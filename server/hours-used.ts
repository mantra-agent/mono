import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { createLogger } from "./log";
import { ensureMetricsSamplesSchema, metricsDb } from "./metrics-db";
import { enqueueTelemetryWrite } from "./telemetry-write";
import { ensurePlatformBusinessMetrics, upsertInternalPeriodSample } from "./metrics/core-engine";

const log = createLogger("HoursUsed");
export const USAGE_LEASE_TAIL_MS = 45_000;
const RAW_RETENTION_DAYS = 400;
const ROLLUP_RETENTION_DAYS = 400;
export const USAGE_SAMPLE_MAX_DAYS = 400;
const HOUR_MS = 60 * 60 * 1000;
const ROLLUP_INTERVAL_MS = 60 * 1000;
let schemaReady: Promise<void> | null = null;
let rollupTimer: NodeJS.Timeout | null = null;

export type HoursUsedPresenceObservation = {
  accountId: string;
  userId: string;
  clientId: string;
  connectedAt: Date;
  lastSeenAt: Date;
  active: boolean;
};

export type UsageRangeSample = {
  start: string;
  end: string;
  hoursUsed: number;
  activeUsers: number;
  currentUsers: number;
};

const USAGE_METRIC_DEFINITIONS = [
  {
    key: "hours-used",
    name: "Hours Used",
    unit: "hours",
    description: "Connected time unioned per authenticated user across tabs and devices.",
  },
] as const;

export async function ensureHoursUsedSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await ensureMetricsSamplesSchema();
      await metricsDb.execute(sql`
        CREATE TABLE IF NOT EXISTS hours_used_intervals (
          id uuid PRIMARY KEY,
          account_id text NOT NULL,
          user_id text NOT NULL,
          client_id text NOT NULL,
          connected_at timestamptz NOT NULL,
          last_seen_at timestamptz NOT NULL,
          disconnected_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK (last_seen_at >= connected_at),
          CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at)
        )
      `);
      await metricsDb.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS hours_used_intervals_active_client_uidx
        ON hours_used_intervals(account_id, user_id, client_id)
        WHERE disconnected_at IS NULL
      `);
      await metricsDb.execute(sql`
        CREATE INDEX IF NOT EXISTS hours_used_intervals_rollup_idx
        ON hours_used_intervals(account_id, user_id, connected_at, disconnected_at, last_seen_at)
      `);
      await metricsDb.execute(sql`
        CREATE TABLE IF NOT EXISTS hours_used_rollups (
          account_id text NOT NULL,
          period_kind text NOT NULL,
          period_start timestamptz NOT NULL,
          period_end timestamptz NOT NULL,
          seconds_used double precision NOT NULL,
          computed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (account_id, period_kind, period_start),
          CHECK (period_kind IN ('hour', 'day')),
          CHECK (seconds_used >= 0),
          CHECK (period_end > period_start)
        )
      `);
      await metricsDb.execute(sql`
        CREATE INDEX IF NOT EXISTS hours_used_rollups_period_idx
        ON hours_used_rollups(period_kind, period_start DESC)
      `);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export function observeHoursUsedPresence(observation: HoursUsedPresenceObservation): void {
  enqueueTelemetryWrite("hours-used-presence", async () => {
    await ensureHoursUsedSchema();
    if (observation.active) {
      await metricsDb.execute(sql`
        INSERT INTO hours_used_intervals (
          id, account_id, user_id, client_id, connected_at, last_seen_at
        ) VALUES (
          ${randomUUID()}, ${observation.accountId}, ${observation.userId}, ${observation.clientId},
          ${observation.connectedAt}, ${observation.lastSeenAt}
        )
        ON CONFLICT (account_id, user_id, client_id) WHERE disconnected_at IS NULL
        DO UPDATE SET
          last_seen_at = GREATEST(hours_used_intervals.last_seen_at, EXCLUDED.last_seen_at),
          updated_at = CURRENT_TIMESTAMP
      `);
    } else {
      await metricsDb.execute(sql`
        UPDATE hours_used_intervals
        SET disconnected_at = GREATEST(connected_at, ${observation.lastSeenAt}),
            last_seen_at = GREATEST(last_seen_at, ${observation.lastSeenAt}),
            updated_at = CURRENT_TIMESTAMP
        WHERE account_id = ${observation.accountId}
          AND user_id = ${observation.userId}
          AND client_id = ${observation.clientId}
          AND disconnected_at IS NULL
      `);
    }
  });
}

function validateUsageRange(start: Date, end: Date): void {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw Object.assign(new Error("start and end must be valid ISO timestamps"), { status: 400 });
  }
  if (end <= start) {
    throw Object.assign(new Error("end must be after start"), { status: 400 });
  }
  if (end.getTime() - start.getTime() > USAGE_SAMPLE_MAX_DAYS * 24 * HOUR_MS) {
    throw Object.assign(new Error(`range cannot exceed ${USAGE_SAMPLE_MAX_DAYS} days`), { status: 400 });
  }
  // Catalog/list callers pass Date.now() as exclusive end. Clock skew of a few
  // seconds is not a future range — clamp rather than fail the product adapter.
  if (end.getTime() > Date.now() + 60_000) {
    throw Object.assign(new Error("end cannot be in the future"), { status: 400 });
  }
}

export async function sampleUsageRange(accountId: string | null, start: Date, end: Date): Promise<UsageRangeSample> {
  validateUsageRange(start, end);
  await ensureHoursUsedSchema();
  const rows = await metricsDb.execute(sql`
    WITH bounded AS (
      SELECT user_id,
        tstzrange(
          GREATEST(connected_at, ${start}),
          LEAST(COALESCE(disconnected_at, last_seen_at + (${USAGE_LEASE_TAIL_MS} * interval '1 millisecond')), ${end}),
          '[)'
        ) AS span,
        connected_at,
        COALESCE(disconnected_at, last_seen_at + (${USAGE_LEASE_TAIL_MS} * interval '1 millisecond')) AS effective_end
      FROM hours_used_intervals
      WHERE (${accountId}::text IS NULL OR account_id = ${accountId})
        AND connected_at < ${end}
        AND COALESCE(disconnected_at, last_seen_at + (${USAGE_LEASE_TAIL_MS} * interval '1 millisecond')) > ${start}
    ), merged AS (
      SELECT user_id, unnest(range_agg(span)) AS span
      FROM bounded
      WHERE NOT isempty(span)
      GROUP BY user_id
    )
    SELECT
      COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (upper(span) - lower(span)))) FROM merged), 0) AS seconds_used,
      COALESCE((SELECT COUNT(DISTINCT user_id) FROM bounded), 0) AS active_users,
      COALESCE((SELECT COUNT(DISTINCT user_id) FROM bounded WHERE connected_at < ${end} AND effective_end >= ${end}), 0) AS current_users
  `);
  const resultRows = Array.isArray(rows) ? rows : (rows as unknown as { rows?: unknown[] }).rows ?? [];
  const row = resultRows[0] as { seconds_used?: string | number; active_users?: string | number; current_users?: string | number } | undefined;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    hoursUsed: Number(row?.seconds_used ?? 0) / 3600,
    activeUsers: Number(row?.active_users ?? 0),
    currentUsers: Number(row?.current_users ?? 0),
  };
}

async function rollupCompletedHours(now = new Date()): Promise<void> {
  await ensureHoursUsedSchema();
  const hourEnd = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const hourStart = new Date(hourEnd.getTime() - HOUR_MS);
  await metricsDb.execute(sql`
    INSERT INTO hours_used_rollups (account_id, period_kind, period_start, period_end, seconds_used)
    SELECT account_id, 'hour', ${hourStart}, ${hourEnd},
      COALESCE(SUM(EXTRACT(EPOCH FROM (upper(merged) - lower(merged)))), 0)
    FROM (
      SELECT account_id, user_id, unnest(range_agg(span)) AS merged
      FROM (
        SELECT account_id, user_id,
          tstzrange(
            GREATEST(connected_at, ${hourStart}),
            LEAST(COALESCE(disconnected_at, last_seen_at + (${USAGE_LEASE_TAIL_MS} * interval '1 millisecond')), ${hourEnd}),
            '[)'
          ) AS span
        FROM hours_used_intervals
        WHERE connected_at < ${hourEnd}
          AND COALESCE(disconnected_at, last_seen_at + (${USAGE_LEASE_TAIL_MS} * interval '1 millisecond')) > ${hourStart}
      ) bounded
      WHERE NOT isempty(span)
      GROUP BY account_id, user_id
    ) unions
    GROUP BY account_id
    ON CONFLICT (account_id, period_kind, period_start)
    DO UPDATE SET seconds_used = EXCLUDED.seconds_used, period_end = EXCLUDED.period_end, computed_at = CURRENT_TIMESTAMP
  `);

  const dayEnd = new Date(Date.UTC(hourEnd.getUTCFullYear(), hourEnd.getUTCMonth(), hourEnd.getUTCDate()));
  const dayStart = new Date(dayEnd.getTime() - 24 * HOUR_MS);
  await metricsDb.execute(sql`
    INSERT INTO hours_used_rollups (account_id, period_kind, period_start, period_end, seconds_used)
    SELECT account_id, 'day', ${dayStart}, ${dayEnd}, SUM(seconds_used)
    FROM hours_used_rollups
    WHERE period_kind = 'hour' AND period_start >= ${dayStart} AND period_start < ${dayEnd}
    GROUP BY account_id
    ON CONFLICT (account_id, period_kind, period_start)
    DO UPDATE SET seconds_used = EXCLUDED.seconds_used, period_end = EXCLUDED.period_end, computed_at = CURRENT_TIMESTAMP
  `);

  const dailyRows = await metricsDb.execute(sql`
    SELECT ${dayStart}::timestamptz AS period_start, ${dayEnd}::timestamptz AS period_end,
      COALESCE(sum(seconds_used), 0) AS seconds_used
    FROM hours_used_rollups
    WHERE period_kind = 'day' AND period_start = ${dayStart}
  `);
  const days = (Array.isArray(dailyRows) ? dailyRows : (dailyRows as unknown as { rows?: unknown[] }).rows ?? []) as Array<{
    period_start: Date; period_end: Date; seconds_used: number;
  }>;
  const metric = (await ensurePlatformBusinessMetrics(USAGE_METRIC_DEFINITIONS)).get("hours-used");
  if (metric) await metricsDb.execute(sql`
    DELETE FROM metric_samples
    WHERE source_ref = 'internal/hours-used-v1' AND metric_id <> ${metric.id}
  `);
  const day = days[0];
  if (metric && day) await upsertInternalPeriodSample({
    id: `msamp_hours_used_${metric.businessId}_${dayStart.toISOString().slice(0, 10)}`,
    metricId: metric.id,
    accountId: metric.accountId,
    ownerUserId: metric.ownerUserId,
    vaultId: metric.vaultId,
    value: Number(day.seconds_used) / 3600,
    unit: "hours",
    observedAt: day.period_end,
    sourceRef: "internal/hours-used-v2",
    evidence: "Platform sum of authenticated connected time, unioned per user across tabs and devices.",
    periodStart: day.period_start,
    periodEnd: day.period_end,
  });

  const currentDayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const provisionalRows = await metricsDb.execute(sql`
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (upper(merged) - lower(merged)))), 0) AS seconds_used
    FROM (
      SELECT account_id, user_id, unnest(range_agg(span)) AS merged
      FROM (
        SELECT account_id, user_id,
          tstzrange(
            GREATEST(connected_at, ${currentDayStart}),
            LEAST(COALESCE(disconnected_at, last_seen_at + (${USAGE_LEASE_TAIL_MS} * interval '1 millisecond')), ${now}),
            '[)'
          ) AS span
        FROM hours_used_intervals
        WHERE connected_at < ${now}
          AND COALESCE(disconnected_at, last_seen_at + (${USAGE_LEASE_TAIL_MS} * interval '1 millisecond')) > ${currentDayStart}
      ) bounded
      WHERE NOT isempty(span)
      GROUP BY account_id, user_id
    ) unions
  `);
  const provisional = (Array.isArray(provisionalRows)
    ? provisionalRows
    : (provisionalRows as unknown as { rows?: unknown[] }).rows ?? []) as Array<{ seconds_used: number }>;
  const currentMetric = (await ensurePlatformBusinessMetrics(USAGE_METRIC_DEFINITIONS)).get("hours-used");
  if (currentMetric) await upsertInternalPeriodSample({
    id: `msamp_hours_used_${currentMetric.businessId}_${currentDayStart.toISOString().slice(0, 10)}`,
    metricId: currentMetric.id,
    accountId: currentMetric.accountId,
    ownerUserId: currentMetric.ownerUserId,
    vaultId: currentMetric.vaultId,
    value: Number(provisional[0]?.seconds_used ?? 0) / 3600,
    unit: "hours",
    observedAt: now,
    sourceRef: "internal/hours-used-v2",
    evidence: "Provisional platform total for the current UTC day; authenticated connected time unioned per user.",
    periodStart: currentDayStart,
    periodEnd: now,
  });

  await metricsDb.execute(sql`
    DELETE FROM hours_used_intervals
    WHERE COALESCE(disconnected_at, last_seen_at + (${USAGE_LEASE_TAIL_MS} * interval '1 millisecond'))
      < CURRENT_TIMESTAMP - (${RAW_RETENTION_DAYS} * interval '1 day')
  `);
  await metricsDb.execute(sql`
    DELETE FROM hours_used_rollups
    WHERE period_start < CURRENT_TIMESTAMP - (${ROLLUP_RETENTION_DAYS} * interval '1 day')
  `);
}

export async function startHoursUsedRollups(): Promise<void> {
  if (rollupTimer) return;
  await rollupCompletedHours();
  rollupTimer = setInterval(() => {
    void rollupCompletedHours().catch((error) => {
      log.warn("rollup degraded", {
        code: "HOURS_USED_ROLLUP_FAILED",
        errorType: error instanceof Error ? error.name : typeof error,
      });
    });
  }, ROLLUP_INTERVAL_MS);
  rollupTimer.unref();
}

export function stopHoursUsedRollups(): void {
  if (!rollupTimer) return;
  clearInterval(rollupTimer);
  rollupTimer = null;
}
