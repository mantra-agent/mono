/**
 * Separate connection pool for high-volume metric samples.
 * Uses METRICS_DATABASE_URL when set; falls back to primary DATABASE_URL in dev
 * so local/single-db environments still work without a second Postgres.
 */
import { createManagedDatabasePool } from "./database-adapters";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@shared/schema";
import {
  DB_IDLE_TIMEOUT_MS,
  GENERAL_DB_POOL_MAX,
  GENERAL_DB_POOL_MIN,
} from "./timeout";
import { createLogger } from "./log";

const log = createLogger("MetricsDb");

const METRICS_DB_POOL_MAX = Number(process.env.METRICS_DB_POOL_MAX || Math.min(GENERAL_DB_POOL_MAX, 8));
const METRICS_DB_POOL_MIN = Number(process.env.METRICS_DB_POOL_MIN || 0);
const METRICS_DB_STATEMENT_TIMEOUT_MS = Number(process.env.METRICS_DB_STATEMENT_TIMEOUT_MS || 30_000);
const METRICS_DB_ACQUIRE_TIMEOUT_MS = Number(process.env.METRICS_DB_ACQUIRE_TIMEOUT_MS || 5_000);

const metricsConnectionString =
  process.env.METRICS_DATABASE_URL || process.env.DATABASE_URL;

if (!metricsConnectionString) {
  throw new Error("DATABASE_URL must be set (METRICS_DATABASE_URL optional override).");
}

const usingDedicatedMetricsDb = Boolean(process.env.METRICS_DATABASE_URL);

const metricsPoolAdapter = createManagedDatabasePool("metrics", {
  connectionString: metricsConnectionString,
  max: METRICS_DB_POOL_MAX,
  min: METRICS_DB_POOL_MIN,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  statement_timeout: METRICS_DB_STATEMENT_TIMEOUT_MS,
  connectionTimeoutMillis: METRICS_DB_ACQUIRE_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: usingDedicatedMetricsDb ? "mantra-metrics" : "mantra-metrics-fallback",
} as any);
export const metricsPool = metricsPoolAdapter.pool;

export const metricsDb = drizzle(metricsPool, { schema });

export function isDedicatedMetricsDatabase(): boolean {
  return usingDedicatedMetricsDb;
}

let samplesSchemaReady: Promise<void> | null = null;

/** Idempotent DDL for high-volume samples table on the metrics pool. */
export async function ensureMetricsSamplesSchema(): Promise<void> {
  if (!samplesSchemaReady) {
    samplesSchemaReady = (async () => {
      await metricsDb.execute(sql`
        CREATE TABLE IF NOT EXISTS metric_samples (
          id text PRIMARY KEY,
          metric_id text NOT NULL,
          account_id text NOT NULL,
          vault_id text,
          value double precision NOT NULL,
          unit text NOT NULL DEFAULT '',
          observed_at timestamptz NOT NULL,
          source_ref text NOT NULL DEFAULT 'manual',
          evidence text,
          period_start timestamptz,
          period_end timestamptz,
          created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await metricsDb.execute(
        sql`CREATE INDEX IF NOT EXISTS metric_samples_metric_observed_idx ON metric_samples(metric_id, observed_at DESC)`,
      );
      await metricsDb.execute(
        sql`CREATE INDEX IF NOT EXISTS metric_samples_account_metric_idx ON metric_samples(account_id, metric_id)`,
      );
      log.info("metric_samples schema ready", {
        dedicated: usingDedicatedMetricsDb,
      });
    })().catch((err) => {
      samplesSchemaReady = null;
      throw err;
    });
  }
  await samplesSchemaReady;
}

export function getMetricsPoolStats(): {
  dedicated: boolean;
  total: number;
  idle: number;
  waiting: number;
} {
  return {
    dedicated: usingDedicatedMetricsDb,
    total: metricsPool.totalCount,
    idle: metricsPool.idleCount,
    waiting: metricsPool.waitingCount,
  };
}
