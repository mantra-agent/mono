import { and, asc, count, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { libraryPages } from "@shared/models/info";
import { planExecutions } from "@shared/schema";
import { db } from "./db";
import { ensureCanonicalVaultFolder, publishLibraryChanged } from "./library-save";
import { moveLibraryPage } from "./library-move";
import { softDeleteLibrarySubtree } from "./library-domain";
import { libraryPageIsLive } from "./library-trash";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { combineWithWritableScope } from "./scoped-storage";

const log = createLogger("PlanLibraryReconciliation");
const PLANS_FOLDER_TAG = "canonical-folder-plans";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_OFFSET = 100_000;

const planScopeColumns = {
  ownerUserId: planExecutions.ownerUserId,
  accountId: planExecutions.accountId,
};
const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export type PlanLibraryReconciliationMode = "preview" | "apply";

interface JoinedPlanPage {
  planId: string;
  libraryPageId: string;
  vaultId: string;
  parentId: string | null;
}

interface PlansFolderCandidate {
  id: string;
  vaultId: string;
  tags: string[];
}

export interface PlanLibraryReconciliationResult {
  outcome: "preview" | "applied";
  mode: PlanLibraryReconciliationMode;
  pagination: { limit: number; offset: number; total: number; hasMore: boolean };
  associations: Array<{
    planId: string;
    libraryPageId: string;
    vaultId: string;
    currentParentId: string | null;
    canonicalPlansPageId: string | null;
    action: "none" | "move" | "ensure_then_move";
  }>;
  duplicateContainers: Array<{
    libraryPageId: string;
    vaultId: string;
    canonicalPlansPageId: string;
    childCount: number;
    planAssociationCount: number;
    action: "retire" | "skip_non_empty" | "skip_plan_associated" | "skip_unproven_duplicate";
  }>;
  moved: Array<{ planId: string; libraryPageId: string; canonicalPlansPageId: string; descendantCount: number }>;
  retired: Array<{ libraryPageId: string; vaultId: string }>;
  skipped: Array<{ libraryPageId: string; reason: string }>;
}

function boundedInteger(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(Math.floor(parsed), max));
}

function writablePlan(principal: Principal) {
  return combineWithWritableScope(principal, planScopeColumns);
}

function writablePage(principal: Principal, predicate?: SQL) {
  return combineWithWritableScope(principal, libraryScopeColumns, predicate);
}

async function readJoinedPlanPages(
  principal: Principal,
  limit: number,
  offset: number,
): Promise<{ rows: JoinedPlanPage[]; total: number }> {
  const basePredicate = and(
    writablePlan(principal),
    writablePage(principal),
    libraryPageIsLive(),
    sql`${libraryPages.vaultId} IS NOT NULL`,
  );
  const [totalRow] = await db
    .select({ value: count() })
    .from(planExecutions)
    .innerJoin(libraryPages, eq(planExecutions.pageId, libraryPages.id))
    .where(basePredicate);
  const rows = await db
    .select({
      planId: planExecutions.id,
      libraryPageId: libraryPages.id,
      vaultId: libraryPages.vaultId,
      parentId: libraryPages.parentId,
    })
    .from(planExecutions)
    .innerJoin(libraryPages, eq(planExecutions.pageId, libraryPages.id))
    .where(basePredicate)
    .orderBy(asc(planExecutions.createdAt), asc(planExecutions.id))
    .limit(limit)
    .offset(offset);
  return {
    rows: rows.flatMap(row => row.vaultId ? [{ ...row, vaultId: row.vaultId }] : []),
    total: Number(totalRow?.value ?? 0),
  };
}

async function readPlansFolders(principal: Principal, vaultIds: string[]): Promise<PlansFolderCandidate[]> {
  if (vaultIds.length === 0) return [];
  return db
    .select({
      id: libraryPages.id,
      vaultId: libraryPages.vaultId,
      tags: libraryPages.tags,
    })
    .from(libraryPages)
    .where(writablePage(principal, and(
      inArray(libraryPages.vaultId, vaultIds),
      isNull(libraryPages.parentId),
      libraryPageIsLive(),
      or(
        eq(sql`lower(${libraryPages.title})`, "plans"),
        sql`${PLANS_FOLDER_TAG} = ANY(${libraryPages.tags})`,
      ),
    )))
    .orderBy(asc(libraryPages.createdAt), asc(libraryPages.id))
    .then(rows => rows.flatMap(row => row.vaultId ? [{ ...row, vaultId: row.vaultId }] : []));
}

function canonicalFoldersByVault(folders: PlansFolderCandidate[]): Map<string, PlansFolderCandidate> {
  const result = new Map<string, PlansFolderCandidate>();
  for (const folder of folders) {
    if (!result.has(folder.vaultId)) result.set(folder.vaultId, folder);
  }
  return result;
}

async function countLiveChildren(principal: Principal, parentId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(libraryPages)
    .where(writablePage(principal, and(eq(libraryPages.parentId, parentId), libraryPageIsLive())));
  return Number(row?.value ?? 0);
}

async function countPlanAssociations(principal: Principal, pageId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(planExecutions)
    .where(combineWithWritableScope(principal, planScopeColumns, eq(planExecutions.pageId, pageId)));
  return Number(row?.value ?? 0);
}

export async function reconcilePlanLibraryPlacement(input: {
  principal: Principal;
  mode: PlanLibraryReconciliationMode;
  limit?: unknown;
  offset?: unknown;
}): Promise<PlanLibraryReconciliationResult> {
  if (!input.principal.userId || !input.principal.accountId) {
    throw Object.assign(new Error("Plan Library reconciliation requires an explicit user principal"), { status: 403 });
  }
  const requestedLimit = Number(input.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, boundedInteger(requestedLimit, DEFAULT_LIMIT, MAX_LIMIT))
    : DEFAULT_LIMIT;
  const offset = boundedInteger(input.offset, 0, MAX_OFFSET);
  const joined = await readJoinedPlanPages(input.principal, limit, offset);
  const vaultIds = Array.from(new Set(joined.rows.map(row => row.vaultId)));
  let folders = await readPlansFolders(input.principal, vaultIds);
  let canonicalByVault = canonicalFoldersByVault(folders);

  if (input.mode === "apply") {
    for (const vaultId of vaultIds) {
      await ensureCanonicalVaultFolder({ principal: input.principal, vaultId, kind: "plans" });
    }
    folders = await readPlansFolders(input.principal, vaultIds);
    canonicalByVault = canonicalFoldersByVault(folders);
  }

  const result: PlanLibraryReconciliationResult = {
    outcome: input.mode === "apply" ? "applied" : "preview",
    mode: input.mode,
    pagination: {
      limit,
      offset,
      total: joined.total,
      hasMore: offset + joined.rows.length < joined.total,
    },
    associations: [],
    duplicateContainers: [],
    moved: [],
    retired: [],
    skipped: [],
  };

  for (const association of joined.rows) {
    const canonical = canonicalByVault.get(association.vaultId) ?? null;
    const action = canonical
      ? association.parentId === canonical.id ? "none" : "move"
      : "ensure_then_move";
    result.associations.push({
      planId: association.planId,
      libraryPageId: association.libraryPageId,
      vaultId: association.vaultId,
      currentParentId: association.parentId,
      canonicalPlansPageId: canonical?.id ?? null,
      action,
    });
    if (input.mode !== "apply" || action === "none") continue;
    if (!canonical) {
      result.skipped.push({ libraryPageId: association.libraryPageId, reason: "canonical_plans_folder_unavailable" });
      continue;
    }
    if (association.libraryPageId === canonical.id) {
      result.skipped.push({ libraryPageId: association.libraryPageId, reason: "plan_page_is_canonical_container" });
      continue;
    }
    const moved = await moveLibraryPage({
      pageId: association.libraryPageId,
      destinationParentId: canonical.id,
      destinationVaultId: association.vaultId,
    }, input.principal);
    result.moved.push({
      planId: association.planId,
      libraryPageId: association.libraryPageId,
      canonicalPlansPageId: canonical.id,
      descendantCount: Math.max(0, moved.transferredPageCount - 1),
    });
  }

  for (const folder of folders) {
    const canonical = canonicalByVault.get(folder.vaultId);
    if (!canonical || folder.id === canonical.id) continue;
    const childCount = await countLiveChildren(input.principal, folder.id);
    const planAssociationCount = await countPlanAssociations(input.principal, folder.id);
    const action = !folder.tags.includes(PLANS_FOLDER_TAG)
      ? "skip_unproven_duplicate"
      : planAssociationCount > 0
        ? "skip_plan_associated"
        : childCount > 0 ? "skip_non_empty" : "retire";
    result.duplicateContainers.push({
      libraryPageId: folder.id,
      vaultId: folder.vaultId,
      canonicalPlansPageId: canonical.id,
      childCount,
      planAssociationCount,
      action,
    });
    if (input.mode !== "apply" || action !== "retire") continue;

    // Prove the duplicate is still an empty, unreferenced, root-level canonical
    // Plans container atomically inside the Trash transaction. The boundary holds
    // the folder's own child-parent lock while this runs, so a concurrent
    // child-add or plan-association cannot slip between the proof and the stamp.
    const retired = await softDeleteLibrarySubtree(input.principal, folder.id, {
      precondition: async () => {
        const [currentFolder] = await db
          .select({ tags: libraryPages.tags, parentId: libraryPages.parentId })
          .from(libraryPages)
          .where(writablePage(input.principal, and(eq(libraryPages.id, folder.id), libraryPageIsLive())))
          .limit(1);
        if (!currentFolder || !currentFolder.tags.includes(PLANS_FOLDER_TAG) || currentFolder.parentId !== null) {
          return false;
        }
        if (await countLiveChildren(input.principal, folder.id) !== 0) return false;
        if (await countPlanAssociations(input.principal, folder.id) !== 0) return false;
        return true;
      },
    });
    if (retired.preconditionFailed) {
      result.skipped.push({ libraryPageId: folder.id, reason: "duplicate_container_changed_before_retirement" });
    } else if (retired.trashedCount === 1) {
      result.retired.push({ libraryPageId: folder.id, vaultId: folder.vaultId });
    } else {
      result.skipped.push({ libraryPageId: folder.id, reason: "duplicate_container_not_retired" });
    }
  }

  if (input.mode === "apply" && (result.moved.length > 0 || result.retired.length > 0)) {
    publishLibraryChanged("plan_placement_reconciled");
  }
  log.info("Plan Library reconciliation completed", {
    mode: input.mode,
    associationCount: result.associations.length,
    movedCount: result.moved.length,
    duplicateContainerCount: result.duplicateContainers.length,
    retiredCount: result.retired.length,
    skippedCount: result.skipped.length,
    hasMore: result.pagination.hasMore,
  });
  return result;
}
