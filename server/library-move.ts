import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { libraryPages, libraryPlacements, type LibraryPage } from "@shared/models/info";
import { vaults } from "@shared/models/vaults";
import {
  acquireLibraryParentLocks,
  db,
  type DrizzleTx,
} from "./db";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
} from "./scoped-storage";

const log = createLogger("LibraryMove");
const MAX_TRANSFER_PAGES = 5_000;
const MAX_STABILIZATION_PASSES = 4;

const pageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

const placementScopeColumns = {
  scope: libraryPlacements.scope,
  ownerUserId: libraryPlacements.ownerUserId,
  accountId: libraryPlacements.accountId,
};

export interface MoveLibraryPageInput {
  pageId: string;
  destinationParentId: string | null;
  destinationVaultId?: string | null;
  sortOrder?: number;
}

export interface MoveLibraryPageResult {
  page: LibraryPage;
  sourceVaultId: string | null;
  destinationVaultId: string;
  transferredPageCount: number;
  reconciledPlacementCount: number;
  crossVault: boolean;
}

interface SubtreeRow {
  id: string;
  parentId: string | null;
  vaultId: string | null;
  scope: string;
  ownerUserId: string | null;
  accountId: string | null;
  tags: string[];
  structuralRole: string;
  sortOrder: number;
  depth: number;
}

interface SubtreeSqlRow {
  id: string;
  parent_id: string | null;
  vault_id: string | null;
  scope: string;
  owner_user_id: string | null;
  account_id: string | null;
  tags: string[] | null;
  structural_role: string;
  sort_order: number;
  depth: number;
}

function clientError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function visiblePages(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, pageScopeColumns, predicate);
}

function writablePages(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, pageScopeColumns, predicate);
}

function writablePlacements(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, placementScopeColumns, predicate);
}

function parentCondition(parentId: string | null): SQL {
  return parentId === null
    ? isNull(libraryPages.parentId)
    : eq(libraryPages.parentId, parentId);
}

function vaultCondition(vaultId: string | null): SQL {
  return vaultId === null
    ? isNull(libraryPages.vaultId)
    : eq(libraryPages.vaultId, vaultId);
}

function isProtectedPage(row: Pick<SubtreeRow, "scope" | "tags" | "structuralRole">): boolean {
  return (
    row.scope === "global" ||
    row.scope === "system" ||
    row.structuralRole === "meta" ||
    row.tags.includes("system-folder") ||
    row.tags.includes("library-meta") ||
    row.tags.includes("library-vault")
  );
}

function snapshotKey(rows: SubtreeRow[]): string {
  return rows
    .map((row) => `${row.id}:${row.parentId ?? "<root>"}:${row.vaultId ?? "<none>"}`)
    .sort()
    .join("|");
}

async function readSubtree(tx: DrizzleTx, pageId: string): Promise<SubtreeRow[]> {
  const result = await tx.execute<SubtreeSqlRow>(sql`
    WITH RECURSIVE subtree AS (
      SELECT
        id,
        parent_id,
        vault_id,
        scope,
        owner_user_id,
        account_id,
        tags,
        structural_role,
        sort_order,
        0 AS depth,
        ARRAY[id]::text[] AS path
      FROM library_pages
      WHERE id = ${pageId}

      UNION ALL

      SELECT
        child.id,
        child.parent_id,
        child.vault_id,
        child.scope,
        child.owner_user_id,
        child.account_id,
        child.tags,
        child.structural_role,
        child.sort_order,
        parent.depth + 1,
        parent.path || child.id
      FROM library_pages child
      INNER JOIN subtree parent ON child.parent_id = parent.id
      WHERE parent.depth < ${MAX_TRANSFER_PAGES}
        AND NOT child.id = ANY(parent.path)
    )
    SELECT
      id,
      parent_id,
      vault_id,
      scope,
      owner_user_id,
      account_id,
      tags,
      structural_role,
      sort_order,
      depth
    FROM subtree
    LIMIT ${MAX_TRANSFER_PAGES + 1}
  `);

  return (result.rows ?? []).map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    vaultId: row.vault_id,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    accountId: row.account_id,
    tags: row.tags ?? [],
    structuralRole: row.structural_role,
    sortOrder: Number(row.sort_order),
    depth: Number(row.depth),
  }));
}

async function readStableSubtree(
  tx: DrizzleTx,
  pageId: string,
  initialOldParentId: string | null,
  destinationParentId: string | null,
): Promise<SubtreeRow[]> {
  let previous = await readSubtree(tx, pageId);
  if (previous.length === 0) throw clientError(404, "Library page not found");

  for (let pass = 0; pass < MAX_STABILIZATION_PASSES; pass++) {
    const root = previous.find((row) => row.id === pageId);
    await acquireLibraryParentLocks(tx, [
      initialOldParentId,
      root?.parentId ?? null,
      destinationParentId,
      ...previous.map((row) => row.id),
    ]);
    const current = await readSubtree(tx, pageId);
    if (snapshotKey(current) === snapshotKey(previous)) return current;
    previous = current;
  }

  const error = clientError(409, "Library hierarchy changed during the move; please retry");
  (error as Error & { code?: string }).code = "40001";
  throw error;
}

async function requireDestinationVault(
  tx: DrizzleTx,
  principal: Principal,
  destinationVaultId: string,
): Promise<void> {
  if (!principal.accountId) {
    throw clientError(403, "An account principal is required to move Library pages");
  }
  if (
    principal.actorType !== "system" &&
    !principal.visibleVaultIds.includes(destinationVaultId)
  ) {
    throw clientError(403, "Destination vault is not visible");
  }

  const [vault] = await tx
    .select({ id: vaults.id })
    .from(vaults)
    .where(
      and(
        eq(vaults.id, destinationVaultId),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      ),
    )
    .limit(1);
  if (!vault) {
    throw clientError(403, "Destination vault not found, writable, or active");
  }
}

async function clearStalePlacementParents(
  tx: DrizzleTx,
  principal: Principal,
  pageIds: string[],
  destinationVaultId: string,
): Promise<number> {
  const cleared = await tx
    .update(libraryPlacements)
    .set({
      parentPageId: null,
      updatedByUserId: principal.userId ?? undefined,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      writablePlacements(
        principal,
        and(
          inArray(libraryPlacements.parentPageId, pageIds),
          or(
            ne(libraryPlacements.vaultId, destinationVaultId),
            isNull(libraryPlacements.vaultId),
          ),
        ),
      ),
    )
    .returning({ id: libraryPlacements.id });
  return cleared.length;
}

/**
 * Canonical atomic Library hierarchy mutation. Every reparent and vault transfer
 * must cross this boundary so a page subtree cannot split across vaults.
 */
export async function moveLibraryPage(
  input: MoveLibraryPageInput,
  principal: Principal,
): Promise<MoveLibraryPageResult> {
  const requestedDestinationVaultId = input.destinationVaultId ?? null;

  try {
    const result = await db.transaction(async (tx) => {
      const [preMove] = await tx
        .select({
          id: libraryPages.id,
          parentId: libraryPages.parentId,
          vaultId: libraryPages.vaultId,
        })
        .from(libraryPages)
        .where(writablePages(principal, eq(libraryPages.id, input.pageId)))
        .limit(1);
      if (!preMove) throw clientError(404, "Library page not found or not writable");

      const subtree = await readStableSubtree(
        tx,
        input.pageId,
        preMove.parentId,
        input.destinationParentId,
      );
      if (subtree.length > MAX_TRANSFER_PAGES) {
        throw clientError(400, `Library moves are limited to ${MAX_TRANSFER_PAGES.toLocaleString()} pages`);
      }

      const root = subtree.find((row) => row.id === input.pageId);
      if (!root) throw clientError(404, "Library page not found");
      const pageIds = subtree.map((row) => row.id);
      const writableRows = await tx
        .select({ id: libraryPages.id })
        .from(libraryPages)
        .where(writablePages(principal, inArray(libraryPages.id, pageIds)));
      if (writableRows.length !== subtree.length) {
        throw clientError(403, "The complete Library subtree must be visible and writable");
      }
      if (subtree.some(isProtectedPage)) {
        throw clientError(403, "Protected or system Library content cannot be moved");
      }
      if (subtree.some((row) => row.vaultId !== root.vaultId)) {
        throw clientError(409, "Library subtree already spans multiple vaults and must be repaired before moving");
      }

      let destinationParent: { id: string; vaultId: string | null } | null = null;
      if (input.destinationParentId !== null) {
        const [parent] = await tx
          .select({ id: libraryPages.id, vaultId: libraryPages.vaultId })
          .from(libraryPages)
          .where(
            writablePages(
              principal,
              eq(libraryPages.id, input.destinationParentId),
            ),
          )
          .limit(1);
        if (!parent) throw clientError(400, "Destination parent not found or not writable");
        destinationParent = parent;
        if (pageIds.includes(parent.id)) {
          throw clientError(400, "Cannot move a page into its own descendant");
        }
      }

      if (input.destinationParentId === null && !requestedDestinationVaultId) {
        throw clientError(
          400,
          "destinationVaultId is required when moving a page to a vault root",
        );
      }
      const destinationVaultId =
        requestedDestinationVaultId ?? destinationParent?.vaultId;
      if (!destinationVaultId) {
        throw clientError(400, "destinationVaultId is required for this Library move");
      }
      await requireDestinationVault(tx, principal, destinationVaultId);
      if (
        destinationParent &&
        destinationParent.vaultId !== destinationVaultId
      ) {
        throw clientError(400, "Destination parent does not belong to destinationVaultId");
      }

      const crossVault = root.vaultId !== destinationVaultId;
      if (crossVault) {
        log.info("cross-vault transfer attempted", {
          pageId: input.pageId,
          sourceVaultId: root.vaultId,
          destinationVaultId,
          destinationParentId: input.destinationParentId,
          principalUserId: principal.userId ?? null,
          subtreeCount: subtree.length,
        });
      }

      const sourceSiblingCondition = and(
        parentCondition(root.parentId),
        vaultCondition(root.vaultId),
      );
      const destinationSiblingCondition = and(
        parentCondition(input.destinationParentId),
        vaultCondition(destinationVaultId),
      );
      const [destinationSiblingCount] = await tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(libraryPages)
        .where(
          visiblePages(
            principal,
            and(destinationSiblingCondition, ne(libraryPages.id, input.pageId)),
          ),
        );
      const maxDestinationOrder = Number(destinationSiblingCount?.count ?? 0);
      const changingParentOrVault =
        root.parentId !== input.destinationParentId || crossVault;
      const requestedSortOrder =
        input.sortOrder ?? (changingParentOrVault ? maxDestinationOrder : root.sortOrder);
      const destinationSortOrder = Math.max(
        0,
        Math.min(requestedSortOrder, maxDestinationOrder),
      );

      if (changingParentOrVault) {
        await tx
          .update(libraryPages)
          .set({ sortOrder: sql`${libraryPages.sortOrder} - 1` })
          .where(
            writablePages(
              principal,
              and(
                sourceSiblingCondition,
                gt(libraryPages.sortOrder, root.sortOrder),
                ne(libraryPages.id, input.pageId),
              ),
            ),
          );
        await tx
          .update(libraryPages)
          .set({ sortOrder: sql`${libraryPages.sortOrder} + 1` })
          .where(
            writablePages(
              principal,
              and(
                destinationSiblingCondition,
                gte(libraryPages.sortOrder, destinationSortOrder),
                ne(libraryPages.id, input.pageId),
              ),
            ),
          );
      } else if (destinationSortOrder > root.sortOrder) {
        await tx
          .update(libraryPages)
          .set({ sortOrder: sql`${libraryPages.sortOrder} - 1` })
          .where(
            writablePages(
              principal,
              and(
                destinationSiblingCondition,
                gt(libraryPages.sortOrder, root.sortOrder),
                lte(libraryPages.sortOrder, destinationSortOrder),
                ne(libraryPages.id, input.pageId),
              ),
            ),
          );
      } else if (destinationSortOrder < root.sortOrder) {
        await tx
          .update(libraryPages)
          .set({ sortOrder: sql`${libraryPages.sortOrder} + 1` })
          .where(
            writablePages(
              principal,
              and(
                destinationSiblingCondition,
                gte(libraryPages.sortOrder, destinationSortOrder),
                lt(libraryPages.sortOrder, root.sortOrder),
                ne(libraryPages.id, input.pageId),
              ),
            ),
          );
      }

      let migratedPlacementCount = 0;
      if (crossVault) {
        migratedPlacementCount = await clearStalePlacementParents(
          tx,
          principal,
          pageIds,
          destinationVaultId,
        );
        const moved = await tx
          .update(libraryPages)
          .set({
            vaultId: destinationVaultId,
            updatedAt: sql`CURRENT_TIMESTAMP`,
            updatedByUserId: principal.userId ?? undefined,
          })
          .where(writablePages(principal, inArray(libraryPages.id, pageIds)))
          .returning({ id: libraryPages.id });
        if (moved.length !== subtree.length) {
          throw clientError(409, "Library subtree transfer did not update every page");
        }
      }

      const [page] = await tx
        .update(libraryPages)
        .set({
          parentId: input.destinationParentId,
          sortOrder: destinationSortOrder,
          updatedAt: sql`CURRENT_TIMESTAMP`,
          updatedByUserId: principal.userId ?? undefined,
        })
        .where(writablePages(principal, eq(libraryPages.id, input.pageId)))
        .returning();
      if (!page) throw clientError(409, "Library page changed during the move");

      return {
        page,
        sourceVaultId: root.vaultId,
        destinationVaultId,
        transferredPageCount: subtree.length,
        migratedPlacementCount,
        crossVault,
      };
    });

    if (result.crossVault) {
      log.info("cross-vault transfer completed", {
        pageId: input.pageId,
        sourceVaultId: result.sourceVaultId,
        destinationVaultId: result.destinationVaultId,
        destinationParentId: input.destinationParentId,
        principalUserId: principal.userId ?? null,
        subtreeCount: result.transferredPageCount,
        migratedPlacementCount: result.migratedPlacementCount,
      });
    }
    return result;
  } catch (error) {
    const status = (error as Error & { status?: number }).status ?? 500;
    log.warn("Library move rejected or failed", {
      pageId: input.pageId,
      destinationVaultId: requestedDestinationVaultId,
      destinationParentId: input.destinationParentId,
      principalUserId: principal.userId ?? null,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
