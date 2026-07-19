export const BROWSER_TELEMETRY_ENDPOINT = "/api/browser-telemetry";

export const BROWSER_TELEMETRY_EVENT_KINDS = [
  "navigation",
  "web_vital",
  "chat_latency",
  "transport_gap",
  "long_task",
  "event_loop_responsiveness",
  "frame_contention",
] as const;

export type BrowserTelemetryEventKind = typeof BROWSER_TELEMETRY_EVENT_KINDS[number];

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
} as const;

export interface BrowserTelemetryMetricSummary {
  kind: BrowserTelemetryEventKind | string;
  name: string;
  count: number;
  p50: number | null;
  p95: number | null;
  latestAt: string | null;
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
}
