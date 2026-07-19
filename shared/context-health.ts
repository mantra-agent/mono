export const CONTEXT_HEALTH_BUDGETS = {
  providerTtftP95Ms: 3000,
} as const;

export const CONTEXT_HEALTH_MEASUREMENT_CONTRACT = {
  scope: "system-wide",
  source: "api_calls rows where metadata.trackedAtBoundary=true",
  comparablePopulation: "per-call text-model provider usage with valid total/output token accounting",
  contextTokenDefinition: "effective prompt/context tokens = provider total tokens - output tokens",
  exclusions: [
    "cumulative provider-session counters, including Claude CLI assistant.usage rows",
    "unknown usage semantics",
    "missing or invalid token usage",
  ],
  providerRows: "grouped by provider, model, tier, and usage semantics; token statistics are comparable-row only",
  budgets: "provider TTFT p95 is the only health budget in this summary; context token distribution is informational until a real workload budget exists",
} as const;

export type ContextUsageSemantics = "per_call" | "cumulative_provider_session" | "unknown";

export interface ContextHealthDistributionBucket {
  label: string;
  minTokens: number | null;
  maxTokens: number | null;
  count: number;
}

export interface ContextHealthExclusionReason {
  reason: string;
  count: number;
}

export interface ContextHealthModelSummary {
  provider: string;
  model: string;
  tier: string;
  callCount: number;
  comparableCallCount: number;
  excludedCallCount: number;
  usageSemantics: ContextUsageSemantics;
  avgContextTokens: number | null;
  medianContextTokens: number | null;
  p95ContextTokens: number | null;
  maxContextTokens: number | null;
  avgTtftMs: number | null;
}

export interface ContextHealthSummary {
  generatedAt: number;
  windowHours: number;
  rowLimit: number;
  callCount: number;
  comparableCallCount: number;
  excludedCallCount: number;
  callsPerHour: number;
  successCount: number;
  errorCount: number;
  abortedCount: number;
  partialCount: number;
  errorRate: number;
  avgContextTokens: number | null;
  medianContextTokens: number | null;
  p95ContextTokens: number | null;
  maxContextTokens: number | null;
  avgOutputTokens: number | null;
  avgTotalTokens: number | null;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  ttftSampleCount: number;
  avgTtftMs: number | null;
  p95TtftMs: number | null;
  contextTokenDistribution: ContextHealthDistributionBucket[];
  exclusionReasons: ContextHealthExclusionReason[];
  measurementContract: typeof CONTEXT_HEALTH_MEASUREMENT_CONTRACT;
  budgets: typeof CONTEXT_HEALTH_BUDGETS;
  byModel: ContextHealthModelSummary[];
}
