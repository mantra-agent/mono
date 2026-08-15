/**
 * PlanWidget — canonical inline plan progress widget used in sessions and plan details.
 *
 * Containers decide where the widget appears. The widget renders as a permanently
 * open hierarchy tree; child sessions own their own inline expansion.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  Loader2,
  OctagonAlert,
  MailOpen,
  MoreHorizontal,
  Pause,
  Pin,
  PinOff,
  Trash2,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleCheckCircle } from "@/components/home/home-check-circle";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
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
import { emitSessionListChanged } from "@/hooks/use-data-sync";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDiagnosticValue } from "@/lib/diagnostic-error";
import { createReferenceRef } from "@shared/references";
import {
  type PlanData,
  type PlanStep,
  type PlanStepAttempt,
} from "./plan-shared";
import type { PlanReviewDecision } from "@shared/plan-review";
import { ChildSessionBlock } from "@/components/inline-session-blocks";
import type { ChildSessionBlockMeta } from "@shared/models/chat";
import type { SessionStreamMap } from "@/hooks/use-session-subscription";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";

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
  pinned?: boolean;
}

function isProgressedStep(step: PlanStep): boolean {
  return step.status === "completed" || step.status === "skipped" || step.status === "failed" || step.status === "needs_review";
}

// Tree geometry is shared with the inline workflow widget.

function getAttemptChildSessionId(attempt: PlanStepAttempt): string | null {
  return attempt.childSessionId || null;
}

function PlanAttemptChild({ planId, parentSessionId, step, attempt, ownedChildBlocks, sessionTitleById, sessionStreams, variant = "history" }: { planId: string; parentSessionId: string; step: PlanStep; attempt: PlanStepAttempt; ownedChildBlocks?: Map<string, ChildSessionBlockMeta>; sessionTitleById?: Record<string, string>; sessionStreams?: SessionStreamMap; variant?: "active" | "history" }) {
  const stepCompleted = isProgressedStep(step);
  const childSessionId = getAttemptChildSessionId(attempt);
  if (!childSessionId) return null;
  const startedAt = attempt.startedAt || attempt.updatedAt || attempt.completedAt || new Date().toISOString();
  const ownedMeta = ownedChildBlocks?.get(childSessionId);
  const meta: ChildSessionBlockMeta = ownedMeta
    ? { ...ownedMeta, parentSessionId: ownedMeta.parentSessionId || parentSessionId }
    : {
        childSessionId,
        parentSessionId,
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
      hierarchyStepCompleted={stepCompleted}
      hierarchyLabel={`Attempt ${attempt.attemptNumber}`}
      hideHeader={variant === "active"}
      defaultExpanded={variant === "active"}
    />
  );
}

const REVIEW_OPTIONS: Array<{ decision: PlanReviewDecision; label: string }> = [
  { decision: "approve", label: "Approve" },
  { decision: "request_changes", label: "Request changes" },
  { decision: "retry", label: "Retry" },
  { decision: "stop", label: "Stop plan" },
];

function PlanReviewCard({
  planId,
  step,
  submitting,
  onSubmit,
}: {
  planId: string;
  step: PlanStep;
  submitting: boolean;
  onSubmit: (stepId: string, reviewId: number, decision: PlanReviewDecision, reason: string) => void;
}) {
  const [decision, setDecision] = useState<PlanReviewDecision>("approve");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const review = step.review;

  useEffect(() => {
    setDecision("approve");
    setReason("");
    setError(null);
  }, [review?.id]);

  if (!review || review.status !== "open") return null;

  const submit = () => {
    const normalizedReason = reason.trim();
    if (decision === "request_changes" && !normalizedReason) {
      setError("Describe the change needed.");
      return;
    }
    setError(null);
    onSubmit(step.id, review.id, decision, normalizedReason);
  };

  return (
    <div className="mt-1 overflow-hidden rounded-md border border-border/60 bg-muted/20" data-testid={`plan-review-${planId}-${step.id}`}>
      <div className="border-b border-border/40 px-3 py-2">
        <div className="flex items-start gap-2">
          <MailOpen className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
          <InlineReferenceText
            text={review.prompt}
            className="min-w-0 text-sm font-medium text-foreground"
          />
        </div>
        {review.detail ? (
          <div className="mt-1.5 whitespace-pre-wrap pl-6 text-sm leading-relaxed text-muted-foreground">
            <InlineReferenceText text={review.detail} />
          </div>
        ) : null}
      </div>
      <div className="space-y-0.5 px-2 py-2">
        {REVIEW_OPTIONS.map((option) => (
          <button
            key={option.decision}
            type="button"
            role="radio"
            aria-checked={decision === option.decision}
            disabled={submitting}
            onClick={() => {
              setDecision(option.decision);
              setError(null);
            }}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors",
              decision === option.decision ? "bg-accent/60" : "hover:bg-accent/40",
              submitting && "cursor-not-allowed opacity-60",
            )}
          >
            <SimpleCheckCircle checked={decision === option.decision} interactive={false} className="mt-0.5 shrink-0" />
            <span className="text-sm text-foreground">{option.label}</span>
          </button>
        ))}
        {(decision === "request_changes" || decision === "retry") && (
          <textarea
            autoFocus
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={submitting}
            rows={2}
            placeholder={decision === "request_changes" ? "What should change?" : "Optional retry guidance"}
            className="ml-[26px] mt-1 w-[calc(100%-26px)] resize-none rounded-sm border border-border/30 bg-transparent p-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border/60"
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-2">
        {error ? <p className="text-xs text-error">{error}</p> : <span />}
        <Button
          type="button"
          size="sm"
          className="bg-cta text-cta-foreground hover:bg-cta/90"
          disabled={submitting}
          onClick={submit}
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Submit"}
        </Button>
      </div>
    </div>
  );
}

function PlanStepCheckbox({
  step,
  stepIndex,
  continues,
  planId,
  parentSessionId,
  ownedChildBlocks,
  sessionTitleById,
  sessionStreams,
  reviewSubmitting,
  onReviewSubmit,
}: {
  step: PlanStep;
  stepIndex: number;
  continues: boolean;
  planId: string;
  parentSessionId: string;
  ownedChildBlocks?: Map<string, ChildSessionBlockMeta>;
  sessionTitleById?: Record<string, string>;
  sessionStreams?: SessionStreamMap;
  reviewSubmitting: boolean;
  onReviewSubmit: (stepId: string, reviewId: number, decision: PlanReviewDecision, reason: string) => void;
}) {
  const [attemptsOpen, setAttemptsOpen] = useState(step.status === "needs_review");

  useEffect(() => {
    if (step.status === "needs_review") setAttemptsOpen(true);
  }, [step.status, step.review?.id]);

  const checked = isProgressedStep(step);
  const isBlocked = step.status === "blocked";
  const needsReview = step.status === "needs_review";
  const stepErrorText = formatDiagnosticValue(step.error);
  const attemptsBySession = useMemo(() => {
    const bySession = new Map(
      (step.attempts ?? [])
        .filter((attempt) => attempt.childSessionId)
        .map((attempt) => [attempt.childSessionId!, attempt]),
    );
    for (const block of ownedChildBlocks?.values() ?? []) {
      if (block.planId !== planId || block.planStepId !== step.id || bySession.has(block.childSessionId)) continue;
      bySession.set(block.childSessionId, {
        id: block.planAttemptId ?? undefined,
        attemptNumber: block.planAttemptNumber ?? bySession.size + 1,
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
    return bySession;
  }, [ownedChildBlocks, planId, step.attempts, step.id]);
  const attempts = [...attemptsBySession.values()].sort((a, b) => a.attemptNumber - b.attemptNumber);
  const currentAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const priorAttempts = attempts.length > 1 ? attempts.slice(0, -1).reverse() : [];
  const hasRunningAttempt = attempts.some((attempt) => {
    if (attempt.status === "running" || attempt.status === "pending") return true;
    if (!attempt.childSessionId || attempt.completedAt) return false;
    const childStream = sessionStreams?.[attempt.childSessionId];
    return childStream?.status === "streaming" || childStream?.runActive === true;
  });
  const isActive = step.status === "running" || hasRunningAttempt;
  const displayChecked = checked && !isActive;
  const stepLabel = `Step ${stepIndex + 1}: ${step.title}`;

  return (
    <HierarchyTreeRow continues={continues} connectorAnchor="first-row-center">
      <div className="min-w-0">
        <div
          className={cn(
            "group relative flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground",
            needsReview && "text-foreground",
            isActive && "text-active hover:text-active",
            (step.status === "failed" || isBlocked) && "text-destructive hover:text-destructive",
          )}
        >
          <span
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center transition-colors",
              displayChecked && !needsReview && "text-success",
              isBlocked && "text-destructive",
              needsReview && "text-foreground",
              isActive && "text-active",
              !checked && !isBlocked && !needsReview && !isActive && "text-muted-foreground/50",
            )}
            aria-hidden="true"
          >
            {displayChecked && !needsReview && <CircleCheck className="h-3.5 w-3.5" />}
            {isBlocked && <OctagonAlert className="h-3 w-3" />}
            {needsReview && <MailOpen className="h-3.5 w-3.5" />}
            {isActive && !isBlocked && !needsReview && <ActiveStatusSpinner className="h-3.5 w-3.5" />}
            {!isActive && !checked && !isBlocked && !needsReview && <Circle className="h-3.5 w-3.5" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn("min-w-0 flex-1 truncate", displayChecked && !needsReview && "text-muted-foreground", needsReview && "font-medium text-foreground", isActive && "font-medium text-active")}>{stepLabel}</span>
              {isBlocked && <span className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">Blocked</span>}
              {needsReview && <span className="shrink-0 rounded border border-foreground/25 bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">Needs Review</span>}
            </div>
            {stepErrorText && <p className="mt-0.5 line-clamp-2 text-xs text-destructive">{stepErrorText}</p>}
          </div>
          {attempts.length > 0 && (
            <button
              type="button"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setAttemptsOpen((open) => !open)}
              aria-expanded={attemptsOpen}
              aria-label={attemptsOpen ? "Collapse step attempts" : "Expand step attempts"}
            >
              {attemptsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>

        {attemptsOpen && currentAttempt && (
          <div className="ml-4 border-l border-border/60 pl-2">
            <PlanAttemptChild
              key={currentAttempt.id ?? `${step.id}-${currentAttempt.attemptNumber}`}
              planId={planId}
              parentSessionId={parentSessionId}
              step={step}
              attempt={currentAttempt}
              ownedChildBlocks={ownedChildBlocks}
              sessionTitleById={sessionTitleById}
              sessionStreams={sessionStreams}
              variant="active"
            />
            {priorAttempts.map((attempt) => (
              <PlanAttemptChild
                key={attempt.id ?? `${step.id}-${attempt.attemptNumber}`}
                planId={planId}
                parentSessionId={parentSessionId}
                step={step}
                attempt={attempt}
                ownedChildBlocks={ownedChildBlocks}
                sessionTitleById={sessionTitleById}
                sessionStreams={sessionStreams}
                variant="history"
              />
            ))}
          </div>
        )}

        {needsReview && (
          <PlanReviewCard
            planId={planId}
            step={step}
            submitting={reviewSubmitting}
            onSubmit={onReviewSubmit}
          />
        )}
      </div>
    </HierarchyTreeRow>
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
  pinned = false,
}: PlanWidgetProps) {
  const { toast } = useToast();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const isExecuting = plan.status === "executing";
  const isPaused = plan.status === "paused";
  const isCreated = plan.status === "created";
  const isArchived = Boolean(plan.archivedAt);
  const canPause = !isArchived && isExecuting;
  const canResume = !isArchived && (isPaused || isCreated || plan.status === "failed");
  const canArchive = showArchiveAction && !isArchived && !isExecuting;
  const canDeleteFromSession = Boolean(sessionId);
  const canPinInSession = Boolean(sessionId);
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

  const reviewMutation = useMutation({
    mutationFn: async ({ stepId, reviewId, decision, reason }: { stepId: string; reviewId: number; decision: PlanReviewDecision; reason: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/plans/${encodeURIComponent(plan.pageId)}/steps/${encodeURIComponent(stepId)}/review`,
        { reviewId, decision, ...(reason ? { reason } : {}) },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Review failed");
      }
      return res.json();
    },
    onSuccess: (result) => {
      toast({
        title: result.decision === "approve" ? "Approved" : result.decision === "stop" ? "Plan stopped" : "Review recorded",
      });
      // Session menu review badges are derived from /api/sessions. Force a
      // local refresh even if the server data event is delayed or missed.
      void emitSessionListChanged("plan_review_resolved");
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      if (sessionId) {
        queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Review failed", description: err.message, variant: "destructive" });
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

  const pinMutation = useMutation({
    mutationFn: async (nextPinned: boolean) => {
      if (!sessionId) throw new Error("No session is attached to this plan widget");
      const res = await apiRequest("PATCH", `/api/sessions/${encodeURIComponent(sessionId)}/plans/${encodeURIComponent(plan.id)}/pin`, {
        pinned: nextPinned,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || "Pin failed");
      }
    },
    onSuccess: (_result, nextPinned) => {
      toast({ title: nextPinned ? "Plan pinned" : "Plan unpinned" });
      if (sessionId) queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
    },
    onError: (err: Error) => {
      toast({ title: pinned ? "Unpin failed" : "Pin failed", description: err.message, variant: "destructive" });
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

          {(canPause || canResume || canArchive || canDeleteFromSession || canPinInSession) && (
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
                {canPinInSession && (
                  <DropdownMenuItem onClick={() => pinMutation.mutate(!pinned)} disabled={pinMutation.isPending}>
                    {pinned ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}
                    {pinned ? "Unpin" : "Pin"}
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
                    {isCreated ? "Execute" : plan.status === "failed" ? "Retry" : "Resume"}
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
              parentSessionId={sessionId ?? plan.originSessionId}
              ownedChildBlocks={ownedChildBlocks}
              sessionTitleById={sessionTitleById}
              sessionStreams={sessionStreams}
              reviewSubmitting={reviewMutation.isPending}
              onReviewSubmit={(stepId, reviewId, decision, reason) => reviewMutation.mutate({ stepId, reviewId, decision, reason })}
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
