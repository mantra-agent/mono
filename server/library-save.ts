import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { acquireLibraryParentLocks, db } from "./db";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import type { LibrarySemanticPlacementResult } from "./library-placement";
import { markSourceChanged } from "./memory/vnext-source-queue";
import type { Principal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, ownedInsertValues } from "./scoped-storage";
import { libraryPages } from "@shared/models/info";
import { syncEmbeddedLibraryPageLinks } from "./library-link-graph";
import { syncContentFields } from "@shared/markdown-tiptap";
import {
  assertWritableVault,
  normalizeLibraryStructuralRole,
  type LibraryStructuralRole,
} from "./library-domain";

export interface CreateFiledLibraryPageInput {
  title: string;
  markdown: string;
  purpose?: string | null;
  /**
   * Deterministic canonical folder placement. When set and no explicit parent
   * is supplied, the page is filed under the per-vault Plans/Workflows/Specs/
   * Skills folder (get-or-created on demand). This is the single structural
   * placement authority for the four canonical folders; it is independent of
   * the retired Library2 Wiki/Index/Log metadata system.
   */
  canonicalFolder?: CanonicalVaultFolder | null;
  explicitParentId?: string | null;
  explicitVaultId?: string | null;
  pageContext?: string | null;
  contentSummary?: string | null;
  tags?: string[];
  status?: string | null;
  structuralRole?: LibraryStructuralRole | null;
  createdBySessionId?: string | null;
  id?: string;
  slugSuffix?: string | null;
  surface?: boolean;
  surfaceDurationHours?: number;
  surfaceReason?: string | null;
  surfaceSection?: string | null;
}

export type CreatedFiledLibraryPage = typeof libraryPages.$inferSelect & {
  filingResolution: LibrarySemanticPlacementResult;
};

const log = createLogger("LibrarySave");

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export const CANONICAL_VAULT_FOLDERS = ["plans", "workflows", "specs", "skills"] as const;
export type CanonicalVaultFolder = (typeof CANONICAL_VAULT_FOLDERS)[number];

const CANONICAL_FOLDER_DEFS: Record<
  CanonicalVaultFolder,
  { title: string; tag: string; sortOrder: number; description: string }
> = {
  plans: { title: "Plans", tag: "canonical-folder-plans", sortOrder: 900, description: "Multi-step execution plans for this vault." },
  workflows: { title: "Workflows", tag: "canonical-folder-workflows", sortOrder: 901, description: "Workflow run checkpoints and lifecycle artifacts for this vault." },
  specs: { title: "Specs", tag: "canonical-folder-specs", sortOrder: 902, description: "Specifications and implementation designs for this vault." },
  skills: { title: "Skills", tag: "canonical-folder-skills", sortOrder: 903, description: "Skill run outputs, logs, and artifacts for this vault." },
};

export function isCanonicalVaultFolder(value: unknown): value is CanonicalVaultFolder {
  return typeof value === "string" && (CANONICAL_VAULT_FOLDERS as readonly string[]).includes(value);
}

/**
 * Get-or-create the canonical folder page for `(vaultId, kind)` at the vault
 * root, returning its page id. Identity is `(vault_id, root, folder tag)` under
 * a transaction-scoped advisory lock so concurrent producers converge on one
 * folder rather than forking duplicates. When duplicates already exist (e.g.
 * hand-migrated history), the earliest is treated as canonical. This is a fresh
 * deterministic placement authority for Plans/Workflows/Specs/Skills and does
 * not reuse the retired Library2 metadata (Wiki/Index/Log) machinery.
 */
export async function ensureCanonicalVaultFolder(input: {
  principal: Principal;
  vaultId: string;
  kind: CanonicalVaultFolder;
}): Promise<string> {
  const def = CANONICAL_FOLDER_DEFS[input.kind];
  const lockKey = `library-canonical-folder:${input.vaultId}:${input.kind}`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const existing = await tx
      .select({ id: libraryPages.id })
      .from(libraryPages)
      .where(
        combineWithVisibleScope(
          input.principal,
          libraryScopeColumns,
          and(
            eq(libraryPages.vaultId, input.vaultId),
            isNull(libraryPages.parentId),
            sql`${def.tag} = ANY(${libraryPages.tags})`,
          ),
        ),
      )
      .orderBy(asc(libraryPages.createdAt), asc(libraryPages.id))
      .limit(1);
    if (existing[0]) return existing[0].id;

    const synced = syncContentFields({ markdown: `# ${def.title}\n\n${def.description}` });
    const [created] = await tx
      .insert(libraryPages)
      .values({
        title: def.title,
        slug: slugifyLibraryTitle(def.title, input.kind),
        content: synced.content,
        plainTextContent: synced.plainTextContent,
        parentId: null,
        tags: ["folder", def.tag],
        structuralRole: "artifact",
        sortOrder: def.sortOrder,
        ...ownedInsertValues(input.principal, libraryScopeColumns),
        vaultId: input.vaultId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .returning({ id: libraryPages.id });
    log.info("Ensured canonical vault folder", { vaultId: input.vaultId, kind: input.kind, pageId: created.id });
    return created.id;
  });
}

export function slugifyLibraryTitle(title: string, fallback = "page"): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

export function buildLibrarySurfaceSet(input: {
  surface?: boolean;
  surfaceDurationHours?: number;
  surfaceReason?: string | null;
  surfaceSection?: string | null;
}): Partial<typeof libraryPages.$inferInsert> {
  if (input.surface === false) {
    return { surface: false, surfaceUntil: null, surfaceReason: null, surfaceSection: null };
  }
  if (input.surface === true && typeof input.surfaceDurationHours === "number" && input.surfaceDurationHours > 0) {
    return {
      surface: true,
      surfaceUntil: new Date(Date.now() + input.surfaceDurationHours * 60 * 60 * 1000),
      surfaceReason: input.surfaceReason ?? null,
      surfaceSection: input.surfaceSection ?? "inbox",
    };
  }
  return {};
}

export function publishLibraryChanged(action: string, page?: { id?: string | null; title?: string | null; surface?: boolean | null; surfaceUntil?: Date | string | null }) {
  eventBus.publish({
    category: "system",
    event: "data:library_changed",
    payload: {
      source: "library_service",
      action,
      pageId: page?.id ?? null,
      title: page?.title ?? null,
      surface: page?.surface ?? null,
      surfaceUntil: page?.surfaceUntil instanceof Date ? page.surfaceUntil.toISOString() : (page?.surfaceUntil ?? null),
    },
  });
}

async function resolveStandardLibraryPlacement(
  input: CreateFiledLibraryPageInput,
): Promise<LibrarySemanticPlacementResult> {
  const principal = getCurrentPrincipalOrSystem();
  const structuralRole = normalizeLibraryStructuralRole(
    input.structuralRole,
    "artifact",
  );

  if (input.explicitParentId) {
    const [parent] = await db
      .select({
        id: libraryPages.id,
        title: libraryPages.title,
        vaultId: libraryPages.vaultId,
      })
      .from(libraryPages)
      .where(
        combineWithVisibleScope(
          principal,
          libraryScopeColumns,
          and(
            eq(libraryPages.id, input.explicitParentId),
            isNull(libraryPages.deletedAt),
          ),
        ),
      )
      .limit(1);
    if (!parent?.vaultId) {
      throw Object.assign(new Error("Explicit Library parent is not visible"), {
        status: 404,
      });
    }
    return {
      outcome: "explicit_parent",
      vaultId: parent.vaultId,
      indexPageId: null,
      parentId: parent.id,
      parentTitle: parent.title,
      structuralRole,
      confidence: 1,
      reason: "Caller supplied an explicit parent in the standard Library hierarchy.",
      lint: { requiresReview: false, code: "explicit_parent", message: null },
      compatibility: { purpose: input.purpose ?? null },
    };
  }

  const requestedVaultId =
    input.explicitVaultId ??
    principal.activeVaultId ??
    (principal.visibleVaultIds.length === 1 ? principal.visibleVaultIds[0] : null);
  if (!requestedVaultId) {
    throw Object.assign(
      new Error("Choose an active Vault before creating a Library page"),
      { status: 400 },
    );
  }
  const vaultId = await assertWritableVault(principal, requestedVaultId);

  if (input.canonicalFolder) {
    const def = CANONICAL_FOLDER_DEFS[input.canonicalFolder];
    const parentId = await ensureCanonicalVaultFolder({ principal, vaultId, kind: input.canonicalFolder });
    return {
      outcome: "explicit_parent",
      vaultId,
      indexPageId: null,
      parentId,
      parentTitle: def.title,
      structuralRole,
      confidence: 1,
      reason: `Filed under the canonical ${def.title} folder for this vault.`,
      lint: { requiresReview: false, code: "none", message: null },
      compatibility: { purpose: input.purpose ?? null },
    };
  }

  return {
    outcome: input.explicitVaultId ? "explicit_vault" : "vault_root",
    vaultId,
    indexPageId: null,
    parentId: null,
    parentTitle: "Vault root",
    structuralRole,
    confidence: 1,
    reason: input.explicitVaultId
      ? "Caller supplied an explicit destination vault."
      : "Saved at the current Vault root; automatic Library2 organization is disabled.",
    lint: { requiresReview: false, code: "none", message: null },
    compatibility: { purpose: input.purpose ?? null },
  };
}

export async function createFiledLibraryPage(input: CreateFiledLibraryPageInput): Promise<CreatedFiledLibraryPage> {
  const principal = getCurrentPrincipalOrSystem();
  const filingResolution = await resolveStandardLibraryPlacement(input);
  const synced = syncContentFields({ markdown: input.markdown });
  const slugBase = slugifyLibraryTitle(input.title, "page");
  const slug = input.slugSuffix ? `${slugBase}-${input.slugSuffix}` : slugBase;

  const page = await db.transaction(async (tx) => {
    await acquireLibraryParentLocks(tx, [filingResolution.parentId]);
    const [row] = await tx.insert(libraryPages).values({
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      slug,
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      parentId: filingResolution.parentId,
      tags: Array.from(new Set([...(input.tags ?? []), ...(filingResolution.lint.requiresReview ? ["library-placement-review"] : [])])),
      status: filingResolution.lint.requiresReview ? (input.status ?? "needs_review") : (input.status ?? null),
      structuralRole: filingResolution.structuralRole,
      createdBySessionId: input.createdBySessionId ?? null,
      ...buildLibrarySurfaceSet(input),
      ...ownedInsertValues(principal, libraryScopeColumns),
      vaultId: filingResolution.vaultId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).returning();
    return row;
  });

  try {
    await syncEmbeddedLibraryPageLinks(page.id, principal);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[links] error source=library sourceId=${page.id} reason=embedded_link_sync_failed error=${message}`);
  }

  try {
    await markSourceChanged("library_page", page.id, principal);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[ingest] error source=library sourceId=${page.id} reason=filed_create_sync_failed error=${message}`);
  }

  publishLibraryChanged(page.surface ? "surfaced" : "created", page);
  return { ...page, filingResolution };
}
