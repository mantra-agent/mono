import { pool } from "../../db";
import { createLogger } from "../../log";
import { fetchDeploymentsForEnvironment, type RailwayDeployment, type RailwayRequestClass } from "./client";
import type { RailwayEnvironmentControl } from "./environment-control";

const log = createLogger("RailwayDeploymentState");
const ACTIVE_REFRESH_MS = 15_000;
const STABLE_REFRESH_MS = 5 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;
const REQUEST_WINDOW_MS = 60 * 60_000;
const OBSERVATION_REQUEST_BUDGET = 800;
const RATE_LIMIT_RESERVE = 200;
const ACTIVE_STATUSES = new Set(["BUILDING", "DEPLOYING", "WAITING", "QUEUED", "INITIALIZING"]);

export interface RailwayDeploymentSnapshot {
  deployments: RailwayDeployment[];
  observedAt: string | null;
  stale: boolean;
  refreshing: boolean;
  nextRefreshAt: string | null;
}

interface StoredSnapshot {
  snapshot: RailwayDeployment[] | null;
  observed_at: Date | null;
  next_refresh_at: Date | null;
  cooldown_until: Date | null;
}

interface StoredGovernor {
  request_window_started_at: Date;
  observation_request_count: number;
  cooldown_until: Date | null;
}

export async function ensureRailwayDeploymentStateSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS railway_provider_deployment_state (
      platform_environment_id INTEGER PRIMARY KEY REFERENCES platform_product_environments(id) ON DELETE CASCADE,
      provider_connection_id INTEGER NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      provider_environment_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      snapshot JSONB,
      observed_at TIMESTAMPTZ,
      next_refresh_at TIMESTAMPTZ,
      cooldown_until TIMESTAMPTZ,
      request_window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      request_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT railway_provider_deployment_state_request_count CHECK (request_count >= 0),
      CONSTRAINT railway_provider_deployment_state_snapshot CHECK (snapshot IS NULL OR jsonb_typeof(snapshot) = 'array')
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS railway_provider_quota_governors (
      provider_connection_id INTEGER PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
      request_window_started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      observation_request_count INTEGER NOT NULL DEFAULT 0,
      cooldown_until TIMESTAMPTZ,
      last_error_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT railway_provider_quota_governors_count CHECK (observation_request_count >= 0)
    )
  `);
}

export async function getSharedRailwayDeploymentSnapshot(
  control: RailwayEnvironmentControl,
  limit = 20,
  options: { refresh?: "observer" | "release" } = {},
): Promise<RailwayDeploymentSnapshot> {
  const client = await pool.connect();
  const environmentKey = `railway-deployments:${control.environment.connectionId}:${control.environment.platformEnvironmentId}`;
  const connectionKey = `railway-quota:${control.environment.connectionId}`;
  let environmentLocked = false;
  let connectionLocked = false;
  try {
    const environmentLock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [environmentKey]);
    environmentLocked = environmentLock.rows[0]?.locked === true;
    const current = await readState(client, control.environment.platformEnvironmentId);
    const now = new Date();
    const due = !current?.snapshot || !current.next_refresh_at || current.next_refresh_at <= now;
    const shouldRefresh = options.refresh === "release" || (options.refresh === "observer" && due);
    if (!shouldRefresh || !environmentLocked) return projectSnapshot(current, now, shouldRefresh && !environmentLocked);

    const connectionLock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [connectionKey]);
    connectionLocked = connectionLock.rows[0]?.locked === true;
    if (!connectionLocked) return projectSnapshot(current, now, true);

    const governor = await readGovernor(client, control.environment.connectionId);
    const budget = normalizeBudget(governor, now);
    if (governor?.cooldown_until && governor.cooldown_until > now) return projectSnapshot(current, now, false);
    if (options.refresh !== "release" && budget.count >= OBSERVATION_REQUEST_BUDGET) return projectSnapshot(current, now, false);

    await reserveRequest(client, control.environment.connectionId, budget.startedAt, budget.count + (options.refresh === "release" ? 0 : 1));
    try {
      const requestClass: RailwayRequestClass = options.refresh === "release" ? "release" : "observation";
      const deployments = await fetchDeploymentsForEnvironment(
        control.projectId,
        control.serviceId,
        control.railwayEnvironmentId,
        limit,
        control.token,
        { requestClass },
      );
      const active = deployments.some(item => ACTIVE_STATUSES.has(item.status.toUpperCase()));
      const nextRefreshAt = new Date(now.getTime() + (active ? ACTIVE_REFRESH_MS : STABLE_REFRESH_MS));
      await client.query(`
        INSERT INTO railway_provider_deployment_state (
          platform_environment_id, provider_connection_id, project_id, provider_environment_id, service_id,
          snapshot, observed_at, next_refresh_at, cooldown_until, last_error_code, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,NULL,NULL,CURRENT_TIMESTAMP)
        ON CONFLICT (platform_environment_id) DO UPDATE SET
          provider_connection_id=EXCLUDED.provider_connection_id, project_id=EXCLUDED.project_id,
          provider_environment_id=EXCLUDED.provider_environment_id, service_id=EXCLUDED.service_id,
          snapshot=EXCLUDED.snapshot, observed_at=EXCLUDED.observed_at, next_refresh_at=EXCLUDED.next_refresh_at,
          cooldown_until=NULL, last_error_code=NULL, updated_at=CURRENT_TIMESTAMP
      `, [control.environment.platformEnvironmentId, control.environment.connectionId, control.projectId,
        control.railwayEnvironmentId, control.serviceId, JSON.stringify(deployments), now, nextRefreshAt]);
      return { deployments, observedAt: now.toISOString(), stale: false, refreshing: false, nextRefreshAt: nextRefreshAt.toISOString() };
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 0;
      const retrySeconds = typeof error === "object" && error && "retryAfterSeconds" in error
        ? Number((error as { retryAfterSeconds: unknown }).retryAfterSeconds) : 0;
      const cooldownUntil = status === 429
        ? new Date(now.getTime() + Math.max(1_000, Number.isFinite(retrySeconds) ? retrySeconds * 1_000 : 5 * 60_000))
        : governor?.cooldown_until ?? null;
      await client.query(`UPDATE railway_provider_quota_governors SET cooldown_until=$2, last_error_code=$3, updated_at=CURRENT_TIMESTAMP WHERE provider_connection_id=$1`,
        [control.environment.connectionId, cooldownUntil, status ? `HTTP_${status}` : "PROVIDER_FAILED"]);
      await client.query(`
        INSERT INTO railway_provider_deployment_state (platform_environment_id, provider_connection_id, project_id, provider_environment_id, service_id, last_error_code)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (platform_environment_id) DO UPDATE SET last_error_code=EXCLUDED.last_error_code, updated_at=CURRENT_TIMESTAMP
      `, [control.environment.platformEnvironmentId, control.environment.connectionId, control.projectId,
        control.railwayEnvironmentId, control.serviceId, status ? `HTTP_${status}` : "PROVIDER_FAILED"]);
      if (current?.snapshot) {
        log.warn("Serving stale Railway deployment snapshot after refresh failure", {
          platformEnvironmentId: control.environment.platformEnvironmentId,
          providerConnectionId: control.environment.connectionId,
          status,
          observedAt: current.observed_at?.toISOString() ?? null,
        });
        return projectSnapshot(current, now, false);
      }
      throw error;
    }
  } finally {
    if (connectionLocked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [connectionKey]).catch(() => undefined);
    if (environmentLocked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [environmentKey]).catch(() => undefined);
    client.release();
  }
}

function normalizeBudget(state: StoredGovernor | null, now: Date): { startedAt: Date; count: number } {
  if (!state || now.getTime() - state.request_window_started_at.getTime() >= REQUEST_WINDOW_MS) return { startedAt: now, count: 0 };
  return { startedAt: state.request_window_started_at, count: state.observation_request_count };
}

async function reserveRequest(client: { query: Function }, connectionId: number, startedAt: Date, count: number): Promise<void> {
  await client.query(`
    INSERT INTO railway_provider_quota_governors (provider_connection_id, request_window_started_at, observation_request_count, updated_at)
    VALUES ($1,$2,$3,CURRENT_TIMESTAMP)
    ON CONFLICT (provider_connection_id) DO UPDATE SET request_window_started_at=EXCLUDED.request_window_started_at,
      observation_request_count=EXCLUDED.observation_request_count, updated_at=CURRENT_TIMESTAMP
  `, [connectionId, startedAt, Math.min(count, OBSERVATION_REQUEST_BUDGET + RATE_LIMIT_RESERVE)]);
}

async function readGovernor(client: { query: Function }, connectionId: number): Promise<StoredGovernor | null> {
  const result = await client.query("SELECT request_window_started_at, observation_request_count, cooldown_until FROM railway_provider_quota_governors WHERE provider_connection_id=$1", [connectionId]);
  return (result.rows[0] as StoredGovernor | undefined) ?? null;
}

async function readState(client: { query: Function }, environmentId: number): Promise<StoredSnapshot | null> {
  const result = await client.query("SELECT snapshot, observed_at, next_refresh_at, cooldown_until FROM railway_provider_deployment_state WHERE platform_environment_id=$1", [environmentId]);
  return (result.rows[0] as StoredSnapshot | undefined) ?? null;
}

function projectSnapshot(state: StoredSnapshot | null, now: Date, refreshing: boolean): RailwayDeploymentSnapshot {
  const observedAt = state?.observed_at?.toISOString() ?? null;
  const stale = !state?.observed_at || now.getTime() - state.observed_at.getTime() > MAX_STALE_MS || (!!state.next_refresh_at && state.next_refresh_at <= now);
  return { deployments: state?.snapshot ?? [], observedAt, stale, refreshing, nextRefreshAt: state?.next_refresh_at?.toISOString() ?? null };
}
