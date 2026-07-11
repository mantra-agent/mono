import type { Principal } from "../principal";

/**
 * Shared types for the voice pipeline.
 *
 * These types are used across all voice modules. Keeping them in a single
 * file prevents circular dependencies between voice-llm.ts and the
 * extracted modules.
 */

export interface VoiceMessage {
  role: string;
  content: string;
}

export interface VoiceToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  callId?: string;
  timestamp: string;
}

export interface VoiceSession {
  id: string;
  chatSessionId: string | null;
  chatSessionKey: string | null;
  cachedSystemPrompt: string | null;
  cachedSystemPromptFocusKey: string | null;
  cachedAt: number;
  toolCalls: VoiceToolCall[];
  turnCount: number;
  startedAt: number;
  ending: boolean;
  inflightAbort: AbortController | null;
  inflightTurn: number;
  inflightDone: Promise<void> | null;
  inflightDoneResolve: (() => void) | null;
  inflightContextPromise: Promise<string> | null;
  inflightContextFocusKey: string | null;
  lastDataDeliveryAt: number;
  inflightChunksDelivered: number;
  totalSuccessfulTurns: number;
  totalAbortedTurns: number;
  longestDataGapMs: number;
  disconnectReason: string | null;
  lastFiredUserContent: string;
  lastCallbackAt: number;
  isReconnect: boolean;
  historyInjected: boolean;
  recentCancellations: number[];
  circuitBreakerActive: boolean;
  prefixContinuation: boolean;
  lastPersistedUserMessageId: string | null;
  lastPersistedUserTurnKey: string | null;
  lastPersistedUserOrdinal: number | null;
  pendingTranscriptUpdate: VoiceMessage[] | null;
  executorStarted: boolean;
  activeTurnNumber: number;
  /** Stable logical turn identity across growing transcript callbacks. */
  activeVoiceTurnId: string | null;
  activeTranscriptRevision: number;
  activeAssistantAttemptId: string | null;
  /** Principal captured at /api/voice/start for scoping voice LLM callbacks. */
  principal: Principal | null;
}

export interface SSEWriteState {
  ts: number;
  preview: string;
  index: number;
  ok: boolean;
}

export interface BackpressureState {
  active: boolean;
  startedAt: number | null;
  drainWaits: number;
  totalBytes: number;
}

export interface TurnContext {
  turnStart: number;
  currentTurn: number;
  turnId: string;
  assistantAttemptId: string;
  transcriptRevision: number;
  aborted: boolean;
  turnAbort: AbortController;
  lastWrite: SSEWriteState;
  bp: BackpressureState;
  currentToolName: string | null;
  currentToolStartAt: number | null;
  coalesceBuf: { value: string };
  coalesceFlushCount: number;
  chunkCounter: { count: number };
  responseSize: { total: number };
  firstChunk: { sentAt: number | null };
  lastContentAt: { ts: number | null };
  firstRealContentAt: { ts: number | null };
  lastRealContentAt: { ts: number | null };
  longestContentGapMs: number;
  chatId: string;
  created: number;
  turnEndCause: string;
  fillerCount: number;
  fillerTimer: ReturnType<typeof setInterval> | null;
  lastContentSentAt: number;
  lastFillerSentAt: number;
  lastWriteAt: number;
  firstLlmDeltaAt: number | null;
  thinkingSuppressedChars: number;
  thinkingSuppressedMs: number;
  systemSteps: Array<{ name: string; status: "done" | "error"; elapsedMs?: number; detail?: string }>;
  segmentChronology: Array<{ s: "system"; i: number } | { s: "content"; c: string } | { s: "tool"; i: number }>;
  toolCallChronologyCount: number;
  toolCallActive: boolean;
  contentDroppedPublished: boolean;
  lastAudibleDeltaAt: number;
  audibleDeltaCount: number;
  keepalivesSent: number;
  lastKeepaliveAt: number | null;
  toolCallIndex: number;
  pipelineStagesEmitted: Set<string>;
  lastToolCallId: string | null;
}
