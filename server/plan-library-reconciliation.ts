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
const MAX_ANCESTOR_DEPTH = 100;

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
  placementRootPlanPageId: string;
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
    placementRootPlanPageId: string;
    canonicalPlansPageId: string | null;
    action: "none" | "move" | "preserve_nested" | "ensure_then_move";
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
  const scopedRows = rows.flatMap(row => row.vaultId ? [{ ...row, vaultId: row.vaultId }] : []);
  const pageIds = scopedRows.map(row => row.libraryPageId);
  if (pageIds.length === 0) return { rows: [], total: Number(totalRow?.value ?? 0) };

  const ancestors = await db.execute<{
    page_id: string;
    ancestor_id: string;
    depth: number;
  }>(sql`
    WITH RECURSIVE ancestors AS (
      SELECT
        lp.id AS page_id,
        lp.id AS ancestor_id,
        lp.parent_id,
        0 AS depth,
        ARRAY[lp.id]::text[] AS path
      FROM library_pages lp
      WHERE lp.id IN (${sql.join(pageIds.map(id => sql`${id}`), sql`, `)})

      UNION ALL

      SELECT
        ancestors.page_id,
        parent.id AS ancestor_id,
        parent.parent_id,
        ancestors.depth + 1,
        ancestors.path || parent.id
      FROM ancestors
      INNER JOIN library_pages parent ON parent.id = ancestors.parent_id
      WHERE ancestors.depth < ${MAX_ANCESTOR_DEPTH}
        AND NOT parent.id = ANY(ancestors.path)
    )
    SELECT ancestors.page_id, ancestors.ancestor_id, ancestors.depth
    FROM ancestors
    INNER JOIN plan_executions ON plan_executions.page_id = ancestors.ancestor_id
    INNER JOIN library_pages ON library_pages.id = ancestors.ancestor_id
    WHERE ${combineWithWritableScope(principal, planScopeColumns)}
      AND ${combineWithWritableScope(principal, libraryScopeColumns)}
      AND ${libraryPageIsLive()}
    ORDER BY ancestors.page_id, ancestors.depth DESC
  `);
  const placementRootByPage = new Map<string, string>();
  for (const ancestor of ancestors.rows ?? []) {
    if (!placementRootByPage.has(ancestor.page_id)) {
      placementRootByPage.set(ancestor.page_id, ancestor.ancestor_id);
    }
  }

  return {
    rows: scopedRows.map(row => ({
      ...row,
      placementRootPlanPageId: placementRootByPage.get(row.libraryPageId) ?? row.libraryPageId,
    })),
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
  if (input.principal.actorType !== "user" || !input.principal.userId || !input.principal.accountId) {
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
    const isNestedPlan = association.placementRootPlanPageId !== association.libraryPageId;
    const action = isNestedPlan
      ? "preserve_nested"
      : !canonical
        ? "ensure_then_move"
        : association.parentId === canonical.id ? "none" : "move";
    result.associations.push({
      planId: association.planId,
      libraryPageId: association.libraryPageId,
      vaultId: association.vaultId,
      currentParentId: association.parentId,
      placementRootPlanPageId: association.placementRootPlanPageId,
      canonicalPlansPageId: canonical?.id ?? null,
      action,
    });
    if (input.mode !== "apply" || action === "none" || action === "preserve_nested") continue;
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
      : childCount > 0
        ? "skip_non_empty"
        : planAssociationCount > 0 ? "skip_plan_associated" : "retire";
    result.duplicateContainers.push({
      libraryPageId: folder.id,
      vaultId: folder.vaultId,
      canonicalPlansPageId: canonical.id,
      childCount,
      planAssociationCount,
      action,
    });
    if (input.mode !== "apply" || action !== "retire") continue;

    const currentChildCount = await countLiveChildren(input.principal, folder.id);
    const currentPlanAssociationCount = await countPlanAssociations(input.principal, folder.id);
    const [currentFolder] = await db
      .select({ tags: libraryPages.tags, parentId: libraryPages.parentId })
      .from(libraryPages)
      .where(writablePage(input.principal, and(eq(libraryPages.id, folder.id), libraryPageIsLive())))
      .limit(1);
    if (!currentFolder?.tags.includes(PLANS_FOLDER_TAG) || currentFolder.parentId !== null || currentChildCount !== 0 || currentPlanAssociationCount !== 0) {
      result.skipped.push({ libraryPageId: folder.id, reason: "duplicate_container_changed_before_retirement" });
      continue;
    }
    const retired = await softDeleteLibrarySubtree(input.principal, folder.id, { requireEmpty: true });
    if (retired.trashedCount === 1) {
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
