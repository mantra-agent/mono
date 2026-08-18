export const BROWSER_TELEMETRY_ENDPOINT = "/api/browser-telemetry";

export const BROWSER_TELEMETRY_EVENT_KINDS = [
  "navigation",
  "web_vital",
  "chat_latency",
  "transport_gap",
  "long_task",
  "event_loop_responsiveness",
  "frame_contention",
  "graph",
  "features",
  "home",
] as const;

export type BrowserTelemetryEventKind = typeof BROWSER_TELEMETRY_EVENT_KINDS[number];

export const NAVIGATION_TRACE_DIAGNOSES = [
  "healthy",
  "network_or_query_delay",
  "main_thread_contention",
  "ready_but_uncommitted",
  "incomplete_or_unknown",
] as const;

export type NavigationTraceDiagnosis = typeof NAVIGATION_TRACE_DIAGNOSES[number];
export type NavigationTraceOutcome = "completed" | "deadline" | "pagehide" | "superseded";

export interface BrowserTelemetryEventInput {
  kind: BrowserTelemetryEventKind;
  name: string;
  value: number;
  unit: "ms" | "score" | "count" | "bytes";
  routeKey?: string;
  sessionId?: string;
  clientTurnId?: string;
  bucket?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
  /** Visibility state of the page at the moment the sample was captured.
   *  Omit only for browser environments that do not support document.visibilityState. */
  visibility?: "visible" | "hidden";
}

export interface BrowserTelemetryBatchInput {
  events: BrowserTelemetryEventInput[];
}

export const BROWSER_TELEMETRY_LIMITS = {
  maxBatchSize: 50,
  maxMetadataBytes: 1024,
  maxStringLength: 120,
  rawRetentionDays: 7,
} as const;


export const BROWSER_TELEMETRY_BUDGETS = {
  navigation: { p95Ms: 2500 },
  webVital: {
    lcpGoodMs: 2500,
    lcpPoorMs: 4000,
    inpGoodMs: 200,
    inpPoorMs: 500,
    clsGoodScore: 0.1,
    clsPoorScore: 0.25,
  },
  chatLatency: {
    submitToAckP95Ms: 1000,
    submitToFirstTokenP95Ms: 3000,
    submitToCompleteP95Ms: 20000,
  },
  transportGapP95Ms: 3000,
  longTaskP95Ms: 250,
  eventLoopResponsivenessP95Ms: 250,
  frameContentionP95Ms: 120,
  graph: {
    snapshotWarmP95Ms: 300,
    snapshotColdP95Ms: 750,
    payloadKb: 250,
    firstInteractiveDesktopMs: 1000,
    firstInteractiveMobileMs: 1500,
    initTaskMaxMs: 100,
    frameP95Ms: 33,
  },
  /** Features page — list + humming session chrome under load. */
  features: {
    listFetchP95Ms: 500,
    firstPaintP95Ms: 1000,
    sessionMatchP95Ms: 50,
    expandP95Ms: 400,
  },
  /** Home attribution — decision thresholds, not product SLOs. */
  home: {
    feedReadyMs: 2500,
    libraryListMs: 2500,
    feedRenderMs: 250,
    sectionCommitMs: 250,
    dwellLongTaskMs: 250,
    dwellSlowFrameMs: 120,
  },
} as const;

export interface BrowserTelemetryMetricSummary {
  kind: BrowserTelemetryEventKind | string;
  name: string;
  count: number;
  /**
   * Ordinary experience: mean after dropping only the slowest 5% of samples.
   * This is the health decision statistic (Pareto bulk), not the tail.
   */
  upperTrimmedMean95: number | null;
  p50: number | null;
  p95: number | null;
  latestAt: string | null;
}

export interface NavigationTraceAggregate {
  count: number;
  completedCount: number;
  incompleteCount: number;
  /** Ordinary experience: mean after dropping only the slowest 5% of completed traces. */
  upperTrimmedMean95Ms: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  diagnosisCounts: Record<NavigationTraceDiagnosis, number>;
}

export interface NavigationTraceIncident {
  traceId: string;
  fromRoute: string;
  toRoute: string;
  durationMs: number;
  outcome: NavigationTraceOutcome;
  diagnosis: NavigationTraceDiagnosis;
  occurredAt: string;
  evidence: {
    fallbackMs: number | null;
    lazyReadyMs: number | null;
    dataReadyMs: number | null;
    firstCommitMs: number | null;
    queriesActiveAtEnd: number;
    peakQueries: number;
    longTaskMaxMs: number;
    slowFrameMaxMs: number;
    streamActiveMax: number;
    streamSegmentsMax: number;
    /** Closed Home fetch identities on `/home` traces only (−1 = not initial-pending). */
    homeFeedMs?: number | null;
    libraryListMs?: number | null;
    otherInitialQueryCount?: number | null;
  };
}

export interface BrowserTelemetrySummary {
  generatedAt: number;
  windowHours: number;
  rawRetentionDays: number;
  sampleCount: number;
  sampleHealth: "empty" | "thin" | "healthy";
  budgets: typeof BROWSER_TELEMETRY_BUDGETS;
  metrics: BrowserTelemetryMetricSummary[];
  recentDegradations: Array<{ kind: string; name: string; value: number; unit: string; routeKey: string | null; occurredAt: string }>;
  navigationTraces: NavigationTraceAggregate;
  recentNavigationIncidents: NavigationTraceIncident[];
  /** Number of samples excluded from percentile calculations because visibility='hidden'.
   *  Zero when all samples are visible or untagged (NULL). */
  hiddenSampleCount: number;
}
