import { safeStringify } from "./utils/safe-stringify";
import {
  DEFAULT_TOOL_OUTPUT_POLICY,
  ensureToolOutputArchived,
  estimateToolOutputSize,
} from "./tool-output-artifacts";
import type { ExecutorMessage } from "./agent-executor";

export const CURRENT_CYCLE_TOOL_RESULT_BUDGET_TOKENS = Number(
  process.env.AGENT_CURRENT_CYCLE_TOOL_RESULT_BUDGET_TOKENS || 30_000,
);

export const MATERIAL_REFRESH_REDUCTION_TOKENS = Number(
  process.env.AGENT_WORKING_SET_REFRESH_MIN_REDUCTION_TOKENS || 2_000,
);

export interface WorkingSetProjectionTelemetry {
  outcome: "applied" | "skipped";
  reason: "historical_tool_receipts" | "no_eligible_tool_outputs" | "archive_unavailable";
  tokensOriginal: number;
  tokensProjected: number;
  tokensSaved: number;
  receiptsApplied: number;
  archiveFailures: number;
}

export interface WorkingSetProjectionResult {
  messages: ExecutorMessage[];
  telemetry: WorkingSetProjectionTelemetry;
}

export interface ImmediateToolResultProjection {
  providerResult: string;
  historicalProviderResult?: string;
  archivedRefId?: string;
  originalTokens: number;
  historicalTokens: number;
  refreshReductionTokens: number;
  canMateriallyShrinkOnRefresh: boolean;
  outcome: "inline" | "archived_exact_once" | "archive_failed";
}

function estimateMessagesTokens(messages: ExecutorMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += typeof message.content === "string"
      ? message.content.length
      : safeStringify(message.content).length;
  }
  return Math.ceil(chars / 4);
}

function cloneMessages(messages: ExecutorMessage[]): ExecutorMessage[] {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
  }));
}

function toolMetadata(messages: ExecutorMessage[]): Map<string, { toolName: string; action?: string }> {
  const metadata = new Map<string, { toolName: string; action?: string }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_use" || !block.id || !block.name) continue;
      const input = block.input && typeof block.input === "object"
        ? block.input as Record<string, unknown>
        : undefined;
      metadata.set(block.id, {
        toolName: block.name,
        action: typeof input?.action === "string" ? input.action : undefined,
      });
    }
  }
  return metadata;
}

function archiveOperationKey(args: { sessionId?: string; runId: string; toolCallId: string }): string {
  return `tool-output:${args.sessionId || args.runId}:${args.toolCallId}`;
}

function historicalEligibility(
  messageIndex: number,
  lastAssistantIndex: number,
  toolCallId: string | undefined,
  providerConsumedToolCallIds?: ReadonlySet<string>,
): boolean {
  if (messageIndex < lastAssistantIndex) return true;
  return !!toolCallId && !!providerConsumedToolCallIds?.has(toolCallId);
}

export async function projectWorkingSet(args: {
  messages: ExecutorMessage[];
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  source?: string;
  providerConsumedToolCallIds?: ReadonlySet<string>;
}): Promise<WorkingSetProjectionResult> {
  const original = cloneMessages(args.messages);
  const projected = cloneMessages(args.messages);
  const tokensOriginal = estimateMessagesTokens(original);
  const lastAssistantIndex = projected.reduce(
    (latest, message, index) => message.role === "assistant" ? index : latest,
    -1,
  );
  const metadata = toolMetadata(projected);
  const providersConsumed = args.providerConsumedToolCallIds
    ? new Set(args.providerConsumedToolCallIds)
    : undefined;
  let receiptsApplied = 0;
  let archiveFailures = 0;
  let eligibleOutputs = 0;

  for (let messageIndex = 0; messageIndex < projected.length; messageIndex++) {
    const message = projected[messageIndex];
    if (message.role !== "tool_result" || !Array.isArray(message.content)) continue;

    const nextBlocks = [...message.content];
    let changed = false;
    for (let blockIndex = 0; blockIndex < nextBlocks.length; blockIndex++) {
      const block = nextBlocks[blockIndex];
      if (block.type !== "tool_result" || typeof block.content !== "string") continue;
      const toolCallId = block.tool_use_id;
      if (!historicalEligibility(
        messageIndex,
        lastAssistantIndex,
        toolCallId,
        providersConsumed,
      )) continue;

      const size = estimateToolOutputSize(block.content);
      const wasArchivedImmediately = size.estimatedTokens >= DEFAULT_TOOL_OUTPUT_POLICY.alwaysArchiveAboveTokens;
      const exceedsInlinePolicy = size.estimatedTokens > DEFAULT_TOOL_OUTPUT_POLICY.maxInlineTokens
        || size.chars > DEFAULT_TOOL_OUTPUT_POLICY.maxInlineChars;
      if (!wasArchivedImmediately && !exceedsInlinePolicy) continue;

      eligibleOutputs++;
      const tool = toolCallId ? metadata.get(toolCallId) : undefined;
      const archived = await ensureToolOutputArchived({
        toolName: tool?.toolName || "unknown_tool",
        action: tool?.action,
        sessionId: args.sessionId,
        runId: args.runId,
        toolCallId,
        result: block.content,
        maxPreviewChars: block.is_error ? 1_200 : 2_000,
      });
      if (!archived.formattedRef) {
        archiveFailures++;
        continue;
      }

      nextBlocks[blockIndex] = { ...block, content: archived.formattedRef };
      receiptsApplied++;
      changed = true;
    }

    if (changed) projected[messageIndex] = { ...message, content: nextBlocks };
  }

  const tokensProjected = estimateMessagesTokens(projected);
  const tokensSaved = Math.max(0, tokensOriginal - tokensProjected);
  const outcome = receiptsApplied > 0 && tokensSaved > 0 ? "applied" : "skipped";
  const reason = outcome === "applied"
    ? "historical_tool_receipts"
    : eligibleOutputs === 0
      ? "no_eligible_tool_outputs"
      : "archive_unavailable";

  return {
    messages: projected,
    telemetry: {
      outcome,
      reason,
      tokensOriginal,
      tokensProjected,
      tokensSaved,
      receiptsApplied,
      archiveFailures,
    },
  };
}

export async function projectImmediateToolResult(args: {
  toolName: string;
  toolArgs?: Record<string, unknown>;
  toolCallId: string;
  result: string;
  error?: boolean;
  sessionId?: string;
  runId: string;
}): Promise<ImmediateToolResultProjection> {
  const size = estimateToolOutputSize(args.result);
  const action = typeof args.toolArgs?.action === "string" ? args.toolArgs.action : undefined;
  const shouldArchive = size.estimatedTokens >= DEFAULT_TOOL_OUTPUT_POLICY.alwaysArchiveAboveTokens
    || size.estimatedTokens > DEFAULT_TOOL_OUTPUT_POLICY.maxInlineTokens
    || size.chars > DEFAULT_TOOL_OUTPUT_POLICY.maxInlineChars;

  if (!shouldArchive) {
    return {
      providerResult: args.result,
      originalTokens: size.estimatedTokens,
      historicalTokens: size.estimatedTokens,
      refreshReductionTokens: 0,
      canMateriallyShrinkOnRefresh: false,
      outcome: "inline",
    };
  }

  const archived = await ensureToolOutputArchived({
    toolName: args.toolName,
    action,
    sessionId: args.sessionId,
    runId: args.runId,
    toolCallId: args.toolCallId,
    result: args.result,
    operationKey: archiveOperationKey(args),
    maxPreviewChars: args.error ? 1_200 : 2_000,
  });
  if (!archived.formattedRef) {
    return {
      providerResult: args.result,
      originalTokens: size.estimatedTokens,
      historicalTokens: size.estimatedTokens,
      refreshReductionTokens: 0,
      canMateriallyShrinkOnRefresh: false,
      outcome: "archive_failed",
    };
  }

  const historicalTokens = estimateToolOutputSize(archived.formattedRef).estimatedTokens;
  const refreshReductionTokens = Math.max(0, size.estimatedTokens - historicalTokens);
  return {
    providerResult: args.result,
    historicalProviderResult: archived.formattedRef,
    archivedRefId: archived.ref?.refId,
    originalTokens: size.estimatedTokens,
    historicalTokens,
    refreshReductionTokens,
    canMateriallyShrinkOnRefresh: refreshReductionTokens >= MATERIAL_REFRESH_REDUCTION_TOKENS,
    outcome: "archived_exact_once",
  };
}
