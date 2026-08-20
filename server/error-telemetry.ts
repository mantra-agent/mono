import { createHash } from "crypto";
import { pool } from "./db";
import { enqueueTelemetryWrite } from "./telemetry-write";
import { deriveSafeErrorCallsite, selectErrorStack } from "@shared/error-callsite";
import type { Principal } from "./principal";
import { principalHasPermission } from "./permissions";
import type { Permission } from "@shared/permissions-vocabulary";

const MAX_IDENTITY_LENGTH = 160;
const MAX_SOURCE_LENGTH = 240;
/** Issues Errors and Self Heal share this list; older undismissed rows stay stored. */
const ACTIVE_ERROR_WINDOW = "7 days";
const SECRET_LIKE =
  /(?:bearer\s+\S+|api[_-]?key|authorization|cookie|password|secret|token|session|email|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i;

export interface AggregatedApplicationError {
  fingerprint: string;
  errorIdentity: string;
  sourceFile: string | null;
  sourceLine: number | null;
  sourceSite: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
}

function requireApplicationErrorPermission(principal: Principal, permission: Permission): void {
  if (!principalHasPermission(principal, permission)) {
    throw Object.assign(new Error(`Permission required: ${permission}`), {
      statusCode: 403,
      permission,
    });
  }
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool
      .query(
        `
      CREATE TABLE IF NOT EXISTS application_error_aggregates (
        fingerprint text PRIMARY KEY,
        error_identity text NOT NULL,
        source_file text,
        source_line integer,
        source_site text NOT NULL,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        occurrence_count bigint NOT NULL DEFAULT 1,
        dismissed_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS application_error_deliveries (
        delivery_id uuid PRIMARY KEY,
        received_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE application_error_aggregates
        ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
      CREATE INDEX IF NOT EXISTS application_error_aggregates_last_seen_idx
        ON application_error_aggregates (last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS application_error_aggregates_active_count_idx
        ON application_error_aggregates (occurrence_count DESC, last_seen_at DESC)
        WHERE dismissed_at IS NULL;
    `,
      )
      .then(() => undefined)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

export interface ApplicationErrorProjection {
  logger: string;
  deliveryId?: string;
  errorName?: string;
  errorCode?: string;
  sourceFile?: string | null;
  sourceLine?: number | null;
  sourceSite?: string;
}

function normalizeProjection(input: ApplicationErrorProjection) {
  const logger = /^[A-Za-z0-9_.:-]{1,80}$/.test(input.logger) ? input.logger : "UnknownLogger";
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(input.errorName ?? "")
    ? input.errorName!
    : "Error";
  const code = /^[A-Z][A-Z0-9_]{1,48}$/.test(input.errorCode ?? "")
    ? input.errorCode!
    : "UNCLASSIFIED";
  const sourceFile =
    typeof input.sourceFile === "string" &&
    input.sourceFile.length > 0 &&
    input.sourceFile.length <= MAX_SOURCE_LENGTH &&
    !input.sourceFile.includes("..") &&
    !SECRET_LIKE.test(input.sourceFile)
      ? input.sourceFile
      : null;
  const sourceLine =
    typeof input.sourceLine === "number" &&
    Number.isInteger(input.sourceLine) &&
    input.sourceLine > 0 &&
    input.sourceLine < 1_000_000
      ? input.sourceLine
      : null;
  const candidateSite = (input.sourceSite ?? "").slice(0, 160);
  const sourceSite =
    /^[A-Za-z0-9_.:$<>/-]{1,160}$/.test(candidateSite) && !SECRET_LIKE.test(candidateSite)
      ? candidateSite
      : logger;
  const errorIdentity = `${logger}:${name}:${code}`.slice(0, MAX_IDENTITY_LENGTH);
  const fingerprint = createHash("sha256")
    .update([errorIdentity, sourceFile ?? "", String(sourceLine ?? ""), sourceSite].join("|"))
    .digest("hex");
  return { fingerprint, errorIdentity, sourceFile, sourceLine, sourceSite };
}

async function persistProjection(input: ApplicationErrorProjection): Promise<void> {
  await ensureSchema();
  const normalized = normalizeProjection(input);
  if (input.deliveryId) {
    const delivery = await pool.query(
      `INSERT INTO application_error_deliveries (delivery_id)
       VALUES ($1::uuid)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [input.deliveryId],
    );
    if (delivery.rowCount === 0) return;
  }

  await pool.query(
    `INSERT INTO application_error_aggregates (
       fingerprint, error_identity, source_file, source_line, source_site, occurrence_count, dismissed_at
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL)
     ON CONFLICT (fingerprint) DO UPDATE SET
       last_seen_at = now(),
       occurrence_count = application_error_aggregates.occurrence_count + 1,
       dismissed_at = NULL,
       error_identity = EXCLUDED.error_identity,
       source_file = COALESCE(EXCLUDED.source_file, application_error_aggregates.source_file),
       source_line = COALESCE(EXCLUDED.source_line, application_error_aggregates.source_line),
       source_site = EXCLUDED.source_site`,
    [
      normalized.fingerprint,
      normalized.errorIdentity,
      normalized.sourceFile,
      normalized.sourceLine,
      normalized.sourceSite,
    ],
  );
}

export function enqueueApplicationErrorProjection(input: ApplicationErrorProjection): void {
  // Must match enqueueTelemetryWrite(label, run) — object form is dropped/misrun
  // and starves application_error_aggregates of all post-boot projections.
  enqueueTelemetryWrite("application-error-aggregate", () => persistProjection(input));
}

export function captureApplicationError(error: unknown, logger = "ExpressFallback"): void {
  const callsite = deriveSafeErrorCallsite(selectErrorStack({ error }));
  const errorName = error instanceof Error && error.name ? error.name : "Error";
  const errorCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    /^[A-Z][A-Z0-9_]{1,48}$/.test(String((error as { code?: unknown }).code ?? ""))
      ? String((error as { code?: unknown }).code)
      : undefined;
  enqueueApplicationErrorProjection({
    logger,
    errorName,
    errorCode,
    ...callsite,
    sourceSite: callsite.sourceSite ?? logger,
  });
}

/**
 * Platform-health projection. The aggregate is intentionally global and keyed
 * only by privacy-safe fingerprint, so one defect recurring for many users is
 * one operational error with a platform-wide occurrence count. The Issues
 * Errors tab and Self Heal both consume this list, so recency is a query
 * contract here — not a UI filter or skill prompt. Callers must establish
 * their own authority; admin wrappers below add named permissions.
 */
export async function listRecentApplicationErrors(
  limit = 25,
  offset = 0,
): Promise<AggregatedApplicationError[]> {
  await ensureSchema();
  const result = await pool.query(
    `SELECT fingerprint, error_identity, source_file, source_line, source_site,
            first_seen_at, last_seen_at, occurrence_count
     FROM application_error_aggregates
     WHERE dismissed_at IS NULL
       AND last_seen_at >= now() - $3::interval
     ORDER BY occurrence_count DESC, last_seen_at DESC, fingerprint ASC
     LIMIT $1 OFFSET $2`,
    [Math.min(100, Math.max(1, limit)), Math.max(0, offset), ACTIVE_ERROR_WINDOW],
  );
  return result.rows.map((row) => ({
    fingerprint: row.fingerprint,
    errorIdentity: row.error_identity,
    sourceFile: row.source_file,
    sourceLine: row.source_line,
    sourceSite: row.source_site,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    occurrenceCount: Number(row.occurrence_count),
  }));
}

export async function listPlatformApplicationErrors(
  principal: Principal,
  limit = 25,
  offset = 0,
): Promise<AggregatedApplicationError[]> {
  requireApplicationErrorPermission(principal, "system:read");
  return listRecentApplicationErrors(limit, offset);
}

export async function getApplicationError(
  fingerprint: string,
): Promise<AggregatedApplicationError | null> {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) return null;
  await ensureSchema();
  const result = await pool.query(
    `SELECT fingerprint, error_identity, source_file, source_line, source_site,
            first_seen_at, last_seen_at, occurrence_count
     FROM application_error_aggregates
     WHERE fingerprint = $1 AND dismissed_at IS NULL
     LIMIT 1`,
    [fingerprint.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    fingerprint: row.fingerprint,
    errorIdentity: row.error_identity,
    sourceFile: row.source_file,
    sourceLine: row.source_line,
    sourceSite: row.source_site,
    firstSeenAt: new Date(row.first_seen_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    occurrenceCount: Number(row.occurrence_count),
  };
}

export async function getPlatformApplicationError(
  principal: Principal,
  fingerprint: string,
): Promise<AggregatedApplicationError | null> {
  requireApplicationErrorPermission(principal, "system:read");
  return getApplicationError(fingerprint);
}

export async function dismissApplicationError(fingerprint: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) return false;
  await ensureSchema();
  const result = await pool.query(
    `UPDATE application_error_aggregates
     SET dismissed_at = now()
     WHERE fingerprint = $1 AND dismissed_at IS NULL`,
    [fingerprint.toLowerCase()],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function dismissPlatformApplicationError(
  principal: Principal,
  fingerprint: string,
): Promise<boolean> {
  requireApplicationErrorPermission(principal, "system:write");
  return dismissApplicationError(fingerprint);
}

/** Dismiss every active aggregate sharing one errorIdentity (asset/site siblings). */
export async function dismissApplicationErrorsByIdentity(errorIdentity: string): Promise<number> {
  const identity = errorIdentity.trim().slice(0, MAX_IDENTITY_LENGTH);
  if (!identity) return 0;
  await ensureSchema();
  const result = await pool.query(
    `UPDATE application_error_aggregates
     SET dismissed_at = now()
     WHERE error_identity = $1 AND dismissed_at IS NULL`,
    [identity],
  );
  return result.rowCount ?? 0;
}

export async function dismissPlatformApplicationErrorsByIdentity(
  principal: Principal,
  errorIdentity: string,
): Promise<number> {
  requireApplicationErrorPermission(principal, "system:write");
  return dismissApplicationErrorsByIdentity(errorIdentity);
}
