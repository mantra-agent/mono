import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChevronRight,
  ChevronDown,
  Circle,
  GitPullRequest,
  GitCommit,
  Rocket,
  Clock,
  ExternalLink,
  Info,
} from "lucide-react";
import { useTimezone } from "@/hooks/use-timezone";

// ── Types ──────────────────────────────────────────────────────────────

interface TimelineCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string | null;
  htmlUrl: string;
  timestamp: string;
}

interface TimelinePR {
  number: number;
  title: string;
  author: string | null;
  htmlUrl: string;
  mergedAt: string;
  mergeCommitSha: string | null;
  commits: TimelineCommit[];
}

interface TimelineDeploy {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  durationMs: number | null;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  branch: string | null;
  prs: TimelinePR[];
  orphanCommits: TimelineCommit[];
}

interface TimelineResponse {
  pending: TimelinePR[];
  deployments: TimelineDeploy[];
  githubConnected: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function absoluteTime(dateStr: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

function deployStatusColor(status: string): string {
  switch (status) {
    case "SUCCESS":
      return "bg-success";
    case "FAILED":
    case "CRASHED":
      return "bg-error";
    case "DEPLOYING":
    case "BUILDING":
    case "INITIALIZING":
      return "bg-info animate-pulse";
    case "REMOVING":
    case "REMOVED":
      return "bg-muted-foreground/40";
    default:
      return "bg-warning";
  }
}

function deployStatusLabel(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}

// ── Components ─────────────────────────────────────────────────────────

function CommitRow({ commit, timezone }: { commit: TimelineCommit; timezone: string }) {
  return (
    <div className="flex items-start gap-2 py-1 px-2 text-xs group">
      <GitCommit className="h-3 w-3 text-muted-foreground/60 mt-0.5 shrink-0" />
      <a
        href={commit.htmlUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-muted-foreground hover:text-foreground transition-colors"
      >
        {commit.shortSha}
      </a>
      <span className="text-foreground/80 truncate flex-1">{commit.message}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-muted-foreground/50 shrink-0">{relativeTime(commit.timestamp)}</span>
        </TooltipTrigger>
        <TooltipContent>{absoluteTime(commit.timestamp, timezone)}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function PRRow({ pr, timezone }: { pr: TimelinePR; timezone: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasCommits = pr.commits.length > 0;

  return (
    <div className="border-l-2 border-muted ml-2">
      <button
        className="flex items-center gap-2 py-1.5 px-2 w-full text-left text-sm hover:bg-muted/30 transition-colors rounded-r"
        onClick={() => hasCommits && setExpanded(!expanded)}
        disabled={!hasCommits}
      >
        {hasCommits ? (
          expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
          )
        ) : (
          <Circle className="h-2 w-2 text-muted-foreground/40 ml-0.5 mr-0.5 shrink-0" />
        )}
        <GitPullRequest className="h-3.5 w-3.5 text-cat-ai shrink-0" />
        <a
          href={pr.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          #{pr.number}
        </a>
        <span className="text-foreground/90 truncate flex-1">{pr.title}</span>
        {pr.author && (
          <span className="text-xs text-muted-foreground/50 shrink-0">{pr.author}</span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-xs text-muted-foreground/50 shrink-0">
              {relativeTime(pr.mergedAt)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{absoluteTime(pr.mergedAt, timezone)}</TooltipContent>
        </Tooltip>
        {hasCommits && (
          <Badge variant="secondary" className="text-xs font-mono px-1 py-0 shrink-0">
            {pr.commits.length}
          </Badge>
        )}
      </button>
      {expanded && hasCommits && (
        <div className="ml-6 border-l border-border/50 mb-1">
          {pr.commits.map((c) => (
            <CommitRow key={c.sha} commit={c} timezone={timezone} />
          ))}
        </div>
      )}
    </div>
  );
}

function DeployCard({
  deploy,
  isLatest,
  timezone,
}: {
  deploy: TimelineDeploy;
  isLatest: boolean;
  timezone: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const totalItems = deploy.prs.length + deploy.orphanCommits.length;
  const hasContent = totalItems > 0;
  const title = deploy.commitMessage || deploy.commitHash?.slice(0, 7) || "Deploy";

  return (
    <div className="relative">
      {/* Timeline dot */}
      <div className="absolute -left-6 top-4">
        <div
          className={`h-3 w-3 rounded-full ring-2 ring-background ${deployStatusColor(deploy.status)}`}
        />
      </div>

      <Card
        className={`transition-colors ${hasContent ? "cursor-pointer" : ""} ${
          isLatest ? "border-primary/30" : ""
        }`}
        onClick={() => hasContent && setExpanded(!expanded)}
      >
        <CardContent className="py-3 px-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0 flex-1">
              {hasContent ? (
                expanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                )
              ) : (
                <Rocket className="h-4 w-4 text-muted-foreground/40 mt-0.5 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{title}</span>
                  {isLatest && (
                    <Badge variant="default" className="text-xs">
                      Live
                    </Badge>
                  )}
                  <Badge
                    variant="secondary"
                    className={`text-xs ${
                      deploy.status === "SUCCESS"
                        ? "text-success-foreground"
                        : deploy.status === "FAILED" || deploy.status === "CRASHED"
                          ? "text-error-foreground"
                          : ""
                    }`}
                  >
                    {deployStatusLabel(deploy.status)}
                  </Badge>
                </div>
                {deploy.commitHash && (
                  <span className="text-xs font-mono text-muted-foreground/60">
                    {deploy.commitHash.slice(0, 7)}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {deploy.durationMs && deploy.durationMs > 0 && (
                <Badge variant="outline" className="text-xs font-mono gap-1">
                  <Clock className="h-2.5 w-2.5" />
                  {formatDuration(deploy.durationMs)}
                </Badge>
              )}
              {deploy.prs.length > 0 && (
                <Badge variant="secondary" className="text-xs font-mono px-1 py-0">
                  {deploy.prs.length} PR{deploy.prs.length !== 1 ? "s" : ""}
                </Badge>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground/60">
                    {relativeTime(deploy.createdAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{absoluteTime(deploy.createdAt, timezone)}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {expanded && hasContent && (
            <div className="mt-3 space-y-1" onClick={(e) => e.stopPropagation()}>
              {deploy.prs.map((pr) => (
                <PRRow key={pr.number} pr={pr} timezone={timezone} />
              ))}
              {deploy.orphanCommits.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border/30">
                  <span className="text-xs uppercase tracking-wider text-muted-foreground/50 px-2">
                    Direct commits
                  </span>
                  {deploy.orphanCommits.map((c) => (
                    <CommitRow key={c.sha} commit={c} timezone={timezone} />
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PendingSection({
  prs,
  timezone,
}: {
  prs: TimelinePR[];
  timezone: string;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <Card className="border-dashed border-warning/40 bg-warning/5">
      <CardContent className="py-3 px-4">
        <button
          className="flex items-center gap-2 w-full text-left"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-warning shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-warning shrink-0" />
          )}
          <Rocket className="h-4 w-4 text-warning shrink-0" />
          <span className="text-sm font-medium text-warning-foreground">
            Pending deploy
          </span>
          <Badge variant="secondary" className="bg-cat-alert/15 text-cat-alert-foreground border border-cat-alert/30 rounded-sm text-xs font-medium font-mono px-2 py-0.5">
            {prs.length} PR{prs.length !== 1 ? "s" : ""}
          </Badge>
        </button>
        {expanded && (
          <div className="mt-2 space-y-1">
            {prs.map((pr) => (
              <PRRow key={pr.number} pr={pr} timezone={timezone} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function GitHubBanner() {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <Info className="h-3.5 w-3.5 shrink-0" />
      <span>
        Connect GitHub in the{" "}
        <span className="font-medium text-foreground/80">GitHub tab</span> for full PR and commit
        history.
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export default function VersionTimeline() {
  const { timezone } = useTimezone();
  const { data, isLoading } = useQuery<TimelineResponse>({
    queryKey: ["/api/version/timeline"],
    refetchInterval: 5 * 60 * 1000, // match server cache TTL
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-24" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
    );
  }

  const deployments = data?.deployments ?? [];
  const pending = data?.pending ?? [];
  const githubConnected = data?.githubConnected ?? false;

  if (deployments.length === 0 && pending.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Rocket className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No deployments yet. Push to main and Railway will deploy automatically.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Rocket className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Version Timeline</span>
        <Badge variant="secondary" className="text-xs font-mono px-1 py-0">
          {deployments.length} deploy{deployments.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {!githubConnected && <GitHubBanner />}

      {pending.length > 0 && <PendingSection prs={pending} timezone={timezone} />}

      {/* Timeline spine */}
      <div className="relative pl-6">
        <div className="absolute left-1.5 top-0 bottom-0 w-px bg-border" />
        <div className="space-y-3">
          {deployments.map((deploy, i) => (
            <DeployCard
              key={deploy.id}
              deploy={deploy}
              isLatest={i === 0}
              timezone={timezone}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
