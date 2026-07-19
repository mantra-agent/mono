export const CONTEXT_HEALTH_BUDGETS = {
  providerTtftP95Ms: 3000,
} as const;

export interface ContextHealthModelSummary {
  provider: string;
  model: string;
  tier: string;
  callCount: number;
  avgContextTokens: number | null;
  maxContextTokens: number | null;
  avgTtftMs: number | null;
}

export interface ContextHealthSummary {
  generatedAt: number;
  windowHours: number;
  callCount: number;
  callsPerHour: number;
  successCount: number;
  errorCount: number;
  abortedCount: number;
  partialCount: number;
  errorRate: number;
  avgContextTokens: number | null;
  maxContextTokens: number | null;
  avgOutputTokens: number | null;
  avgTotalTokens: number | null;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  ttftSampleCount: number;
  avgTtftMs: number | null;
  p95TtftMs: number | null;
  budgets: typeof CONTEXT_HEALTH_BUDGETS;
  byModel: ContextHealthModelSummary[];
}
