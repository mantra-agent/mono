import { createLogger } from "./log";

const log = createLogger("AbortTrace");

export type AbortTraceLevel = "info" | "warn" | "error";

export interface AbortTraceFields {
  runId?: string | null;
  sessionId?: string | null;
  sessionKey?: string | null;
  routeStartAt?: number;
  count?: number;
  reason?: string | null;
  error?: string | null;
  ms?: number;
  [key: string]: string | number | boolean | null | undefined;
}

export function abortTrace(
  stage: string,
  fields: AbortTraceFields = {},
  level: AbortTraceLevel = "info",
): void {
  const { routeStartAt, ...rest } = fields;
  const elapsedMs = typeof routeStartAt === "number" ? Date.now() - routeStartAt : undefined;
  const parts: string[] = [`stage=${stage}`];
  if (elapsedMs !== undefined) parts.push(`elapsedMs=${elapsedMs}`);
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null) continue;
    const str = typeof value === "string" ? value : String(value);
    const safe = str.includes(" ") || str.includes("=") ? JSON.stringify(str) : str;
    parts.push(`${key}=${safe}`);
  }
  log[level](parts.join(" "));
}
