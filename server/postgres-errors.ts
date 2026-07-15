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

export function getPostgresErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "unknown";
}
