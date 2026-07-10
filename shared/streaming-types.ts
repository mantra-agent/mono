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
  /** Canonical per-turn correlation ID for voice turns. */
  turnId?: string | null;
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
  cost: null,
  apiCallCount: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
};
