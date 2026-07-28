/**
 * Voice turn data persistence — single-write architecture.
 *
 * Each message is persisted exactly once via the chat storage public API:
 *   - persistUserMessage: persists (or updates) the user transcript
 *   - persistAssistantMessage: persists the assistant response with tool calls
 *   - persistOrphanedTurnData: attaches orphaned tool calls / system steps
 *   - persistVoiceErrorMessage: persists an error message as an assistant turn
 */
import type { VoiceSession, VoiceToolCall, TurnContext } from "./types";
import { acquireSessionTurnLock, publishVoiceDiagnostic, publishVoiceEvent } from "./session";
import { accessVoiceChat, voiceChatAccessError } from "./chat-owner";
import { createLogger } from "../log";

const log = createLogger("VoiceLlm");

const TIMESTAMP_RE = /^\s*\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]\n]+\]\s*/;

function cleanVoiceTranscriptText(value: string): string {
  return value
    .replace(TIMESTAMP_RE, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function getVoiceUserOrdinal(conversationMessages: Array<{ role: string; content: string }>): number {
  return conversationMessages.filter((m) => m.role === "user").length;
}

export function getVoiceUserTurnKey(session: VoiceSession, userOrdinal: number): string {
  const chatScope = session.chatSessionId || session.chatSessionKey || session.id;
  return `${chatScope}:voice-user:${userOrdinal}`;
}

// ── User Message Persistence (single write) ──────────────────────────────

export async function persistUserMessage(
  session: VoiceSession,
  conversationMessages: Array<{ role: string; content: string }>,
  currentTurn: number,
  userTimestamp?: string,
  turnId?: string,
): Promise<string | null> {
  if (!session.chatSessionId) return null;
  const lastUserMsg = conversationMessages.filter(m => m.role === "user").pop();
  if (!lastUserMsg?.content) return null;

  const cleanContent = cleanVoiceTranscriptText(lastUserMsg.content);
  if (!cleanContent) return null;

  const computedUserOrdinal = getVoiceUserOrdinal(conversationMessages);
  const userOrdinal = session.prefixContinuation && session.lastPersistedUserOrdinal !== null
    ? session.lastPersistedUserOrdinal
    : computedUserOrdinal;
  const turnKey = session.prefixContinuation && session.lastPersistedUserTurnKey
    ? session.lastPersistedUserTurnKey
    : getVoiceUserTurnKey(session, userOrdinal);
  const access = await accessVoiceChat(
    session,
    "persist_user_message",
    (storage) => storage.upsertVoiceUserMessage(
      session.chatSessionId!,
      cleanContent,
      {
        source: "elevenlabs-voice",
        voiceSessionId: session.id,
        turnKey,
        turnId,
        userOrdinal,
        turnNumber: currentTurn,
      },
    ),
    { nullMeansUnavailable: true },
  );

  if (access.outcome === "chat_unavailable") {
    log.warn(`turn ${currentTurn} SINGLE_WRITE user discarded because owner-verified chat is unavailable convId=${session.chatSessionId}`);
    return null;
  }
  if (access.outcome === "superseded" || access.outcome === "persistence_disabled") return null;
  if (access.outcome === "owner_context_missing" || access.outcome === "storage_failure") {
    const error = voiceChatAccessError("persist_user_message", access);
    publishVoiceDiagnostic(session, "user_persist_failed", error.message, { turn: currentTurn, status: "error" });
    throw error;
  }
  const msg = access.value;
  const wasContinuation = session.prefixContinuation ? " prefixContinuation=true" : "";
  session.lastPersistedUserMessageId = msg.id;
  session.lastPersistedUserTurnKey = turnKey;
  session.lastPersistedUserOrdinal = userOrdinal;
  log.log(`turn ${currentTurn} SINGLE_WRITE user upserted msgId=${msg.id} turnKey=${turnKey} userOrdinal=${userOrdinal} computedOrdinal=${computedUserOrdinal}${wasContinuation} convId=${session.chatSessionId}`);
  return msg.id;
}

// ── Assistant Message Persistence (single write) ─────────────────────────

export async function persistAssistantMessage(
  session: VoiceSession,
  resultContent: string | null,
  currentTurn: number,
  timestamps?: { assistantTimestamp?: string },
  turnCtx?: TurnContext,
  turnId?: string,
): Promise<void> {
  if (!session.chatSessionId) return;
  const sanitizedAssistant = resultContent && resultContent.trim() ? resultContent : null;

  const releaseLock = await acquireSessionTurnLock(session.id);
  let turnToolCalls: VoiceToolCall[];
  try {
    if (turnCtx && (turnCtx.aborted || session.activeAssistantAttemptId !== turnCtx.assistantAttemptId)) {
      const discarded = session.toolCalls.filter((call) => call.assistantAttemptId === turnCtx.assistantAttemptId).length;
      session.toolCalls = session.toolCalls.filter((call) => call.assistantAttemptId !== turnCtx.assistantAttemptId);
      log.log(`turn ${currentTurn} assistant persistence discarded before mutation after supersession attempt=${turnCtx.assistantAttemptId} toolCalls=${discarded}`);
      return;
    }
    const attemptId = turnCtx?.assistantAttemptId;
    turnToolCalls = attemptId
      ? session.toolCalls.filter((call) => call.assistantAttemptId === attemptId)
      : [];
    session.toolCalls = attemptId
      ? session.toolCalls.filter((call) => call.assistantAttemptId !== attemptId)
      : session.toolCalls;
  } finally {
    releaseLock();
  }

  const systemSteps = turnCtx?.systemSteps && turnCtx.systemSteps.length > 0 ? [...turnCtx.systemSteps] : undefined;
  const visibleSegmentChronology = turnCtx?.segmentChronology?.filter((entry) => entry.s !== "system");
  const segmentChronology = visibleSegmentChronology && visibleSegmentChronology.length > 0 ? visibleSegmentChronology : undefined;
  if (!sanitizedAssistant && turnToolCalls.length === 0 && !segmentChronology) {
    log.debug(`turn ${currentTurn} SINGLE_WRITE assistant skipped empty no-op convId=${session.chatSessionId}`);
    return;
  }

  const toolCalls = turnToolCalls.length > 0
    ? turnToolCalls.map(tc => ({
        toolName: tc.name,
        status: ("done" as const),
        arguments: tc.args,
        result: tc.result,
        toolCallId: tc.callId,
      }))
    : undefined;

  const effectiveTurnId = turnId || turnCtx?.turnId;
  const access = await accessVoiceChat(
    session,
    "persist_assistant_message",
    (storage) => storage.createMessage(
      session.chatSessionId!,
      "assistant",
      sanitizedAssistant || "",
      undefined,
      toolCalls,
      "elevenlabs-voice",
      systemSteps,
      undefined,
      undefined,
      segmentChronology,
      undefined,
      undefined,
      undefined,
      undefined,
      effectiveTurnId,
      turnCtx?.persona,
    ),
    {
      isCurrent: () => !turnCtx || (!turnCtx.aborted && session.activeAssistantAttemptId === turnCtx.assistantAttemptId),
      nullMeansUnavailable: true,
    },
  );

  if (access.outcome === "superseded") {
    log.log(`turn ${currentTurn} assistant persistence discarded after supersession attempt=${turnCtx?.assistantAttemptId || "none"}`);
    return;
  }
  if (access.outcome === "chat_unavailable") {
    log.warn(`turn ${currentTurn} assistant persistence discarded because owner-verified chat is unavailable convId=${session.chatSessionId}`);
    return;
  }
  if (access.outcome === "persistence_disabled") return;
  if (access.outcome === "owner_context_missing" || access.outcome === "storage_failure") {
    throw voiceChatAccessError("persist_assistant_message", access);
  }
  log.log(`turn ${currentTurn} SINGLE_WRITE assistant persisted msgId=${access.value.id} turnId=${effectiveTurnId || "none"} toolCalls=${turnToolCalls.length} systemSteps=${systemSteps?.length || 0} convId=${session.chatSessionId}`);
}

// ── Voice Error Message Persistence ──────────────────────────────────────

export async function persistVoiceErrorMessage(
  session: VoiceSession,
  errorText: string,
  turnCtx?: TurnContext,
): Promise<void> {
  if (!session.chatSessionId) return;
  const systemSteps = turnCtx?.systemSteps && turnCtx.systemSteps.length > 0 ? [...turnCtx.systemSteps] : undefined;
  const segmentChronology = turnCtx?.segmentChronology && turnCtx.segmentChronology.length > 0 ? [...turnCtx.segmentChronology] : undefined;
  const effectiveTurnId = turnCtx?.turnId;
  const access = await accessVoiceChat(
    session,
    "persist_voice_error",
    (storage) => storage.createMessage(session.chatSessionId!, "assistant", errorText, undefined, undefined, undefined, systemSteps, undefined, undefined, segmentChronology, undefined, undefined, undefined, undefined, effectiveTurnId, turnCtx?.persona),
    {
      isCurrent: () => !turnCtx || (!turnCtx.aborted && session.activeAssistantAttemptId === turnCtx.assistantAttemptId),
      nullMeansUnavailable: true,
    },
  );
  if (access.outcome === "superseded" || access.outcome === "chat_unavailable" || access.outcome === "persistence_disabled") {
    log.debug(`voice error persistence discarded outcome=${access.outcome} session=${session.id}`);
    return;
  }
  if (access.outcome === "owner_context_missing" || access.outcome === "storage_failure") {
    throw voiceChatAccessError("persist_voice_error", access);
  }
  log.log(`persisted voice error message to chat session=${session.chatSessionId} turnId=${effectiveTurnId || "none"} error="${errorText.slice(0, 80)}" systemSteps=${systemSteps?.length || 0}`);
}

// ── Orphaned Turn Data Persistence ───────────────────────────────────────

export async function persistOrphanedTurnData(
  session: VoiceSession,
  currentTurn: number,
  reason: string,
  ctx?: TurnContext,
): Promise<void> {
  const releaseLock = await acquireSessionTurnLock(session.id);
  let discardedToolCallCount = 0;
  try {
    const attemptId = ctx?.assistantAttemptId;
    if (attemptId) {
      discardedToolCallCount = session.toolCalls.filter((call) => call.assistantAttemptId === attemptId).length;
      session.toolCalls = session.toolCalls.filter((call) => call.assistantAttemptId !== attemptId);
    }
  } finally {
    releaseLock();
  }

  // Superseded attempts are diagnostics, never chat messages. Persisting their
  // chronology created empty assistant rows and made abandoned output renderable.
  log.log(`turn ${currentTurn} ${reason}_DISCARDED turnId=${ctx?.turnId || "none"} assistantAttemptId=${ctx?.assistantAttemptId || "none"} toolCalls=${discardedToolCallCount} session=${session.id}`);
  publishVoiceEvent(session, "voice_tools_cleared", { turn: currentTurn, reason });
}
