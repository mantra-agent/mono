import { db } from "../db";
import {
  memoryEntries,
  memoryLinks,
  memorySourceRefs,
  memoryTransitions,
  memoryContentBlocks,
  memoryEvents,
  memoryEntityLinks,
  relationshipTypes,
  type MemoryEntry,
  type InsertMemoryEntry,
  type MemoryLink,
  type InsertMemoryLink,
  type MemorySourceRef,
  type InsertMemorySourceRef,
  type MemoryTransition,
  type MemoryContentBlock,
  type MemoryEvent,
  type MemoryEventType,
  type MemoryEntityLink,
  type MemoryLayer,
  type MemorySource,
  MEMORY_INTEGRATION_STAGE,
  deriveMemoryIntegrationStage,
  type SimilarEntryResult,
  type NeighborhoodCache,
  type NeighborhoodCacheEntry,
  type RelationshipType,
} from "@shared/schema";
import {
  eq,
  desc,
  sql,
  and,
  count,
  inArray,
  isNull,
  or,
  ne,
  gte,
  lte,
  lt,
  asc,
  count,
} from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { createHash } from "crypto";
import { getTimezone } from "../timezone";
import { createLogger } from "../log";
import { insertMemoryEvent } from "./memory-events";

const log = createLogger("MemoryStorage");


function isSessionSummaryMetadata(metadata: unknown): boolean {
  return (metadata as Record<string, unknown> | null)?.mirrorKind === "session_summary";
}

function notSessionSummaryMemoryPredicate() {
  return or(
    ne(memoryEntries.source, "chat_journal"),
    sql`COALESCE(${memoryEntries.metadata}->>'mirrorKind', '') <> 'session_summary'`,
  );
}

const memoryScopeColumns = {
  scope: memoryEntries.scope,
  ownerUserId: memoryEntries.ownerUserId,
  accountId: memoryEntries.accountId,
};

const memorySourceScopeColumns = {
  scope: memorySourceRefs.scope,
  ownerUserId: memorySourceRefs.ownerUserId,
  accountId: memorySourceRefs.accountId,
};


function canonicalOrLegacyLongCondition(alias: string = "me") {
  const table = sql.raw(alias);
  return sql`(${table}.integration_stage IN ('stage_3', 'stage_4') OR ${table}.layer = 'long')`;
}

function normalizeMemoryLinkRelationship(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function classifyMemoryLinkSourceRef(
  link: Pick<MemoryLink, "fromId" | "toId" | "relationship" | "relationshipType" | "strength">,
): MemorySourceRefInput | null {
  const relationship = normalizeMemoryLinkRelationship(link.relationship);
  const relationshipType = normalizeMemoryLinkRelationship(link.relationshipType || "related");

  if (relationshipType === "supports" || relationship === "supports") {
    return {
      memoryId: link.toId,
      sourceType: "memory",
      sourceId: String(link.fromId),
      relationship: "supports",
      context: link.relationship,
      strength: link.strength,
    };
  }

  if (relationshipType === "contradicts" || relationship === "contradicts") {
    return {
      memoryId: link.toId,
      sourceType: "memory",
      sourceId: String(link.fromId),
      relationship: "contradicts",
      context: link.relationship,
      strength: link.strength,
    };
  }

  if (
    relationshipType === "evolves" ||
    relationship === "evolves" ||
    relationship === "refines" ||
    relationship === "supersedes"
  ) {
    return {
      memoryId: link.toId,
      sourceType: "memory",
      sourceId: String(link.fromId),
      relationship: relationship === "supersedes" ? "supersedes" : "refines",
      context: link.relationship,
      strength: link.strength,
    };
  }

  if (relationshipType === "depends_on" || relationship === "depends_on") {
    return {
      memoryId: link.fromId,
      sourceType: "memory",
      sourceId: String(link.toId),
      relationship: "depends_on",
      context: link.relationship,
      strength: link.strength,
    };
  }

  if (relationship === "derived_from" || relationship === "extracted_from") {
    return {
      memoryId: link.fromId,
      sourceType: "memory",
      sourceId: String(link.toId),
      relationship: "extracted_from",
      context: link.relationship,
      strength: link.strength,
    };
  }

  return null;
}

export function memoryKnowledgeEligibleCondition() {
  return and(
    ne(memoryEntries.layer, "workspace"),
    sql`COALESCE(${memoryEntries.metadata}->>'canonicalDocument', 'false') != 'true'`,
    sql`COALESCE(${memoryEntries.metadata}->>'sourceOfTruth', '') != 'domain'`,
    or(
      ne(memoryEntries.source, "chat"),
      sql`${memoryEntries.metadata}->>'mirrorKind' = 'session_summary'`,
    ),
    or(
      ne(memoryEntries.source, "voice_session"),
      sql`${memoryEntries.metadata}->>'mirrorKind' = 'session_summary'`,
    ),
    or(
      ne(memoryEntries.source, "conversation"),
      and(
        sql`COALESCE(${memoryEntries.sourceId}, '') NOT LIKE 'exchange-%'`,
        sql`NOT (COALESCE(${memoryEntries.tags}, ARRAY[]::text[]) @> ARRAY['exchange']::text[])`,
      ),
    ),
  );
}

export const memoryKnowledgeEligibleSql = sql`
  layer != 'workspace'
  AND COALESCE(metadata->>'canonicalDocument', 'false') != 'true'
  AND COALESCE(metadata->>'sourceOfTruth', '') != 'domain'
  AND (source != 'chat' OR metadata->>'mirrorKind' = 'session_summary')
  AND (source != 'voice_session' OR metadata->>'mirrorKind' = 'session_summary')
  AND (source != 'conversation' OR (COALESCE(source_id, '') NOT LIKE 'exchange-%' AND NOT (COALESCE(tags, ARRAY[]::text[]) @> ARRAY['exchange']::text[])))
`;


export interface RetentionPurgeRequest {
  startDate?: Date;
  endDate: Date;
  layers?: MemoryLayer[];
  sources?: MemorySource[];
  protectionMode?: "standard" | "aggressive" | "exact";
}

export interface RetentionPurgeDryRun {
  queryHash: string;
  candidates: number;
  skipped: number;
  byLayer: Record<string, number>;
  bySource: Record<string, number>;
  affectedLinks: number;
  affectedEntityLinks: number;
  survivingPeersToRecompute: number;
  estimatedBatches: number;
  samples: {
    oldest: Array<Pick<MemoryEntry, "id" | "title" | "layer" | "source" | "createdAt">>;
    newest: Array<Pick<MemoryEntry, "id" | "title" | "layer" | "source" | "createdAt">>;
    highestLinked: Array<Pick<MemoryEntry, "id" | "title" | "layer" | "source" | "createdAt"> & { linkCount: number }>;
  };
  skippedReasons: Array<{ reason: string; count: number }>;
  warnings: string[];
}

export interface RetentionPurgeArchive extends RetentionPurgeDryRun {
  createdAt: string;
  request: { startDate?: string; endDate: string; layers?: MemoryLayer[]; sources?: MemorySource[]; protectionMode: "standard" | "aggressive" | "exact" };
  memoryEntries: unknown[];
  memoryLinks: unknown[];
  memorySources: unknown[];
  memoryEntityLinks: unknown[];
  memoryTransitions: unknown[];
  memoryContentBlocks: unknown[];
  memoryEvents: unknown[];
}

export interface DuplicateEdgeInput {
  a: number;
  b: number;
  embeddingSim: number;
  titleSim: number;
  contentSim: number;
  exact: boolean;
}

export interface DuplicateMemberMeta {
  title: string | null;
  layer: string;
  contentLength: number;
}

export function buildDuplicateClustersFromEdges(
  edges: DuplicateEdgeInput[],
  memberMeta: Map<number, DuplicateMemberMeta>,
  limit: number,
): DuplicateCluster[] {
  const allIds = new Set<number>();
  for (const e of edges) {
    allIds.add(e.a);
    allIds.add(e.b);
  }
  if (allIds.size === 0) return [];

  const parent = new Map<number, number>();
  for (const id of allIds) parent.set(id, id);
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur)! !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (x: number, y: number): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const e of edges) union(e.a, e.b);

  const clusterEdges = new Map<number, DuplicateEdgeInput[]>();
  const clusterMembers = new Map<number, Set<number>>();
  for (const id of allIds) {
    const root = find(id);
    if (!clusterMembers.has(root)) clusterMembers.set(root, new Set());
    clusterMembers.get(root)!.add(id);
  }
  for (const e of edges) {
    const root = find(e.a);
    if (!clusterEdges.has(root)) clusterEdges.set(root, []);
    clusterEdges.get(root)!.push(e);
  }

  const clusters: DuplicateCluster[] = [];
  for (const [root, memberSet] of clusterMembers.entries()) {
    if (memberSet.size < 2) continue;
    const list = clusterEdges.get(root) || [];
    const minEmb = list.reduce(
      (m, e) => Math.min(m, e.embeddingSim),
      Number.POSITIVE_INFINITY,
    );
    const minTitle = list.reduce(
      (m, e) => Math.min(m, e.titleSim),
      Number.POSITIVE_INFINITY,
    );
    const minContent = list.reduce(
      (m, e) => Math.min(m, e.contentSim),
      Number.POSITIVE_INFINITY,
    );
    const allExact = list.length > 0 && list.every((e) => e.exact);

    const members = Array.from(memberSet)
      .sort((a, b) => a - b)
      .map((id) => {
        const meta = memberMeta.get(id) || {
          title: null,
          layer: "unknown",
          contentLength: 0,
        };
        return {
          id,
          title: meta.title,
          layer: meta.layer,
          contentLength: meta.contentLength,
        };
      });

    const embeddingSimilarity = Number.isFinite(minEmb) ? minEmb : 1.0;
    clusters.push({
      members,
      embeddingSimilarity,
      contentSimilarity: Number.isFinite(minContent) ? minContent : 1.0,
      titleSimilarity: Number.isFinite(minTitle) ? minTitle : 1.0,
      exactMatch: allExact,
      recommendedAction:
        allExact || embeddingSimilarity >= 0.95 ? "merge" : "review",
    });
  }

  clusters.sort((a, b) => {
    if (b.members.length !== a.members.length)
      return b.members.length - a.members.length;
    return b.embeddingSimilarity - a.embeddingSimilarity;
  });

  return clusters.slice(0, limit);
}

export interface DuplicateClusterMember {
  id: number;
  title: string | null;
  layer: string;
  contentLength: number;
}

export interface DuplicateCluster {
  members: DuplicateClusterMember[];
  embeddingSimilarity: number;
  contentSimilarity: number;
  titleSimilarity: number;
  exactMatch: boolean;
  recommendedAction: "merge" | "review";
}

export function computeStringOverlap(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();
  if (aLower === bLower) return 1;
  const aWords = new Set(aLower.split(/\s+/).filter((w) => w.length > 0));
  const bWords = new Set(bLower.split(/\s+/).filter((w) => w.length > 0));
  if (aWords.size === 0 && bWords.size === 0) return 1;
  if (aWords.size === 0 || bWords.size === 0) return 0;
  let overlap = 0;
  for (const w of aWords) {
    if (bWords.has(w)) overlap++;
  }
  return overlap / Math.max(aWords.size, bWords.size);
}

const NEIGHBORHOOD_CACHE_VERSION = 2;
const NEIGHBORHOOD_MAX_ENTRIES = 50;
const NEIGHBORHOOD_SEMAPHORE_CAP = 4;

let neighborhoodSemaphoreCount = 0;
const neighborhoodSemaphoreQueue: Array<() => void> = [];

async function acquireNeighborhoodSemaphore(): Promise<void> {
  if (neighborhoodSemaphoreCount < NEIGHBORHOOD_SEMAPHORE_CAP) {
    neighborhoodSemaphoreCount++;
    return;
  }
  return new Promise<void>((resolve) => {
    neighborhoodSemaphoreQueue.push(() => {
      neighborhoodSemaphoreCount++;
      resolve();
    });
  });
}

function releaseNeighborhoodSemaphore(): void {
  neighborhoodSemaphoreCount--;
  const next = neighborhoodSemaphoreQueue.shift();
  if (next) next();
}

type DbExecutor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const memoryEntryLightColumns = {
  id: memoryEntries.id,
  layer: memoryEntries.layer,
  integrationStage: memoryEntries.integrationStage,
  content: memoryEntries.content,
  summary: memoryEntries.summary,
  contentHash: memoryEntries.contentHash,
  source: memoryEntries.source,
  sourceId: memoryEntries.sourceId,
  path: memoryEntries.path,
  title: memoryEntries.title,
  oneLiner: memoryEntries.oneLiner,
  metadata: memoryEntries.metadata,
  tags: memoryEntries.tags,
  graphed: memoryEntries.graphed,
  createdAt: memoryEntries.createdAt,
  processedAt: memoryEntries.processedAt,
  processingStatus: memoryEntries.processingStatus,
  processingRunId: memoryEntries.processingRunId,
  processingStartedAt: memoryEntries.processingStartedAt,
  processingError: memoryEntries.processingError,
  processingUpdatedAt: memoryEntries.processingUpdatedAt,
} as const;

export function wrapLightEntry(
  entry: Omit<MemoryEntry, "embedding">,
): MemoryEntry {
  return new Proxy(entry as MemoryEntry, {
    get(target, prop) {
      if (prop === "embedding") {
        log.warn(
          `[LightEntry] Accessing 'embedding' on light-selected entry #${target.id} — embedding was excluded from query. This is a bug.`,
        );
        return null;
      }
      return (target as any)[prop];
    },
  });
}

export const memoryEntryListingColumns = {
  id: memoryEntries.id,
  layer: memoryEntries.layer,
  integrationStage: memoryEntries.integrationStage,
  summary: memoryEntries.summary,
  source: memoryEntries.source,
  sourceId: memoryEntries.sourceId,
  path: memoryEntries.path,
  title: memoryEntries.title,
  oneLiner: memoryEntries.oneLiner,
  metadata: memoryEntries.metadata,
  tags: memoryEntries.tags,
  graphed: memoryEntries.graphed,
  pinned: memoryEntries.pinned,
  createdAt: memoryEntries.createdAt,
  processedAt: memoryEntries.processedAt,
  processingStatus: memoryEntries.processingStatus,
  processingRunId: memoryEntries.processingRunId,
  processingStartedAt: memoryEntries.processingStartedAt,
  processingError: memoryEntries.processingError,
  processingUpdatedAt: memoryEntries.processingUpdatedAt,
} as const;

export function wrapListingEntry(
  entry: Omit<MemoryEntry, "embedding" | "content" | "contentHash">,
): MemoryEntry {
  return new Proxy(entry as MemoryEntry, {
    get(target, prop) {
      if (prop === "embedding") {
        log.warn(
          `[ListingEntry] Accessing 'embedding' on listing-selected entry #${target.id} — embedding was excluded from query. This is a bug.`,
        );
        return null;
      }
      if (prop === "content") {
        log.warn(
          `[ListingEntry] Accessing 'content' on listing-selected entry #${target.id} — content was excluded from query, falling back to summary.`,
        );
        return (target as any).summary ?? "";
      }
      if (prop === "contentHash") {
        return null;
      }
      return (target as any)[prop];
    },
  });
}

const LINK_QUERY_BATCH = 500;

export function isDuplicateLayerConstraintError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("uk_memory_layer_source_id") || msg.includes("duplicate key")
  );
}

export function computeContentHash(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

export function isSummaryStale(entry: MemoryEntry): boolean {
  if (!entry.summary || !entry.contentHash) return true;
  return entry.contentHash !== computeContentHash(entry.content);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function normalizedSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

function fuzzyBestMatch(item: string, candidates: string[]): number {
  if (candidates.length === 0) return 0;
  let best = 0;
  for (const c of candidates) {
    const sim = normalizedSimilarity(item, c);
    if (sim > best) best = sim;
    if (best === 1) break;
  }
  return best;
}

function fuzzySetSimilarity(setA: string[], setB: string[]): number {
  if (setA.length === 0 && setB.length === 0) return 0;
  if (setA.length === 0 || setB.length === 0) return 0;
  const cappedA = setA.length > 20 ? setA.slice(0, 20) : setA;
  const cappedB = setB.length > 20 ? setB.slice(0, 20) : setB;
  let sumA = 0;
  for (const a of cappedA) sumA += fuzzyBestMatch(a, cappedB);
  let sumB = 0;
  for (const b of cappedB) sumB += fuzzyBestMatch(b, cappedA);
  return (sumA + sumB) / (cappedA.length + cappedB.length);
}

function fuzzyTitleSimilarity(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  const wordsA = a
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 15);
  const wordsB = b
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 15);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  return fuzzySetSimilarity(wordsA, wordsB);
}

interface RawMemoryRow {
  id: number;
  layer: string;
  integration_stage: string | null;
  content: string;
  summary: string | null;
  embedding: number[] | null;
  source: string;
  source_id: string | null;
  path: string | null;
  title: string | null;
  one_liner: string | null;
  content_hash: string | null;
  metadata: Record<string, unknown>;
  tags: string[] | null;
  graphed: boolean;
  created_at: Date | string;
  processed_at: Date | string | null;
  processing_status?: string | null;
  processing_run_id?: string | null;
  processing_started_at?: Date | string | null;
  processing_error?: string | null;
  processing_updated_at?: Date | string | null;
  similarity?: string | number | null;
}

interface MyelinationStatsRow {
  total: number;
  with_summary: number;
  with_embedding: number;
  with_hash: number;
  needs_processing: number;
}

interface LinkedCountRow {
  linked_count: string;
}

interface MemoryEntriesByDayRow {
  day: string;
  entry_id: number;
  title: string | null;
}

function parseOptionalDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function memoryProcessingFields(row: {
  processing_status?: string | null;
  processing_run_id?: string | null;
  processing_started_at?: Date | string | null;
  processing_error?: string | null;
  processing_updated_at?: Date | string | null;
}) {
  return {
    processingStatus: row.processing_status ?? "idle",
    processingRunId: row.processing_run_id ?? null,
    processingStartedAt: parseOptionalDate(row.processing_started_at),
    processingError: row.processing_error ?? null,
    processingUpdatedAt: parseOptionalDate(row.processing_updated_at),
  };
}

function calculateHybridScore(
  row: RawMemoryRow,
  sourceTags: Set<string>,
  sourceTitle: string,
  hasEmbedding: boolean,
): {
  entry: MemoryEntry;
  embeddingSim: number;
  tagSim: number;
  titleSim: number;
  hybridScore: number;
} {
  const entryTagsArr: string[] = (row.tags || []).map((t: string) =>
    t.toLowerCase(),
  );
  const sourceTagsArr = Array.from(sourceTags) as string[];
  const tagSim = fuzzySetSimilarity(sourceTagsArr, entryTagsArr);
  const embeddingSim =
    row.similarity != null ? parseFloat(String(row.similarity)) : 0;

  let titleSim = 0;
  if (sourceTitle && row.title) {
    const candidateTitle = row.title.toLowerCase().trim();
    titleSim = fuzzyTitleSimilarity(sourceTitle, candidateTitle);
  }

  let hybridScore: number;
  if (hasEmbedding) {
    hybridScore = 0.6 * embeddingSim + 0.25 * tagSim + 0.15 * titleSim;
  } else {
    hybridScore = 0.7 * tagSim + 0.3 * titleSim;
  }

  return {
    entry: mapRawRowToEntry(row),
    embeddingSim,
    tagSim,
    titleSim,
    hybridScore,
  };
}

export function mapRawRowToEntry(row: RawMemoryRow): MemoryEntry {
  return {
    id: row.id,
    layer: row.layer as MemoryLayer,
    integrationStage: deriveMemoryIntegrationStage({
      integrationStage: row.integration_stage,
      layer: row.layer,
      title: row.title,
      summary: row.summary,
      tags: row.tags,
    }),
    content: row.content,
    summary: row.summary,
    embedding: row.embedding,
    source: row.source as MemorySource,
    sourceId: row.source_id,
    path: row.path ?? null,
    title: row.title ?? null,
    oneLiner: row.one_liner ?? null,
    contentHash: row.content_hash ?? null,
    metadata: row.metadata,
    tags: row.tags,
    graphed: row.graphed ?? false,
    pinned: false,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
    processedAt: parseOptionalDate(row.processed_at),
    ...memoryProcessingFields(row),
  };
}

function mapRawRowToLightEntry(row: RawMemoryRow): MemoryEntry {
  return wrapLightEntry({
    id: row.id,
    layer: row.layer as MemoryLayer,
    integrationStage: deriveMemoryIntegrationStage({
      integrationStage: row.integration_stage,
      layer: row.layer,
      title: row.title,
      summary: row.summary,
      tags: row.tags,
    }),
    content: row.content,
    summary: row.summary,
    source: row.source as MemorySource,
    sourceId: row.source_id,
    path: row.path ?? null,
    title: row.title ?? null,
    oneLiner: row.one_liner ?? null,
    contentHash: row.content_hash ?? null,
    metadata: row.metadata,
    tags: row.tags,
    graphed: row.graphed ?? false,
    pinned: false,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at
        : new Date(row.created_at),
    processedAt: parseOptionalDate(row.processed_at),
    ...memoryProcessingFields(row),
  });
}

export async function executeSemanticSearch(
  queryEmbedding: number[],
  limit: number,
  layerFilter?: string,
  startUTC?: Date,
  endUTC?: Date,
  queryTag?: string,
  options: { archiveMode?: boolean } = {},
): Promise<Array<{ row: RawMemoryRow; similarity: number }>> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const layerCondition = layerFilter
    ? sql`AND layer = ${layerFilter}`
    : sql`AND layer != 'workspace'`;
  const knowledgeCondition = options.archiveMode ? sql`` : sql`AND (${memoryKnowledgeEligibleSql})`;
  const startCondition = startUTC
    ? sql`AND created_at >= ${startUTC.toISOString()}`
    : sql``;
  const endCondition = endUTC
    ? sql`AND created_at < ${endUTC.toISOString()}`
    : sql``;
  const principal = getCurrentPrincipalOrSystem();
  const visibilityCondition = principal.actorType === "system"
    ? sql``
    : sql`AND (scope = 'global' OR owner_user_id = ${principal.userId} OR account_id = ${principal.accountId})`;
  const tagComment = queryTag ? sql.raw(`/* ${queryTag} */`) : sql``;
  const results = await db.execute(sql`
    ${tagComment}
    SELECT id, layer, integration_stage, content, summary, content_hash, source, source_id, path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at,
      1 - (embedding <=> ${embeddingStr}::vector) AS similarity
    FROM memory_entries
    WHERE embedding IS NOT NULL ${visibilityCondition} ${layerCondition} ${knowledgeCondition} ${startCondition} ${endCondition}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `);
  return (results.rows as unknown as RawMemoryRow[]).map((row) => ({
    row,
    similarity: parseFloat(String(row.similarity ?? "0")),
  }));
}

export interface MemorySourceRefInput {
  memoryId: number;
  sourceType: string;
  sourceId: string;
  relationship?: InsertMemorySourceRef["relationship"];
  context?: string;
  quote?: string | null;
  spanStart?: number | null;
  spanEnd?: number | null;
  strength?: number;
}

export class MemoryStorage {
  async addSourceRef(input: MemorySourceRefInput): Promise<MemorySourceRef> {
    const principal = getCurrentPrincipalOrSystem();
    const values = {
      memoryId: input.memoryId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      relationship: input.relationship ?? "extracted_from",
      context: input.context ?? "",
      quote: input.quote ?? null,
      spanStart: input.spanStart ?? null,
      spanEnd: input.spanEnd ?? null,
      strength: input.strength ?? 1,
      ...ownedInsertValues(principal, memorySourceScopeColumns),
      createdByUserId: principal.userId ?? undefined,
      updatedByUserId: principal.userId ?? undefined,
    };

    const [ref] = await db
      .insert(memorySourceRefs)
      .values(values)
      .onConflictDoUpdate({
        target: [
          memorySourceRefs.memoryId,
          memorySourceRefs.sourceType,
          memorySourceRefs.sourceId,
          memorySourceRefs.relationship,
        ],
        set: {
          context: values.context,
          quote: values.quote,
          spanStart: values.spanStart,
          spanEnd: values.spanEnd,
          strength: values.strength,
          updatedByUserId: values.updatedByUserId,
        },
      })
      .returning();
    return ref;
  }

  private async addLegacySourceRef(
    memoryId: number,
    source: MemorySource,
    sourceId?: string | null,
    context = "Backfilled from legacy memory_entries.source/source_id",
  ): Promise<void> {
    if (!sourceId) return;
    try {
      await this.addSourceRef({
        memoryId,
        sourceType: source,
        sourceId,
        relationship: "extracted_from",
        context,
        strength: 1,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to create memory source ref for entry #${memoryId} (${source}:${sourceId}): ${message}`,
      );
    }
  }

  async ingest(
    content: string,
    source: MemorySource,
    sourceId?: string,
    metadata?: Record<string, unknown>,
    tags?: string[],
    title?: string,
    emotionalStateId?: number | null,
  ): Promise<MemoryEntry> {
    const values = {
      layer: "short" as const,
      integrationStage: MEMORY_INTEGRATION_STAGE.RAW,
      content,
      source,
      sourceId: sourceId ?? null,
      metadata: metadata ?? {},
      tags: tags ?? [],
      ...(title ? { title } : {}),
      ...(emotionalStateId ? { emotionalStateId } : {}),
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), memoryScopeColumns),
      createdByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
    };

    if (sourceId) {
      const [existingRaw] = await db
        .select(memoryEntryLightColumns)
        .from(memoryEntries)
        .where(
          combineWithVisibleScope(
            getCurrentPrincipalOrSystem(),
            memoryScopeColumns,
            and(
              eq(memoryEntries.sourceId, sourceId),
              eq(memoryEntries.source, source),
              eq(memoryEntries.layer, "short"),
            ),
          ),
        )
        .limit(1);

      if (existingRaw) {
        return wrapLightEntry(existingRaw as Omit<MemoryEntry, "embedding">);
      }

      const [entry] = await db.insert(memoryEntries).values(values).returning();

      await this.addLegacySourceRef(entry.id, source, sourceId);
      await this.appendEvent(entry.id, "created", { source, layer: "short" });
      return entry;
    }

    const [entry] = await db.insert(memoryEntries).values(values).returning();

    await this.addLegacySourceRef(entry.id, source, sourceId);
    await this.appendEvent(entry.id, "created", { source, layer: "short" });
    return entry;
  }

  async upsertExchange(
    sourceId: string,
    content: string,
    source: MemorySource,
    metadata?: Record<string, unknown>,
    tags?: string[],
    title?: string | null,
    emotionalStateId?: number | null,
  ): Promise<MemoryEntry> {
    const [existingRaw] = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(
            eq(memoryEntries.layer, "short"),
            eq(memoryEntries.source, source),
            eq(memoryEntries.sourceId, sourceId),
          ),
        ),
      )
      .limit(1);
    const existing = existingRaw
      ? wrapLightEntry(existingRaw as Omit<MemoryEntry, "embedding">)
      : null;

    let entry: MemoryEntry;
    if (existing) {
      const updateSet: Record<string, unknown> = {
        content,
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
        metadata: metadata !== undefined ? (metadata ?? {}) : existing.metadata,
        tags: tags !== undefined ? (tags ?? []) : existing.tags,
        processedAt: new Date(),
        summary: existing.content !== content ? null : existing.summary,
        contentHash: existing.content !== content ? null : existing.contentHash,
        ...(emotionalStateId ? { emotionalStateId } : {}),
      };
      if (title !== undefined && title !== null) {
        updateSet.title = title;
      }
      const [updated] = await db
        .update(memoryEntries)
        .set(updateSet)
        .where(
          combineWithWritableScope(
            getCurrentPrincipalOrSystem(),
            memoryScopeColumns,
            eq(memoryEntries.id, existing.id),
          ),
        )
        .returning();
      entry = updated;
    } else {
      // Guard: never recall session summary entries through the exchange pipeline.
      // Session summaries are managed exclusively by upsertSessionSummaryMemory at archive time.
      const isSessionSummary = await this.isSessionSummaryEntry(sourceId, source);
      const promoted = isSessionSummary
        ? null
        : await this.recallPromotedEntry(
            sourceId,
            source,
            content,
            metadata,
            tags,
            title,
          );
      if (promoted) {
        entry = promoted;
      } else {
        const [inserted] = await db
          .insert(memoryEntries)
          .values({
            layer: "short",
            integrationStage: MEMORY_INTEGRATION_STAGE.RAW,
            content,
            source,
            sourceId,
            metadata: metadata ?? {},
            tags: tags ?? [],
            title: title || null,
            ...(emotionalStateId ? { emotionalStateId } : {}),
            ...ownedInsertValues(
              getCurrentPrincipalOrSystem(),
              memoryScopeColumns,
            ),
            createdByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
            updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
          })
          .returning();
        await this.addLegacySourceRef(inserted.id, source, sourceId);
        entry = inserted;
      }
    }

    await this.addLegacySourceRef(entry.id, source, sourceId);
    await this.appendEvent(entry.id, "updated", { source });
    return entry;
  }

  /**
   * Check if an existing mid/long entry for this source+sourceId is a session summary.
   * Session summaries must not be recalled by the exchange pipeline.
   */
  private async isSessionSummaryEntry(
    sourceId: string,
    source: MemorySource,
  ): Promise<boolean> {
    const [row] = await db
      .select({ metadata: memoryEntries.metadata })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.source, source),
          eq(memoryEntries.sourceId, sourceId),
          sql`${memoryEntries.layer} IN ('mid', 'long')`,
        ),
      )
      .limit(1);
    return isSessionSummaryMetadata(row?.metadata ?? null);
  }

  private async recallPromotedEntry(
    sourceId: string,
    source: MemorySource,
    content: string,
    metadata?: Record<string, unknown>,
    tags?: string[],
    title?: string | null,
  ): Promise<MemoryEntry | null> {
    const [midMatchRaw] = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(
            eq(memoryEntries.source, source),
            eq(memoryEntries.sourceId, sourceId),
            eq(memoryEntries.layer, "mid"),
            notSessionSummaryMemoryPredicate(),
          ),
        ),
      )
      .limit(1);

    const longMatchRaw = midMatchRaw
      ? null
      : ((
          await db
            .select(memoryEntryLightColumns)
            .from(memoryEntries)
            .where(
              combineWithVisibleScope(
                getCurrentPrincipalOrSystem(),
                memoryScopeColumns,
                and(
                  eq(memoryEntries.source, source),
                  eq(memoryEntries.sourceId, sourceId),
                  eq(memoryEntries.layer, "long"),
                  notSessionSummaryMemoryPredicate(),
                ),
              ),
            )
            .limit(1)
        )[0] ?? null);

    const promotedRaw = midMatchRaw ?? longMatchRaw;
    const promoted = promotedRaw
      ? wrapLightEntry(promotedRaw as Omit<MemoryEntry, "embedding">)
      : null;

    if (!promoted) return null;

    if (isSessionSummaryMetadata(promoted.metadata)) {
      log.error(
        `[MemoryRecall] Invariant violation blocked: session_summary entry #${promoted.id} cannot be recalled/demoted (sourceId=${sourceId})`,
      );
      await this.appendEvent(promoted.id, "updated", {
        reason: "blocked_session_summary_recall",
        attemptedSource: source,
        attemptedSourceId: sourceId,
      });
      return promoted;
    }

    const previousLayer = promoted.layer;
    const previousGraphed = promoted.graphed;
    const existingMeta = (promoted.metadata as Record<string, unknown>) || {};

    const mergedMeta: Record<string, unknown> = {
      ...existingMeta,
      ...(metadata ?? {}),
      recalledAt: new Date().toISOString(),
      previousLayer,
      ...(previousGraphed ? { previousGraphed: true } : {}),
    };

    const updateSet: Record<string, unknown> = {
      layer: "short",
      integrationStage: MEMORY_INTEGRATION_STAGE.RAW,
      content,
      metadata: mergedMeta,
      tags: tags !== undefined ? (tags ?? []) : promoted.tags,
      processedAt: new Date(),
      summary: null,
      contentHash: null,
      graphed: false,
    };
    if (title !== undefined && title !== null) {
      updateSet.title = title;
    }

    const [updated] = await db
      .update(memoryEntries)
      .set(updateSet)
      .where(eq(memoryEntries.id, promoted.id))
      .returning();

    // Clean up orphaned graph links when graphed is cleared
    if (previousGraphed) {
      const deleted = await this.deleteLinksForEntry(promoted.id);
      if (deleted > 0) {
        log.debug(
          `[MemoryRecall] Cleaned up ${deleted} orphaned graph links for entry #${promoted.id}`,
        );
      }
    }

    await db.insert(memoryTransitions).values({
      entryId: promoted.id,
      fromLayer: previousLayer,
      toLayer: "short",
      reason: `Recalled for continuation: #${promoted.id} ${previousLayer}${previousGraphed ? "+graphed" : ""} → short`,
    });

    await this.appendEvent(promoted.id, "recalled", {
      previousLayer,
      previousGraphed,
      reason: "recalled_for_continuation",
    });

    log.debug(
      `[MemoryRecall] Entry #${promoted.id} recalled from ${previousLayer}${previousGraphed ? "+graphed" : ""} → short for continued session (sourceId=${sourceId})`,
    );

    return updated;
  }

  async claimStageOneSweepBatch(options: {
    runId: string;
    cutoff: Date;
    touchCutoff: Date;
    staleCutoff: Date;
    limit: number;
  }): Promise<MemoryEntry[]> {
    const rows = await db.execute(sql`
      UPDATE memory_entries
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'stageSweep', jsonb_build_object(
              'status', 'processing',
              'runId', ${options.runId}::text,
              'claimedAt', NOW(),
              'staleRecovered', COALESCE(processing_status, 'idle') = 'processing'
            )
          ),
          processing_status = 'processing',
          processing_run_id = ${options.runId},
          processing_started_at = NOW(),
          processing_error = NULL,
          processing_updated_at = NOW(),
          processed_at = NOW(),
          updated_by_user_id = ${getCurrentPrincipalOrSystem().userId ?? null}
      WHERE id IN (
        SELECT id
        FROM memory_entries
        WHERE integration_stage = ${MEMORY_INTEGRATION_STAGE.ENRICHED}
          AND created_at <= ${options.cutoff}
          AND (${memoryKnowledgeEligibleSql})
          AND (
            COALESCE(processing_status, 'idle') = 'idle'
            OR (COALESCE(processing_status, 'idle') = 'processing' AND COALESCE(processing_updated_at, processed_at, created_at) <= ${options.staleCutoff})
          )
          AND (
            processed_at IS NULL
            OR processed_at <= ${options.touchCutoff}
            OR (COALESCE(processing_status, 'idle') = 'processing' AND COALESCE(processing_updated_at, processed_at, created_at) <= ${options.staleCutoff})
          )
        ORDER BY created_at ASC
        LIMIT ${options.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, layer, integration_stage, content, summary, content_hash, source, source_id, path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at, processing_status, processing_run_id, processing_started_at, processing_error, processing_updated_at
    `);
    return (rows.rows as unknown as RawMemoryRow[]).map(mapRawRowToEntry);
  }

  async preserveLegacySourceRef(
    memoryId: number,
    source: MemorySource,
    sourceId?: string | null,
    context = "Preserved during memory stage advancement",
  ): Promise<void> {
    await this.addLegacySourceRef(memoryId, source, sourceId, context);
  }


  async getStageTwoEvidenceCounts(memoryId: number): Promise<{ sourceRefs: number; legacyLinks: number }> {
    const [sourceRefRow] = await db
      .select({ count: count() })
      .from(memorySourceRefs)
      .where(eq(memorySourceRefs.memoryId, memoryId));

    const [legacyLinkRow] = await db
      .select({ count: count() })
      .from(memoryLinks)
      .where(or(eq(memoryLinks.fromId, memoryId), eq(memoryLinks.toId, memoryId)));

    return {
      sourceRefs: Number(sourceRefRow?.count ?? 0),
      legacyLinks: Number(legacyLinkRow?.count ?? 0),
    };
  }

  async advanceStageOneToStageTwo(
    entryId: number,
    runId: string,
    details: { linksCreated: number; sourceRefPreserved: boolean },
  ): Promise<MemoryEntry | null> {
    const result = await db.transaction(async (tx) => {
      const [updatedRaw] = await tx
        .update(memoryEntries)
        .set({
          layer: "mid",
          integrationStage: MEMORY_INTEGRATION_STAGE.INTEGRATED,
          contentHash: sql`COALESCE(${memoryEntries.contentHash}, md5(${memoryEntries.content}))`,
          metadata: sql`COALESCE(${memoryEntries.metadata}, '{}'::jsonb) || jsonb_build_object(
            'stageSweep', jsonb_build_object(
              'status', 'completed',
              'runId', ${runId}::text,
              'completedAt', NOW(),
              'linksCreated', ${details.linksCreated}::int,
              'sourceRefPreserved', ${details.sourceRefPreserved}::boolean
            )
          )`,
          processedAt: new Date(),
          processingStatus: "idle",
          processingRunId: null,
          processingStartedAt: null,
          processingError: null,
          processingUpdatedAt: new Date(),
          updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
        })
        .where(
          and(
            eq(memoryEntries.id, entryId),
            eq(memoryEntries.integrationStage, MEMORY_INTEGRATION_STAGE.ENRICHED),
            eq(memoryEntries.processingStatus, "processing"),
            eq(memoryEntries.processingRunId, runId),
            ne(memoryEntries.layer, "workspace"),
            sql`COALESCE(${memoryEntries.metadata}->>'canonicalDocument', 'false') != 'true'`,
            sql`COALESCE(${memoryEntries.metadata}->>'sourceOfTruth', '') != 'domain'`,
          ),
        )
        .returning(memoryEntryLightColumns);

      if (!updatedRaw) return null;

      await tx.insert(memoryTransitions).values({
        entryId,
        fromLayer: "stage_1",
        toLayer: "stage_2",
        reason: `Stage sweep advanced #${entryId}: stage_1 → stage_2`,
      });
      await insertMemoryEvent(tx, {
        entryId,
        eventType: "promoted",
        details: {
          fromStage: MEMORY_INTEGRATION_STAGE.ENRICHED,
          toStage: MEMORY_INTEGRATION_STAGE.INTEGRATED,
          fromLayer: "stage_1",
          toLayer: "stage_2",
          source: "stage_one_sweep",
          ...details,
        },
      });

      return wrapLightEntry(updatedRaw as Omit<MemoryEntry, "embedding">);
    });

    return result;
  }

  async markStageOneSweepFailed(entryId: number, runId: string, error: string): Promise<void> {
    await db
      .update(memoryEntries)
      .set({
        metadata: sql`COALESCE(${memoryEntries.metadata}, '{}'::jsonb) || jsonb_build_object(
          'stageSweep', jsonb_build_object(
            'status', 'failed',
            'runId', ${runId}::text,
            'failedAt', NOW(),
            'error', ${error.slice(0, 500)}::text
          )
        )`,
        processedAt: new Date(),
        processingStatus: "error",
        processingRunId: null,
        processingStartedAt: null,
        processingError: error.slice(0, 500),
        processingUpdatedAt: new Date(),
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      })
      .where(
        and(
          eq(memoryEntries.id, entryId),
          eq(memoryEntries.integrationStage, MEMORY_INTEGRATION_STAGE.ENRICHED),
          eq(memoryEntries.processingStatus, "processing"),
          eq(memoryEntries.processingRunId, runId),
        ),
      );
    await this.appendEvent(entryId, "updated", { source: "stage_one_sweep", status: "failed", error: error.slice(0, 500) });
  }


  async markStageOneSweepSkipped(entryId: number, runId: string, reason: string): Promise<void> {
    await db
      .update(memoryEntries)
      .set({
        metadata: sql`COALESCE(${memoryEntries.metadata}, '{}'::jsonb) || jsonb_build_object(
          'stageSweep', jsonb_build_object(
            'status', 'skipped',
            'runId', ${runId}::text,
            'skippedAt', NOW(),
            'reason', ${reason.slice(0, 500)}::text
          )
        )`,
        processedAt: new Date(),
        processingStatus: "idle",
        processingRunId: null,
        processingStartedAt: null,
        processingError: null,
        processingUpdatedAt: new Date(),
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      })
      .where(
        and(
          eq(memoryEntries.id, entryId),
          eq(memoryEntries.integrationStage, MEMORY_INTEGRATION_STAGE.ENRICHED),
          eq(memoryEntries.processingStatus, "processing"),
          eq(memoryEntries.processingRunId, runId),
        ),
      );
    await this.appendEvent(entryId, "updated", { source: "stage_one_sweep", status: "skipped", reason: reason.slice(0, 500) });
  }

  async getLayer(
    layer: MemoryLayer,
    limit = 50,
    offset = 0,
    options: { archiveMode?: boolean } = {},
  ): Promise<MemoryEntry[]> {
    const conditions = [eq(memoryEntries.layer, layer)];
    if (!options.archiveMode) {
      conditions.push(memoryKnowledgeEligibleCondition());
    }
    if (layer === "long") {
      conditions.push(eq(memoryEntries.graphed, false));
    }
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(...conditions),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => wrapLightEntry(r as Omit<MemoryEntry, "embedding">));
  }

  async findSimilarEntries(
    entryId: number,
    limit = 8,
    options?: {
      layers?: string[];
      excludeIds?: Set<number>;
      skipLinkedFilter?: boolean;
    },
  ): Promise<SimilarEntryResult[]> {
    // Intentional SELECT * — needs embedding column for similarity search
    const [source] = await db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, entryId))
      .limit(1);
    if (!source) return [];

    const excludeIds = new Set<number>(options?.excludeIds ?? []);
    excludeIds.add(entryId);

    if (!options?.skipLinkedFilter) {
      const existingLinks = await this.getLinks(entryId);
      for (const link of existingLinks) {
        excludeIds.add(link.fromId);
        excludeIds.add(link.toId);
      }
    }

    const layers = options?.layers ?? ["long", "workspace"];
    const layersLiteral = `{${layers.join(",")}}`;
    const sourceTags = new Set((source.tags || []).map((t) => t.toLowerCase()));
    const sourceTitle = (source.title || "").toLowerCase().trim();
    const hasEmbedding = !!source.embedding;
    const principal = getCurrentPrincipalOrSystem();
    const visibilityCondition = principal.actorType === "system"
      ? sql``
      : sql`AND (scope = 'global' OR owner_user_id = ${principal.userId} OR account_id = ${principal.accountId})`;

    let candidateRows: RawMemoryRow[];

    if (hasEmbedding) {
      const embeddingStr = `[${(source.embedding as number[]).join(",")}]`;
      const candidates = await db.execute(sql`
        SELECT id, layer, integration_stage, content, summary, content_hash, source, source_id, path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at,
          CASE WHEN embedding IS NOT NULL
            THEN 1 - (embedding <=> ${embeddingStr}::vector)
            ELSE NULL
          END AS similarity
        FROM memory_entries
        WHERE id != ${entryId}
          AND layer = ANY(${layersLiteral}::text[])
          ${visibilityCondition}
          AND (${memoryKnowledgeEligibleSql})
        ORDER BY
          CASE WHEN embedding IS NOT NULL
            THEN embedding <=> ${embeddingStr}::vector
            ELSE 2
          END
        LIMIT ${limit * 3}
      `);
      candidateRows = candidates.rows as unknown as RawMemoryRow[];
    } else {
      const candidates = await db.execute(sql`
        SELECT id, layer, integration_stage, content, summary, content_hash, source, source_id, path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at,
          NULL AS similarity
        FROM memory_entries
        WHERE id != ${entryId}
          AND layer = ANY(${layersLiteral}::text[])
          ${visibilityCondition}
          AND (${memoryKnowledgeEligibleSql})
          AND tags IS NOT NULL
          AND array_length(tags, 1) > 0
        ORDER BY created_at DESC
        LIMIT ${limit * 5}
      `);
      candidateRows = candidates.rows as unknown as RawMemoryRow[];
    }

    log.debug(
      `findSimilarEntries entry #${entryId} | layers=${layers.join(",")} | hasEmbedding=${hasEmbedding} | sourceTags=[${Array.from(sourceTags).join(", ")}] | candidates found: ${candidateRows.length}`,
    );

    const scored = candidateRows
      .filter((row) => !excludeIds.has(row.id))
      .map((row) =>
        calculateHybridScore(row, sourceTags, sourceTitle, hasEmbedding),
      )
      .filter((item) => item.hybridScore > 0)
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .slice(0, limit);

    if (scored.length > 0) {
      log.debug(
        `findSimilarEntries entry #${entryId} | top ${scored.length} results: ${scored
          .slice(0, 3)
          .map(
            (s) =>
              `#${s.entry.id} "${s.entry.title || "?"}" (hybrid=${s.hybridScore.toFixed(3)}, tag=${s.tagSim.toFixed(3)}, emb=${s.embeddingSim.toFixed(3)}, title=${s.titleSim.toFixed(1)})`,
          )
          .join(", ")}`,
      );
    } else {
      log.debug(
        `findSimilarEntries entry #${entryId} | no similar entries found`,
      );
    }

    return scored;
  }

  async getLinksWithEntries(
    entryId: number,
    queryTag?: string,
  ): Promise<
    Array<{
      link: MemoryLink;
      entry: MemoryEntry;
      direction: "from" | "to";
    }>
  > {
    const links = await this.getLinks(entryId, queryTag);
    if (links.length === 0) return [];

    const otherIds = links.map((l) =>
      l.fromId === entryId ? l.toId : l.fromId,
    );
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(inArray(memoryEntries.id, otherIds));

    const entryMap = new Map(
      rows.map((e) => [
        e.id,
        wrapLightEntry(e as Omit<MemoryEntry, "embedding">),
      ]),
    );

    return links
      .map((link) => {
        const otherId = link.fromId === entryId ? link.toId : link.fromId;
        const entry = entryMap.get(otherId);
        if (!entry) return null;
        return {
          link,
          entry,
          direction: (link.fromId === entryId ? "to" : "from") as "from" | "to",
        };
      })
      .filter(Boolean) as Array<{
      link: MemoryLink;
      entry: MemoryEntry;
      direction: "from" | "to";
    }>;
  }

  async getEntry(
    id: number,
  ): Promise<(MemoryEntry & { links: MemoryLink[] }) | null> {
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          eq(memoryEntries.id, id),
        ),
      )
      .limit(1);

    if (rows.length === 0) return null;

    const entry = wrapLightEntry(rows[0] as Omit<MemoryEntry, "embedding">);
    const links = await this.getLinks(id);
    return { ...entry, links };
  }

  async getMany(ids: number[]): Promise<MemoryEntry[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, ids),
        ),
      );
    return rows.map((r) => wrapLightEntry(r as Omit<MemoryEntry, "embedding">));
  }

  async findDuplicateClusters(options: {
    layer?: string;
    source?: string;
    createdAfter?: string;
    createdBefore?: string;
    limit?: number;
  }): Promise<DuplicateCluster[]> {
    const limit = options.limit || 20;
    const principal = getCurrentPrincipalOrSystem();
    const visibilityCondition = principal.actorType === "system"
      ? sql`TRUE`
      : sql`(memory_entries.scope = 'global' OR memory_entries.owner_user_id = ${principal.userId} OR memory_entries.account_id = ${principal.accountId})`;
    const aVisibilityCondition = principal.actorType === "system"
      ? sql`TRUE`
      : sql`(a.scope = 'global' OR a.owner_user_id = ${principal.userId} OR a.account_id = ${principal.accountId})`;

    interface Edge {
      a: number;
      b: number;
      embeddingSim: number;
      titleSim: number;
      contentSim: number;
      exact: boolean;
    }

    const edges: Edge[] = [];
    const allIds = new Set<number>();

    // Hash-based exact matches
    const hashConditions: ReturnType<typeof sql>[] = [
      sql`content_hash IS NOT NULL`,
      visibilityCondition,
    ];
    if (options.layer) hashConditions.push(sql`layer = ${options.layer}`);
    if (options.source) hashConditions.push(sql`source = ${options.source}`);
    if (options.createdAfter)
      hashConditions.push(
        sql`created_at >= ${options.createdAfter}::timestamptz`,
      );
    if (options.createdBefore)
      hashConditions.push(
        sql`created_at < ${options.createdBefore}::timestamptz`,
      );

    const hashGroups = await db.execute(sql`
      SELECT content_hash, array_agg(id ORDER BY created_at) AS ids
      FROM memory_entries
      WHERE ${sql.join(hashConditions, sql` AND `)}
      GROUP BY content_hash
      HAVING COUNT(*) > 1
    `);

    for (const row of hashGroups.rows as Array<{
      content_hash: string;
      ids: number[];
    }>) {
      const ids = row.ids;
      for (const id of ids) allIds.add(id);
      // Connect all members of a hash group as a chain (sufficient for union-find)
      for (let i = 1; i < ids.length; i++) {
        edges.push({
          a: ids[i - 1],
          b: ids[i],
          embeddingSim: 1.0,
          titleSim: 1.0,
          contentSim: 1.0,
          exact: true,
        });
      }
    }

    // Embedding-based similarity edges (≥ 0.85)
    const embConditions: ReturnType<typeof sql>[] = [
      sql`a.embedding IS NOT NULL`,
      aVisibilityCondition,
    ];
    if (options.layer) embConditions.push(sql`a.layer = ${options.layer}`);
    if (options.source) embConditions.push(sql`a.source = ${options.source}`);
    if (options.createdAfter)
      embConditions.push(
        sql`a.created_at >= ${options.createdAfter}::timestamptz`,
      );
    if (options.createdBefore)
      embConditions.push(
        sql`a.created_at < ${options.createdBefore}::timestamptz`,
      );

    // Pull more candidate edges than `limit` so transitive merging works for large clusters
    const edgeFetchLimit = Math.max(limit * 20, 500);

    const embResults = await db.execute(sql`
      SELECT
        a.id AS a_id, a.title AS a_title, a.layer AS a_layer, char_length(a.content) AS a_len,
        a.content AS a_content,
        b.id AS b_id, b.title AS b_title, b.layer AS b_layer, char_length(b.content) AS b_len,
        b.content AS b_content,
        1 - (a.embedding <=> b.embedding) AS similarity
      FROM memory_entries a
      CROSS JOIN LATERAL (
        SELECT b2.id, b2.title, b2.layer, b2.content, b2.embedding FROM memory_entries b2
        WHERE b2.id > a.id
          AND b2.embedding IS NOT NULL
          ${principal.actorType === "system" ? sql`` : sql`AND (b2.scope = 'global' OR b2.owner_user_id = ${principal.userId} OR b2.account_id = ${principal.accountId})`}
          ${options.layer ? sql`AND b2.layer = ${options.layer}` : sql``}
          ${options.source ? sql`AND b2.source = ${options.source}` : sql``}
          ${options.createdAfter ? sql`AND b2.created_at >= ${options.createdAfter}::timestamptz` : sql``}
          ${options.createdBefore ? sql`AND b2.created_at < ${options.createdBefore}::timestamptz` : sql``}
          AND 1 - (a.embedding <=> b2.embedding) >= 0.85
        ORDER BY a.embedding <=> b2.embedding
        LIMIT 10
      ) b
      WHERE ${sql.join(embConditions, sql` AND `)}
      ORDER BY similarity DESC
      LIMIT ${edgeFetchLimit}
    `);

    interface EmbRow {
      a_id: number;
      a_title: string | null;
      a_layer: string;
      a_len: number;
      a_content: string | null;
      b_id: number;
      b_title: string | null;
      b_layer: string;
      b_len: number;
      b_content: string | null;
      similarity: string | number;
    }

    const memberMeta = new Map<
      number,
      { title: string | null; layer: string; contentLength: number }
    >();

    for (const row of embResults.rows as unknown as EmbRow[]) {
      const embSim = parseFloat(String(row.similarity));
      const titleSim = computeStringOverlap(
        row.a_title || "",
        row.b_title || "",
      );
      const contentSim = computeStringOverlap(
        (row.a_content || "").slice(0, 500),
        (row.b_content || "").slice(0, 500),
      );
      edges.push({
        a: row.a_id,
        b: row.b_id,
        embeddingSim: embSim,
        titleSim,
        contentSim,
        exact: false,
      });
      allIds.add(row.a_id);
      allIds.add(row.b_id);
      memberMeta.set(row.a_id, {
        title: row.a_title,
        layer: row.a_layer,
        contentLength: row.a_len,
      });
      memberMeta.set(row.b_id, {
        title: row.b_title,
        layer: row.b_layer,
        contentLength: row.b_len,
      });
    }

    if (allIds.size === 0) return [];

    // Fetch metadata for any cluster members not already populated (hash-only members)
    const missingIds = Array.from(allIds).filter((id) => !memberMeta.has(id));
    if (missingIds.length > 0) {
      const fetched = await db
        .select(memoryEntryLightColumns)
        .from(memoryEntries)
        .where(inArray(memoryEntries.id, missingIds));
      for (const e of fetched) {
        memberMeta.set(e.id, {
          title: e.title,
          layer: e.layer,
          contentLength: (e.content || "").length,
        });
      }
    }

    return buildDuplicateClustersFromEdges(edges, memberMeta, limit);
  }

  async getLinks(entryId: number, queryTag?: string): Promise<MemoryLink[]> {
    const fromLinks = await db
      .select()
      .from(memoryLinks)
      .where(
        queryTag
          ? and(
              sql`/* ${sql.raw(queryTag)} */ TRUE`,
              eq(memoryLinks.fromId, entryId),
            )
          : eq(memoryLinks.fromId, entryId),
      );

    const toLinks = await db
      .select()
      .from(memoryLinks)
      .where(
        queryTag
          ? and(
              sql`/* ${sql.raw(queryTag)} */ TRUE`,
              eq(memoryLinks.toId, entryId),
            )
          : eq(memoryLinks.toId, entryId),
      );

    const seen = new Set<number>();
    const allLinks: MemoryLink[] = [];
    const visibleIds = new Set<number>();
    const candidateIds = new Set<number>([entryId]);
    for (const link of [...fromLinks, ...toLinks]) {
      candidateIds.add(link.fromId);
      candidateIds.add(link.toId);
      if (!seen.has(link.id)) {
        seen.add(link.id);
        allLinks.push(link);
      }
    }
    if (allLinks.length === 0) return [];

    const visibleEntries = await db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, Array.from(candidateIds)),
        ),
      );
    for (const entry of visibleEntries) visibleIds.add(entry.id);
    if (!visibleIds.has(entryId)) return [];

    return allLinks.filter(
      (link) => visibleIds.has(link.fromId) && visibleIds.has(link.toId),
    );
  }

  async createLink(
    fromId: number,
    toId: number,
    relationship: string,
    strength = 0.5,
    relationshipType: string = "related",
  ): Promise<MemoryLink> {
    const visibleEndpoints = await db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, [fromId, toId]),
        ),
      );
    if (visibleEndpoints.length !== 2) {
      throw new Error("Cannot link memory entries outside visible scope");
    }

    const validType = (relationshipTypes as readonly string[]).includes(
      relationshipType,
    )
      ? relationshipType
      : "related";
    const [link] = await db
      .insert(memoryLinks)
      .values({
        fromId,
        toId,
        relationship,
        strength,
        relationshipType: validType,
      })
      .returning();

    const sourceRef = classifyMemoryLinkSourceRef(link);
    if (sourceRef) {
      try {
        await this.addSourceRef(sourceRef);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to mirror memory link #${link.id} as memory source ref: ${message}`,
        );
      }
    }

    this.recomputeNeighborhoodsAsync([fromId, toId], "createLink");
    return link;
  }

  async deleteLink(id: number): Promise<void> {
    const [link] = await db
      .select()
      .from(memoryLinks)
      .where(eq(memoryLinks.id, id))
      .limit(1);
    if (!link) return;

    const visibleEndpoints = await db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, [link.fromId, link.toId]),
        ),
      );
    if (visibleEndpoints.length !== 2) return;

    await db.delete(memoryLinks).where(eq(memoryLinks.id, id));
    this.recomputeNeighborhoodsAsync([link.fromId, link.toId], "deleteLink");
  }

  private async transferLinksWithExecutor(
    executor: DbExecutor,
    fromId: number,
    toId: number,
  ): Promise<number> {
    const existingPairs = new Set<string>();
    let offset = 0;
    let existingBatch: { fromId: number; toId: number }[];
    do {
      existingBatch = await executor
        .select({ fromId: memoryLinks.fromId, toId: memoryLinks.toId })
        .from(memoryLinks)
        .where(or(eq(memoryLinks.fromId, toId), eq(memoryLinks.toId, toId)))
        .limit(LINK_QUERY_BATCH)
        .offset(offset);
      for (const l of existingBatch) existingPairs.add(`${l.fromId}-${l.toId}`);
      offset += existingBatch.length;
    } while (existingBatch.length === LINK_QUERY_BATCH);

    let transferred = 0;
    let deleted = 0;

    let batch: any[];
    do {
      batch = await executor
        .select()
        .from(memoryLinks)
        .where(eq(memoryLinks.fromId, fromId))
        .limit(LINK_QUERY_BATCH);
      for (const link of batch) {
        const newTo = link.toId === fromId ? toId : link.toId;
        if (toId === newTo) {
          await executor.delete(memoryLinks).where(eq(memoryLinks.id, link.id));
          deleted++;
          continue;
        }
        if (existingPairs.has(`${toId}-${newTo}`)) {
          await executor.delete(memoryLinks).where(eq(memoryLinks.id, link.id));
          deleted++;
        } else {
          await executor
            .update(memoryLinks)
            .set({ fromId: toId })
            .where(eq(memoryLinks.id, link.id));
          existingPairs.add(`${toId}-${newTo}`);
          transferred++;
        }
      }
    } while (batch.length === LINK_QUERY_BATCH);

    do {
      batch = await executor
        .select()
        .from(memoryLinks)
        .where(eq(memoryLinks.toId, fromId))
        .limit(LINK_QUERY_BATCH);
      for (const link of batch) {
        const newFrom = link.fromId === fromId ? toId : link.fromId;
        if (newFrom === toId) {
          await executor.delete(memoryLinks).where(eq(memoryLinks.id, link.id));
          deleted++;
          continue;
        }
        if (existingPairs.has(`${newFrom}-${toId}`)) {
          await executor.delete(memoryLinks).where(eq(memoryLinks.id, link.id));
          deleted++;
        } else {
          await executor
            .update(memoryLinks)
            .set({ toId })
            .where(eq(memoryLinks.id, link.id));
          existingPairs.add(`${newFrom}-${toId}`);
          transferred++;
        }
      }
    } while (batch.length === LINK_QUERY_BATCH);

    if (transferred > 0 || deleted > 0) {
      log.debug(
        `transferLinks #${fromId} → #${toId}: ${transferred} transferred, ${deleted} removed (self/duplicate)`,
      );
    }
    return transferred;
  }

  async findDuplicateInLayer(
    layer: MemoryLayer,
    source: MemorySource,
    sourceId: string,
    excludeId: number,
  ): Promise<MemoryEntry | null> {
    const [match] = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.layer, layer),
          eq(memoryEntries.source, source),
          eq(memoryEntries.sourceId, sourceId),
          ne(memoryEntries.id, excludeId),
        ),
      )
      .limit(1);
    return match
      ? wrapLightEntry(match as Omit<MemoryEntry, "embedding">)
      : null;
  }

  async deleteEntry(
    id: number,
    opts?: { awaitCleanup?: boolean },
  ): Promise<{
    deleted: boolean;
    linksRemoved: number;
    peerCleanupScheduled: number;
    cleanupErrors?: string[];
  }> {
    const peerIds = new Set<number>();
    const existingLinks = await db
      .select()
      .from(memoryLinks)
      .where(or(eq(memoryLinks.fromId, id), eq(memoryLinks.toId, id)));
    for (const link of existingLinks) {
      if (link.fromId !== id) peerIds.add(link.fromId);
      if (link.toId !== id) peerIds.add(link.toId);
    }

    await this.appendEvent(id, "deleted");

    const deletedRows = await db
      .delete(memoryEntries)
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          eq(memoryEntries.id, id),
        ),
      )
      .returning({ id: memoryEntries.id });
    const deleted = deletedRows.length > 0;

    const peerArray = Array.from(peerIds);
    let cleanupErrors: string[] | undefined;

    if (peerArray.length > 0) {
      if (opts?.awaitCleanup) {
        const results = await Promise.allSettled(
          peerArray.map((peerId) => this.recomputeNeighborhood(peerId)),
        );
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) =>
            r.reason instanceof Error ? r.reason.message : String(r.reason),
          );
        if (errors.length > 0) cleanupErrors = errors;
      } else {
        this.recomputeNeighborhoodsAsync(peerArray, "deleteEntry");
      }
    }

    return {
      deleted,
      linksRemoved: existingLinks.length,
      peerCleanupScheduled: peerArray.length,
      cleanupErrors,
    };
  }

  async updateEntry(
    id: number,
    updates: Partial<
      Pick<
        MemoryEntry,
        | "content"
        | "summary"
        | "oneLiner"
        | "metadata"
        | "tags"
        | "layer"
        | "integrationStage"
        | "graphed"
      >
    >,
  ): Promise<MemoryEntry | null> {
    const result = await db
      .update(memoryEntries)
      .set({
        ...updates,
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      })
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          eq(memoryEntries.id, id),
        ),
      )
      .returning();

    if (result.length > 0) {
      await this.appendEvent(id, "updated", { fields: Object.keys(updates) });
    }
    return result.length > 0 ? result[0] : null;
  }

  async promoteToMid(
    sourceId: number,
    title: string,
    summary: string,
    tags: string[],
  ): Promise<MemoryEntry> {
    let postCommitRecomputeIds: number[] | null = null;

    const result = await db.transaction(async (tx) => {
      const [sourceRaw] = await tx
        .select(memoryEntryLightColumns)
        .from(memoryEntries)
        .where(eq(memoryEntries.id, sourceId))
        .limit(1);
      if (!sourceRaw) throw new Error(`Source entry #${sourceId} not found`);
      const source = wrapLightEntry(
        sourceRaw as Omit<MemoryEntry, "embedding">,
      );

      if (source.source && source.sourceId) {
        const [existingMidRaw] = await tx
          .select(memoryEntryLightColumns)
          .from(memoryEntries)
          .where(
            and(
              eq(memoryEntries.layer, "mid"),
              eq(memoryEntries.source, source.source),
              eq(memoryEntries.sourceId, source.sourceId),
              ne(memoryEntries.id, sourceId),
            ),
          )
          .limit(1);
        const existingMid = existingMidRaw
          ? wrapLightEntry(existingMidRaw as Omit<MemoryEntry, "embedding">)
          : null;

        if (existingMid) {
          const peerLinks = await tx
            .select()
            .from(memoryLinks)
            .where(
              or(
                eq(memoryLinks.fromId, sourceId),
                eq(memoryLinks.toId, sourceId),
              ),
            );
          const affectedPeerIds = new Set<number>();
          for (const link of peerLinks) {
            if (link.fromId !== sourceId) affectedPeerIds.add(link.fromId);
            if (link.toId !== sourceId) affectedPeerIds.add(link.toId);
          }
          affectedPeerIds.add(existingMid.id);
          postCommitRecomputeIds = Array.from(affectedPeerIds);

          const linksTransferred = await this.transferLinksWithExecutor(
            tx,
            sourceId,
            existingMid.id,
          );
          await tx.delete(memoryEntries).where(eq(memoryEntries.id, sourceId));
          await tx.insert(memoryTransitions).values({
            entryId: existingMid.id,
            fromLayer: "short",
            toLayer: "mid",
            reason: `Duplicate resolved: deleted short #${sourceId}, kept existing mid #${existingMid.id}: ${title}`,
          });
          await insertMemoryEvent(tx, {
            entryId: existingMid.id,
            eventType: "duplicate_resolved",
            details: {
              fromLayer: "short",
              toLayer: "mid",
              deletedId: sourceId,
              linksTransferred,
            },
          });

          return existingMid;
        }
      }

      const entryMeta = (source.metadata as Record<string, unknown>) || {};
      const { recalledAt, previousLayer, ...cleanMeta } = entryMeta;
      const isRecalled = !!recalledAt;

      const [updated] = await tx
        .update(memoryEntries)
        .set({
          layer: "mid",
          integrationStage: MEMORY_INTEGRATION_STAGE.INTEGRATED,
          title,
          summary,
          tags,
          contentHash: computeContentHash(source.content),
          metadata: isRecalled
            ? { ...cleanMeta, reconsolidatedAt: new Date().toISOString() }
            : cleanMeta,
          processedAt: new Date(),
        })
        .where(eq(memoryEntries.id, sourceId))
        .returning();

      await tx.insert(memoryTransitions).values({
        entryId: sourceId,
        fromLayer: "short",
        toLayer: "mid",
        reason: `Promoted #${sourceId}: ${title}`,
      });

      await insertMemoryEvent(tx, {
        entryId: sourceId,
        eventType: "promoted",
        details: { fromLayer: "short", toLayer: "mid", fromStage: MEMORY_INTEGRATION_STAGE.RAW, toStage: MEMORY_INTEGRATION_STAGE.INTEGRATED },
      });

      return updated;
    });

    if (result.source && result.sourceId) {
      await this.addLegacySourceRef(
        result.id,
        result.source as MemorySource,
        result.sourceId,
        "Preserved across short→mid memory consolidation",
      );
    }

    if (postCommitRecomputeIds) {
      this.recomputeNeighborhoodsAsync(
        postCommitRecomputeIds,
        "promoteToMid:merge",
      );
    }

    return result;
  }

  async promoteToLong(
    sourceId: number,
    title: string,
    summary: string,
    tags: string[],
  ): Promise<MemoryEntry> {
    let postCommitRecomputeIds: number[] | null = null;

    const result = await db.transaction(async (tx) => {
      const [sourceRaw] = await tx
        .select(memoryEntryLightColumns)
        .from(memoryEntries)
        .where(eq(memoryEntries.id, sourceId))
        .limit(1);
      if (!sourceRaw) throw new Error(`Source entry #${sourceId} not found`);
      const source = wrapLightEntry(
        sourceRaw as Omit<MemoryEntry, "embedding">,
      );

      if (source.source && source.sourceId) {
        const [existingLongRaw] = await tx
          .select(memoryEntryLightColumns)
          .from(memoryEntries)
          .where(
            and(
              eq(memoryEntries.layer, "long"),
              eq(memoryEntries.source, source.source),
              eq(memoryEntries.sourceId, source.sourceId),
              ne(memoryEntries.id, sourceId),
            ),
          )
          .limit(1);
        const existingLong = existingLongRaw
          ? wrapLightEntry(existingLongRaw as Omit<MemoryEntry, "embedding">)
          : null;

        if (existingLong) {
          const peerLinks = await tx
            .select()
            .from(memoryLinks)
            .where(
              or(
                eq(memoryLinks.fromId, sourceId),
                eq(memoryLinks.toId, sourceId),
              ),
            );
          const affectedPeerIds = new Set<number>();
          for (const link of peerLinks) {
            if (link.fromId !== sourceId) affectedPeerIds.add(link.fromId);
            if (link.toId !== sourceId) affectedPeerIds.add(link.toId);
          }
          affectedPeerIds.add(existingLong.id);
          postCommitRecomputeIds = Array.from(affectedPeerIds);

          const linksTransferred = await this.transferLinksWithExecutor(
            tx,
            sourceId,
            existingLong.id,
          );
          await tx.delete(memoryEntries).where(eq(memoryEntries.id, sourceId));
          await tx.insert(memoryTransitions).values({
            entryId: existingLong.id,
            fromLayer: "mid",
            toLayer: "long",
            reason: `Duplicate resolved: deleted mid #${sourceId}, kept existing long #${existingLong.id}: ${title}`,
          });
          await insertMemoryEvent(tx, {
            entryId: existingLong.id,
            eventType: "duplicate_resolved",
            details: {
              fromLayer: "mid",
              toLayer: "long",
              deletedId: sourceId,
              linksTransferred,
            },
          });

          return existingLong;
        }
      }

      const entryMeta = (source.metadata as Record<string, unknown>) || {};
      const { recalledAt, previousLayer, ...cleanMeta } = entryMeta;
      const isRecalled = !!recalledAt;

      const [updated] = await tx
        .update(memoryEntries)
        .set({
          layer: "long",
          integrationStage: MEMORY_INTEGRATION_STAGE.CANONICAL,
          title,
          summary,
          tags,
          contentHash: computeContentHash(source.content),
          metadata: isRecalled
            ? {
                ...cleanMeta,
                decay_score: 1.0,
                reconsolidatedAt: new Date().toISOString(),
              }
            : { ...cleanMeta, decay_score: 1.0 },
          processedAt: new Date(),
        })
        .where(eq(memoryEntries.id, sourceId))
        .returning();

      await tx.insert(memoryTransitions).values({
        entryId: sourceId,
        fromLayer: "mid",
        toLayer: "long",
        reason: `Promoted #${sourceId}: ${title}`,
      });

      await insertMemoryEvent(tx, {
        entryId: sourceId,
        eventType: "promoted",
        details: { fromLayer: "mid", toLayer: "long", fromStage: MEMORY_INTEGRATION_STAGE.INTEGRATED, toStage: MEMORY_INTEGRATION_STAGE.CANONICAL },
      });

      return updated;
    });

    if (result.source && result.sourceId) {
      await this.addLegacySourceRef(
        result.id,
        result.source as MemorySource,
        result.sourceId,
        "Preserved across mid→long memory integration",
      );
    }

    if (postCommitRecomputeIds) {
      this.recomputeNeighborhoodsAsync(
        postCommitRecomputeIds,
        "promoteToLong:merge",
      );
    }

    return result;
  }

  async getLinkedEntries(entryId: number): Promise<MemoryEntry[]> {
    const fromLinks = await db
      .select({ id: memoryLinks.fromId })
      .from(memoryLinks)
      .where(eq(memoryLinks.toId, entryId));

    const toLinks = await db
      .select({ id: memoryLinks.toId })
      .from(memoryLinks)
      .where(eq(memoryLinks.fromId, entryId));

    const linkedIds = new Set([
      ...fromLinks.map((l) => l.id),
      ...toLinks.map((l) => l.id),
    ]);
    linkedIds.delete(entryId);

    if (linkedIds.size === 0) return [];

    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, Array.from(linkedIds)),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt));
    return rows.map((r) => wrapLightEntry(r as Omit<MemoryEntry, "embedding">));
  }

  async getStats(options: { archiveMode?: boolean } = {}): Promise<{
    short: number;
    mid: number;
    long: number;
    links: number;
    shortGraphed: number;
    midGraphed: number;
    longGraphed: number;
    shortUngraphed: number;
    midUngraphed: number;
    longUngraphed: number;
  }> {
    const principal = getCurrentPrincipalOrSystem();
    const conditions: ReturnType<typeof sql>[] = [];
    if (principal.actorType !== "system") {
      conditions.push(sql`(scope = 'global' OR owner_user_id = ${principal.userId} OR account_id = ${principal.accountId})`);
    }
    if (!options.archiveMode) {
      conditions.push(memoryKnowledgeEligibleSql);
    }
    const visibilityCondition = conditions.length > 0
      ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
      : sql``;
    const linkConditions: ReturnType<typeof sql>[] = [];
    if (principal.actorType !== "system") {
      linkConditions.push(sql`(from_entry.scope = 'global' OR from_entry.owner_user_id = ${principal.userId} OR from_entry.account_id = ${principal.accountId})`);
      linkConditions.push(sql`(to_entry.scope = 'global' OR to_entry.owner_user_id = ${principal.userId} OR to_entry.account_id = ${principal.accountId})`);
    }
    if (!options.archiveMode) {
      linkConditions.push(sql`(from_entry.source != 'chat' OR from_entry.metadata->>'mirrorKind' = 'session_summary')`);
      linkConditions.push(sql`(from_entry.source != 'voice_session' OR from_entry.metadata->>'mirrorKind' = 'session_summary')`);
      linkConditions.push(sql`(from_entry.source != 'conversation' OR (COALESCE(from_entry.source_id, '') NOT LIKE 'exchange-%' AND NOT (COALESCE(from_entry.tags, ARRAY[]::text[]) @> ARRAY['exchange']::text[])))`);
      linkConditions.push(sql`(to_entry.source != 'chat' OR to_entry.metadata->>'mirrorKind' = 'session_summary')`);
      linkConditions.push(sql`(to_entry.source != 'voice_session' OR to_entry.metadata->>'mirrorKind' = 'session_summary')`);
      linkConditions.push(sql`(to_entry.source != 'conversation' OR (COALESCE(to_entry.source_id, '') NOT LIKE 'exchange-%' AND NOT (COALESCE(to_entry.tags, ARRAY[]::text[]) @> ARRAY['exchange']::text[])))`);
    }
    const linkVisibilityCondition = linkConditions.length > 0
      ? sql`WHERE ${sql.join(linkConditions, sql` AND `)}`
      : sql``;

    const layerCounts = await db.execute(sql`
      SELECT layer, graphed, COUNT(*)::int AS count
      FROM memory_entries
      ${visibilityCondition}
      GROUP BY layer, graphed
    `);

    const linkCount = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM memory_links
      INNER JOIN memory_entries from_entry ON from_entry.id = memory_links.from_id
      INNER JOIN memory_entries to_entry ON to_entry.id = memory_links.to_id
      ${linkVisibilityCondition}
    `);

    const stats = {
      short: 0,
      mid: 0,
      long: 0,
      links: 0,
      shortGraphed: 0,
      midGraphed: 0,
      longGraphed: 0,
      shortUngraphed: 0,
      midUngraphed: 0,
      longUngraphed: 0,
    };
    for (const row of layerCounts.rows as Array<{
      layer: string;
      graphed: boolean;
      count: number;
    }>) {
      if (row.layer !== "short" && row.layer !== "mid" && row.layer !== "long")
        continue;
      stats[row.layer] += row.count;
      if (row.graphed) {
        if (row.layer === "short") stats.shortGraphed += row.count;
        else if (row.layer === "mid") stats.midGraphed += row.count;
        else stats.longGraphed += row.count;
      } else {
        if (row.layer === "short") stats.shortUngraphed += row.count;
        else if (row.layer === "mid") stats.midUngraphed += row.count;
        else stats.longUngraphed += row.count;
      }
    }
    stats.links = (linkCount.rows[0] as { count: number })?.count ?? 0;

    return stats;
  }

  async countEntries(
    options: {
      layer?: string;
      source?: string;
      createdAfter?: string;
      createdBefore?: string;
      archiveMode?: boolean;
    } = {},
  ): Promise<{
    total: number;
    byLayer: { short: number; mid: number; long: number };
    graphed: number;
    ungraphed: number;
  }> {
    const conditions: ReturnType<typeof sql>[] = [];
    if (options.layer) conditions.push(sql`layer = ${options.layer}`);
    if (options.source) conditions.push(sql`source = ${options.source}`);
    if (options.createdAfter)
      conditions.push(sql`created_at >= ${options.createdAfter}::timestamptz`);
    if (options.createdBefore)
      conditions.push(sql`created_at < ${options.createdBefore}::timestamptz`);
    if (!options.archiveMode) conditions.push(memoryKnowledgeEligibleSql);

    const whereClause =
      conditions.length > 0
        ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
        : sql``;

    const result = await db.execute(sql`
      SELECT layer, graphed, COUNT(*)::int AS count
      FROM memory_entries
      ${whereClause}
      GROUP BY layer, graphed
    `);

    const out = {
      total: 0,
      byLayer: { short: 0, mid: 0, long: 0 },
      graphed: 0,
      ungraphed: 0,
    };
    for (const row of result.rows as Array<{
      layer: string;
      graphed: boolean;
      count: number;
    }>) {
      out.total += row.count;
      if (row.graphed) out.graphed += row.count;
      else out.ungraphed += row.count;
      if (
        row.layer === "short" ||
        row.layer === "mid" ||
        row.layer === "long"
      ) {
        out.byLayer[row.layer] += row.count;
      }
    }
    return out;
  }

  async bulkDeleteEntries(ids: number[]): Promise<{
    deletedCount: number;
    requestedCount: number;
    notFoundIds: number[];
    linksRemoved: number;
    peerCleanupScheduled: number;
    cleanupErrors?: string[];
  }> {
    const requestedCount = ids.length;
    const uniqueIds = Array.from(
      new Set(ids.filter((id) => Number.isFinite(id) && Number.isInteger(id))),
    );
    if (uniqueIds.length === 0) {
      return {
        deletedCount: 0,
        requestedCount,
        notFoundIds: [],
        linksRemoved: 0,
        peerCleanupScheduled: 0,
      };
    }

    const idSet = new Set(uniqueIds);

    const existingLinks = await db
      .select()
      .from(memoryLinks)
      .where(
        or(
          inArray(memoryLinks.fromId, uniqueIds),
          inArray(memoryLinks.toId, uniqueIds),
        ),
      );

    const peerIds = new Set<number>();
    for (const link of existingLinks) {
      if (!idSet.has(link.fromId)) peerIds.add(link.fromId);
      if (!idSet.has(link.toId)) peerIds.add(link.toId);
    }

    for (const id of uniqueIds) {
      try {
        await this.appendEvent(id, "deleted");
      } catch {
        /* best-effort */
      }
    }

    const deletedRows = await db
      .delete(memoryEntries)
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, uniqueIds),
        ),
      )
      .returning({ id: memoryEntries.id });

    const deletedSet = new Set(deletedRows.map((r) => r.id));
    const notFoundIds = uniqueIds.filter((id) => !deletedSet.has(id));

    const peerArray = Array.from(peerIds);
    let cleanupErrors: string[] | undefined;

    if (peerArray.length > 0) {
      const results = await Promise.allSettled(
        peerArray.map((peerId) => this.recomputeNeighborhood(peerId)),
      );
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) =>
          r.reason instanceof Error ? r.reason.message : String(r.reason),
        );
      if (errors.length > 0) cleanupErrors = errors;
    }

    return {
      deletedCount: deletedRows.length,
      requestedCount,
      notFoundIds,
      linksRemoved: existingLinks.length,
      peerCleanupScheduled: peerArray.length,
      cleanupErrors,
    };
  }

  private retentionPredicate(request: RetentionPurgeRequest) {
    const clauses = [lt(memoryEntries.createdAt, request.endDate)];
    if (request.startDate) clauses.push(gte(memoryEntries.createdAt, request.startDate));
    if (request.layers?.length) clauses.push(inArray(memoryEntries.layer, request.layers));
    if (request.sources?.length) clauses.push(inArray(memoryEntries.source, request.sources));
    return combineWithWritableScope(
      getCurrentPrincipalOrSystem(),
      memoryScopeColumns,
      and(...clauses),
    );
  }

  private retentionQueryHash(request: RetentionPurgeRequest): string {
    return createHash("sha256")
      .update(JSON.stringify({
        startDate: request.startDate?.toISOString() ?? null,
        endDate: request.endDate.toISOString(),
        layers: [...(request.layers || [])].sort(),
        sources: [...(request.sources || [])].sort(),
        protectionMode: request.protectionMode || "standard",
      }))
      .digest("hex");
  }

  async dryRunRetentionPurge(request: RetentionPurgeRequest, batchSize = 500): Promise<RetentionPurgeDryRun> {
    const predicate = this.retentionPredicate(request);
    const candidateRows = await db
      .select({ id: memoryEntries.id, layer: memoryEntries.layer, source: memoryEntries.source, title: memoryEntries.title, createdAt: memoryEntries.createdAt, pinned: memoryEntries.pinned, metadata: memoryEntries.metadata })
      .from(memoryEntries)
      .where(predicate)
      .orderBy(asc(memoryEntries.createdAt));

    const protectionMode = request.protectionMode || "standard";
    const candidates = candidateRows.filter((row) => {
      if (protectionMode === "exact") return true;
      if (row.pinned) return false;
      const meta = (row.metadata || {}) as Record<string, unknown>;
      if (meta.deletionLocked === true || meta.retentionProtected === true) return false;
      return true;
    });
    const skipped = candidateRows.length - candidates.length;
    const ids = candidates.map((row) => row.id);
    const idSet = new Set(ids);

    let affectedLinks = 0;
    let survivingPeersToRecompute = 0;
    const peerIds = new Set<number>();
    const linkCounts = new Map<number, number>();
    if (ids.length > 0) {
      const links = await db.select().from(memoryLinks).where(or(inArray(memoryLinks.fromId, ids), inArray(memoryLinks.toId, ids)));
      affectedLinks = links.length;
      for (const link of links) {
        linkCounts.set(link.fromId, (linkCounts.get(link.fromId) || 0) + 1);
        linkCounts.set(link.toId, (linkCounts.get(link.toId) || 0) + 1);
        if (!idSet.has(link.fromId)) peerIds.add(link.fromId);
        if (!idSet.has(link.toId)) peerIds.add(link.toId);
      }
      survivingPeersToRecompute = peerIds.size;
    }

    let affectedEntityLinks = 0;
    if (ids.length > 0) {
      const [row] = await db.select({ count: count() }).from(memoryEntityLinks).where(inArray(memoryEntityLinks.memoryId, ids));
      affectedEntityLinks = Number(row?.count || 0);
    }

    const byLayer: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    for (const row of candidates) {
      byLayer[row.layer] = (byLayer[row.layer] || 0) + 1;
      bySource[row.source] = (bySource[row.source] || 0) + 1;
    }
    const summarize = (row: typeof candidateRows[number]) => ({ id: row.id, title: row.title, layer: row.layer, source: row.source, createdAt: row.createdAt });
    const highestLinked = [...candidates]
      .map((row) => ({ ...summarize(row), linkCount: linkCounts.get(row.id) || 0 }))
      .sort((a, b) => b.linkCount - a.linkCount)
      .slice(0, 10);

    return {
      queryHash: this.retentionQueryHash(request),
      candidates: candidates.length,
      skipped,
      byLayer,
      bySource,
      affectedLinks,
      affectedEntityLinks,
      survivingPeersToRecompute,
      estimatedBatches: Math.ceil(candidates.length / batchSize),
      samples: { oldest: candidates.slice(0, 10).map(summarize), newest: candidates.slice(-10).reverse().map(summarize), highestLinked },
      skippedReasons: skipped ? [{ reason: "Pinned or retention-protected", count: skipped }] : [],
      warnings: candidates.length > 0 ? ["Archive before execute is required.", "Execution permanently deletes selected memories and cascaded SQL rows.", "Surviving graph neighborhoods will be recomputed after deletion."] : [],
    };
  }

  async buildRetentionPurgeArchive(request: RetentionPurgeRequest): Promise<RetentionPurgeArchive> {
    const dryRun = await this.dryRunRetentionPurge(request);
    const predicate = this.retentionPredicate(request);
    const rows = await db.select().from(memoryEntries).where(predicate).orderBy(asc(memoryEntries.createdAt));
    const protectedIds = new Set<number>();
    if ((request.protectionMode || "standard") !== "exact") {
      for (const row of rows) {
        const meta = (row.metadata || {}) as Record<string, unknown>;
        if (row.pinned || meta.deletionLocked === true || meta.retentionProtected === true) protectedIds.add(row.id);
      }
    }
    const ids = rows.map((row) => row.id).filter((id) => !protectedIds.has(id));
    const [links, sourceRefs, entityLinks, transitions, blocks, events] = ids.length === 0
      ? [[], [], [], [], [], []]
      : await Promise.all([
          db.select().from(memoryLinks).where(or(inArray(memoryLinks.fromId, ids), inArray(memoryLinks.toId, ids))),
          db.select().from(memorySourceRefs).where(inArray(memorySourceRefs.memoryId, ids)),
          db.select().from(memoryEntityLinks).where(inArray(memoryEntityLinks.memoryId, ids)),
          db.select().from(memoryTransitions).where(inArray(memoryTransitions.entryId, ids)),
          db.select().from(memoryContentBlocks).where(inArray(memoryContentBlocks.entryId, ids)),
          db.select().from(memoryEvents).where(inArray(memoryEvents.entryId, ids)),
        ]);
    return {
      ...dryRun,
      createdAt: new Date().toISOString(),
      request: {
        startDate: request.startDate?.toISOString(),
        endDate: request.endDate.toISOString(),
        layers: request.layers,
        sources: request.sources,
        protectionMode: request.protectionMode || "standard",
      },
      memoryEntries: rows.filter((row) => !protectedIds.has(row.id)),
      memoryLinks: links,
      memorySources: sourceRefs,
      memoryEntityLinks: entityLinks,
      memoryTransitions: transitions,
      memoryContentBlocks: blocks,
      memoryEvents: events,
    };
  }

  async executeRetentionPurge(request: RetentionPurgeRequest, batchSize = 500): Promise<{ deletedCount: number; requestedCount: number; batches: number; linksRemoved: number; peerCleanupScheduled: number; cleanupErrors?: string[] }> {
    const archive = await this.buildRetentionPurgeArchive(request);
    const ids = (archive.memoryEntries as Array<{ id: number }>).map((entry) => entry.id);
    let deletedCount = 0;
    let requestedCount = 0;
    let linksRemoved = 0;
    let peerCleanupScheduled = 0;
    const cleanupErrors: string[] = [];
    for (let index = 0; index < ids.length; index += batchSize) {
      const result = await this.bulkDeleteEntries(ids.slice(index, index + batchSize));
      deletedCount += result.deletedCount;
      requestedCount += result.requestedCount;
      linksRemoved += result.linksRemoved;
      peerCleanupScheduled += result.peerCleanupScheduled;
      if (result.cleanupErrors?.length) cleanupErrors.push(...result.cleanupErrors);
    }
    return { deletedCount, requestedCount, batches: Math.ceil(ids.length / batchSize), linksRemoved, peerCleanupScheduled, cleanupErrors: cleanupErrors.length ? cleanupErrors : undefined };
  }

  async flushLayer(layer: MemoryLayer): Promise<{ deleted: number }> {
    const entries = await db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(eq(memoryEntries.layer, layer));

    if (entries.length === 0) return { deleted: 0 };

    const ids = entries.map((e) => e.id);
    await db
      .delete(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, ids),
        ),
      );
    await db
      .delete(memoryTransitions)
      .where(inArray(memoryTransitions.entryId, ids));

    return { deleted: ids.length };
  }

  async deduplicateMidTerm(): Promise<{ removed: number; remaining: number }> {
    const midEntries = await db
      .select({
        id: memoryEntries.id,
        summary: memoryEntries.summary,
        createdAt: memoryEntries.createdAt,
      })
      .from(memoryEntries)
      .where(eq(memoryEntries.layer, "mid"))
      .orderBy(desc(memoryEntries.createdAt));

    if (midEntries.length === 0) return { removed: 0, remaining: 0 };

    const summaryGroups = new Map<string, typeof midEntries>();
    for (const entry of midEntries) {
      const key = (entry.summary || "").trim();
      if (!key) continue;
      if (!summaryGroups.has(key)) {
        summaryGroups.set(key, []);
      }
      summaryGroups.get(key)!.push(entry);
    }

    const idsToDelete: number[] = [];
    for (const [_summary, entries] of summaryGroups) {
      if (entries.length <= 1) continue;
      entries.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      for (let i = 1; i < entries.length; i++) {
        idsToDelete.push(entries[i].id);
      }
    }

    if (idsToDelete.length > 0) {
      await db
        .delete(memoryEntries)
        .where(inArray(memoryEntries.id, idsToDelete));
      const orphanedLinks = await db
        .select()
        .from(memoryLinks)
        .where(
          sql`${memoryLinks.fromId} IN (${sql.join(
            idsToDelete.map((id) => sql`${id}`),
            sql`, `,
          )}) OR ${memoryLinks.toId} IN (${sql.join(
            idsToDelete.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
      if (orphanedLinks.length > 0) {
        await db.delete(memoryLinks).where(
          inArray(
            memoryLinks.id,
            orphanedLinks.map((l) => l.id),
          ),
        );
      }
      await db
        .delete(memoryTransitions)
        .where(inArray(memoryTransitions.entryId, idsToDelete));
    }

    return {
      removed: idsToDelete.length,
      remaining: midEntries.length - idsToDelete.length,
    };
  }

  async getTransitions(limit = 50): Promise<MemoryTransition[]> {
    return db
      .select()
      .from(memoryTransitions)
      .orderBy(desc(memoryTransitions.transitionedAt))
      .limit(limit);
  }

  async getPalace(linkSource: "links" | "sources" = "links"): Promise<{
    entries: MemoryEntry[];
    links: MemoryLink[];
    linkSource: "links" | "sources";
  }> {
    const rawEntries = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(eq(memoryEntries.graphed, true), eq(memoryEntries.layer, "long")),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt));
    const entries = rawEntries.map((r) =>
      wrapLightEntry(r as Omit<MemoryEntry, "embedding">),
    );

    const visibleIds = new Set(entries.map((entry) => entry.id));
    let links: MemoryLink[];

    if (linkSource === "sources" && entries.length > 0) {
      // Use memory_sources (vNext) where source_type='memory' — both directions
      const sourceRows = await db
        .select()
        .from(memorySourceRefs)
        .where(
          and(
            eq(memorySourceRefs.sourceType, "memory"),
            or(
              inArray(memorySourceRefs.memoryId, Array.from(visibleIds)),
              inArray(sql`CAST(${memorySourceRefs.sourceId} AS integer)`, Array.from(visibleIds)),
            ),
          ),
        );
      // Convert source refs to MemoryLink shape for the graph renderer
      links = sourceRows
        .filter(sr => {
          const targetId = parseInt(sr.sourceId, 10);
          return !isNaN(targetId) && visibleIds.has(sr.memoryId) && visibleIds.has(targetId);
        })
        .map(sr => ({
          id: sr.id,
          fromId: sr.memoryId,
          toId: parseInt(sr.sourceId, 10),
          relationship: sr.relationship,
          strength: sr.strength,
          createdAt: sr.createdAt,
          relationshipType: sr.sourceType,
        }));
    } else if (entries.length > 0) {
      // Legacy: use memory_links
      links = (await db
        .select()
        .from(memoryLinks)
        .where(
          and(
            inArray(memoryLinks.fromId, Array.from(visibleIds)),
            inArray(memoryLinks.toId, Array.from(visibleIds)),
          ),
        )).filter((link) => visibleIds.has(link.fromId) && visibleIds.has(link.toId));
    } else {
      links = [];
    }

    return { entries, links, linkSource };
  }

  async clearGraph(): Promise<{ entriesReset: number; linksDeleted: number }> {
    const visibleEntries = await db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          eq(memoryEntries.graphed, true),
        ),
      );
    const visibleIds = visibleEntries.map((entry) => entry.id);
    if (visibleIds.length === 0) return { entriesReset: 0, linksDeleted: 0 };

    const linkResult = await db
      .delete(memoryLinks)
      .where(
        and(
          inArray(memoryLinks.fromId, visibleIds),
          inArray(memoryLinks.toId, visibleIds),
        ),
      )
      .returning();
    const linksDeleted = linkResult.length;

    const entryResult = await db
      .update(memoryEntries)
      .set({ graphed: false })
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, visibleIds),
        ),
      )
      .returning();
    const entriesReset = entryResult.length;

    return { entriesReset, linksDeleted };
  }

  async setGraphed(id: number, graphed: boolean): Promise<MemoryEntry | null> {
    const result = await db
      .update(memoryEntries)
      .set({ graphed })
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          eq(memoryEntries.id, id),
        ),
      )
      .returning();
    if (result.length > 0 && graphed) {
      await this.appendEvent(id, "graphed");
    }
    return result.length > 0 ? result[0] : null;
  }

  async deleteLinksForEntry(entryId: number): Promise<number> {
    const peerIds = new Set<number>();
    const existingLinks = await db
      .select()
      .from(memoryLinks)
      .where(
        or(eq(memoryLinks.fromId, entryId), eq(memoryLinks.toId, entryId)),
      );
    for (const link of existingLinks) {
      if (link.fromId !== entryId) peerIds.add(link.fromId);
      if (link.toId !== entryId) peerIds.add(link.toId);
    }

    const fromResult = await db
      .delete(memoryLinks)
      .where(eq(memoryLinks.fromId, entryId))
      .returning();
    const toResult = await db
      .delete(memoryLinks)
      .where(eq(memoryLinks.toId, entryId))
      .returning();

    if (peerIds.size > 0) {
      this.recomputeNeighborhoodsAsync(
        Array.from(peerIds),
        "deleteLinksForEntry",
      );
    }

    return fromResult.length + toResult.length;
  }

  async transferLinks(fromEntryId: number, toEntryId: number): Promise<number> {
    const peerIds = new Set<number>();
    const existingLinks = await db
      .select()
      .from(memoryLinks)
      .where(
        or(
          eq(memoryLinks.fromId, fromEntryId),
          eq(memoryLinks.toId, fromEntryId),
        ),
      );
    for (const link of existingLinks) {
      if (link.fromId !== fromEntryId) peerIds.add(link.fromId);
      if (link.toId !== fromEntryId) peerIds.add(link.toId);
    }

    const result = await this.transferLinksWithExecutor(
      db,
      fromEntryId,
      toEntryId,
    );

    peerIds.add(toEntryId);
    peerIds.delete(fromEntryId);
    this.recomputeNeighborhoodsAsync(Array.from(peerIds), "transferLinks");

    return result;
  }

  async getEntriesNeedingSummary(limit = 10000): Promise<MemoryEntry[]> {
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        and(
          or(
            eq(memoryEntries.layer, "long"),
            eq(memoryEntries.layer, "workspace"),
            eq(memoryEntries.layer, "mid"),
          ),
          memoryKnowledgeEligibleCondition(),
          or(isNull(memoryEntries.summary), isNull(memoryEntries.contentHash)),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(limit);

    const entries = rows.map((r) =>
      wrapLightEntry(r as Omit<MemoryEntry, "embedding">),
    );

    const breakdown: Record<string, number> = {};
    for (const entry of entries) {
      const key = `${entry.layer}/${entry.source}`;
      breakdown[key] = (breakdown[key] || 0) + 1;
    }
    log.debug(
      `getEntriesNeedingSummary: ${entries.length} entries found. Breakdown: ${JSON.stringify(breakdown)}`,
    );

    return entries;
  }

  async getEntriesNeedingEmbedding(limit = 10000): Promise<MemoryEntry[]> {
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        and(
          or(
            eq(memoryEntries.layer, "long"),
            eq(memoryEntries.layer, "workspace"),
          ),
          memoryKnowledgeEligibleCondition(),
          sql`embedding IS NULL`,
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(limit);
    return rows.map((r) => wrapLightEntry(r as Omit<MemoryEntry, "embedding">));
  }

  async updateSummaryAndHash(
    id: number,
    summary: string,
    contentHash: string,
  ): Promise<void> {
    await db
      .update(memoryEntries)
      .set({ summary, contentHash, processedAt: new Date() })
      .where(eq(memoryEntries.id, id));
  }

  async updateSummaryTitleAndHash(
    id: number,
    summary: string,
    title: string | null,
    contentHash: string,
    tags?: string[],
    oneLiner?: string,
  ): Promise<void> {
    const setData: Partial<typeof memoryEntries.$inferInsert> = {
      summary,
      contentHash,
      processedAt: new Date(),
      integrationStage: deriveMemoryIntegrationStage({
        integrationStage: null,
        title,
        summary,
        tags,
      }),
    };
    if (title) setData.title = title;
    if (oneLiner !== undefined) setData.oneLiner = oneLiner || null;
    if (tags && tags.length > 0) setData.tags = tags;

    log.debug(
      `updateSummaryTitleAndHash: id=${id}, keys=${Object.keys(setData).join(",")}, contentHash=${contentHash}, summaryLen=${summary.length}, title=${title}, oneLiner=${oneLiner?.slice(0, 60) ?? "(none)"}, tagsCount=${tags?.length ?? 0}`,
    );

    const result = await db
      .update(memoryEntries)
      .set(setData)
      .where(eq(memoryEntries.id, id));

    const rowCount = (result as { rowCount?: number })?.rowCount ?? "unknown";
    log.debug(
      `updateSummaryTitleAndHash: id=${id} update rowCount=${rowCount}`,
    );
    await this.appendEvent(id, "summary_updated", {
      title,
      tagsCount: tags?.length ?? 0,
    });
  }

  async flushMyelination(): Promise<{ cleared: number; linksDeleted: number }> {
    const result = await db.execute(sql`
      UPDATE memory_entries
      SET summary = NULL, content_hash = NULL, title = NULL
      WHERE layer IN ('long', 'workspace')
        AND (${memoryKnowledgeEligibleSql})
      AND (summary IS NOT NULL OR content_hash IS NOT NULL)
    `);
    const cleared = Number((result as { rowCount?: number }).rowCount || 0);

    const linkResult = await db.delete(memoryLinks);
    const linksDeleted = Number(
      (linkResult as { rowCount?: number }).rowCount || 0,
    );

    return { cleared, linksDeleted };
  }

  async updateEmbedding(id: number, embedding: number[]): Promise<void> {
    const embeddingStr = `[${embedding.join(",")}]`;
    log.debug(
      `updateEmbedding: id=${id}, dimensions=${embedding.length}, vectorStr length=${embeddingStr.length}`,
    );
    const result = await db.execute(sql`
      UPDATE memory_entries
      SET embedding = ${embeddingStr}::vector,
          processed_at = CURRENT_TIMESTAMP
      WHERE id = ${id}
    `);
    const rowCount = (result as { rowCount?: number }).rowCount ?? 0;
    log.debug(`updateEmbedding result: id=${id}, rowCount=${rowCount}`);
    if (rowCount === 0) {
      log.warn(
        `updateEmbedding: no rows updated for id=${id} — entry may not exist`,
      );
    }
  }

  async ensureEmbedding(
    entryId: number,
    text?: string,
  ): Promise<number[] | null> {
    const { isEmbeddingsAvailable, generateEmbedding } =
      await import("./embedding");
    if (!isEmbeddingsAvailable()) {
      log.debug(
        `ensureEmbedding: embeddings not available, skipping entry #${entryId}`,
      );
      return null;
    }

    let textForEmbed = text;
    if (!textForEmbed) {
      // Intentional SELECT * — needs embedding column to check/return existing embedding
      const [entry] = await db
        .select()
        .from(memoryEntries)
        .where(eq(memoryEntries.id, entryId))
        .limit(1);
      if (!entry) {
        log.warn(`ensureEmbedding: entry #${entryId} not found`);
        return null;
      }
      if (entry.embedding) {
        return entry.embedding;
      }
      textForEmbed = entry.summary || entry.content;
    }

    const embedding = await generateEmbedding(textForEmbed);
    await this.updateEmbedding(entryId, embedding);
    log.debug(
      `ensureEmbedding: generated and saved embedding for entry #${entryId} (${embedding.length} dims)`,
    );
    return embedding;
  }

  async addContentBlock(
    entryId: number,
    content: string,
    role: string,
    ordinal?: number,
  ): Promise<MemoryContentBlock> {
    const ord = ordinal ?? 0;
    if (ord === 0) {
      const existing = await db
        .select({ maxOrd: sql<number>`COALESCE(MAX(ordinal), -1)` })
        .from(memoryContentBlocks)
        .where(eq(memoryContentBlocks.entryId, entryId));
      const nextOrd = (existing[0]?.maxOrd ?? -1) + 1;
      const [block] = await db
        .insert(memoryContentBlocks)
        .values({ entryId, content, role, ordinal: nextOrd })
        .returning();
      return block;
    }
    const [block] = await db
      .insert(memoryContentBlocks)
      .values({ entryId, content, role, ordinal: ord })
      .returning();
    return block;
  }

  async getContentBlocks(entryId: number): Promise<MemoryContentBlock[]> {
    return db
      .select()
      .from(memoryContentBlocks)
      .where(eq(memoryContentBlocks.entryId, entryId))
      .orderBy(memoryContentBlocks.ordinal);
  }

  async getMyelinationStats(): Promise<{
    total: number;
    withSummary: number;
    withEmbedding: number;
    withLinks: number;
    needsSummary: number;
    needsEmbedding: number;
    needsProcessing: number;
  }> {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(summary)::int AS with_summary,
        COUNT(embedding)::int AS with_embedding,
        COUNT(CASE WHEN content_hash IS NOT NULL THEN 1 END)::int AS with_hash,
        COUNT(CASE WHEN summary IS NULL OR content_hash IS NULL OR embedding IS NULL THEN 1 END)::int AS needs_processing
      FROM memory_entries
      WHERE layer IN ('long', 'workspace')
        AND (${memoryKnowledgeEligibleSql})
    `);
    const row = result.rows[0] as unknown as MyelinationStatsRow;

    const linkResult = await db.execute(sql`
      SELECT COUNT(DISTINCT memory_links.from_id) + COUNT(DISTINCT memory_links.to_id) AS linked_count
      FROM memory_links
      INNER JOIN memory_entries from_entry ON from_entry.id = memory_links.from_id
      INNER JOIN memory_entries to_entry ON to_entry.id = memory_links.to_id
      WHERE (from_entry.source != 'chat' OR from_entry.metadata->>'mirrorKind' = 'session_summary')
        AND (from_entry.source != 'voice_session' OR from_entry.metadata->>'mirrorKind' = 'session_summary')
        AND (from_entry.source != 'conversation' OR (COALESCE(from_entry.source_id, '') NOT LIKE 'exchange-%' AND NOT (COALESCE(from_entry.tags, ARRAY[]::text[]) @> ARRAY['exchange']::text[])))
        AND (to_entry.source != 'chat' OR to_entry.metadata->>'mirrorKind' = 'session_summary')
        AND (to_entry.source != 'voice_session' OR to_entry.metadata->>'mirrorKind' = 'session_summary')
        AND (to_entry.source != 'conversation' OR (COALESCE(to_entry.source_id, '') NOT LIKE 'exchange-%' AND NOT (COALESCE(to_entry.tags, ARRAY[]::text[]) @> ARRAY['exchange']::text[])))
    `);
    const linkedCount = parseInt(
      (linkResult.rows[0] as unknown as LinkedCountRow)?.linked_count || "0",
    );

    return {
      total: row.total,
      withSummary: row.with_summary,
      withEmbedding: row.with_embedding,
      withLinks: linkedCount,
      needsSummary: row.total - row.with_summary,
      needsEmbedding: row.total - row.with_embedding,
      needsProcessing: row.needs_processing,
    };
  }
  async appendEvent(
    entryId: number,
    eventType: MemoryEventType,
    details?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await insertMemoryEvent(db, {
        entryId,
        eventType,
        details: details ?? {},
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        `appendEvent failed (entry #${entryId}, type=${eventType}): ${message}`,
      );
    }
  }

  async getEventsByRange(
    start: Date,
    end: Date,
    options?: { eventType?: string; limit?: number },
  ): Promise<
    Array<
      MemoryEvent & {
        entryTitle: string | null;
        entrySummary: string | null;
        entrySource: string | null;
        entryLayer: string | null;
      }
    >
  > {
    const conditions = [
      gte(memoryEvents.occurredAt, start),
      lte(memoryEvents.occurredAt, end),
    ];
    if (options?.eventType) {
      conditions.push(eq(memoryEvents.eventType, options.eventType));
    }

    // Scope event visibility through the joined memory entry's ownership
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "system") {
      conditions.push(
        or(
          sql`(${memoryEntries.scope} = 'global')`,
          eq(memoryEntries.ownerUserId, principal.userId!),
          eq(memoryEntries.accountId, principal.accountId!),
        )!,
      );
    }

    const rows = await db
      .select({
        id: memoryEvents.id,
        entryId: memoryEvents.entryId,
        eventType: memoryEvents.eventType,
        details: memoryEvents.details,
        occurredAt: memoryEvents.occurredAt,
        entryTitle: memoryEntries.title,
        entrySummary: memoryEntries.summary,
        entrySource: memoryEntries.source,
        entryLayer: memoryEntries.layer,
      })
      .from(memoryEvents)
      .innerJoin(memoryEntries, eq(memoryEvents.entryId, memoryEntries.id))
      .where(and(...conditions))
      .orderBy(desc(memoryEvents.occurredAt))
      .limit(options?.limit ?? 200);

    return rows;
  }

  async getEventsForEntry(entryId: number): Promise<MemoryEvent[]> {
    // Verify the entry is visible to the current principal before returning events
    const entry = await this.getEntry(entryId);
    if (!entry) return [];
    return db
      .select()
      .from(memoryEvents)
      .where(eq(memoryEvents.entryId, entryId))
      .orderBy(desc(memoryEvents.occurredAt));
  }

  async getRecentGraphedSummaries(
    days: number,
  ): Promise<
    Array<{ title: string | null; summary: string | null; occurredAt: Date }>
  > {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const principal = getCurrentPrincipalOrSystem();
    const conditions = [
      eq(memoryEvents.eventType, "graphed"),
      gte(memoryEvents.occurredAt, since),
    ];
    if (principal.actorType !== "system") {
      conditions.push(
        or(
          sql`(${memoryEntries.scope} = 'global')`,
          eq(memoryEntries.ownerUserId, principal.userId!),
          eq(memoryEntries.accountId, principal.accountId!),
        )!,
      );
    }

    const rows = await db
      .select({
        title: memoryEntries.title,
        summary: memoryEntries.summary,
        occurredAt: memoryEvents.occurredAt,
      })
      .from(memoryEvents)
      .innerJoin(memoryEntries, eq(memoryEvents.entryId, memoryEntries.id))
      .where(and(...conditions))
      .orderBy(desc(memoryEvents.occurredAt))
      .limit(50);

    return rows;
  }

  async getEventSummaryByRange(
    start: Date,
    end: Date,
  ): Promise<Record<string, number>> {
    const principal = getCurrentPrincipalOrSystem();
    const conditions = [
      gte(memoryEvents.occurredAt, start),
      lte(memoryEvents.occurredAt, end),
    ];
    if (principal.actorType !== "system") {
      conditions.push(
        or(
          sql`(${memoryEntries.scope} = 'global')`,
          eq(memoryEntries.ownerUserId, principal.userId!),
          eq(memoryEntries.accountId, principal.accountId!),
        )!,
      );
    }
    const rows = await db
      .select({
        eventType: memoryEvents.eventType,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(memoryEvents)
      .innerJoin(memoryEntries, eq(memoryEvents.entryId, memoryEntries.id))
      .where(and(...conditions))
      .groupBy(memoryEvents.eventType);

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.eventType] = row.count;
    }
    return result;
  }

  async getDaysWithEvents(start: Date, end: Date): Promise<string[]> {
    const tz = getTimezone();
    const principal = getCurrentPrincipalOrSystem();
    const conditions = [
      gte(memoryEvents.occurredAt, start),
      lte(memoryEvents.occurredAt, end),
    ];
    if (principal.actorType !== "system") {
      conditions.push(
        or(
          sql`(${memoryEntries.scope} = 'global')`,
          eq(memoryEntries.ownerUserId, principal.userId!),
          eq(memoryEntries.accountId, principal.accountId!),
        )!,
      );
    }
    const rows = await db
      .select({
        day: sql<string>`TO_CHAR(occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
      })
      .from(memoryEvents)
      .innerJoin(memoryEntries, eq(memoryEvents.entryId, memoryEntries.id))
      .where(and(...conditions))
      .groupBy(sql`TO_CHAR(occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`)
      .orderBy(asc(sql`TO_CHAR(occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD')`));

    return rows.map((r) => r.day);
  }

  async getMemoryEntriesByDay(
    start: Date,
    end: Date,
  ): Promise<Array<{ day: string; entryId: number; title: string | null }>> {
    const tz = getTimezone();
    const principal = getCurrentPrincipalOrSystem();
    const ownerFilter = principal.actorType === "system"
      ? sql`TRUE`
      : sql`(${memoryEntries.scope} = 'global' OR ${memoryEntries.ownerUserId} = ${principal.userId} OR ${memoryEntries.accountId} = ${principal.accountId})`;
    const rows = await db.execute(sql`
      SELECT DISTINCT ON (entry_id, TO_CHAR(occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD'))
        TO_CHAR(occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') as day,
        ${memoryEvents.entryId} as entry_id,
        ${memoryEntries.title} as title
      FROM ${memoryEvents}
      INNER JOIN ${memoryEntries} ON ${memoryEvents.entryId} = ${memoryEntries.id}
      WHERE ${memoryEvents.occurredAt} >= ${start} AND ${memoryEvents.occurredAt} <= ${end}
        AND ${ownerFilter}
      ORDER BY TO_CHAR(occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD'), entry_id
    `);

    return (rows.rows || []).map((r: any) => ({
      day: r.day,
      entryId: r.entry_id,
      title: r.title,
    }));
  }

  async linkMemoryToEntity(
    memoryId: number,
    entityType: string,
    entityId: string,
  ): Promise<MemoryEntityLink> {
    const existing = await db
      .select()
      .from(memoryEntityLinks)
      .where(
        and(
          eq(memoryEntityLinks.memoryId, memoryId),
          eq(memoryEntityLinks.entityType, entityType),
          eq(memoryEntityLinks.entityId, entityId),
        ),
      )
      .limit(1);
    if (existing.length > 0) return existing[0];

    const [link] = await db
      .insert(memoryEntityLinks)
      .values({ memoryId, entityType, entityId })
      .returning();
    return link;
  }

  async unlinkMemoryFromEntity(
    memoryId: number,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    await db
      .delete(memoryEntityLinks)
      .where(
        and(
          eq(memoryEntityLinks.memoryId, memoryId),
          eq(memoryEntityLinks.entityType, entityType),
          eq(memoryEntityLinks.entityId, entityId),
        ),
      );
  }

  async getEntityLinksForMemory(memoryId: number): Promise<MemoryEntityLink[]> {
    return db
      .select()
      .from(memoryEntityLinks)
      .where(eq(memoryEntityLinks.memoryId, memoryId));
  }

  async getMemoriesForEntity(
    entityType: string,
    entityId: string,
  ): Promise<Array<MemoryEntry & { linkId: number }>> {
    const links = await db
      .select()
      .from(memoryEntityLinks)
      .where(
        and(
          eq(memoryEntityLinks.entityType, entityType),
          eq(memoryEntityLinks.entityId, entityId),
        ),
      );
    if (links.length === 0) return [];

    const memoryIds = links.map((l) => l.memoryId);
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, memoryIds),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt));

    const linkMap = new Map(links.map((l) => [l.memoryId, l.id]));
    return rows.map((r) => {
      const entry = wrapLightEntry(r as Omit<MemoryEntry, "embedding">);
      return { ...entry, linkId: linkMap.get(entry.id)! };
    });
  }
  async backfillDecayScores(): Promise<number> {
    const rows = await db
      .select({ id: memoryEntries.id, metadata: memoryEntries.metadata })
      .from(memoryEntries)
      .where(eq(memoryEntries.layer, "long"));

    let updated = 0;
    for (const row of rows) {
      const meta = (row.metadata || {}) as Record<string, unknown>;
      if (meta.decay_score !== undefined) continue;
      meta.decay_score = 1.0;
      await db
        .update(memoryEntries)
        .set({ metadata: meta })
        .where(eq(memoryEntries.id, row.id));
      updated++;
    }
    if (updated > 0) {
      log.debug(`Backfilled decay_score=1.0 on ${updated} long-term entries`);
    }
    return updated;
  }

  async decayAllLinks(
    factor: number = 0.95,
    minStrength: number = 0.1,
  ): Promise<{ decayed: number; pruned: number }> {
    const decayResult = await db.execute(sql`
      UPDATE memory_links
      SET strength = strength * ${factor}
    `);
    const decayed = Number(
      (decayResult as { rowCount?: number }).rowCount || 0,
    );

    const pruneResult = await db.execute(sql`
      DELETE FROM memory_links
      WHERE strength < ${minStrength}
    `);
    const pruned = Number((pruneResult as { rowCount?: number }).rowCount || 0);

    return { decayed, pruned };
  }

  async reinforceLinks(
    entryIds: number[],
    boost: number = 0.1,
    cap: number = 1.0,
  ): Promise<number> {
    if (entryIds.length === 0) return 0;
    const idConditions = sql.join(
      entryIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await db.execute(sql`
      UPDATE memory_links
      SET strength = LEAST(${cap}, strength + ${boost})
      WHERE from_id IN (${idConditions})
         OR to_id IN (${idConditions})
    `);
    return Number((result as { rowCount?: number }).rowCount || 0);
  }

  async updateLinkStrength(linkId: number, newStrength: number): Promise<void> {
    await db
      .update(memoryLinks)
      .set({ strength: Math.max(0, Math.min(1.0, newStrength)) })
      .where(eq(memoryLinks.id, linkId));
  }

  async getOrphanEntries(
    options: {
      minAgeDays?: number;
      maxDecayScore?: number;
      limit?: number;
    } = {},
  ): Promise<MemoryEntry[]> {
    const minAgeDays = options.minAgeDays ?? 7;
    const maxDecayScore = options.maxDecayScore ?? 0.5;
    const limit = options.limit ?? 50;
    const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);

    const rows = await db.execute(sql`
      SELECT me.id, me.layer, me.integration_stage, me.content, me.summary, me.content_hash, me.source, me.source_id,
             me.path, me.title, me.one_liner, me.metadata, me.tags, me.graphed, me.pinned, me.created_at, me.processed_at
      FROM memory_entries me
      LEFT JOIN memory_links ml_from ON ml_from.from_id = me.id
      LEFT JOIN memory_links ml_to ON ml_to.to_id = me.id
      WHERE ${canonicalOrLegacyLongCondition('me')}
        AND ml_from.id IS NULL
        AND ml_to.id IS NULL
        AND me.created_at <= ${cutoff}
        AND COALESCE((me.metadata->>'decay_score')::float, 1.0) <= ${maxDecayScore}
      ORDER BY COALESCE((me.metadata->>'decay_score')::float, 1.0) ASC
      LIMIT ${limit}
    `);

    return (rows.rows as unknown as RawMemoryRow[]).map(mapRawRowToLightEntry);
  }


  /**
   * Get count of long-term memory entries.
   */
  async getLongTermEntryCount(): Promise<number> {
    const result = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM memory_entries WHERE layer = 'long' OR integration_stage IN ('stage_3', 'stage_4')
    `);
    return (result.rows[0] as { cnt: number }).cnt;
  }

  /**
   * Get the lowest-value entries for budget enforcement pruning.
   * Value = decay_score*0.3 + normalized_recall*0.4 + normalized_links*0.2 + recency*0.1
   * Excludes protected entries (canonical/principle/architecture tags, confidence>0.8,
   * recalled in last 14 days, linked to active goals/projects/people).
   */
  async getLowestValueEntries(limit: number): Promise<Array<{ id: number; value: number }>> {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const rows = await db.execute(sql`
      SELECT
        me.id,
        (
          COALESCE((me.metadata->>'decay_score')::float, 0.5) * 0.3 +
          LEAST(COALESCE((me.metadata->>'recall_count')::int, 0) / 10.0, 1.0) * 0.4 +
          LEAST(
            (SELECT COUNT(*)::float FROM memory_links ml WHERE ml.from_id = me.id OR ml.to_id = me.id) / 5.0,
            1.0
          ) * 0.2 +
          GREATEST(0, 1.0 - EXTRACT(EPOCH FROM (NOW() - COALESCE(
            (me.metadata->>'last_recalled_at')::timestamp,
            me.created_at
          ))) / (90.0 * 86400)) * 0.1
        ) AS value
      FROM memory_entries me
      WHERE ${canonicalOrLegacyLongCondition('me')}
        AND NOT (me.tags && ARRAY['canonical', 'principle', 'architecture'])
        AND COALESCE((me.metadata->>'confidence')::float, 0.5) <= 0.8
        AND COALESCE(
          (me.metadata->>'last_recalled_at')::timestamp,
          '1970-01-01'::timestamp
        ) < ${fourteenDaysAgo}
      ORDER BY value ASC
      LIMIT ${limit}
    `);
    return (rows.rows as Array<{ id: number; value: number }>);
  }
  /**
   * Recall-based survival pruning: entries that have existed 30+ days, were never
   * recalled, have at most 1 graph link, decayed below 0.3, and carry no protected
   * tags (canonical, principle, architecture). These entries failed the "contingent
   * interaction" test — reality never reinforced them.
   */
  async getUnrecalledDormantEntries(
    options: { limit?: number } = {},
  ): Promise<MemoryEntry[]> {
    const limit = options.limit ?? 50;
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    const rows = await db.execute(sql`
      SELECT me.id, me.layer, me.integration_stage, me.content, me.summary, me.content_hash, me.source, me.source_id,
             me.path, me.title, me.one_liner, me.metadata, me.tags, me.graphed, me.pinned, me.created_at, me.processed_at
      FROM memory_entries me
      LEFT JOIN memory_links ml_from ON ml_from.from_id = me.id
      LEFT JOIN memory_links ml_to ON ml_to.to_id = me.id
      WHERE ${canonicalOrLegacyLongCondition('me')}
        AND COALESCE((me.metadata->>'recall_count')::int, 0) = 0
        AND me.created_at <= ${cutoff}
        AND COALESCE((me.metadata->>'decay_score')::float, 1.0) < 0.3
        AND NOT (me.tags && ARRAY['canonical', 'principle', 'architecture'])
      GROUP BY me.id
      HAVING COUNT(DISTINCT ml_from.id) + COUNT(DISTINCT ml_to.id) <= 1
      ORDER BY COALESCE((me.metadata->>'decay_score')::float, 1.0) ASC
      LIMIT ${limit}
    `);

    return (rows.rows as unknown as RawMemoryRow[]).map(mapRawRowToLightEntry);
  }

  async getRandomEntries(
    count: number = 5,
    layer: string = "long",
  ): Promise<MemoryEntry[]> {
    const rows = await db.execute(sql`
      SELECT id, layer, integration_stage, content, summary, content_hash, source, source_id,
             path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at
      FROM memory_entries
      WHERE (layer = ${layer} OR (${layer} = 'long' AND integration_stage IN ('stage_3', 'stage_4')))
        AND summary IS NOT NULL
      ORDER BY RANDOM()
      LIMIT ${count}
    `);
    return (rows.rows as unknown as RawMemoryRow[]).map(mapRawRowToLightEntry);
  }

  async getRandomDiverseEntries(
    count: number = 5,
    layer: string = "long",
  ): Promise<MemoryEntry[]> {
    const tagRows = await db.execute(sql`
      SELECT tag FROM (
        SELECT DISTINCT unnest(tags) AS tag
        FROM memory_entries
        WHERE (layer = ${layer} OR (${layer} = 'long' AND integration_stage IN ('stage_3', 'stage_4')))
          AND tags IS NOT NULL
          AND array_length(tags, 1) > 0
      ) t
      ORDER BY RANDOM()
      LIMIT ${count * 2}
    `);

    const tags = (tagRows.rows as Array<{ tag: string }>).map((r) => r.tag);
    if (tags.length === 0) {
      return this.getRandomEntries(count, layer);
    }

    const selectedTags = tags.slice(0, count);
    const entryPromises = selectedTags.map((tag) =>
      db.execute(sql`
        SELECT id, layer, integration_stage, content, summary, content_hash, source, source_id,
               path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at
        FROM memory_entries
        WHERE (layer = ${layer} OR (${layer} = 'long' AND integration_stage IN ('stage_3', 'stage_4')))
          AND summary IS NOT NULL
          AND ${tag} = ANY(tags)
        ORDER BY RANDOM()
        LIMIT 1
      `),
    );

    const results = await Promise.all(entryPromises);
    const seen = new Set<number>();
    const entries: MemoryEntry[] = [];

    for (const result of results) {
      const rows = result.rows as unknown as RawMemoryRow[];
      if (rows.length > 0 && !seen.has(rows[0].id)) {
        seen.add(rows[0].id);
        entries.push(mapRawRowToLightEntry(rows[0]));
      }
    }

    if (entries.length < count) {
      const excludeIds = Array.from(seen);
      const excludeClause =
        excludeIds.length > 0
          ? sql`AND id NOT IN (${sql.join(
              excludeIds.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``;
      const fillRows = await db.execute(sql`
        SELECT id, layer, integration_stage, content, summary, content_hash, source, source_id,
               path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at
        FROM memory_entries
        WHERE (layer = ${layer} OR (${layer} = 'long' AND integration_stage IN ('stage_3', 'stage_4')))
          AND summary IS NOT NULL
          ${excludeClause}
        ORDER BY RANDOM()
        LIMIT ${count - entries.length}
      `);
      for (const row of fillRows.rows as unknown as RawMemoryRow[]) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          entries.push(mapRawRowToLightEntry(row));
        }
      }
    }

    return entries;
  }

  async getGraphMetrics(): Promise<{
    totalEntries: number;
    totalLinks: number;
    linkedEntries: number;
    orphanEntries: number;
    avgLinkStrength: number;
    weakLinks: number;
    strongLinks: number;
  }> {
    const result = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM memory_entries WHERE layer = 'long' OR integration_stage IN ('stage_3', 'stage_4')) AS total_entries,
        (SELECT COUNT(*)::int FROM memory_links) AS total_links,
        (SELECT COUNT(DISTINCT id)::int FROM (
          SELECT from_id AS id FROM memory_links
          UNION
          SELECT to_id AS id FROM memory_links
        ) sub WHERE id IN (SELECT id FROM memory_entries WHERE layer = 'long' OR integration_stage IN ('stage_3', 'stage_4'))) AS linked_entries,
        COALESCE((SELECT AVG(strength) FROM memory_links), 0) AS avg_link_strength,
        (SELECT COUNT(*)::int FROM memory_links WHERE strength < 0.3) AS weak_links,
        (SELECT COUNT(*)::int FROM memory_links WHERE strength >= 0.7) AS strong_links
    `);

    const row = result.rows[0] as {
      total_entries: number;
      total_links: number;
      linked_entries: number;
      avg_link_strength: string;
      weak_links: number;
      strong_links: number;
    };

    return {
      totalEntries: row.total_entries,
      totalLinks: row.total_links,
      linkedEntries: row.linked_entries,
      orphanEntries: row.total_entries - row.linked_entries,
      avgLinkStrength: parseFloat(String(row.avg_link_strength)),
      weakLinks: row.weak_links,
      strongLinks: row.strong_links,
    };
  }

  async findMergeCandidates(
    limit: number = 20,
    windowDays: number = 30,
  ): Promise<
    Array<{
      entryA: MemoryEntry;
      entryB: MemoryEntry;
      similarity: number;
    }>
  > {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const rows = await db.execute(sql`
      SELECT
        a.id AS a_id, a.layer AS a_layer, a.integration_stage AS a_integration_stage, a.content AS a_content, a.summary AS a_summary,
        a.source AS a_source, a.source_id AS a_source_id, a.title AS a_title,
        a.metadata AS a_metadata, a.tags AS a_tags, a.graphed AS a_graphed,
        a.created_at AS a_created_at, a.processed_at AS a_processed_at,
        a.content_hash AS a_content_hash, a.path AS a_path,
        b.id AS b_id, b.layer AS b_layer, b.integration_stage AS b_integration_stage, b.content AS b_content, b.summary AS b_summary,
        b.source AS b_source, b.source_id AS b_source_id, b.title AS b_title,
        b.metadata AS b_metadata, b.tags AS b_tags, b.graphed AS b_graphed,
        b.created_at AS b_created_at, b.processed_at AS b_processed_at,
        b.content_hash AS b_content_hash, b.path AS b_path,
        1 - (a.embedding <=> b.embedding) AS similarity
      FROM memory_entries a
      CROSS JOIN LATERAL (
        SELECT b2.id, b2.layer, b2.integration_stage, b2.content, b2.summary, b2.content_hash, b2.source, b2.source_id, b2.path, b2.title, b2.one_liner, b2.metadata, b2.tags, b2.graphed, b2.pinned, b2.created_at, b2.processed_at, b2.embedding
        FROM memory_entries b2
        WHERE b2.id > a.id
          AND (b2.layer = 'long' OR b2.integration_stage IN ('stage_3', 'stage_4'))
          AND b2.embedding IS NOT NULL
          AND b2.created_at >= ${cutoff}
        ORDER BY a.embedding <=> b2.embedding
        LIMIT 1
      ) b
      WHERE (a.layer = 'long' OR a.integration_stage IN ('stage_3', 'stage_4'))
        AND a.embedding IS NOT NULL
        AND a.created_at >= ${cutoff}
        AND 1 - (a.embedding <=> b.embedding) >= 0.85
      ORDER BY similarity DESC
      LIMIT ${limit}
    `);

    return (rows.rows as Array<Record<string, unknown>>).map((row) => ({
      entryA: mapRawRowToEntry({
        id: row.a_id as number,
        layer: row.a_layer as string,
        integration_stage: row.a_integration_stage as string | null,
        content: row.a_content as string,
        summary: row.a_summary as string | null,
        embedding: null,
        source: row.a_source as string,
        source_id: row.a_source_id as string | null,
        path: row.a_path as string | null,
        title: row.a_title as string | null,
        one_liner: null,
        content_hash: row.a_content_hash as string | null,
        metadata: row.a_metadata as Record<string, unknown>,
        tags: row.a_tags as string[] | null,
        graphed: row.a_graphed as boolean,
        pinned: false,
        created_at: row.a_created_at as Date,
        processed_at: row.a_processed_at as Date | null,
        similarity: null,
      }),
      entryB: mapRawRowToEntry({
        id: row.b_id as number,
        layer: row.b_layer as string,
        integration_stage: row.b_integration_stage as string | null,
        content: row.b_content as string,
        summary: row.b_summary as string | null,
        embedding: null,
        source: row.b_source as string,
        source_id: row.b_source_id as string | null,
        path: row.b_path as string | null,
        title: row.b_title as string | null,
        one_liner: null,
        content_hash: row.b_content_hash as string | null,
        metadata: row.b_metadata as Record<string, unknown>,
        tags: row.b_tags as string[] | null,
        graphed: row.b_graphed as boolean,
        pinned: false,
        created_at: row.b_created_at as Date,
        processed_at: row.b_processed_at as Date | null,
        similarity: null,
      }),
      similarity: parseFloat(String(row.similarity)),
    }));
  }

  async getDecayScoreDistribution(): Promise<Array<{ score: number }>> {
    const rows = await db.execute(sql`
      SELECT COALESCE((metadata->>'decay_score')::float, 1.0) AS score
      FROM memory_entries
      WHERE layer = 'long'
    `);
    return rows.rows as Array<{ score: number }>;
  }

  async migrateConceptsToBelief(): Promise<number> {
    const conceptsRaw = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(eq(memoryEntries.source, "concept" as any));
    const concepts = conceptsRaw.map((r) =>
      wrapLightEntry(r as Omit<MemoryEntry, "embedding">),
    );

    if (concepts.length === 0) return 0;

    let migrated = 0;
    for (const entry of concepts) {
      const existingMeta = (entry.metadata || {}) as Record<string, unknown>;
      const domain =
        (entry.tags || []).find((t) => t !== "concept") || "general";
      const newMeta: Record<string, unknown> = {
        ...existingMeta,
        confidence: 0.7,
        decay_score: 1.0,
        domain,
        status: "active",
        migrated_from: "concept",
      };

      await db
        .update(memoryEntries)
        .set({
          source: "belief",
          metadata: newMeta,
          tags: [
            "belief",
            ...(entry.tags || []).filter((t) => t !== "concept"),
          ],
        })
        .where(eq(memoryEntries.id, entry.id));
      migrated++;
    }

    if (migrated > 0) {
      log.debug(`Migrated ${migrated} concept entries to belief source`);
    }
    return migrated;
  }

  async recomputeNeighborhood(entryId: number): Promise<void> {
    await acquireNeighborhoodSemaphore();
    try {
      const hop1Links = await db
        .select()
        .from(memoryLinks)
        .where(
          or(eq(memoryLinks.fromId, entryId), eq(memoryLinks.toId, entryId)),
        );

      if (hop1Links.length === 0) {
        await db
          .update(memoryEntries)
          .set({
            metadata: sql`jsonb_set(COALESCE(metadata, '{}'::jsonb), '{neighborhood_cache}', ${JSON.stringify(
              {
                version: NEIGHBORHOOD_CACHE_VERSION,
                computedAt: new Date().toISOString(),
                entries: [],
              },
            )}::jsonb)`,
          })
          .where(eq(memoryEntries.id, entryId));
        return;
      }

      const hop1PeerIds = new Set<number>();
      const hop1LinkMap = new Map<
        number,
        { relationship: string; relationshipType: string; strength: number }
      >();
      for (const link of hop1Links) {
        const peerId = link.fromId === entryId ? link.toId : link.fromId;
        hop1PeerIds.add(peerId);
        const existing = hop1LinkMap.get(peerId);
        if (!existing || link.strength > existing.strength) {
          hop1LinkMap.set(peerId, {
            relationship: link.relationship,
            relationshipType: link.relationshipType || "related",
            strength: link.strength,
          });
        }
      }

      const hop1Ids = Array.from(hop1PeerIds);
      const hop1Entries =
        hop1Ids.length > 0
          ? await db
              .select({
                id: memoryEntries.id,
                title: memoryEntries.title,
                summary: memoryEntries.summary,
                tags: memoryEntries.tags,
              })
              .from(memoryEntries)
              .where(inArray(memoryEntries.id, hop1Ids))
          : [];

      const cacheEntries: NeighborhoodCacheEntry[] = [];
      for (const entry of hop1Entries) {
        const linkInfo = hop1LinkMap.get(entry.id);
        if (!linkInfo) continue;
        cacheEntries.push({
          id: entry.id,
          title: entry.title,
          summary: entry.summary,
          relationship: linkInfo.relationship,
          relationshipType: (linkInfo.relationshipType ||
            "related") as RelationshipType,
          strength: linkInfo.strength,
          hop: 1,
          tags: (entry.tags || []) as string[],
        });
      }

      if (
        cacheEntries.length < NEIGHBORHOOD_MAX_ENTRIES &&
        hop1Ids.length > 0
      ) {
        const hop2Links = await db
          .select()
          .from(memoryLinks)
          .where(
            and(
              or(
                inArray(memoryLinks.fromId, hop1Ids),
                inArray(memoryLinks.toId, hop1Ids),
              ),
              sql`${memoryLinks.fromId} != ${entryId}`,
              sql`${memoryLinks.toId} != ${entryId}`,
            ),
          );

        const hop2PeerIds = new Set<number>();
        const hop2LinkMap = new Map<
          number,
          {
            relationship: string;
            relationshipType: string;
            strength: number;
            viaStrength: number;
          }
        >();
        for (const link of hop2Links) {
          const fromPeer = hop1PeerIds.has(link.fromId);
          const toPeer = hop1PeerIds.has(link.toId);
          const peerId = fromPeer ? link.toId : link.fromId;
          const viaPeerId = fromPeer ? link.fromId : link.toId;

          if (peerId === entryId || hop1PeerIds.has(peerId)) continue;
          if (!fromPeer && !toPeer) continue;

          hop2PeerIds.add(peerId);
          const viaLink = hop1LinkMap.get(viaPeerId);
          const viaStrength = viaLink ? viaLink.strength : 0.5;
          const existing = hop2LinkMap.get(peerId);
          const combinedStrength = link.strength * viaStrength;
          if (
            !existing ||
            combinedStrength > existing.strength * existing.viaStrength
          ) {
            hop2LinkMap.set(peerId, {
              relationship: link.relationship,
              relationshipType: link.relationshipType || "related",
              strength: link.strength,
              viaStrength,
            });
          }
        }

        const remainingSlots = NEIGHBORHOOD_MAX_ENTRIES - cacheEntries.length;
        const hop2Ids = Array.from(hop2PeerIds).sort((a, b) => {
          const aInfo = hop2LinkMap.get(a);
          const bInfo = hop2LinkMap.get(b);
          const aScore = aInfo ? aInfo.strength * aInfo.viaStrength : 0;
          const bScore = bInfo ? bInfo.strength * bInfo.viaStrength : 0;
          return bScore - aScore;
        });
        const hop2IdsToFetch = hop2Ids.slice(0, remainingSlots);

        if (hop2IdsToFetch.length > 0) {
          const hop2Entries = await db
            .select({
              id: memoryEntries.id,
              title: memoryEntries.title,
              summary: memoryEntries.summary,
              tags: memoryEntries.tags,
            })
            .from(memoryEntries)
            .where(inArray(memoryEntries.id, hop2IdsToFetch));

          for (const entry of hop2Entries) {
            const linkInfo = hop2LinkMap.get(entry.id);
            if (!linkInfo) continue;
            cacheEntries.push({
              id: entry.id,
              title: entry.title,
              summary: entry.summary,
              relationship: linkInfo.relationship,
              relationshipType: (linkInfo.relationshipType ||
                "related") as RelationshipType,
              strength: linkInfo.strength * linkInfo.viaStrength,
              hop: 2,
              tags: (entry.tags || []) as string[],
            });
          }
        }
      }

      const cache: NeighborhoodCache = {
        version: NEIGHBORHOOD_CACHE_VERSION,
        computedAt: new Date().toISOString(),
        entries: cacheEntries.slice(0, NEIGHBORHOOD_MAX_ENTRIES),
      };

      await db
        .update(memoryEntries)
        .set({
          metadata: sql`jsonb_set(COALESCE(metadata, '{}'::jsonb), '{neighborhood_cache}', ${JSON.stringify(cache)}::jsonb)`,
        })
        .where(eq(memoryEntries.id, entryId));
    } finally {
      releaseNeighborhoodSemaphore();
    }
  }

  private static correlationCounter = 0;

  recomputeNeighborhoodAsync(
    entryId: number,
    operation: string,
    correlationId?: string,
  ): void {
    const corrId = correlationId || `nc-${++MemoryStorage.correlationCounter}`;
    this.recomputeNeighborhood(entryId).catch((err) => {
      log.warn(
        `Neighborhood recomputation failed for entry #${entryId} (op=${operation}, corr=${corrId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  recomputeNeighborhoodsAsync(entryIds: number[], operation: string): void {
    const corrId = `nc-${++MemoryStorage.correlationCounter}`;
    for (const id of entryIds) {
      this.recomputeNeighborhoodAsync(id, operation, corrId);
    }
  }

  async backfillNeighborhoodCaches(): Promise<{
    processed: number;
    errors: number;
  }> {
    const graphedEntries = await db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.graphed, true),
          eq(memoryEntries.layer, "long"),
          or(
            sql`metadata IS NULL`,
            sql`metadata->'neighborhood_cache' IS NULL`,
          ),
        ),
      );

    log.debug(
      `Neighborhood backfill: ${graphedEntries.length} long-term graphed entries to process`,
    );

    let processed = 0;
    let errors = 0;

    for (
      let i = 0;
      i < graphedEntries.length;
      i += NEIGHBORHOOD_SEMAPHORE_CAP
    ) {
      const batch = graphedEntries.slice(i, i + NEIGHBORHOOD_SEMAPHORE_CAP);
      const results = await Promise.allSettled(
        batch.map((entry) => this.recomputeNeighborhood(entry.id)),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          processed++;
        } else {
          errors++;
          log.warn(
            `Neighborhood backfill error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }

      if ((i + batch.length) % 100 < NEIGHBORHOOD_SEMAPHORE_CAP) {
        log.debug(
          `Neighborhood backfill progress: ${Math.min(i + batch.length, graphedEntries.length)}/${graphedEntries.length}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    log.debug(
      `Neighborhood backfill complete: ${processed} processed, ${errors} errors`,
    );
    return { processed, errors };
  }

  async getEntriesForDisplay(ids: number[]): Promise<MemoryEntry[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .select(memoryEntryListingColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          inArray(memoryEntries.id, ids),
        ),
      );

    const needsContent: number[] = [];
    for (const r of rows) {
      if (r.summary == null) needsContent.push(r.id);
    }

    let contentMap = new Map<number, string>();
    if (needsContent.length > 0) {
      const contentRows = await db
        .select({
          id: memoryEntries.id,
          content: memoryEntries.content,
        })
        .from(memoryEntries)
        .where(
          combineWithVisibleScope(
            getCurrentPrincipalOrSystem(),
            memoryScopeColumns,
            inArray(memoryEntries.id, needsContent),
          ),
        );
      contentMap = new Map(contentRows.map((r) => [r.id, r.content]));
    }

    return rows.map((r) => {
      const summary = r.summary ?? contentMap.get(r.id) ?? null;
      const listing: Omit<
        MemoryEntry,
        "embedding" | "content" | "contentHash"
      > = {
        id: r.id,
        layer: r.layer as MemoryLayer,
        summary,
        source: r.source as MemorySource,
        sourceId: r.sourceId,
        path: r.path ?? null,
        title: r.title ?? null,
        oneLiner: r.oneLiner ?? null,
        metadata: r.metadata as Record<string, unknown>,
        tags: r.tags,
        graphed: r.graphed ?? false,
        pinned: r.pinned ?? false,
        createdAt:
          r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
        processedAt: r.processedAt
          ? r.processedAt instanceof Date
            ? r.processedAt
            : new Date(r.processedAt)
          : null,
      };
      return wrapListingEntry(listing);
    });
  }
}

export const memoryStorage = new MemoryStorage();

/**
 * Standalone helper for logging memory events from outside the MemoryStorage class.
 * Fire-and-forget — failures are logged but never block the caller.
 */
export async function logMemoryEvent(
  memoryId: number,
  eventType: MemoryEventType,
  metadata?: Record<string, unknown>,
): Promise<void> {
  return memoryStorage.appendEvent(memoryId, eventType, metadata);
}
