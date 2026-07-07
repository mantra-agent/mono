import { writeSync } from "fs";

const STDERR_FD = 2;

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

export function abortTrace(stage: string, fields: AbortTraceFields = {}): void {
  const { routeStartAt, ...rest } = fields;
  const elapsedMs = typeof routeStartAt === "number" ? Date.now() - routeStartAt : undefined;
  const parts: string[] = [`stage=${stage}`];
  if (elapsedMs !== undefined) parts.push(`elapsedMs=${elapsedMs}`);
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null) continue;
    const str = typeof v === "string" ? v : String(v);
    const safe = str.includes(" ") || str.includes("=") ? JSON.stringify(str) : str;
    parts.push(`${k}=${safe}`);
  }
  const line = `[AbortTrace] ${parts.join(" ")} ts=${new Date().toISOString()}\n`;
  try {
    writeSync(STDERR_FD, line);
  } catch {}
}
