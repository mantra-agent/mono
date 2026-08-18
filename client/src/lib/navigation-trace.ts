import type { Query } from "@tanstack/react-query";
import type { NavigationTraceDiagnosis, NavigationTraceOutcome } from "@shared/browser-telemetry";
import { queryClient } from "@/lib/queryClient";

const TRACE_DEADLINE_MS = 15_000;
const COMMIT_SETTLE_GRACE_MS = 100;
const READY_COMMIT_GAP_MS = 250;
const MAIN_THREAD_TASK_MS = 75;
const MAIN_THREAD_FRAME_MS = 120;
const NAVIGATION_BUDGET_MS = 2_500;

/** Closed Home fetch identities — first queryKey segment only, never queryHash. */
const HOME_FEED_QUERY_IDENTITY = "/api/home/feed";
const HOME_LIBRARY_QUERY_IDENTITY = "/api/info/library";

interface TrackedQueryMeta {
  startedAt: number;
  firstKey: string | null;
}

interface NavigationTrace {
  id: string;
  fromRoute: string;
  toRoute: string;
  startedAt: number;
  startedAtEpochMs: number;
  fallbackAt?: number;
  lazyReadyAt?: number;
  lazyFailed: boolean;
  firstCommitAt?: number;
  queryStartedCount: number;
  querySettledCount: number;
  trackedQueries: Map<string, TrackedQueryMeta>;
  lastQuerySettledAt?: number;
  peakQueries: number;
  longTaskCount: number;
  longTaskMaxMs: number;
  longTaskTotalMs: number;
  slowFrameCount: number;
  slowFrameMaxMs: number;
  streamSubscribedMax: number;
  streamActiveMax: number;
  streamSegmentsMax: number;
  /** Settled durations for closed Home identities (ms). Absent until that identity settles. */
  homeFeedDurationMs?: number;
  libraryListDurationMs?: number;
  otherInitialQueryCount: number;
  deadlineTimer: number;
  settleTimer?: number;
}

export interface NavigationTraceTerminalEvent {
  id: string;
  fromRoute: string;
  toRoute: string;
  durationMs: number;
  outcome: NavigationTraceOutcome;
  diagnosis: NavigationTraceDiagnosis;
  metadata: Record<string, string | number | boolean>;
  occurredAt: string;
}

type TerminalListener = (event: NavigationTraceTerminalEvent) => void;

let initialized = false;
let activeTrace: NavigationTrace | null = null;
let lastKnownRoute = typeof window === "undefined" ? "/" : currentRoute();
let terminalListener: TerminalListener | null = null;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function currentRoute(): string {
  return `${window.location.pathname || "/"}`.slice(0, 120);
}

function routeFromUrl(url: string | URL | null | undefined): string {
  if (url == null) return currentRoute();
  try {
    return new URL(String(url), window.location.href).pathname.slice(0, 120) || "/";
  } catch {
    return currentRoute();
  }
}

function createTraceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `nav-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function beginNavigation(toRoute: string): void {
  const fromRoute = currentRoute();
  if (toRoute === fromRoute) return;
  if (activeTrace) finalizeNavigation("superseded");

  const startedAt = now();
  const trace: NavigationTrace = {
    id: createTraceId(),
    fromRoute,
    toRoute,
    startedAt,
    startedAtEpochMs: Date.now(),
    lazyFailed: false,
    queryStartedCount: 0,
    querySettledCount: 0,
    trackedQueries: new Map(),
    peakQueries: 0,
    longTaskCount: 0,
    longTaskMaxMs: 0,
    longTaskTotalMs: 0,
    slowFrameCount: 0,
    slowFrameMaxMs: 0,
    streamSubscribedMax: 0,
    streamActiveMax: 0,
    streamSegmentsMax: 0,
    otherInitialQueryCount: 0,
    deadlineTimer: window.setTimeout(() => finalizeNavigation("deadline"), TRACE_DEADLINE_MS),
  };
  activeTrace = trace;
  lastKnownRoute = toRoute;
}

function queryFirstKey(query: Query): string | null {
  const first = query.queryKey[0];
  return typeof first === "string" ? first.slice(0, 120) : null;
}

function homeAttributionMetadata(trace: NavigationTrace, endedAt: number): Record<string, number> {
  if (trace.toRoute !== "/home") return {};
  let homeFeedMs = typeof trace.homeFeedDurationMs === "number" ? trace.homeFeedDurationMs : -1;
  let libraryListMs = typeof trace.libraryListDurationMs === "number" ? trace.libraryListDurationMs : -1;
  let otherInitialQueryCount = trace.otherInitialQueryCount;
  // Still-pending tracked queries at finalize: count elapsed so far without naming raw keys.
  for (const meta of trace.trackedQueries.values()) {
    const elapsed = Math.max(0, endedAt - meta.startedAt);
    if (meta.firstKey === HOME_FEED_QUERY_IDENTITY) {
      if (homeFeedMs < 0) homeFeedMs = elapsed;
    } else if (meta.firstKey === HOME_LIBRARY_QUERY_IDENTITY) {
      if (libraryListMs < 0) libraryListMs = elapsed;
    } else {
      otherInitialQueryCount += 1;
    }
  }
  return { homeFeedMs, libraryListMs, otherInitialQueryCount };
}

function readinessAt(trace: NavigationTrace): number | undefined {
  if (trace.lazyFailed || trace.trackedQueries.size > 0) return undefined;
  const queryReadyAt = trace.queryStartedCount > 0 ? trace.lastQuerySettledAt : trace.startedAt;
  if (trace.fallbackAt && !trace.lazyReadyAt) return undefined;
  return Math.max(queryReadyAt ?? trace.startedAt, trace.lazyReadyAt ?? trace.startedAt);
}

function diagnose(trace: NavigationTrace, outcome: NavigationTraceOutcome, endedAt: number): NavigationTraceDiagnosis {
  const duration = endedAt - trace.startedAt;
  const readyAt = readinessAt(trace);
  const commitGap = trace.firstCommitAt && readyAt ? trace.firstCommitAt - readyAt : 0;

  if (trace.longTaskMaxMs >= MAIN_THREAD_TASK_MS || trace.slowFrameMaxMs >= MAIN_THREAD_FRAME_MS) {
    return "main_thread_contention";
  }
  if (trace.firstCommitAt && readyAt && commitGap >= READY_COMMIT_GAP_MS) {
    return "ready_but_uncommitted";
  }
  if (
    trace.lazyFailed ||
    trace.trackedQueries.size > 0 ||
    (trace.lazyReadyAt && trace.lazyReadyAt - trace.startedAt >= READY_COMMIT_GAP_MS) ||
    (trace.lastQuerySettledAt && trace.lastQuerySettledAt - trace.startedAt >= READY_COMMIT_GAP_MS)
  ) {
    return "network_or_query_delay";
  }
  if (outcome === "completed" && duration <= NAVIGATION_BUDGET_MS) return "healthy";
  return "incomplete_or_unknown";
}

function finalizeNavigation(outcome: NavigationTraceOutcome): void {
  const trace = activeTrace;
  if (!trace) return;
  activeTrace = null;
  window.clearTimeout(trace.deadlineTimer);
  if (trace.settleTimer) window.clearTimeout(trace.settleTimer);

  const endedAt = now();
  const durationMs = Math.max(0, endedAt - trace.startedAt);
  const readyAt = readinessAt(trace);
  const diagnosis = diagnose(trace, outcome, endedAt);
  terminalListener?.({
    id: trace.id,
    fromRoute: trace.fromRoute,
    toRoute: trace.toRoute,
    durationMs,
    outcome,
    diagnosis,
    occurredAt: new Date(trace.startedAtEpochMs).toISOString(),
    metadata: {
      traceId: trace.id,
      fromRoute: trace.fromRoute,
      outcome,
      diagnosis,
      fallbackMs: trace.fallbackAt ? trace.fallbackAt - trace.startedAt : -1,
      lazyReadyMs: trace.lazyReadyAt ? trace.lazyReadyAt - trace.startedAt : -1,
      lazyFailed: trace.lazyFailed,
      firstCommitMs: trace.firstCommitAt ? trace.firstCommitAt - trace.startedAt : -1,
      dataReadyMs: readyAt ? readyAt - trace.startedAt : -1,
      queryStartedCount: trace.queryStartedCount,
      querySettledCount: trace.querySettledCount,
      queriesActiveAtEnd: trace.trackedQueries.size,
      peakQueries: trace.peakQueries,
      longTaskCount: trace.longTaskCount,
      longTaskMaxMs: trace.longTaskMaxMs,
      longTaskTotalMs: trace.longTaskTotalMs,
      slowFrameCount: trace.slowFrameCount,
      slowFrameMaxMs: trace.slowFrameMaxMs,
      streamSubscribedMax: trace.streamSubscribedMax,
      streamActiveMax: trace.streamActiveMax,
      streamSegmentsMax: trace.streamSegmentsMax,
      ...homeAttributionMetadata(trace, endedAt),
    },
  });
}

function scheduleCompletedFinalization(): void {
  const trace = activeTrace;
  if (!trace?.firstCommitAt || trace.trackedQueries.size > 0) return;
  if (trace.settleTimer) window.clearTimeout(trace.settleTimer);
  trace.settleTimer = window.setTimeout(() => {
    if (activeTrace === trace && trace.firstCommitAt && trace.trackedQueries.size === 0) {
      finalizeNavigation("completed");
    }
  }, COMMIT_SETTLE_GRACE_MS);
}

function shouldTrackQuery(query: Query): boolean {
  const firstKey = query.queryKey[0];
  if (typeof firstKey !== "string") return true;
  return !firstKey.startsWith("/api/browser-telemetry");
}

/**
 * True when this fetch is a genuine first load that should gate navigation
 * readiness. Background refetches and interval pollers keep status "success"
 * (or "error") while fetchStatus cycles through "fetching"; those must not
 * hold the SPA navigation trace open until the 15s deadline.
 */
function isInitialLoadFetch(query: Query): boolean {
  return query.state.status === "pending";
}

function observeQueries(): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    const trace = activeTrace;
    const query = event?.query;
    if (!trace || !query || !shouldTrackQuery(query)) return;
    const queryHash = query.queryHash;
    if (query.state.fetchStatus === "fetching") {
      // Only genuine initial loads (no settled data yet) gate readiness.
      // App-wide pollers (executor status, env activity, wellness, comms, …)
      // refetch forever; tracking them made trackedQueries.size === 0 rare,
      // forced outcome=deadline, and mis-attributed unrelated long tasks /
      // slow frames as main_thread_contention while inflating peakQueries.
      if (isInitialLoadFetch(query) && !trace.trackedQueries.has(queryHash)) {
        const firstKey = queryFirstKey(query);
        trace.trackedQueries.set(queryHash, { startedAt: now(), firstKey });
        trace.queryStartedCount += 1;
        trace.peakQueries = Math.max(trace.peakQueries, trace.trackedQueries.size);
      }
      return;
    }
    const tracked = trace.trackedQueries.get(queryHash);
    if (tracked && trace.trackedQueries.delete(queryHash)) {
      const settledAt = now();
      const durationMs = Math.max(0, settledAt - tracked.startedAt);
      if (tracked.firstKey === HOME_FEED_QUERY_IDENTITY) {
        trace.homeFeedDurationMs = durationMs;
      } else if (tracked.firstKey === HOME_LIBRARY_QUERY_IDENTITY) {
        trace.libraryListDurationMs = durationMs;
      } else {
        trace.otherInitialQueryCount += 1;
      }
      trace.querySettledCount += 1;
      trace.lastQuerySettledAt = settledAt;
      scheduleCompletedFinalization();
    }
  });
}

function installHistoryObserver(): void {
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  window.history.pushState = ((state: unknown, unused: string, url?: string | URL | null) => {
    beginNavigation(routeFromUrl(url));
    return originalPushState(state, unused, url);
  }) as History["pushState"];

  window.history.replaceState = ((state: unknown, unused: string, url?: string | URL | null) => {
    beginNavigation(routeFromUrl(url));
    return originalReplaceState(state, unused, url);
  }) as History["replaceState"];

  window.addEventListener("popstate", () => {
    const toRoute = currentRoute();
    if (toRoute !== lastKnownRoute) {
      if (activeTrace) finalizeNavigation("superseded");
      const fromRoute = lastKnownRoute;
      const startedAt = now();
      const traceId = createTraceId();
      activeTrace = {
        id: traceId,
        fromRoute,
        toRoute,
        startedAt,
        startedAtEpochMs: Date.now(),
        lazyFailed: false,
        queryStartedCount: 0,
        querySettledCount: 0,
        trackedQueries: new Map(),
        peakQueries: 0,
        longTaskCount: 0,
        longTaskMaxMs: 0,
        longTaskTotalMs: 0,
        slowFrameCount: 0,
        slowFrameMaxMs: 0,
        streamSubscribedMax: 0,
        streamActiveMax: 0,
        streamSegmentsMax: 0,
        otherInitialQueryCount: 0,
        deadlineTimer: window.setTimeout(() => finalizeNavigation("deadline"), TRACE_DEADLINE_MS),
      };
      lastKnownRoute = toRoute;
    }
  });
}

export function initializeNavigationTracing(listener: TerminalListener): void {
  terminalListener = listener;
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  installHistoryObserver();
  observeQueries();
  window.addEventListener("pagehide", () => finalizeNavigation("pagehide"));
}

export function markNavigationFallback(): void {
  const trace = activeTrace;
  if (trace && !trace.fallbackAt) trace.fallbackAt = now();
}

export function markNavigationLazyReady(failed = false): void {
  const trace = activeTrace;
  if (!trace) return;
  trace.lazyReadyAt = trace.lazyReadyAt ?? now();
  trace.lazyFailed = trace.lazyFailed || failed;
  scheduleCompletedFinalization();
}

export function markNavigationDestinationCommit(route: string): void {
  const trace = activeTrace;
  if (!trace || trace.toRoute !== route.split("?")[0].split("#")[0]) return;
  trace.firstCommitAt = trace.firstCommitAt ?? now();
  lastKnownRoute = trace.toRoute;
  scheduleCompletedFinalization();
}

export function noteNavigationLongTask(durationMs: number): void {
  const trace = activeTrace;
  if (!trace) return;
  trace.longTaskCount += 1;
  trace.longTaskMaxMs = Math.max(trace.longTaskMaxMs, durationMs);
  trace.longTaskTotalMs += durationMs;
}

export function noteNavigationSlowFrame(durationMs: number): void {
  const trace = activeTrace;
  if (!trace) return;
  trace.slowFrameCount += 1;
  trace.slowFrameMaxMs = Math.max(trace.slowFrameMaxMs, durationMs);
}

export function noteNavigationStreamPressure(subscribed: number, active: number, maxSegments: number): void {
  const trace = activeTrace;
  if (!trace) return;
  trace.streamSubscribedMax = Math.max(trace.streamSubscribedMax, subscribed);
  trace.streamActiveMax = Math.max(trace.streamActiveMax, active);
  trace.streamSegmentsMax = Math.max(trace.streamSegmentsMax, maxSegments);
}
