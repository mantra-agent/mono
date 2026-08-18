/**
 * Core measurement engine boundary.
 *
 * Metrics and KPIs are Core primitives. Domain consumers (Business, Performance,
 * Health, and future adapters) must depend on this module rather than the
 * retained metrics-storage compatibility path. The underlying storage remains
 * unchanged during this additive cut, preserving identifiers, samples, scope,
 * and historical provenance.
 *
 * queryMetric(id, range) is the sole single-metric read: principal-visible
 * definition → platform gate (users:read) → adapterKey dispatch → series + residual.
 */
export {
  ensureMetricsDefinitionsSchema,
  ensurePlatformBusinessMetrics,
  kpiStorage,
  metricsStorage,
  upsertInternalPeriodSample,
} from "../metrics-storage";

import type { Metric, MetricCollection, MetricCoverage, MetricSample, MetricSeries } from "@shared/models/metrics";
import { createLogger } from "../log";
import { getCurrentPrincipal } from "../principal-context";
import {
  adapterKeyOf,
  ensureEngagementMetrics,
  ensureProductCatalogDefinitions,
  metricIsVisibleTo,
  METRIC_ADAPTER_HANDLERS,
  stampPlatformOwnerOnProductMetrics,
} from "./metric-adapters";

const log = createLogger("MetricsCoreEngine");

export type {
  InternalBusinessMetricDefinition,
  InternalBusinessMetricRef,
  InternalPeriodSampleInput,
} from "../metrics-storage";

export {
  ensureEngagementMetrics,
  ensureProductCatalogDefinitions,
  canReadPlatformMetrics,
  canReadSystemMetrics,
  isPlatformMetric,
  isSystemMetric,
  metricIsVisibleTo,
  stampPlatformOwnerOnProductMetrics,
  PRODUCT_METRIC_SLUGS,
} from "./metric-adapters";

function notFound(): never {
  throw Object.assign(new Error("Metric not found"), { status: 404 });
}

async function warehouseSeries(
  metric: Metric,
  range: { start: Date; end: Date },
): Promise<MetricSeries> {
  const samples = await metricsStorage.listSamplesInRange(metric.id, range.start, range.end);
  return {
    metric: { ...metric, latestSample: samples[0] ?? metric.latestSample ?? null },
    samples,
    valueStatus: "actual",
    coverage: { status: "finalized" },
  };
}

/**
 * Canonical single-metric read.
 * Unauthorized platform metrics fail closed as not found (same as ordinary scope miss).
 */
export async function queryMetric(
  metricId: string,
  range: { start: Date; end: Date },
): Promise<MetricSeries> {
  if (
    !range?.start ||
    !range?.end ||
    !Number.isFinite(range.start.getTime()) ||
    !Number.isFinite(range.end.getTime()) ||
    range.end <= range.start
  ) {
    throw Object.assign(new Error("start and end must form a valid sampling range"), { status: 400 });
  }

  const principal = getCurrentPrincipal();
  if (!principal?.userId || !principal.accountId) {
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  }

  // Best-effort engagement provisioning + product owner stamp (idempotent).
  await Promise.all([
    ensureEngagementMetrics(principal).catch((error) => {
      log.warn("engagement metric provision failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }),
    ensureProductCatalogDefinitions().catch((error) => {
      log.warn("product catalog definition provision failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }),
    stampPlatformOwnerOnProductMetrics().catch((error) => {
      log.warn("product metric owner stamp failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }),
  ]);

  let metric: Metric;
  try {
    metric = await metricsStorage.get(metricId);
  } catch (error) {
    if ((error as { status?: number })?.status === 404) notFound();
    throw error;
  }

  if (!metricIsVisibleTo(principal, metric)) {
    notFound();
  }

  const key = adapterKeyOf(metric);
  const handler = key ? METRIC_ADAPTER_HANDLERS[key] : undefined;
  if (!handler) {
    return warehouseSeries(metric, range);
  }

  try {
    const series = await handler(metric, range, principal);
    if (!series) notFound();
    return series;
  } catch (error) {
    if ((error as { status?: number })?.status === 404) throw error;
    log.error("metric adapter failed", {
      metricId: metric.id,
      adapterKey: key,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      metric: { ...metric, latestSample: null },
      samples: [],
      valueStatus: "actual",
      coverage: {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "Adapter failed",
      } satisfies MetricCoverage,
    };
  }
}

export async function queryMetricCollection(
  businessId: string,
  start: Date,
  end: Date,
): Promise<MetricCollection> {
  // Same handlers + product gate as queryMetric; storage.collection applies the gate.
  return metricsStorage.collection(businessId, start, end);
}

function catalogQueryRange(range: { start: Date; end: Date }): { start: Date; end: Date } {
  const now = Date.now();
  const endMs = range.end.getTime();
  // Hours Used rejects end more than 60s ahead of wall clock. Catalog callers
  // pass Date.now(); clamp a few seconds of skew instead of marking unavailable.
  if (endMs > now) {
    const start = range.start.getTime() < now ? range.start : new Date(now - 1);
    return { start, end: new Date(now) };
  }
  return range;
}

/**
 * Catalog list overlay: one queryMetric series per visible definition.
 * Query-time adapters never write metric_samples, so warehouse latestSample
 * would leave Hours Used / engagement blank or unavailable.
 */
export async function overlayCatalogSeries(
  metrics: Metric[],
  range: { start: Date; end: Date },
): Promise<Metric[]> {
  const queryRange = catalogQueryRange(range);
  const overlaid = await Promise.all(metrics.map(async (metric) => {
    try {
      const series = await queryMetric(metric.id, queryRange);
      return {
        ...series.metric,
        latestSample: series.metric.latestSample ?? series.samples[0] ?? null,
        coverage: series.coverage,
      };
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return null;
      log.warn("catalog overlay failed", {
        metricId: metric.id,
        slug: metric.slug,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        ...metric,
        latestSample: null,
      };
    }
  }));
  return overlaid.filter((metric): metric is Metric => metric != null);
}

/** Re-export sample type helpers used by adapters/routes. */
export type { MetricSample, MetricSeries, MetricCoverage };
