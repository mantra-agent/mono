/**
 * Reconcile Metrics + KPIs with the eight canonical Business Advantage cards.
 *
 * Defaults are deliberately qualitative and unmeasured. A standing objective
 * can span several eventual data sources, so the seed must not invent a proxy,
 * threshold, unit, adapter, sample, or Manual metric shell just to make the
 * card look instrumented. Manual metrics are user-authored only.
 */
import { ADVANTAGE_STANDING_OBJECTIVES } from "@shared/models/advantage-dashboard";
import { businessPlans } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type {
  Kpi,
  Metric,
  MetricDirection,
  MetricSample,
  StandingObjectiveKey,
} from "@shared/models/metrics";
import { kpiStorage, metricsStorage } from "./metrics/core-engine";
import { db } from "./db";
import { getCurrentPrincipal } from "./principal-context";

interface LegacySeed {
  objective: StandingObjectiveKey;
  metricName: string;
  metricSlug: string;
  unit: string;
  direction: MetricDirection;
  kpiName: string;
  kpiSlug: string;
  targetLabel: string;
  cadence: string;
  ownerLabel: string;
  bull: number;
  onTrack: number;
  bear: number;
  sampleValue: number;
  sampleEvidence: string;
}

/**
 * Exact signatures shipped by the original Metrics/KPI seed. They are used
 * only to identify untouched system defaults. Any changed definition, binding,
 * adapter, threshold, or user-recorded sample makes the row ineligible for
 * automatic retirement.
 */
const LEGACY_SEEDS: readonly LegacySeed[] = [
  {
    objective: "trust-security",
    metricName: "Critical security findings open",
    metricSlug: "critical-security-findings-open",
    unit: "findings",
    direction: "lower_is_better",
    kpiName: "Trust & security posture",
    kpiSlug: "trust-security-posture",
    targetLabel: "0 critical findings open",
    cadence: "Weekly",
    ownerLabel: "Platform",
    bull: 0,
    onTrack: 1,
    bear: 3,
    sampleValue: 0,
    sampleEvidence: "Stub: no open critical findings in staging review.",
  },
  {
    objective: "reliability-performance",
    metricName: "API availability (rolling 7d)",
    metricSlug: "api-availability-7d",
    unit: "%",
    direction: "higher_is_better",
    kpiName: "Reliability & performance",
    kpiSlug: "reliability-performance",
    targetLabel: "≥99.5% availability",
    cadence: "Daily",
    ownerLabel: "Platform",
    bull: 99.9,
    onTrack: 99.5,
    bear: 99,
    sampleValue: 99.7,
    sampleEvidence: "Stub: derived from /api/health probe window.",
  },
  {
    objective: "customer-health",
    metricName: "Active paying accounts",
    metricSlug: "active-paying-accounts",
    unit: "accounts",
    direction: "higher_is_better",
    kpiName: "Customer health",
    kpiSlug: "customer-health",
    targetLabel: "Growing WoW, zero P0 blockers",
    cadence: "Weekly",
    ownerLabel: "Customer success",
    bull: 5,
    onTrack: 2,
    bear: 1,
    sampleValue: 1,
    sampleEvidence: "Stub: founder-led design partners in motion.",
  },
  {
    objective: "revenue-runway",
    metricName: "Cash runway months",
    metricSlug: "cash-runway-months",
    unit: "months",
    direction: "higher_is_better",
    kpiName: "Revenue, cash & runway",
    kpiSlug: "revenue-runway",
    targetLabel: "≥12 months runway",
    cadence: "Monthly",
    ownerLabel: "Finance",
    bull: 18,
    onTrack: 12,
    bear: 6,
    sampleValue: 14,
    sampleEvidence: "Stub: funded plan runway estimate.",
  },
  {
    objective: "delivery-economics",
    metricName: "Fully-loaded cost per active account",
    metricSlug: "cost-per-active-account",
    unit: "$/account",
    direction: "lower_is_better",
    kpiName: "Delivery economics",
    kpiSlug: "delivery-economics",
    targetLabel: "Declining unit cost as reuse rises",
    cadence: "Monthly",
    ownerLabel: "Operations",
    bull: 200,
    onTrack: 500,
    bear: 1000,
    sampleValue: 750,
    sampleEvidence: "Stub: early-stage unit economics placeholder.",
  },
  {
    objective: "product-release",
    metricName: "Successful production deploys (7d)",
    metricSlug: "successful-deploys-7d",
    unit: "deploys",
    direction: "higher_is_better",
    kpiName: "Product & release health",
    kpiSlug: "product-release-health",
    targetLabel: "Healthy deploys, no Sev-1 open",
    cadence: "Per deploy",
    ownerLabel: "Engineering",
    bull: 10,
    onTrack: 3,
    bear: 1,
    sampleValue: 5,
    sampleEvidence: "Stub: recent main→live publish cadence.",
  },
  {
    objective: "founder-team",
    metricName: "Founder judgment time share",
    metricSlug: "founder-judgment-time-share",
    unit: "%",
    direction: "higher_is_better",
    kpiName: "Founder & team capacity",
    kpiSlug: "founder-team-capacity",
    targetLabel: "≥50% judgment / GTM time",
    cadence: "Weekly",
    ownerLabel: "Ray",
    bull: 60,
    onTrack: 50,
    bear: 35,
    sampleValue: 45,
    sampleEvidence: "Stub: calendar classification estimate.",
  },
  {
    objective: "corporate-stewardship",
    metricName: "Open corporate compliance items",
    metricSlug: "open-compliance-items",
    unit: "items",
    direction: "lower_is_better",
    kpiName: "Corporate stewardship",
    kpiSlug: "corporate-stewardship",
    targetLabel: "0 overdue statutory items",
    cadence: "Weekly",
    ownerLabel: "Operations",
    bull: 0,
    onTrack: 1,
    bear: 3,
    sampleValue: 1,
    sampleEvidence: "Stub: one non-overdue follow-up tracked.",
  },
];

const SYNTHETIC_USAGE_METRICS = new Map([
  ["active-users", {
    name: "Active Users",
    description: "Distinct authenticated users connected at any point in the sampled range.",
    unit: "users",
  }],
  ["current-users", {
    name: "Current Users",
    description: "Authenticated users connected at the end of the sampled range.",
    unit: "users",
  }],
]);

const STANDING_OBJECTIVE_BY_KEY = new Map(
  ADVANTAGE_STANDING_OBJECTIVES.map((objective) => [
    objective.key as StandingObjectiveKey,
    objective,
  ]),
);

function sameAdapterConfig(
  actual: Record<string, unknown>,
  metricSlug: string,
): boolean {
  return (
    Object.keys(actual).length === 1 && actual.key === metricSlug
  );
}

function isUntouchedLegacyMetric(metric: Metric, seed: LegacySeed): boolean {
  return (
    metric.name === seed.metricName &&
    metric.slug === seed.metricSlug &&
    metric.description ===
      `Seed metric for Advantage standing objective ${seed.objective}.` &&
    metric.unit === seed.unit &&
    metric.direction === seed.direction &&
    metric.samplePeriod === "point" &&
    metric.adapterKind === "internal" &&
    sameAdapterConfig(metric.adapterConfig, seed.metricSlug) &&
    metric.status === "active"
  );
}

function isUntouchedLegacyKpi(kpi: Kpi, seed: LegacySeed): boolean {
  return (
    kpi.name === seed.kpiName &&
    kpi.slug === seed.kpiSlug &&
    kpi.description ===
      `Standing operating objective scorecard for ${seed.objective}.` &&
    kpi.targetLabel === seed.targetLabel &&
    kpi.cadence === seed.cadence &&
    kpi.ownerLabel === seed.ownerLabel &&
    kpi.direction === seed.direction &&
    kpi.bullThreshold === seed.bull &&
    kpi.onTrackThreshold === seed.onTrack &&
    kpi.bearThreshold === seed.bear &&
    kpi.staleAfterHours === 168 &&
    kpi.standingObjectiveKey === seed.objective &&
    kpi.status === "active"
  );
}

function isLegacyStubSample(
  sample: MetricSample,
  seed: LegacySeed,
): boolean {
  return (
    sample.value === seed.sampleValue &&
    sample.unit === seed.unit &&
    sample.sourceRef === "stub/metrics-seed" &&
    sample.evidence === seed.sampleEvidence &&
    sample.periodStart === null &&
    sample.periodEnd === null
  );
}

/**
 * Manual standing-objective shells created by the post-legacy seed. They only
 * existed to satisfy KPI.metricId and must never appear as user Manual metrics.
 */
function isUntouchedManualStandingShell(metric: Metric): boolean {
  const objective = STANDING_OBJECTIVE_BY_KEY.get(
    metric.slug as StandingObjectiveKey,
  );
  if (!objective) return false;
  return (
    metric.name === objective.label &&
    metric.description === objective.definition &&
    metric.unit === "" &&
    metric.direction === "target_band" &&
    metric.samplePeriod === "point" &&
    metric.adapterKind === "manual" &&
    Object.keys(metric.adapterConfig ?? {}).length === 0 &&
    metric.status === "active"
  );
}

function isUntouchedManualStandingKpi(kpi: Kpi, metric: Metric): boolean {
  const objective = STANDING_OBJECTIVE_BY_KEY.get(
    (kpi.standingObjectiveKey ?? kpi.slug) as StandingObjectiveKey,
  );
  if (!objective) return false;
  return (
    kpi.metricId === metric.id &&
    kpi.name === objective.label &&
    kpi.slug === objective.key &&
    kpi.description === objective.definition &&
    kpi.targetLabel === objective.definition &&
    kpi.cadence === objective.cadence &&
    kpi.ownerLabel === objective.owner &&
    kpi.direction === "target_band" &&
    kpi.bullThreshold == null &&
    kpi.onTrackThreshold == null &&
    kpi.bearThreshold == null &&
    kpi.staleAfterHours === 168 &&
    kpi.standingObjectiveKey === objective.key &&
    kpi.status === "active"
  );
}

function sameVaultScope(
  rowVaultId: string | null | undefined,
  activeVaultId: string,
): boolean {
  // NULL vault rows are pre-scoping leftovers that still render in the active
  // vault's visible set; treat them as in-scope for retirement.
  return rowVaultId == null || rowVaultId === activeVaultId;
}

function isSyntheticUsageShell(metric: Metric): boolean {
  const signature = SYNTHETIC_USAGE_METRICS.get(metric.slug);
  return Boolean(
    signature &&
    metric.name === signature.name &&
    metric.description === signature.description &&
    metric.unit === signature.unit &&
    metric.direction === "higher_is_better" &&
    metric.samplePeriod === "custom" &&
    metric.adapterKind === "internal" &&
    sameAdapterConfig(metric.adapterConfig, metric.slug) &&
    metric.status === "active"
  );
}

async function isMetricBoundToPlan(metricId: string): Promise<boolean> {
  const principal = getCurrentPrincipal();
  const rows = await db.select({ id: businessPlans.id }).from(businessPlans).where(and(
    eq(businessPlans.ownerUserId, principal.userId),
    eq(businessPlans.accountId, principal.accountId),
    sql`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(${businessPlans.initiativeMeasurementBindings}) binding
      WHERE binding ->> 'leadingMetricId' = ${metricId}
    )`,
  )).limit(1);
  return rows.length > 0;
}

async function retireSyntheticUsageShells(
  visibleVaultIds: readonly string[],
): Promise<number> {
  let retiredMetrics = 0;
  const candidates = (await metricsStorage.list()).filter((metric) =>
    visibleVaultIds.some((vaultId) => sameVaultScope(metric.vaultId, vaultId)) &&
    isSyntheticUsageShell(metric),
  );
  const kpis = await kpiStorage.list();

  for (const metric of candidates) {
    if (kpis.some((kpi) => kpi.metricId === metric.id)) continue;
    if ((await metricsStorage.listSamples(metric.id, 1)).length > 0) continue;
    if (await isMetricBoundToPlan(metric.id)) continue;
    await metricsStorage.delete(metric.id);
    retiredMetrics += 1;
  }

  return retiredMetrics;
}

async function retireUntouchedLegacyDefaults(
  visibleVaultIds: readonly string[],
): Promise<{
  retiredMetrics: number;
  retiredKpis: number;
  retiredSamples: number;
}> {
  let retiredMetrics = 0;
  let retiredKpis = 0;
  let retiredSamples = 0;
  const metrics = (await metricsStorage.list()).filter((metric) =>
    visibleVaultIds.some((vaultId) => sameVaultScope(metric.vaultId, vaultId)),
  );
  const kpis = (await kpiStorage.list()).filter((kpi) =>
    visibleVaultIds.some((vaultId) => sameVaultScope(kpi.vaultId, vaultId)),
  );

  for (const seed of LEGACY_SEEDS) {
    const candidates = metrics.filter((metric) =>
      metric.slug === seed.metricSlug && isUntouchedLegacyMetric(metric, seed),
    );
    for (const metric of candidates) {
      const boundKpis = kpis.filter((kpi) => kpi.metricId === metric.id);
      if (
        boundKpis.length !== 1 ||
        !isUntouchedLegacyKpi(boundKpis[0], seed)
      ) {
        continue;
      }

      const samples = await metricsStorage.listSamples(metric.id, 2);
      if (
        samples.length > 1 ||
        (samples.length === 1 && !isLegacyStubSample(samples[0], seed))
      ) {
        continue;
      }

      await kpiStorage.delete(boundKpis[0].id);
      retiredKpis += 1;
      for (const sample of samples) {
        await metricsStorage.deleteSample(sample.id);
        retiredSamples += 1;
      }
      await metricsStorage.delete(metric.id);
      retiredMetrics += 1;
    }
  }

  return { retiredMetrics, retiredKpis, retiredSamples };
}

async function retireUntouchedManualStandingShells(
  visibleVaultIds: readonly string[],
): Promise<{
  retiredMetrics: number;
  retiredKpis: number;
}> {
  let retiredMetrics = 0;
  let retiredKpis = 0;
  const metrics = (await metricsStorage.list()).filter((metric) =>
    visibleVaultIds.some((vaultId) => sameVaultScope(metric.vaultId, vaultId)),
  );
  const kpis = (await kpiStorage.list()).filter((kpi) =>
    visibleVaultIds.some((vaultId) => sameVaultScope(kpi.vaultId, vaultId)),
  );

  for (const metric of metrics) {
    if (!isUntouchedManualStandingShell(metric)) continue;

    const boundKpis = kpis.filter((kpi) => kpi.metricId === metric.id);
    if (
      boundKpis.some((kpi) => !isUntouchedManualStandingKpi(kpi, metric))
    ) {
      continue;
    }

    const samples = await metricsStorage.listSamples(metric.id, 1);
    if (samples.length > 0) continue;

    for (const kpi of boundKpis) {
      await kpiStorage.delete(kpi.id);
      retiredKpis += 1;
    }
    await metricsStorage.delete(metric.id);
    retiredMetrics += 1;
  }

  return { retiredMetrics, retiredKpis };
}

export async function seedDefaultMetricsAndKpis(): Promise<{
  createdMetrics: number;
  createdKpis: number;
  createdSamples: number;
  retiredMetrics: number;
  retiredKpis: number;
  retiredSamples: number;
  skipped: number;
  objectiveKeys: StandingObjectiveKey[];
}> {
  const principal = getCurrentPrincipal();
  const activeVaultId = principal.activeVaultId;
  if (!activeVaultId) {
    throw new Error("Metrics/KPI defaults require an active vault");
  }
  const visibleVaultIds = Array.from(new Set([
    activeVaultId,
    ...(principal.visibleVaultIds ?? []),
  ]));

  // Never invent Manual metrics. Standing objectives stay unmeasured until the
  // user authors a real metric and binds a KPI. This pass only retires prior
  // system shells (legacy internal stubs + post-legacy Manual placeholders),
  // including NULL-vault duplicates that still render in the active vault.
  const retiredLegacy = await retireUntouchedLegacyDefaults(visibleVaultIds);
  const retiredShells = await retireUntouchedManualStandingShells(visibleVaultIds);
  const retiredUsageShells = await retireSyntheticUsageShells(visibleVaultIds);

  const kpis = (await kpiStorage.list()).filter((kpi) =>
    visibleVaultIds.some((vaultId) => sameVaultScope(kpi.vaultId, vaultId)),
  );
  const byObjective = new Set(
    kpis
      .map((kpi) => kpi.standingObjectiveKey)
      .filter((key): key is StandingObjectiveKey => !!key),
  );

  let skipped = 0;
  const objectiveKeys: StandingObjectiveKey[] = [];
  for (const objective of ADVANTAGE_STANDING_OBJECTIVES) {
    const objectiveKey = objective.key as StandingObjectiveKey;
    objectiveKeys.push(objectiveKey);
    if (byObjective.has(objectiveKey)) skipped += 1;
  }

  return {
    createdMetrics: 0,
    createdKpis: 0,
    createdSamples: 0,
    retiredMetrics: retiredLegacy.retiredMetrics + retiredShells.retiredMetrics + retiredUsageShells,
    retiredKpis: retiredLegacy.retiredKpis + retiredShells.retiredKpis,
    retiredSamples: retiredLegacy.retiredSamples,
    skipped,
    objectiveKeys,
  };
}
