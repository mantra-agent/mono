import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { acquireLibraryParentLocks, db } from "./db";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { createNamedSystemPrincipal } from "./principal";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";
import { syncContentFields } from "@shared/markdown-tiptap";
import { libraryPages } from "@shared/models/info";
import { users } from "@shared/schema";
import { vaults } from "@shared/models/vaults";

export const LIBRARY_STRUCTURAL_ROLES = ["source", "artifact", "wiki", "meta"] as const;
export type LibraryStructuralRole = (typeof LIBRARY_STRUCTURAL_ROLES)[number];

export const MANTRA_LIBRARY_VAULT_NAME = "Mantra";
export const CANONICAL_LIBRARY_INDEX_BOOTSTRAP_MARKDOWN =
  "# Library Index\n\nThis vault has no approved Index sections yet.";

const log = createLogger("LibraryDomain");

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export function normalizeLibraryStructuralRole(
  role: string | null | undefined,
  fallback: LibraryStructuralRole = "artifact",
): LibraryStructuralRole {
  return LIBRARY_STRUCTURAL_ROLES.includes(role as LibraryStructuralRole)
    ? (role as LibraryStructuralRole)
    : fallback;
}

function slugify(title: string, fallback = "page"): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

function requireAccountPrincipal(
  principal: Principal,
): Principal & { userId: string; accountId: string } {
  if (
    principal.actorType !== "user" ||
    !principal.userId ||
    !principal.accountId
  ) {
    throw Object.assign(
      new Error("Library vault bootstrap requires a user principal"),
      { status: 403 },
    );
  }
  return principal as Principal & { userId: string; accountId: string };
}

async function ensureMantraVault(principal: Principal): Promise<string> {
  const scopedPrincipal = requireAccountPrincipal(principal);
  const [existing] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(
      and(
        eq(vaults.accountId, scopedPrincipal.accountId),
        eq(vaults.name, MANTRA_LIBRARY_VAULT_NAME),
      ),
    )
    .limit(1);
  if (existing) {
    await ensureUserCanSeeVault(principal, existing.id);
    return existing.id;
  }

  const [positionRow] = await db
    .select({ maxPosition: sql<number>`COALESCE(MAX(${vaults.position}), -1)` })
    .from(vaults)
    .where(eq(vaults.accountId, scopedPrincipal.accountId));

  const [created] = await db
    .insert(vaults)
    .values({
      accountId: scopedPrincipal.accountId,
      name: MANTRA_LIBRARY_VAULT_NAME,
      icon: "M",
      color: "#63B3FF",
      purpose: "Mantra product, architecture, specs, meeting notes, and compiled product knowledge.",
      position: (positionRow?.maxPosition ?? -1) + 1,
      isDefault: false,
    })
    .onConflictDoUpdate({
      target: [vaults.accountId, vaults.name],
      set: {
        purpose: "Mantra product, architecture, specs, meeting notes, and compiled product knowledge.",
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning({ id: vaults.id });

  await ensureUserCanSeeVault(principal, created.id);
  log.info("Ensured Mantra Library vault", {
    accountId: scopedPrincipal.accountId,
    vaultId: created.id,
  });
  return created.id;
}

async function ensureUserCanSeeVault(principal: Principal, vaultId: string): Promise<void> {
  if (principal.actorType !== "user" || !principal.userId) return;
  await db
    .update(users)
    .set({
      visibleVaultIds: sql`CASE
        WHEN ${users.visibleVaultIds} IS NULL THEN ARRAY[${vaultId}]::text[]
        WHEN ${vaultId} = ANY(${users.visibleVaultIds}) THEN ${users.visibleVaultIds}
        ELSE array_append(${users.visibleVaultIds}, ${vaultId})
      END`,
    })
    .where(eq(users.id, principal.userId));
}

/**
 * Assert that `vaultId` is a live, writable destination vault for `principal`,
 * returning the validated id. Shared authorization gate for filing a page into
 * an explicitly chosen vault (create-at-vault-root). Parallels the
 * in-transaction check in library-move.ts's requireDestinationVault, but runs
 * against the module `db` for pre-insert validation. Throws status-bearing
 * errors so routes surface 403 rather than 500.
 */
export async function assertWritableVault(
  principal: Principal,
  vaultId: string,
): Promise<string> {
  if (!principal.accountId) {
    throw Object.assign(
      new Error("An account principal is required to file into a vault"),
      { status: 403 },
    );
  }
  if (
    principal.actorType !== "system" &&
    !principal.visibleVaultIds.includes(vaultId)
  ) {
    throw Object.assign(new Error("Destination vault is not visible"), {
      status: 403,
    });
  }
  const [vault] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(
      and(
        eq(vaults.id, vaultId),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      ),
    )
    .limit(1);
  if (!vault) {
    throw Object.assign(
      new Error("Destination vault not found, writable, or active"),
      { status: 403 },
    );
  }
  return vault.id;
}

export async function ensureVaultPage(input: {
  principal: Principal;
  vaultId: string;
  title: string;
  parentId: string | null;
  structuralRole: LibraryStructuralRole;
  tags: string[];
  plainTextContent: string;
  sortOrder: number;
  slugFallback?: string;
}): Promise<typeof libraryPages.$inferSelect> {
  const synced = syncContentFields({ markdown: input.plainTextContent });
  const slug = slugify(input.title, input.slugFallback ?? "page");

  const [existing] = await db
    .select()
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        input.principal,
        libraryScopeColumns,
        and(
          eq(libraryPages.vaultId, input.vaultId),
          input.parentId === null
            ? isNull(libraryPages.parentId)
            : eq(libraryPages.parentId, input.parentId),
          eq(libraryPages.slug, slug),
        ),
      ),
    )
    .limit(1);

  if (existing) {
    if (
      existing.scope !== "user" ||
      existing.ownerUserId !== input.principal.userId ||
      existing.accountId !== input.principal.accountId
    ) {
      throw Object.assign(
        new Error("Library page is visible but not writable"),
        { status: 403 },
      );
    }
    const desiredRole = normalizeLibraryStructuralRole(existing.structuralRole, input.structuralRole);
    const desiredTags = Array.from(new Set([...(existing.tags ?? []), ...input.tags]));
    const [updated] = await db
      .update(libraryPages)
      .set({
        structuralRole: desiredRole,
        tags: desiredTags,
        vaultId: input.vaultId,
        updatedAt: sql`CURRENT_TIMESTAMP`,
        updatedByUserId: input.principal.userId ?? undefined,
      })
      .where(
        combineWithWritableScope(
          input.principal,
          libraryScopeColumns,
          eq(libraryPages.id, existing.id),
        ),
      )
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(libraryPages)
    .values({
      title: input.title,
      slug,
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      parentId: input.parentId,
      tags: input.tags,
      structuralRole: input.structuralRole,
      sortOrder: input.sortOrder,
      ...ownedInsertValues(input.principal, libraryScopeColumns),
      vaultId: input.vaultId,
      createdByUserId: input.principal.userId ?? undefined,
      updatedByUserId: input.principal.userId ?? undefined,
    })
    .returning();
  return created;
}

export type CanonicalLibraryMetadataKind = "index" | "wiki" | "log";

const canonicalMetadata = {
  index: {
    title: "Index",
    tag: "library-index",
    tags: ["library-index", "library-meta"],
    markdown: CANONICAL_LIBRARY_INDEX_BOOTSTRAP_MARKDOWN,
    sortOrder: 0,
  },
  wiki: {
    title: "Wiki",
    tag: "wiki",
    tags: ["wiki", "library-meta"],
    markdown: "# Wiki\n\nAgent-maintained compiled knowledge for this vault.",
    sortOrder: 1,
  },
  log: {
    title: "Log",
    tag: "library-log",
    tags: ["library-log", "library-meta"],
    markdown: "# Library Log\n\nAppend-only maintenance history for this vault.",
    sortOrder: 2,
  },
} as const;

/**
 * Canonical metadata identity is `(vault_id, structural_role=meta, kind tag)`.
 * Parentage is normalized only after that identity is resolved under a
 * transaction-scoped lock, so moving metadata to the vault root cannot fork it.
 */
export async function ensureCanonicalVaultMetadataPage(input: {
  principal: Principal;
  vaultId: string;
  kind: CanonicalLibraryMetadataKind;
}): Promise<typeof libraryPages.$inferSelect> {
  requireAccountPrincipal(input.principal);
  const definition = canonicalMetadata[input.kind];
  const synced = syncContentFields({ markdown: definition.markdown });
  const lockKey = `library-metadata:${input.vaultId}:${input.kind}`;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    const candidates = await tx
      .select()
      .from(libraryPages)
      .where(
        combineWithVisibleScope(
          input.principal,
          libraryScopeColumns,
          and(
            eq(libraryPages.vaultId, input.vaultId),
            eq(libraryPages.structuralRole, "meta"),
            sql`${definition.tag} = ANY(${libraryPages.tags})`,
          ),
        ),
      )
      .orderBy(asc(libraryPages.createdAt), asc(libraryPages.id));

    // Canonical metadata identity is (vault, structural_role=meta, kind tag)
    // and its home is always the vault root. Any additional row matching that
    // identity is stale classification by definition, whether nested or a
    // second root-level duplicate. Converge deterministically here at the one
    // boundary that owns the invariant: the earliest root page (or the earliest
    // page if none sit at the root) stays canonical, and every other match is
    // demoted below, instead of failing every read, lint, move, and workflow
    // checkpoint that encounters the duplicate.
    const rootCandidates = candidates.filter((page) => page.parentId === null);
    const canonical = rootCandidates[0] ?? candidates[0];
    const staleNested = candidates.filter((page) => page.id !== canonical?.id);
    for (const stale of staleNested) {
      const demotedTags = (stale.tags ?? []).filter(
        (tag) => tag !== definition.tag && tag !== "library-meta",
      );
      const [demoted] = await tx
        .update(libraryPages)
        .set({
          structuralRole: "artifact",
          tags: demotedTags,
          updatedAt: sql`CURRENT_TIMESTAMP`,
          updatedByUserId: input.principal.userId ?? undefined,
        })
        .where(
          combineWithWritableScope(
            input.principal,
            libraryScopeColumns,
            eq(libraryPages.id, stale.id),
          ),
        )
        .returning({ id: libraryPages.id });
      if (!demoted) {
        throw Object.assign(
          new Error(`Stale duplicate ${definition.title} page is not writable; migration repair is required`),
          { status: 409 },
        );
      }
      log.warn("Demoted stale canonical metadata duplicate", {
        vaultId: input.vaultId,
        kind: input.kind,
        pageId: stale.id,
        parentId: stale.parentId,
        canonicalPageId: canonical?.id ?? null,
      });
    }

    const existing = canonical;
    if (existing) {
      const desiredTags = Array.from(new Set([...(existing.tags ?? []), ...definition.tags]));
      const [updated] = await tx
        .update(libraryPages)
        .set({
          title: definition.title,
          slug: slugify(definition.title),
          parentId: null,
          structuralRole: "meta",
          tags: desiredTags,
          sortOrder: definition.sortOrder,
          updatedAt: sql`CURRENT_TIMESTAMP`,
          updatedByUserId: input.principal.userId ?? undefined,
        })
        .where(
          combineWithWritableScope(
            input.principal,
            libraryScopeColumns,
            eq(libraryPages.id, existing.id),
          ),
        )
        .returning();
      if (!updated) {
        throw Object.assign(new Error("Canonical Library metadata page is not writable"), { status: 403 });
      }
      return updated;
    }

    const [created] = await tx
      .insert(libraryPages)
      .values({
        title: definition.title,
        slug: slugify(definition.title),
        content: synced.content,
        plainTextContent: synced.plainTextContent,
        parentId: null,
        tags: [...definition.tags],
        structuralRole: "meta",
        sortOrder: definition.sortOrder,
        ...ownedInsertValues(input.principal, libraryScopeColumns),
        vaultId: input.vaultId,
        createdByUserId: input.principal.userId ?? undefined,
        updatedByUserId: input.principal.userId ?? undefined,
      })
      .returning();
    return created;
  });
}

export interface MantraLibraryVaultBootstrapResult {
  vaultId: string;
  wikiPageId: string;
  indexPageId: string;
  logPageId: string;
}

export async function ensureMantraLibraryVault(
  principal: Principal = getCurrentPrincipalOrSystem(),
): Promise<MantraLibraryVaultBootstrapResult> {
  const vaultId = await ensureMantraVault(principal);
  const index = await ensureCanonicalVaultMetadataPage({ principal, vaultId, kind: "index" });
  const wiki = await ensureCanonicalVaultMetadataPage({ principal, vaultId, kind: "wiki" });
  const logPage = await ensureCanonicalVaultMetadataPage({ principal, vaultId, kind: "log" });

  return {
    vaultId,
    wikiPageId: wiki.id,
    indexPageId: index.id,
    logPageId: logPage.id,
  };
}

/**
 * Soft-delete (move to Trash) a Library page and its ENTIRE descendant subtree
 * as one restorable unit. This is the single canonical mutation path for page
 * deletion — every route, tool, and job that "deletes" a page must call this so
 * the invariant lives in one place.
 *
 * Trash is a lifecycle state on `library_pages.deleted_at`, the single source of
 * truth. Vault, parent, placements, and content are left untouched; only
 * `deleted_at` is stamped, so the subtree can be restored later by clearing it.
 *
 * Derivation-first unit identity: every page in the cascade shares one
 * `deleted_at` timestamp, and the trashed unit is fully reconstructable from
 * (subtree root + shared `deleted_at`) via a `parent_id` descendant walk. A page
 * already trashed by an earlier, separate deletion keeps its own earlier
 * timestamp and is excluded here by the `deleted_at IS NULL` guard, so restoring
 * this unit will not resurrect a separately-trashed child. That is why no
 * `trashRootId`/`deletedBatchId` column is required.
 */
export async function softDeleteLibrarySubtree(
  principal: Principal,
  rootId: string,
): Promise<{ trashedCount: number; trashedIds: string[] }> {
  return db.transaction(async (tx) => {
    const [root] = await tx
      .select({ id: libraryPages.id, parentId: libraryPages.parentId })
      .from(libraryPages)
      .where(
        combineWithWritableScope(
          principal,
          libraryScopeColumns,
          eq(libraryPages.id, rootId),
        ),
      )
      .limit(1);
    if (!root) return { trashedCount: 0, trashedIds: [] };

    // Serialize against concurrent reparent/reorder of the root's siblings,
    // matching the advisory-lock discipline used by move/reorder.
    await acquireLibraryParentLocks(tx, [root.parentId]);

    // Gather the whole descendant subtree by parent_id. UNION (not UNION ALL)
    // guarantees termination even if a cycle ever exists. IDs only — no content.
    const subtree = await tx.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM library_pages WHERE id = ${rootId}
        UNION
        SELECT lp.id FROM library_pages lp
        JOIN subtree s ON lp.parent_id = s.id
      )
      SELECT id FROM subtree
    `);
    const ids = (subtree.rows as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) return { trashedCount: 0, trashedIds: [] };

    // One shared deleted_at across the cascade, atomically. Writable-scoped so a
    // user can only ever trash their own rows; deleted_at IS NULL preserves any
    // child trashed earlier as its own separate unit.
    const stamped = await tx
      .update(libraryPages)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        combineWithWritableScope(
          principal,
          libraryScopeColumns,
          and(inArray(libraryPages.id, ids), isNull(libraryPages.deletedAt)),
        ),
      )
      .returning({ id: libraryPages.id });

    log.info("Soft-deleted Library subtree", {
      rootId,
      subtreeSize: ids.length,
      trashedCount: stamped.length,
    });
    return {
      trashedCount: stamped.length,
      trashedIds: stamped.map((row) => row.id),
    };
  });
}

/**
 * Restore a trashed page and its trashed subtree (the UNIT that was deleted
 * together) back to the live Library. This is the single canonical mutation
 * path for undeleting a page — every route or tool that "restores" a page must
 * call this so the invariant lives in one place, mirroring
 * softDeleteLibrarySubtree.
 *
 * Unit identity is derivation-first: the trashed unit is every page reachable
 * from `rootId` by a parent_id walk that shares the root's `deleted_at`
 * timestamp. A descendant trashed earlier as its own separate unit carries an
 * earlier timestamp and is intentionally excluded, so restoring this unit never
 * resurrects a separately-trashed child.
 *
 * Vault membership was never changed by soft-delete, so restore keeps each
 * page's vault. Parentage is preserved for descendants (their parents restore
 * with them). The unit root returns to its original parent only when that parent
 * is still live and visible; if the original parent is missing or itself
 * trashed, the root falls back to the source vault root (parent_id = NULL).
 */
export async function restoreLibrarySubtree(
  principal: Principal,
  rootId: string,
): Promise<{ restoredCount: number; restoredIds: string[] }> {
  return db.transaction(async (tx) => {
    const [root] = await tx
      .select({
        id: libraryPages.id,
        parentId: libraryPages.parentId,
        deletedAt: libraryPages.deletedAt,
      })
      .from(libraryPages)
      .where(
        combineWithWritableScope(
          principal,
          libraryScopeColumns,
          and(eq(libraryPages.id, rootId), isNotNull(libraryPages.deletedAt)),
        ),
      )
      .limit(1);
    if (!root || !root.deletedAt) return { restoredCount: 0, restoredIds: [] };

    // Serialize against concurrent reparent/reorder of the restore destination,
    // matching the advisory-lock discipline used by soft-delete/move/reorder.
    await acquireLibraryParentLocks(tx, [root.parentId]);

    // Gather the trashed unit: descendants reachable by parent_id that share the
    // root's deleted_at. UNION (not UNION ALL) guarantees termination. A child
    // trashed earlier as its own unit has a different timestamp and is excluded,
    // so it stays trashed.
    const unit = await tx.execute(sql`
      WITH RECURSIVE unit AS (
        SELECT id FROM library_pages WHERE id = ${rootId}
        UNION
        SELECT lp.id FROM library_pages lp
        JOIN unit u ON lp.parent_id = u.id
        WHERE lp.deleted_at = ${root.deletedAt}
      )
      SELECT id FROM unit
    `);
    const ids = (unit.rows as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) return { restoredCount: 0, restoredIds: [] };

    // Decide whether the unit root can return to its original parent. Keep it
    // only when that parent is still live (not trashed) and visible to the
    // principal; otherwise fall back to the source vault root.
    let rootParentFallback = false;
    if (root.parentId) {
      const [liveParent] = await tx
        .select({ id: libraryPages.id })
        .from(libraryPages)
        .where(
          combineWithVisibleScope(
            principal,
            libraryScopeColumns,
            and(
              eq(libraryPages.id, root.parentId),
              isNull(libraryPages.deletedAt),
            ),
          ),
        )
        .limit(1);
      if (!liveParent) rootParentFallback = true;
    }

    // Clear deleted_at across the unit atomically. Writable-scoped so a user can
    // only ever restore their own rows; deleted_at IS NOT NULL keeps this a pure
    // undelete.
    const restored = await tx
      .update(libraryPages)
      .set({ deletedAt: null, updatedAt: sql`now()` })
      .where(
        combineWithWritableScope(
          principal,
          libraryScopeColumns,
          and(inArray(libraryPages.id, ids), isNotNull(libraryPages.deletedAt)),
        ),
      )
      .returning({ id: libraryPages.id });

    if (rootParentFallback) {
      await tx
        .update(libraryPages)
        .set({ parentId: null, updatedAt: sql`now()` })
        .where(
          combineWithWritableScope(
            principal,
            libraryScopeColumns,
            eq(libraryPages.id, rootId),
          ),
        );
    }

    log.info("Restored Library subtree", {
      rootId,
      unitSize: ids.length,
      restoredCount: restored.length,
      rootParentFallback,
    });
    return {
      restoredCount: restored.length,
      restoredIds: restored.map((row) => row.id),
    };
  });
}

const HARD_DELETE_BATCH = 500;

/**
 * Retention horizon for the Library trash auto-purge. Pages soft-deleted longer
 * ago than this are permanently destroyed by the nightly sweep.
 */
export const LIBRARY_TRASH_RETENTION_DAYS = 30;

/**
 * Canonical, irreversible hard-delete for Library pages. This is the SINGLE
 * destruction path shared by the user-triggered Empty Trash action and the
 * nightly 30-day auto-purge (DRY — the destruction logic exists exactly once).
 *
 * Blast-radius POLICY lives with each caller, never here:
 *   - Empty Trash passes the exact VISIBLE trashed set (top-bar vault toggles +
 *     active vault chip), re-validated by the route to trashed rows.
 *   - Auto-purge passes every page whose deleted_at crossed the retention
 *     horizon, across all users and vaults, under a system principal.
 *
 * This function only ever destroys rows that are (a) in the id set it is given,
 * (b) writable by the principal (writable scope — a user can never destroy
 * another user's row; a system principal spans all owners), and (c) already
 * soft-deleted. The `deleted_at IS NOT NULL` guard is structural: the canonical
 * destruction path can never hard-delete a live page, regardless of caller.
 *
 * Cleanup, with no dangling references:
 *   - library_pages rows — FK ON DELETE CASCADE removes library_page_links,
 *     library_placements, library_annotations, and library_page_views; self
 *     parent_id and placement parent_page_id are ON DELETE SET NULL.
 *   - vNext provenance for source_type='library_page' (queue rows + claim source
 *     refs), retiring any claim orphaned by losing its final source.
 *   - The legacy memory_entries mirror is retired and no longer maintained
 *     (memory_entry_id is NULL for current pages), so it is intentionally not
 *     touched here.
 *
 * @page references embedded in other pages' content are not FK rows; once the
 * target page row is gone they resolve as unavailable at render time.
 *
 * Deletes are bounded and batched.
 */
export async function hardDeleteLibraryPages(
  principal: Principal,
  pageIds: string[],
): Promise<{ deletedCount: number; deletedIds: string[] }> {
  const uniqueIds = [...new Set(pageIds)].filter(Boolean);
  if (uniqueIds.length === 0) return { deletedCount: 0, deletedIds: [] };

  const deletedIds: string[] = [];
  for (let i = 0; i < uniqueIds.length; i += HARD_DELETE_BATCH) {
    const batch = uniqueIds.slice(i, i + HARD_DELETE_BATCH);
    const deleted = await db
      .delete(libraryPages)
      .where(
        combineWithWritableScope(
          principal,
          libraryScopeColumns,
          and(
            inArray(libraryPages.id, batch),
            isNotNull(libraryPages.deletedAt),
          ),
        ),
      )
      .returning({ id: libraryPages.id });
    for (const row of deleted) deletedIds.push(row.id);
  }

  if (deletedIds.length === 0) return { deletedCount: 0, deletedIds: [] };

  // Tear down vNext provenance derived from these pages (queue rows + claim
  // source refs + orphan claims), mirroring the canonical session-source
  // removal. Isolated so a provenance-cleanup failure never resurrects the
  // already-destroyed pages; the vNext lifecycle tolerates missing sources.
  try {
    const { removeLibraryPageSources } = await import(
      "./memory/vnext-source-queue"
    );
    await removeLibraryPageSources(deletedIds, principal);
  } catch (err) {
    log.error(
      `[hardDelete] vNext provenance cleanup failed for ${deletedIds.length} pages: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  log.info("Hard-deleted Library pages", {
    requested: uniqueIds.length,
    deletedCount: deletedIds.length,
  });
  return { deletedCount: deletedIds.length, deletedIds };
}

/**
 * Nightly auto-purge: permanently destroy every Library page whose deleted_at
 * crossed the {@link LIBRARY_TRASH_RETENTION_DAYS} horizon, across ALL users and
 * ALL vaults, under an audited named system principal.
 *
 * CRITICAL distinction from Empty Trash: auto-purge has NO "visible set."
 * Vault-visibility toggles are a UI-session concept, never page state, so the
 * selection is strictly by age — there is no vault or visibility predicate. The
 * destruction itself routes through the shared {@link hardDeleteLibraryPages}
 * path. The sweep is idempotent (already-purged rows are gone) and batched, so
 * concurrent per-user sleep cycles are safe.
 */
export async function purgeExpiredLibraryTrash(): Promise<{
  purgedCount: number;
}> {
  const systemPrincipal = createNamedSystemPrincipal("library-trash-purge");
  const expired = await db
    .select({ id: libraryPages.id })
    .from(libraryPages)
    .where(
      and(
        isNotNull(libraryPages.deletedAt),
        sql`${libraryPages.deletedAt} < now() - (${LIBRARY_TRASH_RETENTION_DAYS} * interval '1 day')`,
      ),
    )
    .limit(HARD_DELETE_BATCH * 20);
  if (expired.length === 0) return { purgedCount: 0 };

  const { deletedCount } = await hardDeleteLibraryPages(
    systemPrincipal,
    expired.map((row) => row.id),
  );
  log.info("Library trash auto-purge complete", {
    scanned: expired.length,
    purgedCount: deletedCount,
    retentionDays: LIBRARY_TRASH_RETENTION_DAYS,
  });
  return { purgedCount: deletedCount };
}
