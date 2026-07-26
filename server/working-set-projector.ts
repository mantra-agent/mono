import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import { parseReferenceText } from "@shared/reference-parser";
import { redactSensitiveValue } from "./sensitive-data-redaction";
import { safeStringify } from "./utils/safe-stringify";
import {
  ensureToolOutputArchived,
  estimateToolOutputSize,
  type EnsureToolOutputArchiveResult,
} from "./tool-output-artifacts";
import type { ContentBlock, ExecutorMessage } from "./agent-executor";

const log = createLogger("WorkingSetProjector");

const PROJECTED_SAVINGS_FLOOR_TOKENS = Number(process.env.WORKING_SET_PROJECTED_SAVINGS_FLOOR_TOKENS || 8_000);
export const CURRENT_CYCLE_TOOL_RESULT_BUDGET_TOKENS = Number(process.env.WORKING_SET_TOOL_RESULT_CYCLE_BUDGET_TOKENS || 20_000);
const RECEIPT_ARGUMENT_BYTES = 1_200;
const MAX_RECEIPT_REFERENCES = 12;
const MUTATION_ACTION_PATTERN = /^(create|update|delete|remove|add|merge|set|complete|close|open|save|publish|deploy|activate|disable|enable|rename|link|unlink|resolve|reopen|lock|cancel|trigger|apply|write|edit)/i;

interface CompletedToolInteraction {
  resultMessageIndex: number;
  consumed: boolean;
  toolUse: ContentBlock;
  result: ContentBlock;
}

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
    if (typeof message.content === "string") return total + Math.ceil(message.content.length / 3.5);
    return total + message.content.reduce((sum, block) => {
      const value = block.text || block.thinking || block.content || safeStringify(block.input || {}, {
        maxBytes: 8_000,
        label: "working-set-projector.token-estimate",
      });
      return sum + Math.ceil(value.length / 3.5);
    }, 0);
  }, 0);
}

function collectCompletedInteractions(messages: ExecutorMessage[]): CompletedToolInteraction[] {
  const toolUses = new Map<string, ContentBlock>();
  const completed: CompletedToolInteraction[] = [];
  const lastAssistantMessageIndex = messages.findLastIndex((message) => message.role === "assistant");

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (!Array.isArray(message.content)) continue;
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool_use" && block.id) {
          toolUses.set(block.id, block);
        }
      }
      continue;
    }
    if (message.role !== "tool_result") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result" || !block.tool_use_id || block.is_error || block.content == null) continue;
      const use = toolUses.get(block.tool_use_id);
      if (!use) continue;
      completed.push({
        resultMessageIndex: messageIndex,
        consumed: lastAssistantMessageIndex > messageIndex,
        toolUse: use,
        result: block,
      });
    }
  }
  return completed;
}

function collectReferences(args: Record<string, unknown>, result: string): string[] {
  const references: string[] = [];
  const addFrom = (value: string) => {
    for (const part of parseReferenceText(value)) {
      if (part.kind !== "reference" || references.includes(part.ref.canonical)) continue;
      references.push(part.ref.canonical);
      if (references.length >= MAX_RECEIPT_REFERENCES) return;
    }
  };
  addFrom(safeStringify(redactSensitiveValue(args), {
    maxBytes: 4_000,
    maxDepth: 4,
    maxKeys: 20,
    maxArrayItems: 20,
    maxStrLen: 600,
    label: "working-set-projector.reference-args",
  }));
  if (references.length < MAX_RECEIPT_REFERENCES) addFrom(result.slice(0, 16_000));
  return references;
}

function formatImportantArguments(args: Record<string, unknown>): string {
  const important = Object.fromEntries(Object.entries(args).filter(([key, value]) => {
    if (value == null || value === "") return false;
    return /^(action|id|.*Id|.*_id|query|name|title|status|path|route|file|branch|url|target|source|reason)$/i.test(key);
  }));
  const selected = Object.keys(important).length > 0 ? important : args;
  return safeStringify(redactSensitiveValue(selected), {
    maxBytes: RECEIPT_ARGUMENT_BYTES,
    maxDepth: 3,
    maxKeys: 16,
    maxArrayItems: 12,
    maxStrLen: 400,
    label: "working-set-projector.receipt-args",
  });
}

function buildReceipt(interaction: CompletedToolInteraction, archive: EnsureToolOutputArchiveResult): string {
  const args = interaction.toolUse.input || {};
  const toolName = interaction.toolUse.name || "unknown";
  const action = typeof args.action === "string" ? args.action : undefined;
  const references = collectReferences(args, interaction.result.content || "");
  const mutation = action && MUTATION_ACTION_PATTERN.test(action) ? "mutation" : "read";
  return [
    "[Tool Action Receipt v1]",
    `Tool: ${toolName}${action ? ` action=${action}` : ""}`,
    `Arguments: ${formatImportantArguments(args)}`,
    `Outcome: success (${mutation})`,
    references.length > 0 ? `Object references: ${references.join(", ")}` : undefined,
    `Result archived: indexed_content/read_section id="${archive.ref!.refId}"`,
    `Original size: ${archive.size.chars.toLocaleString()} chars (~${archive.size.estimatedTokens.toLocaleString()} tokens)`,
    "Rehydrate by calling indexed_content with action=read_section and the archived id.",
  ].filter(Boolean).join("\n");
}

function archiveOperationKey(args: {
  sessionId?: string;
  runId: string;
  toolCallId: string;
}): string {
  return `working-set:${args.sessionId || "no-session"}:${args.runId}:${args.toolCallId}`;
}

function publishTelemetry(args: {
  runId: string;
  sessionId?: string;
  sessionKey: string;
  source: string;
  telemetry: WorkingSetProjectionTelemetry;
}): void {
  const payload = { ...args.telemetry, runId: args.runId, sessionId: args.sessionId || null, source: args.source };
  log.log(`working_set.projected ${Object.entries(payload).map(([key, value]) => `${key}=${value}`).join(" ")}`);
  eventBus.publish({
    category: "agent",
    event: "agent.working_set_projected",
    payload,
    runId: args.runId,
    sessionKey: args.sessionKey,
  });
}

export async function projectWorkingSet(args: {
  messages: ExecutorMessage[];
  runId: string;
  sessionId?: string;
  sessionKey: string;
  source: string;
}): Promise<{ messages: ExecutorMessage[]; telemetry: WorkingSetProjectionTelemetry }> {
  const tokensBefore = estimateMessagesTokens(args.messages);
  const completed = collectCompletedInteractions(args.messages);
  const candidates = completed.filter((interaction) => interaction.consumed);
  const unconsumedPairsPreserved = completed.length - candidates.length;
  const candidateTokens = candidates.reduce((sum, interaction) => sum + estimateToolOutputSize(interaction.result.content || "").estimatedTokens, 0);
  const hasOversizedCandidate = candidates.some((interaction) =>
    estimateToolOutputSize(interaction.result.content || "").estimatedTokens > PROJECTED_SAVINGS_FLOOR_TOKENS,
  );
  if (candidates.length === 0 || (candidateTokens < PROJECTED_SAVINGS_FLOOR_TOKENS && !hasOversizedCandidate)) {
    return {
      messages: args.messages,
      telemetry: {
        outcome: "skipped",
        reason: candidates.length === 0 ? "no_consumed_pairs" : "below_savings_floor",
        tokensBefore,
        tokensAfter: tokensBefore,
        tokensProjected: 0,
        charsProjected: 0,
        pairsProjected: 0,
        unconsumedPairsPreserved,
        archiveRefsCreated: 0,
        archiveRefsReused: 0,
        receiptsRehydratable: 0,
      },
    };
  }

  const projected = cloneMessages(args.messages);
  let pairsProjected = 0;
  let charsProjected = 0;
  let refsCreated = 0;
  let refsReused = 0;

  for (const interaction of candidates) {
    const result = interaction.result.content || "";
    const archive = await ensureToolOutputArchived({
      toolName: interaction.toolUse.name || "unknown",
      action: typeof interaction.toolUse.input?.action === "string" ? interaction.toolUse.input.action : undefined,
      sessionId: args.sessionId,
      runId: args.runId,
      toolCallId: interaction.toolUse.id,
      result,
      operationKey: archiveOperationKey({
        sessionId: args.sessionId,
        runId: args.runId,
        toolCallId: interaction.toolUse.id!,
      }),
      maxPreviewChars: 0,
    });
    if (!archive.ref) continue;
    const targetMessage = projected[interaction.resultMessageIndex];
    if (!Array.isArray(targetMessage.content)) continue;
    const targetBlock = targetMessage.content.find((block) => block.type === "tool_result" && block.tool_use_id === interaction.toolUse.id);
    if (!targetBlock) continue;
    targetBlock.content = buildReceipt(interaction, archive);
    pairsProjected++;
    charsProjected += result.length;
    if (archive.outcome === "created") refsCreated++;
    else refsReused++;
  }

  const tokensAfter = estimateMessagesTokens(projected);
  const telemetry: WorkingSetProjectionTelemetry = {
    outcome: pairsProjected > 0 ? (pairsProjected === candidates.length ? "projected" : "degraded") : "degraded",
    reason: pairsProjected === candidates.length ? "savings_floor_met" : "archive_failed_exact_preserved",
    tokensBefore,
    tokensAfter,
    tokensProjected: Math.max(0, tokensBefore - tokensAfter),
    charsProjected,
    pairsProjected,
    unconsumedPairsPreserved,
    archiveRefsCreated: refsCreated,
    archiveRefsReused: refsReused,
    receiptsRehydratable: pairsProjected,
  };
  publishTelemetry({ ...args, telemetry });
  return { messages: pairsProjected > 0 ? projected : args.messages, telemetry };
}

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
  if (args.error || size.estimatedTokens <= PROJECTED_SAVINGS_FLOOR_TOKENS) {
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
