export const CONTEXT_HEALTH_BUDGETS = {
  // Ordinary-experience targets (mean of best 95% of samples). Tail p95 is diagnostic only.
  providerTtfpP95Ms: 3000,
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
    "unknown model context window",
    "context tokens above the configured model context window",
  ],
  contextWindowSource: "server/model-registry.ts ModelInfo.contextWindow, matched by canonical api_calls.model",
  providerRows: "grouped by provider with comparable/excluded coverage and observed exclusion reasons",
  modelRows: "grouped by provider, model, tier, usage semantics, and context-window status; token statistics are comparable-row only",
  budgets: "provider TTFP/TTFT ordinary experience (mean of best 95% after dropping the slowest 5%) is the health decision statistic against these targets; p95/max remain diagnostic; context token distribution is informational until a real workload budget exists",
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

export interface ContextHealthProviderSummary {
  provider: string;
  callCount: number;
  comparableCallCount: number;
  excludedCallCount: number;
  exclusionReasons: ContextHealthExclusionReason[];
}

export interface ContextHealthModelSummary {
  provider: string;
  model: string;
  tier: string;
  /** Normalized reasoning level joined to TTFT (none|low|medium|high|xhigh|unknown|null when absent). */
  reasoningEffort: string | null;
  /** request_effort | request_budget | imputed_from_tier | none | unknown | null */
  reasoningSourceKind: string | null;
  callCount: number;
  comparableCallCount: number;
  excludedCallCount: number;
  usageSemantics: ContextUsageSemantics;
  contextWindow: number | null;
  contextWindowStatus: "known" | "unknown";
  avgContextTokens: number | null;
  medianContextTokens: number | null;
  p95ContextTokens: number | null;
  maxContextTokens: number | null;
  avgTtfpMs: number | null;
  avgTtftMs: number | null;
  exclusionReasons: ContextHealthExclusionReason[];
}

export interface MidTurnCompactionSummary {
  totalCompactions: number;
  eligibleTurns: number;
  affectedTurns: number;
  compactionsPerTurn: number | null;
  affectedTurnPct: number | null;
  p95CompactionsPerTurn: number | null;
  maxCompactionsPerTurn: number | null;
  priorWindowCompactionsPerTurn: number | null;
  trendPct: number | null;
  status: "healthy" | "empty" | "degraded";
  degradedReason: string | null;
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
  /** Ordinary experience: mean after dropping only the slowest 5% of durations. */
  upperTrimmedMean95DurationMs: number | null;
  p95DurationMs: number | null;
  ttfpSampleCount: number;
  avgTtfpMs: number | null;
  /** Ordinary experience: mean after dropping only the slowest 5% of TTFP samples. */
  upperTrimmedMean95TtfpMs: number | null;
  p95TtfpMs: number | null;
  ttftSampleCount: number;
  avgTtftMs: number | null;
  /** Ordinary experience: mean after dropping only the slowest 5% of TTFT samples. */
  upperTrimmedMean95TtftMs: number | null;
  p95TtftMs: number | null;
  contextTokenDistribution: ContextHealthDistributionBucket[];
  exclusionReasons: ContextHealthExclusionReason[];
  midTurnCompaction: MidTurnCompactionSummary;
  measurementContract: typeof CONTEXT_HEALTH_MEASUREMENT_CONTRACT;
  budgets: typeof CONTEXT_HEALTH_BUDGETS;
  byProvider: ContextHealthProviderSummary[];
  byModel: ContextHealthModelSummary[];
}
