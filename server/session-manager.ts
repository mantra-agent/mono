/**
 * SessionManager — server-authoritative streaming state.
 *
 * Maintains a live StreamingContent per active session, applies journal
 * events through pure reducers, and broadcasts deltas to subscribed
 * WebSocket clients. Runs alongside the existing eventBus during migration.
 */

import { WebSocket } from "ws";
import { createLogger } from "./log";
import {
  appendThinking,
  finishThinking,
  addToolCall,
  resolveToolResult,
  appendContent,
  appendCompacting,
  addSystemStep,
  resolveSystemStep,
  settleStream,
} from "./streaming-reducers";
import type { ExecutionStep, StreamingContent, StreamingSource } from "@shared/streaming-types";
import { initialStreamingContent } from "@shared/streaming-types";

const log = createLogger("session-manager");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionRuntimeStatus = "streaming" | "saved" | "error";
type VisibleAssistantActivity = "none" | "thinking" | "streaming" | "tool";

interface LiveSession {
  sessionId: string;
  sessionKey: string;
  source: StreamingSource;
  streamingContent: StreamingContent;
  status: SessionRuntimeStatus;
  subscribers: Set<WebSocket>;
  finalizedAt: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  eventSeq: number;
  runGeneration: number;
}

export interface SessionSubscriberIdentity {
  connectionId?: string;
  tabId?: string;
  handlerId?: string;
  owner?: string;
  activeSession?: string | null;
}

export type SessionStreamEvent = {
  type: string;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  narrative?: string;
  result?: unknown;
  error?: string;
  model?: string;
  autoTier?: string;
  persona?: { id: number; name: string; icon: string };
  runId?: string;
  turnId?: string;
  assistantAttemptId?: string;
  transcriptRevision?: number;
  step?: string;
  status?: string;
  elapsedMs?: number;
  detail?: string;
  stepId?: string;
  severity?: string;
  messageId?: string;
  cost?: number | null;
  apiCallCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  ts?: number;
  parentId?: string;
  startedAt?: number;
  endedAt?: number;
  selfTimeMs?: number;
  timingKind?: ExecutionStep["timingKind"];
  diagnosticVisibility?: ExecutionStep["diagnosticVisibility"];
  childMode?: ExecutionStep["childMode"];
  occurredAt?: number;
  metadata?: Record<string, unknown>;
};

/** Snapshot sent to a newly subscribing client. */
export interface SessionSnapshot {
  sessionId: string;
  sessionKey: string;
  streamingContent: StreamingContent;
  status: SessionRuntimeStatus;
  eventSeq: number;
  subscriberCount: number;
  runActive: boolean;
  canStop: boolean;
  visibleAssistantActivity: VisibleAssistantActivity;
}

/** Delta broadcast to subscribers after each event. */
export interface SessionDelta {
  sessionId: string;
  type: string;
  streamingContent: StreamingContent;
  status: SessionRuntimeStatus;
  runActive: boolean;
  canStop: boolean;
  visibleAssistantActivity: VisibleAssistantActivity;
}


function getSteps(streamingContent: StreamingContent): ExecutionStep[] {
  return streamingContent.segments.flatMap((segment) => segment.type === "timeline" ? segment.steps : []);
}

function deriveVisibleAssistantActivity(session: LiveSession): VisibleAssistantActivity {
  if (session.status !== "streaming") return "none";
  const steps = getSteps(session.streamingContent);
  if (steps.some((step) =>
    step.status === "active" && (
      (step.type === "thinking" && (step.thinking || "").trim().length > 0) ||
      (step.type === "system" && step.systemStepName === "session_compaction")
    )
  )) {
    return "thinking";
  }
  if (session.streamingContent.segments.some((segment) => segment.type === "content" && segment.content.length > 0)) {
    return "streaming";
  }
  if (steps.some((step) => step.type === "tool_call" && step.status === "active")) {
    return "tool";
  }
  return "none";
}

function runtimeProjection(session: LiveSession) {
  const runActive = session.status === "streaming";
  return {
    runActive,
    canStop: runActive,
    visibleAssistantActivity: deriveVisibleAssistantActivity(session),
  };
}

/**
 * Event sequence numbers are wall-clock anchored so they stay strictly
 * monotonic per sessionId across live-entry recreation and server restarts.
 * Clients reject deltas whose seq regresses below the last seen value, so a
 * recreated entry (after finalize + cleanup) or a new boot must always outrank
 * every previously delivered seq for that session. Anchoring to Date.now()
 * encodes that invariant in the value domain without any retained state.
 */
function nextEventSeq(prior: number): number {
  return Math.max(Date.now(), prior + 1);
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

class SessionManager {
  private sessions = new Map<string, LiveSession>();
  /**
   * Stable delivery interest, independent of disposable LiveSession entries.
   * A shared socket may have several UI owners interested in the same session;
   * removing one owner must not detach the others.
   */
  private subscriptionOwners = new Map<string, Map<WebSocket, Map<string, SessionSubscriberIdentity>>>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Cleanup sweep every 5 minutes: remove finalized sessions with no subscribers
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    // Don't block process exit
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  // ── Registration ──────────────────────────────────────────────────

  registerSession(sessionId: string, sessionKey: string, source: StreamingSource): number {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      log.debug(`registerSession: already registered sessionId=${sessionId} — resetting`);
      if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
    }

    // Runtime delivery is derived from stable connection interest. Finalization
    // may replace/delete LiveSession without erasing what open clients requested.
    const interestedSockets = this.subscriptionOwners.get(sessionId);
    const mergedSubscribers = new Set<WebSocket>(interestedSockets?.keys() ?? []);

    const session: LiveSession = {
      sessionId,
      sessionKey,
      source,
      streamingContent: { ...initialStreamingContent, source },
      status: "streaming",
      subscribers: mergedSubscribers,
      finalizedAt: null,
      cleanupTimer: null,
      eventSeq: nextEventSeq(existing?.eventSeq ?? 0),
      runGeneration: (existing?.runGeneration ?? 0) + 1,
    };
    this.sessions.set(sessionId, session);

    // A new run generation is authoritative immediately. Push its initial
    // snapshot to every interested socket, including clients that stayed
    // subscribed while the prior finalized runtime entry was cleaned up.
    if (session.subscribers.size > 0) {
      const snapshot = JSON.stringify({
        type: "session.snapshot",
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        streamingContent: session.streamingContent,
        status: session.status,
        eventSeq: session.eventSeq,
        subscriberCount: session.subscribers.size,
        ...runtimeProjection(session),
      });
      for (const ws of session.subscribers) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(snapshot);
        } catch (err) {
          log.warn(`registerSession snapshot send failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    log.log(`registerSession sessionId=${sessionId} source=${source} subscribers=${session.subscribers.size}`);
    return session.runGeneration;
  }

  // ── Event application ─────────────────────────────────────────────

  /**
   * Maps a journal event to a streaming reducer and broadcasts the delta.
   * Called from publishJournalToUI for chat-category events.
   */
  applyEvent(sessionId: string, event: SessionStreamEvent, broadcast = true): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.debug(`applyEvent: no live session for sessionId=${sessionId} type=${event.type} — ignoring`);
      return;
    }

    let prev = session.streamingContent;
    let changed = true;

    switch (event.type) {
      case "thinking":
        prev = appendThinking(prev, event.content || "", event.ts);
        break;

      case "thinking_complete":
        prev = finishThinking(prev);
        break;

      case "delta":
        prev = appendContent(prev, event.content || "");
        break;

      case "tool_call":
        prev = addToolCall(prev, event.toolName, event.toolCallId, event.arguments, event.narrative, event.parentId);
        break;

      case "tool_result":
        prev = resolveToolResult(prev, event.toolCallId, event.result, event.error, event.toolName, event.ts, event.arguments);
        break;

      case "compacting":
        prev = appendCompacting(prev, event.content || "", event.status, event.stepId);
        break;

      case "system_step": {
        const stepStatus = event.status || "done";
        if (stepStatus === "started" || stepStatus === "active") {
          prev = addSystemStep(prev, event.step || "unknown", {
            systemStepName: event.step,
            systemStepDetail: event.detail,
            systemStepMetadata: event.metadata,
            status: "active",
            stepId: event.stepId,
            parentId: event.parentId,
            startedAt: event.startedAt,
            endedAt: event.endedAt,
            selfTimeMs: event.selfTimeMs,
            timingKind: event.timingKind,
            diagnosticVisibility: event.diagnosticVisibility,
            childMode: event.childMode,
            occurredAt: event.occurredAt,
          });
        } else {
          // Try to resolve first; if no active step exists, add as already-done
          const resolved = resolveSystemStep(
            prev,
            event.step || "unknown",
            stepStatus as "done" | "error",
            event.elapsedMs,
            event.detail,
            event.stepId,
            event.metadata,
            event.parentId,
            event.startedAt,
            event.endedAt,
            event.selfTimeMs,
            event.timingKind,
            event.diagnosticVisibility,
            event.childMode,
            event.occurredAt,
          );
          // Check if resolution actually changed anything
          if (resolved === prev) {
            prev = addSystemStep(prev, event.step || "unknown", {
              systemStepName: event.step,
              systemStepDetail: event.detail,
              systemStepMetadata: event.metadata,
              status: stepStatus,
              elapsedMs: event.elapsedMs,
              stepId: event.stepId,
              parentId: event.parentId,
              startedAt: event.startedAt,
              endedAt: event.endedAt,
              selfTimeMs: event.selfTimeMs,
              timingKind: event.timingKind,
              diagnosticVisibility: event.diagnosticVisibility,
              childMode: event.childMode,
              occurredAt: event.occurredAt,
            });
          } else {
            prev = resolved;
          }
        }
        break;
      }

      case "model_info":
        prev = {
          ...prev,
          model: event.model || prev.model || null,
          autoTier: event.autoTier || prev.autoTier || null,
          persona: event.persona || prev.persona || null,
        };
        break;

      case "run_start":
        prev = { ...prev, runId: event.runId || null, turnId: event.turnId ?? prev.turnId ?? null };
        break;

      case "turn_start":
      case "assistant_attempt_started":
        // A new attempt is a replacement, never an append to superseded output.
        prev = {
          ...initialStreamingContent,
          source: session.source ?? "voice",
          turnId: event.turnId || prev.turnId || null,
          assistantAttemptId: event.assistantAttemptId || null,
          transcriptRevision: event.transcriptRevision ?? null,
        };
        session.status = "streaming";
        session.finalizedAt = null;
        break;

      case "assistant_attempt_superseded":
        // Superseded output must disappear atomically and must never freeze.
        if (!event.assistantAttemptId || prev.assistantAttemptId === event.assistantAttemptId) {
          prev = {
            ...initialStreamingContent,
            source: session.source ?? "voice",
            turnId: event.turnId || prev.turnId || null,
            transcriptRevision: event.transcriptRevision ?? prev.transcriptRevision ?? null,
          };
        } else {
          changed = false;
        }
        break;

      case "saved":
        prev = {
          ...prev,
          cost: event.cost ?? prev.cost ?? null,
          apiCallCount: event.apiCallCount ?? prev.apiCallCount ?? null,
          inputTokens: event.inputTokens ?? prev.inputTokens ?? null,
          outputTokens: event.outputTokens ?? prev.outputTokens ?? null,
          totalTokens: event.totalTokens ?? prev.totalTokens ?? null,
        };
        break;

      case "done":
      case "error":
        // Terminal events — don't update streamingContent here.
        // finalizeSession handles settlement.
        changed = false;
        break;

      default:
        // system_notice, user_message, etc. — broadcast raw but don't transform state
        changed = false;
        break;
    }

    if (changed) {
      // Ensure source is set so client-side isActiveStreaming checks pass.
      // Use the session's registered source (voice or text) — never default to "text"
      // for a voice-registered session.
      if (!prev.source) {
        prev = { ...prev, source: session.source ?? "text" };
      }
      session.streamingContent = prev;
    }

    if (broadcast) {
      this.broadcastDelta(session, {
        sessionId,
        type: event.type,
        streamingContent: session.streamingContent,
        status: session.status,
        ...runtimeProjection(session),
      });
    }
  }

  applyEvents(sessionId: string, events: SessionStreamEvent[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.debug(`applyEvents: no live session for sessionId=${sessionId} count=${events.length} — ignoring`);
      return;
    }
    if (events.length === 0) return;
    for (const event of events) this.applyEvent(sessionId, event, false);
    this.broadcastDelta(session, {
      sessionId,
      type: "event_batch",
      streamingContent: session.streamingContent,
      status: session.status,
      ...runtimeProjection(session),
    });
  }

  // ── Subscription ──────────────────────────────────────────────────

  subscribe(sessionId: string, ws: WebSocket, identity: SessionSubscriberIdentity = {}): SessionSnapshot | null {
    const ownerId = identity.handlerId || "connection";
    let sockets = this.subscriptionOwners.get(sessionId);
    if (!sockets) {
      sockets = new Map();
      this.subscriptionOwners.set(sessionId, sockets);
    }
    let owners = sockets.get(ws);
    if (!owners) {
      owners = new Map();
      sockets.set(ws, owners);
    }
    const alreadySubscribed = owners.has(ownerId);
    owners.set(ownerId, identity);

    const session = this.sessions.get(sessionId);
    if (!session) {
      log.verbose(() => `SESSION:SUBSCRIBE:PENDING session=${sessionId} sockets=${sockets.size} owners=${owners.size}`);
      return null;
    }

    session.subscribers.add(ws);
    log.verbose(() => `SESSION:SUBSCRIBE session=${sessionId} subs=${session.subscribers.size} owners=${owners.size} alreadySub=${alreadySubscribed}`);

    return {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      streamingContent: session.streamingContent,
      status: session.status,
      eventSeq: session.eventSeq,
      subscriberCount: session.subscribers.size,
      ...runtimeProjection(session),
    };
  }

  unsubscribe(sessionId: string, ws: WebSocket, identity: SessionSubscriberIdentity = {}): boolean {
    const ownerId = identity.handlerId || "connection";
    const sockets = this.subscriptionOwners.get(sessionId);
    const owners = sockets?.get(ws);
    owners?.delete(ownerId);

    if (owners && owners.size > 0) {
      log.verbose(() => `SESSION:UNSUBSCRIBE_OWNER session=${sessionId} owners=${owners.size}`);
      return true;
    }

    sockets?.delete(ws);
    if (sockets?.size === 0) this.subscriptionOwners.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) session.subscribers.delete(ws);
    log.verbose(() => `SESSION:UNSUBSCRIBE session=${sessionId} subs=${session?.subscribers.size ?? 0}`);
    return false;
  }

  unsubscribeAll(ws: WebSocket): void {
    let removed = 0;
    for (const [sessionId, sockets] of this.subscriptionOwners) {
      if (sockets.delete(ws)) removed++;
      if (sockets.size === 0) this.subscriptionOwners.delete(sessionId);
    }
    for (const session of this.sessions.values()) session.subscribers.delete(ws);
    log.verbose(() => `SESSION:UNSUBSCRIBE_ALL removed=${removed}`);
  }

  // ── Finalization ──────────────────────────────────────────────────

  finalizeSession(sessionId: string, runGeneration?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.debug(`finalizeSession: no live session for sessionId=${sessionId}`);
      return;
    }

    if (runGeneration !== undefined && session.runGeneration !== runGeneration) {
      log.debug(
        `finalizeSession: stale generation ignored sessionId=${sessionId} expected=${runGeneration} current=${session.runGeneration}`,
      );
      return;
    }

    if (session.status === "saved" && session.finalizedAt !== null) {
      log.debug(`finalizeSession: already finalized sessionId=${sessionId}`);
      return;
    }

    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    session.streamingContent = settleStream(session.streamingContent);
    session.status = "saved";
    session.finalizedAt = Date.now();

    this.broadcastDelta(session, {
      sessionId,
      type: "finalized",
      streamingContent: session.streamingContent,
      status: "saved",
      runActive: false,
      canStop: false,
      visibleAssistantActivity: "none",
    });

    log.log(`finalizeSession sessionId=${sessionId} subscribers=${session.subscribers.size}`);

    // Finalized state is durable. Remove only the runtime projection after the
    // recovery window. Stable connection interest lives in subscriptionOwners
    // and will attach automatically when the next run generation registers.
    session.cleanupTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current !== session || current.status === "streaming") return;
      this.sessions.delete(sessionId);
      log.debug(`cleanup: removed finalized session sessionId=${sessionId} subscribers=${session.subscribers.size}`);
    }, 60_000);
  }

  getSubscriptionMetrics() {
    let socketLinks = 0;
    let ownerLinks = 0;
    let staleSocketLinks = 0;
    let pendingSessions = 0;
    for (const [sessionId, sockets] of this.subscriptionOwners) {
      if (!this.sessions.has(sessionId)) pendingSessions++;
      socketLinks += sockets.size;
      for (const [ws, owners] of sockets) {
        ownerLinks += owners.size;
        if (ws.readyState !== WebSocket.OPEN) staleSocketLinks++;
      }
    }
    let streamingSessions = 0;
    for (const session of this.sessions.values()) {
      if (session.status === "streaming") streamingSessions++;
    }
    return {
      subscribedSessions: this.subscriptionOwners.size,
      socketLinks,
      ownerLinks,
      staleSocketLinks,
      pendingSessions,
      liveSessions: this.sessions.size,
      streamingSessions,
    };
  }

  // ── Snapshot ───────────────────────────────────────────────────────

  getSnapshot(sessionId: string): SessionSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      streamingContent: session.streamingContent,
      status: session.status,
      eventSeq: session.eventSeq,
      subscriberCount: session.subscribers.size,
      ...runtimeProjection(session),
    };
  }

  // ── Broadcasting ──────────────────────────────────────────────────

  private broadcastDelta(session: LiveSession, delta: SessionDelta): void {
    session.eventSeq = nextEventSeq(session.eventSeq);
    const eventSeq = session.eventSeq;
    const payload = JSON.stringify({
      type: "session.delta",
      sessionId: delta.sessionId,
      eventType: delta.type,
      streamingContent: delta.streamingContent,
      status: delta.status,
      eventSeq,
      subscriberCount: session.subscribers.size,
      runActive: delta.runActive,
      canStop: delta.canStop,
      visibleAssistantActivity: delta.visibleAssistantActivity,
    });
    const dead: WebSocket[] = [];
    log.verbose(() => `SESSION:DELTA:BROADCAST session=${session.sessionId} seq=${eventSeq} type=${delta.type} source=${delta.streamingContent.source} segments=${delta.streamingContent.segments.length} subs=${session.subscribers.size}`);

    for (const ws of session.subscribers) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        } else {
          dead.push(ws);
        }
      } catch (err) {
        log.warn(`broadcastDelta send error sessionId=${session.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      session.subscribers.delete(ws);
      for (const [sessionId, sockets] of this.subscriptionOwners) {
        sockets.delete(ws);
        if (sockets.size === 0) this.subscriptionOwners.delete(sessionId);
      }
    }
  }

  // ── Sweep ─────────────────────────────────────────────────────────

  private sweep(): void {
    const now = Date.now();
    let swept = 0;
    for (const [sessionId, session] of this.sessions) {
      if (
        session.finalizedAt !== null &&
        session.status !== "streaming" &&
        now - session.finalizedAt > 60_000
      ) {
        if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
        this.sessions.delete(sessionId);
        swept++;
      }
    }
    if (swept > 0) {
      log.debug(`sweep: removed ${swept} stale sessions, ${this.sessions.size} remaining`);
    }
  }
}

export const sessionManager = new SessionManager();
