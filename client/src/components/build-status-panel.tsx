import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  History,
  Loader2,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

export interface DevDeploymentSummary {
  id: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  staticUrl: string | null;
  url: string | null;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor?: string | null;
  branch: string | null;
  repo: string | null;
}

export interface DevLogEntry {
  timestamp: string;
  message: string;
  severity: string | null;
}

export type StatusFamily = "running" | "deploying" | "failed" | "stopped" | "unknown";

export function statusFamily(status: string | undefined | null): StatusFamily {
  switch ((status || "").toUpperCase()) {
    case "SUCCESS": return "running";
    case "BUILDING":
    case "DEPLOYING":
    case "WAITING":
    case "QUEUED":
    case "INITIALIZING": return "deploying";
    case "FAILED":
    case "CRASHED": return "failed";
    case "REMOVED":
    case "SLEEPING":
    case "SKIPPED": return "stopped";
    default: return "unknown";
  }
}

export function statusLabel(status: string | undefined | null): string {
  if (!status) return "Unknown";
  const f = statusFamily(status);
  if (f === "running") return "Running";
  if (f === "deploying") return "Deploying";
  if (f === "failed") return status === "CRASHED" ? "Crashed" : "Failed";
  if (f === "stopped") return status === "SLEEPING" ? "Sleeping" : status === "REMOVED" ? "Removed" : "Stopped";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export function detailedStatusLabel(status: string | undefined | null): string {
  if (!status) return "Unknown";
  const upper = status.toUpperCase();
  switch (upper) {
    case "BUILDING": return "Building";
    case "DEPLOYING": return "Deploying";
    case "INITIALIZING": return "Initializing";
    case "QUEUED": return "Queued";
    case "WAITING": return "Waiting";
    case "SUCCESS": return "Running";
    case "CRASHED": return "Crashed";
    case "FAILED": return "Failed";
    case "SLEEPING": return "Sleeping";
    case "REMOVED": return "Removed";
    case "SKIPPED": return "Skipped";
    default: return status.charAt(0) + status.slice(1).toLowerCase();
  }
}

export const familyClasses: Record<StatusFamily, { dot: string; badge: string; border: string }> = {
  running: { dot: "bg-success", badge: "bg-success/15 text-success-foreground border-success/30", border: "border-l-success" },
  deploying: { dot: "bg-active animate-pulse", badge: "bg-active/10 text-active border-active/30", border: "border-l-active" },
  failed: { dot: "bg-error", badge: "bg-error/10 text-error border-error/30", border: "border-l-error" },
  stopped: { dot: "bg-muted-foreground", badge: "bg-muted text-muted-foreground border-border", border: "border-l-muted-foreground" },
  unknown: { dot: "bg-border", badge: "bg-muted text-muted-foreground border-border", border: "border-l-border" },
};

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return "—"; }
}

export function commitUrl(repo: string | null | undefined, hash: string | null | undefined): string | null {
  if (!hash || !repo) return null;
  const m = repo.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/commit/${hash}` : null;
}

export function formatBuildElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  return `${String(Math.floor(totalSec / 60)).padStart(2, "0")}:${String(totalSec % 60).padStart(2, "0")}`;
}

const LOG_LEVELS = ["all", "debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function levelOf(severity: string | null | undefined): LogLevel {
  const s = (severity || "").toLowerCase();
  if (s.includes("error") || s === "err") return "error";
  if (s.includes("warn")) return "warn";
  if (s.includes("debug")) return "debug";
  return "info";
}

export function levelClasses(level: LogLevel): string {
  if (level === "error") return "text-error";
  if (level === "warn") return "text-warning";
  if (level === "debug") return "text-muted-foreground";
  return "text-foreground";
}

export const MAX_LOG_LINES = 500;

export interface BuildStatusPanelProps {
  deployment: DevDeploymentSummary;
  buildLogsUrl?: string;
  retryUrl?: string;
  environmentLabel?: string;
  invalidateOnRetry?: readonly (readonly string[])[];
}

export function BuildStatusPanel({ deployment, buildLogsUrl, retryUrl, environmentLabel = "dev", invalidateOnRetry = [] }: BuildStatusPanelProps) {
  const { toast } = useToast();
  const family = statusFamily(deployment.status);
  const isDeploying = family === "deploying";
  const isFailed = family === "failed";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isDeploying) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isDeploying]);

  const startedMs = deployment.createdAt ? Date.parse(deployment.createdAt) : NaN;
  const endedMs = deployment.updatedAt ? Date.parse(deployment.updatedAt) : NaN;
  const elapsedMs = !Number.isNaN(startedMs) ? (isDeploying ? now - startedMs : Number.isNaN(endedMs) ? now - startedMs : endedMs - startedMs) : 0;

  const retryMutation = useMutation({
    mutationFn: async () => {
      if (!retryUrl) throw new Error("Retry not supported in this environment");
      const res = await apiRequest("POST", retryUrl, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Retrying build…" });
      for (const key of invalidateOnRetry) queryClient.invalidateQueries({ queryKey: [...key] });
    },
    onError: (err: Error) => toast({ title: "Retry failed", description: err.message, variant: "destructive" }),
  });

  const environmentUrl = deployment.url || deployment.staticUrl;
  const statusIcon = isDeploying ? <Loader2 className="h-3.5 w-3.5 animate-spin text-active" /> : isFailed ? <AlertTriangle className="h-3.5 w-3.5 text-error" /> : family === "running" ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Rocket className="h-3.5 w-3.5" />;

  return (
    <div className="min-w-0" data-testid="panel-build-status">
      <ProfileTreeRow label="Status" icon={statusIcon} hasValue showEmpty mobileLayout="inline" valueLayout="compact" actionContent={isFailed && retryUrl ? (
        <Button variant="ghost" size="icon" className="h-6 min-h-6 w-6 min-w-6 rounded-md" onClick={() => retryMutation.mutate()} disabled={retryMutation.isPending} aria-label="Retry build" data-testid="button-retry-build">
          {retryMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      ) : undefined}>
        <span className={cn("truncate", isDeploying && "text-active", isFailed && "text-error", family === "running" && "text-success")}>{detailedStatusLabel(deployment.status)} · {formatBuildElapsed(elapsedMs)}</span>
      </ProfileTreeRow>
      <ProfileTreeRow label="Build application" icon={<Rocket className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact" defaultOpen={isDeploying || isFailed} expandedContentClassName="[content-visibility:auto] [contain-intrinsic-size:auto_280px]" expandedContent={buildLogsUrl ? (
        <div className="flex max-h-[42vh] min-h-[220px] flex-col overflow-hidden border-l border-border/30 pl-3">
          <BuildLogStream deploymentId={deployment.id} pollMs={isDeploying ? 3_000 : isFailed ? 10_000 : false} buildLogsUrl={buildLogsUrl} />
        </div>
      ) : undefined}>
        <span className="truncate">{deployment.commitMessage || deployment.id.slice(0, 8)}</span>
      </ProfileTreeRow>
      <ProfileTreeRow label="Deployment" icon={<History className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact"><span className="truncate font-mono">{deployment.id.slice(0, 8)}</span></ProfileTreeRow>
      {deployment.commitHash ? <ProfileTreeRow label="Commit" icon={<History className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact"><span className="truncate font-mono">{deployment.commitHash.slice(0, 8)}</span></ProfileTreeRow> : null}
      {deployment.branch ? <ProfileTreeRow label="Branch" icon={<GitBranch className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact"><span className="truncate font-mono">{deployment.branch}</span></ProfileTreeRow> : null}
      <ProfileTreeRow label={`Verify ${environmentLabel}`} icon={family === "running" ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <ExternalLink className="h-3.5 w-3.5" />} hasValue={Boolean(environmentUrl)} showEmpty mobileLayout="inline" valueLayout="compact">
        {environmentUrl ? <a href={environmentUrl} target="_blank" rel="noopener noreferrer" className="truncate text-cta underline-offset-4 hover:text-active hover:underline">Open environment</a> : <span className="text-muted-foreground">Waiting for URL</span>}
      </ProfileTreeRow>
    </div>
  );
}

export function BuildLogStream({ deploymentId, pollMs, buildLogsUrl }: { deploymentId: string; pollMs: number | false; buildLogsUrl?: string }) {
  if (!buildLogsUrl) return null;
  const url = buildLogsUrl;
  const [logs, setLogs] = useState<DevLogEntry[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { data, error, isLoading } = useQuery<{ logs: DevLogEntry[]; deploymentId: string | null }>({
    queryKey: [url, deploymentId],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      return res.json();
    },
    refetchInterval: pollMs,
    refetchOnWindowFocus: false,
  });

  useEffect(() => setLogs([]), [deploymentId]);
  useEffect(() => {
    if (!data?.logs) return;
    setLogs((prev) => {
      const seen = new Set(prev.map((l) => `${l.timestamp}|${l.message}`));
      const additions = data.logs.filter((l) => !seen.has(`${l.timestamp}|${l.message}`));
      if (additions.length === 0) return prev;
      const merged = [...prev, ...additions];
      return merged.length > MAX_LOG_LINES ? merged.slice(-MAX_LOG_LINES) : merged;
    });
  }, [data]);
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div ref={containerRef} className="flex-1 min-h-0 overflow-auto bg-background font-mono text-xs p-3" data-testid="build-log-output">
      {isLoading && logs.length === 0 ? <div className="text-muted-foreground">Connecting to build log stream…</div> : error && logs.length === 0 ? <div className="text-error">Failed to load build logs: {(error as Error).message}</div> : logs.length === 0 ? <div className="text-muted-foreground">Waiting for build output…</div> : logs.map((l, i) => {
        const lvl = levelOf(l.severity);
        return <div key={`${l.timestamp}-${i}`} className="flex gap-3 leading-tight py-0.5"><span title={l.timestamp} className="text-muted-foreground shrink-0 tabular-nums">{relativeTime(l.timestamp)}</span><span className={cn("whitespace-pre-wrap break-words", levelClasses(lvl))}>{l.message}</span></div>;
      })}
    </div>
  );
}
