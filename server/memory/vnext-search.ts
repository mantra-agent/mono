import { and, desc, ilike, inArray, or, sql } from "drizzle-orm";
import type { MemoryVnextClaim, MemoryVnextSourceRef } from "@shared/schema";
import {
  MEMORY_VNEXT_LIFECYCLE_STAGE,
  memoryVnextClaimLinks,
  memoryVnextClaims,
  memoryVnextSourceRefs,
} from "@shared/schema";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { getTimezone } from "../timezone";
import { combineWithVisibleScope } from "../scoped-storage";
import { generateEmbedding } from "./embedding";
import { executeVnextClaimSemanticSearch } from "./vnext-claim-storage";

const log = createLogger("MemoryVnextSearch");
const MAX_CANDIDATES = 500;
const SEMANTIC_POOL = 120;
const LEXICAL_POOL = 120;

const claimScopeColumns = {
  scope: memoryVnextClaims.scope,
  ownerUserId: memoryVnextClaims.ownerUserId,
  accountId: memoryVnextClaims.accountId,
};
const sourceScopeColumns = {
  scope: memoryVnextSourceRefs.scope,
  ownerUserId: memoryVnextSourceRefs.ownerUserId,
  accountId: memoryVnextSourceRefs.accountId,
};
const linkScopeColumns = {
  scope: memoryVnextClaimLinks.scope,
  ownerUserId: memoryVnextClaimLinks.ownerUserId,
  accountId: memoryVnextClaimLinks.accountId,
};

export interface VnextSearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  source?: string | string[];
  claimType?: string;
  lifecycleStage?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  minLinks?: number;
  maxLinks?: number;
  minContentLength?: number;
  maxContentLength?: number;
  recalledBefore?: string;
  recalledAfter?: string;
  minRecallCount?: number;
  maxRecallCount?: number;
  hasTitle?: boolean;
  createdBefore?: string;
  createdAfter?: string;
  updatedBefore?: string;
  updatedAfter?: string;
  sortBy?: "createdAt" | "contentLength" | "linkCount" | "recallCount";
  sortOrder?: "asc" | "desc";
}

export interface VnextSearchResult {
  claim: MemoryVnextClaim;
  score: number;
  embeddingSimilarity: number;
  lexicalSimilarity: number;
  textMatch: boolean;
  linkCount: number;
  sourceRefs: MemoryVnextSourceRef[];
  retrievalPath: Array<"semantic" | "lexical" | "structured">;
}

export interface VnextSearchResponse {
  storage: "memory_vnext_claims";
  total: number;
  results: VnextSearchResult[];
}

function getTimezoneOffsetMs(utcDate: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = formatter.formatToParts(utcDate);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  const hour = value("hour") === "24" ? "00" : value("hour");
  const localAsUtc = new Date(`${value("year")}-${value("month")}-${value("day")}T${hour}:${value("minute")}:${value("second")}Z`);
  return localAsUtc.getTime() - utcDate.getTime();
}

function dateToUtc(date: string, timezone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date format: "${date}", expected YYYY-MM-DD`);
  const midnightUtc = new Date(`${date}T00:00:00Z`);
  const firstOffset = getTimezoneOffsetMs(midnightUtc, timezone);
  const candidate = new Date(midnightUtc.getTime() - firstOffset);
  const secondOffset = getTimezoneOffsetMs(candidate, timezone);
  return new Date(midnightUtc.getTime() - secondOffset);
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

function lexicalSimilarity(query: string, claim: MemoryVnextClaim): number {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery || normalizedQuery === "*") return 0;
  const title = (claim.title ?? "").toLowerCase();
  const content = claim.content.toLowerCase();
  const topics = (claim.topics ?? []).map((topic) => topic.toLowerCase());
  if (title === normalizedQuery) return 1;
  if (title.includes(normalizedQuery)) return 0.95;
  if (topics.some((topic) => topic === normalizedQuery)) return 0.9;
  if (content.includes(normalizedQuery)) return 0.86;
  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize(`${title} ${topics.join(" ")} ${content.slice(0, 3000)}`));
  return queryTokens.filter((token) => haystack.has(token)).length / queryTokens.length * 0.78;
}

function lifecycleFactor(stage: string): number {
  if (stage === "canonical") return 1.08;
  if (stage === "linked") return 1.04;
  if (stage === "sourced") return 1;
  return 0.92;
}

function sourceMatches(source: string | string[], claim: MemoryVnextClaim, refs: MemoryVnextSourceRef[]): boolean {
  const needles = (Array.isArray(source) ? source : [source]).map((value) => value.toLowerCase());
  const values = [claim.source, ...refs.map((ref) => ref.sourceType)].map((value) => value.toLowerCase());
  return needles.some((needle) => values.some((value) => value === needle || value.includes(needle)));
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO date: ${value}`);
  return parsed;
}

async function loadSourceRefs(claimIds: number[]): Promise<Map<number, MemoryVnextSourceRef[]>> {
  const refsByClaim = new Map<number, MemoryVnextSourceRef[]>();
  if (claimIds.length === 0) return refsByClaim;
  const refs = await db.select().from(memoryVnextSourceRefs).where(combineWithVisibleScope(
    getCurrentPrincipalOrSystem(), sourceScopeColumns, inArray(memoryVnextSourceRefs.claimId, claimIds),
  ));
  for (const ref of refs) refsByClaim.set(ref.claimId, [...(refsByClaim.get(ref.claimId) ?? []), ref]);
  return refsByClaim;
}

async function loadLinkCounts(claimIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (claimIds.length === 0) return counts;
  const links = await db.select().from(memoryVnextClaimLinks).where(combineWithVisibleScope(
    getCurrentPrincipalOrSystem(), linkScopeColumns,
    or(inArray(memoryVnextClaimLinks.fromClaimId, claimIds), inArray(memoryVnextClaimLinks.toClaimId, claimIds)),
  ));
  for (const link of links) {
    counts.set(link.fromClaimId, (counts.get(link.fromClaimId) ?? 0) + 1);
    counts.set(link.toClaimId, (counts.get(link.toClaimId) ?? 0) + 1);
  }
  return counts;
}

async function loadLexicalClaims(query: string, includeStructuredPool: boolean): Promise<MemoryVnextClaim[]> {
  const active = sql`${memoryVnextClaims.lifecycleStage} <> ${MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED}`;
  const trimmed = query.trim();
  const predicate = trimmed === "*" || includeStructuredPool
    ? active
    : and(active, or(
        ilike(memoryVnextClaims.title, `%${trimmed}%`),
        ilike(memoryVnextClaims.content, `%${trimmed}%`),
        sql`EXISTS (SELECT 1 FROM unnest(${memoryVnextClaims.topics}) topic WHERE topic ILIKE ${`%${trimmed}%`})`,
      ));
  return db.select().from(memoryVnextClaims)
    .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), claimScopeColumns, predicate))
    .orderBy(desc(memoryVnextClaims.createdAt))
    .limit(trimmed === "*" || includeStructuredPool ? MAX_CANDIDATES : LEXICAL_POOL);
}

export async function searchVnextMemory(options: VnextSearchOptions): Promise<VnextSearchResponse> {
  const query = options.query.trim();
  if (!query) return { storage: "memory_vnext_claims", total: 0, results: [] };
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const isWildcard = query === "*";
  const includeStructuredPool = !!(
    options.source || options.claimType || options.lifecycleStage || options.startDate || options.endDate ||
    options.minLinks !== undefined || options.maxLinks !== undefined || options.minContentLength !== undefined ||
    options.maxContentLength !== undefined || options.recalledBefore || options.recalledAfter ||
    options.minRecallCount !== undefined || options.maxRecallCount !== undefined || options.hasTitle !== undefined ||
    options.createdBefore || options.createdAfter || options.updatedBefore || options.updatedAfter || options.sortBy
  );
  const semanticRows = isWildcard ? [] : await executeVnextClaimSemanticSearch(await generateEmbedding(query), SEMANTIC_POOL);
  const lexicalRows = await loadLexicalClaims(query, includeStructuredPool);
  const candidates = new Map<number, MemoryVnextClaim>();
  const semanticById = new Map<number, number>();
  for (const { row, similarity } of semanticRows) {
    candidates.set(row.id, row);
    semanticById.set(row.id, similarity);
  }
  for (const claim of lexicalRows) candidates.set(claim.id, claim);

  const claimIds = [...candidates.keys()].slice(0, MAX_CANDIDATES);
  const [refsByClaim, linkCounts] = await Promise.all([loadSourceRefs(claimIds), loadLinkCounts(claimIds)]);
  const timezone = options.timezone || getTimezone();
  const startAt = options.startDate ? dateToUtc(options.startDate, timezone).getTime() : null;
  const endAt = options.endDate ? dateToUtc(options.endDate, timezone).getTime() : null;
  const createdBefore = parseDate(options.createdBefore);
  const createdAfter = parseDate(options.createdAfter);
  const updatedBefore = parseDate(options.updatedBefore);
  const updatedAfter = parseDate(options.updatedAfter);
  const recalledBefore = parseDate(options.recalledBefore);
  const recalledAfter = parseDate(options.recalledAfter);

  const matched = claimIds.map((id): VnextSearchResult => {
    const claim = candidates.get(id)!;
    const refs = refsByClaim.get(id) ?? [];
    const embeddingSimilarity = Math.max(0, semanticById.get(id) ?? 0);
    const lexical = lexicalSimilarity(query, claim);
    const textMatch = lexical >= 0.86;
    const baseScore = isWildcard ? 0 : Math.min(1, Math.max(embeddingSimilarity, lexical * 0.96) + (embeddingSimilarity > 0 && lexical > 0 ? 0.05 : 0));
    const score = isWildcard ? 0 : Math.min(1, baseScore * lifecycleFactor(claim.lifecycleStage) * (0.82 + claim.confidence * 0.22));
    const retrievalPath: VnextSearchResult["retrievalPath"] = [];
    if (embeddingSimilarity > 0) retrievalPath.push("semantic");
    if (lexical > 0) retrievalPath.push("lexical");
    if (isWildcard) retrievalPath.push("structured");
    return { claim, score, embeddingSimilarity, lexicalSimilarity: lexical, textMatch, linkCount: linkCounts.get(id) ?? 0, sourceRefs: refs, retrievalPath };
  }).filter((result) => {
    const { claim } = result;
    const createdAt = claim.createdAt.getTime();
    const updatedAt = claim.updatedAt.getTime();
    const recalledAt = claim.lastRecalledAt?.getTime() ?? null;
    if (options.source && !sourceMatches(options.source, claim, result.sourceRefs)) return false;
    if (options.claimType && claim.claimType !== options.claimType) return false;
    if (options.lifecycleStage && claim.lifecycleStage !== options.lifecycleStage) return false;
    if (startAt !== null && createdAt < startAt) return false;
    if (endAt !== null && createdAt >= endAt) return false;
    if (createdBefore !== null && createdAt >= createdBefore) return false;
    if (createdAfter !== null && createdAt <= createdAfter) return false;
    if (updatedBefore !== null && updatedAt >= updatedBefore) return false;
    if (updatedAfter !== null && updatedAt <= updatedAfter) return false;
    if (recalledBefore !== null && (recalledAt === null || recalledAt >= recalledBefore)) return false;
    if (recalledAfter !== null && (recalledAt === null || recalledAt <= recalledAfter)) return false;
    if (options.minLinks !== undefined && result.linkCount < options.minLinks) return false;
    if (options.maxLinks !== undefined && result.linkCount > options.maxLinks) return false;
    if (options.minContentLength !== undefined && claim.content.length < options.minContentLength) return false;
    if (options.maxContentLength !== undefined && claim.content.length > options.maxContentLength) return false;
    if (options.minRecallCount !== undefined && claim.recallCount < options.minRecallCount) return false;
    if (options.maxRecallCount !== undefined && claim.recallCount > options.maxRecallCount) return false;
    if (options.hasTitle === true && !claim.title?.trim()) return false;
    if (options.hasTitle === false && !!claim.title?.trim()) return false;
    return isWildcard || result.embeddingSimilarity > 0 || result.lexicalSimilarity > 0;
  });

  const direction = options.sortOrder === "asc" ? 1 : -1;
  matched.sort((left, right) => {
    if (!options.sortBy && !isWildcard) return right.score - left.score;
    const sortBy = options.sortBy ?? "createdAt";
    const leftValue = sortBy === "contentLength" ? left.claim.content.length
      : sortBy === "linkCount" ? left.linkCount
      : sortBy === "recallCount" ? left.claim.recallCount
      : left.claim.createdAt.getTime();
    const rightValue = sortBy === "contentLength" ? right.claim.content.length
      : sortBy === "linkCount" ? right.linkCount
      : sortBy === "recallCount" ? right.claim.recallCount
      : right.claim.createdAt.getTime();
    return (leftValue - rightValue) * direction;
  });

  const results = matched.slice(offset, offset + limit);
  log.debug(JSON.stringify({ event: "memory.vnext.search", query: query.slice(0, 80), candidates: candidates.size, matched: matched.length, returned: results.length }));
  return { storage: "memory_vnext_claims", total: matched.length, results };
}
