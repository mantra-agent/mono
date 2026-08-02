import { createLogger } from "../log";
import { runWithPrincipal } from "../principal-context";
import type { RuntimeResourcePool } from "@shared/models/runtime";
import {
  appendRuntimeEvidence,
  claimNextRuntimeRun,
  heartbeatRuntimeAttempt,
  resolveRuntimeAttempt,
  startRuntimeAttempt,
} from "./runtime-storage";
import type { RuntimeAttemptDecision, RuntimeExecutionContext } from "./runtime-handler";

const log = createLogger("RuntimeWorker");
const CLAIM_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const CLAIM_BATCH_LIMIT = 4;
const NATIVE_POOLS: RuntimeResourcePool[] = ["background_agent", "short_worker"];
const workerId = `${process.env.RAILWAY_REPLICA_ID || "local"}:${process.pid}`;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
const activePools = new Set<RuntimeResourcePool>();
const activeExecutions = new Set<Promise<void>>();

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function executeClaimed(
  claimed: NonNullable<Awaited<ReturnType<typeof claimNextRuntimeRun>>>,
): Promise<void> {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let startedAttempt: Awaited<ReturnType<typeof startRuntimeAttempt>> | null = null;
  try {
    startedAttempt = await startRuntimeAttempt(claimed.fence, "in_process_trusted");
    heartbeat = setInterval(() => {
      void heartbeatRuntimeAttempt(claimed.fence).catch((error) => {
        log.error("runtime.worker.heartbeat_failed", {
          runId: claimed.run.id,
          attemptId: claimed.attempt.id,
          handler: `${claimed.run.handlerKey}@${claimed.run.handlerVersion}`,
          errorType: errorType(error),
        });
      });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    const context: RuntimeExecutionContext = {
      fence: claimed.fence,
      effectIdempotencyKey(effectName) {
        return `${claimed.run.accountId}/${claimed.run.id}/${effectName}`;
      },
      async heartbeat(usageDelta) {
        await heartbeatRuntimeAttempt(claimed.fence, usageDelta);
      },
      async appendEvidence(input) {
        await appendRuntimeEvidence(claimed.fence, input);
      },
    };

    const decision = await runWithPrincipal(startedAttempt.principal, () =>
      startedAttempt.handler.execute(context, startedAttempt.input),
    );
    await resolveRuntimeAttempt(startedAttempt.principal, claimed.fence, decision);
  } catch (error) {
    log.error("runtime.worker.execution_failed", {
      runId: claimed.run.id,
      attemptId: claimed.attempt.id,
      handler: `${claimed.run.handlerKey}@${claimed.run.handlerVersion}`,
      errorType: errorType(error),
    });
    try {
      if (!startedAttempt) return;
      const retryAt = new Date(Date.now() + 30_000);
      const canRetryMemory = claimed.run.handlerKey === "memory.source.process" && retryAt < claimed.run.deadlineAt;
      const decision: RuntimeAttemptDecision = canRetryMemory
        ? {
            kind: "retry",
            failureClass: "transient_database",
            reasonCode: "memory_source_attempt_failed",
            attribution: "handler",
            retryAt,
          }
        : claimed.run.handlerKey === "memory.source.process"
          ? {
              kind: "complete",
              outcome: "failed",
              reasonCode: "memory_source_deadline_exhausted",
              attribution: "handler",
              outputRefs: [],
              verificationLevel: "observed",
            }
          : {
            kind: "complete",
            outcome: "needs_review",
            reasonCode: "skill_side_effect_state_unknown",
            attribution: "unknown",
            outputRefs: [],
            verificationLevel: "observed",
          };
      await resolveRuntimeAttempt(startedAttempt.principal, claimed.fence, decision);
    } catch (settleError) {
      log.error("runtime.worker.settlement_failed", {
        runId: claimed.run.id,
        attemptId: claimed.attempt.id,
        handler: `${claimed.run.handlerKey}@${claimed.run.handlerVersion}`,
        errorType: errorType(settleError),
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

async function drainPool(pool: RuntimeResourcePool): Promise<void> {
  if (activePools.has(pool)) return;
  activePools.add(pool);
  try {
    for (let index = 0; index < CLAIM_BATCH_LIMIT; index++) {
      const claimed = await claimNextRuntimeRun(pool, workerId);
      if (!claimed) break;
      const execution = executeClaimed(claimed);
      activeExecutions.add(execution);
      void execution.finally(() => activeExecutions.delete(execution));
    }
  } finally {
    activePools.delete(pool);
  }
}

function tick(): void {
  for (const pool of NATIVE_POOLS) {
    void drainPool(pool).catch((error) => {
      log.error("runtime.worker.claim_failed", { resourcePool: pool, errorType: errorType(error) });
    });
  }
}

export function startRuntimeWorker(): void {
  if (started) return;
  started = true;
  tick();
  timer = setInterval(tick, CLAIM_INTERVAL_MS);
  timer.unref();
  log.info("runtime.worker.started", { workerId, pools: NATIVE_POOLS });
}

export async function stopRuntimeWorker(): Promise<void> {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
  if (activeExecutions.size > 0) {
    await Promise.race([
      Promise.allSettled([...activeExecutions]).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  log.info("runtime.worker.stopped", { workerId, activeExecutions: activeExecutions.size });
}
