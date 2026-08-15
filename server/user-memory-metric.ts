import { sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { ensureMetricsSamplesSchema, metricsDb } from "./metrics-db";
import {
  ensurePlatformBusinessMetrics,
  upsertInternalPeriodSample,
  type InternalBusinessMetricDefinition,
} from "./metrics/core-engine";

const log = createLogger("UserMemory");
const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
let rollupTimer: NodeJS.Timeout | null = null;

/**
 * User Memory: the count of durable knowledge Mantra holds for an account —
 * active (non-retired) vNext claims that reached the canonical or linked lifecycle
 * stage. Per-account and user-scoped; the platform-wide total is the sum across
 * accounts, computed the same way the usage dashboard aggregates Hours Used.
 */
const USER_MEMORY_METRIC_DEFINITION: InternalBusinessMetricDefinition = {
  key: "user-memory",
  name: "User Memory",
  unit: "claims",
  description: "Active canonical and linked vNext memory claims held across Mantra.",
  direction: "higher_is_better",
  samplePeriod: "daily",
};

async function rollupUserMemory(now = new Date()): Promise<void> {
  await ensureMetricsSamplesSchema();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayKey = dayStart.toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    SELECT count(*)::int AS claim_count
    FROM memory_vnext_claims
    WHERE lifecycle_stage IN ('canonical', 'linked')
  `);
  const resultRows = (Array.isArray(rows) ? rows : (rows as unknown as { rows?: unknown[] }).rows ?? []) as Array<{
    claim_count: number;
  }>;
  const metric = (await ensurePlatformBusinessMetrics([USER_MEMORY_METRIC_DEFINITION])).get("user-memory");
  if (!metric) return;
  await metricsDb.execute(sql`
    DELETE FROM metric_samples
    WHERE source_ref = 'internal/user-memory-v1' AND metric_id <> ${metric.id}
  `);
  await upsertInternalPeriodSample({
    id: `msamp_user_memory_${metric.businessId}_${dayKey}`,
    metricId: metric.id,
    accountId: metric.accountId,
    ownerUserId: metric.ownerUserId,
    vaultId: metric.vaultId,
    value: Number(resultRows[0]?.claim_count ?? 0),
    unit: "claims",
    observedAt: now,
    sourceRef: "internal/user-memory-v2",
    evidence: "Platform count of active canonical and linked vNext memory claims.",
    periodStart: dayStart,
    periodEnd: now,
  });
}

export async function startUserMemoryRollups(): Promise<void> {
  if (rollupTimer) return;
  await rollupUserMemory();
  rollupTimer = setInterval(() => {
    void rollupUserMemory().catch((error) => {
      log.warn("rollup degraded", {
        code: "USER_MEMORY_ROLLUP_FAILED",
        errorType: error instanceof Error ? error.name : typeof error,
      });
    });
  }, ROLLUP_INTERVAL_MS);
  rollupTimer.unref();
}

export function stopUserMemoryRollups(): void {
  if (!rollupTimer) return;
  clearInterval(rollupTimer);
  rollupTimer = null;
}
