import type { Query } from "@tanstack/react-query";
import type { NavigationTraceDiagnosis, NavigationTraceOutcome } from "@shared/browser-telemetry";
import { queryClient } from "@/lib/queryClient";

const TRACE_DEADLINE_MS = 15_000;
const COMMIT_SETTLE_GRACE_MS = 100;
const READY_COMMIT_GAP_MS = 250;
const MAIN_THREAD_TASK_MS = 75;
const MAIN_THREAD_FRAME_MS = 120;
const NAVIGATION_BUDGET_MS = 2_500;

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
  trackedQueries: Map<string, number>;
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
    deadlineTimer: window.setTimeout(() => finalizeNavigation("deadline"), TRACE_DEADLINE_MS),
  };
  activeTrace = trace;
  lastKnownRoute = toRoute;
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

function observeQueries(): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    const trace = activeTrace;
    const query = event?.query;
    if (!trace || !query || !shouldTrackQuery(query)) return;
    const queryHash = query.queryHash;
    if (query.state.fetchStatus === "fetching") {
      if (!trace.trackedQueries.has(queryHash)) {
        trace.trackedQueries.set(queryHash, now());
        trace.queryStartedCount += 1;
        trace.peakQueries = Math.max(trace.peakQueries, trace.trackedQueries.size);
      }
      return;
    }
    if (trace.trackedQueries.delete(queryHash)) {
      trace.querySettledCount += 1;
      trace.lastQuerySettledAt = now();
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
