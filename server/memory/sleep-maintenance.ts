import { memoryStorage, computeStringOverlap } from "./memory-storage";
import { chatCompletion } from "../model-client";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { withAbortTimeout } from "../timeout";
import { eventBus } from "../event-bus";
import { contextBuilder } from "../context-builder";
import { getPromptModulePrompt } from "../prompt-modules";
import { createLogger } from "../log";
import { extractJson } from "../utils/extract-json";
import { db, pool, withQueryAttributionAsync } from "../db";
import { memoryEntries, memoryLinks, MEMORY_INTEGRATION_STAGE } from "@shared/schema";
import { eq, or, sql } from "drizzle-orm";

const log = createLogger("SleepNREM");

const mergeLock = { current: Promise.resolve() as Promise<unknown> };

function withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mergeLock.current;
  const next = prev.then(fn, fn);
  mergeLock.current = next;
  return next;
}

const LINK_DECAY_FACTOR = 0.95;
const LINK_DEATH_THRESHOLD = 0.1;
const LINK_REINFORCEMENT_BOOST = 0.1;

const MAX_MERGE_CANDIDATES = 50;
const MAX_ORPHAN_CLEANUP = 250;
const LLM_TIMEOUT_MS = 60_000;
const MERGE_CONSECUTIVE_FAILURE_LIMIT = 3;
const LLM_HEALTH_PROBE_TIMEOUT_MS = 10_000;
const HEURISTIC_AUTO_MERGE_SIMILARITY = 0.95;
const HEURISTIC_AUTO_MERGE_CONTENT_OVERLAP = 0.80;
const HEURISTIC_SKIP_SIMILARITY = 0.87;
const ORPHAN_DELETE_DECAY_THRESHOLD = 0.3;
const ORPHAN_DELETE_AGE_DAYS = 14;
const MAX_DORMANT_PRUNE = 500;

export interface NREMResult {
  linksDecayed: number;
  linksPruned: number;
  linksReinforced: number;
  entriesMerged: number;
  orphansRemoved: number;
  orphansLinked: number;
  longTitlesHealed: number;
  errors: string[];
  durationMs: number;
  mergeEvalsAttempted: number;
  mergeEvalsFailed: number;
  mergeAbortedEarly: boolean;
  orphanEvalsAttempted: number;
  orphanEvalsFailed: number;
  orphanCandidatesFound: number;
  orphanDeleteAttempts: number;
  orphanDeleteFailures: number;
  orphanLinkAttempts: number;
  orphanLinkFailures: number;
  llmCallsAttempted: number;
  llmCallsSucceeded: number;
  heuristicMerges: number;
  heuristicSkips: number;
  heuristicOrphanDeletes: number;
  heuristicOrphanKeeps: number;
  dormantCandidatesFound: number;
  dormantPruned: number;
  dormantDeleteAttempts: number;
  dormantDeleteFailures: number;
  llmHealthProbeResult: "passed" | "failed" | "skipped";
  entriesAdvancedToUpkeep: number;
  sourceRefsEnriched: number;
}

interface CachedPhaseContext {
  internalContext: string;
  mergePrompt: string;
}

async function buildPhaseContext(): Promise<CachedPhaseContext> {
  const internalSpine = await contextBuilder.resolve({ callType: "internal", llmMode: "text" });
  const internalContext = contextBuilder.renderToPrompt(internalSpine);
  const mergePrompt = await getPromptModulePrompt("myelination-mid-merge");
  return { internalContext, mergePrompt };
}

async function probeLLMHealth(): Promise<boolean> {
  try {
    const result = await withAbortTimeout(
      async (signal) => {
        const probeResult = await chatCompletion({
          activity: ACTIVITY_MEMORY,
          metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
          maxTokens: 5,
          messages: [
            { role: "system" as const, content: "Respond with exactly: OK" },
            { role: "user" as const, content: "Health check" },
          ],
          temperature: 0,
          signal,
        });
        return probeResult.content;
      },
      LLM_HEALTH_PROBE_TIMEOUT_MS,
      "nrem-llm-health-probe",
    );
    const passed = typeof result === "string" && result.length > 0;
    log.debug(`[NREM] LLM health probe: ${passed ? "PASSED" : "FAILED (empty response)"}`);
    return passed;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[NREM] LLM health probe FAILED: ${msg}`);
    return false;
  }
}


async function repairRecalledSessionSummaries(): Promise<number> {
  const rows = await db.execute(sql`
    SELECT id, layer, metadata->>'previousLayer' AS previous_layer
    FROM memory_entries
    WHERE source = 'chat_journal'
      AND metadata->>'mirrorKind' = 'session_summary'
      AND metadata ? 'recalledAt'
    LIMIT 100
  `);

  const recalled = rows.rows as Array<{ id: number; layer: string; previous_layer: string | null }>;
  if (recalled.length === 0) return 0;

  log.error(`[NREM] Invariant violation: ${recalled.length} session_summary entries carried recall metadata; repairing`);

  for (const row of recalled) {
    const restoreLayer =
      row.layer === "short" && (row.previous_layer === "mid" || row.previous_layer === "long")
        ? row.previous_layer
        : row.layer;

    await db.execute(sql`
      UPDATE memory_entries
      SET layer = ${restoreLayer},
          metadata = metadata - 'recalledAt' - 'previousLayer' - 'previousGraphed',
          processed_at = NOW()
      WHERE id = ${row.id}
        AND source = 'chat_journal'
        AND metadata->>'mirrorKind' = 'session_summary'
    `);
  }

  eventBus.publish({
    category: "memory",
    event: "session_summary_recall_invariant_repaired",
    payload: { count: recalled.length },
  });

  return recalled.length;
}

async function getRecentlyRecalledEntryIds(): Promise<number[]> {
  const REINFORCEMENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const cutoff = new Date(Date.now() - REINFORCEMENT_LOOKBACK_MS);
  const rows = await db.execute(sql`
    SELECT DISTINCT mev.entry_id AS id
    FROM memory_events mev
    WHERE mev.event_type = 'recalled'
      AND mev.occurred_at >= ${cutoff}
  `);
  return (rows.rows as Array<{ id: number }>).map(r => r.id);
}

async function runLinkDecay(): Promise<{ decayed: number; pruned: number }> {
  log.log("[NREM] Phase 1a: Link decay");
  const result = await memoryStorage.decayAllLinks(LINK_DECAY_FACTOR, LINK_DEATH_THRESHOLD);
  log.debug(`[NREM] Link decay complete: ${result.decayed} decayed, ${result.pruned} pruned (below ${LINK_DEATH_THRESHOLD})`);

  if (result.pruned > 0) {
    eventBus.publish({
      category: "system",
      event: "sleep:links_pruned",
      payload: { decayed: result.decayed, pruned: result.pruned },
    });
  }

  return result;
}

async function runLinkReinforcement(): Promise<number> {
  log.debug("[NREM] Phase 1b: Link reinforcement for recently recalled entries");
  const recalledIds = await getRecentlyRecalledEntryIds();
  if (recalledIds.length === 0) {
    log.debug("[NREM] No recently recalled entries — skipping link reinforcement");
    return 0;
  }

  const reinforced = await memoryStorage.reinforceLinks(recalledIds, LINK_REINFORCEMENT_BOOST);
  log.debug(`[NREM] Reinforced ${reinforced} links for ${recalledIds.length} recently recalled entries`);
  return reinforced;
}

function computeContentOverlap(contentA: string, contentB: string): number {
  return computeStringOverlap(
    contentA.slice(0, 500),
    contentB.slice(0, 500),
  );
}

interface MergeCandidate {
  entryA: import("@shared/schema").MemoryEntry;
  entryB: import("@shared/schema").MemoryEntry;
  similarity: number;
}

type HeuristicDecision = "auto-merge" | "skip" | "llm-eval";

function classifyMergeCandidate(candidate: MergeCandidate): { decision: HeuristicDecision; reason: string } {
  const contentOverlap = computeContentOverlap(candidate.entryA.content, candidate.entryB.content);
  const sameSources = candidate.entryA.source === candidate.entryB.source;
  const titleA = (candidate.entryA.title || "").toLowerCase().trim();
  const titleB = (candidate.entryB.title || "").toLowerCase().trim();
  const sameTitle = titleA.length > 0 && titleA === titleB;

  if (candidate.similarity >= HEURISTIC_AUTO_MERGE_SIMILARITY && contentOverlap >= HEURISTIC_AUTO_MERGE_CONTENT_OVERLAP) {
    return { decision: "auto-merge", reason: `similarity=${candidate.similarity.toFixed(3)} content_overlap=${contentOverlap.toFixed(3)}` };
  }

  if (sameTitle && contentOverlap >= HEURISTIC_AUTO_MERGE_CONTENT_OVERLAP) {
    return { decision: "auto-merge", reason: `identical_title content_overlap=${contentOverlap.toFixed(3)}` };
  }

  if (candidate.similarity < HEURISTIC_SKIP_SIMILARITY && !sameSources) {
    return { decision: "skip", reason: `low_similarity=${candidate.similarity.toFixed(3)} different_sources` };
  }

  return { decision: "llm-eval", reason: `ambiguous similarity=${candidate.similarity.toFixed(3)} content_overlap=${contentOverlap.toFixed(3)}` };
}

async function executeAutoMerge(candidate: MergeCandidate, reason: string): Promise<boolean> {
  const keeperId = candidate.entryA.content.length >= candidate.entryB.content.length
    ? candidate.entryA.id : candidate.entryB.id;
  const doomedId = keeperId === candidate.entryA.id ? candidate.entryB.id : candidate.entryA.id;

  return withMergeLock(async () => {
    return await db.transaction(async (tx) => {
      const [keeper] = await tx.select({ id: memoryEntries.id })
        .from(memoryEntries).where(eq(memoryEntries.id, keeperId)).limit(1);
      const [doomed] = await tx.select({ id: memoryEntries.id })
        .from(memoryEntries).where(eq(memoryEntries.id, doomedId)).limit(1);
      if (!keeper || !doomed) return false;

      const keeperLinks = await tx.select().from(memoryLinks)
        .where(or(eq(memoryLinks.fromId, keeperId), eq(memoryLinks.toId, keeperId)));
      const keeperEdges = new Map<string, { id: number; strength: number }>();
      for (const kl of keeperLinks) {
        const otherNode = kl.fromId === keeperId ? kl.toId : kl.fromId;
        const edgeKey = `${Math.min(keeperId, otherNode)}-${Math.max(keeperId, otherNode)}`;
        keeperEdges.set(edgeKey, { id: kl.id, strength: Number(kl.strength ?? 0.5) });
      }

      const doomedLinks = await tx.select().from(memoryLinks)
        .where(or(eq(memoryLinks.fromId, doomedId), eq(memoryLinks.toId, doomedId)));

      for (const link of doomedLinks) {
        const otherNode = link.fromId === doomedId ? link.toId : link.fromId;
        if (otherNode === keeperId) {
          await tx.delete(memoryLinks).where(eq(memoryLinks.id, link.id));
          continue;
        }
        const edgeKey = `${Math.min(keeperId, otherNode)}-${Math.max(keeperId, otherNode)}`;
        const existing = keeperEdges.get(edgeKey);
        if (existing) {
          const mergedStrength = Math.min(1.0, Math.max(existing.strength, Number(link.strength ?? 0.5)));
          await tx.update(memoryLinks).set({ strength: mergedStrength }).where(eq(memoryLinks.id, existing.id));
          await tx.delete(memoryLinks).where(eq(memoryLinks.id, link.id));
        } else {
          await tx.update(memoryLinks).set({
            fromId: link.fromId === doomedId ? keeperId : link.fromId,
            toId: link.toId === doomedId ? keeperId : link.toId,
          }).where(eq(memoryLinks.id, link.id));
          keeperEdges.set(edgeKey, { id: link.id, strength: Number(link.strength ?? 0.5) });
        }
      }

      await tx.delete(memoryEntries).where(eq(memoryEntries.id, doomedId));
      return true;
    });
  });
}

interface MergeStats {
  merged: number;
  evalsAttempted: number;
  evalsFailed: number;
  abortedEarly: boolean;
  llmCallsAttempted: number;
  llmCallsSucceeded: number;
  heuristicMerges: number;
  heuristicSkips: number;
}

async function runIncrementalMerge(
  errors: string[],
  phaseContext: CachedPhaseContext,
  parentSignal?: AbortSignal,
): Promise<MergeStats> {
  log.log("[NREM] Phase 2: Incremental merge pass");

  const candidates = await memoryStorage.findMergeCandidates(MAX_MERGE_CANDIDATES);
  if (candidates.length === 0) {
    log.debug("[NREM] No merge candidates found");
    return { merged: 0, evalsAttempted: 0, evalsFailed: 0, abortedEarly: false, llmCallsAttempted: 0, llmCallsSucceeded: 0, heuristicMerges: 0, heuristicSkips: 0 };
  }

  log.debug(`[NREM] Found ${candidates.length} merge candidates`);
  let merged = 0;
  let consecutiveFailures = 0;
  let evalsAttempted = 0;
  let evalsFailed = 0;
  let llmCallsAttempted = 0;
  let llmCallsSucceeded = 0;
  let heuristicMerges = 0;
  let heuristicSkips = 0;
  let abortedEarly = false;

  for (const candidate of candidates) {
    if (parentSignal?.aborted) {
      log.warn(`[NREM] Merge loop aborted by parent signal — stopping early`);
      abortedEarly = true;
      break;
    }

    const classification = classifyMergeCandidate(candidate);

    if (classification.decision === "skip") {
      heuristicSkips++;
      log.debug(`[NREM] Heuristic SKIP #${candidate.entryA.id}/#${candidate.entryB.id}: ${classification.reason}`);
      continue;
    }

    if (classification.decision === "auto-merge") {
      try {
        const didMerge = await executeAutoMerge(candidate, classification.reason);
        if (didMerge) {
          heuristicMerges++;
          merged++;
          const keeperId = candidate.entryA.content.length >= candidate.entryB.content.length
            ? candidate.entryA.id : candidate.entryB.id;
          const doomedId = keeperId === candidate.entryA.id ? candidate.entryB.id : candidate.entryA.id;
          log.debug(`[NREM] Heuristic MERGE #${doomedId} into #${keeperId}: ${classification.reason}`);
          eventBus.publish({
            category: "system",
            event: "sleep:entries_merged",
            payload: { keeperId, doomedId, reason: `heuristic: ${classification.reason}` },
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Heuristic merge ${candidate.entryA.id}/${candidate.entryB.id}: ${msg}`);
        log.error(`[NREM] Heuristic merge error for #${candidate.entryA.id}/#${candidate.entryB.id}: ${msg}`);
      }
      continue;
    }

    evalsAttempted++;

    try {
      if (pool.waitingCount > 0) {
        log.debug(`[NREM] Backpressure before merge candidate: pool.waitingCount=${pool.waitingCount} — waiting`);
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (pool.waitingCount === 0) break;
        }
      }

      llmCallsAttempted++;
      const shouldMerge = await withAbortTimeout(
        async (signal) => {
          const entryADesc = `[ENTRY A] ID:${candidate.entryA.id} "${candidate.entryA.title || "Untitled"}" — ${candidate.entryA.summary || candidate.entryA.content.slice(0, 200)}`;
          const entryBDesc = `[ENTRY B] ID:${candidate.entryB.id} "${candidate.entryB.title || "Untitled"}" — ${candidate.entryB.summary || candidate.entryB.content.slice(0, 200)}`;

          const startTime = Date.now();
          const messages = [
            {
              role: "system" as const,
              content: phaseContext.internalContext
                ? `${phaseContext.internalContext}\n\n${phaseContext.mergePrompt}`
                : phaseContext.mergePrompt,
            },
            {
              role: "user" as const,
              content: `Similarity: ${candidate.similarity.toFixed(3)}\n\n${entryADesc}\n\n${entryBDesc}\n\nShould these entries be merged? If yes, which one should be kept (the "keeper") and what should the merged title/summary be? Respond with JSON: { "merge": true/false, "keeperId": <id>, "title": "...", "summary": "...", "reason": "..." }`,
            },
          ];

          const result = await chatCompletion({
            activity: ACTIVITY_MEMORY,
            metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
            maxTokens: 500,
            messages,
            temperature: 0.2,
            jsonMode: true,
            signal,
          });
          return JSON.parse(extractJson(result.content));
        },
        LLM_TIMEOUT_MS,
        `nrem-merge-eval-${candidate.entryA.id}-${candidate.entryB.id}`,
        parentSignal,
      );

      llmCallsSucceeded++;
      consecutiveFailures = 0;

      if (!shouldMerge?.merge) continue;

      const keeperId = shouldMerge.keeperId === candidate.entryA.id
        ? candidate.entryA.id
        : candidate.entryB.id;
      const doomedId = keeperId === candidate.entryA.id
        ? candidate.entryB.id
        : candidate.entryA.id;

      const didMerge = await withMergeLock(async () => {
        return await db.transaction(async (tx) => {
          const [keeper] = await tx.select({ id: memoryEntries.id })
            .from(memoryEntries).where(eq(memoryEntries.id, keeperId)).limit(1);
          const [doomed] = await tx.select({ id: memoryEntries.id })
            .from(memoryEntries).where(eq(memoryEntries.id, doomedId)).limit(1);
          if (!keeper || !doomed) return false;

          const keeperLinks = await tx.select().from(memoryLinks)
            .where(or(eq(memoryLinks.fromId, keeperId), eq(memoryLinks.toId, keeperId)));
          const keeperEdges = new Map<string, { id: number; strength: number }>();
          for (const kl of keeperLinks) {
            const otherNode = kl.fromId === keeperId ? kl.toId : kl.fromId;
            const edgeKey = `${Math.min(keeperId, otherNode)}-${Math.max(keeperId, otherNode)}`;
            keeperEdges.set(edgeKey, { id: kl.id, strength: Number(kl.strength ?? 0.5) });
          }

          const doomedLinks = await tx.select().from(memoryLinks)
            .where(or(eq(memoryLinks.fromId, doomedId), eq(memoryLinks.toId, doomedId)));

          for (const link of doomedLinks) {
            const otherNode = link.fromId === doomedId ? link.toId : link.fromId;
            if (otherNode === keeperId) {
              await tx.delete(memoryLinks).where(eq(memoryLinks.id, link.id));
              continue;
            }
            const edgeKey = `${Math.min(keeperId, otherNode)}-${Math.max(keeperId, otherNode)}`;
            const existing = keeperEdges.get(edgeKey);
            if (existing) {
              const mergedStrength = Math.min(1.0, Math.max(existing.strength, Number(link.strength ?? 0.5)));
              await tx.update(memoryLinks).set({ strength: mergedStrength }).where(eq(memoryLinks.id, existing.id));
              await tx.delete(memoryLinks).where(eq(memoryLinks.id, link.id));
            } else {
              await tx.update(memoryLinks).set({
                fromId: link.fromId === doomedId ? keeperId : link.fromId,
                toId: link.toId === doomedId ? keeperId : link.toId,
              }).where(eq(memoryLinks.id, link.id));
              keeperEdges.set(edgeKey, { id: link.id, strength: Number(link.strength ?? 0.5) });
            }
          }

          const updates: Record<string, unknown> = {};
          if (shouldMerge.title) updates.title = shouldMerge.title;
          if (shouldMerge.summary) updates.summary = shouldMerge.summary;
          if (Object.keys(updates).length > 0) {
            await tx.update(memoryEntries).set(updates).where(eq(memoryEntries.id, keeperId));
          }

          await tx.delete(memoryEntries).where(eq(memoryEntries.id, doomedId));
          return true;
        });
      });
      if (didMerge) {
        merged++;
        log.debug(`[NREM] Merged #${doomedId} into #${keeperId}: ${shouldMerge.reason || "similar content"}`);
        eventBus.publish({
          category: "system",
          event: "sleep:entries_merged",
          payload: { keeperId, doomedId, reason: shouldMerge.reason },
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Merge ${candidate.entryA.id}/${candidate.entryB.id}: ${msg}`);
      log.error(`[NREM] Merge error for #${candidate.entryA.id}/#${candidate.entryB.id}: ${msg}`);
      consecutiveFailures++;
      evalsFailed++;

      if (consecutiveFailures >= MERGE_CONSECUTIVE_FAILURE_LIMIT) {
        log.error(`[NREM] Merge phase ABORTED: ${consecutiveFailures} consecutive LLM failures (${evalsFailed}/${evalsAttempted} total failed)`);
        abortedEarly = true;
        break;
      }
    }
  }

  log.log(`[NREM] Incremental merge complete: ${merged} merged out of ${candidates.length} candidates (heuristic=${heuristicMerges} skipped=${heuristicSkips} llm_attempted=${llmCallsAttempted} llm_succeeded=${llmCallsSucceeded} aborted=${abortedEarly})`);
  return { merged, evalsAttempted, evalsFailed, abortedEarly, llmCallsAttempted, llmCallsSucceeded, heuristicMerges, heuristicSkips };
}

type OrphanHeuristicDecision = "delete" | "keep" | "llm-eval";

function classifyOrphan(orphan: import("@shared/schema").MemoryEntry): { decision: OrphanHeuristicDecision; reason: string } {
  const meta = (orphan.metadata || {}) as Record<string, unknown>;
  const decayScore = Number(meta.decay_score ?? 1.0);
  const tags = orphan.tags || [];
  const createdAt = orphan.createdAt instanceof Date ? orphan.createdAt : new Date(String(orphan.createdAt));
  const ageDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

  if (decayScore < ORPHAN_DELETE_DECAY_THRESHOLD && ageDays > ORPHAN_DELETE_AGE_DAYS && tags.length === 0) {
    return { decision: "delete", reason: `decay=${decayScore.toFixed(3)} age=${Math.floor(ageDays)}d no_tags` };
  }

  if (tags.length > 0 && decayScore >= 0.3) {
    return { decision: "keep", reason: `has_tags=${tags.length} decay=${decayScore.toFixed(3)}` };
  }

  if (ageDays < 14 && decayScore >= 0.3) {
    return { decision: "keep", reason: `recent age=${Math.floor(ageDays)}d decay=${decayScore.toFixed(3)}` };
  }

  return { decision: "llm-eval", reason: `ambiguous decay=${decayScore.toFixed(3)} age=${Math.floor(ageDays)}d tags=${tags.length}` };
}

interface OrphanStats {
  candidatesFound: number;
  removed: number;
  linked: number;
  evalsAttempted: number;
  evalsFailed: number;
  deleteAttempts: number;
  deleteFailures: number;
  linkAttempts: number;
  linkFailures: number;
  llmCallsAttempted: number;
  llmCallsSucceeded: number;
  heuristicDeletes: number;
  heuristicKeeps: number;
}

async function runOrphanCleanup(
  errors: string[],
  parentSignal?: AbortSignal,
  skipLLMEvals: boolean = false,
): Promise<OrphanStats> {
  log.log("[NREM] Phase 3: Orphan cleanup");

  const orphans = await memoryStorage.getOrphanEntries({
    minAgeDays: 7,
    maxDecayScore: 0.5,
    limit: MAX_ORPHAN_CLEANUP,
  });

  if (orphans.length === 0) {
    log.debug("[NREM] No orphan entries found");
    return { candidatesFound: 0, removed: 0, linked: 0, evalsAttempted: 0, evalsFailed: 0, deleteAttempts: 0, deleteFailures: 0, linkAttempts: 0, linkFailures: 0, llmCallsAttempted: 0, llmCallsSucceeded: 0, heuristicDeletes: 0, heuristicKeeps: 0 };
  }

  log.debug(`[NREM] Found ${orphans.length} orphan entries to evaluate`);
  const candidatesFound = orphans.length;
  let removed = 0;
  let linked = 0;
  let evalsAttempted = 0;
  let evalsFailed = 0;
  let deleteAttempts = 0;
  let deleteFailures = 0;
  let linkAttempts = 0;
  let linkFailures = 0;
  let llmCallsAttempted = 0;
  let llmCallsSucceeded = 0;
  let heuristicDeletes = 0;
  let heuristicKeeps = 0;

  for (const orphan of orphans) {
    if (parentSignal?.aborted) {
      log.warn(`[NREM] Orphan cleanup aborted by parent signal`);
      break;
    }

    const classification = classifyOrphan(orphan);

    if (classification.decision === "delete") {
      try {
        deleteAttempts++;
        const deleteResult = await memoryStorage.deleteEntry(orphan.id);
        if (deleteResult.deleted) {
          removed++;
          heuristicDeletes++;
        } else {
          deleteFailures++;
          errors.push(`Orphan #${orphan.id} heuristic delete: entry was not deleted`);
        }
        log.debug(`[NREM] Orphan #${orphan.id} heuristic DELETE: ${classification.reason}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        deleteFailures++;
        errors.push(`Orphan #${orphan.id} heuristic delete: ${msg}`);
        log.error(`[NREM] Orphan heuristic delete error for #${orphan.id}: ${msg}`);
      }
      continue;
    }

    if (classification.decision === "keep") {
      heuristicKeeps++;
      log.debug(`[NREM] Orphan #${orphan.id} heuristic KEEP: ${classification.reason}`);
      linkAttempts++;
      const didLink = await attemptOrphanLinkage(orphan, errors);
      if (didLink) linked++;
      else linkFailures++;
      continue;
    }

    if (skipLLMEvals) {
      heuristicKeeps++;
      log.debug(`[NREM] Orphan #${orphan.id} kept (LLM evals disabled — probe failed): ${classification.reason}`);
      linkAttempts++;
      const didLink = await attemptOrphanLinkage(orphan, errors);
      if (didLink) linked++;
      else linkFailures++;
      continue;
    }

    evalsAttempted++;
    try {
      llmCallsAttempted++;
      const decision = await withAbortTimeout(
        async (signal) => {
          const orphanDesc = `[ORPHAN] ID:${orphan.id} "${orphan.title || "Untitled"}" (decay_score=${((orphan.metadata as Record<string, unknown>)?.decay_score as number ?? 1.0).toFixed(3)})\nSummary: ${orphan.summary || orphan.content.slice(0, 300)}\nTags: ${(orphan.tags || []).join(", ")}\nSource: ${orphan.source}\nCreated: ${orphan.createdAt}`;

          const startTime = Date.now();
          const messages = [
            {
              role: "system" as const,
              content: "You are evaluating an orphan memory entry (no graph links, low decay score, old). Decide whether to DELETE it (redundant or low-value) or KEEP it (unique and valuable). Respond with JSON: { \"action\": \"delete\" | \"keep\", \"reason\": \"...\" }",
            },
            {
              role: "user" as const,
              content: orphanDesc,
            },
          ];

          const result = await chatCompletion({
            activity: ACTIVITY_MEMORY,
            metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
            maxTokens: 200,
            messages,
            temperature: 0.2,
            jsonMode: true,
            signal,
          });
          return JSON.parse(extractJson(result.content));
        },
        LLM_TIMEOUT_MS,
        `nrem-orphan-eval-${orphan.id}`,
        parentSignal,
      );

      llmCallsSucceeded++;

      if (decision?.action === "delete") {
        deleteAttempts++;
        const deleteResult = await memoryStorage.deleteEntry(orphan.id);
        if (deleteResult.deleted) {
          removed++;
          log.debug(`[NREM] Orphan #${orphan.id} deleted: ${decision.reason}`);
        } else {
          deleteFailures++;
          errors.push(`Orphan #${orphan.id}: delete decision did not delete entry`);
        }
      } else {
        linkAttempts++;
      const didLink = await attemptOrphanLinkage(orphan, errors);
      if (didLink) linked++;
      else linkFailures++;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Orphan #${orphan.id}: ${msg}`);
      log.error(`[NREM] Orphan cleanup error for #${orphan.id}: ${msg}`);
      evalsFailed++;
    }
  }

  if (removed > 0 || linked > 0) {
    eventBus.publish({
      category: "system",
      event: "sleep:orphans_processed",
      payload: { removed, linked },
    });
  }

  log.log(`[NREM] Orphan cleanup complete: candidates=${candidatesFound}, removed=${removed}/${deleteAttempts}, linked=${linked}/${linkAttempts}, deleteFailures=${deleteFailures}, linkFailures=${linkFailures} (heuristic_deletes=${heuristicDeletes} heuristic_keeps=${heuristicKeeps} llm_attempted=${llmCallsAttempted} llm_succeeded=${llmCallsSucceeded})`);
  return { candidatesFound, removed, linked, evalsAttempted, evalsFailed, deleteAttempts, deleteFailures, linkAttempts, linkFailures, llmCallsAttempted, llmCallsSucceeded, heuristicDeletes, heuristicKeeps };
}

async function advanceCanonicalEntriesToUpkeep(limit: number = 250): Promise<number> {
  const result = await db.execute(sql`
    UPDATE memory_entries
    SET integration_stage = ${MEMORY_INTEGRATION_STAGE.UPKEEP},
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'sleep_upkeep_at', NOW(),
          'sleep_upkeep_reason', 'nrem-maintained-canonical'
        ),
        processed_at = NOW()
    WHERE id IN (
      SELECT me.id
      FROM memory_entries me
      WHERE me.integration_stage = ${MEMORY_INTEGRATION_STAGE.CANONICAL}
        AND me.layer = 'long'
        AND COALESCE(me.metadata->>'canonicalDocument', 'false') != 'true'
        AND COALESCE(me.metadata->>'sourceOfTruth', '') != 'domain'
        AND COALESCE((me.metadata->>'decay_score')::float, 1.0) >= 0.3
      ORDER BY COALESCE(me.processed_at, me.created_at) ASC
      LIMIT ${limit}
    )
  `);
  return Number((result as { rowCount?: number }).rowCount || 0);
}

async function enrichMissingLegacySourceRefs(limit: number = 250): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO memory_sources (memory_id, source_type, source_id, relationship, context, strength, scope, owner_user_id, account_id, created_by_user_id, updated_by_user_id)
    SELECT me.id, me.source, me.source_id, 'extracted_from', 'Backfilled during sleep upkeep from memory_entries.source/source_id', 1,
           me.scope, me.owner_user_id, me.account_id, me.created_by_user_id, me.updated_by_user_id
    FROM memory_entries me
    WHERE me.source_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM memory_sources ms
        WHERE ms.memory_id = me.id
          AND ms.source_type = me.source
          AND ms.source_id = me.source_id
          AND ms.relationship = 'extracted_from'
      )
    ORDER BY me.created_at DESC
    LIMIT ${limit}
    ON CONFLICT (memory_id, source_type, source_id, relationship) DO NOTHING
  `);
  return Number((result as { rowCount?: number }).rowCount || 0);
}

async function attemptOrphanLinkage(orphan: import("@shared/schema").MemoryEntry, errors: string[]): Promise<boolean> {
  try {
    const similar = await memoryStorage.findSimilarEntries(orphan.id, 3, {
      layers: ["long"],
      skipLinkedFilter: true,
    });
    if (similar.length > 0) {
      const best = similar[0];
      await memoryStorage.createLink(orphan.id, best.entry.id, "related", 0.3, "related");
      log.debug(`[NREM] Orphan #${orphan.id} linked to #${best.entry.id}: rescued unique entry`);
      return true;
    } else {
      log.debug(`[NREM] Orphan #${orphan.id}: no semantically similar linkage target available, kept as-is`);
      return false;
    }
  } catch (linkErr: unknown) {
    const msg = linkErr instanceof Error ? linkErr.message : String(linkErr);
    errors.push(`Orphan linkage #${orphan.id}: ${msg}`);
    log.error(`[NREM] Orphan linkage error for #${orphan.id}: ${msg}`);
    return false;
  }
}

export async function runNREMPhase(parentSignal?: AbortSignal): Promise<NREMResult> {
  return withQueryAttributionAsync("memory-write", async () => {
    const startTime = Date.now();
    log.log("[NREM] Starting NREM phase");

    const result: NREMResult = {
      linksDecayed: 0,
      linksPruned: 0,
      linksReinforced: 0,
      entriesMerged: 0,
      orphansRemoved: 0,
      orphansLinked: 0,
      longTitlesHealed: 0,
      errors: [],
      durationMs: 0,
      mergeEvalsAttempted: 0,
      mergeEvalsFailed: 0,
      mergeAbortedEarly: false,
      orphanEvalsAttempted: 0,
      orphanEvalsFailed: 0,
      orphanCandidatesFound: 0,
      orphanDeleteAttempts: 0,
      orphanDeleteFailures: 0,
      orphanLinkAttempts: 0,
      orphanLinkFailures: 0,
      llmCallsAttempted: 0,
      llmCallsSucceeded: 0,
      heuristicMerges: 0,
      heuristicSkips: 0,
      heuristicOrphanDeletes: 0,
      heuristicOrphanKeeps: 0,
      dormantCandidatesFound: 0,
      dormantPruned: 0,
      dormantDeleteAttempts: 0,
      dormantDeleteFailures: 0,
      llmHealthProbeResult: "skipped",
      entriesAdvancedToUpkeep: 0,
      sourceRefsEnriched: 0,
    };

    try {
      if (parentSignal?.aborted) {
        result.errors.push("NREM aborted before start");
        return result;
      }


      try {
        await repairRecalledSessionSummaries();
      } catch (repairErr: unknown) {
        const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
        result.errors.push(`Session summary recall invariant repair error: ${msg}`);
        log.error(`[NREM] Session summary recall invariant repair error: ${msg}`);
      }

      const decayResult = await runLinkDecay();
      result.linksDecayed = decayResult.decayed;
      result.linksPruned = decayResult.pruned;

      result.linksReinforced = await runLinkReinforcement();

      try {
        result.entriesAdvancedToUpkeep = await advanceCanonicalEntriesToUpkeep();
        result.sourceRefsEnriched = await enrichMissingLegacySourceRefs();
        if (result.entriesAdvancedToUpkeep > 0 || result.sourceRefsEnriched > 0) {
          log.debug(`[NREM] Stage 4 upkeep: advanced=${result.entriesAdvancedToUpkeep}, sourceRefsEnriched=${result.sourceRefsEnriched}`);
        }
      } catch (upkeepErr: unknown) {
        const msg = upkeepErr instanceof Error ? upkeepErr.message : String(upkeepErr);
        result.errors.push(`Stage 4 upkeep error: ${msg}`);
        log.error(`[NREM] Stage 4 upkeep error: ${msg}`);
      }

      const llmHealthy = await probeLLMHealth();
      result.llmHealthProbeResult = llmHealthy ? "passed" : "failed";

      if (!llmHealthy) {
        log.warn("[NREM] LLM health probe failed — skipping merge phase and LLM orphan evals (heuristic-only orphan cleanup)");
        result.mergeAbortedEarly = true;
        result.errors.push("Merge phase skipped: LLM health probe failed");
      } else {
        result.llmCallsAttempted++;
        result.llmCallsSucceeded++;

        const phaseContext = await buildPhaseContext();

        const mergeStats = await runIncrementalMerge(result.errors, phaseContext, parentSignal);
        result.entriesMerged = mergeStats.merged;
        result.mergeEvalsAttempted = mergeStats.evalsAttempted;
        result.mergeEvalsFailed = mergeStats.evalsFailed;
        result.mergeAbortedEarly = mergeStats.abortedEarly;
        result.llmCallsAttempted += mergeStats.llmCallsAttempted;
        result.llmCallsSucceeded += mergeStats.llmCallsSucceeded;
        result.heuristicMerges = mergeStats.heuristicMerges;
        result.heuristicSkips = mergeStats.heuristicSkips;
      }

      const orphanStats = await runOrphanCleanup(result.errors, parentSignal, !llmHealthy);
      result.orphansRemoved = orphanStats.removed;
      result.orphansLinked = orphanStats.linked;
      result.orphanEvalsAttempted = orphanStats.evalsAttempted;
      result.orphanEvalsFailed = orphanStats.evalsFailed;
      result.orphanCandidatesFound = orphanStats.candidatesFound;
      result.orphanDeleteAttempts = orphanStats.deleteAttempts;
      result.orphanDeleteFailures = orphanStats.deleteFailures;
      result.orphanLinkAttempts = orphanStats.linkAttempts;
      result.orphanLinkFailures = orphanStats.linkFailures;
      result.llmCallsAttempted += orphanStats.llmCallsAttempted;
      result.llmCallsSucceeded += orphanStats.llmCallsSucceeded;
      result.heuristicOrphanDeletes = orphanStats.heuristicDeletes;
      result.heuristicOrphanKeeps = orphanStats.heuristicKeeps;

      // Phase 3b: Recall-based dormant pruning
      // Entries that have existed 30+ days, never been recalled, have ≤1 link,
      // decayed below 0.3, and carry no protected tags get deleted.
      try {
        const dormantEntries = await memoryStorage.getUnrecalledDormantEntries({ limit: MAX_DORMANT_PRUNE });
        result.dormantCandidatesFound = dormantEntries.length;
        if (dormantEntries.length > 0) {
          log.log(`[NREM] Phase 3b: Dormant pruning — ${dormantEntries.length} candidates`);
          for (const entry of dormantEntries) {
            if (parentSignal?.aborted) break;
            try {
              result.dormantDeleteAttempts++;
              const deleteResult = await memoryStorage.deleteEntry(entry.id);
              if (deleteResult.deleted) {
                result.dormantPruned++;
                log.debug(`[NREM] Dormant pruned #${entry.id} "${entry.title || "Untitled"}"`);
              } else {
                result.dormantDeleteFailures++;
                result.errors.push(`Dormant prune #${entry.id}: entry was not deleted`);
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              result.dormantDeleteFailures++;
              result.errors.push(`Dormant prune #${entry.id}: ${msg}`);
            }
          }
          log.log(`[NREM] Dormant pruning complete: ${result.dormantPruned}/${result.dormantDeleteAttempts} pruned (failures=${result.dormantDeleteFailures})`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Dormant pruning error: ${msg}`);
        log.error(`[NREM] Dormant pruning error: ${msg}`);
      }

      try {
        const { backfillLongTitles } = await import("./long-title-maintenance");
        const backfillResult = await backfillLongTitles();
        result.longTitlesHealed = backfillResult.updated;
        if (backfillResult.updated > 0) {
          log.debug(`[NREM] Long title healing: ${backfillResult.updated} entries reset for re-summarization`);
        }
      } catch (healErr: unknown) {
        const msg = healErr instanceof Error ? healErr.message : String(healErr);
        result.errors.push(`Long title healing error: ${msg}`);
        log.error(`[NREM] Long title healing error: ${msg}`);
      }

      // Slow self-heal: re-summarize a small batch of library memory entries (mid/long)
      // whose summary is missing or is effectively a verbatim dump of the page body.
      // Hard-capped per cycle so the load stays bounded; manual backfill exists for impatience.
      if (llmHealthy) {
        try {
          const LIBRARY_HEAL_PER_CYCLE = 5;
          const { findBrokenLibraryMemoryEntries } = await import("../routes/library");
          const broken = await findBrokenLibraryMemoryEntries(LIBRARY_HEAL_PER_CYCLE);
          if (broken.length > 0) {
            log.debug(`[NREM] Library self-heal: re-summarizing ${broken.length} entries (capped at ${LIBRARY_HEAL_PER_CYCLE})`);
            // Clear contentHash for verbatim-summary entries so summarizeBatch
            // doesn't skip them on the unchanged-hash optimization.
            for (const { entry } of broken) {
              try {
                await db.update(memoryEntries)
                  .set({ contentHash: null })
                  .where(eq(memoryEntries.id, entry.id));
                entry.contentHash = null;
              } catch (clearErr: unknown) {
                log.warn(`[NREM] Library self-heal: failed to clear contentHash for #${entry.id}: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`);
              }
            }
            const entriesToHeal = broken.map(b => b.entry);
            const { summarizeBatch } = await import("./memory-enrichment");
            const healResult = await summarizeBatch(entriesToHeal);
            log.debug(`[NREM] Library self-heal complete: summarized=${healResult.summarized} errors=${healResult.errors.length}`);
            for (const err of healResult.errors) result.errors.push(`Library heal: ${err}`);
          }
        } catch (libHealErr: unknown) {
          const msg = libHealErr instanceof Error ? libHealErr.message : String(libHealErr);
          result.errors.push(`Library self-heal error: ${msg}`);
          log.error(`[NREM] Library self-heal error: ${msg}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`NREM phase error: ${msg}`);
      log.error(`[NREM] Phase error: ${msg}`);
    }

    result.durationMs = Date.now() - startTime;
    log.log(`[NREM] Phase complete in ${result.durationMs}ms: decayed=${result.linksDecayed} pruned=${result.linksPruned} reinforced=${result.linksReinforced} merged=${result.entriesMerged} orphansRemoved=${result.orphansRemoved} orphansLinked=${result.orphansLinked} advancedToUpkeep=${result.entriesAdvancedToUpkeep} sourceRefsEnriched=${result.sourceRefsEnriched} dormantPruned=${result.dormantPruned} longTitlesHealed=${result.longTitlesHealed} errors=${result.errors.length} llm=${result.llmCallsSucceeded}/${result.llmCallsAttempted} heuristic_merges=${result.heuristicMerges} heuristic_skips=${result.heuristicSkips} merge_aborted=${result.mergeAbortedEarly}`);

    return result;
  }, "nrem-phase");
}
