import type { RuntimeResourcePool } from "@shared/models/runtime";
import { BOOT_ID } from "../db";
import { createLogger } from "../log";
import { AccountLifecycleError } from "../principal";
import { runWithPrincipal } from "../principal-context";
import type { RuntimeAttemptDecision, RuntimeExecutionContext } from "./runtime-handler";
import {
  appendRuntimeEvidence,
  claimNextRuntimeRun,
  heartbeatRuntimeAttempt,
  resolveRuntimeAttempt,
  startRuntimeAttempt,
} from "./runtime-storage";

const log = createLogger("RuntimeDispatcher");
const DISPATCH_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STOP_DRAIN_MS = 7_000;
const NATIVE_POOLS: RuntimeResourcePool[] = ["background_agent", "short_worker"];

/**
 * startRuntimeAttempt already terminalizes authority failures as blocked, then
 * rethrows so execute() stops. That is expected control flow — not a dispatcher
 * contract failure — so it must not project into application_error_aggregates.
 */
function isExpectedAuthorityTerminal(error: unknown): boolean {
  if (error instanceof AccountLifecycleError) return true;
  if (!error || typeof error !== "object") return false;
  const code =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code: string }).code)
      : "";
  if (
    code === "authority_subject_missing" ||
    code === "account_suspended" ||
    code === "account_archived" ||
    code.startsWith("authority_") ||
    code.endsWith("_authority_revoked")
  ) {
    return true;
  }
  return "status" in error && (error as { status?: unknown }).status === 403;
}

class RuntimeDispatcher {
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private readonly claiming = new Set<RuntimeResourcePool>();
  private readonly active = new Set<Promise<void>>();

  start(): void {
    if (this.interval) return;
    this.stopping = false;
    this.interval = setInterval(() => void this.tick(), DISPATCH_INTERVAL_MS);
    this.interval.unref?.();
    void this.tick();
    log.info("runtime.dispatcher.started", { workerId: BOOT_ID, pools: NATIVE_POOLS });
  }

  beginShutdown(): void {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    this.interval = null;
    if (this.active.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.active]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_DRAIN_MS);
          timer.unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    log.info("runtime.dispatcher.stopped", { workerId: BOOT_ID, active: this.active.size });
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    await Promise.all(NATIVE_POOLS.map((pool) => this.claim(pool)));
  }

  private async claim(resourcePool: RuntimeResourcePool): Promise<void> {
    if (this.stopping || this.claiming.has(resourcePool)) return;
    this.claiming.add(resourcePool);
    try {
      const claimed = await claimNextRuntimeRun(resourcePool, `${BOOT_ID}:${resourcePool}`);
      if (!claimed || this.stopping) return;
      const execution = this.execute(claimed.fence).catch((error) => {
        const details = {
          runId: claimed.run.id,
          attemptId: claimed.attempt.id,
          accountId: claimed.run.accountId,
          handler: `${claimed.run.handlerKey}@${claimed.run.handlerVersion}`,
          resourcePool,
          errorType: error instanceof Error ? error.name : typeof error,
          reasonCode:
            error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
              ? String((error as { code: string }).code)
              : null,
        };
        // Authority already terminalized the run as blocked; warn only so
        // AccountLifecycleError thrash cannot flood ERRORS (see Self Heal
        // RUNTIME_DISPATCH_EXECUTION_FAILED).
        if (isExpectedAuthorityTerminal(error)) {
          log.warn("runtime.dispatch.execution_blocked", details);
          return;
        }
        log.error("runtime.dispatch.execution_failed", details);
      });
      this.active.add(execution);
      void execution.finally(() => this.active.delete(execution));
    } catch (error) {
      log.error("runtime.dispatch.claim_failed", {
        resourcePool,
        workerId: BOOT_ID,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      this.claiming.delete(resourcePool);
    }
  }

  private async execute(fence: Parameters<typeof startRuntimeAttempt>[0]): Promise<void> {
    const started = await startRuntimeAttempt(fence, "in_process_trusted");
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatFailure: unknown = null;
    const abortController = new AbortController();
    let heartbeatQueue = Promise.resolve();
    const heartbeat = (usageDelta: Record<string, number> = {}): Promise<void> => {
      const operation = heartbeatQueue.then(async () => {
        try {
          const state = await heartbeatRuntimeAttempt(fence, usageDelta);
          if (state.cancellationRequested && !abortController.signal.aborted) {
            abortController.abort("cancelled");
          }
        } catch (error) {
          heartbeatFailure = error;
          throw error;
        }
      });
      heartbeatQueue = operation.catch(() => undefined);
      return operation;
    };
    const context: RuntimeExecutionContext = {
      fence,
      signal: abortController.signal,
      effectIdempotencyKey: (effectName) => `${started.run.accountId}/${started.run.id}/${effectName}`,
      heartbeat,
      appendEvidence: (input) => appendRuntimeEvidence(fence, input).then(() => undefined),
    };

    try {
      heartbeatTimer = setInterval(() => {
        void heartbeat().catch((error) => {
          const expectedLeaseLoss = error && typeof error === "object" && "code" in error && error.code === "stale_fence";
          const details = {
            runId: started.run.id,
            attemptId: started.attempt.id,
            accountId: started.run.accountId,
            resourcePool: started.run.resourcePool,
            errorType: error instanceof Error ? error.name : typeof error,
          };
          if (expectedLeaseLoss) {
            log.debug("runtime.dispatch.heartbeat_lease_lost", details);
          } else {
            log.error("runtime.dispatch.heartbeat_failed", details);
          }
        });
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();

      let decision: RuntimeAttemptDecision;
      try {
        decision = await runWithPrincipal(started.principal, () => started.handler.execute(context, started.input));
      } catch (error) {
        if (heartbeatFailure || (error && typeof error === "object" && "code" in error && error.code === "stale_fence")) {
          throw error;
        }
        const retryAt = new Date(Date.now() + Math.min(5 * 60_000, 30_000 * 2 ** Math.max(0, started.attempt.attemptNumber - 1)));
        const sourceCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 120)
          : "";
        const reasonCode = sourceCode || "handler_exception";
        decision = {
          kind: "retry",
          failureClass: "handler_transient",
          reasonCode,
          attribution: "handler",
          retryAt,
        };
        await appendRuntimeEvidence(fence, {
          eventType: "failure",
          reasonCode,
          payload: { errorType: error instanceof Error ? error.name : typeof error, sourceCode: sourceCode || null },
        }).catch(() => undefined);
      }
      await heartbeatQueue;
      if (heartbeatFailure && decision.kind === "complete") {
        decision = {
          kind: "retry",
          failureClass: "lease_lost",
          reasonCode: "heartbeat_failed",
          attribution: "runtime",
          retryAt: new Date(Date.now() + 30_000),
        };
      }
      await resolveRuntimeAttempt(started.principal, fence, decision);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
  }
}

export const runtimeDispatcher = new RuntimeDispatcher();
