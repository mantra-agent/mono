import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IssueInlineProfile } from "@/components/issue-inline-profile";
import { SimpleTextFrame } from "@/components/home/simple-text-frame";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { openIssueCaptureDialog } from "@/components/issue-capture";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSessionLaunch } from "@/hooks/use-session-launch";
import { useToast } from "@/hooks/use-toast";
import { useTimezone } from "@/hooks/use-timezone";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  CircleX,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  FolderOpen,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Rocket,
  X,
} from "lucide-react";
import type { Issue, IssueStatus } from "@shared/schema";
import { composeIssueFeatureLaunchMessage } from "@shared/issue-feature";

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

/** Match the Home menu timestamp: clock time stacked over an M/D date. */
function formatStackedTimestamp(value: Date | string | null | undefined, timezone: string): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${time}\n${get("month")}/${get("day")}`;
}

function shouldIgnoreRowToggle(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('a, button, input, textarea, select, [role="menuitem"]'));
}

function StatusIcon({ status, className }: { status: IssueStatus; className?: string }) {
  switch (status) {
    case "open":
      return <Circle className={cn("text-muted-foreground", className)} />;
    case "in_progress":
      return <CircleDot className={cn("text-active", className)} />;
    case "in_review":
      return <CircleDashed className={cn("text-warning", className)} />;
    case "resolved":
      return <CircleCheck className={cn("text-success", className)} />;
  }
}

/** Shared Home-mirroring row chrome: stacked time, leading control, content, expander, hover-only overflow. */
function TreeRow({
  timestamp,
  control,
  children,
  expandedContent,
  menuContent,
  menuLabel,
  testId,
}: {
  timestamp: string;
  control: ReactNode;
  children: ReactNode;
  expandedContent?: ReactNode;
  menuContent: ReactNode;
  menuLabel: string;
  testId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = Boolean(expandedContent);

  const toggle = () => {
    if (canExpand) setExpanded((value) => !value);
  };

  return (
    <div className="min-w-0" data-testid={testId}>
      <div
        className={cn(
          "group flex items-center rounded-md py-1 transition-colors duration-200 hover:bg-accent/50",
          canExpand && "cursor-pointer",
        )}
        onClick={(event) => {
          if (shouldIgnoreRowToggle(event.target)) return;
          toggle();
        }}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        onKeyDown={(event) => {
          if (!canExpand) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
      >
        {/* Time column — clock time over M/D date, exactly like the Home menu. */}
        <span className="w-14 shrink-0 whitespace-pre-line pr-1.5 text-right text-[11px] leading-tight tabular-nums text-muted-foreground">
          {timestamp}
        </span>

        {/* Leading control column — sits to the right of the timestamp like Home's check circle. */}
        <span className="flex w-4 shrink-0 items-center justify-center">{control}</span>

        {/* Content */}
        <div className="relative min-w-0 flex-1 pl-0.5">{children}</div>

        {/* Expander */}
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          {canExpand ? (
            <button
              type="button"
              className="rounded p-0.5 hover:bg-accent/60"
              onClick={(event) => {
                event.stopPropagation();
                toggle();
              }}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              <ChevronRight
                className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", expanded && "rotate-90")}
              />
            </button>
          ) : null}
        </span>

        {/* Overflow menu — visible only on hover, after the expander. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-5 shrink-0 items-center justify-center rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              aria-label={menuLabel}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {menuContent}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded && expandedContent ? (
        <div className="pb-2 pl-0 pr-1.5">{expandedContent}</div>
      ) : null}
    </div>
  );
}

function IssueTreeRow({
  issue,
  onCycleStatus,
  isUpdating,
  onDiscuss,
  onLaunch,
  isLaunching,
  onOpen,
  isOpening,
}: {
  issue: Issue;
  onCycleStatus: (id: number, nextStatus: IssueStatus) => void;
  isUpdating: boolean;
  onDiscuss: () => void;
  onLaunch: () => void;
  isLaunching?: boolean;
  onOpen?: () => void;
  isOpening?: boolean;
}) {
  const { timezone } = useTimezone();
  const status = issue.status as IssueStatus;
  const nextStatus = STATUS_CYCLE[(STATUS_CYCLE.indexOf(status) + 1) % STATUS_CYCLE.length];
  const timestamp = formatStackedTimestamp(issue.createdAt, timezone);

  return (
    <TreeRow
      timestamp={timestamp}
      testId={`issue-item-${issue.id}`}
      menuLabel={`Actions for ${issue.title}`}
      control={
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCycleStatus(issue.id, nextStatus);
              }}
              className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
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
      }
      expandedContent={<IssueInlineProfile issueId={issue.id} />}
      menuContent={
        <>
          {onOpen ? (
            <DropdownMenuItem
              disabled={isOpening}
              onSelect={(event) => {
                event.preventDefault();
                onOpen();
              }}
              data-testid={`menu-open-issue-${issue.id}`}
            >
              <FolderOpen className="mr-2 h-4 w-4" />
              Open
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={isLaunching}
            onSelect={(event) => {
              event.preventDefault();
              onLaunch();
            }}
            data-testid={`menu-launch-issue-${issue.id}`}
          >
            {isLaunching ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="mr-2 h-4 w-4" />
            )}
            Feature
          </DropdownMenuItem>
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
        </>
      }
    >
      <span
        className={cn(
          "block min-w-0 truncate text-sm font-medium text-foreground",
          status === "resolved" && "text-muted-foreground line-through",
        )}
        data-testid={`label-issue-${issue.id}`}
      >
        {issue.title}
      </span>
    </TreeRow>
  );
}

function ErrorTreeRow({
  error,
  onDiscuss,
  onDismiss,
  onOpen,
  isDismissing,
  isOpening,
}: {
  error: AggregatedApplicationError;
  onDiscuss: () => void;
  onDismiss: () => void;
  onOpen: () => void;
  isDismissing: boolean;
  isOpening: boolean;
}) {
  const { timezone } = useTimezone();
  const source = error.sourceFile
    ? `${error.sourceFile}${error.sourceLine ? `:${error.sourceLine}` : ""}`
    : null;
  const timestamp = formatStackedTimestamp(error.lastSeenAt, timezone);
  const details = [
    ["Identity", error.errorIdentity],
    ["Source", source],
    ["Logger / site", [error.sourceSite, error.errorIdentity.split(":", 1)[0]].filter(Boolean).join(" · ")],
    ["First seen", formatStackedTimestamp(error.firstSeenAt, timezone).replace("\n", " ")],
    ["Last seen", timestamp.replace("\n", " ")],
    ["Count", error.occurrenceCount.toLocaleString()],
  ].filter((detail): detail is [string, string] => typeof detail[1] === "string" && detail[1].length > 0);

  return (
    <TreeRow
      timestamp={timestamp}
      testId={`error-item-${error.fingerprint}`}
      menuLabel={`Actions for ${error.errorIdentity}`}
      control={<CircleX className="h-3.5 w-3.5 text-destructive" />}
      expandedContent={
        <dl className="grid gap-1.5 rounded-xl rounded-bl-sm border border-primary/20 bg-card/70 px-3 py-2 text-xs">
          {details.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      }
      menuContent={
        <>
          <DropdownMenuItem
            disabled={isOpening}
            onSelect={(event) => {
              event.preventDefault();
              onOpen();
            }}
            data-testid={`menu-open-error-${error.fingerprint}`}
          >
            <FolderOpen className="mr-2 h-4 w-4" />
            Open
          </DropdownMenuItem>
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
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {error.errorIdentity}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {error.occurrenceCount.toLocaleString()}
        </span>
      </span>
    </TreeRow>
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
        className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
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
        className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
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
  const launch = useSessionLaunch();
  const [search, setSearch] = useState("");
  const [errorsOpen, setErrorsOpen] = useState(true);
  const [reportedOpen, setReportedOpen] = useState(true);
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
  const visionaryId = useMemo(
    () => personasData?.find((persona) => persona.name.toLowerCase() === "visionary")?.id,
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
    mutationFn: async ({
      id,
      updates,
    }: {
      id: number;
      updates: { status?: IssueStatus; kind?: "tracked" | "reported" };
    }) => {
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

  const openErrorMutation = useMutation({
    mutationFn: async (fingerprint: string) => {
      const response = await apiRequest("POST", `/api/issues/errors/${fingerprint}/open`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/issues"] });
      queryClient.invalidateQueries({ queryKey: ["/api/issues/errors/recent"] });
      toast({ title: "Error opened as Issue" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to open error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const normalized = search.trim();
  const activeIssues = (activeData?.issues || []).filter((issue) =>
    matchesQuery(
      `${issue.title} ${issue.description ?? ""} ${issue.reproSteps ?? ""} ${issue.reporterEmail ?? ""}`,
      normalized,
    ),
  );
  const reportedIssues = activeIssues.filter((issue) => issue.kind === "reported");
  const trackedIssues = activeIssues.filter((issue) => issue.kind !== "reported");
  const openIssues = trackedIssues.filter((issue) => issue.status === "open");
  const inProgressIssues = trackedIssues.filter((issue) => issue.status === "in_progress");
  const inReviewIssues = trackedIssues.filter((issue) => issue.status === "in_review");
  const resolvedIssues = (resolvedData?.issues || []).filter((issue) =>
    issue.kind !== "reported"
    && matchesQuery(
      `${issue.title} ${issue.description ?? ""} ${issue.reproSteps ?? ""} ${issue.reporterEmail ?? ""}`,
      normalized,
    ),
  );
  const filteredErrors = (errorsData || []).filter((error) =>
    matchesQuery(
      `${error.errorIdentity} ${error.sourceFile ?? ""} ${error.sourceSite ?? ""}`,
      normalized,
    ),
  );

  const discussIssue = (issue: Issue) => {
    launch.mutate({
      pendingKey: `issue-discuss-${issue.id}`,
      title: `Issue: ${issue.title}`,
      message: [
        `Diagnose the issue @issue:${issue.id} and determine if a fix is obvious, if so then do it and resolve the issue.`,
        "Look at the logs and code to ensure you understand the issue fully.",
        "If you don't have a clear understanding of the issue, do not make a speculative fix.",
        "",
        issue.description,
        ...(issue.reproSteps ? ["", "Reproduction steps:", issue.reproSteps] : []),
      ].join("\n"),
      clientTurnSuffix: `issue-discuss-${issue.id}`,
      personaId: engineerId,
      personaName: engineerId ? undefined : "Engineer",
      errorTitle: "Could not start issue discussion",
    });
  };

  const launchIssueFeature = (issue: Issue) => {
    launch.mutate({
      pendingKey: `issue-launch-${issue.id}`,
      title: `Feature: ${issue.title}`.slice(0, 80),
      message: composeIssueFeatureLaunchMessage({
        id: issue.id,
        title: issue.title,
        description: issue.description,
        reproSteps: issue.reproSteps,
        status: issue.status,
        kind: issue.kind,
        productId: issue.productId,
        platformEnvironmentId: issue.platformEnvironmentId,
        buildId: issue.buildId,
      }),
      clientTurnSuffix: `issue-launch-${issue.id}`,
      personaId: visionaryId,
      personaName: visionaryId ? undefined : "Visionary",
      errorTitle: "Could not start Feature conversion",
    });
  };

  const discussError = (error: AggregatedApplicationError) => {
    const source = error.sourceFile
      ? `${error.sourceFile}${error.sourceLine ? `:${error.sourceLine}` : ""}`
      : error.sourceSite || "Unavailable";
    launch.mutate({
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
      personaName: engineerId ? undefined : "Engineer",
      errorTitle: "Could not start error discussion",
    });
  };

  const openReportedIssue = (issue: Issue) => {
    updateMutation.mutate({
      id: issue.id,
      updates: { kind: "tracked", status: "open" },
    });
  };

  const renderIssue = (issue: Issue, options?: { canOpen?: boolean }) => (
    <IssueTreeRow
      key={issue.id}
      issue={issue}
      onCycleStatus={(id, nextStatus) => updateMutation.mutate({ id, updates: { status: nextStatus } })}
      isUpdating={updatingId === issue.id}
      onDiscuss={() => discussIssue(issue)}
      onLaunch={() => launchIssueFeature(issue)}
      isLaunching={launch.isPending && launch.variables?.pendingKey === `issue-launch-${issue.id}`}
      onOpen={options?.canOpen ? () => openReportedIssue(issue) : undefined}
      isOpening={options?.canOpen ? updatingId === issue.id && updateMutation.isPending : false}
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
          Report Issue
        </button>

        <IssueTreeSection
          label="Reported"
          issues={reportedIssues}
          open={reportedOpen}
          onOpenChange={setReportedOpen}
          testId="button-toggle-reported-group"
          count={reportedIssues.length}
          loading={isLoading}
          emptyLabel="No reported issues."
          renderIssue={(issue) => renderIssue(issue, { canOpen: true })}
        />

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
              onOpen={() => openErrorMutation.mutate(error.fingerprint)}
              isDismissing={dismissErrorMutation.isPending && dismissErrorMutation.variables === error.fingerprint}
              isOpening={openErrorMutation.isPending && openErrorMutation.variables === error.fingerprint}
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
          renderIssue={(issue) => renderIssue(issue)}
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
          renderIssue={(issue) => renderIssue(issue)}
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
          renderIssue={(issue) => renderIssue(issue)}
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
          renderIssue={(issue) => renderIssue(issue)}
        />
      </div>
    </div>
  );
}

export default IssuesTab;
