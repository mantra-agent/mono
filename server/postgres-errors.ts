const RECOVERABLE_POSTGRES_CONNECTION_CODES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

const RECOVERABLE_POSTGRES_CONNECTION_MESSAGE =
  /terminating connection|connection terminated|server closed the connection unexpectedly|connection reset by peer|ECONNRESET/i;

export function isRecoverablePostgresConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
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
  const seen = new Set<unknown>();
  let current: unknown = error;
  let depth = 0;
  let fallbackType = error instanceof Error ? error.name || "Error" : typeof error;
  while (current != null && depth <= 6 && !seen.has(current)) {
    seen.add(current);
    const record = typeof current === "object" ? current as { code?: unknown; cause?: unknown } : null;
    const code = record?.code;
    if (typeof code === "string" && code.length > 0) {
      return {
        code,
        errorType: current instanceof Error ? current.name || fallbackType : fallbackType,
        causeDepth: depth,
      };
    }
    current = record?.cause;
    depth += 1;
  }
  return { code: "unknown", errorType: fallbackType, causeDepth: 0 };
}

export function getPostgresErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "unknown";
}
