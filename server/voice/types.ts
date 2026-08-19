import type { Principal } from "../principal";
import type { PersonaSnapshot } from "@shared/models/chat";
import type { ProviderSystemToolCall } from "./provider-system-tools";

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
  assistantAttemptId: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
  callId?: string;
  timestamp: string;
}

export type VoiceToolMode = "standard" | "none";

/** Per-turn presence discriminant — sole source for hold / speak / silent. */
export type PresenceState = "speaking" | "holding" | "silent" | "reconnecting";

export interface VoiceSession {
  id: string;
  chatSessionId: string | null;
  chatSessionKey: string | null;
  cachedSystemPrompt: string | null;
  cachedSystemPromptFocusKey: string | null;
  cachedAt: number;
  /** Per-process memo: the authoritative orientation check (real session title) already passed for this chat session. */
  orientationEnsured: boolean;
  toolCalls: VoiceToolCall[];
  turnCount: number;
  startedAt: number;
  ending: boolean;
  inflightAbort: AbortController | null;
  inflightTurn: number;
  inflightDone: Promise<void> | null;
  inflightDoneResolve: (() => void) | null;
  /** Hot-swappable custom-LLM SSE write port. Socket death replaces this; it must not abort the generator. */
  activeWriteRes: import("express").Response | null;
  /** Bind a cascade-retry socket under the live generator. Installs lifecycle and flushes held remainder. */
  attachWritePort: ((req: import("express").Request, res: import("express").Response) => void) | null;
  /** Cascade retry that arrived before turn I/O existed. Consumed once attachWritePort is installed. */
  pendingAttach: { req: import("express").Request; res: import("express").Response } | null;
  inflightContextPromise: Promise<string> | null;
  inflightContextFocusKey: string | null;
  lastDataDeliveryAt: number;
  inflightChunksDelivered: number;
  totalSuccessfulTurns: number;
  totalAbortedTurns: number;
  longestDataGapMs: number;
  disconnectReason: string | null;
  lastFiredUserContent: string;
  /** Last flushed model speakable for the current utterance. Terminal-retry replay source. */
  lastFlushedSpeakable: string;
  /** Unflushed remainder after a dead write-port. Preferred terminal-retry replay source. */
  unflushedSpeakable: string;
  /** User ordinal that owns lastFlushedSpeakable / unflushedSpeakable. */
  lastSpeakableUserOrdinal: number | null;
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
  /** ElevenLabs conversation user-message ordinal for the active physical utterance. */
  activeVoiceUserOrdinal: number | null;
  activeTranscriptRevision: number;
  activeRunId: string | null;
  activeAssistantAttemptId: string | null;
  /** Principal captured by the durable voice lease; required for every authenticated chat access. */
  principal: Principal;
  /** Authenticated browser tab that initiated this voice session; never model-provided. */
  originatingClientId: string | null;
  /** Restricted public sessions receive no model-callable tools. */
  toolMode: VoiceToolMode;
  /** Hash-only onboarding capability used to revalidate restricted sessions after process recovery. */
  onboardingTokenHash: string | null;
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
  persona?: PersonaSnapshot;
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
  /** One presence discriminant for the turn — produced only at the speakable write helper. */
  presence: PresenceState;
  /** Hold counter (spoken hold sentences). Not model content. */
  fillerCount: number;
  fillerTimer: ReturnType<typeof setInterval> | null;
  lastContentSentAt: number;
  lastFillerSentAt: number;
  /** Clock for hold cadence: last flushed speakable (model sentence or hold). */
  lastFlushedSpeakableAt: number;
  /** Monotonic id of last flushed speakable for duplicate-word spine proof. */
  lastFlushedSpeakableId: number;
  lastWriteAt: number;
  firstLlmDeltaAt: number | null;
  thinkingSuppressedChars: number;
  thinkingSuppressedMs: number;
  systemSteps: Array<{ name: string; status: "done" | "error"; elapsedMs?: number; detail?: string }>;
  segmentChronology: Array<{ s: "system"; i: number } | { s: "content"; c: string } | { s: "tool"; i: number }>;
  toolCallChronologyCount: number;
  toolCallActive: boolean;
  contentDroppedPublished: boolean;
  /** @deprecated presence clocks — retained for log compatibility only */
  lastAudibleDeltaAt: number;
  audibleDeltaCount: number;
  keepalivesSent: number;
  lastKeepaliveAt: number | null;
  toolCallIndex: number;
  pipelineStagesEmitted: Set<string>;
  lastToolCallId: string | null;
  providerSystemToolCall: ProviderSystemToolCall | null;
}
