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

/** Postgres unique_violation — primary key or unique index conflict. */
export function isUniqueViolationError(error: unknown): boolean {
  return getPostgresErrorCode(error) === "23505";
}
