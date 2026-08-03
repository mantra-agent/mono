export const RELIABILITY_WINDOW_DEFAULT_HOURS = 24;
export const RELIABILITY_WINDOW_MIN_HOURS = 1;
export const RELIABILITY_WINDOW_MAX_HOURS = 24 * 30;

export type ReliabilityHealth = "healthy" | "degraded" | "failing" | "no_data";

export interface ReliabilityOutcomeMetrics {
  succeeded: number;
  failed: number;
  terminal: number;
  excluded: number;
  successRate: number | null;
  failureRate: number | null;
  health: ReliabilityHealth;
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
    planSteps: ReliabilityOutcomeMetrics;
    workflowRuns: ReliabilityOutcomeMetrics;
    conversationalTurns: ReliabilityOutcomeMetrics;
  };
}

export type ReliabilityDomainKey = keyof ReliabilityOutcomeSummary["domains"];

export function normalizeReliabilityWindowHours(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return RELIABILITY_WINDOW_DEFAULT_HOURS;
  return Math.min(
    RELIABILITY_WINDOW_MAX_HOURS,
    Math.max(RELIABILITY_WINDOW_MIN_HOURS, Math.round(parsed)),
  );
}
