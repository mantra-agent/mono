import { createLogger } from "./log";
import { eventBus } from "./event-bus";
import { pool, withQueryAttributionAsync } from "./db";
import { getZombieMetrics, resetZombiePeakCount } from "./cli-sdk-adapter";
import type { VnextLifecycleRunResult } from "./memory/vnext-lifecycle";
import type { DreamResult } from "./memory/dream-engine";
import type { GSIScore } from "./memory/graph-metrics";

const log = createLogger("SleepCycle");

const BACKPRESSURE_POLL_MS = 2000;
const BACKPRESSURE_MAX_WAIT_MS = 60_000;
const GLOBAL_SLEEP_CYCLE_TIMEOUT_MS = 10 * 60 * 1000;

function logPoolHealth(phase: string, context?: string): void {
  const extra = context ? ` ${context}` : "";
  log.debug(`[Sleep:pool] phase=${phase} pool=[total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}]${extra}`);
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

export interface FullSleepCycleResult {
  vnextLifecycle: VnextLifecycleRunResult | null;
  rem: DreamResult;
  gsi: GSIScore | null;
  durationMs: number;
  timedOut?: boolean;
  abortReason?: string;
  phaseDurations: Record<string, number>;
  errors: string[];
}

function emptyRem(): DreamResult {
  return {
    seedCount: 0,
    sessionCount: 0,
    domainsWoven: 0,
    dreamTitle: null,
    dreamNarrative: null,
    dreamInsight: null,
    errors: [],
    durationMs: 0,
    llmCallsAttempted: 0,
    llmCallsSucceeded: 0,
  };
}

/**
 * Nightly sleep cycle over the vNext memory graph:
 *   1. Existing vNext claim lifecycle (advancement, retirement, decay, bridges)
 *   2. REM dream generation (seeded from active claims + recent sessions)
 *   3. Optional GSI computation (weekly)
 *
 * The cycle no longer touches legacy memory_entries state. The report is
 * emitted to the journal and event bus; durable filing (Library dream page,
 * sleep report page) is owned by the sleep skill using the returned result.
 */
export async function runFullSleepCycle(options?: { includeGSI?: boolean }): Promise<FullSleepCycleResult> {
  return withQueryAttributionAsync("memory-write", async () => {
    const startTime = Date.now();
    log.log("[Sleep] Starting sleep cycle (vNext lifecycle + REM)");
    logPoolHealth("cycle-start");
    resetZombiePeakCount();

    const globalController = new AbortController();
    const globalTimeoutTimer = setTimeout(() => {
      log.error(`[Sleep] GLOBAL TIMEOUT: Sleep cycle exceeded ${GLOBAL_SLEEP_CYCLE_TIMEOUT_MS}ms — aborting remaining phases`);
      globalController.abort();
    }, GLOBAL_SLEEP_CYCLE_TIMEOUT_MS);

    const poolAtStart = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };

    let vnextLifecycle: VnextLifecycleRunResult | null = null;
    let rem: DreamResult = emptyRem();
    let gsi: GSIScore | null = null;
    let timedOut = false;
    let abortReason: string | undefined;
    const phaseDurations: Record<string, number> = {};
    const errors: string[] = [];

    let phaseStart = Date.now();
    try {
      // Phase 1: vNext claim lifecycle
      await waitForBackpressure("vnext-lifecycle");
      logPoolHealth("pre-vnext-lifecycle");
      try {
        const { runVnextLifecycle } = await import("./memory/vnext-lifecycle");
        phaseStart = Date.now();
        vnextLifecycle = await runVnextLifecycle({ limit: 200, trigger: "sleep_cycle" });
        phaseDurations.vnextLifecycle = Date.now() - phaseStart;
        log.log(
          `[Sleep] vNext lifecycle: scanned=${vnextLifecycle.scanned} retired=${vnextLifecycle.retired} ` +
          `decayed=${vnextLifecycle.decayed} canonicalized=${vnextLifecycle.canonicalized} ` +
          `bridgesCreated=${vnextLifecycle.bridges.created} errors=${vnextLifecycle.errors}`,
        );
      } catch (vnextErr: unknown) {
        phaseDurations.vnextLifecycle = Date.now() - phaseStart;
        const msg = vnextErr instanceof Error ? vnextErr.message : String(vnextErr);
        errors.push(`vnext-lifecycle: ${msg}`);
        log.error(`[Sleep] vNext lifecycle failed: ${msg}`);
      }

      if (globalController.signal.aborted) {
        timedOut = true;
        throw new Error("Global sleep cycle timeout");
      }

      // Phase 2: REM dream generation
      await waitForBackpressure("rem");
      logPoolHealth("pre-rem");
      const { runREMPhase } = await import("./memory/dream-engine");
      phaseStart = Date.now();
      rem = await runREMPhase(globalController.signal);
      phaseDurations.rem = Date.now() - phaseStart;
      errors.push(...rem.errors.map((e) => `rem: ${e}`));

      // Phase 3: optional GSI
      if (options?.includeGSI) {
        if (globalController.signal.aborted) {
          timedOut = true;
          throw new Error("Global sleep cycle timeout");
        }
        await waitForBackpressure("gsi");
        logPoolHealth("pre-gsi");
        try {
          const { computeGSI } = await import("./memory/graph-metrics");
          phaseStart = Date.now();
          gsi = await computeGSI();
          phaseDurations.gsi = Date.now() - phaseStart;
        } catch (gsiErr: unknown) {
          phaseDurations.gsi = Date.now() - phaseStart;
          const msg = gsiErr instanceof Error ? gsiErr.message : String(gsiErr);
          errors.push(`gsi: ${msg}`);
          log.error(`[Sleep] GSI computation failed: ${msg}`);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Global sleep cycle timeout")) {
        timedOut = true;
        abortReason = `Global timeout exceeded (${GLOBAL_SLEEP_CYCLE_TIMEOUT_MS}ms)`;
        log.error(`[Sleep] Sleep cycle ABORTED by global timeout after ${Date.now() - startTime}ms`);
      } else {
        errors.push(msg);
        log.error(`[Sleep] Sleep cycle error: ${msg}`);
      }
      logPoolHealth("error", msg);
    } finally {
      clearTimeout(globalTimeoutTimer);
    }

    const durationMs = Date.now() - startTime;
    const poolAtEnd = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };

    const summaryObj = {
      durationMs,
      phaseDurations,
      vnextLifecycle: vnextLifecycle
        ? {
            scanned: vnextLifecycle.scanned,
            retired: vnextLifecycle.retired,
            retiredByReason: vnextLifecycle.retiredByReason,
            decayed: vnextLifecycle.decayed,
            canonicalized: vnextLifecycle.canonicalized,
            sourced: vnextLifecycle.sourced,
            linked: vnextLifecycle.linked,
            bridges: { created: vnextLifecycle.bridges.created, finalEdges: vnextLifecycle.bridges.finalEdges, ceiling: vnextLifecycle.bridges.ceiling },
            shadowPredictions: vnextLifecycle.shadowPredictions
              ? {
                  generated: vnextLifecycle.shadowPredictions.generated,
                  resolved: vnextLifecycle.shadowPredictions.resolved,
                  scored: vnextLifecycle.shadowPredictions.scored,
                  certaintyUpdates: vnextLifecycle.shadowPredictions.certaintyUpdates,
                  abstained: vnextLifecycle.shadowPredictions.abstained,
                }
              : null,
            errors: vnextLifecycle.errors,
          }
        : null,
      rem: {
        dreamTitle: rem.dreamTitle,
        seeds: rem.seedCount,
        sessions: rem.sessionCount,
        domainsWoven: rem.domainsWoven,
        llmAttempted: rem.llmCallsAttempted,
        llmSucceeded: rem.llmCallsSucceeded,
      },
      gsiScore: gsi?.overall ?? null,
      pool: { start: poolAtStart, end: poolAtEnd },
      zombies: getZombieMetrics(),
      timedOut,
      abortReason: abortReason || null,
      errorCount: errors.length,
    };

    log.log(`[Sleep:summary] ${JSON.stringify(summaryObj)}`);
    log.log(`[Sleep] Sleep cycle complete in ${durationMs}ms${timedOut ? " (TIMED OUT)" : ""}`);
    logPoolHealth("cycle-end", `duration=${durationMs}ms`);

    const reportDate = new Date().toISOString().slice(0, 10);
    try {
      const reportLines = [
        `# Sleep Cycle Report — ${reportDate}`,
        `Duration: ${(durationMs / 1000).toFixed(1)}s`,
        timedOut ? `**TIMED OUT**: ${abortReason}` : "",
        "",
        "## vNext Claims",
        vnextLifecycle
          ? [
              `- Scanned: ${vnextLifecycle.scanned}`,
              `- Retired: ${vnextLifecycle.retired}${vnextLifecycle.retired > 0 ? ` (${Object.entries(vnextLifecycle.retiredByReason).map(([r, c]) => `${r}=${c}`).join(", ")})` : ""}`,
              `- Decayed: ${vnextLifecycle.decayed}`,
              `- Canonicalized: ${vnextLifecycle.canonicalized}`,
              `- Sourced: ${vnextLifecycle.sourced} / Linked: ${vnextLifecycle.linked}`,
              `- Bridges: ${vnextLifecycle.bridges.created} created, ${vnextLifecycle.bridges.finalEdges}/${vnextLifecycle.bridges.ceiling} edges`,
              vnextLifecycle.shadowPredictions
                ? `- Shadow predictions: ${vnextLifecycle.shadowPredictions.generated} generated, ${vnextLifecycle.shadowPredictions.resolved} resolved, ${vnextLifecycle.shadowPredictions.scored} scored, ${vnextLifecycle.shadowPredictions.abstained} abstained`
                : `- Shadow predictions: unavailable`,
              `- Errors: ${vnextLifecycle.errors}`,
            ].join("\n")
          : "- Skipped (phase did not run)",
        "",
        "## REM",
        `- Dream: ${rem.dreamTitle || "none"}`,
        `- Seeds: ${rem.seedCount} claims, ${rem.sessionCount} recent sessions`,
        `- Domains woven: ${rem.domainsWoven}`,
        rem.dreamInsight ? `- Insight: ${rem.dreamInsight}` : "",
        "",
        "## Phase Durations",
        ...Object.entries(phaseDurations).map(([phase, ms]) => `- ${phase}: ${(ms / 1000).toFixed(1)}s`),
      ].filter(Boolean);

      if (gsi) {
        reportLines.push(
          "",
          "## GSI (vNext graph)",
          `- Overall: ${(gsi.overall * 100).toFixed(1)}%`,
          `- Connectivity: ${(gsi.connectivity * 100).toFixed(1)}%`,
          `- Link Quality: ${(gsi.linkQuality * 100).toFixed(1)}%`,
          `- Orphan Rate: ${(gsi.orphanRate * 100).toFixed(1)}%`,
          `- Cluster Balance: ${(gsi.clusterBalance * 100).toFixed(1)}%`,
          `- Decay Health: ${(gsi.decayHealth * 100).toFixed(1)}%`,
        );
      }

      if (errors.length > 0) {
        reportLines.push("", "## Errors", ...errors.map((e) => `- ${e}`));
      }

      const reportContent = reportLines.join("\n");
      const { appendJournalEntry } = await import("./chat-journal");
      appendJournalEntry({
        ts: Date.now(),
        type: "done",
        sessionKey: `sleep-cycle:${reportDate}`,
        sessionId: `sleep-cycle:${reportDate}`,
        source: "system",
        content: reportContent,
      });
      log.debug(`[Sleep] Sleep report appended to journal`);
    } catch (reportErr: unknown) {
      log.error(`[Sleep] Failed to store sleep report: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`);
    }

    eventBus.publish({
      category: "system",
      event: "sleep:cycle_complete",
      payload: {
        durationMs,
        timedOut,
        vnextLifecycle: vnextLifecycle
          ? {
              scanned: vnextLifecycle.scanned,
              retired: vnextLifecycle.retired,
              decayed: vnextLifecycle.decayed,
              canonicalized: vnextLifecycle.canonicalized,
              errors: vnextLifecycle.errors,
            }
          : null,
        rem: { dreamTitle: rem.dreamTitle, seeds: rem.seedCount },
        gsiScore: gsi?.overall ?? null,
        errorCount: errors.length,
      },
    });

    return { vnextLifecycle, rem, gsi, durationMs, timedOut, abortReason, phaseDurations, errors };
  }, "sleep-cycle");
}
