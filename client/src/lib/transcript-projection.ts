/**
 * transcript-projection.ts
 *
 * Pure transcript projection reducer for SessionTranscriptPanel.
 *
 * Computes the final display state from inputs: persisted messages, active
 * stream projection, optimistic local pending turn, voice UI chrome state,
 * and frozen stream handoff. The component orchestrates state/effects;
 * this module decides transcript truth.
 *
 * One Discriminant Per Decision: the output carries a single
 * `assistantActivity` discriminant that tells the renderer exactly what
 * the assistant is doing right now.
 */

import type { ChatMessage as Message } from "@/components/chat-shared";
import type { PendingChatTurn } from "@/hooks/use-chat-send";
import { initialStreamingContent, type StreamingContent } from "@shared/streaming-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inputs to the transcript projection — all values, no hooks. */
export interface TranscriptProjectionInput {
  /** Currently focused session ID. */
  activeSession: string | null;
  /** Raw persisted messages from the server, already sorted by createdAt. */
  persistedMessages: Message[];
  /** Raw streaming content from the session subscription. */
  rawStreaming: StreamingContent;
  /** Persisted session status from the DB poll (e.g. "streaming", "saved"). */
  persistedSessionStatus: string | null;
  /** Whether the WS subscription says the run is active. */
  subRunActive: boolean;
  /** WS subscription status (e.g. "streaming", "idle", "saved"). */
  subStatus: string;
  /** WS subscription updatedAt timestamp (ms). */
  subUpdatedAt: number | null;
  /** Optimistic pending user turn from the composer. */
  pendingTurn: PendingChatTurn | null;
  /** Whether a post is currently in-flight (legacy; always false now). */
  postSending: boolean;
  /** Previously frozen stream handoff, if any. */
  frozenStreamHandoff: FrozenStreamHandoff | null;
  /** Previous stabilization snapshot for transcript merge. */
  previousTranscript: TranscriptSnapshot | null;
  /** Whether messages contain a compaction boundary marker. */
  messagesContainCompactionBoundary: boolean;
}

export interface FrozenStreamHandoff {
  sessionId: string;
  renderId: string;
  streaming: StreamingContent;
  /** Authoritative live snapshot this frozen copy was captured from. */
  capturedFrom: StreamingContent;
  lowerBound: number | null;
}

export interface TranscriptSnapshot {
  sessionId: string | null;
  messages: Message[];
}

/**
 * One discriminant for what the assistant is doing right now.
 *
 * - `idle`:      No active turn. Render persisted messages only.
 * - `pending`:   User sent a message; waiting for server acknowledgment.
 * - `streaming`: Server is actively streaming assistant content.
 * - `frozen`:    Stream ended but persistence hasn't caught up yet.
 */
export type AssistantActivity = "idle" | "pending" | "streaming" | "frozen";

/** Output of the transcript projection. */
export interface TranscriptProjection {
  /** Messages to display, with stabilization applied. */
  displayMessages: Message[];
  /** Updated transcript snapshot for next render cycle. */
  transcriptSnapshot: TranscriptSnapshot;
  /** The streaming content to pass to the renderer. */
  displayStreaming: StreamingContent;
  /** Whether the session is considered actively running. */
  isSessionActive: boolean;
  /** The pending turn to render as an optimistic placeholder, or null. */
  renderPendingTurn: PendingChatTurn | null;
  /** Stable ID for the live stream assistant render target. */
  liveStreamRenderId: string | null;
  /** Combined ID for display (live or frozen). */
  displayLiveStreamRenderId: string | null;
  /** Whether any active streaming or pending state exists. */
  isStreaming: boolean;
  /** Single discriminant for assistant activity state. */
  assistantActivity: AssistantActivity;
  /** Whether the pending user turn's text matches a persisted message. */
  pendingTurnPersisted: boolean;
  /** Whether the visible pending turn was adopted by the server stream. */
  pendingWasAdoptedByServer: boolean;
  /** Whether a new frozen handoff should be captured (computed, not set). */
  shouldCaptureFrozenHandoff: boolean;
  /** The frozen handoff to capture, if shouldCaptureFrozenHandoff is true. */
  newFrozenHandoff: FrozenStreamHandoff | null;
  /** Whether the frozen handoff should be cleared. */
  shouldClearFrozenHandoff: boolean;
  /** Whether the pending turn should be cleared due to server persistence. */
  shouldClearPendingTurn: boolean;
  /** Render revision string for scroll pinning. */
  renderRevision: string;
  /** Whether transcript stabilization is active (for debug tracing). */
  transcriptStabilizationActive: boolean;
}

// ---------------------------------------------------------------------------
// Helpers (moved from session-transcript-panel.tsx)
// ---------------------------------------------------------------------------

export function normalizeChatText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function getMessageTs(message: Message): number {
  const ts = new Date(message.createdAt).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

export function sortMessagesByCreatedAt(messages: Message[]): Message[] {
  return [...messages].sort((a, b) => getMessageTs(a) - getMessageTs(b));
}

export function summarizeMessageIds(messages: Message[]): string[] {
  return messages.map((message) => `${message.id}:${message.role}:${message.content?.length ?? 0}:${message.segmentChronology?.length ?? 0}`);
}

export function hasCompactionBoundary(messages: Message[]): boolean {
  return messages.some((message) => message.model === "compaction-marker");
}

function isTerminalAssistantMessage(message: Message): boolean {
  return message.role === "assistant"
    && !message.id.startsWith("draft-")
    && message.assistantState !== "streaming";
}

export function freezeStreamingContent(streaming: StreamingContent): StreamingContent {
  return {
    ...streaming,
    source: null,
    segments: streaming.segments.map((segment) => segment.type === "content"
      ? { ...segment }
      : { ...segment, steps: segment.steps.map((step) => ({ ...step, status: step.status === "active" ? "done" : step.status })) }
    ),
  };
}

export function computeStreamingRevision(streaming: StreamingContent): number {
  if (streaming.segments.length === 0) return 0;
  return streaming.segments.reduce((total, segment) => {
    if (segment.type === "content") return total + segment.content.length;
    return total + segment.steps.reduce((stepTotal, step) => {
      return stepTotal
        + step.id.length
        + step.type.length
        + (step.status?.length ?? 0)
        + (step.thinking?.length ?? 0)
        + (step.toolName?.length ?? 0)
        + (step.narrative?.length ?? 0)
        + (step.systemStepName?.length ?? 0)
        + (step.systemStepDetail?.length ?? 0)
        + (step.result ? JSON.stringify(step.result).length : 0)
        + (step.error?.length ?? 0);
    }, 0);
  }, 0);
}

// ---------------------------------------------------------------------------
// Core projection
// ---------------------------------------------------------------------------

/**
 * Pure function that computes the complete transcript projection from inputs.
 * No React hooks, no side effects, no DOM access. The component owns state
 * transitions (setting frozen handoff, clearing pending turn); this function
 * only computes what _should_ happen.
 */
export function buildTranscriptProjection(input: TranscriptProjectionInput): TranscriptProjection {
  const {
    activeSession,
    persistedMessages,
    rawStreaming,
    persistedSessionStatus,
    subRunActive,
    subStatus,
    subUpdatedAt,
    pendingTurn,
    postSending,
    frozenStreamHandoff,
    previousTranscript,
    messagesContainCompactionBoundary,
  } = input;

  // --- Session activity ---
  const isSessionActive =
    subRunActive ||
    subStatus === "streaming" ||
    (subStatus === "idle" && persistedSessionStatus === "streaming");

  // --- Visible pending turn ---
  const visiblePendingTurn = pendingTurn && (
    pendingTurn.sessionId === null ||
    pendingTurn.sessionId === activeSession ||
    activeSession === null
  ) ? pendingTurn : null;

  const terminalStreamAvailable =
    !isSessionActive &&
    (subStatus === "saved" || subStatus === "error") &&
    rawStreaming.source === null &&
    rawStreaming.segments.length > 0;
  const terminalLowerBound = visiblePendingTurn
    ? new Date(visiblePendingTurn.submittedAt).getTime()
    : frozenStreamHandoff?.lowerBound ?? null;
  const terminalAssistantNowPersisted = terminalStreamAvailable && persistedMessages.some((message) => {
    if (!isTerminalAssistantMessage(message)) return false;
    if (
      rawStreaming.runId &&
      message.assistantRunId &&
      message.assistantRunId !== rawStreaming.runId
    ) return false;
    if (
      rawStreaming.turnId &&
      message.turnId &&
      message.turnId !== rawStreaming.turnId
    ) return false;
    if (terminalLowerBound !== null && new Date(message.createdAt).getTime() < terminalLowerBound) return false;
    return (message.content || "").trim().length > 0 || (message.segmentChronology?.length ?? 0) > 0;
  });
  // The terminal server payload is the last authoritative live snapshot. Keep
  // it for the overlap render while the frozen handoff clears, then let the
  // durably terminal assistant message become the sole source of truth.
  const hasAuthoritativeTerminalStream = terminalStreamAvailable && (
    !terminalAssistantNowPersisted || frozenStreamHandoff !== null
  );
  const streaming = isSessionActive || hasAuthoritativeTerminalStream
    ? rawStreaming
    : initialStreamingContent;

  // --- Pending turn persistence check ---
  const pendingTurnPersisted = (() => {
    if (!visiblePendingTurn) return false;
    const submittedAt = new Date(visiblePendingTurn.submittedAt).getTime();
    const expected = normalizeChatText(visiblePendingTurn.content || "");
    return persistedMessages.some((message) => {
      if (message.role !== "user" || message.id.startsWith("draft-")) return false;
      const createdAt = new Date(message.createdAt).getTime();
      if (Number.isFinite(createdAt) && createdAt < submittedAt - 5000) return false;
      return normalizeChatText(message.content || "") === expected;
    });
  })();

  // --- Should clear pending turn (assistant reply persisted) ---
  const pendingSubmittedAtMs = visiblePendingTurn ? new Date(visiblePendingTurn.submittedAt).getTime() : null;
  const assistantHasVisiblePersistedReply = (() => {
    if (!visiblePendingTurn || !pendingTurnPersisted) return false;
    const pendingSubmittedAt = new Date(visiblePendingTurn.submittedAt).getTime();
    return persistedMessages.some((message) => {
      if (!isTerminalAssistantMessage(message)) return false;
      if (new Date(message.createdAt).getTime() < pendingSubmittedAt) return false;
      return (message.content || "").trim().length > 0 || (message.segmentChronology?.length ?? 0) > 0;
    });
  })();

  const pendingWasAdoptedByServer = visiblePendingTurn?.status === "streaming";

  // --- Streaming state derivation ---
  const streamUpdatedAt = subUpdatedAt;
  const streamIsFreshForPendingTurn =
    pendingSubmittedAtMs === null ||
    (streamUpdatedAt !== null && streamUpdatedAt >= pendingSubmittedAtMs);
  const currentTurnStreaming = streamIsFreshForPendingTurn ? streaming : initialStreamingContent;
  const serverStreaming = isSessionActive && streamIsFreshForPendingTurn;
  const hasLiveStreamingState = serverStreaming && currentTurnStreaming.source !== null;
  // --- Render pending turn ---
  // Session activity alone is not an assistant presentation state. During
  // supersession the old run can publish a fresh terminal/idle snapshot before
  // the replacement publishes its source. Keep the optimistic Thinking turn
  // visible through that gap; only a concrete live assistant stream may adopt it.
  const renderPendingTurn = hasLiveStreamingState
    ? null
    : visiblePendingTurn;

  // --- Live stream render ID ---
  const liveStreamRenderId = hasLiveStreamingState
    ? currentTurnStreaming.assistantAttemptId
      ? `draft-assistant-attempt-${currentTurnStreaming.assistantAttemptId}`
      : visiblePendingTurn?.clientTurnId
        ? `draft-assistant-${visiblePendingTurn.clientTurnId}`
        : currentTurnStreaming.runId
          ? `draft-assistant-run-${currentTurnStreaming.runId}`
          : activeSession
            ? `draft-assistant-server-${activeSession}`
            : null
    : null;

  // --- Frozen handoff decisions ---
  const shouldCaptureFrozenHandoff = !!(
    activeSession &&
    hasLiveStreamingState &&
    liveStreamRenderId &&
    currentTurnStreaming.segments.length > 0 &&
    (
      frozenStreamHandoff?.sessionId !== activeSession ||
      frozenStreamHandoff.renderId !== liveStreamRenderId ||
      frozenStreamHandoff.capturedFrom !== currentTurnStreaming
    )
  );

  const newFrozenHandoff: FrozenStreamHandoff | null = shouldCaptureFrozenHandoff
    ? (() => {
        const lowerBound = visiblePendingTurn
          ? new Date(visiblePendingTurn.submittedAt).getTime()
          : persistedMessages.length > 0
            ? (() => {
                const lastUser = [...persistedMessages].reverse().find((m) => m.role === "user");
                return lastUser ? new Date(lastUser.createdAt).getTime() : null;
              })()
            : null;
        return {
          sessionId: activeSession!,
          renderId: liveStreamRenderId!,
          streaming: freezeStreamingContent(currentTurnStreaming),
          capturedFrom: currentTurnStreaming,
          lowerBound: Number.isFinite(lowerBound) ? lowerBound : null,
        };
      })()
    : null;

  const frozenAssistantNowPersisted = frozenStreamHandoff
    ? persistedMessages.some((message) => {
        if (!isTerminalAssistantMessage(message)) return false;
        if (
          frozenStreamHandoff.streaming.runId &&
          message.assistantRunId &&
          message.assistantRunId !== frozenStreamHandoff.streaming.runId
        ) return false;
        if (frozenStreamHandoff.lowerBound !== null && new Date(message.createdAt).getTime() < frozenStreamHandoff.lowerBound) return false;
        return (message.content || "").trim().length > 0 || (message.segmentChronology?.length ?? 0) > 0;
      })
    : false;

  const shouldClearFrozenHandoff = frozenStreamHandoff !== null && (
    frozenStreamHandoff.sessionId !== activeSession ||
    hasLiveStreamingState ||
    frozenAssistantNowPersisted
  );

  // Persisted replacement and frozen stream must overlap for one committed render.
  // Clearing during projection removes the draft in the same render that mounts the
  // persisted turn, which makes React tear down the visible content before the new
  // tree is painted under load. Keep the frozen handoff for this render, then let
  // the projection-driven effect clear it after paint. MessageList suppresses the
  // persisted duplicate while this overlap is active.
  const effectiveFrozenHandoff = frozenStreamHandoff?.sessionId === activeSession && !hasLiveStreamingState
    ? frozenStreamHandoff
    : null;

  const terminalRenderId = hasAuthoritativeTerminalStream
    ? rawStreaming.assistantAttemptId
      ? `draft-assistant-attempt-${rawStreaming.assistantAttemptId}`
      : rawStreaming.runId
        ? `draft-assistant-run-${rawStreaming.runId}`
        : effectiveFrozenHandoff?.renderId ?? (activeSession ? `draft-assistant-server-${activeSession}` : null)
    : null;

  // Live state wins first. At terminal settlement, the final server payload wins
  // over the effect-captured frozen copy, which can be one event behind.
  const displayStreaming = hasLiveStreamingState
    ? currentTurnStreaming
    : hasAuthoritativeTerminalStream
      ? rawStreaming
      : effectiveFrozenHandoff?.sessionId === activeSession
        ? effectiveFrozenHandoff.streaming
        : currentTurnStreaming;

  const displayLiveStreamRenderId = liveStreamRenderId ?? terminalRenderId ?? (
    effectiveFrozenHandoff?.sessionId === activeSession ? effectiveFrozenHandoff.renderId : null
  );

  const hasFrozenHandoff = !hasLiveStreamingState && (
    hasAuthoritativeTerminalStream || effectiveFrozenHandoff?.sessionId === activeSession
  );
  const isStreaming = hasLiveStreamingState || hasFrozenHandoff || postSending || !!renderPendingTurn;

  // --- Transcript stabilization ---
  const transcriptStabilizationActive = !!visiblePendingTurn || hasLiveStreamingState || postSending;

  const { displayMessages, transcriptSnapshot } = (() => {
    if (previousTranscript?.sessionId !== activeSession || !transcriptStabilizationActive || messagesContainCompactionBoundary) {
      const snapshot: TranscriptSnapshot = { sessionId: activeSession, messages: persistedMessages };
      return { displayMessages: persistedMessages, transcriptSnapshot: snapshot };
    }

    const byId = new Map<string, Message>();
    for (const message of previousTranscript.messages) byId.set(message.id, message);
    for (const message of persistedMessages) byId.set(message.id, message);
    const merged = sortMessagesByCreatedAt([...byId.values()]);

    const snapshot: TranscriptSnapshot = { sessionId: activeSession, messages: merged };
    return { displayMessages: merged, transcriptSnapshot: snapshot };
  })();

  // --- Should clear pending turn ---
  // The server can briefly finalize the interrupted run before starting its
  // replacement. That terminal snapshot must not clear an accepted pending turn:
  // there is still no assistant reply for it, and clearing loses the causal anchor
  // that lets the replacement stream render under the new user message.
  const shouldClearPendingTurn = assistantHasVisiblePersistedReply;

  // --- One discriminant for assistant activity ---
  const assistantActivity: AssistantActivity =
    hasLiveStreamingState ? "streaming"
    : hasFrozenHandoff ? "frozen"
    : renderPendingTurn ? "pending"
    : "idle";

  // --- Render revision ---
  const renderRevision = [
    activeSession ?? "no-session",
    displayMessages
      .map((m) => `${m.id}:${m.createdAt}:${m.role}:${m.content?.length ?? 0}:${m.segmentChronology?.length ?? 0}`)
      .join("|"),
    visiblePendingTurn
      ? `optimistic:${visiblePendingTurn.clientTurnId}:${visiblePendingTurn.status}:${visiblePendingTurn.content.length}`
      : "optimistic:none",
    renderPendingTurn
      ? `pending:${renderPendingTurn.clientTurnId}:${renderPendingTurn.status}:${renderPendingTurn.content.length}`
      : "pending:none",
    displayLiveStreamRenderId ?? "no-live-stream",
    String(computeStreamingRevision(displayStreaming)),
    hasFrozenHandoff ? "frozen" : "live-or-none",
    // voice revision excluded — still computed in the component from voiceSession hook
  ].join("::");

  return {
    displayMessages,
    transcriptSnapshot,
    displayStreaming,
    isSessionActive,
    renderPendingTurn,
    liveStreamRenderId,
    displayLiveStreamRenderId,
    isStreaming,
    assistantActivity,
    pendingTurnPersisted,
    pendingWasAdoptedByServer,
    shouldCaptureFrozenHandoff,
    newFrozenHandoff,
    shouldClearFrozenHandoff,
    shouldClearPendingTurn,
    renderRevision,
    transcriptStabilizationActive,
  };
}
