import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, SlidersHorizontal } from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/format-utils";
import { cn } from "@/lib/utils";
import { usePageHeader } from "@/hooks/use-page-header";
import {
  getSharedWSDiagnostics,
  subscribeSharedWSDiagnostics,
  type SharedWSDiagnostics,
} from "@/lib/ws-connection";
import type { SystemResourcesData } from "@shared/system-resources";
import type { BrowserTelemetrySummary } from "@shared/browser-telemetry";
import type { ContextHealthSummary } from "@shared/context-health";
import type {
  ReliabilityDomainKey,
  ReliabilityHealth,
  ReliabilityOutcomeMetrics,
  ReliabilityOutcomeSummary,
} from "@shared/reliability-outcomes";
import type { BuildDeploymentTimingSummary } from "@shared/models/build-deployments";
import {
  RESOURCES_REFRESH_INTERVAL_MS as REFRESH_INTERVAL_MS,
  FRONTEND_EXPERIENCE_REFRESH_INTERVAL_MS,
  CONTEXT_HEALTH_REFRESH_INTERVAL_MS,
  RELIABILITY_OUTCOMES_REFRESH_INTERVAL_MS,
  RESOURCES_STALE_AFTER_MS as STALE_AFTER_MS,
  RESOURCES_THRESHOLDS as THRESHOLDS,
} from "./resources-thresholds";

type Status = "ok" | "unknown" | "amber" | "red";

const RELIABILITY_DOMAINS: Array<{ key: ReliabilityDomainKey; label: string }> = [
  { key: "toolExecutions", label: "Tool executions" },
  { key: "planSteps", label: "Plan steps" },
  { key: "workflowRuns", label: "Workflow runs" },
  { key: "conversationalTurns", label: "Conversational turns" },
];

/** Page-level date range for every windowed metric on Performance. */
const PERFORMANCE_WINDOWS = [
  { hours: 24, label: "24h" },
  { hours: 168, label: "7d" },
  { hours: 720, label: "30d" },
] as const;

interface ConnectedAccountRow {
  accountId: string;
  provider: string;
  email?: string | null;
  label?: string | null;
  healthy?: boolean | null;
  healthError?: string | null;
  healthCheckedAt?: string | null;
  missingScopes?: string[] | null;
}

function reliabilityHealthStatus(health: ReliabilityHealth | "no_data" | undefined): Status {
  if (health === "critical" || health === "failing") return "red";
  if (health === "degraded") return "amber";
  if (!health || health === "no_data") return "unknown";
  return "ok";
}

function formatReliabilityRate(metric: ReliabilityOutcomeMetrics): string {
  return metric.successRate === null ? "No terminal data" : `${(metric.successRate * 100).toFixed(1)}%`;
}

function reliabilityMetricDetail(metric: ReliabilityOutcomeMetrics): ReactNode {
  const amberFailures = metric.amberFailures ?? 0;
  const unclassifiedErrors = metric.unclassifiedErrors ?? Math.max(0, metric.failed - amberFailures);
  return (
    <DetailList
      items={[
        `${metric.succeeded} succeeded · ${metric.failed} failed · ${metric.terminal} terminal`,
        `${amberFailures} ambers · ${unclassifiedErrors} errors`,
        metric.excluded > 0
          ? `${metric.excluded} nonterminal or excluded`
          : "No nonterminal or excluded outcomes",
        `Health: ${metric.health === "no_data" ? "no data" : metric.health}`,
      ]}
    />
  );
}

interface ResourcesResponse {
  processes: unknown[];
  failures?: string[];
  resources: SystemResourcesData | null;
}

interface DiagnosticData {
  buildMode: string;
  eventLoopLag: { current: number; avg: number; max: number };
  uptime: number;
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
    maxMemoryBytes?: number | null;
    maxMemoryMB?: number | null;
    rssUsedPct?: number | null;
    limitSource?: string | null;
  };
  system: {
    cpuCores: number;
    cpuLimitVcpus: number | null;
    cpuLimitSource: string | null;
    loadAvg: number[];
    totalMemory: number;
    freeMemory: number;
    platform: string;
    arch: string;
  };
  realtime: {
    cpu: { current: number | null; coreEquivalents: number; history: number[] };
    rss: { current: number; history: number[] };
    eventLoop: { current: number; history: number[] };
    rps: { current: number; history: number[] };
    wsConnections: number;
  };
  apiTimings: Array<{ route: string; method: string; avg: number; p95: number; count: number; errors: number }>;
  bootTiming: {
    phases: Array<{ name: string; durationMs: number }>;
    totalMs: number;
    bootedAt: string;
  } | null;
}

function statusRank(status: Status): number {
  if (status === "red") return 2;
  if (status === "amber") return 1;
  return 0;
}

function highestStatus(statuses: Status[]): Status {
  return statuses.reduce<Status>((highest, status) => (
    statusRank(status) > statusRank(highest) ? status : highest
  ), "ok");
}

function statusLabel(status: Status): string {
  if (status === "red") return "Critical";
  if (status === "amber") return "Attention";
  if (status === "unknown") return "Unavailable";
  return "Healthy";
}

function statusDot(status: Status): string {
  if (status === "red") return "bg-destructive";
  if (status === "amber") return "bg-warning";
  if (status === "unknown") return "bg-muted-foreground";
  return "bg-success";
}

function statusText(status: Status): string {
  if (status === "red") return "text-destructive";
  if (status === "amber") return "text-warning-foreground dark:text-warning";
  if (status === "unknown") return "text-muted-foreground";
  return "text-success";
}

function formatMs(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function formatRelative(ts: number | null, now: number): string {
  if (!ts) return "never";
  const diff = now - ts;
  if (diff < 1000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function cpuStatus(percent: number | null): Status {
  if (percent === null) return "unknown";
  if (percent >= 80) return "red";
  if (percent >= 50) return "amber";
  return "ok";
}

function memoryStatus(memory: SystemResourcesData["memory"]): Status {
  if (!memory.maxMemoryBytes) return "unknown";
  const ratio = memory.rss / memory.maxMemoryBytes;
  if (ratio >= 0.9) return "red";
  if (ratio >= 0.8) return "amber";
  return "ok";
}

function pingStatus(pingMs: number | null): Status {
  if (pingMs === null) return "ok";
  if (pingMs >= 500) return "red";
  if (pingMs >= 200) return "amber";
  return "ok";
}

function dbStatus(db: SystemResourcesData["dbPool"]): Status {
  if (db.waiting > THRESHOLDS.dbWaitingRed || db.saturatedForMs > THRESHOLDS.dbSaturatedRedMs) return "red";
  if (db.waiting >= THRESHOLDS.dbWaitingAmber) return "amber";
  return "ok";
}

function inFlightStatus(inFlight: SystemResourcesData["inFlight"]): Status {
  if (inFlight.total > inFlight.highThreshold) return "red";
  if (inFlight.total > inFlight.highThreshold * THRESHOLDS.inFlightAmberMultiplier) return "amber";
  return "ok";
}

function admissionStatus(admission: SystemResourcesData["admission"]): Status {
  if (admission.queueDepth >= THRESHOLDS.admissionQueueRed) return "red";
  if (admission.queueDepth >= THRESHOLDS.admissionQueueAmber) return "amber";
  return "ok";
}

function zombieStatus(zombies: SystemResourcesData["zombies"]): Status {
  if (zombies.active >= THRESHOLDS.zombieRed) return "red";
  if (zombies.active >= THRESHOLDS.zombieAmber) return "amber";
  return "ok";
}

function eventLoopStatus(eventLoop: SystemResourcesData["eventLoop"]): Status {
  if (eventLoop.currentMs >= THRESHOLDS.eventLoopRedMs || eventLoop.avgMs >= THRESHOLDS.eventLoopRedMs) return "red";
  if (eventLoop.currentMs >= THRESHOLDS.eventLoopAmberMs || eventLoop.avgMs >= THRESHOLDS.eventLoopAmberMs) return "amber";
  return "ok";
}

function slowQueryStatus(slowQueries: SystemResourcesData["slowQueries"]): Status {
  if (slowQueries.lastMinute >= THRESHOLDS.slowQueryRedPerMin) return "red";
  if (slowQueries.lastMinute >= THRESHOLDS.slowQueryAmberPerMin) return "amber";
  return "ok";
}

function isChatLatencyMetric(kind: string): boolean {
  return kind === "chat_latency";
}

function chatExperienceStatus(frontend: BrowserTelemetrySummary | null): Status {
  if (!frontend) return "unknown";
  const chatMetrics = sortChatMetrics(frontend.metrics.filter(metric => isChatLatencyMetric(metric.kind)));
  if (chatMetrics.length === 0) return "unknown";
  // Health = ordinary experience (mean of best 95%) vs target — not the tail.
  if (chatMetrics.some(metric => metric.upperTrimmedMean95 !== null && metric.upperTrimmedMean95 > frontendMetricBudget(frontend, metric.kind, metric.name))) {
    return "amber";
  }
  return "ok";
}

function frontendExperienceStatus(frontend: BrowserTelemetrySummary | null): Status {
  if (!frontend || frontend.sampleCount === 0) return "unknown";
  if (frontend.sampleHealth !== "healthy") return "amber";
  // Chat owns its own section; Frontend health is browser chrome only.
  if (frontend.metrics.some(metric => !isChatLatencyMetric(metric.kind) && metric.upperTrimmedMean95 !== null && metric.upperTrimmedMean95 > frontendMetricBudget(frontend, metric.kind, metric.name))) {
    return "amber";
  }
  if (frontend.navigationTraces.upperTrimmedMean95Ms !== null && frontend.navigationTraces.upperTrimmedMean95Ms > frontend.budgets.navigation.p95Ms) {
    return "amber";
  }
  return "ok";
}

function frontendMetricBudget(frontend: BrowserTelemetrySummary, kind: string, name: string): number {
  if (kind === "navigation") return frontend.budgets.navigation.p95Ms;
  if (kind === "web_vital") {
    const lower = name.toLowerCase();
    if (lower.includes("cls")) return frontend.budgets.webVital.clsGoodScore;
    if (lower.includes("inp")) return frontend.budgets.webVital.inpGoodMs;
    if (lower.includes("fid")) return frontend.budgets.webVital.inpGoodMs;
    return frontend.budgets.webVital.lcpGoodMs;
  }
  if (kind === "chat_latency") {
    if (name.includes("ack")) return frontend.budgets.chatLatency.submitToAckP95Ms;
    if (name.includes("complete")) return frontend.budgets.chatLatency.submitToCompleteP95Ms;
    // first_progress and first_token share the first-text target until a dedicated progress budget exists
    return frontend.budgets.chatLatency.submitToFirstTokenP95Ms;
  }
  if (kind === "transport_gap") return frontend.budgets.transportGapP95Ms;
  if (kind === "long_task") return frontend.budgets.longTaskP95Ms;
  if (kind === "event_loop_responsiveness") return frontend.budgets.eventLoopResponsivenessP95Ms;
  if (kind === "frame_contention") return frontend.budgets.frameContentionP95Ms;
  if (kind === "features") {
    if (name === "list_fetch") return frontend.budgets.features.listFetchP95Ms;
    if (name === "first_paint") return frontend.budgets.features.firstPaintP95Ms;
    if (name === "session_match") return frontend.budgets.features.sessionMatchP95Ms;
    if (name === "expand") return frontend.budgets.features.expandP95Ms;
  }
  return Number.POSITIVE_INFINITY;
}

/** Headline shows the decision measurement; color is measurement vs target. */
function againstTarget(value: number | null, target: number | null | undefined): Status {
  if (value === null || value === undefined || target === null || target === undefined || !Number.isFinite(target)) {
    return value === null || value === undefined ? "unknown" : "ok";
  }
  return value > target ? "amber" : "ok";
}

function contextHealthStatus(context: ContextHealthSummary | null): Status {
  // Context is diagnostic-only: presence of data, not provider latency, owns section color.
  if (!context || context.callCount === 0) return "unknown";
  return "ok";
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value >= 0.1 ? 1 : 2)}%`;
}

function formatUsageSemantics(value: string): string {
  return value.replace(/_/g, " ");
}

function formatExclusionReason(value: string): string {
  return value.replace(/_/g, " ");
}

function divergenceStatus(divergence: SystemResourcesData["divergence"]): Status {
  if (divergence.value >= THRESHOLDS.divergenceRed) return "red";
  if (divergence.value >= THRESHOLDS.divergenceAmber) return "amber";
  return "ok";
}

function executorStatus(executor: SystemResourcesData["executor"]): Status {
  return executor.runs.some(run => run.aborted) ? "red" : "ok";
}

function longRunningStatus(longRunningQueries: SystemResourcesData["longRunningQueries"]): Status {
  return longRunningQueries.rows.length > 0 ? "amber" : "ok";
}

function realtimeStatus(realtime: SystemResourcesData["realtime"]): Status {
  if (realtime.staleSessionSocketLinks > 0 || realtime.subscriptionDivergence > 0) return "red";
  return "ok";
}

function sharedWsStatus(diagnostics: SharedWSDiagnostics): Status {
  if (diagnostics.duplicateOwnerRefs > 0 || diagnostics.refCount !== diagnostics.ownerCount) return "red";
  if (diagnostics.refCount > 0 && diagnostics.physicalSockets === 0) return "amber";
  return "ok";
}

/** Row title = measurement only. Section owns the domain. */
function formatMetricTitle(kind: string, name: string): string {
  const key = `${kind}:${name}`.toLowerCase();
  const titles: Record<string, string> = {
    "chat_latency:submit_to_ack": "Ack",
    "chat_latency:submit_to_first_progress": "First progress",
    "chat_latency:submit_to_first_token": "First text",
    "frame_contention:slow_frame": "Slow frame",
    "long_task:main_thread_blocked": "Long task",
    "web_vital:lcp": "LCP",
    "web_vital:fid": "FID",
    "web_vital:cls": "CLS",
    "web_vital:inp": "INP",
    "transport_gap:reconnect": "Reconnect",
    "event_loop_responsiveness:timer_lag": "Timer lag",
    "navigation:spa_navigation": "Navigation",
    "graph:first_interactive": "First interactive",
    "graph:init_task": "Init task",
    "graph:layout_settled": "Layout settled",
    "features:list_fetch": "List fetch",
    "features:first_paint": "First paint",
    "features:session_match": "Session match",
    "features:active_sessions": "Active sessions",
    "features:row_count": "Row count",
    "features:expand": "Expand",
  };
  if (titles[key]) return titles[key];
  // Fallback: measurement name only — never re-prefix the kind (section already names the domain).
  return name.replace(/_/g, " ");
}

const CHAT_METRIC_ORDER = [
  "submit_to_ack",
  "submit_to_first_progress",
  "submit_to_first_token",
] as const;

function sortChatMetrics<T extends { name: string }>(metrics: T[]): T[] {
  return [...metrics]
    .filter((metric) => metric.name !== "submit_to_complete")
    .sort((a, b) => {
      const ai = CHAT_METRIC_ORDER.indexOf(a.name as (typeof CHAT_METRIC_ORDER)[number]);
      const bi = CHAT_METRIC_ORDER.indexOf(b.name as (typeof CHAT_METRIC_ORDER)[number]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
}

function chatMetricDefinition(name: string): string {
  if (name === "submit_to_ack") return "Send → server acceptance";
  if (name === "submit_to_first_progress") return "Send → first visible thinking, tool use, or assistant text";
  if (name === "submit_to_first_token") return "Send → first visible assistant text";
  return "Browser-observed chat latency";
}

function formatConnectorProvider(provider: string): string {
  return provider
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function connectorStatus(account: ConnectedAccountRow): Status {
  if (account.healthy === false) return "red";
  if (account.healthy === true) return "ok";
  return "unknown";
}

function connectorLabel(account: ConnectedAccountRow): string {
  const provider = formatConnectorProvider(account.provider);
  const identity = account.email || account.label || account.accountId;
  return identity ? `${provider} · ${identity}` : provider;
}

function connectorsSectionStatus(accounts: ConnectedAccountRow[] | undefined): Status {
  if (!accounts || accounts.length === 0) return "unknown";
  if (accounts.some((account) => account.healthy === false)) return "red";
  if (accounts.every((account) => account.healthy === true)) return "ok";
  return "amber";
}

function formatNavigationDiagnosis(value: string): string {
  return value.replace(/_/g, " ");
}

function formatFrontendMetricValue(kind: string, name: string, value: number | null): string {
  if (value === null) return "—";
  if (kind === "web_vital" && name.toLowerCase().includes("cls")) return value.toFixed(3);
  return formatMs(value);
}

function wsStateLabel(readyState: number): string {
  if (readyState === WebSocket.CONNECTING) return "connecting";
  if (readyState === WebSocket.OPEN) return "open";
  if (readyState === WebSocket.CLOSING) return "closing";
  return "closed";
}

function StatusValue({ status, value }: { status: Status; value?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center justify-end gap-1.5 tabular-nums", statusText(status))}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", statusDot(status))} aria-hidden="true" />
      <span className="truncate">{value ?? statusLabel(status)}</span>
    </span>
  );
}

function NeutralValue({ children }: { children: ReactNode }) {
  return <span className="truncate text-muted-foreground tabular-nums">{children}</span>;
}

function TreeChildren({ children }: { children: ReactNode }) {
  return (
    <div className="ml-0.5 border-l border-border pl-2 @sm:ml-1 @sm:pl-3">
      {children}
    </div>
  );
}

function MetricRow({
  label,
  value,
  status,
  detail,
  testId,
}: {
  label: ReactNode;
  value: string;
  status?: Status;
  detail?: ReactNode;
  testId?: string;
}) {
  return (
    <ProfileTreeRow
      label={label}
      hasValue
      showEmpty
      expandedContent={detail}
      testId={testId}
      mobileLayout="inline"
      valueLayout="compact"
    >
      {status ? <StatusValue status={status} value={value} /> : <NeutralValue>{value}</NeutralValue>}
    </ProfileTreeRow>
  );
}

function PerformanceSection({
  label,
  status,
  children,
  testId,
  defaultOpen,
}: {
  label: string;
  status: Status;
  children: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? status !== "ok");

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid={testId}
      className="[content-visibility:auto] [contain-intrinsic-size:auto_320px]"
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover-elevate">
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{label}</span>
        <span
          className={cn("ml-auto h-1.5 w-1.5 shrink-0 rounded-full", statusDot(status))}
          aria-label={`${label} ${statusLabel(status)}`}
          title={statusLabel(status)}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <TreeChildren>{children}</TreeChildren>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DetailText({ children }: { children: ReactNode }) {
  return <div className="break-words text-muted-foreground">{children}</div>;
}

function DetailList({ items }: { items: string[] }) {
  return (
    <div className="space-y-1 text-muted-foreground">
      {items.map(item => <div key={item}>{item}</div>)}
    </div>
  );
}

function formatDeploymentDuration(ms: number | null): string {
  if (!ms) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 60 ? `${minutes + 1}m` : `${minutes}m ${seconds}s`;
}

function BuildDeploymentDetail({
  environment,
}: {
  environment: BuildDeploymentTimingSummary["environments"][number];
}) {
  const recentSamples = environment.samples.slice(0, 10).reverse();
  const maxDuration = Math.max(...recentSamples.map(sample => sample.durationMs), 1);

  return (
    <div className="space-y-2 text-muted-foreground">
      <div>
        Median {formatDeploymentDuration(environment.medianDurationMs)} · {environment.sampleCount} deployment{environment.sampleCount === 1 ? "" : "s"} in 30 days
      </div>
      <div
        className="flex h-11 items-end gap-1"
        aria-label={`Recent deployment durations for ${environment.environmentName}`}
      >
        {recentSamples.map(sample => (
          <div
            key={sample.observationId}
            className="min-w-1 flex-1 rounded-sm bg-muted-foreground/40"
            style={{ height: `${Math.max(10, Math.round((sample.durationMs / maxDuration) * 100))}%` }}
            title={`${formatDeploymentDuration(sample.durationMs)} · ${new Date(sample.deployedAt).toLocaleString()}`}
          />
        ))}
      </div>
    </div>
  );
}

export default function PerformancePage() {
  usePageHeader({ title: "Performance" });
  const [windowHours, setWindowHours] = useState(24);
  const windowLabel = PERFORMANCE_WINDOWS.find((window) => window.hours === windowHours)?.label ?? `${windowHours}h`;
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery<ResourcesResponse>({
    queryKey: ["/api/gateway/processes", "resources"],
    retry: false,
    retryOnMount: false,
    queryFn: async () => {
      const res = await fetch("/api/gateway/processes", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const { data: feData } = useQuery<{ frontendExperience: BrowserTelemetrySummary | null }>({
    queryKey: ["/api/gateway/frontend-experience", windowHours],
    queryFn: async () => {
      const res = await fetch(`/api/gateway/frontend-experience?hours=${windowHours}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: FRONTEND_EXPERIENCE_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const { data: contextData } = useQuery<{ contextHealth: ContextHealthSummary }>({
    queryKey: ["/api/gateway/context-health", windowHours],
    queryFn: async () => {
      const res = await fetch(`/api/gateway/context-health?hours=${windowHours}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: CONTEXT_HEALTH_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const {
    data: reliability,
    isLoading: reliabilityLoading,
    isError: reliabilityError,
  } = useQuery<ReliabilityOutcomeSummary>({
    queryKey: ["/api/performance/reliability", windowHours],
    queryFn: async () => {
      const res = await fetch(`/api/performance/reliability?hours=${windowHours}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: RELIABILITY_OUTCOMES_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });

  const { data: connectorsData, isLoading: connectorsLoading, isError: connectorsError } = useQuery<{
    accounts: ConnectedAccountRow[];
  }>({
    queryKey: ["/api/connected-accounts", "performance"],
    queryFn: async () => {
      const res = await fetch("/api/connected-accounts", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  const {
    data: buildDeploymentTimings,
    isLoading: buildDeploymentTimingsLoading,
    isError: buildDeploymentTimingsError,
  } = useQuery<BuildDeploymentTimingSummary>({
    queryKey: ["/api/performance/build-deployments"],
    queryFn: async () => {
      const res = await fetch("/api/performance/build-deployments", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-4 @sm:p-6">
          <div className="mx-auto max-w-5xl space-y-2">
            <Skeleton className="h-9 rounded-md" />
            <Skeleton className="h-9 rounded-md" />
            <Skeleton className="h-9 rounded-md" />
            <Skeleton className="h-9 rounded-md" />
          </div>
        </div>
      </div>
    );
  }

  if (isError || !data?.resources) {
    const msg = error instanceof Error ? error.message : data?.failures?.join("; ") || "Resources unavailable";
    return (
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto p-4 @sm:p-6">
          <div
            className="mx-auto flex max-w-5xl items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/5 p-4"
            data-testid="resources-error-state"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-destructive">Couldn't load system resources</p>
              <p className="mt-1 break-words text-xs text-muted-foreground" data-testid="text-resources-error">{msg}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const now = Date.now();
  return (
    <ResourcesView
      resources={data.resources}
      frontendExperience={feData?.frontendExperience ?? null}
      contextHealth={contextData?.contextHealth ?? null}
      reliability={reliability ?? null}
      windowHours={windowHours}
      windowLabel={windowLabel}
      onWindowHoursChange={setWindowHours}
      reliabilityLoading={reliabilityLoading}
      reliabilityError={reliabilityError}
      connectors={connectorsData?.accounts ?? []}
      connectorsLoading={connectorsLoading}
      connectorsError={connectorsError}
      buildDeploymentTimings={buildDeploymentTimings ?? null}
      buildDeploymentTimingsLoading={buildDeploymentTimingsLoading}
      buildDeploymentTimingsError={buildDeploymentTimingsError}
      failures={data.failures}
      now={now}
      isStale={dataUpdatedAt > 0 && now - dataUpdatedAt > STALE_AFTER_MS}
    />
  );
}

function ResourcesView({
  resources: r,
  frontendExperience,
  contextHealth,
  reliability,
  windowHours,
  windowLabel,
  onWindowHoursChange,
  reliabilityLoading,
  reliabilityError,
  connectors,
  connectorsLoading,
  connectorsError,
  buildDeploymentTimings,
  buildDeploymentTimingsLoading,
  buildDeploymentTimingsError,
  failures,
  now,
  isStale,
}: {
  resources: SystemResourcesData;
  frontendExperience: BrowserTelemetrySummary | null;
  contextHealth: ContextHealthSummary | null;
  reliability: ReliabilityOutcomeSummary | null;
  windowHours: number;
  windowLabel: string;
  onWindowHoursChange: (hours: number) => void;
  reliabilityLoading: boolean;
  reliabilityError: boolean;
  connectors: ConnectedAccountRow[];
  connectorsLoading: boolean;
  connectorsError: boolean;
  buildDeploymentTimings: BuildDeploymentTimingSummary | null;
  buildDeploymentTimingsLoading: boolean;
  buildDeploymentTimingsError: boolean;
  failures?: string[];
  now: number;
  isStale: boolean;
}) {
  const clientWs = useSyncExternalStore(
    subscribeSharedWSDiagnostics,
    getSharedWSDiagnostics,
    getSharedWSDiagnostics,
  );
  const [pingMs, setPingMs] = useState<number | null>(null);
  const activeConnectors = useMemo(
    () => [...connectors].sort((a, b) => {
      const providerCmp = a.provider.localeCompare(b.provider);
      if (providerCmp !== 0) return providerCmp;
      return connectorLabel(a).localeCompare(connectorLabel(b));
    }),
    [connectors],
  );

  const { data: diagData } = useQuery<DiagnosticData>({
    queryKey: ["/api/diagnostics/performance"],
    refetchInterval: 3000,
  });

  useEffect(() => {
    let mounted = true;
    const measurePing = async () => {
      try {
        const start = performance.now();
        await fetch("/api/health", { cache: "no-store" });
        if (mounted) setPingMs(Math.round(performance.now() - start));
      } catch {
        if (mounted) setPingMs(null);
      }
    };
    measurePing();
    const id = setInterval(measurePing, 3000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  const cpuPercent = diagData?.realtime.cpu.current ?? null;
  const serviceStatuses: Status[] = [
    eventLoopStatus(r.eventLoop),
    memoryStatus(r.memory),
    isStale ? "amber" : "ok",
    failures?.length ? "amber" : "ok",
  ];
  if (diagData) serviceStatuses.push(cpuStatus(cpuPercent), pingStatus(pingMs));
  const serviceStatus = highestStatus(serviceStatuses);

  const workStatuses: Status[] = [
    dbStatus(r.dbPool),
    inFlightStatus(r.inFlight),
    admissionStatus(r.admission),
    slowQueryStatus(r.slowQueries),
    longRunningStatus(r.longRunningQueries),
    executorStatus(r.executor),
    zombieStatus(r.zombies),
    divergenceStatus(r.divergence),
  ];
  const workStatus = highestStatus(workStatuses);
  const transportStatus = realtimeStatus(r.realtime);
  const browserStatus = sharedWsStatus(clientWs);
  const realtimeBranchStatus = highestStatus([transportStatus, browserStatus]);
  const chatStatus = chatExperienceStatus(frontendExperience);
  const frontendStatus = frontendExperienceStatus(frontendExperience);
  const contextStatus = contextHealthStatus(contextHealth);
  const chatMetrics = frontendExperience
    ? sortChatMetrics(frontendExperience.metrics.filter(metric => isChatLatencyMetric(metric.kind)))
    : [];
  const frontendMetrics = frontendExperience
    ? frontendExperience.metrics.filter(metric => !isChatLatencyMetric(metric.kind)).slice(0, 8)
    : [];
  const reliabilityStatus: Status = reliabilityError
    ? "red"
    : reliability
      ? reliabilityHealthStatus(reliability.health)
      : "unknown";
  const connectorsStatus = connectorsError
    ? "red"
    : connectorsLoading
      ? "unknown"
      : connectorsSectionStatus(connectors);

  const memoryPercent = r.memory.maxMemoryBytes
    ? r.memory.rssUsedPct ?? Math.round((r.memory.rss / r.memory.maxMemoryBytes) * 1000) / 10
    : null;
  const inFlightSubsystems = Object.entries(r.inFlight.bySubsystem)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => `${name}: ${value}`);
  const admissionTiers = Object.entries(r.admission.tierCounts)
    .filter(([, value]) => value > 0)
    .map(([tier, value]) => `${tier}: ${value}`);
  const queuedTiers = Object.entries(r.admission.queuedByTier)
    .filter(([, value]) => value > 0)
    .map(([tier, value]) => `${tier}: ${value} queued`);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin @sm:p-6">
        <div className="mx-auto max-w-5xl space-y-1">
          <div className="mb-2 flex items-center gap-2 px-1" data-testid="performance-filter-bar">
            <div className="min-w-0 flex-1 text-sm text-muted-foreground">
              Window · {windowLabel}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" data-testid="button-performance-mixer">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Mixer
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="menu-performance-date-range">Date range</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={String(windowHours)}
                      onValueChange={(value) => onWindowHoursChange(Number(value))}
                    >
                      {PERFORMANCE_WINDOWS.map(({ hours, label }) => (
                        <DropdownMenuRadioItem
                          key={hours}
                          value={String(hours)}
                          data-testid={`menu-performance-window-${hours}`}
                        >
                          {label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <PerformanceSection
            label="Service"
            status={serviceStatus}
            testId="section-service"
          >
                {isStale && (
                  <MetricRow
                    label="Data freshness"
                    value="Stale"
                    status="amber"
                    detail={<DetailText>Resource data is older than {Math.round(STALE_AFTER_MS / 1000)} seconds.</DetailText>}
                    testId="badge-stale"
                  />
                )}

                {failures && failures.length > 0 && (
                  <MetricRow
                    label="Collection failures"
                    value={`${failures.length} partial`}
                    status="amber"
                    detail={<DetailList items={failures} />}
                    testId="resources-partial-failure-banner"
                  />
                )}

                  {diagData && (
                    <MetricRow
                      label="CPU"
                      value={cpuPercent === null ? "Unavailable" : `${cpuPercent}%`}
                      status={cpuStatus(cpuPercent)}
                      detail={(
                        <DetailText>
                          {diagData.realtime.cpu.coreEquivalents} vCPU used
                          {diagData.system.cpuLimitVcpus !== null ? ` / ${diagData.system.cpuLimitVcpus} available` : " · allocation unavailable"}
                          {diagData.system.cpuLimitSource ? ` (${diagData.system.cpuLimitSource})` : ""}
                          {` · load ${diagData.system.loadAvg.join(" / ")}`}
                        </DetailText>
                      )}
                      testId="text-cpu-usage"
                    />
                  )}
                  <MetricRow
                    label="Memory"
                    value={memoryPercent === null ? formatBytes(r.memory.rss) : `${memoryPercent}%`}
                    status={memoryStatus(r.memory)}
                    detail={(
                      <DetailText>
                        RSS {formatBytes(r.memory.rss)} · heap {formatBytes(r.memory.heapUsed)} / {formatBytes(r.memory.heapTotal)}
                        {r.memory.maxMemoryBytes ? ` · limit ${formatBytes(r.memory.maxMemoryBytes)} (${r.memory.limitSource ?? "unknown"})` : " · watchdog limit unavailable"}
                      </DetailText>
                    )}
                    testId="text-memory-usage"
                  />
                  <MetricRow
                    label="Event loop"
                    value={formatMs(r.eventLoop.currentMs)}
                    status={eventLoopStatus(r.eventLoop)}
                    detail={<DetailText>Average {formatMs(r.eventLoop.avgMs)} · peak {formatMs(r.eventLoop.maxMs)}</DetailText>}
                    testId="text-event-loop-lag"
                  />
                  {diagData && (
                    <>
                      <MetricRow
                        label="Requests"
                        value={`${diagData.realtime.rps.current}/s`}
                        detail={<DetailText>Current request throughput.</DetailText>}
                        testId="text-rps"
                      />
                      <MetricRow
                        label="Ping"
                        value={pingMs === null ? "Measuring" : `${pingMs}ms`}
                        status={pingStatus(pingMs)}
                        detail={<DetailText>Round trip from this browser to the service health endpoint.</DetailText>}
                        testId="text-ping"
                      />
                      <MetricRow
                        label="Uptime"
                        value={formatUptime(diagData.uptime)}
                        detail={<DetailText>{diagData.buildMode} · {diagData.system.platform} {diagData.system.arch}</DetailText>}
                        testId="text-uptime"
                      />
                    </>
                  )}
          </PerformanceSection>

          <PerformanceSection
            label="Work"
            status={workStatus}
            testId="section-work"
          >
                  <MetricRow
                    label="Database"
                    value={`${r.dbPool.waiting} waiting`}
                    status={dbStatus(r.dbPool)}
                    detail={(
                      <DetailText>
                        {r.dbPool.total} total · {r.dbPool.idle} idle
                        {r.dbPool.general && r.dbPool.voice ? ` · general ${r.dbPool.general.total}/${r.dbPool.general.idle}/${r.dbPool.general.waiting} · voice ${r.dbPool.voice.total}/${r.dbPool.voice.idle}/${r.dbPool.voice.waiting}` : ""}
                        {r.dbPool.saturatedForMs > 0 ? ` · saturated ${formatMs(r.dbPool.saturatedForMs)}` : ""}
                      </DetailText>
                    )}
                    testId="tile-db-pool"
                  />
                  <MetricRow
                    label="In-flight"
                    value={String(r.inFlight.total)}
                    status={inFlightStatus(r.inFlight)}
                    detail={<DetailList items={[`High threshold: ${r.inFlight.highThreshold}`, ...(inFlightSubsystems.length ? inFlightSubsystems : ["No active query subsystems."])]} />}
                    testId="tile-in-flight"
                  />
                  <MetricRow
                    label="Queue"
                    value={`${r.admission.queueDepth} queued`}
                    status={admissionStatus(r.admission)}
                    detail={(
                      <DetailList
                        items={[
                          `State: ${r.admission.state}`,
                          ...(admissionTiers.length ? admissionTiers : ["No occupied slots."]),
                          ...queuedTiers,
                          ...r.admission.slots.map(slot => `${slot.tier} · ${formatMs(slot.ageMs)} · ${slot.runId}${slot.yieldRequested ? " · yield requested" : ""}`),
                        ]}
                      />
                    )}
                    testId="tile-admission"
                  />
                  <MetricRow
                    label="Runs"
                    value={String(r.executor.activeRuns)}
                    status={executorStatus(r.executor)}
                    detail={(
                      <DetailList
                        items={r.executor.runs.length
                          ? [...r.executor.runs]
                            .sort((a, b) => b.ageMs - a.ageMs)
                            .map(run => `${run.activity ?? "Run"} · ${run.model ?? "model unknown"} · ${formatMs(run.ageMs)} · ${run.aborted ? "aborted" : "running"} · ${run.runId}`)
                          : ["No active runs."]}
                      />
                    )}
                    testId="tile-executor"
                  />
                  <MetricRow
                    label="Slow queries"
                    value={`${r.slowQueries.lastMinute} / min`}
                    status={slowQueryStatus(r.slowQueries)}
                    detail={(
                      <DetailList
                        items={[
                          `${r.slowQueries.lastTenMinutes} in 10m · last ${r.slowQueries.lastSlowDurationMs ? formatMs(r.slowQueries.lastSlowDurationMs) : "—"} ${formatRelative(r.slowQueries.lastSlowAt, now)}`,
                          r.slowQueries.lastQueryFingerprint
                            ? `fingerprint ${r.slowQueries.lastQueryFingerprint}`
                            : "fingerprint —",
                          r.slowQueries.lastSqlSnippet
                            ? `sql ${r.slowQueries.lastSqlSnippet}`
                            : "sql —",
                        ]}
                      />
                    )}
                    testId="tile-slow-queries"
                  />
                  <MetricRow
                    label="Long queries"
                    value={String(r.longRunningQueries.rows.length)}
                    status={longRunningStatus(r.longRunningQueries)}
                    detail={(
                      <DetailList
                        items={r.longRunningQueries.rows.length
                          ? r.longRunningQueries.rows.map(row => {
                              const fp = row.queryFingerprint ? ` · ${row.queryFingerprint}` : "";
                              const sql = row.sqlSnippet ? ` · ${row.sqlSnippet}` : "";
                              return `${row.subsystem} · ${row.label ?? "unlabelled"} · ${formatMs(row.ageMs)}${fp}${sql}`;
                            })
                          : [`No queries over ${formatMs(r.longRunningQueries.thresholdMs)}.`]}
                      />
                    )}
                    testId="card-long-running-queries"
                  />
                  <MetricRow
                    label="Zombies"
                    value={String(r.zombies.active)}
                    status={zombieStatus(r.zombies)}
                    detail={<DetailText>Peak since boot: {r.zombies.peak}</DetailText>}
                    testId="tile-zombies"
                  />
                  <MetricRow
                    label="Drift"
                    value={String(r.divergence.value)}
                    status={divergenceStatus(r.divergence)}
                    detail={<DetailText>{r.divergence.detail}</DetailText>}
                    testId="tile-divergence"
                  />
          </PerformanceSection>

          <PerformanceSection
            label="Chat"
            status={chatStatus}
            testId="section-chat-latency"
          >
                  {frontendExperience && chatMetrics.length > 0 ? (
                    chatMetrics.map(metric => {
                      const budget = frontendMetricBudget(frontendExperience, metric.kind, metric.name);
                      return (
                        <MetricRow
                          key={`${metric.kind}:${metric.name}`}
                          label={formatMetricTitle(metric.kind, metric.name)}
                          value={formatFrontendMetricValue(metric.kind, metric.name, metric.upperTrimmedMean95)}
                          status={againstTarget(metric.upperTrimmedMean95, budget)}
                          detail={(
                            <DetailList
                              items={[
                                chatMetricDefinition(metric.name),
                                `Browser-observed Chat telemetry · ${frontendExperience.windowHours}h window`,
                                `Ordinary experience (mean of best 95%) vs target ${formatFrontendMetricValue(metric.kind, metric.name, budget)}`,
                                metric.count < 20
                                  ? `n=${metric.count} · fewer than 20 samples; no slow samples trimmed`
                                  : `n=${metric.count} · slowest ${Math.ceil(metric.count * 0.05)} sample(s) excluded`,
                                `p50 ${formatFrontendMetricValue(metric.kind, metric.name, metric.p50)} · p95 ${formatFrontendMetricValue(metric.kind, metric.name, metric.p95)}`,
                                `latest ${formatRelative(metric.latestAt ? new Date(metric.latestAt).getTime() : null, now)}`,
                              ]}
                            />
                          )}
                          testId={`tile-chat-${metric.name}`}
                        />
                      );
                    })
                  ) : (
                    <MetricRow
                      label="Summary"
                      value="Unavailable"
                      status="unknown"
                      detail={<DetailText>No chat latency samples in this window.</DetailText>}
                      testId="tile-chat-summary"
                    />
                  )}
          </PerformanceSection>

          <PerformanceSection
            label="Frontend"
            status={frontendStatus}
            testId="section-frontend-experience"
          >
                  {frontendExperience ? (
                    <>
                      <MetricRow
                        label="Samples"
                        value={`${frontendExperience.sampleHealth} · ${frontendExperience.sampleCount}`}
                        status={frontendExperience.sampleCount === 0 ? "unknown" : frontendExperience.sampleHealth === "healthy" ? "ok" : "amber"}
                        detail={<DetailText>{frontendExperience.windowHours}h window · raw retention {frontendExperience.rawRetentionDays}d · {frontendExperience.hiddenSampleCount} hidden-tab samples filtered where throttling invalidates the metric · same summary used by system.frontend_performance.</DetailText>}
                        testId="tile-frontend-sample-health"
                      />
                      {frontendMetrics.map(metric => {
                        const budget = frontendMetricBudget(frontendExperience, metric.kind, metric.name);
                        return (
                          <MetricRow
                            key={`${metric.kind}:${metric.name}`}
                            label={formatMetricTitle(metric.kind, metric.name)}
                            value={formatFrontendMetricValue(metric.kind, metric.name, metric.upperTrimmedMean95)}
                            status={againstTarget(metric.upperTrimmedMean95, budget)}
                            detail={(
                              <DetailList
                                items={[
                                  `Ordinary experience (mean of best 95%) vs target ${formatFrontendMetricValue(metric.kind, metric.name, budget)}`,
                                  metric.count < 20
                                    ? `n=${metric.count} · fewer than 20 samples; no slow samples trimmed`
                                    : `n=${metric.count} · slowest ${Math.ceil(metric.count * 0.05)} sample(s) excluded`,
                                  `p50 ${formatFrontendMetricValue(metric.kind, metric.name, metric.p50)} · p95 ${formatFrontendMetricValue(metric.kind, metric.name, metric.p95)}`,
                                  `latest ${formatRelative(metric.latestAt ? new Date(metric.latestAt).getTime() : null, now)}`,
                                ]}
                              />
                            )}
                          />
                        );
                      })}
                      <MetricRow
                        label="Navigation"
                        value={formatFrontendMetricValue("navigation", "spa_navigation", frontendExperience.navigationTraces.upperTrimmedMean95Ms)}
                        status={frontendExperience.navigationTraces.incompleteCount > 0
                          ? "amber"
                          : againstTarget(frontendExperience.navigationTraces.upperTrimmedMean95Ms, frontendExperience.budgets.navigation.p95Ms)}
                        detail={(
                          <DetailList
                            items={[
                              `Ordinary experience (mean of best 95%) vs target ${formatMs(frontendExperience.budgets.navigation.p95Ms)}`,
                              `p50 ${formatFrontendMetricValue("navigation", "spa_navigation", frontendExperience.navigationTraces.p50Ms)} · p95 ${formatFrontendMetricValue("navigation", "spa_navigation", frontendExperience.navigationTraces.p95Ms)}`,
                              `${frontendExperience.navigationTraces.count} traces · ${frontendExperience.navigationTraces.completedCount} completed · ${frontendExperience.navigationTraces.incompleteCount} incomplete`,
                              ...Object.entries(frontendExperience.navigationTraces.diagnosisCounts).map(([diagnosis, count]) => `${formatNavigationDiagnosis(diagnosis)}: ${count}`),
                            ]}
                          />
                        )}
                        testId="tile-navigation-health"
                      />
                      <MetricRow
                        label="History"
                        value={String(frontendExperience.recentDegradations.length)}
                        status="ok"
                        detail={(
                          <DetailList
                            items={frontendExperience.recentDegradations.length
                              ? [
                                "Informational history only; each metric row colors against its target.",
                                `Targets · navigation ${formatMs(frontendExperience.budgets.navigation.p95Ms)} · long task ${formatMs(frontendExperience.budgets.longTaskP95Ms)} · frame ${formatMs(frontendExperience.budgets.frameContentionP95Ms)}`,
                                `Chat · ack ${formatMs(frontendExperience.budgets.chatLatency.submitToAckP95Ms)} · first progress ${formatMs(frontendExperience.budgets.chatLatency.submitToFirstTokenP95Ms)}`,
                                ...frontendExperience.recentDegradations.slice(0, 7).map(item => `${formatMetricTitle(item.kind, item.name)} · ${formatMs(item.value)}${item.routeKey ? ` · ${item.routeKey}` : ""} · ${formatRelative(new Date(item.occurredAt).getTime(), now)}`),
                              ]
                              : ["No threshold-only frontend degradations in this window."]}
                          />
                        )}
                        testId="tile-frontend-degradations"
                      />
                    </>
                  ) : (
                    <MetricRow
                      label="Summary"
                      value="Unavailable"
                      status="unknown"
                      detail={<DetailText>No browser telemetry summary was returned with system resources.</DetailText>}
                    />
                  )}
          </PerformanceSection>

          <PerformanceSection
            label="Context"
            status={contextStatus}
            testId="section-context-health"
          >
                  {contextHealth ? (
                    <>
                      <MetricRow
                        label="Scope"
                        value={`${contextHealth.callCount} rows · ${contextHealth.callsPerHour}/h`}
                        status={contextHealth.callCount > 0 ? "ok" : "unknown"}
                        detail={(
                          <DetailList
                            items={[
                              `${contextHealth.windowHours}h window · system-wide · row cap ${contextHealth.rowLimit.toLocaleString()}`,
                              `Source: ${contextHealth.measurementContract.source}`,
                              `Same canonical summary used by system.context_health.`,
                              "Diagnostic only — provider latency does not gate this section.",
                            ]}
                          />
                        )}
                        testId="tile-context-calls"
                      />
                      <MetricRow
                        label="Compaction"
                        value={contextHealth.midTurnCompaction.status === "degraded"
                          ? "Degraded"
                          : contextHealth.midTurnCompaction.status === "empty"
                            ? "No eligible turns"
                            : `${contextHealth.midTurnCompaction.compactionsPerTurn?.toFixed(2)} / turn · ${contextHealth.midTurnCompaction.affectedTurnPct?.toFixed(1)}% affected`}
                        status={contextHealth.midTurnCompaction.status === "healthy"
                          ? "ok"
                          : contextHealth.midTurnCompaction.status === "empty"
                            ? "unknown"
                            : "amber"}
                        detail={
                          <DetailList
                            items={contextHealth.midTurnCompaction.status === "degraded"
                              ? ["Scoped aggregation unavailable; no estimate shown."]
                              : contextHealth.midTurnCompaction.status === "empty"
                                ? [`No completed user turns in this ${contextHealth.windowHours}h window.`]
                                : [
                                  `${contextHealth.midTurnCompaction.totalCompactions} canonical working_context_compression events across ${contextHealth.midTurnCompaction.eligibleTurns} completed user turns; ${contextHealth.midTurnCompaction.affectedTurns} turns affected.`,
                                  `p95 ${contextHealth.midTurnCompaction.p95CompactionsPerTurn} · max ${contextHealth.midTurnCompaction.maxCompactionsPerTurn} compactions per turn.`,
                                  contextHealth.midTurnCompaction.priorWindowCompactionsPerTurn === null
                                    ? "Prior-window trend unavailable."
                                    : `Prior ${contextHealth.windowHours}h: ${contextHealth.midTurnCompaction.priorWindowCompactionsPerTurn.toFixed(2)} / turn${contextHealth.midTurnCompaction.trendPct === null ? "" : ` · ${contextHealth.midTurnCompaction.trendPct >= 0 ? "+" : ""}${contextHealth.midTurnCompaction.trendPct.toFixed(1)}%`}.`,
                                  "Between-turn durable compaction is excluded.",
                                ]}
                          />
                        }
                      />
                      <MetricRow
                        label="Coverage"
                        value={`${contextHealth.comparableCallCount} in · ${contextHealth.excludedCallCount} out`}
                        status={contextHealth.comparableCallCount > 0 ? "ok" : "unknown"}
                        detail={(
                          <DetailList
                            items={[
                              contextHealth.measurementContract.comparablePopulation,
                              contextHealth.measurementContract.contextTokenDefinition,
                              `Context window source: ${contextHealth.measurementContract.contextWindowSource}`,
                              ...contextHealth.exclusionReasons.map(reason => `Excluded ${reason.count}: ${formatExclusionReason(reason.reason)}`),
                              ...(contextHealth.exclusionReasons.length ? [] : ["No excluded rows in this window."]),
                            ]}
                          />
                        )}
                        testId="tile-context-population"
                      />
                      <MetricRow
                        label="Tokens"
                        value={formatTokens(contextHealth.medianContextTokens)}
                        detail={(
                          <DetailList
                            items={[
                              "Comparable rows only — no hard target yet; median is the ordinary size signal",
                              `median ${formatTokens(contextHealth.medianContextTokens)} · p95 ${formatTokens(contextHealth.p95ContextTokens)} · max ${formatTokens(contextHealth.maxContextTokens)}`,
                              "Only per-call rows with known context windows and in-window context tokens are included.",
                              "Non-comparable CLI cumulative counters are excluded and never displayed as prompt/context size.",
                              ...contextHealth.contextTokenDistribution.map(bucket => `${bucket.label}: ${bucket.count}`),
                            ]}
                          />
                        )}
                        testId="tile-context-tokens"
                      />
                      <MetricRow
                        label="Output"
                        value={formatTokens(contextHealth.avgOutputTokens)}
                        detail={<DetailText>Comparable-row average output tokens · comparable-row average total tokens {formatTokens(contextHealth.avgTotalTokens)}.</DetailText>}
                        testId="tile-context-output"
                      />
                      <MetricRow
                        label="Duration"
                        value={formatMs(contextHealth.upperTrimmedMean95DurationMs)}
                        detail={(
                          <DetailList
                            items={[
                              "Ordinary experience (mean of best 95%) across complete, partial, aborted, and failed tracked inference rows",
                              `avg ${formatMs(contextHealth.avgDurationMs)} · p95 ${formatMs(contextHealth.p95DurationMs)}`,
                            ]}
                          />
                        )}
                        testId="tile-context-duration"
                      />
                      <MetricRow
                        label="Errors"
                        value={`${formatPercent(contextHealth.errorRate)} · ${contextHealth.errorCount}`}
                        detail={<DetailText>{contextHealth.successCount} successful · {contextHealth.errorCount} errors · {contextHealth.abortedCount} aborted · {contextHealth.partialCount} partial. Informational until a real service error budget is established.</DetailText>}
                        testId="tile-context-errors"
                      />
                      <MetricRow
                        label="Providers"
                        value={String(contextHealth.byProvider.length)}
                        detail={(
                          <DetailList
                            items={contextHealth.byProvider.length
                              ? [
                                contextHealth.measurementContract.providerRows,
                                ...contextHealth.byProvider.map(item => `${item.provider} · rows ${item.callCount} (${item.comparableCallCount} comparable, ${item.excludedCallCount} excluded)${item.exclusionReasons.length ? ` · excluded: ${item.exclusionReasons.map(reason => `${formatExclusionReason(reason.reason)} ${reason.count}`).join(", ")}` : ""}`),
                              ]
                              : ["No provider calls in this window."]}
                          />
                        )}
                        testId="tile-context-providers"
                      />
                      <MetricRow
                        label="Models"
                        value={String(contextHealth.byModel.length)}
                        detail={(
                          <DetailList
                            items={contextHealth.byModel.length
                              ? [
                                contextHealth.measurementContract.modelRows,
                                ...contextHealth.byModel.map(item => `${item.provider} · ${item.model} · ${item.tier} · ${formatUsageSemantics(item.usageSemantics)} · window ${item.contextWindowStatus === "known" ? formatTokens(item.contextWindow) : "unknown"} · rows ${item.callCount} (${item.comparableCallCount} comparable, ${item.excludedCallCount} excluded)${item.exclusionReasons.length ? ` · excluded: ${item.exclusionReasons.map(reason => `${formatExclusionReason(reason.reason)} ${reason.count}`).join(", ")}` : ""} · p95 context ${formatTokens(item.p95ContextTokens)} · max ${formatTokens(item.maxContextTokens)}`),
                              ]
                              : ["No model calls in this window."]}
                          />
                        )}
                        testId="tile-context-models"
                      />
                    </>
                  ) : (
                    <MetricRow
                      label="Summary"
                      value="Unavailable"
                      status="unknown"
                      detail={<DetailText>No context-health summary was returned.</DetailText>}
                    />
                  )}
          </PerformanceSection>

          <PerformanceSection
            label="Realtime"
            status={realtimeBranchStatus}
            testId="section-realtime"
          >
                  <MetricRow
                    label="Server transport"
                    value={transportStatus === "red"
                      ? `${r.realtime.staleSessionSocketLinks} stale · ${r.realtime.subscriptionDivergence} diverged`
                      : `${r.realtime.eventSockets + r.realtime.sessionSockets} sockets`}
                    status={transportStatus}
                    detail={(
                      <DetailList
                        items={[
                          `${r.realtime.eventSockets} event sockets · peak ${r.realtime.peakEventSockets}`,
                          `${r.realtime.sessionSockets} session sockets · peak ${r.realtime.peakSessionSockets}`,
                          `${r.realtime.sessionSocketLinks} socket links · ${r.realtime.sessionOwnerLinks} owner links`,
                          `${r.realtime.liveSessions} live · ${r.realtime.streamingSessions} streaming · ${r.realtime.pendingSubscribedSessions} retained`,
                          `${r.realtime.staleSessionSocketLinks} stale · ${r.realtime.subscriptionDivergence} diverged`,
                          `${r.realtime.connectionsOpened} opened · ${r.realtime.connectionsClosed} closed · ${r.realtime.abnormalDisconnects} abnormal`,
                          `Oldest event socket: ${formatMs(r.realtime.oldestEventSocketAgeMs)}`,
                        ]}
                      />
                    )}
                    testId="tile-event-sockets"
                  />
                  <MetricRow
                    label="This browser"
                    value={wsStateLabel(clientWs.readyState)}
                    status={browserStatus}
                    detail={(
                      <DetailList
                        items={[
                          `${clientWs.physicalSockets} physical socket · ${clientWs.reconnects} reconnects · ${clientWs.forcedReconnects} liveness resets`,
                          `${clientWs.ownerCount} owners · ${clientWs.refCount} refs · ${clientWs.duplicateOwnerRefs} duplicate refs`,
                          `${clientWs.streamOwners} session owners`,
                          `${clientWs.messageHandlers} message handlers · ${clientWs.lifecycleHandlers} lifecycle handlers`,
                          ...Object.entries(clientWs.ownerRefs).map(([owner, count]) => `${owner}${count > 1 ? ` ×${count}` : ""}`),
                        ]}
                      />
                    )}
                    testId="card-client-websocket"
                  />
          </PerformanceSection>

          <PerformanceSection
            label="Reliability"
            status={reliabilityStatus}
            testId="section-reliability"
          >
            {reliabilityLoading ? (
              <MetricRow
                label="Reliability outcomes"
                value="Loading"
                detail={<DetailText>Fetching terminal success and failure rates.</DetailText>}
                testId="tile-reliability-loading"
              />
            ) : reliabilityError || !reliability ? (
              <MetricRow
                label="Reliability outcomes"
                value="Unavailable"
                status="red"
                detail={<DetailText>Reliability outcomes are temporarily unavailable.</DetailText>}
                testId="tile-reliability-error"
              />
            ) : (
              RELIABILITY_DOMAINS.map(({ key, label }) => {
                const metric = reliability.domains[key];
                const amberFailures = metric.amberFailures ?? 0;
                const unclassifiedErrors =
                  metric.unclassifiedErrors ??
                  Math.max(0, metric.failed - amberFailures);
                const rate = formatReliabilityRate(metric);
                const value =
                  metric.failed > 0
                    ? `${rate} · ${amberFailures}a/${unclassifiedErrors}e`
                    : rate;
                return (
                  <MetricRow
                    key={key}
                    label={label}
                    value={value}
                    status={reliabilityHealthStatus(metric.health)}
                    detail={reliabilityMetricDetail(metric)}
                    testId={`tile-reliability-${key}`}
                  />
                );
              })
            )}
          </PerformanceSection>

          <PerformanceSection
            label="Connectors"
            status={connectorsStatus}
            testId="section-connectors"
            defaultOpen
          >
            {connectorsLoading ? (
              <MetricRow
                label="Connectors"
                value="Loading"
                detail={<DetailText>Loading connected external accounts.</DetailText>}
                testId="tile-connectors-loading"
              />
            ) : connectorsError ? (
              <MetricRow
                label="Connectors"
                value="Unavailable"
                status="red"
                detail={<DetailText>Could not load connected accounts.</DetailText>}
                testId="tile-connectors-error"
              />
            ) : activeConnectors.length === 0 ? (
              <MetricRow
                label="Active connectors"
                value="None"
                status="unknown"
                detail={<DetailText>No connected external accounts for this principal.</DetailText>}
                testId="tile-connectors-empty"
              />
            ) : (
              activeConnectors.map((account) => {
                const status = connectorStatus(account);
                return (
                  <MetricRow
                    key={account.accountId}
                    label={connectorLabel(account)}
                    value={status === "ok" ? "Healthy" : status === "red" ? "Unhealthy" : "Unknown"}
                    status={status}
                    detail={(
                      <DetailList
                        items={[
                          `Provider ${formatConnectorProvider(account.provider)} · ${account.accountId}`,
                          account.healthError ? `Error: ${account.healthError}` : "No health error recorded",
                          account.healthCheckedAt
                            ? `Checked ${formatRelative(new Date(account.healthCheckedAt).getTime(), now)}`
                            : "No health check timestamp",
                          account.missingScopes?.length
                            ? `Missing scopes: ${account.missingScopes.join(", ")}`
                            : "No missing scopes",
                        ]}
                      />
                    )}
                    testId={`tile-connector-${account.accountId}`}
                  />
                );
              })
            )}
          </PerformanceSection>

          <PerformanceSection
            label="BUILD"
            status={buildDeploymentTimingsError ? "red" : buildDeploymentTimingsLoading || !buildDeploymentTimings?.environments.length ? "unknown" : "ok"}
            testId="section-build-deploy-times"
            defaultOpen
          >
            {buildDeploymentTimingsError ? (
              <MetricRow
                label="Deployment timings"
                value="Unavailable"
                status="red"
                testId="build-deploy-times-error"
              />
            ) : buildDeploymentTimingsLoading ? (
              <MetricRow label="Deployment timings" value="Loading" />
            ) : !buildDeploymentTimings?.environments.length ? (
              <MetricRow label="Deployment timings" value="Awaiting first observation" />
            ) : (
              buildDeploymentTimings.environments.map(environment => (
                <MetricRow
                  key={environment.platformEnvironmentId}
                  label={`${environment.platformName} / ${environment.productName} / ${environment.environmentName}`}
                  value={formatDeploymentDuration(environment.latestDurationMs)}
                  detail={<BuildDeploymentDetail environment={environment} />}
                  testId={`build-deploy-time-${environment.platformEnvironmentId}`}
                />
              ))
            )}
          </PerformanceSection>
        </div>
      </div>
    </div>
  );
}
