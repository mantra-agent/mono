import type { BrowserTelemetrySummary } from "./browser-telemetry";

export interface DbPoolResource {
  total: number;
  idle: number;
  waiting: number;
  saturatedForMs: number;
  lastProbeDurationMs: number | null;
  lastSuccessfulProbeAt: number | null;
  general?: { total: number; idle: number; waiting: number; max: number };
  voice?: { total: number; idle: number; waiting: number; max: number };
}

export interface InFlightResource {
  total: number;
  submitted: number;
  waiting: number;
  executing: number;
  highThreshold: number;
  bySubsystem: Record<string, number>;
}

export interface LongRunningQueryRow {
  subsystem: string;
  label: string | null;
  ageMs: number;
}

export interface LongRunningQueriesResource {
  thresholdMs: number;
  rows: LongRunningQueryRow[];
}

export interface SlowQueryResource {
  lastMinute: number;
  lastTenMinutes: number;
  lastSlowAt: number | null;
  lastSlowDurationMs: number | null;
  thresholdMs: number;
}

export interface ExecutorRunRow {
  runId: string;
  sessionId: string | null;
  model: string | null;
  activity: string | null;
  ageMs: number;
  aborted: boolean;
}

export interface ExecutorResource {
  activeRuns: number;
  runs: ExecutorRunRow[];
}

export interface AdmissionSlotRow {
  runId: string;
  tier: string;
  ageMs: number;
  yieldRequested: boolean;
}

export interface AdmissionResource {
  state: string;
  queueDepth: number;
  tierCounts: Record<string, number>;
  queuedByTier: Record<string, number>;
  slots: AdmissionSlotRow[];
}

export interface ZombieResource {
  active: number;
  peak: number;
}


export interface MemoryResource {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  maxMemoryBytes: number | null;
  maxMemoryMB: number | null;
  rssUsedPct: number | null;
  limitSource: string | null;
}

export interface EventLoopResource {
  currentMs: number;
  maxMs: number;
  avgMs: number;
}

export interface RealtimeTransportResource {
  eventSockets: number;
  peakEventSockets: number;
  sessionSockets: number;
  peakSessionSockets: number;
  sessionSocketLinks: number;
  peakSessionSocketLinks: number;
  uniqueSubscribedSessions: number;
  sessionOwnerLinks: number;
  staleSessionSocketLinks: number;
  pendingSubscribedSessions: number;
  liveSessions: number;
  streamingSessions: number;
  subscriptionDivergence: number;
  oldestEventSocketAgeMs: number;
  connectionsOpened: number;
  connectionsClosed: number;
  abnormalDisconnects: number;
}

export interface SystemResourcesData {
  generatedAt: number;
  dbPool: DbPoolResource;
  inFlight: InFlightResource;
  longRunningQueries: LongRunningQueriesResource;
  slowQueries: SlowQueryResource;
  executor: ExecutorResource;
  admission: AdmissionResource;
  zombies: ZombieResource;
  eventLoop: EventLoopResource;
  realtime: RealtimeTransportResource;
  memory: MemoryResource;
  divergence: {
    value: number;
    detail: string;
  };
  frontendExperience: BrowserTelemetrySummary | null;
}
