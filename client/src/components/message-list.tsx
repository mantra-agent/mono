import { useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import { ChatEmptyState } from "@/components/chat-empty-state";
import {
  ChatTurn,
  type ChatMessage as Message,
  type ChildSessionBlockMeta,
  type CrossSessionMeta,
} from "@/components/chat-shared";
import type { StreamingContent } from "@shared/streaming-types";
import type { SessionStreamMap } from "@/hooks/use-session-subscription";
import type { PendingChatTurn } from "@/hooks/use-chat-send";
import { VoiceTranscriptBubble, VoiceThinkingBubble } from "@/components/voice-session-ui";
import type { VoiceTranscriptEntry } from "@/hooks/use-voice-session";
import { useVisibilityLayer } from "@/hooks/use-visibility-layer";
import {
  ChildSessionBlock,
  CrossSessionAnnotation,
  useLiveSessionBlocks,
} from "@/components/inline-session-blocks";
import { SystemNoticeMessage, parseSystemNotice } from "@/components/system-notice-message";
import { createLogger } from "@/lib/logger";

const log = createLogger("MessageList");

interface MessageListProps {
  messages: Message[];
  streaming: StreamingContent;
  isSessionStreaming: boolean;
  msgsLoading: boolean;
  activeSession: string | null;
  sessionKey?: string | null;
  voiceActive: boolean;
  showVoiceTools: boolean;
  voiceStepsInsertIndex: number;
  voiceStatus: string;
  voiceTranscript: VoiceTranscriptEntry[];
  voiceThinking?: boolean;
  /** Human-readable session titles keyed by session id for legacy cross-session messages without labels. */
  sessionTitleById?: Record<string, string>;
  /** Parent-owned live stream cache for child session widgets. */
  sessionStreams?: SessionStreamMap;
  pendingTurn?: PendingChatTurn | null;
  optimisticUserTurn?: PendingChatTurn | null;
  liveStreamRenderId?: string | null;
}

type ListItem =
  | { kind: "message"; msg: Message; ts: number }
  | { kind: "voice_transcript"; entry: VoiceTranscriptEntry; index: number; ts: number }
  | { kind: "live_child"; meta: ChildSessionBlockMeta; ts: number }
  | { kind: "live_cross"; id: string; meta: CrossSessionMeta; content: string; ts: number };

function normalizeTranscriptText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function transcriptRoleMatchesMessage(entry: VoiceTranscriptEntry, msg: Message): boolean {
  if (entry.source === "user") return msg.role === "user";
  if (entry.source === "ai") return msg.role === "assistant";
  return false;
}

function transcriptMatchesPersistedMessage(entry: VoiceTranscriptEntry, msg: Message): boolean {
  if (!transcriptRoleMatchesMessage(entry, msg)) return false;
  const persistedTurnKey = msg.voice?.turnKey;
  if (entry.turnKey && persistedTurnKey === entry.turnKey) return true;
  if (entry.turnId && persistedTurnKey && (persistedTurnKey === entry.turnId || persistedTurnKey.endsWith(`:${entry.turnId}`))) return true;
  const transcriptText = normalizeTranscriptText(entry.message);
  if (!transcriptText) return false;
  const messageText = normalizeTranscriptText(msg.content || "");
  return transcriptText === messageText;
}

function getTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

const CHAT_HIDDEN_VOICE_SETUP_STEPS = new Set([
  "tool_use",
  "thinking",
  "engine_setup",
  "signed_url",
]);

function hasVisibleSystemStepPayload(msg: Message): boolean {
  const steps = Array.isArray(msg.systemSteps) ? msg.systemSteps : [];
  if (steps.length === 0) return false;
  return steps.some(step => !CHAT_HIDDEN_VOICE_SETUP_STEPS.has(step.name));
}

function hasVisibleChronologyPayload(msg: Message): boolean {
  if (!Array.isArray(msg.segmentChronology) || msg.segmentChronology.length === 0) return false;
  const steps = Array.isArray(msg.systemSteps) ? msg.systemSteps : [];
  return msg.segmentChronology.some(entry => {
    if (entry.s === "content") return Boolean((entry.c || "").trim());
    if (entry.s === "thinking") return Boolean((entry.c || msg.thinking || "").trim());
    if (entry.s === "tool") return true;
    if (entry.s === "system") {
      const step = steps[entry.i];
      return Boolean(step && !CHAT_HIDDEN_VOICE_SETUP_STEPS.has(step.name));
    }
    return false;
  });
}

function hasRenderableAssistantPayload(msg: Message): boolean {
  if (msg.role !== "assistant") return true;
  if ((msg.content || "").trim().length > 0) return true;
  if ((msg.thinking || "").trim().length > 0) return true;
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return true;
  if (hasVisibleSystemStepPayload(msg)) return true;
  if (hasVisibleChronologyPayload(msg)) return true;
  return false;
}


function hasChildSessionId(meta: ChildSessionBlockMeta | null | undefined): meta is ChildSessionBlockMeta {
  return typeof meta?.childSessionId === "string" && meta.childSessionId.length > 0;
}

function getChildSessionChronologyTs(
  meta: ChildSessionBlockMeta,
  fallback: number,
  childStream?: SessionStreamMap[string],
): number {
  if (childStream?.updatedAt && childStream.status === "streaming") return childStream.updatedAt;

  // Child-session block updates are lifecycle mutations, not new transcript events.
  // Sorting completed blocks by updatedAt moves Step N below the parent status
  // notice written after completion, which breaks the inline plan chronology.
  return getTimestamp(meta.startedAt, fallback);
}

function getVisibleVoiceTranscript(
  transcript: VoiceTranscriptEntry[],
  persistedMessages: Message[],
): Array<{ entry: VoiceTranscriptEntry; index: number; ts: number }> {
  const seen = new Set<string>();
  const userTurnsBackInInput = new Set<string>();

  for (const entry of transcript) {
    if (entry.source !== "user" || !entry.turnId) continue;
    if (entry.isFinal === false) userTurnsBackInInput.add(entry.turnId);
    else if (entry.isFinal === true) userTurnsBackInInput.delete(entry.turnId);
  }

  return transcript
    .map((entry, index) => ({ entry, index, ts: getTimestamp(entry.timestamp, Date.now() + index) }))
    .filter(({ entry, index }) => {
      if (!entry.message.trim()) return false;
      if (entry.source === "user" && entry.turnId && userTurnsBackInInput.has(entry.turnId)) return false;
      if (entry.source === "user" && entry.isFinal === false) return false;
      const key = entry.turnKey || entry.transcriptId || entry.turnId || `${entry.source}:${normalizeTranscriptText(entry.message)}:${index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (entry.source === "system") return true;
      return !persistedMessages.some((msg) => transcriptMatchesPersistedMessage(entry, msg));
    });
}

function isOutgoingChildMessage(msg: Pick<Message, "crossSession">, activeSession: string | null): boolean {
  const crossSession = msg.crossSession;
  return !!(
    activeSession &&
    crossSession?.direction === "child" &&
    crossSession.fromSessionId === activeSession
  );
}

export function MessageList({
  messages,
  streaming,
  isSessionStreaming,
  msgsLoading,
  activeSession,
  sessionKey,
  voiceActive,
  showVoiceTools,
  voiceStepsInsertIndex,
  voiceStatus,
  voiceTranscript,
  voiceThinking,
  sessionTitleById,
  sessionStreams,
  pendingTurn,
  optimisticUserTurn,
  liveStreamRenderId,
}: MessageListProps) {
  const { layer } = useVisibilityLayer();
  const { childBlocks, crossMessages } = useLiveSessionBlocks(activeSession);
  const liveDraftCreatedAtRef = useRef<{ id: string; createdAt: string; ts: number } | null>(null);
  // Keep optimistic and server-empty Thinking on the same render path. When
  // the assistant is known to be working but no server segments are visible yet,
  // expose an active empty stream instead of fabricating a fake timeline step.
  // NOTE: This hook MUST stay above all early returns to avoid React error #310
  // ("Rendered more hooks than during the previous render").
  const effectiveStreaming = useMemo(() => {
    if ((isSessionStreaming || pendingTurn) && streaming.segments.length === 0) {
      return {
        ...streaming,
        source: streaming.source ?? "text" as const,
      };
    }
    return streaming;
  }, [isSessionStreaming, pendingTurn, streaming]);

  if (msgsLoading && voiceStatus !== "connecting") {
    return (
      <div className="flex items-center justify-center py-12" data-testid="messages-loading">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasLive = childBlocks.length > 0 || crossMessages.length > 0;
  if (
    messages.length === 0 &&
    !isSessionStreaming &&
    !pendingTurn &&
    streaming.segments.length === 0 &&
    !voiceTranscript.length &&
    voiceStatus !== "connecting" &&
    !hasLive
  ) {
    return (
      <ChatEmptyState className="min-h-[calc(100dvh-160px)] py-12" />
    );
  }

  const persistedChildIds = new Set(
    messages
      .filter(m => m.role === "child_session_block" && hasChildSessionId(m.childSession))
      .map(m => m.childSession.childSessionId)
  );
  const persistedCrossKeys = new Set(
    messages
      .filter(m => m.role === "cross_session" && m.crossSession)
      .map(m => `${m.crossSession!.fromSessionId}:${m.crossSession!.toSessionId}:${m.createdAt}`)
  );
  const visibleVoiceTranscript = getVisibleVoiceTranscript(voiceTranscript, messages);

  const latestPersistedChildMessageId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === "child_session_block" && hasChildSessionId(msg.childSession)) {
      latestPersistedChildMessageId.set(msg.childSession.childSessionId, msg.id);
    }
  }

  const items: ListItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && !msg.id.startsWith("draft-") && !hasRenderableAssistantPayload(msg)) continue;
    if (msg.role === "cross_session" && isOutgoingChildMessage(msg, activeSession)) continue;
    if (msg.role === "child_session_block" && hasChildSessionId(msg.childSession)) {
      if (latestPersistedChildMessageId.get(msg.childSession.childSessionId) !== msg.id) continue;
    }
    const childStream = msg.role === "child_session_block" && hasChildSessionId(msg.childSession)
      ? sessionStreams?.[msg.childSession.childSessionId]
      : undefined;
    // Compaction markers sort to the very beginning so the subsequent splice
    // (which removes everything before the first marker) never eats the kept
    // messages that have older timestamps than the marker itself.
    const ts = msg.model === "compaction-marker"
      ? 0
      : msg.role === "child_session_block" && hasChildSessionId(msg.childSession)
        ? getChildSessionChronologyTs(msg.childSession, new Date(msg.createdAt).getTime(), childStream)
        : new Date(msg.createdAt).getTime();
    items.push({ kind: "message", msg, ts });
  }
  for (const vt of visibleVoiceTranscript) {
    items.push({ kind: "voice_transcript", entry: vt.entry, index: vt.index, ts: vt.ts });
  }
  for (const lc of childBlocks) {
    if (!hasChildSessionId(lc.meta)) {
      log.warn("Skipping malformed live child session block", { activeSession, block: lc.meta });
      continue;
    }
    if (persistedChildIds.has(lc.meta.childSessionId)) continue;
    items.push({ kind: "live_child", meta: lc.meta, ts: getChildSessionChronologyTs(lc.meta, lc.receivedAt, sessionStreams?.[lc.meta.childSessionId]) });
  }
  for (const cm of crossMessages) {
    const key = `${cm.meta.fromSessionId}:${cm.meta.toSessionId}:${cm.receivedAt}`;
    if (persistedCrossKeys.has(key)) continue;
    if (isOutgoingChildMessage({ crossSession: cm.meta }, activeSession)) continue;
    items.push({ kind: "live_cross", id: cm.id, meta: cm.meta, content: cm.content, ts: cm.receivedAt });
  }
  items.sort((a, b) => a.ts - b.ts);
  const optimisticUserSubmittedAt = optimisticUserTurn ? getTimestamp(optimisticUserTurn.submittedAt, Date.now()) : null;
  let persistedOptimisticUserId: string | null = null;
  const optimisticUserAlreadyPersisted = optimisticUserTurn
    ? messages.some((msg) => {
      if (msg.role !== "user" || msg.id.startsWith("draft-")) return false;
      const ts = getTimestamp(msg.createdAt, 0);
      if (optimisticUserSubmittedAt !== null && ts < optimisticUserSubmittedAt - 5000) return false;
      const matches = normalizeTranscriptText(msg.content || "") === normalizeTranscriptText(optimisticUserTurn.content || "");
      if (matches) persistedOptimisticUserId = msg.id;
      return matches;
    })
    : false;
  const optimisticUserDraftId = optimisticUserTurn ? `draft-user-${optimisticUserTurn.clientTurnId}` : null;
  if (optimisticUserTurn && !optimisticUserAlreadyPersisted) {
    // The optimistic user belongs after the existing transcript prefix by
    // causality, even if the client/server clocks disagree. Do not sort this
    // synthetic turn by timestamp; doing so lets the active turn interleave with
    // completed history and makes previous assistant turns visually unstable.
    const lastTs = items.length > 0 ? items[items.length - 1].ts : (optimisticUserSubmittedAt ?? Date.now());
    const optimisticUserMessage: Message = {
      id: optimisticUserDraftId!,
      sessionId: optimisticUserTurn.sessionId || activeSession || "",
      role: "user",
      content: optimisticUserTurn.content,
      thinking: null,
      toolCalls: null,
      systemSteps: null,
      model: null,
      createdAt: optimisticUserTurn.submittedAt,
    };
    items.push({ kind: "message", msg: optimisticUserMessage, ts: lastTs + 1 });
  }

  // Hide messages that precede the first compaction marker — they've been
  // summarized and should not appear in the UI.
  const firstCompactionIdx = items.findIndex(
    it => it.kind === "message" && it.msg.model === "compaction-marker"
  );
  if (firstCompactionIdx > 0) {
    items.splice(0, firstCompactionIdx);
  }

  // Compaction widget renders at index 0 (above kept messages).
  // The kept messages follow chronologically after it.

  // The active turn anchor must follow the same logical turn even when
  // SessionTranscriptPanel suppresses `pendingTurn` because live streaming has started. The
  // optimistic user turn remains the causal anchor until the persisted user is
  // available. Falling back to the last persisted user in that interval puts the
  // live "Thinking..." assistant between the previous user and previous
  // assistant, which is the jump Ray observed.
  const activeTurn = pendingTurn ?? optimisticUserTurn ?? null;
  const activeTurnSubmittedAt = activeTurn ? new Date(activeTurn.submittedAt).getTime() : null;
  const pendingSubmittedAt = activeTurnSubmittedAt;
  let lastUserBeforeStream: Message | null = null;
  let lastUserBeforeStreamIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.id.startsWith("draft-")) continue;
    if (m.role === "user") {
      lastUserBeforeStream = m;
      lastUserBeforeStreamIndex = i;
      break;
    }
  }
  const lastUserSubmittedAt = lastUserBeforeStream ? getTimestamp(lastUserBeforeStream.createdAt, 0) : null;
  const streamTurnLowerBound = activeTurnSubmittedAt ?? lastUserSubmittedAt ?? null;

  let persistedUserForPendingTurnIndex = -1;
  if (activeTurn) {
    const expected = normalizeTranscriptText(activeTurn.content || "");
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.id.startsWith("draft-") || m.role !== "user") continue;
      const ts = getTimestamp(m.createdAt, 0);
      if (activeTurnSubmittedAt !== null && ts < activeTurnSubmittedAt - 5000) continue;
      if (normalizeTranscriptText(m.content || "") === expected) {
        persistedUserForPendingTurnIndex = i;
        break;
      }
    }
  }
  const activeTurnUserId = activeTurn
    ? (persistedUserForPendingTurnIndex >= 0 ? messages[persistedUserForPendingTurnIndex].id : optimisticUserDraftId)
    : lastUserBeforeStream?.id ?? null;
  let activeTurnUserItemIndex = activeTurnUserId
    ? items.findIndex((item) => item.kind === "message" && item.msg.id === activeTurnUserId)
    : -1;
  if (activeTurnUserItemIndex < 0 && lastUserBeforeStream?.id) {
    activeTurnUserItemIndex = items.findIndex((item) => item.kind === "message" && item.msg.id === lastUserBeforeStream!.id);
  }
  const streamTurnAnchorIndex = activeTurn
    ? persistedUserForPendingTurnIndex
    : lastUserBeforeStreamIndex;

  let persistedAssistantForStreamingTurn: Message | null = null;
  if (activeTurnUserItemIndex >= 0) {
    for (let i = activeTurnUserItemIndex + 1; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== "message") continue;
      if (item.msg.role === "user") break;
      if (item.msg.role !== "assistant" || item.msg.id.startsWith("draft-")) continue;
      persistedAssistantForStreamingTurn = item.msg;
    }
  }
  // The server SessionManager is authoritative for live stream rendering. A
  // local pending turn gives us a stronger draft id for the turn this client
  // submitted, but it is not required permission to render an already-running
  // subscribed session when focus changes.
  const hasVisibleStreamingPayload = effectiveStreaming.segments.some((segment) => {
    if (segment.type === "content") return segment.content.trim().length > 0;
    if (segment.type === "timeline") {
      return segment.steps.some((step) => {
        if (step.type === "thinking") return step.status === "active" || Boolean(step.thinking?.trim());
        if (step.type === "tool_call") return step.status === "active" || Boolean(step.result) || Boolean(step.error);
        if (step.type === "system") return !CHAT_HIDDEN_VOICE_SETUP_STEPS.has(step.systemStepName ?? "");
        return true;
      });
    }
    return false;
  });
  const hasActiveAssistantPlaceholder =
    !!activeTurn &&
    effectiveStreaming.segments.length === 0 &&
    effectiveStreaming.source !== null &&
    (isSessionStreaming || !!pendingTurn);
  const hasRenderableStreamForTurn = hasVisibleStreamingPayload || hasActiveAssistantPlaceholder;
  const hasServerAuthoritativeStream =
    !!activeSession &&
    effectiveStreaming.segments.length > 0 &&
    (isSessionStreaming || !!liveStreamRenderId);
  const activeTurnKey = activeTurn
    ? activeTurn.clientTurnId
    : activeSession
      ? `server-${activeSession}`
      : null;
  const activeStreamingDraftId = activeTurnKey
    ? `draft-assistant-${activeTurnKey}`
    : hasServerAuthoritativeStream
      ? liveStreamRenderId ?? `draft-assistant-server-${activeSession}`
      : null;
  const needsStreamingTarget =
    !!activeStreamingDraftId &&
    hasRenderableStreamForTurn;

  const hiddenStreamingCheckpointIds: string[] = [];
  if (needsStreamingTarget && activeTurnUserItemIndex >= 0) {
    // Active streaming is scoped to the active user turn only. Suppress only
    // assistant checkpoint messages between that user and the next user, and
    // only after the live stream has visible payload worth replacing them with.
    // On mobile resume/login, stale WS state can briefly report a session as
    // streaming while the stream contains only layer-hidden lifecycle steps;
    // saved assistant text must remain authoritative in that state.
    for (let i = items.length - 1; i > activeTurnUserItemIndex; i--) {
      const it = items[i];
      if (it.kind !== "message") continue;
      if (it.msg.role === "user") break;
      if (it.msg.role !== "assistant" || it.msg.id.startsWith("draft-")) continue;
      if (hasRenderableAssistantPayload(it.msg) && !hasVisibleStreamingPayload) continue;
      hiddenStreamingCheckpointIds.push(it.msg.id);
      items.splice(i, 1);
    }
  }

  let streamingTargetIdx = -1;
  if (needsStreamingTarget && activeStreamingDraftId) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "message" && it.msg.id === activeStreamingDraftId) {
        streamingTargetIdx = i;
        break;
      }
    }
    if (streamingTargetIdx === -1) {
      if (liveDraftCreatedAtRef.current?.id !== activeStreamingDraftId) {
        const anchorTs = activeTurnUserItemIndex >= 0 ? items[activeTurnUserItemIndex].ts : Date.now();
        const createdAt = activeTurnUserItemIndex >= 0 && items[activeTurnUserItemIndex].kind === "message"
          ? items[activeTurnUserItemIndex].msg.createdAt
          : activeTurn?.submittedAt ?? new Date().toISOString();
        liveDraftCreatedAtRef.current = {
          id: activeStreamingDraftId,
          createdAt,
          ts: anchorTs + 1,
        };
      }
      const draftCreatedAt = liveDraftCreatedAtRef.current.createdAt;
      const draftTs = liveDraftCreatedAtRef.current.ts;
      const draft: Message = {
        id: activeStreamingDraftId,
        sessionId: activeSession || "",
        role: "assistant",
        content: "",
        thinking: null,
        toolCalls: null,
        systemSteps: null,
        model: null,
        createdAt: draftCreatedAt,
      };
      const insertAt = activeTurnUserItemIndex >= 0 ? activeTurnUserItemIndex + 1 : items.length;
      items.splice(insertAt, 0, { kind: "message", msg: draft, ts: draftTs });
      streamingTargetIdx = insertAt;
    }
  }

  if (hasRenderableStreamForTurn || pendingTurn) {
    const selected = streamingTargetIdx >= 0 ? items[streamingTargetIdx] : null;
    log.debug("STREAM:TARGET:SELECT", {
      activeSession,
      clientTurnId: activeTurn?.clientTurnId ?? null,
      activeTurnKey,
      pendingStatus: activeTurn?.status ?? null,
      streamingSource: effectiveStreaming.source,
      segments: effectiveStreaming.segments.length,
      hasVisibleStreamingPayload,
      selectedIndex: streamingTargetIdx,
      selectedMessageId: selected?.kind === "message" ? selected.msg.id : null,
      needsStreamingTarget,
      isSessionStreaming,
      hiddenStreamingCheckpointIds,
    });
  }


  const renderItem = (item: ListItem, isLast: boolean, isStreamingTarget: boolean): JSX.Element => {
    if (item.kind === "voice_transcript") {
      return <VoiceTranscriptBubble key={`vt-${item.entry.transcriptId || item.entry.turnId || item.index}`} entry={item.entry} index={item.index} />;
    }
    if (item.kind === "live_child") {
      return (
        <ChildSessionBlock
          key={`live-child-${item.meta.childSessionId}`}
          meta={item.meta}
          sessionKey={sessionKey}
          depth={0}
          sessionTitleById={sessionTitleById}
          childStream={sessionStreams?.[item.meta.childSessionId]}
        />
      );
    }
    if (item.kind === "live_cross") {
      const perspective: "sender" | "receiver" = item.meta.fromSessionId === activeSession ? "sender" : "receiver";
      return (
        <CrossSessionAnnotation
          key={`live-cross-${item.id}`}
          meta={item.meta}
          content={item.content}
          perspective={perspective}
          sessionTitleById={sessionTitleById}
          childStream={sessionStreams?.[item.meta.childSessionId]}
        />
      );
    }
    const msg = item.msg;
    if (msg.role === "child_session_block" && msg.childSession) {
      return (
        <ChildSessionBlock
          key={msg.id}
          meta={msg.childSession}
          sessionKey={sessionKey}
          depth={0}
          sessionTitleById={sessionTitleById}
          childStream={sessionStreams?.[msg.childSession.childSessionId]}
        />
      );
    }
    if (msg.role === "cross_session" && msg.crossSession) {
      const perspective: "sender" | "receiver" = msg.crossSession.fromSessionId === activeSession ? "sender" : "receiver";
      const relatedSessionId = perspective === "sender"
        ? msg.crossSession.toSessionId
        : msg.crossSession.fromSessionId;
      return (
        <CrossSessionAnnotation
          key={msg.id}
          meta={msg.crossSession}
          content={msg.content}
          perspective={perspective}
          sessionTitleById={sessionTitleById}
          childStream={sessionStreams?.[relatedSessionId]}
        />
      );
    }
    if (msg.role === "system_notice") {
      const notice = parseSystemNotice(msg.content);
      if (notice) {
        return <SystemNoticeMessage key={msg.id} notice={notice} timestamp={msg.createdAt} />;
      }
    }
    return (
      <ChatTurn
        key={msg.id}
        message={msg}
        isLast={isLast}
        streaming={isStreamingTarget ? effectiveStreaming : undefined}
        sessionKey={sessionKey ?? undefined}
      />
    );
  };

  const elements: JSX.Element[] = [];

  for (let i = 0; i < items.length; i++) {
    const isLast =
      i === items.length - 1 &&
      visibleVoiceTranscript.length === 0 &&
      items[i].kind === "message";
    const isStreamingTarget = i === streamingTargetIdx;
    elements.push(renderItem(items[i], isLast, isStreamingTarget));
  }

  return (
    <>
      {elements}
      {voiceThinking && !isSessionStreaming && effectiveStreaming.segments.length === 0 && layer >= 2 && <VoiceThinkingBubble />}
    </>
  );
}
