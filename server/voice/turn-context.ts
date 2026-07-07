/**
 * Voice turn context — per-turn state container.
 *
 * TurnContext tracks all the mutable state for a single voice turn:
 * SSE write state, backpressure, coalesce buffer, diagnostics counters,
 * tool call tracking, and pipeline chronology.
 */
import type { VoiceSession, TurnContext } from "./types";

/**
 * Create a fresh TurnContext for a new voice turn.
 */
export function createTurnContext(session: VoiceSession, turnAbort: AbortController): TurnContext {
  const currentTurn = session.turnCount;
  return {
    turnStart: Date.now(),
    currentTurn,
    turnId: `${session.id}-turn-${currentTurn}-${Date.now()}`,
    aborted: false,
    turnAbort,
    lastWrite: { ts: 0, preview: "", index: 0, ok: true },
    bp: { active: false, startedAt: null, drainWaits: 0, totalBytes: 0 },
    currentToolName: null,
    currentToolStartAt: null,
    coalesceBuf: { value: "" },
    coalesceFlushCount: 0,
    chunkCounter: { count: 0 },
    responseSize: { total: 0 },
    firstChunk: { sentAt: null },
    lastContentAt: { ts: null },
    firstRealContentAt: { ts: null },
    lastRealContentAt: { ts: null },
    longestContentGapMs: 0,
    chatId: `chatcmpl-${session.id}-${currentTurn}`,
    created: Math.floor(Date.now() / 1000),
    turnEndCause: "normal",
    fillerCount: 0,
    fillerTimer: null,
    lastContentSentAt: session.lastDataDeliveryAt,
    lastFillerSentAt: 0,
    lastWriteAt: Date.now(),
    firstLlmDeltaAt: null,
    thinkingSuppressedChars: 0,
    thinkingSuppressedMs: 0,
    systemSteps: [],
    segmentChronology: [],
    toolCallChronologyCount: 0,
    toolCallActive: false,
    contentDroppedPublished: false,
    lastAudibleDeltaAt: Date.now(),
    audibleDeltaCount: 0,
    keepalivesSent: 0,
    lastKeepaliveAt: null,
    toolCallIndex: 0,
    pipelineStagesEmitted: new Set<string>(),
    lastToolCallId: null,
  };
}
