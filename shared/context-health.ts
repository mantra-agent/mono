export const CONTEXT_HEALTH_BUDGETS = {
  // Primary felt-latency budget: time to first *progress* (thinking, text, or tool).
  providerTtfpP95Ms: 3000,
  // Secondary: time to first visible *text* token, kept for continuity.
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
  budgets: "provider TTFP (first-progress: thinking/text/tool) p95 is the primary felt-latency budget, with TTFT (first-text) p95 reported alongside; context token distribution is informational until a real workload budget exists",
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
  ttfpSampleCount: number;
  avgTtfpMs: number | null;
  p95TtfpMs: number | null;
  ttftSampleCount: number;
  avgTtftMs: number | null;
  p95TtftMs: number | null;
  contextTokenDistribution: ContextHealthDistributionBucket[];
  exclusionReasons: ContextHealthExclusionReason[];
  measurementContract: typeof CONTEXT_HEALTH_MEASUREMENT_CONTRACT;
  budgets: typeof CONTEXT_HEALTH_BUDGETS;
  byProvider: ContextHealthProviderSummary[];
  byModel: ContextHealthModelSummary[];
}
