import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { metrics } from "@shared/schema";
import { db } from "./db";
import { createLogger } from "./log";
import { ensureMetricsSamplesSchema, metricsDb } from "./metrics-db";
import { enqueueTelemetryWrite } from "./telemetry-write";

const log = createLogger("HoursUsed");
const LEASE_TAIL_MS = 45_000;
const RAW_RETENTION_DAYS = 14;
const ROLLUP_RETENTION_DAYS = 400;
const HOUR_MS = 60 * 60 * 1000;
const ROLLUP_INTERVAL_MS = 15 * 60 * 1000;
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

async function ensureHoursUsedMetric(accountId: string): Promise<{ id: string; vaultId: string | null } | null> {
  const accountRows = await db.execute(sql`
    SELECT a.owner_user_id, u.active_vault_id
    FROM accounts a
    JOIN users u ON u.id = a.owner_user_id
    WHERE a.id = ${accountId} AND a.kind = 'personal'
    LIMIT 1
  `);
  const rows = Array.isArray(accountRows) ? accountRows : (accountRows as unknown as { rows?: unknown[] }).rows ?? [];
  const owner = rows[0] as { owner_user_id?: string; active_vault_id?: string | null } | undefined;
  if (!owner?.owner_user_id) return null;
  const id = `metric_hours_used_${accountId}`;
  await db.execute(sql`
    INSERT INTO metrics (
      id, name, slug, description, unit, direction, sample_period, adapter_kind,
      adapter_config, status, scope, owner_user_id, account_id, vault_id, created_by_user_id
    )
    SELECT
      ${id}, 'Hours Used', 'hours-used',
      'Total hours authenticated users are connected to Mantra, unioned per user across tabs and devices.',
      'hours', 'higher_is_better', 'daily', 'internal', ${JSON.stringify({ key: "hours-used" })}::jsonb,
      'active', 'user', ${owner.owner_user_id}, ${accountId}, ${owner.active_vault_id ?? null}, ${owner.owner_user_id}
    WHERE NOT EXISTS (
      SELECT 1 FROM metrics WHERE account_id = ${accountId} AND slug = 'hours-used'
    )
    ON CONFLICT DO NOTHING
  `);
  const [metric] = await db.select({ id: metrics.id, vaultId: metrics.vaultId }).from(metrics)
    .where(sql`${metrics.accountId} = ${accountId} AND ${metrics.slug} = 'hours-used'`)
    .limit(1);
  return metric ?? null;
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
            LEAST(COALESCE(disconnected_at, last_seen_at + (${LEASE_TAIL_MS} * interval '1 millisecond')), ${hourEnd}),
            '[)'
          ) AS span
        FROM hours_used_intervals
        WHERE connected_at < ${hourEnd}
          AND COALESCE(disconnected_at, last_seen_at + (${LEASE_TAIL_MS} * interval '1 millisecond')) > ${hourStart}
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
    SELECT account_id, period_start, period_end, seconds_used
    FROM hours_used_rollups
    WHERE period_kind = 'day' AND period_start = ${dayStart}
    LIMIT 1000
  `);
  const days = (Array.isArray(dailyRows) ? dailyRows : (dailyRows as unknown as { rows?: unknown[] }).rows ?? []) as Array<{
    account_id: string; period_start: Date; period_end: Date; seconds_used: number;
  }>;
  for (const day of days) {
    const metric = await ensureHoursUsedMetric(day.account_id);
    if (!metric) continue;
    const sampleId = `msamp_hours_used_${day.account_id}_${dayStart.toISOString().slice(0, 10)}`;
    await metricsDb.execute(sql`
      INSERT INTO metric_samples (
        id, metric_id, account_id, vault_id, value, unit, observed_at,
        source_ref, evidence, period_start, period_end
      ) VALUES (
        ${sampleId}, ${metric.id}, ${day.account_id}, ${metric.vaultId}, ${Number(day.seconds_used) / 3600},
        'hours', ${day.period_end}, 'internal/hours-used-v1',
        'Union of canonical authenticated client-presence intervals per user.', ${day.period_start}, ${day.period_end}
      )
      ON CONFLICT (id) DO UPDATE SET
        value = EXCLUDED.value, observed_at = EXCLUDED.observed_at,
        period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end
    `);
  }

  await metricsDb.execute(sql`
    DELETE FROM hours_used_intervals
    WHERE COALESCE(disconnected_at, last_seen_at + (${LEASE_TAIL_MS} * interval '1 millisecond'))
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
