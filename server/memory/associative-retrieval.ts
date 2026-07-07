import { db } from "../db";
import { memoryEntries, memoryLinks, type MemoryEntry, type RelationshipType } from "@shared/schema";
import { and, inArray, gte, lte, sql, or, eq } from "drizzle-orm";
import { createLogger } from "../log";
import { unifiedMemorySearch, type UnifiedSearchResult, type RetrievalPath } from "./unified-search";
import { walkGraph } from "./graph-walker";
import { generateEmbedding, isEmbeddingsAvailable } from "./embedding";
import { memoryEntryLightColumns, wrapLightEntry } from "./memory-storage";
import pLimit from "p-limit";

const log = createLogger("AssociativeRetrieval");

export const ENABLE_ASSOCIATIVE_RETRIEVAL = process.env.ASSOCIATIVE_RETRIEVAL === "true";

const ASSOCIATIVE_DB_CONCURRENCY = 4;
const TEMPORAL_WINDOW_DAYS = 3;
const ANCHOR_LIMIT = 5;
const RECENCY_HALFLIFE_DAYS = 90;

const dbLimiter = pLimit(ASSOCIATIVE_DB_CONCURRENCY);

export interface EmotionalModulationInput {
  valence: number;  // -1 to 1
  arousal: number;  // 0 to 1
}

export interface AssociativeRetrieveOptions {
  focusText: string;
  limit: number;
  sessionTopics: string[];
  recentMessages: string[];
  emotionalState?: EmotionalModulationInput | null;
}

export interface ScoredMemory {
  entry: MemoryEntry;
  semantic: number;
  temporal: number;
  causal: number;
  contrastive: number;
  source: RetrievalPath[];
}

export interface BlendWeights {
  semantic: number;
  temporal: number;
  causal: number;
  contrastive: number;
}

export type SessionType = "strategy" | "planning" | "reflection" | "debugging" | "general";

export const STRATEGY_KEYWORDS = ["strategy", "strategic", "priority", "priorities", "goal", "goals", "vision", "mission", "direction", "alignment"];
export const PLANNING_KEYWORDS = ["plan", "planning", "schedule", "timeline", "milestone", "deadline", "roadmap", "next steps", "action items"];
export const REFLECTION_KEYWORDS = ["reflect", "reflection", "looking back", "learned", "mistake", "regret", "growth", "evolve", "changed", "used to"];
export const DEBUGGING_KEYWORDS = ["debug", "error", "bug", "issue", "broken", "fix", "crash", "fail", "wrong", "problem"];

export const BLEND_WEIGHTS: Record<SessionType, BlendWeights> = {
  strategy:   { semantic: 0.35, temporal: 0.15, causal: 0.35, contrastive: 0.15 },
  planning:   { semantic: 0.30, temporal: 0.30, causal: 0.25, contrastive: 0.15 },
  reflection: { semantic: 0.25, temporal: 0.20, causal: 0.20, contrastive: 0.35 },
  debugging:  { semantic: 0.40, temporal: 0.25, causal: 0.25, contrastive: 0.10 },
  general:    { semantic: 0.40, temporal: 0.20, causal: 0.25, contrastive: 0.15 },
};

/**
 * Apply emotional state as multiplicative modifiers to retrieval blend weights.
 * Returns normalized weights (sum = 1.0) plus a delta string for logging.
 */
export function modulateWeights(
  base: BlendWeights,
  emotion: EmotionalModulationInput | null | undefined,
): { weights: BlendWeights; modulated: boolean; deltas: string } {
  if (!emotion) return { weights: base, modulated: false, deltas: "" };

  const { valence, arousal } = emotion;
  let s = base.semantic;
  let t = base.temporal;
  let c = base.causal;
  let x = base.contrastive;

  // High arousal: boost semantic, reduce temporal
  if (arousal > 0.7) { s *= 1.2; t *= 0.8; }
  // Low arousal: boost temporal + causal, reduce semantic
  if (arousal < 0.3) { t *= 1.2; c *= 1.2; s *= 0.8; }
  // Negative valence: boost contrastive
  if (valence < -0.3) { x *= 1.3; }
  // Positive valence: boost semantic
  if (valence > 0.3) { s *= 1.1; }

  // Normalize to sum = 1.0
  const total = s + t + c + x;
  const w: BlendWeights = {
    semantic: s / total,
    temporal: t / total,
    causal: c / total,
    contrastive: x / total,
  };

  const fmt = (n: number) => n.toFixed(2);
  const deltas = `s:${fmt(base.semantic)}→${fmt(w.semantic)} t:${fmt(base.temporal)}→${fmt(w.temporal)} c:${fmt(base.causal)}→${fmt(w.causal)} x:${fmt(base.contrastive)}→${fmt(w.contrastive)} (v=${fmt(valence)} a=${fmt(arousal)})`;

  return { weights: w, modulated: true, deltas };
}

export function detectSessionType(text: string): { type: SessionType; triggerKeywords: string[] } {
  const lower = text.toLowerCase();
  const matches: Array<{ type: SessionType; keywords: string[] }> = [];

  const check = (type: SessionType, keywords: readonly string[]) => {
    const found = keywords.filter(k => lower.includes(k));
    if (found.length > 0) matches.push({ type, keywords: found });
  };

  check("strategy", STRATEGY_KEYWORDS);
  check("planning", PLANNING_KEYWORDS);
  check("reflection", REFLECTION_KEYWORDS);
  check("debugging", DEBUGGING_KEYWORDS);

  if (matches.length === 0) return { type: "general", triggerKeywords: [] };

  matches.sort((a, b) => b.keywords.length - a.keywords.length);
  const best = matches[0];
  log.log(`[AssociativeRetrieval] detectSessionType type=${best.type} triggers=[${best.keywords.join(",")}]`);
  return { type: best.type, triggerKeywords: best.keywords };
}

async function semanticRetrieve(
  focusText: string,
  limit: number
): Promise<ScoredMemory[]> {
  const start = Date.now();
  log.log(`[AssociativeRetrieval] semanticRetrieve START /* associative:semantic */ query="${focusText.slice(0, 60)}" limit=${limit}`);
  try {
    const results = await dbLimiter(() =>
      unifiedMemorySearch({ query: focusText, limit, queryTag: "associative:semantic" })
    );
    const scored: ScoredMemory[] = results.map(r => ({
      entry: r.entry,
      semantic: r.score,
      temporal: 0,
      causal: 0,
      contrastive: 0,
      source: ["semantic" as RetrievalPath],
    }));
    log.log(`[AssociativeRetrieval] semanticRetrieve DONE count=${scored.length} elapsed=${Date.now() - start}ms`);
    return scored;
  } catch (err) {
    log.warn(`[AssociativeRetrieval] semanticRetrieve ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function temporalProximity(anchorDate: Date, candidateDate: Date): number {
  const diffMs = Math.abs(anchorDate.getTime() - candidateDate.getTime());
  const diffSeconds = diffMs / 1000;
  return 1 / (1 + diffSeconds / 86400);
}

async function temporalRetrieve(
  anchors: ScoredMemory[]
): Promise<ScoredMemory[]> {
  const start = Date.now();
  const anchorSubset = anchors.slice(0, ANCHOR_LIMIT);
  log.log(`[AssociativeRetrieval] temporalRetrieve START anchors=${anchorSubset.length}`);
  try {
    if (anchorSubset.length === 0) return [];

    const anchorIds = anchorSubset.map(a => a.entry.id);
    const anchorScores = new Map(anchorSubset.map(a => [a.entry.id, a.semantic]));
    const windowMs = TEMPORAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    const windowClauses = anchorSubset.map(a => {
      const lo = new Date(a.entry.createdAt.getTime() - windowMs);
      const hi = new Date(a.entry.createdAt.getTime() + windowMs);
      return sql`(${memoryEntries.createdAt} >= ${lo} AND ${memoryEntries.createdAt} <= ${hi})`;
    });

    const coOccurringRaw = await dbLimiter(() =>
      db.select(memoryEntryLightColumns).from(memoryEntries).where(
        and(
          sql`/* associative:temporal */ TRUE`,
          or(eq(memoryEntries.layer, "mid"), eq(memoryEntries.layer, "long")),
          or(...windowClauses),
          sql`${memoryEntries.id} != ALL(${sql`ARRAY[${sql.join(anchorIds.map(id => sql`${id}`), sql`, `)}]::int[]`})`
        )
      ).limit(50)
    );
    const coOccurring = coOccurringRaw.map(r => wrapLightEntry(r as Omit<MemoryEntry, "embedding">));

    const scored: ScoredMemory[] = [];
    const seen = new Set<number>();

    for (const entry of coOccurring) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);

      let bestScore = 0;
      for (const anchor of anchorSubset) {
        const diffMs = Math.abs(anchor.entry.createdAt.getTime() - entry.createdAt.getTime());
        if (diffMs > windowMs) continue;
        const proximity = temporalProximity(anchor.entry.createdAt, entry.createdAt);
        const anchorRelevance = anchorScores.get(anchor.entry.id) || 0;
        const score = anchorRelevance * proximity;
        if (score > bestScore) bestScore = score;
      }

      if (bestScore > 0.05) {
        scored.push({
          entry,
          semantic: 0,
          temporal: bestScore,
          causal: 0,
          contrastive: 0,
          source: ["temporal" as RetrievalPath],
        });
      }
    }

    log.log(`[AssociativeRetrieval] temporalRetrieve DONE count=${scored.length} elapsed=${Date.now() - start}ms`);
    return scored;
  } catch (err) {
    log.warn(`[AssociativeRetrieval] temporalRetrieve ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export const CAUSAL_RELATIONSHIP_TYPES: RelationshipType[] = ["causal", "supports", "blocks", "depends_on", "led_to", "contradicts"];
const CAUSAL_TYPE_WEIGHTS: Record<string, number> = {
  causal: 1.0, blocks: 1.0, supports: 0.8,
  depends_on: 0.8, led_to: 1.0, contradicts: 0.8, related: 0.5,
};

async function causalRetrieve(
  anchors: ScoredMemory[],
  focusEmbedding: number[] | null
): Promise<ScoredMemory[]> {
  const start = Date.now();
  const anchorSubset = anchors.slice(0, ANCHOR_LIMIT);
  log.log(`[AssociativeRetrieval] causalRetrieve START /* associative:causal */ anchors=${anchorSubset.length}`);
  try {
    if (anchorSubset.length === 0 || !focusEmbedding) return [];

    const seedIds = anchorSubset.map(a => a.entry.id);
    const anchorScores = new Map(anchorSubset.map(a => [a.entry.id, a.semantic]));

    const ranked = await dbLimiter(() =>
      walkGraph({
        seedEntryIds: seedIds,
        focusEmbedding,
        maxHops: 2,
        minRelevance: 0.2,
        maxResults: 20,
        relationshipTypes: CAUSAL_RELATIONSHIP_TYPES,
        queryTag: "associative:causal",
      })
    );

    const scored: ScoredMemory[] = ranked.map(r => {
      const hopDecay = Math.pow(0.6, r.hop);
      const typeWeight = CAUSAL_TYPE_WEIGHTS[r.linkRelationshipType || "related"] || 0.5;
      const anchorRelevance = Math.max(...seedIds.map(id => anchorScores.get(id) || 0));
      const score = anchorRelevance * r.linkStrength * hopDecay * typeWeight;
      return {
        entry: r.entry,
        semantic: 0,
        temporal: 0,
        causal: score,
        contrastive: 0,
        source: ["causal" as RetrievalPath],
      };
    });

    log.log(`[AssociativeRetrieval] causalRetrieve DONE count=${scored.length} elapsed=${Date.now() - start}ms`);
    return scored;
  } catch (err) {
    log.warn(`[AssociativeRetrieval] causalRetrieve ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function computeTagOverlap(tagsA: string[], tagsB: string[]): number {
  if (tagsA.length === 0 || tagsB.length === 0) return 0;
  const setA = new Set(tagsA.map(t => t.toLowerCase()));
  const setB = new Set(tagsB.map(t => t.toLowerCase()));
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

async function contrastiveRetrieve(
  anchors: ScoredMemory[],
  queryEmbedding: number[] | null
): Promise<ScoredMemory[]> {
  const start = Date.now();
  log.log(`[AssociativeRetrieval] contrastiveRetrieve START anchors=${anchors.length}`);
  try {
    if (anchors.length === 0) return [];

    const anchorTags = [...new Set(anchors.flatMap(a => (a.entry.tags || []) as string[]))];
    if (anchorTags.length === 0 && !queryEmbedding) return [];

    const scored: ScoredMemory[] = [];
    const anchorIds = new Set(anchors.map(a => a.entry.id));

    if (anchorTags.length > 0) {
      const tagCandidatesRaw = await dbLimiter(() =>
        db.select(memoryEntryLightColumns).from(memoryEntries).where(
          and(
            sql`/* associative:contrastive */ TRUE`,
            sql`${memoryEntries.tags} && ${sql`ARRAY[${sql.join(anchorTags.map(t => sql`${t}`), sql`, `)}]::text[]`}`,
            sql`${memoryEntries.id} != ALL(${sql`ARRAY[${sql.join([...anchorIds].map(id => sql`${id}`), sql`, `)}]::int[]`})`
          )
        ).limit(30)
      );
      const tagCandidates = tagCandidatesRaw.map(r => wrapLightEntry(r as Omit<MemoryEntry, "embedding">));

      const now = new Date();
      for (const entry of tagCandidates) {
        const entryTags = (entry.tags || []) as string[];
        const tagOverlap = computeTagOverlap(anchorTags, entryTags);
        if (tagOverlap < 0.1) continue;

        const embeddingSim = 0.5;

        const contrastiveScore = tagOverlap * embeddingSim * (1 - embeddingSim);
        const daysSince = (now.getTime() - entry.createdAt.getTime()) / (1000 * 60 * 60 * 24);
        const recencyBoost = 1 / (1 + daysSince / RECENCY_HALFLIFE_DAYS);

        scored.push({
          entry,
          semantic: 0,
          temporal: 0,
          causal: 0,
          contrastive: contrastiveScore * recencyBoost,
          source: ["contrastive" as RetrievalPath],
        });
      }
    }

    const contradictIds = anchors.slice(0, ANCHOR_LIMIT).map(a => a.entry.id);
    if (contradictIds.length > 0) {
      const contradictLinks = await dbLimiter(() =>
        db.select().from(memoryLinks).where(
          and(
            sql`/* associative:contrastive */ TRUE`,
            or(
              inArray(memoryLinks.fromId, contradictIds),
              inArray(memoryLinks.toId, contradictIds)
            ),
            or(
              eq(memoryLinks.relationshipType, "contradicts"),
              eq(memoryLinks.relationshipType, "evolves")
            )
          )
        ).limit(20)
      );

      const linkedIds = new Set<number>();
      for (const link of contradictLinks) {
        const peerId = contradictIds.includes(link.fromId) ? link.toId : link.fromId;
        if (!anchorIds.has(peerId)) linkedIds.add(peerId);
      }

      if (linkedIds.size > 0) {
        const linkedEntriesRaw = await dbLimiter(() =>
          db.select(memoryEntryLightColumns).from(memoryEntries).where(
            inArray(memoryEntries.id, [...linkedIds])
          )
        );
        const linkedEntries = linkedEntriesRaw.map(r => wrapLightEntry(r as Omit<MemoryEntry, "embedding">));

        const existing = new Set(scored.map(s => s.entry.id));
        const now = new Date();
        for (const entry of linkedEntries) {
          if (existing.has(entry.id)) continue;
          const daysSince = (now.getTime() - entry.createdAt.getTime()) / (1000 * 60 * 60 * 24);
          const recencyBoost = 1 / (1 + daysSince / RECENCY_HALFLIFE_DAYS);
          scored.push({
            entry,
            semantic: 0,
            temporal: 0,
            causal: 0,
            contrastive: 0.5 * recencyBoost,
            source: ["contrastive" as RetrievalPath],
          });
        }
      }
    }

    log.log(`[AssociativeRetrieval] contrastiveRetrieve DONE count=${scored.length} elapsed=${Date.now() - start}ms`);
    return scored;
  } catch (err) {
    log.warn(`[AssociativeRetrieval] contrastiveRetrieve ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function normalizeScores(values: number[]): number[] {
  const max = Math.max(...values, 0.001);
  return values.map(v => v / max);
}

export function blendScores(
  allResults: ScoredMemory[],
  weights: BlendWeights,
  limit: number
): UnifiedSearchResult[] {
  if (allResults.length === 0) return [];

  const merged = new Map<number, ScoredMemory>();
  for (const r of allResults) {
    const existing = merged.get(r.entry.id);
    if (existing) {
      existing.semantic = Math.max(existing.semantic, r.semantic);
      existing.temporal = Math.max(existing.temporal, r.temporal);
      existing.causal = Math.max(existing.causal, r.causal);
      existing.contrastive = Math.max(existing.contrastive, r.contrastive);
      for (const s of r.source) {
        if (!existing.source.includes(s)) existing.source.push(s);
      }
    } else {
      merged.set(r.entry.id, { ...r, source: [...r.source] });
    }
  }

  const entries = Array.from(merged.values());
  const semNorm = normalizeScores(entries.map(e => e.semantic));
  const tmpNorm = normalizeScores(entries.map(e => e.temporal));
  const cauNorm = normalizeScores(entries.map(e => e.causal));
  const conNorm = normalizeScores(entries.map(e => e.contrastive));

  const results: UnifiedSearchResult[] = entries.map((e, i) => {
    const meta = (e.entry.metadata || {}) as Record<string, unknown>;
    const decayScore = Number(meta.decay_score ?? 1.0);
    const weighted = (
      weights.semantic * semNorm[i] +
      weights.temporal * tmpNorm[i] +
      weights.causal * cauNorm[i] +
      weights.contrastive * conNorm[i]
    ) * decayScore;

    return {
      entry: e.entry,
      score: weighted,
      embeddingSim: e.semantic,
      tagSim: 0,
      titleSim: 0,
      textMatch: false,
      graphHop: null,
      graphLinkStrength: null,
      retrievalPath: e.source,
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export async function associativeRetrieve(
  options: AssociativeRetrieveOptions
): Promise<{ results: UnifiedSearchResult[]; sessionType: SessionType; weights: BlendWeights; triggerKeywords: string[] }> {
  const start = Date.now();
  const { focusText, limit, sessionTopics } = options;
  const detection = detectSessionType(focusText + " " + sessionTopics.join(" "));
  const baseWeights = BLEND_WEIGHTS[detection.type];
  const { weights, modulated, deltas } = modulateWeights(baseWeights, options.emotionalState);
  if (modulated) {
    log.log(`[AssociativeRetrieval] emotional_modulation ${deltas}`);
  }

  let queryEmbedding: number[] | null = null;
  if (isEmbeddingsAvailable()) {
    try {
      queryEmbedding = await generateEmbedding(focusText);
    } catch { /* embedding optional for associative paths */ }
  }

  const semanticResults = await semanticRetrieve(focusText, limit);
  const semanticAnchors = semanticResults.slice(0, ANCHOR_LIMIT);

  const PATH_TIMEOUT_MS = 4000;
  const withPathTimeout = <T>(name: string, fn: Promise<T>, anchorCount: number): Promise<T | ScoredMemory[]> => {
    let timer: ReturnType<typeof setTimeout>;
    let timedOut = false;
    const timeoutPromise = new Promise<ScoredMemory[]>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        log.warn(`[AssociativeRetrieval] ${name} TIMEOUT after ${PATH_TIMEOUT_MS}ms anchors=${anchorCount} — returning []`);
        resolve([]);
      }, PATH_TIMEOUT_MS);
    });
    return Promise.race([
      fn.finally(() => { if (!timedOut) clearTimeout(timer); }),
      timeoutPromise,
    ]);
  };

  const pathResults = await Promise.all([
    Promise.resolve(semanticResults),
    withPathTimeout("temporalRetrieve", temporalRetrieve(semanticAnchors), semanticAnchors.length).catch(err => {
      log.warn(`[AssociativeRetrieval] temporalRetrieve failed anchors=${semanticAnchors.length}: ${err instanceof Error ? err.message : String(err)}`);
      return [] as ScoredMemory[];
    }),
    withPathTimeout("causalRetrieve", causalRetrieve(semanticAnchors, queryEmbedding), semanticAnchors.length).catch(err => {
      log.warn(`[AssociativeRetrieval] causalRetrieve failed anchors=${semanticAnchors.length}: ${err instanceof Error ? err.message : String(err)}`);
      return [] as ScoredMemory[];
    }),
    withPathTimeout("contrastiveRetrieve", contrastiveRetrieve(semanticAnchors, queryEmbedding), semanticAnchors.length).catch(err => {
      log.warn(`[AssociativeRetrieval] contrastiveRetrieve failed anchors=${semanticAnchors.length}: ${err instanceof Error ? err.message : String(err)}`);
      return [] as ScoredMemory[];
    }),
  ]);

  const [semResults, tmpResults, cauResults, conResults] = pathResults;
  const allFailed = semResults.length === 0 && tmpResults.length === 0 && cauResults.length === 0 && conResults.length === 0;

  if (allFailed) {
    log.error(`[AssociativeRetrieval] ALL paths returned empty — falling back to unifiedMemorySearch`);
    const fallback = await unifiedMemorySearch({ query: focusText, limit });
    return { results: fallback, sessionType: detection.type, weights, triggerKeywords: detection.triggerKeywords };
  }

  const allResults = [...semResults, ...tmpResults, ...cauResults, ...conResults];
  const blended = blendScores(allResults, weights, limit);

  log.log(`[AssociativeRetrieval] BLEND type=${detection.type} triggers=[${detection.triggerKeywords.join(",")}] sem=${semResults.length} tmp=${tmpResults.length} cau=${cauResults.length} con=${conResults.length} weights=s${weights.semantic}/t${weights.temporal}/c${weights.causal}/x${weights.contrastive} total=${blended.length} elapsed=${Date.now() - start}ms`);

  return { results: blended, sessionType: detection.type, weights, triggerKeywords: detection.triggerKeywords };
}
