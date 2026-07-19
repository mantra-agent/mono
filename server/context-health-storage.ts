// Use createLogger for logging ONLY
import type { QueryResultRow } from "pg";
import { CONTEXT_HEALTH_BUDGETS, type ContextHealthModelSummary, type ContextHealthSummary } from "@shared/context-health";
import { pool, withQueryAttributionAsync } from "./db";

type ScalarRow = QueryResultRow & {
  call_count: number;
  success_count: number;
  error_count: number;
  aborted_count: number;
  partial_count: number;
  error_rate: string;
  avg_context_tokens: string | null;
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
  call_count: number;
  avg_context_tokens: string | null;
  max_context_tokens: number | null;
  avg_ttft_ms: string | null;
};

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getContextHealthSummary(windowHours = 24): Promise<ContextHealthSummary> {
  const hours = Math.min(Math.max(Math.floor(windowHours), 1), 168);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const [scalarResult, modelResult] = await withQueryAttributionAsync("general", () => Promise.all([
    pool.query<ScalarRow>(`
      WITH bounded_calls AS (
        SELECT output_tokens, total_tokens, duration_ms, metadata
        FROM api_calls
        WHERE timestamp >= $1
          AND metadata->>'trackedAtBoundary' = 'true'
        ORDER BY timestamp DESC
        LIMIT 10000
      ), normalized AS (
        SELECT
          GREATEST(total_tokens - output_tokens, 0) AS context_tokens,
          output_tokens,
          total_tokens,
          duration_ms,
          COALESCE(metadata->>'status', 'success') AS status,
          CASE
            WHEN jsonb_typeof(metadata->'latency'->'providerTtftMs') = 'number'
            THEN (metadata->'latency'->>'providerTtftMs')::double precision
            ELSE NULL
          END AS provider_ttft_ms
        FROM bounded_calls
      )
      SELECT
        COUNT(*)::int AS call_count,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
        COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
        COUNT(*) FILTER (WHERE status = 'aborted')::int AS aborted_count,
        COUNT(*) FILTER (WHERE status = 'partial')::int AS partial_count,
        COALESCE(COUNT(*) FILTER (WHERE status = 'error')::double precision / NULLIF(COUNT(*), 0), 0)::text AS error_rate,
        AVG(context_tokens)::text AS avg_context_tokens,
        MAX(context_tokens)::int AS max_context_tokens,
        AVG(output_tokens)::text AS avg_output_tokens,
        AVG(total_tokens)::text AS avg_total_tokens,
        AVG(duration_ms)::text AS avg_duration_ms,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::text AS p95_duration_ms,
        COUNT(provider_ttft_ms)::int AS ttft_sample_count,
        AVG(provider_ttft_ms)::text AS avg_ttft_ms,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY provider_ttft_ms) FILTER (WHERE provider_ttft_ms IS NOT NULL))::text AS p95_ttft_ms
      FROM normalized
    `, [cutoff]),
    pool.query<ModelRow>(`
      WITH bounded_calls AS (
        SELECT provider, model, profile, output_tokens, total_tokens, metadata
        FROM api_calls
        WHERE timestamp >= $1
          AND metadata->>'trackedAtBoundary' = 'true'
        ORDER BY timestamp DESC
        LIMIT 10000
      )
      SELECT
        provider,
        model,
        COALESCE(profile, 'unknown') AS tier,
        COUNT(*)::int AS call_count,
        AVG(GREATEST(total_tokens - output_tokens, 0))::text AS avg_context_tokens,
        MAX(GREATEST(total_tokens - output_tokens, 0))::int AS max_context_tokens,
        AVG(
          CASE
            WHEN jsonb_typeof(metadata->'latency'->'providerTtftMs') = 'number'
            THEN (metadata->'latency'->>'providerTtftMs')::double precision
            ELSE NULL
          END
        )::text AS avg_ttft_ms
      FROM bounded_calls
      GROUP BY provider, model, profile
      ORDER BY call_count DESC
      LIMIT 8
    `, [cutoff]),
  ]), "context-health.summary");

  const scalar = scalarResult.rows[0];
  const callCount = scalar?.call_count ?? 0;
  const byModel: ContextHealthModelSummary[] = modelResult.rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    tier: row.tier,
    callCount: row.call_count,
    avgContextTokens: nullableNumber(row.avg_context_tokens),
    maxContextTokens: nullableNumber(row.max_context_tokens),
    avgTtftMs: nullableNumber(row.avg_ttft_ms),
  }));

  return {
    generatedAt: Date.now(),
    windowHours: hours,
    callCount,
    callsPerHour: Math.round((callCount / hours) * 10) / 10,
    successCount: scalar?.success_count ?? 0,
    errorCount: scalar?.error_count ?? 0,
    abortedCount: scalar?.aborted_count ?? 0,
    partialCount: scalar?.partial_count ?? 0,
    errorRate: nullableNumber(scalar?.error_rate) ?? 0,
    avgContextTokens: nullableNumber(scalar?.avg_context_tokens),
    maxContextTokens: nullableNumber(scalar?.max_context_tokens),
    avgOutputTokens: nullableNumber(scalar?.avg_output_tokens),
    avgTotalTokens: nullableNumber(scalar?.avg_total_tokens),
    avgDurationMs: nullableNumber(scalar?.avg_duration_ms),
    p95DurationMs: nullableNumber(scalar?.p95_duration_ms),
    ttftSampleCount: scalar?.ttft_sample_count ?? 0,
    avgTtftMs: nullableNumber(scalar?.avg_ttft_ms),
    p95TtftMs: nullableNumber(scalar?.p95_ttft_ms),
    budgets: CONTEXT_HEALTH_BUDGETS,
    byModel,
  };
}
