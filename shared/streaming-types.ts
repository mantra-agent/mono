/**
 * Shared streaming data types — used by both server and client.
 *
 * Ported from client/src/lib/streaming-state.ts as part of the
 * server-authoritative sessions migration. Only the pure data model
 * lives here; client-specific rendering concerns (StreamPhase,
 * filterStepsByLayer, etc.) remain in the client.
 */

export type ExecutionStepType = "thinking" | "tool_call" | "compacting" | "system";

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
  status?: "active" | "done" | "error";
  narrative?: string;
  systemStepName?: string;
  systemStepDetail?: string;
  systemStepMetadata?: Record<string, unknown>;
  elapsedMs?: number;
  /** Explicit trace parent. Children are rendered beneath this step in Diagnostic detail. */
  parentId?: string;
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

export interface StreamingContent {
  segments: MessageSegment[];
  source: StreamingSource;
  model?: string | null;
  autoTier?: string | null;
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
}

export const initialStreamingContent: StreamingContent = {
  segments: [],
  source: null,
  model: null,
  autoTier: null,
  runId: null,
  turnId: null,
  assistantAttemptId: null,
  transcriptRevision: null,
  cost: null,
  apiCallCount: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
};
