import { eventBus } from "./event-bus";
import { ACTIVITY_MEMORY } from "./job-profiles";
import { createLogger } from "./log";

const log = createLogger("Admission");

export type AdmissionTier = "communication" | "realtime" | "request" | "background";
export type AdmissionState = "idle" | "cooling_down" | "active";

export interface AdmissionSlot {
  runId: string;
  tier: AdmissionTier;
  sessionId?: string;
  activity?: string;
  yieldRequested: boolean;
  grantedAt: number;
}

interface QueuedRequest {
  runId: string;
  tier: AdmissionTier;
  sessionId?: string;
  activity?: string;
  resolve: (slot: AdmissionSlot) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_IDLE_THRESHOLD_MS = 60 * 1000;
const DEFAULT_CONCURRENCY_BUDGET = 5;
const DEFAULT_BACKGROUND_RESERVE = 1;
const DEFAULT_MAINTENANCE_RESERVE = 0;
const DEFAULT_ADMISSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_BACKGROUND_SLOT_AGE_MS = 15 * 60 * 1000;

function parseEnvInt(name: string, fallback: number, options?: { min?: number; max?: number }): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    log.warn(`${name} invalid (${raw}); using ${fallback}`);
    return fallback;
  }

  const min = options?.min ?? Number.NEGATIVE_INFINITY;
  const max = options?.max ?? Number.POSITIVE_INFINITY;
  const bounded = Math.min(max, Math.max(min, parsed));
  if (bounded !== parsed) {
    log.warn(`${name} out of range (${raw}); using bounded value ${bounded}`);
  }
  return bounded;
}

function getInitialAdmissionConfig() {
  const concurrencyBudget = parseEnvInt("RUN_ADMISSION_CONCURRENCY_BUDGET", DEFAULT_CONCURRENCY_BUDGET, { min: 1, max: 25 });
  const backgroundReserve = parseEnvInt("RUN_ADMISSION_BACKGROUND_RESERVE", DEFAULT_BACKGROUND_RESERVE, { min: 0, max: Math.max(0, concurrencyBudget - 1) });
  const maintenanceReserve = parseEnvInt("RUN_ADMISSION_MAINTENANCE_RESERVE", DEFAULT_MAINTENANCE_RESERVE, { min: 0, max: Math.max(0, concurrencyBudget - 1) });
  return {
    idleThresholdMs: parseEnvInt("RUN_ADMISSION_IDLE_THRESHOLD_MS", DEFAULT_IDLE_THRESHOLD_MS, { min: 0, max: 30 * 60 * 1000 }),
    concurrencyBudget,
    backgroundReserve,
    maintenanceReserve,
  };
}

const TIER_PRIORITY: Record<AdmissionTier, number> = {
  communication: 0,
  realtime: 1,
  request: 2,
  background: 3,
};

export class RunAdmissionController {
  private slots = new Map<string, AdmissionSlot>();
  private queue: QueuedRequest[] = [];
  private state: AdmissionState = "idle";
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private slotAgeTimer: ReturnType<typeof setInterval> | null = null;
  private idleThresholdMs: number;
  private concurrencyBudget: number;
  private backgroundReserve: number;
  private maintenanceReserve: number;

  constructor() {
    const config = getInitialAdmissionConfig();
    this.idleThresholdMs = config.idleThresholdMs;
    this.concurrencyBudget = config.concurrencyBudget;
    this.backgroundReserve = config.backgroundReserve;
    this.maintenanceReserve = config.maintenanceReserve;
    log.debug(
      `Initialized admission config: budget=${this.concurrencyBudget}, idleThreshold=${this.idleThresholdMs}ms, ` +
      `backgroundReserve=${this.backgroundReserve}, maintenanceReserve=${this.maintenanceReserve}`
    );
    this.slotAgeTimer = setInterval(() => this.enforceMaxSlotAge(), 60_000);
  }

  getState(): AdmissionState {
    return this.state;
  }

  getSlots(): AdmissionSlot[] {
    return Array.from(this.slots.values());
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getQueuedByTier(): Record<AdmissionTier, number> {
    const counts: Record<AdmissionTier, number> = { communication: 0, realtime: 0, request: 0, background: 0 };
    for (const q of this.queue) {
      counts[q.tier]++;
    }
    return counts;
  }

  getTierCounts(): Record<AdmissionTier, number> {
    const counts: Record<AdmissionTier, number> = { communication: 0, realtime: 0, request: 0, background: 0 };
    for (const slot of this.slots.values()) {
      counts[slot.tier]++;
    }
    return counts;
  }

  private getActiveCount(): number {
    return this.slots.size;
  }

  private setState(newState: AdmissionState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    log.verbose(() => `State: ${oldState} → ${newState}`);

    if (newState === "idle") {
      eventBus.publish({ category: "system", event: "system.state.idle", payload: { previousState: oldState } });
    } else if (newState === "active") {
      eventBus.publish({ category: "system", event: "system.state.active", payload: { previousState: oldState, tierCounts: this.getTierCounts() } });
    }
  }

  private updateState(): void {
    const count = this.getActiveCount();
    if (count === 0 && this.state !== "cooling_down") {
      this.setState("idle");
    } else if (count > 0) {
      this.setState("active");
    }
  }

  async requestSlot(
    tier: AdmissionTier,
    runId: string,
    options?: { sessionId?: string; activity?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<AdmissionSlot> {
    const slot: AdmissionSlot = {
      runId,
      tier,
      sessionId: options?.sessionId,
      activity: options?.activity,
      yieldRequested: false,
      grantedAt: Date.now(),
    };

    if (tier === "communication") {
      this.slots.set(runId, slot);
      if (this.cooldownTimer) {
        clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
      }
      this.setState("active");
      if (this.getActiveCount() > this.concurrencyBudget) {
        this.yieldLowestTierRuns(tier, this.getActiveCount() - this.concurrencyBudget);
      }
      log.verbose(() => `Communication slot granted: ${runId}`);
      return slot;
    }

    if (tier === "realtime") {
      if (this.getActiveCount() < this.concurrencyBudget) {
        this.slots.set(runId, slot);
        if (this.cooldownTimer) {
          clearTimeout(this.cooldownTimer);
          this.cooldownTimer = null;
        }
        this.setState("active");
        log.verbose(() => `Realtime slot granted: ${runId}`);
        return slot;
      }

      const timeout = options?.timeout ?? DEFAULT_ADMISSION_TIMEOUT_MS;
      this.yieldLowestTierRuns(tier, 1);
      log.verbose(() => `Realtime run queued (with preemption signal): ${runId} (queue depth: ${this.queue.length + 1}, timeout: ${timeout}ms)`);
      return this.enqueue(runId, tier, timeout, options?.signal, { sessionId: options?.sessionId, activity: options?.activity });
    }

    if (tier === "request") {
      if (this.getActiveCount() < this.concurrencyBudget) {
        if (this.cooldownTimer) {
          clearTimeout(this.cooldownTimer);
          this.cooldownTimer = null;
        }
        this.slots.set(runId, slot);
        this.setState("active");
        log.verbose(() => `Request slot granted: ${runId}`);
        return slot;
      }

      const timeout = options?.timeout ?? DEFAULT_ADMISSION_TIMEOUT_MS;
      this.yieldLowestTierRuns(tier, 1);
      log.verbose(() => `Request run queued: ${runId} (queue depth: ${this.queue.length + 1}, timeout: ${timeout}ms)`);
      return this.enqueue(runId, tier, timeout, options?.signal, { sessionId: options?.sessionId, activity: options?.activity });
    }

    if (this.canAdmitBackground({ activity: options?.activity })) {
      this.slots.set(runId, slot);
      this.setState("active");
      log.verbose(() => `Background slot granted: ${runId}${options?.activity ? ` (activity: ${options.activity})` : ""}`);
      return slot;
    }

    const timeout = options?.timeout ?? DEFAULT_ADMISSION_TIMEOUT_MS;
    log.verbose(() => `Background run queued: ${runId} (queue depth: ${this.queue.length + 1}, timeout: ${timeout}ms)`);
    return this.enqueue(runId, tier, timeout, options?.signal, { sessionId: options?.sessionId, activity: options?.activity });
  }

  /** Whether a background run can be admitted right now (public for pre-flight checks). */
  canAdmitBackground(options?: { activity?: string }): boolean {
    if (this.cooldownTimer !== null) return false;
    const reserve = this.getBackgroundReserve(options?.activity);
    return this.getActiveCount() < Math.max(1, this.concurrencyBudget - reserve);
  }

  getAdmissionSnapshot(options?: { activity?: string }) {
    return {
      state: this.state,
      tierCounts: this.getTierCounts(),
      queueDepth: this.getQueueDepth(),
      queuedByTier: this.getQueuedByTier(),
      activeCount: this.getActiveCount(),
      concurrencyBudget: this.concurrencyBudget,
      backgroundReserve: this.getBackgroundReserve(options?.activity),
      idleThresholdMs: this.idleThresholdMs,
      cooldownActive: this.cooldownTimer !== null,
      maintenance: this.isMaintenanceActivity(options?.activity),
    };
  }

  private isMaintenanceActivity(activity?: string): boolean {
    return activity === ACTIVITY_MEMORY;
  }

  private getBackgroundReserve(activity?: string): number {
    return this.isMaintenanceActivity(activity) ? this.maintenanceReserve : this.backgroundReserve;
  }

  private enqueue(
    runId: string,
    tier: AdmissionTier,
    timeout: number,
    signal?: AbortSignal,
    options?: { sessionId?: string; activity?: string },
  ): Promise<AdmissionSlot> {
    return new Promise<AdmissionSlot>((resolve, reject) => {
      // If already aborted before queueing, reject immediately
      if (signal?.aborted) {
        log.verbose(() => `Admission request already aborted for ${tier} run: ${runId}`);
        reject(new Error("admission_aborted"));
        return;
      }

      const timer = timeout > 0
        ? setTimeout(() => {
            const idx = this.queue.findIndex(q => q.runId === runId);
            if (idx !== -1) {
              this.queue.splice(idx, 1);
              log.warn(`Admission timeout for ${tier} run: ${runId}`);
              reject(new Error("admission_timeout"));
            }
          }, timeout)
        : null;

      // Wire the abort signal to cancel the queued request
      const onAbort = () => {
        const idx = this.queue.findIndex(q => q.runId === runId);
        if (idx !== -1) {
          if (this.queue[idx].timer) clearTimeout(this.queue[idx].timer);
          this.queue.splice(idx, 1);
          log.verbose(() => `Admission request cancelled by signal for ${tier} run: ${runId}`);
          reject(new Error("admission_aborted"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      // Wrap resolve to clean up signal listener
      const wrappedResolve = (slot: AdmissionSlot) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(slot);
      };

      // Wrap reject to clean up signal listener
      const wrappedReject = (err: Error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      };

      this.queue.push({
        runId,
        tier,
        sessionId: options?.sessionId,
        activity: options?.activity,
        resolve: wrappedResolve,
        reject: wrappedReject,
        timer,
      });
      this.queue.sort((a, b) => TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier]);
    });
  }

  releaseSlot(runId: string): void {
    const slot = this.slots.get(runId);
    if (!slot) return;

    this.slots.delete(runId);
    log.verbose(() => `Slot released: ${runId} (tier: ${slot.tier})`);

    if (slot.tier === "communication") {
      const hasCommunication = this.getTierCounts().communication > 0;
      if (!hasCommunication) {
        this.startCooldown();
      } else {
        this.drainQueue();
        this.updateState();
      }
    } else {
      this.drainQueue();
      this.updateState();
    }
  }

  isYieldRequested(runId: string): boolean {
    const slot = this.slots.get(runId);
    return slot?.yieldRequested ?? false;
  }

  private yieldLowestTierRuns(callerTier: AdmissionTier, count: number): void {
    const candidates = Array.from(this.slots.values())
      .filter(s => {
        if (s.yieldRequested) return false;
        if (s.tier === "realtime") return false;
        if (callerTier === "communication") {
          return s.tier === "request" || s.tier === "background";
        }
        if (callerTier === "realtime" || callerTier === "request") {
          return s.tier === "background";
        }
        return false;
      })
      .sort((a, b) => TIER_PRIORITY[b.tier] - TIER_PRIORITY[a.tier]);

    let yielded = 0;
    for (const slot of candidates) {
      if (yielded >= count) break;
      slot.yieldRequested = true;
      yielded++;
      log.verbose(() => `Yield requested for ${slot.tier} run: ${slot.runId} (preempted by ${callerTier})`);
    }
  }

  private startCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    this.setState("cooling_down");
    this.drainNonBackgroundQueue();
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      const counts = this.getTierCounts();
      if (counts.communication === 0) {
        if (this.getActiveCount() === 0) {
          this.setState("idle");
        }
        this.drainQueue();
        this.updateState();
      }
    }, this.idleThresholdMs);
  }

  private drainNonBackgroundQueue(): void {
    let i = 0;
    while (i < this.queue.length) {
      const next = this.queue[i];
      if (next.tier === "background") {
        i++;
        continue;
      }
      if (this.getActiveCount() >= this.concurrencyBudget) break;
      this.queue.splice(i, 1);
      if (next.timer) clearTimeout(next.timer);
      const slot: AdmissionSlot = {
        runId: next.runId,
        tier: next.tier,
        sessionId: next.sessionId,
        activity: next.activity,
        yieldRequested: false,
        grantedAt: Date.now(),
      };
      this.slots.set(next.runId, slot);
      this.setState("active");
      log.verbose(() => `${next.tier} slot granted from queue (skipped cooldown): ${next.runId}`);
      next.resolve(slot);
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.tier === "background") {
        if (!this.canAdmitBackground({ activity: next.activity })) break;
      } else {
        if (this.getActiveCount() >= this.concurrencyBudget) break;
      }
      this.grantNextFromQueue();
    }
  }

  private grantNextFromQueue(): void {
    if (this.queue.length === 0) return;

    const request = this.queue.shift()!;
    if (request.timer) clearTimeout(request.timer);

    const slot: AdmissionSlot = {
      runId: request.runId,
      tier: request.tier,
      sessionId: request.sessionId,
      activity: request.activity,
      yieldRequested: false,
      grantedAt: Date.now(),
    };
    this.slots.set(request.runId, slot);
    this.setState("active");

    log.verbose(() => `${request.tier} slot granted from queue: ${request.runId}`);
    request.resolve(slot);
  }

  private enforceMaxSlotAge(): void {
    const now = Date.now();
    for (const [runId, slot] of this.slots) {
      if (slot.tier === "background" && (now - slot.grantedAt) > MAX_BACKGROUND_SLOT_AGE_MS) {
        log.warn(`Background slot exceeded max age (${MAX_BACKGROUND_SLOT_AGE_MS}ms), force-releasing: ${runId}`);
        slot.yieldRequested = true;
      }
    }
  }

  configure(options: { idleThresholdMs?: number; concurrencyBudget?: number; backgroundReserve?: number; maintenanceReserve?: number }): void {
    if (options.idleThresholdMs !== undefined) {
      this.idleThresholdMs = options.idleThresholdMs;
      log.verbose(() => `Idle threshold updated: ${this.idleThresholdMs}ms`);
    }
    if (options.concurrencyBudget !== undefined) {
      this.concurrencyBudget = Math.max(1, options.concurrencyBudget);
      this.backgroundReserve = Math.min(this.backgroundReserve, Math.max(0, this.concurrencyBudget - 1));
      this.maintenanceReserve = Math.min(this.maintenanceReserve, Math.max(0, this.concurrencyBudget - 1));
      log.verbose(() => `Concurrency budget updated: ${this.concurrencyBudget}`);
    }
    if (options.backgroundReserve !== undefined) {
      this.backgroundReserve = Math.min(Math.max(0, options.backgroundReserve), Math.max(0, this.concurrencyBudget - 1));
      log.verbose(() => `Background reserve updated: ${this.backgroundReserve}`);
    }
    if (options.maintenanceReserve !== undefined) {
      this.maintenanceReserve = Math.min(Math.max(0, options.maintenanceReserve), Math.max(0, this.concurrencyBudget - 1));
      log.verbose(() => `Maintenance reserve updated: ${this.maintenanceReserve}`);
    }
  }

  shutdown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    if (this.slotAgeTimer) {
      clearInterval(this.slotAgeTimer);
      this.slotAgeTimer = null;
    }
    for (const request of this.queue) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(new Error("shutdown"));
    }
    this.queue = [];
    this.slots.clear();
  }

  reset(): void {
    this.shutdown();
    this.state = "idle";
    this.slotAgeTimer = setInterval(() => this.enforceMaxSlotAge(), 60_000);
  }
}

export const admissionController = new RunAdmissionController();
