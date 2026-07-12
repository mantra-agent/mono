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
}

export interface SessionSubscriberIdentity {
  connectionId?: string;
  tabId?: string;
  handlerId?: string;
  owner?: string;
  activeSession?: string | null;
}

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
  if (steps.some((step) => step.type === "thinking" && step.status === "active" && (step.thinking || "").trim().length > 0)) {
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

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

class SessionManager {
  private sessions = new Map<string, LiveSession>();
  /** WS clients that subscribed before the session was registered. Drained on registerSession. */
  private pendingSubscribers = new Map<string, Set<WebSocket>>();
  private subscriberIdentities = new WeakMap<WebSocket, SessionSubscriberIdentity>();
  private sessionSubscriberIdentities = new WeakMap<WebSocket, Map<string, SessionSubscriberIdentity>>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Cleanup sweep every 5 minutes: remove finalized sessions with no subscribers
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    // Don't block process exit
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  // ── Registration ──────────────────────────────────────────────────

  registerSession(sessionId: string, sessionKey: string, source: StreamingSource): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      log.debug(`registerSession: already registered sessionId=${sessionId} — resetting`);
      if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
    }

    // Merge existing subscribers + any pending subscribers that arrived before registration
    const mergedSubscribers = existing?.subscribers ?? new Set<WebSocket>();
    const pending = this.pendingSubscribers.get(sessionId);
    if (pending) {
      for (const ws of pending) {
        mergedSubscribers.add(ws);
      }
      this.pendingSubscribers.delete(sessionId);
    }

    const session: LiveSession = {
      sessionId,
      sessionKey,
      source,
      streamingContent: { ...initialStreamingContent, source },
      status: "streaming",
      subscribers: mergedSubscribers,
      finalizedAt: null,
      cleanupTimer: null,
      eventSeq: existing?.eventSeq ?? 0,
    };
    this.sessions.set(sessionId, session);

    // Broadcast initial snapshot to any pending subscribers that were queued
    if (pending && pending.size > 0) {
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
      for (const ws of pending) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(snapshot);
          }
        } catch (err) {
          log.warn(`registerSession pending snapshot send failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      log.log(`registerSession sessionId=${sessionId} source=${source} subscribers=${session.subscribers.size} (${pending.size} were pending)`);
    } else {
      log.log(`registerSession sessionId=${sessionId} source=${source} subscribers=${session.subscribers.size}`);
    }
  }

  // ── Event application ─────────────────────────────────────────────

  /**
   * Maps a journal event to a streaming reducer and broadcasts the delta.
   * Called from publishJournalToUI for chat-category events.
   */
  applyEvent(sessionId: string, event: {
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
  }): void {
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
        prev = addToolCall(prev, event.toolName, event.toolCallId, event.arguments, event.narrative);
        break;

      case "tool_result":
        prev = resolveToolResult(prev, event.toolCallId, event.result, event.error, event.toolName, event.ts);
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
            });
          } else {
            prev = resolved;
          }
        }
        break;
      }

      case "model_info":
        prev = { ...prev, model: event.model || null, autoTier: event.autoTier || null };
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

    this.broadcastDelta(session, {
      sessionId,
      type: event.type,
      streamingContent: session.streamingContent,
      status: session.status,
      ...runtimeProjection(session),
    });
  }

  // ── Subscription ──────────────────────────────────────────────────

  subscribe(sessionId: string, ws: WebSocket, identity: SessionSubscriberIdentity = {}): SessionSnapshot | null {
    const priorIdentity = this.subscriberIdentities.get(ws) ?? {};
    const nextIdentity = { ...priorIdentity, ...identity };
    this.subscriberIdentities.set(ws, nextIdentity);
    let perSessionIdentities = this.sessionSubscriberIdentities.get(ws);
    if (!perSessionIdentities) {
      perSessionIdentities = new Map();
      this.sessionSubscriberIdentities.set(ws, perSessionIdentities);
    }
    perSessionIdentities.set(sessionId, nextIdentity);
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Queue as pending subscriber — will be drained when registerSession fires
      let pending = this.pendingSubscribers.get(sessionId);
      if (!pending) {
        pending = new Set();
        this.pendingSubscribers.set(sessionId, pending);
      }
      const before = pending.size;
      pending.add(ws);
      log.verbose(() => `SESSION:SUBSCRIBE:PENDING session=${sessionId} pending=${pending.size}`);
      return null;
    }

    const before = session.subscribers.size;
    session.subscribers.add(ws);
    const alreadySubscribed = before === session.subscribers.size;
    log.verbose(() => `SESSION:SUBSCRIBE session=${sessionId} subs=${session.subscribers.size} alreadySub=${alreadySubscribed}`);

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

  unsubscribe(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const identity = this.sessionSubscriberIdentities.get(ws)?.get(sessionId) ?? this.subscriberIdentities.get(ws);
      const before = session.subscribers.size;
      session.subscribers.delete(ws);
      log.verbose(() => `SESSION:UNSUBSCRIBE session=${sessionId} subs=${session.subscribers.size}`);
    }
    // Also clean up pending subscribers
    const pending = this.pendingSubscribers.get(sessionId);
    if (pending) {
      pending.delete(ws);
      if (pending.size === 0) this.pendingSubscribers.delete(sessionId);
    }
    this.sessionSubscriberIdentities.get(ws)?.delete(sessionId);
  }

  unsubscribeAll(ws: WebSocket): void {
    const identity = this.subscriberIdentities.get(ws);
    let removed = 0;
    for (const session of this.sessions.values()) {
      const before = session.subscribers.size;
      session.subscribers.delete(ws);
      if (before !== session.subscribers.size) removed++;
    }
    // Also clean up from all pending sets
    for (const [sessionId, pending] of this.pendingSubscribers) {
      pending.delete(ws);
      if (pending.size === 0) this.pendingSubscribers.delete(sessionId);
    }
    log.verbose(() => `SESSION:UNSUBSCRIBE_ALL removed=${removed}`);
    this.subscriberIdentities.delete(ws);
    this.sessionSubscriberIdentities.delete(ws);
  }

  // ── Finalization ──────────────────────────────────────────────────

  finalizeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.debug(`finalizeSession: no live session for sessionId=${sessionId}`);
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

    // Finalized state is already durable and terminal subscribers received the
    // authoritative delta above. Remove the runtime entry after the recovery
    // window even when clients remain subscribed; a future duplicate subscribe
    // will receive an idle snapshot, while a new run registers a fresh entry.
    session.cleanupTimer = setTimeout(() => {
      const current = this.sessions.get(sessionId);
      if (current !== session || current.status === "streaming") return;
      this.sessions.delete(sessionId);
      log.debug(`cleanup: removed finalized session sessionId=${sessionId} subscribers=${session.subscribers.size}`);
    }, 60_000);
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
    session.eventSeq += 1;
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
