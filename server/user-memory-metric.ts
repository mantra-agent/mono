import { and, count, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { memoryVnextClaims } from "@shared/schema";
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
const STOCK_STAGES = ["canonical", "linked"] as const;
let rollupTimer: NodeJS.Timeout | null = null;

/**
 * User Memory: the count of durable knowledge Mantra holds —
 * vNext claims that have reached canonical or linked. Point-in-time stock.
 * queryMetric answers any range.end; hourly warehouse rows remain a projection.
 */
const USER_MEMORY_METRIC_DEFINITION: InternalBusinessMetricDefinition = {
  key: "user-memory",
  name: "User Memory",
  unit: "claims",
  description: "Active canonical and linked vNext memory claims held across Mantra.",
  direction: "higher_is_better",
  samplePeriod: "point",
};

export const USER_MEMORY_PLATFORM_DEFINITION = USER_MEMORY_METRIC_DEFINITION;

export const USER_MEMORY_STOCK_PARTIAL_REASON =
  "Reconstructed as of range.end from created and lifecycle timestamps; stage history is incomplete.";

export async function sampleUserMemoryStock(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(memoryVnextClaims)
    .where(inArray(memoryVnextClaims.lifecycleStage, [...STOCK_STAGES]));
  return Number(row?.value ?? 0);
}

/**
 * Reconstruct User Memory as of `at`.
 *
 * There is no SCD. A claim is treated as in-stock at `at` when it existed
 * (`createdAt < at`) and is either still linked/canonical, or left those
 * stages later (`retired` after `at` from linked/canonical). Mid-life stage
 * flips that later reverse are invisible — callers must mark coverage partial.
 */
export async function sampleUserMemoryStockAsOf(at: Date): Promise<number> {
  const lastFrom = sql<string>`COALESCE(${memoryVnextClaims.metadata}->'lifecycle'->'lastTransition'->>'from', '')`;
  const [row] = await db
    .select({ value: count() })
    .from(memoryVnextClaims)
    .where(
      and(
        lt(memoryVnextClaims.createdAt, at),
        or(
          inArray(memoryVnextClaims.lifecycleStage, [...STOCK_STAGES]),
          and(
            eq(memoryVnextClaims.lifecycleStage, "retired"),
            gte(memoryVnextClaims.lifecycleStageUpdatedAt, at),
            inArray(lastFrom, [...STOCK_STAGES]),
          ),
        ),
      ),
    );
  return Number(row?.value ?? 0);
}

async function rollupUserMemory(now = new Date()): Promise<void> {
  await ensureMetricsSamplesSchema();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayKey = dayStart.toISOString().slice(0, 10);
  const value = await sampleUserMemoryStock();
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
    value,
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
