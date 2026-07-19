/**
 * PlanWidget — canonical inline plan progress widget used in sessions and plan details.
 *
 * Containers decide where the widget appears. Progress, expansion, step checkboxes,
 * and plan controls stay here.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Archive,
  Circle,
  CircleCheck,
  ChevronDown,
  ChevronRight,
  FileText,
  OctagonAlert,
  MailOpen,
  MoreHorizontal,
  Pause,
  Trash2,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
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
  type PlanStatus,
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
  variant?: "sticky" | "card";
  showArchiveAction?: boolean;
  sessionId?: string;
  className?: string;
  ownedChildBlocks?: Map<string, ChildSessionBlockMeta>;
  sessionTitleById?: Record<string, string>;
  sessionStreams?: SessionStreamMap;
}

function getBorderColor(status: PlanStatus, isFlashing: boolean): string {
  if (isFlashing && status === "completed") return "border-l-success";
  if (isFlashing && (status === "failed" || status === "aborted")) return "border-l-destructive";
  switch (status) {
    case "executing":
      return "border-l-info/30";
    case "completed":
      return "border-l-success/20";
    case "completed_with_failures":
      return "border-l-warning/20";
    case "failed":
    case "aborted":
      return "border-l-destructive/20";
    case "needs_review":
      return "border-l-foreground/30";
    case "paused":
      return "border-l-warning/20";
    default:
      return "border-l-border";
  }
}

function getTerminalLabel(status: PlanStatus): string | null {
  if (status === "completed") return "Complete";
  if (status === "completed_with_failures") return "Complete with warnings";
  if (status === "failed") return "Failed";
  if (status === "aborted") return "Aborted";
  return null;
}

function isProgressedStep(step: PlanStep): boolean {
  return step.status === "completed" || step.status === "skipped" || step.status === "failed" || step.status === "needs_review";
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

function PlanStepCheckbox({ step, stepIndex, planId, parentSessionId, ownedChildBlocks, sessionTitleById, sessionStreams }: { step: PlanStep; stepIndex: number; planId: string; parentSessionId?: string; ownedChildBlocks?: Map<string, ChildSessionBlockMeta>; sessionTitleById?: Record<string, string>; sessionStreams?: SessionStreamMap }) {
  const checked = isProgressedStep(step);
  const isRunning = step.status === "running";
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
      <div className="space-y-1">
        {attempts.map((attempt) => (
          <PlanAttemptChild
            key={attempt.id ?? `${step.id}-${attempt.attemptNumber}`}
            planId={planId}
            parentSessionId={parentSessionId}
            step={step}
            attempt={attempt}
            ownedChildBlocks={ownedChildBlocks}
            sessionTitleById={sessionTitleById}
            sessionStreams={sessionStreams}
          />
        ))}
      </div>
    );
  }

  // Pending step row with "Step N: title" prefix.
  return (
    <div>
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
    </div>
  );
}

export function PlanWidget({
  plan,
  variant = "card",
  showArchiveAction = false,
  sessionId,
  className,
  ownedChildBlocks,
  sessionTitleById,
  sessionStreams,
}: PlanWidgetProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [isMinimal, setIsMinimal] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const isExecuting = plan.status === "executing";
  const isTerminal =
    plan.status === "completed" ||
    plan.status === "completed_with_failures" ||
    plan.status === "failed" ||
    plan.status === "aborted";
  const isPaused = plan.status === "paused";
  const needsReview = plan.status === "needs_review";
  const isCreated = plan.status === "created";
  const isArchived = Boolean(plan.archivedAt);
  const canPause = !isArchived && isExecuting;
  const canResume = !isArchived && (isPaused || needsReview || isCreated || plan.status === "failed");
  const canArchive = showArchiveAction && !isArchived && !isExecuting;
  const canDeleteFromSession = Boolean(sessionId);
  const progressedCount = plan.steps.filter(isProgressedStep).length;
  const progressPercent = plan.steps.length > 0
    ? Math.round((progressedCount / plan.steps.length) * 100)
    : 0;


  useEffect(() => {
    if (variant !== "sticky" || !isTerminal) {
      setIsFlashing(false);
      setIsMinimal(false);
      return;
    }
    setIsFlashing(true);
    setIsOpen(false);
    const flashTimer = setTimeout(() => setIsFlashing(false), 2000);
    const minimalTimer = setTimeout(() => setIsMinimal(true), 10000);
    return () => {
      clearTimeout(flashTimer);
      clearTimeout(minimalTimer);
    };
  }, [isTerminal, plan.status, variant]);

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

  const terminalLabel = useMemo(() => getTerminalLabel(plan.status), [plan.status]);
  const title = plan.title.replace(/^Plan:\s*/, "") || plan.id;

  if (isMinimal && variant === "sticky" && isTerminal) {
    return (
      <div
        className={cn(
          "flex shrink-0 cursor-pointer items-center gap-2 border-b border-l-4 border-border bg-card px-4 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-accent/50",
          getBorderColor(plan.status, false),
          className,
        )}
        onClick={() => {
          setIsMinimal(false);
          setIsOpen(true);
        }}
      >
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[200px] truncate font-medium text-foreground/80">{title}</span>
        <span>{terminalLabel}</span>
      </div>
    );
  }

  return (
    <>
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          "overflow-hidden rounded-md border border-l-4 border-border/60 bg-muted/20 px-4 py-3 transition-all duration-200",
          isFlashing && plan.status === "completed" && "bg-success/10 border-b-success/30",
          isFlashing && (plan.status === "failed" || plan.status === "aborted") && "bg-destructive/10 border-b-destructive/30",
          getBorderColor(plan.status, isFlashing),
          className,
        )}
      >
        <div className="flex items-start gap-2">
          <CollapsibleTrigger asChild>
            <button className="min-w-0 flex-1 cursor-pointer select-none text-left">
              <div className="flex min-h-[28px] items-center gap-3">
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
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
                  <span className={cn("truncate text-sm font-medium", isExecuting && "text-active animate-pulse")}>{title}</span>
                )}

              </div>
              <div className="mt-2 pl-7">
                <Progress value={progressPercent} className="h-1.5" />
              </div>
            </button>
          </CollapsibleTrigger>

          {(canPause || canResume || canArchive || canDeleteFromSession) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
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

        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200">
          <div className="space-y-1 pt-3">
            <div className="max-h-[28rem] space-y-0.5 overflow-y-auto pr-2 scrollbar-thin">
              {plan.steps.map((step, stepIndex) => (
                <PlanStepCheckbox
                  key={step.id}
                  step={step}
                  stepIndex={stepIndex}
                  planId={plan.id}
                  parentSessionId={sessionId}
                  ownedChildBlocks={ownedChildBlocks}
                  sessionTitleById={sessionTitleById}
                  sessionStreams={sessionStreams}
                />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
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
