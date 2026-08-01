import { createHash } from "crypto";
import { and, asc, count, eq, gt, inArray, like, or } from "drizzle-orm";
import { extractPositionedReferences } from "@shared/reference-parser";
import { normalizeProtocolAddress, REFERENCE_OCCURRENCE_BATCH_LIMIT } from "@shared/life-addressing";
import { libraryPageLinks, libraryPages, type LibraryPage } from "@shared/models/info";
import { referenceOccurrences, referenceOccurrenceSources } from "@shared/schema";
import { db } from "./db";
import { replaceReferenceOccurrences } from "./life-addressing-storage";
import { libraryPageIsLive } from "./library-trash";
import { syncEmbeddedLibraryPageLinks } from "./library-link-graph";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { combineWithVisibleScope } from "./scoped-storage";

const log = createLogger("LibraryReferenceIndex");
const pageScope = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};
const occurrenceScope = {
  scope: referenceOccurrences.scope,
  ownerUserId: referenceOccurrences.ownerUserId,
  accountId: referenceOccurrences.accountId,
};
const occurrenceSourceScope = {
  scope: referenceOccurrenceSources.scope,
  ownerUserId: referenceOccurrenceSources.ownerUserId,
  accountId: referenceOccurrenceSources.accountId,
};
const linkScope = {
  scope: libraryPageLinks.scope,
  ownerUserId: libraryPageLinks.ownerUserId,
  accountId: libraryPageLinks.accountId,
};

export const LIBRARY_REFERENCE_BACKFILL_LIMIT = 100;
export const LIBRARY_REFERENCE_NEIGHBORHOOD_LIMIT = 5_000;

export function libraryPageLinksCompatibilityEnabled(): boolean {
  return process.env.LIBRARY_PAGE_LINKS_COMPATIBILITY_ENABLED !== "false";
}

function requireUserPrincipal(principal: Principal): asserts principal is Principal & { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw Object.assign(new Error("Library reference indexing requires an authenticated user principal"), { status: 401 });
  }
}

function pageAddress(pageId: string): string {
  return `@page:${pageId}`;
}

function revisionForContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function canonicalPageAddresses(
  principal: Principal,
  identifiers: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(identifiers.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ id: libraryPages.id, slug: libraryPages.slug })
    .from(libraryPages)
    .where(combineWithVisibleScope(
      principal,
      pageScope,
      and(or(inArray(libraryPages.id, wanted), inArray(libraryPages.slug, wanted)), libraryPageIsLive()),
    ));
  return new Map(rows.flatMap(row => [[row.id, pageAddress(row.id)], [row.slug, pageAddress(row.id)]] as const));
}

export interface LibraryReferenceIndexResult {
  pageId: string;
  outcome: "replaced" | "unchanged" | "stale";
  occurrenceCount: number;
  unresolvedCount: number;
  compatibilitySynced: boolean;
}

/**
 * Canonical Library authored-reference mutation boundary. Call this inside the
 * same ambient database transaction that writes the page revision.
 */
export async function indexLibraryPageReferences(
  principal: Principal,
  page: Pick<LibraryPage, "id" | "plainTextContent" | "updatedAt">,
): Promise<LibraryReferenceIndexResult> {
  requireUserPrincipal(principal);
  const positioned = extractPositionedReferences(page.plainTextContent, { includeUnknownTypes: true });
  if (positioned.length > REFERENCE_OCCURRENCE_BATCH_LIMIT) {
    throw Object.assign(new Error(`Library page contains too many references (max ${REFERENCE_OCCURRENCE_BATCH_LIMIT})`), { status: 400 });
  }

  const pageTargets = positioned.filter(item => item.ref.type === "page").map(item => item.ref.id);
  const canonicalPages = await canonicalPageAddresses(principal, pageTargets);
  let unresolvedCount = 0;
  const occurrences = positioned.flatMap(item => {
    const normalizedTarget = item.ref.type === "page" ? undefined : normalizeProtocolAddress(item.ref.canonical);
    const targetAddress = item.ref.type === "page"
      ? canonicalPages.get(item.ref.id)
      : normalizedTarget?.outcome === "valid"
        ? normalizedTarget.address
        : undefined;
    if (!targetAddress) {
      unresolvedCount++;
      return [];
    }
    return [{ targetAddress, location: { start: item.start, end: item.end } }];
  });

  const replacement = await replaceReferenceOccurrences(principal, {
    sourceAddress: pageAddress(page.id),
    sourceRevision: revisionForContent(page.plainTextContent),
    observedAt: page.updatedAt,
    occurrences,
  });

  const compatibilitySynced = libraryPageLinksCompatibilityEnabled();
  if (compatibilitySynced) await syncEmbeddedLibraryPageLinks(page.id, principal);

  log.debug("Indexed Library references", {
    pageId: page.id,
    outcome: replacement.outcome,
    occurrenceCount: replacement.occurrenceCount,
    unresolvedCount,
    compatibilitySynced,
  });
  return {
    pageId: page.id,
    outcome: replacement.outcome,
    occurrenceCount: replacement.occurrenceCount,
    unresolvedCount,
    compatibilitySynced,
  };
}

export interface LibraryReferenceNeighborhood {
  sourcePageId: string;
  targetPageId: string;
  createdAt: Date;
  occurrenceCount: number;
  source: "occurrence" | "compatibility";
}

function aggregateOccurrenceNeighborhood(rows: Array<{ sourceAddress: string; targetAddress: string; observedAt: Date }>): LibraryReferenceNeighborhood[] {
  const aggregated = new Map<string, LibraryReferenceNeighborhood>();
  for (const row of rows) {
    if (!row.sourceAddress.startsWith("@page:") || !row.targetAddress.startsWith("@page:")) continue;
    const sourcePageId = row.sourceAddress.slice(6);
    const targetPageId = row.targetAddress.slice(6);
    if (!sourcePageId || !targetPageId || sourcePageId === targetPageId) continue;
    const key = `${sourcePageId}->${targetPageId}`;
    const current = aggregated.get(key);
    if (current) {
      current.occurrenceCount++;
      if (row.observedAt > current.createdAt) current.createdAt = row.observedAt;
    } else {
      aggregated.set(key, { sourcePageId, targetPageId, createdAt: row.observedAt, occurrenceCount: 1, source: "occurrence" });
    }
  }
  return [...aggregated.values()];
}

export interface LibraryAuthoredOccurrence {
  sourceAddress: string;
  targetAddress: string;
  observedAt: Date;
  occurrenceCount: number;
}

export async function getLibraryAuthoredOccurrences(
  principal: Principal,
  pageIds: string[],
): Promise<LibraryAuthoredOccurrence[]> {
  requireUserPrincipal(principal);
  const addresses = [...new Set(pageIds.filter(Boolean))].slice(0, 50).map(pageAddress);
  if (addresses.length === 0) return [];
  const rows = await db.select({
    sourceAddress: referenceOccurrences.sourceAddress,
    targetAddress: referenceOccurrences.targetAddress,
    observedAt: referenceOccurrences.observedAt,
  }).from(referenceOccurrences)
    .where(combineWithVisibleScope(principal, occurrenceScope, inArray(referenceOccurrences.sourceAddress, addresses)))
    .orderBy(asc(referenceOccurrences.observedAt), asc(referenceOccurrences.id))
    .limit(LIBRARY_REFERENCE_NEIGHBORHOOD_LIMIT);
  const aggregated = new Map<string, LibraryAuthoredOccurrence>();
  for (const row of rows) {
    const key = `${row.sourceAddress}->${row.targetAddress}`;
    const current = aggregated.get(key);
    if (current) {
      current.occurrenceCount++;
      if (row.observedAt > current.observedAt) current.observedAt = row.observedAt;
    } else {
      aggregated.set(key, { ...row, occurrenceCount: 1 });
    }
  }
  return [...aggregated.values()];
}

async function occurrenceNeighborhood(principal: Principal, pageIds: string[]): Promise<LibraryReferenceNeighborhood[]> {
  const addresses = pageIds.map(pageAddress);
  if (addresses.length === 0) return [];
  const rows = await db.select({
    sourceAddress: referenceOccurrences.sourceAddress,
    targetAddress: referenceOccurrences.targetAddress,
    observedAt: referenceOccurrences.observedAt,
  }).from(referenceOccurrences)
    .where(combineWithVisibleScope(principal, occurrenceScope, or(
      inArray(referenceOccurrences.sourceAddress, addresses),
      inArray(referenceOccurrences.targetAddress, addresses),
    )))
    .orderBy(asc(referenceOccurrences.observedAt), asc(referenceOccurrences.id))
    .limit(LIBRARY_REFERENCE_NEIGHBORHOOD_LIMIT);
  return aggregateOccurrenceNeighborhood(rows);
}

async function compatibilityNeighborhood(principal: Principal, pageIds: string[]): Promise<LibraryReferenceNeighborhood[]> {
  if (!libraryPageLinksCompatibilityEnabled() || pageIds.length === 0) return [];
  return db.select({
    sourcePageId: libraryPageLinks.sourcePageId,
    targetPageId: libraryPageLinks.targetPageId,
    createdAt: libraryPageLinks.createdAt,
  }).from(libraryPageLinks)
    .where(combineWithVisibleScope(principal, linkScope, or(
      inArray(libraryPageLinks.sourcePageId, pageIds),
      inArray(libraryPageLinks.targetPageId, pageIds),
    )))
    .orderBy(asc(libraryPageLinks.createdAt), asc(libraryPageLinks.id))
    .limit(LIBRARY_REFERENCE_NEIGHBORHOOD_LIMIT)
    .then(rows => rows.map(row => ({ ...row, occurrenceCount: 1, source: "compatibility" as const })));
}

function parity(oldRows: LibraryReferenceNeighborhood[], newRows: LibraryReferenceNeighborhood[]) {
  const key = (row: LibraryReferenceNeighborhood) => `${row.sourcePageId}->${row.targetPageId}`;
  const oldKeys = new Set(oldRows.map(key));
  const newKeys = new Set(newRows.map(key));
  return {
    oldEdges: oldKeys.size,
    newEdges: newKeys.size,
    matchedEdges: [...oldKeys].filter(item => newKeys.has(item)).length,
    oldOnlyEdges: [...oldKeys].filter(item => !newKeys.has(item)).length,
    newOnlyEdges: [...newKeys].filter(item => !oldKeys.has(item)).length,
  };
}

/** Canonical occurrence neighborhood with compatibility fallback for unbackfilled sources. */
export async function getLibraryReferenceNeighborhood(
  principal: Principal,
  pageIds: string[],
): Promise<{ links: LibraryReferenceNeighborhood[]; parity: ReturnType<typeof parity>; usedCompatibilityFallback: boolean }> {
  requireUserPrincipal(principal);
  const ids = [...new Set(pageIds.filter(Boolean))].slice(0, 50);
  if (ids.length === 0) return { links: [], parity: parity([], []), usedCompatibilityFallback: false };
  const addresses = ids.map(pageAddress);
  const [newRows, oldRows, projectedRows] = await Promise.all([
    occurrenceNeighborhood(principal, ids),
    compatibilityNeighborhood(principal, ids),
    db.select({ sourceAddress: referenceOccurrenceSources.sourceAddress })
      .from(referenceOccurrenceSources)
      .where(combineWithVisibleScope(principal, occurrenceSourceScope, inArray(referenceOccurrenceSources.sourceAddress, addresses))),
  ]);
  const comparison = parity(oldRows, newRows);
  const projectedSources = new Set(projectedRows.map(row => row.sourceAddress.slice(6)));
  const fallbackRows = oldRows.filter(row => !projectedSources.has(row.sourcePageId));
  return {
    links: [...newRows, ...fallbackRows],
    parity: comparison,
    usedCompatibilityFallback: fallbackRows.length > 0,
  };
}

export interface LibraryReferenceBackfillResult {
  cursor?: string;
  nextCursor?: string;
  limit: number;
  totalPages: number;
  projectedPages: number;
  scanned: number;
  replaced: number;
  unchanged: number;
  stale: number;
  occurrences: number;
  unresolved: number;
  errors: number;
  parity: ReturnType<typeof parity>;
}

/** Replay one bounded, resumable page-ID batch. */
export async function backfillLibraryReferences(
  principal: Principal,
  input: { cursor?: string; limit?: number } = {},
): Promise<LibraryReferenceBackfillResult> {
  requireUserPrincipal(principal);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? LIBRARY_REFERENCE_BACKFILL_LIMIT), 1), LIBRARY_REFERENCE_BACKFILL_LIMIT);
  const pagePredicate = and(libraryPageIsLive(), input.cursor ? gt(libraryPages.id, input.cursor) : undefined);
  const pages = await db.select({ id: libraryPages.id, plainTextContent: libraryPages.plainTextContent, updatedAt: libraryPages.updatedAt })
    .from(libraryPages)
    .where(combineWithVisibleScope(principal, pageScope, pagePredicate))
    .orderBy(asc(libraryPages.id))
    .limit(limit + 1);
  const batch = pages.slice(0, limit);
  const nextCursor = pages.length > limit ? batch.at(-1)?.id : undefined;
  const counters = { replaced: 0, unchanged: 0, stale: 0, occurrences: 0, unresolved: 0, errors: 0 };

  for (const page of batch) {
    try {
      const result = await db.transaction(async () => indexLibraryPageReferences(principal, page));
      counters[result.outcome]++;
      counters.occurrences += result.occurrenceCount;
      counters.unresolved += result.unresolvedCount;
    } catch (error: unknown) {
      counters.errors++;
      log.warn("Library reference backfill page failed", { pageId: page.id, errorType: error instanceof Error ? error.name : "unknown" });
    }
  }

  const [totals, projected, comparison] = await Promise.all([
    db.select({ value: count() }).from(libraryPages).where(combineWithVisibleScope(principal, pageScope, libraryPageIsLive())),
    db.select({ value: count() }).from(referenceOccurrenceSources).where(combineWithVisibleScope(principal, occurrenceSourceScope, like(referenceOccurrenceSources.sourceAddress, "@page:%"))),
    getLibraryReferenceNeighborhood(principal, batch.map(page => page.id)),
  ]);
  const result: LibraryReferenceBackfillResult = {
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    limit,
    totalPages: Number(totals[0]?.value ?? 0),
    projectedPages: Number(projected[0]?.value ?? 0),
    scanned: batch.length,
    ...counters,
    parity: comparison.parity,
  };
  log.info("Library reference backfill batch", result);
  return result;
}
