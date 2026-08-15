import { getSecret } from "./secrets-store";
import { getCurrentPrincipal } from "./principal-context";
import { fetchUptimeAggregate, getSentryConfig, isSentryConfigured, SentryApiError } from "./integrations/sentry/client";
import { metricsStorage } from "./metrics/core-engine";
import type { Metric } from "@shared/models/metrics";

const EXPECTED_DAILY_CHECKS = 24 * 60;
const MINIMUM_COVERAGE = 0.9;
const METRIC_SLUG = "service-availability";

export type SentryAvailabilityStatus =
  | { status: "not_configured"; configured: false; missing: string[] }
  | { status: "monitor_pending"; configured: true; periodStart: string; periodEnd: string; checkCount: number; expectedChecks: number; coverage: number }
  | { status: "ready"; configured: true; periodStart: string; periodEnd: string; checkCount: number; expectedChecks: number; coverage: number; availability: number; failureRate: number }
  | { status: "unavailable"; configured: true; error: string };

function completedUtcDay(now = new Date()): { start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: new Date(end.getTime() - 24 * 60 * 60 * 1000), end };
}

async function configuredStatus(): Promise<{ cfg: Awaited<ReturnType<typeof getSentryConfig>>; missing: string[] }> {
  const cfg = await getSentryConfig();
  const missing: string[] = [];
  if (!cfg.dsn) missing.push("SENTRY_DSN");
  if (!cfg.hasToken) missing.push("SENTRY_AUTH_TOKEN");
  if (!cfg.org) missing.push("SENTRY_ORG");
  if (!cfg.project) missing.push("SENTRY_PROJECT");
  return { cfg, missing };
}

export async function getSentryAvailabilityStatus(now = new Date()): Promise<SentryAvailabilityStatus> {
  const { cfg, missing } = await configuredStatus();
  if (!isSentryConfigured(cfg)) return { status: "not_configured", configured: false, missing };
  const { start, end } = completedUtcDay(now);
  try {
    const query = (await getSecret("SENTRY_UPTIME_QUERY"))?.trim().slice(0, 500) || undefined;
    const result = await fetchUptimeAggregate(cfg.org, cfg.project, { start, end, query });
    const coverage = result.checkCount / EXPECTED_DAILY_CHECKS;
    const common = {
      configured: true as const,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      checkCount: result.checkCount,
      expectedChecks: EXPECTED_DAILY_CHECKS,
      coverage,
    };
    if (result.incomplete || coverage < MINIMUM_COVERAGE) {
      return { status: "monitor_pending", ...common };
    }
    return {
      status: "ready",
      ...common,
      availability: 100 - result.failureRatePercent,
      failureRate: result.failureRatePercent,
    };
  } catch (error) {
    const message = error instanceof SentryApiError && (error.status === 400 || error.status === 404)
      ? "Uptime results are not available for this Sentry project yet."
      : "Sentry uptime results are temporarily unavailable.";
    return { status: "unavailable", configured: true, error: message };
  }
}

async function ensureAvailabilityMetric(): Promise<Metric> {
  const principal = getCurrentPrincipal();
  const existing = (await metricsStorage.list()).find((metric) =>
    metric.slug === METRIC_SLUG && metric.vaultId === principal?.activeVaultId,
  );
  if (existing) return existing;
  try {
    return await metricsStorage.create({
      name: "Service Availability",
      slug: METRIC_SLUG,
      description: "Percentage of expected one-minute external Sentry Uptime checks that completed successfully.",
      unit: "%",
      direction: "higher_is_better",
      samplePeriod: "daily",
      adapterKind: "internal",
      adapterConfig: { key: "sentry-uptime" },
      status: "active",
    });
  } catch {
    const converged = (await metricsStorage.list()).find((metric) =>
      metric.slug === METRIC_SLUG && metric.vaultId === principal?.activeVaultId,
    );
    if (!converged) throw new Error("Service Availability metric reconciliation failed");
    return converged;
  }
}

export async function syncSentryAvailability(now = new Date()): Promise<{ status: SentryAvailabilityStatus; sampleId?: string }> {
  const principal = getCurrentPrincipal();
  if (!principal?.userId || !principal.accountId) {
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  }
  const status = await getSentryAvailabilityStatus(now);
  if (status.status !== "ready") return { status };
  const metric = await ensureAvailabilityMetric();
  const day = status.periodStart.slice(0, 10);
  const sample = await metricsStorage.recordPeriodSample({
    idempotencyKey: `sentry_availability_${principal.accountId}_${day}`,
    metricId: metric.id,
    value: status.availability,
    unit: "%",
    observedAt: status.periodEnd,
    sourceRef: "sentry/uptime-results-v1",
    evidence: `${status.checkCount}/${status.expectedChecks} expected one-minute checks observed; missing coverage abstains below ${Math.round(MINIMUM_COVERAGE * 100)}%.`,
    periodStart: status.periodStart,
    periodEnd: status.periodEnd,
  });
  return { status, sampleId: sample.id };
}
