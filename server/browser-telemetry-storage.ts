// Use createLogger for logging ONLY
import { desc, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { browserPerformanceTelemetry } from "@shared/schema";
import {
  BROWSER_TELEMETRY_BUDGETS,
  BROWSER_TELEMETRY_EVENT_KINDS,
  BROWSER_TELEMETRY_LIMITS,
  NAVIGATION_TRACE_DIAGNOSES,
  type BrowserTelemetryEventInput,
  type BrowserTelemetrySummary,
  type NavigationTraceDiagnosis,
  type NavigationTraceIncident,
  type NavigationTraceOutcome,
} from "@shared/browser-telemetry";
import { db } from "./db";
import type { Principal } from "./principal";
import { combineWithVisibleScope, ownedInsertValues } from "./scoped-storage";
import { createLogger } from "./log";
import { enqueueTelemetryWrite } from "./telemetry-write";

const log = createLogger("BrowserTelemetry");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

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
  visibility: z.enum(["visible", "hidden"]).optional(),
});

const telemetryBatchSchema = z.object({
  events: z.array(telemetryEventSchema).max(BROWSER_TELEMETRY_LIMITS.maxBatchSize),
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export function parseBrowserTelemetryBatch(body: unknown): BrowserTelemetryEventInput[] {
  const parsed = telemetryBatchSchema.parse(body);
  return parsed.events;
}

function assertBrowserTelemetryPrincipal(principal: Principal): asserts principal is Principal & { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("browser telemetry requires an authenticated user principal");
  }
}

async function writeBrowserTelemetry(principal: Principal, events: BrowserTelemetryEventInput[]): Promise<number> {
  assertBrowserTelemetryPrincipal(principal);
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
    visibility: event.visibility ?? null,
  }));
  await db.insert(browserPerformanceTelemetry).values(rows);
  return rows.length;
}

/** Enqueue a validated batch for background insert. Returns accepted event count immediately. */
export function enqueueBrowserTelemetry(principal: Principal, events: BrowserTelemetryEventInput[]): number {
  assertBrowserTelemetryPrincipal(principal);
  if (events.length === 0) return 0;
  // Shared telemetry log-sink owns serial delivery + query attribution.
  enqueueTelemetryWrite("browser-telemetry.ingest", async () => {
    await writeBrowserTelemetry(principal, events);
  });
  return events.length;
}

/** Synchronous write path retained for callers that must await durability. */
export async function ingestBrowserTelemetry(principal: Principal, events: BrowserTelemetryEventInput[]): Promise<number> {
  return writeBrowserTelemetry(principal, events);
}

// ---------------------------------------------------------------------------
// Retention prune
// ---------------------------------------------------------------------------

export async function pruneExpiredBrowserTelemetry(): Promise<void> {
  const cutoff = new Date(Date.now() - BROWSER_TELEMETRY_LIMITS.rawRetentionDays * 24 * 60 * 60 * 1000);
  await db.delete(browserPerformanceTelemetry).where(sql`${browserPerformanceTelemetry.receivedAt} < ${cutoff}`);
}

// ---------------------------------------------------------------------------
// Visibility-aware filtering
// ---------------------------------------------------------------------------

/**
 * Returns true when a row should be included in percentile calculations for the
 * given metric kind.
 *
 * Policy (documented here as the single source of truth for this decision):
 *
 * - chat_latency: keep ALL rows regardless of visibility. Chat turns are
 *   user-initiated and their latency is meaningful whether the tab is focused
 *   or not (e.g. the user may switch tabs while waiting for a response).
 *
 * - event_loop_responsiveness (timer_lag) and transport_gap (liveness_gap):
 *   exclude visibility='hidden' AND NULL. These metrics are exclusively driven
 *   by browser throttling of backgrounded tabs (setTimeout/setInterval fire at
 *   ≥1 s and WebSocket keepalive intervals elongate), producing p95 values in
 *   the 6-minute range that permanently orange the panel with no signal value.
 *   NULL rows (pre-migration 0079) are also excluded here because they cannot
 *   be distinguished from hidden-tab samples, and these two metrics are the
 *   specific ones reported as dominated by background noise. Old data ages out
 *   within 7 days (rawRetentionDays), so the transition window is short.
 *
 * - All other kinds (navigation, web_vital, long_task, frame_contention):
 *   exclude visibility='hidden' only; include NULL rows. NULL represents data
 *   collected before tagging was introduced — it is most likely from visible
 *   sessions (the panel was only open when the user was looking at it) and
 *   should be preserved for historical continuity during the 7-day transition.
 */
function shouldIncludeForPercentile(kind: string, visibility: string | null): boolean {
  if (kind === "chat_latency") {
    // Chat latency: keep all samples, visibility irrelevant.
    return true;
  }
  if (kind === "event_loop_responsiveness" || kind === "transport_gap") {
    // Timer-lag and liveness-gap: exclude hidden AND NULL (see policy above).
    return visibility === "visible";
  }
  // All other kinds: exclude hidden, include NULL.
  return visibility !== "hidden";
}

function exceedsBrowserBudget(kind: string, name: string, value: number): boolean {
  if (kind === "navigation") return value > BROWSER_TELEMETRY_BUDGETS.navigation.p95Ms;
  if (kind === "long_task") return value > BROWSER_TELEMETRY_BUDGETS.longTaskP95Ms;
  if (kind === "frame_contention") return value > BROWSER_TELEMETRY_BUDGETS.frameContentionP95Ms;
  if (kind === "transport_gap") return value > BROWSER_TELEMETRY_BUDGETS.transportGapP95Ms;
  if (kind === "event_loop_responsiveness") return value > BROWSER_TELEMETRY_BUDGETS.eventLoopResponsivenessP95Ms;
  if (kind === "features") {
    if (name === "list_fetch") return value > BROWSER_TELEMETRY_BUDGETS.features.listFetchP95Ms;
    if (name === "first_paint") return value > BROWSER_TELEMETRY_BUDGETS.features.firstPaintP95Ms;
    if (name === "session_match") return value > BROWSER_TELEMETRY_BUDGETS.features.sessionMatchP95Ms;
    if (name === "expand") return value > BROWSER_TELEMETRY_BUDGETS.features.expandP95Ms;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalMetadataNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
  return typeof metadata[key] === "string" ? String(metadata[key]) : "unknown";
}

function navigationDiagnosis(metadata: Record<string, unknown>): NavigationTraceDiagnosis {
  const diagnosis = metadataString(metadata, "diagnosis");
  return NAVIGATION_TRACE_DIAGNOSES.includes(diagnosis as NavigationTraceDiagnosis)
    ? diagnosis as NavigationTraceDiagnosis
    : "incomplete_or_unknown";
}

function navigationOutcome(metadata: Record<string, unknown>): NavigationTraceOutcome {
  const outcome = metadataString(metadata, "outcome");
  return outcome === "completed" || outcome === "deadline" || outcome === "pagehide" || outcome === "superseded"
    ? outcome
    : "deadline";
}

/** Percentiles measure completed navigations only. Deadline/pagehide/superseded are incompleteness, not latency. */
function isCompletedNavigationSample(kind: string, metadata: unknown): boolean {
  if (kind !== "navigation") return true;
  return navigationOutcome(metadataRecord(metadata)) === "completed";
}

export async function getBrowserTelemetrySummary(principal: Principal, windowHours = 24): Promise<BrowserTelemetrySummary> {
  // Match reliability window ceiling so Performance page date range is one source of truth.
  const hours = Math.min(Math.max(Math.floor(windowHours), 1), 720);
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
    metadata: browserPerformanceTelemetry.metadata,
    occurredAt: browserPerformanceTelemetry.occurredAt,
    receivedAt: browserPerformanceTelemetry.receivedAt,
    visibility: browserPerformanceTelemetry.visibility,
  })
    .from(browserPerformanceTelemetry)
    .where(scope)
    .orderBy(desc(browserPerformanceTelemetry.receivedAt))
    .limit(5000);

  // Count excluded hidden-tab samples so the UI can surface the exclusion.
  const hiddenSampleCount = rows.filter((row) => row.visibility === "hidden").length;

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.name}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const metrics = Array.from(groups.values()).map((group) => {
    // Filter rows per-metric according to the visibility policy.
    // Navigation percentiles use completed traces only so deadline caps do not right-censor p95.
    const eligible = group.filter(
      (row) => shouldIncludeForPercentile(row.kind, row.visibility) && isCompletedNavigationSample(row.kind, row.metadata),
    );
    const sorted = eligible.map((row) => Number(row.value)).filter(Number.isFinite).sort((a, b) => a - b);
    const pick = (pct: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * pct))] : null;
    // Ordinary experience = mean of best 95% (drop only the slowest 5%). Require n>=20 before trimming.
    const trimCount = sorted.length >= 20 ? Math.ceil(sorted.length * 0.05) : 0;
    const ordinary = trimCount > 0 ? sorted.slice(0, -trimCount) : sorted;
    const upperTrimmedMean95 = ordinary.length
      ? ordinary.reduce((sum, value) => sum + value, 0) / ordinary.length
      : null;
    return {
      kind: group[0].kind,
      name: group[0].name,
      count: eligible.length,
      upperTrimmedMean95,
      p50: pick(0.5),
      p95: pick(0.95),
      latestAt: eligible[0]?.receivedAt instanceof Date ? eligible[0].receivedAt.toISOString() : null,
    };
  }).filter((metric) => metric.count > 0).sort((a, b) => b.count - a.count).slice(0, 50);

  const recentDegradations = rows
    .filter((row) =>
      shouldIncludeForPercentile(row.kind, row.visibility)
      && isCompletedNavigationSample(row.kind, row.metadata)
      && exceedsBrowserBudget(row.kind, row.name, Number(row.value)))
    .slice(0, 20)
    .map((row) => ({
      kind: row.kind,
      name: row.name,
      value: Number(row.value),
      unit: row.unit,
      routeKey: row.routeKey,
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : new Date().toISOString(),
    }));

  const navigationRows = rows.filter((row) => row.kind === "navigation" && row.name === "spa_navigation" && shouldIncludeForPercentile(row.kind, row.visibility));
  const completedNavigationRows = navigationRows.filter((row) => isCompletedNavigationSample(row.kind, row.metadata));
  const navigationDurations = completedNavigationRows.map((row) => Number(row.value)).filter(Number.isFinite).sort((a, b) => a - b);
  const navigationPick = (pct: number) => navigationDurations.length
    ? navigationDurations[Math.min(navigationDurations.length - 1, Math.floor((navigationDurations.length - 1) * pct))]
    : null;
  const navigationTrim = navigationDurations.length >= 20 ? Math.ceil(navigationDurations.length * 0.05) : 0;
  const navigationOrdinary = navigationTrim > 0 ? navigationDurations.slice(0, -navigationTrim) : navigationDurations;
  const navigationUpperTrimmedMean95Ms = navigationOrdinary.length
    ? navigationOrdinary.reduce((sum, value) => sum + value, 0) / navigationOrdinary.length
    : null;
  const diagnosisCounts = Object.fromEntries(NAVIGATION_TRACE_DIAGNOSES.map((diagnosis) => [diagnosis, 0])) as Record<NavigationTraceDiagnosis, number>;
  const navigationIncidents: NavigationTraceIncident[] = [];
  for (const row of navigationRows) {
    const metadata = metadataRecord(row.metadata);
    const diagnosis = navigationDiagnosis(metadata);
    const outcome = navigationOutcome(metadata);
    diagnosisCounts[diagnosis] += 1;
    if (diagnosis === "healthy" && outcome === "completed") continue;
    navigationIncidents.push({
      traceId: metadataString(metadata, "traceId"),
      fromRoute: metadataString(metadata, "fromRoute"),
      toRoute: row.routeKey ?? "unknown",
      durationMs: Number(row.value),
      outcome,
      diagnosis,
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : new Date().toISOString(),
      evidence: {
        fallbackMs: optionalMetadataNumber(metadata, "fallbackMs"),
        lazyReadyMs: optionalMetadataNumber(metadata, "lazyReadyMs"),
        dataReadyMs: optionalMetadataNumber(metadata, "dataReadyMs"),
        firstCommitMs: optionalMetadataNumber(metadata, "firstCommitMs"),
        queriesActiveAtEnd: metadataNumber(metadata, "queriesActiveAtEnd"),
        peakQueries: metadataNumber(metadata, "peakQueries"),
        longTaskMaxMs: metadataNumber(metadata, "longTaskMaxMs"),
        slowFrameMaxMs: metadataNumber(metadata, "slowFrameMaxMs"),
        streamActiveMax: metadataNumber(metadata, "streamActiveMax"),
        streamSegmentsMax: metadataNumber(metadata, "streamSegmentsMax"),
      },
    });
    if (navigationIncidents.length >= 12) break;
  }

  const sampleHealth = rows.length === 0 ? "empty" : rows.length < 20 ? "thin" : "healthy";
  const completedCount = completedNavigationRows.length;

  return {
    generatedAt: Date.now(),
    windowHours: hours,
    rawRetentionDays: BROWSER_TELEMETRY_LIMITS.rawRetentionDays,
    sampleCount: rows.length,
    sampleHealth,
    budgets: BROWSER_TELEMETRY_BUDGETS,
    metrics,
    recentDegradations,
    navigationTraces: {
      count: navigationRows.length,
      completedCount,
      incompleteCount: navigationRows.length - completedCount,
      upperTrimmedMean95Ms: navigationUpperTrimmedMean95Ms,
      p50Ms: navigationPick(0.5),
      p95Ms: navigationPick(0.95),
      diagnosisCounts,
    },
    recentNavigationIncidents: navigationIncidents,
    hiddenSampleCount,
  };
}

export function logBrowserTelemetryIngestFailure(error: unknown): void {
  log.warn("browser telemetry ingestion failed", { error: error instanceof Error ? error.message : String(error) });
}
