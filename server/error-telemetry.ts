import { createHash } from "crypto";
import { pool } from "./db";
import { createLogger } from "./log";

const telemetryLog = createLogger("ErrorTelemetry");
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

export async function captureApplicationError(error: unknown): Promise<void> {
  const identity = normalizeIdentity(error);
  const source = sourceLocation(error);
  const fingerprint = createHash("sha256")
    .update(`${identity}\n${source.file ?? "unknown"}\n${source.line ?? 0}\n${source.site}`)
    .digest("hex");
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO application_error_aggregates
         (fingerprint, error_identity, source_file, source_line, source_site)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (fingerprint) DO UPDATE SET
         last_seen_at = now(),
         occurrence_count = application_error_aggregates.occurrence_count + 1`,
      [fingerprint, identity, source.file, source.line, source.site],
    );
  } catch (captureError) {
    telemetryLog.warn("Privacy-safe application error aggregation failed", {
      errorType: captureError instanceof Error ? captureError.name : "UnknownError",
    });
  }
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
