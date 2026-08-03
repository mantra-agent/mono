export const RELIABILITY_WINDOW_DEFAULT_HOURS = 24;
export const RELIABILITY_WINDOW_MIN_HOURS = 1;
export const RELIABILITY_WINDOW_MAX_HOURS = 24 * 30;

export const RELIABILITY_TOOL_FAILURE_DEFAULT_LIMIT = 50;
export const RELIABILITY_TOOL_FAILURE_MAX_LIMIT = 200;

export type ReliabilityHealth = "healthy" | "degraded" | "critical";

export type ReliabilityToolFailureKind = "input" | "permission" | "transient" | "internal";

export interface ReliabilityOutcomeMetrics {
  succeeded: number;
  failed: number;
  excluded: number;
  successRate: number | null;
}

export interface ReliabilityOutcomeSummary {
  window: {
    start: string;
    end: string;
    hours: number;
  };
  health: ReliabilityHealth;
  domains: {
    toolExecutions: ReliabilityOutcomeMetrics;
    conversationalTurns: ReliabilityOutcomeMetrics;
    planSteps: ReliabilityOutcomeMetrics;
    workflowRuns: ReliabilityOutcomeMetrics;
  };
}

/** One persisted tool failure row for pattern diagnosis. */
export interface ReliabilityToolFailureRow {
  timestamp: string;
  sessionId: string;
  tool: string;
  action: string | null;
  failureKind: ReliabilityToolFailureKind | null;
  code: string | null;
  error: string;
  argsSummary: string | null;
  resultSnippet: string | null;
  toolCallId: string | null;
}

export interface ReliabilityToolFailureFilters {
  failureKind: ReliabilityToolFailureKind | null;
  toolName: string | null;
  code: string | null;
}

export interface ReliabilityToolFailureList {
  window: {
    start: string;
    end: string;
    hours: number;
  };
  totalMatched: number;
  returned: number;
  truncated: boolean;
  filters: ReliabilityToolFailureFilters;
  failures: ReliabilityToolFailureRow[];
}

export function normalizeReliabilityWindowHours(hours?: number): number {
  if (typeof hours !== "number" || !Number.isFinite(hours)) {
    return RELIABILITY_WINDOW_DEFAULT_HOURS;
  }
  const rounded = Math.round(hours);
  return Math.min(RELIABILITY_WINDOW_MAX_HOURS, Math.max(RELIABILITY_WINDOW_MIN_HOURS, rounded));
}

export function normalizeReliabilityToolFailureLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return RELIABILITY_TOOL_FAILURE_DEFAULT_LIMIT;
  }
  const rounded = Math.round(limit);
  return Math.min(RELIABILITY_TOOL_FAILURE_MAX_LIMIT, Math.max(1, rounded));
}

export function emptyReliabilityMetrics(): ReliabilityOutcomeMetrics {
  return {
    succeeded: 0,
    failed: 0,
    excluded: 0,
    successRate: null,
  };
}

export function toReliabilityMetrics(succeeded: number, failed: number, excluded = 0): ReliabilityOutcomeMetrics {
  const decided = succeeded + failed;
  return {
    succeeded,
    failed,
    excluded,
    successRate: decided > 0 ? succeeded / decided : null,
  };
}

export function deriveReliabilityHealth(domains: ReliabilityOutcomeSummary["domains"]): ReliabilityHealth {
  const rates = Object.values(domains)
    .map((domain) => domain.successRate)
    .filter((rate): rate is number => typeof rate === "number");

  if (rates.length === 0) return "healthy";
  if (rates.some((rate) => rate < 0.9)) return "critical";
  if (rates.some((rate) => rate < 0.99)) return "degraded";
  return "healthy";
}
