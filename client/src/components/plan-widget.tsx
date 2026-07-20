/**
 * PlanWidget — canonical inline plan progress widget used in sessions and plan details.
 *
 * Containers decide where the widget appears. The widget renders as a permanently
 * open hierarchy tree; child sessions own their own inline expansion.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Archive,
  Circle,
  CircleCheck,
  OctagonAlert,
  MailOpen,
  MoreHorizontal,
  Pause,
  Trash2,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDiagnosticValue } from "@/lib/diagnostic-error";
import { createReferenceRef } from "@shared/references";
import {
  type PlanData,
  type PlanStep,
  type PlanStepAttempt,
} from "./plan-shared";
import { ChildSessionBlock } from "@/components/inline-session-blocks";
import type { ChildSessionBlockMeta } from "@shared/models/chat";
import type { SessionStreamMap } from "@/hooks/use-session-subscription";

export interface PlanWidgetPlan extends PlanData {
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
}

interface PlanWidgetProps {
  plan: PlanWidgetPlan;
  showArchiveAction?: boolean;
  sessionId?: string;
  className?: string;
  ownedChildBlocks?: Map<string, ChildSessionBlockMeta>;
  sessionTitleById?: Record<string, string>;
  sessionStreams?: SessionStreamMap;
}

function isProgressedStep(step: PlanStep): boolean {
  return step.status === "completed" || step.status === "skipped" || step.status === "failed" || step.status === "needs_review";
}

// Match the Project task tree geometry. Derive the connector from row padding
// and completion-control size so the branch terminates at the center of the check.
const PLAN_ROW_PADDING_PX = 8;
const PLAN_COMPLETION_SIZE_PX = 16;
const PLAN_CONNECTOR_STROKE_PX = 1;
const PLAN_INDENT_STEP_PX = 24;
const PLAN_CONNECTOR_SPINE_PX = PLAN_INDENT_STEP_PX - PLAN_ROW_PADDING_PX - PLAN_COMPLETION_SIZE_PX / 2;
const PLAN_CONNECTOR_BRANCH_PX = PLAN_ROW_PADDING_PX + PLAN_COMPLETION_SIZE_PX / 2 - PLAN_CONNECTOR_SPINE_PX;

function PlanTreeConnector({ continues }: { continues: boolean }) {
  const spineStyle = {
    left: PLAN_CONNECTOR_SPINE_PX,
    width: PLAN_CONNECTOR_STROKE_PX,
  };
  const branchStyle = {
    left: PLAN_CONNECTOR_SPINE_PX,
    width: PLAN_CONNECTOR_BRANCH_PX,
    height: PLAN_CONNECTOR_STROKE_PX,
  };

  return (
    <div className="relative w-4 shrink-0 self-stretch" aria-hidden="true">
      <div
        className={cn("absolute top-0 bg-border", continues ? "bottom-0" : "bottom-1/2")}
        style={spineStyle}
      />
      <div className="absolute top-1/2 bg-border" style={branchStyle} />
    </div>
  );
}

function PlanTreeRow({
  continues,
  children,
}: {
  continues: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 items-stretch"
      style={{ paddingLeft: PLAN_INDENT_STEP_PX }}
    >
      <PlanTreeConnector continues={continues} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function getAttemptChildSessionId(attempt: PlanStepAttempt): string | null {
  return attempt.childSessionId || null;
}

function PlanAttemptChild({ planId, parentSessionId, step, attempt, ownedChildBlocks, sessionTitleById, sessionStreams }: { planId: string; parentSessionId?: string; step: PlanStep; attempt: PlanStepAttempt; ownedChildBlocks?: Map<string, ChildSessionBlockMeta>; sessionTitleById?: Record<string, string>; sessionStreams?: SessionStreamMap }) {
  const stepCompleted = isProgressedStep(step);
  const childSessionId = getAttemptChildSessionId(attempt);
  if (!childSessionId) return null;
  const startedAt = attempt.startedAt || attempt.updatedAt || attempt.completedAt || new Date().toISOString();
  const meta: ChildSessionBlockMeta = ownedChildBlocks?.get(childSessionId) ?? {
    childSessionId,
    parentSessionId: parentSessionId ?? "",
    role: `Attempt ${attempt.attemptNumber}`,
    startedAt,
    updatedAt: attempt.updatedAt ?? attempt.completedAt ?? startedAt,
    summary: attempt.outcome ?? null,
    error: attempt.error ?? null,
    elapsedMs: attempt.durationSeconds != null ? attempt.durationSeconds * 1000 : null,
    planId,
    planStepId: step.id,
    planAttemptId: attempt.id ?? null,
    planAttemptNumber: attempt.attemptNumber,
  };
  return (
    <ChildSessionBlock
      meta={meta}
      depth={1}
      sessionTitleById={sessionTitleById}
      childStream={sessionStreams?.[childSessionId]}
      planStepCompleted={stepCompleted}
    />
  );
}

function PlanStepCheckbox({ step, stepIndex, continues, planId, parentSessionId, ownedChildBlocks, sessionTitleById, sessionStreams }: { step: PlanStep; stepIndex: number; continues: boolean; planId: string; parentSessionId?: string; ownedChildBlocks?: Map<string, ChildSessionBlockMeta>; sessionTitleById?: Record<string, string>; sessionStreams?: SessionStreamMap }) {
  const checked = isProgressedStep(step);
  const isBlocked = step.status === "blocked";
  const needsReview = step.status === "needs_review";
  const stepErrorText = formatDiagnosticValue(step.error);
  const attemptsBySession = new Map(
    (step.attempts ?? [])
      .filter((attempt) => attempt.childSessionId)
      .map((attempt) => [attempt.childSessionId!, attempt]),
  );
  for (const block of ownedChildBlocks?.values() ?? []) {
    if (
      block.planId !== planId ||
      block.planStepId !== step.id ||
      attemptsBySession.has(block.childSessionId)
    ) continue;
    attemptsBySession.set(block.childSessionId, {
      id: block.planAttemptId ?? undefined,
      attemptNumber: block.planAttemptNumber ?? attemptsBySession.size + 1,
      childSessionId: block.childSessionId,
      status: block.error ? "failed" : block.summary ? "completed" : "running",
      startedAt: block.startedAt,
      updatedAt: block.updatedAt,
      completedAt: block.summary || block.error ? block.updatedAt : null,
      durationSeconds: block.elapsedMs != null ? Math.round(block.elapsedMs / 1000) : null,
      outcome: block.summary,
      error: block.error,
    });
  }
  const attempts = [...attemptsBySession.values()].sort(
    (a, b) => a.attemptNumber - b.attemptNumber,
  );

  const stepLabel = `Step ${stepIndex + 1}: ${step.title}`;

  // When a step has a child session, replace the step row entirely with the
  // child session widget. The child renders its own check icon via planStepCompleted.
  if (attempts.length > 0) {
    return (
      <>
        {attempts.map((attempt, attemptIndex) => (
          <PlanTreeRow
            key={attempt.id ?? `${step.id}-${attempt.attemptNumber}`}
            continues={continues || attemptIndex < attempts.length - 1}
          >
            <PlanAttemptChild
              planId={planId}
              parentSessionId={parentSessionId}
              step={step}
              attempt={attempt}
              ownedChildBlocks={ownedChildBlocks}
              sessionTitleById={sessionTitleById}
              sessionStreams={sessionStreams}
            />
          </PlanTreeRow>
        ))}
      </>
    );
  }

  // Pending step row with "Step N: title" prefix.
  return (
    <PlanTreeRow continues={continues}>
      <div
        className={cn(
          "group relative flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground",
          needsReview && "text-foreground",
          (step.status === "failed" || isBlocked) && "text-destructive hover:text-destructive",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center transition-colors",
            checked && "text-success",
            isBlocked && !checked && "rounded border border-destructive bg-destructive/10 text-destructive",
            needsReview && !checked && "rounded border border-foreground/70 bg-foreground/10 text-foreground shadow-[0_0_0_1px_hsl(var(--foreground)/0.12)]",
            !checked && !isBlocked && !needsReview && "text-muted-foreground/50",
          )}
          aria-hidden="true"
        >
          {checked && !needsReview && <CircleCheck className="h-3.5 w-3.5" />}
          {isBlocked && !checked && <OctagonAlert className="h-3 w-3" />}
          {needsReview && checked && <MailOpen className="h-3 w-3" />}
          {!checked && !isBlocked && !needsReview && <Circle className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                checked && "text-muted-foreground",
                needsReview && "font-medium text-foreground",
              )}
            >
              {stepLabel}
            </span>
            {isBlocked && <span className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">Blocked</span>}
            {needsReview && <span className="shrink-0 rounded border border-foreground/25 bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">Needs Review</span>}
          </div>
          {stepErrorText && (
            <p className="mt-0.5 line-clamp-2 text-xs text-destructive">{stepErrorText}</p>
          )}
        </div>
      </div>
    </PlanTreeRow>
  );
}

export function PlanWidget({
  plan,
  showArchiveAction = false,
  sessionId,
  className,
  ownedChildBlocks,
  sessionTitleById,
  sessionStreams,
}: PlanWidgetProps) {
  const { toast } = useToast();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const isExecuting = plan.status === "executing";
  const isPaused = plan.status === "paused";
  const needsReview = plan.status === "needs_review";
  const isCreated = plan.status === "created";
  const isArchived = Boolean(plan.archivedAt);
  const canPause = !isArchived && isExecuting;
  const canResume = !isArchived && (isPaused || needsReview || isCreated || plan.status === "failed");
  const canArchive = showArchiveAction && !isArchived && !isExecuting;
  const canDeleteFromSession = Boolean(sessionId);
  const invalidatePlanQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
    queryClient.invalidateQueries({ queryKey: ["/api/plans", plan.id] });
    queryClient.invalidateQueries({ queryKey: ["/api/plans", plan.pageId] });
  };

  const pauseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/plans/${plan.pageId}/pause`);
      if (!res.ok) throw new Error("Pause failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Pause requested", description: "Current step will complete before pausing." });
      invalidatePlanQueries();
    },
    onError: (err: Error) => {
      toast({ title: "Pause failed", description: err.message, variant: "destructive" });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const endpoint = isCreated ? "execute" : "resume";
      const res = await apiRequest("POST", `/api/plans/${plan.pageId}/${endpoint}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Resume failed");
      }
      return res.json();
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/plans", plan.pageId] });
      const prev = queryClient.getQueryData<PlanData>(["/api/plans", plan.pageId]);
      if (prev) {
        queryClient.setQueryData<PlanData>(["/api/plans", plan.pageId], {
          ...prev,
          status: "executing",
        });
      }
      return { prev };
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["/api/plans", plan.pageId], ctx.prev);
      toast({ title: isCreated ? "Execute failed" : "Resume failed", description: err.message, variant: "destructive" });
    },
    onSettled: invalidatePlanQueries,
  });

  const unlinkMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) throw new Error("No session is attached to this plan widget");
      const res = await apiRequest("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}/plan`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Delete failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Plan removed from session" });
      if (sessionId) queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      invalidatePlanQueries();
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/plans/${plan.pageId}/archive`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Archive failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Plan archived" });
      invalidatePlanQueries();
    },
    onError: (err: Error) => {
      toast({ title: "Archive failed", description: err.message, variant: "destructive" });
    },
  });

  const title = plan.title.replace(/^Plan:\s*/, "") || plan.id;

  return (
    <>
      <div className={cn("min-w-0", className)}>
        <div className="group flex min-w-0 items-center gap-2 px-2 py-1.5">
          <div className="min-w-0 flex-1">
            {plan.pageSlug ? (
              <ReferenceRenderer
                refValue={createReferenceRef({
                  type: "page",
                  id: plan.pageSlug,
                  metadata: { label: title },
                })}
                surface="card"
              />
            ) : (
              <span className={cn("block truncate text-sm font-medium", isExecuting && "text-active animate-pulse")}>{title}</span>
            )}
          </div>

          {(canPause || canResume || canArchive || canDeleteFromSession) && (
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
                {canPause && (
                  <DropdownMenuItem onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
                    <Pause className="mr-2 h-4 w-4" />
                    Pause
                  </DropdownMenuItem>
                )}
                {canResume && (
                  <DropdownMenuItem onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
                    <Play className="mr-2 h-4 w-4" />
                    {isCreated ? "Execute" : plan.status === "failed" ? "Retry" : needsReview ? "Review" : "Resume"}
                  </DropdownMenuItem>
                )}
                {canArchive && (
                  <DropdownMenuItem
                    onClick={() => archiveMutation.mutate()}
                    disabled={archiveMutation.isPending}
                    className="text-destructive focus:text-destructive"
                  >
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </DropdownMenuItem>
                )}
                {canDeleteFromSession && (
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      setConfirmDeleteOpen(true);
                    }}
                    disabled={unlinkMutation.isPending}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="max-h-[28rem] overflow-y-auto pr-2 scrollbar-thin">
          {plan.steps.map((step, stepIndex) => (
            <PlanStepCheckbox
              key={step.id}
              step={step}
              stepIndex={stepIndex}
              continues={stepIndex < plan.steps.length - 1}
              planId={plan.id}
              parentSessionId={sessionId}
              ownedChildBlocks={ownedChildBlocks}
              sessionTitleById={sessionTitleById}
              sessionStreams={sessionStreams}
            />
          ))}
        </div>
      </div>
      <AlertDialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this plan from the session?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the Plan widget from this session. It does not delete the plan page or its execution history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => unlinkMutation.mutate()}
            disabled={unlinkMutation.isPending}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
