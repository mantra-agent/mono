// Use createLogger for logging ONLY
import { timerStorage } from "./file-storage";
import { eventBus } from "./event-bus";
import type { Timer, Schedule, TimerRun } from "@shared/models/timers";
import { createLogger } from "./log";
import { BOOT_ID, fnv1a32, withQueryAttributionAsync } from "./db";
import { systemTimerRegistry } from "./system-timer-registry";
import { timerHandlerRouter } from "./timer-handler-router";
import type { TimerHandlerResult } from "./timer-handlers";
import { Cron } from "croner";
import { runWithPrincipal, getCurrentPrincipal } from "./principal-context";
import { createNamedSystemPrincipal, createUserPrincipalFromUser, type Principal } from "./principal";
import { getUserEffectivePermissions } from "./permissions";
import { storage } from "./storage";
import { assertSpendAllowed, isSpendAuthorityError } from "./spend-authority";

const log = createLogger("TimerScheduler");

type TimerSchedulerOperation =
  | "safe_set_long_timeout"
  | "ephemeral_cleanup"
  | "scheduler_maintenance"
  | "deferred_retry"
  | "queued_execution"
  | "boot_reminder"
  | "timer_lookup"
  | "ephemeral_delete"
  | "handler_failed"
  | "compute_next_run"
  | "compute_previous_run"
  | "reschedule_all";

type TimerSchedulerOperationError = Error & {
  code?: string;
  operation?: TimerSchedulerOperation;
  timerId?: string;
  runId?: string;
  scheduleId?: string;
  timerName?: string;
  trigger?: string;
};

function normalizeTimerSchedulerError(
  value: unknown,
  operation: TimerSchedulerOperation,
  fallbackCode: string,
  message?: string,
): TimerSchedulerOperationError {
  let error: TimerSchedulerOperationError;
  if (value instanceof Error) {
    error = value as TimerSchedulerOperationError;
  } else if (typeof value === "string" && value.trim()) {
    error = new Error(message || value) as TimerSchedulerOperationError;
  } else {
    error = new Error(message || "TimerScheduler operation failed", {
      cause: value,
    }) as TimerSchedulerOperationError;
  }
  if (!error.code || !/^[A-Z][A-Z0-9_]{1,47}$/.test(String(error.code))) {
    error.code = fallbackCode;
  }
  error.operation = operation;
  return error;
}

function timerSchedulerLogContext(options: {
  operation: TimerSchedulerOperation;
  timerId?: string;
  runId?: string;
  scheduleId?: string;
  timerName?: string;
  trigger?: string;
}) {
  return {
    operation: options.operation,
    timerId: options.timerId,
    runId: options.runId,
    scheduleId: options.scheduleId,
    timerName: options.timerName,
    trigger: options.trigger,
  };
}

/**
 * Build/deploy identity for fireOnNextBuild exactly-once claims.
 * Prefer Railway deployment id (one claim per deploy) and fall back to git
 * SHA when deployment id is unset. The run row is the claim — there is no
 * separate settings marker.
 */
function getCurrentBuildId(): string | null {
  return (
    process.env.RAILWAY_DEPLOYMENT_ID?.trim() ||
    process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    null
  );
}

interface ScheduledTimer {
  timerId: string;
  scheduleId: string;
  cancel: () => void;
  // The wall-clock fire time we computed when we armed setTimeout. Stored so
  // the slot guard in executeTimer can compare *actual* fire time to *intended*
  // fire time (which we cannot recover from computeNextRun after the fact —
  // computeNextRun(now) returns the *next* slot, not the slot we were aiming
  // at when we armed). A drift of more than EARLY_FIRE_TOLERANCE_MS in either
  // direction means the OS fired the callback at the wrong time (overflow,
  // clock jump, manual replay).
  nextRunAt: number;
}

// Node clamps any setTimeout delay > 2^31 - 1 (~24.8 days) to 1ms and emits
// TimeoutOverflowWarning. Long-horizon timers (annual/quarterly/monthly) thus
// fired immediately at boot, producing the post-`boot_complete` stampede in
// production incident `mooppudm-l8pk`. This helper trampolines on a 24h slice
// (well under the 32-bit ceiling) until the real fire time arrives. One
// helper, one trampoline chain, one opaque cancel handle (DRY).
const NODE_MAX_TIMEOUT_MS = 2_147_483_647; // 2^31 - 1
const TRAMPOLINE_SLICE_MS = 24 * 60 * 60 * 1000; // 24h

export interface CancelHandle {
  cancel: () => void;
}

export function safeSetLongTimeout(
  callback: () => void,
  delayMs: number,
): CancelHandle {
  let active = true;
  let current: ReturnType<typeof setTimeout> | null = null;
  let remaining = Math.max(0, delayMs);

  const armNextSlice = (): void => {
    if (!active) return;
    const slice =
      remaining > NODE_MAX_TIMEOUT_MS ? TRAMPOLINE_SLICE_MS : remaining;
    remaining -= slice;
    current = setTimeout(() => {
      if (!active) return;
      if (remaining > 0) {
        armNextSlice();
      } else {
        try {
          callback();
        } catch (err: unknown) {
          const error = normalizeTimerSchedulerError(
            err,
            "safe_set_long_timeout",
            "TIMER_SAFE_TIMEOUT_CALLBACK_FAILED",
            "safeSetLongTimeout callback threw",
          );
          log.error(error, timerSchedulerLogContext({ operation: error.operation! }));
        }
      }
    }, slice);
  };

  armNextSlice();

  return {
    cancel: () => {
      active = false;
      if (current !== null) {
        clearTimeout(current);
        current = null;
      }
    },
  };
}

// Between-runs cooldown (NOT a mid-callback stagger). The serial wait queue
// in enqueueTimerExecution applies this gap *between* timers so a herd of
// timers that all fire at the same slot (e.g. boot) cannot pile up
// concurrent ContextBuilder fan-outs against the pg pool.
const STAGGER_DELAY_MS = 12_000;
// Random jitter added per-timer so timers whose real next-fire times genuinely
// collide (e.g. midnight) don't all start at the exact same millisecond.
const TIMER_JITTER_MAX_MS = 2_000;
// Tolerance for the `executeTimer` slot guard: a scheduled fire is allowed
// to lead/lag the intended fire time by up to this much (clock skew, scheduler
// queue wait). Anything further is treated as an early/late fire (bug, clock
// jump, manual replay).
const EARLY_FIRE_TOLERANCE_MS = 60_000;
// Admission deferrals are transient, durable scheduled-slot state. Retry the
// same run row every five minutes for up to 24 hours; the storage claim is
// atomic across replicas and the skill runner's single-flight guard prevents
// overlap with a concurrent manual or scheduled launch of the same skill.
const DEFERRED_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFERRED_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_DEFERRED_RETRY_COUNT = Math.ceil(
  DEFERRED_RETRY_WINDOW_MS / DEFERRED_RETRY_DELAY_MS,
);
const MANAGED_EVENT_CLAIM_STALE_MS = 35 * 60 * 1000;

const DEFERRED_RETRY_REASONS = [
  "admission_deferred_or_already_running",
  "admission_timeout",
];

// Pure function so we can unit-test the slot guard's decision without standing
// up the full scheduler + storage. Exported for tests; do not use elsewhere
// (the inline call in executeTimer is the production path).
//
// Asymmetric on purpose: only *early* fires are skipped (the 32-bit overflow
// signature, plus clock jumps and accidental replays). *Late* fires are always
// ok — the executor uses an N-second between-runs cooldown plus jitter and
// serializes execution, so legitimate fires routinely arrive minutes after
// their intended time when many timers collide on the same slot. Skipping
// those would defeat serialization and silently drop valid work.
export type SlotGuardVerdict =
  { kind: "ok" } | { kind: "early-fire"; driftMs: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEphemeralOneTimeTimer(timer: Timer): boolean {
  return timer.scope === "user" &&
    !timer.systemKey &&
    timer.schedules.length > 0 &&
    timer.schedules.every((schedule) => schedule.frequency === "once");
}

function evaluateSlotGuard(
  intendedFireAt: number,
  now: number,
  toleranceMs: number = EARLY_FIRE_TOLERANCE_MS,
): SlotGuardVerdict {
  const driftMs = now - intendedFireAt;
  if (driftMs < -toleranceMs) return { kind: "early-fire", driftMs };
  return { kind: "ok" };
}

type ScheduledRunSlot = {
  intendedFireAt: string;
  slotStart: string;
  slotEnd: string;
  /** Present for fireOnNextBuild / fireOnNextBoot slots — the deploy/build identity. */
  buildId?: string;
};

class TimerScheduler {
  private timers = new Map<string, ScheduledTimer>();
  private globalPaused = false;
  private started = false;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private executionQueue: Promise<void> = Promise.resolve();
  private inFlightCount = 0;
  private lastExecutionEndedAt = 0;

  getInFlightCount(): number {
    return this.inFlightCount;
  }

  isRunning(): boolean {
    return this.started;
  }

  isPaused(): boolean {
    return this.globalPaused;
  }
  private getScheduleIntervalMs(schedule: {
    frequency: string;
    interval?: number;
  }): number {
    switch (schedule.frequency) {
      case "every_x_minutes":
        return (schedule.interval || 30) * 60 * 1000;
      case "every_x_hours":
        return (schedule.interval || 1) * 60 * 60 * 1000;
      case "every_x_weeks":
        return (schedule.interval || 1) * 7 * 24 * 60 * 60 * 1000;
      case "daily":
        return 24 * 60 * 60 * 1000;
      case "weekly":
        return 7 * 24 * 60 * 60 * 1000;
      case "monthly":
        return 30 * 24 * 60 * 60 * 1000;
      case "quarterly":
        return 90 * 24 * 60 * 60 * 1000;
      case "annually":
        return 365 * 24 * 60 * 60 * 1000;
      default:
        return 0;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const state = await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.getSchedulerState(),
    );
    this.globalPaused = state.globalPaused;

    const reconcileResult = await systemTimerRegistry.reconcile();
    if (!reconcileResult.ok) {
      const message = `system timer registry reconcile failed: ${reconcileResult.error}`;
      eventBus.publish({
        category: "timer",
        event: "system_timer_registry.reconcile.failed",
        payload: { error: reconcileResult.error, critical: true },
      });
      this.started = false;
      throw new Error(message);
    }

    log.log(`Starting scheduler, globalPaused=${this.globalPaused}`);
    try {
      const deletedCount = await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.deleteCompletedEphemeralOneTimeTimersForScheduler(),
      );
      if (deletedCount > 0) {
        log.log(`deleted ${deletedCount} completed ephemeral one-time timer(s)`);
      }
    } catch (error: unknown) {
      const normalized = normalizeTimerSchedulerError(
        error,
        "ephemeral_cleanup",
        "TIMER_EPHEMERAL_CLEANUP_FAILED",
        "completed ephemeral one-time timer cleanup failed; scheduler will continue",
      );
      log.warn(normalized, timerSchedulerLogContext({ operation: normalized.operation! }));
    }
    await this.fireBootReminders();
    await this.rescheduleAll();
    await this.dispatchManagedEventRuns();
    await this.retryDeferredRuns();

    this.checkInterval = setInterval(() => {
      this.maintainSchedules().catch((err: unknown) => {
        const error = normalizeTimerSchedulerError(
          err,
          "scheduler_maintenance",
          "TIMER_SCHEDULER_MAINTENANCE_FAILED",
          "scheduler maintenance error",
        );
        log.error(error, timerSchedulerLogContext({ operation: error.operation! }));
      });
    }, 60_000);
  }

  stop(): void {
    this.started = false;
    Array.from(this.timers.values()).forEach((entry) => entry.cancel());
    this.timers.clear();
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    log.log(`Stopped`);
  }

  private async maintainSchedules(): Promise<void> {
    await this.rescheduleAll();
    await this.dispatchManagedEventRuns();
    await this.retryDeferredRuns();
  }

  async rescheduleAll(): Promise<void> {
    const allTimers = await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.getAllForScheduler(),
    );
    const activeKeys = new Set<string>();

    for (const timer of allTimers) {
      if (!timer.enabled || this.globalPaused) continue;

      for (const schedule of timer.schedules) {
        const key = `${timer.id}:${schedule.id}`;
        activeKeys.add(key);

        const nextRun = computeNextRun(schedule, timer.timezone);
        if (!nextRun) continue;

        const existing = this.timers.get(key);
        if (existing && Math.abs(existing.nextRunAt - nextRun) < 1000) {
          continue;
        }

        if (existing) {
          existing.cancel();
        }

        const delay = Math.max(0, nextRun - Date.now());
        // safeSetLongTimeout: trampolines on a 24h slice when delay exceeds
        // Node's 32-bit setTimeout ceiling (~24.8 days), so monthly/quarterly/
        // annual timers no longer fire immediately at boot.
        const intendedFireAt = nextRun;
        const handle = safeSetLongTimeout(() => {
          this.enqueueTimerExecution(
            timer.id,
            timer.name,
            schedule.id,
            intendedFireAt,
          );
        }, delay);

        this.timers.set(key, {
          timerId: timer.id,
          scheduleId: schedule.id,
          cancel: handle.cancel,
          nextRunAt: nextRun,
        });
      }
    }

    Array.from(this.timers.keys()).forEach((key) => {
      if (!activeKeys.has(key)) {
        const entry = this.timers.get(key);
        if (entry) entry.cancel();
        this.timers.delete(key);
      }
    });
  }

  private async dispatchManagedEventRuns(): Promise<void> {
    if (!this.started || this.globalPaused) return;
    const now = Date.now();
    const staleBefore = new Date(now - MANAGED_EVENT_CLAIM_STALE_MS);
    const runs = await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.getPendingManagedEventRunsForScheduler(
        new Date(now - DEFERRED_RETRY_WINDOW_MS),
        new Date(now - DEFERRED_RETRY_DELAY_MS),
        staleBefore,
        20,
      ),
    );
    for (const run of runs) {
      const timer = await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.getForScheduler(run.timerId),
      );
      if (!timer?.enabled) continue;
      const attemptCount = typeof run.metadata?.dispatchAttempt === "number" && Number.isFinite(run.metadata.dispatchAttempt)
        ? run.metadata.dispatchAttempt
        : 0;
      const metadata: TimerRun["metadata"] = {
        ...(run.metadata ?? {}),
        dispatchAttempt: attemptCount + 1,
        claimedAt: new Date(now).toISOString(),
        retryCount: typeof run.metadata?.retryCount === "number" ? run.metadata.retryCount : 0,
      };
      const claimed = await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.claimManagedEventRunForScheduler(timer, run.id, metadata, staleBefore),
      );
      if (!claimed) continue;
      log.log(`dispatching managed Build event timer="${timer.name}" runId=${run.id} attempt=${attemptCount + 1}`);
      this.enqueueDeferredTimerExecution(timer, { ...run, status: "running" }, metadata);
    }
  }

  private async retryDeferredRuns(): Promise<void> {
    if (!this.started || this.globalPaused) return;
    const now = Date.now();
    const deferredRuns = await withQueryAttributionAsync(
      "timer-scheduler",
      () => timerStorage.getDeferredRunsForScheduler(
        DEFERRED_RETRY_REASONS,
        new Date(now - DEFERRED_RETRY_WINDOW_MS),
        new Date(now - DEFERRED_RETRY_DELAY_MS),
        MAX_DEFERRED_RETRY_COUNT,
        100,
      ),
    );

    for (const run of deferredRuns) {
      const timer = await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.getForScheduler(run.timerId),
      );
      if (!timer?.enabled) continue;
      if (!timer.schedules.some((candidate) => candidate.id === run.scheduleId)) {
        continue;
      }
      const recentRuns = await withQueryAttributionAsync(
        "timer-scheduler",
        () => timerStorage.getRunsForScheduler(timer, 100),
      );
      const deferredSlotEnd =
        run.scheduledSlotEnd ?? run.intendedFireAt ?? run.startedAt;
      if (
        recentRuns.some(
          (candidate) =>
            candidate.trigger === "scheduled" &&
            candidate.scheduleId === run.scheduleId &&
            candidate.status === "success" &&
            (candidate.scheduledSlotEnd ?? candidate.intendedFireAt ?? candidate.startedAt) >=
              deferredSlotEnd,
        )
      ) {
        continue;
      }

      const retryCount =
        typeof run.metadata?.retryCount === "number" &&
        Number.isFinite(run.metadata.retryCount)
          ? run.metadata.retryCount
          : 0;
      const metadata: TimerRun["metadata"] = {
        ...(run.metadata ?? {}),
        retryCount: retryCount + 1,
        lastRetryAt: new Date(now).toISOString(),
      };
      const claimed = await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.claimDeferredRunForRetry(timer, run.id, metadata),
      );
      if (!claimed) continue;

      eventBus.publish({
        category: "timer",
        event: "timer.run.retry",
        payload: {
          runId: run.id,
          timerId: run.timerId,
          name: timer.name,
          retryCount: retryCount + 1,
          reason: run.error,
        },
      });
      log.log(
        `retrying deferred "${timer.name}" runId=${run.id} retryCount=${retryCount + 1} reason=${run.error}`,
      );
      this.enqueueDeferredTimerExecution(timer, run, metadata);
    }
  }

  private enqueueDeferredTimerExecution(
    timer: Timer,
    run: TimerRun,
    metadata: TimerRun["metadata"],
  ): void {
    const queuedAt = Date.now();
    this.executionQueue = this.executionQueue.then(async () => {
      if (this.lastExecutionEndedAt > 0) {
        const cooldown = STAGGER_DELAY_MS - (Date.now() - this.lastExecutionEndedAt);
        if (cooldown > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, cooldown));
        }
      }
      this.inFlightCount++;
      try {
        await this.executeExistingTimerRun(timer, run, metadata);
      } catch (err: unknown) {
        const error = normalizeTimerSchedulerError(
          err,
          "deferred_retry",
          "TIMER_DEFERRED_RETRY_FAILED",
          `deferred retry error timer=${timer.id} runId=${run.id}`,
        );
        error.timerId = timer.id;
        error.runId = run.id;
        error.timerName = timer.name;
        log.error(
          error,
          timerSchedulerLogContext({
            operation: error.operation!,
            timerId: timer.id,
            runId: run.id,
            timerName: timer.name,
          }),
        );
      } finally {
        this.inFlightCount--;
        this.lastExecutionEndedAt = Date.now();
        const waitMs = Date.now() - queuedAt;
        if (waitMs > 100) {
          log.debug(
            `[TimerScheduler] deferred retry "${timer.name}" settled after ${waitMs}ms queue+execution`,
          );
        }
      }
    });
  }

  private async executeExistingTimerRun(
    timer: Timer,
    run: TimerRun,
    metadata: TimerRun["metadata"],
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const retryRun: TimerRun = {
      ...run,
      status: "running",
      startedAt,
      completedAt: undefined,
      durationMs: undefined,
      error: undefined,
      metadata,
    };
    const executionPrincipal = await this.resolveExecutionPrincipal(timer);
    await runWithPrincipal(executionPrincipal, async () => {
      eventBus.publish({
        category: "timer",
        event: "timer.run.start",
        payload: {
          runId: retryRun.id,
          timerId: timer.id,
          name: timer.name,
          type: timer.type,
          trigger: retryRun.trigger,
          metadata,
          retry: true,
        },
      });
      try {
        const result = await this.executeTimerHandler(timer, retryRun);
        await this.finalizeTimerRun(timer, retryRun, startedAt, result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        const handlerResult: TimerHandlerResult =
          errorMessage === "admission_timeout"
            ? {
                outcome: "deferred",
                reason: "admission_timeout",
                output: { error: "admission_timeout: another autonomous run is active" },
              }
            : { outcome: "failed", error: errorStack || errorMessage };
        await this.finalizeTimerRun(timer, retryRun, startedAt, handlerResult);
      }
    });
  }

  private enqueueTimerExecution(
    timerId: string,
    timerName: string,
    scheduleId: string,
    intendedFireAt?: number,
  ): void {
    // Front-load the gate: hold every timer in a real serial wait queue rather
    // than firing-then-stalling-mid-callback. The 12s STAGGER_DELAY_MS now acts
    // as a between-runs *cooldown* (applied only once a previous run has
    // finished), and per-timer jitter (0..TIMER_JITTER_MAX_MS) prevents
    // simultaneous fires from landing on the same millisecond.
    const queuedAt = Date.now();
    const jitterMs = Math.floor(Math.random() * TIMER_JITTER_MAX_MS);

    this.executionQueue = this.executionQueue.then(async () => {
      // Cooldown vs. *previous* execution end (not vs. concurrent in-flight,
      // because the serial queue guarantees one-at-a-time).
      if (this.lastExecutionEndedAt > 0) {
        const elapsed = Date.now() - this.lastExecutionEndedAt;
        const cooldown = STAGGER_DELAY_MS - elapsed;
        if (cooldown > 0) {
          log.debug(
            `[TimerScheduler] cooldown ${Math.round(cooldown / 1000)}s before "${timerName}" (last finished ${Math.round(elapsed / 1000)}s ago)`,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, cooldown));
        }
      }
      if (jitterMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, jitterMs));
      }
      this.inFlightCount++;
      const waitMs = Date.now() - queuedAt;
      if (waitMs > 100) {
        log.debug(
          `[TimerScheduler] starting "${timerName}" after ${waitMs}ms wait (jitter=${jitterMs}ms)`,
        );
      }
      try {
        await this.executeTimer(
          timerId,
          scheduleId,
          "scheduled",
          intendedFireAt,
        );
      } catch (err: unknown) {
        const error = normalizeTimerSchedulerError(
          err,
          "queued_execution",
          "TIMER_QUEUED_EXECUTION_FAILED",
          `execution error timer=${timerId}`,
        );
        error.timerId = timerId;
        error.scheduleId = scheduleId;
        error.timerName = timerName;
        error.trigger = "scheduled";
        log.error(
          error,
          timerSchedulerLogContext({
            operation: error.operation!,
            timerId,
            scheduleId,
            timerName,
            trigger: "scheduled",
          }),
        );
      } finally {
        this.inFlightCount--;
        this.lastExecutionEndedAt = Date.now();
      }
    });
  }

  private async fireBootReminders(): Promise<void> {
    if (this.globalPaused) return;
    try {
      const allTimers = await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.getAllForScheduler(),
      );
      const bootTimers = allTimers.filter(
        (timer) =>
          timer.enabled &&
          timer.schedules?.some((schedule) => schedule.fireOnNextBoot || schedule.fireOnNextBuild),
      );
      if (bootTimers.length === 0) return;

      // Exactly-once is encoded in the run row (deterministic build-scoped
      // slot + unique index + claim-via-insert). No process-local or settings
      // marker participates — concurrent boots and same-build restarts all
      // race the same insert and only the winner executes.
      const currentBuildId = getCurrentBuildId();
      if (!currentBuildId) {
        log.warn(
          "build identity unavailable (RAILWAY_DEPLOYMENT_ID / RAILWAY_GIT_COMMIT_SHA unset); " +
            "next-build timers still fire, but slot identity falls back to process boot time",
        );
      }

      log.debug(
        `Evaluating ${bootTimers.length} boot/build timer(s) build=${currentBuildId?.slice(0, 12) ?? "unknown"}`,
      );
      for (const timer of bootTimers) {
        const schedules = Array.from(
          new Map(
            timer.schedules
              .filter((schedule) => schedule.fireOnNextBoot || schedule.fireOnNextBuild)
              .map((schedule) => [schedule.id, schedule]),
          ).values(),
        );
        for (const schedule of schedules) {
          try {
            // Pass buildId so computeScheduledRunSlot produces a stable slot
            // for fireOnNextBuild (and fireOnNextBoot when build id is known).
            await this.executeTimer(
              timer.id,
              schedule.id,
              "scheduled",
              undefined,
              currentBuildId ?? undefined,
            );
          } catch (err: unknown) {
            const error = normalizeTimerSchedulerError(
              err,
              "boot_reminder",
              "TIMER_BOOT_REMINDER_FAILED",
              `fireBootReminders error for "${timer.name}"`,
            );
            error.timerId = timer.id;
            error.scheduleId = schedule.id;
            error.timerName = timer.name;
            error.trigger = "scheduled";
            log.error(
              error,
              timerSchedulerLogContext({
                operation: error.operation!,
                timerId: timer.id,
                scheduleId: schedule.id,
                timerName: timer.name,
                trigger: "scheduled",
              }),
            );
          }
        }
      }
    } catch (err: unknown) {
      const error = normalizeTimerSchedulerError(
        err,
        "boot_reminder",
        "TIMER_BOOT_REMINDER_ENUMERATION_FAILED",
        "fireBootReminders error",
      );
      log.error(error, timerSchedulerLogContext({ operation: error.operation! }));
    }
  }

  /**
   * Compute the exclusive scheduled slot for a fire.
   *
   * Cron/interval schedules use the ordinary previous-run → intended-fire
   * half-open window.
   *
   * fireOnNextBuild uses a *build-scoped* slot: both endpoints are derived
   * from a stable hash of deploy/build identity so concurrent replicas and
   * same-build restarts all compute the identical key. Wall-clock Date.now()
   * must never participate in that key — otherwise every boot gets a unique
   * slot and triple-fires.
   *
   * fireOnNextBoot (without fireOnNextBuild) uses the process BOOT_ID so a
   * single process start claims once; a true process restart gets a new id.
   * Multi-replica boots remain independent (one fire per replica process).
   *
   * The non-deferred unique index on (timer, schedule, slot) makes the
   * insert the exclusive claim in all cases.
   */
  private computeScheduledRunSlot(
    timer: Timer,
    schedule: Timer["schedules"][number],
    intendedFireAt?: number,
    buildId?: string,
  ): ScheduledRunSlot {
    if (schedule.fireOnNextBuild) {
      const identity = (buildId ?? getCurrentBuildId() ?? `boot-${BOOT_ID}`).trim();
      return this.stableIdentitySlot(`build:${identity}`, identity);
    }

    if (schedule.fireOnNextBoot) {
      const identity = `boot:${BOOT_ID}`;
      return this.stableIdentitySlot(identity, identity);
    }

    const slotEndMs = intendedFireAt ?? Date.now();
    const previousSlotMs = computePreviousRun(
      schedule,
      timer.timezone,
      slotEndMs,
    );
    const slotStartMs =
      previousSlotMs ?? slotEndMs - this.getScheduleIntervalMs(schedule);

    return {
      intendedFireAt: new Date(slotEndMs).toISOString(),
      slotStart: new Date(slotStartMs).toISOString(),
      slotEnd: new Date(slotEndMs).toISOString(),
    };
  }

  /** Deterministic slot pair from a stable identity string (not wall-clock). */
  private stableIdentitySlot(identityKey: string, buildId: string): ScheduledRunSlot {
    const epochMs = 1_000_000_000_000; // 2001-09-09 — stable, far from 0
    const spanMs = 1_000; // only the pair identity matters
    const slotStartMs = epochMs + (fnv1a32(`timer-slot:${identityKey}`) % 1_000_000_000);
    const slotEndMs = slotStartMs + spanMs;
    const intended = new Date(slotEndMs).toISOString();
    return {
      intendedFireAt: intended,
      slotStart: new Date(slotStartMs).toISOString(),
      slotEnd: new Date(slotEndMs).toISOString(),
      buildId,
    };
  }

  private hasClaimedScheduledRunForSlot(
    runs: TimerRun[],
    scheduleId: string,
    slot: ScheduledRunSlot,
  ): boolean {
    return runs.some(
      (run) =>
        run.trigger === "scheduled" &&
        run.scheduleId === scheduleId &&
        run.status !== "deferred" &&
        run.scheduledSlotStart === slot.slotStart &&
        run.scheduledSlotEnd === slot.slotEnd,
    );
  }

  async executeTimer(
    timerId: string,
    scheduleId: string,
    trigger: "scheduled" | "manual" = "scheduled",
    intendedFireAt?: number,
    buildId?: string,
  ): Promise<TimerRun | null> {
    const timer = await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.getForScheduler(timerId),
    );
    if (!timer) {
      const error = normalizeTimerSchedulerError(
        new Error(`timer not found: ${timerId}`),
        "timer_lookup",
        "TIMER_NOT_FOUND",
        `timer not found: ${timerId}`,
      );
      error.timerId = timerId;
      error.scheduleId = scheduleId;
      error.trigger = trigger;
      log.error(
        error,
        timerSchedulerLogContext({
          operation: error.operation!,
          timerId,
          scheduleId,
          trigger,
        }),
      );
      return null;
    }

    if (trigger === "manual") {
      const requester = getCurrentPrincipal();
      if (
        requester?.actorType !== "user" ||
        !requester.userId ||
        !requester.accountId ||
        timer.scope !== "user" ||
        timer.ownerUserId !== requester.userId ||
        timer.accountId !== requester.accountId
      ) {
        throw Object.assign(new Error("Timer not found or not visible"), { status: 404 });
      }
    }

    if (!timer.enabled && trigger === "scheduled") {
      log.debug(`skipping disabled timer: ${timer.name}`);
      return null;
    }

    if (this.globalPaused && trigger === "scheduled") {
      log.debug(`skipping (global pause): ${timer.name}`);
      return null;
    }

    // Defensive slot guard: compare the *actual* fire time to the wall-clock
    // fire time we computed when we armed setTimeout. The OS should fire the
    // callback within tens of milliseconds of `intendedFireAt`. A drift of
    // more than EARLY_FIRE_TOLERANCE_MS in either direction means something
    // went wrong (32-bit overflow, clock jump, accidental replay) — skip the
    // run and let the next reschedule pass put us back on the right slot.
    // Fail loudly with structured fields so a future incident has a single
    // greppable line. (Manual triggers bypass this; explicit "Run Now" is
    // intentional. fireBootReminders also bypasses by not passing
    // intendedFireAt — those are intentional out-of-slot fires.)
    if (trigger === "scheduled" && intendedFireAt !== undefined) {
      const now = Date.now();
      const verdict = evaluateSlotGuard(intendedFireAt, now);
      if (verdict.kind === "early-fire") {
        // Slot window: the legitimate fire belongs in the [previous, intended]
        // half-open window. An actual fire-time before that window means the
        // OS fired the callback for some *future* slot too early (32-bit
        // overflow signature, clock jump, accidental replay).
        const schedule = timer.schedules.find((s) => s.id === scheduleId);
        const expectedSlotEnd = intendedFireAt;
        const expectedSlotStart = schedule
          ? computePreviousRun(schedule, timer.timezone, intendedFireAt)
          : null;
        log.warn(
          `[TimerScheduler] early-fire — skipping timer="${timer.name}" timerId=${timerId} scheduleId=${scheduleId} ` +
            `expectedSlotStart=${expectedSlotStart !== null ? new Date(expectedSlotStart).toISOString() : "n/a"} ` +
            `expectedSlotEnd=${new Date(expectedSlotEnd).toISOString()} ` +
            `actualFireTime=${new Date(now).toISOString()} driftMs=${verdict.driftMs} reason=early-fire`,
        );
        return null;
      }
    }

    const schedule = timer.schedules.find((s) => s.id === scheduleId);
    const scheduledSlot =
      trigger === "scheduled" && schedule
        ? this.computeScheduledRunSlot(timer, schedule, intendedFireAt, buildId)
        : null;

    // Best-effort pre-check (reduces noise). The exclusive claim is the
    // appendRun insert under the non-deferred scheduled-slot unique index —
    // concurrent losers lose there, not here.
    if (trigger === "scheduled" && scheduledSlot) {
      const recentRuns = await withQueryAttributionAsync(
        "timer-scheduler",
        () => timerStorage.getRunsForScheduler(timer, 100),
      );
      if (
        this.hasClaimedScheduledRunForSlot(
          recentRuns,
          scheduleId,
          scheduledSlot,
        )
      ) {
        log.debug(
          `skipping timer "${timer.name}" — scheduled slot already claimed ` +
            `scheduleId=${scheduleId} slotStart=${scheduledSlot.slotStart} slotEnd=${scheduledSlot.slotEnd}` +
            (scheduledSlot.buildId ? ` buildId=${scheduledSlot.buildId}` : ""),
        );
        return null;
      }
    }

    // Deterministic run id for build/boot fires so run_id uniqueness is a
    // second claim surface (alongside the slot unique index). Cron/interval
    // fires keep a random id because their slot pair is already exclusive.
    const now = new Date().toISOString();
    const runId =
      trigger === "scheduled" && scheduledSlot?.buildId
        ? `timer-run-build-${timerId}-${scheduleId}-${scheduledSlot.buildId}`
        : `timer-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const run: TimerRun = {
      id: runId,
      timerId,
      scheduleId,
      status: "running",
      startedAt: now,
      trigger,
      intendedFireAt:
        trigger === "scheduled" ? (scheduledSlot?.intendedFireAt ?? now) : undefined,
      scheduledSlotStart:
        trigger === "scheduled" ? (scheduledSlot?.slotStart ?? now) : undefined,
      scheduledSlotEnd:
        trigger === "scheduled" ? (scheduledSlot?.slotEnd ?? now) : undefined,
      metadata:
        trigger === "scheduled"
          ? (scheduledSlot ?? {
              intendedFireAt: now,
              slotStart: now,
              slotEnd: now,
            })
          : { requestedAt: now },
    };

    const executionPrincipal = await this.resolveExecutionPrincipal(timer);
    // Account + pinned Instance authorize Timer spend; quarantined/unentitled fail closed.
    try {
      await runWithPrincipal(executionPrincipal, async () =>
        assertSpendAllowed({
          purpose: "timer",
          principal: executionPrincipal,
          accountId: timer.accountId,
          userId: timer.ownerUserId,
        }),
      );
    } catch (error) {
      if (isSpendAuthorityError(error)) {
        log.warn(
          `skipping timer "${timer.name}" — spend denied reason=${error.reason} ` +
            `accountId=${error.accountId ?? timer.accountId ?? "n/a"} ` +
            `instanceId=${error.instanceId ?? "n/a"}`,
        );
        return null;
      }
      throw error;
    }
    // Claim is the insert. Lost races return false and must not run the handler.
    const claimed = await runWithPrincipal(executionPrincipal, async () =>
      withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.appendRun(timer, run),
      ),
    );
    if (!claimed) {
      log.debug(
        `skipping timer "${timer.name}" — lost exclusive claim ` +
          `runId=${runId} scheduleId=${scheduleId}` +
          (scheduledSlot
            ? ` slotStart=${scheduledSlot.slotStart} slotEnd=${scheduledSlot.slotEnd}`
            : "") +
          (scheduledSlot?.buildId ? ` buildId=${scheduledSlot.buildId}` : ""),
      );
      return null;
    }

    await runWithPrincipal(executionPrincipal, async () => {
      eventBus.publish({
        category: "timer",
        event: "timer.run.start",
        payload: {
          runId,
          timerId,
          name: timer.name,
          type: timer.type,
          trigger,
          metadata: run.metadata,
        },
      });

      log.log(
        `executing "${timer.name}" (${timer.type}) runId=${runId} trigger=${trigger} scope=${timer.scope}`,
      );

      try {
        const handlerResult = await this.executeTimerHandler(timer, run);
        await this.finalizeTimerRun(timer, run, now, handlerResult);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        const fullError = errorStack || errorMessage;
        const handlerResult: TimerHandlerResult =
          errorMessage === "admission_timeout"
            ? {
                outcome: "deferred",
                reason: "admission_timeout",
                output: { error: "admission_timeout: another autonomous run is active" },
              }
            : { outcome: "failed", error: fullError };
        await this.finalizeTimerRun(timer, run, now, handlerResult);
      }
    });

    if (trigger === "scheduled") {
      setTimeout(() => {
        this.rescheduleAll().catch((err: unknown) => {
          const error = normalizeTimerSchedulerError(
            err,
            "reschedule_all",
            "TIMER_RESCHEDULE_FAILED",
            "reschedule failed",
          );
          error.timerId = timerId;
          error.scheduleId = scheduleId;
          error.timerName = timer.name;
          log.warn(
            error,
            timerSchedulerLogContext({
              operation: error.operation!,
              timerId,
              scheduleId,
              timerName: timer.name,
            }),
          );
        });
      }, 1000);
    }

    const updatedRun = (
      await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.getRunsForScheduler(timer, 1),
      )
    )[0];
    return updatedRun || run;
  }

  private async resolveExecutionPrincipal(timer: Timer): Promise<Principal> {
    if (timer.scope === "system" && timer.type === "system" && timer.systemKey) {
      return createNamedSystemPrincipal(`timer:${timer.systemKey}`);
    }
    if (timer.scope !== "user" || !timer.ownerUserId || !timer.accountId) {
      throw new Error(`Timer ${timer.id} is not executable because ownership is unresolved`);
    }
    const user = await storage.getUser(timer.ownerUserId);
    if (!user) throw new Error(`Timer owner user missing: ${timer.ownerUserId}`);
    const principal = createUserPrincipalFromUser(user, timer.accountId);
    principal.permissions = await getUserEffectivePermissions(user.id);
    return principal;
  }

  private async executeTimerHandler(
    timer: Timer,
    run: TimerRun,
  ): Promise<TimerHandlerResult> {
    return timerHandlerRouter.execute(timer, run);
  }

  private async finalizeTimerRun(
    timer: Timer,
    run: TimerRun,
    startedAt: string,
    result: TimerHandlerResult,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const durationMs =
      new Date(completedAt).getTime() - new Date(startedAt).getTime();
    const handlerOutput = isPlainObject(result.output)
      ? result.output
      : undefined;
    const metadata =
      result.output === undefined
        ? run.metadata
        : { ...(run.metadata ?? {}), handlerOutput: result.output };

    if (result.outcome === "accepted") {
      await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.updateRun(timer, run.id, { metadata }),
      );
      log.log(
        `Timer "${timer.name}" execution accepted by downstream Runtime; awaiting terminal receipt`,
      );
      return;
    }

    const update: Partial<TimerRun> = {
      status:
        result.outcome === "success"
          ? "success"
          : result.outcome === "failed"
            ? "error"
            : result.outcome,
      completedAt,
      durationMs,
      metadata,
    };

    if (typeof handlerOutput?.sessionId === "string") {
      update.sessionId = handlerOutput.sessionId;
    }

    if (result.outcome === "failed") {
      update.error = result.error;
    } else if (
      result.outcome === "skipped" ||
      result.outcome === "deferred" ||
      result.outcome === "degraded"
    ) {
      update.error = result.reason;
    }

    await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.updateRun(timer, run.id, update),
    );

    if (result.outcome !== "deferred" && isEphemeralOneTimeTimer(timer)) {
      try {
        const deleted = await withQueryAttributionAsync("timer-scheduler", () =>
          timerStorage.deleteEphemeralOneTimeForScheduler(timer),
        );
        if (deleted) {
          log.debug(`deleted completed ephemeral one-time timer "${timer.name}"`);
        } else {
          log.debug(`skipped cleanup for changed or already-deleted one-time timer "${timer.name}"`);
        }
      } catch (error: unknown) {
        const normalized = normalizeTimerSchedulerError(
          error,
          "ephemeral_delete",
          "TIMER_EPHEMERAL_DELETE_FAILED",
          `failed to delete completed ephemeral one-time timer "${timer.name}"; disabling fallback`,
        );
        normalized.timerId = timer.id;
        normalized.runId = run.id;
        normalized.timerName = timer.name;
        log.error(
          normalized,
          timerSchedulerLogContext({
            operation: normalized.operation!,
            timerId: timer.id,
            runId: run.id,
            timerName: timer.name,
          }),
        );
        await withQueryAttributionAsync("timer-scheduler", () =>
          timerStorage.disableEphemeralOneTimeForScheduler(timer),
        );
      }
    }

    const event =
      result.outcome === "success"
        ? "timer.run.complete"
        : result.outcome === "failed"
          ? "timer.run.error"
          : result.outcome === "deferred"
            ? "timer.run.deferred"
            : result.outcome === "degraded"
              ? "timer.run.degraded"
              : "timer.run.skipped";

    const hasReason =
      result.outcome === "skipped" ||
      result.outcome === "deferred" ||
      result.outcome === "degraded";

    eventBus.publish({
      category: "timer",
      event,
      payload: {
        runId: run.id,
        timerId: timer.id,
        name: timer.name,
        status: update.status,
        durationMs,
        ...(result.outcome === "failed" ? { error: result.error } : {}),
        ...(hasReason ? { reason: result.reason, outcome: result.outcome } : {}),
      },
    });

    if (result.outcome === "success") {
      log.log(
        `completed "${timer.name}" runId=${run.id} duration=${durationMs}ms`,
      );
    } else if (result.outcome === "failed") {
      const error = normalizeTimerSchedulerError(
        result.error,
        "handler_failed",
        "TIMER_HANDLER_FAILED",
        `error "${timer.name}" runId=${run.id}`,
      );
      error.timerId = timer.id;
      error.runId = run.id;
      error.timerName = timer.name;
      log.error(
        error,
        timerSchedulerLogContext({
          operation: error.operation!,
          timerId: timer.id,
          runId: run.id,
          timerName: timer.name,
        }),
      );
    } else if (result.outcome === "degraded") {
      log.warn(`degraded "${timer.name}" runId=${run.id}: ${result.reason}`);
    } else {
      log.debug(`skipped "${timer.name}" runId=${run.id} — ${result.reason}`);
    }
  }

  async setGlobalPaused(paused: boolean): Promise<void> {
    this.globalPaused = paused;
    await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.setSchedulerState({
        globalPaused: paused,
        lastUpdated: new Date().toISOString(),
      }),
    );
    log.debug(`Global pause set to ${paused}`);
    if (paused) {
      Array.from(this.timers.values()).forEach((entry) => entry.cancel());
      this.timers.clear();
    } else {
      await this.rescheduleAll();
    }

    eventBus.publish({
      category: "timer",
      event: "timer:global_pause",
      payload: { paused },
    });
  }

  isGlobalPaused(): boolean {
    return this.globalPaused;
  }

  getNextRunTimes(): Record<string, number> {
    const result: Record<string, number> = {};
    Array.from(this.timers.values()).forEach((entry) => {
      const existing = result[entry.timerId];
      if (!existing || entry.nextRunAt < existing) {
        result[entry.timerId] = entry.nextRunAt;
      }
    });
    return result;
  }
}

export function computeNextRun(
  schedule: Schedule,
  timezone: string,
): number | null {
  const now = Date.now();

  try {
    switch (schedule.frequency) {
      case "every_x_minutes": {
        const interval = (schedule.interval || 30) * 60 * 1000;
        const next = now + interval - (now % interval);
        return next;
      }

      case "every_x_hours": {
        const interval = (schedule.interval || 1) * 60 * 60 * 1000;
        const next = now + interval - (now % interval);
        return next;
      }

      case "every_x_weeks": {
        return getNextMultiWeekRun(
          schedule.timeOfDay || "09:00",
          schedule.daysOfWeek || ["mon"],
          schedule.interval || 1,
          timezone,
          now,
        );
      }

      case "daily": {
        const target = getNextTimeOfDay(
          schedule.timeOfDay || "09:00",
          timezone,
        );
        return target;
      }

      case "weekly": {
        const days = schedule.daysOfWeek || ["mon"];
        const target = getNextWeeklyRun(
          schedule.timeOfDay || "09:00",
          days,
          timezone,
        );
        return target;
      }

      case "monthly": {
        const dayOfMonth = schedule.dayOfMonth || 1;
        const target = getNextMonthlyRun(
          schedule.timeOfDay || "09:00",
          dayOfMonth,
          timezone,
        );
        return target;
      }

      case "quarterly": {
        const quarter = schedule.quarter || 1;
        const target = getNextQuarterlyRun(
          schedule.timeOfDay || "09:00",
          quarter,
          timezone,
        );
        return target;
      }

      case "annually": {
        const dayOfYear = schedule.dayOfYear || 1;
        const target = getNextAnnualRun(
          schedule.timeOfDay || "09:00",
          dayOfYear,
          timezone,
        );
        return target;
      }

      case "once": {
        if (!schedule.fireAt) return null;
        const fireAtMs = new Date(schedule.fireAt).getTime();
        if (isNaN(fireAtMs)) return null;
        return fireAtMs > now ? fireAtMs : null;
      }

      case "custom": {
        if (!schedule.cronExpression?.trim()) return null;
        return (
          new Cron(schedule.cronExpression, { timezone, paused: true })
            .nextRun(new Date(now))
            ?.getTime() ?? null
        );
      }

      default:
        return null;
    }
  } catch (err: unknown) {
    const error = normalizeTimerSchedulerError(
      err,
      "compute_next_run",
      "TIMER_COMPUTE_NEXT_RUN_FAILED",
      "computeNextRun error",
    );
    log.error(
      error,
      timerSchedulerLogContext({
        operation: error.operation!,
        scheduleId: schedule.id,
      }),
    );
    return null;
  }
}

export function computePreviousRun(
  schedule: Schedule,
  timezone: string,
  before: number = Date.now(),
): number | null {
  try {
    switch (schedule.frequency) {
      case "every_x_minutes": {
        const interval = (schedule.interval || 30) * 60 * 1000;
        return before - interval;
      }
      case "every_x_hours": {
        const interval = (schedule.interval || 1) * 60 * 60 * 1000;
        return before - interval;
      }
      case "every_x_weeks":
        return getPrevMultiWeekRun(
          schedule.timeOfDay || "09:00",
          schedule.daysOfWeek || ["mon"],
          schedule.interval || 1,
          timezone,
          before,
        );
      case "daily":
        return getPrevDailyRun(
          schedule.timeOfDay || "09:00",
          timezone,
          before,
        );
      case "weekly": {
        const days = schedule.daysOfWeek || ["mon"];
        return getPrevWeeklyRun(
          schedule.timeOfDay || "09:00",
          days,
          timezone,
          before,
        );
      }
      case "monthly":
        return getPrevMonthlyRun(
          schedule.timeOfDay || "09:00",
          schedule.dayOfMonth || 1,
          timezone,
          before,
        );
      case "quarterly":
        return getPrevQuarterlyRun(
          schedule.timeOfDay || "09:00",
          timezone,
          before,
        );
      case "annually":
        return getPrevAnnualRun(
          schedule.timeOfDay || "09:00",
          schedule.dayOfYear || 1,
          timezone,
          before,
        );
      case "custom": {
        if (!schedule.cronExpression?.trim()) return null;
        return (
          new Cron(schedule.cronExpression, { timezone, paused: true })
            .previousRuns(1, new Date(before))[0]
            ?.getTime() ?? null
        );
      }
      default:
        return null;
    }
  } catch (err: unknown) {
    const error = normalizeTimerSchedulerError(
      err,
      "compute_previous_run",
      "TIMER_COMPUTE_PREVIOUS_RUN_FAILED",
      "computePreviousRun error",
    );
    log.error(
      error,
      timerSchedulerLogContext({
        operation: error.operation!,
        scheduleId: schedule.id,
      }),
    );
    return null;
  }
}

function getPrevDailyRun(
  timeOfDay: string,
  timezone: string,
  before: number,
): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const { year, month, day } = getLocalDateParts(before, timezone);

  for (let offset = 0; offset <= 2; offset++) {
    const candidateDate = new Date(Date.UTC(year, month - 1, day - offset));
    const built = buildDateInTimezone(
      candidateDate.getUTCFullYear(),
      candidateDate.getUTCMonth() + 1,
      candidateDate.getUTCDate(),
      hours,
      minutes,
      timezone,
    );
    if (built.getTime() < before) return built.getTime();
  }

  return before - 24 * 60 * 60 * 1000;
}


const MULTI_WEEK_EPOCH_DATE = Date.UTC(2024, 0, 1);

function isEligibleMultiWeekDate(
  year: number,
  month: number,
  day: number,
  intervalWeeks: number,
): boolean {
  const dateUtc = Date.UTC(year, month - 1, day);
  const weekIndex = Math.floor((dateUtc - MULTI_WEEK_EPOCH_DATE) / (7 * 24 * 60 * 60 * 1000));
  return ((weekIndex % intervalWeeks) + intervalWeeks) % intervalWeeks === 0;
}

function findMultiWeekRun(
  timeOfDay: string,
  days: string[],
  intervalWeeks: number,
  timezone: string,
  boundary: number,
  direction: 1 | -1,
): number {
  const normalizedInterval = Math.max(1, Math.floor(intervalWeeks));
  const targetDays = new Set(days);
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const boundaryDate = new Date(boundary);
  const searchDays = normalizedInterval * 7 + 7;

  for (let offset = 0; offset <= searchDays; offset++) {
    const candidate = new Date(boundaryDate);
    candidate.setUTCDate(candidate.getUTCDate() + direction * offset);
    const dateStr = candidate.toLocaleDateString("en-CA", { timeZone: timezone });
    const [year, month, day] = dateStr.split("-").map(Number);
    const dayName = candidate
      .toLocaleDateString("en-US", { timeZone: timezone, weekday: "short" })
      .toLowerCase()
      .slice(0, 3);
    if (!targetDays.has(dayName) || !isEligibleMultiWeekDate(year, month, day, normalizedInterval)) continue;

    const runAt = buildDateInTimezone(year, month, day, hours, minutes, timezone).getTime();
    if ((direction === 1 && runAt > boundary) || (direction === -1 && runAt < boundary)) return runAt;
  }

  return boundary + direction * normalizedInterval * 7 * 24 * 60 * 60 * 1000;
}

function getNextMultiWeekRun(
  timeOfDay: string,
  days: string[],
  intervalWeeks: number,
  timezone: string,
  after: number,
): number {
  return findMultiWeekRun(timeOfDay, days, intervalWeeks, timezone, after, 1);
}

function getPrevMultiWeekRun(
  timeOfDay: string,
  days: string[],
  intervalWeeks: number,
  timezone: string,
  before: number,
): number {
  return findMultiWeekRun(timeOfDay, days, intervalWeeks, timezone, before, -1);
}

function getPrevWeeklyRun(
  timeOfDay: string,
  days: string[],
  timezone: string,
  before: number,
): number {
  const dayMap: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  const targetDays = days.map((d) => dayMap[d]).filter((d) => d !== undefined);
  if (targetDays.length === 0) return before - 7 * 24 * 60 * 60 * 1000;

  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const beforeDate = new Date(before);

  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(beforeDate);
    candidate.setDate(candidate.getDate() - offset);
    const dateStr = candidate.toLocaleDateString("en-CA", {
      timeZone: timezone,
    });
    const [y, m, d] = dateStr.split("-").map(Number);
    const built = buildDateInTimezone(y, m, d, hours, minutes, timezone);
    const dowStr = candidate
      .toLocaleDateString("en-US", { timeZone: timezone, weekday: "short" })
      .toLowerCase()
      .slice(0, 3);
    const dayNum = dayMap[dowStr];
    if (
      dayNum !== undefined &&
      targetDays.includes(dayNum) &&
      built.getTime() < before
    ) {
      return built.getTime();
    }
  }

  return before - 7 * 24 * 60 * 60 * 1000;
}

function getLocalDateParts(
  ms: number,
  timezone: string,
): { year: number; month: number; day: number } {
  const dateStr = new Date(ms).toLocaleDateString("en-CA", {
    timeZone: timezone,
  });
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

function getPrevMonthlyRun(
  timeOfDay: string,
  dayOfMonth: number,
  timezone: string,
  before: number,
): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const { year, month } = getLocalDateParts(before, timezone);

  for (let offset = 0; offset <= 13; offset++) {
    const monthIndex = month - 1 - offset;
    const candidateYear = year + Math.floor(monthIndex / 12);
    const candidateMonth = ((monthIndex % 12) + 12) % 12 + 1;
    const daysInMonth = new Date(candidateYear, candidateMonth, 0).getDate();
    const clampedDay = Math.min(dayOfMonth, daysInMonth);
    const built = buildDateInTimezone(
      candidateYear,
      candidateMonth,
      clampedDay,
      hours,
      minutes,
      timezone,
    );
    if (built.getTime() < before) return built.getTime();
  }

  return before - 30 * 24 * 60 * 60 * 1000;
}

function getPrevQuarterlyRun(
  timeOfDay: string,
  timezone: string,
  before: number,
): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const { year } = getLocalDateParts(before, timezone);
  const quarterStarts = [10, 7, 4, 1];

  for (let yOffset = 0; yOffset <= 2; yOffset++) {
    const candidateYear = year - yOffset;
    for (const qMonth of quarterStarts) {
      const built = buildDateInTimezone(
        candidateYear,
        qMonth,
        1,
        hours,
        minutes,
        timezone,
      );
      if (built.getTime() < before) return built.getTime();
    }
  }

  return before - 90 * 24 * 60 * 60 * 1000;
}

function getPrevAnnualRun(
  timeOfDay: string,
  dayOfYear: number,
  timezone: string,
  before: number,
): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const { year } = getLocalDateParts(before, timezone);

  for (let yOffset = 0; yOffset <= 3; yOffset++) {
    const targetYear = year - yOffset;
    const targetUtcMs =
      Date.UTC(targetYear, 0, 1) + (dayOfYear - 1) * 24 * 60 * 60 * 1000;
    const utcDate = new Date(targetUtcMs);
    const built = buildDateInTimezone(
      utcDate.getUTCFullYear(),
      utcDate.getUTCMonth() + 1,
      utcDate.getUTCDate(),
      hours,
      minutes,
      timezone,
    );
    if (built.getTime() < before) return built.getTime();
  }

  return before - 365 * 24 * 60 * 60 * 1000;
}

function getNextTimeOfDay(timeOfDay: string, timezone: string): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = new Date();

  const todayStr = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const [year, month, day] = todayStr.split("-").map(Number);

  const candidate = buildDateInTimezone(
    year,
    month,
    day,
    hours,
    minutes,
    timezone,
  );

  if (candidate.getTime() > Date.now()) {
    return candidate.getTime();
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString("en-CA", {
    timeZone: timezone,
  });
  const [y2, m2, d2] = tomorrowStr.split("-").map(Number);
  return buildDateInTimezone(y2, m2, d2, hours, minutes, timezone).getTime();
}

function getNextWeeklyRun(
  timeOfDay: string,
  days: string[],
  timezone: string,
): number {
  const dayMap: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  const targetDays = days
    .map((d) => dayMap[d])
    .filter((d) => d !== undefined)
    .sort();

  if (targetDays.length === 0) return getNextTimeOfDay(timeOfDay, timezone);

  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = new Date();

  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + offset);
    const dateStr = candidate.toLocaleDateString("en-CA", {
      timeZone: timezone,
    });
    const [y, m, d] = dateStr.split("-").map(Number);
    const built = buildDateInTimezone(y, m, d, hours, minutes, timezone);

    const dayOfWeekStr = candidate
      .toLocaleDateString("en-US", { timeZone: timezone, weekday: "short" })
      .toLowerCase()
      .slice(0, 3);
    const dayNum = dayMap[dayOfWeekStr];

    if (targetDays.includes(dayNum) && built.getTime() > Date.now()) {
      return built.getTime();
    }
  }

  return getNextTimeOfDay(timeOfDay, timezone);
}

function getNextMonthlyRun(
  timeOfDay: string,
  dayOfMonth: number,
  timezone: string,
): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = new Date();

  for (let monthOffset = 0; monthOffset < 13; monthOffset++) {
    const candidate = new Date(now);
    candidate.setMonth(candidate.getMonth() + monthOffset);
    const dateStr = candidate.toLocaleDateString("en-CA", {
      timeZone: timezone,
    });
    const [y, m] = dateStr.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const clampedDay = Math.min(dayOfMonth, daysInMonth);
    const built = buildDateInTimezone(
      y,
      m,
      clampedDay,
      hours,
      minutes,
      timezone,
    );

    if (built.getTime() > Date.now()) {
      return built.getTime();
    }
  }

  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

function getNextQuarterlyRun(
  timeOfDay: string,
  _quarter: number,
  timezone: string,
): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const [year, month] = dateStr.split("-").map(Number);

  const quarterStarts = [1, 4, 7, 10];
  for (let yOffset = 0; yOffset < 2; yOffset++) {
    for (const qMonth of quarterStarts) {
      const targetYear = year + yOffset;
      const built = buildDateInTimezone(
        targetYear,
        qMonth,
        1,
        hours,
        minutes,
        timezone,
      );
      if (built.getTime() > Date.now()) {
        return built.getTime();
      }
    }
  }

  return Date.now() + 90 * 24 * 60 * 60 * 1000;
}

function getNextAnnualRun(
  timeOfDay: string,
  dayOfYear: number,
  timezone: string,
): number {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const [year] = dateStr.split("-").map(Number);

  for (let yOffset = 0; yOffset < 3; yOffset++) {
    const targetYear = year + yOffset;
    // Use UTC arithmetic to convert dayOfYear → (year, month, day) so the
    // result does NOT depend on the server's local timezone. dayOfYear=1
    // is January 1, dayOfYear=2 is January 2, etc., regardless of where
    // the process runs.
    const targetUtcMs =
      Date.UTC(targetYear, 0, 1) + (dayOfYear - 1) * 24 * 60 * 60 * 1000;
    const utcDate = new Date(targetUtcMs);
    const y = utcDate.getUTCFullYear();
    const m = utcDate.getUTCMonth() + 1;
    const d = utcDate.getUTCDate();
    const built = buildDateInTimezone(y, m, d, hours, minutes, timezone);
    if (built.getTime() > Date.now()) {
      return built.getTime();
    }
  }

  return Date.now() + 365 * 24 * 60 * 60 * 1000;
}

function buildDateInTimezone(
  year: number,
  month: number,
  day: number,
  hours: number,
  minutes: number,
  timezone: string,
): Date {
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const utcGuess = new Date(dateStr + "Z");
  const parts = formatter.formatToParts(utcGuess);
  const getPart = (type: string) =>
    parts.find((p) => p.type === type)?.value || "0";

  const tzHour = parseInt(getPart("hour"), 10);
  const tzMinute = parseInt(getPart("minute"), 10);

  const hourDiff = hours - tzHour;
  const minuteDiff = minutes - tzMinute;

  const adjustedMs =
    utcGuess.getTime() + hourDiff * 3600000 + minuteDiff * 60000;
  return new Date(adjustedMs);
}

export function humanizeSchedule(schedule: Schedule): string {
  switch (schedule.frequency) {
    case "every_x_minutes":
      return `Every ${schedule.interval || 30} minutes`;
    case "every_x_hours":
      return `Every ${schedule.interval || 1} hour${(schedule.interval || 1) > 1 ? "s" : ""}`;
    case "every_x_weeks": {
      const days = (schedule.daysOfWeek || ["mon"])
        .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
        .join(", ");
      return `Every ${schedule.interval || 1} weeks on ${days} at ${schedule.timeOfDay || "09:00"}`;
    }
    case "daily":
      return `Daily at ${schedule.timeOfDay || "09:00"}`;
    case "weekly": {
      const days = (schedule.daysOfWeek || ["mon"])
        .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
        .join(", ");
      return `Weekly on ${days} at ${schedule.timeOfDay || "09:00"}`;
    }
    case "monthly":
      return `Monthly on day ${schedule.dayOfMonth || 1} at ${schedule.timeOfDay || "09:00"}`;
    case "quarterly":
      return `Quarterly on the 1st at ${schedule.timeOfDay || "09:00"}`;
    case "annually":
      return `Annually on day ${schedule.dayOfYear || 1} at ${schedule.timeOfDay || "09:00"}`;
    case "custom":
      return schedule.cronExpression || "Custom schedule";
    default:
      return "Unknown schedule";
  }
}

export function humanizeNextRun(nextRunAt: number): string {
  const now = Date.now();
  const diff = nextRunAt - now;

  if (diff <= 0) return "Running now";
  if (diff < 60000) return "Less than a minute";
  if (diff < 3600000) {
    const mins = Math.ceil(diff / 60000);
    return `In ${mins} minute${mins > 1 ? "s" : ""}`;
  }
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    const mins = Math.ceil((diff % 3600000) / 60000);
    return mins > 0
      ? `In ${hours}h ${mins}m`
      : `In ${hours} hour${hours > 1 ? "s" : ""}`;
  }
  const days = Math.floor(diff / 86400000);
  if (days === 1) {
    return `Tomorrow at ${new Date(nextRunAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true })}`;
  }
  return `In ${days} days`;
}

export const timerScheduler = new TimerScheduler();
