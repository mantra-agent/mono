/**
 * PlanWidget — shared plan progress widget for chat sticky bars and Work > Plans rows.
 *
 * Session chat is the source shape. Containers decide whether it appears pinned
 * or card-like; progress, expansion, step checkboxes, and plan controls stay here.
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDiagnosticValue } from "@/lib/diagnostic-error";
import { createReferenceRef } from "@shared/references";
import {
  getStatusBadge,
  type PlanData,
  type PlanStatus,
  type PlanStep,
} from "./plan-shared";

export interface PlanWidgetPlan extends PlanData {
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
}

interface PlanWidgetProps {
  plan: PlanWidgetPlan;
  variant?: "sticky" | "card";
  showArchiveAction?: boolean;
  className?: string;
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
  return step.status === "completed" || step.status === "skipped" || step.status === "failed";
}

function PlanStepCheckbox({ step }: { step: PlanStep }) {
  const checked = isProgressedStep(step);
  const isRunning = step.status === "running";
  const isBlocked = step.status === "blocked";
  const needsReview = step.status === "needs_review";
  const stepErrorText = formatDiagnosticValue(step.error);

  return (
    <div className="flex min-w-0 items-stretch pl-4">
      <div className="relative mr-1 w-5 shrink-0 self-stretch" aria-hidden="true">
        <div className="absolute bottom-1/2 left-1/2 top-0 -translate-x-px border-l border-border/50" />
        <div className="absolute left-1/2 right-0 top-1/2 border-t border-border/50" />
      </div>
      <div
        className={cn(
          "group relative flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground",
          isRunning && "bg-sidebar-accent/50 text-active hover:text-active",
          needsReview && "text-foreground",
          (step.status === "failed" || isBlocked) && "text-destructive hover:text-destructive",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center transition-colors",
            checked && "text-success",
            isRunning && !checked && "text-active",
            isBlocked && !checked && "rounded border border-destructive bg-destructive/10 text-destructive",
            needsReview && !checked && "rounded border border-foreground/70 bg-foreground/10 text-foreground shadow-[0_0_0_1px_hsl(var(--foreground)/0.12)]",
            !checked && !isRunning && !isBlocked && !needsReview && "text-muted-foreground/50",
          )}
          aria-hidden="true"
        >
          {checked && <CircleCheck className="h-3.5 w-3.5" />}
          {isRunning && !checked && <ActiveStatusSpinner className="h-3.5 w-3.5" />}
          {isBlocked && !checked && <OctagonAlert className="h-3 w-3" />}
          {needsReview && !checked && <MailOpen className="h-3 w-3" />}
          {!checked && !isRunning && !isBlocked && !needsReview && <Circle className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                checked && "text-muted-foreground",
                needsReview && "font-medium text-foreground",
                isRunning && "font-medium text-active",
              )}
            >
              {step.title}
            </span>
            {isBlocked && <span className="shrink-0 rounded border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-destructive">Blocked</span>}
            {needsReview && <span className="shrink-0 rounded border border-foreground/25 bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground">Unread</span>}
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
  variant = "sticky",
  showArchiveAction = false,
  className,
}: PlanWidgetProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [isMinimal, setIsMinimal] = useState(false);

  const isExecuting = plan.status === "executing";
  const isTerminal =
    plan.status === "completed" ||
    plan.status === "completed_with_failures" ||
    plan.status === "failed" ||
    plan.status === "aborted";
  const isPaused = plan.status === "paused";
  const isCreated = plan.status === "created";
  const isArchived = Boolean(plan.archivedAt);
  const canPause = !isArchived && isExecuting;
  const canResume = !isArchived && (isPaused || isCreated || plan.status === "failed");
  const canArchive = showArchiveAction && !isArchived && !isExecuting;

  const progressedCount = plan.steps.filter(isProgressedStep).length;
  const progressPercent = plan.steps.length > 0
    ? Math.round((progressedCount / plan.steps.length) * 100)
    : 0;
  const currentStep = plan.steps.find((s) => s.status === "running");

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
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          "border-l-4 border-border bg-card transition-all duration-200",
          variant === "sticky" ? "shrink-0 border-b px-4 py-2" : "overflow-hidden rounded-lg border border-l-4 px-4 py-3",
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
                {isExecuting ? (
                  <ActiveStatusSpinner className="h-4 w-4" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className={cn("truncate text-sm font-medium", isExecuting && "text-active animate-pulse")}>{title}</span>
                {!isExecuting && getStatusBadge(plan.status)}
                {isExecuting && currentStep && (
                  <span className="min-w-0 flex-1 truncate text-xs text-active/80">
                    {currentStep.title}
                  </span>
                )}
              </div>
              <div className="mt-2 pl-7">
                <Progress value={progressPercent} className="h-1.5" />
              </div>
            </button>
          </CollapsibleTrigger>

          {(canPause || canResume || canArchive) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
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
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200">
          <div className="space-y-2 pt-3 pl-7">
            {plan.pageSlug && (
              <div className="flex flex-wrap items-center gap-1.5">
                <ReferenceRenderer
                  refValue={createReferenceRef({
                    type: "page",
                    id: plan.pageSlug,
                    metadata: { label: title },
                  })}
                  surface="card"
                />
              </div>
            )}
            <div className="max-h-[20rem] space-y-0.5 overflow-y-auto pr-2 scrollbar-thin">
              {plan.steps.map((step) => (
                <PlanStepCheckbox key={step.id} step={step} />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
