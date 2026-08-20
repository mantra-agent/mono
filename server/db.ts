// Use createLogger for logging ONLY
import { type Pool, types as pgTypes } from "pg";
import { createHash } from "crypto";

// Treat `timestamp without time zone` (OID 1114) as UTC.
// PostgreSQL stores UTC values but node-postgres interprets them as local time,
// causing a +5h shift in America/Chicago. Appending 'Z' forces correct UTC parsing.
pgTypes.setTypeParser(1114, (str: string) => new Date(str + 'Z'));
import { AsyncLocalStorage } from "async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "@shared/schema";
import {
  DB_POOL_MAX,
  DB_IDLE_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
  GENERAL_DB_POOL_MAX,
  GENERAL_DB_POOL_MIN,
  VOICE_DB_ACQUIRE_TIMEOUT_MS,
  VOICE_DB_POOL_MAX,
  VOICE_DB_POOL_MIN,
  VOICE_DB_STATEMENT_TIMEOUT_MS,
} from "./timeout";
import { createLogger } from "./log";
import { safeStringify, safeTruncate } from "./utils/safe-stringify";
import {
  getPostgresErrorCode,
  isPoolAcquireTimeoutError,
  isRecoverablePostgresConnectionError,
  resolveQueryContractTelemetryCode,
} from "./postgres-errors";

const log = createLogger("DB");

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

const DB_CONNECTION_TIMEOUT_MS = 5000;
/** One immediate retry after a pool-acquire timeout; never retries SQL that already started. */
const POOL_ACQUIRE_RETRY_LIMIT = 1;
const SLOW_QUERY_THRESHOLD_MS = 1000;
const HIGH_IN_FLIGHT_THRESHOLD = 10;
const LONG_RUNNING_THRESHOLD_MS = 500;
const LONG_RUNNING_MAX_ROWS = 20;
const SLOW_QUERY_SQL_SNIPPET_CHARS = 220;

const SLOW_QUERY_WINDOW_MS = 10 * 60 * 1000;
const _slowQueryTimestamps: number[] = [];
let _lastSlowQueryAt: number | null = null;
let _lastSlowQueryDurationMs: number | null = null;
let _lastSlowQueryFingerprint: string | null = null;
let _lastSlowQuerySqlSnippet: string | null = null;

/** Extract SQL text from node-pg Pool.query argument shapes without touching bind values. */
function extractQueryText(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string") {
    return (first as { text: string }).text;
  }
  return null;
}

/**
 * Normalize SQL for grouping: drop comments/literals/params and collapse whitespace.
 * Bind values are never included because node-pg keeps them separate from `text`.
 */
function normalizeSqlForFingerprint(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fingerprintSql(sqlText: string): string {
  const normalized = normalizeSqlForFingerprint(sqlText);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function sqlSnippetFromText(sqlText: string): string {
  const compact = sqlText.replace(/\s+/g, " ").trim();
  return safeTruncate(compact, SLOW_QUERY_SQL_SNIPPET_CHARS, "db.slowQuery.sql", false);
}

function describeQuerySql(args: unknown[]): {
  queryFingerprint: string | null;
  sqlSnippet: string | null;
} {
  const text = extractQueryText(args);
  if (!text) return { queryFingerprint: null, sqlSnippet: null };
  return {
    queryFingerprint: fingerprintSql(text),
    sqlSnippet: sqlSnippetFromText(text),
  };
}

function recordSlowQuery(
  durationMs: number,
  meta?: { queryFingerprint?: string | null; sqlSnippet?: string | null },
): void {
  const now = Date.now();
  _lastSlowQueryAt = now;
  _lastSlowQueryDurationMs = durationMs;
  _lastSlowQueryFingerprint = meta?.queryFingerprint ?? null;
  _lastSlowQuerySqlSnippet = meta?.sqlSnippet ?? null;
  _slowQueryTimestamps.push(now);
  const cutoff = now - SLOW_QUERY_WINDOW_MS;
  while (_slowQueryTimestamps.length > 0 && _slowQueryTimestamps[0] < cutoff) {
    _slowQueryTimestamps.shift();
  }
}

export function getSlowQueryStats(): {
  lastMinute: number;
  lastTenMinutes: number;
  lastSlowAt: number | null;
  lastSlowDurationMs: number | null;
  thresholdMs: number;
  lastQueryFingerprint: string | null;
  lastSqlSnippet: string | null;
} {
  const now = Date.now();
  const cutoff = now - SLOW_QUERY_WINDOW_MS;
  while (_slowQueryTimestamps.length > 0 && _slowQueryTimestamps[0] < cutoff) {
    _slowQueryTimestamps.shift();
  }
  const minuteCutoff = now - 60_000;
  let lastMinute = 0;
  for (let i = _slowQueryTimestamps.length - 1; i >= 0; i--) {
    if (_slowQueryTimestamps[i] >= minuteCutoff) lastMinute++;
    else break;
  }
  return {
    lastMinute,
    lastTenMinutes: _slowQueryTimestamps.length,
    lastSlowAt: _lastSlowQueryAt,
    lastSlowDurationMs: _lastSlowQueryDurationMs,
    thresholdMs: SLOW_QUERY_THRESHOLD_MS,
    lastQueryFingerprint: _lastSlowQueryFingerprint,
    lastSqlSnippet: _lastSlowQuerySqlSnippet,
  };
}

export function getInFlightHighThreshold(): number {
  return HIGH_IN_FLIGHT_THRESHOLD;
}

import { getAppNamePrefix } from "@shared/instance-config";
import {
  closeManagedDatabasePools,
  createDedicatedDatabaseClient,
  createManagedDatabasePool,
} from "./database-adapters";
export const APP_NAME_PREFIX = getAppNamePrefix();
export const BOOT_ID =
  process.env.WATCHDOG_BOOT_ID ||
  `${Date.now().toString(36)}-${process.pid}`;
export const APP_NAME = `${APP_NAME_PREFIX}-${BOOT_ID}`;

const generalPoolAdapter = createManagedDatabasePool("general", {
  connectionString: process.env.DATABASE_URL,
  max: GENERAL_DB_POOL_MAX,
  min: GENERAL_DB_POOL_MIN,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  statement_timeout: DB_STATEMENT_TIMEOUT_MS,
  connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: APP_NAME,
} as any);
export const pool = generalPoolAdapter.pool;

const voicePoolAdapter = createManagedDatabasePool("voice", {
  connectionString: process.env.DATABASE_URL,
  max: VOICE_DB_POOL_MAX,
  min: VOICE_DB_POOL_MIN,
  idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
  statement_timeout: VOICE_DB_STATEMENT_TIMEOUT_MS,
  connectionTimeoutMillis: VOICE_DB_ACQUIRE_TIMEOUT_MS,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: `${APP_NAME}-voice`,
} as any);
export const voicePool = voicePoolAdapter.pool;

type ConnectionIncidentLane = "general" | "voice";

type RecoverableConnectionIncident = {
  code: string;
  message: string;
  startedAt: number;
  count: number;
  lanes: Record<ConnectionIncidentLane, number>;
  timer: ReturnType<typeof setTimeout>;
};

let recoverableConnectionIncident: RecoverableConnectionIncident | null = null;

function flushRecoverableConnectionIncident(): void {
  const incident = recoverableConnectionIncident;
  recoverableConnectionIncident = null;
  if (!incident) return;
  log.warn(
    `transient connection incident code=${incident.code} affectedConnections=${incident.count} ` +
      `lanes=general:${incident.lanes.general},voice:${incident.lanes.voice} ` +
      `durationMs=${Date.now() - incident.startedAt} message=${incident.message} ` +
      `pool=general:${pool.totalCount}/${pool.idleCount}/${pool.waitingCount},voice:${voicePool.totalCount}/${voicePool.idleCount}/${voicePool.waitingCount}; pools will reconnect`,
  );
}

const POOL_ACQUIRE_NODE_CODE_RE = /^(ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET)$/;

/**
 * Stable telemetry codes for the DB boundary. Prefer these over provider /
 * Node codes (ETIMEDOUT, 08xxx) so errorIdentity stays product-owned.
 */
function resolveDbTelemetryCode(error: unknown, fallback: string): string {
  if (isPoolAcquireTimeoutError(error)) return "POOL_ACQUIRE_TIMEOUT";
  const existing = error instanceof Error
    ? (error as Error & { code?: unknown }).code
    : undefined;
  if (
    typeof existing === "string" &&
    /^[A-Z][A-Z0-9_]{1,48}$/.test(existing) &&
    !/^[0-9A-Z]{5}$/.test(existing) &&
    !POOL_ACQUIRE_NODE_CODE_RE.test(existing)
  ) {
    return existing;
  }
  return fallback;
}

/**
 * Build a telemetry-only Error with a stable machine code.
 * Never mutates the original provider/Postgres error — callers still need
 * SQLSTATE and other native fields on the thrown value.
 */
function classifyDbLogError(error: unknown, code: string): Error {
  const original =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" && error.trim() ? error : "database operation failed");
  const telemetryCode = resolveDbTelemetryCode(original, code);
  const existing = (original as Error & { code?: unknown }).code;
  if (
    typeof existing === "string" &&
    existing === telemetryCode &&
    /^[A-Z][A-Z0-9_]{1,48}$/.test(existing)
  ) {
    return original;
  }
  const classified = new Error(original.message);
  classified.name = original.name || "Error";
  classified.stack = original.stack;
  (classified as Error & { code?: string; cause?: unknown }).code = telemetryCode;
  (classified as Error & { cause?: unknown }).cause = original;
  return classified;
}

function poolCounts(targetPool: Pool): string {
  return `${targetPool.totalCount}/${targetPool.idleCount}/${targetPool.waitingCount}`;
}

function logQueryFailure(opts: {
  err: unknown;
  lane: DatabaseLane;
  subsystem: string;
  label: string | null;
  targetPool: Pool;
  sqlDiag: string;
  elapsedMs: number;
  phase: "sync" | "async";
  attempt: number;
}): void {
  const { err, lane, subsystem, label, targetPool, sqlDiag, elapsedMs, phase, attempt } = opts;
  const acquireTimeout = isPoolAcquireTimeoutError(err);
  const pgCode = getPostgresErrorCode(err);
  const errorType = err instanceof Error ? "Error" : typeof err;
  const counts = poolCounts(targetPool);
  const kind = acquireTimeout ? "pool acquire timeout" : "query contract failed";
  // Split ERRORS identity by SQLSTATE class so timeouts/FK/syntax do not share
  // one immortal QUERY_CONTRACT_FAILED fingerprint across unrelated producers.
  const code = acquireTimeout
    ? "POOL_ACQUIRE_TIMEOUT"
    : resolveQueryContractTelemetryCode(err);
  const message =
    `${kind} after ${elapsedMs}ms lane=${lane} subsystem=${subsystem} label=${label || "none"} ` +
    `pool=${counts}${sqlDiag} phase=${phase} attempt=${attempt} errorType=${errorType}` +
    `${pgCode && pgCode !== "unknown" ? ` sqlstate=${pgCode}` : ""}` +
    `${acquireTimeout ? " class=pool_acquire" : ""}`;
  log.error(message, classifyDbLogError(err, code));
}

function handlePoolConnectionError(lane: ConnectionIncidentLane, error: Error): void {
  if (!isRecoverablePostgresConnectionError(error)) {
    log.error(
      `unexpected ${lane} connection error`,
      classifyDbLogError(error, "UNEXPECTED_POOL_CONNECTION_ERROR"),
    );
    return;
  }

  const code = getPostgresErrorCode(error);
  const message = error.message;
  const existing = recoverableConnectionIncident;
  if (existing && existing.code === code && existing.message === message) {
    existing.count++;
    existing.lanes[lane]++;
    return;
  }
  if (existing) {
    clearTimeout(existing.timer);
    flushRecoverableConnectionIncident();
  }

  const timer = setTimeout(flushRecoverableConnectionIncident, 1_000);
  if (timer.unref) timer.unref();
  recoverableConnectionIncident = {
    code,
    message,
    startedAt: Date.now(),
    count: 1,
    lanes: { general: lane === "general" ? 1 : 0, voice: lane === "voice" ? 1 : 0 },
    timer,
  };
}

pool.on("error", (error) => handlePoolConnectionError("general", error));
voicePool.on("error", (error) => handlePoolConnectionError("voice", error));

let _healthInterval: ReturnType<typeof setInterval> | null = null;
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _saturationInterval: ReturnType<typeof setInterval> | null = null;

let _saturatedSinceMs: number | null = null;
let _lastSuccessfulProbeAt: number | null = null;
let _lastProbeDurationMs: number | null = null;

export function getDbSaturationInfo(): {
  saturatedSinceMs: number | null;
  saturatedForMs: number;
  lastSuccessfulProbeAt: number | null;
  lastProbeDurationMs: number | null;
  total: number;
  idle: number;
  waiting: number;
  general: { total: number; idle: number; waiting: number; max: number };
  voice: { total: number; idle: number; waiting: number; max: number };
} {
  return {
    saturatedSinceMs: _saturatedSinceMs,
    saturatedForMs: _saturatedSinceMs === null ? 0 : Date.now() - _saturatedSinceMs,
    lastSuccessfulProbeAt: _lastSuccessfulProbeAt,
    lastProbeDurationMs: _lastProbeDurationMs,
    total: pool.totalCount + voicePool.totalCount,
    idle: pool.idleCount + voicePool.idleCount,
    waiting: pool.waitingCount + voicePool.waitingCount,
    general: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: GENERAL_DB_POOL_MAX },
    voice: { total: voicePool.totalCount, idle: voicePool.idleCount, waiting: voicePool.waitingCount, max: VOICE_DB_POOL_MAX },
  };
}

export async function probeDb(timeoutMs = 2000): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const queryP = pool.query("SELECT 1");
    const timeoutP = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe timeout ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([queryP, timeoutP]);
    const durationMs = Date.now() - start;
    _lastSuccessfulProbeAt = Date.now();
    _lastProbeDurationMs = durationMs;
    return { ok: true, durationMs };
  } catch (err: any) {
    const durationMs = Date.now() - start;
    _lastProbeDurationMs = durationMs;
    return { ok: false, durationMs, error: err?.message || String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function startPoolSaturationMonitor(intervalMs = 1000): void {
  if (_saturationInterval) return;
  _saturationInterval = setInterval(updateQueryPressureIncident, intervalMs);
  if (_saturationInterval.unref) _saturationInterval.unref();
}

export function stopPoolSaturationMonitor(): void {
  if (_saturationInterval) {
    clearInterval(_saturationInterval);
    _saturationInterval = null;
  }
}

// Database connections are owned by PostgreSQL and the process that opened them.
// A new app process must never infer that another boot is dead from a different
// application_name and terminate its backends. Hosted verification commands can
// overlap the serving process, and PostgreSQL already reclaims connections when
// their real owner exits.

// The heartbeat is the canary: every tick stamps `_lastHeartbeatLogAt`. If
// this stops moving while real work is in flight, the pool-wedge watchdog
// (below) will dump pg_stat_activity and self-exit so the supervisor restarts
// us. Crucially, we do NOT fan-out N parallel `SELECT 1`s here — under
// contention that DDoSes the already-stressed pool with bookkeeping queries
// and hides the real waiting count behind synthetic load. We log once per
// interval and, at most, kick a single low-cost seed connect+release in
// flight. Real traffic refills the pool naturally.
let _lastHeartbeatLogAt: number = Date.now();
let _seedInFlight: boolean = false;

export function getLastHeartbeatLogAt(): number {
  return _lastHeartbeatLogAt;
}

export function startPoolHeartbeat(intervalMs = 30_000): void {
  if (_heartbeatInterval) return;
  _heartbeatInterval = setInterval(() => {
    _lastHeartbeatLogAt = Date.now();
    const total = pool.totalCount;
    const idle = pool.idleCount;
    const waiting = pool.waitingCount;
    const inFlight = inFlightQueries;
    const deficit = GENERAL_DB_POOL_MIN - total;
    if (deficit <= 0) return;

    log.log(
      `heartbeat: pool below min total=${total} idle=${idle} waiting=${waiting} in-flight=${inFlight} min=${GENERAL_DB_POOL_MIN} deficit=${deficit}`,
    );

    // At most one seed connection in flight at a time. We use connect+release
    // so the connection lands in the idle pool (instead of being reaped
    // immediately like a fire-and-forget `SELECT 1` would be). Bounded with a
    // short timeout so a wedged pool can't pile up zombie seeds.
    if (_seedInFlight) return;
    _seedInFlight = true;
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (_seedInFlight) {
        log.warn(`heartbeat seed timed out after ${Date.now() - start}ms (pool may be saturated)`);
        _seedInFlight = false;
      }
      timer = null;
    }, 5_000);
    pool.connect()
      .then((client) => {
        client.release();
        const ms = Date.now() - start;
        if (ms > 1_000) log.log(`heartbeat seed completed in ${ms}ms`);
      })
      .catch((err) => {
        log.warn(`heartbeat seed failed: ${err?.message || err}`);
      })
      .finally(() => {
        if (timer) {
          clearTimeout(timer);
          _seedInFlight = false;
        }
      });
  }, intervalMs);
  if (_heartbeatInterval.unref) _heartbeatInterval.unref();
}

export function stopPoolHeartbeat(): void {
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
}

// ─── Pool-wedge self-exit watchdog ─────────────────────────────────────────
// If the heartbeat stops moving for `silenceMs` while there is real work in
// flight (in-flight queries or clients waiting), assume the event loop is
// alive but the DB pool is wedged on a deadlock. Dump pg_stat_activity for
// our application_name (so a triager can see waiting/blocking PIDs and
// xact_age) and `process.exit(POOL_WEDGE_EXIT_CODE)`. The supervisor then
// restarts us cleanly. This is the safety net behind all the deadlock-prevention
// fixes — it should almost never fire.
export const POOL_WEDGE_EXIT_CODE = 79;

let _wedgeInterval: ReturnType<typeof setInterval> | null = null;
let _wedgeTriggered = false;

export async function dumpPgStatActivity(timeoutMs = 5_000): Promise<string> {
  // Use a dedicated short-lived client so we don't compete for the wedged
  // pool's connections.
  const dedicated = createDedicatedDatabaseClient("watchdog", {
    connectionString: process.env.DATABASE_URL,
    application_name: `${APP_NAME}-watchdog`,
    statement_timeout: timeoutMs,
    connectionTimeoutMillis: timeoutMs,
  } as any);
  try {
    await dedicated.connect();
    const res = await dedicated.query(
      `SELECT pid, state, wait_event_type, wait_event,
              EXTRACT(EPOCH FROM (NOW() - xact_start))::int AS xact_age_s,
              EXTRACT(EPOCH FROM (NOW() - query_start))::int AS query_age_s,
              pg_blocking_pids(pid) AS blocking_pids,
              LEFT(query, 300) AS query
         FROM pg_stat_activity
        WHERE application_name = $1
          AND pid <> pg_backend_pid()
        ORDER BY xact_start NULLS LAST`,
      [APP_NAME],
    );
    if (res.rows.length === 0) {
      return `pg_stat_activity dump: 0 rows for app=${APP_NAME}`;
    }
    const lines = res.rows.map((r: any) =>
      `  pid=${r.pid} state=${r.state} wait=${r.wait_event_type ?? "-"}/${r.wait_event ?? "-"} ` +
      `xact_age=${r.xact_age_s ?? "-"}s query_age=${r.query_age_s ?? "-"}s ` +
      `blocked_by=[${(r.blocking_pids || []).join(",")}] query=${r.query}`,
    );
    return `pg_stat_activity dump (${res.rows.length} rows for app=${APP_NAME}):\n${lines.join("\n")}`;
  } catch (err: any) {
    return `pg_stat_activity dump failed: ${err?.message || err}`;
  } finally {
    try { await dedicated.end(); } catch {}
  }
}

export function startPoolWedgeWatchdog(opts?: {
  silenceMs?: number;
  intervalMs?: number;
  exitCode?: number;
}): void {
  if (_wedgeInterval) return;
  const silenceMs = opts?.silenceMs ?? 90_000;
  const intervalMs = opts?.intervalMs ?? 15_000;
  const exitCode = opts?.exitCode ?? POOL_WEDGE_EXIT_CODE;
  _wedgeInterval = setInterval(() => {
    if (_wedgeTriggered) return;
    const sinceHeartbeat = Date.now() - _lastHeartbeatLogAt;
    if (sinceHeartbeat < silenceMs) return;

    const inFlight = inFlightQueries;
    const waiting = pool.waitingCount;
    const dbHasWork = inFlight > 0 || waiting > 0;

    // Generalized check across all subsystems (HTTP req, executor runs, chat
    // streams, tool dispatches, journal flushes, doc upserts, conv locks,
    // db pool). The pool-only gate misses wedges in any of those.
    let crossSubsystemHasWork = false;
    let wedgeSnap: any = null;
    try {
      // Lazy require to avoid an import cycle.
      const { collectInflightSnapshot } = require("./wedge-watchdog");
      wedgeSnap = collectInflightSnapshot();
      crossSubsystemHasWork = wedgeSnap.totalInFlight > 0;
    } catch {
      // If the wedge module isn't available, fall back to pool-only check.
    }

    const hasWork = dbHasWork || crossSubsystemHasWork;
    if (!hasWork) {
      // Process is just idle — don't kill it. Reset the heartbeat clock so
      // we don't fire as soon as a single request shows up.
      log.warn(
        `pool-wedge watchdog: heartbeat silent for ${Math.round(sinceHeartbeat / 1000)}s but no work in flight (in-flight=${inFlight}, waiting=${waiting}); not exiting`,
      );
      _lastHeartbeatLogAt = Date.now();
      return;
    }

    _wedgeTriggered = true;
    const offenderStr = wedgeSnap?.oldestSubsystem
      ? ` offender=${wedgeSnap.oldestSubsystem.name}/${wedgeSnap.oldestSubsystem.id} ageMs=${wedgeSnap.oldestSubsystem.ageMs}`
      : "";
    log.error(
      `[Watchdog] WEDGE — heartbeat silent for ${Math.round(sinceHeartbeat / 1000)}s with db.in-flight=${inFlight} db.waiting=${waiting} pool=total:${pool.totalCount}/idle:${pool.idleCount} crossSubsystem=${crossSubsystemHasWork ? wedgeSnap?.totalInFlight : 0}${offenderStr}. Dumping pg_stat_activity + inflight snapshot then exiting.`,
    );
    void (async () => {
      try {
        const dump = await Promise.race<string>([
          dumpPgStatActivity(5_000),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("pg_stat_activity dump: outer timeout"), 7_000),
          ),
        ]);
        // pg_stat_activity dump can be many MB on a saturated pool. Bound
        // it before the synchronous log write so the dump itself can never
        // become the wedge we are trying to escape from.
        log.error(safeTruncate(dump, 256 * 1024, "db.pgStatActivity"));
      } catch (err: any) {
        log.error(`pg_stat_activity dump errored: ${safeTruncate(String(err?.message || err), 4 * 1024, "db.pgStatActivity.error")}`);
      } finally {
        // Death-rattle dump + exit. If wedge-watchdog isn't loaded, fall back
        // to legacy pool-wedge exit code.
        try {
          const { dumpWedgeRattle, WEDGE_EXIT_CODE } = require("./wedge-watchdog");
          // If db pool is the only signal, use the generalized code anyway —
          // dumpWedgeRattle will name the actual offender (db pool entries).
          dumpWedgeRattle(
            `db pool/multi-subsystem wedge silenceMs=${sinceHeartbeat} dbInFlight=${inFlight} dbWaiting=${waiting}`,
            crossSubsystemHasWork && !dbHasWork ? WEDGE_EXIT_CODE : exitCode,
          );
        } catch {
          log.error(`[Watchdog] pool-wedge: exiting with code ${exitCode}`);
          setImmediate(() => process.exit(exitCode));
        }
      }
    })();
  }, intervalMs);
  if (_wedgeInterval.unref) _wedgeInterval.unref();
}

export function stopPoolWedgeWatchdog(): void {
  if (_wedgeInterval) {
    clearInterval(_wedgeInterval);
    _wedgeInterval = null;
  }
}

export function startPoolHealthCheck(intervalMs = 60_000): void {
  if (_healthInterval) return;
  _healthInterval = setInterval(() => {
    const breakdown = Object.entries(inFlightBySubsystem)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const subsystemInfo = breakdown ? ` in-flight=[${breakdown}]` : "";

    let elLag = 0;
    let elMaxRecent = 0;
    try {
      const pm = require("./performance-monitor");
      elLag = pm.getLatestEventLoopLag?.() ?? 0;
      const diag = pm.getPerformanceDiagnostics?.();
      elMaxRecent = diag?.eventLoopLag?.max ?? 0;
    } catch {}

    const sinceProbe = _lastSuccessfulProbeAt === null
      ? "never"
      : `${Math.round((Date.now() - _lastSuccessfulProbeAt) / 1000)}s`;
    const satFor = _saturatedSinceMs === null
      ? "0ms"
      : `${Date.now() - _saturatedSinceMs}ms`;
    const slowest = Object.entries(inFlightBySubsystem)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])[0];
    const slowestStr = slowest ? `${slowest[0]}(${slowest[1]})` : "none";

    log.log(
      `op-summary boot=${BOOT_ID} general=total:${pool.totalCount}/idle:${pool.idleCount}/waiting:${pool.waitingCount} voice=total:${voicePool.totalCount}/idle:${voicePool.idleCount}/waiting:${voicePool.waitingCount} saturated=${satFor} top-subsystem=${slowestStr} eventLoop=cur:${Math.round(elLag)}ms/max60s:${Math.round(elMaxRecent)}ms lastProbe=${sinceProbe} probeMs=${_lastProbeDurationMs ?? "-"}${subsystemInfo}`
    );
  }, intervalMs);
  if (_healthInterval.unref) _healthInterval.unref();
}

export function stopPoolHealthCheck(): void {
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
}

let inFlightQueries = 0;
const inFlightBySubsystem: Record<string, number> = {};

interface InFlightEntry {
  id: number;
  subsystem: string;
  label: string | null;
  startedAt: number;
  queryFingerprint: string | null;
  sqlSnippet: string | null;
}
const _inFlightEntries = new Map<number, InFlightEntry>();
let _inFlightSeq = 0;
const QUERY_PRESSURE_DEBOUNCE_MS = 2_000;
const QUERY_PRESSURE_SUMMARY_INTERVAL_MS = 10_000;

type QueryPressureSnapshot = {
  observedAt: number;
  peakSubmitted: number;
  peakWaiting: number;
  peakExecuting: number;
};

type QueryPressureIncident = QueryPressureSnapshot & {
  startedAt: number;
  lastSummaryAt: number;
};

let queryPressureCandidate: QueryPressureSnapshot | null = null;
let queryPressureIncident: QueryPressureIncident | null = null;

export type QuerySubsystem = "context-build" | "context-prewarm" | "chat-stream" | "ooda" | "tool-exec" | "memory" | "memory-write" | "log-sink" | "timer-scheduler" | "voice" | "autonomous" | "general";

function currentQueryPressure(): { submitted: number; waiting: number; executing: number } {
  const waiting = pool.waitingCount + voicePool.waitingCount;
  return {
    submitted: inFlightQueries,
    waiting,
    executing: Math.max(0, inFlightQueries - waiting),
  };
}

function activeSubsystemBreakdown(): string {
  return Object.entries(inFlightBySubsystem)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
}

function queryPressureDescription(pressure: ReturnType<typeof currentQueryPressure>): string {
  const breakdown = activeSubsystemBreakdown();
  return `submitted=${pressure.submitted} executing=${pressure.executing} waiting=${pressure.waiting}` +
    `${breakdown ? ` [${breakdown}]` : ""} ` +
    `general=${pool.totalCount}/${pool.idleCount}/${pool.waitingCount} ` +
    `voice=${voicePool.totalCount}/${voicePool.idleCount}/${voicePool.waitingCount}`;
}

function isLaneExhausted(targetPool: Pool, maxConnections: number): boolean {
  return targetPool.waitingCount > 0 && targetPool.idleCount === 0 && targetPool.totalCount >= maxConnections;
}

function isDatabaseLaneExhausted(): boolean {
  return isLaneExhausted(pool, GENERAL_DB_POOL_MAX) || isLaneExhausted(voicePool, VOICE_DB_POOL_MAX);
}

function updatePressurePeaks(snapshot: QueryPressureSnapshot, pressure: ReturnType<typeof currentQueryPressure>): void {
  snapshot.peakSubmitted = Math.max(snapshot.peakSubmitted, pressure.submitted);
  snapshot.peakWaiting = Math.max(snapshot.peakWaiting, pressure.waiting);
  snapshot.peakExecuting = Math.max(snapshot.peakExecuting, pressure.executing);
}

function updateQueryPressureIncident(): void {
  const now = Date.now();
  const pressure = currentQueryPressure();
  const exhausted = isDatabaseLaneExhausted();

  if (!exhausted) {
    queryPressureCandidate = null;
    if (!queryPressureIncident) {
      _saturatedSinceMs = null;
      return;
    }
    const incident = queryPressureIncident;
    queryPressureIncident = null;
    _saturatedSinceMs = null;
    log.info(
      `DB SATURATION RECOVERED durationMs=${now - incident.startedAt} ` +
      `peaks=submitted:${incident.peakSubmitted},executing:${incident.peakExecuting},waiting:${incident.peakWaiting} ` +
      queryPressureDescription(pressure),
    );
    return;
  }

  if (queryPressureIncident) {
    updatePressurePeaks(queryPressureIncident, pressure);
    if (now - queryPressureIncident.lastSummaryAt >= QUERY_PRESSURE_SUMMARY_INTERVAL_MS) {
      queryPressureIncident.lastSummaryAt = now;
      log.warn(
        `DB SATURATION SUMMARY durationMs=${now - queryPressureIncident.startedAt} ` +
        `peaks=submitted:${queryPressureIncident.peakSubmitted},executing:${queryPressureIncident.peakExecuting},waiting:${queryPressureIncident.peakWaiting} ` +
        queryPressureDescription(pressure),
      );
    }
    return;
  }

  if (!queryPressureCandidate) {
    queryPressureCandidate = {
      observedAt: now,
      peakSubmitted: pressure.submitted,
      peakWaiting: pressure.waiting,
      peakExecuting: pressure.executing,
    };
    return;
  }

  updatePressurePeaks(queryPressureCandidate, pressure);
  if (now - queryPressureCandidate.observedAt < QUERY_PRESSURE_DEBOUNCE_MS) return;

  queryPressureIncident = {
    ...queryPressureCandidate,
    startedAt: queryPressureCandidate.observedAt,
    lastSummaryAt: now,
  };
  queryPressureCandidate = null;
  _saturatedSinceMs = queryPressureIncident.startedAt;
  log.warn(
    `DB SATURATION START durationMs=${now - queryPressureIncident.startedAt} ` +
    `peaks=submitted:${queryPressureIncident.peakSubmitted},executing:${queryPressureIncident.peakExecuting},waiting:${queryPressureIncident.peakWaiting} ` +
    queryPressureDescription(pressure),
  );
}

export function getInFlightStats(): {
  total: number;
  submitted: number;
  waiting: number;
  executing: number;
  bySubsystem: Record<string, number>;
} {
  const pressure = currentQueryPressure();
  return { total: pressure.submitted, ...pressure, bySubsystem: { ...inFlightBySubsystem } };
}

export function getLongRunningQueries(thresholdMs = LONG_RUNNING_THRESHOLD_MS): {
  thresholdMs: number;
  rows: Array<{
    subsystem: string;
    label: string | null;
    ageMs: number;
    queryFingerprint: string | null;
    sqlSnippet: string | null;
  }>;
} {
  const now = Date.now();
  const rows: Array<{
    subsystem: string;
    label: string | null;
    ageMs: number;
    queryFingerprint: string | null;
    sqlSnippet: string | null;
  }> = [];
  for (const e of _inFlightEntries.values()) {
    const ageMs = now - e.startedAt;
    if (ageMs >= thresholdMs) {
      rows.push({
        subsystem: e.subsystem,
        label: e.label,
        ageMs,
        queryFingerprint: e.queryFingerprint,
        sqlSnippet: e.sqlSnippet,
      });
    }
  }
  rows.sort((a, b) => b.ageMs - a.ageMs);
  return { thresholdMs, rows: rows.slice(0, LONG_RUNNING_MAX_ROWS) };
}

export type DatabaseLane = "general" | "voice";
const databaseLaneALS = new AsyncLocalStorage<DatabaseLane>();
const querySubsystemALS = new AsyncLocalStorage<QuerySubsystem>();
const queryLabelALS = new AsyncLocalStorage<string>();
const admissionTierALS = new AsyncLocalStorage<string>();

export function withDatabaseLane<T>(lane: DatabaseLane, fn: () => T): T {
  return databaseLaneALS.run(lane, fn);
}

export function withAdmissionTier<T>(tier: string, fn: () => Promise<T>): Promise<T> {
  return admissionTierALS.run(tier, fn);
}

export function withQueryAttributionAsync<T>(subsystem: QuerySubsystem, fn: () => Promise<T>, label?: string): Promise<T> {
  if (label) {
    return querySubsystemALS.run(subsystem, () => queryLabelALS.run(label, fn));
  }
  return querySubsystemALS.run(subsystem, fn);
}

function instrumentPool(targetPool: Pool, lane: DatabaseLane): void {
  const origQuery = targetPool.query.bind(targetPool);
  (targetPool as any).query = function (...args: any[]) {
    const subsystem = lane === "voice" ? "voice" : (querySubsystemALS.getStore() || "general");
    const label = queryLabelALS.getStore() || null;

    if (subsystem === "context-prewarm" || lane === "voice") {
      const tag = lane === "voice"
        ? (label ? `/* lane:voice:${label} */` : `/* lane:voice */`)
        : (label ? `/* context:prewarm:${label} */` : `/* context:prewarm */`);
      if (typeof args[0] === "string") args[0] = `${tag} ${args[0]}`;
      else if (args[0] && typeof args[0].text === "string") args[0] = { ...args[0], text: `${tag} ${args[0].text}` };
    }

    const { queryFingerprint, sqlSnippet } = describeQuerySql(args);
    const sqlDiag =
      (queryFingerprint ? ` fingerprint=${queryFingerprint}` : "") +
      (sqlSnippet ? ` sql=${JSON.stringify(sqlSnippet)}` : "");

    inFlightQueries++;
    inFlightBySubsystem[subsystem] = (inFlightBySubsystem[subsystem] || 0) + 1;
    const entryId = ++_inFlightSeq;
    _inFlightEntries.set(entryId, {
      id: entryId,
      subsystem,
      label: label ? `${lane}:${label}` : lane,
      startedAt: Date.now(),
      queryFingerprint,
      sqlSnippet,
    });
    const start = Date.now();
    let attempt = 1;

    const releaseInFlight = () => {
      inFlightQueries--;
      inFlightBySubsystem[subsystem] = Math.max(0, (inFlightBySubsystem[subsystem] || 0) - 1);
      _inFlightEntries.delete(entryId);
    };

    const settleSuccess = () => {
      releaseInFlight();
      const elapsed = Date.now() - start;
      if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
        recordSlowQuery(elapsed, { queryFingerprint, sqlSnippet });
        log.warn(
          `SLOW query after ${elapsed}ms lane=${lane} subsystem=${subsystem} label=${label || "none"} ` +
            `pool=${poolCounts(targetPool)}${sqlDiag}`,
        );
      }
    };

    const settleFailure = (err: unknown) => {
      releaseInFlight();
      const elapsed = Date.now() - start;
      if (elapsed > SLOW_QUERY_THRESHOLD_MS) {
        recordSlowQuery(elapsed, { queryFingerprint, sqlSnippet });
      }
      logQueryFailure({
        err,
        lane,
        subsystem,
        label,
        targetPool,
        sqlDiag,
        elapsedMs: elapsed,
        phase: "async",
        attempt,
      });
    };

    const dispatch = (): any => {
      let result: any;
      try {
        result = (origQuery as any)(...args);
      } catch (err) {
        // Sync throws are rare for Pool.query; still classify and never retry
        // here because the call may have partially started.
        releaseInFlight();
        logQueryFailure({
          err,
          lane,
          subsystem,
          label,
          targetPool,
          sqlDiag,
          elapsedMs: Date.now() - start,
          phase: "sync",
          attempt,
        });
        throw err;
      }

      if (result && typeof result.then === "function") {
        return result.then(
          (value: unknown) => {
            settleSuccess();
            return value;
          },
          (err: unknown) => {
            // Retry only pool-acquire timeouts: no SQL has run yet, so the
            // operation remains replay-safe. Statement timeouts and mid-query
            // failures stay single-shot.
            if (attempt <= POOL_ACQUIRE_RETRY_LIMIT && isPoolAcquireTimeoutError(err)) {
              const retryAttempt = attempt;
              attempt += 1;
              log.warn(
                `pool acquire timeout retrying once lane=${lane} subsystem=${subsystem} ` +
                  `label=${label || "none"} pool=${poolCounts(targetPool)} ` +
                  `attempt=${retryAttempt} elapsedMs=${Date.now() - start}`,
              );
              return dispatch();
            }
            settleFailure(err);
            throw err;
          },
        );
      }

      settleSuccess();
      return result;
    };

    return dispatch();
  };
}

instrumentPool(pool, "general");
instrumentPool(voicePool, "voice");

const generalDb = drizzle(pool, { schema });
const voiceDb = drizzle(voicePool, { schema });
type DrizzleTransaction = Parameters<Parameters<typeof generalDb.transaction>[0]>[0];
const databaseTransactionALS = new AsyncLocalStorage<DrizzleTransaction>();

export function runWithDatabaseTransaction<T>(
  transaction: DrizzleTransaction,
  operation: () => Promise<T>,
): Promise<T> {
  return databaseTransactionALS.run(transaction, operation);
}

export function hasAmbientDatabaseTransaction(): boolean {
  return databaseTransactionALS.getStore() !== undefined;
}

export function getAmbientDatabaseTransaction(): DrizzleTransaction | null {
  return databaseTransactionALS.getStore() ?? null;
}

/**
 * Run durable evidence or recovery work without inheriting the caller's
 * business transaction. Other async context remains intact.
 */
export function runOutsideDatabaseTransaction<T>(operation: () => Promise<T>): Promise<T> {
  return databaseTransactionALS.exit(operation);
}

const databaseProxyTarget = Object.create(null);
export const db = new Proxy(databaseProxyTarget, {
  get(_target, property, receiver) {
    const selected =
      databaseTransactionALS.getStore() ??
      (databaseLaneALS.getStore() === "voice" ? voiceDb : generalDb);
    const value = Reflect.get(selected as object, property, selected);
    return typeof value === "function" ? value.bind(selected) : value;
  },
}) as typeof generalDb;

export async function closeDatabasePools(): Promise<void> {
  stopPoolHealthCheck();
  stopPoolHeartbeat();
  stopPoolSaturationMonitor();
  stopPoolWedgeWatchdog();
  await closeManagedDatabasePools();
}


// ─── Advisory locks for serializing writes per logical key ─────────────────
// Postgres `pg_advisory_xact_lock(int4, int4)` takes two 32-bit ints. We use
// the namespace as a stable per-subsystem id and the per-key int as a
// 32-bit hash of the logical key (e.g. a parent UUID, or a sentinel for
// "root"). Locks are released automatically at transaction commit/rollback.
//
// `LIBRARY_PARENT` serializes Library tree mutations (reorder, create,
// update, edit, delete) per affected parent so the bulk sort_order shifts
// in `PATCH /api/info/library/reorder` cannot cross-lock with concurrent
// reorders or with `library` tool writes targeting the same parent.
export const ADVISORY_LOCK_NS = {
  LIBRARY_PARENT: 0x4c425052, // 'LBPR' — must fit in int32
  PERSON_MERGE: 0x5052534d, // 'PRSM' — serializes Person merges per account
  CHAT_DOCUMENT: 0x43484443, // 'CHDC' — serializes one scoped chat document across processes
  SESSION_SEARCH_PROJECTION: 0x53535052, // 'SSPR' — serializes one rebuildable session-search projection
  COMPACTION_OPERATION: 0x434f4d50, // 'COMP' — serializes one scoped compaction claim
  CALENDAR_ATTENDEE_PROMOTION: 0x43415450, // 'CATP' — serializes profile promotion by account + attendee email
  MEETING_PREP: 0x4d545052, // 'MTPR' — serializes one canonical preparation-page claim per meeting
  MEETING_VAULT: 0x4d54564c, // 'MTVL' — serializes one meeting aggregate Vault transfer
  PROJECT_MILESTONES: 0x50524d53, // 'PRMS' — serializes milestone replacement and project-local ID allocation
  OBJECT_GRANT: 0x4f424752, // 'OBGR' — serializes all grant mutations for one work object
  INVITED_SUBJECT: 0x49565342, // 'IVSB' — serializes global email resolution and claim
  RECAP_DRAFT_RECIPIENT: 0x52445243, // 'RDRC' — serializes recap recipient rotation with provider-send ownership
  CHAT_SESSION_KEY: 0x4348534b, // 'CHSK' — serializes replay-safe session creation by owner + canonical session key
  WORKFLOW_ARTIFACTS: 0x57464152, // 'WFAR' — serializes child-session artifact projection per stage attempt
  USER_IDENTITY: 0x55494446, // 'UIDF' — serializes personal account, membership, profile, and default Vault provisioning
  PROFILE_AVATAR: 0x50524156, // 'PRAV' — serializes one account/user profile-avatar replacement
  AGENDA_DEFINITION: 0x41474446, // 'AGDF' — serializes agenda definition mutations and reserved seeding per owner/account
  PERSON_EMAIL: 0x50454d4c, // 'PEML' — serializes account-local Person identity by normalized email
  RECIPIENT_RECAP: 0x52524350, // 'RRCP' — serializes one recipient-owned recap materialization
  ISSUE: 0x49535355, // 'ISSU' — serializes one Issue read-modify-write transition
  TIMER_BUILD: 0x54424c44, // 'TBLD' — serializes the cross-replica new-build Timer claim
  REGRESSION_RETIREMENT: 0x52475244, // 'RGRD' — serializes terminal retirement of the removed Regression schema
  MEETING_AUDIO_SAMPLE: 0x4d415544, // 'MAUD' — serializes retained-audio capture, replay, and deletion per sample
  REFERENCE_OCCURRENCES: 0x52464f43, // 'RFOC' — serializes one authored source projection replacement
  ADDRESS_LINK: 0x41444c4b, // 'ADLK' — serializes one explicit-link idempotency or lifecycle mutation
  MOD_LIFECYCLE: 0x4d4f444c, // 'MODL' — serializes one account+mod entitlement/install lifecycle transition
  RUNTIME_POOL: 0x5254504c, // 'RTPL' — serializes one runtime resource-pool claim transaction
  RUNTIME_RUN: 0x5254524e, // 'RTRN' — serializes one runtime run terminal/retry/cancel transition
  HOOK_EXECUTION: 0x484f4f4b, // 'HOOK' — serializes one Hook's cooldown, firing budget, and execution claim
  DOCUMENT_TEMPLATE: 0x44544d50, // 'DTMP' — serializes document template map mutations per owner/account
} as const;

const LIBRARY_ROOT_SENTINEL = "__LIBRARY_ROOT__";

// Stable 32-bit FNV-1a hash, returned as a signed int32. Advisory locks use a
// single bigint assembled from the namespace and key halves so Drizzle emits
// one ordinary parameter instead of its broken two-number SQL interpolation.
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h | 0;
}

export function libraryParentLockKey(parentId: string | null): number {
  return fnv1a32(parentId === null ? LIBRARY_ROOT_SENTINEL : parentId);
}

export type DrizzleTx = DrizzleTransaction;

function advisoryLockKey(namespace: number, key: number): string {
  const combined = (BigInt(namespace >>> 0) << 32n) | BigInt(key >>> 0);
  return BigInt.asIntN(64, combined).toString();
}

async function acquireAdvisoryLock(tx: DrizzleTx, namespace: number, key: number): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${advisoryLockKey(namespace, key)}::bigint)`,
  );
}

export async function acquireAdvisoryTransactionLock(
  tx: DrizzleTx,
  namespace: number,
  logicalKey: string,
): Promise<void> {
  await acquireAdvisoryLock(tx, namespace, fnv1a32(logicalKey));
}

// Acquire pg advisory locks (transaction-scoped) for the given parent ids.
// Locks are deduplicated and acquired in a stable sorted order so concurrent
// reparents touching {A,B} and {B,A} can't AB/BA-deadlock on the locks
// themselves. Must be called inside a `db.transaction(...)` block — the lock
// is released when the transaction commits or rolls back.
export async function acquireLibraryParentLocks(
  tx: DrizzleTx,
  parentIds: (string | null)[],
): Promise<void> {
  const uniq = Array.from(
    new Set(parentIds.map((p) => (p === null ? LIBRARY_ROOT_SENTINEL : p))),
  ).sort();
  for (const k of uniq) {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_NS.LIBRARY_PARENT, fnv1a32(k));
  }
}

// True for Postgres serialization-conflict error codes. Caller can map these
// to a 409 with a "retry" hint.
export function isSerializationConflict(err: unknown): boolean {
  const code = getPostgresErrorCode(err);
  return code === "40P01" /* deadlock_detected */ || code === "40001" /* serialization_failure */;
}

startPoolHealthCheck();
startPoolHeartbeat();
startPoolSaturationMonitor();
log.log(`pools initialized: app=${APP_NAME} totalMax=${DB_POOL_MAX} general=${GENERAL_DB_POOL_MAX}/${GENERAL_DB_POOL_MIN} voice=${VOICE_DB_POOL_MAX}/${VOICE_DB_POOL_MIN} voiceAcquireMs=${VOICE_DB_ACQUIRE_TIMEOUT_MS} voiceStatementMs=${VOICE_DB_STATEMENT_TIMEOUT_MS}`);
