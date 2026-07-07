import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Camera, CheckCircle2, ChevronDown, ChevronRight, Circle, ExternalLink, FileText, GitBranch, Loader2, LockKeyhole, MoreHorizontal, OctagonAlert, Pause, Play, Square, Waypoints, XCircle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { formatDiagnosticValue } from "@/lib/diagnostic-error";
import type { WorkflowStageStatus, WorkflowWidgetArtifact, WorkflowWidgetRun, WorkflowWidgetSession, WorkflowWidgetStage } from "@/components/workflow-shared";
import { WorkflowStatusBadge, humanizeWorkflowValue } from "@/components/workflow-shared";

interface WorkflowWidgetProps { workflow: WorkflowWidgetRun; variant?: "sticky" | "card"; className?: string; }
const EVIDENCE_KIND_PRIORITY = ["screenshot", "acceptance", "logs", "deployment", "pr", "commit", "library_page"];

function getBorderColor(status: WorkflowWidgetRun["run"]["status"]): string { if (status === "active") return "border-l-info/30"; if (status === "needs_review" || status === "paused") return "border-l-warning/30"; if (status === "blocked" || status === "failed") return "border-l-destructive/30"; if (status === "completed") return "border-l-success/20"; return "border-l-border"; }
function stageIcon(status: WorkflowStageStatus) { if (status === "active") return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-info" />; if (status === "passed") return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />; if (status === "failed") return <XCircle className="h-4 w-4 shrink-0 text-destructive" />; if (status === "blocked") return <OctagonAlert className="h-4 w-4 shrink-0 text-destructive" />; if (status === "needs_review") return <LockKeyhole className="h-4 w-4 shrink-0 text-warning" />; return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />; }
function formatDate(value?: string | null): string { if (!value) return ""; const date = new Date(value); if (Number.isNaN(date.getTime())) return ""; return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
function formatFailure(value: unknown): string | null { if (value == null) return null; if (typeof value === "string") return value; if (typeof value === "object") { const record = value as Record<string, unknown>; for (const key of ["summary", "message", "error", "reason", "description"]) { if (typeof record[key] === "string" && record[key]) return record[key] as string; } } return formatDiagnosticValue(value); }
function artifactHref(artifact: WorkflowWidgetArtifact): string | null { if (artifact.url) return artifact.url; if ((artifact.refType === "library_page" || artifact.kind === "library_page") && artifact.refId) return `/info#library?page=${encodeURIComponent(artifact.refId)}`; return null; }
function newestTime(artifact: WorkflowWidgetArtifact): number { const time = artifact.createdAt ? new Date(artifact.createdAt).getTime() : NaN; return Number.isFinite(time) ? time : 0; }
function selectLatestEvidence(artifacts: WorkflowWidgetArtifact[]): WorkflowWidgetArtifact | null { for (const kind of EVIDENCE_KIND_PRIORITY) { const matching = artifacts.filter((artifact) => artifact.kind === kind).sort((a, b) => newestTime(b) - newestTime(a)); if (matching[0]) return matching[0]; } return null; }
function sessionHref(sessionId: string): string { return `/session?c=${encodeURIComponent(sessionId)}`; }
function getStageSessions(stage: WorkflowWidgetStage, sessions: WorkflowWidgetSession[]): WorkflowWidgetSession[] { const byId = new Map<string, WorkflowWidgetSession>(); for (const session of sessions) { if (session.stageAttemptId && stage.attempts.some((attempt) => attempt.id === session.stageAttemptId)) byId.set(session.sessionId, session); } if (stage.latestAttempt?.childSessionId && !byId.has(stage.latestAttempt.childSessionId)) byId.set(stage.latestAttempt.childSessionId, { id: stage.latestAttempt.id, stageAttemptId: stage.latestAttempt.id, sessionId: stage.latestAttempt.childSessionId, role: "stage" }); return Array.from(byId.values()); }

function StageRow({ stage, current, sessions }: { stage: WorkflowWidgetStage; current: boolean; sessions: WorkflowWidgetSession[] }) {
  const [open, setOpen] = useState(false);
  const stageSessions = getStageSessions(stage, sessions);
  const failure = formatFailure(stage.latestAttempt?.failureContext);
  const hasDetail = !!stage.latestAttempt?.outputSummary || !!failure || stageSessions.length > 0;
  return <Collapsible open={open} onOpenChange={setOpen}><div className={cn("rounded-md px-2 py-1.5", current && "bg-info/5", stage.status === "needs_review" && "bg-warning/5", (stage.status === "blocked" || stage.status === "failed") && "bg-destructive/5")}><div className="flex items-start gap-2">{hasDetail ? <CollapsibleTrigger asChild><button className="mt-0.5 text-muted-foreground hover:text-foreground">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button></CollapsibleTrigger> : <span className="mt-0.5 h-3.5 w-3.5" />}{stageIcon(stage.status)}<div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><span className={cn("truncate text-xs", current ? "font-medium text-foreground" : "text-muted-foreground")}>{stage.title}</span></div>{current && stage.latestAttempt?.outputSummary && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{stage.latestAttempt.outputSummary}</p>}</div></div><CollapsibleContent><div className="space-y-1.5 pb-1 pl-16 pt-2 text-xs text-muted-foreground">{stage.latestAttempt?.outputSummary && <p>{stage.latestAttempt.outputSummary}</p>}{failure && <p className="text-destructive">{failure}</p>}{stageSessions.length > 0 && <div className="flex flex-wrap gap-2">{stageSessions.map((session) => <a key={session.sessionId} href={sessionHref(session.sessionId)} className="inline-flex items-center gap-1 text-info hover:underline"><GitBranch className="h-3 w-3" />{humanizeWorkflowValue(session.role || "Stage session")}</a>)}</div>}</div></CollapsibleContent></div></Collapsible>;
}

export function WorkflowWidget({ workflow, variant = "card", className }: WorkflowWidgetProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(variant === "card");

  const isActive = workflow.run.status === "active";
  
  const isPaused = workflow.run.status === "paused";
  const isTerminal = workflow.run.status === "completed" || workflow.run.status === "failed" || workflow.run.status === "canceled";
  
  const canPause = isActive;
  const canResume = isPaused;
  

  const runId = workflow.run.id;
  const invalidateWorkflow = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/workflows/runs/${runId}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/workflows/runs"] });
  };

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/start`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error || "Start failed"); }
      return res.json();
    },
    onSuccess: () => { toast({ title: "Workflow started" }); invalidateWorkflow(); },
    onError: (err: Error) => { toast({ title: "Start failed", description: err.message, variant: "destructive" }); },
  });

  const pauseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/pause`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error || "Pause failed"); }
      return res.json();
    },
    onSuccess: () => { toast({ title: "Workflow paused" }); invalidateWorkflow(); },
    onError: (err: Error) => { toast({ title: "Pause failed", description: err.message, variant: "destructive" }); },
  });

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/resume`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error || "Resume failed"); }
      return res.json();
    },
    onSuccess: () => { toast({ title: "Workflow resumed" }); invalidateWorkflow(); },
    onError: (err: Error) => { toast({ title: "Resume failed", description: err.message, variant: "destructive" }); },
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/cancel`);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b?.error || "Cancel failed"); }
      return res.json();
    },
    onSuccess: () => { toast({ title: "Workflow canceled" }); invalidateWorkflow(); },
    onError: (err: Error) => { toast({ title: "Cancel failed", description: err.message, variant: "destructive" }); },
  });

  const rawStages = workflow.stages ?? [];
  const isDraft = workflow.run.status === "draft";
  const canStart = isDraft;
  const canCancel = isActive || isPaused || isDraft;
  const showMenu = canStart || canPause || canResume || canCancel;
  const stages = isDraft
    ? rawStages.map((stage) => (stage.status === "active" ? { ...stage, status: "pending" as const } : stage))
    : rawStages;
  const passedCount = stages.filter((stage) => stage.status === "passed").length;
  const progressPercent = stages.length > 0 ? Math.round((passedCount / stages.length) * 100) : 0;
  const currentStage = isDraft ? null : stages.find((stage) => stage.key === workflow.run.currentStageKey) ?? stages.find((stage) => stage.status === "active") ?? null;
  const openGates = (workflow.gates ?? []).filter((gate) => gate.status === "open");
  const latestEvidence = useMemo(() => selectLatestEvidence(workflow.artifacts ?? []), [workflow.artifacts]);

  const blocker = workflow.run.status === "blocked" || workflow.run.status === "failed" ? formatFailure(currentStage?.latestAttempt?.failureContext) ?? formatFailure(workflow.run.failurePacket) : workflow.run.status === "needs_review" ? openGates[0]?.prompt ?? "Needs review" : null;
  const evidenceLink = latestEvidence ? artifactHref(latestEvidence) : null;
  return <Collapsible open={open} onOpenChange={setOpen}><div className={cn("border-l-4 border-border bg-card transition-all duration-200", variant === "sticky" ? "shrink-0 border-b px-4 py-2" : "overflow-hidden rounded-lg border border-l-4 px-4 py-3", getBorderColor(workflow.run.status), className)}><div className="flex items-start gap-2"><CollapsibleTrigger asChild><button className="min-w-0 flex-1 cursor-pointer select-none text-left"><div className="flex min-h-[28px] items-center gap-3">{open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}<Waypoints className={cn("h-4 w-4 shrink-0", workflow.run.status === "active" ? "text-info" : "text-muted-foreground")} /><span className="truncate text-sm font-medium">{workflow.run.title || workflow.run.id}</span><WorkflowStatusBadge status={workflow.run.status} />{workflow.template?.name && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{workflow.template.name}</span>}</div><div className="mt-2 space-y-1 pl-7"><Progress value={progressPercent} className="h-1.5" /></div></button></CollapsibleTrigger>{showMenu && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8 shrink-0"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{canStart && <DropdownMenuItem onClick={() => startMutation.mutate()} disabled={startMutation.isPending}><Play className="mr-2 h-4 w-4" />Start</DropdownMenuItem>}{canPause && <DropdownMenuItem onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}><Pause className="mr-2 h-4 w-4" />Pause</DropdownMenuItem>}{canResume && <DropdownMenuItem onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}><Play className="mr-2 h-4 w-4" />Resume</DropdownMenuItem>}{canCancel && <DropdownMenuItem onClick={() => cancelMutation.mutate()} disabled={cancelMutation.isPending} className="text-destructive focus:text-destructive"><Square className="mr-2 h-4 w-4" />Cancel</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>}</div><CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-200"><div className="space-y-3 pt-3 pl-7">{blocker && <div className="rounded-md border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning-foreground">{blocker}</div>}<div className="max-h-64 space-y-0.5 overflow-y-auto">{stages.map((stage) => <StageRow key={stage.key} stage={stage} current={stage.key === currentStage?.key} sessions={workflow.sessions ?? []} />)}</div>{latestEvidence && <div className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-background/40 px-3 py-2 text-xs">{latestEvidence.kind === "screenshot" ? <Camera className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}<div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><span className="truncate font-medium">{latestEvidence.title}</span><span className="shrink-0 text-muted-foreground">{humanizeWorkflowValue(latestEvidence.kind)}</span></div>{latestEvidence.summary && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{latestEvidence.summary}</p>}</div>{evidenceLink && <a href={evidenceLink} className="shrink-0 text-info hover:underline" target={evidenceLink.startsWith("http") ? "_blank" : undefined} rel={evidenceLink.startsWith("http") ? "noreferrer" : undefined}><ExternalLink className="h-3.5 w-3.5" /></a>}</div>}<div className="flex flex-wrap items-center gap-3 text-xs"><Link href={`/workflows/${workflow.run.id}`} className="inline-flex items-center gap-1 text-info hover:underline">Open workflow <ExternalLink className="h-3 w-3" /></Link></div></div></CollapsibleContent></div></Collapsible>;
}
