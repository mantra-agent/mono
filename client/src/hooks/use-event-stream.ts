import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";

export interface BusEvent {
  id: string;
  timestamp: number;
  category: "agent" | "system" | "session" | "channel" | "chat" | "gateway" | "tool" | "responsibility" | "memory";
  event: string;
  payload: unknown;
  runId?: string;
  sessionKey?: string;
  bootId?: string;
}

interface EventStreamSnapshot {
  events: BusEvent[];
  connected: boolean;
}

const EVENT_STREAM_CAPACITY = 1_000;
const EVENT_STREAM_OWNER = "eventStream";
const EVENT_STREAM_HANDLER = "eventStream";
const EMPTY_SNAPSHOT: EventStreamSnapshot = { events: [], connected: false };

let eventStreamSnapshot = EMPTY_SNAPSHOT;
const eventStreamListeners = new Set<() => void>();

function isBusEvent(value: unknown): value is BusEvent {
  const event = value as Partial<BusEvent> | null;
  return Boolean(
    event
    && typeof event.id === "string"
    && typeof event.timestamp === "number"
    && typeof event.category === "string"
    && typeof event.event === "string",
  );
}

function emitEventStreamSnapshot(next: EventStreamSnapshot): void {
  if (next === eventStreamSnapshot) return;
  eventStreamSnapshot = next;
  eventStreamListeners.forEach((listener) => listener());
}

function setEventStreamConnected(connected: boolean): void {
  if (eventStreamSnapshot.connected === connected) return;
  emitEventStreamSnapshot({ ...eventStreamSnapshot, connected });
}

function compareEvents(a: BusEvent, b: BusEvent): number {
  return a.timestamp - b.timestamp || a.id.localeCompare(b.id);
}

function mergeEvents(incoming: readonly BusEvent[]): void {
  if (incoming.length === 0) return;

  const current = eventStreamSnapshot.events;
  if (incoming.length === 1) {
    const event = incoming[0];
    const last = current.at(-1);
    const existingIndex = current.findIndex((candidate) => candidate.id === event.id);

    if (existingIndex === -1 && (!last || compareEvents(last, event) <= 0)) {
      const events = current.length < EVENT_STREAM_CAPACITY
        ? [...current, event]
        : [...current.slice(1), event];
      emitEventStreamSnapshot({ ...eventStreamSnapshot, events });
      return;
    }

    if (existingIndex >= 0 && current[existingIndex] === event) return;
  }

  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  const events = Array.from(byId.values())
    .sort(compareEvents)
    .slice(-EVENT_STREAM_CAPACITY);
  emitEventStreamSnapshot({ ...eventStreamSnapshot, events });
}

function subscribeEventStream(listener: () => void): () => void {
  eventStreamListeners.add(listener);
  return () => eventStreamListeners.delete(listener);
}

function getEventStreamSnapshot(): EventStreamSnapshot {
  return eventStreamSnapshot;
}

function resetEventStream(): void {
  emitEventStreamSnapshot(EMPTY_SNAPSHOT);
}

export function useEventStreamTransport(): void {
  useEffect(() => {
    const sharedWS = acquireSharedWS(EVENT_STREAM_OWNER);

    const resume = () => {
      setEventStreamConnected(true);
      const afterEventId = eventStreamSnapshot.events.at(-1)?.id;
      sharedWS.send({
        type: "events.resume",
        ...(afterEventId ? { afterEventId } : {}),
      });
    };

    sharedWS.addMessageHandler(EVENT_STREAM_HANDLER, (message) => {
      const msg = message as { type?: unknown; event?: unknown; events?: unknown };
      if (msg.type === "event" && isBusEvent(msg.event)) {
        mergeEvents([msg.event]);
        return;
      }
      if (msg.type === "history" && Array.isArray(msg.events)) {
        mergeEvents(msg.events.filter(isBusEvent));
      }
    });
    sharedWS.addOpenHandler(EVENT_STREAM_HANDLER, resume);
    sharedWS.addCloseHandler(EVENT_STREAM_HANDLER, () => setEventStreamConnected(false));
    sharedWS.addErrorHandler(EVENT_STREAM_HANDLER, () => setEventStreamConnected(false));

    if (sharedWS.getReadyState() === WebSocket.OPEN) resume();
    else sharedWS.connect();

    return () => {
      sharedWS.removeMessageHandler(EVENT_STREAM_HANDLER);
      sharedWS.removeOpenHandler(EVENT_STREAM_HANDLER);
      sharedWS.removeCloseHandler(EVENT_STREAM_HANDLER);
      sharedWS.removeErrorHandler(EVENT_STREAM_HANDLER);
      releaseSharedWS(EVENT_STREAM_OWNER);
      resetEventStream();
    };
  }, []);
}

export function useEventStream(maxEvents = 500) {
  const snapshot = useSyncExternalStore(
    subscribeEventStream,
    getEventStreamSnapshot,
    getEventStreamSnapshot,
  );
  const clearedEventIdsRef = useRef<Set<string>>(new Set());
  const [clearRevision, setClearRevision] = useState(0);
  const boundedMaxEvents = Math.max(1, Math.min(maxEvents, EVENT_STREAM_CAPACITY));

  const events = useMemo(
    () => snapshot.events
      .filter((event) => !clearedEventIdsRef.current.has(event.id))
      .slice(-boundedMaxEvents),
    [boundedMaxEvents, clearRevision, snapshot.events],
  );

  const clearEvents = useCallback(() => {
    clearedEventIdsRef.current = new Set(snapshot.events.map((event) => event.id));
    setClearRevision((revision) => revision + 1);
  }, [snapshot.events]);

  return { events, connected: snapshot.connected, clearEvents };
}
