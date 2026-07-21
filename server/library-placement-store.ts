import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  libraryPages,
  libraryPlacements,
  type LibraryPlacement,
  type LibraryPlacementIndexSection,
  type LibraryPlacementSource,
} from "@shared/models/info";
import { vaults } from "@shared/models/vaults";
import { db } from "./db";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import {
  assertVisible,
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";

/**
 * Canonical persistence service for Library placements — the join between a
 * Library page and a vault's Index/Wiki structure (Library2 second-brain lens).
 *
 * This is the single mutation path for placement rows. Create is a replay-safe
 * upsert on (page_id, vault_id); delete is scoped to the owning principal.
 * A placement never copies page content: the library_pages row remains the one
 * source of truth, and the second-brain lens is a view derived from placements.
 * Import is reversible by deleting placement rows, which leaves the flat Library
 * completely unaffected.
 */

const log = createLogger("LibraryPlacementStore");

// Placement ownership boundary is account/owner scoping. vault_id is the
// destination vault chosen by placement logic, not an ownership discriminant,
// so it is intentionally excluded here: including it would let ownedInsertValues
// overwrite the explicit destination with the principal's active vault.
const placementScopeColumns = {
  scope: libraryPlacements.scope,
  ownerUserId: libraryPlacements.ownerUserId,
  accountId: libraryPlacements.accountId,
};

const libraryPageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export interface CreateLibraryPlacementInput {
  pageId: string;
  vaultId: string;
  indexSection: LibraryPlacementIndexSection;
  parentPageId?: string | null;
  placedBy?: LibraryPlacementSource;
  confidence?: number | null;
}

export interface ListLibraryPlacementsFilter {
  pageId?: string;
  vaultId?: string;
}

function visiblePlacements(principal: Principal, predicate?: SQL): SQL {
  return combineWithVisibleScope(principal, placementScopeColumns, predicate);
}

function writablePlacements(principal: Principal, predicate?: SQL): SQL {
  return combineWithWritableScope(principal, placementScopeColumns, predicate);
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

async function requireVisiblePage(
  pageId: string,
  principal: Principal,
): Promise<void> {
  const [page] = await db
    .select({ id: libraryPages.id })
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        principal,
        libraryPageScopeColumns,
        eq(libraryPages.id, pageId),
      ),
    )
    .limit(1);
  assertVisible(principal, page, "Library page");
}

async function requireOwnedVault(
  vaultId: string,
  principal: Principal,
): Promise<void> {
  // System principals are trusted to place across accounts (backfill/import).
  if (principal.actorType === "system") return;
  if (!principal.accountId) {
    throw badRequest("Library placement requires an account principal");
  }
  const [vault] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(eq(vaults.id, vaultId), eq(vaults.accountId, principal.accountId)))
    .limit(1);
  if (!vault) {
    throw Object.assign(
      new Error("Destination vault not found in this account"),
      { status: 404 },
    );
  }
}

/**
 * Create (or replay-safely update) the placement of a page within a vault.
 * Uniqueness on (page_id, vault_id) means a page has at most one lens position
 * per vault; a second call updates the existing placement instead of duplicating.
 */
export async function createLibraryPlacement(
  input: CreateLibraryPlacementInput,
  principal: Principal,
): Promise<LibraryPlacement> {
  await requireVisiblePage(input.pageId, principal);
  await requireOwnedVault(input.vaultId, principal);

  const owner = ownedInsertValues(principal, placementScopeColumns);
  const placedBy: LibraryPlacementSource = input.placedBy ?? "manual";
  const parentPageId = input.parentPageId ?? null;
  const confidence = input.confidence ?? null;

  const [row] = await db
    .insert(libraryPlacements)
    .values({
      pageId: input.pageId,
      vaultId: input.vaultId,
      indexSection: input.indexSection,
      parentPageId,
      placedBy,
      confidence,
      ...owner,
      createdByUserId: principal.userId ?? undefined,
      updatedByUserId: principal.userId ?? undefined,
    })
    .onConflictDoUpdate({
      target: [libraryPlacements.pageId, libraryPlacements.vaultId],
      set: {
        indexSection: input.indexSection,
        parentPageId,
        placedBy,
        confidence,
        updatedByUserId: principal.userId ?? undefined,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning();

  log.log(
    `placement upserted page=${input.pageId} vault=${input.vaultId} section=${input.indexSection} placedBy=${placedBy}`,
  );
  return row;
}

/** List placements visible to the principal, optionally filtered by page or vault. */
export async function listLibraryPlacements(
  filter: ListLibraryPlacementsFilter,
  principal: Principal,
): Promise<LibraryPlacement[]> {
  const clauses: SQL[] = [];
  if (filter.pageId) clauses.push(eq(libraryPlacements.pageId, filter.pageId));
  if (filter.vaultId) clauses.push(eq(libraryPlacements.vaultId, filter.vaultId));
  const predicate =
    clauses.length === 0
      ? undefined
      : clauses.length === 1
        ? clauses[0]
        : and(...clauses);

  return db
    .select()
    .from(libraryPlacements)
    .where(visiblePlacements(principal, predicate))
    .orderBy(libraryPlacements.createdAt);
}

/** Fetch a single placement by id if visible to the principal. */
export async function getLibraryPlacement(
  id: string,
  principal: Principal,
): Promise<LibraryPlacement | null> {
  const [row] = await db
    .select()
    .from(libraryPlacements)
    .where(visiblePlacements(principal, eq(libraryPlacements.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * Delete a placement the principal owns. Returns true when a row was removed.
 * This is how import is reversed: removing the placement takes the page out of
 * the second-brain lens without touching the underlying Library page.
 */
export async function deleteLibraryPlacement(
  id: string,
  principal: Principal,
): Promise<boolean> {
  const deleted = await db
    .delete(libraryPlacements)
    .where(writablePlacements(principal, eq(libraryPlacements.id, id)))
    .returning({ id: libraryPlacements.id });
  const removed = deleted.length > 0;
  if (removed) log.log(`placement deleted id=${id}`);
  return removed;
}
