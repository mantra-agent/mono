import { safeStringify } from "./utils/safe-stringify";
import {
  ensureToolOutputArchived,
  estimateToolOutputSize,
} from "./tool-output-artifacts";
import type { ExecutorMessage } from "./agent-executor";

const ARCHIVE_LARGE_RESULT_TOKENS = Number(
  process.env.WORKING_SET_ARCHIVE_SIDECAR_TOKEN_FLOOR
    || process.env.WORKING_SET_PROJECTED_SAVINGS_FLOOR_TOKENS
    || 8_000,
);

export const CURRENT_CYCLE_TOOL_RESULT_BUDGET_TOKENS = Number(
  process.env.WORKING_SET_TOOL_RESULT_CYCLE_BUDGET_TOKENS || 20_000,
);

export interface WorkingSetProjectionTelemetry {
  outcome: "skipped" | "projected" | "degraded";
  reason: string;
  tokensBefore: number;
  tokensAfter: number;
  tokensProjected: number;
  charsProjected: number;
  pairsProjected: number;
  unconsumedPairsPreserved: number;
  archiveRefsCreated: number;
  archiveRefsReused: number;
  receiptsRehydratable: number;
}

function cloneMessages(messages: ExecutorMessage[]): ExecutorMessage[] {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({
          ...block,
          input: block.input ? { ...block.input } : undefined,
          image_url: block.image_url ? { ...block.image_url } : undefined,
        }))
      : message.content,
  }));
}

function estimateMessagesTokens(messages: ExecutorMessage[]): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === "string") {
      return total + Math.ceil(message.content.length / 3.5);
    }

    return total + message.content.reduce((sum, block) => {
      const value = block.text
        || block.thinking
        || block.content
        || safeStringify(block.input || {}, {
          maxBytes: 8_000,
          label: "working-set-projector.token-estimate",
        });
      return sum + Math.ceil(value.length / 3.5);
    }, 0);
  }, 0);
}

function countExactSuccessfulToolResults(messages: ExecutorMessage[]): number {
  return messages.reduce((count, message) => {
    if (message.role !== "tool_result" || !Array.isArray(message.content)) {
      return count;
    }

    return count + message.content.filter((block) => (
      block.type === "tool_result"
      && !block.is_error
      && block.content != null
    )).length;
  }, 0);
}

function archiveOperationKey(args: {
  sessionId?: string;
  runId: string;
  toolCallId: string;
}): string {
  return `working-set:${args.sessionId || "no-session"}:${args.runId}:${args.toolCallId}`;
}

/**
 * Preserve the exact model-facing transcript.
 *
 * A later assistant message proves only that the model observed a tool result in
 * one inference. It does not prove that the result is no longer required by a
 * future stateless inference. Until the runtime has an explicit semantic
 * working-set contract, replacing historical results with receipts is unsafe.
 */
export async function projectWorkingSet(args: {
  messages: ExecutorMessage[];
  runId: string;
  sessionId?: string;
  sessionKey: string;
  source: string;
}): Promise<{ messages: ExecutorMessage[]; telemetry: WorkingSetProjectionTelemetry }> {
  const tokens = estimateMessagesTokens(args.messages);

  return {
    messages: cloneMessages(args.messages),
    telemetry: {
      outcome: "skipped",
      reason: "lossy_projection_disabled",
      tokensBefore: tokens,
      tokensAfter: tokens,
      tokensProjected: 0,
      charsProjected: 0,
      pairsProjected: 0,
      unconsumedPairsPreserved: countExactSuccessfulToolResults(args.messages),
      archiveRefsCreated: 0,
      archiveRefsReused: 0,
      receiptsRehydratable: 0,
    },
  };
}

/**
 * Archive large results as a sidecar while returning the exact result to the
 * provider. Archival must never change the model-facing evidence.
 */
export async function projectImmediateToolResult(args: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  result: string;
  error?: boolean;
  runId: string;
  sessionId?: string;
}): Promise<{ providerResult: string; archived: "created" | "reused" | "failed" | "not_needed" }> {
  const size = estimateToolOutputSize(args.result);
  if (args.error || size.estimatedTokens <= ARCHIVE_LARGE_RESULT_TOKENS) {
    return { providerResult: args.result, archived: "not_needed" };
  }

  const archive = await ensureToolOutputArchived({
    toolName: args.toolName,
    action: typeof args.toolArgs.action === "string" ? args.toolArgs.action : undefined,
    sessionId: args.sessionId,
    runId: args.runId,
    toolCallId: args.toolCallId,
    result: args.result,
    operationKey: archiveOperationKey(args),
    maxPreviewChars: 0,
  });

  return archive.ref
    ? { providerResult: args.result, archived: archive.outcome }
    : { providerResult: args.result, archived: "failed" };
}
