// Use createLogger for logging ONLY
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { browserPerformanceTelemetry } from "@shared/schema";
import {
  BROWSER_TELEMETRY_BUDGETS,
  BROWSER_TELEMETRY_EVENT_KINDS,
  BROWSER_TELEMETRY_LIMITS,
  type BrowserTelemetryEventInput,
  type BrowserTelemetrySummary,
} from "@shared/browser-telemetry";
import { db } from "./db";
import type { Principal } from "./principal";
import { combineWithVisibleScope, ownedInsertValues } from "./scoped-storage";
import { createLogger } from "./log";

const log = createLogger("BrowserTelemetry");

const telemetryEventSchema = z.object({
  kind: z.enum(BROWSER_TELEMETRY_EVENT_KINDS),
  name: z.string().min(1).max(80),
  value: z.number().finite().nonnegative().max(3_600_000),
  unit: z.enum(["ms", "score", "count", "bytes"]),
  routeKey: z.string().max(120).optional(),
  sessionId: z.string().max(120).optional(),
  clientTurnId: z.string().max(120).optional(),
  bucket: z.string().max(80).optional(),
  metadata: z.record(z.unknown()).optional(),
  occurredAt: z.string().datetime().optional(),
});

const telemetryBatchSchema = z.object({
  events: z.array(telemetryEventSchema).max(BROWSER_TELEMETRY_LIMITS.maxBatchSize),
});

const BUDGET_WINDOW_MS = 60_000;
const MAX_EVENTS_PER_WINDOW = 300;
const budgetBuckets = new Map<string, { windowStart: number; count: number }>();

export function claimBrowserTelemetryBudget(key: string, eventCount: number): boolean {
  const now = Date.now();
  const current = budgetBuckets.get(key);
  if (!current || now - current.windowStart >= BUDGET_WINDOW_MS) {
    budgetBuckets.set(key, { windowStart: now, count: eventCount });
    return eventCount <= MAX_EVENTS_PER_WINDOW;
  }
  if (current.count + eventCount > MAX_EVENTS_PER_WINDOW) return false;
  current.count += eventCount;
  return true;
}

function stripUnsafeString(value: string | undefined): string | null {
  if (!value) return null;
  return value
    .split("?")[0]
    .split("#")[0]
    .replace(/[^a-zA-Z0-9_./:-]/g, "")
    .slice(0, BROWSER_TELEMETRY_LIMITS.maxStringLength) || null;
}

function sanitizeMetadata(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
    else if (typeof value === "boolean") output[key] = value;
    else if (typeof value === "string") output[key] = stripUnsafeString(value);
  }
  const json = JSON.stringify(output);
  if (json.length <= BROWSER_TELEMETRY_LIMITS.maxMetadataBytes) return output;
  return { truncated: true };
}

export function parseBrowserTelemetryBatch(body: unknown): BrowserTelemetryEventInput[] {
  const parsed = telemetryBatchSchema.parse(body);
  return parsed.events;
}

export async function ingestBrowserTelemetry(principal: Principal, events: BrowserTelemetryEventInput[]): Promise<number> {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("browser telemetry requires an authenticated user principal");
  }
  if (events.length === 0) return 0;
  const owner = ownedInsertValues(principal, {
    scope: browserPerformanceTelemetry.scope,
    ownerUserId: browserPerformanceTelemetry.ownerUserId,
    accountId: browserPerformanceTelemetry.accountId,
  });
  const rows = events.map((event) => ({
    ...owner,
    createdByUserId: principal.userId,
    kind: event.kind,
    name: stripUnsafeString(event.name) ?? "unknown",
    value: event.value,
    unit: event.unit,
    routeKey: stripUnsafeString(event.routeKey),
    sessionId: stripUnsafeString(event.sessionId),
    clientTurnId: stripUnsafeString(event.clientTurnId),
    bucket: stripUnsafeString(event.bucket),
    metadata: sanitizeMetadata(event.metadata),
    occurredAt: event.occurredAt ? new Date(event.occurredAt) : new Date(),
  }));
  await db.insert(browserPerformanceTelemetry).values(rows);
  return rows.length;
}

export async function pruneExpiredBrowserTelemetry(): Promise<void> {
  const cutoff = new Date(Date.now() - BROWSER_TELEMETRY_LIMITS.rawRetentionDays * 24 * 60 * 60 * 1000);
  await db.delete(browserPerformanceTelemetry).where(sql`${browserPerformanceTelemetry.receivedAt} < ${cutoff}`);
}

export async function getBrowserTelemetrySummary(principal: Principal, windowHours = 24): Promise<BrowserTelemetrySummary> {
  const hours = Math.min(Math.max(Math.floor(windowHours), 1), 168);
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const scope = combineWithVisibleScope(principal, {
    scope: browserPerformanceTelemetry.scope,
    ownerUserId: browserPerformanceTelemetry.ownerUserId,
    accountId: browserPerformanceTelemetry.accountId,
  }, gte(browserPerformanceTelemetry.receivedAt, cutoff));

  const rows = await db.select({
    kind: browserPerformanceTelemetry.kind,
    name: browserPerformanceTelemetry.name,
    value: browserPerformanceTelemetry.value,
    unit: browserPerformanceTelemetry.unit,
    routeKey: browserPerformanceTelemetry.routeKey,
    occurredAt: browserPerformanceTelemetry.occurredAt,
    receivedAt: browserPerformanceTelemetry.receivedAt,
  })
    .from(browserPerformanceTelemetry)
    .where(scope)
    .orderBy(desc(browserPerformanceTelemetry.receivedAt))
    .limit(5000);

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.name}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const metrics = Array.from(groups.values()).map((group) => {
    const sorted = group.map((row) => Number(row.value)).filter(Number.isFinite).sort((a, b) => a - b);
    const pick = (pct: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct))] : null;
    return {
      kind: group[0].kind,
      name: group[0].name,
      count: group.length,
      p50: pick(0.5),
      p95: pick(0.95),
      latestAt: group[0].receivedAt instanceof Date ? group[0].receivedAt.toISOString() : null,
    };
  }).sort((a, b) => b.count - a.count).slice(0, 50);

  const recentDegradations = rows
    .filter((row) => row.kind === "long_task" || row.kind === "frame_contention" || row.kind === "transport_gap" || row.kind === "event_loop_responsiveness")
    .slice(0, 20)
    .map((row) => ({
      kind: row.kind,
      name: row.name,
      value: Number(row.value),
      unit: row.unit,
      routeKey: row.routeKey,
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : new Date().toISOString(),
    }));

  const sampleHealth = rows.length === 0 ? "empty" : rows.length < 20 ? "thin" : "healthy";

  return {
    generatedAt: Date.now(),
    windowHours: hours,
    rawRetentionDays: BROWSER_TELEMETRY_LIMITS.rawRetentionDays,
    sampleCount: rows.length,
    sampleHealth,
    budgets: BROWSER_TELEMETRY_BUDGETS,
    metrics,
    recentDegradations,
  };
}

export function logBrowserTelemetryIngestFailure(error: unknown): void {
  log.warn("browser telemetry ingestion failed", { error: error instanceof Error ? error.message : String(error) });
}
