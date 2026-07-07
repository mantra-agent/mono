import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PipelineCockpit,
  type PipelineStatus,
  type PipelineStep,
} from "@/components/pipeline-cockpit";
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

export type StatusFamily =
  | "running"
  | "deploying"
  | "failed"
  | "stopped"
  | "unknown";

export function statusFamily(status: string | undefined | null): StatusFamily {
  switch ((status || "").toUpperCase()) {
    case "SUCCESS":
      return "running";
    case "BUILDING":
    case "DEPLOYING":
    case "WAITING":
    case "QUEUED":
    case "INITIALIZING":
      return "deploying";
    case "FAILED":
    case "CRASHED":
      return "failed";
    case "REMOVED":
    case "SLEEPING":
    case "SKIPPED":
      return "stopped";
    default:
      return "unknown";
  }
}

export function statusLabel(status: string | undefined | null): string {
  if (!status) return "Unknown";
  const f = statusFamily(status);
  if (f === "running") return "Running";
  if (f === "deploying") return "Deploying";
  if (f === "failed") return status === "CRASHED" ? "Crashed" : "Failed";
  if (f === "stopped")
    return status === "SLEEPING"
      ? "Sleeping"
      : status === "REMOVED"
        ? "Removed"
        : "Stopped";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

export function detailedStatusLabel(status: string | undefined | null): string {
  if (!status) return "Unknown";
  const upper = status.toUpperCase();
  switch (upper) {
    case "BUILDING":
      return "Building";
    case "DEPLOYING":
      return "Deploying";
    case "INITIALIZING":
      return "Initializing";
    case "QUEUED":
      return "Queued";
    case "WAITING":
      return "Waiting";
    case "SUCCESS":
      return "Running";
    case "CRASHED":
      return "Crashed";
    case "FAILED":
      return "Failed";
    case "SLEEPING":
      return "Sleeping";
    case "REMOVED":
      return "Removed";
    case "SKIPPED":
      return "Skipped";
    default:
      return status.charAt(0) + status.slice(1).toLowerCase();
  }
}

export const familyClasses: Record<
  StatusFamily,
  { dot: string; badge: string; border: string }
> = {
  running: {
    dot: "bg-success",
    badge: "bg-success/15 text-success-foreground border-success/30",
    border: "border-l-success",
  },
  deploying: {
    dot: "bg-active animate-pulse",
    badge: "bg-active/10 text-active border-active/30",
    border: "border-l-active",
  },
  failed: {
    dot: "bg-error",
    badge: "bg-error/10 text-error border-error/30",
    border: "border-l-error",
  },
  stopped: {
    dot: "bg-muted-foreground",
    badge: "bg-muted text-muted-foreground border-border",
    border: "border-l-muted-foreground",
  },
  unknown: {
    dot: "bg-border",
    badge: "bg-muted text-muted-foreground border-border",
    border: "border-l-border",
  },
};

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

export function commitUrl(
  repo: string | null | undefined,
  hash: string | null | undefined,
): string | null {
  if (!hash) return null;
  if (!repo) return null;
  const m = repo.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}/commit/${hash}`;
}

export function formatBuildElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
  switch (level) {
    case "error":
      return "text-error";
    case "warn":
      return "text-warning";
    case "debug":
      return "text-muted-foreground";
    default:
      return "text-foreground";
  }
}

export const MAX_LOG_LINES = 500;

export interface BuildStatusPanelProps {
  deployment: DevDeploymentSummary;
  /** Endpoint that returns merged build + deploy logs for the deployment. */
  buildLogsUrl?: string;
  /** Endpoint to POST to when the user clicks "Retry build" (only used on failure).
   *  When omitted, the retry button is hidden. */
  retryUrl?: string;
  /** Human label for the environment, used in the panel heading and in the
   *  default invalidation key. Defaults to "dev" for backwards compatibility. */
  environmentLabel?: string;
  /** Query keys to invalidate after a successful retry. Defaults to the dev
   *  status / deployments queries so the existing Development tab keeps the
   *  exact same behaviour without callers having to opt in. */
  invalidateOnRetry?: readonly (readonly string[])[];
}

export function BuildStatusPanel({
  deployment,
  buildLogsUrl,
  retryUrl,
  environmentLabel = "dev",
  invalidateOnRetry = [
    ["/api/railway/dev/status"],
    ["/api/railway/dev/deployments"],
  ],
}: BuildStatusPanelProps) {
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

  const startedMs = deployment.createdAt
    ? Date.parse(deployment.createdAt)
    : NaN;
  const endedMs = deployment.updatedAt ? Date.parse(deployment.updatedAt) : NaN;
  const elapsedMs = !Number.isNaN(startedMs)
    ? isDeploying
      ? now - startedMs
      : Number.isNaN(endedMs)
        ? now - startedMs
        : endedMs - startedMs
    : 0;

  const retryMutation = useMutation({
    mutationFn: async () => {
      if (!retryUrl) throw new Error("Retry not supported in this environment");
      const res = await apiRequest("POST", retryUrl, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Retrying build…" });
      for (const key of invalidateOnRetry) {
        queryClient.invalidateQueries({ queryKey: [...key] });
      }
    },
    onError: (err: Error) => {
      toast({
        title: "Retry failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const cockpitStatus: PipelineStatus = isDeploying
    ? "running"
    : isFailed
      ? "failed"
      : family === "running"
        ? "succeeded"
        : family === "stopped"
          ? "cancelled"
          : "idle";

  const buildLogs = (
    <div className="flex h-full max-h-[42vh] min-h-[220px] flex-1 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <div>
          <h3 className="text-sm font-semibold">Build logs</h3>
          <p className="text-xs text-muted-foreground">
            Railway build and deploy output for debugging.
          </p>
        </div>
      </div>
      <BuildLogStream
        deploymentId={deployment.id}
        pollMs={isDeploying ? 3_000 : isFailed ? 10_000 : false}
        buildLogsUrl={buildLogsUrl}
      />
    </div>
  );

  const steps: PipelineStep[] = [
    {
      id: "railway-build",
      label: "Build application",
      status: isFailed
        ? "failed"
        : isDeploying
          ? "running"
          : family === "running"
            ? "succeeded"
            : "pending",
      description: isFailed
        ? "Railway reported a failed build or deploy."
        : isDeploying
          ? deployment.commitMessage || "Build/deploy logs are available here."
          : deployment.commitMessage ||
            "Railway build completed for this deployment.",
      icon: Rocket,
      detail: (
        <div className="space-y-3">
          <div className="grid gap-2 @md:grid-cols-2 @xl:grid-cols-3">
            <div className="rounded-lg border bg-card/60 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Deployment ID</div>
              <div className="mt-1 font-mono text-sm">{deployment.id.slice(0, 8)}</div>
            </div>
            {deployment.commitHash ? (
              <div className="rounded-lg border bg-card/60 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Commit</div>
                <div className="mt-1 font-mono text-sm">{deployment.commitHash.slice(0, 8)}</div>
              </div>
            ) : null}
            {deployment.branch ? (
              <div className="rounded-lg border bg-card/60 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Branch</div>
                <div className="mt-1 text-sm">{deployment.branch}</div>
              </div>
            ) : null}
          </div>
          {buildLogs}
        </div>
      ),
    },
    {
      id: "verify-environment",
      label: `Verify ${environmentLabel} environment`,
      status:
        family === "running" ? "succeeded" : isFailed ? "failed" : "pending",
      description:
        family === "running"
          ? `Deployed ${relativeTime(deployment.updatedAt || deployment.createdAt)}`
          : deployment.url || deployment.staticUrl
            ? "Environment URL is available."
            : "Waiting for a reachable deployment URL.",
      detail: (
        <div className="space-y-3">
          {deployment.url || deployment.staticUrl ? (
            <div className="rounded-lg border bg-card/60 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Environment URL</div>
              <a
                href={deployment.url || deployment.staticUrl || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex max-w-full text-sm text-cta underline-offset-4 hover:text-active hover:underline"
              >
                <span className="truncate">{deployment.url || deployment.staticUrl}</span>
              </a>
            </div>
          ) : null}
          {deployment.url || deployment.staticUrl ? (
            <Button asChild variant="outline" className="h-9">
              <a
                href={deployment.url || deployment.staticUrl || undefined}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open environment
              </a>
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="min-w-0">
      <PipelineCockpit
        title={environmentLabel === "dev" ? "Development" : environmentLabel}
        status={cockpitStatus}
        steps={steps}
        primaryAction={
          isFailed && retryUrl
            ? {
                label: "Retry build",
                onClick: () => retryMutation.mutate(),
                pending: retryMutation.isPending,
                icon: <RefreshCw className="h-4 w-4" />,
                testId: "button-retry-build",
              }
            : undefined
        }
        testId="panel-build-status"
      />
    </div>
  );
}

export function BuildLogStream({
  deploymentId,
  pollMs,
  buildLogsUrl,
}: {
  deploymentId: string;
  pollMs: number | false;
  buildLogsUrl?: string;
}) {
  const url = buildLogsUrl ?? "/api/railway/dev/build-logs";
  const [logs, setLogs] = useState<DevLogEntry[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const { data, error, isLoading } = useQuery<{
    logs: DevLogEntry[];
    deploymentId: string | null;
  }>({
    queryKey: [url, deploymentId],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok)
        throw new Error(
          `${res.status}: ${(await res.text()) || res.statusText}`,
        );
      return res.json();
    },
    refetchInterval: pollMs,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setLogs([]);
  }, [deploymentId]);

  useEffect(() => {
    if (!data?.logs) return;
    setLogs((prev) => {
      const seen = new Set(prev.map((l) => `${l.timestamp}|${l.message}`));
      const additions = data.logs.filter(
        (l) => !seen.has(`${l.timestamp}|${l.message}`),
      );
      if (additions.length === 0) return prev;
      const merged = [...prev, ...additions];
      return merged.length > MAX_LOG_LINES
        ? merged.slice(-MAX_LOG_LINES)
        : merged;
    });
  }, [data]);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-auto bg-background font-mono text-xs p-3"
      data-testid="build-log-output"
    >
      {isLoading && logs.length === 0 ? (
        <div className="text-muted-foreground">
          Connecting to build log stream…
        </div>
      ) : error && logs.length === 0 ? (
        <div className="text-error">
          Failed to load build logs: {(error as Error).message}
        </div>
      ) : logs.length === 0 ? (
        <div className="text-muted-foreground">Waiting for build output…</div>
      ) : (
        logs.map((l, i) => {
          const lvl = levelOf(l.severity);
          return (
            <div
              key={`${l.timestamp}-${i}`}
              className="flex gap-3 leading-tight py-0.5"
            >
              <span
                title={l.timestamp}
                className="text-muted-foreground shrink-0 tabular-nums"
              >
                {relativeTime(l.timestamp)}
              </span>
              <span
                className={cn(
                  "whitespace-pre-wrap break-words",
                  levelClasses(lvl),
                )}
              >
                {l.message}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
