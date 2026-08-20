const RECOVERABLE_POSTGRES_CONNECTION_CODES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const RECOVERABLE_POSTGRES_CONNECTION_MESSAGE =
  /terminating connection|connection terminated|server closed the connection unexpectedly|connection reset by peer|ECONNRESET/i;

/** node-postgres pool acquisition timeout (connectionTimeoutMillis). */
const POOL_ACQUIRE_TIMEOUT_MESSAGE =
  /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i;

/**
 * True when node-postgres failed while acquiring a pool client, before any
 * application SQL ran. Distinct from statement timeout (57014) and from
 * mid-query disconnects.
 */
export function isPoolAcquireTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (POOL_ACQUIRE_TIMEOUT_MESSAGE.test(error.message)) return true;
  const code = typeof (error as Error & { code?: unknown }).code === "string"
    ? (error as Error & { code: string }).code
    : "";
  // node-pg may surface connect races as ETIMEDOUT; require a connection-shaped
  // message so unrelated timeouts stay out of this class.
  return code === "ETIMEDOUT" && /connect|connection|pool/i.test(error.message);
}

export function isRecoverablePostgresConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isPoolAcquireTimeoutError(error)) return true;
  const code = typeof (error as Error & { code?: unknown }).code === "string"
    ? (error as Error & { code: string }).code
    : "";
  return (
    RECOVERABLE_POSTGRES_CONNECTION_CODES.has(code) ||
    code.startsWith("08") ||
    RECOVERABLE_POSTGRES_CONNECTION_MESSAGE.test(error.message)
  );
}

export interface PostgresErrorDetails {
  code: string;
  errorType: string;
  causeDepth: number;
}

export function getPostgresErrorDetails(error: unknown): PostgresErrorDetails {
  let current: unknown = error;
  const seen = new Set<unknown>();
  const fallbackType = error instanceof Error ? error.name || "Error" : typeof error;
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length > 0) {
      return {
        code: candidate.code,
        errorType: current instanceof Error ? current.name || fallbackType : fallbackType,
        causeDepth: depth,
      };
    }
    current = candidate.cause;
  }
  return { code: "unknown", errorType: fallbackType, causeDepth: 0 };
}

export function getPostgresErrorCode(error: unknown): string {
  return getPostgresErrorDetails(error).code;
}

/**
 * Product-owned telemetry codes for ordinary query-contract failures.
 * ERRORS identity is logger:name:code — a single immortal QUERY_CONTRACT_FAILED
 * collapses unrelated SQLSTATE classes (timeout vs FK vs syntax). Map known
 * classes here so disposition can track producers separately. Unknown SQLSTATE
 * still falls through to QUERY_CONTRACT_FAILED.
 */
export function resolveQueryContractTelemetryCode(error: unknown): string {
  const sqlstate = getPostgresErrorCode(error);
  switch (sqlstate) {
    case "57014":
      return "QUERY_STATEMENT_TIMEOUT";
    case "55P03":
      return "QUERY_LOCK_NOT_AVAILABLE";
    case "40P01":
      return "QUERY_DEADLOCK";
    case "40001":
      return "QUERY_SERIALIZATION_FAILURE";
    case "23001":
      return "QUERY_RESTRICT_VIOLATION";
    case "23503":
      return "QUERY_FK_VIOLATION";
    case "23505":
      return "QUERY_UNIQUE_VIOLATION";
    case "23502":
      return "QUERY_NOT_NULL_VIOLATION";
    case "22P02":
      return "QUERY_INVALID_TEXT";
    case "42P01":
      return "QUERY_UNDEFINED_TABLE";
    case "42703":
      return "QUERY_UNDEFINED_COLUMN";
    case "42601":
      return "QUERY_SYNTAX_ERROR";
    default:
      return "QUERY_CONTRACT_FAILED";
  }
}

/** Postgres unique_violation — primary key or unique index conflict. */
export function isUniqueViolationError(error: unknown): boolean {
  return getPostgresErrorCode(error) === "23505";
}

/**
 * The constraint/index name node-postgres attaches to a violation (e.g. the
 * primary key vs a named unique index). Returns null when the driver did not
 * surface one, so callers must treat null as "unknown", not as a match.
 */
export function getPostgresConstraintName(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current);
    const candidate = current as { constraint?: unknown; cause?: unknown };
    if (typeof candidate.constraint === "string" && candidate.constraint.length > 0) {
      return candidate.constraint;
    }
    current = candidate.cause;
  }
  return null;
}
