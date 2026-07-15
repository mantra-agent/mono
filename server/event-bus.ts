// Use createLogger for logging ONLY
import { EventEmitter } from "events";
import type { EventCategory } from "@shared/event-catalog";
import { createLogger } from "./log";
import { getCurrentPrincipal } from "./principal-context";
import type { Principal } from "./principal";

const log = createLogger("event-bus");

export type EventAudience =
  | { scope: "user"; ownerUserId: string; accountId: string }
  | { scope: "system" }
  | { scope: "global" };

export interface BusEvent {
  id: string;
  timestamp: number;
  category: EventCategory;
  event: string;
  payload: Record<string, unknown>;
  audience: EventAudience;
  runId?: string;
  sessionKey?: string;
  bootId?: string;
}

export function audienceForPrincipal(principal: Principal | null): EventAudience {
  if (principal?.actorType === "user" && principal.userId && principal.accountId) {
    return { scope: "user", ownerUserId: principal.userId, accountId: principal.accountId };
  }
  return { scope: "system" };
}

export function isEventVisibleToPrincipal(event: BusEvent, principal: Principal): boolean {
  if (event.audience.scope === "global") return principal.actorType === "user";
  if (event.audience.scope === "system") {
    return principal.actorType === "system" || principal.permissions.includes("system:read");
  }
  return principal.actorType === "user" && principal.accountId === event.audience.accountId;
}

const MAX_BUFFER_SIZE = 2000;

const TERMINAL_RUN_EVENTS = new Set([
  "agent.run.terminal_decision",
  "agent.run.complete",
  "agent.run.aborted",
  "agent.run.error",
  "runtime.active_run.cleared",
]);


class EventBus extends EventEmitter {
  private buffer: BusEvent[] = [];
  private seqCounter = 0;
  private publishCounts: Record<string, number> = {};
  private trimDroppedSinceLastLog = 0;
  private lastTrimLogTime = 0;
  private readonly TRIM_LOG_INTERVAL_MS = 60_000;
  public readonly bootId = `boot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  public readonly bootTimestamp = Date.now();

  on(event: string | symbol, listener: (...args: any[]) => void): this {
    log.log(`subscriber registered event=${String(event)} totalListeners=${this.listenerCount(event) + 1}`);
    return super.on(event, listener);
  }

  off(event: string | symbol, listener: (...args: any[]) => void): this {
    log.log(`subscriber unregistered event=${String(event)} remainingListeners=${Math.max(0, this.listenerCount(event) - 1)}`);
    return super.off(event, listener);
  }

  removeListener(event: string | symbol, listener: (...args: any[]) => void): this {
    log.log(`subscriber removed event=${String(event)} remainingListeners=${Math.max(0, this.listenerCount(event) - 1)}`);
    return super.removeListener(event, listener);
  }

  publish(event: Omit<BusEvent, "id" | "timestamp" | "bootId" | "audience"> & { audience?: EventAudience }): BusEvent {
    const busEvent: BusEvent = {
      ...event,
      audience: event.audience ?? audienceForPrincipal(getCurrentPrincipal()),
      id: `evt-${++this.seqCounter}-${Date.now()}`,
      timestamp: Date.now(),
      bootId: this.bootId,
    };

    this.publishCounts[event.category] = (this.publishCounts[event.category] || 0) + 1;

    this.buffer.push(busEvent);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      const trimmed = this.buffer.length - MAX_BUFFER_SIZE;
      this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
      this.trimDroppedSinceLastLog += trimmed;
      const now = Date.now();
      if (trimmed > 10 || now - this.lastTrimLogTime >= this.TRIM_LOG_INTERVAL_MS) {
        log.log(`buffer trimmed totalDroppedSinceLastLog=${this.trimDroppedSinceLastLog} currentDrop=${trimmed} size=${this.buffer.length}`);
        this.trimDroppedSinceLastLog = 0;
        this.lastTrimLogTime = now;
      }
    }

    this.emit("event", busEvent);
    this.persistAsync(busEvent);
    return busEvent;
  }

  private _persistFn: ((e: BusEvent) => Promise<number | undefined>) | null = null;
  private _persistFnLoading = false;
  private _persistBacklog: BusEvent[] = [];
  private readonly _MAX_BACKLOG = 2000;
  private _backlogOverflow = 0;

  private persistAsync(busEvent: BusEvent): void {
    if (this._persistFn) {
      this._persistFn(busEvent).catch((error) => log.error("event persistence rejected", { event: busEvent.event, eventId: busEvent.id, error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (this._persistBacklog.length < this._MAX_BACKLOG) {
      this._persistBacklog.push(busEvent);
    } else {
      this._backlogOverflow++;
      if (this._backlogOverflow === 1 || this._backlogOverflow % 100 === 0) {
        log.warn(`persist backlog overflow: ${this._backlogOverflow} events dropped while waiting for module load`);
      }
    }
    if (!this._persistFnLoading) {
      this._persistFnLoading = true;
      import("./event-persistence").then(({ persistEvent }) => {
        this._persistFn = persistEvent;
        const backlog = this._persistBacklog;
        this._persistBacklog = [];
        for (const evt of backlog) {
          this._persistFn(evt).catch((error) => log.error("event backlog persistence rejected", { event: evt.event, eventId: evt.id, error: error instanceof Error ? error.message : String(error) }));
        }
      }).catch((error) => {
        this._persistFnLoading = false;
        log.error("event persistence module failed to load", { error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  getPublishCounts(): Record<string, number> {
    return { ...this.publishCounts };
  }

  getRecentEvents(limit = 100, filter?: { category?: string; runId?: string; event?: string }, principal?: Principal): BusEvent[] {
    let events = principal ? this.buffer.filter((event) => isEventVisibleToPrincipal(event, principal)) : this.buffer;
    if (filter) {
      if (filter.category) events = events.filter(e => e.category === filter.category);
      if (filter.runId) events = events.filter(e => e.runId === filter.runId);
      if (filter.event) events = events.filter(e => e.event.includes(filter.event!));
    }
    return events.slice(-limit);
  }

  getRunEvents(runId: string, principal?: Principal): BusEvent[] {
    return this.buffer.filter(e => e.runId === runId && (!principal || isEventVisibleToPrincipal(e, principal)));
  }

  getActiveRuns(principal?: Principal): { runId: string; startedAt: number; events: number; lastEvent: string }[] {
    const runs = new Map<string, { startedAt: number; events: number; lastEvent: string; lastTs: number; terminal: boolean }>();
    for (const e of this.buffer) {
      if (!e.runId || (principal && !isEventVisibleToPrincipal(e, principal))) continue;
      const existing = runs.get(e.runId);
      if (!existing) {
        runs.set(e.runId, {
          startedAt: e.timestamp,
          events: 1,
          lastEvent: e.event,
          lastTs: e.timestamp,
          terminal: TERMINAL_RUN_EVENTS.has(e.event),
        });
      } else {
        existing.events++;
        if (e.timestamp > existing.lastTs) {
          existing.lastEvent = e.event;
          existing.lastTs = e.timestamp;
          existing.terminal = existing.terminal || TERMINAL_RUN_EVENTS.has(e.event);
        }
      }
    }
    return Array.from(runs.entries())
      .filter(([, data]) => !data.terminal)
      .map(([runId, data]) => ({ runId, startedAt: data.startedAt, events: data.events, lastEvent: data.lastEvent }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  clearActiveRun(runId: string, reason = "manual_cleanup", principal?: Principal): { cleared: boolean; runId: string; reason: string } {
    const hasRun = this.buffer.some(e => e.runId === runId && (!principal || isEventVisibleToPrincipal(e, principal)));
    if (!hasRun) return { cleared: false, runId, reason };
    this.publish({
      category: "system",
      event: "runtime.active_run.cleared",
      payload: { runId, reason, source: "system_tool" },
      runId,
    });
    return { cleared: true, runId, reason };
  }

  clear() {
    log.log(`clear bufferSize=${this.buffer.length}`);
    this.buffer = [];
  }

  getBufferSize(): number {
    return this.buffer.length;
  }
}

export const eventBus = new EventBus();
