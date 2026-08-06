import { createHash } from "crypto";
import { pool } from "./db";
import { enqueueTelemetryWrite } from "./telemetry-write";
const MAX_IDENTITY_LENGTH = 160;
const MAX_SOURCE_LENGTH = 240;
const SECRET_LIKE = /(?:bearer\s+\S+|api[_-]?key|authorization|cookie|password|secret|token|session|email|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i;

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

let schemaReady: Promise<void> | null = null;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS application_error_aggregates (
        fingerprint text PRIMARY KEY,
        error_identity text NOT NULL,
        source_file text,
        source_line integer,
        source_site text NOT NULL,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        occurrence_count bigint NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS application_error_deliveries (
        delivery_id uuid PRIMARY KEY,
        received_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS application_error_aggregates_last_seen_idx
        ON application_error_aggregates (last_seen_at DESC);
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function normalizeIdentity(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : "Error";
  const candidateCode = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const code = /^[A-Z][A-Z0-9_]{1,48}$/.test(candidateCode) ? candidateCode : "UNCLASSIFIED";
  // Exception messages are deliberately excluded: they frequently contain user content or secrets.
  return `${name}:${code}`.slice(0, MAX_IDENTITY_LENGTH);
}

function sourceLocation(error: unknown): { file: string | null; line: number | null; site: string } {
  const stack = error instanceof Error ? error.stack : undefined;
  const frames = stack?.split("\n").slice(1) ?? [];
  for (const frame of frames) {
    const match = frame.match(/(?:at\s+([^\s(]+)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!match) continue;
    const fullPath = match[2].replace(/\\/g, "/");
    const marker = fullPath.lastIndexOf("/server/");
    const file = (marker >= 0 ? fullPath.slice(marker + 1) : fullPath.split("/").slice(-2).join("/"))
      .slice(0, MAX_SOURCE_LENGTH);
    if (SECRET_LIKE.test(file)) continue;
    return { file, line: Number(match[3]), site: (match[1] || "anonymous").slice(0, 120) };
  }
  return { file: null, line: null, site: "unknown" };
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
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(input.errorName ?? "") ? input.errorName! : "Error";
  const code = /^[A-Z][A-Z0-9_]{1,48}$/.test(input.errorCode ?? "") ? input.errorCode! : "UNCLASSIFIED";
  const candidateFile = (input.sourceFile ?? "").replace(/\\/g, "/").slice(0, MAX_SOURCE_LENGTH);
  const file = candidateFile && !SECRET_LIKE.test(candidateFile) && !candidateFile.includes("..") ? candidateFile : null;
  const line = Number.isInteger(input.sourceLine) && input.sourceLine! > 0 && input.sourceLine! <= 10_000_000 ? input.sourceLine! : null;
  const candidateSite = (input.sourceSite ?? "unknown").slice(0, 160);
  const site = /^[A-Za-z0-9_.$<>:-]{1,160}$/.test(candidateSite) ? candidateSite : "unknown";
  const deliveryId = /^[0-9a-f-]{36}$/i.test(input.deliveryId ?? "") ? input.deliveryId! : null;
  return { identity: `${logger}:${name}:${code}`.slice(0, MAX_IDENTITY_LENGTH), file, line, site, deliveryId };
}

async function persistProjection(projection: ReturnType<typeof normalizeProjection>): Promise<void> {
  const fingerprint = createHash("sha256")
    .update(`${projection.identity}\n${projection.file ?? "unknown"}\n${projection.line ?? 0}\n${projection.site}`)
    .digest("hex");
  await ensureSchema();
  if (projection.deliveryId) {
    const claimed = await pool.query(
      `INSERT INTO application_error_deliveries (delivery_id) VALUES ($1)
       ON CONFLICT DO NOTHING RETURNING delivery_id`,
      [projection.deliveryId],
    );
    if (claimed.rowCount === 0) return;
  }
  await pool.query(
    `INSERT INTO application_error_aggregates
       (fingerprint, error_identity, source_file, source_line, source_site)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (fingerprint) DO UPDATE SET
       last_seen_at = now(),
       occurrence_count = application_error_aggregates.occurrence_count + 1`,
    [fingerprint, projection.identity, projection.file, projection.line, projection.site],
  );
}

export function enqueueApplicationErrorProjection(input: ApplicationErrorProjection): void {
  const projection = normalizeProjection(input);
  enqueueTelemetryWrite("application-error-aggregate.capture", () => persistProjection(projection));
}

export function captureApplicationError(error: unknown, logger = "ExpressFallback"): void {
  const [errorName, errorCode] = normalizeIdentity(error).split(":");
  const source = sourceLocation(error);
  enqueueApplicationErrorProjection({ logger, errorName, errorCode, sourceFile: source.file, sourceLine: source.line, sourceSite: source.site });
}

export async function listRecentApplicationErrors(limit = 25, offset = 0): Promise<AggregatedApplicationError[]> {
  await ensureSchema();
  const result = await pool.query(
    `SELECT fingerprint, error_identity, source_file, source_line, source_site,
            first_seen_at, last_seen_at, occurrence_count
       FROM application_error_aggregates
      ORDER BY last_seen_at DESC
      LIMIT $1 OFFSET $2`,
    [Math.min(100, Math.max(1, limit)), Math.max(0, offset)],
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
