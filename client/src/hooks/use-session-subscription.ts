/**
 * Session streaming subscriptions — server-authoritative session streaming cache.
 *
 * The server owns StreamingContent for each live session. The client may
 * subscribe to multiple active sessions on one shared WS so background runs stay
 * warm while the user focuses another session.
 */

import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import type { StreamingContent, SegmentPatch, MessageSegment } from "@shared/streaming-types";
import { initialStreamingContent } from "@shared/streaming-types";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { createLogger } from "@/lib/logger";
import { markChatStreamProgress, streamingContentHasText, streamingContentHasProgress } from "@/lib/browser-telemetry";
import { noteNavigationStreamPressure } from "@/lib/navigation-trace";
import { getClientTabId } from "@/lib/client-tab-identity";

const log = createLogger("SessionSub");
const lastQuestionStreamSignatureBySession = new Map<string, string>();

function questionToolCallIdsFromStreaming(content: StreamingContent): string[] {
  return Array.from(new Set(content.segments.flatMap((segment) =>
    segment.type === "timeline"
      ? segment.steps.flatMap((step) =>
          step.toolName === "question" && typeof step.toolCallId === "string"
            ? [step.toolCallId]
            : [],
        )
      : [],
  )));
}

function traceQuestionStreamTransition(
  event: "snapshot" | "delta",
  msg: SessionMessage,
  content: StreamingContent,
  status: SessionStatus,
): void {
  const questionToolCallIds = questionToolCallIdsFromStreaming(content);
  if (questionToolCallIds.length === 0) return;
  const signature = JSON.stringify({
    questionToolCallIds,
    status,
    runActive: msg.runActive ?? status === "streaming",
    handoffPhase: msg.handoffPhase ?? "live",
    durableRevision: msg.durableRevision ?? null,
  });
  if (lastQuestionStreamSignatureBySession.get(msg.sessionId) === signature) return;
  lastQuestionStreamSignatureBySession.set(msg.sessionId, signature);
  log.info("QUESTION_TRACE:STREAM_STATE", {
    event,
    sessionId: msg.sessionId,
    questionToolCallIds,
    status,
    runActive: msg.runActive ?? status === "streaming",
    handoffPhase: msg.handoffPhase ?? "live",
    durableRevision: msg.durableRevision ?? null,
    eventSeq: msg.eventSeq ?? null,
    patchSeq: msg.patchSeq ?? null,
    tracedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionStatus = "idle" | "streaming" | "saved" | "error";
export type VisibleAssistantActivity = "none" | "streaming" | "thinking" | "tool";
export type DurableHandoffPhase = "live" | "durable";

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
  runGeneration?: number;
  durableRevision: number | null;
  handoffPhase: DurableHandoffPhase;
  /** Client's current segment-patch baseline (protocol v2); null when unknown. */
  patchSeq: number | null;
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
  runGeneration?: number;
  eventType?: string;
  subscriberCount?: number;
  runActive?: boolean;
  canStop?: boolean;
  visibleAssistantActivity?: VisibleAssistantActivity;
  durableRevision?: number | null;
  handoffPhase?: DurableHandoffPhase;
  patchSeq?: number;
  basePatchSeq?: number;
  scalars?: Partial<StreamingContent>;
  segmentPatch?: SegmentPatch;
}

export interface SessionSubscriptionOptions {
  owner?: string;
  activeSession?: string | null;
}

export interface SessionStreamStore {
  getState: (sessionId: string) => SessionStreamState | undefined;
  getSnapshot: () => SessionStreamMap;
  setState: (sessionId: string, state: SessionStreamState) => void;
  deleteState: (sessionId: string) => void;
  subscribe: (listener: () => void) => () => void;
}

function createSessionStreamStore(): SessionStreamStore {
  let snapshot: SessionStreamMap = {};
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  return {
    getState: (sessionId) => snapshot[sessionId],
    getSnapshot: () => snapshot,
    setState: (sessionId, state) => {
      if (snapshot[sessionId] === state) return;
      snapshot = { ...snapshot, [sessionId]: state };
      publish();
    },
    deleteState: (sessionId) => {
      if (!(sessionId in snapshot)) return;
      const { [sessionId]: _removed, ...next } = snapshot;
      snapshot = next;
      publish();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const idleStreamState: SessionStreamState = {
  streamingContent: null,
  status: "idle",
  wsConnected: false,
  runActive: false,
  canStop: false,
  visibleAssistantActivity: "none",
  durableRevision: null,
  handoffPhase: "live",
  patchSeq: null,
};

function getIdleStreamState(wsConnected: boolean): SessionStreamState {
  return { ...idleStreamState, wsConnected };
}

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

/**
 * Apply a protocol-v2 segment patch to a baseline segment array. Truncate to the
 * authoritative final length, then overwrite/extend the changed indices. The
 * server guarantees every new index is present in `set`, so no holes remain.
 */
function applySegmentPatch(base: MessageSegment[], patch: SegmentPatch): MessageSegment[] {
  const next = base.slice(0, patch.length);
  for (const entry of patch.set) {
    next[entry.index] = entry.segment;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

let instanceCounter = 0;

export function useSessionSubscriptions(
  sessionIds: readonly (string | null | undefined)[],
  options: SessionSubscriptionOptions = {},
): {
  store: SessionStreamStore;
  wsConnected: boolean;
} {
  const handlerId = useMemo(() => `sessionSub-${++instanceCounter}`, []);
  const owner = options.owner ?? "unknown";
  const activeSession = options.activeSession ?? null;
  const activeSessionRef = useRef<string | null>(activeSession);
  activeSessionRef.current = activeSession;
  const tabId = useMemo(getClientTabId, []);
  const initialSessionIdsRef = useRef<string[]>(normalizeSessionIds(sessionIds));
  const sharedWSRef = useRef<ReturnType<typeof acquireSharedWS> | null>(null);
  const wsOwnerId = `${owner}:${handlerId}`;
  const subscribedIdsRef = useRef<Set<string>>(new Set());
  const requestedIdsRef = useRef<Set<string>>(new Set());
  const subscriptionEpochRef = useRef<Record<string, number>>({});
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRecoveryReasonsRef = useRef<Set<string>>(new Set());
  const wsConnectedRef = useRef(false);
  // Per-session contiguous patch baseline + last full content, read synchronously
  // for gap detection and patch application (protocol v2).
  const patchSeqRef = useRef<Record<string, number | null>>({});
  const latestStreamRef = useRef<Record<string, StreamingContent | null>>({});
  const store = useMemo(createSessionStreamStore, []);
  const [wsConnected, setWsConnected] = useState(false);

  const normalizedKey = useMemo(() => normalizeSessionIds(sessionIds).join("\u0000"), [sessionIds]);

  useEffect(() => store.subscribe(() => {
    const states = Object.values(store.getSnapshot());
    const active = states.filter((state) => state.runActive || state.status === "streaming").length;
    const maxSegments = states.reduce((max, state) => Math.max(max, state.streamingContent?.segments.length ?? 0), 0);
    noteNavigationStreamPressure(sessionIds.length, active, maxSegments);
  }), [sessionIds.length, store]);

  const setStreamConnected = useCallback((connected: boolean) => {
    if (wsConnectedRef.current === connected) return;
    wsConnectedRef.current = connected;
    setWsConnected(connected);
    for (const [sessionId, state] of Object.entries(store.getSnapshot())) {
      if (state.wsConnected === connected) continue;
      store.setState(sessionId, { ...state, wsConnected: connected });
    }
  }, [store]);

  const sendSubscribe = useCallback((id: string, trigger: string) => {
    const ws = sharedWSRef.current;
    if (!ws || ws.getReadyState() !== WebSocket.OPEN) return;
    if (requestedIdsRef.current.has(id)) return;
    requestedIdsRef.current.add(id);
    const currentActiveSession = activeSessionRef.current;
    const subscriptionEpoch = (subscriptionEpochRef.current[id] ?? 0) + 1;
    subscriptionEpochRef.current[id] = subscriptionEpoch;
    log.info("STREAM:SUBSCRIPTION_MUTATION", { operation: "subscribe", trigger, handlerId, owner, tabId, activeSession: currentActiveSession, sessionId: id, subscriptionEpoch });
    ws.send({ type: "session.subscribe", sessionId: id, handlerId, owner, tabId, activeSession: currentActiveSession, subscriptionEpoch, trigger, supportsDelta: true });
  }, [handlerId, owner, tabId]);

  const sendUnsubscribe = useCallback((id: string, trigger: string) => {
    const ws = sharedWSRef.current;
    requestedIdsRef.current.delete(id);
    if (!ws || ws.getReadyState() !== WebSocket.OPEN) return;
    const currentActiveSession = activeSessionRef.current;
    const subscriptionEpoch = (subscriptionEpochRef.current[id] ?? 0) + 1;
    subscriptionEpochRef.current[id] = subscriptionEpoch;
    log.info("STREAM:SUBSCRIPTION_MUTATION", { operation: "unsubscribe", trigger, handlerId, owner, tabId, activeSession: currentActiveSession, sessionId: id, subscriptionEpoch });
    ws.send({ type: "session.unsubscribe", sessionId: id, handlerId, owner, tabId, activeSession: currentActiveSession, subscriptionEpoch, trigger });
  }, [handlerId, owner, tabId]);

  // A dropped or out-of-baseline patch means the client's baseline is stale.
  // Reset it and force a fresh subscribe so the server replies with a full
  // snapshot that re-establishes the baseline. Existing state is retained until
  // that snapshot arrives.
  const forceResync = useCallback((id: string) => {
    patchSeqRef.current[id] = null;
    requestedIdsRef.current.delete(id);
    sendSubscribe(id, "patch-gap-resync");
  }, [sendSubscribe]);

  const upsertStream = useCallback((sessionId: string, patch: Partial<SessionStreamState>) => {
    const connected = wsConnectedRef.current;
    const current = store.getState(sessionId) ?? getIdleStreamState(connected);
    const incomingGeneration = patch.runGeneration;
    const currentGeneration = current.runGeneration;
    const incomingSeq = patch.eventSeq;
    const currentSeq = current.eventSeq;

    // Runtime payloads advance lexicographically by (runGeneration, eventSeq).
    // Equal-sequence snapshots are replay acknowledgements, not new state;
    // equal-sequence deltas are likewise duplicates. Rejecting either prevents
    // delayed recovery from overwriting a newer baseline while still allowing a
    // higher generation to reset patchSeq.
    const generationRegressed =
      typeof incomingGeneration === "number" &&
      typeof currentGeneration === "number" &&
      incomingGeneration < currentGeneration;
    const sameGeneration =
      incomingGeneration === undefined ||
      currentGeneration === undefined ||
      incomingGeneration === currentGeneration;
    const sequenceDidNotAdvance =
      sameGeneration &&
      typeof incomingSeq === "number" &&
      typeof currentSeq === "number" &&
      incomingSeq <= currentSeq;
    if (generationRegressed || sequenceDidNotAdvance) {
      log.debug("STREAM:STALE_EVENT_REJECTED", {
        sessionId,
        incomingGeneration,
        currentGeneration,
        incomingSeq,
        currentSeq,
        incomingStatus: patch.status,
        currentStatus: current.status,
      });
      return;
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
      next.runGeneration === current.runGeneration &&
      next.durableRevision === current.durableRevision &&
      next.handoffPhase === current.handoffPhase &&
      next.patchSeq === current.patchSeq &&
      next.wsConnected === current.wsConnected
    ) {
      return;
    }
    store.setState(sessionId, next);
  }, [store]);

  const handleMessage = useCallback((msg: unknown) => {
    if (!isSessionMessage(msg)) return;
    if (!subscribedIdsRef.current.has(msg.sessionId)) return;

    if (msg.type === "session.snapshot") {
      const status = (msg.status as SessionStatus | undefined) || "streaming";
      const serverStreaming = status === "streaming";
      const content = msg.streamingContent ?? msg.content ?? initialStreamingContent;
      log.verbose(() => `SNAPSHOT:RECEIVE session=${msg.sessionId} status=${status} segments=${content.segments.length}`);
      // The server snapshot is authoritative, including its settled terminal
      // payload. The transcript handoff releases it only after durable finality.
      markChatStreamProgress(msg.sessionId, streamingContentHasProgress(content), streamingContentHasText(content), status);
      traceQuestionStreamTransition("snapshot", msg, content, status);
      patchSeqRef.current[msg.sessionId] = msg.patchSeq ?? null;
      latestStreamRef.current[msg.sessionId] = content;
      upsertStream(msg.sessionId, {
        streamingContent: content,
        status,
        updatedAt: Date.now(),
        runActive: msg.runActive ?? serverStreaming,
        canStop: msg.canStop ?? serverStreaming,
        visibleAssistantActivity: msg.visibleAssistantActivity ?? (serverStreaming ? "thinking" : "none"),
        eventSeq: msg.eventSeq,
        runGeneration: msg.runGeneration,
        durableRevision: msg.durableRevision ?? null,
        handoffPhase: msg.handoffPhase ?? "live",
        patchSeq: msg.patchSeq ?? null,
      });
      return;
    }

    if (msg.type === "session.delta") {
      const status = msg.status as SessionStatus | undefined;
      const serverStreaming = status === undefined || status === "streaming";

      // Protocol v2: an incremental segment patch. Reconstruct the full
      // StreamingContent from the baseline the client already holds. A missing
      // baseline or non-contiguous patch sequence means a dropped patch — drop
      // this one and resubscribe for a fresh snapshot rather than corrupt state.
      let content: StreamingContent;
      if (msg.segmentPatch) {
        const currentSeq = patchSeqRef.current[msg.sessionId] ?? null;
        const base = latestStreamRef.current[msg.sessionId];
        if (!base || currentSeq === null || msg.basePatchSeq !== currentSeq) {
          log.debug("STREAM:PATCH_GAP_RESYNC", { sessionId: msg.sessionId, basePatchSeq: msg.basePatchSeq, currentSeq });
          forceResync(msg.sessionId);
          return;
        }
        content = { ...base, ...(msg.scalars ?? {}), segments: applySegmentPatch(base.segments, msg.segmentPatch) };
        patchSeqRef.current[msg.sessionId] = msg.patchSeq ?? null;
      } else {
        content = msg.streamingContent ?? initialStreamingContent;
        if (msg.patchSeq !== undefined) patchSeqRef.current[msg.sessionId] = msg.patchSeq;
      }
      latestStreamRef.current[msg.sessionId] = content;

      log.verbose(() => `DELTA:RECEIVE session=${msg.sessionId} status=${status ?? "streaming"} segments=${content.segments.length}`);
      markChatStreamProgress(msg.sessionId, streamingContentHasProgress(content), streamingContentHasText(content), status);
      traceQuestionStreamTransition("delta", msg, content, status ?? "streaming");
      const patch: Partial<SessionStreamState> = {};
      patch.streamingContent = content;
      if (status) patch.status = status;
      patch.updatedAt = Date.now();
      patch.runActive = msg.runActive ?? serverStreaming;
      patch.canStop = msg.canStop ?? serverStreaming;
      patch.visibleAssistantActivity = msg.visibleAssistantActivity ?? (serverStreaming ? "thinking" : "none");
      patch.eventSeq = msg.eventSeq;
      patch.runGeneration = msg.runGeneration;
      if (msg.patchSeq !== undefined) patch.patchSeq = msg.patchSeq;
      if (msg.durableRevision !== undefined) patch.durableRevision = msg.durableRevision;
      if (msg.handoffPhase !== undefined) patch.handoffPhase = msg.handoffPhase;
      upsertStream(msg.sessionId, patch);
    }
  }, [handlerId, owner, tabId, upsertStream, forceResync]);

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
    for (const id of ids) patchSeqRef.current[id] = null;
    ids.forEach((id) => sendSubscribe(id, `recovery:${reason}`));
  }, [handlerId, owner, sendSubscribe, tabId]);

  const requestRecovery = useCallback((reason: string) => {
    pendingRecoveryReasonsRef.current.add(reason);
    if (recoveryTimerRef.current) return;
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = null;
      const reasons = Array.from(pendingRecoveryReasonsRef.current).sort();
      pendingRecoveryReasonsRef.current.clear();
      refreshSubscriptions(reasons.join("+"));
    }, 50);
  }, [refreshSubscriptions]);

  const handleReconnect = useCallback(() => {
    requestRecovery("reconnect");
  }, [requestRecovery]);

  useEffect(() => {
    log.debug("STREAM:HOOK:MOUNT", { handlerId, owner, tabId, activeSession: activeSessionRef.current, initialSessionIds: initialSessionIdsRef.current });
    const sharedWS = acquireSharedWS(wsOwnerId);
    sharedWSRef.current = sharedWS;
    setStreamConnected(sharedWS.getReadyState() === WebSocket.OPEN);

    sharedWS.addMessageHandler(handlerId, handleMessage);
    sharedWS.addReconnectHandler(handlerId, handleReconnect);
    sharedWS.addOpenHandler(handlerId, () => {
      setStreamConnected(true);
      requestedIdsRef.current.clear();
      if (sharedWS.getReadyState() === WebSocket.OPEN && !sharedWS.wasReconnectOpen()) {
        subscribedIdsRef.current.forEach((id) => sendSubscribe(id, "socket-open"));
      }
    });
    sharedWS.addCloseHandler(handlerId, () => setStreamConnected(false));
    sharedWS.addErrorHandler(handlerId, () => setStreamConnected(false));

    const handleVisibilityResume = () => {
      if (document.visibilityState === "visible") {
        requestRecovery("visibility-visible");
      }
    };
    const handlePageShow = () => requestRecovery("pageshow");
    const handleWindowFocus = () => requestRecovery("window-focus");
    document.addEventListener("visibilitychange", handleVisibilityResume);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityResume);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleWindowFocus);
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      pendingRecoveryReasonsRef.current.clear();
      subscribedIdsRef.current.forEach((id) => sendUnsubscribe(id, "hook-unmount"));
      subscribedIdsRef.current.clear();
      requestedIdsRef.current.clear();
      sharedWS.removeMessageHandler(handlerId);
      sharedWS.removeReconnectHandler(handlerId);
      sharedWS.removeOpenHandler(handlerId);
      sharedWS.removeCloseHandler(handlerId);
      sharedWS.removeErrorHandler(handlerId);
      sharedWSRef.current = null;
      log.debug("STREAM:HOOK:UNMOUNT", { handlerId, owner, tabId, activeSession: activeSessionRef.current });
      sharedWS.setStreamActive(wsOwnerId, false);
      releaseSharedWS(wsOwnerId);
    };
  }, [handlerId, handleMessage, handleReconnect, owner, requestRecovery, sendSubscribe, sendUnsubscribe, setStreamConnected, tabId, wsOwnerId]);

  useEffect(() => {
    if (sharedWSRef.current?.getReadyState() !== WebSocket.OPEN) return;
    const ids = Array.from(subscribedIdsRef.current);
    if (ids.length === 0) return;
    requestedIdsRef.current.clear();
    ids.forEach((id) => sendSubscribe(id, "active-session-change"));
  }, [activeSession, sendSubscribe]);

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
        sendUnsubscribe(prevId, "session-set-removed");
        prevIds.delete(prevId);
        delete patchSeqRef.current[prevId];
        delete latestStreamRef.current[prevId];
      }
    }

    for (const nextId of nextIds) {
      if (!prevIds.has(nextId)) {
        prevIds.add(nextId);
        if (!store.getState(nextId)) {
          store.setState(nextId, getIdleStreamState(wsConnected));
        }
        if (sharedWSRef.current?.getReadyState() === WebSocket.OPEN) {
          sendSubscribe(nextId, "session-set-added");
        }
      }
    }

    for (const cachedId of Object.keys(store.getSnapshot())) {
      if (!nextIds.has(cachedId)) store.deleteState(cachedId);
    }
    sharedWSRef.current?.setStreamActive(wsOwnerId, nextIds.size > 0);
  }, [handlerId, normalizedKey, owner, sendSubscribe, sendUnsubscribe, store, tabId, wsConnected, wsOwnerId]);

  return { store, wsConnected };
}

export function useSessionStreamState(
  store: SessionStreamStore,
  sessionId: string | null | undefined,
  wsConnected: boolean,
): SessionStreamState {
  const fallback = useMemo(() => getIdleStreamState(wsConnected), [wsConnected]);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(
    () => sessionId ? store.getState(sessionId) ?? fallback : fallback,
    [fallback, sessionId, store],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSessionStreamMap(
  store: SessionStreamStore,
  sessionIds: readonly (string | null | undefined)[],
): SessionStreamMap {
  const normalizedKey = useMemo(() => normalizeSessionIds(sessionIds).join("\u0000"), [sessionIds]);
  const selectedIds = useMemo(() => normalizedKey ? normalizedKey.split("\u0000") : [], [normalizedKey]);
  const lastSelectionRef = useRef<{ states: Array<SessionStreamState | null>; snapshot: SessionStreamMap } | null>(null);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const getSnapshot = useCallback(() => {
    const states = selectedIds.map((id) => store.getState(id) ?? null);
    const prior = lastSelectionRef.current;
    if (prior && prior.states.length === states.length && prior.states.every((state, index) => state === states[index])) {
      return prior.snapshot;
    }
    const snapshot = Object.fromEntries(selectedIds.flatMap((id) => {
      const state = store.getState(id);
      return state ? [[id, state]] : [];
    }));
    lastSelectionRef.current = { states, snapshot };
    return snapshot;
  }, [selectedIds, store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSessionSubscription(sessionId: string | null): SessionStreamState {
  const sessionIds = useMemo(() => (sessionId ? [sessionId] : []), [sessionId]);
  const { store, wsConnected } = useSessionSubscriptions(sessionIds, { owner: "single-session-hook", activeSession: sessionId });
  return useSessionStreamState(store, sessionId, wsConnected);
}
