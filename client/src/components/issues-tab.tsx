import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IssueInlineProfile } from "@/components/issue-inline-profile";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useTimezone, formatDate } from "@/hooks/use-timezone";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { Issue, IssueStatus } from "@shared/schema";

const STATUS_CYCLE: IssueStatus[] = ["open", "in_progress", "in_review", "resolved"];

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  in_review: "In Review",
  resolved: "Resolved",
};

interface IssueTreeRowProps {
  issue: Issue;
  onCycleStatus: (id: number, nextStatus: IssueStatus) => void;
  isUpdating: boolean;
}

interface IssueTreeSectionProps {
  label: string;
  issues: Issue[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  count?: number;
  loading?: boolean;
  emptyLabel?: string;
  renderIssue: (issue: Issue) => ReactNode;
}

function StatusIcon({ status, className }: { status: IssueStatus; className?: string }) {
  switch (status) {
    case "resolved":
      return <CircleCheck className={cn(className, "text-success")} />;
    case "in_review":
      return <CircleDashed className={cn(className, "text-info")} />;
    case "in_progress":
      return <CircleDot className={cn(className, "text-warning")} />;
    default:
      return <Circle className={cn(className, "text-muted-foreground/50")} />;
  }
}

function formatIssueDate(date: Date, timezone: string) {
  return formatDate(date.toString(), timezone, { month: "short", day: "numeric" });
}

function IssueTreeRow({ issue, onCycleStatus, isUpdating }: IssueTreeRowProps) {
  const { timezone } = useTimezone();
  const status = issue.status as IssueStatus;
  const nextStatus = STATUS_CYCLE[(STATUS_CYCLE.indexOf(status) + 1) % STATUS_CYCLE.length];

  return (
    <ProfileTreeRow
      label={(
        <span
          className={cn(
            "block max-w-full truncate font-medium text-foreground",
            status === "resolved" && "text-muted-foreground line-through",
          )}
          data-testid={`label-issue-${issue.id}`}
        >
          {issue.title}
        </span>
      )}
      icon={(
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => onCycleStatus(issue.id, nextStatus)}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              disabled={isUpdating}
              aria-label={`${STATUS_LABELS[status]}. Change status to ${STATUS_LABELS[nextStatus]}`}
              data-testid={`button-cycle-status-${issue.id}`}
            >
              {isUpdating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <StatusIcon status={status} className="h-3.5 w-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {STATUS_LABELS[status]}
          </TooltipContent>
        </Tooltip>
      )}
      hasValue
      showEmpty
      mobileLayout="inline"
      expandedContent={<IssueInlineProfile issueId={issue.id} />}
      expandedContentClassName="px-2 pb-3 pl-2"
      testId={`issue-item-${issue.id}`}
    >
      {issue.createdAt ? (
        <span className="truncate font-mono text-muted-foreground">
          {formatIssueDate(issue.createdAt, timezone)}
        </span>
      ) : null}
    </ProfileTreeRow>
  );
}

function IssueTreeSection({
  label,
  issues,
  open,
  onOpenChange,
  testId,
  count = issues.length,
  loading = false,
  emptyLabel = "No issues.",
  renderIssue,
}: IssueTreeSectionProps) {
  return (
    <section className="min-w-0">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
        aria-expanded={open}
        data-testid={testId}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{label}</span>
        <span className="ml-auto font-normal tabular-nums text-muted-foreground/70">{count}</span>
      </button>
      {open ? (
        <div className="ml-3 border-l border-border pl-2">
          {loading ? (
            <div className="space-y-1 py-1">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : issues.length > 0 ? (
            issues.map(renderIssue)
          ) : (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyLabel}</div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function IssuesTab() {
  const { toast } = useToast();
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [openOpen, setOpenOpen] = useState(true);
  const [inProgressOpen, setInProgressOpen] = useState(true);
  const [inReviewOpen, setInReviewOpen] = useState(true);
  const [resolvedOpen, setResolvedOpen] = useState(false);

  const { data: activeData, isLoading, isFetching, refetch } = useQuery<{ issues: Issue[] }>({
    queryKey: ["/api/issues", "active"],
    queryFn: async () => {
      const response = await fetch("/api/issues?lightweight=true&exclude_status=resolved");
      if (!response.ok) throw new Error(`Failed to fetch issues: ${response.statusText}`);
      return response.json();
    },
    refetchInterval: 10000,
  });

  const { data: resolvedData, isLoading: resolvedLoading } = useQuery<{ issues: Issue[] }>({
    queryKey: ["/api/issues", "resolved"],
    queryFn: async () => {
      const response = await fetch("/api/issues?lightweight=true&status=resolved");
      if (!response.ok) throw new Error(`Failed to fetch issues: ${response.statusText}`);
      return response.json();
    },
    enabled: resolvedOpen,
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: { status?: IssueStatus } }) => {
      setUpdatingId(id);
      const response = await apiRequest("PATCH", `/api/issues/${id}`, updates);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update issue", description: error.message, variant: "destructive" });
    },
    onSettled: () => setUpdatingId(null),
  });

  const activeIssues = activeData?.issues || [];
  const openIssues = activeIssues.filter((issue) => issue.status === "open");
  const inProgressIssues = activeIssues.filter((issue) => issue.status === "in_progress");
  const inReviewIssues = activeIssues.filter((issue) => issue.status === "in_review");
  const resolvedIssues = resolvedData?.issues || [];

  const renderIssue = (issue: Issue) => (
    <IssueTreeRow
      key={issue.id}
      issue={issue}
      onCycleStatus={(id, nextStatus) => updateMutation.mutate({ id, updates: { status: nextStatus } })}
      isUpdating={updatingId === issue.id}
    />
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-w-0 overflow-x-hidden bg-background p-2 text-foreground">
      <div className="mb-1 flex min-w-0 items-center justify-between gap-2 px-2 py-1">
        <span className="text-xs text-muted-foreground" data-testid="badge-open-count">
          {activeIssues.length} active
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh issues"
          data-testid="button-refresh-issues"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="min-w-0 space-y-0">
        {inReviewIssues.length > 0 ? (
          <IssueTreeSection
            label="In Review"
            issues={inReviewIssues}
            open={inReviewOpen}
            onOpenChange={setInReviewOpen}
            testId="button-toggle-inreview-group"
            renderIssue={renderIssue}
          />
        ) : null}
        {inProgressIssues.length > 0 ? (
          <IssueTreeSection
            label="In Progress"
            issues={inProgressIssues}
            open={inProgressOpen}
            onOpenChange={setInProgressOpen}
            testId="button-toggle-inprogress-group"
            renderIssue={renderIssue}
          />
        ) : null}
        {openIssues.length > 0 ? (
          <IssueTreeSection
            label="Open"
            issues={openIssues}
            open={openOpen}
            onOpenChange={setOpenOpen}
            testId="button-toggle-open-group"
            renderIssue={renderIssue}
          />
        ) : (
          <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-no-issues">
            No active issues.
          </div>
        )}
        <IssueTreeSection
          label="Resolved"
          issues={resolvedIssues}
          open={resolvedOpen}
          onOpenChange={setResolvedOpen}
          testId="button-toggle-resolved-group"
          count={resolvedData ? resolvedIssues.length : 0}
          loading={resolvedLoading}
          emptyLabel="No resolved issues."
          renderIssue={renderIssue}
        />
      </div>
    </div>
  );
}
