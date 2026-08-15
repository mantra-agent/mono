import { createHash } from "crypto";
import { and, eq, gte } from "drizzle-orm";
import { metrics } from "@shared/schema";
import { healthMetrics } from "@shared/models/health";
import { db } from "../db";
import { upsertInternalPeriodSample } from "../metrics/core-engine";
import { requireCurrentPrincipal } from "../principal-context";

const SOURCE = "oura";
const LOOKBACK_DAYS = 90;

function stableId(accountId: string, metricType: string): string {
  return `metric_health_${createHash("sha256").update(`${accountId}:${metricType}`).digest("hex").slice(0, 24)}`;
}

function sampleId(metricId: string, date: string): string {
  return `msamp_${createHash("sha256").update(`${metricId}:${date}`).digest("hex").slice(0, 24)}`;
}

function slug(metricType: string): string {
  return `health-${metricType.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`;
}

function displayName(metricType: string): string {
  return metricType.replace(/(^|_)([a-z])/g, (_match, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
}

/** Projects preserved Oura health history into Core Metric definitions and samples. */
export async function projectOuraMetrics(): Promise<{ sourceRows: number; projectedSamples: number; metricIds: string[] }> {
  const principal = requireCurrentPrincipal();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS);
  const rows = await db.select().from(healthMetrics).where(and(
    gte(healthMetrics.date, since.toISOString().slice(0, 10)),
    eq(healthMetrics.source, SOURCE),
  )).limit(5000);

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.principalAccountId || !row.ownerUserId) continue;
    const key = `${row.principalAccountId}:${row.metricType}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  let projectedSamples = 0;
  const metricIds: string[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const metricId = stableId(first.principalAccountId!, first.metricType);
    await db.insert(metrics).values({
      id: metricId,
      ownerKind: "health",
      ownerId: first.principalAccountId,
      name: displayName(first.metricType),
      slug: slug(first.metricType),
      description: `Daily ${displayName(first.metricType)} measured by Oura.`,
      unit: first.unit,
      direction: "higher_is_better",
      samplePeriod: "daily",
      adapterKind: "internal",
      adapterConfig: { adapterKey: "oura", source: SOURCE, metricType: first.metricType },
      status: "active",
      scope: "user",
      ownerUserId: first.ownerUserId,
      accountId: first.principalAccountId,
      vaultId: first.vaultId,
      createdByUserId: first.ownerUserId,
    }).onConflictDoNothing({ target: metrics.id });
    metricIds.push(metricId);

    for (const row of group) {
      const date = row.date.slice(0, 10);
      await upsertInternalPeriodSample({
        id: sampleId(metricId, date),
        metricId,
        accountId: first.principalAccountId!,
        ownerUserId: first.ownerUserId!,
        vaultId: first.vaultId,
        value: row.value,
        unit: row.unit,
        observedAt: row.recordedAt,
        sourceRef: `oura/${first.metricType}/${date}`,
        evidence: `Preserved health_metrics row ${row.id}; Oura polling is the reliability backbone.`,
        periodStart: new Date(`${date}T00:00:00.000Z`),
        periodEnd: new Date(`${date}T23:59:59.999Z`),
      });
      projectedSamples += 1;
    }
  }
  return { sourceRows: rows.length, projectedSamples, metricIds: [...new Set(metricIds)] };
}
