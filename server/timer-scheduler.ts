// Use createLogger for logging ONLY
import { timerStorage } from "./file-storage";
import { eventBus } from "./event-bus";
import type { Timer, Schedule, TimerRun } from "@shared/models/timers";
import { createLogger } from "./log";
import { withQueryAttributionAsync } from "./db";
import { systemTimerRegistry } from "./system-timer-registry";
import { timerHandlerRouter } from "./timer-handler-router";
import { getSetting, setSetting } from "./system-settings";
import type { TimerHandlerResult } from "./timer-handlers";

const log = createLogger("TimerScheduler");

// Single source of truth for build identity across boots. Next-build reminders
// fire only when the running build differs from the build recorded at the
// previous boot, so crash-restarts of the same build do not re-fire them.
const LAST_BOOT_BUILD_ID_KEY = "system.lastBootBuildId";

function getCurrentBuildId(): string | null {
  return process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null;
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
          log.error(
            `safeSetLongTimeout callback threw:`,
            err instanceof Error ? err.message : String(err),
          );
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
    await this.fireBootReminders();
    await this.rescheduleAll();

    this.checkInterval = setInterval(() => {
      this.rescheduleAll().catch((err: unknown) => {
        log.error(
          `reschedule error:`,
          err instanceof Error ? err.message : String(err),
        );
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

  async rescheduleAll(): Promise<void> {
    await systemTimerRegistry.healMissingTimers();

    const allTimers = await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.getAll(),
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
        log.error(
          `execution error timer=${timerId}:`,
          err instanceof Error ? err.message : String(err),
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
      // Determine build identity before evaluating reminders, and persist it
      // on every evaluated boot so the comparison is always against the
      // previous boot. Unknown build identity degrades next-build reminders
      // to next-boot behavior (fire) rather than never firing.
      const currentBuildId = getCurrentBuildId();
      let isNewBuild = true;
      if (currentBuildId) {
        const lastBuildId = await getSetting<string>(LAST_BOOT_BUILD_ID_KEY);
        isNewBuild = lastBuildId !== currentBuildId;
        if (lastBuildId !== currentBuildId) {
          await setSetting(LAST_BOOT_BUILD_ID_KEY, currentBuildId);
        }
      } else {
        log.warn(
          "build identity unavailable (RAILWAY_GIT_COMMIT_SHA unset); next-build reminders degrade to next-boot behavior",
        );
      }

      const allTimers = await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.getAll(),
      );
      const bootReminders = allTimers.filter(
        (t) =>
          t.type === "reminder" &&
          t.enabled &&
          t.schedules?.some((s) => s.fireOnNextBoot || s.fireOnNextBuild),
      );
      if (bootReminders.length === 0) return;
      log.debug(
        `Evaluating ${bootReminders.length} boot reminder(s), isNewBuild=${isNewBuild} build=${currentBuildId?.slice(0, 7) ?? "unknown"}`,
      );
      for (const timer of bootReminders) {
        const schedule = timer.schedules.find(
          (s) => s.fireOnNextBoot || s.fireOnNextBuild,
        );
        if (!schedule) continue;
        if (!schedule.fireOnNextBoot && schedule.fireOnNextBuild && !isNewBuild) {
          log.debug(
            `holding next-build reminder "${timer.name}" — same build as previous boot`,
          );
          continue;
        }
        try {
          await this.executeTimer(timer.id, schedule.id, "scheduled");
        } catch (err: unknown) {
          log.error(
            `fireBootReminders error for "${timer.name}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } catch (err: unknown) {
      log.error(
        `fireBootReminders error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private computeScheduledRunSlot(
    timer: Timer,
    schedule: Timer["schedules"][number],
    intendedFireAt?: number,
  ): ScheduledRunSlot {
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

  private hasSuccessfulScheduledRunForSlot(
    runs: TimerRun[],
    scheduleId: string,
    slot: ScheduledRunSlot,
  ): boolean {
    return runs.some(
      (run) =>
        run.trigger === "scheduled" &&
        run.scheduleId === scheduleId &&
        run.status === "success" &&
        run.scheduledSlotStart === slot.slotStart &&
        run.scheduledSlotEnd === slot.slotEnd,
    );
  }

  async executeTimer(
    timerId: string,
    scheduleId: string,
    trigger: "scheduled" | "manual" = "scheduled",
    intendedFireAt?: number,
  ): Promise<TimerRun | null> {
    const timer = await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.get(timerId),
    );
    if (!timer) {
      log.error(`timer not found: ${timerId}`);
      return null;
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
        ? this.computeScheduledRunSlot(timer, schedule, intendedFireAt)
        : null;

    if (trigger === "scheduled" && scheduledSlot) {
      const recentRuns = await withQueryAttributionAsync(
        "timer-scheduler",
        () => timerStorage.getRuns(timerId, 100),
      );
      if (
        this.hasSuccessfulScheduledRunForSlot(
          recentRuns,
          scheduleId,
          scheduledSlot,
        )
      ) {
        log.debug(
          `skipping timer "${timer.name}" — already ran successfully for scheduled slot ` +
            `scheduleId=${scheduleId} slotStart=${scheduledSlot.slotStart} slotEnd=${scheduledSlot.slotEnd}`,
        );
        return null;
      }
    }

    const runId = `timer-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

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

    await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.appendRun(run),
    );

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
      `executing "${timer.name}" (${timer.type}) runId=${runId} trigger=${trigger}`,
    );

    try {
      const handlerResult = await this.executeTimerHandler(timer, run);
      await this.finalizeTimerRun(timer, run, now, handlerResult);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      const fullError = errorStack || errorMessage;
      const handlerResult: TimerHandlerResult =
        errorMessage === "admission_timeout"
          ? {
              outcome: "deferred",
              reason: "admission_timeout",
              output: {
                error: "admission_timeout: another autonomous run is active",
              },
            }
          : { outcome: "failed", error: fullError };

      await this.finalizeTimerRun(timer, run, now, handlerResult);
    }

    if (trigger === "scheduled") {
      setTimeout(() => {
        this.rescheduleAll().catch((err) => log.warn("reschedule failed", err));
      }, 1000);
    }

    const updatedRun = (
      await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.getRuns(timerId, 1),
      )
    )[0];
    return updatedRun || run;
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
      timerStorage.updateRun(timer.id, run.id, update),
    );

    if (handlerOutput?.disableTimer === true) {
      await withQueryAttributionAsync("timer-scheduler", () =>
        timerStorage.update(timer.id, { enabled: false }),
      );
      log.debug(`disabled timer "${timer.name}" after handler request`);
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
      log.error(`error "${timer.name}" runId=${run.id}:`, result.error);
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
        return null;
      }

      default:
        return null;
    }
  } catch (err: unknown) {
    log.error(
      `computeNextRun error:`,
      err instanceof Error ? err.message : String(err),
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
      default:
        return null;
    }
  } catch (err: unknown) {
    log.error(
      `computePreviousRun error:`,
      err instanceof Error ? err.message : String(err),
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
