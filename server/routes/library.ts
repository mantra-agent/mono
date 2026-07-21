import type { Express } from "express";
import type { Principal } from "../principal";
import type { FieldDef } from "pg";
import {
  db,
  pool,
  acquireLibraryParentLocks,
  isSerializationConflict,
} from "../db";
import { z } from "zod";
import {
  eq,
  desc,
  asc,
  and,
  or,
  ilike,
  isNull,
  gt,
  gte,
  lt,
  lte,
  ne,
  inArray,
  sql as dsql,
  type SQL,
} from "drizzle-orm";
import {
  infoNotes,
  libraryPages,
  libraryPageLinks,
  libraryAnnotations,
  libraryPageViews,
} from "@shared/models/info";
import type { LibraryPage } from "@shared/models/info";
import {
  MEMORY_INTEGRATION_STAGE,
  deriveMemoryIntegrationStage,
  memoryEntries,
  memorySourceRefs,
} from "@shared/models/memory";
import { users, type MemoryEntry } from "@shared/schema";
import {
  computeContentHash,
  memoryEntryLightColumns,
  wrapLightEntry,
} from "../memory/memory-storage";
import { scheduleMemoryLinks } from "../memory/link-scheduling";
import { searchVnextMemory } from "../memory/vnext-search";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { createUserSessionPrincipal, getPrincipal } from "../principal";
import { getCurrentPrincipalOrSystem, runWithPrincipal } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { WORKSPACE_DIR } from "../paths";
import { eventBus } from "../event-bus";
import { markSourceChanged, registerSourceIfAbsent } from "../memory/vnext-source-queue";
import {
  ensureMantraLibraryVault,
  normalizeLibraryStructuralRole,
} from "../library-domain";
import { getLibraryPageNeighbors, runLibraryLint, syncEmbeddedLibraryPageLinks } from "../library-link-graph";
import { compileLibraryPageToMantraWiki, queryMantraLibraryIndex } from "../library-compiler";
import { projectActiveLibraryReminders } from "../library-reminders";
import { buildLibrarySurfaceSet } from "../library-save";
import {
  createLibrary2Placements,
  deleteLibrary2Placement,
  listLibrary2Destinations,
  listLibrary2Placements,
  suggestLibrary2Destination,
} from "../library2-placement-service";

const log = createLogger("InfoRoutes");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};
const memoryScopeColumns = {
  scope: memoryEntries.scope,
  ownerUserId: memoryEntries.ownerUserId,
  accountId: memoryEntries.accountId,
  vaultId: memoryEntries.vaultId,
};

const memorySourceScopeColumns = {
  scope: memorySourceRefs.scope,
  ownerUserId: memorySourceRefs.ownerUserId,
  accountId: memorySourceRefs.accountId,
};

function principalOrThrow(req: any) {
  const principal = getPrincipal(req);
  if (!principal)
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  return principal;
}

async function resolveLibraryOperatorPrincipal(req: any, targetUserId?: string): Promise<Principal> {
  const principal = principalOrThrow(req);
  if (principal.actorType === "user") return principal;

  if (principal.actorType !== "service" && !principal.isAdmin) {
    throw Object.assign(new Error("User principal required"), { status: 403 });
  }
  if (!targetUserId) {
    throw Object.assign(new Error("targetUserId is required for service Library operations"), { status: 400 });
  }

  const [user] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
  if (!user) throw Object.assign(new Error("Target user not found"), { status: 404 });

  return createUserSessionPrincipal(user);
}

function publishLibraryChanged(action: string, page?: { id?: string | null; title?: string | null; surface?: boolean | null; surfaceUntil?: Date | string | null }) {
  eventBus.publish({
    category: "system",
    event: "data:library_changed",
    payload: {
      source: "library_api",
      action,
      pageId: page?.id ?? null,
      title: page?.title ?? null,
      surface: page?.surface ?? null,
      surfaceUntil: page?.surfaceUntil instanceof Date ? page.surfaceUntil.toISOString() : (page?.surfaceUntil ?? null),
    },
  });
}

function visibleLibrary(req: any, predicate?: SQL): SQL {
  return combineWithVisibleScope(
    principalOrThrow(req),
    libraryScopeColumns,
    predicate,
  );
}

function writableLibrary(req: any, predicate?: SQL): SQL {
  return combineWithWritableScope(
    principalOrThrow(req),
    libraryScopeColumns,
    predicate,
  );
}

const librarySurfaceInput = {
  surface: z.boolean().optional(),
  surfaceDurationHours: z.number().positive().optional(),
  surfaceReason: z.string().nullable().optional(),
  surfaceSection: z.string().nullable().optional(),
};

function visibleMemory(req: any, predicate?: SQL): SQL {
  return combineWithVisibleScope(
    principalOrThrow(req),
    memoryScopeColumns,
    predicate,
  );
}

async function ensureLibraryMemorySourceRef(memoryId: number, pageId: string): Promise<void> {
  const principal = getCurrentPrincipalOrSystem();
  await db
    .insert(memorySourceRefs)
    .values({
      memoryId,
      sourceType: "library",
      sourceId: pageId,
      relationship: "extracted_from",
      context: "Library page memory mirror source from legacy memory_entries.source/source_id",
      strength: 1,
      ...ownedInsertValues(principal, memorySourceScopeColumns),
      createdByUserId: principal.userId ?? undefined,
      updatedByUserId: principal.userId ?? undefined,
    })
    .onConflictDoUpdate({
      target: [
        memorySourceRefs.memoryId,
        memorySourceRefs.sourceType,
        memorySourceRefs.sourceId,
        memorySourceRefs.relationship,
      ],
      set: {
        context: "Library page memory mirror source from legacy memory_entries.source/source_id",
        strength: 1,
        updatedByUserId: principal.userId ?? undefined,
      },
    });
  log.debug(`[ingest] source_ref_attached source=library sourceId=${pageId} memoryEntryId=${memoryId}`);
}

export function isSummaryEffectivelyVerbatim(
  summary: string | null,
  plainContent: string | null,
): boolean {
  if (!summary || !plainContent) return false;
  const s = summary.trim();
  const c = plainContent.trim();
  if (!s || !c) return false;
  if (c.length < 200) return false; // very short pages may have a summary == content; skip
  // Length within ~10% of the page's plaintext length and high prefix overlap.
  const lengthRatio = s.length / c.length;
  if (lengthRatio < 0.9 || lengthRatio > 1.1) return false;
  const probeLen = Math.min(200, Math.floor(c.length * 0.2));
  if (probeLen < 50) return false;
  const sPrefix = s.slice(0, probeLen);
  const cPrefix = c.slice(0, probeLen);
  let matching = 0;
  for (let i = 0; i < probeLen; i++) {
    if (sPrefix[i] === cPrefix[i]) matching++;
  }
  return matching / probeLen >= 0.85;
}

interface BrokenLibraryEntry {
  entry: MemoryEntry;
  page: LibraryPage | null;
}

export async function findBrokenLibraryMemoryEntries(
  limit?: number,
): Promise<BrokenLibraryEntry[]> {
  const rows = await db
    .select(memoryEntryLightColumns)
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.source, "library"),
        or(eq(memoryEntries.layer, "mid"), eq(memoryEntries.layer, "long")),
      ),
    )
    .orderBy(asc(memoryEntries.id));

  const entries = rows.map((r) =>
    wrapLightEntry(r as Omit<MemoryEntry, "embedding">),
  );
  const pageIds = Array.from(new Set(
    entries
      .map((e) => e.sourceId)
      .filter((id): id is string => !!id),
  ));
  const pageMap = new Map<string, LibraryPage>();
  if (pageIds.length > 0) {
    const pages = await db
      .select()
      .from(libraryPages)
      .where(inArray(libraryPages.id, pageIds));
    for (const p of pages) pageMap.set(p.id, p);
  }

  const broken: BrokenLibraryEntry[] = [];
  for (const e of entries) {
    const summary = (e.summary || "").trim();
    const page = e.sourceId ? (pageMap.get(e.sourceId) ?? null) : null;
    const plain = page?.plainTextContent || "";
    if (!summary) {
      broken.push({ entry: e, page });
      continue;
    }
    if (page && isSummaryEffectivelyVerbatim(summary, plain)) {
      broken.push({ entry: e, page });
    }
  }

  return typeof limit === "number" ? broken.slice(0, limit) : broken;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "page"
  );
}

export async function registerLibraryRoutes(app: Express) {
  app.use(["/api/info", "/api/library"], requireAuth);

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS library_page_views (
        page_id TEXT PRIMARY KEY REFERENCES library_pages(id) ON DELETE CASCADE,
        last_viewed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (e: any) {
    log.warn(
      `[migration] library_page_views creation failed (non-fatal): ${e.message}`,
    );
  }

  try {
    await pool.query(`
      ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0
    `);
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS one_liner TEXT`,
    );
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS summary TEXT`,
    );
    await pool.query(
      `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS structural_role TEXT NOT NULL DEFAULT 'artifact'`,
    );
    await pool.query(
      `ALTER TABLE library_pages DROP CONSTRAINT IF EXISTS chk_library_pages_structural_role`,
    );
    await pool.query(
      `ALTER TABLE library_pages ADD CONSTRAINT chk_library_pages_structural_role CHECK (structural_role IN ('source', 'artifact', 'wiki', 'meta'))`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_library_pages_structural_role ON library_pages(structural_role)`,
    );
    await pool.query(
      `ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS one_liner TEXT`,
    );

    const { rows: sentinel } = await pool.query(`
      SELECT 1 FROM library_pages WHERE sort_order != 0 LIMIT 1
    `);
    if (sentinel.length === 0) {
      const { rows: total } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM library_pages`,
      );
      const totalCount = parseInt(total[0]?.cnt ?? "0", 10);
      if (totalCount > 0) {
        log.log(
          `[backfill] One-time sort_order backfill for ${totalCount} library pages`,
        );
        await pool.query(`
          WITH ranked AS (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY title) - 1 AS rn
            FROM library_pages
          )
          UPDATE library_pages SET sort_order = ranked.rn
          FROM ranked WHERE library_pages.id = ranked.id
        `);
        log.debug(`[backfill] sort_order backfill complete`);
      }
    }
  } catch (e: any) {
    log.warn(
      `[backfill] sort_order migration/backfill failed (non-fatal): ${e.message}`,
    );
  }

  try {
    const { rows: hasTypeCol } = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'library_pages' AND column_name = 'type'
    `);
    if (hasTypeCol.length > 0) {
      log.log(
        `[migration] Migrating library_pages: unifying type system to tags+status`,
      );
      await pool.query(
        `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'`,
      );
      await pool.query(
        `ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS status TEXT`,
      );
      await pool.query(`
        UPDATE library_pages
        SET tags = ARRAY['spec'],
            status = COALESCE((metadata->>'status'), 'draft')
        WHERE type = 'spec'
      `);
      await pool.query(`
        UPDATE library_pages SET tags = ARRAY['folder'] WHERE type = 'folder'
      `);
      await pool.query(`DROP INDEX IF EXISTS idx_library_pages_type`);
      await pool.query(`ALTER TABLE library_pages DROP COLUMN IF EXISTS type`);
      await pool.query(
        `ALTER TABLE library_pages DROP COLUMN IF EXISTS metadata`,
      );
      log.debug(`[migration] Library pages type→tags migration complete`);
    }
  } catch (e: any) {
    log.warn(
      `[migration] Library pages type migration failed (non-fatal): ${e.message}`,
    );
  }

  // ─── Notes → Library Migration ──────────────────────────────────────
  try {
    const existingNotesFolder = await db
      .select({ id: libraryPages.id })
      .from(libraryPages)
      .where(
        and(
          eq(libraryPages.slug, "notes"),
          dsql`'system-folder' = ANY(${libraryPages.tags})`,
        ),
      );

    if (existingNotesFolder.length === 0) {
      const { resolveLibraryParent } = await import("../library-index");
      const { upsertLibraryPageMemory } = await import("./library");
      const folderId = await resolveLibraryParent("notes");

      // Set sortOrder to -1 and emoji to pin at top
      await db
        .update(libraryPages)
        .set({ sortOrder: -1, emoji: "📝" })
        .where(eq(libraryPages.id, folderId));
      log.debug(`[migration] Created Notes system folder: ${folderId}`);

      // Migrate all info_notes to library_pages
      const allNotes = await db.select().from(infoNotes);
      if (allNotes.length > 0) {
        log.log(`[migration] Migrating ${allNotes.length} notes to Library...`);
        const usedSlugs = new Set<string>();
        for (const note of allNotes) {
          let slug = slugify(note.title || "untitled");
          if (!slug) slug = "untitled";
          let finalSlug = slug;
          let counter = 2;
          while (usedSlugs.has(finalSlug)) {
            finalSlug = `${slug}-${counter++}`;
          }
          usedSlugs.add(finalSlug);

          const [created] = await db
            .insert(libraryPages)
            .values({
              title: note.title || "Untitled",
              slug: finalSlug,
              content: note.content ?? { type: "doc", content: [] },
              plainTextContent: note.plainTextContent || "",
              parentId: folderId,
              tags: ["migrated-from-note"],
              sortOrder: 0,
              createdAt: note.createdAt,
              updatedAt: note.updatedAt,
            })
            .returning();

          // Update memory entries from note source to library source
          await db
            .update(memoryEntries)
            .set({
              source: "library",
              sourceId: created.id,
            })
            .where(
              and(
                eq(memoryEntries.source, "note"),
                eq(memoryEntries.sourceId, note.id),
              ),
            );

          upsertLibraryPageMemory(created).catch((e) =>
            log.warn(
              `[migration] Page memory upsert failed for ${created.id}: ${e.message}`,
            ),
          );
          log.debug(
            `[migration] Migrated note "${note.title}" → library page ${created.id} (slug: ${finalSlug})`,
          );
        }
        log.debug(
          `[migration] Notes migration complete: ${allNotes.length} notes migrated`,
        );
      } else {
        log.debug(`[migration] No info_notes to migrate`);
      }
    }
  } catch (e: any) {
    log.warn(
      `[migration] Notes→Library migration failed (non-fatal): ${e.message}`,
    );
  }

  try {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.accountId) {
      await ensureMantraLibraryVault(principal);
    }
  } catch (e: any) {
    log.warn(`[bootstrap] Mantra Library vault bootstrap skipped/failed: ${e.message}`);
  }

  // ─── Library2 placement lens ──────────────────────────────────────────

  const library2SourceSchema = z.discriminatedUnion("type", [
    z.object({ type: z.enum(["page", "section"]), pageId: z.string().min(1) }),
    z.object({ type: z.literal("vault"), vaultId: z.string().min(1) }),
  ]);

  app.get("/api/library2/destinations", async (req, res) => {
    try {
      res.json(await listLibrary2Destinations(principalOrThrow(req)));
    } catch (err: any) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  app.get("/api/library2/placements", async (req, res) => {
    try {
      res.json(await listLibrary2Placements(principalOrThrow(req)));
    } catch (err: any) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  app.post("/api/library2/suggest", async (req, res) => {
    try {
      const input = z.object({ source: library2SourceSchema }).parse(req.body ?? {});
      res.json(await suggestLibrary2Destination(input.source, principalOrThrow(req)));
    } catch (err: any) {
      if (err.name === "ZodError") return res.status(400).json({ error: "Invalid input", details: err.errors });
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  app.post("/api/library2/placements", async (req, res) => {
    try {
      const input = z.object({
        source: library2SourceSchema,
        vaultId: z.string().min(1),
        sectionPageId: z.string().min(1),
        importKey: z.string().min(8).max(200),
      }).parse(req.body ?? {});
      const result = await createLibrary2Placements(input, principalOrThrow(req));
      publishLibraryChanged("library2_import");
      res.status(result.createdCount > 0 ? 201 : 200).json(result);
    } catch (err: any) {
      if (err.name === "ZodError") return res.status(400).json({ error: "Invalid input", details: err.errors });
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  app.delete("/api/library2/placements/:id", async (req, res) => {
    try {
      res.json(await deleteLibrary2Placement(req.params.id, principalOrThrow(req)));
      publishLibraryChanged("library2_remove");
    } catch (err: any) {
      res.status(err.status ?? 500).json({ error: err.message });
    }
  });

  // ─── Library Pages CRUD ───────────────────────────────────────────────

  app.post("/api/library/vaults/mantra/ensure", async (req, res) => {
    try {
      const result = await ensureMantraLibraryVault(principalOrThrow(req));
      res.json(result);
    } catch (err: any) {
      log.error(`Mantra Library vault ensure failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/library", async (req, res) => {
    try {
      const search =
        typeof req.query.search === "string" ? req.query.search.trim() : "";
      const metadataColumns = {
        id: libraryPages.id,
        pageId: libraryPages.pageId,
        title: libraryPages.title,
        slug: libraryPages.slug,
        parentId: libraryPages.parentId,
        tags: libraryPages.tags,
        status: libraryPages.status,
        emoji: libraryPages.emoji,
        oneLiner: libraryPages.oneLiner,
        summary: libraryPages.summary,
        surface: libraryPages.surface,
        surfaceUntil: libraryPages.surfaceUntil,
        surfaceReason: libraryPages.surfaceReason,
        surfaceSection: libraryPages.surfaceSection,
        sortOrder: libraryPages.sortOrder,
        vaultId: libraryPages.vaultId,
        structuralRole: libraryPages.structuralRole,
        scope: libraryPages.scope,
        createdAt: libraryPages.createdAt,
        updatedAt: libraryPages.updatedAt,
      };
      const query = search
        ? db
            .select(metadataColumns)
            .from(libraryPages)
            .where(
              visibleLibrary(
                req,
                or(
                  ilike(libraryPages.title, `%${search}%`),
                  ilike(libraryPages.plainTextContent, `%${search}%`),
                ),
              ),
            )
            .orderBy(desc(libraryPages.updatedAt))
        : db
            .select(metadataColumns)
            .from(libraryPages)
            .where(visibleLibrary(req))
            .orderBy(desc(libraryPages.updatedAt));
      const pages = await query;
      res.json(await projectActiveLibraryReminders(pages));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/library/tree", async (req, res) => {
    try {
      const rawPages = await db
        .select({
          id: libraryPages.id,
          pageId: libraryPages.pageId,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          tags: libraryPages.tags,
          status: libraryPages.status,
          emoji: libraryPages.emoji,
          surface: libraryPages.surface,
          surfaceUntil: libraryPages.surfaceUntil,
          surfaceReason: libraryPages.surfaceReason,
          surfaceSection: libraryPages.surfaceSection,
          vaultId: libraryPages.vaultId,
          structuralRole: libraryPages.structuralRole,
          scope: libraryPages.scope,
          updatedAt: libraryPages.updatedAt,
        })
        .from(libraryPages)
        .where(visibleLibrary(req))
        .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));
      const pages = await projectActiveLibraryReminders(rawPages);

      type PageWithChildren = (typeof pages)[number] & {
        children: PageWithChildren[];
      };
      const buildTree = (parentId: string | null): PageWithChildren[] => {
        return pages
          .filter((p) => p.parentId === parentId)
          .map((p) => ({ ...p, children: buildTree(p.id) }));
      };

      res.json(buildTree(null));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/library/unread", async (req, res) => {
    try {
      const rows = await db
        .select({ id: libraryPages.id })
        .from(libraryPages)
        .leftJoin(
          libraryPageViews,
          eq(libraryPages.id, libraryPageViews.pageId),
        )
        .where(
          visibleLibrary(
            req,
            or(
              isNull(libraryPageViews.lastViewedAt),
              gt(libraryPages.updatedAt, libraryPageViews.lastViewedAt),
            ),
          ),
        );

      res.json(rows.map((r) => r.id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/info/library/:id/read", async (req, res) => {
    try {
      const pageId = req.params.id;
      const [existing] = await db
        .select({ id: libraryPages.id })
        .from(libraryPages)
        .where(visibleLibrary(req, eq(libraryPages.id, pageId)));
      if (!existing)
        return res.status(404).json({ error: "Library page not found" });

      await db
        .insert(libraryPageViews)
        .values({
          pageId,
          lastViewedAt: new Date(),
          ...ownedInsertValues(principalOrThrow(req), {
            scope: libraryPageViews.scope,
            ownerUserId: libraryPageViews.ownerUserId,
            accountId: libraryPageViews.accountId,
          }),
          createdByUserId: principalOrThrow(req).userId ?? undefined,
          updatedByUserId: principalOrThrow(req).userId ?? undefined,
        })
        .onConflictDoUpdate({
          target: libraryPageViews.pageId,
          set: { lastViewedAt: new Date() },
        });

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/library/:id", async (req, res) => {
    try {
      let page = null;
      const byId = await db
        .select()
        .from(libraryPages)
        .where(visibleLibrary(req, eq(libraryPages.id, req.params.id)));
      if (byId.length > 0) {
        page = byId[0];
      } else {
        const bySlug = await db
          .select()
          .from(libraryPages)
          .where(visibleLibrary(req, eq(libraryPages.slug, req.params.id)));
        page = bySlug[0] || null;
      }
      if (!page)
        return res.status(404).json({ error: "Library page not found" });
      await registerSourceIfAbsent("library_page", page.id, req.principal);
      res.json(page);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/library/:id/backlinks", async (req, res) => {
    try {
      const principal = principalOrThrow(req);
      const links = await db
        .select({
          id: libraryPages.id,
          pageId: libraryPages.pageId,
          title: libraryPages.title,
          slug: libraryPages.slug,
          summary: libraryPages.summary,
          structuralRole: libraryPages.structuralRole,
        })
        .from(libraryPageLinks)
        .innerJoin(
          libraryPages,
          eq(libraryPageLinks.sourcePageId, libraryPages.id),
        )
        .where(combineWithVisibleScope(principal, { scope: libraryPageLinks.scope, ownerUserId: libraryPageLinks.ownerUserId, accountId: libraryPageLinks.accountId }, eq(libraryPageLinks.targetPageId, req.params.id)));
      res.json(links);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/library/:id/links", async (req, res) => {
    try {
      const principal = principalOrThrow(req);
      const outbound = await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug, summary: libraryPages.summary, structuralRole: libraryPages.structuralRole })
        .from(libraryPageLinks)
        .innerJoin(libraryPages, eq(libraryPageLinks.targetPageId, libraryPages.id))
        .where(combineWithVisibleScope(principal, { scope: libraryPageLinks.scope, ownerUserId: libraryPageLinks.ownerUserId, accountId: libraryPageLinks.accountId }, eq(libraryPageLinks.sourcePageId, req.params.id)));
      const inbound = await getLibraryPageNeighbors([req.params.id], principal, 50);
      res.json({ outbound, neighbors: inbound });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/info/library/lint", async (req, res) => {
    try {
      const input = z.object({ repair: z.boolean().optional(), surfaceReport: z.boolean().optional() }).parse(req.body ?? {});
      const report = await runLibraryLint(input, principalOrThrow(req));
      publishLibraryChanged("lint", report.reportPageId ? { id: report.reportPageId, title: "Library Lint Report", surface: true } : undefined);
      res.json(report);
    } catch (err: any) {
      if (err.name === "ZodError") return res.status(400).json({ error: "Invalid input", details: err.errors });
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/info/library/compile", async (req, res) => {
    try {
      const input = z.object({ id: z.string().min(1), targetUserId: z.string().optional() }).parse(req.body ?? {});
      const principal = await resolveLibraryOperatorPrincipal(req, input.targetUserId);
      const result = await runWithPrincipal(principal, () => compileLibraryPageToMantraWiki(input.id, principal));
      publishLibraryChanged("compiled", { id: result.sourcePageId, title: result.sourceTitle });
      res.json(result);
    } catch (err: any) {
      if (err.name === "ZodError") return res.status(400).json({ error: "Invalid input", details: err.errors });
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/info/library/index-query", async (req, res) => {
    try {
      const input = z.object({ query: z.string().min(1), targetUserId: z.string().optional() }).parse(req.body ?? {});
      const principal = await resolveLibraryOperatorPrincipal(req, input.targetUserId);
      const result = await runWithPrincipal(principal, () => queryMantraLibraryIndex(input.query, principal));
      res.json(result);
    } catch (err: any) {
      if (err.name === "ZodError") return res.status(400).json({ error: "Invalid input", details: err.errors });
      res.status(500).json({ error: err.message });
    }
  });

  const reorderSchema = z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    sortOrder: z.number().int().min(0),
  });

  // Cycle check using a slim {id, parentId} projection — no jsonb / plain_text
  // columns. Walk parent pointers from `proposedParentId` up to root; if we
  // ever hit `nodeId`, the move would create a cycle.
  function wouldCreateCycleLite(
    parentMap: Map<string, string | null>,
    nodeId: string,
    proposedParentId: string,
  ): boolean {
    let current: string | null = proposedParentId;
    const visited = new Set<string>();
    while (current) {
      if (current === nodeId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      current = parentMap.get(current) ?? null;
    }
    return false;
  }

  // PATCH /api/info/library/reorder
  //
  // Reparenting / reordering a Library page issues bulk
  // `UPDATE library_pages SET sort_order = sort_order ± 1 WHERE parent_id = $1 AND ...`
  // statements that grab row locks on every sibling under the affected
  // parent(s). Without serialization, two concurrent reorders against the
  // same parent (or a reparent that touches both old + new parent) would
  // each hold half the row locks and wait on the other half — a classic
  // AB/BA deadlock. Around 22:18 UTC on Apr 25 2026 production wedged on
  // exactly this pattern with two `auto:spec` sessions writing pages while
  // the user reparented Library entries.
  //
  // Fix:
  //  1. Whole route runs inside ONE transaction (one connection).
  //  2. Take a `pg_advisory_xact_lock` keyed on the old + new parent before
  //     any UPDATE, so concurrent reorders touching the same parent queue
  //     on the lock instead of cross-locking on row sets.
  //  3. Cycle check uses a slim `{id, parentId}` projection (the previous
  //     `db.select().from(libraryPages)` pulled every page's `content` jsonb
  //     and `plain_text_content`, dominating the route's ~2.5s p95).
  //  4. Catch Postgres `40P01` / `40001` and return 409 so the client can
  //     retry instead of seeing a generic 500.
  app.patch("/api/info/library/reorder", async (req, res) => {
    let parsed: z.infer<typeof reorderSchema>;
    try {
      parsed = reorderSchema.parse(req.body);
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res
          .status(400)
          .json({ error: "Invalid input", details: err.errors });
      }
      throw err;
    }
    const { id, parentId, sortOrder } = parsed;

    // System folders cannot be moved or reparented
    const [reorderTarget] = await db
      .select({ tags: libraryPages.tags })
      .from(libraryPages)
      .where(visibleLibrary(req, eq(libraryPages.id, id)));
    if (!reorderTarget) {
      return res.status(404).json({ error: "Page not found" });
    }
    if (reorderTarget?.tags?.includes("system-folder")) {
      return res.status(403).json({ error: "System folders cannot be moved." });
    }

    type ReorderResult =
      | {
          kind: "ok";
          updated: LibraryPage;
          oldParentId: string | null;
          newParentId: string | null;
        }
      | { kind: "client-error"; status: number; error: string };

    // Captured outside the transaction so the catch block can include
    // oldParent/newParent in the 409 log line for triage. Populated after we
    // first resolve the page's pre-move parent inside the tx.
    let conflictOldParent: string | null | undefined = undefined;
    let conflictNewParent: string | null = parentId;

    try {
      const result: ReorderResult = await db.transaction(async (tx) => {
        // Step 1: tiny single-row read just to learn the page's current
        // parent. We need this to know which old-parent lock to take.
        const [preRow] = await tx
          .select({ parentId: libraryPages.parentId })
          .from(libraryPages)
          .where(visibleLibrary(req, eq(libraryPages.id, id)));
        if (!preRow) {
          return { kind: "client-error", status: 404, error: "Page not found" };
        }
        const oldParentFromSnapshot = preRow.parentId;
        conflictOldParent = oldParentFromSnapshot;

        // Step 2: acquire advisory locks on BOTH parents (sorted dedup
        // inside the helper) so cycle-check + bulk shifts run on a stable
        // snapshot.
        await acquireLibraryParentLocks(tx, [oldParentFromSnapshot, parentId]);

        // Step 3: post-lock slim {id, parentId} snapshot for cycle / parent
        // existence checks. The reviewer flagged that doing the cycle check
        // before the lock could miss a concurrent reparent that just shifted
        // an ancestor — re-reading after the lock keeps the check
        // lock-consistent.
        const lite = await tx
          .select({ id: libraryPages.id, parentId: libraryPages.parentId })
          .from(libraryPages)
          .where(visibleLibrary(req));
        const parentMap = new Map(lite.map((p) => [p.id, p.parentId] as const));

        if (!parentMap.has(id)) {
          return { kind: "client-error", status: 404, error: "Page not found" };
        }
        if (parentId !== null) {
          if (!parentMap.has(parentId)) {
            return {
              kind: "client-error",
              status: 400,
              error: "Parent not found",
            };
          }
          if (wouldCreateCycleLite(parentMap, id, parentId)) {
            return {
              kind: "client-error",
              status: 400,
              error: "Cannot move a node into its own descendant",
            };
          }
        }

        // Step 4: re-read the row to get authoritative sort_order + parent
        // (the row may have moved between Step 1 and acquiring the lock).
        const [pageRow] = await tx
          .select({
            sortOrder: libraryPages.sortOrder,
            parentId: libraryPages.parentId,
          })
          .from(libraryPages)
          .where(visibleLibrary(req, eq(libraryPages.id, id)));
        if (!pageRow) {
          return { kind: "client-error", status: 404, error: "Page not found" };
        }
        const oldParentId = pageRow.parentId;
        const oldSortOrder = pageRow.sortOrder;
        const changingParent = oldParentId !== parentId;
        conflictOldParent = oldParentId;

        // If the actual old parent (post-lock) differs from what we locked
        // in Step 2, grab the lock on the now-correct old parent too. Edge
        // case but cheap and keeps the invariant.
        if (oldParentId !== oldParentFromSnapshot) {
          await acquireLibraryParentLocks(tx, [oldParentId]);
        }

        const newParentCondition = parentId
          ? eq(libraryPages.parentId, parentId)
          : isNull(libraryPages.parentId);
        const [siblingCount] = await tx
          .select({ cnt: dsql<number>`COUNT(*)` })
          .from(libraryPages)
          .where(visibleLibrary(req, and(newParentCondition, ne(libraryPages.id, id))));
        const maxAllowed = Number(siblingCount?.cnt ?? 0);
        const clampedSortOrder = Math.max(0, Math.min(sortOrder, maxAllowed));

        if (changingParent) {
          const oldParentCondition = oldParentId
            ? eq(libraryPages.parentId, oldParentId)
            : isNull(libraryPages.parentId);
          await tx
            .update(libraryPages)
            .set({ sortOrder: dsql`${libraryPages.sortOrder} - 1` })
            .where(
              writableLibrary(req, and(
                oldParentCondition,
                gt(libraryPages.sortOrder, oldSortOrder),
                ne(libraryPages.id, id),
              )),
            );
          await tx
            .update(libraryPages)
            .set({ sortOrder: dsql`${libraryPages.sortOrder} + 1` })
            .where(
              writableLibrary(req, and(
                newParentCondition,
                gte(libraryPages.sortOrder, clampedSortOrder),
                ne(libraryPages.id, id),
              )),
            );
        } else if (clampedSortOrder > oldSortOrder) {
          await tx
            .update(libraryPages)
            .set({ sortOrder: dsql`${libraryPages.sortOrder} - 1` })
            .where(
              writableLibrary(req, and(
                newParentCondition,
                gt(libraryPages.sortOrder, oldSortOrder),
                lte(libraryPages.sortOrder, clampedSortOrder),
                ne(libraryPages.id, id),
              )),
            );
        } else if (clampedSortOrder < oldSortOrder) {
          await tx
            .update(libraryPages)
            .set({ sortOrder: dsql`${libraryPages.sortOrder} + 1` })
            .where(
              writableLibrary(req, and(
                newParentCondition,
                gte(libraryPages.sortOrder, clampedSortOrder),
                lt(libraryPages.sortOrder, oldSortOrder),
                ne(libraryPages.id, id),
              )),
            );
        }

        const [updated] = await tx
          .update(libraryPages)
          .set({ parentId, sortOrder: clampedSortOrder, updatedAt: new Date() })
          .where(writableLibrary(req, eq(libraryPages.id, id)))
          .returning();

        return { kind: "ok", updated, oldParentId, newParentId: parentId };
      });

      if (result.kind === "client-error") {
        return res.status(result.status).json({ error: result.error });
      }
      res.json(result.updated);
    } catch (err: any) {
      if (isSerializationConflict(err)) {
        log.warn(
          `Reorder serialization conflict: op=reorder page=${id} oldParent=${conflictOldParent ?? "<unread>"} newParent=${conflictNewParent} requestedSort=${sortOrder} code=${err?.code} message=${err?.message}`,
        );
        return res.status(409).json({
          error: "Reorder conflict — please retry",
          code: err?.code,
          retry: true,
        });
      }
      log.error(`Reorder failed: ${err.message}`);
      if (err.name === "ZodError") {
        return res
          .status(400)
          .json({ error: "Invalid input", details: err.errors });
      }
      res.status(500).json({ error: err.message });
    }
  });

  const createPageSchema = z.object({
    title: z.string().default(""),
    content: z.any().optional(),
    plainTextContent: z.string().default(""),
    parentId: z.string().nullable().optional(),
    purpose: z.string().nullable().optional(),
    pageContext: z.string().nullable().optional(),
    contentSummary: z.string().nullable().optional(),
    tags: z.array(z.string()).default([]),
    status: z.string().nullable().optional(),
    emoji: z.string().nullable().optional(),
    structuralRole: z.enum(["source", "artifact", "wiki", "meta"]).optional(),
    ...librarySurfaceInput,
  });

  app.post("/api/info/library", async (req, res) => {
    try {
      const data = createPageSchema.parse(req.body);
      const { syncContentFields, isValidTiptapDoc } = await import("@shared/markdown-tiptap");
      const synced = isValidTiptapDoc(data.content)
        ? syncContentFields({ tiptapJson: data.content })
        : syncContentFields({ markdown: data.plainTextContent });
      const { createFiledLibraryPage } = await import("../library-save");
      const page = await createFiledLibraryPage({
        title: data.title,
        markdown: synced.plainTextContent,
        purpose: data.purpose ?? null,
        explicitParentId: data.parentId ?? null,
        pageContext: data.pageContext ?? null,
        contentSummary: data.contentSummary ?? null,
        tags: data.tags,
        status: data.status,
        structuralRole: data.structuralRole,
        surface: data.surface,
        surfaceDurationHours: data.surfaceDurationHours,
        surfaceReason: data.surfaceReason,
        surfaceSection: data.surfaceSection,
      });

      res.status(201).json(page);
    } catch (err: any) {
      if (err.name === "ZodError")
        return res
          .status(400)
          .json({ error: "Invalid input", details: err.errors });
      res.status(500).json({ error: err.message });
    }
  });

  const updatePageSchema = z.object({
    title: z.string().optional(),
    content: z.any().optional(),
    plainTextContent: z.string().optional(),
    parentId: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    status: z.string().nullable().optional(),
    emoji: z.string().nullable().optional(),
    structuralRole: z.enum(["source", "artifact", "wiki", "meta"]).optional(),
    linkPages: z.array(z.string()).optional(),
    ...librarySurfaceInput,
  });

  app.patch("/api/info/library/:id", async (req, res) => {
    try {
      const updates = updatePageSchema.parse(req.body);
      const setData: Partial<typeof libraryPages.$inferInsert> & {
        updatedAt: Date;
      } = { updatedAt: new Date() };
      if (updates.title !== undefined) {
        setData.title = updates.title;
        setData.slug = slugify(updates.title);
      }
      if (
        updates.content !== undefined ||
        updates.plainTextContent !== undefined
      ) {
        const { syncContentFields, isValidTiptapDoc } =
          await import("@shared/markdown-tiptap");
        if (isValidTiptapDoc(updates.content)) {
          const synced = syncContentFields({ tiptapJson: updates.content });
          setData.content = synced.content;
          setData.plainTextContent = synced.plainTextContent;
        } else if (updates.plainTextContent !== undefined) {
          const synced = syncContentFields({
            markdown: updates.plainTextContent,
          });
          setData.content = synced.content;
          setData.plainTextContent = synced.plainTextContent;
        }
      }
      if (updates.parentId !== undefined) {
        setData.parentId = updates.parentId === "" ? null : updates.parentId;
      }
      if (updates.tags !== undefined) setData.tags = updates.tags;
      if (updates.emoji !== undefined) setData.emoji = updates.emoji;
      if (updates.structuralRole !== undefined)
        setData.structuralRole = normalizeLibraryStructuralRole(updates.structuralRole);
      Object.assign(setData, buildLibrarySurfaceSet(updates));

      const [updated] = await db
        .update(libraryPages)
        .set({
          ...setData,
          updatedByUserId: principalOrThrow(req).userId ?? undefined,
        })
        .where(writableLibrary(req, eq(libraryPages.id, req.params.id)))
        .returning();
      if (!updated)
        return res.status(404).json({ error: "Library page not found" });

      if (updates.linkPages && updates.linkPages.length > 0) {
        for (const targetId of updates.linkPages) {
          await db
            .insert(libraryPageLinks)
            .values({
              sourcePageId: req.params.id,
              targetPageId: targetId,
              ...ownedInsertValues(principalOrThrow(req), { scope: libraryPageLinks.scope, ownerUserId: libraryPageLinks.ownerUserId, accountId: libraryPageLinks.accountId }),
              createdByUserId: principalOrThrow(req).userId ?? undefined,
              updatedByUserId: principalOrThrow(req).userId ?? undefined,
            })
            .onConflictDoNothing();
        }
      }

      if (updates.content !== undefined || updates.plainTextContent !== undefined) {
        syncEmbeddedLibraryPageLinks(updated.id, principalOrThrow(req)).catch((e) =>
          log.warn(`Library link sync failed for page ${updated.id}: ${e.message}`),
        );
      }

      upsertLibraryPageMemory(updated).catch((e) =>
        log.warn(`Library memory upsert failed: ${e.message}`),
      );

      // Queue for vNext claim extraction on material content changes
      const hasMaterialChange =
        updates.content !== undefined ||
        updates.plainTextContent !== undefined ||
        updates.title !== undefined;
      if (hasMaterialChange) {
        const principal = principalOrThrow(req);
        markSourceChanged("library_page", updated.id, principal).catch((e) =>
          log.warn(`vNext source queue upsert failed for page ${updated.id}: ${e.message}`),
        );
      }

      publishLibraryChanged("updated", updated);
      res.json(updated);
    } catch (err: any) {
      if (err.name === "ZodError")
        return res
          .status(400)
          .json({ error: "Invalid input", details: err.errors });
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/info/library/:id/surface", async (req, res) => {
    try {
      const input = z.object(librarySurfaceInput).parse(req.body);
      const setData = buildLibrarySurfaceSet(input);
      if (Object.keys(setData).length === 0) {
        return res.status(400).json({ error: "Provide surface=false to dismiss or surface=true with surfaceDurationHours > 0 to surface." });
      }

      const [updated] = await db
        .update(libraryPages)
        .set({
          ...setData,
          updatedAt: new Date(),
          updatedByUserId: principalOrThrow(req).userId ?? undefined,
        })
        .where(writableLibrary(req, eq(libraryPages.id, req.params.id)))
        .returning();
      if (!updated)
        return res.status(404).json({ error: "Library page not found" });

      publishLibraryChanged(updated.surface ? "surfaced" : "desurfaced", updated);
      res.json(updated);
    } catch (err: any) {
      if (err.name === "ZodError")
        return res
          .status(400)
          .json({ error: "Invalid input", details: err.errors });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/info/library/:id", async (req, res) => {
    try {
      const [page] = await db
        .select({ id: libraryPages.id, tags: libraryPages.tags })
        .from(libraryPages)
        .where(visibleLibrary(req, eq(libraryPages.id, req.params.id)));
      if (!page)
        return res.status(404).json({ error: "Library page not found" });
      if (page.tags?.includes("system-folder"))
        return res
          .status(403)
          .json({ error: "System folders cannot be deleted." });
      const [deleted] = await db
        .delete(libraryPages)
        .where(writableLibrary(req, eq(libraryPages.id, req.params.id)))
        .returning();
      if (!deleted)
        return res.status(404).json({ error: "Library page not found" });
      publishLibraryChanged("deleted", deleted);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Share toggle ────────────────────────────────────────────────────

  app.patch("/api/info/library/:id/share", async (req, res) => {
    try {
      const shared = req.body.shared === true;
      const [updated] = await db
        .update(libraryPages)
        .set({
          scope: shared ? "shared" : "user",
          updatedAt: dsql`CURRENT_TIMESTAMP`,
        })
        .where(writableLibrary(req, eq(libraryPages.id, req.params.id)))
        .returning({ id: libraryPages.id, scope: libraryPages.scope });
      if (!updated)
        return res.status(404).json({ error: "Library page not found" });
      res.json({ ok: true, scope: updated.scope });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Library Annotations ─────────────────────────────────────────────

  app.get("/api/info/library/:id/annotations", async (req, res) => {
    try {
      const annotations = await db
        .select()
        .from(libraryAnnotations)
        .where(eq(libraryAnnotations.pageId, req.params.id))
        .orderBy(desc(libraryAnnotations.createdAt));
      res.json(annotations);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const createAnnotationSchema = z.object({
    content: z.string().min(1),
    annotationType: z
      .enum(["observation", "connection", "confidence"])
      .default("observation"),
  });

  app.post("/api/info/library/:id/annotations", async (req, res) => {
    try {
      const data = createAnnotationSchema.parse(req.body);
      const [annotation] = await db
        .insert(libraryAnnotations)
        .values({
          ...ownedInsertValues(principalOrThrow(req), {
            scope: libraryAnnotations.scope,
            ownerUserId: libraryAnnotations.ownerUserId,
            accountId: libraryAnnotations.accountId,
          }),
          createdByUserId: principalOrThrow(req).userId ?? undefined,
          pageId: req.params.id,
          content: data.content,
          annotationType: data.annotationType,
        })
        .returning();
      res.status(201).json(annotation);
    } catch (err: any) {
      if (err.name === "ZodError")
        return res
          .status(400)
          .json({ error: "Invalid input", details: err.errors });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/info/annotations/:id", async (req, res) => {
    try {
      const [deleted] = await db
        .delete(libraryAnnotations)
        .where(
          combineWithWritableScope(
            principalOrThrow(req),
            {
              scope: libraryAnnotations.scope,
              ownerUserId: libraryAnnotations.ownerUserId,
              accountId: libraryAnnotations.accountId,
            },
            eq(libraryAnnotations.id, req.params.id),
          ),
        )
        .returning();
      if (!deleted)
        return res.status(404).json({ error: "Annotation not found" });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Library Index (progressive disclosure) ────────────────────────────────

  app.get("/api/library/index", async (req, res) => {
    try {
      const parentId =
        typeof req.query.parentId === "string" ? req.query.parentId : null;
      const isRoot = !parentId || parentId === "null";

      const allPages = await db
        .select({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          oneLiner: libraryPages.oneLiner,
          summary: libraryPages.summary,
          emoji: libraryPages.emoji,
          tags: libraryPages.tags,
        })
        .from(libraryPages)
        .where(visibleLibrary(req))
        .orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));

      const childCountMap: Record<string, number> = {};
      for (const p of allPages) {
        const pid = p.parentId || "__root__";
        childCountMap[pid] = (childCountMap[pid] || 0) + 1;
      }

      const filtered = allPages.filter((p) =>
        isRoot ? !p.parentId : p.parentId === parentId,
      );

      const result = filtered.map((p) => ({
        id: p.id,
        title: p.title,
        slug: p.slug,
        emoji: p.emoji,
        oneLiner: p.oneLiner,
        summary: p.summary,
        tags: p.tags,
        hasChildren: (childCountMap[p.id] || 0) > 0,
        childCount: childCountMap[p.id] || 0,
      }));

      res.json({ nodes: result, totalCount: allPages.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const backfillState = {
    running: false,
    total: 0,
    enriched: 0,
    errors: 0,
    detail: "",
    startedAt: null as number | null,
    finishedAt: null as number | null,
  };

  app.get("/api/library/backfill/status", (_req, res) => {
    res.json({ ...backfillState });
  });

  app.post("/api/library/backfill", async (_req, res) => {
    if (backfillState.running) {
      return res
        .status(409)
        .json({ error: "A backfill job is already running." });
    }

    backfillState.running = true;
    backfillState.total = 0;
    backfillState.enriched = 0;
    backfillState.errors = 0;
    backfillState.detail = "";
    backfillState.startedAt = Date.now();
    backfillState.finishedAt = null;

    res.json({ ok: true, message: "Backfill job started." });

    (async () => {
      try {
        const { generateTitleSummaryTags } =
          await import("../memory/memory-enrichment");

        const pages = await db.select().from(libraryPages).where(visibleLibrary(req));
        const needsEnrichment = pages.filter((p) => !p.oneLiner || !p.summary);

        const childMap: Record<string, typeof pages> = {};
        for (const p of pages) {
          if (p.parentId) {
            if (!childMap[p.parentId]) childMap[p.parentId] = [];
            childMap[p.parentId].push(p);
          }
        }

        function getDepth(page: (typeof pages)[0]): number {
          let depth = 0;
          let current = page;
          while (current.parentId) {
            depth++;
            const parent = pages.find((p) => p.id === current.parentId);
            if (!parent) break;
            current = parent;
          }
          return depth;
        }

        needsEnrichment.sort((a, b) => getDepth(b) - getDepth(a));

        backfillState.total = needsEnrichment.length;
        const BATCH_SIZE = 10;
        const BATCH_DELAY_MS = 2000;

        for (let i = 0; i < needsEnrichment.length; i++) {
          const page = needsEnrichment[i];
          backfillState.detail = page.title;
          if (i > 0 && i % BATCH_SIZE === 0) {
            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
          }

          try {
            let contentForEnrich = page.plainTextContent || "";
            if (contentForEnrich.length < 50) {
              const children = childMap[page.id] || [];
              const freshChildren = await db
                .select()
                .from(libraryPages)
                .where(eq(libraryPages.parentId, page.id));
              const childContext = freshChildren
                .map((c) => {
                  const parts = [c.title];
                  if (c.oneLiner) parts.push(c.oneLiner);
                  return parts.join(" — ");
                })
                .filter(Boolean);
              if (childContext.length > 0) {
                contentForEnrich = `${page.title || "Untitled"}\n\nChild pages:\n${childContext.join("\n")}`;
              } else {
                contentForEnrich = page.title || "Untitled";
              }
            }

            const {
              title,
              oneLiner,
              summary: genSummary,
              tags,
            } = await generateTitleSummaryTags({
              content: contentForEnrich,
              source: "library",
              title: page.title,
            });

            const existingTags = page.tags || [];
            const mergedTags = [...new Set([...existingTags, ...tags])];

            await db
              .update(libraryPages)
              .set({
                oneLiner: oneLiner || null,
                summary: genSummary || null,
                tags: mergedTags,
                updatedAt: new Date(),
              })
              .where(eq(libraryPages.id, page.id));

            const [existingEntryRaw] = await db
              .select(memoryEntryLightColumns)
              .from(memoryEntries)
              .where(
                visibleMemory(
                  req,
                  and(
                    eq(memoryEntries.source, "library"),
                    eq(memoryEntries.sourceId, page.id),
                  ),
                ),
              );
            const existingEntry = existingEntryRaw
              ? wrapLightEntry(
                  existingEntryRaw as Omit<MemoryEntry, "embedding">,
                )
              : null;
            if (existingEntry) {
              await db
                .update(memoryEntries)
                .set({
                  oneLiner: oneLiner || null,
                  title: title || existingEntry.title,
                  summary: genSummary || existingEntry.summary,
                  tags: mergedTags,
                })
                .where(eq(memoryEntries.id, existingEntry.id));
            }

            backfillState.enriched++;
            log.debug(
              `[backfill] Enriched library page "${page.title}" (${i + 1}/${needsEnrichment.length})`,
            );
          } catch (pageErr: unknown) {
            backfillState.errors++;
            log.warn(
              `[backfill] Failed to enrich page "${page.title}": ${pageErr instanceof Error ? pageErr.message : String(pageErr)}`,
            );
          }
        }

        // Phase 2: re-summarize library mid/long memory entries whose summary is missing
        // or is effectively a verbatim dump of the linked page's plainTextContent.
        const brokenLibraryEntries = await findBrokenLibraryMemoryEntries();
        if (brokenLibraryEntries.length > 0) {
          backfillState.total += brokenLibraryEntries.length;
          log.debug(
            `[backfill] Found ${brokenLibraryEntries.length} library memory entries with missing/dumped summaries — re-summarizing`,
          );

          for (let i = 0; i < brokenLibraryEntries.length; i++) {
            const { entry, page } = brokenLibraryEntries[i];
            const titleHint = page?.title || entry.title || "Untitled";
            backfillState.detail = `re-summarize: ${titleHint}`;

            if (i > 0 && i % BATCH_SIZE === 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, BATCH_DELAY_MS),
              );
            }

            try {
              const contentForEnrich =
                page?.plainTextContent && page.plainTextContent.length > 0
                  ? page.plainTextContent
                  : entry.content;

              const {
                title,
                oneLiner,
                summary: genSummary,
                tags,
              } = await generateTitleSummaryTags({
                content: contentForEnrich,
                source: "library",
                title: titleHint,
              });

              const finalTitle =
                title &&
                title.trim() &&
                title.trim().toLowerCase() !== "untitled"
                  ? title.trim()
                  : titleHint;

              await db
                .update(memoryEntries)
                .set({
                  summary: genSummary || null,
                  oneLiner: oneLiner || null,
                  title: finalTitle,
                  tags: tags && tags.length > 0 ? tags : entry.tags,
                  processedAt: new Date(),
                })
                .where(eq(memoryEntries.id, entry.id));

              if (page) {
                const existingTags = page.tags || [];
                const mergedTags = [...new Set([...existingTags, ...tags])];
                await db
                  .update(libraryPages)
                  .set({
                    oneLiner: oneLiner || page.oneLiner || null,
                    summary: genSummary || page.summary || null,
                    tags: mergedTags,
                    updatedAt: new Date(),
                  })
                  .where(eq(libraryPages.id, page.id));
              }

              backfillState.enriched++;
              log.debug(
                `[backfill] Re-summarized library memory #${entry.id} ("${titleHint}") (${i + 1}/${brokenLibraryEntries.length})`,
              );
            } catch (resumErr: unknown) {
              backfillState.errors++;
              log.warn(
                `[backfill] Failed to re-summarize library memory #${entry.id}: ${resumErr instanceof Error ? resumErr.message : String(resumErr)}`,
              );
            }
          }
        } else {
          log.debug(`[backfill] No broken library memory entries found`);
        }

        backfillState.detail = "";
        backfillState.finishedAt = Date.now();
        backfillState.running = false;
      } catch (err: unknown) {
        log.error(
          `[backfill] Fatal error: ${err instanceof Error ? err.message : String(err)}`,
        );
        backfillState.errors = Math.max(1, backfillState.errors + 1);
        backfillState.detail = `Fatal: ${err instanceof Error ? err.message : String(err)}`;
        backfillState.finishedAt = Date.now();
        backfillState.running = false;
      }
    })();
  });

  app.post("/api/library/pages/:id/enrich", async (req, res) => {
    try {
      const { generateTitleSummaryTags } =
        await import("../memory/memory-enrichment");
      const pageId = req.params.id;

      const [page] = await db
        .select()
        .from(libraryPages)
        .where(visibleLibrary(req, eq(libraryPages.id, pageId)));
      if (!page) return res.status(404).json({ error: "Page not found" });

      let contentForEnrich = page.plainTextContent || "";
      if (contentForEnrich.length < 50) {
        const children = await db
          .select()
          .from(libraryPages)
          .where(eq(libraryPages.parentId, page.id));
        const childContext = children
          .map((c) => {
            const parts = [c.title];
            if (c.oneLiner) parts.push(c.oneLiner);
            return parts.join(" — ");
          })
          .filter(Boolean);
        if (childContext.length > 0) {
          contentForEnrich = `${page.title || "Untitled"}\n\nChild pages:\n${childContext.join("\n")}`;
        } else {
          contentForEnrich = page.title || "Untitled";
        }
      }

      const {
        title,
        oneLiner,
        summary: genSummary,
        tags,
      } = await generateTitleSummaryTags({
        content: contentForEnrich,
        source: "library",
        title: page.title,
      });

      const existingTags = page.tags || [];
      const mergedTags = [...new Set([...existingTags, ...tags])];

      await db
        .update(libraryPages)
        .set({
          oneLiner: oneLiner || null,
          summary: genSummary || null,
          tags: mergedTags,
          updatedAt: new Date(),
        })
        .where(eq(libraryPages.id, page.id));

      const [existingEntryRaw2] = await db
        .select(memoryEntryLightColumns)
        .from(memoryEntries)
        .where(
          visibleMemory(
            req,
            and(
              eq(memoryEntries.source, "library"),
              eq(memoryEntries.sourceId, page.id),
            ),
          ),
        );
      const existingEntry = existingEntryRaw2
        ? wrapLightEntry(existingEntryRaw2 as Omit<MemoryEntry, "embedding">)
        : null;
      if (existingEntry) {
        await db
          .update(memoryEntries)
          .set({
            oneLiner: oneLiner || null,
            title: title || existingEntry.title,
            summary: genSummary || existingEntry.summary,
            tags: mergedTags,
          })
          .where(eq(memoryEntries.id, existingEntry.id));
      }

      const [updated] = await db
        .select()
        .from(libraryPages)
        .where(visibleLibrary(req, eq(libraryPages.id, pageId)));
      res.json(updated);
    } catch (err: any) {
      log.error(`[enrich-single] Error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Unified semantic search ────────────────────────────────────────────────

  app.get("/api/info/search", async (req, res) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q) return res.json([]);
      const response = await searchVnextMemory({ query: q, limit: 20, source: ["library", "note"] });
      res.json(response.results.map(({ claim, score, embeddingSimilarity, lexicalSimilarity, textMatch, linkCount, retrievalPath }) => ({
        storage: "memory_vnext_claims",
        claim,
        score,
        embeddingSimilarity,
        lexicalSimilarity,
        textMatch,
        linkCount,
        retrievalPath,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Scratch Files ────────────────────────────────────────────────────────────

  app.get("/api/info/files/scratch", async (req, res) => {
    const principal = principalOrThrow(req);
    if (principal.actorType !== "system" && !principal.isAdmin) {
      return res.json([]);
    }
    try {
      const fsp = await import("fs/promises");
      const fs = await import("fs");
      const { join } = await import("path");

      const scratchDir = WORKSPACE_DIR;
      const walk = async (
        dir: string,
        prefix = "",
      ): Promise<Array<{ path: string; size: number; mtime: string }>> => {
        const results: Array<{ path: string; size: number; mtime: string }> =
          [];
        let entries: import("fs").Dirent[] = [];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return results;
        }
        for (const entry of entries) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          const abs = join(dir, entry.name);
          if (entry.isDirectory()) {
            results.push(...(await walk(abs, rel)));
          } else {
            try {
              const stat = await fsp.stat(abs);
              results.push({
                path: rel,
                size: stat.size,
                mtime: stat.mtime.toISOString(),
              });
            } catch {
              results.push({
                path: rel,
                size: 0,
                mtime: new Date().toISOString(),
              });
            }
          }
        }
        return results;
      };

      let files: Array<{ path: string; size: number; mtime: string }> = [];
      try {
        files = await walk(scratchDir);
      } catch {
        files = [];
      }
      void fs; // keep import block clean — fs imported above for typing only

      res.json(files.slice(0, 500));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/files/scratch/read", async (req, res) => {
    try {
      const relPath = String(req.query.path || "");
      if (!relPath) return res.status(400).json({ error: "Invalid path" });
      const fsp = await import("fs/promises");
      const fs = await import("fs");
      const { resolve } = await import("path");
      const scratchRoot = resolve(WORKSPACE_DIR);
      const absPath = resolve(scratchRoot, relPath);
      if (!absPath.startsWith(scratchRoot + "/") && absPath !== scratchRoot) {
        return res
          .status(403)
          .json({ error: "Access denied: path outside workspace" });
      }
      try {
        await fsp.access(absPath, fs.constants.R_OK);
      } catch {
        return res.status(404).json({ error: "File not found" });
      }
      const stat = await fsp.stat(absPath);
      if (stat.isDirectory())
        return res.status(400).json({ error: "Path is a directory" });
      if (stat.size > 1024 * 1024)
        return res
          .status(400)
          .json({ error: "File too large to preview (>1MB)" });
      const content = await fsp.readFile(absPath, "utf-8");
      res.json({ path: relPath, content, size: stat.size });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/files/bucket", async (req, res) => {
    const principal = principalOrThrow(req);
    if (principal.actorType !== "system" && !principal.isAdmin) {
      return res.json({ bucketName: null, files: [], error: null });
    }
    try {
      const { storageBackend, PRIVATE_PREFIX } =
        await import("../object_storage");

      const bucketName = storageBackend.getBucketName();
      const files = await storageBackend.listObjects(PRIVATE_PREFIX, {
        maxKeys: 500,
      });

      const fileList = files.map((f) => {
        const entityId = f.key.slice(PRIVATE_PREFIX.length);
        return {
          name: f.key,
          size: f.size,
          contentType: "",
          updated: f.updatedAt ? f.updatedAt.toISOString() : "",
          downloadUrl: `/objects/${entityId}`,
        };
      });

      res.json({ bucketName, files: fileList });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Object storage files list failed: ${message}`);
      res.json({ bucketName: null, files: [], error: message });
    }
  });

  // ─── DB Browser ──────────────────────────────────────────────────────────────

  app.get("/api/info/db/size", async (req, res) => {
    const principal = principalOrThrow(req);
    if (principal.actorType !== "system" && !principal.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      await pool.query(`ANALYZE`);
      const dbSize = await pool.query(
        `SELECT pg_database_size(current_database()) AS total_bytes`,
      );
      const tableSizes = await pool.query(`
        SELECT
          c.relname AS table_name,
          pg_total_relation_size(c.oid) AS total_bytes,
          pg_relation_size(c.oid) AS table_bytes,
          pg_indexes_size(c.oid) AS index_bytes,
          COALESCE(s.n_live_tup, 0)::bigint AS row_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
      `);
      res.json({
        totalBytes: parseInt(dbSize.rows[0].total_bytes, 10),
        tables: tableSizes.rows.map(
          (r: {
            table_name: string;
            total_bytes: string;
            table_bytes: string;
            index_bytes: string;
            row_count: string;
          }) => ({
            name: r.table_name,
            totalBytes: parseInt(r.total_bytes, 10),
            tableBytes: parseInt(r.table_bytes, 10),
            indexBytes: parseInt(r.index_bytes, 10),
            rowCount: parseInt(r.row_count, 10) || 0,
          }),
        ),
      });
    } catch (err: unknown) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/info/db/tables", async (req, res) => {
    const principal = principalOrThrow(req);
    if (principal.actorType !== "system" && !principal.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const result = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      res.json(result.rows.map((r: { table_name: string }) => r.table_name));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/info/db/tables/:table", async (req, res) => {
    const principal = principalOrThrow(req);
    if (principal.actorType !== "system" && !principal.isAdmin) {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const tableName = req.params.table.replace(/[^a-z0-9_]/gi, "");
      if (!tableName)
        return res.status(400).json({ error: "Invalid table name" });
      const page = Math.max(0, parseInt(String(req.query.page || "0"), 10));
      const limit = Math.min(
        100,
        Math.max(1, parseInt(String(req.query.limit || "50"), 10)),
      );
      const offset = page * limit;

      const countResult = await pool.query(
        `SELECT COUNT(*) as cnt FROM "${tableName}"`,
      );
      const rowsResult = await pool.query(
        `SELECT * FROM "${tableName}" LIMIT $1 OFFSET $2`,
        [limit, offset],
      );

      res.json({
        table: tableName,
        total: parseInt(countResult.rows[0].cnt, 10),
        page,
        limit,
        rows: rowsResult.rows,
        columns: rowsResult.fields?.map((f: FieldDef) => f.name) ?? [],
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}

export async function upsertLibraryPageMemory(
  page: LibraryPage,
): Promise<void> {
  // Compatibility alias during legacy retirement. Library pages feed vNext
  // directly through the source queue; no memory_entries mirror is maintained.
  const principal = getCurrentPrincipalOrSystem();
  await markSourceChanged("library_page", page.id, principal);
  log.debug(`[vnext_ingest] queued source=library_page sourceId=${page.id} via=compat_alias`);
}

