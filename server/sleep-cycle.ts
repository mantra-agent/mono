import { createLogger } from "./log";
import { eventBus } from "./event-bus";
import { pool, withQueryAttributionAsync } from "./db";
import { getZombieMetrics, resetZombiePeakCount } from "./cli-sdk-adapter";

const log = createLogger("SleepCycle");

const DEFAULT_DECAY_RATE = 0.03;
const CONFIDENCE_FLOOR = 0.3;
const UNCERTAIN_THRESHOLD = 0.4;
const REVIEW_THRESHOLD = 0.2;
const REINFORCEMENT_BOOST = 0.1;
const REINFORCEMENT_CAP = 1.0;

const DECAY_SCORE_FLOOR = 0.05;
const BATCH_SIZE = 200;

const CIRCUIT_BREAKER_THRESHOLD = 3;
const BACKPRESSURE_POLL_MS = 2000;
const BACKPRESSURE_MAX_WAIT_MS = 60_000;
const GLOBAL_SLEEP_CYCLE_TIMEOUT_MS = 10 * 60 * 1000;
const NREM_ERROR_RATIO_THRESHOLD = 0.5;

// Budget enforcement constants
const MEMORY_BUDGET_TARGET = 8000;
const MEMORY_BUDGET_HARD_CAP = 10000;
const BUDGET_DAILY_GROWTH_BUFFER = 1000;
const MAX_BUDGET_EMERGENCY_DELETE = 10000;

export interface MemoryDecayResult {
  decayed: number;
  byLayer: Record<string, number>;
  byStage: Record<string, number>;
  flippedUncertain: number;
  flaggedForReview: number;
  errors: string[];
}

export interface MemoryReinforcementResult {
  reinforced: number;
  byLayer: Record<string, number>;
  byStage: Record<string, number>;
  errors: string[];
}

function logPoolHealth(phase: string, context?: string): void {
  const extra = context ? ` ${context}` : "";
  log.debug(`[Sleep:pool] phase=${phase} pool=[total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}]${extra}`);
}

class CircuitBreakerTripped extends Error {
  constructor(public phase: string, public consecutiveFailures: number, public lastError: string) {
    super(`Circuit breaker tripped in ${phase}: ${consecutiveFailures} consecutive DB failures. Last error: ${lastError}`);
    this.name = "CircuitBreakerTripped";
  }
}

let circuitBreakerFailures = 0;
let circuitBreakerLastError = "";
let circuitBreakerPhase = "";

function resetCircuitBreaker(): void {
  circuitBreakerFailures = 0;
  circuitBreakerLastError = "";
  circuitBreakerPhase = "";
}

function recordCircuitBreakerSuccess(): void {
  circuitBreakerFailures = 0;
}

function recordCircuitBreakerFailure(phase: string, error: string): void {
  circuitBreakerFailures++;
  circuitBreakerLastError = error;
  circuitBreakerPhase = phase;

  if (circuitBreakerFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    log.error(`[Sleep:circuit-breaker] TRIPPED in ${phase}: ${circuitBreakerFailures} consecutive failures. Last error: ${error}. Pool: total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
    eventBus.publish({
      category: "system",
      event: "sleep:circuit_breaker_tripped",
      payload: { phase, consecutiveFailures: circuitBreakerFailures, lastError: error, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } },
    });
    throw new CircuitBreakerTripped(phase, circuitBreakerFailures, error);
  }
}

function isConnectionError(msg: string): boolean {
  return msg.includes("timeout") || msg.includes("connection") || msg.includes("Connection terminated") || msg.includes("ECONNRESET") || msg.includes("ECONNREFUSED");
}

async function waitForBackpressure(phase: string): Promise<void> {
  if (pool.waitingCount === 0) return;

  log.debug(`[Sleep:backpressure] Waiting before ${phase}: pool.waitingCount=${pool.waitingCount}`);
  const deadline = Date.now() + BACKPRESSURE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, BACKPRESSURE_POLL_MS));
    if (pool.waitingCount === 0) {
      log.debug(`[Sleep:backpressure] Pressure cleared for ${phase}: pool.waitingCount=${pool.waitingCount}`);
      return;
    }
  }
  log.warn(`[Sleep:backpressure] Timed out waiting for pressure to clear before ${phase}`);
}

export async function runMemoryDecay(): Promise<MemoryDecayResult> {
  return withQueryAttributionAsync("memory-write", async () => {
    log.debug("[Sleep] Running universal memory decay");
    logPoolHealth("decay-start");

    const result: MemoryDecayResult = {
      decayed: 0,
      byLayer: {},
      byStage: {},
      flippedUncertain: 0,
      flaggedForReview: 0,
      errors: [],
    };

    let phaseStart: number;
    try {
      const { db } = await import("./db");
      const { memoryEntries } = await import("@shared/schema");
      const { or, sql } = await import("drizzle-orm");
      const { memoryEntryLightColumns, wrapLightEntry } = await import("./memory/memory-storage");

      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const rows = await db
          .select(memoryEntryLightColumns)
          .from(memoryEntries)
          .where(or(sql`${memoryEntries.layer} = 'long'`, sql`${memoryEntries.integrationStage} IN ('stage_3', 'stage_4')`))
          .limit(BATCH_SIZE)
          .offset(offset);

        if (rows.length < BATCH_SIZE) hasMore = false;
        offset += rows.length;
        const wrappedRows = rows.map(r => wrapLightEntry(r as Omit<import("@shared/schema").MemoryEntry, "embedding">));

        const updates: Array<{ id: number; metadata: Record<string, unknown>; processedAt: Date }> = [];

        for (const row of wrappedRows) {
          try {
            const meta = { ...((row.metadata || {}) as Record<string, unknown>) };
            const isBelief = row.source === "belief";

            const currentDecayScore = Number(meta.decay_score ?? 1.0);
            if (currentDecayScore > DECAY_SCORE_FLOOR) {
              const decayRate = Number(meta.decay_rate ?? DEFAULT_DECAY_RATE);
              const newDecayScore = Math.max(DECAY_SCORE_FLOOR, currentDecayScore - decayRate);
              meta.decay_score = newDecayScore;
            }

            if (isBelief) {
              const currentConfidence = Number(meta.confidence ?? 0.5);
              if (currentConfidence > CONFIDENCE_FLOOR) {
                const beliefDecayRate = Number(meta.decay_rate ?? DEFAULT_DECAY_RATE);
                const newConfidence = Math.max(CONFIDENCE_FLOOR, currentConfidence - beliefDecayRate);
                meta.confidence = newConfidence;

                if (newConfidence < UNCERTAIN_THRESHOLD && currentConfidence >= UNCERTAIN_THRESHOLD) {
                  meta.status = "uncertain";
                  result.flippedUncertain++;
                  log.debug(`[Sleep] Belief "${row.content?.slice(0, 60)}" flipped to uncertain (confidence=${newConfidence.toFixed(3)})`);
                }
              }

              const confidence = Number(meta.confidence ?? 0.5);
              const status = String(meta.status || "active");
              if ((status === "active" || status === "uncertain") && confidence < REVIEW_THRESHOLD) {
                result.flaggedForReview++;
                log.debug(`[Sleep] Belief "${row.content?.slice(0, 60)}" flagged for review (confidence=${confidence.toFixed(3)})`);
                eventBus.publish({
                  category: "system",
                  event: "sleep:belief_flagged",
                  payload: { entryId: row.id, sourceId: row.sourceId, claim: row.content?.slice(0, 120), confidence },
                });
              }
            }

            const newDecayScore = Number(meta.decay_score ?? 1.0);
            if (newDecayScore < 0.1) {
              eventBus.publish({
                category: "system",
                event: "sleep:memory_low_decay",
                payload: { entryId: row.id, decayScore: newDecayScore, source: row.source },
              });
            }

            updates.push({ id: row.id, metadata: meta, processedAt: new Date() });
            result.decayed++;
            result.byLayer[row.layer] = (result.byLayer[row.layer] ?? 0) + 1;
            result.byStage[row.integrationStage] = (result.byStage[row.integrationStage] ?? 0) + 1;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Entry #${row.id}: ${msg}`);
            log.error(`[Sleep] Error computing decay for entry #${row.id}: ${msg}`);
          }
        }

        if (updates.length > 0) {
          try {
            const batchPayload = JSON.stringify(updates.map(u => ({ id: u.id, metadata: u.metadata })));
            await db.execute(sql`
              UPDATE memory_entries
              SET metadata = batch.metadata, processed_at = NOW()
              FROM jsonb_array_elements(${batchPayload}::jsonb) AS item,
              LATERAL (SELECT (item->>'id')::int AS id, item->'metadata' AS metadata) AS batch
              WHERE memory_entries.id = batch.id
            `);
            recordCircuitBreakerSuccess();
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`[Sleep] Batch decay UPDATE failed: ${msg}`);
            result.errors.push(`Batch update failed: ${msg}`);
            if (isConnectionError(msg)) {
              recordCircuitBreakerFailure("decay", msg);
            }
          }
        }
      }

      log.debug(`[Sleep] Memory decay complete: decayed=${result.decayed} byLayer=${JSON.stringify(result.byLayer)} byStage=${JSON.stringify(result.byStage)} uncertain=${result.flippedUncertain} flagged=${result.flaggedForReview}`);
      logPoolHealth("decay-end");
    } catch (err: unknown) {
      if (err instanceof CircuitBreakerTripped) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Memory decay failed: ${msg}`);
      log.error(`[Sleep] Memory decay failed: ${msg}`);
      if (isConnectionError(msg)) {
        recordCircuitBreakerFailure("decay", msg);
      }
    }

    return result;
  }, "memory-decay");
}

export async function runMemoryReinforcement(): Promise<MemoryReinforcementResult> {
  return withQueryAttributionAsync("memory-write", async () => {
    log.debug("[Sleep] Running universal memory reinforcement");
    logPoolHealth("reinforcement-start");

    const result: MemoryReinforcementResult = {
      reinforced: 0,
      byLayer: {},
      byStage: {},
      errors: [],
    };

    let phaseStart: number;
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");

      const REINFORCEMENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      const cutoff = new Date(Date.now() - REINFORCEMENT_LOOKBACK_MS);
      const recalledRows = await db.execute(sql`
        SELECT DISTINCT me.id, me.layer, me.integration_stage, me.source_id, me.metadata, me.content, me.source
        FROM memory_events mev
        JOIN memory_entries me ON me.id = mev.entry_id
        WHERE mev.event_type = 'recalled'
          AND mev.occurred_at >= ${cutoff}
      `);

      const recalledEntries = recalledRows.rows as Array<{
        id: number;
        layer: string;
        integration_stage: string;
        source_id: string | null;
        metadata: Record<string, unknown>;
        content: string;
        source: string;
      }>;

      if (recalledEntries.length === 0) {
        log.debug("[Sleep] No recently recalled memories found");
        return result;
      }

      log.debug(`[Sleep] Found ${recalledEntries.length} recently recalled entries`);

      const updates: Array<{ id: number; metadata: Record<string, unknown> }> = [];
      const eventAppends: Array<{ id: number; decayScore: number }> = [];
      const publishPayloads: Array<{ entryId: number; sourceId: string | null; decayScore: number; source: string; layer: string; integrationStage: string }> = [];

      for (const entry of recalledEntries) {
        const meta = { ...(entry.metadata || {}) };
        const isBelief = entry.source === "belief";

        const currentDecayScore = Number(meta.decay_score ?? 1.0);
        const newDecayScore = Math.min(REINFORCEMENT_CAP, currentDecayScore + REINFORCEMENT_BOOST);
        meta.decay_score = newDecayScore;

        if (isBelief) {
          const currentConfidence = Number(meta.confidence ?? 0.5);
          const newConfidence = Math.min(REINFORCEMENT_CAP, currentConfidence + REINFORCEMENT_BOOST);
          meta.confidence = newConfidence;
          meta.status = "active";
        }

        updates.push({ id: entry.id, metadata: meta });
        result.byLayer[entry.layer] = (result.byLayer[entry.layer] ?? 0) + 1;
        result.byStage[entry.integration_stage] = (result.byStage[entry.integration_stage] ?? 0) + 1;

        eventAppends.push({ id: entry.id, decayScore: newDecayScore });
        publishPayloads.push({ entryId: entry.id, sourceId: entry.source_id, decayScore: newDecayScore, source: entry.source, layer: entry.layer, integrationStage: entry.integration_stage });

        result.reinforced++;
        log.debug(`[Sleep] Memory #${entry.id} "${entry.content?.slice(0, 60)}" reinforced (decay_score=${newDecayScore.toFixed(3)})`);
      }

      if (updates.length > 0) {
        try {
          const batchPayload = JSON.stringify(updates.map(u => ({ id: u.id, metadata: u.metadata })));
          await db.execute(sql`
            UPDATE memory_entries
            SET metadata = batch.metadata, processed_at = NOW()
            FROM jsonb_array_elements(${batchPayload}::jsonb) AS item,
            LATERAL (SELECT (item->>'id')::int AS id, item->'metadata' AS metadata) AS batch
            WHERE memory_entries.id = batch.id
          `);
          recordCircuitBreakerSuccess();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`[Sleep] Batch reinforcement UPDATE failed: ${msg}`);
          result.errors.push(`Batch update failed: ${msg}`);
          if (isConnectionError(msg)) {
            recordCircuitBreakerFailure("reinforcement", msg);
          }
        }
      }

      if (eventAppends.length > 0) {
        try {
          const { memoryStorage } = await import("./memory/memory-storage");
          for (const ea of eventAppends) {
            try {
              await memoryStorage.appendEvent(ea.id, "updated", {
                field: "decay_score",
                newValue: ea.decayScore,
                reason: "reinforcement",
              });
            } catch (appendErr: unknown) {
              const msg = appendErr instanceof Error ? appendErr.message : String(appendErr);
              result.errors.push(`appendEvent #${ea.id}: ${msg}`);
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Event appends failed: ${msg}`);
        }
      }

      for (const p of publishPayloads) {
        eventBus.publish({
          category: "system",
          event: "sleep:memory_reinforced",
          payload: p,
        });
      }

      log.debug(`[Sleep] Memory reinforcement complete: reinforced=${result.reinforced} byLayer=${JSON.stringify(result.byLayer)} byStage=${JSON.stringify(result.byStage)}`);
      logPoolHealth("reinforcement-end");
    } catch (err: unknown) {
      if (err instanceof CircuitBreakerTripped) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Memory reinforcement failed: ${msg}`);
      log.error(`[Sleep] Memory reinforcement failed: ${msg}`);
      if (isConnectionError(msg)) {
        recordCircuitBreakerFailure("reinforcement", msg);
      }
    }

    return result;
  }, "memory-reinforce");
}
export interface BudgetEnforcementResult {
  totalCount: number;
  finalCount: number;
  target: number;
  hardCap: number;
  surplus: number;
  finalSurplus: number;
  emergencyMode: boolean;
  deletionRequired: boolean;
  deleteTarget: number;
  candidatesFound: number;
  entriesDeleted: number;
  entriesAcceleratedDecay: number;
  shortfall: number;
  status: "within_budget" | "accelerated_decay" | "pruned" | "failed_closed";
  errors: string[];
  durationMs: number;
}

async function runBudgetEnforcement(): Promise<BudgetEnforcementResult> {
  const startTime = Date.now();
  log.log("[Sleep:budget] Starting budget enforcement check");
  logPoolHealth("budget-start");

  const result: BudgetEnforcementResult = {
    totalCount: 0,
    finalCount: 0,
    target: MEMORY_BUDGET_TARGET,
    hardCap: MEMORY_BUDGET_HARD_CAP,
    surplus: 0,
    finalSurplus: 0,
    emergencyMode: false,
    deletionRequired: false,
    deleteTarget: 0,
    candidatesFound: 0,
    entriesDeleted: 0,
    entriesAcceleratedDecay: 0,
    shortfall: 0,
    status: "within_budget",
    errors: [],
    durationMs: 0,
  };

  try {
    const { memoryStorage } = await import("./memory/memory-storage");
    result.totalCount = await memoryStorage.getLongTermEntryCount();
    result.finalCount = result.totalCount;
    result.surplus = Math.max(0, result.totalCount - MEMORY_BUDGET_TARGET);
    result.finalSurplus = result.surplus;

    if (result.totalCount <= MEMORY_BUDGET_TARGET) {
      log.log(`[Sleep:budget] Within budget: ${result.totalCount}/${MEMORY_BUDGET_TARGET}`);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    result.entriesAcceleratedDecay = result.surplus;
    result.emergencyMode = result.totalCount > MEMORY_BUDGET_HARD_CAP;
    result.deletionRequired = result.emergencyMode;

    if (result.deletionRequired) {
      result.deleteTarget = Math.min(
        result.surplus + BUDGET_DAILY_GROWTH_BUFFER,
        MAX_BUDGET_EMERGENCY_DELETE,
      );

      log.warn(`[Sleep:budget] EMERGENCY MODE: count=${result.totalCount} exceeds hard cap=${MEMORY_BUDGET_HARD_CAP}. Targeting ${result.deleteTarget} deletions (surplus=${result.surplus}, growthBuffer=${BUDGET_DAILY_GROWTH_BUFFER}).`);

      eventBus.publish({
        category: "system",
        event: "sleep:budget_emergency",
        payload: {
          totalCount: result.totalCount,
          hardCap: MEMORY_BUDGET_HARD_CAP,
          target: MEMORY_BUDGET_TARGET,
          surplus: result.surplus,
          dailyGrowthBuffer: BUDGET_DAILY_GROWTH_BUFFER,
          deleteTarget: result.deleteTarget,
        },
      });

      const candidates = await memoryStorage.getLowestValueEntries(result.deleteTarget);
      result.candidatesFound = candidates.length;
      log.log(`[Sleep:budget] Found ${candidates.length}/${result.deleteTarget} deletion candidates`);

      for (const candidate of candidates) {
        try {
          const deleteResult = await memoryStorage.deleteEntry(candidate.id);
          if (deleteResult.deleted) {
            result.entriesDeleted++;
            log.debug(`[Sleep:budget] Deleted entry #${candidate.id} (value=${candidate.value.toFixed(4)})`);
          } else {
            result.errors.push(`delete #${candidate.id}: entry was not deleted`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`delete #${candidate.id}: ${msg}`);
          if (isConnectionError(msg)) {
            recordCircuitBreakerFailure("budget", msg);
          }
        }
      }

      result.finalCount = await memoryStorage.getLongTermEntryCount();
      result.finalSurplus = Math.max(0, result.finalCount - MEMORY_BUDGET_TARGET);
      result.shortfall = Math.max(0, result.deleteTarget - result.entriesDeleted);
      result.status = result.finalCount > MEMORY_BUDGET_HARD_CAP || result.entriesDeleted === 0 ? "failed_closed" : "pruned";

      log.log(`[Sleep:budget] Emergency pruning complete: deleted=${result.entriesDeleted}/${result.deleteTarget}, candidates=${result.candidatesFound}, count=${result.totalCount}->${result.finalCount}, finalSurplus=${result.finalSurplus}, shortfall=${result.shortfall}, status=${result.status}, errors=${result.errors.length}`);

      if (result.status === "failed_closed") {
        const reason = `Budget enforcement failed closed: count=${result.totalCount}->${result.finalCount}, hardCap=${MEMORY_BUDGET_HARD_CAP}, deleted=${result.entriesDeleted}/${result.deleteTarget}, candidates=${result.candidatesFound}`;
        result.errors.push(reason);
        log.error(`[Sleep:budget] ${reason}`);
        eventBus.publish({
          category: "system",
          event: "sleep:budget_failed_closed",
          payload: {
            totalCount: result.totalCount,
            finalCount: result.finalCount,
            target: MEMORY_BUDGET_TARGET,
            hardCap: MEMORY_BUDGET_HARD_CAP,
            deleteTarget: result.deleteTarget,
            candidatesFound: result.candidatesFound,
            entriesDeleted: result.entriesDeleted,
            shortfall: result.shortfall,
          },
        });
      }
    } else {
      result.status = "accelerated_decay";
      log.log(`[Sleep:budget] Over budget: ${result.totalCount}/${MEMORY_BUDGET_TARGET} (surplus=${result.surplus}). Accelerated decay applies; hard deletion begins above ${MEMORY_BUDGET_HARD_CAP}.`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`budget-enforcement: ${msg}`);
    log.error(`[Sleep:budget] Error during budget enforcement: ${msg}`);
    if (isConnectionError(msg)) {
      recordCircuitBreakerFailure("budget", msg);
    }
  }

  result.durationMs = Date.now() - startTime;
  return result;
}


export interface FullSleepCycleResult {
  entryDecay: MemoryDecayResult;
  budget: BudgetEnforcementResult;
  entryReinforcement: MemoryReinforcementResult;
  vnextLifecycle?: import("./memory/vnext-lifecycle").VnextLifecycleRunResult;
  nrem: import("./memory/sleep-maintenance").NREMResult;
  rem: import("./memory/dream-engine").DreamResult;
  gsi: import("./memory/graph-metrics").GSIScore | null;
  durationMs: number;
  abortedByCircuitBreaker?: boolean;
  abortReason?: string;
  timedOut?: boolean;
  phaseDurations: Record<string, number>;
}

export async function runFullSleepCycle(options?: { includeGSI?: boolean }): Promise<FullSleepCycleResult> {
  return withQueryAttributionAsync("memory-write", async () => {
    const startTime = Date.now();
    log.log("[Sleep] Starting full NREM/REM sleep cycle");
    logPoolHealth("cycle-start");
    resetCircuitBreaker();
    resetZombiePeakCount();

    const globalController = new AbortController();
    const globalTimeoutTimer = setTimeout(() => {
      log.error(`[Sleep] GLOBAL TIMEOUT: Sleep cycle exceeded ${GLOBAL_SLEEP_CYCLE_TIMEOUT_MS}ms — aborting remaining phases`);
      globalController.abort();
    }, GLOBAL_SLEEP_CYCLE_TIMEOUT_MS);

    const poolAtStart = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    const emptyDecay: MemoryDecayResult = { decayed: 0, byLayer: {}, byStage: {}, flippedUncertain: 0, flaggedForReview: 0, errors: [] };
    const emptyReinforcement: MemoryReinforcementResult = { reinforced: 0, byLayer: {}, byStage: {}, errors: [] };
    const emptyNrem: import("./memory/sleep-maintenance").NREMResult = {
      linksDecayed: 0, linksPruned: 0, linksReinforced: 0, entriesMerged: 0,
      orphansRemoved: 0, orphansLinked: 0, longTitlesHealed: 0, errors: [], durationMs: 0,
      mergeEvalsAttempted: 0, mergeEvalsFailed: 0, mergeAbortedEarly: false,
      orphanEvalsAttempted: 0, orphanEvalsFailed: 0,
      orphanCandidatesFound: 0, orphanDeleteAttempts: 0, orphanDeleteFailures: 0,
      orphanLinkAttempts: 0, orphanLinkFailures: 0,
      llmCallsAttempted: 0, llmCallsSucceeded: 0,
      heuristicMerges: 0, heuristicSkips: 0,
      heuristicOrphanDeletes: 0, heuristicOrphanKeeps: 0,
      dormantCandidatesFound: 0, dormantPruned: 0, dormantDeleteAttempts: 0, dormantDeleteFailures: 0,
      llmHealthProbeResult: "skipped",
      entriesAdvancedToUpkeep: 0,
      sourceRefsEnriched: 0,
    };
    const emptyRem: import("./memory/dream-engine").DreamResult = {
      seedCount: 0, domainsWoven: 0, conceptsSynthesized: 0,
      dreamEntryId: null, dreamTitle: null, seedLayers: {}, seedStages: {}, sourceRefsCreated: 0, errors: [], durationMs: 0,
      llmCallsAttempted: 0, llmCallsSucceeded: 0,
    };

    let entryDecay = emptyDecay;
    let entryReinforcement = emptyReinforcement;
    let vnextLifecycleResult: import("./memory/vnext-lifecycle").VnextLifecycleRunResult | undefined;
    let nrem = emptyNrem;
    let rem = emptyRem;
    let gsi: import("./memory/graph-metrics").GSIScore | null = null;
    let abortedByCircuitBreaker = false;
    let abortReason: string | undefined;
    let timedOut = false;
    const phaseDurations: Record<string, number> = {};
    const emptyBudget: BudgetEnforcementResult = {
      totalCount: 0, finalCount: 0, target: MEMORY_BUDGET_TARGET, hardCap: MEMORY_BUDGET_HARD_CAP,
      surplus: 0, finalSurplus: 0, emergencyMode: false, deletionRequired: false,
      deleteTarget: 0, candidatesFound: 0, entriesDeleted: 0, entriesAcceleratedDecay: 0,
      shortfall: 0, status: "within_budget", errors: [], durationMs: 0,
    };
    let budget = emptyBudget;

    let phaseStart: number;
    try {
      // Phase 0: Budget enforcement (runs first)
      phaseStart = Date.now();
      budget = await runBudgetEnforcement();
      phaseDurations.budget = Date.now() - phaseStart;

      if (globalController.signal.aborted) {
        timedOut = true;
        throw new Error("Global sleep cycle timeout");
      }

      await waitForBackpressure("decay");
      logPoolHealth("pre-decay");

      phaseStart = Date.now();
      entryDecay = await runMemoryDecay();
      phaseDurations.decay = Date.now() - phaseStart;

      if (globalController.signal.aborted) {
        timedOut = true;
        throw new Error("Global sleep cycle timeout");
      }

      await waitForBackpressure("reinforcement");
      logPoolHealth("pre-reinforcement");
      phaseStart = Date.now();
      entryReinforcement = await runMemoryReinforcement();
      phaseDurations.reinforcement = Date.now() - phaseStart;

      if (globalController.signal.aborted) {
        timedOut = true;
        throw new Error("Global sleep cycle timeout");
      }

      // Phase 2.5: vNext claim lifecycle (decay + retirement)
      await waitForBackpressure("vnext-lifecycle");
      logPoolHealth("pre-vnext-lifecycle");
      try {
        const { runVnextLifecycle } = await import("./memory/vnext-lifecycle");
        phaseStart = Date.now();
        const vnextResult = await runVnextLifecycle({ limit: 200, trigger: "sleep_cycle" });
        phaseDurations.vnextLifecycle = Date.now() - phaseStart;
        vnextLifecycleResult = vnextResult;
        log.log(`[Sleep] vNext lifecycle: scanned=${vnextResult.scanned} retired=${vnextResult.retired} decayed=${vnextResult.decayed} canonicalized=${vnextResult.canonicalized} errors=${vnextResult.errors}`);
      } catch (vnextErr: unknown) {
        phaseDurations.vnextLifecycle = Date.now() - phaseStart;
        log.warn(`[Sleep] vNext lifecycle failed (non-fatal): ${vnextErr instanceof Error ? vnextErr.message : String(vnextErr)}`);
      }

      if (globalController.signal.aborted) {
        timedOut = true;
        throw new Error("Global sleep cycle timeout");
      }

      await waitForBackpressure("nrem");
      logPoolHealth("pre-nrem");
      const { runNREMPhase } = await import("./memory/sleep-maintenance");
      try {
        phaseStart = Date.now();
        nrem = await runNREMPhase(globalController.signal);
        phaseDurations.nrem = Date.now() - phaseStart;

        if (nrem.llmHealthProbeResult === "failed") {
          log.warn(`[Sleep] NREM LLM health probe failed — recording circuit breaker failure`);
          recordCircuitBreakerFailure("nrem", "LLM health probe failed");
        } else {
          const totalNremEvals = nrem.mergeEvalsAttempted + nrem.orphanEvalsAttempted;
          const totalNremFailures = nrem.mergeEvalsFailed + nrem.orphanEvalsFailed;
          if (totalNremEvals > 0 && (totalNremFailures / totalNremEvals) > NREM_ERROR_RATIO_THRESHOLD) {
            log.warn(`[Sleep] NREM phase had high failure rate: ${totalNremFailures}/${totalNremEvals} evals failed (${(totalNremFailures / totalNremEvals * 100).toFixed(0)}%)`);
            recordCircuitBreakerFailure("nrem", `High NREM failure rate: ${totalNremFailures}/${totalNremEvals} evals failed`);
          } else if (nrem.errors.length >= 3) {
            log.warn(`[Sleep] NREM phase had ${nrem.errors.length} internal errors — recording circuit breaker failure`);
            recordCircuitBreakerFailure("nrem", `${nrem.errors.length} NREM internal errors`);
          } else {
            recordCircuitBreakerSuccess();
          }
        }
      } catch (nremErr: unknown) {
        phaseDurations.nrem = Date.now() - phaseStart;
        const msg = nremErr instanceof Error ? nremErr.message : String(nremErr);
        if (nremErr instanceof CircuitBreakerTripped) throw nremErr;
        if (isConnectionError(msg)) {
          recordCircuitBreakerFailure("nrem", msg);
        }
        throw nremErr;
      }

      if (globalController.signal.aborted) {
        timedOut = true;
        throw new Error("Global sleep cycle timeout");
      }

      await waitForBackpressure("rem");
      logPoolHealth("pre-rem");
      const { runREMPhase } = await import("./memory/dream-engine");
      try {
        phaseStart = Date.now();
        rem = await runREMPhase(globalController.signal);
        phaseDurations.rem = Date.now() - phaseStart;

        if (rem.llmCallsAttempted > 0 && rem.llmCallsSucceeded === 0) {
          log.warn(`[Sleep] REM phase had 100% LLM failure rate: ${rem.llmCallsAttempted} attempted, 0 succeeded`);
          recordCircuitBreakerFailure("rem", `All ${rem.llmCallsAttempted} REM LLM calls failed`);
        } else if (rem.llmCallsAttempted > 0) {
          const remFailureRatio = (rem.llmCallsAttempted - rem.llmCallsSucceeded) / Math.max(1, rem.llmCallsAttempted);
          if (remFailureRatio > NREM_ERROR_RATIO_THRESHOLD) {
            log.warn(`[Sleep] REM phase had high LLM failure rate: ${rem.llmCallsAttempted - rem.llmCallsSucceeded}/${rem.llmCallsAttempted} failed`);
            recordCircuitBreakerFailure("rem", `High REM LLM failure rate: ${rem.llmCallsAttempted - rem.llmCallsSucceeded}/${rem.llmCallsAttempted}`);
          } else if (rem.errors.length >= 2) {
            log.warn(`[Sleep] REM phase had ${rem.errors.length} internal errors — recording circuit breaker failure`);
            recordCircuitBreakerFailure("rem", `${rem.errors.length} REM internal errors`);
          } else {
            recordCircuitBreakerSuccess();
          }
        } else if (rem.errors.length >= 2) {
          log.warn(`[Sleep] REM phase had ${rem.errors.length} internal errors (no LLM attempted) — recording circuit breaker failure`);
          recordCircuitBreakerFailure("rem", `${rem.errors.length} REM internal errors`);
        } else {
          recordCircuitBreakerSuccess();
        }
      } catch (remErr: unknown) {
        phaseDurations.rem = Date.now() - phaseStart;
        const msg = remErr instanceof Error ? remErr.message : String(remErr);
        if (remErr instanceof CircuitBreakerTripped) throw remErr;
        if (isConnectionError(msg)) {
          recordCircuitBreakerFailure("rem", msg);
        }
        throw remErr;
      }

      if (options?.includeGSI) {
        if (globalController.signal.aborted) {
          timedOut = true;
          throw new Error("Global sleep cycle timeout");
        }

        await waitForBackpressure("gsi");
        logPoolHealth("pre-gsi");
        const { computeGSI } = await import("./memory/graph-metrics");
        try {
          phaseStart = Date.now();
          gsi = await withQueryAttributionAsync("memory-write", () => computeGSI(), "compute-gsi");
          phaseDurations.gsi = Date.now() - phaseStart;
          recordCircuitBreakerSuccess();
        } catch (gsiErr: unknown) {
          phaseDurations.gsi = Date.now() - phaseStart;
          const msg = gsiErr instanceof Error ? gsiErr.message : String(gsiErr);
          if (gsiErr instanceof CircuitBreakerTripped) throw gsiErr;
          if (isConnectionError(msg)) {
            recordCircuitBreakerFailure("gsi", msg);
          }
          throw gsiErr;
        }
      }
    } catch (err: unknown) {
      if (err instanceof CircuitBreakerTripped) {
        abortedByCircuitBreaker = true;
        abortReason = err.message;
        log.error(`[Sleep] Sleep cycle ABORTED by circuit breaker: ${err.message}`);
        logPoolHealth("circuit-breaker-abort", `phase=${err.phase} failures=${err.consecutiveFailures}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Global sleep cycle timeout")) {
          timedOut = true;
          abortReason = `Global timeout exceeded (${GLOBAL_SLEEP_CYCLE_TIMEOUT_MS}ms)`;
          log.error(`[Sleep] Sleep cycle ABORTED by global timeout after ${Date.now() - startTime}ms`);
        } else {
          log.error(`[Sleep] Sleep cycle error: ${msg}`);
        }
        logPoolHealth("error", msg);
      }
    } finally {
      clearTimeout(globalTimeoutTimer);
    }

    const durationMs = Date.now() - startTime;
    const poolAtEnd = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    const totalLlmAttempted = nrem.llmCallsAttempted + rem.llmCallsAttempted;
    const totalLlmSucceeded = nrem.llmCallsSucceeded + rem.llmCallsSucceeded;
    const allErrors = [
      ...entryDecay.errors.map(e => `entry-decay: ${e}`),
      ...budget.errors.map(e => `budget: ${e}`),
      ...entryReinforcement.errors.map(e => `reinforcement: ${e}`),
      ...nrem.errors.map(e => `nrem: ${e}`),
      ...rem.errors.map(e => `rem: ${e}`),
    ];

    const summaryObj = {
      durationMs,
      budget: { count: budget.totalCount, finalCount: budget.finalCount, target: budget.target, hardCap: budget.hardCap, surplus: budget.surplus, finalSurplus: budget.finalSurplus, emergency: budget.emergencyMode, deletionRequired: budget.deletionRequired, deleteTarget: budget.deleteTarget, candidatesFound: budget.candidatesFound, deleted: budget.entriesDeleted, shortfall: budget.shortfall, status: budget.status, acceleratedDecay: budget.entriesAcceleratedDecay },
      phaseDurations,
      decayed: { total: entryDecay.decayed, byLayer: entryDecay.byLayer, byStage: entryDecay.byStage },
      reinforced: { total: entryReinforcement.reinforced, byLayer: entryReinforcement.byLayer, byStage: entryReinforcement.byStage },
      nrem: {
        linksDecayed: nrem.linksDecayed,
        linksPruned: nrem.linksPruned,
        linksReinforced: nrem.linksReinforced,
        merged: nrem.entriesMerged,
        orphansFound: nrem.orphanCandidatesFound,
        orphansRemoved: nrem.orphansRemoved,
        orphansLinked: nrem.orphansLinked,
        orphanDeleteAttempts: nrem.orphanDeleteAttempts,
        orphanDeleteFailures: nrem.orphanDeleteFailures,
        orphanLinkAttempts: nrem.orphanLinkAttempts,
        orphanLinkFailures: nrem.orphanLinkFailures,
        mergeAborted: nrem.mergeAbortedEarly,
        heuristicMerges: nrem.heuristicMerges,
        heuristicSkips: nrem.heuristicSkips,
        heuristicOrphanDeletes: nrem.heuristicOrphanDeletes,
        heuristicOrphanKeeps: nrem.heuristicOrphanKeeps,
        dormantCandidatesFound: nrem.dormantCandidatesFound,
        dormantPruned: nrem.dormantPruned,
        dormantDeleteAttempts: nrem.dormantDeleteAttempts,
        dormantDeleteFailures: nrem.dormantDeleteFailures,
        llmHealthProbe: nrem.llmHealthProbeResult,
        entriesAdvancedToUpkeep: nrem.entriesAdvancedToUpkeep,
        sourceRefsEnriched: nrem.sourceRefsEnriched,
      },
      rem: {
        dreamId: rem.dreamEntryId,
        dreamTitle: rem.dreamTitle,
        seeds: rem.seedCount,
        domainsWoven: rem.domainsWoven,
        concepts: rem.conceptsSynthesized,
        seedLayers: rem.seedLayers,
        seedStages: rem.seedStages,
        sourceRefsCreated: rem.sourceRefsCreated,
        llmAttempted: rem.llmCallsAttempted,
        llmSucceeded: rem.llmCallsSucceeded,
      },
      gsiScore: gsi?.overall ?? null,
      llm: { attempted: totalLlmAttempted, succeeded: totalLlmSucceeded },
      circuitBreaker: { failures: circuitBreakerFailures, tripped: abortedByCircuitBreaker },
      pool: { start: poolAtStart, end: poolAtEnd },
      zombies: getZombieMetrics(),
      aborted: abortedByCircuitBreaker,
      timedOut,
      abortReason: abortReason || null,
      errorCount: allErrors.length,
      phaseErrorCounts: {
        budget: budget.errors.length,
        decay: entryDecay.errors.length,
        reinforcement: entryReinforcement.errors.length,
        nrem: nrem.errors.length,
        rem: rem.errors.length,
      },
    };

    log.log(`[Sleep:summary] ${JSON.stringify(summaryObj)}`);

    log.log(`[Sleep] Full sleep cycle complete in ${durationMs}ms${abortedByCircuitBreaker ? " (ABORTED)" : ""}${timedOut ? " (TIMED OUT)" : ""}`);
    logPoolHealth("cycle-end", `duration=${durationMs}ms`);

    try {
      const { memoryStorage } = await import("./memory/memory-storage");
      const reportDate = new Date().toISOString().slice(0, 10);
      const reportLines = [
        `# Sleep Cycle Report — ${reportDate}`,
        `Duration: ${(durationMs / 1000).toFixed(1)}s`,
        abortedByCircuitBreaker ? `**ABORTED**: ${abortReason}` : "",
        timedOut ? `**TIMED OUT**: ${abortReason}` : "",
        "",
        "## Budget",
        `- Initial entries: ${budget.totalCount}`,
        `- Final entries: ${budget.finalCount}`,
        `- Target: ${budget.target}`,
        `- Hard cap: ${budget.hardCap}`,
        `- Initial surplus: ${budget.surplus}`,
        `- Final surplus: ${budget.finalSurplus}`,
        `- Status: ${budget.status}`,
        budget.emergencyMode ? `- **EMERGENCY MODE**: ${budget.entriesDeleted}/${budget.deleteTarget} deleted (candidates=${budget.candidatesFound}, shortfall=${budget.shortfall})` : "",
        budget.entriesAcceleratedDecay > 0 ? `- Accelerated decay marked: ${budget.entriesAcceleratedDecay} entries` : "",
        "",
        "## Entry-Level",
        `- Decayed: ${entryDecay.decayed} by layer ${JSON.stringify(entryDecay.byLayer)} / stage ${JSON.stringify(entryDecay.byStage)}`,
        `- Reinforced: ${entryReinforcement.reinforced} by layer ${JSON.stringify(entryReinforcement.byLayer)} / stage ${JSON.stringify(entryReinforcement.byStage)}`,
        `- Flipped uncertain: ${entryDecay.flippedUncertain}`,
        `- Flagged for review: ${entryDecay.flaggedForReview}`,
        "",
        "## vNext Claims",
        vnextLifecycleResult
          ? [
              `- Scanned: ${vnextLifecycleResult.scanned}`,
              `- Retired: ${vnextLifecycleResult.retired}${vnextLifecycleResult.retired > 0 ? ` (${Object.entries(vnextLifecycleResult.retiredByReason).map(([r, c]) => `${r}=${c}`).join(", ")})` : ""}`,
              `- Decayed: ${vnextLifecycleResult.decayed}`,
              `- Canonicalized: ${vnextLifecycleResult.canonicalized}`,
              `- Sourced: ${vnextLifecycleResult.sourced}`,
              `- Linked: ${vnextLifecycleResult.linked}`,
              `- Errors: ${vnextLifecycleResult.errors}`,
            ].join("\n")
          : "- Skipped (phase did not run)",
        "",
        "## NREM",
        `- Links decayed: ${nrem.linksDecayed}`,
        `- Links pruned: ${nrem.linksPruned}`,
        `- Links reinforced: ${nrem.linksReinforced}`,
        `- Entries merged: ${nrem.entriesMerged} (heuristic=${nrem.heuristicMerges} LLM=${nrem.entriesMerged - nrem.heuristicMerges})`,
        `- Heuristic skips: ${nrem.heuristicSkips}`,
        `- Merge aborted early: ${nrem.mergeAbortedEarly}`,
        `- LLM health probe: ${nrem.llmHealthProbeResult}`,
        `- Orphans found: ${nrem.orphanCandidatesFound}`,
        `- Orphans removed: ${nrem.orphansRemoved}/${nrem.orphanDeleteAttempts} (heuristic=${nrem.heuristicOrphanDeletes} LLM=${nrem.orphansRemoved - nrem.heuristicOrphanDeletes}, failures=${nrem.orphanDeleteFailures})`,
        `- Orphans linked: ${nrem.orphansLinked}/${nrem.orphanLinkAttempts} (failures=${nrem.orphanLinkFailures})`,
        `- Advanced to Stage 4 upkeep: ${nrem.entriesAdvancedToUpkeep}`,
        `- Source refs enriched: ${nrem.sourceRefsEnriched}`,
        `- Dormant candidates: ${nrem.dormantCandidatesFound}`,
        `- Dormant pruned: ${nrem.dormantPruned}/${nrem.dormantDeleteAttempts} (failures=${nrem.dormantDeleteFailures})`,
        `- LLM calls: ${nrem.llmCallsSucceeded}/${nrem.llmCallsAttempted} succeeded`,
        "",
        "## REM",
        `- Dream: ${rem.dreamTitle || "none"}${rem.dreamEntryId ? ` (#${rem.dreamEntryId})` : ""}`,
        `- Seeds: ${rem.seedCount}`,
        `- Domains woven: ${rem.domainsWoven}`,
        `- Concepts synthesized: ${rem.conceptsSynthesized}`,
        `- Seed layers: ${JSON.stringify(rem.seedLayers)}`,
        `- Seed stages: ${JSON.stringify(rem.seedStages)}`,
        `- Source refs created: ${rem.sourceRefsCreated}`,
        "",
        "## Phase Durations",
        ...Object.entries(phaseDurations).map(([phase, ms]) => `- ${phase}: ${(ms / 1000).toFixed(1)}s`),
      ].filter(Boolean);

      if (gsi) {
        reportLines.push(
          "",
          "## GSI",
          `- Overall: ${(gsi.overall * 100).toFixed(1)}%`,
          `- Connectivity: ${(gsi.connectivity * 100).toFixed(1)}%`,
          `- Link Quality: ${(gsi.linkQuality * 100).toFixed(1)}%`,
          `- Orphan Rate: ${(gsi.orphanRate * 100).toFixed(1)}%`,
        );
      }

      if (allErrors.length > 0) {
        reportLines.push("", "## Errors", ...allErrors.map(e => `- ${e}`));
      }

      const reportContent = reportLines.join("\n");
      await memoryStorage.ingest(
        reportContent,
        "memory",
        `sleep-report-${reportDate}`,
        {
          type: "sleep_report",
          date: reportDate,
          durationMs,
          gsiScore: gsi?.overall ?? null,
          entriesDecayed: entryDecay.decayed,
          entriesMerged: nrem.entriesMerged,
          dreamId: rem.dreamEntryId,
          abortedByCircuitBreaker,
          timedOut,
          llmCallsAttempted: totalLlmAttempted,
          llmCallsSucceeded: totalLlmSucceeded,
          heuristicMerges: nrem.heuristicMerges,
          heuristicSkips: nrem.heuristicSkips,
          budgetCount: budget.totalCount,
          budgetFinalCount: budget.finalCount,
          budgetTarget: budget.target,
          budgetHardCap: budget.hardCap,
          budgetSurplus: budget.surplus,
          budgetFinalSurplus: budget.finalSurplus,
          budgetStatus: budget.status,
          budgetEmergency: budget.emergencyMode,
          budgetDeleteTarget: budget.deleteTarget,
          budgetCandidatesFound: budget.candidatesFound,
          budgetDeleted: budget.entriesDeleted,
          budgetShortfall: budget.shortfall,
        },
        ["sleep-report", "system-metrics"],
        `Sleep Report — ${reportDate}`,
      );

      const { appendJournalEntry } = await import("./chat-journal");
      appendJournalEntry({
        ts: Date.now(),
        type: "done",
        sessionKey: `sleep-cycle:${reportDate}`,
        sessionId: `sleep-cycle:${reportDate}`,
        source: "system",
        content: reportContent,
      });

      log.debug(`[Sleep] Sleep report stored as memory entry and journal entry`);
    } catch (reportErr: unknown) {
      log.error(`[Sleep] Failed to store sleep report: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`);
    }

    eventBus.publish({
      category: "system",
      event: "sleep:cycle_complete",
      payload: {
        durationMs,
        budget: { count: budget.totalCount, finalCount: budget.finalCount, target: budget.target, hardCap: budget.hardCap, surplus: budget.surplus, finalSurplus: budget.finalSurplus, emergency: budget.emergencyMode, deletionRequired: budget.deletionRequired, deleteTarget: budget.deleteTarget, candidatesFound: budget.candidatesFound, deleted: budget.entriesDeleted, shortfall: budget.shortfall, status: budget.status },
        abortedByCircuitBreaker,
        timedOut,
        entryDecay: { decayed: entryDecay.decayed, byLayer: entryDecay.byLayer, byStage: entryDecay.byStage, flippedUncertain: entryDecay.flippedUncertain },
        entryReinforcement: { reinforced: entryReinforcement.reinforced, byLayer: entryReinforcement.byLayer, byStage: entryReinforcement.byStage },
        vnextLifecycle: vnextLifecycleResult ? { scanned: vnextLifecycleResult.scanned, retired: vnextLifecycleResult.retired, decayed: vnextLifecycleResult.decayed, canonicalized: vnextLifecycleResult.canonicalized, errors: vnextLifecycleResult.errors } : null,
        nrem: { linksDecayed: nrem.linksDecayed, linksPruned: nrem.linksPruned, merged: nrem.entriesMerged, entriesAdvancedToUpkeep: nrem.entriesAdvancedToUpkeep, heuristicMerges: nrem.heuristicMerges },
        rem: { dreamId: rem.dreamEntryId, dreamTitle: rem.dreamTitle, seedStages: rem.seedStages },
        gsiScore: gsi?.overall ?? null,
        llmCalls: { attempted: totalLlmAttempted, succeeded: totalLlmSucceeded },
      },
    });

    return { budget, entryDecay, entryReinforcement, vnextLifecycle: vnextLifecycleResult, nrem, rem, gsi, durationMs, abortedByCircuitBreaker, abortReason, timedOut, phaseDurations };
  }, "sleep-cycle");
}

export { runMemoryDecay as runBeliefDecay, runMemoryReinforcement as runBeliefReinforcement };
export type { MemoryDecayResult as BeliefDecayResult, MemoryReinforcementResult as BeliefReinforcementResult };
