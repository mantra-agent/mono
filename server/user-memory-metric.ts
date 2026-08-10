import { sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import {
  ensureInternalAccountMetrics,
  upsertInternalPeriodSample,
  type InternalAccountMetricDefinition,
} from "./metrics-storage";

const log = createLogger("UserMemory");
const ROLLUP_INTERVAL_MS = 60 * 60 * 1000;
const ACCOUNT_SCAN_LIMIT = 5000;
let rollupTimer: NodeJS.Timeout | null = null;

/**
 * User Memory: the count of durable knowledge Mantra holds for an account —
 * active (non-retired) vNext claims that reached the canonical or linked lifecycle
 * stage. Per-account and user-scoped; the platform-wide total is the sum across
 * accounts, computed the same way the usage dashboard aggregates Hours Used.
 */
const USER_MEMORY_METRIC_DEFINITION: InternalAccountMetricDefinition = {
  key: "user-memory",
  name: "User Memory",
  unit: "claims",
  description: "Active canonical and linked vNext memory claims held for the account.",
  direction: "higher_is_better",
  samplePeriod: "daily",
};

async function rollupUserMemory(now = new Date()): Promise<void> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayKey = dayStart.toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    SELECT account_id, owner_user_id, count(*)::int AS claim_count
    FROM memory_vnext_claims
    WHERE lifecycle_stage IN ('canonical', 'linked')
      AND account_id IS NOT NULL
      AND owner_user_id IS NOT NULL
    GROUP BY account_id, owner_user_id
    LIMIT ${ACCOUNT_SCAN_LIMIT}
  `);
  const resultRows = (Array.isArray(rows) ? rows : (rows as unknown as { rows?: unknown[] }).rows ?? []) as Array<{
    account_id: string;
    owner_user_id: string;
    claim_count: number;
  }>;

  for (const row of resultRows) {
    const metric = (await ensureInternalAccountMetrics(row.account_id, [USER_MEMORY_METRIC_DEFINITION])).get("user-memory");
    if (!metric) continue;
    await upsertInternalPeriodSample({
      id: `msamp_user_memory_${row.account_id}_${dayKey}`,
      metricId: metric.id,
      accountId: row.account_id,
      ownerUserId: metric.ownerUserId,
      vaultId: metric.vaultId,
      value: Number(row.claim_count),
      unit: "claims",
      observedAt: now,
      sourceRef: "internal/user-memory-v1",
      evidence: "Count of active canonical and linked vNext memory claims for the account.",
      periodStart: dayStart,
      periodEnd: now,
    });
  }
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
