import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import {
  RESOURCES_REFRESH_INTERVAL_MS as REFRESH_INTERVAL_MS,
  FRONTEND_EXPERIENCE_REFRESH_INTERVAL_MS,
  RESOURCES_STALE_AFTER_MS as STALE_AFTER_MS,
  RESOURCES_THRESHOLDS as THRESHOLDS,
} from "./resources-thresholds";

type Status = "ok" | "amber" | "red";

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
    loadAvg: number[];
    totalMemory: number;
    freeMemory: number;
    platform: string;
    arch: string;
  };
  realtime: {
    cpu: { current: number; history: number[] };
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
  return "Healthy";
}

function statusDot(status: Status): string {
  if (status === "red") return "bg-destructive";
  if (status === "amber") return "bg-warning";
  return "bg-success";
}

function statusText(status: Status): string {
  if (status === "red") return "text-destructive";
  if (status === "amber") return "text-warning-foreground dark:text-warning";
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

function cpuStatus(percent: number): Status {
  if (percent >= 80) return "red";
  if (percent >= 50) return "amber";
  return "ok";
}

function memoryStatus(memory: SystemResourcesData["memory"]): Status {
  if (!memory.maxMemoryBytes) return "amber";
  const ratio = memory.rss / memory.maxMemoryBytes;
  if (ratio >= 0.85) return "red";
  if (ratio >= 0.7) return "amber";
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
  if (eventLoop.currentMs >= THRESHOLDS.eventLoopRedMs || eventLoop.maxMs >= THRESHOLDS.eventLoopRedMs) return "red";
  if (eventLoop.currentMs >= THRESHOLDS.eventLoopAmberMs || eventLoop.maxMs >= THRESHOLDS.eventLoopAmberMs) return "amber";
  return "ok";
}

function slowQueryStatus(slowQueries: SystemResourcesData["slowQueries"]): Status {
  if (slowQueries.lastMinute >= THRESHOLDS.slowQueryRedPerMin) return "red";
  if (slowQueries.lastMinute >= THRESHOLDS.slowQueryAmberPerMin) return "amber";
  return "ok";
}

function frontendExperienceStatus(frontend: BrowserTelemetrySummary | null): Status {
  if (!frontend || frontend.sampleHealth === "empty") return "amber";
  if (frontend.recentDegradations.length > 0) return "amber";
  if (frontend.metrics.some(metric => metric.p95 !== null && metric.p95 > frontendMetricBudget(frontend, metric.kind, metric.name))) return "amber";
  return "ok";
}

function frontendMetricBudget(frontend: BrowserTelemetrySummary, kind: string, name: string): number {
  if (kind === "navigation") return frontend.budgets.navigation.p95Ms;
  if (kind === "web_vital") {
    const lower = name.toLowerCase();
    if (lower.includes("cls")) return frontend.budgets.webVital.clsGoodScore;
    if (lower.includes("inp")) return frontend.budgets.webVital.inpGoodMs;
    return frontend.budgets.webVital.lcpGoodMs;
  }
  if (kind === "chat_latency") {
    if (name.includes("ack")) return frontend.budgets.chatLatency.submitToAckP95Ms;
    if (name.includes("first")) return frontend.budgets.chatLatency.submitToFirstTokenP95Ms;
    return frontend.budgets.chatLatency.submitToCompleteP95Ms;
  }
  if (kind === "transport_gap") return frontend.budgets.transportGapP95Ms;
  if (kind === "long_task") return frontend.budgets.longTaskP95Ms;
  if (kind === "event_loop_responsiveness") return frontend.budgets.eventLoopResponsivenessP95Ms;
  if (kind === "frame_contention") return frontend.budgets.frameContentionP95Ms;
  return Number.POSITIVE_INFINITY;
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

function formatMetricName(kind: string, name: string): string {
  return `${kind.replace(/_/g, " ")} · ${name.replace(/_/g, " ")}`;
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
}: {
  label: string;
  status: Status;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(status !== "ok");

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
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

export default function ResourcesPage() {
  usePageHeader({ title: "Performance" });
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
    queryKey: ["/api/gateway/frontend-experience"],
    queryFn: async () => {
      const res = await fetch("/api/gateway/frontend-experience", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: FRONTEND_EXPERIENCE_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
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
      failures={data.failures}
      now={now}
      isStale={dataUpdatedAt > 0 && now - dataUpdatedAt > STALE_AFTER_MS}
    />
  );
}

function ResourcesView({
  resources: r,
  frontendExperience,
  failures,
  now,
  isStale,
}: {
  resources: SystemResourcesData;
  frontendExperience: BrowserTelemetrySummary | null;
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

  const cpuPercent = diagData?.realtime.cpu.current ?? 0;
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
  const frontendStatus = frontendExperienceStatus(frontendExperience);

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
                      value={`${cpuPercent}%`}
                      status={cpuStatus(cpuPercent)}
                      detail={<DetailText>{diagData.system.cpuCores} cores · load {diagData.system.loadAvg.join(" / ")}</DetailText>}
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
                    label="In-flight queries"
                    value={String(r.inFlight.total)}
                    status={inFlightStatus(r.inFlight)}
                    detail={<DetailList items={[`High threshold: ${r.inFlight.highThreshold}`, ...(inFlightSubsystems.length ? inFlightSubsystems : ["No active query subsystems."])]} />}
                    testId="tile-in-flight"
                  />
                  <MetricRow
                    label="Admission queue"
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
                    label="Executor runs"
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
                    detail={<DetailText>{r.slowQueries.lastTenMinutes} in 10m · last {r.slowQueries.lastSlowDurationMs ? formatMs(r.slowQueries.lastSlowDurationMs) : "—"} {formatRelative(r.slowQueries.lastSlowAt, now)}</DetailText>}
                    testId="tile-slow-queries"
                  />
                  <MetricRow
                    label="Long-running queries"
                    value={String(r.longRunningQueries.rows.length)}
                    status={longRunningStatus(r.longRunningQueries)}
                    detail={(
                      <DetailList
                        items={r.longRunningQueries.rows.length
                          ? r.longRunningQueries.rows.map(row => `${row.subsystem} · ${row.label ?? "unlabelled"} · ${formatMs(row.ageMs)}`)
                          : [`No queries over ${formatMs(r.longRunningQueries.thresholdMs)}.`]}
                      />
                    )}
                    testId="card-long-running-queries"
                  />
                  <MetricRow
                    label="Zombie runs"
                    value={String(r.zombies.active)}
                    status={zombieStatus(r.zombies)}
                    detail={<DetailText>Peak since boot: {r.zombies.peak}</DetailText>}
                    testId="tile-zombies"
                  />
                  <MetricRow
                    label="Books vs reality"
                    value={String(r.divergence.value)}
                    status={divergenceStatus(r.divergence)}
                    detail={<DetailText>{r.divergence.detail}</DetailText>}
                    testId="tile-divergence"
                  />
          </PerformanceSection>


          <PerformanceSection
            label="Frontend Experience"
            status={frontendStatus}
            testId="section-frontend-experience"
          >
                  {frontendExperience ? (
                    <>
                      <MetricRow
                        label="Sample health"
                        value={`${frontendExperience.sampleHealth} · ${frontendExperience.sampleCount}`}
                        status={frontendExperience.sampleHealth === "healthy" ? "ok" : "amber"}
                        detail={<DetailText>{frontendExperience.windowHours}h window · raw retention {frontendExperience.rawRetentionDays}d · same summary used by system.frontend_performance.</DetailText>}
                        testId="tile-frontend-sample-health"
                      />
                      {frontendExperience.metrics.slice(0, 8).map(metric => (
                        <MetricRow
                          key={`${metric.kind}:${metric.name}`}
                          label={formatMetricName(metric.kind, metric.name)}
                          value={`${formatMs(metric.p50)} / ${formatMs(metric.p95)}`}
                          status={metric.p95 !== null && metric.p95 > frontendMetricBudget(frontendExperience, metric.kind, metric.name) ? "amber" : "ok"}
                          detail={<DetailText>p50 / p95 · n={metric.count} · budget {formatMs(frontendMetricBudget(frontendExperience, metric.kind, metric.name))} · latest {formatRelative(metric.latestAt ? new Date(metric.latestAt).getTime() : null, now)}</DetailText>}
                        />
                      ))}
                      <MetricRow
                        label="Budgets"
                        value="p95 guarded"
                        detail={(
                          <DetailList
                            items={[
                              `Navigation ${formatMs(frontendExperience.budgets.navigation.p95Ms)}`,
                              `Chat ack ${formatMs(frontendExperience.budgets.chatLatency.submitToAckP95Ms)} · first token ${formatMs(frontendExperience.budgets.chatLatency.submitToFirstTokenP95Ms)} · complete ${formatMs(frontendExperience.budgets.chatLatency.submitToCompleteP95Ms)}`,
                              `Vitals LCP ${formatMs(frontendExperience.budgets.webVital.lcpGoodMs)} · INP ${formatMs(frontendExperience.budgets.webVital.inpGoodMs)} · CLS ${frontendExperience.budgets.webVital.clsGoodScore}`,
                              `Long task ${formatMs(frontendExperience.budgets.longTaskP95Ms)} · frame contention ${formatMs(frontendExperience.budgets.frameContentionP95Ms)}`,
                            ]}
                          />
                        )}
                        testId="tile-frontend-budgets"
                      />
                      <MetricRow
                        label="Recent degradations"
                        value={String(frontendExperience.recentDegradations.length)}
                        status={frontendExperience.recentDegradations.length ? "amber" : "ok"}
                        detail={(
                          <DetailList
                            items={frontendExperience.recentDegradations.length
                              ? frontendExperience.recentDegradations.slice(0, 8).map(item => `${formatMetricName(item.kind, item.name)} · ${formatMs(item.value)}${item.routeKey ? ` · ${item.routeKey}` : ""} · ${formatRelative(new Date(item.occurredAt).getTime(), now)}`)
                              : ["No threshold-only frontend degradations in this window."]}
                          />
                        )}
                        testId="tile-frontend-degradations"
                      />
                    </>
                  ) : (
                    <MetricRow
                      label="Frontend summary"
                      value="Unavailable"
                      status="amber"
                      detail={<DetailText>No browser telemetry summary was returned with system resources.</DetailText>}
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
                    value={`${r.realtime.eventSockets + r.realtime.sessionSockets} sockets`}
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
        </div>
      </div>
    </div>
  );
}
