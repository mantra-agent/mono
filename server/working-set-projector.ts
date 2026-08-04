import { safeStringify } from "./utils/safe-stringify";
import {
  DEFAULT_TOOL_OUTPUT_POLICY,
  ensureToolOutputArchived,
  estimateToolOutputSize,
  extractToolOutputRef,
} from "./tool-output-artifacts";
import type { ExecutorMessage } from "./agent-executor";
import {
  buildContinuationCapsule,
  renderContinuationCapsule,
  type ContinuationCapsuleEntry,
} from "./continuation-capsule";
import {
  summarizeCompactedMessages,
  type SummarizableMessage,
} from "./compaction-summarizer";
import { createLogger } from "./log";

const log = createLogger("WorkingSetProjector");

/** Soft wall for exact tool-result bytes still live in the incomplete cycle. */
export const CURRENT_CYCLE_TOOL_RESULT_BUDGET_TOKENS = Number(
  process.env.AGENT_CURRENT_CYCLE_TOOL_RESULT_BUDGET_TOKENS || 30_000,
);

/** Material floor for working_set_refresh acceptance. */
export const MATERIAL_REFRESH_REDUCTION_TOKENS = Number(
  process.env.AGENT_WORKING_SET_REFRESH_MIN_REDUCTION_TOKENS || 2_000,
);

/** Active-history latency budget for the provider-facing projected transcript. */
export const ACTIVE_HISTORY_BUDGET_TOKENS = Number(
  process.env.ACTIVE_HISTORY_BUDGET_TOKENS || 28_000,
);

/** Newest completed cycles kept exact (plus the incomplete current cycle). */
export const PROTECTED_RECENT_COMPLETED_CYCLES = Number(
  process.env.PROTECTED_RECENT_COMPLETED_CYCLES || 1,
);

/**
 * Minimum tokens a checkpoint collapse must save to be accepted.
 * Defaults to the material-refresh floor so small collapses do not burn summarizer budget.
 */
export const MATERIAL_CHECKPOINT_REDUCTION_TOKENS = Number(
  process.env.MATERIAL_CHECKPOINT_REDUCTION_TOKENS
    || process.env.AGENT_WORKING_SET_REFRESH_MIN_REDUCTION_TOKENS
    || 2_000,
);

/** Soft wall for checkpoint summarizer work inside one projection. */
const CHECKPOINT_DEADLINE_MS = Number(process.env.ACTIVE_HISTORY_CHECKPOINT_DEADLINE_MS || 10_000);

/** Compact digest body budget for small consumed results. */
const COMPACT_DIGEST_MAX_CHARS = 1_200;

export type WorkingSetProjectionOutcome = "applied" | "skipped";

export type WorkingSetProjectionReason =
  | "historical_tool_receipts"
  | "no_eligible_tool_outputs"
  | "archive_unavailable"
  | "closed_cycle_receipts"
  | "checkpoint_applied"
  | "receipts_and_checkpoints"
  | "under_active_history_budget"
  | "checkpoint_rejected_immaterial"
  | "checkpoint_summarizer_failed"
  | "checkpoint_deadline"
  | "protected_cycles_only";

export interface WorkingSetAttribution {
  systemFramingTokens: number;
  toolsSchemaTokens: number;
  activeHistoryTokens: number;
  exactToolResultTokens: number;
  receiptTokens: number;
  digestTokens: number;
  checkpointTokens: number;
  otherMessageTokens: number;
  totalProjectedTokens: number;
  budgetTokens: number;
  overBudgetTokens: number;
}

export interface WorkingSetProjectionTelemetry {
  outcome: WorkingSetProjectionOutcome;
  reason: WorkingSetProjectionReason;
  tokensOriginal: number;
  tokensProjected: number;
  tokensSaved: number;
  receiptsApplied: number;
  archiveFailures: number;
  /** Extended attribution / cycle telemetry (additive). */
  digestsApplied?: number;
  archivesCreated?: number;
  skippedProtected?: number;
  skippedAlreadyReceipt?: number;
  eligibleCount?: number;
  checkpointsApplied?: number;
  checkpointsRejected?: number;
  cyclesDetected?: number;
  cyclesProtected?: number;
  cyclesEligible?: number;
  activeHistoryBudgetTokens?: number;
  source?: string;
  runId?: string;
  sessionId?: string;
  attribution?: WorkingSetAttribution;
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

export interface CycleSpan {
  /** Inclusive start index in the message array. */
  start: number;
  /** Inclusive end index in the message array. */
  end: number;
  /** Zero-based completed-cycle index among completed spans; -1 if incomplete. */
  cycleIndex: number;
  completed: boolean;
  toolCallIds: string[];
  toolResultMessageIndexes: number[];
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

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
  // Prefer the consume ledger when present; fall back to index < lastAssistant.
  if (providerConsumedToolCallIds && toolCallId) {
    return providerConsumedToolCallIds.has(toolCallId);
  }
  if (messageIndex < lastAssistantIndex) return true;
  return false;
}

function contentToText(content: ExecutorMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : safeStringify(content);
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return safeStringify(block);
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      if (block.type === "tool_use") {
        return `${String(block.name || "tool")} ${safeStringify(block.input ?? {})}`;
      }
      if (block.type === "tool_result") {
        return typeof block.content === "string" ? block.content : safeStringify(block.content ?? "");
      }
      return safeStringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

function isReceiptContent(content: unknown): boolean {
  if (typeof content !== "string") return false;
  if (extractToolOutputRef(content)) return true;
  return (
    content.includes("**Tool Output Archived**")
    || content.includes("[ref:")
    || content.startsWith("tool_output:")
    || content.includes("[cycle_checkpoint")
    || content.includes("## Cycle checkpoint")
  );
}

function isDigestContent(content: unknown): boolean {
  return typeof content === "string" && content.startsWith("[Consumed tool result digest]");
}

function isCheckpointMessage(message: ExecutorMessage): boolean {
  const text = contentToText(message.content);
  return text.includes("[cycle_checkpoint") || text.startsWith("## Cycle checkpoint");
}

function collectAssistantToolUseIds(message: ExecutorMessage | undefined): string[] {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content) {
    if (block.type === "tool_use" && typeof block.id === "string" && block.id.length > 0) {
      ids.push(block.id);
    }
  }
  return ids;
}

function collectToolResultIds(message: ExecutorMessage | undefined): string[] {
  if (!message || message.role !== "tool_result" || !Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content) {
    if (block.type === "tool_result" && typeof block.tool_use_id === "string" && block.tool_use_id.length > 0) {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

function isSuccessfulFinalAssistant(message: ExecutorMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  return collectAssistantToolUseIds(message).length === 0;
}

/**
 * Detect contiguous provider cycles:
 * [assistant tool_use+] → [tool_result+] → [assistant successful final?]
 */
export function detectCycleSpans(messages: ExecutorMessage[]): CycleSpan[] {
  const spans: CycleSpan[] = [];
  let i = 0;
  let completedIndex = 0;

  while (i < messages.length) {
    const message = messages[i];
    const toolUseIds = collectAssistantToolUseIds(message);
    if (message.role !== "assistant" || toolUseIds.length === 0) {
      i += 1;
      continue;
    }

    const start = i;
    const toolCallIds = [...toolUseIds];
    const toolResultMessageIndexes: number[] = [];
    i += 1;

    while (i < messages.length && messages[i].role === "tool_result") {
      const resultIds = collectToolResultIds(messages[i]);
      toolResultMessageIndexes.push(i);
      for (const id of resultIds) {
        if (!toolCallIds.includes(id)) toolCallIds.push(id);
      }
      i += 1;
    }

    let end = toolResultMessageIndexes.length > 0
      ? toolResultMessageIndexes[toolResultMessageIndexes.length - 1]
      : start;
    let completed = false;

    if (i < messages.length && isSuccessfulFinalAssistant(messages[i])) {
      end = i;
      completed = true;
      i += 1;
    }

    spans.push({
      start,
      end,
      cycleIndex: completed ? completedIndex : -1,
      completed,
      toolCallIds,
      toolResultMessageIndexes,
    });
    if (completed) completedIndex += 1;
  }

  return spans;
}

function spanKey(span: CycleSpan): string {
  return `${span.start}:${span.end}`;
}

function protectedSpanKeys(
  spans: CycleSpan[],
  protectedRecentCompleted: number,
): Set<string> {
  const protectedKeys = new Set<string>();
  const completed = spans.filter((span) => span.completed);
  const protectCount = Math.max(0, protectedRecentCompleted);
  const protectedCompleted = completed.slice(Math.max(0, completed.length - protectCount));
  for (const span of spans) {
    if (!span.completed) protectedKeys.add(spanKey(span));
  }
  for (const span of protectedCompleted) {
    protectedKeys.add(spanKey(span));
  }
  return protectedKeys;
}

function buildCompactDigest(args: {
  toolName?: string;
  action?: string;
  toolCallId: string;
  content: string;
  isError?: boolean;
}): string {
  const size = estimateToolOutputSize(args.content);
  const preview = args.content.replace(/\s+/g, " ").trim().slice(0, COMPACT_DIGEST_MAX_CHARS);
  const toolLabel = [args.toolName, args.action].filter(Boolean).join("/");
  return [
    "[Consumed tool result digest]",
    `tool_call_id: ${args.toolCallId}`,
    toolLabel ? `tool: ${toolLabel}` : undefined,
    `chars: ${size.chars}`,
    `estimated_tokens: ${size.estimatedTokens}`,
    args.isError ? "is_error: true" : undefined,
    preview ? `preview: ${preview}` : "preview: (empty)",
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldForceArchive(content: string, isError?: boolean): boolean {
  const size = estimateToolOutputSize(content);
  return (
    Boolean(isError)
    || size.estimatedTokens >= DEFAULT_TOOL_OUTPUT_POLICY.forceArtifactTokens
    || size.estimatedTokens > DEFAULT_TOOL_OUTPUT_POLICY.maxInlineTokens
    || size.chars > DEFAULT_TOOL_OUTPUT_POLICY.maxInlineChars
  );
}

function collectArchiveRefsFromMessages(messages: ExecutorMessage[]): string[] {
  const refs = new Set<string>();
  for (const message of messages) {
    const text = contentToText(message.content);
    const extracted = extractToolOutputRef(text);
    if (extracted?.refId) {
      refs.add(`tool_output:${extracted.refId}`);
      continue;
    }
    const match = text.match(/\[ref:([^\]]+)\]/);
    if (match?.[1]) refs.add(`tool_output:${match[1]}`);
  }
  return [...refs];
}

function toSummarizableMessages(messages: ExecutorMessage[]): SummarizableMessage[] {
  const out: SummarizableMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const toolUses = message.content.filter((block) => block.type === "tool_use");
      if (toolUses.length > 0) {
        out.push({
          role: "assistant",
          content: contentToText(message.content),
          toolCalls: toolUses.map((block) => ({
            toolName: typeof block.name === "string" ? block.name : undefined,
            arguments: block.input && typeof block.input === "object"
              ? block.input as Record<string, unknown>
              : undefined,
          })),
        });
        continue;
      }
    }

    if (message.role === "tool_result" && Array.isArray(message.content)) {
      out.push({
        role: "tool_result",
        content: contentToText(message.content),
        toolCalls: message.content
          .filter((block) => block.type === "tool_result")
          .map((block) => ({
            toolName: undefined as string | undefined,
            output: typeof block.content === "string" ? block.content : safeStringify(block.content ?? ""),
            error: block.is_error ? true : undefined,
          })),
      });
      continue;
    }

    out.push({
      role: message.role,
      content: contentToText(message.content),
    });
  }
  return out;
}

function toCapsuleEntries(messages: ExecutorMessage[]): ContinuationCapsuleEntry[] {
  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const toolUses = message.content.filter((block) => block.type === "tool_use");
      if (toolUses.length > 0) {
        return {
          role: "assistant" as const,
          content: contentToText(message.content),
        };
      }
    }

    if (message.role === "tool_result") {
      return {
        role: "tool" as const,
        content: contentToText(message.content),
        toolResult: contentToText(message.content),
      };
    }

    const role = message.role === "system" || message.role === "user" || message.role === "assistant"
      ? message.role
      : "user";
    return {
      role,
      content: contentToText(message.content),
    };
  });
}

function buildCheckpointMarkdown(args: {
  cycleIndex: number;
  start: number;
  end: number;
  toolCallCount: number;
  narrative: string;
  archiveRefs: string[];
  tokensSaved: number;
  degraded: boolean;
}): string {
  const header = `[cycle_checkpoint cycle=${args.cycleIndex} messages=${args.start}-${args.end} saved≈${args.tokensSaved}${args.degraded ? " degraded=1" : ""}]`;
  const refs = args.archiveRefs.length > 0
    ? ["## Archive refs", ...args.archiveRefs.map((ref) => `- ${ref}`)]
    : ["## Archive refs", "- (none)"];
  const cycleMeta = [
    "## Cycle",
    `index: ${args.cycleIndex} · messages: ${args.start}-${args.end} · tool_calls: ${args.toolCallCount}`,
  ];
  const body = args.narrative.trim();
  const withTitle = body.startsWith("## ")
    ? `## Cycle checkpoint\n\n${body}`
    : `## Cycle checkpoint\n\n${body}`;
  return [header, withTitle, ...refs, ...cycleMeta].join("\n");
}

function computeAttribution(args: {
  messages: ExecutorMessage[];
  budgetTokens: number;
  systemFramingTokens?: number;
  toolsSchemaTokens?: number;
}): WorkingSetAttribution {
  let exactToolResultTokens = 0;
  let receiptTokens = 0;
  let digestTokens = 0;
  let checkpointTokens = 0;
  let otherMessageTokens = 0;

  for (const message of args.messages) {
    const text = contentToText(message.content);
    const tokens = estimateTextTokens(text);

    if (isCheckpointMessage(message)) {
      checkpointTokens += tokens;
      continue;
    }

    if (message.role === "tool_result" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const blockText = typeof block.content === "string"
          ? block.content
          : safeStringify(block.content ?? "");
        const blockTokens = estimateTextTokens(blockText);
        if (isDigestContent(block.content)) digestTokens += blockTokens;
        else if (isReceiptContent(block.content)) receiptTokens += blockTokens;
        else exactToolResultTokens += blockTokens;
      }
      continue;
    }

    otherMessageTokens += tokens;
  }

  const systemFramingTokens = Math.max(0, args.systemFramingTokens ?? 0);
  const toolsSchemaTokens = Math.max(0, args.toolsSchemaTokens ?? 0);
  const activeHistoryTokens = exactToolResultTokens
    + receiptTokens
    + digestTokens
    + checkpointTokens
    + otherMessageTokens;
  const totalProjectedTokens = systemFramingTokens + toolsSchemaTokens + activeHistoryTokens;

  return {
    systemFramingTokens,
    toolsSchemaTokens,
    activeHistoryTokens,
    exactToolResultTokens,
    receiptTokens,
    digestTokens,
    checkpointTokens,
    otherMessageTokens,
    totalProjectedTokens,
    budgetTokens: args.budgetTokens,
    overBudgetTokens: Math.max(0, activeHistoryTokens - args.budgetTokens),
  };
}

function selectReason(args: {
  tokensSaved: number;
  receiptsApplied: number;
  digestsApplied: number;
  checkpointsApplied: number;
  checkpointsRejected: number;
  archiveFailures: number;
  eligibleCount: number;
  cyclesEligible: number;
  activeHistoryTokens: number;
  budgetTokens: number;
  hitDeadline: boolean;
  summarizerFailed: boolean;
}): WorkingSetProjectionReason {
  const consumedApplied = args.receiptsApplied + args.digestsApplied;
  const applied = args.tokensSaved > 0 && (consumedApplied > 0 || args.checkpointsApplied > 0);

  if (applied) {
    if (consumedApplied > 0 && args.checkpointsApplied > 0) return "receipts_and_checkpoints";
    if (args.checkpointsApplied > 0) return "checkpoint_applied";
    if (consumedApplied > 0) {
      // Preserve legacy reason when only archive receipts applied (no digests/checkpoints).
      if (args.digestsApplied === 0) return "historical_tool_receipts";
      return "closed_cycle_receipts";
    }
  }

  if (args.hitDeadline && args.checkpointsApplied === 0 && args.cyclesEligible > 0) {
    return "checkpoint_deadline";
  }
  if (args.summarizerFailed && args.checkpointsApplied === 0 && args.cyclesEligible > 0) {
    return "checkpoint_summarizer_failed";
  }
  if (args.checkpointsRejected > 0) return "checkpoint_rejected_immaterial";
  if (args.archiveFailures > 0 && consumedApplied === 0 && args.eligibleCount > 0) {
    return "archive_unavailable";
  }
  if (args.activeHistoryTokens > args.budgetTokens && args.cyclesEligible === 0) {
    return "protected_cycles_only";
  }
  if (args.activeHistoryTokens <= args.budgetTokens && consumedApplied === 0) {
    return "under_active_history_budget";
  }
  return "no_eligible_tool_outputs";
}

async function projectConsumedToolResult(args: {
  content: string;
  toolCallId: string;
  isError?: boolean;
  toolName?: string;
  action?: string;
  runId: string;
  sessionId?: string;
}): Promise<{
  content: string;
  kind: "receipt" | "digest";
  archived: boolean;
  failed: boolean;
}> {
  // Size gates archival only. All consumed results leave the exact path.
  if (shouldForceArchive(args.content, args.isError)) {
    try {
      const archived = await ensureToolOutputArchived({
        toolName: args.toolName || "unknown_tool",
        action: args.action,
        sessionId: args.sessionId,
        runId: args.runId,
        toolCallId: args.toolCallId,
        result: args.content,
        operationKey: archiveOperationKey({
          sessionId: args.sessionId,
          runId: args.runId,
          toolCallId: args.toolCallId,
        }),
        maxPreviewChars: args.isError ? 1_200 : 2_000,
      });
      if (archived.formattedRef) {
        return {
          content: archived.formattedRef,
          kind: "receipt",
          archived: archived.outcome === "created" || archived.outcome === "reused",
          failed: false,
        };
      }
      // Archive unavailable — fall through to digest so consumed results still leave exact path.
      log.warn(
        `consumed archive unavailable toolCallId=${args.toolCallId} outcome=${archived.outcome}`,
      );
    } catch (error) {
      log.warn(
        `consumed archive failed toolCallId=${args.toolCallId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    content: buildCompactDigest({
      toolName: args.toolName,
      action: args.action,
      toolCallId: args.toolCallId,
      content: args.content,
      isError: args.isError,
    }),
    kind: "digest",
    archived: false,
    failed: shouldForceArchive(args.content, args.isError),
  };
}

async function applyConsumedReceipts(args: {
  messages: ExecutorMessage[];
  runId: string;
  sessionId?: string;
  providerConsumedToolCallIds?: ReadonlySet<string>;
}): Promise<{
  receiptsApplied: number;
  digestsApplied: number;
  archivesCreated: number;
  skippedProtected: number;
  skippedAlreadyReceipt: number;
  archiveFailures: number;
  eligibleCount: number;
}> {
  const projected = args.messages;
  const lastAssistantIndex = projected.reduce(
    (latest, message, index) => (message.role === "assistant" ? index : latest),
    -1,
  );
  const metadata = toolMetadata(projected);
  const providersConsumed = args.providerConsumedToolCallIds
    ? new Set(args.providerConsumedToolCallIds)
    : undefined;

  let receiptsApplied = 0;
  let digestsApplied = 0;
  let archivesCreated = 0;
  let skippedProtected = 0;
  let skippedAlreadyReceipt = 0;
  let archiveFailures = 0;
  let eligibleCount = 0;

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
      )) {
        skippedProtected += 1;
        continue;
      }

      if (isReceiptContent(block.content) || isDigestContent(block.content)) {
        skippedAlreadyReceipt += 1;
        continue;
      }

      // All consumed tool results are eligible. Size gates archival only.
      eligibleCount += 1;
      if (!toolCallId) {
        archiveFailures += 1;
        continue;
      }

      const tool = metadata.get(toolCallId);
      const projectedContent = await projectConsumedToolResult({
        content: block.content,
        toolCallId,
        isError: Boolean(block.is_error),
        toolName: tool?.toolName,
        action: tool?.action,
        runId: args.runId,
        sessionId: args.sessionId,
      });

      nextBlocks[blockIndex] = { ...block, content: projectedContent.content };
      changed = true;

      if (projectedContent.kind === "receipt") {
        receiptsApplied += 1;
        if (projectedContent.archived) archivesCreated += 1;
      } else {
        digestsApplied += 1;
      }
      if (projectedContent.failed) archiveFailures += 1;
    }

    if (changed) projected[messageIndex] = { ...message, content: nextBlocks };
  }

  return {
    receiptsApplied,
    digestsApplied,
    archivesCreated,
    skippedProtected,
    skippedAlreadyReceipt,
    archiveFailures,
    eligibleCount,
  };
}

async function checkpointOldestEligibleSpans(args: {
  messages: ExecutorMessage[];
  sessionId?: string;
  budgetTokens: number;
  materialTokens: number;
  protectedRecentCompleted: number;
}): Promise<{
  checkpointsApplied: number;
  checkpointsRejected: number;
  cyclesDetected: number;
  cyclesProtected: number;
  cyclesEligible: number;
  hitDeadline: boolean;
  summarizerFailed: boolean;
}> {
  const projected = args.messages;
  const deadlineAt = Date.now() + CHECKPOINT_DEADLINE_MS;
  let checkpointsApplied = 0;
  let checkpointsRejected = 0;
  let hitDeadline = false;
  let summarizerFailed = false;
  let initialCyclesDetected = 0;
  let initialCyclesProtected = 0;
  let initialCyclesEligible = 0;
  let firstPass = true;

  while (estimateMessagesTokens(projected) > args.budgetTokens) {
    if (Date.now() >= deadlineAt) {
      hitDeadline = true;
      break;
    }

    const spans = detectCycleSpans(projected);
    const protectedKeys = protectedSpanKeys(spans, args.protectedRecentCompleted);
    const eligible = spans
      .filter((span) => span.completed && !protectedKeys.has(spanKey(span)))
      .sort((a, b) => a.start - b.start);

    if (firstPass) {
      initialCyclesDetected = spans.length;
      initialCyclesProtected = spans.filter((span) => protectedKeys.has(spanKey(span))).length;
      initialCyclesEligible = eligible.length;
      firstPass = false;
    }

    if (eligible.length === 0) break;

    const span = eligible[0];
    const spanMessages = projected.slice(span.start, span.end + 1);
    const tokensBeforeCollapse = estimateMessagesTokens(spanMessages);
    const archiveRefs = collectArchiveRefsFromMessages(spanMessages);
    const summarizable = toSummarizableMessages(spanMessages);
    const capsule = buildContinuationCapsule(toCapsuleEntries(spanMessages));
    const capsuleFacts = renderContinuationCapsule(capsule);

    let narrative: string | null = null;
    let degraded = false;
    try {
      const summary = await summarizeCompactedMessages({
        sessionId: args.sessionId || "working-set",
        messages: summarizable,
        capsuleFacts,
        deadlineAt,
      });
      if (summary?.narrative) {
        narrative = summary.narrative;
      } else {
        summarizerFailed = true;
        degraded = true;
        narrative = capsuleFacts;
      }
    } catch (error) {
      summarizerFailed = true;
      degraded = true;
      narrative = capsuleFacts;
      log.warn(
        `checkpoint summarizer failed span=${span.start}-${span.end}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!narrative || !narrative.trim()) {
      checkpointsRejected += 1;
      break;
    }

    const provisionalText = buildCheckpointMarkdown({
      cycleIndex: span.cycleIndex >= 0 ? span.cycleIndex : 0,
      start: span.start,
      end: span.end,
      toolCallCount: span.toolCallIds.length,
      narrative,
      archiveRefs,
      tokensSaved: Math.max(0, tokensBeforeCollapse - estimateTextTokens(narrative)),
      degraded,
    });
    const provisionalTokens = estimateTextTokens(provisionalText);
    const tokensSaved = tokensBeforeCollapse - provisionalTokens;
    if (tokensSaved < args.materialTokens) {
      checkpointsRejected += 1;
      break;
    }

    const checkpointMessage: ExecutorMessage = {
      role: "assistant",
      content: buildCheckpointMarkdown({
        cycleIndex: span.cycleIndex >= 0 ? span.cycleIndex : 0,
        start: span.start,
        end: span.end,
        toolCallCount: span.toolCallIds.length,
        narrative,
        archiveRefs,
        tokensSaved,
        degraded,
      }),
    };

    // Collapse the whole cycle span (assistant tool_use + tool_results + final)
    // into one checkpoint message on the provider projection only.
    projected.splice(span.start, span.end - span.start + 1, checkpointMessage);
    checkpointsApplied += 1;
  }

  if (firstPass) {
    const spans = detectCycleSpans(projected);
    const protectedKeys = protectedSpanKeys(spans, args.protectedRecentCompleted);
    initialCyclesDetected = spans.length;
    initialCyclesProtected = spans.filter((span) => protectedKeys.has(spanKey(span))).length;
    initialCyclesEligible = spans.filter(
      (span) => span.completed && !protectedKeys.has(spanKey(span)),
    ).length;
  }

  return {
    checkpointsApplied,
    checkpointsRejected,
    cyclesDetected: initialCyclesDetected,
    cyclesProtected: initialCyclesProtected,
    cyclesEligible: initialCyclesEligible,
    hitDeadline,
    summarizerFailed,
  };
}

export async function projectWorkingSet(args: {
  messages: ExecutorMessage[];
  runId: string;
  sessionId?: string;
  sessionKey?: string;
  source?: string;
  providerConsumedToolCallIds?: ReadonlySet<string>;
  /** Optional outer-request framing tokens for attribution only (not projected here). */
  systemFramingTokens?: number;
  /** Optional tools-schema tokens for attribution only (not projected here). */
  toolsSchemaTokens?: number;
  activeHistoryBudgetTokens?: number;
  protectedRecentCompletedCycles?: number;
  materialCheckpointReductionTokens?: number;
}): Promise<WorkingSetProjectionResult> {
  const budgetTokens = args.activeHistoryBudgetTokens ?? ACTIVE_HISTORY_BUDGET_TOKENS;
  const protectedRecent = args.protectedRecentCompletedCycles ?? PROTECTED_RECENT_COMPLETED_CYCLES;
  const materialTokens = args.materialCheckpointReductionTokens ?? MATERIAL_CHECKPOINT_REDUCTION_TOKENS;

  const projected = cloneMessages(args.messages);
  const tokensOriginal = estimateMessagesTokens(projected);

  const receiptStats = await applyConsumedReceipts({
    messages: projected,
    runId: args.runId,
    sessionId: args.sessionId,
    providerConsumedToolCallIds: args.providerConsumedToolCallIds,
  });

  let checkpointStats = {
    checkpointsApplied: 0,
    checkpointsRejected: 0,
    cyclesDetected: 0,
    cyclesProtected: 0,
    cyclesEligible: 0,
    hitDeadline: false,
    summarizerFailed: false,
  };

  const tokensAfterReceipts = estimateMessagesTokens(projected);
  if (tokensAfterReceipts > budgetTokens) {
    checkpointStats = await checkpointOldestEligibleSpans({
      messages: projected,
      sessionId: args.sessionId,
      budgetTokens,
      materialTokens,
      protectedRecentCompleted: protectedRecent,
    });
  } else {
    const spans = detectCycleSpans(projected);
    const protectedKeys = protectedSpanKeys(spans, protectedRecent);
    checkpointStats = {
      checkpointsApplied: 0,
      checkpointsRejected: 0,
      cyclesDetected: spans.length,
      cyclesProtected: spans.filter((span) => protectedKeys.has(spanKey(span))).length,
      cyclesEligible: spans.filter(
        (span) => span.completed && !protectedKeys.has(spanKey(span)),
      ).length,
      hitDeadline: false,
      summarizerFailed: false,
    };
  }

  const tokensProjected = estimateMessagesTokens(projected);
  const tokensSaved = Math.max(0, tokensOriginal - tokensProjected);
  const attribution = computeAttribution({
    messages: projected,
    budgetTokens,
    systemFramingTokens: args.systemFramingTokens,
    toolsSchemaTokens: args.toolsSchemaTokens,
  });

  const reason = selectReason({
    tokensSaved,
    receiptsApplied: receiptStats.receiptsApplied,
    digestsApplied: receiptStats.digestsApplied,
    checkpointsApplied: checkpointStats.checkpointsApplied,
    checkpointsRejected: checkpointStats.checkpointsRejected,
    archiveFailures: receiptStats.archiveFailures,
    eligibleCount: receiptStats.eligibleCount,
    cyclesEligible: checkpointStats.cyclesEligible,
    activeHistoryTokens: attribution.activeHistoryTokens,
    budgetTokens,
    hitDeadline: checkpointStats.hitDeadline,
    summarizerFailed: checkpointStats.summarizerFailed,
  });

  const outcome: WorkingSetProjectionOutcome =
    tokensSaved > 0
    && (
      receiptStats.receiptsApplied > 0
      || receiptStats.digestsApplied > 0
      || checkpointStats.checkpointsApplied > 0
    )
      ? "applied"
      : "skipped";

  const telemetry: WorkingSetProjectionTelemetry = {
    outcome,
    reason,
    tokensOriginal,
    tokensProjected,
    tokensSaved,
    receiptsApplied: receiptStats.receiptsApplied,
    archiveFailures: receiptStats.archiveFailures,
    digestsApplied: receiptStats.digestsApplied,
    archivesCreated: receiptStats.archivesCreated,
    skippedProtected: receiptStats.skippedProtected,
    skippedAlreadyReceipt: receiptStats.skippedAlreadyReceipt,
    eligibleCount: receiptStats.eligibleCount,
    checkpointsApplied: checkpointStats.checkpointsApplied,
    checkpointsRejected: checkpointStats.checkpointsRejected,
    cyclesDetected: checkpointStats.cyclesDetected,
    cyclesProtected: checkpointStats.cyclesProtected,
    cyclesEligible: checkpointStats.cyclesEligible,
    activeHistoryBudgetTokens: budgetTokens,
    source: args.source,
    runId: args.runId,
    sessionId: args.sessionId,
    attribution,
  };

  log.log(
    `projectWorkingSet source=${args.source || "unknown"} outcome=${outcome} reason=${reason} ` +
    `original=${tokensOriginal} projected=${tokensProjected} saved=${tokensSaved} ` +
    `receipts=${receiptStats.receiptsApplied} digests=${receiptStats.digestsApplied} ` +
    `checkpoints=${checkpointStats.checkpointsApplied} ` +
    `activeHistory=${attribution.activeHistoryTokens}/${budgetTokens} ` +
    `exact=${attribution.exactToolResultTokens} receiptTok=${attribution.receiptTokens} ` +
    `digestTok=${attribution.digestTokens} checkpointTok=${attribution.checkpointTokens}`,
  );

  return { messages: projected, telemetry };
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
  const shouldArchive = size.estimatedTokens >= DEFAULT_TOOL_OUTPUT_POLICY.forceArtifactTokens
    || size.estimatedTokens > DEFAULT_TOOL_OUTPUT_POLICY.maxInlineTokens
    || size.chars > DEFAULT_TOOL_OUTPUT_POLICY.maxInlineChars;

  if (!shouldArchive) {
    // Small results stay exact on the first post-tool turn. Historical path
    // still gets a compact digest once the result is consumed (material-refresh only).
    const digest = buildCompactDigest({
      toolName: args.toolName,
      action,
      toolCallId: args.toolCallId,
      content: args.result,
      isError: args.error,
    });
    const historicalTokens = estimateToolOutputSize(digest).estimatedTokens;
    const refreshReductionTokens = Math.max(0, size.estimatedTokens - historicalTokens);
    return {
      providerResult: args.result,
      historicalProviderResult: refreshReductionTokens > 0 ? digest : undefined,
      originalTokens: size.estimatedTokens,
      historicalTokens: refreshReductionTokens > 0 ? historicalTokens : size.estimatedTokens,
      refreshReductionTokens,
      canMateriallyShrinkOnRefresh: refreshReductionTokens >= MATERIAL_REFRESH_REDUCTION_TOKENS,
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
    // Exact-once: first post-tool inference still sees the exact body.
    // Historical path uses the receipt once the provider has consumed it.
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
