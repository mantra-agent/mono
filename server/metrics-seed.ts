/**
 * Reconcile Metrics + KPIs with the eight canonical Business Advantage cards.
 *
 * Defaults are deliberately qualitative and unmeasured. A standing objective
 * can span several eventual data sources, so the seed must not invent a proxy,
 * threshold, unit, adapter, or sample just to make the card look measured.
 */
import { ADVANTAGE_STANDING_OBJECTIVES } from "@shared/models/advantage-dashboard";
import type {
  Kpi,
  Metric,
  MetricDirection,
  MetricSample,
  StandingObjectiveKey,
} from "@shared/models/metrics";
import { kpiStorage, metricsStorage } from "./metrics-storage";
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

async function retireUntouchedLegacyDefaults(
  activeVaultId: string | null,
): Promise<{
  retiredMetrics: number;
  retiredKpis: number;
  retiredSamples: number;
}> {
  let retiredMetrics = 0;
  let retiredKpis = 0;
  let retiredSamples = 0;
  const metrics = (await metricsStorage.list()).filter(
    (metric) => metric.vaultId === activeVaultId,
  );
  const kpis = (await kpiStorage.list()).filter(
    (kpi) => kpi.vaultId === activeVaultId,
  );

  for (const seed of LEGACY_SEEDS) {
    const metric = metrics.find((candidate) => candidate.slug === seed.metricSlug);
    const kpi = kpis.find((candidate) => candidate.slug === seed.kpiSlug);
    if (
      !metric ||
      !kpi ||
      kpi.metricId !== metric.id ||
      !isUntouchedLegacyMetric(metric, seed) ||
      !isUntouchedLegacyKpi(kpi, seed) ||
      kpis.some(
        (candidate) => candidate.metricId === metric.id && candidate.id !== kpi.id,
      )
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

    await kpiStorage.delete(kpi.id);
    retiredKpis += 1;
    for (const sample of samples) {
      await metricsStorage.deleteSample(sample.id);
      retiredSamples += 1;
    }
    await metricsStorage.delete(metric.id);
    retiredMetrics += 1;
  }

  return { retiredMetrics, retiredKpis, retiredSamples };
}

function canonicalMetricSlug(objectiveKey: string): string {
  return objectiveKey;
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
  const activeVaultId = getCurrentPrincipal().activeVaultId;
  if (!activeVaultId) {
    throw new Error("Metrics/KPI defaults require an active vault");
  }
  const retired = await retireUntouchedLegacyDefaults(activeVaultId);
  let createdMetrics = 0;
  let createdKpis = 0;
  let skipped = 0;
  const objectiveKeys: StandingObjectiveKey[] = [];
  let metrics = (await metricsStorage.list()).filter(
    (metric) => metric.vaultId === activeVaultId,
  );
  const kpis = (await kpiStorage.list()).filter(
    (kpi) => kpi.vaultId === activeVaultId,
  );
  const byObjective = new Map(
    kpis
      .filter((kpi) => kpi.standingObjectiveKey)
      .map((kpi) => [kpi.standingObjectiveKey!, kpi]),
  );

  for (const objective of ADVANTAGE_STANDING_OBJECTIVES) {
    const objectiveKey = objective.key as StandingObjectiveKey;
    objectiveKeys.push(objectiveKey);

    // A modified or user-authored binding is authoritative and must survive.
    if (byObjective.has(objectiveKey)) {
      skipped += 1;
      continue;
    }

    const metricSlug = canonicalMetricSlug(objective.key);
    let metric = metrics.find((candidate) => candidate.slug === metricSlug);
    if (!metric) {
      metric = await metricsStorage.create({
        name: objective.label,
        slug: metricSlug,
        description: objective.definition,
        unit: "",
        direction: "target_band",
        samplePeriod: "point",
        adapterKind: "manual",
        adapterConfig: {},
        status: "active",
      });
      metrics = [...metrics, metric];
      createdMetrics += 1;
    }

    await kpiStorage.create({
      metricId: metric.id,
      name: objective.label,
      slug: objective.key,
      description: objective.definition,
      targetLabel: objective.definition,
      cadence: objective.cadence,
      ownerLabel: objective.owner,
      direction: "target_band",
      bullThreshold: null,
      onTrackThreshold: null,
      bearThreshold: null,
      standingObjectiveKey: objectiveKey,
      status: "active",
    });
    createdKpis += 1;
  }

  return {
    createdMetrics,
    createdKpis,
    createdSamples: 0,
    ...retired,
    skipped,
    objectiveKeys,
  };
}
