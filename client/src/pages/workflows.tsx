import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Archive,
  Camera,
  CheckCircle2,
  ChevronRight,
  Circle,
  ExternalLink,
  FileCode2,
  FileText,
  GitBranch,
  History,
  Loader2,
  LockKeyhole,
  Pause,
  Play,
  RefreshCcw,
  RotateCcw,
  Search,
  ShieldCheck,
  Waypoints,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type WorkflowRunStatus = "draft" | "active" | "blocked" | "needs_review" | "completed" | "failed" | "canceled" | "paused";
type WorkflowStageStatus = "pending" | "active" | "passed" | "failed" | "blocked" | "skipped" | "needs_review";
type WorkflowAutonomyMode = "autonomous" | "requires_user_review" | "requires_agent_review" | "manual_external";

interface WorkflowStageDefinition {
  key: string;
  title: string;
  position: number;
  autonomyMode: WorkflowAutonomyMode;
  entryCriteria?: string[];
  exitCriteria?: string[];
  evidenceRequirements?: string[];
  allowedTransitions?: Array<{ toStageKey: string | null; on: string; reason?: string }>;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  type: string;
  description: string;
  version: string;
  status: string;
  definition?: { stages?: WorkflowStageDefinition[]; terminalStatuses?: string[] };
  defaultAutonomyPolicy?: Record<string, unknown>;
  enabled: boolean;
  updatedAt: string;
}

interface WorkflowRun {
  id: string;
  templateId: string;
  title: string;
  objective: string;
  status: WorkflowRunStatus;
  currentStageKey: string | null;
  autonomyPolicy?: Record<string, unknown>;
  retryPolicy?: Record<string, unknown>;
  failurePacket?: unknown;
  parentSessionId?: string | null;
  linkedLibraryPageId?: string | null;
  linkedPlanId?: string | null;
  linkedProjectId?: number | null;
  linkedPlatformId?: number | null;
  linkedProductId?: number | null;
  linkedEnvironmentId?: number | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowStageAttempt {
  id: number;
  workflowRunId: string;
  stageKey: string;
  stageTitle: string;
  attemptNumber: number;
  status: WorkflowStageStatus;
  autonomyMode: WorkflowAutonomyMode;
  childSessionId?: string | null;
  linkedPlanId?: string | null;
  evidence?: unknown;
  outputSummary?: string | null;
  failureContext?: unknown;
  result?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  durationSeconds?: number | null;
  createdAt: string;
}

interface WorkflowStage {
  key: string;
  title: string;
  autonomyMode: WorkflowAutonomyMode;
  status: WorkflowStageStatus;
  attempts: WorkflowStageAttempt[];
  latestAttempt?: WorkflowStageAttempt;
}

interface WorkflowTransition {
  id: number;
  fromStageKey?: string | null;
  toStageKey?: string | null;
  fromAttemptId?: number | null;
  trigger: string;
  reason: string;
  evidence?: unknown;
  createdBySessionId?: string | null;
  createdAt: string;
}

interface WorkflowArtifact {
  id: number;
  stageAttemptId?: number | null;
  kind: string;
  title: string;
  refType: string;
  refId?: string | null;
  url?: string | null;
  summary: string;
  metadata?: unknown;
  createdBySessionId?: string | null;
  createdAt: string;
}

interface WorkflowGate {
  id: number;
  stageAttemptId?: number | null;
  gateType: string;
  status: "open" | "approved" | "rejected" | "canceled";
  prompt: string;
  decision?: string | null;
  decisionReason?: string | null;
  openedAt: string;
  resolvedAt?: string | null;
}

interface WorkflowSessionLink {
  id: number;
  stageAttemptId?: number | null;
  sessionId: string;
  role: string;
  spawnReason?: string | null;
  createdAt: string;
}

interface WorkflowRunDetail {
  run: WorkflowRun;
  template: WorkflowTemplate;
  stages: WorkflowStage[];
  transitions: WorkflowTransition[];
  artifacts: WorkflowArtifact[];
  gates: WorkflowGate[];
  sessions: WorkflowSessionLink[];
  linked: Record<string, string | number | null | undefined>;
}

type ValidationViewportStep = {
  key?: string;
  label?: string;
  status?: "pending" | "passed" | "failed";
  at?: string;
  url?: string | null;
  error?: string | null;
};

type ValidationViewportData = {
  artifact: WorkflowArtifact;
  capturedAt?: string;
  currentUrl?: string | null;
  finalUrl?: string | null;
  targetUrl?: string | null;
  routePath?: string | null;
  authVerified?: boolean;
  authSessionEstablished?: boolean;
  loginScreenDetected?: boolean;
  screenshot?: { path?: string; width?: number; height?: number; truncated?: boolean } | null;
  steps: ValidationViewportStep[];
  failedGates: string[];
  passed: boolean;
  error?: string | null;
};

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function latestValidationViewport(detail: WorkflowRunDetail): ValidationViewportData | null {
  const artifact = [...detail.artifacts].reverse().find((item) => item.kind === "acceptance" && item.metadata);
  if (!artifact) return null;
  const metadata = metadataRecord(artifact.metadata);
  const browserSession = metadataRecord(metadata.browserSession);
  const auth = metadataRecord(metadata.auth);
  const gates = metadataRecord(metadata.gates);
  const failurePacket = metadataRecord(metadata.failurePacket);
  const steps = Array.isArray(browserSession.steps) ? browserSession.steps as ValidationViewportStep[] : [];
  const failedGates = Array.isArray(failurePacket.failedGates)
    ? failurePacket.failedGates.map(String)
    : Object.entries(gates).filter(([, value]) => value === false).map(([key]) => key);
  return {
    artifact,
    capturedAt: typeof metadata.capturedAt === "string" ? metadata.capturedAt : artifact.createdAt,
    currentUrl: typeof browserSession.currentUrl === "string" ? browserSession.currentUrl : typeof browserSession.finalUrl === "string" ? browserSession.finalUrl : artifact.url || null,
    finalUrl: typeof browserSession.finalUrl === "string" ? browserSession.finalUrl : null,
    targetUrl: typeof metadata.targetUrl === "string" ? metadata.targetUrl : artifact.url || null,
    routePath: typeof metadata.routePath === "string" ? metadata.routePath : null,
    authVerified: auth.verified === true || browserSession.authVerified === true,
    authSessionEstablished: auth.established === true,
    loginScreenDetected: browserSession.loginScreenDetected === true,
    screenshot: metadataRecord(browserSession.screenshot).path ? metadataRecord(browserSession.screenshot) as ValidationViewportData["screenshot"] : metadataRecord(metadata.screenshot).path ? metadataRecord(metadata.screenshot) as ValidationViewportData["screenshot"] : null,
    steps,
    failedGates,
    passed: failedGates.length === 0,
    error: typeof browserSession.error === "string" ? browserSession.error : typeof metadata.browserError === "string" ? metadata.browserError : null,
  };
}

function screenshotSrc(path?: string | null) {
  if (!path) return "";
  return `/api/workflows/validation-screenshot?path=${encodeURIComponent(path)}`;
}

function ValidationViewport({ detail }: { detail: WorkflowRunDetail }) {
  const viewport = latestValidationViewport(detail);
  if (!viewport) return null;
  const shotPath = viewport.screenshot?.path || null;
  return (
    <Card className={cn("overflow-hidden border-border/70 bg-card/70", viewport.passed ? "border-success/20" : "border-destructive/25")}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 p-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2"><Camera className="h-4 w-4 text-muted-foreground" /><h2 className="text-sm font-medium">Validation viewport</h2><StatusBadge status={viewport.passed ? "passed" : "failed"} /></div>
          <p className="truncate text-xs text-muted-foreground">{viewport.currentUrl || viewport.targetUrl || "No browser URL recorded"}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className={cn("text-xs", viewport.authVerified ? "border-success/20 bg-success/15 text-success" : "border-destructive/20 bg-destructive/15 text-destructive")}>auth {viewport.authVerified ? "verified" : "unverified"}</Badge>
          {viewport.routePath && <Badge variant="secondary" className="text-xs">{viewport.routePath}</Badge>}
          <Badge variant="outline" className="text-xs">{fmtDate(viewport.capturedAt)}</Badge>
        </div>
      </div>
      <div className="grid gap-0 @4xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.8fr)]">
        <div className="min-h-[220px] bg-black/40">
          {shotPath ? <img src={screenshotSrc(shotPath)} alt="Latest validation screenshot" className="h-full max-h-[520px] w-full object-contain" /> : <div className="flex h-full min-h-[220px] items-center justify-center text-xs text-muted-foreground">No screenshot captured</div>}
        </div>
        <div className="space-y-3 border-t border-border/60 p-3 @4xl:border-l @4xl:border-t-0">
          <div className="space-y-2">
            {(viewport.steps.length ? viewport.steps : [{ label: viewport.artifact.summary, status: viewport.passed ? "passed" : "failed", error: viewport.error }]).map((step, index) => (
              <div key={`${step.key || index}-${step.at || index}`} className="flex items-start gap-2 text-xs">
                {step.status === "passed" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> : step.status === "failed" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <div className="min-w-0"><p className="text-foreground/90">{step.label || humanize(step.key)}</p>{step.error && <p className="mt-0.5 text-destructive/80">{step.error}</p>}</div>
              </div>
            ))}
          </div>
          {viewport.failedGates.length > 0 && <div className="rounded-md border border-destructive/20 bg-destructive/10 p-2"><p className="text-xs font-medium text-destructive">Failed gates</p><p className="mt-1 text-xs text-destructive/80">{viewport.failedGates.map(humanize).join(", ")}</p></div>}
          {viewport.artifact.url && <a href={viewport.artifact.url} className="inline-flex items-center gap-1 text-xs text-info hover:underline" target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />Open target route</a>}
        </div>
      </div>
    </Card>
  );
}

function fmtDate(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtDuration(seconds?: number | null) {
  if (seconds == null) return "";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m}:${String(s).padStart(2, "0")}` : `${m}m`;
}

function humanize(value?: string | null) {
  return (value || "none").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function StatusBadge({ status }: { status: WorkflowRunStatus | WorkflowStageStatus | WorkflowGate["status"] }) {
  const classes: Record<string, string> = {
    active: "bg-info/15 text-info border-info/20",
    completed: "bg-success/15 text-success border-success/20",
    passed: "bg-success/15 text-success border-success/20",
    approved: "bg-success/15 text-success border-success/20",
    needs_review: "bg-warning/15 text-warning border-warning/20",
    blocked: "bg-destructive/15 text-destructive border-destructive/20",
    failed: "bg-destructive/15 text-destructive border-destructive/20",
    rejected: "bg-destructive/15 text-destructive border-destructive/20",
    paused: "bg-warning/15 text-warning border-warning/20",
    open: "bg-warning/15 text-warning border-warning/20",
    canceled: "bg-muted text-muted-foreground border-border",
    skipped: "bg-muted text-muted-foreground border-border",
    draft: "bg-secondary text-secondary-foreground border-border",
    pending: "bg-secondary text-secondary-foreground border-border",
  };
  return <Badge variant="outline" className={cn("text-xs", classes[status] || classes.pending)}>{humanize(status)}</Badge>;
}

function StageIcon({ status }: { status: WorkflowStageStatus }) {
  if (status === "active") return <Loader2 className="h-4 w-4 animate-spin text-info" />;
  if (status === "passed") return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (status === "failed" || status === "blocked") return <XCircle className="h-4 w-4 text-destructive" />;
  if (status === "needs_review") return <LockKeyhole className="h-4 w-4 text-warning" />;
  return <Circle className="h-4 w-4 text-muted-foreground/40" />;
}

function AutonomyBadge({ mode }: { mode: string }) {
  const icon = mode === "autonomous" ? <RefreshCcw className="h-3 w-3" /> : mode.includes("review") ? <ShieldCheck className="h-3 w-3" /> : <LockKeyhole className="h-3 w-3" />;
  return <Badge variant="outline" className="gap-1 text-xs text-muted-foreground border-border">{icon}{humanize(mode)}</Badge>;
}

function jsonPreview(value: unknown) {
  if (!value || (typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0)) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function EmptyState({ icon: Icon, title, body }: { icon: React.ComponentType<{ className?: string }>; title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon className="mb-3 h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {body && <p className="mt-1 max-w-[340px] text-xs text-muted-foreground/70">{body}</p>}
    </div>
  );
}

function useWorkflowAction(runId: string, action: "start" | "pause" | "resume" | "cancel") {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const body = action === "pause" || action === "cancel" ? { reason: action } : undefined;
      const res = await apiRequest("POST", `/api/workflows/runs/${runId}/${action}`, body);
      return res.json() as Promise<WorkflowRunDetail>;
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(["/api/workflows/runs", runId], detail);
      queryClient.invalidateQueries({ queryKey: ["/api/workflows/runs"] });
      toast({ title: `Workflow ${action}ed`, description: detail.run.title });
    },
    onError: (err: Error) => toast({ title: `${humanize(action)} failed`, description: err.message, variant: "destructive" }),
  });
}

function RunActions({ detail }: { detail: WorkflowRunDetail }) {
  const start = useWorkflowAction(detail.run.id, "start");
  const pause = useWorkflowAction(detail.run.id, "pause");
  const resume = useWorkflowAction(detail.run.id, "resume");
  const cancel = useWorkflowAction(detail.run.id, "cancel");
  const currentStage = detail.stages.find((s) => s.key === detail.run.currentStageKey);
  const rerun = useMutation({
    mutationFn: async () => {
      if (!detail.run.currentStageKey) throw new Error("No current stage to run.");
      const res = await apiRequest("POST", `/api/workflows/runs/${detail.run.id}/stages/${detail.run.currentStageKey}/start-attempt`, {});
      return res.json() as Promise<WorkflowStageAttempt>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/workflows/runs", detail.run.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/workflows/runs"] });
    },
  });
  const busy = start.isPending || pause.isPending || resume.isPending || cancel.isPending || rerun.isPending;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {detail.run.status === "draft" || detail.run.status === "blocked" ? (
        <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => start.mutate()}><Play className="h-3.5 w-3.5" />Start</Button>
      ) : null}
      {detail.run.status === "paused" ? (
        <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => resume.mutate()}><Play className="h-3.5 w-3.5" />Resume</Button>
      ) : null}
      {detail.run.status === "active" || detail.run.status === "needs_review" ? (
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => pause.mutate()}><Pause className="h-3.5 w-3.5" />Pause</Button>
      ) : null}
      {detail.run.currentStageKey && !["completed", "failed", "canceled"].includes(detail.run.status) ? (
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => rerun.mutate()}><RotateCcw className="h-3.5 w-3.5" />Run {currentStage?.attempts.length ? "retry" : "attempt"}</Button>
      ) : null}
      {! ["completed", "failed", "canceled"].includes(detail.run.status) ? (
        <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground" disabled={busy} onClick={() => cancel.mutate()}><XCircle className="h-3.5 w-3.5" />Cancel</Button>
      ) : null}
    </div>
  );
}

function GateCard({ gate, runId }: { gate: WorkflowGate; runId: string }) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: async (decision: "approve" | "reject") => {
      const res = await apiRequest("POST", `/api/workflows/gates/${gate.id}/${decision}`, { decisionReason: reason || decision });
      return res.json() as Promise<WorkflowRunDetail>;
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(["/api/workflows/runs", runId], detail);
      queryClient.invalidateQueries({ queryKey: ["/api/workflows/runs"] });
      toast({ title: "Gate resolved", description: gate.prompt });
    },
    onError: (err: Error) => toast({ title: "Gate decision failed", description: err.message, variant: "destructive" }),
  });
  const open = gate.status === "open";
  return (
    <Card className={cn("overflow-hidden p-4 space-y-3", open && "border-warning/25 bg-warning/5")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2"><LockKeyhole className="h-4 w-4 text-warning" /><span className="text-sm font-medium">{humanize(gate.gateType)}</span><StatusBadge status={gate.status} /></div>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{gate.prompt}</p>
          <p className="text-xs text-muted-foreground/70">Opened {fmtDate(gate.openedAt)}{gate.stageAttemptId ? ` · attempt ${gate.stageAttemptId}` : ""}</p>
        </div>
      </div>
      {open ? (
        <div className="space-y-2">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Decision reason" className="min-h-16 text-sm" />
          <div className="flex gap-2">
            <Button size="sm" className="gap-1.5" disabled={decide.isPending} onClick={() => decide.mutate("approve")}><CheckCircle2 className="h-3.5 w-3.5" />Approve</Button>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={decide.isPending} onClick={() => decide.mutate("reject")}><XCircle className="h-3.5 w-3.5" />Reject</Button>
          </div>
        </div>
      ) : gate.decisionReason ? <p className="text-xs text-muted-foreground">Decision: {gate.decisionReason}</p> : null}
    </Card>
  );
}

function TemplateList({ templates }: { templates: WorkflowTemplate[] }) {
  if (!templates.length) return <EmptyState icon={FileCode2} title="No workflow templates" body="Templates define reusable operational lifecycles." />;
  return (
    <div className="grid gap-3 @3xl:grid-cols-2">
      {templates.map((template) => {
        const stages = template.definition?.stages || [];
        return (
          <Card key={template.id} className="overflow-hidden p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><FileCode2 className="h-4 w-4 text-muted-foreground" /><h3 className="truncate text-sm font-medium">{template.name}</h3></div>
                <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
              </div>
              <Badge variant="outline" className="text-xs">v{template.version}</Badge>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {stages.map((stage) => <Badge key={stage.key} variant="secondary" className="text-xs">{stage.title}</Badge>)}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function WorkflowRunTreeRow({ run }: { run: WorkflowRun }) {
  return (
    <Link
      href={`/workflows/${run.id}`}
      className="group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
    >
      <Waypoints className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-foreground">{run.title}</span>
      <span className="hidden min-w-0 max-w-40 truncate text-xs text-muted-foreground sm:block">
        {humanize(run.currentStageKey)}
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function WorkflowTreeSection({
  title,
  runs,
  emptyLabel,
  defaultOpen = true,
}: {
  title: string;
  runs: WorkflowRun[];
  emptyLabel: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section>
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/70 hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{title}</span>
        <span className="ml-auto font-normal tabular-nums">{runs.length}</span>
      </button>
      {open ? (
        runs.length ? (
          <div className="ml-3 border-l border-border pl-2">
            {runs.map((run) => <WorkflowRunTreeRow key={run.id} run={run} />)}
          </div>
        ) : (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyLabel}</div>
        )
      ) : null}
    </section>
  );
}

function WorkflowListPage() {
  const [tab, setTab] = useState("runs");
  const [search, setSearch] = useState("");
  usePageHeader({ title: "Workflows", tabs: [
    { value: "runs", label: "Runs", icon: <Waypoints className="h-3.5 w-3.5" /> },
    { value: "templates", label: "Templates", icon: <FileCode2 className="h-3.5 w-3.5" /> },
  ], activeTab: tab, onTabChange: setTab });

  const templates = useQuery<WorkflowTemplate[]>({ queryKey: ["/api/workflows/templates"] });
  const runs = useQuery<WorkflowRun[]>({ queryKey: ["/api/workflows/runs"], refetchInterval: (q) => (q.state.data || []).some((r) => ["active", "needs_review"].includes(r.status)) ? 8000 : false });
  const query = search.trim().toLowerCase();
  const runList = (runs.data || []).filter((run) => !query || [run.title, run.objective, run.currentStageKey, run.status].some((value) => value?.toLowerCase().includes(query)));
  const active = runList.filter((r) => ["draft", "active", "paused"].includes(r.status));
  const blocked = runList.filter((r) => ["blocked", "needs_review", "failed"].includes(r.status));
  const completed = runList.filter((r) => ["completed", "canceled"].includes(r.status));

  if (templates.isLoading || runs.isLoading) return <WorkflowSkeleton />;

  return (
    <div className="w-full min-w-0 p-4">
      {tab === "templates" ? <TemplateList templates={templates.data || []} /> : (
        <div className="w-full min-w-0 max-w-full overflow-hidden rounded-md bg-background p-2">
          <div className="relative mb-1 min-w-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search workflow runs"
              className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label="Search workflow runs"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="Clear workflow search"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          <WorkflowTreeSection title="Active" runs={active} emptyLabel={query ? "No active runs match." : "No active workflow runs."} />
          <WorkflowTreeSection title="Blocked / Review" runs={blocked} emptyLabel={query ? "No blocked runs match." : "No blocked runs."} />
          <WorkflowTreeSection title="Completed" runs={completed} emptyLabel={query ? "No completed runs match." : "No completed runs yet."} defaultOpen={!active.length && !blocked.length} />
        </div>
      )}
    </div>
  );
}

function WorkflowSkeleton() {
  return <div className="p-4 space-y-3">{[1,2,3].map((i) => <Card key={i} className="p-4 space-y-3"><Skeleton className="h-5 w-56" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-72" /></Card>)}</div>;
}

function StagesTimeline({ detail }: { detail: WorkflowRunDetail }) {
  return (
    <div className="space-y-3">
      {detail.stages.map((stage, index) => (
        <Card key={stage.key} className={cn("overflow-hidden p-4", detail.run.currentStageKey === stage.key && "border-info/25 bg-info/5")}>
          <div className="flex items-start gap-3">
            <div className="flex flex-col items-center gap-2"><StageIcon status={stage.status} />{index < detail.stages.length - 1 && <div className="h-10 w-px bg-border" />}</div>
            <div className="min-w-0 flex-1 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0"><h3 className="text-sm font-medium">{stage.title}</h3><p className="text-xs text-muted-foreground">{stage.key} · {stage.attempts.length} attempt{stage.attempts.length === 1 ? "" : "s"}</p></div>
                <div className="flex gap-2"><StatusBadge status={stage.status} /><AutonomyBadge mode={stage.autonomyMode} /></div>
              </div>
              {stage.attempts.length ? <AttemptsList attempts={stage.attempts} /> : <p className="text-xs text-muted-foreground">No attempts yet.</p>}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function AttemptsList({ attempts }: { attempts: WorkflowStageAttempt[] }) {
  return <div className="space-y-2">{attempts.map((attempt) => <div key={attempt.id} className="rounded-md border border-border/60 bg-background/40 p-3 space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><Badge variant="secondary" className="text-xs">Attempt {attempt.attemptNumber}</Badge><StatusBadge status={attempt.status} />{attempt.result && <span className="text-xs text-muted-foreground">Result: {humanize(attempt.result)}</span>}</div><span className="text-xs text-muted-foreground">{fmtDate(attempt.startedAt)} {attempt.durationSeconds != null ? `· ${fmtDuration(attempt.durationSeconds)}` : ""}</span></div>{attempt.outputSummary && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{attempt.outputSummary}</p>}{attempt.childSessionId && <a className="inline-flex items-center gap-1 text-xs text-info hover:underline" href={`/session?c=${encodeURIComponent(attempt.childSessionId)}`}><ExternalLink className="h-3 w-3" />Child session</a>}{jsonPreview(attempt.failureContext) && <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs text-muted-foreground">{jsonPreview(attempt.failureContext)}</pre>}</div>)}</div>;
}

function ArtifactList({ artifacts }: { artifacts: WorkflowArtifact[] }) {
  if (!artifacts.length) return <EmptyState icon={FileText} title="No artifacts attached" body="Evidence, PRs, screenshots, logs, and checkpoint pages will appear here." />;
  return <div className="grid gap-3 @3xl:grid-cols-2">{artifacts.map((artifact) => <Card key={artifact.id} className="overflow-hidden p-4 space-y-2"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><FileText className="h-4 w-4 text-muted-foreground" /><h3 className="truncate text-sm font-medium">{artifact.title}</h3></div><p className="mt-1 text-xs text-muted-foreground">{artifact.summary || "No summary."}</p></div><Badge variant="outline" className="text-xs">{humanize(artifact.kind)}</Badge></div><div className="flex flex-wrap gap-3 text-xs text-muted-foreground/70"><span>{artifact.refType}{artifact.refId ? `: ${artifact.refId}` : ""}</span><span>{fmtDate(artifact.createdAt)}</span>{artifact.stageAttemptId && <span>attempt {artifact.stageAttemptId}</span>}</div>{artifact.url && <a href={artifact.url} className="inline-flex items-center gap-1 text-xs text-info hover:underline" target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />Open artifact</a>}</Card>)}</div>;
}

function DetailPage() {
  const [, params] = useRoute("/workflows/:id");
  const [, navigate] = useLocation();
  const runId = params?.id || "";
  const detailQuery = useQuery<WorkflowRunDetail>({ queryKey: ["/api/workflows/runs", runId], enabled: Boolean(runId), refetchInterval: (q) => q.state.data && ["active", "needs_review"].includes(q.state.data.run.status) ? 5000 : false });
  const detail = detailQuery.data;
  usePageHeader({ title: detail?.run.title || "Workflow", customContent: <Button size="sm" variant="ghost" onClick={() => navigate("/workflows")}>All workflows</Button> });
  if (detailQuery.isLoading || !detail) return <WorkflowSkeleton />;
  const openGates = detail.gates.filter((g) => g.status === "open");

  return (
    <div className="w-full p-4 space-y-4">
      <Card className="overflow-hidden p-4 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2"><div className="flex flex-wrap items-center gap-2"><StatusBadge status={detail.run.status} /><Badge variant="outline" className="text-xs">{detail.template.name}</Badge>{openGates.length > 0 && <Badge variant="outline" className="bg-warning/15 text-warning border-warning/20 text-xs">{openGates.length} open gate{openGates.length === 1 ? "" : "s"}</Badge>}</div><h1 className="text-xl font-semibold">{detail.run.title}</h1><p className="max-w-4xl text-sm text-muted-foreground whitespace-pre-wrap">{detail.run.objective}</p><div className="flex flex-wrap gap-3 text-xs text-muted-foreground/70"><span>Current: {humanize(detail.run.currentStageKey)}</span><span>Updated {fmtDate(detail.run.updatedAt)}</span>{detail.run.linkedLibraryPageId && <Link className="text-info hover:underline" href={`/library/${detail.run.linkedLibraryPageId}`}>Checkpoint page</Link>}{detail.run.parentSessionId && <a className="text-info hover:underline" href={`/session?c=${encodeURIComponent(detail.run.parentSessionId)}`}>Parent session</a>}</div></div>
          <RunActions detail={detail} />
        </div>
      </Card>

      <ValidationViewport detail={detail} />

      <Tabs defaultValue={openGates.length ? "gates" : "stages"} className="space-y-4">
        <TabsList><TabsTrigger value="stages">Stages</TabsTrigger><TabsTrigger value="gates">Review Gates</TabsTrigger><TabsTrigger value="artifacts">Evidence</TabsTrigger><TabsTrigger value="sessions">Sessions</TabsTrigger><TabsTrigger value="transitions">Transitions</TabsTrigger></TabsList>
        <TabsContent value="stages"><StagesTimeline detail={detail} /></TabsContent>
        <TabsContent value="gates" className="space-y-3">{detail.gates.length ? detail.gates.map((gate) => <GateCard key={gate.id} gate={gate} runId={detail.run.id} />) : <EmptyState icon={ShieldCheck} title="No user-review gates" body="Hard gates stop autonomous advancement until resolved." />}</TabsContent>
        <TabsContent value="artifacts"><ArtifactList artifacts={detail.artifacts} /></TabsContent>
        <TabsContent value="sessions" className="space-y-3">{detail.sessions.length ? detail.sessions.map((session) => <Card key={session.id} className="p-4 flex items-center justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><GitBranch className="h-4 w-4 text-muted-foreground" /><span className="text-sm font-medium">{humanize(session.role)}</span></div><p className="text-xs text-muted-foreground truncate">{session.sessionId}{session.spawnReason ? ` · ${session.spawnReason}` : ""}</p></div><a href={`/session?c=${encodeURIComponent(session.sessionId)}`} className="inline-flex items-center gap-1 text-xs text-info hover:underline"><ExternalLink className="h-3 w-3" />Open</a></Card>) : <EmptyState icon={GitBranch} title="No linked sessions" />}</TabsContent>
        <TabsContent value="transitions" className="space-y-3">{detail.transitions.length ? detail.transitions.map((t) => <Card key={t.id} className="p-4"><div className="flex flex-wrap items-center gap-2 text-sm"><Badge variant="secondary" className="text-xs">{humanize(t.trigger)}</Badge><span>{humanize(t.fromStageKey || "start")}</span><span className="text-muted-foreground">→</span><span>{humanize(t.toStageKey || "terminal")}</span></div><p className="mt-1 text-xs text-muted-foreground">{fmtDate(t.createdAt)}{t.reason ? ` · ${t.reason}` : ""}{t.fromAttemptId ? ` · attempt ${t.fromAttemptId}` : ""}</p>{jsonPreview(t.evidence) && <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted/40 p-2 text-xs text-muted-foreground">{jsonPreview(t.evidence)}</pre>}</Card>) : <EmptyState icon={History} title="No transitions recorded" />}</TabsContent>
      </Tabs>
    </div>
  );
}

export default function WorkflowsPage() {
  const [isDetail] = useRoute("/workflows/:id");
  return isDetail ? <DetailPage /> : <WorkflowListPage />;
}
