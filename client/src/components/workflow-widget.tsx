import { useMutation } from "@tanstack/react-query";
import {
  Circle,
  CircleCheck,
  LockKeyhole,
  MoreHorizontal,
  OctagonAlert,
  Pause,
  Play,
  Square,
} from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { formatDiagnosticValue } from "@/lib/diagnostic-error";
import type {
  WorkflowStageStatus,
  WorkflowWidgetAttempt,
  WorkflowWidgetRun,
  WorkflowWidgetSession,
  WorkflowWidgetStage,
} from "@/components/workflow-shared";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ChildSessionBlock } from "@/components/inline-session-blocks";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import type { ChildSessionBlockMeta } from "@shared/models/chat";
import type { SessionStreamMap } from "@/hooks/use-session-subscription";

interface WorkflowWidgetProps {
  workflow: WorkflowWidgetRun;
  sessionId?: string;
  sessionTitleById?: Record<string, string>;
  sessionStreams?: SessionStreamMap;
  className?: string;
}

function formatFailure(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["summary", "message", "error", "reason", "description"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
  }
  return formatDiagnosticValue(value);
}

function isProgressedStage(status: WorkflowStageStatus): boolean {
  return status === "passed" || status === "skipped" || status === "failed" || status === "needs_review";
}

function getStageSessions(
  stage: WorkflowWidgetStage,
  sessions: WorkflowWidgetSession[],
): WorkflowWidgetSession[] {
  const byId = new Map<string, WorkflowWidgetSession>();
  for (const session of sessions) {
    if (
      session.stageAttemptId &&
      stage.attempts.some((attempt) => attempt.id === session.stageAttemptId)
    ) {
      byId.set(session.sessionId, session);
    }
  }
  for (const attempt of stage.attempts) {
    if (attempt.childSessionId && !byId.has(attempt.childSessionId)) {
      byId.set(attempt.childSessionId, {
        id: attempt.id,
        stageAttemptId: attempt.id,
        sessionId: attempt.childSessionId,
        role: "stage",
      });
    }
  }
  return [...byId.values()];
}

function getSessionAttempt(
  stage: WorkflowWidgetStage,
  session: WorkflowWidgetSession,
): WorkflowWidgetAttempt | undefined {
  return stage.attempts.find((attempt) =>
    attempt.id === session.stageAttemptId || attempt.childSessionId === session.sessionId,
  );
}

function workflowSessionStartedAt(session: WorkflowWidgetSession): string {
  return session.createdAt ?? "1970-01-01T00:00:00.000Z";
}

function WorkflowStageIcon({ status }: { status: WorkflowStageStatus }) {
  if (status === "active") return <ActiveStatusSpinner className="h-3.5 w-3.5" />;
  if (status === "passed") return <CircleCheck className="h-3.5 w-3.5 text-success" />;
  if (status === "blocked" || status === "failed") {
    return <OctagonAlert className="h-3 w-3 text-destructive" />;
  }
  if (status === "needs_review") return <LockKeyhole className="h-3 w-3 text-foreground" />;
  if (status === "skipped") return <CircleCheck className="h-3.5 w-3.5 text-muted-foreground" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />;
}

function WorkflowAttemptChild({
  parentSessionId,
  stage,
  stageIndex,
  session,
  sessionTitleById,
  sessionStreams,
}: {
  parentSessionId?: string;
  stage: WorkflowWidgetStage;
  stageIndex: number;
  session: WorkflowWidgetSession;
  sessionTitleById?: Record<string, string>;
  sessionStreams?: SessionStreamMap;
}) {
  const attempt = getSessionAttempt(stage, session);
  const failure = formatFailure(attempt?.failureContext);
  const startedAt = attempt?.startedAt ?? workflowSessionStartedAt(session);
  const meta: ChildSessionBlockMeta = {
    childSessionId: session.sessionId,
    parentSessionId: parentSessionId ?? "",
    role: `Stage ${stageIndex + 1}: ${stage.title}`,
    startedAt,
    updatedAt: startedAt,
    summary: attempt?.outputSummary ?? null,
    error: failure,
    elapsedMs: attempt?.durationSeconds != null ? attempt.durationSeconds * 1000 : null,
    spawnReason: session.spawnReason ?? null,
  };

  return (
    <ChildSessionBlock
      meta={meta}
      depth={1}
      sessionTitleById={sessionTitleById}
      childStream={sessionStreams?.[session.sessionId]}
      hierarchyStepCompleted={isProgressedStage(stage.status)}
    />
  );
}

function WorkflowStageRow({
  parentSessionId,
  stage,
  stageIndex,
  continues,
  sessions,
  sessionTitleById,
  sessionStreams,
}: {
  parentSessionId?: string;
  stage: WorkflowWidgetStage;
  stageIndex: number;
  continues: boolean;
  sessions: WorkflowWidgetSession[];
  sessionTitleById?: Record<string, string>;
  sessionStreams?: SessionStreamMap;
}) {
  const stageSessions = getStageSessions(stage, sessions);
  const failure = formatFailure(stage.latestAttempt?.failureContext);
  const isBlocked = stage.status === "blocked";
  const isFailed = stage.status === "failed";
  const needsReview = stage.status === "needs_review";
  const isActive = stage.status === "active";

  if (stageSessions.length > 0) {
    return (
      <>
        {stageSessions.map((session, sessionIndex) => (
          <HierarchyTreeRow
            key={session.sessionId}
            continues={continues || sessionIndex < stageSessions.length - 1}
          >
            <WorkflowAttemptChild
              parentSessionId={parentSessionId}
              stage={stage}
              stageIndex={stageIndex}
              session={session}
              sessionTitleById={sessionTitleById}
              sessionStreams={sessionStreams}
            />
          </HierarchyTreeRow>
        ))}
      </>
    );
  }

  return (
    <HierarchyTreeRow continues={continues}>
      <div
        className={cn(
          "group relative flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground",
          isActive && "font-medium text-foreground",
          needsReview && "text-foreground",
          (isBlocked || isFailed) && "text-destructive hover:text-destructive",
        )}
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
          <WorkflowStageIcon status={stage.status} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                isProgressedStage(stage.status) && !needsReview && !isFailed && "text-muted-foreground",
                needsReview && "font-medium text-foreground",
              )}
            >
              {`Stage ${stageIndex + 1}: ${stage.title}`}
            </span>
            {isBlocked && (
              <span className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">
                Blocked
              </span>
            )}
            {needsReview && (
              <span className="shrink-0 rounded border border-foreground/25 bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">
                Needs Review
              </span>
            )}
          </div>
          {failure && <p className="mt-0.5 line-clamp-2 text-xs text-destructive">{failure}</p>}
        </div>
      </div>
    </HierarchyTreeRow>
  );
}

export function WorkflowWidget({
  workflow,
  sessionId,
  sessionTitleById,
  sessionStreams,
  className,
}: WorkflowWidgetProps) {
  const { toast } = useToast();
  const runId = workflow.run.id;
  const isDraft = workflow.run.status === "draft";
  const isActive = workflow.run.status === "active";
  const isPaused = workflow.run.status === "paused";
  const canStart = isDraft;
  const canPause = isActive;
  const canResume = isPaused;
  const canCancel = isDraft || isActive || isPaused;
  const showMenu = canStart || canPause || canResume || canCancel;

  const invalidateWorkflow = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/workflows/runs/${runId}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/workflows/runs"] });
  };

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/start`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Start failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Workflow started" });
      invalidateWorkflow();
    },
    onError: (err: Error) => {
      toast({ title: "Start failed", description: err.message, variant: "destructive" });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/pause`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Pause failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Workflow paused" });
      invalidateWorkflow();
    },
    onError: (err: Error) => {
      toast({ title: "Pause failed", description: err.message, variant: "destructive" });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/resume`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Resume failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Workflow resumed" });
      invalidateWorkflow();
    },
    onError: (err: Error) => {
      toast({ title: "Resume failed", description: err.message, variant: "destructive" });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/cancel`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Cancel failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Workflow canceled" });
      invalidateWorkflow();
    },
    onError: (err: Error) => {
      toast({ title: "Cancel failed", description: err.message, variant: "destructive" });
    },
  });

  const stages = isDraft
    ? workflow.stages.map((stage) =>
        stage.status === "active" ? { ...stage, status: "pending" as const } : stage,
      )
    : workflow.stages;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="group flex min-w-0 items-center gap-2 px-2 py-1.5">
        <Link
          href={`/workflows/${runId}`}
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium hover:underline underline-offset-2",
            isActive && "text-active animate-pulse",
          )}
        >
          {workflow.run.title || runId}
        </Link>

        {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canStart && (
                <DropdownMenuItem onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
                  <Play className="mr-2 h-4 w-4" />
                  Start
                </DropdownMenuItem>
              )}
              {canPause && (
                <DropdownMenuItem onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
                  <Pause className="mr-2 h-4 w-4" />
                  Pause
                </DropdownMenuItem>
              )}
              {canResume && (
                <DropdownMenuItem onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
                  <Play className="mr-2 h-4 w-4" />
                  Resume
                </DropdownMenuItem>
              )}
              {canCancel && (
                <DropdownMenuItem
                  onClick={() => cancelMutation.mutate()}
                  disabled={cancelMutation.isPending}
                  className="text-destructive focus:text-destructive"
                >
                  <Square className="mr-2 h-4 w-4" />
                  Cancel
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="max-h-[28rem] overflow-y-auto pr-2 scrollbar-thin">
        {stages.map((stage, stageIndex) => (
          <WorkflowStageRow
            key={stage.key}
            parentSessionId={sessionId}
            stage={stage}
            stageIndex={stageIndex}
            continues={stageIndex < stages.length - 1}
            sessions={workflow.sessions ?? []}
            sessionTitleById={sessionTitleById}
            sessionStreams={sessionStreams}
          />
        ))}
      </div>
    </div>
  );
}
