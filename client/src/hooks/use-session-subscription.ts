/**
 * Session streaming subscriptions — server-authoritative session streaming cache.
 *
 * The server owns StreamingContent for each live session. The client may
 * subscribe to multiple active sessions on one shared WS so background runs stay
 * warm while the user focuses another session.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { StreamingContent } from "@shared/streaming-types";
import { initialStreamingContent } from "@shared/streaming-types";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { createLogger } from "@/lib/logger";

const log = createLogger("SessionSub");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionStatus = "idle" | "streaming" | "saved" | "error";
export type VisibleAssistantActivity = "none" | "thinking" | "streaming" | "tool";

export interface SessionStreamState {
  streamingContent: StreamingContent | null;
  status: SessionStatus;
  /** Whether the underlying WebSocket connection is open. */
  wsConnected: boolean;
  /** Client receive time for the latest server snapshot/delta. Used to reject stale stream state during optimistic send handoff. */
  updatedAt?: number;
  /** Server-owned runtime projection. `status` is durable/live run state; this discriminates UI activity. */
  runActive: boolean;
  canStop: boolean;
  visibleAssistantActivity: VisibleAssistantActivity;
  eventSeq?: number;
}

export type SessionStreamMap = Record<string, SessionStreamState>;

/** WS envelope for session messages. */
interface SessionMessage {
  type: string;
  sessionId: string;
  content?: StreamingContent;
  streamingContent?: StreamingContent;
  status?: string;
  eventSeq?: number;
  eventType?: string;
  subscriberCount?: number;
  runActive?: boolean;
  canStop?: boolean;
  visibleAssistantActivity?: VisibleAssistantActivity;
}

export interface SessionSubscriptionOptions {
  owner?: string;
  activeSession?: string | null;
}

const idleStreamState: SessionStreamState = {
  streamingContent: null,
  status: "idle",
  wsConnected: false,
  runActive: false,
  canStop: false,
  visibleAssistantActivity: "none",
};

// ---------------------------------------------------------------------------
// WS message parsing
// ---------------------------------------------------------------------------

function isSessionMessage(msg: unknown): msg is SessionMessage {
  if (!msg || typeof msg !== "object") return false;
  const obj = msg as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    (obj.type === "session.snapshot" || obj.type === "session.delta") &&
    typeof obj.sessionId === "string"
  );
}

function normalizeSessionIds(sessionIds: readonly (string | null | undefined)[]): string[] {
  return Array.from(new Set(sessionIds.filter((id): id is string => Boolean(id)))).sort();
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

let instanceCounter = 0;

function getStreamTraceTabId(): string {
  const key = "xyzStreamTraceTabId";
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const next = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(key, next);
    return next;
  } catch {
    return "tab-unavailable";
  }
}

export function useSessionSubscriptions(
  sessionIds: readonly (string | null | undefined)[],
  options: SessionSubscriptionOptions = {},
): {
  streams: SessionStreamMap;
  wsConnected: boolean;
} {
  const handlerId = useMemo(() => `sessionSub-${++instanceCounter}`, []);
  const owner = options.owner ?? "unknown";
  const activeSession = options.activeSession ?? null;
  const activeSessionRef = useRef<string | null>(activeSession);
  activeSessionRef.current = activeSession;
  const tabId = useMemo(getStreamTraceTabId, []);
  const initialSessionIdsRef = useRef<string[]>(normalizeSessionIds(sessionIds));
  const sharedWSRef = useRef<ReturnType<typeof acquireSharedWS> | null>(null);
  const subscribedIdsRef = useRef<Set<string>>(new Set());
  const requestedIdsRef = useRef<Set<string>>(new Set());
  const wsConnectedRef = useRef(false);
  const [streams, setStreams] = useState<SessionStreamMap>({});
  const [wsConnected, setWsConnected] = useState(false);

  const normalizedKey = useMemo(() => normalizeSessionIds(sessionIds).join("\u0000"), [sessionIds]);

  const setStreamConnected = useCallback((connected: boolean) => {
    wsConnectedRef.current = connected;
    setWsConnected(connected);
    setStreams((prev) => {
      let changed = false;
      const next: SessionStreamMap = {};
      for (const [sessionId, state] of Object.entries(prev)) {
        if (state.wsConnected !== connected) changed = true;
        next[sessionId] = { ...state, wsConnected: connected };
      }
      return changed ? next : prev;
    });
  }, []);

  const sendSubscribe = useCallback((id: string) => {
    const ws = sharedWSRef.current;
    if (!ws || ws.getReadyState() !== WebSocket.OPEN) return;
    if (requestedIdsRef.current.has(id)) return;
    requestedIdsRef.current.add(id);
    const currentActiveSession = activeSessionRef.current;
    log.debug("STREAM:SUBSCRIBE", { handlerId, owner, tabId, activeSession: currentActiveSession, sessionId: id });
    ws.send({ type: "session.subscribe", sessionId: id, handlerId, owner, tabId, activeSession: currentActiveSession });
  }, [handlerId, owner, tabId]);

  const sendUnsubscribe = useCallback((id: string) => {
    const ws = sharedWSRef.current;
    requestedIdsRef.current.delete(id);
    if (!ws || ws.getReadyState() !== WebSocket.OPEN) return;
    const currentActiveSession = activeSessionRef.current;
    log.debug("STREAM:UNSUBSCRIBE", { handlerId, owner, tabId, activeSession: currentActiveSession, sessionId: id });
    ws.send({ type: "session.unsubscribe", sessionId: id, handlerId, owner, tabId, activeSession: currentActiveSession });
  }, [handlerId, owner, tabId]);

  const upsertStream = useCallback((sessionId: string, patch: Partial<SessionStreamState>) => {
    setStreams((prev) => {
      const connected = wsConnectedRef.current;
      const current = prev[sessionId] ?? { ...idleStreamState, wsConnected: connected };
      const incomingSeq = patch.eventSeq;
      const currentSeq = current.eventSeq;

      // Snapshots and deltas share one monotonically increasing server sequence.
      // A delayed streaming payload must never resurrect a run after its terminal
      // delta has already cleared the canonical projection.
      if (
        typeof incomingSeq === "number" &&
        typeof currentSeq === "number" &&
        incomingSeq < currentSeq
      ) {
        log.debug("STREAM:STALE_EVENT_REJECTED", {
          sessionId,
          incomingSeq,
          currentSeq,
          incomingStatus: patch.status,
          currentStatus: current.status,
        });
        return prev;
      }

      const next = {
        ...current,
        ...patch,
        wsConnected: connected,
      };
      if (
        next.status === current.status &&
        next.streamingContent === current.streamingContent &&
        next.runActive === current.runActive &&
        next.canStop === current.canStop &&
        next.visibleAssistantActivity === current.visibleAssistantActivity &&
        next.eventSeq === current.eventSeq &&
        next.wsConnected === current.wsConnected
      ) {
        return prev;
      }
      return { ...prev, [sessionId]: next };
    });
  }, []);

  const handleMessage = useCallback((msg: unknown) => {
    if (!isSessionMessage(msg)) return;
    if (!subscribedIdsRef.current.has(msg.sessionId)) return;

    if (msg.type === "session.snapshot") {
      const status = (msg.status as SessionStatus | undefined) || "streaming";
      const serverStreaming = status === "streaming";
      const content = serverStreaming
        ? (msg.streamingContent ?? msg.content ?? initialStreamingContent)
        : initialStreamingContent;
      log.verbose(() => `SNAPSHOT:RECEIVE session=${msg.sessionId} status=${status} segments=${content.segments.length}`);
      // The server snapshot is authoritative. A non-streaming snapshot clears
      // any stale local live content left behind by reconnect/resume races.
      upsertStream(msg.sessionId, {
        streamingContent: content,
        status,
        updatedAt: Date.now(),
        runActive: msg.runActive ?? serverStreaming,
        canStop: msg.canStop ?? serverStreaming,
        visibleAssistantActivity: msg.visibleAssistantActivity ?? (serverStreaming ? "thinking" : "none"),
        eventSeq: msg.eventSeq,
      });
      return;
    }

    if (msg.type === "session.delta") {
      const status = msg.status as SessionStatus | undefined;
      const serverStreaming = status === undefined || status === "streaming";
      const content = serverStreaming ? msg.streamingContent : initialStreamingContent;
      log.verbose(() => `DELTA:RECEIVE session=${msg.sessionId} status=${status ?? "streaming"} segments=${content?.segments.length ?? 0}`);
      const patch: Partial<SessionStreamState> = {};
      if (content) patch.streamingContent = content;
      if (status) patch.status = status;
      patch.updatedAt = Date.now();
      patch.runActive = msg.runActive ?? serverStreaming;
      patch.canStop = msg.canStop ?? serverStreaming;
      patch.visibleAssistantActivity = msg.visibleAssistantActivity ?? (serverStreaming ? "thinking" : "none");
      patch.eventSeq = msg.eventSeq;
      upsertStream(msg.sessionId, patch);
    }
  }, [handlerId, owner, tabId, upsertStream]);

  const refreshSubscriptions = useCallback((reason: string) => {
    const ids = Array.from(subscribedIdsRef.current);
    if (ids.length === 0) return;
    const ws = sharedWSRef.current;
    if (!ws || ws.getReadyState() !== WebSocket.OPEN) return;
    log.debug("STREAM:REFRESH_SUBSCRIPTIONS", {
      handlerId,
      owner,
      tabId,
      activeSession: activeSessionRef.current,
      reason,
      sessionCount: ids.length,
    });
    requestedIdsRef.current.clear();
    ids.forEach(sendSubscribe);
  }, [handlerId, owner, sendSubscribe, tabId]);

  const handleReconnect = useCallback(() => {
    refreshSubscriptions("reconnect");
  }, [refreshSubscriptions]);

  useEffect(() => {
    log.debug("STREAM:HOOK:MOUNT", { handlerId, owner, tabId, activeSession: activeSessionRef.current, initialSessionIds: initialSessionIdsRef.current });
    const sharedWS = acquireSharedWS(`${owner}:${handlerId}`);
    sharedWSRef.current = sharedWS;
    setStreamConnected(sharedWS.getReadyState() === WebSocket.OPEN);

    sharedWS.addMessageHandler(handlerId, handleMessage);
    sharedWS.addReconnectHandler(handlerId, handleReconnect);
    sharedWS.addOpenHandler(handlerId, () => {
      setStreamConnected(true);
      requestedIdsRef.current.clear();
      if (sharedWS.getReadyState() === WebSocket.OPEN && !sharedWS.wasReconnectOpen()) {
        subscribedIdsRef.current.forEach(sendSubscribe);
      }
    });
    sharedWS.addCloseHandler(handlerId, () => setStreamConnected(false));
    sharedWS.addErrorHandler(handlerId, () => setStreamConnected(false));

    const handleVisibilityResume = () => {
      if (document.visibilityState === "visible") {
        refreshSubscriptions("visibility-visible");
      }
    };
    const handlePageShow = () => refreshSubscriptions("pageshow");
    const handleWindowFocus = () => refreshSubscriptions("window-focus");
    document.addEventListener("visibilitychange", handleVisibilityResume);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityResume);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleWindowFocus);
      subscribedIdsRef.current.forEach(sendUnsubscribe);
      subscribedIdsRef.current.clear();
      requestedIdsRef.current.clear();
      sharedWS.removeMessageHandler(handlerId);
      sharedWS.removeReconnectHandler(handlerId);
      sharedWS.removeOpenHandler(handlerId);
      sharedWS.removeCloseHandler(handlerId);
      sharedWS.removeErrorHandler(handlerId);
      sharedWSRef.current = null;
      log.debug("STREAM:HOOK:UNMOUNT", { handlerId, owner, tabId, activeSession: activeSessionRef.current });
      releaseSharedWS(`${owner}:${handlerId}`);
    };
  }, [handlerId, handleMessage, handleReconnect, owner, refreshSubscriptions, sendSubscribe, sendUnsubscribe, setStreamConnected, tabId]);

  useEffect(() => {
    const normalizedIds = normalizedKey ? normalizedKey.split("\u0000") : [];
    const nextIds = new Set(normalizedIds);
    const prevIds = subscribedIdsRef.current;
    const previousIds = Array.from(prevIds).sort();
    const added = normalizedIds.filter((id) => !prevIds.has(id));
    const removed = previousIds.filter((id) => !nextIds.has(id));
    if (added.length > 0 || removed.length > 0) {
      log.debug("STREAM:HOOK:SESSION_IDS", { handlerId, owner, tabId, activeSession: activeSessionRef.current, previousIds, nextIds: normalizedIds, added, removed });
    }

    for (const prevId of prevIds) {
      if (!nextIds.has(prevId)) {
        sendUnsubscribe(prevId);
        prevIds.delete(prevId);
      }
    }

    for (const nextId of nextIds) {
      if (!prevIds.has(nextId)) {
        prevIds.add(nextId);
        setStreams((prev) => ({
          ...prev,
          [nextId]: prev[nextId] ?? {
            ...idleStreamState,
            wsConnected,
          },
        }));
        if (sharedWSRef.current?.getReadyState() === WebSocket.OPEN) {
          sendSubscribe(nextId);
        }
      }
    }

    setStreams((prev) => {
      let changed = false;
      const next: SessionStreamMap = {};
      for (const [sessionId, state] of Object.entries(prev)) {
        if (nextIds.has(sessionId)) {
          next[sessionId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    if (nextIds.size > 0) {
      sharedWSRef.current?.setStreamActive(true);
    }
  }, [handlerId, normalizedKey, owner, sendSubscribe, sendUnsubscribe, tabId, wsConnected]);

  return { streams, wsConnected };
}

export function getSessionStreamState(
  streams: SessionStreamMap,
  sessionId: string | null | undefined,
  wsConnected: boolean,
): SessionStreamState {
  if (!sessionId) return { ...idleStreamState, wsConnected };
  return streams[sessionId] ?? { ...idleStreamState, wsConnected };
}

export function useSessionSubscription(sessionId: string | null): SessionStreamState {
  const sessionIds = useMemo(() => (sessionId ? [sessionId] : []), [sessionId]);
  const { streams, wsConnected } = useSessionSubscriptions(sessionIds, { owner: "single-session-hook", activeSession: sessionId });
  return getSessionStreamState(streams, sessionId, wsConnected);
}
