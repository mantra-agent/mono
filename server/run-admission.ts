import { eventBus } from "./event-bus";
import { createLogger } from "./log";

const log = createLogger("Admission");

export type AdmissionTier = "communication" | "realtime" | "request" | "background";
export type AdmissionState = "idle" | "cooling_down" | "active";

export interface AdmissionSlot {
  runId: string;
  tier: AdmissionTier;
  sessionId?: string;
  activity?: string;
  lineageId?: string;
  yieldRequested: boolean;
  grantedAt: number;
}

interface QueuedRequest {
  runId: string;
  tier: AdmissionTier;
  sessionId?: string;
  activity?: string;
  lineageId?: string;
  resolve: (slot: AdmissionSlot) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  queuedAt: number;
}

const DEFAULT_IDLE_THRESHOLD_MS = 60 * 1000;
const DEFAULT_CONCURRENCY_BUDGET = 20;
const DEFAULT_REQUEST_BUDGET = 14;
const DEFAULT_BACKGROUND_BUDGET = 6;
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
  const concurrencyBudget = parseEnvInt("RUN_ADMISSION_CONCURRENCY_BUDGET", DEFAULT_CONCURRENCY_BUDGET, { min: 1, max: 50 });
  const requestBudget = Math.min(
    concurrencyBudget,
    parseEnvInt("RUN_ADMISSION_REQUEST_BUDGET", DEFAULT_REQUEST_BUDGET, { min: 1, max: 50 }),
  );
  const backgroundBudget = Math.min(
    concurrencyBudget,
    parseEnvInt("RUN_ADMISSION_BACKGROUND_BUDGET", DEFAULT_BACKGROUND_BUDGET, { min: 0, max: 50 }),
  );
  return {
    idleThresholdMs: parseEnvInt("RUN_ADMISSION_IDLE_THRESHOLD_MS", DEFAULT_IDLE_THRESHOLD_MS, { min: 0, max: 30 * 60 * 1000 }),
    concurrencyBudget,
    requestBudget,
    backgroundBudget,
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
  private suspendedSlots = new Map<string, AdmissionSlot>();
  private queue: QueuedRequest[] = [];
  private state: AdmissionState = "idle";
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private slotAgeTimer: ReturnType<typeof setInterval> | null = null;
  private idleThresholdMs: number;
  private concurrencyBudget: number;
  private requestBudget: number;
  private backgroundBudget: number;

  constructor() {
    const config = getInitialAdmissionConfig();
    this.idleThresholdMs = config.idleThresholdMs;
    this.concurrencyBudget = config.concurrencyBudget;
    this.requestBudget = config.requestBudget;
    this.backgroundBudget = config.backgroundBudget;
    log.debug(
      `Initialized admission config: budget=${this.concurrencyBudget}, requestBudget=${this.requestBudget}, ` +
      `backgroundBudget=${this.backgroundBudget}, idleThreshold=${this.idleThresholdMs}ms`
    );
    this.slotAgeTimer = setInterval(() => this.enforceMaxSlotAge(), 60_000);
  }

  getState(): AdmissionState {
    return this.state;
  }

  getSlots(): AdmissionSlot[] {
    return Array.from(this.slots.values());
  }

  getSuspendedSlots(): AdmissionSlot[] {
    return Array.from(this.suspendedSlots.values());
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getQueuedRequestForSession(sessionId: string): { runId: string; tier: AdmissionTier; activity?: string } | undefined {
    const request = this.queue.find((queued) => queued.sessionId === sessionId);
    if (!request) return undefined;
    return { runId: request.runId, tier: request.tier, activity: request.activity };
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

  private getForegroundCount(): number {
    const counts = this.getTierCounts();
    return counts.communication + counts.realtime + counts.request;
  }

  private canAdmitRealtime(): boolean {
    return this.getActiveCount() < this.concurrencyBudget;
  }

  private canAdmitRequest(): boolean {
    return this.getTierCounts().request < this.requestBudget && this.getActiveCount() < this.concurrencyBudget;
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
    options?: { sessionId?: string; activity?: string; lineageId?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<AdmissionSlot> {
    const slot: AdmissionSlot = {
      runId,
      tier,
      sessionId: options?.sessionId,
      activity: options?.activity,
      lineageId: options?.lineageId,
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
      const totalOverflow = Math.max(0, this.getActiveCount() - this.concurrencyBudget);
      if (totalOverflow > 0) {
        this.yieldLowestTierRuns(tier, totalOverflow, options?.lineageId);
      }
      log.verbose(() => `Communication slot granted: ${runId}`);
      return slot;
    }

    if (tier === "realtime") {
      if (this.canAdmitRealtime()) {
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
      this.yieldLowestTierRuns(tier, 1, options?.lineageId);
      log.verbose(() => `Realtime run queued (with preemption signal): ${runId} (queue depth: ${this.queue.length + 1}, timeout: ${timeout}ms)`);
      return this.enqueue(runId, tier, timeout, options?.signal, { sessionId: options?.sessionId, activity: options?.activity, lineageId: options?.lineageId });
    }

    if (tier === "request") {
      if (this.canAdmitRequest()) {
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
      this.yieldLowestTierRuns(tier, 1, options?.lineageId);
      log.verbose(() => `Request run queued: ${runId} (queue depth: ${this.queue.length + 1}, timeout: ${timeout}ms)`);
      return this.enqueue(runId, tier, timeout, options?.signal, { sessionId: options?.sessionId, activity: options?.activity, lineageId: options?.lineageId });
    }

    if (this.canAdmitBackground({ activity: options?.activity })) {
      this.slots.set(runId, slot);
      this.setState("active");
      log.verbose(() => `Background slot granted: ${runId}${options?.activity ? ` (activity: ${options.activity})` : ""}`);
      return slot;
    }

    const timeout = options?.timeout ?? DEFAULT_ADMISSION_TIMEOUT_MS;
    log.verbose(() => `Background run queued: ${runId} (queue depth: ${this.queue.length + 1}, timeout: ${timeout}ms)`);
    return this.enqueue(runId, tier, timeout, options?.signal, { sessionId: options?.sessionId, activity: options?.activity, lineageId: options?.lineageId });
  }

  /** Whether a background run can be admitted right now (public for pre-flight checks). */
  canAdmitBackground(_options?: { activity?: string }): boolean {
    if (this.cooldownTimer !== null) return false;
    return this.getTierCounts().background < this.backgroundBudget && this.getActiveCount() < this.concurrencyBudget;
  }

  getAdmissionSnapshot(_options?: { activity?: string }) {
    return {
      state: this.state,
      tierCounts: this.getTierCounts(),
      queueDepth: this.getQueueDepth(),
      queuedByTier: this.getQueuedByTier(),
      activeCount: this.getActiveCount(),
      foregroundCount: this.getForegroundCount(),
      concurrencyBudget: this.concurrencyBudget,
      requestBudget: this.requestBudget,
      backgroundBudget: this.backgroundBudget,
      idleThresholdMs: this.idleThresholdMs,
      cooldownActive: this.cooldownTimer !== null,
    };
  }

  private enqueue(
    runId: string,
    tier: AdmissionTier,
    timeout: number,
    signal?: AbortSignal,
    options?: { sessionId?: string; activity?: string; lineageId?: string },
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
              const [expired] = this.queue.splice(idx, 1);
              log.warn(
                `Admission timeout for ${tier} run: ${runId} sessionId=${expired.sessionId ?? "none"} ` +
                `queueAgeMs=${Date.now() - expired.queuedAt} activity=${expired.activity ?? "none"}`,
              );
              reject(new Error("admission_timeout"));
            }
          }, timeout)
        : null;

      // Wire the abort signal to cancel the queued request
      const onAbort = () => {
        const idx = this.queue.findIndex(q => q.runId === runId);
        if (idx !== -1) {
          if (this.queue[idx].timer) clearTimeout(this.queue[idx].timer);
          const [cancelled] = this.queue.splice(idx, 1);
          log.debug(
            `autonomous.lifecycle phase=queue-aborted runId=${runId} sessionId=${cancelled.sessionId ?? "none"} ` +
            `tier=${tier} activity=${cancelled.activity ?? "none"} queueAgeMs=${Date.now() - cancelled.queuedAt}`,
          );
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

      const queuedAt = Date.now();
      this.queue.push({
        runId,
        tier,
        sessionId: options?.sessionId,
        activity: options?.activity,
        lineageId: options?.lineageId,
        resolve: wrappedResolve,
        reject: wrappedReject,
        timer,
        queuedAt,
      });
      this.queue.sort((a, b) => TIER_PRIORITY[a.tier] - TIER_PRIORITY[b.tier]);
      log.debug(
        `autonomous.lifecycle phase=queued runId=${runId} sessionId=${options?.sessionId ?? "none"} ` +
        `tier=${tier} activity=${options?.activity ?? "none"} queueDepth=${this.queue.length} timeoutMs=${timeout}`,
      );
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

  async withSuspendedSlot<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const slot = this.slots.get(runId);
    if (!slot) return fn();

    this.suspendedSlots.set(runId, slot);
    this.releaseSlot(runId);
    log.debug(`Admission slot suspended: ${runId} tier=${slot.tier} lineageId=${slot.lineageId ?? "none"}`);
    try {
      return await fn();
    } finally {
      try {
        await this.requestSlot(slot.tier, runId, {
          sessionId: slot.sessionId,
          activity: slot.activity,
          lineageId: slot.lineageId,
        });
        log.debug(`Admission slot resumed: ${runId} tier=${slot.tier} lineageId=${slot.lineageId ?? "none"}`);
      } finally {
        this.suspendedSlots.delete(runId);
      }
    }
  }

  private yieldLowestTierRuns(callerTier: AdmissionTier, count: number, callerLineageId?: string): void {
    const candidates = Array.from(this.slots.values())
      .filter(s => {
        if (s.yieldRequested) return false;
        if (callerLineageId && s.lineageId === callerLineageId) return false;
        if (callerTier === "communication") {
          return s.tier === "realtime" || s.tier === "request" || s.tier === "background";
        }
        if (s.tier === "realtime") return false;
        if (callerTier === "realtime") {
          return s.tier === "request" || s.tier === "background";
        }
        if (callerTier === "request") {
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
    while (this.queue.length > 0) {
      const nextIndex = this.queue.findIndex((next) => {
        if (next.tier === "background") return false;
        return next.tier === "realtime" ? this.canAdmitRealtime() : this.canAdmitRequest();
      });
      if (nextIndex === -1) break;
      this.grantFromQueue(nextIndex, true);
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const nextIndex = this.queue.findIndex((next) => {
        if (next.tier === "background") {
          return this.canAdmitBackground({ activity: next.activity });
        }
        if (next.tier === "realtime") {
          return this.canAdmitRealtime();
        }
        return this.canAdmitRequest();
      });
      if (nextIndex === -1) break;
      this.grantFromQueue(nextIndex, false);
    }
  }

  private grantFromQueue(index: number, cooldownBypassed: boolean): void {
    const [request] = this.queue.splice(index, 1);
    if (!request) return;
    if (request.timer) clearTimeout(request.timer);

    const slot: AdmissionSlot = {
      runId: request.runId,
      tier: request.tier,
      sessionId: request.sessionId,
      activity: request.activity,
      lineageId: request.lineageId,
      yieldRequested: false,
      grantedAt: Date.now(),
    };
    this.slots.set(request.runId, slot);
    this.setState("active");

    log.debug(
      `autonomous.lifecycle phase=admitted runId=${request.runId} sessionId=${request.sessionId ?? "none"} ` +
      `tier=${request.tier} activity=${request.activity ?? "none"} queueAgeMs=${Date.now() - request.queuedAt} ` +
      `queueDepth=${this.queue.length} cooldownBypassed=${cooldownBypassed}`,
    );
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

  configure(options: { idleThresholdMs?: number; concurrencyBudget?: number; requestBudget?: number; backgroundBudget?: number }): void {
    if (options.idleThresholdMs !== undefined) {
      this.idleThresholdMs = options.idleThresholdMs;
      log.verbose(() => `Idle threshold updated: ${this.idleThresholdMs}ms`);
    }
    if (options.concurrencyBudget !== undefined) {
      this.concurrencyBudget = Math.max(1, options.concurrencyBudget);
    }
    if (options.requestBudget !== undefined) {
      this.requestBudget = Math.max(1, Math.min(this.concurrencyBudget, options.requestBudget));
    }
    if (options.backgroundBudget !== undefined) {
      this.backgroundBudget = Math.max(0, Math.min(this.concurrencyBudget, options.backgroundBudget));
    }
    if (options.concurrencyBudget !== undefined || options.requestBudget !== undefined || options.backgroundBudget !== undefined) {
      this.requestBudget = Math.min(this.requestBudget, this.concurrencyBudget);
      this.backgroundBudget = Math.min(this.backgroundBudget, this.concurrencyBudget);
      log.verbose(
        () => `Admission budgets updated: total=${this.concurrencyBudget}, ` +
          `request=${this.requestBudget}, background=${this.backgroundBudget}`,
      );
      this.drainQueue();
      this.updateState();
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
    this.suspendedSlots.clear();
  }

  reset(): void {
    this.shutdown();
    this.state = "idle";
    this.slotAgeTimer = setInterval(() => this.enforceMaxSlotAge(), 60_000);
  }
}

export const admissionController = new RunAdmissionController();
