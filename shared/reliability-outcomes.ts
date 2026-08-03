export const RELIABILITY_WINDOW_DEFAULT_HOURS = 24;
export const RELIABILITY_WINDOW_MIN_HOURS = 1;
export const RELIABILITY_WINDOW_MAX_HOURS = 24 * 30;

export const RELIABILITY_TOOL_FAILURE_DEFAULT_LIMIT = 50;
export const RELIABILITY_TOOL_FAILURE_MAX_LIMIT = 200;

export type ReliabilityHealth = "healthy" | "degraded" | "critical";

export type ReliabilityDomainKey =
  | "toolExecutions"
  | "conversationalTurns"
  | "planSteps"
  | "workflowRuns";

export type ReliabilityToolFailureKind = "input" | "permission" | "transient" | "internal";

/**
 * Terminal outcome metrics for one reliability domain.
 *
 * Failure split contract:
 * - amberFailures = classified/avoidable (input|permission|transient|internal)
 * - unclassifiedErrors = true surprises missing failureKind (red)
 * - failed = amberFailures + unclassifiedErrors
 */
export interface ReliabilityOutcomeMetrics {
  succeeded: number;
  failed: number;
  amberFailures: number;
  unclassifiedErrors: number;
  excluded: number;
  terminal: number;
  successRate: number | null;
  health: ReliabilityHealth | "no_data";
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

function domainHealth(successRate: number | null): ReliabilityHealth | "no_data" {
  if (successRate === null) return "no_data";
  if (successRate < 0.9) return "critical";
  if (successRate < 0.99) return "degraded";
  return "healthy";
}

export function emptyReliabilityMetrics(): ReliabilityOutcomeMetrics {
  return {
    succeeded: 0,
    failed: 0,
    amberFailures: 0,
    unclassifiedErrors: 0,
    excluded: 0,
    terminal: 0,
    successRate: null,
    health: "no_data",
  };
}

export function toReliabilityMetrics(
  succeeded: number,
  failed: number,
  excluded = 0,
  amberFailures = 0,
  unclassifiedErrors = 0,
): ReliabilityOutcomeMetrics {
  const decided = succeeded + failed;
  // Prefer explicit split when provided; otherwise treat all failures as unclassified.
  const ambers = Math.max(0, Math.min(failed, amberFailures));
  const unclass =
    unclassifiedErrors > 0
      ? Math.max(0, Math.min(failed - ambers, unclassifiedErrors))
      : Math.max(0, failed - ambers);
  const successRate = decided > 0 ? succeeded / decided : null;
  return {
    succeeded,
    failed,
    amberFailures: ambers,
    unclassifiedErrors: unclass,
    excluded,
    terminal: decided,
    successRate,
    health: domainHealth(successRate),
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

/** Compact human label: "12 ambers · 3 errors". */
export function formatReliabilityFailureSplit(
  metric: Pick<ReliabilityOutcomeMetrics, "amberFailures" | "unclassifiedErrors" | "failed">,
): string {
  if (metric.failed <= 0) return "0 ambers · 0 errors";
  return `${metric.amberFailures} ambers · ${metric.unclassifiedErrors} errors`;
}
