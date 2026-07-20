import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type WorkflowRunStatus = "draft" | "active" | "blocked" | "needs_review" | "completed" | "failed" | "canceled" | "paused";
export type WorkflowStageStatus = "pending" | "active" | "passed" | "failed" | "blocked" | "skipped" | "needs_review";
export type WorkflowGateStatus = "open" | "approved" | "rejected" | "canceled";

export interface WorkflowWidgetAttempt { id: number; attemptNumber: number; status: WorkflowStageStatus; result?: string | null; outputSummary?: string | null; failureContext?: unknown; childSessionId?: string | null; durationSeconds?: number | null; startedAt?: string | null; }
export interface WorkflowWidgetStage { key: string; title: string; autonomyMode?: string; status: WorkflowStageStatus; attempts: WorkflowWidgetAttempt[]; latestAttempt?: WorkflowWidgetAttempt; }
export interface WorkflowWidgetArtifact { id: number; stageAttemptId?: number | null; kind: string; title: string; refType: string; refId?: string | null; url?: string | null; summary?: string | null; createdAt?: string | null; }
export interface WorkflowWidgetGate { id: number; stageAttemptId?: number | null; status: WorkflowGateStatus; prompt: string; }
export interface WorkflowWidgetSession { id: number; stageAttemptId?: number | null; sessionId: string; role: string; spawnReason?: string | null; createdAt?: string | null; }
export interface WorkflowWidgetRun { run: { id: string; title: string; objective: string; status: WorkflowRunStatus; currentStageKey: string | null; linkedLibraryPageId?: string | null; failurePacket?: unknown; updatedAt?: string | null; }; template?: { id: string; name: string }; stages: WorkflowWidgetStage[]; artifacts?: WorkflowWidgetArtifact[]; gates?: WorkflowWidgetGate[]; sessions?: WorkflowWidgetSession[]; linked?: { libraryPageId?: string | null; planId?: string | null }; }

export const TERMINAL_WORKFLOW_STATUSES = new Set<WorkflowRunStatus>(["completed", "failed", "canceled"]);
export const ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowRunStatus>(["active", "needs_review", "blocked", "paused"]);

export function humanizeWorkflowValue(value?: string | null): string { return (value || "none").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()); }

export function WorkflowStatusBadge({ status }: { status: WorkflowRunStatus | WorkflowStageStatus | WorkflowGateStatus }) {
  const classes: Record<string, string> = { active: "bg-info/15 text-info border-info/20", completed: "bg-success/15 text-success border-success/20", passed: "bg-success/15 text-success border-success/20", approved: "bg-success/15 text-success border-success/20", needs_review: "bg-warning/15 text-warning border-warning/20", blocked: "bg-destructive/15 text-destructive border-destructive/20", failed: "bg-destructive/15 text-destructive border-destructive/20", rejected: "bg-destructive/15 text-destructive border-destructive/20", paused: "bg-warning/15 text-warning border-warning/20", open: "bg-warning/15 text-warning border-warning/20", canceled: "bg-muted text-muted-foreground border-border", skipped: "bg-muted text-muted-foreground border-border", draft: "bg-secondary text-secondary-foreground border-border", pending: "bg-secondary text-secondary-foreground border-border" };
  return <Badge variant="outline" className={cn("text-xs", classes[status] || classes.pending)}>{humanizeWorkflowValue(status)}</Badge>;
}
