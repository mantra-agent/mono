import { db } from "../db";
import {
  memoryEntries,
  memorySourceRefs,
  type MemoryEntry,
  type MemoryLayer,
  getNeighborhoodCache,
} from "@shared/schema";
import { eq, sql, and, or, ilike, inArray, gte, lt, desc, ne } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import { createLogger } from "../log";
import { generateEmbedding, isEmbeddingsAvailable } from "./embedding";
import {
  executeSemanticSearch,
  mapRawRowToEntry,
  memoryStorage,
  memoryEntryLightColumns,
  wrapLightEntry,
  memoryKnowledgeEligibleCondition,
} from "./memory-storage";
import { getTimezone } from "../timezone";

const log = createLogger("UnifiedSearch");
const memoryScopeColumns = {
  scope: memoryEntries.scope,
  ownerUserId: memoryEntries.ownerUserId,
  accountId: memoryEntries.accountId,
};

function getTzOffsetMs(utcDate: Date, tz: string): number {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(utcDate);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "0";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  const localAsUtc = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}Z`,
  );
  return localAsUtc.getTime() - utcDate.getTime();
}

export function dateToUTC(dateStr: string, tz: string): Date {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match)
    throw new Error(`Invalid date format: "${dateStr}", expected YYYY-MM-DD`);

  const midnightUtc = new Date(`${dateStr}T00:00:00Z`);
  const offset1 = getTzOffsetMs(midnightUtc, tz);
  const candidate = new Date(midnightUtc.getTime() - offset1);
  const offset2 = getTzOffsetMs(candidate, tz);

  if (offset1 !== offset2) {
    return new Date(midnightUtc.getTime() - offset2);
  }
  return candidate;
}

export interface UnifiedSearchOptions {
  query: string;
  limit?: number;
  layer?: MemoryLayer;
  source?: string;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  queryTag?: string;
  minLinks?: number;
  maxLinks?: number;
  minContentLength?: number;
  maxContentLength?: number;
  recalledBefore?: string;
  recalledAfter?: string;
  minRecallCount?: number;
  maxRecallCount?: number;
  hasTitle?: boolean;
  hasSummary?: boolean;
  hasDeletionScheduled?: boolean;
  deletionExpired?: boolean;
  createdBefore?: string;
  createdAfter?: string;
  updatedBefore?: string;
  updatedAfter?: string;
  sortBy?: "createdAt" | "contentLength" | "linkCount" | "recallCount";
  sortOrder?: "asc" | "desc";
  offset?: number;
  archiveMode?: boolean;
}

export type RetrievalPath = "semantic" | "temporal" | "causal" | "contrastive";

export interface TopSourceRef {
  sourceType: string;
  sourceId: string;
  relationship: string;
  strength: number;
  context: string;
  quote: string | null;
}

export interface EnrichedMetadata {
  linkCount: number;
  recallCount: number;
  recalledAt: string | null;
  contentLength: number;
  deletionScheduled: string | null;
  deletionReason: string | null;
  sourceStrength: number;
  topSourceRefs: TopSourceRef[];
}

export interface UnifiedSearchResult {
  entry: MemoryEntry;
  score: number;
  embeddingSim: number;
  tagSim: number;
  titleSim: number;
  textMatch: boolean;
  graphHop: number | null;
  graphLinkStrength: number | null;
  retrievalPath?: RetrievalPath[];
  enriched?: EnrichedMetadata;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function fuzzyWordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  let dist = 0;
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
  dist = matrix[a.length][b.length];
  return 1 - dist / maxLen;
}

function fuzzyBestMatch(item: string, candidates: string[]): number {
  if (candidates.length === 0) return 0;
  let best = 0;
  for (const c of candidates) {
    const sim = fuzzyWordSimilarity(item, c);
    if (sim > best) best = sim;
    if (best === 1) break;
  }
  return best;
}

function fuzzySetSimilarity(setA: string[], setB: string[]): number {
  if (setA.length === 0 || setB.length === 0) return 0;
  let sumA = 0;
  for (const a of setA) sumA += fuzzyBestMatch(a, setB);
  let sumB = 0;
  for (const b of setB) sumB += fuzzyBestMatch(b, setA);
  return (sumA + sumB) / (setA.length + setB.length);
}

function computeTagSimilarity(
  queryTags: string[],
  entryTags: string[],
): number {
  const a = queryTags.map((t) => t.toLowerCase());
  const b = entryTags.map((t) => t.toLowerCase());
  return fuzzySetSimilarity(a, b);
}

function computeTitleSimilarity(
  queryWords: string[],
  entryTitle: string,
): number {
  if (!entryTitle) return 0;
  const titleWords = tokenize(entryTitle);
  if (titleWords.length === 0) return 0;
  return fuzzySetSimilarity(queryWords, titleWords);
}

const WEIGHT_EMBEDDING = 0.38;
const WEIGHT_TOPIC = 0.18;
const WEIGHT_TITLE = 0.16;
const WEIGHT_SUMMARY = 0.16;
const WEIGHT_CONTENT = 0.12;

function computeFieldSimilarity(queryWords: string[], text: string | null | undefined): number {
  if (!text) return 0;
  const words = tokenize(text);
  if (words.length === 0) return 0;
  return fuzzySetSimilarity(queryWords, words.slice(0, 240));
}

function computeConfidenceFactor(metadata: Record<string, unknown>): number {
  const raw = metadata.confidence ?? metadata.confidenceScore ?? metadata.confidence_score;
  const confidence = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 0.7;
  if (!Number.isFinite(confidence)) return 1;
  return 0.75 + Math.max(0, Math.min(1, confidence)) * 0.35;
}

function computeStageFactor(stage: string | null | undefined, layer: MemoryLayer): number {
  switch (stage) {
    case "stage_4": return 1.22;
    case "stage_3": return 1.16;
    case "stage_2": return 1.08;
    case "stage_1": return 0.95;
    case "stage_0": return 0.78;
    default:
      return layer === "long" ? 1.14 : layer === "mid" ? 1.06 : layer === "short" ? 0.86 : 0.9;
  }
}

function computeProcessedFreshnessFactor(entry: Pick<MemoryEntry, "processedAt" | "createdAt">): number {
  const basis = entry.processedAt ?? entry.createdAt;
  if (!basis) return 0.95;
  const ageDays = Math.max(0, (Date.now() - new Date(basis).getTime()) / 86_400_000);
  return 0.85 + 0.25 / (1 + ageDays / 90);
}

function computeSourceStrengthFactor(sourceStrength: number): number {
  const bounded = Math.max(0, Math.min(1, sourceStrength || 0));
  return 0.9 + bounded * 0.2;
}

function isRawSourceEntry(entry: MemoryEntry): boolean {
  const meta = (entry.metadata || {}) as Record<string, unknown>;
  if (meta.mirrorKind === "session_summary") return false;
  if (["chat", "voice_session"].includes(entry.source)) return true;
  if (entry.source === "conversation") {
    const tags = (entry.tags || []) as string[];
    return String(entry.sourceId || "").startsWith("exchange-") || tags.includes("exchange");
  }
  return entry.integrationStage === "stage_0" && entry.layer === "short";
}

function computeHybridScore(
  entry: MemoryEntry,
  embeddingSim: number,
  topicSim: number,
  titleSim: number,
  summarySim: number,
  contentSim: number,
  textMatch: boolean,
  hasEmbedding: boolean,
  sourceStrength: number,
): number {
  const lexicalScore = hasEmbedding
    ? WEIGHT_EMBEDDING * embeddingSim + WEIGHT_TOPIC * topicSim + WEIGHT_TITLE * titleSim + WEIGHT_SUMMARY * summarySim + WEIGHT_CONTENT * Math.max(contentSim, textMatch ? 0.7 : 0)
    : 0.25 * topicSim + 0.25 * titleSim + 0.3 * summarySim + 0.2 * Math.max(contentSim, textMatch ? 0.7 : 0);
  const meta = (entry.metadata || {}) as Record<string, unknown>;
  return lexicalScore
    * computeConfidenceFactor(meta)
    * computeStageFactor(entry.integrationStage, entry.layer)
    * computeProcessedFreshnessFactor(entry)
    * computeSourceStrengthFactor(sourceStrength);
}

function hasStructuredFilters(options: UnifiedSearchOptions): boolean {
  return !!(
    options.minLinks !== undefined ||
    options.maxLinks !== undefined ||
    options.minContentLength !== undefined ||
    options.maxContentLength !== undefined ||
    options.recalledBefore ||
    options.recalledAfter ||
    options.minRecallCount !== undefined ||
    options.maxRecallCount !== undefined ||
    options.hasTitle !== undefined ||
    options.hasSummary !== undefined ||
    options.hasDeletionScheduled !== undefined ||
    options.deletionExpired !== undefined ||
    options.createdBefore ||
    options.createdAfter ||
    options.updatedBefore ||
    options.updatedAfter
  );
}

function buildStructuredConditions(
  options: UnifiedSearchOptions,
): ReturnType<typeof sql>[] {
  const conditions: ReturnType<typeof sql>[] = [];

  if (options.minContentLength !== undefined) {
    conditions.push(
      sql`char_length(${memoryEntries.content}) >= ${options.minContentLength}`,
    );
  }
  if (options.maxContentLength !== undefined) {
    conditions.push(
      sql`char_length(${memoryEntries.content}) <= ${options.maxContentLength}`,
    );
  }
  if (options.hasTitle === true) {
    conditions.push(
      sql`${memoryEntries.title} IS NOT NULL AND ${memoryEntries.title} != ''`,
    );
  }
  if (options.hasTitle === false) {
    conditions.push(
      sql`(${memoryEntries.title} IS NULL OR ${memoryEntries.title} = '')`,
    );
  }
  if (options.hasSummary === true) {
    conditions.push(
      sql`${memoryEntries.summary} IS NOT NULL AND ${memoryEntries.summary} != ''`,
    );
  }
  if (options.hasSummary === false) {
    conditions.push(
      sql`(${memoryEntries.summary} IS NULL OR ${memoryEntries.summary} = '')`,
    );
  }
  if (options.hasDeletionScheduled === true) {
    conditions.push(
      sql`${memoryEntries.metadata}->>'deletionScheduled' IS NOT NULL`,
    );
  }
  if (options.hasDeletionScheduled === false) {
    conditions.push(
      sql`${memoryEntries.metadata}->>'deletionScheduled' IS NULL`,
    );
  }
  if (options.deletionExpired === true) {
    conditions.push(
      sql`${memoryEntries.metadata}->>'deletionScheduled' IS NOT NULL AND (${memoryEntries.metadata}->>'deletionScheduled')::timestamptz <= NOW()`,
    );
  }
  if (options.recalledBefore) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM memory_events me
      WHERE me.entry_id = ${memoryEntries.id}
        AND me.event_type = 'recalled'
        AND me.created_at < ${options.recalledBefore}::timestamptz
    )`);
  }
  if (options.recalledAfter) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM memory_events me
      WHERE me.entry_id = ${memoryEntries.id}
        AND me.event_type = 'recalled'
        AND me.created_at >= ${options.recalledAfter}::timestamptz
    )`);
  }
  if (options.minRecallCount !== undefined) {
    conditions.push(sql`(
      SELECT COUNT(*) FROM memory_events me
      WHERE me.entry_id = ${memoryEntries.id}
        AND me.event_type = 'recalled'
    ) >= ${options.minRecallCount}`);
  }
  if (options.maxRecallCount !== undefined) {
    conditions.push(sql`(
      SELECT COUNT(*) FROM memory_events me
      WHERE me.entry_id = ${memoryEntries.id}
        AND me.event_type = 'recalled'
    ) <= ${options.maxRecallCount}`);
  }
  if (options.createdBefore) {
    conditions.push(
      sql`${memoryEntries.createdAt} < ${options.createdBefore}::timestamptz`,
    );
  }
  if (options.createdAfter) {
    conditions.push(
      sql`${memoryEntries.createdAt} >= ${options.createdAfter}::timestamptz`,
    );
  }
  if (options.updatedBefore) {
    conditions.push(
      sql`${memoryEntries.processedAt} IS NOT NULL AND ${memoryEntries.processedAt} < ${options.updatedBefore}::timestamptz`,
    );
  }
  if (options.updatedAfter) {
    conditions.push(
      sql`${memoryEntries.processedAt} IS NOT NULL AND ${memoryEntries.processedAt} >= ${options.updatedAfter}::timestamptz`,
    );
  }
  if (options.minLinks !== undefined) {
    conditions.push(
      sql`(SELECT COUNT(*) FROM memory_links ml WHERE ml.from_id = ${memoryEntries.id} OR ml.to_id = ${memoryEntries.id}) >= ${options.minLinks}`,
    );
  }
  if (options.maxLinks !== undefined) {
    conditions.push(
      sql`(SELECT COUNT(*) FROM memory_links ml WHERE ml.from_id = ${memoryEntries.id} OR ml.to_id = ${memoryEntries.id}) <= ${options.maxLinks}`,
    );
  }

  return conditions;
}

function buildSortClause(
  sortBy?: string,
  sortOrder?: string,
): ReturnType<typeof sql> {
  const dir = sortOrder === "asc" ? sql`ASC` : sql`DESC`;
  switch (sortBy) {
    case "contentLength":
      return sql`char_length(content) ${dir}`;
    case "linkCount":
      return sql`(SELECT COUNT(*) FROM memory_links ml WHERE ml.from_id = memory_entries.id OR ml.to_id = memory_entries.id) ${dir}`;
    case "recallCount":
      return sql`(SELECT COUNT(*) FROM memory_events me WHERE me.entry_id = memory_entries.id AND me.event_type = 'recalled') ${dir}`;
    case "createdAt":
    default:
      return sql`created_at ${dir}`;
  }
}

function applyPostEnrichmentFilters(
  results: UnifiedSearchResult[],
  options: UnifiedSearchOptions,
): UnifiedSearchResult[] {
  return results.filter((r) => {
    const enriched = r.enriched;
    if (!enriched) return true;
    if (options.minLinks !== undefined && enriched.linkCount < options.minLinks)
      return false;
    if (options.maxLinks !== undefined && enriched.linkCount > options.maxLinks)
      return false;
    if (
      options.minContentLength !== undefined &&
      enriched.contentLength < options.minContentLength
    )
      return false;
    if (
      options.maxContentLength !== undefined &&
      enriched.contentLength > options.maxContentLength
    )
      return false;
    if (
      options.minRecallCount !== undefined &&
      enriched.recallCount < options.minRecallCount
    )
      return false;
    if (
      options.maxRecallCount !== undefined &&
      enriched.recallCount > options.maxRecallCount
    )
      return false;
    if (
      options.recalledBefore &&
      enriched.recalledAt &&
      enriched.recalledAt >= options.recalledBefore
    )
      return false;
    if (
      options.recalledAfter &&
      (!enriched.recalledAt || enriched.recalledAt < options.recalledAfter)
    )
      return false;
    if (options.hasTitle === true && !r.entry.title) return false;
    if (options.hasTitle === false && r.entry.title) return false;
    if (options.hasSummary === true && !r.entry.summary) return false;
    if (options.hasSummary === false && r.entry.summary) return false;
    if (options.hasDeletionScheduled === true && !enriched.deletionScheduled)
      return false;
    if (options.hasDeletionScheduled === false && enriched.deletionScheduled)
      return false;
    if (options.deletionExpired === true) {
      if (!enriched.deletionScheduled) return false;
      if (new Date(enriched.deletionScheduled) > new Date()) return false;
    }
    if (
      options.createdBefore &&
      r.entry.createdAt &&
      new Date(r.entry.createdAt) >= new Date(options.createdBefore)
    )
      return false;
    if (
      options.createdAfter &&
      r.entry.createdAt &&
      new Date(r.entry.createdAt) < new Date(options.createdAfter)
    )
      return false;
    if (
      options.updatedBefore &&
      r.entry.processedAt &&
      new Date(r.entry.processedAt) >= new Date(options.updatedBefore)
    )
      return false;
    if (
      options.updatedAfter &&
      (!r.entry.processedAt ||
        new Date(r.entry.processedAt) < new Date(options.updatedAfter))
    )
      return false;
    return true;
  });
}

async function enrichResults(results: UnifiedSearchResult[]): Promise<void> {
  if (results.length === 0) return;
  const ids = results.map((r) => r.entry.id);
  const idsLiteral = `{${ids.join(",")}}`;

  const linkCounts = await db.execute(sql`
    SELECT entry_id, COUNT(*) AS cnt FROM (
      SELECT from_id AS entry_id FROM memory_links WHERE from_id = ANY(${idsLiteral}::int[])
      UNION ALL
      SELECT to_id AS entry_id FROM memory_links WHERE to_id = ANY(${idsLiteral}::int[])
    ) sub GROUP BY entry_id
  `);
  const linkMap = new Map<number, number>();
  for (const row of linkCounts.rows as Array<{
    entry_id: number;
    cnt: string;
  }>) {
    linkMap.set(row.entry_id, parseInt(row.cnt, 10));
  }

  const recallCounts = await db.execute(sql`
    SELECT entry_id, COUNT(*) AS cnt FROM memory_events
    WHERE entry_id = ANY(${idsLiteral}::int[]) AND event_type = 'recalled'
    GROUP BY entry_id
  `);
  const recallMap = new Map<number, number>();
  for (const row of recallCounts.rows as Array<{
    entry_id: number;
    cnt: string;
  }>) {
    recallMap.set(row.entry_id, parseInt(row.cnt, 10));
  }

  const sourceRows = await db
    .select({
      memoryId: memorySourceRefs.memoryId,
      sourceType: memorySourceRefs.sourceType,
      sourceId: memorySourceRefs.sourceId,
      relationship: memorySourceRefs.relationship,
      strength: memorySourceRefs.strength,
      context: memorySourceRefs.context,
      quote: memorySourceRefs.quote,
    })
    .from(memorySourceRefs)
    .where(
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        {
          scope: memorySourceRefs.scope,
          ownerUserId: memorySourceRefs.ownerUserId,
          accountId: memorySourceRefs.accountId,
        },
        and(
          inArray(memorySourceRefs.memoryId, ids),
          ne(memorySourceRefs.sourceType, "raw_system"),
        ),
      ),
    );
  const sourceMap = new Map<number, TopSourceRef[]>();
  for (const row of sourceRows) {
    const refs = sourceMap.get(row.memoryId) ?? [];
    refs.push({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      relationship: row.relationship,
      strength: Number(row.strength ?? 0),
      context: row.context || "",
      quote: row.quote ?? null,
    });
    sourceMap.set(row.memoryId, refs);
  }
  for (const refs of sourceMap.values()) {
    refs.sort((a, b) => b.strength - a.strength);
  }

  for (const r of results) {
    const meta = (r.entry.metadata || {}) as Record<string, unknown>;
    r.enriched = {
      linkCount: linkMap.get(r.entry.id) || 0,
      recallCount: recallMap.get(r.entry.id) || 0,
      recalledAt: (meta.recalledAt as string) || null,
      contentLength: (r.entry.content || "").length,
      deletionScheduled: (meta.deletionScheduled as string) || null,
      deletionReason: (meta.deletionReason as string) || null,
      sourceStrength: Math.max(0, ...(sourceMap.get(r.entry.id) ?? []).map((ref) => ref.strength)),
      topSourceRefs: (sourceMap.get(r.entry.id) ?? []).slice(0, 3),
    };
  }
}

export async function unifiedMemorySearch(
  options: UnifiedSearchOptions,
): Promise<UnifiedSearchResult[]> {
  const {
    query,
    limit = 20,
    layer,
    source,
    startDate,
    endDate,
    timezone,
    queryTag,
    archiveMode = false,
  } = options;

  if (!query || !query.trim()) {
    log.log("unifiedMemorySearch called with empty query, returning []");
    return [];
  }

  const tz = timezone || getTimezone();
  let startUTC: Date | undefined;
  let endUTC: Date | undefined;
  if (startDate) startUTC = dateToUTC(startDate, tz);
  if (endDate) endUTC = dateToUTC(endDate, tz);

  const isWildcard = query.trim() === "*";
  const hasFilters = hasStructuredFilters(options);

  if (isWildcard && !startUTC && !endUTC && !hasFilters && !layer && !source) {
    log.log(
      "unifiedMemorySearch wildcard query without any filters, returning []",
    );
    return [];
  }

  const startTime = Date.now();

  log.log(
    `unifiedMemorySearch query="${query.slice(0, 80)}" limit=${limit} layer=${layer || "all"} source=${source || "all"} startDate=${startDate || "none"} endDate=${endDate || "none"} tz=${tz} wildcard=${isWildcard} hasFilters=${hasFilters}`,
  );

  if (isWildcard) {
    const conditions: ReturnType<typeof sql>[] = [
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        memoryScopeColumns,
        sql`TRUE`,
      ),
    ];
    if (layer) conditions.push(sql`${memoryEntries.layer} = ${layer}`);
    if (source) conditions.push(sql`${memoryEntries.source} = ${source}`);
    if (!archiveMode) conditions.push(memoryKnowledgeEligibleCondition());
    if (startUTC)
      conditions.push(sql`${memoryEntries.createdAt} >= ${startUTC}`);
    if (endUTC) conditions.push(sql`${memoryEntries.createdAt} < ${endUTC}`);
    conditions.push(...buildStructuredConditions(options));

    const sortClause = buildSortClause(options.sortBy, options.sortOrder);
    const offsetVal = options.offset || 0;

    const entries = await db.execute(sql`
      SELECT id, layer, integration_stage, content, summary, content_hash, source, source_id, path, title, one_liner, metadata, tags, graphed, pinned, created_at, processed_at FROM memory_entries
      ${conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``}
      ORDER BY ${sortClause}
      LIMIT ${limit} OFFSET ${offsetVal}
    `);

    log.log(
      `unifiedMemorySearch wildcard returned ${entries.rows.length} entries in ${Date.now() - startTime}ms`,
    );

    const results: UnifiedSearchResult[] = (entries.rows as any[]).map(
      (row: any) => ({
        entry: mapRawRowToEntry(row),
        score: 1.0,
        embeddingSim: 0,
        tagSim: 0,
        titleSim: 0,
        textMatch: false,
        graphHop: null,
        graphLinkStrength: null,
      }),
    );

    await enrichResults(results);
    return results;
  }

  const queryWords = tokenize(query);
  const embeddingsAvailable = isEmbeddingsAvailable();

  const resultMap = new Map<
    number,
    {
      entry: MemoryEntry;
      embeddingSim: number;
      textMatch: boolean;
    }
  >();

  const semanticPromise = embeddingsAvailable
    ? generateEmbedding(query)
        .then((embedding) => {
          if (!embedding || embedding.length === 0) {
            log.warn(
              "Embedding generation returned empty vector, skipping semantic search",
            );
            return null;
          }
          return executeSemanticSearch(
            embedding,
            limit * 2,
            layer,
            startUTC,
            endUTC,
            queryTag,
            { archiveMode },
          ).then((results) => ({ embedding, results }));
        })
        .catch((err) => {
          log.warn(
            `Semantic search failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        })
    : Promise.resolve(null);

  const textConditions = [
    combineWithVisibleScope(
      getCurrentPrincipalOrSystem(),
      memoryScopeColumns,
      sql`TRUE`,
    ),
    or(
      ilike(memoryEntries.content, `%${query}%`),
      ilike(memoryEntries.title, `%${query}%`),
      sql`${memoryEntries.summary} ILIKE ${"%" + query + "%"}`,
      sql`${memoryEntries.oneLiner} ILIKE ${"%" + query + "%"}`,
      sql`EXISTS (SELECT 1 FROM unnest(${memoryEntries.tags}) AS tag WHERE tag ILIKE ${"%" + query + "%"})`,
    ),
  ];
  if (layer) textConditions.push(eq(memoryEntries.layer, layer));
  if (!archiveMode) textConditions.push(memoryKnowledgeEligibleCondition());
  if (startUTC) textConditions.push(gte(memoryEntries.createdAt, startUTC));
  if (endUTC) textConditions.push(lt(memoryEntries.createdAt, endUTC));
  if (hasFilters) textConditions.push(...buildStructuredConditions(options));

  const textPromise = db
    .select(memoryEntryLightColumns)
    .from(memoryEntries)
    .where(and(...textConditions))
    .limit(limit * 2)
    .then((rows) =>
      rows.map((r) => wrapLightEntry(r as Omit<MemoryEntry, "embedding">)),
    )
    .catch((err) => {
      log.warn(
        `Text search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as MemoryEntry[];
    });

  const [semanticResult, textResults] = await Promise.all([
    semanticPromise,
    textPromise,
  ]);

  let queryEmbedding: number[] | null = null;

  if (semanticResult) {
    queryEmbedding = semanticResult.embedding;
    for (const { row, similarity } of semanticResult.results) {
      const entry = mapRawRowToEntry(row);
      if (!archiveMode && isRawSourceEntry(entry)) continue;
      resultMap.set(entry.id, {
        entry,
        embeddingSim: similarity,
        textMatch: false,
      });
    }
  }

  for (const entry of textResults) {
    if (!archiveMode && isRawSourceEntry(entry)) continue;
    const existing = resultMap.get(entry.id);
    if (existing) {
      existing.textMatch = true;
    } else {
      resultMap.set(entry.id, { entry, embeddingSim: 0, textMatch: true });
    }
  }

  log.log(
    `unifiedMemorySearch merge: semantic=${semanticResult?.results.length ?? 0} text=${textResults.length} unique=${resultMap.size}`,
  );

  let scored: UnifiedSearchResult[] = [];
  const hasEmbedding = queryEmbedding !== null;
  const sourceStrengthByMemoryId = new Map<number, number>();
  const candidateIds = [...resultMap.keys()];
  if (candidateIds.length > 0) {
    try {
      const rows = await db
        .select({ memoryId: memorySourceRefs.memoryId, maxStrength: sql<number>`MAX(${memorySourceRefs.strength})` })
        .from(memorySourceRefs)
        .where(
          combineWithVisibleScope(
            getCurrentPrincipalOrSystem(),
            {
              scope: memorySourceRefs.scope,
              ownerUserId: memorySourceRefs.ownerUserId,
              accountId: memorySourceRefs.accountId,
            },
            inArray(memorySourceRefs.memoryId, candidateIds),
          ),
        )
        .groupBy(memorySourceRefs.memoryId);
      for (const row of rows) sourceStrengthByMemoryId.set(row.memoryId, Number(row.maxStrength ?? 0));
    } catch (err) {
      log.warn(`Source strength lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const { entry, embeddingSim, textMatch } of resultMap.values()) {
    if (source && entry.source !== source) continue;

    const entryTags = (entry.tags || []) as string[];
    const tagSim = computeTagSimilarity(queryWords, entryTags);
    const titleSim = computeTitleSimilarity(queryWords, entry.title || "");
    const summarySim = Math.max(
      computeFieldSimilarity(queryWords, entry.summary),
      computeFieldSimilarity(queryWords, entry.oneLiner),
    );
    const contentSim = computeFieldSimilarity(queryWords, entry.content);
    const meta = (entry.metadata || {}) as Record<string, unknown>;
    const decayScore = Number(meta.decay_score ?? 1.0);
    const score = computeHybridScore(
      entry,
      embeddingSim,
      tagSim,
      titleSim,
      summarySim,
      contentSim,
      textMatch,
      hasEmbedding,
      sourceStrengthByMemoryId.get(entry.id) ?? 0,
    ) * decayScore;

    scored.push({
      entry,
      score,
      embeddingSim,
      tagSim,
      titleSim,
      textMatch,
      graphHop: null,
      graphLinkStrength: null,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  if (queryEmbedding && scored.length > 0) {
    const seedEntries = scored.filter((r) => r.embeddingSim > 0).slice(0, 5);

    if (seedEntries.length > 0) {
      const existingIds = new Set(scored.map((r) => r.entry.id));
      const seedIds = new Set(seedEntries.map((r) => r.entry.id));

      try {
        const HOP_DECAY = 0.6;
        const neighborMap = new Map<
          number,
          { hop: number; strength: number; relationship: string }
        >();

        for (const seed of seedEntries) {
          const cache = getNeighborhoodCache(seed.entry);
          if (!cache) continue;

          for (const neighbor of cache.entries) {
            const hopDecay = Math.pow(HOP_DECAY, neighbor.hop);
            const neighborScore = neighbor.strength * hopDecay;

            const existing = neighborMap.get(neighbor.id);
            if (
              !existing ||
              neighborScore >
                existing.strength * Math.pow(HOP_DECAY, existing.hop)
            ) {
              neighborMap.set(neighbor.id, {
                hop: neighbor.hop,
                strength: neighbor.strength,
                relationship: neighbor.relationship,
              });
            }
          }
        }

        const neighborIdsToFetch: number[] = [];
        for (const [id] of neighborMap) {
          if (!seedIds.has(id)) {
            neighborIdsToFetch.push(id);
          }
        }

        let neighborEntries: MemoryEntry[] = [];
        if (neighborIdsToFetch.length > 0) {
          const neighborRows = await db
            .select(memoryEntryLightColumns)
            .from(memoryEntries)
            .where(
              combineWithVisibleScope(
                getCurrentPrincipalOrSystem(),
                memoryScopeColumns,
                and(
                  inArray(memoryEntries.id, neighborIdsToFetch),
                  ...(!archiveMode ? [memoryKnowledgeEligibleCondition()] : []),
                ),
              ),
            );
          neighborEntries = neighborRows.map((r) =>
            wrapLightEntry(r as Omit<MemoryEntry, "embedding">),
          );
        }

        let graphAdded = 0;
        for (const entry of neighborEntries) {
          if (source && entry.source !== source) continue;
          if (!archiveMode && isRawSourceEntry(entry)) continue;
          if (layer && entry.layer !== layer) continue;
          if (startUTC && entry.createdAt < startUTC) continue;
          if (endUTC && entry.createdAt >= endUTC) continue;

          const info = neighborMap.get(entry.id);
          if (!info) continue;

          const hopDecay = Math.pow(HOP_DECAY, info.hop);
          const graphScore = info.strength
            * hopDecay
            * 0.5
            * computeStageFactor(entry.integrationStage, entry.layer)
            * computeProcessedFreshnessFactor(entry);

          if (existingIds.has(entry.id)) {
            const existingResult = scored.find((r) => r.entry.id === entry.id);
            if (existingResult) {
              existingResult.score = Math.max(existingResult.score, graphScore);
              existingResult.graphHop = info.hop;
              existingResult.graphLinkStrength = info.strength;
            }
          } else {
            const entryTags = (entry.tags || []) as string[];
            const tagSim = computeTagSimilarity(queryWords, entryTags);
            const titleSim = computeTitleSimilarity(
              queryWords,
              entry.title || "",
            );

            scored.push({
              entry,
              score: graphScore,
              embeddingSim: 0,
              tagSim,
              titleSim,
              textMatch: false,
              graphHop: info.hop,
              graphLinkStrength: info.strength,
            });
            graphAdded++;
          }
        }

        log.log(
          `unifiedMemorySearch graph cache: seeds=${seedEntries.length} neighbors=${neighborMap.size} fetched=${neighborEntries.length} added=${graphAdded}`,
        );
      } catch (err) {
        log.warn(
          `Graph cache read failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  let final = scored.slice(0, hasFilters || options.sortBy ? limit * 2 : limit);

  await enrichResults(final);

  if (hasFilters) {
    final = applyPostEnrichmentFilters(final, options);
  }

  if (options.sortBy) {
    const dir = options.sortOrder === "asc" ? 1 : -1;
    final.sort((a, b) => {
      let av: number, bv: number;
      switch (options.sortBy) {
        case "contentLength":
          av = a.enriched?.contentLength ?? 0;
          bv = b.enriched?.contentLength ?? 0;
          break;
        case "linkCount":
          av = a.enriched?.linkCount ?? 0;
          bv = b.enriched?.linkCount ?? 0;
          break;
        case "recallCount":
          av = a.enriched?.recallCount ?? 0;
          bv = b.enriched?.recallCount ?? 0;
          break;
        case "createdAt":
        default:
          av = a.entry.createdAt ? new Date(a.entry.createdAt).getTime() : 0;
          bv = b.entry.createdAt ? new Date(b.entry.createdAt).getTime() : 0;
          break;
      }
      return (av - bv) * dir;
    });
  }

  const offsetVal = options.offset || 0;
  final = final.slice(offsetVal, offsetVal + limit);

  const elapsed = Date.now() - startTime;
  log.log(
    `unifiedMemorySearch complete: ${final.length} results in ${elapsed}ms | top=${final[0]?.score.toFixed(3) || "n/a"} | query="${query.slice(0, 40)}"`,
  );

  if (final.length > 0) {
    log.log(
      `unifiedMemorySearch top 3: ${final
        .slice(0, 3)
        .map(
          (r) =>
            `#${r.entry.id} "${r.entry.title || "?"}" (score=${r.score.toFixed(3)} emb=${r.embeddingSim.toFixed(3)} tag=${r.tagSim.toFixed(2)} title=${r.titleSim.toFixed(2)} text=${r.textMatch} hop=${r.graphHop ?? "-"})`,
        )
        .join(", ")}`,
    );
  }

  const beliefResults = final.filter((r) => r.entry.source === "belief");
  if (beliefResults.length > 0) {
    for (const r of beliefResults) {
      memoryStorage
        .appendEvent(r.entry.id, "recalled", { source: "belief" })
        .catch((err) => {
          log.warn(
            `Failed to record belief recall for entry #${r.entry.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
    log.log(
      `unifiedMemorySearch recorded recall for ${beliefResults.length} belief entries`,
    );
  }

  return final;
}
