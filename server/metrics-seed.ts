/**
 * Seed eight standing-objective Metrics + KPIs (one KPI per Advantage card)
 * plus a few stub samples so the Advantage page can render measured health.
 */
import {
  STANDING_OBJECTIVE_KEYS,
  type StandingObjectiveKey,
} from "@shared/models/metrics";
import { kpiStorage, metricsStorage } from "./metrics-storage";
import { createLogger } from "./log";

const log = createLogger("MetricsSeed");

interface SeedSpec {
  objective: StandingObjectiveKey;
  metricName: string;
  metricSlug: string;
  unit: string;
  direction: "higher_is_better" | "lower_is_better";
  kpiName: string;
  kpiSlug: string;
  targetLabel: string;
  cadence: string;
  ownerLabel: string;
  bull: number;
  onTrack: number;
  bear: number;
  /** Stub sample so Advantage is not empty on first load. */
  sampleValue: number;
  sampleEvidence: string;
}

const SEEDS: SeedSpec[] = [
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
    bear: 99.0,
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

export async function seedDefaultMetricsAndKpis(): Promise<{
  createdMetrics: number;
  createdKpis: number;
  createdSamples: number;
  skipped: number;
  objectiveKeys: string[];
}> {
  let createdMetrics = 0;
  let createdKpis = 0;
  let createdSamples = 0;
  let skipped = 0;

  const existingKpis = await kpiStorage.list();
  const byObjective = new Map(
    existingKpis
      .filter((k) => k.standingObjectiveKey)
      .map((k) => [k.standingObjectiveKey as string, k]),
  );
  const existingMetrics = await metricsStorage.list();
  const metricsBySlug = new Map(existingMetrics.map((m) => [m.slug, m]));

  for (const seed of SEEDS) {
    if (byObjective.has(seed.objective)) {
      skipped += 1;
      continue;
    }

    let metric = metricsBySlug.get(seed.metricSlug);
    if (!metric) {
      metric = await metricsStorage.create({
        name: seed.metricName,
        slug: seed.metricSlug,
        description: `Seed metric for Advantage standing objective ${seed.objective}.`,
        unit: seed.unit,
        direction: seed.direction,
        samplePeriod: seed.cadence.toLowerCase().includes("month")
          ? "monthly"
          : seed.cadence.toLowerCase().includes("day")
            ? "daily"
            : "weekly",
        adapterKind: "internal",
        adapterConfig: { key: seed.metricSlug },
        status: "active",
      });
      createdMetrics += 1;
      metricsBySlug.set(metric.slug, metric);
    }

    // Only add a sample when metric has none yet
    if (!metric.latestSample) {
      await metricsStorage.recordSample({
        metricId: metric.id,
        value: seed.sampleValue,
        unit: seed.unit,
        sourceRef: "seed:internal",
        evidence: seed.sampleEvidence,
      });
      createdSamples += 1;
      // refresh
      metric = await metricsStorage.get(metric.id);
      metricsBySlug.set(metric.slug, metric);
    }

    await kpiStorage.create({
      metricId: metric.id,
      name: seed.kpiName,
      slug: seed.kpiSlug,
      description: `Qualitative scorecard KPI bound 1:1 to standing objective ${seed.objective}.`,
      targetLabel: seed.targetLabel,
      cadence: seed.cadence,
      ownerLabel: seed.ownerLabel,
      direction: seed.direction,
      bullThreshold: seed.bull,
      onTrackThreshold: seed.onTrack,
      bearThreshold: seed.bear,
      staleAfterHours: 168,
      standingObjectiveKey: seed.objective,
      status: "active",
    });
    createdKpis += 1;
  }

  log.info("metrics/kpi seed complete", {
    createdMetrics,
    createdKpis,
    createdSamples,
    skipped,
  });

  return {
    createdMetrics,
    createdKpis,
    createdSamples,
    skipped,
    objectiveKeys: [...STANDING_OBJECTIVE_KEYS],
  };
}
