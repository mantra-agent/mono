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
const TRANSIENT_EVENTS = new Set(["chat.stream"]);

export interface EventBufferFilters {
  category?: string;
  event?: string;
  runId?: string;
  sessionKey?: string;
  startTimestamp?: number;
  endTimestamp?: number;
  payloadQuery?: Record<string, unknown>;
}

function payloadContains(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((value) => actual.some((candidate) => payloadContains(candidate, value)));
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  return Object.entries(expected as Record<string, unknown>).every(
    ([key, value]) => payloadContains((actual as Record<string, unknown>)[key], value),
  );
}

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
  public readonly bootId = process.env.WATCHDOG_BOOT_ID || `boot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

    // Stream deltas are delivered synchronously to live subscribers and then
    // discarded. All other events live only in this bounded process-local
    // buffer. EventBus telemetry never competes with canonical state for DB
    // connections.
    if (!TRANSIENT_EVENTS.has(busEvent.event)) {
      this.buffer.push(busEvent);
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        const trimmed = this.buffer.length - MAX_BUFFER_SIZE;
        this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
        this.trimDroppedSinceLastLog += trimmed;
        const now = Date.now();
        if (trimmed > 10 || now - this.lastTrimLogTime >= this.TRIM_LOG_INTERVAL_MS) {
          log.debug(`buffer trimmed totalDroppedSinceLastLog=${this.trimDroppedSinceLastLog} currentDrop=${trimmed} size=${this.buffer.length}`);
          this.trimDroppedSinceLastLog = 0;
          this.lastTrimLogTime = now;
        }
      }
    }

    this.emit("event", busEvent);
    return busEvent;
  }

  getPublishCounts(): Record<string, number> {
    return { ...this.publishCounts };
  }

  private filterBufferedEvents(filter?: EventBufferFilters, principal?: Principal): BusEvent[] {
    let events = principal ? this.buffer.filter((event) => isEventVisibleToPrincipal(event, principal)) : this.buffer;
    if (!filter) return events;
    if (filter.category) events = events.filter((event) => event.category === filter.category);
    if (filter.runId) events = events.filter((event) => event.runId === filter.runId);
    if (filter.event) events = events.filter((event) => event.event.includes(filter.event!));
    if (filter.sessionKey) events = events.filter((event) => event.sessionKey === filter.sessionKey);
    if (filter.startTimestamp) events = events.filter((event) => event.timestamp >= filter.startTimestamp!);
    if (filter.endTimestamp) events = events.filter((event) => event.timestamp <= filter.endTimestamp!);
    if (filter.payloadQuery) events = events.filter((event) => payloadContains(event.payload, filter.payloadQuery));
    return events;
  }

  getRecentEvents(limit = 100, filter?: EventBufferFilters, principal?: Principal): BusEvent[] {
    return this.filterBufferedEvents(filter, principal).slice(-Math.max(1, limit));
  }

  queryRecentEvents(input: {
    limit?: number;
    offset?: number;
    filter?: EventBufferFilters;
    principal?: Principal;
  }): { events: BusEvent[]; total: number } {
    const filtered = this.filterBufferedEvents(input.filter, input.principal);
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const newestFirst = [...filtered].reverse();
    return { events: newestFirst.slice(offset, offset + limit), total: filtered.length };
  }

  replayRecentEvents(input: {
    afterEventId?: string;
    category?: string;
    payloadQuery?: Record<string, unknown>;
    limit?: number;
    principal: Principal;
  }): { events: BusEvent[]; cursorFound: boolean } {
    const filtered = this.filterBufferedEvents({
      category: input.category,
      payloadQuery: input.payloadQuery,
    }, input.principal);
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 200);
    if (!input.afterEventId) return { events: filtered.slice(-limit), cursorFound: true };
    const cursorIndex = filtered.findIndex((event) => event.id === input.afterEventId);
    if (cursorIndex < 0) return { events: filtered.slice(-limit), cursorFound: false };
    return { events: filtered.slice(cursorIndex + 1, cursorIndex + 1 + limit), cursorFound: true };
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
