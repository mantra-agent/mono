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
import { getModel } from "./model-registry";

const CONTEXT_HEALTH_ROW_LIMIT = 10_000;

const CONTEXT_TOKEN_BUCKETS: Array<Omit<ContextHealthDistributionBucket, "count">> = [
  { label: "<8k", minTokens: null, maxTokens: 7_999 },
  { label: "8k-32k", minTokens: 8_000, maxTokens: 31_999 },
  { label: "32k-64k", minTokens: 32_000, maxTokens: 63_999 },
  { label: "64k-128k", minTokens: 64_000, maxTokens: 127_999 },
  { label: ">=128k", minTokens: 128_000, maxTokens: null },
];

type ApiCallContextRow = QueryResultRow & {
  provider: string;
  model: string;
  profile: string | null;
  output_tokens: number | null;
  total_tokens: number | null;
  duration_ms: number | null;
  metadata: Record<string, unknown> | null;
};

type ClassifiedContextRow = {
  provider: string;
  model: string;
  tier: string;
  status: string;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  providerTtftMs: number | null;
  usageSemantics: ContextUsageSemantics;
  contextTokens: number | null;
  contextWindow: number | null;
  contextWindowStatus: "known" | "unknown";
  comparable: boolean;
  exclusionReason: string | null;
};

type Accumulator = {
  callCount: number;
  comparableCallCount: number;
  excludedCallCount: number;
  contextTokens: number[];
  outputTokens: number[];
  totalTokens: number[];
  durations: number[];
  ttfts: number[];
  exclusions: Map<string, number>;
};

function emptyAccumulator(): Accumulator {
  return {
    callCount: 0,
    comparableCallCount: 0,
    excludedCallCount: 0,
    contextTokens: [],
    outputTokens: [],
    totalTokens: [],
    durations: [],
    ttfts: [],
    exclusions: new Map(),
  };
}

function addExclusion(acc: Accumulator, reason: string | null): void {
  if (!reason) return;
  acc.exclusions.set(reason, (acc.exclusions.get(reason) ?? 0) + 1);
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max(values: number[]): number | null {
  return values.length ? Math.max(...values) : null;
}

function increment(acc: Accumulator, row: ClassifiedContextRow): void {
  acc.callCount++;
  if (row.comparable) {
    acc.comparableCallCount++;
    if (row.contextTokens !== null) acc.contextTokens.push(row.contextTokens);
    if (row.outputTokens !== null) acc.outputTokens.push(row.outputTokens);
    if (row.totalTokens !== null) acc.totalTokens.push(row.totalTokens);
  } else {
    acc.excludedCallCount++;
    addExclusion(acc, row.exclusionReason);
  }
  if (row.durationMs !== null) acc.durations.push(row.durationMs);
  if (row.providerTtftMs !== null) acc.ttfts.push(row.providerTtftMs);
}

function exclusionReasonsFromMap(map: Map<string, number>): ContextHealthExclusionReason[] {
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function tokenAccounting(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  const value = metadata?.tokenAccounting;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function inferUsageSemantics(provider: string, metadata: Record<string, unknown> | null): ContextUsageSemantics {
  const accounting = tokenAccounting(metadata);
  const explicit = metadata?.usageSemantics ?? accounting?.usageSemantics;
  if (explicit === "per_call" || explicit === "cumulative_provider_session" || explicit === "unknown") return explicit;

  const providerReportedUsage = accounting?.providerReportedUsage;
  if (provider === "claude-cli") {
    if (providerReportedUsage === "assistant.usage") return "cumulative_provider_session";
    return "unknown";
  }
  if (provider === "anthropic" || provider === "openai" || provider === "openai-subscription" || provider === "local") return "per_call";
  return "unknown";
}

function nullableNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableMetadataNumber(metadata: Record<string, unknown> | null, path: string[]): number | null {
  let current: unknown = metadata;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return nullableNumber(current as string | number | null | undefined);
}

function classifyRow(row: ApiCallContextRow): ClassifiedContextRow {
  const metadata = row.metadata ?? null;
  const outputTokens = nullableNumber(row.output_tokens);
  const totalTokens = nullableNumber(row.total_tokens);
  const usageSemantics = inferUsageSemantics(row.provider, metadata);
  const contextTokens = totalTokens !== null && outputTokens !== null && totalTokens > 0 && totalTokens >= outputTokens
    ? Math.max(totalTokens - outputTokens, 0)
    : null;
  const modelInfo = getModel(row.model);
  const contextWindow = modelInfo?.contextWindow ?? null;
  const contextWindowStatus = contextWindow === null ? "unknown" : "known";

  let exclusionReason: string | null = null;
  if (usageSemantics === "cumulative_provider_session") exclusionReason = "cumulative_provider_session";
  else if (usageSemantics === "unknown") exclusionReason = "unknown_usage_semantics";
  else if (contextTokens === null) exclusionReason = "missing_or_invalid_token_usage";
  else if (contextWindow === null) exclusionReason = "unknown_model_context_window";
  else if (contextTokens > contextWindow) exclusionReason = "exceeds_model_context_window";

  return {
    provider: row.provider,
    model: row.model,
    tier: row.profile ?? "unknown",
    status: typeof metadata?.status === "string" ? metadata.status : "success",
    outputTokens,
    totalTokens,
    durationMs: nullableNumber(row.duration_ms),
    providerTtftMs: nullableMetadataNumber(metadata, ["latency", "providerTtftMs"]),
    usageSemantics,
    contextTokens,
    contextWindow,
    contextWindowStatus,
    comparable: exclusionReason === null,
    exclusionReason,
  };
}

function distributionFromValues(values: number[]): ContextHealthDistributionBucket[] {
  return CONTEXT_TOKEN_BUCKETS.map((bucket) => ({
    ...bucket,
    count: values.filter((value) => (bucket.minTokens === null || value >= bucket.minTokens) && (bucket.maxTokens === null || value <= bucket.maxTokens)).length,
  }));
}

function summarizeModel(key: string, rows: ClassifiedContextRow[]): ContextHealthModelSummary {
  const [provider, model, tier, usageSemantics, contextWindowPart] = key.split("\u0000");
  const acc = emptyAccumulator();
  rows.forEach((row) => increment(acc, row));
  return {
    provider,
    model,
    tier,
    callCount: acc.callCount,
    comparableCallCount: acc.comparableCallCount,
    excludedCallCount: acc.excludedCallCount,
    usageSemantics: usageSemantics as ContextUsageSemantics,
    contextWindow: contextWindowPart === "unknown" ? null : Number(contextWindowPart),
    contextWindowStatus: contextWindowPart === "unknown" ? "unknown" : "known",
    avgContextTokens: average(acc.contextTokens),
    medianContextTokens: percentile(acc.contextTokens, 0.5),
    p95ContextTokens: percentile(acc.contextTokens, 0.95),
    maxContextTokens: max(acc.contextTokens),
    avgTtftMs: average(acc.ttfts),
    exclusionReasons: exclusionReasonsFromMap(acc.exclusions),
  };
}

function summarizeProvider(provider: string, rows: ClassifiedContextRow[]) {
  const acc = emptyAccumulator();
  rows.forEach((row) => increment(acc, row));
  return {
    provider,
    callCount: acc.callCount,
    comparableCallCount: acc.comparableCallCount,
    excludedCallCount: acc.excludedCallCount,
    exclusionReasons: exclusionReasonsFromMap(acc.exclusions),
  };
}

const boundedTrackedCallsSql = `
  SELECT provider, model, profile, output_tokens, total_tokens, duration_ms, metadata
  FROM api_calls
  WHERE timestamp >= $1
    AND metadata->>'trackedAtBoundary' = 'true'
  ORDER BY timestamp DESC
  LIMIT $2
`;

export async function getContextHealthSummary(windowHours = 24): Promise<ContextHealthSummary> {
  const hours = Math.min(Math.max(Math.floor(windowHours), 1), 168);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const result = await withQueryAttributionAsync("general", () => pool.query<ApiCallContextRow>(boundedTrackedCallsSql, [cutoff, CONTEXT_HEALTH_ROW_LIMIT]), "context-health.summary");
  const rows = result.rows.map(classifyRow);
  const global = emptyAccumulator();
  let successCount = 0;
  let errorCount = 0;
  let abortedCount = 0;
  let partialCount = 0;
  const modelRows = new Map<string, ClassifiedContextRow[]>();
  const providerRows = new Map<string, ClassifiedContextRow[]>();

  for (const row of rows) {
    increment(global, row);
    if (row.status === "error") errorCount++;
    else if (row.status === "aborted") abortedCount++;
    else if (row.status === "partial") partialCount++;
    else successCount++;

    const modelKey = [row.provider, row.model, row.tier, row.usageSemantics, row.contextWindow ?? "unknown"].join("\u0000");
    modelRows.set(modelKey, [...(modelRows.get(modelKey) ?? []), row]);
    providerRows.set(row.provider, [...(providerRows.get(row.provider) ?? []), row]);
  }

  const callCount = global.callCount;
  const byModel = [...modelRows.entries()]
    .map(([key, modelGroup]) => summarizeModel(key, modelGroup))
    .sort((a, b) => b.callCount - a.callCount)
    .slice(0, 8);
  const byProvider = [...providerRows.entries()]
    .map(([provider, providerGroup]) => summarizeProvider(provider, providerGroup))
    .sort((a, b) => b.callCount - a.callCount || a.provider.localeCompare(b.provider));

  return {
    generatedAt: Date.now(),
    windowHours: hours,
    rowLimit: CONTEXT_HEALTH_ROW_LIMIT,
    callCount,
    comparableCallCount: global.comparableCallCount,
    excludedCallCount: global.excludedCallCount,
    callsPerHour: Math.round((callCount / hours) * 10) / 10,
    successCount,
    errorCount,
    abortedCount,
    partialCount,
    errorRate: callCount > 0 ? errorCount / callCount : 0,
    avgContextTokens: average(global.contextTokens),
    medianContextTokens: percentile(global.contextTokens, 0.5),
    p95ContextTokens: percentile(global.contextTokens, 0.95),
    maxContextTokens: max(global.contextTokens),
    avgOutputTokens: average(global.outputTokens),
    avgTotalTokens: average(global.totalTokens),
    avgDurationMs: average(global.durations),
    p95DurationMs: percentile(global.durations, 0.95),
    ttftSampleCount: global.ttfts.length,
    avgTtftMs: average(global.ttfts),
    p95TtftMs: percentile(global.ttfts, 0.95),
    contextTokenDistribution: distributionFromValues(global.contextTokens),
    exclusionReasons: exclusionReasonsFromMap(global.exclusions),
    measurementContract: CONTEXT_HEALTH_MEASUREMENT_CONTRACT,
    budgets: CONTEXT_HEALTH_BUDGETS,
    byProvider,
    byModel,
  };
}
