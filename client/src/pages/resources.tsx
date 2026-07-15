import { useState, useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle } from "lucide-react";
import { formatBytes } from "@/lib/format-utils";
import { usePageHeader } from "@/hooks/use-page-header";
import {
  getSharedWSDiagnostics,
  subscribeSharedWSDiagnostics,
  type SharedWSDiagnostics,
} from "@/lib/ws-connection";
import type { SystemResourcesData } from "@shared/system-resources";
import {
  RESOURCES_REFRESH_INTERVAL_MS as REFRESH_INTERVAL_MS,
  RESOURCES_STALE_AFTER_MS as STALE_AFTER_MS,
  RESOURCES_THRESHOLDS as THRESHOLDS,
} from "./resources-thresholds";

type Status = "ok" | "amber" | "red";

interface ResourcesResponse {
  processes: unknown[];
  failures?: string[];
  resources: SystemResourcesData | null;
}

function statusColor(status: Status): string {
  if (status === "red") return "border-destructive/50 bg-destructive/5";
  if (status === "amber") return "border-warning/50 bg-warning/5";
  return "border-border bg-card";
}

function statusDot(status: Status): string {
  if (status === "red") return "bg-destructive";
  if (status === "amber") return "bg-warning";
  return "bg-success";
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

function Sparkline({ values, status, testId }: { values: number[]; status: Status; testId: string }) {
  if (!values || values.length < 2) return null;
  const w = 80;
  const h = 20;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const stroke =
    status === "red" ? "hsl(var(--destructive))" : status === "amber" ? "rgb(245 158 11)" : "rgb(16 185 129)";
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="overflow-visible"
      data-testid={testId}
    >
      <polyline fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" points={points} />
    </svg>
  );
}

function ResourceTile({
  label,
  value,
  sub,
  status,
  testId,
  history,
}: {
  label: string;
  value: string;
  sub?: string;
  status: Status;
  testId: string;
  history?: number[];
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${statusColor(status)}`}
      data-testid={testId}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={`h-2 w-2 rounded-full ${statusDot(status)}`} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold tabular-nums" data-testid={`${testId}-value`}>
          {value}
        </div>
        {history && history.length >= 2 && (
          <Sparkline values={history} status={status} testId={`${testId}-sparkline`} />
        )}
      </div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-1 truncate" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

function dbStatus(d: SystemResourcesData["dbPool"]): Status {
  if (d.waiting > THRESHOLDS.dbWaitingRed) return "red";
  if (d.saturatedForMs > THRESHOLDS.dbSaturatedRedMs) return "red";
  if (d.waiting >= THRESHOLDS.dbWaitingAmber) return "amber";
  return "ok";
}

function inFlightStatus(i: SystemResourcesData["inFlight"]): Status {
  if (i.total > i.highThreshold) return "red";
  if (i.total > i.highThreshold * THRESHOLDS.inFlightAmberMultiplier) return "amber";
  return "ok";
}

function zombieStatus(z: SystemResourcesData["zombies"]): Status {
  if (z.active >= THRESHOLDS.zombieRed) return "red";
  if (z.active >= THRESHOLDS.zombieAmber) return "amber";
  return "ok";
}

function eventLoopStatus(e: SystemResourcesData["eventLoop"]): Status {
  if (e.currentMs >= THRESHOLDS.eventLoopRedMs || e.maxMs >= THRESHOLDS.eventLoopRedMs) return "red";
  if (e.currentMs >= THRESHOLDS.eventLoopAmberMs || e.maxMs >= THRESHOLDS.eventLoopAmberMs) return "amber";
  return "ok";
}

function slowQueryStatus(s: SystemResourcesData["slowQueries"]): Status {
  if (s.lastMinute >= THRESHOLDS.slowQueryRedPerMin) return "red";
  if (s.lastMinute >= THRESHOLDS.slowQueryAmberPerMin) return "amber";
  return "ok";
}

function divergenceStatus(d: SystemResourcesData["divergence"]): Status {
  if (d.value >= THRESHOLDS.divergenceRed) return "red";
  if (d.value >= THRESHOLDS.divergenceAmber) return "amber";
  return "ok";
}

function executorStatus(e: SystemResourcesData["executor"]): Status {
  return e.activeRuns > 0 ? "amber" : "ok";
}

function realtimeStatus(r: SystemResourcesData["realtime"]): Status {
  if (r.staleSessionSocketLinks > 0 || r.subscriptionDivergence > 0) return "red";
  return "ok";
}

function sharedWsStatus(d: SharedWSDiagnostics): Status {
  if (d.duplicateOwnerRefs > 0 || d.refCount !== d.ownerCount) return "red";
  if (d.refCount > 0 && d.physicalSockets === 0) return "amber";
  return "ok";
}

function wsStateLabel(readyState: number): string {
  if (readyState === WebSocket.CONNECTING) return "connecting";
  if (readyState === WebSocket.OPEN) return "open";
  if (readyState === WebSocket.CLOSING) return "closing";
  return "closed";
}

// --- Performance diagnostics types & helpers (moved from Build > Performance) ---

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

function formatUptime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function lagSeverity(ms: number): "healthy" | "warning" | "critical" {
  if (ms < 50) return "healthy";
  if (ms < 200) return "warning";
  return "critical";
}

function severityColor(severity: "healthy" | "warning" | "critical") {
  switch (severity) {
    case "healthy": return "text-success";
    case "warning": return "text-warning";
    case "critical": return "text-error";
  }
}

function PerfSparkline({ data, color, height = 32, className }: { data: number[]; color: string; height?: number; className?: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 120;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  const fillPoints = `0,${height} ${points} ${w},${height}`;

  return (
    <svg viewBox={`0 0 ${w} ${height}`} className={`w-full ${className || ""}`} style={{ height }} preserveAspectRatio="none">
      <polygon points={fillPoints} fill={color} fillOpacity="0.1" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PerfTile({ label, value, sub, severity, sparkData, sparkColor, testId }: {
  label: string;
  value: string;
  sub?: string;
  severity?: "healthy" | "warning" | "critical";
  sparkData?: number[];
  sparkColor?: string;
  testId: string;
}) {
  return (
    <Card>
      <CardContent className="pt-3 pb-2 px-3">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        <div className="flex items-baseline gap-1.5 mt-0.5">
          <span className={`text-lg font-semibold tabular-nums ${severity ? severityColor(severity) : ""}`} data-testid={testId}>
            {value}
          </span>
        </div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
        {sparkData && sparkData.length > 1 && sparkColor && (
          <PerfSparkline data={sparkData} color={sparkColor} className="mt-1" />
        )}
      </CardContent>
    </Card>
  );
}

export default function ResourcesPage() {
  usePageHeader({ title: "Resources" });
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

  if (isLoading) {
    return (
      <div className="flex flex-col h-full min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="p-4 @sm:p-6">
            <div className="space-y-4">
              <div className="grid grid-cols-2 @md:grid-cols-4 gap-3">
                {[0, 1, 2, 3, 4, 5, 6, 7].map(i => (
                  <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
              </div>
              <Skeleton className="h-48 rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isError || !data?.resources) {
    const msg = error instanceof Error ? error.message : data?.failures?.join("; ") || "Resources unavailable";
    return (
      <div className="flex flex-col h-full min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="p-4 @sm:p-6">
            <div
              className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 flex items-start gap-3"
              data-testid="resources-error-state"
            >
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-destructive">Couldn't load system resources</p>
                <p className="text-xs text-muted-foreground mt-1 break-words" data-testid="text-resources-error">
                  {msg}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const r = data.resources;
  const now = Date.now();
  const isStale = dataUpdatedAt > 0 && now - dataUpdatedAt > STALE_AFTER_MS;

  return <ResourcesView resources={r} failures={data.failures} now={now} isStale={isStale} />;
}

const HISTORY_CAP = 60;
type HistoryKey = "dbWaiting" | "inFlight" | "eventLoop" | "executorActive" | "zombies" | "eventSockets" | "sessionSockets" | "sessionSocketLinks" | "sessionOwnerLinks";
type Histories = Record<HistoryKey, number[]>;
const EMPTY_HISTORIES: Histories = {
  dbWaiting: [],
  inFlight: [],
  eventLoop: [],
  executorActive: [],
  zombies: [],
  eventSockets: [],
  sessionSockets: [],
  sessionSocketLinks: [],
  sessionOwnerLinks: [],
};

const historyStore = (() => {
  let state: Histories = EMPTY_HISTORIES;
  let lastGeneratedAt: number | null = null;
  const listeners = new Set<() => void>();
  const pushCapped = (arr: number[], v: number) => {
    const next = arr.length >= HISTORY_CAP ? arr.slice(arr.length - HISTORY_CAP + 1) : arr.slice();
    next.push(v);
    return next;
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): Histories {
      return state;
    },
    record(generatedAt: number, sample: Record<HistoryKey, number>) {
      if (!generatedAt || generatedAt === lastGeneratedAt) return;
      lastGeneratedAt = generatedAt;
      state = {
        dbWaiting: pushCapped(state.dbWaiting, sample.dbWaiting),
        inFlight: pushCapped(state.inFlight, sample.inFlight),
        eventLoop: pushCapped(state.eventLoop, sample.eventLoop),
        executorActive: pushCapped(state.executorActive, sample.executorActive),
        zombies: pushCapped(state.zombies, sample.zombies),
        eventSockets: pushCapped(state.eventSockets, sample.eventSockets),
        sessionSockets: pushCapped(state.sessionSockets, sample.sessionSockets),
        sessionSocketLinks: pushCapped(state.sessionSocketLinks, sample.sessionSocketLinks),
        sessionOwnerLinks: pushCapped(state.sessionOwnerLinks, sample.sessionOwnerLinks),
      };
      listeners.forEach(l => l());
    },
  };
})();

function ResourcesView({
  resources: r,
  failures,
  now,
  isStale,
}: {
  resources: SystemResourcesData;
  failures?: string[];
  now: number;
  isStale: boolean;
}) {
  const histories = useSyncExternalStore(historyStore.subscribe, historyStore.getSnapshot, historyStore.getSnapshot);
  const clientWs = useSyncExternalStore(
    subscribeSharedWSDiagnostics,
    getSharedWSDiagnostics,
    getSharedWSDiagnostics,
  );

  // --- Performance diagnostics (CPU, Memory, Event Loop, Ping, Uptime, Req/s) ---
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [pingHistory, setPingHistory] = useState<number[]>([]);

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
        const ms = Math.round(performance.now() - start);
        if (mounted) {
          setPingMs(ms);
          setPingHistory(prev => {
            const next = [...prev, ms];
            return next.length > 60 ? next.slice(-60) : next;
          });
        }
      } catch {}
    };
    measurePing();
    const id = setInterval(measurePing, 3000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  const rt = diagData?.realtime;

  useEffect(() => {
    historyStore.record(r.generatedAt, {
      dbWaiting: r.dbPool.waiting,
      inFlight: r.inFlight.total,
      eventLoop: r.eventLoop.currentMs,
      executorActive: r.executor.activeRuns,
      zombies: r.zombies.active,
      eventSockets: r.realtime.eventSockets,
      sessionSockets: r.realtime.sessionSockets,
      sessionSocketLinks: r.realtime.sessionSocketLinks,
      sessionOwnerLinks: r.realtime.sessionOwnerLinks,
    });
  }, [r.generatedAt, r.dbPool.waiting, r.inFlight.total, r.eventLoop.currentMs, r.executor.activeRuns, r.zombies.active, r.realtime.eventSockets, r.realtime.sessionSockets, r.realtime.sessionSocketLinks, r.realtime.sessionOwnerLinks]);

  const inFlightSubs = Object.entries(r.inFlight.bySubsystem)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0 p-4 @sm:p-6 scrollbar-thin">
        <div className="space-y-4">
        {/* Server performance tiles */}
        {diagData && (
          <>
            <div className="grid grid-cols-2 @lg:grid-cols-3 gap-3">
              <PerfTile label="CPU" value={`${rt?.cpu.current ?? 0}%`} sub={`${diagData.system.cpuCores} cores / load ${diagData.system.loadAvg[0]}`} severity={(rt?.cpu.current ?? 0) < 50 ? "healthy" : (rt?.cpu.current ?? 0) < 80 ? "warning" : "critical"} sparkData={rt?.cpu.history} sparkColor="hsl(var(--primary))" testId="text-cpu-usage" />
              <PerfTile
                label="Memory (RSS)"
                value={formatBytes(diagData.memoryUsage.rss)}
                sub={diagData.memoryUsage.maxMemoryBytes
                  ? `${diagData.memoryUsage.rssUsedPct ?? Math.round((diagData.memoryUsage.rss / diagData.memoryUsage.maxMemoryBytes) * 1000) / 10}% of ${formatBytes(diagData.memoryUsage.maxMemoryBytes)} · ${diagData.memoryUsage.limitSource ?? "limit"}`
                  : `heap ${formatBytes(diagData.memoryUsage.heapUsed)} / ${formatBytes(diagData.memoryUsage.heapTotal)} · limit unavailable`}
                severity={diagData.memoryUsage.maxMemoryBytes
                  ? (diagData.memoryUsage.rss / diagData.memoryUsage.maxMemoryBytes) < 0.70 ? "healthy" : (diagData.memoryUsage.rss / diagData.memoryUsage.maxMemoryBytes) < 0.85 ? "warning" : "critical"
                  : undefined}
                sparkData={rt?.rss.history}
                sparkColor="hsl(160, 60%, 45%)"
                testId="text-memory-usage"
              />
              <PerfTile label="Event Loop" value={`${formatMs(diagData.eventLoopLag.current)}`} sub={`avg ${formatMs(diagData.eventLoopLag.avg)} / peak ${formatMs(diagData.eventLoopLag.max)}`} severity={lagSeverity(diagData.eventLoopLag.current)} sparkData={rt?.eventLoop.history} sparkColor="hsl(30, 80%, 55%)" testId="text-event-loop-lag" />
              <PerfTile label="Ping" value={pingMs !== null ? `${pingMs}ms` : "..."} sub="round-trip to server" severity={pingMs === null ? "healthy" : pingMs < 200 ? "healthy" : pingMs < 500 ? "warning" : "critical"} sparkData={pingHistory} sparkColor="hsl(280, 65%, 60%)" testId="text-ping" />
              <PerfTile label="Uptime" value={formatUptime(diagData.uptime)} testId="text-uptime" />
              <PerfTile label="Req/s" value={String(rt?.rps.current ?? 0)} sparkData={rt?.rps.history} sparkColor="hsl(200, 70%, 50%)" testId="text-rps" />
            </div>
          </>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Realtime Connections</h2>
            {(realtimeStatus(r.realtime) !== "ok" || sharedWsStatus(clientWs) !== "ok") && (
              <Badge variant="outline" className="text-xs border-warning/50 text-warning-foreground dark:text-warning">
                inspect
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">process lifetime + this tab</div>
        </div>

        <div className="grid grid-cols-2 @md:grid-cols-4 gap-3">
          <ResourceTile
            label="Event Sockets"
            value={String(r.realtime.eventSockets)}
            sub={`server physical sockets · peak ${r.realtime.peakEventSockets}`}
            status={realtimeStatus(r.realtime)}
            testId="tile-event-sockets"
            history={histories.eventSockets}
          />
          <ResourceTile
            label="Session Sockets"
            value={String(r.realtime.sessionSockets)}
            sub={`${r.realtime.sessionSocketLinks} socket↔session links · peak ${r.realtime.peakSessionSockets}`}
            status={realtimeStatus(r.realtime)}
            testId="tile-session-sockets"
            history={histories.sessionSockets}
          />
          <ResourceTile
            label="Session Owners"
            value={String(r.realtime.sessionOwnerLinks)}
            sub={`${r.realtime.uniqueSubscribedSessions} sessions · ${r.realtime.pendingSubscribedSessions} retained without live runtime`}
            status={realtimeStatus(r.realtime)}
            testId="tile-session-owners"
            history={histories.sessionOwnerLinks}
          />
          <ResourceTile
            label="Stale / Diverged"
            value={`${r.realtime.staleSessionSocketLinks} / ${r.realtime.subscriptionDivergence}`}
            sub={`stale socket links / registry delta · peak links ${r.realtime.peakSessionSocketLinks}`}
            status={realtimeStatus(r.realtime)}
            testId="tile-session-divergence"
            history={histories.sessionSocketLinks}
          />
        </div>

        <Card data-testid="card-client-websocket">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-semibold flex items-center justify-between gap-2">
              <span>This Browser Tab</span>
              <Badge variant="outline" className="font-normal">{wsStateLabel(clientWs.readyState)}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 @md:grid-cols-4 gap-3">
              <ResourceTile
                label="Physical Socket"
                value={String(clientWs.physicalSockets)}
                sub={`${clientWs.reconnects} reconnects · ${clientWs.forcedReconnects} liveness resets`}
                status={sharedWsStatus(clientWs)}
                testId="tile-client-physical-socket"
              />
              <ResourceTile
                label="React Owners"
                value={String(clientWs.ownerCount)}
                sub={`refs ${clientWs.refCount} · peak ${clientWs.peakOwnerCount} owners / ${clientWs.peakRefCount} refs`}
                status={sharedWsStatus(clientWs)}
                testId="tile-client-ws-owners"
              />
              <ResourceTile
                label="Session Owners"
                value={String(clientWs.streamOwners)}
                sub="owners with active session subscriptions"
                status={sharedWsStatus(clientWs)}
                testId="tile-client-session-owners"
              />
              <ResourceTile
                label="Handlers"
                value={`${clientWs.messageHandlers} / ${clientWs.lifecycleHandlers}`}
                sub={`message / lifecycle · duplicate refs ${clientWs.duplicateOwnerRefs}`}
                status={sharedWsStatus(clientWs)}
                testId="tile-client-ws-handlers"
              />
            </div>
            <div className="text-xs text-muted-foreground">
              Server churn since boot: {r.realtime.connectionsOpened} opened / {r.realtime.connectionsClosed} closed / {r.realtime.abnormalDisconnects} abnormal · oldest event socket {formatMs(r.realtime.oldestEventSocketAgeMs)}.
            </div>
            {Object.keys(clientWs.ownerRefs).length > 0 && (
              <div className="flex flex-wrap gap-1.5" data-testid="client-ws-owner-list">
                {Object.entries(clientWs.ownerRefs).map(([owner, count]) => (
                  <Badge key={owner} variant="secondary" className="font-mono text-[10px] font-normal">
                    {owner}{count > 1 ? ` ×${count}` : ""}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Live Resources</h2>
            {isStale && (
              <Badge variant="outline" className="text-xs border-warning/50 text-warning-foreground dark:text-warning" data-testid="badge-stale">
                stale
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground" data-testid="text-resources-updated-at">
            updated {formatRelative(r.generatedAt, now)}
          </div>
        </div>

        {failures && failures.length > 0 && (
          <div
            className="flex items-start gap-2 p-2 rounded-md border border-warning/40 bg-warning/5"
            data-testid="resources-partial-failure-banner"
          >
            <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground break-words">{failures.join("; ")}</p>
          </div>
        )}

        <div className="grid grid-cols-2 @md:grid-cols-4 gap-3">
          <ResourceTile
            label="DB Pool"
            value={`${r.dbPool.total} / ${r.dbPool.idle} / ${r.dbPool.waiting}`}
            sub={`total / idle / waiting${r.dbPool.saturatedForMs > 0 ? ` · saturated ${formatMs(r.dbPool.saturatedForMs)}` : ""}`}
            status={dbStatus(r.dbPool)}
            testId="tile-db-pool"
            history={histories.dbWaiting}
          />
          <ResourceTile
            label="In-flight Queries"
            value={String(r.inFlight.total)}
            sub={`high at ${r.inFlight.highThreshold}${inFlightSubs ? ` · ${inFlightSubs}` : ""}`}
            status={inFlightStatus(r.inFlight)}
            testId="tile-in-flight"
            history={histories.inFlight}
          />
          <ResourceTile
            label="Slow Queries"
            value={`${r.slowQueries.lastMinute} / ${r.slowQueries.lastTenMinutes}`}
            sub={`last 1m / 10m · last ${r.slowQueries.lastSlowDurationMs ? formatMs(r.slowQueries.lastSlowDurationMs) : "—"} ${formatRelative(r.slowQueries.lastSlowAt, now)}`}
            status={slowQueryStatus(r.slowQueries)}
            testId="tile-slow-queries"
          />
          <ResourceTile
            label="Event Loop"
            value={`${r.eventLoop.currentMs.toFixed(1)}ms`}
            sub={`max ${r.eventLoop.maxMs.toFixed(1)}ms · avg ${r.eventLoop.avgMs.toFixed(1)}ms`}
            status={eventLoopStatus(r.eventLoop)}
            testId="tile-event-loop"
            history={histories.eventLoop}
          />
          <ResourceTile
            label="Memory Limit"
            value={r.memory.maxMemoryBytes ? formatBytes(r.memory.maxMemoryBytes) : "disabled"}
            sub={r.memory.maxMemoryBytes
              ? `RSS ${formatBytes(r.memory.rss)} · ${r.memory.rssUsedPct ?? Math.round((r.memory.rss / r.memory.maxMemoryBytes) * 1000) / 10}% · ${r.memory.limitSource ?? "limit"}`
              : "watchdog limit unavailable"}
            status={!r.memory.maxMemoryBytes ? "amber" : (r.memory.rss / r.memory.maxMemoryBytes) >= 0.85 ? "red" : (r.memory.rss / r.memory.maxMemoryBytes) >= 0.70 ? "amber" : "ok"}
            testId="tile-memory-limit"
          />
          <ResourceTile
            label="Executor"
            value={String(r.executor.activeRuns)}
            sub="active runs"
            status={executorStatus(r.executor)}
            testId="tile-executor"
            history={histories.executorActive}
          />
          <ResourceTile
            label="Zombies"
            value={`${r.zombies.active}`}
            sub={`peak ${r.zombies.peak}`}
            status={zombieStatus(r.zombies)}
            testId="tile-zombies"
            history={histories.zombies}
          />
          <ResourceTile
            label="Books vs Reality"
            value={String(r.divergence.value)}
            sub={r.divergence.detail}
            status={divergenceStatus(r.divergence)}
            testId="tile-divergence"
          />
        </div>

        <Card data-testid="card-long-running-queries">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-semibold">
              Long-running Queries{" "}
              <span className="text-muted-foreground font-normal">
                ({r.longRunningQueries.rows.length}) · &gt; {formatMs(r.longRunningQueries.thresholdMs)} in-flight
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {r.longRunningQueries.rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No queries past threshold.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-3 font-medium">Subsystem</th>
                      <th className="py-1.5 pr-3 font-medium">Label</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.longRunningQueries.rows.map((row, idx) => (
                      <tr
                        key={`${row.subsystem}-${idx}`}
                        className="border-b border-border/50"
                        data-testid={`row-long-running-query-${idx}`}
                      >
                        <td className="py-1.5 pr-3">
                          <Badge variant="outline" className="text-xs px-1.5 py-0" data-testid={`text-long-running-subsystem-${idx}`}>
                            {row.subsystem}
                          </Badge>
                        </td>
                        <td className="py-1.5 pr-3 text-muted-foreground truncate max-w-[280px]" title={row.label ?? ""} data-testid={`text-long-running-label-${idx}`}>
                          {row.label ?? "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums" data-testid={`text-long-running-age-${idx}`}>
                          {formatMs(row.ageMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-executor-runs">
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-semibold">
              Executor Runs <span className="text-muted-foreground font-normal">({r.executor.runs.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {r.executor.runs.length === 0 ? (
              <p className="text-xs text-muted-foreground">No active runs.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-3 font-medium">Run ID</th>
                      <th className="py-1.5 pr-3 font-medium">Session</th>
                      <th className="py-1.5 pr-3 font-medium">Model</th>
                      <th className="py-1.5 pr-3 font-medium">Activity</th>
                      <th className="py-1.5 pr-3 font-medium text-right">Age</th>
                      <th className="py-1.5 pr-3 font-medium">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...r.executor.runs].sort((a, b) => b.ageMs - a.ageMs).map(run => (
                      <tr key={run.runId} className="border-b border-border/50" data-testid={`row-executor-run-${run.runId}`}>
                        <td className="py-1.5 pr-3 font-mono truncate max-w-[160px]" title={run.runId}>{run.runId}</td>
                        <td className="py-1.5 pr-3 font-mono text-muted-foreground truncate max-w-[160px]" title={run.sessionId ?? ""}>{run.sessionId ?? "—"}</td>
                        <td className="py-1.5 pr-3 font-mono">{run.model ?? "—"}</td>
                        <td className="py-1.5 pr-3">{run.activity ?? "—"}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{formatMs(run.ageMs)}</td>
                        <td className="py-1.5 pr-3">
                          {run.aborted ? (
                            <Badge variant="destructive" className="text-xs px-1.5 py-0">aborted</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs px-1.5 py-0">running</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        </div>
      </div>
    </div>
  );
}
