import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Bug,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDot,
  CircleDashed,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useLocation } from "wouter";
import type { Issue, IssueStatus } from "@shared/schema";
import { useTimezone, formatDate } from "@/hooks/use-timezone";

const STATUS_CYCLE: IssueStatus[] = ["open", "in_progress", "in_review", "resolved"];

function StatusIcon({ status, className }: { status: IssueStatus; className?: string }) {
  switch (status) {
    case "resolved":
      return <CircleCheck className={`${className} text-success`} />;
    case "in_review":
      return <CircleDashed className={`${className} text-info`} />;
    case "in_progress":
      return <CircleDot className={`${className} text-warning`} />;
    default:
      return <Circle className={`${className} text-muted-foreground/50`} />;
  }
}

function formatIssueDate(dateStr: string, timezone: string) {
  return formatDate(dateStr, timezone, { month: "short", day: "numeric" });
}

function IssueItem({ issue, onCycleStatus, isUpdating }: {
  issue: Issue;
  onCycleStatus: (id: number, nextStatus: IssueStatus) => void;
  isUpdating: boolean;
}) {
  const { timezone } = useTimezone();
  const [, setLocation] = useLocation();
  const nextStatus = STATUS_CYCLE[(STATUS_CYCLE.indexOf(issue.status as IssueStatus) + 1) % STATUS_CYCLE.length];
  const statusLabel = issue.status === "open" ? "Open" : issue.status === "in_progress" ? "In Progress" : issue.status === "in_review" ? "In Review" : "Resolved";

  return (
    <div className="border rounded-md hover-elevate" data-testid={`issue-item-${issue.id}`}>
      <div className="flex items-center gap-1 px-3 py-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => { e.stopPropagation(); onCycleStatus(issue.id, nextStatus); }}
              className="shrink-0 p-0.5"
              disabled={isUpdating}
              data-testid={`button-cycle-status-${issue.id}`}
            >
              {isUpdating ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <StatusIcon status={issue.status as IssueStatus} className="h-4 w-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {statusLabel}
          </TooltipContent>
        </Tooltip>
        <button
          onClick={() => setLocation(`/issues/${issue.id}`)}
          className="flex-1 flex items-center gap-2 text-left min-w-0"
          data-testid={`button-open-issue-${issue.id}`}
        >
          <span className={`text-sm truncate ${issue.status === "resolved" ? "line-through text-muted-foreground" : ""}`}>
            {issue.title}
          </span>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {issue.createdAt && (
            <span className="text-xs text-muted-foreground font-mono mr-1">{formatIssueDate(issue.createdAt.toString(), timezone)}</span>
          )}
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

export function IssuesTab() {
  const { toast } = useToast();
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const { data: activeData, isLoading, refetch } = useQuery<{ issues: Issue[] }>({
    queryKey: ["/api/issues", "active"],
    queryFn: async () => {
      const res = await fetch("/api/issues?lightweight=true&exclude_status=resolved");
      if (!res.ok) throw new Error(`Failed to fetch issues: ${res.statusText}`);
      return res.json();
    },
    refetchInterval: 10000,
  });

  const [openCollapsed, setOpenCollapsed] = useState(false);
  const [inProgressCollapsed, setInProgressCollapsed] = useState(false);
  const [inReviewCollapsed, setInReviewCollapsed] = useState(false);
  const [resolvedCollapsed, setResolvedCollapsed] = useState(true);

  const { data: resolvedData, isLoading: resolvedLoading } = useQuery<{ issues: Issue[] }>({
    queryKey: ["/api/issues", "resolved"],
    queryFn: async () => {
      const res = await fetch("/api/issues?lightweight=true&status=resolved");
      if (!res.ok) throw new Error(`Failed to fetch issues: ${res.statusText}`);
      return res.json();
    },
    enabled: !resolvedCollapsed,
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: { status?: IssueStatus } }) => {
      setUpdatingId(id);
      const res = await apiRequest("PATCH", `/api/issues/${id}`, updates);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update issue", description: err.message, variant: "destructive" });
    },
    onSettled: () => setUpdatingId(null),
  });

  const activeIssues = activeData?.issues || [];
  const openIssues = activeIssues.filter(i => i.status === "open");
  const inProgressIssues = activeIssues.filter(i => i.status === "in_progress");
  const inReviewIssues = activeIssues.filter(i => i.status === "in_review");
  const resolvedIssues = resolvedData?.issues || [];
  const activeCount = activeIssues.length;

  const renderGroup = (
    label: string,
    issues: Issue[],
    collapsed: boolean,
    setCollapsed: (v: boolean) => void,
    testId: string,
  ) => {
    if (issues.length === 0) return null;
    return (
      <div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 w-full text-left mb-2"
          data-testid={testId}
        >
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"}`} />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {label} ({issues.length})
          </span>
        </button>
        {!collapsed && (
          <div className="space-y-1.5">
            {issues.map((issue) => (
              <IssueItem
                key={issue.id}
                issue={issue}
                onCycleStatus={(id, nextStatus) => updateMutation.mutate({ id, updates: { status: nextStatus } })}
                isUpdating={updatingId === issue.id}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Bug className="h-4 w-4" />
          Issues
          {activeCount > 0 && (
            <Badge variant="secondary" className="text-xs font-mono px-1 py-0" data-testid="badge-open-count">
              {activeCount} active
            </Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => refetch()}
            data-testid="button-refresh-issues"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : activeIssues.length > 0 || !resolvedCollapsed ? (
          <div className="space-y-4">
            {renderGroup("In Review", inReviewIssues, inReviewCollapsed, setInReviewCollapsed, "button-toggle-inreview-group")}
            {renderGroup("In Progress", inProgressIssues, inProgressCollapsed, setInProgressCollapsed, "button-toggle-inprogress-group")}
            {renderGroup("Open", openIssues, openCollapsed, setOpenCollapsed, "button-toggle-open-group")}
            <div>
              <button
                onClick={() => setResolvedCollapsed(!resolvedCollapsed)}
                className="flex items-center gap-2 w-full text-left mb-2"
                data-testid="button-toggle-resolved-group"
              >
                <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${resolvedCollapsed ? "" : "rotate-90"}`} />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Resolved {resolvedIssues.length > 0 ? `(${resolvedIssues.length})` : ""}
                </span>
              </button>
              {!resolvedCollapsed && (
                resolvedLoading ? (
                  <div className="space-y-2 pl-5">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : resolvedIssues.length > 0 ? (
                  <div className="space-y-1.5">
                    {resolvedIssues.map((issue) => (
                      <IssueItem
                        key={issue.id}
                        issue={issue}
                        onCycleStatus={(id, nextStatus) => updateMutation.mutate({ id, updates: { status: nextStatus } })}
                        isUpdating={updatingId === issue.id}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground pl-5">No resolved issues.</p>
                )
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="text-no-issues">
            No issues captured yet. Use the bug button at the bottom-left to report issues.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
