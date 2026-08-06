import { and, eq, gte, sql } from "drizzle-orm";
import { documentStoreDocuments } from "@shared/models/memory";
import { planSteps, workflowRuns } from "@shared/schema";
import {
  normalizeReliabilityToolFailureLimit,
  normalizeReliabilityWindowHours,
  deriveReliabilityHealth,
  toReliabilityMetrics,
  type ReliabilityOutcomeSummary,
  type ReliabilityToolFailureFilters,
  type ReliabilityToolFailureKind,
  type ReliabilityToolFailureList,
  type ReliabilityToolFailureRow,
  type ReliabilityTurnFailureList,
  type ReliabilityTurnFailureRow,
} from "@shared/reliability-outcomes";
import { db } from "./db";
import { getCurrentPrincipal } from "./principal-context";
import { combineWithVisibleScope, type ScopeColumns } from "./scoped-storage";

const DOC_SCOPE: ScopeColumns = {
  ownerUserId: documentStoreDocuments.ownerUserId,
  accountId: documentStoreDocuments.accountId,
  scope: documentStoreDocuments.scope,
};

const PLAN_SCOPE: ScopeColumns = {
  ownerUserId: planSteps.ownerUserId,
  accountId: planSteps.accountId,
  scope: planSteps.scope,
};

const WORKFLOW_SCOPE: ScopeColumns = {
  ownerUserId: workflowRuns.ownerUserId,
  accountId: workflowRuns.accountId,
  scope: workflowRuns.scope,
};

type OutcomeCounts = {
  succeeded: number;
  failed: number;
  amberFailures: number;
  unclassifiedErrors: number;
  excluded: number;
};

type ChatToolCall = {
  toolName?: unknown;
  name?: unknown;
  status?: unknown;
  arguments?: unknown;
  args?: unknown;
  error?: unknown;
  result?: unknown;
  output?: unknown;
  failureKind?: unknown;
  toolCallId?: unknown;
  id?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  completedAt?: unknown;
  timestamp?: unknown;
  ts?: unknown;
};

type ChatMessage = {
  id?: unknown;
  role?: unknown;
  timestamp?: unknown;
  createdAt?: unknown;
  toolCalls?: unknown;
  assistantRunId?: unknown;
  turnId?: unknown;
  assistantState?: unknown;
};

type ChatDocumentContent = {
  messages?: unknown;
};

const FAILURE_KINDS = new Set<ReliabilityToolFailureKind>([
  "input",
  "permission",
  "transient",
  "internal",
]);

const ARGS_SUMMARY_MAX_CHARS = 240;
const RESULT_SNIPPET_MAX_CHARS = 280;
const ERROR_MAX_CHARS = 400;

function emptyCounts(): OutcomeCounts {
  return { succeeded: 0, failed: 0, amberFailures: 0, unclassifiedErrors: 0, excluded: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Chat rows store SessionData as a JSON string in document_store_documents.content
 * (text column via serializeSessionContent). Never cast the raw column as an object.
 */
function parseChatDocumentContent(raw: unknown): ChatDocumentContent {
  if (raw == null) return {};
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return asRecord(parsed) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(raw) ?? {};
}

function messagesFromChatDocument(raw: unknown): ChatMessage[] {
  const content = parseChatDocumentContent(raw);
  return Array.isArray(content.messages) ? (content.messages as ChatMessage[]) : [];
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Accept both epoch ms and epoch seconds.
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" && !(value instanceof Date)) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function messageTimestampMs(message: ChatMessage): number | null {
  return parseTimestampMs(message.timestamp) ?? parseTimestampMs(message.createdAt);
}

function isAssistantMessage(message: ChatMessage): boolean {
  return message.role === "assistant";
}

/**
 * A persisted `system_notice` message is the authoritative terminal record for
 * a conversational turn that ended abnormally (watchdog/idle/pipeline aborts,
 * model/provider errors, empty-response degradations, process restarts, or user
 * stops). It carries a known reason, so these turns are always *classified*.
 * Returns null for any message that is not a terminal notice.
 */
function parseTerminalNotice(
  message: ChatMessage,
): { outcome: "failed" | "excluded"; reason: string } | null {
  if (message.role !== "system_notice") return null;

  let payload: Record<string, unknown> | null = null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      payload = null;
    }
  } else if (content && typeof content === "object") {
    payload = content as Record<string, unknown>;
  }

  const asStr = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
  const errorType = asStr(payload?.errorType);
  const reason =
    asStr(payload?.terminationReason) ||
    asStr(payload?.abortReason) ||
    asStr(payload?.degradationReason) ||
    errorType ||
    "unknown";

  // User-initiated stops (cancel / supersede) are not failures — exclude them.
  if (errorType === "user_stopped") return { outcome: "excluded", reason };
  return { outcome: "failed", reason };
}

function countToolCalls(
  messages: ChatMessage[],
  windowStartMs: number,
  windowEndMs: number,
): { toolExecutions: OutcomeCounts; conversationalTurns: OutcomeCounts } {
  const toolExecutions = emptyCounts();
  const conversationalTurns = emptyCounts();

  // The turn outcome for the most recent in-window assistant message is held
  // pending so a trailing terminal `system_notice` can override it — an aborted
  // turn whose tools all completed must not be counted as a success.
  let pendingTurn: "succeeded" | "failed" | "excluded" | null = null;
  let pendingHasUnclassified = false;
  // Guards against a rare run of consecutive notices for the same turn being
  // counted as multiple turns; a real assistant message clears it.
  let lastCountedNotice = false;

  const commitPending = () => {
    if (!pendingTurn) return;
    if (pendingTurn === "failed") {
      conversationalTurns.failed += 1;
      if (pendingHasUnclassified) conversationalTurns.unclassifiedErrors += 1;
      else conversationalTurns.amberFailures += 1;
    } else {
      conversationalTurns[pendingTurn] += 1;
    }
    pendingTurn = null;
    pendingHasUnclassified = false;
  };

  for (const message of messages) {
    // Terminal notice: authoritative terminal outcome for the current turn.
    const notice = parseTerminalNotice(message);
    if (notice) {
      const ts = messageTimestampMs(message);
      if (ts == null || ts < windowStartMs || ts > windowEndMs) continue;
      // Discard any provisional assistant outcome — the notice is authoritative.
      const hadPending = pendingTurn != null;
      pendingTurn = null;
      pendingHasUnclassified = false;
      if (lastCountedNotice && !hadPending) continue; // collapse duplicate notices
      if (notice.outcome === "excluded") {
        conversationalTurns.excluded += 1;
      } else {
        // Reason is known → classified (amber), never unclassified.
        conversationalTurns.failed += 1;
        conversationalTurns.amberFailures += 1;
      }
      lastCountedNotice = true;
      continue;
    }

    if (!isAssistantMessage(message)) continue;
    const ts = messageTimestampMs(message);
    if (ts == null || ts < windowStartMs || ts > windowEndMs) continue;

    // New assistant turn starts: commit the previous provisional outcome.
    commitPending();
    lastCountedNotice = false;

    const toolCalls = Array.isArray(message.toolCalls) ? (message.toolCalls as ChatToolCall[]) : [];
    let turnFailed = false;
    let turnHasUnclassified = false;
    let turnHasTerminalTool = false;

    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") continue;
      if (toolCall.status === "done") {
        toolExecutions.succeeded += 1;
        turnHasTerminalTool = true;
        continue;
      }
      if (toolCall.status === "error") {
        toolExecutions.failed += 1;
        // Amber = classified/avoidable; red = missing failureKind.
        if (asFailureKind(toolCall.failureKind)) {
          toolExecutions.amberFailures += 1;
        } else {
          toolExecutions.unclassifiedErrors += 1;
          turnHasUnclassified = true;
        }
        turnFailed = true;
        turnHasTerminalTool = true;
        continue;
      }
      // running / unknown statuses are not terminal outcomes
      toolExecutions.excluded += 1;
    }

    // Hold provisional turn outcome; a trailing terminal notice may override it.
    if (!turnHasTerminalTool) {
      pendingTurn = "excluded";
    } else if (turnFailed) {
      pendingTurn = "failed";
      pendingHasUnclassified = turnHasUnclassified;
    } else {
      pendingTurn = "succeeded";
    }
  }

  commitPending();

  return { toolExecutions, conversationalTurns };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function asFailureKind(value: unknown): ReliabilityToolFailureKind | null {
  if (typeof value !== "string") return null;
  return FAILURE_KINDS.has(value as ReliabilityToolFailureKind)
    ? (value as ReliabilityToolFailureKind)
    : null;
}

function toolCallName(toolCall: ChatToolCall): string {
  if (typeof toolCall.toolName === "string" && toolCall.toolName.trim()) return toolCall.toolName.trim();
  if (typeof toolCall.name === "string" && toolCall.name.trim()) return toolCall.name.trim();
  return "unknown";
}

function toolCallArguments(toolCall: ChatToolCall): Record<string, unknown> | null {
  return asRecord(toolCall.arguments) ?? asRecord(toolCall.args);
}

function toolCallAction(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const action = args.action;
  if (typeof action === "string" && action.trim()) return action.trim();
  return null;
}

function summarizeArgs(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  try {
    return truncateText(compactText(JSON.stringify(args)), ARGS_SUMMARY_MAX_CHARS);
  } catch {
    return null;
  }
}

function stringifyUnknown(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = compactText(value);
    return text ? text : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return compactText(JSON.stringify(value));
  } catch {
    return null;
  }
}

function extractErrorText(toolCall: ChatToolCall): string {
  const direct = stringifyUnknown(toolCall.error);
  if (direct) return truncateText(direct, ERROR_MAX_CHARS);

  const resultText = stringifyUnknown(toolCall.result) ?? stringifyUnknown(toolCall.output);
  if (resultText) return truncateText(resultText, ERROR_MAX_CHARS);

  return "Tool call failed";
}

function extractFailureCode(toolCall: ChatToolCall, errorText: string): string | null {
  const errorRecord = asRecord(toolCall.error);
  if (errorRecord) {
    const code = errorRecord.code ?? errorRecord.failureCode;
    if (typeof code === "string" && code.trim()) return code.trim();
  }

  const resultRecord = asRecord(toolCall.result);
  if (resultRecord) {
    const code = resultRecord.code ?? resultRecord.failureCode;
    if (typeof code === "string" && code.trim()) return code.trim();
    const failure = asRecord(resultRecord.failure);
    if (failure && typeof failure.code === "string" && failure.code.trim()) {
      return failure.code.trim();
    }
  }

  // Common serialized forms: "shell_policy_denied: ..." or "code=shell_policy_denied"
  const prefixMatch = errorText.match(/^([a-z][a-z0-9_]{2,64})\s*:/i);
  if (prefixMatch?.[1]) return prefixMatch[1];

  const codeEqMatch = errorText.match(/\bcode\s*=\s*([a-z][a-z0-9_]{2,64})\b/i);
  if (codeEqMatch?.[1]) return codeEqMatch[1];

  return null;
}

function toolCallTimestampMs(toolCall: ChatToolCall, messageTs: number): number {
  return (
    parseTimestampMs(toolCall.endedAt)
    ?? parseTimestampMs(toolCall.completedAt)
    ?? parseTimestampMs(toolCall.startedAt)
    ?? parseTimestampMs(toolCall.timestamp)
    ?? parseTimestampMs(toolCall.ts)
    ?? messageTs
  );
}

function resultSnippetFor(toolCall: ChatToolCall): string | null {
  const text =
    stringifyUnknown(toolCall.result)
    ?? stringifyUnknown(toolCall.output)
    ?? stringifyUnknown(toolCall.error);
  if (!text) return null;
  return truncateText(text, RESULT_SNIPPET_MAX_CHARS);
}

function normalizeOptionalFilter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeFailureKindFilter(value: unknown): ReliabilityToolFailureKind | null {
  const kind = asFailureKind(normalizeOptionalFilter(value));
  return kind;
}

function collectToolFailuresFromMessages(
  sessionId: string,
  messages: ChatMessage[],
  windowStartMs: number,
  windowEndMs: number,
  filters: ReliabilityToolFailureFilters,
): ReliabilityToolFailureRow[] {
  const rows: ReliabilityToolFailureRow[] = [];

  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;
    const messageTs = messageTimestampMs(message);
    if (messageTs == null) continue;

    const toolCalls = Array.isArray(message.toolCalls) ? (message.toolCalls as ChatToolCall[]) : [];
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") continue;
      if (toolCall.status !== "error") continue;

      const ts = toolCallTimestampMs(toolCall, messageTs);
      if (ts < windowStartMs || ts > windowEndMs) continue;

      const tool = toolCallName(toolCall);
      if (filters.toolName && tool !== filters.toolName) continue;

      const failureKind = asFailureKind(toolCall.failureKind);
      if (filters.failureKind && failureKind !== filters.failureKind) continue;

      const args = toolCallArguments(toolCall);
      const error = extractErrorText(toolCall);
      const code = extractFailureCode(toolCall, error);
      if (filters.code && code !== filters.code) continue;

      const toolCallId =
        typeof toolCall.toolCallId === "string" && toolCall.toolCallId.trim()
          ? toolCall.toolCallId.trim()
          : typeof toolCall.id === "string" && toolCall.id.trim()
            ? toolCall.id.trim()
            : null;

      rows.push({
        timestamp: new Date(ts).toISOString(),
        sessionId,
        tool,
        action: toolCallAction(args),
        failureKind,
        code,
        error,
        argsSummary: summarizeArgs(args),
        resultSnippet: resultSnippetFor(toolCall),
        toolCallId,
      });
    }
  }

  return rows;
}

type PendingTurnDetail = {
  timestamp: string;
  sessionId: string;
  runId: string | null;
  turnId: string | null;
  failedTools: ChatToolCall[];
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toolCallId(toolCall: ChatToolCall): string | null {
  return stringValue(toolCall.toolCallId) ?? stringValue(toolCall.id);
}

function finalRunStatusForReason(reason: string): ReliabilityTurnFailureRow["finalRunStatus"] {
  return reason === "output_limit_no_final" || reason === "empty_model_completion"
    ? "degraded"
    : "failed";
}

function turnFailureFromTool(args: PendingTurnDetail): ReliabilityTurnFailureRow | null {
  const primary = args.failedTools[args.failedTools.length - 1];
  if (!primary) return null;
  const errorText = extractErrorText(primary);
  return {
    timestamp: args.timestamp,
    sessionId: args.sessionId,
    runId: args.runId,
    turnId: args.turnId,
    terminalReason: "tool_error",
    finalRunStatus: "unknown",
    toolErrorsRecovered: false,
    toolFailureKind: asFailureKind(primary.failureKind),
    toolFailureCode: extractFailureCode(primary, errorText),
    tool: toolCallName(primary),
    toolCallId: toolCallId(primary),
  };
}

function collectTurnFailures(
  messages: ChatMessage[],
  sessionId: string,
  windowStartMs: number,
  windowEndMs: number,
): ReliabilityTurnFailureRow[] {
  const failures: ReliabilityTurnFailureRow[] = [];
  let pending: PendingTurnDetail | null = null;
  let lastCountedNotice = false;

  const commitPending = () => {
    if (!pending) return;
    const failure = turnFailureFromTool(pending);
    if (failure) failures.push(failure);
    pending = null;
  };

  for (const message of messages) {
    const notice = parseTerminalNotice(message);
    if (notice) {
      const timestampMs = messageTimestampMs(message);
      if (
        notice.outcome === "failed"
        && !lastCountedNotice
        && timestampMs != null
        && timestampMs >= windowStartMs
        && timestampMs <= windowEndMs
      ) {
        const failedTools = pending?.failedTools ?? [];
        const primary = failedTools[failedTools.length - 1] ?? null;
        const errorText = primary ? extractErrorText(primary) : "";
        failures.push({
          timestamp: new Date(timestampMs).toISOString(),
          sessionId,
          runId: pending?.runId ?? null,
          turnId: pending?.turnId ?? null,
          terminalReason: notice.reason,
          finalRunStatus: finalRunStatusForReason(notice.reason),
          toolErrorsRecovered: null,
          toolFailureKind: primary ? asFailureKind(primary.failureKind) : null,
          toolFailureCode: primary ? extractFailureCode(primary, errorText) : null,
          tool: primary ? toolCallName(primary) : null,
          toolCallId: primary ? toolCallId(primary) : null,
        });
      }
      pending = null;
      lastCountedNotice = true;
      continue;
    }

    if (!isAssistantMessage(message)) continue;
    commitPending();
    lastCountedNotice = false;
    const timestampMs = messageTimestampMs(message);
    if (timestampMs == null || timestampMs < windowStartMs || timestampMs > windowEndMs) continue;
    pending = {
      timestamp: new Date(timestampMs).toISOString(),
      sessionId,
      runId: stringValue(message.assistantRunId),
      turnId: stringValue(message.turnId),
      failedTools: asToolCalls(message.toolCalls).filter((toolCall) => toolCall.status === "error"),
    };
  }

  commitPending();
  return failures;
}

export async function getReliabilityOutcomeSummary(
  hoursInput?: number,
): Promise<ReliabilityOutcomeSummary> {
  const principal = getCurrentPrincipal();
  if (!principal) {
    throw new Error("Principal required for reliability outcomes");
  }

  const hours = normalizeReliabilityWindowHours(hoursInput);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const windowStartMs = start.getTime();
  const windowEndMs = end.getTime();

  const chatDocs = await db
    .select({
      content: documentStoreDocuments.content,
      updatedAt: documentStoreDocuments.updatedAt,
    })
    .from(documentStoreDocuments)
    .where(
      combineWithVisibleScope(
        principal,
        DOC_SCOPE,
        and(
          eq(documentStoreDocuments.documentType, "chat"),
          gte(documentStoreDocuments.updatedAt, start),
        ),
      ),
    );

  const toolExecutions = emptyCounts();
  const conversationalTurns = emptyCounts();

  for (const doc of chatDocs) {
    const messages = messagesFromChatDocument(doc.content);
    const counted = countToolCalls(messages, windowStartMs, windowEndMs);
    toolExecutions.succeeded += counted.toolExecutions.succeeded;
    toolExecutions.failed += counted.toolExecutions.failed;
    toolExecutions.amberFailures += counted.toolExecutions.amberFailures;
    toolExecutions.unclassifiedErrors += counted.toolExecutions.unclassifiedErrors;
    toolExecutions.excluded += counted.toolExecutions.excluded;
    conversationalTurns.succeeded += counted.conversationalTurns.succeeded;
    conversationalTurns.failed += counted.conversationalTurns.failed;
    conversationalTurns.amberFailures += counted.conversationalTurns.amberFailures;
    conversationalTurns.unclassifiedErrors += counted.conversationalTurns.unclassifiedErrors;
    conversationalTurns.excluded += counted.conversationalTurns.excluded;
  }

  const [planRow] = await db
    .select({
      succeeded: sql<number>`count(*) filter (where ${planSteps.status} = 'completed')::int`,
      failed: sql<number>`count(*) filter (where ${planSteps.status} = 'failed')::int`,
      excluded: sql<number>`count(*) filter (where ${planSteps.status} not in ('completed', 'failed'))::int`,
    })
    .from(planSteps)
    .where(
      combineWithVisibleScope(
        principal,
        PLAN_SCOPE,
        gte(planSteps.updatedAt, start),
      ),
    );

  const [workflowRow] = await db
    .select({
      succeeded: sql<number>`count(*) filter (where ${workflowRuns.status} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'failed')::int`,
      excluded: sql<number>`count(*) filter (where ${workflowRuns.status} not in ('succeeded', 'failed'))::int`,
    })
    .from(workflowRuns)
    .where(
      combineWithVisibleScope(
        principal,
        WORKFLOW_SCOPE,
        gte(workflowRuns.updatedAt, start),
      ),
    );

  const planFailed = Number(planRow?.failed ?? 0);
  const workflowFailed = Number(workflowRow?.failed ?? 0);
  // Plan/workflow tables do not yet persist failureKind — count as unclassified until they do.
  const domains = {
    toolExecutions: toReliabilityMetrics(
      toolExecutions.succeeded,
      toolExecutions.failed,
      toolExecutions.excluded,
      toolExecutions.amberFailures,
      toolExecutions.unclassifiedErrors,
    ),
    conversationalTurns: toReliabilityMetrics(
      conversationalTurns.succeeded,
      conversationalTurns.failed,
      conversationalTurns.excluded,
      conversationalTurns.amberFailures,
      conversationalTurns.unclassifiedErrors,
    ),
    planSteps: toReliabilityMetrics(
      Number(planRow?.succeeded ?? 0),
      planFailed,
      Number(planRow?.excluded ?? 0),
      0,
      planFailed,
    ),
    workflowRuns: toReliabilityMetrics(
      Number(workflowRow?.succeeded ?? 0),
      workflowFailed,
      Number(workflowRow?.excluded ?? 0),
      0,
      workflowFailed,
    ),
  };

  return {
    window: {
      start: start.toISOString(),
      end: end.toISOString(),
      hours,
    },
    health: deriveReliabilityHealth(domains),
    domains,
  };
}

export async function listReliabilityTurnFailures(input?: {
  hours?: number;
  limit?: number;
}): Promise<ReliabilityTurnFailureList> {
  const principal = getCurrentPrincipal();
  if (!principal) throw new Error("Principal required for reliability turn failures");

  const hours = normalizeReliabilityWindowHours(input?.hours);
  const limit = normalizeReliabilityToolFailureLimit(input?.limit);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const windowStartMs = start.getTime();
  const windowEndMs = end.getTime();
  const chatDocs = await db
    .select({
      documentId: documentStoreDocuments.documentId,
      content: documentStoreDocuments.content,
      updatedAt: documentStoreDocuments.updatedAt,
    })
    .from(documentStoreDocuments)
    .where(
      combineWithVisibleScope(
        principal,
        DOC_SCOPE,
        and(
          eq(documentStoreDocuments.documentType, "chat"),
          gte(documentStoreDocuments.updatedAt, start),
        ),
      ),
    );

  const rows: ReliabilityTurnFailureRow[] = [];
  for (const doc of chatDocs) {
    rows.push(
      ...collectTurnFailures(
        messagesFromChatDocument(doc.content),
        doc.documentId,
        windowStartMs,
        windowEndMs,
      ),
    );
  }
  rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    window: { start: start.toISOString(), end: end.toISOString(), hours },
    totalMatched: rows.length,
    returned: Math.min(rows.length, limit),
    truncated: rows.length > limit,
    failures: rows.slice(0, limit),
  };
}

export async function listReliabilityToolFailures(input?: {
  hours?: number;
  limit?: number;
  failureKind?: string;
  tool?: string;
  toolName?: string;
  code?: string;
}): Promise<ReliabilityToolFailureList> {
  const principal = getCurrentPrincipal();
  if (!principal) {
    throw new Error("Principal required for reliability tool failures");
  }

  const hours = normalizeReliabilityWindowHours(input?.hours);
  const limit = normalizeReliabilityToolFailureLimit(input?.limit);
  const filters: ReliabilityToolFailureFilters = {
    failureKind: normalizeFailureKindFilter(input?.failureKind),
    toolName: normalizeOptionalFilter(input?.toolName ?? input?.tool),
    code: normalizeOptionalFilter(input?.code),
  };

  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  const windowStartMs = start.getTime();
  const windowEndMs = end.getTime();

  const chatDocs = await db
    .select({
      documentId: documentStoreDocuments.documentId,
      content: documentStoreDocuments.content,
      updatedAt: documentStoreDocuments.updatedAt,
    })
    .from(documentStoreDocuments)
    .where(
      combineWithVisibleScope(
        principal,
        DOC_SCOPE,
        and(
          eq(documentStoreDocuments.documentType, "chat"),
          gte(documentStoreDocuments.updatedAt, start),
        ),
      ),
    );

  const failures: ReliabilityToolFailureRow[] = [];
  for (const doc of chatDocs) {
    const sessionId =
      typeof doc.documentId === "string" && doc.documentId.trim()
        ? doc.documentId.trim()
        : "unknown";
    const messages = messagesFromChatDocument(doc.content);
    failures.push(
      ...collectToolFailuresFromMessages(sessionId, messages, windowStartMs, windowEndMs, filters),
    );
  }

  failures.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const totalMatched = failures.length;
  const page = failures.slice(0, limit);

  return {
    window: {
      start: start.toISOString(),
      end: end.toISOString(),
      hours,
    },
    totalMatched,
    returned: page.length,
    truncated: totalMatched > page.length,
    filters,
    failures: page,
  };
}
