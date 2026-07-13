import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  ExternalLink,
  GitCommit,
  GitMerge,
  FileText,
  Loader2,
  MoreHorizontal,
  Play,
  RotateCw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import type { DevDeploymentSummary } from "@/components/build-status-panel";
import {
  PipelineCockpit,
  type PipelineStatus,
  type PipelineStep,
} from "@/components/pipeline-cockpit";

// ─── Production deploy status (mirrors useDevStatus on the Development tab)

interface ProdStatusOk {
  configured: true;
  prodUrl: string | null;
  projectId: string;
  environmentId: string;
  serviceId: string;
  statusError: string | null;
  fetchedAt: string;
  deployment: DevDeploymentSummary | null;
}

interface ProdStatusMissing {
  configured: false;
  hasToken: boolean;
  missing: {
    projectId: boolean;
    environmentId: boolean;
    serviceId: boolean;
    prodUrl: boolean;
  };
  prodUrl: string | null;
}

export type ProdStatus = ProdStatusOk | ProdStatusMissing;

const PROD_DEPLOYING_STATUSES = new Set([
  "BUILDING",
  "DEPLOYING",
  "WAITING",
  "QUEUED",
  "INITIALIZING",
]);

export function isProdDeploying(status: ProdStatus | undefined): boolean {
  if (!status || !("configured" in status) || !status.configured) return false;
  const s = (status.deployment?.status ?? "").toUpperCase();
  return PROD_DEPLOYING_STATUSES.has(s);
}

export function useProdStatus() {
  return useQuery<ProdStatus>({
    queryKey: ["/api/railway/prod/status"],
    queryFn: async () => {
      const res = await fetch("/api/railway/prod/status", {
        credentials: "include",
      });
      if (res.status === 503) return (await res.json()) as ProdStatus;
      if (!res.ok)
        throw new Error(
          `${res.status}: ${(await res.text()) || res.statusText}`,
        );
      return (await res.json()) as ProdStatus;
    },
    refetchInterval: (query) =>
      isProdDeploying(query.state.data as ProdStatus | undefined)
        ? 5_000
        : 15_000,
    refetchOnWindowFocus: true,
    staleTime: 2_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

// ─── Types ─────────────────────────────────────────────────────────────────────

type StageName =
  | "fast_forward_live"
  | "railway_build"
  | "trigger_redeploy_fallback"
  | "wait_for_success"
  | "health_check"
  | "ready";

type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string | null;
  url: string;
}

interface DirtyMergeDiagnosis {
  mergeableState: string;
  prNumber: number | null;
  prHtmlUrl: string | null;
  filesUrl: string | null;
  driftCommits: CommitSummary[];
  driftKnown: boolean;
  conflictingFiles: Array<{
    filename: string;
    status: string;
    blobUrl: string | null;
  }>;
  filesTruncated: boolean;
  explanation: string;
}

interface PublishStage {
  name: StageName;
  label: string;
  status: StageStatus;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  log: string[];
  error: string | null;
  dirtyMerge?: DirtyMergeDiagnosis | null;
}

type VersionIncrement = "minor" | "major" | "flagship";

interface ReleaseNotes {
  newFeatures: string[];
  improvements: string[];
  fixes: string[];
}

interface PublishRun {
  id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  startedByName: string | null;
  summary: {
    devCommit: { sha: string; shortSha: string; message: string } | null;
    devBranch: string | null;
    prodCommit: { sha: string; shortSha: string; message: string } | null;
    prodBranch: string;
    repo: string | null;
    commits: CommitSummary[];
  };
  stages: PublishStage[];
  prUrl: string | null;
  prNumber: number | null;
  deploymentId: string | null;
  deploymentUrl: string | null;
  newProdCommitSha: string | null;
  release: {
    increment: VersionIncrement;
    previousVersion: string;
    version: string;
    recordedAt: string | null;
    notes: ReleaseNotes;
  } | null;
  prodUrl: string | null;
  resumeFromStage: StageName | null;
}

export interface PublishSummary {
  ready: boolean;
  reason: string | null;
  repo: string | null;
  devBranch: string | null;
  prodBranch: string;
  prodUrl: string | null;
  devCommit: { sha: string; shortSha: string; message: string } | null;
  prodCommit: { sha: string; shortSha: string; message: string } | null;
  aheadBy: number;
  commits: CommitSummary[];
  compareError?: string;
  versioning: {
    currentVersion: string;
    latestRelease: {
      version: string;
      increment: VersionIncrement;
      promotedCommitSha: string;
      promotedAt: string;
    } | null;
  };
  run: PublishRun | null;
}

// ─── Hooks ─────────────────────────────────────────────────────────────────────

export function usePublishSummary() {
  return useQuery<PublishSummary>({
    queryKey: ["/api/railway/publish/summary"],
    refetchInterval: (query) => {
      const data = query.state.data as PublishSummary | undefined;
      return data?.run?.status === "running" ? 2000 : 30000;
    },
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

// ─── Small components ──────────────────────────────────────────────────────────

function StageIcon({ status }: { status: StageStatus }) {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="h-5 w-5 text-success" />;
    case "failed":
      return <XCircle className="h-5 w-5 text-error" />;
    case "running":
      return <Loader2 className="h-5 w-5 text-info animate-spin" />;
    case "skipped":
      return <Ban className="h-5 w-5 text-muted-foreground" />;
    default:
      return <Circle className="h-5 w-5 text-muted-foreground/50" />;
  }
}

function StageDuration({ stage }: { stage: PublishStage }) {
  if (!stage.startedAt) return null;
  const ms = stage.durationMs ?? Date.now() - Date.parse(stage.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const label =
    ms < 1000
      ? `${ms}ms`
      : ms < 60_000
        ? `${(ms / 1000).toFixed(1)}s`
        : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return (
    <span className="text-xs text-muted-foreground tabular-nums">{label}</span>
  );
}

function RunStatusBadge({ status }: { status: PublishRun["status"] }) {
  const variant: "default" | "secondary" | "destructive" | "outline" =
    status === "succeeded"
      ? "default"
      : status === "failed"
        ? "destructive"
        : status === "cancelled"
          ? "outline"
          : "secondary";
  const label =
    status === "running"
      ? "Running"
      : status === "succeeded"
        ? "Succeeded"
        : status === "failed"
          ? "Failed"
          : "Cancelled";
  return (
    <Badge
      variant={variant}
      className="text-xs py-0 px-1.5"
      data-testid={`badge-run-status-${status}`}
    >
      {label}
    </Badge>
  );
}

// ─── Inline build log (replaces standalone BuildStatusPanel for publish) ──────

function InlineBuildLog({ isActive }: { isActive: boolean }) {
  const preRef = useRef<HTMLPreElement>(null);
  const { data, isLoading } = useQuery<string>({
    queryKey: ["/api/railway/prod/build-logs", "inline"],
    queryFn: async () => {
      const res = await fetch("/api/railway/prod/build-logs", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = await res.json();
      if (typeof json === "string") return json;
      if (Array.isArray(json))
        return json
          .map((l: { message?: string }) => l.message ?? String(l))
          .join("\n");
      return JSON.stringify(json, null, 2);
    },
    enabled: isActive,
    refetchInterval: isActive ? 3000 : false,
    retry: false,
  });

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [data]);

  if (isLoading) {
    return (
      <p className="text-xs text-muted-foreground mt-1.5">
        Loading build logs...
      </p>
    );
  }

  if (!data) {
    return (
      <p className="text-xs text-muted-foreground mt-1.5">
        Build in progress...
      </p>
    );
  }

  return (
    <pre
      ref={preRef}
      className="mt-1.5 text-xs whitespace-pre-wrap bg-background border border-border rounded p-2 max-h-60 overflow-auto font-mono"
      data-testid="inline-build-log"
    >
      {data}
    </pre>
  );
}

// ─── DirtyMergeCard ────────────────────────────────────────────────────────────

interface DirtyMergeCardProps {
  diagnosis: DirtyMergeDiagnosis;
  onReconcile: () => void;
  reconcilePending: boolean;
}

function DirtyMergeCard({
  diagnosis,
  onReconcile,
  reconcilePending,
}: DirtyMergeCardProps) {
  const drift = diagnosis.driftCommits;
  return (
    <div
      className="mt-2 rounded-md border border-error/30 bg-error/5 p-3 space-y-3"
      data-testid="dirty-merge-diagnosis"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-error shrink-0 mt-0.5" />
        <p className="text-xs text-error" data-testid="text-dirty-explanation">
          {diagnosis.explanation}
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Drift commits on live
            {diagnosis.driftKnown ? ` (${drift.length})` : ""}
          </span>
        </div>
        {!diagnosis.driftKnown ? (
          <p
            className="text-xs text-muted-foreground italic"
            data-testid="text-drift-unknown"
          >
            Drift unknown — couldn't compare branches. Try Reconcile anyway.
          </p>
        ) : drift.length === 0 ? (
          <p
            className="text-xs text-muted-foreground italic"
            data-testid="text-no-drift-commits"
          >
            No drift commits — conflict is structural.
          </p>
        ) : (
          <ul className="space-y-1.5" data-testid="list-drift-commits">
            {drift.map((c) => (
              <li
                key={c.sha}
                className="flex items-start gap-2 text-xs min-w-0"
                data-testid={`drift-commit-${c.shortSha}`}
              >
                <GitCommit className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-primary hover:underline shrink-0"
                >
                  {c.shortSha}
                </a>
                <span className="flex-1 break-words">
                  {c.message.split("\n")[0]}
                </span>
                {c.author && (
                  <span className="text-muted-foreground whitespace-nowrap">
                    {c.author}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(diagnosis.filesUrl || diagnosis.conflictingFiles.length > 0) && (
        <div>
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Files in PR ({diagnosis.conflictingFiles.length}
              {diagnosis.filesTruncated ? "+" : ""})
            </span>
            {diagnosis.filesUrl && (
              <a
                href={diagnosis.filesUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                data-testid="link-pr-files"
              >
                Files Changed <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          {diagnosis.conflictingFiles.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              Couldn't fetch the PR's file list.
            </p>
          ) : (
            <ul
              className="space-y-0.5 max-h-40 overflow-auto"
              data-testid="list-conflicting-files"
            >
              {diagnosis.conflictingFiles.map((f) => (
                <li
                  key={f.filename}
                  className="flex items-center gap-2 text-xs min-w-0"
                  data-testid={`conflicting-file-${f.filename}`}
                >
                  <span className="text-xs uppercase text-muted-foreground w-14 shrink-0">
                    {f.status}
                  </span>
                  {f.blobUrl ? (
                    <a
                      href={f.blobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-primary hover:underline truncate"
                      title={f.filename}
                    >
                      {f.filename}
                    </a>
                  ) : (
                    <span className="font-mono truncate" title={f.filename}>
                      {f.filename}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center justify-end pt-1 border-t border-error/20">
        <Button
          size="sm"
          variant="outline"
          onClick={onReconcile}
          disabled={
            reconcilePending || (diagnosis.driftKnown && drift.length === 0)
          }
          data-testid="button-reconcile"
          title={
            diagnosis.driftKnown && drift.length === 0
              ? "No drift commits to reconcile — fix the structural conflict on GitHub instead."
              : undefined
          }
        >
          {reconcilePending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
          ) : (
            <GitMerge className="h-3.5 w-3.5 mr-1.5" />
          )}
          Reconcile live → dev
        </Button>
      </div>
    </div>
  );
}

// ─── Stages timeline ───────────────────────────────────────────────────────────

interface StagesTimelineProps {
  stages: PublishStage[];
  prodDeploying?: boolean;
  onReconcile?: () => void;
  reconcilePending?: boolean;
}

function StagesTimeline({
  stages,
  prodDeploying = false,
  onReconcile,
  reconcilePending = false,
}: StagesTimelineProps) {
  return (
    <ol
      className="relative space-y-3 pl-2"
      data-testid="publish-stages-timeline"
    >
      {stages.map((stage, idx) => {
        const isLast = idx === stages.length - 1;
        const showBuildLog =
          stage.name === "railway_build" &&
          stage.status === "running" &&
          prodDeploying;
        return (
          <li
            key={stage.name}
            className="relative flex items-start gap-3"
            data-testid={`stage-${stage.name}`}
            data-status={stage.status}
          >
            <div className="flex flex-col items-center self-stretch">
              <StageIcon status={stage.status} />
              {!isLast && (
                <div
                  className={cn(
                    "w-px flex-1 mt-1",
                    stage.status === "succeeded" || stage.status === "skipped"
                      ? "bg-success/40"
                      : "bg-border",
                  )}
                />
              )}
            </div>
            <div className="flex-1 pb-3 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span
                  className={cn(
                    "text-sm font-medium",
                    stage.status === "running" && "text-foreground",
                    stage.status === "pending" && "text-muted-foreground",
                  )}
                  data-testid={`stage-label-${stage.name}`}
                >
                  {stage.label}
                </span>
                <StageDuration stage={stage} />
              </div>
              {stage.message && (
                <p
                  className={cn(
                    "text-xs mt-0.5 break-words",
                    stage.status === "failed"
                      ? "text-error"
                      : "text-muted-foreground",
                  )}
                  data-testid={`stage-message-${stage.name}`}
                >
                  {stage.message}
                </p>
              )}
              {showBuildLog && <InlineBuildLog isActive />}
              {stage.log.length > 0 && !showBuildLog && (
                <details className="mt-1.5">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                    {stage.log.length} log line
                    {stage.log.length === 1 ? "" : "s"}
                  </summary>
                  <pre className="mt-1 text-xs whitespace-pre-wrap bg-muted/40 rounded p-2 max-h-40 overflow-auto font-mono">
                    {stage.log.join("\n")}
                  </pre>
                </details>
              )}
              {stage.dirtyMerge && onReconcile && (
                <DirtyMergeCard
                  diagnosis={stage.dirtyMerge}
                  onReconcile={onReconcile}
                  reconcilePending={reconcilePending}
                />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ─── Commits list ──────────────────────────────────────────────────────────────

function CommitsList({ commits }: { commits: CommitSummary[] }) {
  if (commits.length === 0) {
    return (
      <p
        className="text-xs text-muted-foreground italic"
        data-testid="text-no-commits"
      >
        No new commits to promote.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5" data-testid="list-pending-commits">
      {commits.map((c) => (
        <li
          key={c.sha}
          className="flex items-start gap-2 text-xs min-w-0"
          data-testid={`commit-row-${c.shortSha}`}
        >
          <GitCommit className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <a
            href={c.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-primary hover:underline shrink-0"
          >
            {c.shortSha}
          </a>
          <span className="flex-1 break-words">{c.message.split("\n")[0]}</span>
          {c.author && (
            <span className="text-muted-foreground whitespace-nowrap">
              {c.author}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── Zone 1: Action Bar ────────────────────────────────────────────────────────

interface ActionBarProps {
  data: PublishSummary;
  isRunning: boolean;
  canStart: boolean;
  canRetry: boolean;
  disabledReason: string | null;
  prodDeploying: boolean;
  isFetching: boolean;
  onPublish: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onRedeploy: () => void;
  onRefresh: () => void;
  publishPending: boolean;
  cancelPending: boolean;
  retryPending: boolean;
  redeployPending: boolean;
}

function PublishActionBar({
  data,
  isRunning,
  canStart,
  canRetry,
  disabledReason,
  prodDeploying,
  isFetching,
  onPublish,
  onCancel,
  onRetry,
  onRedeploy,
  onRefresh,
  publishPending,
  cancelPending,
  retryPending,
  redeployPending,
}: ActionBarProps) {
  const devSha = data.devCommit?.shortSha ?? "???";
  const prodSha = data.prodCommit?.shortSha ?? "???";
  const branchText = `${data.devBranch ?? "dev"} @ ${devSha} → ${data.prodBranch} @ ${prodSha}`;
  const aheadText = data.aheadBy > 0 ? `${data.aheadBy} ahead` : "in sync";

  // Determine primary button
  let buttonLabel: string;
  let buttonIcon: React.ReactNode;
  let buttonAction: () => void;
  let buttonDisabled: boolean;
  let buttonVariant: "default" | "outline" = "default";

  if (isRunning) {
    buttonLabel = "Cancel";
    buttonIcon = cancelPending ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    ) : (
      <XCircle className="h-3.5 w-3.5" />
    );
    buttonAction = onCancel;
    buttonDisabled = cancelPending;
    buttonVariant = "outline";
  } else if (canRetry) {
    buttonLabel = "Retry";
    buttonIcon = retryPending ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    ) : (
      <RotateCw className="h-3.5 w-3.5" />
    );
    buttonAction = onRetry;
    buttonDisabled = retryPending;
    buttonVariant = "outline";
  } else {
    buttonLabel = "Publish";
    buttonIcon = publishPending ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    ) : (
      <Play className="h-3.5 w-3.5" />
    );
    buttonAction = onPublish;
    buttonDisabled = !canStart || publishPending;
  }

  const primaryButton = (
    <Button
      size="sm"
      variant={buttonVariant}
      onClick={buttonAction}
      disabled={buttonDisabled}
      data-testid="button-primary-action"
    >
      {buttonIcon}
      <span className="ml-1.5">{buttonLabel}</span>
    </Button>
  );

  return (
    <div
      className="flex items-center justify-between gap-4 px-4 py-3 border-b border-border"
      data-testid="publish-action-bar"
    >
      <span
        className="text-sm font-mono text-muted-foreground truncate"
        data-testid="text-branch-state"
      >
        {branchText} ·{" "}
        <span className={data.aheadBy > 0 ? "text-foreground font-medium" : ""}>
          {aheadText}
        </span>
      </span>

      <div className="flex items-center gap-2 shrink-0">
        {disabledReason && !isRunning && !canRetry ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{primaryButton}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <p className="text-xs">{disabledReason}</p>
            </TooltipContent>
          </Tooltip>
        ) : (
          primaryButton
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              data-testid="button-overflow-menu"
              aria-label="Publish actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={onRedeploy}
              disabled={redeployPending || prodDeploying}
              data-testid="menu-redeploy"
            >
              <RotateCw className="h-3.5 w-3.5 mr-2" />
              Redeploy Production
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onRefresh}
              disabled={isFetching}
              data-testid="menu-refresh"
            >
              {isFetching ? (
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
              ) : (
                <RotateCw className="h-3.5 w-3.5 mr-2" />
              )}
              Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ─── Zone 2: Feed ──────────────────────────────────────────────────────────────

interface FeedProps {
  data: PublishSummary;
  run: PublishRun | null;
  prodDeploying: boolean;
  onReconcile: () => void;
  reconcilePending: boolean;
}

function PublishFeed({
  data,
  run,
  prodDeploying,
  onReconcile,
  reconcilePending,
}: FeedProps) {
  const startedRel = useMemo(
    () =>
      run
        ? formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })
        : null,
    [run?.startedAt],
  );

  // Running or failed: timeline is the primary content
  if (run && (run.status === "running" || run.status === "failed")) {
    return (
      <div className="space-y-4">
        {data.compareError && (
          <p className="text-xs text-error" data-testid="text-compare-error">
            Couldn't compare branches: {data.compareError}
          </p>
        )}
        <RunHeader run={run} startedRel={startedRel} />
        <StagesTimeline
          stages={run.stages}
          prodDeploying={prodDeploying}
          onReconcile={onReconcile}
          reconcilePending={reconcilePending}
        />
      </div>
    );
  }

  // Idle: show commits (if any) + optional collapsed last run
  return (
    <div className="space-y-4">
      {data.compareError && (
        <p className="text-xs text-error" data-testid="text-compare-error">
          Couldn't compare branches: {data.compareError}
        </p>
      )}

      {data.aheadBy > 0 ? (
        <CommitsList commits={data.commits} />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="text-in-sync">
          Nothing to deploy. {data.devBranch ?? "main"} and {data.prodBranch}{" "}
          are in sync.
        </p>
      )}

      {run && (
        <details className="group" data-testid="details-last-run">
          <summary className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            <RunStatusBadge status={run.status} />
            <span>Last run{startedRel ? ` · ${startedRel}` : ""}</span>
            {run.startedByName && <span>by {run.startedByName}</span>}
          </summary>
          <div className="mt-3">
            <RunHeader run={run} startedRel={startedRel} />
            <StagesTimeline
              stages={run.stages}
              onReconcile={onReconcile}
              reconcilePending={reconcilePending}
            />
          </div>
        </details>
      )}
    </div>
  );
}

/** Compact run metadata row: PR link, deployment link */
function RunHeader({
  run,
  startedRel,
}: {
  run: PublishRun;
  startedRel: string | null;
}) {
  if (!run.prUrl && !run.deploymentUrl) return null;
  return (
    <div
      className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap"
      data-testid="run-header"
    >
      <RunStatusBadge status={run.status} />
      {run.prUrl && (
        <a
          href={run.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground inline-flex items-center gap-1"
          data-testid="link-pr"
        >
          PR #{run.prNumber} <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {run.deploymentUrl && (
        <a
          href={run.deploymentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground inline-flex items-center gap-1"
          data-testid="link-deployment"
          title="Open in Railway console"
        >
          Deployment{run.deploymentId ? ` ${run.deploymentId.slice(0, 8)}` : ""}{" "}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
      {startedRel && (
        <span data-testid="text-run-started">
          started {startedRel}
          {run.startedByName ? ` by ${run.startedByName}` : ""}
        </span>
      )}
    </div>
  );
}

// ─── Main tab ──────────────────────────────────────────────────────────────────

export function DevPublishTab() {
  const { data, isLoading, error, refetch, isFetching } = usePublishSummary();
  const { data: prodStatus } = useProdStatus();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [versionIncrement, setVersionIncrement] = useState<VersionIncrement>("minor");
  const [reconcileConfirmOpen, setReconcileConfirmOpen] = useState(false);
  const [redeployConfirmOpen, setRedeployConfirmOpen] = useState(false);

  const prodDeploying = isProdDeploying(prodStatus);

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  const startMut = useMutation<unknown, Error, VersionIncrement>({
    mutationFn: async (increment) => {
      const res = await apiRequest("POST", "/api/railway/publish/start", { increment });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/railway/publish/summary"],
      });
      toast({ title: "Publish started", description: "Promoting dev → live." });
    },
    onError: (err) => {
      toast({
        title: "Couldn't start publish",
        description: errorMessage(err),
        variant: "destructive",
      });
    },
  });

  const cancelMut = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/railway/publish/cancel", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/railway/publish/summary"],
      });
      toast({ title: "Publish cancelled" });
    },
    onError: (err) => {
      toast({
        title: "Couldn't cancel",
        description: errorMessage(err),
        variant: "destructive",
      });
    },
  });

  const reconcileMut = useMutation<
    {
      url: string;
      number: number;
      created: boolean;
      merged: boolean;
      mergeSha: string | null;
    },
    Error,
    void
  >({
    mutationFn: async () => {
      const res = await apiRequest(
        "POST",
        "/api/railway/publish/reconcile",
        {},
      );
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/railway/publish/summary"],
      });
      const title = result.merged
        ? `Reconciled live → dev (PR #${result.number} merged)`
        : `Reconcile PR #${result.number} was already merged`;
      toast({
        title,
        description:
          "Drift commits absorbed into dev. You can publish again now.",
      });
    },
    onError: (err) => {
      toast({
        title: "Couldn't reconcile",
        description: errorMessage(err),
        variant: "destructive",
      });
    },
  });

  const retryMut = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/railway/publish/retry", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/railway/publish/summary"],
      });
      toast({ title: "Retrying from failed stage" });
    },
    onError: (err) => {
      toast({
        title: "Couldn't retry",
        description: errorMessage(err),
        variant: "destructive",
      });
    },
  });

  const redeployMut = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/railway/prod/redeploy", {});
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/railway/prod/status"] });
      queryClient.invalidateQueries({
        queryKey: ["/api/railway/publish/summary"],
      });
      toast({
        title: "Production redeploy triggered",
        description: "Railway is rebuilding the live service.",
      });
    },
    onError: (err) => {
      toast({
        title: "Couldn't redeploy production",
        description: errorMessage(err),
        variant: "destructive",
      });
    },
  });

  const run = data?.run ?? null;
  const isRunning = run?.status === "running";
  const canStart = !!data?.ready && data.aheadBy > 0 && !isRunning;
  const canRetry = run?.status === "failed" && !isRunning;

  let disabledReason: string | null = null;
  let inSyncReason: string | null = null;
  if (data) {
    if (isRunning) disabledReason = "A publish is already in progress.";
    else if (!data.ready)
      disabledReason = data.reason ?? "Setup is incomplete.";
    else if (data.aheadBy === 0) {
      inSyncReason = `'${data.devBranch ?? "dev"}' is already in sync with '${data.prodBranch}'.`;
      disabledReason = inSyncReason;
    }
  }

  // Loading state
  if (isLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        data-testid="publish-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Error state (no cached data)
  if (error && !data) {
    return (
      <div className="p-6" data-testid="publish-error">
        <div className="rounded-md border p-4 flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-warning" />
          <div className="flex-1">
            <p className="text-sm font-medium">Couldn't load publish status.</p>
            <p className="text-xs text-muted-foreground mt-1">
              {(error as Error).message}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            data-testid="button-retry-publish"
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const pipelineStatus: PipelineStatus = isRunning
    ? "running"
    : run?.status === "failed"
      ? "failed"
      : run?.status === "cancelled"
        ? "cancelled"
        : run?.status === "succeeded"
          ? "succeeded"
          : canStart
            ? "ready"
            : data.ready
              ? "idle"
              : "blocked";

  const startedRel = run
    ? formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })
    : null;
  const changePreview = (
    <div className="rounded-xl border bg-background/50 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Change preview</h3>
          <p className="text-sm text-muted-foreground">
            Commits that will move from development to production.
          </p>
        </div>
        {run && <RunHeader run={run} startedRel={startedRel} />}
      </div>
      {data.aheadBy > 0 ? (
        <CommitsList commits={data.commits} />
      ) : (
        <p className="text-sm text-muted-foreground">No new commits to promote.</p>
      )}
    </div>
  );

  const productionDetails = (
    <div className="grid gap-2 @md:grid-cols-2 @xl:grid-cols-3">
      {run?.prUrl ? (
        <div className="rounded-lg border bg-card/60 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">PR</div>
          <a href={run.prUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex text-sm text-cta underline-offset-4 hover:text-active hover:underline">
            #{run.prNumber}
          </a>
        </div>
      ) : null}
      {run?.deploymentUrl ? (
        <div className="rounded-lg border bg-card/60 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Deployment</div>
          <a href={run.deploymentUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex text-sm text-cta underline-offset-4 hover:text-active hover:underline">
            {run.deploymentId ? run.deploymentId.slice(0, 8) : "Railway"}
          </a>
        </div>
      ) : null}
      {data.prodUrl ? (
        <div className="rounded-lg border bg-card/60 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Live URL</div>
          <a href={data.prodUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex max-w-full text-sm text-cta underline-offset-4 hover:text-active hover:underline">
            <span className="truncate">{data.prodUrl}</span>
          </a>
        </div>
      ) : null}
      {data.repo ? (
        <div className="rounded-lg border bg-card/60 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Repository</div>
          <div className="mt-1 text-sm">{data.repo}</div>
        </div>
      ) : null}
    </div>
  );

  const publishSteps: PipelineStep[] = run?.stages.length
    ? run.stages.map((stage) => {
        const showBuildLog =
          stage.name === "railway_build" &&
          stage.status === "running" &&
          prodDeploying;
        return {
          id: stage.name,
          label: stage.label,
          status: stage.status,
          description: stage.message || stage.error || undefined,
          meta: <StageDuration stage={stage} />,
          detail: (
            <>
              {stage.name === "compare" && changePreview}
              {(stage.name === "railway_build" || stage.name === "health_check") && productionDetails}
              {showBuildLog && <InlineBuildLog isActive />}
              {stage.log.length > 0 && !showBuildLog && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    {stage.log.length} log line
                    {stage.log.length === 1 ? "" : "s"}
                  </summary>
                  <pre className="mt-2 max-h-44 overflow-auto rounded-md border bg-background p-3 font-mono text-xs whitespace-pre-wrap">
                    {stage.log.join("\n")}
                  </pre>
                </details>
              )}
              {stage.dirtyMerge && (
                <DirtyMergeCard
                  diagnosis={stage.dirtyMerge}
                  onReconcile={() => setReconcileConfirmOpen(true)}
                  reconcilePending={reconcileMut.isPending}
                />
              )}
            </>
          ),
          testId: `stage-${stage.name}`,
        } satisfies PipelineStep;
      })
    : [
        {
          id: "compare",
          label: "Compare dev and live",
          status: data.compareError ? "failed" : "succeeded",
          description: data.compareError
            ? `Couldn't compare branches: ${data.compareError}`
            : `${data.aheadBy} commit${data.aheadBy === 1 ? "" : "s"} ahead.`,
          detail: changePreview,
        },
        {
          id: "promote",
          label: "Promote commit",
          status: canStart
            ? "pending"
            : data.aheadBy === 0
              ? "skipped"
              : "pending",
          description: `Fast-forward ${data.prodBranch} to ${data.devBranch ?? "dev"}.`,
          detail: (
            <div className="grid gap-2 @md:grid-cols-2">
              <div className="rounded-lg border bg-card/60 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Source</div>
                <div className="mt-1 font-mono text-sm">{data.devBranch ?? "dev"} @ {data.devCommit?.shortSha ?? "unknown"}</div>
              </div>
              <div className="rounded-lg border bg-card/60 p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Target</div>
                <div className="mt-1 font-mono text-sm">{data.prodBranch} @ {data.prodCommit?.shortSha ?? "unknown"}</div>
              </div>
            </div>
          ),
        },
        {
          id: "deploy",
          label: "Deploy production",
          status: prodDeploying ? "running" : "pending",
          description:
            "Railway builds the live service and swaps traffic after health checks.",
          detail: (
            <div className="space-y-3">
              {productionDetails}
              {data.prodUrl ? (
                <Button asChild variant="outline" className="h-9">
                  <a href={data.prodUrl} target="_blank" rel="noopener noreferrer">
                    Open production
                  </a>
                </Button>
              ) : null}
            </div>
          ),
        },
      ];

  const devSha = data.devCommit?.shortSha ?? "unknown";
  const prodSha = data.prodCommit?.shortSha ?? "unknown";
  const primaryAction = isRunning
    ? {
        label: "Cancel",
        onClick: () => cancelMut.mutate(),
        pending: cancelMut.isPending,
        variant: "outline" as const,
        icon: <XCircle className="h-4 w-4" />,
        testId: "button-primary-action",
      }
    : canRetry
      ? {
          label: "Retry",
          onClick: () => retryMut.mutate(),
          pending: retryMut.isPending,
          variant: "outline" as const,
          icon: <RotateCw className="h-4 w-4" />,
          testId: "button-primary-action",
        }
      : {
          label: "Publish",
          onClick: () => setConfirmOpen(true),
          disabled: !canStart || startMut.isPending,
          pending: startMut.isPending,
          icon: <Play className="h-4 w-4" />,
          testId: "button-primary-action",
          tooltip: inSyncReason ?? disabledReason ?? undefined,
        };

  const secondaryActions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7"
          data-testid="button-overflow-menu"
          aria-label="Production actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => setRedeployConfirmOpen(true)}
          disabled={redeployMut.isPending || prodDeploying}
          data-testid="menu-redeploy"
        >
          <RotateCw className="mr-2 h-4 w-4" />
          Redeploy production
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="menu-refresh"
        >
          {isFetching ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RotateCw className="mr-2 h-4 w-4" />
          )}
          Refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="min-w-0" data-testid="publish-tab">
      <PipelineCockpit
        title="Production"
        status={pipelineStatus}
        statusDetail={
          disabledReason && disabledReason !== inSyncReason && !isRunning && !canRetry
            ? disabledReason
            : undefined
        }
        primaryAction={primaryAction}
        secondaryActions={secondaryActions}
        primaryActionPosition="right"
        summary={[
          {
            label: "Source",
            value: (
              <span className="font-mono">
                {data.devBranch ?? "dev"} @ {devSha}
              </span>
            ),
            detail: data.devCommit?.message || "No dev commit",
          },
          {
            label: "Target",
            value: (
              <span className="font-mono">
                {data.prodBranch} @ {prodSha}
              </span>
            ),
            detail: data.prodCommit?.message || "No live commit",
          },
          {
            label: "Delta",
            value:
              data.aheadBy > 0
                ? `${data.aheadBy} commit${data.aheadBy === 1 ? "" : "s"} ahead`
                : "In sync",
            detail: data.compareError
              ? `Compare failed: ${data.compareError}`
              : "GitHub branch comparison",
          },
          {
            label: "Version",
            value: data.versioning.currentVersion,
            detail: data.versioning.latestRelease
              ? `Release metadata recorded for ${data.versioning.latestRelease.promotedCommitSha.slice(0, 7)}`
              : "No production release recorded yet",
          },
          {
            label: "Production",
            value: prodDeploying
              ? "Deploying"
              : data.prodUrl
                ? "Configured"
                : "No URL",
            detail: data.prodUrl || "Production URL unavailable",
          },
        ]}
        steps={publishSteps}
        emptyState={
          data.aheadBy === 0 && !isRunning && !canRetry
            ? {
                icon: CheckCircle2,
                title: "Live is current",
                description: (
                  <span>
                    {data.devBranch ?? "dev"} and {data.prodBranch} point at the
                    same release state. Nothing is waiting to publish.
                  </span>
                ),
              }
            : null
        }
        testId="publish-pipeline-cockpit"
      />

      {/* Publish confirm dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="dialog-confirm-publish">
          <AlertDialogHeader>
            <AlertDialogTitle>Publish to live?</AlertDialogTitle>
            <AlertDialogDescription>
              This will fast-forward <code>{data.prodBranch}</code> to{" "}
              <code>{data.devBranch}</code>'s HEAD (no PR, no squash commit),
              wait for Railway to deploy, and health-check{" "}
              {data.prodUrl ?? "the prod URL"}.{" "}
              {data.aheadBy > 0
                ? `${data.aheadBy} commit${data.aheadBy === 1 ? "" : "s"} will go out.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Version increment</div>
            <div className="grid grid-cols-3 gap-2">
              {(["minor", "major", "flagship"] as VersionIncrement[]).map((increment) => (
                <Button
                  key={increment}
                  type="button"
                  variant={versionIncrement === increment ? "default" : "outline"}
                  className="min-h-11 capitalize"
                  onClick={() => setVersionIncrement(increment)}
                  data-testid={`button-version-${increment}`}
                >
                  {increment}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Current {data.versioning.currentVersion}. Release notes will be generated from the commits since the last live publish and stored in VERSION.md.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-confirm">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                startMut.mutate(versionIncrement);
              }}
              data-testid="button-confirm-publish"
            >
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reconcile confirm dialog */}
      <AlertDialog
        open={reconcileConfirmOpen}
        onOpenChange={setReconcileConfirmOpen}
      >
        <AlertDialogContent data-testid="dialog-confirm-reconcile">
          <AlertDialogHeader>
            <AlertDialogTitle>Reconcile live → dev?</AlertDialogTitle>
            <AlertDialogDescription>
              This will open (or reuse) a PR from <code>{data.prodBranch}</code>{" "}
              back into <code>{data.devBranch}</code> and merge it via the
              GitHub API so live's drift commits land on dev verbatim. After it
              succeeds, you can retry the publish.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reconcile">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setReconcileConfirmOpen(false);
                reconcileMut.mutate();
              }}
              data-testid="button-confirm-reconcile"
            >
              Open reconcile PR
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Production redeploy confirm dialog */}
      <AlertDialog
        open={redeployConfirmOpen}
        onOpenChange={setRedeployConfirmOpen}
      >
        <AlertDialogContent data-testid="dialog-confirm-prod-redeploy">
          <AlertDialogHeader>
            <AlertDialogTitle>Redeploy production?</AlertDialogTitle>
            <AlertDialogDescription>
              This rebuilds and redeploys the live service on Railway from the
              current <code>{data.prodBranch}</code> commit
              {data.prodCommit && (
                <>
                  {" "}
                  (<code>{data.prodCommit.shortSha}</code>)
                </>
              )}
              . Traffic flips when the new deployment goes healthy. Existing
              users may see a brief reconnect during the swap.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-prod-redeploy">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRedeployConfirmOpen(false);
                redeployMut.mutate();
              }}
              data-testid="button-confirm-prod-redeploy"
            >
              Redeploy production
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
