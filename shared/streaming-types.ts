/**
 * Shared streaming data types — used by both server and client.
 *
 * Ported from client/src/lib/streaming-state.ts as part of the
 * server-authoritative sessions migration. Only the pure data model
 * lives here; client-specific rendering concerns (StreamPhase,
 * filterStepsByLayer, etc.) remain in the client.
 */

export type ExecutionStepType = "thinking" | "tool_call" | "compacting" | "system";
export type DiagnosticTimingKind = "span" | "milestone";
export type DiagnosticVisibility = "default" | "raw" | "hidden";
export type DiagnosticChildMode = "serial" | "parallel";

export interface ExecutionStep {
  id: string;
  type: ExecutionStepType;
  timestamp: number;
  thinking?: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  /** Structured failure kind for UI tone (permission vs actual error). */
  failureKind?: import("./tool-failure").ToolFailureKind;
  status?: "active" | "done" | "error";
  narrative?: string;
  systemStepName?: string;
  systemStepDetail?: string;
  systemStepMetadata?: Record<string, unknown>;
  elapsedMs?: number;
  /** Explicit trace parent. Children are rendered beneath this step in Diagnostic detail. */
  parentId?: string;
  /** Intervals contribute duration; milestones are instantaneous checkpoints. */
  timingKind?: DiagnosticTimingKind;
  /** Raw telemetry is retained but excluded from the default hierarchy. */
  diagnosticVisibility?: DiagnosticVisibility;
  /** Declares that direct child spans intentionally overlap. */
  childMode?: DiagnosticChildMode;
  /** Timestamp for milestone nodes. */
  occurredAt?: number;
  /** Time spent in the step excluding child intervals. */
  selfTimeMs?: number;
  /** Stable trace span boundaries used for overlap-safe self-time calculation. */
  startedAt?: number;
  endedAt?: number;
}

export type MessageSegment =
  | { type: "timeline"; steps: ExecutionStep[] }
  | { type: "content"; content: string };

export type StreamingSource = "text" | "voice" | "meeting" | null;

export interface ContextPressureSnapshot {
  inputTokens: number;
  inputLimit: number;
  compactionThreshold: number;
  /** True provider context window (e.g. 200k) — the real max, for debug display. */
  contextWindow?: number;
  /** Human-readable model display name, for debug display. */
  modelName?: string;
  /** Tokens reserved for model output (off-limits to input) — the roped-off wedge at top of the gauge. */
  outputReserve?: number;
  /** Soft mid-turn compaction target (stage-3 threshold). Stage 2 = 0.80×, stage 1 = 0.65× of this. Drives the amber ladder ticks. */
  compactionTarget?: number;
}

export interface StreamingContent {
  segments: MessageSegment[];
  source: StreamingSource;
  model?: string | null;
  autoTier?: string | null;
  persona?: { id: number; name: string; icon: string } | null;
  runId?: string | null;
  /** Canonical logical voice-turn identity, stable across transcript revisions. */
  turnId?: string | null;
  /** Canonical assistant response attempt. Changes when revised speech supersedes a response. */
  assistantAttemptId?: string | null;
  /** Transcript revision answered by the active assistant attempt. */
  transcriptRevision?: number | null;
  cost?: number | null;
  apiCallCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  contextPressure?: ContextPressureSnapshot | null;
}

/**
 * Incremental segment patch for the protocol-v2 `session.delta`. The server
 * sends only the segments that changed versus the exact state it last
 * broadcast, plus the authoritative final length. The client reconstructs the
 * full StreamingContent from its held baseline. Correctness never depends on
 * minimality: an over-broad `set` still reconstructs identical state.
 */
export interface SegmentPatch {
  /** Authoritative final segment count; the client truncates to this length. */
  length: number;
  /** Full replacement segments by index — only changed or newly added indices. */
  set: { index: number; segment: MessageSegment }[];
}

export const initialStreamingContent: StreamingContent = {
  segments: [],
  source: null,
  model: null,
  autoTier: null,
  persona: null,
  runId: null,
  turnId: null,
  assistantAttemptId: null,
  transcriptRevision: null,
  cost: null,
  apiCallCount: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  contextPressure: null,
};
