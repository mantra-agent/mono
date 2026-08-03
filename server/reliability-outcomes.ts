import { and, eq, gte, sql } from "drizzle-orm";
import { documentStoreDocuments } from "@shared/models/memory";
import { planSteps, workflowRuns } from "@shared/schema";
import {
  normalizeReliabilityWindowHours,
  type ReliabilityHealth,
  type ReliabilityOutcomeMetrics,
  type ReliabilityOutcomeSummary,
} from "@shared/reliability-outcomes";
import { db } from "./db";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope } from "./scoped-storage";

const log = createLogger("reliability-outcomes");

const documentScopeColumns = {
  ownerUserId: documentStoreDocuments.ownerUserId,
  accountId: documentStoreDocuments.accountId,
  scope: documentStoreDocuments.scope,
};

const planStepScopeColumns = {
  ownerUserId: planSteps.ownerUserId,
  accountId: planSteps.accountId,
};

const workflowRunScopeColumns = {
  ownerUserId: workflowRuns.ownerUserId,
  accountId: workflowRuns.accountId,
};

interface OutcomeCounts {
  succeeded: number;
  failed: number;
  excluded: number;
}

interface ChatDocument {
  messages?: unknown;
}

interface PersistedMessage {
  role?: unknown;
  timestamp?: unknown;
  updatedAt?: unknown;
  assistantState?: unknown;
  toolCalls?: unknown;
}

interface PersistedToolCall {
  status?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

function healthForCounts(counts: OutcomeCounts): ReliabilityHealth {
  const terminal = counts.succeeded + counts.failed;
  if (terminal === 0) return "no_data";
  if (counts.failed === 0) return "healthy";
  return counts.succeeded > counts.failed ? "degraded" : "failing";
}

function metricsForCounts(counts: OutcomeCounts): ReliabilityOutcomeMetrics {
  const terminal = counts.succeeded + counts.failed;
  return {
    ...counts,
    terminal,
    successRate: terminal === 0 ? null : counts.succeeded / terminal,
    failureRate: terminal === 0 ? null : counts.failed / terminal,
    health: healthForCounts(counts),
  };
}

function summaryHealth(metrics: ReliabilityOutcomeMetrics[]): ReliabilityHealth {
  const healthRank: Record<ReliabilityHealth, number> = {
    no_data: 0,
    healthy: 1,
    degraded: 2,
    failing: 3,
  };
  const withData = metrics.filter((metric) => metric.health !== "no_data");
  if (withData.length === 0) return "no_data";
  return withData.reduce((worst, metric) =>
    healthRank[metric.health] > healthRank[worst] ? metric.health : worst,
  "healthy" as ReliabilityHealth);
}

function parseMessageTimestamp(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function countChatOutcomes(
  documents: Array<{ id: number; content: string }>,
  windowStartMs: number,
  windowEndMs: number,
): { toolExecutions: OutcomeCounts; conversationalTurns: OutcomeCounts } {
  const toolExecutions: OutcomeCounts = { succeeded: 0, failed: 0, excluded: 0 };
  const conversationalTurns: OutcomeCounts = { succeeded: 0, failed: 0, excluded: 0 };

  for (const document of documents) {
    let parsed: ChatDocument;
    try {
      parsed = JSON.parse(document.content) as ChatDocument;
    } catch (error) {
      log.warn("Skipping malformed chat document in reliability summary", {
        documentId: document.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!Array.isArray(parsed.messages)) continue;

    for (const rawMessage of parsed.messages) {
      if (!rawMessage || typeof rawMessage !== "object") continue;
      const message = rawMessage as PersistedMessage;
      const timestamp = parseMessageTimestamp(message.updatedAt) ?? parseMessageTimestamp(message.timestamp);
      const messageIsInWindow = timestamp !== null && timestamp >= windowStartMs && timestamp <= windowEndMs;

      if (messageIsInWindow && message.role === "assistant") {
        if (message.assistantState === "complete") conversationalTurns.succeeded += 1;
        else if (message.assistantState === "failed" || message.assistantState === "interrupted") conversationalTurns.failed += 1;
        else conversationalTurns.excluded += 1;
      }

      if (!Array.isArray(message.toolCalls)) continue;
      for (const rawToolCall of message.toolCalls) {
        if (!rawToolCall || typeof rawToolCall !== "object") {
          toolExecutions.excluded += 1;
          continue;
        }
        const toolCall = rawToolCall as PersistedToolCall;
        const toolObservedAt = parseMessageTimestamp(toolCall.completedAt)
          ?? parseMessageTimestamp(toolCall.startedAt)
          ?? timestamp;
        if (toolObservedAt === null || toolObservedAt < windowStartMs || toolObservedAt > windowEndMs) continue;
        if (toolCall.status === "done") toolExecutions.succeeded += 1;
        else if (toolCall.status === "error") toolExecutions.failed += 1;
        else toolExecutions.excluded += 1;
      }
    }
  }

  return { toolExecutions, conversationalTurns };
}

function countsFromAggregate(row: {
  succeeded: number;
  failed: number;
  excluded: number;
} | undefined): OutcomeCounts {
  return {
    succeeded: Number(row?.succeeded ?? 0),
    failed: Number(row?.failed ?? 0),
    excluded: Number(row?.excluded ?? 0),
  };
}

export async function getReliabilityOutcomeSummary(
  requestedHours?: unknown,
): Promise<ReliabilityOutcomeSummary> {
  const principal = requireCurrentUserPrincipal();
  const hours = normalizeReliabilityWindowHours(requestedHours);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);

  const planEventTime = sql`CASE
    WHEN ${planSteps.status} IN ('completed', 'failed')
      THEN COALESCE(${planSteps.completedAt}, ${planSteps.updatedAt})
    ELSE ${planSteps.updatedAt}
  END`;
  const workflowEventTime = sql`COALESCE(${workflowRuns.completedAt}, ${workflowRuns.updatedAt})`;

  const [chatDocuments, planRows, workflowRows] = await Promise.all([
    db.select({ id: documentStoreDocuments.id, content: documentStoreDocuments.content })
      .from(documentStoreDocuments)
      .where(combineWithVisibleScope(
        principal,
        documentScopeColumns,
        and(
          eq(documentStoreDocuments.documentType, "chat_session"),
          gte(documentStoreDocuments.updatedAt, start),
        ),
      )),
    db.select({
      succeeded: sql<number>`COUNT(*) FILTER (WHERE ${planSteps.status} = 'completed')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${planSteps.status} = 'failed')::int`,
      excluded: sql<number>`COUNT(*) FILTER (WHERE ${planSteps.status} NOT IN ('completed', 'failed'))::int`,
    })
      .from(planSteps)
      .where(combineWithVisibleScope(
        principal,
        planStepScopeColumns,
        and(sql`${planEventTime} >= ${start}`, sql`${planEventTime} <= ${end}`),
      )),
    db.select({
      succeeded: sql<number>`COUNT(*) FILTER (WHERE ${workflowRuns.status} = 'completed')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${workflowRuns.status} = 'failed')::int`,
      excluded: sql<number>`COUNT(*) FILTER (WHERE ${workflowRuns.status} NOT IN ('completed', 'failed'))::int`,
    })
      .from(workflowRuns)
      .where(combineWithVisibleScope(
        principal,
        workflowRunScopeColumns,
        and(sql`${workflowEventTime} >= ${start}`, sql`${workflowEventTime} <= ${end}`),
      )),
  ]);

  const chatCounts = countChatOutcomes(chatDocuments, start.getTime(), end.getTime());
  const domains = {
    toolExecutions: metricsForCounts(chatCounts.toolExecutions),
    planSteps: metricsForCounts(countsFromAggregate(planRows[0])),
    workflowRuns: metricsForCounts(countsFromAggregate(workflowRows[0])),
    conversationalTurns: metricsForCounts(chatCounts.conversationalTurns),
  };

  return {
    window: { start: start.toISOString(), end: end.toISOString(), hours },
    health: summaryHealth(Object.values(domains)),
    domains,
  };
}
