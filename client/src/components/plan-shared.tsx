/**
 * Shared plan types, helpers, and components used by PlanCard
 * and PlanStickyBar.
 */
import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  XCircle,
  Circle,
  Loader2,
  SkipForward,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  OctagonAlert,
  MailOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import { formatDiagnosticValue } from "@/lib/diagnostic-error";

// ─── Types ───────────────────────────────────────────────────────────

export type PlanStatus = "created" | "executing" | "paused" | "completed" | "completed_with_failures" | "failed" | "aborted";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "blocked" | "needs_review";

export interface PlanStepSessionLink {
  id: string;
  title?: string;
  status?: string;
  role?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  duration?: number;
  outcome?: string;
  error?: unknown;
  sessionId?: string;
  sessions?: PlanStepSessionLink[];
}

export interface PlanData {
  id: string;
  title: string;
  status: PlanStatus;
  steps: PlanStep[];
  pageId: string;
  pageSlug: string;
  blocking: boolean;
  originSessionId: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}:${secs.toString().padStart(2, "0")}` : `${mins}m`;
}

export function getStatusIcon(status: StepStatus, _isCurrentStep: boolean) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-success shrink-0" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-destructive shrink-0" />;
    case "skipped":
      return <SkipForward className="h-4 w-4 text-muted-foreground shrink-0" />;
    case "blocked":
      return <OctagonAlert className="h-4 w-4 text-destructive shrink-0" />;
    case "needs_review":
      return <MailOpen className="h-4 w-4 text-foreground shrink-0" />;
    case "running":
      return <ActiveStatusSpinner className="h-4 w-4" />;
    default:
      return <Circle className="h-4 w-4 text-muted-foreground/40 shrink-0" />;
  }
}

export function getStatusBadge(status: PlanStatus) {
  switch (status) {
    case "executing":
      return <Badge variant="default" className="bg-info/15 text-info border-info/20 text-xs">Running</Badge>;
    case "completed":
      return <Badge variant="default" className="bg-success/15 text-success border-success/20 text-xs">Complete</Badge>;
    case "completed_with_failures":
      return <Badge variant="default" className="bg-warning/15 text-warning border-warning/20 text-xs">Warnings</Badge>;
    case "failed":
      return <Badge variant="destructive" className="text-xs">Failed</Badge>;
    case "paused":
      return <Badge variant="default" className="bg-warning/15 text-warning border-warning/20 text-xs">Paused</Badge>;
    case "aborted":
      return <Badge variant="secondary" className="text-xs">Aborted</Badge>;
    default:
      return <Badge variant="secondary" className="text-xs">Created</Badge>;
  }
}

// ─── Step Row ────────────────────────────────────────────────────────

function sessionHref(sessionId: string): string {
  return `/session?c=${encodeURIComponent(sessionId)}`;
}

function getStepSessions(step: PlanStep): PlanStepSessionLink[] {
  const byId = new Map<string, PlanStepSessionLink>();
  for (const session of step.sessions ?? []) {
    if (session.id) byId.set(session.id, session);
  }
  if (step.sessionId && !byId.has(step.sessionId)) {
    byId.set(step.sessionId, { id: step.sessionId, role: "primary" });
  }
  return Array.from(byId.values());
}

function formatStepTitle(index: number, title: string): string {
  const stepPrefix = `Step ${index + 1}:`;
  return title.trim().startsWith(stepPrefix) ? title : `${stepPrefix} ${title}`;
}

export function StepRow({ step, index, isCurrentStep }: { step: PlanStep; index: number; isCurrentStep: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const sessions = getStepSessions(step);
  const stepErrorText = formatDiagnosticValue(step.error);
  const hasDetail = Boolean(step.outcome || stepErrorText || sessions.length > 0);

  return (
    <div className={cn(
      "flex items-start gap-2 py-1.5 px-2 rounded-sm transition-colors",
      isCurrentStep && "bg-info/5",
      (step.status === "failed" || step.status === "blocked") && "bg-destructive/5",
      step.status === "needs_review" && "bg-foreground/5 ring-1 ring-foreground/10",
    )}>
      {getStatusIcon(step.status, isCurrentStep)}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn(
            "text-sm",
            step.status === "completed" && "text-muted-foreground",
            (step.status === "failed" || step.status === "blocked") && "text-destructive",
            step.status === "needs_review" && "font-medium text-foreground",
            isCurrentStep && "font-medium",
          )}>
            {formatStepTitle(index, step.title)}
          </span>
          {step.duration != null && (
            <span className="text-xs text-muted-foreground tabular-nums">
              ({formatDuration(step.duration)})
            </span>
          )}
        </div>
        {expanded && step.outcome && (
          <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
            {step.outcome}
          </p>
        )}
        {expanded && stepErrorText && (
          <p className="text-xs text-destructive mt-1 whitespace-pre-wrap">
            {stepErrorText}
          </p>
        )}
        {expanded && sessions.length > 0 && (
          <div className="mt-1.5 space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Child sessions</p>
            <div className="flex flex-wrap gap-1.5">
              {sessions.map((session, sessionIndex) => (
                <a
                  key={session.id}
                  href={sessionHref(session.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title={session.id}
                >
                  <ExternalLink className="h-3 w-3" />
                  {session.title || session.role || `Session ${sessionIndex + 1}`}
                  {session.status && <span className="text-muted-foreground/70">({session.status})</span>}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
      {hasDetail && (
        <button
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />
          }
        </button>
      )}
    </div>
  );
}

// ─── Elapsed Timer ───────────────────────────────────────────────────

export function ElapsedTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(iv);
  }, [startTime]);
  return <span className="tabular-nums">{formatDuration(elapsed)}</span>;
}
