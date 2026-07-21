import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
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
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";

/**
 * Canonical persistence service for Library placements, the join between a
 * Library page and a live vault's Index/Wiki structure (the Library2 lens).
 *
 * This is the single mutation path for placement rows. Upserts are replay-safe
 * on (page_id, vault_id), ownership is enforced on both the insert and conflict
 * update paths, and a placement never copies page content. Removing a placement
 * leaves the authoritative library_pages row untouched.
 */

const log = createLogger("LibraryPlacementStore");
const PLACEMENT_WRITE_BATCH_SIZE = 200;

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
  indexPath?: string | null;
  parentPageId?: string | null;
  placedBy?: LibraryPlacementSource;
  confidence?: number | null;
}

export interface ListLibraryPlacementsFilter {
  pageId?: string;
  vaultId?: string;
}

interface NormalizedPlacementInput {
  pageId: string;
  vaultId: string;
  indexSection: LibraryPlacementIndexSection;
  indexPath: string | null;
  parentPageId: string | null;
  placedBy: LibraryPlacementSource;
  confidence: number | null;
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

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    result.push(items.slice(offset, offset + size));
  }
  return result;
}

function normalizeInputs(
  inputs: CreateLibraryPlacementInput[],
): NormalizedPlacementInput[] {
  const byIdentity = new Map<string, NormalizedPlacementInput>();
  for (const input of inputs) {
    byIdentity.set(`${input.pageId}:${input.vaultId}`, {
      pageId: input.pageId,
      vaultId: input.vaultId,
      indexSection: input.indexSection,
      indexPath: input.indexPath?.trim() || null,
      parentPageId: input.parentPageId ?? null,
      placedBy: input.placedBy ?? "manual",
      confidence: input.confidence ?? null,
    });
  }
  return Array.from(byIdentity.values());
}

async function validatePlacementInputs(
  inputs: NormalizedPlacementInput[],
  principal: Principal,
): Promise<void> {
  const pageIds = Array.from(
    new Set(
      inputs.flatMap((input) =>
        input.parentPageId
          ? [input.pageId, input.parentPageId]
          : [input.pageId],
      ),
    ),
  );
  const pageRows: Array<{ id: string; vaultId: string | null }> = [];
  for (const batch of chunks(pageIds, PLACEMENT_WRITE_BATCH_SIZE)) {
    pageRows.push(
      ...(await db
        .select({ id: libraryPages.id, vaultId: libraryPages.vaultId })
        .from(libraryPages)
        .where(
          combineWithVisibleScope(
            principal,
            libraryPageScopeColumns,
            inArray(libraryPages.id, batch),
          ),
        )),
    );
  }
  const pagesById = new Map(pageRows.map((page) => [page.id, page]));
  for (const pageId of pageIds) {
    if (!pagesById.has(pageId)) {
      throw Object.assign(new Error("Library page not found"), { status: 404 });
    }
  }

  const vaultIds = Array.from(new Set(inputs.map((input) => input.vaultId)));
  if (principal.actorType !== "system" && !principal.accountId) {
    throw badRequest("Library placement requires an account principal");
  }
  const vaultRows = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(
      principal.actorType === "system"
        ? and(inArray(vaults.id, vaultIds), eq(vaults.isArchived, false))
        : and(
            inArray(vaults.id, vaultIds),
            eq(vaults.accountId, principal.accountId!),
            eq(vaults.isArchived, false),
          ),
    );
  const visibleVaultIds = new Set(vaultRows.map((vault) => vault.id));
  for (const vaultId of vaultIds) {
    if (!visibleVaultIds.has(vaultId)) {
      throw Object.assign(
        new Error("Destination vault not found or archived"),
        { status: 404 },
      );
    }
  }

  for (const input of inputs) {
    if (!input.parentPageId) continue;
    const parent = pagesById.get(input.parentPageId)!;
    if (parent.vaultId !== input.vaultId) {
      throw badRequest(
        "Library placement parent must belong to the destination vault",
      );
    }
  }
}

function updateGroupKey(input: NormalizedPlacementInput): string {
  return JSON.stringify([
    input.vaultId,
    input.indexSection,
    input.indexPath,
    input.parentPageId,
    input.placedBy,
    input.confidence,
  ]);
}

/**
 * Atomically create or update a bounded batch of placements. Bulk validation,
 * chunked inserts, and grouped conflict updates keep database work bounded. A
 * uniqueness conflict owned by another principal fails closed and rolls back.
 */
export async function createLibraryPlacements(
  inputs: CreateLibraryPlacementInput[],
  principal: Principal,
): Promise<LibraryPlacement[]> {
  const normalizedInputs = normalizeInputs(inputs);
  if (normalizedInputs.length === 0) return [];
  await validatePlacementInputs(normalizedInputs, principal);

  const owner = ownedInsertValues(principal, placementScopeColumns);
  const rows = await db.transaction(async (tx) => {
    const placed: LibraryPlacement[] = [];
    const insertedIdentities = new Set<string>();

    for (const batch of chunks(normalizedInputs, PLACEMENT_WRITE_BATCH_SIZE)) {
      const inserted = await tx
        .insert(libraryPlacements)
        .values(
          batch.map((input) => ({
            ...input,
            ...owner,
            createdByUserId: principal.userId ?? undefined,
            updatedByUserId: principal.userId ?? undefined,
          })),
        )
        .onConflictDoNothing()
        .returning();
      for (const row of inserted) {
        insertedIdentities.add(`${row.pageId}:${row.vaultId}`);
        placed.push(row);
      }
    }

    const conflicts = normalizedInputs.filter(
      (input) => !insertedIdentities.has(`${input.pageId}:${input.vaultId}`),
    );
    const groups = new Map<string, NormalizedPlacementInput[]>();
    for (const input of conflicts) {
      const key = updateGroupKey(input);
      groups.set(key, [...(groups.get(key) ?? []), input]);
    }

    for (const group of groups.values()) {
      const exemplar = group[0];
      for (const batch of chunks(group, PLACEMENT_WRITE_BATCH_SIZE)) {
        const pageIds = batch.map((input) => input.pageId);
        const updated = await tx
          .update(libraryPlacements)
          .set({
            indexSection: exemplar.indexSection,
            indexPath: exemplar.indexPath,
            parentPageId: exemplar.parentPageId,
            placedBy: exemplar.placedBy,
            confidence: exemplar.confidence,
            updatedByUserId: principal.userId ?? undefined,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            writablePlacements(
              principal,
              and(
                eq(libraryPlacements.vaultId, exemplar.vaultId),
                inArray(libraryPlacements.pageId, pageIds),
              ),
            ),
          )
          .returning();
        if (updated.length !== batch.length) {
          throw Object.assign(
            new Error("Library placement identity belongs to another principal"),
            { status: 409 },
          );
        }
        placed.push(...updated);
      }
    }

    return placed;
  });

  log.info("placements upserted", {
    count: rows.length,
    principalUserId: principal.userId ?? null,
    vaultIds: Array.from(new Set(rows.map((row) => row.vaultId))),
  });
  return rows;
}

export async function createLibraryPlacement(
  input: CreateLibraryPlacementInput,
  principal: Principal,
): Promise<LibraryPlacement> {
  const [row] = await createLibraryPlacements([input], principal);
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
 * Delete a placement the principal owns. This removes only the Library2 lens
 * row and never touches the underlying Library page.
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
  if (removed) log.info("placement deleted", { placementId: id });
  return removed;
}
