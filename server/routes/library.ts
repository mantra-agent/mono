import type { Express } from "express";
import type { FieldDef } from "pg";
import { db, pool, isSerializationConflict, runWithDatabaseTransaction } from "../db";
import { z } from "zod";
import {
  eq,
  desc,
  asc,
  and,
  or,
  ilike,
  isNull,
  isNotNull,
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
  libraryPages,
  libraryPagePins,
  libraryPageTrash,
  libraryPageLinks,
  libraryAnnotations,
  libraryPageViews,
} from "@shared/models/info";
import type { LibraryPage } from "@shared/models/info";
// Vault destination validation lives in server/library-move.ts.
import { searchVnextMemory } from "../memory/vnext-search";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { getPrincipal } from "../principal";
import { requireCurrentPrincipal } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { combineWithAuthorizedScope } from "../authorize";
import { WORKSPACE_DIR } from "../paths";
import { eventBus } from "../event-bus";
import { markSourceChanged, registerSourceIfAbsent } from "../memory/vnext-source-queue";
import { normalizeLibraryStructuralRole } from "../library-domain";
import { libraryPageIsPinned } from "../library-pin";
import { libraryPageIsLive, libraryPageIsTrashed } from "../library-trash";
import { getLibraryPageNeighbors } from "../library-link-graph";
import { backfillLibraryReferences, getLibraryReferenceNeighborhood, indexLibraryPageReferences } from "../library-reference-index";
import { projectActiveLibraryReminders } from "../library-reminders";
import { buildLibrarySurfaceSet } from "../library-save";
import { syncLibraryPageTags } from "../library-tag-sync";

const log = createLogger("InfoRoutes");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
  objectId: libraryPages.id,
};

function principalOrThrow(req: any) {
  const principal = getPrincipal(req);
  if (!principal)
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  return principal;
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
  // Trashed pages (those with a library_page_trash row) are excluded from every read that
  // flows through this boundary — list, tree, single get, index, unread, and
  // search. Trash (a later step) reads with its own predicate.
  // Access is ownership OR a live library_page/vault grant, including descendants
  // of a granted page. Placement stays the owner's.
  const principal = principalOrThrow(req);
  const ownedLive = combineWithVisibleScope(principal, libraryScopeColumns, libraryPageIsLive());
  return combineWithAuthorizedScope(
    principal,
    ownedLive,
    "library_page",
    libraryScopeColumns,
    "read",
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

function authorizedLibraryWrite(req: any, predicate?: SQL): SQL {
  const principal = principalOrThrow(req);
  return combineWithAuthorizedScope(
    principal,
    combineWithWritableScope(principal, libraryScopeColumns),
    "library_page",
    libraryScopeColumns,
    "write",
    predicate,
  );
}

// Trash read boundary: the inverse of visibleLibrary — only trashed pages
// (those with a library_page_trash row), still owner/account/vault scoped. Vault-visibility
// (top-bar toggles) and vault-chip filtering are applied client-side over this
// owner-scoped set, exactly like the live list/tree endpoints.
function trashedLibrary(req: any, predicate?: SQL): SQL {
  const trashed = libraryPageIsTrashed();
  return combineWithVisibleScope(
    principalOrThrow(req),
    libraryScopeColumns,
    predicate ? and(predicate, trashed) : trashed,
  );
}

// Library hierarchy mutations are delegated to server/library-move.ts.

const librarySurfaceInput = {
  surface: z.boolean().optional(),
  surfaceDurationHours: z.number().positive().optional(),
  surfaceReason: z.string().nullable().optional(),
  surfaceSection: z.string().nullable().optional(),
};

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

  // Schema and legacy-data convergence is owned by schema-convergence.ts.
  // Route registration composes HTTP behavior only.

  // ─── Library Pages CRUD ───────────────────────────────────────────────

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
        isPinned: libraryPageIsPinned(),
        vaultId: libraryPages.vaultId,
        structuralRole: libraryPages.structuralRole,
        scope: libraryPages.scope,
        ownerUserId: libraryPages.ownerUserId,
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
          isPinned: libraryPageIsPinned(),
          vaultId: libraryPages.vaultId,
          structuralRole: libraryPages.structuralRole,
          scope: libraryPages.scope,
          ownerUserId: libraryPages.ownerUserId,
          updatedAt: libraryPages.updatedAt,
        })
        .from(libraryPages)
        .where(visibleLibrary(req))
        .orderBy(desc(libraryPageIsPinned()), asc(libraryPages.sortOrder), asc(libraryPages.title));
      const pages = await projectActiveLibraryReminders(rawPages);

      type PageWithChildren = (typeof pages)[number] & {
        children: PageWithChildren[];
      };
      const byId = new Map(pages.map((page) => [page.id, page]));
      const attachChildren = (node: (typeof pages)[number]): PageWithChildren => ({
        ...node,
        children: pages
          .filter((page) => page.parentId === node.id)
          .map(attachChildren),
      });
      const roots = pages
        .filter((page) => !page.parentId || !byId.has(page.parentId))
        .map(attachChildren);

      res.json(roots);
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

  // Trash: flat list of the principal's trashed pages. Returned with parent_id
  // and vault_id so the client rebuilds the trashed forest (subtrees render
  // intact), shows source-vault chips, and applies top-bar vault visibility +
  // in-Trash vault filtering. Registered before `/:id` so "trash" is not
  // captured as a page id.
  app.get("/api/info/library/trash", async (req, res) => {
    try {
      const rows = await db
        .select({
          id: libraryPages.id,
          pageId: libraryPages.pageId,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          tags: libraryPages.tags,
          emoji: libraryPages.emoji,
          oneLiner: libraryPages.oneLiner,
          summary: libraryPages.summary,
          vaultId: libraryPages.vaultId,
          structuralRole: libraryPages.structuralRole,
          scope: libraryPages.scope,
          createdAt: libraryPages.createdAt,
          updatedAt: libraryPages.updatedAt,
          deletedAt: libraryPageTrash.deletedAt,
        })
        .from(libraryPages)
        .innerJoin(libraryPageTrash, eq(libraryPageTrash.pageId, libraryPages.id))
        .where(trashedLibrary(req))
        .orderBy(desc(libraryPageTrash.deletedAt), asc(libraryPages.title));
      res.json(rows);
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
      const detailColumns = {
        id: libraryPages.id,
        pageId: libraryPages.pageId,
        title: libraryPages.title,
        slug: libraryPages.slug,
        content: libraryPages.content,
        plainTextContent: libraryPages.plainTextContent,
        parentId: libraryPages.parentId,
        memoryEntryId: libraryPages.memoryEntryId,
        oneLiner: libraryPages.oneLiner,
        summary: libraryPages.summary,
        tags: libraryPages.tags,
        status: libraryPages.status,
        emoji: libraryPages.emoji,
        surface: libraryPages.surface,
        surfaceUntil: libraryPages.surfaceUntil,
        surfaceReason: libraryPages.surfaceReason,
        surfaceSection: libraryPages.surfaceSection,
        sortOrder: libraryPages.sortOrder,
        isPinned: libraryPageIsPinned(),
        createdBySessionId: libraryPages.createdBySessionId,
        scope: libraryPages.scope,
        ownerUserId: libraryPages.ownerUserId,
        accountId: libraryPages.accountId,
        vaultId: libraryPages.vaultId,
        structuralRole: libraryPages.structuralRole,
        createdByUserId: libraryPages.createdByUserId,
        updatedByUserId: libraryPages.updatedByUserId,
        createdAt: libraryPages.createdAt,
        updatedAt: libraryPages.updatedAt,
      };
      const byId = await db
        .select(detailColumns)
        .from(libraryPages)
        .where(visibleLibrary(req, eq(libraryPages.id, req.params.id)));
      if (byId.length > 0) {
        page = byId[0];
      } else {
        const bySlug = await db
          .select(detailColumns)
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
        .where(combineWithVisibleScope(principal, { scope: libraryPageLinks.scope, ownerUserId: libraryPageLinks.ownerUserId, accountId: libraryPageLinks.accountId }, and(eq(libraryPageLinks.targetPageId, req.params.id), libraryPageIsLive())));
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
        .where(combineWithVisibleScope(principal, { scope: libraryPageLinks.scope, ownerUserId: libraryPageLinks.ownerUserId, accountId: libraryPageLinks.accountId }, and(eq(libraryPageLinks.sourcePageId, req.params.id), libraryPageIsLive())));
      const inbound = await getLibraryPageNeighbors([req.params.id], principal, 50);
      res.json({ outbound, neighbors: inbound });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const reorderSchema = z.object({
    id: z.string(),
    parentId: z.string().nullable(),
    destinationVaultId: z.string().min(1).optional(),
    sortOrder: z.number().int().min(0),
  });

  // Cycle and subtree validation live in the canonical move service.

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
    const { id, parentId, destinationVaultId, sortOrder } = parsed;
    try {
      const { moveLibraryPage } = await import("../library-move");
      const result = await moveLibraryPage(
        {
          pageId: id,
          destinationParentId: parentId,
          destinationVaultId,
          sortOrder,
        },
        principalOrThrow(req),
      );
      publishLibraryChanged("moved", result.page);
      return res.json(result.page);
    } catch (err: any) {
      if (isSerializationConflict(err) || err?.status === 409) {
        return res.status(409).json({
          error: err.message || "Reorder conflict; please retry",
          code: err?.code,
          retry: true,
        });
      }
      return res.status(err?.status ?? 500).json({ error: err.message });
    }
  });

  const createPageSchema = z.object({
    title: z.string().default(""),
    content: z.any().optional(),
    plainTextContent: z.string().default(""),
    parentId: z.string().nullable().optional(),
    vaultId: z.string().min(1).nullable().optional(),
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
        explicitParentId: data.parentId ?? null,
        explicitVaultId: data.vaultId ?? null,
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
      res.status(err?.status ?? 500).json({ error: err.message });
    }
  });

  const updatePageSchema = z.object({
    title: z.string().optional(),
    content: z.any().optional(),
    plainTextContent: z.string().optional(),
    parentId: z.string().nullable().optional(),
    destinationVaultId: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    status: z.string().nullable().optional(),
    emoji: z.string().nullable().optional(),
    structuralRole: z.enum(["source", "artifact", "wiki", "meta"]).optional(),
    isPinned: z.boolean().optional(),
    linkPages: z.array(z.string()).optional(),
    ...librarySurfaceInput,
  });

  app.patch("/api/info/library/:id", async (req, res) => {
    try {
      const updates = updatePageSchema.parse(req.body);
      const setData: Partial<typeof libraryPages.$inferInsert> & {
        updatedAt: Date;
      } = { updatedAt: new Date() };
      const [existingPage] = await db
        .select({ tags: libraryPages.tags })
        .from(libraryPages)
        .where(authorizedLibraryWrite(req, eq(libraryPages.id, req.params.id)))
        .limit(1);
      if (!existingPage) return res.status(404).json({ error: "Library page not found" });
      const systemManaged = existingPage.tags.includes("system-folder");
      const structureRequested =
        updates.parentId !== undefined
        || updates.destinationVaultId !== undefined
        || updates.tags !== undefined
        || updates.structuralRole !== undefined
        || updates.isPinned !== undefined
        || updates.surface !== undefined
        || updates.surfaceDurationHours !== undefined
        || updates.surfaceReason !== undefined
        || updates.surfaceSection !== undefined;
      if (structureRequested) {
        const [ownedPage] = await db
          .select({ id: libraryPages.id })
          .from(libraryPages)
          .where(writableLibrary(req, eq(libraryPages.id, req.params.id)))
          .limit(1);
        if (!ownedPage) {
          return res.status(403).json({ error: "Write access does not include moving, tagging, pinning, or surfacing this page." });
        }
      }
      if (systemManaged && (
        updates.title !== undefined
        || updates.parentId !== undefined
        || updates.tags !== undefined
        || updates.structuralRole !== undefined
      )) {
        return res.status(403).json({ error: "System-managed Library structure cannot be renamed, moved, or reclassified." });
      }
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
      let movedPage: LibraryPage | null = null;
      if (updates.parentId !== undefined) {
        const { moveLibraryPage } = await import("../library-move");
        const moveResult = await moveLibraryPage(
          {
            pageId: req.params.id,
            destinationParentId: updates.parentId,
            destinationVaultId: updates.destinationVaultId,
          },
          principalOrThrow(req),
        );
        movedPage = moveResult.page;
      }
      if (updates.tags !== undefined) setData.tags = updates.tags;
      if (updates.emoji !== undefined) setData.emoji = updates.emoji;
      if (updates.structuralRole !== undefined)
        setData.structuralRole = normalizeLibraryStructuralRole(updates.structuralRole);
      Object.assign(setData, buildLibrarySurfaceSet(updates));

      if (updates.isPinned !== undefined) {
        const [writablePage] = await db
          .select({ id: libraryPages.id })
          .from(libraryPages)
          .where(writableLibrary(req, eq(libraryPages.id, req.params.id)))
          .limit(1);
        if (!writablePage)
          return res.status(404).json({ error: "Library page not found" });

        if (updates.isPinned) {
          await db
            .insert(libraryPagePins)
            .values({ pageId: writablePage.id })
            .onConflictDoNothing();
        } else {
          await db
            .delete(libraryPagePins)
            .where(eq(libraryPagePins.pageId, writablePage.id));
        }
      }

      const hasMetadataUpdates = Object.keys(setData).some(
        (key) => key !== "updatedAt",
      );
      let updated = movedPage;
      if (hasMetadataUpdates || (!movedPage && updates.isPinned === undefined)) {
        updated = await db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
          const [row] = await tx
            .update(libraryPages)
            .set({
              ...setData,
              updatedByUserId: principalOrThrow(req).userId ?? undefined,
            })
            .where(authorizedLibraryWrite(req, eq(libraryPages.id, req.params.id)))
            .returning();
          if (row && (updates.content !== undefined || updates.plainTextContent !== undefined)) {
            await indexLibraryPageReferences(principalOrThrow(req), row);
          }
          return row ?? null;
        }));
      } else if (!updated && updates.isPinned !== undefined) {
        [updated] = await db
          .select()
          .from(libraryPages)
          .where(authorizedLibraryWrite(req, eq(libraryPages.id, req.params.id)))
          .limit(1);
      }
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

      if (updates.tags !== undefined) {
        syncLibraryPageTags(updated.id, updated.title, updated.tags);
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
      res.json(updates.isPinned === undefined ? updated : { ...updated, isPinned: updates.isPinned });
    } catch (err: any) {
      if (err.name === "ZodError")
        return res
          .status(400)
          .json({ error: "Invalid input", details: err.errors });
      res.status(err?.status ?? 500).json({ error: err.message });
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
        .select({ id: libraryPages.id, tags: libraryPages.tags, title: libraryPages.title })
        .from(libraryPages)
        .where(writableLibrary(req, eq(libraryPages.id, req.params.id)));
      if (!page)
        return res.status(404).json({ error: "Library page not found" });
      if (page.tags?.includes("system-folder"))
        return res
          .status(403)
          .json({ error: "System folders cannot be deleted." });
      // Soft-delete: write a library_page_trash sidecar row across this page and
      // its entire subtree. Rows stay in the DB with vault/parent/placements
      // intact so restore is a pure undelete; every read path excludes pages
      // that have a sidecar row.
      const { softDeleteLibrarySubtree } = await import("../library-domain");
      const { trashedCount } = await softDeleteLibrarySubtree(
        principalOrThrow(req),
        page.id,
      );
      if (trashedCount === 0)
        return res.status(404).json({ error: "Library page not found" });
      publishLibraryChanged("deleted", { id: page.id, title: page.title });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Restore a trashed page (and its trashed subtree unit) back to the live
  // Library. Delegates to the canonical restoreLibrarySubtree mutation, which
  // removes the sidecar rows across the unit and returns the root to its original
  // parent (or the source vault root when that parent is gone).
  app.post("/api/info/library/:id/restore", async (req, res) => {
    try {
      const [page] = await db
        .select({ id: libraryPages.id, title: libraryPages.title })
        .from(libraryPages)
        .where(trashedLibrary(req, eq(libraryPages.id, req.params.id)));
      if (!page)
        return res.status(404).json({ error: "Trashed Library page not found" });
      const { restoreLibrarySubtree } = await import("../library-domain");
      const { restoredCount } = await restoreLibrarySubtree(
        principalOrThrow(req),
        page.id,
      );
      if (restoredCount === 0)
        return res.status(404).json({ error: "Trashed Library page not found" });
      publishLibraryChanged("restored", { id: page.id, title: page.title });
      res.json({ ok: true, restoredCount });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Empty Trash: permanently hard-delete a set of trashed pages. This is the
  // ONLY irreversible, user-triggered destruction endpoint, and the counted
  // confirmation gate lives in the client. The blast radius is the EXACT visible
  // trashed set the client is showing (top-bar vault toggles + active vault
  // chip), passed as pageIds — pages in toggled-off vaults are never included by
  // the client, so "you can only permanently destroy what you can currently
  // see." The server independently constrains destruction to rows that are
  // actually trashed AND owned (trashedLibrary scope), then routes through the
  // canonical hardDeleteLibraryPages path, which additionally enforces writable
  // scope and the presence of a library_page_trash sidecar row.
  app.post("/api/info/library/trash/empty", async (req, res) => {
    try {
      const parsed = z
        .object({ pageIds: z.array(z.string().min(1)).max(5000) })
        .parse(req.body ?? {});
      if (parsed.pageIds.length === 0) {
        return res.json({ ok: true, deletedCount: 0 });
      }
      // Re-validate the requested ids to this owner's trashed rows only.
      const targets = await db
        .select({ id: libraryPages.id })
        .from(libraryPages)
        .where(trashedLibrary(req, inArray(libraryPages.id, parsed.pageIds)));
      const ids = targets.map((row) => row.id);
      if (ids.length === 0) {
        return res.json({ ok: true, deletedCount: 0 });
      }
      const { hardDeleteLibraryPages } = await import("../library-domain");
      const { deletedCount } = await hardDeleteLibraryPages(
        principalOrThrow(req),
        ids,
      );
      publishLibraryChanged("purged");
      res.json({ ok: true, deletedCount });
    } catch (err: any) {
      if (err.name === "ZodError")
        return res
          .status(400)
          .json({ error: "Invalid input", details: err.errors });
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

      const visibleIds = new Set(allPages.map((page) => page.id));
      const filtered = allPages.filter((p) =>
        isRoot ? !p.parentId || !visibleIds.has(p.parentId) : p.parentId === parentId,
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

  app.post("/api/library/references/backfill", async (req, res) => {
    try {
      const input = z.object({ cursor: z.string().min(1).optional(), limit: z.number().int().positive().max(100).optional() }).parse(req.body ?? {});
      res.json(await backfillLibraryReferences(principalOrThrow(req), input));
    } catch (err: any) {
      if (err.name === "ZodError") return res.status(400).json({ error: "Invalid input", details: err.errors });
      res.status(err?.status ?? 500).json({ error: err.message });
    }
  });

  app.get("/api/library/references/parity", async (req, res) => {
    try {
      const pageIds = typeof req.query.pageIds === "string" ? req.query.pageIds.split(",").map(value => value.trim()).filter(Boolean).slice(0, 50) : [];
      if (pageIds.length === 0) return res.status(400).json({ error: "Provide one or more comma-separated pageIds" });
      const result = await getLibraryReferenceNeighborhood(principalOrThrow(req), pageIds);
      res.json({ pageIds, parity: result.parity, usedCompatibilityFallback: result.usedCompatibilityFallback });
    } catch (err: any) {
      res.status(err?.status ?? 500).json({ error: err.message });
    }
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
          await import("../title-summary-tags");

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

            syncLibraryPageTags(page.id, title || page.title, mergedTags);

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
        await import("../title-summary-tags");
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

      syncLibraryPageTags(page.id, title || page.title, mergedTags);

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
  const principal = requireCurrentPrincipal();
  await markSourceChanged("library_page", page.id, principal);
  log.debug(`[vnext_ingest] queued source=library_page sourceId=${page.id} via=compat_alias`);
}

