import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IssueInlineProfile } from "@/components/issue-inline-profile";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { openIssueCaptureDialog } from "@/components/issue-capture";
import {
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgendaDiscussion } from "@/hooks/use-agenda-discussion";
import { useToast } from "@/hooks/use-toast";
import { useTimezone, formatDate } from "@/hooks/use-timezone";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  CircleX,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  Loader2,
  MessageSquare,
  Plus,
  X,
} from "lucide-react";
import type { Issue, IssueStatus } from "@shared/schema";

const STATUS_CYCLE: IssueStatus[] = ["open", "in_progress", "in_review", "resolved"];

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  in_review: "In Review",
  resolved: "Resolved",
};

interface AggregatedApplicationError {
  fingerprint: string;
  errorIdentity: string;
  sourceFile: string | null;
  sourceLine: number | null;
  sourceSite: string;
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
}

interface IssueTreeRowProps {
  issue: Issue;
  onCycleStatus: (id: number, nextStatus: IssueStatus) => void;
  isUpdating: boolean;
  onDiscuss: () => void;
}

function StatusIcon({ status, className }: { status: IssueStatus; className?: string }) {
  switch (status) {
    case "open":
      return <Circle className={cn("text-muted-foreground", className)} />;
    case "in_progress":
      return <CircleDot className={cn("text-blue-500", className)} />;
    case "in_review":
      return <CircleDashed className={cn("text-amber-500", className)} />;
    case "resolved":
      return <CircleCheck className={cn("text-emerald-500", className)} />;
  }
}

function IssueTreeRow({ issue, onCycleStatus, isUpdating, onDiscuss }: IssueTreeRowProps) {
  const { timezone } = useTimezone();
  const status = issue.status as IssueStatus;
  const nextStatus = STATUS_CYCLE[(STATUS_CYCLE.indexOf(status) + 1) % STATUS_CYCLE.length];

  return (
    <ProfileTreeRow
      label={(
        <span className="flex min-w-0 items-center gap-2" data-testid={`label-issue-${issue.id}`}>
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium text-foreground",
              status === "resolved" && "text-muted-foreground line-through",
            )}
          >
            {issue.title}
          </span>
          {issue.createdAt ? (
            <span
              className="shrink-0 text-xs text-muted-foreground"
              title={formatDate(issue.createdAt, timezone)}
            >
              {formatDate(issue.createdAt, timezone)}
            </span>
          ) : null}
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
      hasValue={false}
      showEmpty
      mobileLayout="inline"
      menuVisibility="always"
      expandedContent={<IssueInlineProfile issueId={issue.id} />}
      expandedContentClassName="px-2 pb-3 pl-2"
      testId={`issue-item-${issue.id}`}
      menuContent={(
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onDiscuss();
          }}
          data-testid={`menu-discuss-issue-${issue.id}`}
        >
          <MessageSquare className="mr-2 h-4 w-4" />
          Discuss
        </DropdownMenuItem>
      )}
    />
  );
}

function ErrorTreeRow({
  error,
  onDiscuss,
  onDismiss,
  isDismissing,
}: {
  error: AggregatedApplicationError;
  onDiscuss: () => void;
  onDismiss: () => void;
  isDismissing: boolean;
}) {
  const { timezone } = useTimezone();
  const source = error.sourceFile
    ? `${error.sourceFile}${error.sourceLine ? `:${error.sourceLine}` : ""}`
    : null;
  const details = [
    ["Identity", error.errorIdentity],
    ["Source", source],
    ["Logger / site", [error.sourceSite, error.errorIdentity.split(":", 1)[0]].filter(Boolean).join(" · ")],
    ["First seen", formatDate(error.firstSeenAt, timezone)],
    ["Last seen", formatDate(error.lastSeenAt, timezone)],
    ["Count", error.occurrenceCount.toLocaleString()],
  ].filter((detail): detail is [string, string] => typeof detail[1] === "string" && detail[1].length > 0);

  return (
    <ProfileTreeRow
      label={(
        <span className="flex min-w-0 items-center gap-2" data-testid={`label-error-${error.fingerprint}`}>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
            {error.errorIdentity}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {error.occurrenceCount.toLocaleString()}
          </span>
        </span>
      )}
      icon={<CircleX className="h-3.5 w-3.5 text-destructive" />}
      hasValue={false}
      showEmpty
      mobileLayout="inline"
      menuVisibility="always"
      testId={`error-item-${error.fingerprint}`}
      expandedContent={(
        <dl className="grid gap-1.5 text-xs">
          {details.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      menuContent={(
        <>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              onDiscuss();
            }}
            data-testid={`menu-discuss-error-${error.fingerprint}`}
          >
            <MessageSquare className="mr-2 h-4 w-4" />
            Discuss
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isDismissing}
            onSelect={(event) => {
              event.preventDefault();
              onDismiss();
            }}
            data-testid={`menu-dismiss-error-${error.fingerprint}`}
          >
            <X className="mr-2 h-4 w-4" />
            Dismiss
          </DropdownMenuItem>
        </>
      )}
    />
  );
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

function IssueTreeSection({
  label,
  issues,
  open,
  onOpenChange,
  testId,
  count,
  loading,
  emptyLabel,
  renderIssue,
}: IssueTreeSectionProps) {
  return (
    <section className="min-w-0">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent/50"
        data-testid={testId}
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{label}</span>
        <span className="ml-auto font-normal tabular-nums text-muted-foreground/70">
          {count ?? issues.length}
        </span>
      </button>
      {open ? (
        <div className="min-w-0">
          {loading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
          ) : issues.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {emptyLabel ?? `No ${label.toLowerCase()}.`}
            </div>
          ) : (
            issues.map(renderIssue)
          )}
        </div>
      ) : null}
    </section>
  );
}

interface ErrorTreeSectionProps {
  label: string;
  errors: AggregatedApplicationError[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
  loading?: boolean;
  emptyLabel?: string;
  renderError: (error: AggregatedApplicationError) => ReactNode;
}

function ErrorTreeSection({
  label,
  errors,
  open,
  onOpenChange,
  testId,
  loading,
  emptyLabel,
  renderError,
}: ErrorTreeSectionProps) {
  return (
    <section className="min-w-0">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent/50"
        data-testid={testId}
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{label}</span>
        <span className="ml-auto font-normal tabular-nums text-muted-foreground/70">
          {errors.length}
        </span>
      </button>
      {open ? (
        <div className="min-w-0">
          {loading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
          ) : errors.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {emptyLabel ?? `No ${label.toLowerCase()}.`}
            </div>
          ) : (
            errors.map(renderError)
          )}
        </div>
      ) : null}
    </section>
  );
}

function matchesQuery(haystack: string, query: string): boolean {
  if (!query) return true;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

export function IssuesTab() {
  const { toast } = useToast();
  const discussion = useAgendaDiscussion();
  const [search, setSearch] = useState("");
  const [errorsOpen, setErrorsOpen] = useState(true);
  const [openOpen, setOpenOpen] = useState(true);
  const [inProgressOpen, setInProgressOpen] = useState(true);
  const [inReviewOpen, setInReviewOpen] = useState(true);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  const { data: personasData } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/personas"],
  });
  const engineerId = useMemo(
    () => personasData?.find((persona) => persona.name.toLowerCase() === "engineer")?.id,
    [personasData],
  );

  const { data: activeData, isLoading } = useQuery<{ issues: Issue[] }>({
    queryKey: ["/api/issues"],
    queryFn: async () => {
      const response = await fetch("/api/issues?lightweight=true&exclude_status=resolved");
      if (!response.ok) throw new Error(`Failed to fetch issues: ${response.statusText}`);
      return response.json();
    },
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

  const { data: errorsData, isLoading: errorsLoading } = useQuery<AggregatedApplicationError[]>({
    queryKey: ["/api/issues/errors/recent"],
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
      toast({
        title: "Failed to update issue",
        description: error.message,
        variant: "destructive",
      });
    },
    onSettled: () => setUpdatingId(null),
  });

  const dismissErrorMutation = useMutation({
    mutationFn: async (fingerprint: string) => {
      const response = await apiRequest("POST", `/api/issues/errors/${fingerprint}/dismiss`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/issues/errors/recent"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to dismiss error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const normalized = search.trim();
  const activeIssues = (activeData?.issues || []).filter((issue) =>
    matchesQuery(`${issue.title} ${issue.description} ${issue.reproSteps ?? ""}`, normalized),
  );
  const openIssues = activeIssues.filter((issue) => issue.status === "open");
  const inProgressIssues = activeIssues.filter((issue) => issue.status === "in_progress");
  const inReviewIssues = activeIssues.filter((issue) => issue.status === "in_review");
  const resolvedIssues = (resolvedData?.issues || []).filter((issue) =>
    matchesQuery(`${issue.title} ${issue.description} ${issue.reproSteps ?? ""}`, normalized),
  );
  const filteredErrors = (errorsData || []).filter((error) =>
    matchesQuery(
      `${error.errorIdentity} ${error.sourceFile ?? ""} ${error.sourceSite ?? ""}`,
      normalized,
    ),
  );

  const discussIssue = (issue: Issue) => {
    discussion.mutate({
      pendingKey: `issue-${issue.id}`,
      title: `Issue: ${issue.title}`,
      message: `Discuss and resolve @issue:${issue.id}.\n\n${issue.description}${
        issue.reproSteps ? `\n\nReproduction steps:\n${issue.reproSteps}` : ""
      }`,
      clientTurnSuffix: `issue-${issue.id}`,
      personaId: engineerId,
    });
  };

  const discussError = (error: AggregatedApplicationError) => {
    const source = error.sourceFile
      ? `${error.sourceFile}${error.sourceLine ? `:${error.sourceLine}` : ""}`
      : error.sourceSite || "Unavailable";
    discussion.mutate({
      pendingKey: `error-${error.fingerprint}`,
      title: `Error: ${error.errorIdentity}`,
      message: [
        "Investigate this privacy-safe error aggregate:",
        "",
        `- Error: ${error.errorIdentity}`,
        `- Count: ${error.occurrenceCount}`,
        `- Source: ${source}`,
        `- Site: ${error.sourceSite}`,
        `- First seen: ${error.firstSeenAt}`,
        `- Last seen: ${error.lastSeenAt}`,
        `- Fingerprint: ${error.fingerprint}`,
      ].join("\n"),
      clientTurnSuffix: `error-${error.fingerprint}`,
      personaId: engineerId,
    });
  };

  const renderIssue = (issue: Issue) => (
    <IssueTreeRow
      key={issue.id}
      issue={issue}
      onCycleStatus={(id, nextStatus) => updateMutation.mutate({ id, updates: { status: nextStatus } })}
      isUpdating={updatingId === issue.id}
      onDiscuss={() => discussIssue(issue)}
    />
  );

  return (
    <div className="h-full w-full overflow-y-auto bg-background" data-testid="issues-tab">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={search}
          onChange={setSearch}
          inputTestId="input-search-issues"
          clearTestId="button-clear-issue-search"
          ariaLabel="Search issues and errors"
        />
        <button
          type="button"
          onClick={openIssueCaptureDialog}
          className={HIERARCHY_PRIMARY_ACTION_CLASS}
          data-testid="button-new-issue"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          New Issue
        </button>

        <ErrorTreeSection
          label="Errors"
          errors={filteredErrors}
          open={errorsOpen}
          onOpenChange={setErrorsOpen}
          testId="button-toggle-errors-group"
          loading={errorsLoading}
          emptyLabel="No recent errors."
          renderError={(error) => (
            <ErrorTreeRow
              key={error.fingerprint}
              error={error}
              onDiscuss={() => discussError(error)}
              onDismiss={() => dismissErrorMutation.mutate(error.fingerprint)}
              isDismissing={dismissErrorMutation.isPending && dismissErrorMutation.variables === error.fingerprint}
            />
          )}
        />

        <IssueTreeSection
          label="Open"
          issues={openIssues}
          open={openOpen}
          onOpenChange={setOpenOpen}
          testId="button-toggle-open-group"
          count={openIssues.length}
          loading={isLoading}
          emptyLabel="No open issues."
          renderIssue={renderIssue}
        />

        <IssueTreeSection
          label="In Progress"
          issues={inProgressIssues}
          open={inProgressOpen}
          onOpenChange={setInProgressOpen}
          testId="button-toggle-in-progress-group"
          count={inProgressIssues.length}
          loading={isLoading}
          emptyLabel="No in-progress issues."
          renderIssue={renderIssue}
        />

        <IssueTreeSection
          label="In Review"
          issues={inReviewIssues}
          open={inReviewOpen}
          onOpenChange={setInReviewOpen}
          testId="button-toggle-in-review-group"
          count={inReviewIssues.length}
          loading={isLoading}
          emptyLabel="No issues in review."
          renderIssue={renderIssue}
        />

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

export default IssuesTab;
