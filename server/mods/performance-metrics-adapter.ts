import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { metrics } from "@shared/schema";
import type { BrowserTelemetrySummary } from "@shared/browser-telemetry";
import { db } from "../db";
import { getBrowserTelemetrySummary } from "../browser-telemetry-storage";
import { upsertInternalPeriodSample } from "../metrics/core-engine";
import type { Principal } from "../principal";

const DEFINITIONS = [
  {
    slug: "performance-route-ready-p95",
    name: "Route ready p95",
    description: "95th percentile completed SPA navigation duration from the canonical browser telemetry summary.",
    unit: "ms",
    direction: "lower_is_better",
    sourceKind: "navigation",
    sourceName: "spa_navigation",
  },
  {
    slug: "performance-main-thread-long-task-p95",
    name: "Main-thread long task p95",
    description: "95th percentile main-thread long-task duration from the canonical browser telemetry summary.",
    unit: "ms",
    direction: "lower_is_better",
    sourceKind: "long_task",
    sourceName: "main_thread_blocked",
  },
] as const;

function stableId(accountId: string, slug: string): string {
  return `metric_performance_${createHash("sha256").update(`${accountId}:${slug}`).digest("hex").slice(0, 24)}`;
}

function period(hours: number): { start: Date; end: Date } {
  const end = new Date();
  return { start: new Date(end.getTime() - hours * 60 * 60 * 1000), end };
}

function findP95(summary: BrowserTelemetrySummary, kind: string, name: string): number | null {
  const metric = summary.metrics.find((candidate) => candidate.kind === kind && candidate.name === name);
  return metric?.p95 ?? null;
}

async function ensureDefinition(principal: Principal, definition: (typeof DEFINITIONS)[number]): Promise<string> {
  const id = stableId(principal.accountId!, definition.slug);
  await db.insert(metrics).values({
    id,
    scope: "user",
    ownerUserId: principal.userId,
    accountId: principal.accountId,
    vaultId: principal.activeVaultId,
    createdByUserId: principal.userId,
    ownerKind: "performance",
    ownerId: principal.accountId,
    name: definition.name,
    slug: definition.slug,
    description: definition.description,
    unit: definition.unit,
    direction: definition.direction,
    samplePeriod: "custom",
    adapterKind: "internal",
    adapterConfig: { adapterKey: "performance", sourceKind: definition.sourceKind, sourceName: definition.sourceName },
    status: "active",
  }).onConflictDoNothing({ target: metrics.id });
  return id;
}

/** Projects canonical browser Performance aggregates into Core Metric series. */
export async function projectPerformanceMetrics(principal: Principal, hours = 24): Promise<{
  sourceSampleCount: number;
  projectedSampleCount: number;
  metricIds: string[];
}> {
  if (!principal.userId || !principal.accountId) throw new Error("Performance metrics require an authenticated user principal");
  const boundedHours = Math.min(Math.max(Math.floor(hours), 1), 168);
  const summary = await getBrowserTelemetrySummary(principal, boundedHours);
  const { start, end } = period(boundedHours);
  let projectedSampleCount = 0;
  const metricIds: string[] = [];

  for (const definition of DEFINITIONS) {
    const value = findP95(summary, definition.sourceKind, definition.sourceName);
    if (value == null) continue;
    const metricId = await ensureDefinition(principal, definition);
    metricIds.push(metricId);
    await upsertInternalPeriodSample({
      id: `msamp_${stableId(principal.accountId, definition.slug)}_${end.toISOString().slice(0, 13)}`,
      metricId,
      accountId: principal.accountId,
      ownerUserId: principal.userId,
      vaultId: principal.activeVaultId,
      value,
      unit: definition.unit,
      observedAt: end,
      sourceRef: `performance/browser-telemetry/${definition.sourceKind}/${definition.sourceName}`,
      evidence: `Canonical browser telemetry summary; window=${boundedHours}h; sourceSamples=${summary.sampleCount}; completedNavigationSamples=${summary.navigationTraces.completedCount}`,
      periodStart: start,
      periodEnd: end,
    });
    projectedSampleCount += 1;
  }

  return {
    sourceSampleCount: summary.sampleCount,
    projectedSampleCount,
    metricIds,
  };
}

export async function listPerformanceMetricIds(principal: Principal): Promise<string[]> {
  if (!principal.accountId) return [];
  const rows = await db.select({ id: metrics.id }).from(metrics).where(and(
    eq(metrics.accountId, principal.accountId),
    eq(metrics.ownerKind, "performance"),
  ));
  return rows.map((row) => row.id);
}
