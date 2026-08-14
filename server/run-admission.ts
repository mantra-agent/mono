import { AsyncLocalStorage } from "async_hooks";
import crypto from "crypto";
import type { RuntimeResourcePool } from "@shared/models/runtime";
import { BOOT_ID } from "./db";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import { getCurrentPrincipal, runWithPrincipal } from "./principal-context";
import type { Principal } from "./principal";
import {
  acquireLegacyRuntimeCapacity,
  cancelLegacyRuntimeCapacityRequest,
  heartbeatRuntimeAttempt,
  releaseLegacyRuntimeCapacity,
  type LegacyRuntimeCapacityLease,
  type RuntimeCapacitySnapshot,
} from "./runtime/runtime-storage";

const log = createLogger("Admission");

export type AdmissionTier = "communication" | "realtime" | "request" | "background";
export type AdmissionState = "idle" | "cooling_down" | "active";

export interface AdmissionSlot {
  runId: string;
  tier: AdmissionTier;
  resourcePool: RuntimeResourcePool;
  sessionId?: string;
  activity?: string;
  lineageId?: string;
  yieldRequested: boolean;
  grantedAt: number;
  runtimeRunId: string;
  runtimeAttemptId: string;
}

interface InternalAdmissionSlot extends AdmissionSlot {
  principal: Principal & { actorType: "user"; userId: string; accountId: string };
  lease: LegacyRuntimeCapacityLease;
  heartbeatInFlight?: Promise<void>;
}

interface QueuedRequest {
  runId: string;
  admissionRequestId: string;
  tier: AdmissionTier;
  resourcePool: RuntimeResourcePool;
  sessionId?: string;
  activity?: string;
  lineageId?: string;
  principal: Principal & { actorType: "user"; userId: string; accountId: string };
  resolve: (slot: AdmissionSlot) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  queuedAt: number;
  deadlineAt: Date;
  cancelled: boolean;
}

const DEFAULT_IDLE_THRESHOLD_MS = 60 * 1000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MAX_BACKGROUND_SLOT_AGE_MS = 15 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const QUEUE_RETRY_INTERVAL_MS = 500;
const TIER_PRIORITY: Record<AdmissionTier, number> = {
  communication: 0,
  realtime: 1,
  request: 2,
  background: 3,
};

function requireUserPrincipal(): Principal & { actorType: "user"; userId: string; accountId: string } {
  const principal = getCurrentPrincipal();
  if (principal?.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Runtime admission requires an explicit owning user principal");
  }
  return principal as Principal & { actorType: "user"; userId: string; accountId: string };
}

function poolForTier(tier: AdmissionTier): RuntimeResourcePool {
  if (tier === "communication") return "realtime_agent";
  return tier === "background" ? "background_agent" : "interactive_agent";
}

function publicSlot(slot: InternalAdmissionSlot): AdmissionSlot {
  const { principal: _principal, lease: _lease, ...visible } = slot;
  return visible;
}

/**
 * Temporary compatibility façade. Process-local state owns only cancellation,
 * liveness, suspension, and diagnostics. A slot exists only after the kernel
 * has created a fenced DB-backed running attempt.
 */
export class RunAdmissionController {
  private readonly slots = new Map<string, InternalAdmissionSlot>();
  private readonly suspendedSlots = new Map<string, AdmissionSlot>();
  private readonly runContext = new AsyncLocalStorage<string>();
  private queue: QueuedRequest[] = [];
  private state: AdmissionState = "idle";
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private queueRetryTimer: ReturnType<typeof setInterval> | null = null;
  private slotAgeTimer: ReturnType<typeof setInterval> | null = null;
  private drainInFlight = false;
  private drainRequested = false;
  private shuttingDown = false;
  private idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS;
  private latestCapacitySnapshot: RuntimeCapacitySnapshot | null = null;

  constructor() {
    this.startTimers();
    log.info("runtime.legacy_facade.initialized", { workerId: BOOT_ID });
  }

  private startTimers(): void {
    this.heartbeatTimer = setInterval(() => void this.heartbeatSlots(), HEARTBEAT_INTERVAL_MS);
    this.queueRetryTimer = setInterval(() => void this.drainQueue(), QUEUE_RETRY_INTERVAL_MS);
    this.slotAgeTimer = setInterval(() => this.enforceMaxSlotAge(), 60_000);
  }

  getState(): AdmissionState {
    return this.state;
  }

  getSlots(): AdmissionSlot[] {
    return Array.from(this.slots.values(), publicSlot);
  }

  getSuspendedSlots(): AdmissionSlot[] {
    return Array.from(this.suspendedSlots.values());
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getQueuedRequestForSession(sessionId: string): { runId: string; tier: AdmissionTier; activity?: string } | undefined {
    const request = this.queue.find((queued) => queued.sessionId === sessionId);
    return request ? { runId: request.runId, tier: request.tier, activity: request.activity } : undefined;
  }

  getQueuedByTier(): Record<AdmissionTier, number> {
    const counts: Record<AdmissionTier, number> = { communication: 0, realtime: 0, request: 0, background: 0 };
    for (const request of this.queue) counts[request.tier]++;
    return counts;
  }

  getTierCounts(): Record<AdmissionTier, number> {
    const counts: Record<AdmissionTier, number> = { communication: 0, realtime: 0, request: 0, background: 0 };
    for (const slot of this.slots.values()) counts[slot.tier]++;
    return counts;
  }

  private setState(next: AdmissionState): void {
    if (this.state === next) return;
    const previousState = this.state;
    this.state = next;
    if (next === "idle") {
      eventBus.publish({ category: "system", event: "system.state.idle", payload: { previousState } });
    } else if (next === "active") {
      eventBus.publish({ category: "system", event: "system.state.active", payload: { previousState, tierCounts: this.getTierCounts() } });
    }
  }

  private updateState(): void {
    if (this.slots.size > 0) this.setState("active");
    else if (!this.cooldownTimer) this.setState("idle");
  }

  private async tryAcquire(
    request: Pick<QueuedRequest, "runId" | "admissionRequestId" | "tier" | "resourcePool" | "sessionId" | "activity" | "lineageId" | "principal">,
    deadlineAt: Date,
  ): Promise<AdmissionSlot | null> {
    const result = await runWithPrincipal(request.principal, () => acquireLegacyRuntimeCapacity(request.principal, {
      externalRunId: request.runId,
      admissionRequestId: request.admissionRequestId,
      resourcePool: request.resourcePool,
      sourceType: request.resourcePool === "realtime_agent" || request.resourcePool === "interactive_agent" || request.resourcePool === "background_agent"
        ? "agent-executor"
        : request.resourcePool === "short_worker" ? "legacy-worker" : "browser-manager",
      activity: request.activity,
      deadlineAt,
      workerId: `${BOOT_ID}:${request.runId}`,
    }));
    this.latestCapacitySnapshot = result.disposition === "acquired" ? result.lease.snapshot : result.snapshot;
    if (result.disposition === "saturated") return null;

    const internal: InternalAdmissionSlot = {
      runId: request.runId,
      tier: request.tier,
      resourcePool: request.resourcePool,
      sessionId: request.sessionId,
      activity: request.activity,
      lineageId: request.lineageId,
      yieldRequested: false,
      grantedAt: Date.now(),
      runtimeRunId: result.lease.run.id,
      runtimeAttemptId: result.lease.attempt.id,
      principal: request.principal,
      lease: result.lease,
    };
    this.slots.set(request.runId, internal);
    if (this.cooldownTimer && request.resourcePool === "interactive_agent") {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.setState("active");
    return publicSlot(internal);
  }

  async requestSlot(
    tier: AdmissionTier,
    runId: string,
    options?: { sessionId?: string; activity?: string; lineageId?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<AdmissionSlot> {
    return this.requestResourceSlot(poolForTier(tier), tier, runId, options);
  }

  async requestResourceSlot(
    resourcePool: RuntimeResourcePool,
    tier: AdmissionTier,
    runId: string,
    options?: { sessionId?: string; activity?: string; lineageId?: string; timeout?: number; signal?: AbortSignal },
  ): Promise<AdmissionSlot> {
    if (this.shuttingDown) throw new Error("shutdown");
    if (options?.signal?.aborted) throw new Error("admission_aborted");
    const principal = requireUserPrincipal();
    const request = {
      runId,
      admissionRequestId: crypto.randomUUID(),
      tier,
      resourcePool,
      principal,
      sessionId: options?.sessionId,
      activity: options?.activity,
      lineageId: options?.lineageId,
    };
    const timeout = options?.timeout ?? DEFAULT_ADMISSION_TIMEOUT_MS;
    const deadlineAt = new Date(Date.now() + Math.max(1, timeout));
    const acquired = await this.tryAcquire(request, deadlineAt);
    if (acquired) {
      if (!options?.signal?.aborted) return acquired;
      await this.releaseSlot(runId, {
        outcome: "cancelled",
        reasonCode: "legacy_capacity_admission_aborted_after_acquire",
      });
      throw new Error("admission_aborted");
    }
    if (options?.signal?.aborted) {
      await cancelLegacyRuntimeCapacityRequest(principal, request.admissionRequestId, "legacy_capacity_admission_aborted");
      throw new Error("admission_aborted");
    }

    if (resourcePool === "interactive_agent") this.yieldBackgroundRuns(options?.lineageId);
    const remainingMs = Math.max(0, deadlineAt.getTime() - Date.now());
    if (remainingMs === 0) {
      await cancelLegacyRuntimeCapacityRequest(principal, request.admissionRequestId, "legacy_capacity_admission_timeout");
      throw new Error("admission_timeout");
    }
    return this.enqueue(request, remainingMs, options?.signal);
  }

  private enqueue(
    request: Pick<QueuedRequest, "runId" | "admissionRequestId" | "tier" | "resourcePool" | "sessionId" | "activity" | "lineageId" | "principal">,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<AdmissionSlot> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        void cancelLegacyRuntimeCapacityRequest(
          request.principal,
          request.admissionRequestId,
          "legacy_capacity_admission_aborted",
        ).catch((error) => {
          log.warn("runtime.legacy_facade.cancel_failed", {
            externalRunId: request.runId,
            resourcePool: request.resourcePool,
            reasonCode: "legacy_capacity_admission_aborted",
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return reject(new Error("admission_aborted"));
      }
      const queuedAt = Date.now();
      const onAbort = () => {
        const index = this.queue.findIndex((queued) => queued.admissionRequestId === request.admissionRequestId);
        if (index < 0) return;
        const [cancelled] = this.queue.splice(index, 1);
        if (cancelled.timer) clearTimeout(cancelled.timer);
        this.cancelDurableRequest(cancelled, "legacy_capacity_admission_aborted");
        reject(new Error("admission_aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = timeout > 0 ? setTimeout(() => {
        const index = this.queue.findIndex((queued) => queued.admissionRequestId === request.admissionRequestId);
        if (index < 0) return;
        const [expired] = this.queue.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        this.cancelDurableRequest(expired, "legacy_capacity_admission_timeout");
        log.warn("runtime.legacy_facade.timeout", {
          externalRunId: request.runId,
          resourcePool: request.resourcePool,
          queueAgeMs: Date.now() - expired.queuedAt,
          globalActive: this.latestCapacitySnapshot?.globalActive,
          poolActive: this.latestCapacitySnapshot?.poolActive,
          protectedInteractiveReserve: this.latestCapacitySnapshot?.protectedInteractiveReserve,
        });
        reject(new Error("admission_timeout"));
      }, timeout) : null;
      this.queue.push({
        ...request,
        queuedAt,
        deadlineAt: new Date(queuedAt + Math.max(1, timeout)),
        cancelled: false,
        timer,
        resolve: (slot) => { signal?.removeEventListener("abort", onAbort); resolve(slot); },
        reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
      });
      this.queue.sort((left, right) => TIER_PRIORITY[left.tier] - TIER_PRIORITY[right.tier] || left.queuedAt - right.queuedAt);
      log.debug("runtime.legacy_facade.queued", {
        externalRunId: request.runId,
        resourcePool: request.resourcePool,
        tier: request.tier,
        queueDepth: this.queue.length,
      });
    });
  }

  private cancelDurableRequest(request: QueuedRequest, reasonCode: string): void {
    request.cancelled = true;
    void cancelLegacyRuntimeCapacityRequest(request.principal, request.admissionRequestId, reasonCode).catch((error) => {
      log.warn("runtime.legacy_facade.cancel_failed", {
        externalRunId: request.runId,
        resourcePool: request.resourcePool,
        reasonCode,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.shuttingDown || this.queue.length === 0) return;
    if (this.drainInFlight) {
      this.drainRequested = true;
      return;
    }
    this.drainInFlight = true;
    try {
      for (let index = 0; index < this.queue.length;) {
        const request = this.queue[index];
        try {
          const slot = await this.tryAcquire(request, request.deadlineAt);
          if (!slot) {
            index++;
            continue;
          }
          const queuedIndex = this.queue.indexOf(request);
          if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
          if (request.timer) clearTimeout(request.timer);
          if (request.cancelled || queuedIndex < 0) {
            await runWithPrincipal(slot.principal, () => releaseLegacyRuntimeCapacity(slot.principal, slot.lease.fence, {
              outcome: "cancelled",
              reasonCode: "legacy_capacity_admission_cancelled_after_acquire",
            }));
            continue;
          }
          log.debug("runtime.legacy_facade.admitted", {
            externalRunId: request.runId,
            runtimeRunId: slot.runtimeRunId,
            resourcePool: request.resourcePool,
            queueAgeMs: Date.now() - request.queuedAt,
          });
          request.resolve(slot);
        } catch (error) {
          const queuedIndex = this.queue.indexOf(request);
          if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
          if (request.timer) clearTimeout(request.timer);
          if (!request.cancelled) {
            this.cancelDurableRequest(request, "legacy_capacity_admission_failed");
            request.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
    } finally {
      this.drainInFlight = false;
      if (this.drainRequested) {
        this.drainRequested = false;
        if (!this.shuttingDown && this.queue.length > 0) void this.drainQueue();
      }
    }
  }

  async releaseSlot(
    runId: string,
    input: { outcome?: "succeeded" | "failed" | "cancelled"; reasonCode?: string } = {},
  ): Promise<void> {
    const slot = this.slots.get(runId);
    if (!slot) return;
    this.slots.delete(runId);
    try {
      await slot.heartbeatInFlight;
      await runWithPrincipal(slot.principal, () => releaseLegacyRuntimeCapacity(slot.principal, slot.lease.fence, input));
    } catch (error) {
      log.error("runtime.legacy_facade.release_failed", {
        externalRunId: runId,
        runtimeRunId: slot.runtimeRunId,
        runtimeAttemptId: slot.runtimeAttemptId,
        resourcePool: slot.resourcePool,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    } finally {
      if (slot.tier === "communication" && this.getTierCounts().communication === 0) this.startCooldown();
      else this.updateState();
      void this.drainQueue();
    }
  }

  isYieldRequested(runId: string): boolean {
    return this.slots.get(runId)?.yieldRequested ?? false;
  }

  withRunContext<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.runContext.run(runId, fn);
  }

  async withResourcePool<T>(
    resourcePool: RuntimeResourcePool,
    runId: string,
    fn: () => Promise<T>,
    options?: { activity?: string; sessionId?: string; timeout?: number; tier?: AdmissionTier },
  ): Promise<T> {
    const parentRunId = this.runContext.getStore();
    const execute = async () => {
      await this.requestResourceSlot(
        resourcePool,
        options?.tier ?? (resourcePool === "background_agent" ? "background" : "request"),
        runId,
        options,
      );
      try {
        return await this.withRunContext(runId, fn);
      } catch (error) {
        if (this.slots.has(runId)) await this.releaseSlot(runId, { outcome: "failed", reasonCode: "legacy_capacity_work_failed" });
        throw error;
      } finally {
        if (this.slots.has(runId)) await this.releaseSlot(runId);
      }
    };
    return parentRunId && this.slots.has(parentRunId)
      ? this.withSuspendedSlot(parentRunId, execute)
      : execute();
  }

  async withSuspendedSlot<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const slot = this.slots.get(runId);
    if (!slot) return fn();
    const suspended = publicSlot(slot);
    this.suspendedSlots.set(runId, suspended);
    await this.releaseSlot(runId, { outcome: "succeeded", reasonCode: "legacy_capacity_suspended" });
    log.debug("runtime.legacy_facade.suspended", { externalRunId: runId, resourcePool: slot.resourcePool });
    try {
      return await fn();
    } finally {
      try {
        await runWithPrincipal(slot.principal, () => this.requestResourceSlot(slot.resourcePool, slot.tier, runId, {
          sessionId: slot.sessionId,
          activity: slot.activity,
          lineageId: slot.lineageId,
        }));
        log.debug("runtime.legacy_facade.resumed", { externalRunId: runId, resourcePool: slot.resourcePool });
      } finally {
        this.suspendedSlots.delete(runId);
      }
    }
  }

  getAdmissionSnapshot() {
    const snapshot = this.latestCapacitySnapshot;
    return {
      state: this.state,
      tierCounts: this.getTierCounts(),
      queueDepth: this.getQueueDepth(),
      queuedByTier: this.getQueuedByTier(),
      activeCount: snapshot?.globalActive ?? 0,
      foregroundCount: this.getTierCounts().communication + this.getTierCounts().realtime + this.getTierCounts().request,
      concurrencyBudget: snapshot?.globalLimit ?? null,
      requestBudget: snapshot?.poolLimit ?? null,
      backgroundBudget: snapshot?.poolLimit ?? null,
      idleThresholdMs: this.idleThresholdMs,
      cooldownActive: this.cooldownTimer !== null,
      capacitySource: "runtime_attempts",
      capacitySnapshot: snapshot,
    };
  }

  /** Whether a background run can be admitted right now (best-effort pre-flight check). */
  canAdmitBackground(_options?: { activity?: string }): boolean {
    if (this.cooldownTimer !== null) return false;
    const snapshot = this.latestCapacitySnapshot;
    if (!snapshot) return true;
    return snapshot.globalActive < snapshot.globalLimit;
  }

  private async heartbeatSlots(): Promise<void> {
    const slots = [...this.slots.values()];
    for (const slot of slots) {
      if (this.slots.get(slot.runId) !== slot || slot.heartbeatInFlight) continue;
      let heartbeat: Promise<void>;
      heartbeat = runWithPrincipal(slot.principal, () => heartbeatRuntimeAttempt(slot.lease.fence))
        .then(() => undefined)
        .catch((error) => {
          slot.yieldRequested = true;
          log.error("runtime.legacy_facade.heartbeat_failed", {
            externalRunId: slot.runId,
            runtimeRunId: slot.runtimeRunId,
            runtimeAttemptId: slot.runtimeAttemptId,
            resourcePool: slot.resourcePool,
            errorType: error instanceof Error ? error.name : typeof error,
          });
        })
        .finally(() => {
          if (slot.heartbeatInFlight === heartbeat) slot.heartbeatInFlight = undefined;
        });
      slot.heartbeatInFlight = heartbeat;
      await heartbeat;
    }
  }

  private yieldBackgroundRuns(callerLineageId?: string): void {
    for (const slot of this.slots.values()) {
      if (slot.resourcePool !== "background_agent" || slot.yieldRequested) continue;
      if (callerLineageId && slot.lineageId === callerLineageId) continue;
      slot.yieldRequested = true;
      break;
    }
  }

  private startCooldown(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.setState("cooling_down");
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.updateState();
      void this.drainQueue();
    }, this.idleThresholdMs);
  }

  private enforceMaxSlotAge(): void {
    const now = Date.now();
    for (const slot of this.slots.values()) {
      if (slot.resourcePool === "background_agent" && now - slot.grantedAt > MAX_BACKGROUND_SLOT_AGE_MS) {
        slot.yieldRequested = true;
        log.warn("runtime.legacy_facade.max_age", {
          externalRunId: slot.runId,
          runtimeRunId: slot.runtimeRunId,
          resourcePool: slot.resourcePool,
          maxAgeMs: MAX_BACKGROUND_SLOT_AGE_MS,
        });
      }
    }
  }

  configure(options: { idleThresholdMs?: number }): void {
    if (options.idleThresholdMs !== undefined) this.idleThresholdMs = Math.max(0, options.idleThresholdMs);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.drainRequested = false;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.queueRetryTimer) clearInterval(this.queueRetryTimer);
    if (this.slotAgeTimer) clearInterval(this.slotAgeTimer);
    this.cooldownTimer = this.heartbeatTimer = this.queueRetryTimer = this.slotAgeTimer = null;
    for (const request of this.queue) {
      if (request.timer) clearTimeout(request.timer);
      this.cancelDurableRequest(request, "legacy_capacity_admission_shutdown");
      request.reject(new Error("shutdown"));
    }
    this.queue = [];
    while (this.drainInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Promise.allSettled([...this.slots.keys()].map((runId) => this.releaseSlot(runId, {
      outcome: "cancelled",
      reasonCode: "legacy_capacity_shutdown",
    })));
    this.suspendedSlots.clear();
    this.updateState();
  }

  async reset(): Promise<void> {
    await this.shutdown();
    this.shuttingDown = false;
    this.state = "idle";
    this.startTimers();
  }
}

export const admissionController = new RunAdmissionController();
