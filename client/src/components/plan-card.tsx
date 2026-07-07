/**
 * PlanCard — renders inline in chat as an interactive plan progress card.
 *
 * Three states:
 * 1. Created — step list with titles, Execute/Edit buttons
 * 2. Executing — live progress with spinner on current step, Pause button
 * 3. Complete/Failed/Paused — final state with expandable step details
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Pause,
  Play,
  RotateCcw,
  ExternalLink,
  FileText,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDiagnosticValue } from "@/lib/diagnostic-error";
import { usePlanEvents, type PlanEvent } from "@/hooks/use-plan-events";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  type PlanStatus,
  type StepStatus,
  type PlanStep,
  type PlanData,
  formatDuration,
  getStatusIcon,
  getStatusBadge,
  StepRow,
  ElapsedTimer,
} from "./plan-shared";

interface PlanCardProps {
  /** Library page ID of the plan */
  planId: string;
  /** Title to display */
  title: string;
  /** Initial plan data from tool result (avoids initial fetch) */
  initialData?: Partial<PlanData>;
}

// ─── Main Component ──────────────────────────────────────────────────

export function PlanCard({ planId, title, initialData }: PlanCardProps) {
  const { toast } = useToast();

  // Local state to avoid refetch lag
  const [localSteps, setLocalSteps] = useState<PlanStep[]>(initialData?.steps || []);
  const [localStatus, setLocalStatus] = useState<PlanStatus>(initialData?.status || "created");
  const [executionStartTime, setExecutionStartTime] = useState<number | null>(null);
  const localDataRef = useRef({ steps: localSteps, status: localStatus });

  // Fetch plan data from API
  const { data: planData } = useQuery<PlanData>({
    queryKey: ["/api/plans", planId],
    queryFn: async () => {
      const res = await fetch(`/api/plans/${planId}`);
      if (!res.ok) throw new Error("Failed to load plan");
      return res.json();
    },
    refetchInterval: localStatus === "executing" ? 5000 : false,
  });

  // Sync API data to local state (only if newer)
  useEffect(() => {
    if (!planData) return;
    // Only update from API if not currently receiving live events
    setLocalSteps(planData.steps);
    setLocalStatus(planData.status);
    localDataRef.current = { steps: planData.steps, status: planData.status };
    if (planData.status === "executing" && !executionStartTime) {
      setExecutionStartTime(Date.now());
    }
  }, [planData]);

  // Subscribe to live WebSocket events
  usePlanEvents(useCallback((event: PlanEvent) => {
    setLocalSteps(prev => {
      const next = [...prev];
      switch (event.type) {
        case "plan.step.started": {
          const idx = next.findIndex(s => s.id === event.stepId);
          if (idx >= 0) next[idx] = { ...next[idx], status: "running" };
          break;
        }
        case "plan.step.completed": {
          const idx = next.findIndex(s => s.id === event.stepId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              status: "completed",
              duration: event.duration,
              outcome: event.outcome,
            };
          }
          break;
        }
        case "plan.step.failed": {
          const idx = next.findIndex(s => s.id === event.stepId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              status: "failed",
              error: event.error,
            };
          }
          break;
        }
      }
      localDataRef.current.steps = next;
      return next;
    });

    switch (event.type) {
      case "plan.started":
        setLocalStatus("executing");
        setExecutionStartTime(Date.now());
        break;
      case "plan.completed":
        setLocalStatus("completed");
        queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
        break;
      case "plan.paused":
        setLocalStatus("paused");
        queryClient.invalidateQueries({ queryKey: ["/api/plans"] });
        break;
    }
  }, []), planId);

  // Derive stats
  const completedCount = localSteps.filter(s => s.status === "completed" || s.status === "skipped" || s.status === "failed").length;
  const totalCount = localSteps.length;
  const currentStep = localSteps.find(s => s.status === "running");
  const currentStepIndex = currentStep ? localSteps.indexOf(currentStep) : -1;
  const failedStep = localSteps.find(s => s.status === "failed");
  const isExecuting = localStatus === "executing";
  const isTerminal = localStatus === "completed" || localStatus === "failed" || localStatus === "aborted";
  const isPaused = localStatus === "paused";
  const isCreated = localStatus === "created";
  const totalDuration = localSteps.reduce((sum, s) => sum + (s.duration || 0), 0);
  const pageSlug = planData?.pageSlug || "";

  // ─── Actions ─────────────────────────────────────────

  const executeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/plans/${planId}/execute`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Execute failed (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setLocalStatus("executing");
      setExecutionStartTime(Date.now());
      queryClient.invalidateQueries({ queryKey: ["/api/plans", planId] });
    },
    onError: (err: Error) => {
      toast({ title: "Execute failed", description: err.message, variant: "destructive" });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/plans/${planId}/pause`);
      if (!res.ok) throw new Error("Pause failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Pause requested", description: "Current step will complete before pausing." });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/plans/${planId}/resume`);
      if (!res.ok) throw new Error("Resume failed");
      return res.json();
    },
    onSuccess: () => {
      setLocalStatus("executing");
      setExecutionStartTime(Date.now());
      queryClient.invalidateQueries({ queryKey: ["/api/plans", planId] });
    },
  });

  // ─── Render ──────────────────────────────────────────

  return (
    <Card className={cn(
      "overflow-hidden my-2",
      isExecuting && "border-info/30",
      localStatus === "completed" && "border-success/20",
      localStatus === "failed" && "border-destructive/20",
      isPaused && "border-warning/20",
    )}>
      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-medium text-sm truncate">{title}</span>
          </div>
          {getStatusBadge(localStatus)}
        </div>

        {/* Progress summary */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {isExecuting && currentStep && (
            <span className="text-info">
              Step {currentStepIndex + 1} of {totalCount}
            </span>
          )}
          {!isExecuting && (
            <span>{completedCount}/{totalCount} steps</span>
          )}
          {isExecuting && executionStartTime && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <ElapsedTimer startTime={executionStartTime} />
            </span>
          )}
          {isTerminal && totalDuration > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(totalDuration)}
            </span>
          )}
        </div>

        {/* Step list */}
        <div className="space-y-0.5">
          {localSteps.map((step, i) => (
            <StepRow
              key={step.id}
              step={step}
              index={i}
              isCurrentStep={step.status === "running"}
            />
          ))}
        </div>

        {/* Error display */}
        {failedStep && formatDiagnosticValue(failedStep.error) && (
          <div className="text-xs text-destructive bg-destructive/5 rounded-md p-2 mt-1">
            <span className="font-medium">Error:</span> {formatDiagnosticValue(failedStep.error)}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          {isCreated && (
            <>
              <Button
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => executeMutation.mutate()}
                disabled={executeMutation.isPending}
              >
                <Play className="h-3 w-3" />
                {executeMutation.isPending ? "Starting..." : "Execute"}
              </Button>
              {pageSlug && (
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" asChild>
                  <a href={`/info/${pageSlug}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3" />
                    Edit
                  </a>
                </Button>
              )}
            </>
          )}
          {isExecuting && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={() => pauseMutation.mutate()}
              disabled={pauseMutation.isPending}
            >
              <Pause className="h-3 w-3" />
              Pause
            </Button>
          )}
          {isPaused && (
            <>
              <Button
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => resumeMutation.mutate()}
                disabled={resumeMutation.isPending}
              >
                <Play className="h-3 w-3" />
                Resume
              </Button>
              {pageSlug && (
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" asChild>
                  <a href={`/info/${pageSlug}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3" />
                    Edit Steps
                  </a>
                </Button>
              )}
            </>
          )}
          {localStatus === "failed" && (
            <>
              <Button
                size="sm"
                className="h-7 text-xs gap-1.5"
                onClick={() => resumeMutation.mutate()}
                disabled={resumeMutation.isPending}
              >
                <RotateCcw className="h-3 w-3" />
                Retry
              </Button>
              {pageSlug && (
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5" asChild>
                  <a href={`/info/${pageSlug}`} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3 w-3" />
                    Edit & Retry
                  </a>
                </Button>
              )}
            </>
          )}
          {/* Library link always visible at bottom */}
          {pageSlug && (isTerminal || isExecuting) && (
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1.5 ml-auto" asChild>
              <a href={`/info/${pageSlug}`} target="_blank" rel="noopener noreferrer">
                <FileText className="h-3 w-3" />
                Library
              </a>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
