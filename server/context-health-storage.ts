// Use createLogger for logging ONLY
import type { QueryResultRow } from "pg";
import {
  CONTEXT_HEALTH_BUDGETS,
  CONTEXT_HEALTH_MEASUREMENT_CONTRACT,
  type ContextHealthDistributionBucket,
  type ContextHealthExclusionReason,
  type ContextHealthModelSummary,
  type ContextHealthSummary,
  type ContextUsageSemantics,
} from "@shared/context-health";
import { pool, withQueryAttributionAsync } from "./db";

const CONTEXT_HEALTH_ROW_LIMIT = 10_000;

const CONTEXT_TOKEN_BUCKETS: Array<Omit<ContextHealthDistributionBucket, "count">> = [
  { label: "<8k", minTokens: null, maxTokens: 7_999 },
  { label: "8k-32k", minTokens: 8_000, maxTokens: 31_999 },
  { label: "32k-64k", minTokens: 32_000, maxTokens: 63_999 },
  { label: "64k-128k", minTokens: 64_000, maxTokens: 127_999 },
  { label: ">=128k", minTokens: 128_000, maxTokens: null },
];

type ScalarRow = QueryResultRow & {
  call_count: number;
  comparable_call_count: number;
  excluded_call_count: number;
  success_count: number;
  error_count: number;
  aborted_count: number;
  partial_count: number;
  error_rate: string;
  avg_context_tokens: string | null;
  median_context_tokens: string | null;
  p95_context_tokens: string | null;
  max_context_tokens: number | null;
  avg_output_tokens: string | null;
  avg_total_tokens: string | null;
  avg_duration_ms: string | null;
  p95_duration_ms: string | null;
  ttft_sample_count: number;
  avg_ttft_ms: string | null;
  p95_ttft_ms: string | null;
};

type ModelRow = QueryResultRow & {
  provider: string;
  model: string;
  tier: string;
  usage_semantics: ContextUsageSemantics;
  call_count: number;
  comparable_call_count: number;
  excluded_call_count: number;
  avg_context_tokens: string | null;
  median_context_tokens: string | null;
  p95_context_tokens: string | null;
  max_context_tokens: number | null;
  avg_ttft_ms: string | null;
};

type DistributionRow = QueryResultRow & {
  bucket: string;
  count: number;
};

type ExclusionRow = QueryResultRow & {
  reason: string;
  count: number;
};

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function distributionFromRows(rows: DistributionRow[]): ContextHealthDistributionBucket[] {
  const counts = new Map(rows.map((row) => [row.bucket, row.count]));
  return CONTEXT_TOKEN_BUCKETS.map((bucket) => ({
    ...bucket,
    count: counts.get(bucket.label) ?? 0,
  }));
}

function exclusionReasonsFromRows(rows: ExclusionRow[]): ContextHealthExclusionReason[] {
  return rows.map((row) => ({ reason: row.reason, count: row.count }));
}

const boundedTrackedCallsCte = `
  WITH bounded_calls AS (
    SELECT provider, model, profile, output_tokens, total_tokens, duration_ms, metadata
    FROM api_calls
    WHERE timestamp >= $1
      AND metadata->>'trackedAtBoundary' = 'true'
    ORDER BY timestamp DESC
    LIMIT $2
  ), normalized AS (
    SELECT
      provider,
      model,
      COALESCE(profile, 'unknown') AS tier,
      output_tokens,
      total_tokens,
      duration_ms,
      COALESCE(metadata->>'status', 'success') AS status,
      COALESCE(
        metadata->>'usageSemantics',
        metadata->'tokenAccounting'->>'usageSemantics',
        CASE
          WHEN provider = 'claude-cli' AND metadata->'tokenAccounting'->>'providerReportedUsage' = 'assistant.usage'
            THEN 'cumulative_provider_session'
          WHEN provider IN ('anthropic', 'openai', 'openai-subscription', 'claude-cli', 'local')
            THEN 'per_call'
          ELSE 'unknown'
        END
      ) AS usage_semantics,
      CASE
        WHEN jsonb_typeof(metadata->'latency'->'providerTtftMs') = 'number'
        THEN (metadata->'latency'->>'providerTtftMs')::double precision
        ELSE NULL
      END AS provider_ttft_ms,
      CASE
        WHEN total_tokens > 0 AND total_tokens >= output_tokens THEN GREATEST(total_tokens - output_tokens, 0)
        ELSE NULL
      END AS context_tokens
    FROM bounded_calls
  ), classified AS (
    SELECT *,
      CASE
        WHEN usage_semantics <> 'per_call' THEN false
        WHEN context_tokens IS NULL THEN false
        ELSE true
      END AS comparable,
      CASE
        WHEN usage_semantics = 'cumulative_provider_session' THEN 'cumulative_provider_session'
        WHEN usage_semantics = 'unknown' THEN 'unknown_usage_semantics'
        WHEN context_tokens IS NULL THEN 'missing_or_invalid_token_usage'
        ELSE NULL
      END AS exclusion_reason
    FROM normalized
  )`;

export async function getContextHealthSummary(windowHours = 24): Promise<ContextHealthSummary> {
  const hours = Math.min(Math.max(Math.floor(windowHours), 1), 168);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const [scalarResult, modelResult, distributionResult, exclusionResult] = await withQueryAttributionAsync("general", () => Promise.all([
    pool.query<ScalarRow>(`${boundedTrackedCallsCte}
      SELECT
        COUNT(*)::int AS call_count,
        COUNT(*) FILTER (WHERE comparable)::int AS comparable_call_count,
        COUNT(*) FILTER (WHERE NOT comparable)::int AS excluded_call_count,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
        COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
        COUNT(*) FILTER (WHERE status = 'aborted')::int AS aborted_count,
        COUNT(*) FILTER (WHERE status = 'partial')::int AS partial_count,
        COALESCE(COUNT(*) FILTER (WHERE status = 'error')::double precision / NULLIF(COUNT(*), 0), 0)::text AS error_rate,
        AVG(context_tokens) FILTER (WHERE comparable)::text AS avg_context_tokens,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY context_tokens) FILTER (WHERE comparable))::text AS median_context_tokens,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY context_tokens) FILTER (WHERE comparable))::text AS p95_context_tokens,
        MAX(context_tokens) FILTER (WHERE comparable)::int AS max_context_tokens,
        AVG(output_tokens) FILTER (WHERE comparable)::text AS avg_output_tokens,
        AVG(total_tokens) FILTER (WHERE comparable)::text AS avg_total_tokens,
        AVG(duration_ms)::text AS avg_duration_ms,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::text AS p95_duration_ms,
        COUNT(provider_ttft_ms)::int AS ttft_sample_count,
        AVG(provider_ttft_ms)::text AS avg_ttft_ms,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY provider_ttft_ms) FILTER (WHERE provider_ttft_ms IS NOT NULL))::text AS p95_ttft_ms
      FROM classified
    `, [cutoff, CONTEXT_HEALTH_ROW_LIMIT]),
    pool.query<ModelRow>(`${boundedTrackedCallsCte}
      SELECT
        provider,
        model,
        tier,
        usage_semantics,
        COUNT(*)::int AS call_count,
        COUNT(*) FILTER (WHERE comparable)::int AS comparable_call_count,
        COUNT(*) FILTER (WHERE NOT comparable)::int AS excluded_call_count,
        AVG(context_tokens) FILTER (WHERE comparable)::text AS avg_context_tokens,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY context_tokens) FILTER (WHERE comparable))::text AS median_context_tokens,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY context_tokens) FILTER (WHERE comparable))::text AS p95_context_tokens,
        MAX(context_tokens) FILTER (WHERE comparable)::int AS max_context_tokens,
        AVG(provider_ttft_ms)::text AS avg_ttft_ms
      FROM classified
      GROUP BY provider, model, tier, usage_semantics
      ORDER BY call_count DESC
      LIMIT 8
    `, [cutoff, CONTEXT_HEALTH_ROW_LIMIT]),
    pool.query<DistributionRow>(`${boundedTrackedCallsCte}
      SELECT
        CASE
          WHEN context_tokens < 8000 THEN '<8k'
          WHEN context_tokens < 32000 THEN '8k-32k'
          WHEN context_tokens < 64000 THEN '32k-64k'
          WHEN context_tokens < 128000 THEN '64k-128k'
          ELSE '>=128k'
        END AS bucket,
        COUNT(*)::int AS count
      FROM classified
      WHERE comparable
      GROUP BY bucket
    `, [cutoff, CONTEXT_HEALTH_ROW_LIMIT]),
    pool.query<ExclusionRow>(`${boundedTrackedCallsCte}
      SELECT exclusion_reason AS reason, COUNT(*)::int AS count
      FROM classified
      WHERE NOT comparable AND exclusion_reason IS NOT NULL
      GROUP BY exclusion_reason
      ORDER BY count DESC, reason ASC
    `, [cutoff, CONTEXT_HEALTH_ROW_LIMIT]),
  ]), "context-health.summary");

  const scalar = scalarResult.rows[0];
  const callCount = scalar?.call_count ?? 0;
  const byModel: ContextHealthModelSummary[] = modelResult.rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    tier: row.tier,
    callCount: row.call_count,
    comparableCallCount: row.comparable_call_count,
    excludedCallCount: row.excluded_call_count,
    usageSemantics: row.usage_semantics,
    avgContextTokens: nullableNumber(row.avg_context_tokens),
    medianContextTokens: nullableNumber(row.median_context_tokens),
    p95ContextTokens: nullableNumber(row.p95_context_tokens),
    maxContextTokens: nullableNumber(row.max_context_tokens),
    avgTtftMs: nullableNumber(row.avg_ttft_ms),
  }));

  return {
    generatedAt: Date.now(),
    windowHours: hours,
    rowLimit: CONTEXT_HEALTH_ROW_LIMIT,
    callCount,
    comparableCallCount: scalar?.comparable_call_count ?? 0,
    excludedCallCount: scalar?.excluded_call_count ?? 0,
    callsPerHour: Math.round((callCount / hours) * 10) / 10,
    successCount: scalar?.success_count ?? 0,
    errorCount: scalar?.error_count ?? 0,
    abortedCount: scalar?.aborted_count ?? 0,
    partialCount: scalar?.partial_count ?? 0,
    errorRate: nullableNumber(scalar?.error_rate) ?? 0,
    avgContextTokens: nullableNumber(scalar?.avg_context_tokens),
    medianContextTokens: nullableNumber(scalar?.median_context_tokens),
    p95ContextTokens: nullableNumber(scalar?.p95_context_tokens),
    maxContextTokens: nullableNumber(scalar?.max_context_tokens),
    avgOutputTokens: nullableNumber(scalar?.avg_output_tokens),
    avgTotalTokens: nullableNumber(scalar?.avg_total_tokens),
    avgDurationMs: nullableNumber(scalar?.avg_duration_ms),
    p95DurationMs: nullableNumber(scalar?.p95_duration_ms),
    ttftSampleCount: scalar?.ttft_sample_count ?? 0,
    avgTtftMs: nullableNumber(scalar?.avg_ttft_ms),
    p95TtftMs: nullableNumber(scalar?.p95_ttft_ms),
    contextTokenDistribution: distributionFromRows(distributionResult.rows),
    exclusionReasons: exclusionReasonsFromRows(exclusionResult.rows),
    measurementContract: CONTEXT_HEALTH_MEASUREMENT_CONTRACT,
    budgets: CONTEXT_HEALTH_BUDGETS,
    byModel,
  };
}
