/**
 * Core measurement engine boundary.
 *
 * Metrics and KPIs are Core primitives. Domain consumers (Business, Performance,
 * Health, and future adapters) must depend on this module rather than the
 * retained metrics-storage compatibility path. The underlying storage remains
 * unchanged during this additive cut, preserving identifiers, samples, scope,
 * and historical provenance.
 */
export {
  ensureMetricsDefinitionsSchema,
  ensurePlatformBusinessMetrics,
  kpiStorage,
  metricsStorage,
  upsertInternalPeriodSample,
} from "../metrics-storage";

import type { MetricCollection } from "@shared/models/metrics";

export async function queryMetricCollection(businessId: string, start: Date, end: Date): Promise<MetricCollection> {
  return metricsStorage.collection(businessId, start, end);
}

export type {
  InternalBusinessMetricDefinition,
  InternalBusinessMetricRef,
  InternalPeriodSampleInput,
} from "../metrics-storage";
