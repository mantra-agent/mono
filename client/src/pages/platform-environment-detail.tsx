import { useState, useCallback, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Check, X, RefreshCw, Globe, AlertCircle, Rocket, KeyRound, Waypoints, ChevronRight, ExternalLink, History, Cable, Link2, User, FolderGit2, GitBranch, GitMerge, Zap, Code2, Server, Hash, Layers, Cpu, CheckCircle2, AlertTriangle, Circle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { CodeGraphTab } from "@/components/code-graph";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { markEnvironmentBuildSeen } from "@/lib/environment-build-seen";
import { detailedStatusLabel, familyClasses, relativeTime, statusFamily, type DevDeploymentSummary } from "@/components/build-status-panel";
import { DevPublishTab } from "@/components/dev-publish-tab";
import { MobileBuildCard } from "@/components/mobile-build-card";
import { SimpleTextFrame } from "@/components/home/simple-text-frame";
import type { StageLifecycleStatus } from "@shared/models/platform-environment-lifecycle";

// --- Types ---

interface ProviderConnection {
  id: number;
  provider: string;
  label: string;
  accountType: string;
  status: string;
}

interface EnvironmentBinding {
  provider: string;
  connection?: ProviderConnection | null;
  inferred?: boolean;
  owner?: string;
  repo?: string;
  branch?: string;
  /** @deprecated Deployment policy belongs to hosting/lifecycle provider truth. */
  autoDeploy?: boolean;
  codeIndexingEnabled?: boolean;
  projectId?: string;
  projectName?: string;
  providerEnvironmentId?: string;
  providerEnvironmentName?: string;
  serviceId?: string;
  serviceName?: string;
  publicUrl?: string;
  staticUrl?: string;
}

interface RuntimeVariable {
  id: number | null;
  key: string;
  category: string;
  required: boolean;
  source: string;
  configured: boolean;
  inferred?: boolean;
}

interface PlatformTreeEnvironment { id: number; name: string }
interface PlatformTreeProduct { id: number; environments: PlatformTreeEnvironment[] }
interface PlatformTree { id: number; products: PlatformTreeProduct[] }

type EnvironmentVersionDocument =
  | { available: false; path: "VERSION.md"; reason: "not_configured" | "not_generated" }
  | { available: true; path: "VERSION.md"; content: string; releaseCount: number; truncated: boolean; updatedAt: string };

interface EnvironmentDetails {
  platform: { id: number; name: string };
  product: { id: number; name: string };
  environment: { id: number; name: string; kind: string; status: string };
  source: EnvironmentBinding;
  hosting: EnvironmentBinding;
  runtimeVariables: RuntimeVariable[];
  deploymentState: { status: string; note?: string };
  promotion: { mode: string; sourceBranch: string; targetBranch: string | null };
}

type WorkflowRunStatus = "draft" | "active" | "blocked" | "needs_review" | "completed" | "failed" | "canceled" | "paused";

interface WorkflowRunSummary {
  id: string;
  title: string;
  objective: string;
  status: WorkflowRunStatus;
  currentStageKey: string | null;
  linkedLibraryPageId?: string | null;
  completedAt?: string | null;
  createdAt: string;
  lifecycleSnapshot?: unknown;
  updatedAt: string;
}


interface BuildLifecycleConfig {
  id: number;
  environmentId: number;
  workflowTemplateId: string;
  providerKind: string;
  deployPolicy: Record<string, unknown>;
  acceptanceTarget: Record<string, unknown>;
  authMode: Record<string, unknown>;
  retryPolicy: Record<string, unknown>;
  gatePolicy: Record<string, unknown>;
  evidenceConfig: Record<string, unknown>;
  docsConfig: Record<string, unknown>;
  enabled: boolean;
  disabledAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BuildLifecycleStatus {
  lifecycle: BuildLifecycleConfig | null;
  source: (EnvironmentBinding & { connection?: ProviderConnection | null }) | null;
  hosting: (EnvironmentBinding & { connection?: ProviderConnection | null }) | null;
  providers: {
    railway?: {
      available?: boolean;
      degraded?: boolean;
      reason?: string | null;
      deployment?: {
        id?: string;
        status?: string | null;
        commitSha?: string | null;
        commitMessage?: string | null;
        deployedAt?: string | null;
      } | null;
      publicUrl?: string | null;
      urlReachable?: boolean | null;
    };
    eas?: {
      available?: boolean;
      degraded?: boolean;
      reason?: string | null;
      latestBuild?: {
        id?: string;
        status?: string | null;
        platform?: string | null;
        profile?: string | null;
        createdAt?: string | null;
        completedAt?: string | null;
      } | null;
    };
    cloudflare_pages?: {
      available?: boolean;
      degraded?: boolean;
      reason?: string | null;
      deployment?: {
        id?: string;
        status?: string | null;
        commitSha?: string | null;
        commitMessage?: string | null;
        deployedAt?: string | null;
        branch?: string | null;
        url?: string | null;
        environment?: string | null;
      } | null;
      publicUrl?: string | null;
      urlReachable?: boolean | null;
      deploymentMode?: "automatic" | "manual" | "disabled" | "unknown";
      project?: { productionBranch?: string | null; source?: { type?: string | null; owner?: string | null; repository?: string | null } | null; build?: { command?: string | null; destinationDirectory?: string | null; rootDirectory?: string | null }; deployments?: { enabled?: boolean | null; productionEnabled?: boolean | null; previewSetting?: string | null; automaticProductionDeployments?: boolean } };
    };
  };
  workflows: { recent: WorkflowRunSummary[] };
  activity: { state: "building" | "idle"; workflowRunId: string | null; stageAttemptId: number | null };
  checkedAt: string;
}


type EnvironmentHealthState = "healthy" | "unhealthy" | "unknown";

interface EnvironmentHealth {
  state: EnvironmentHealthState;
  residual: string | null;
  signals: Array<{
    key: "deploy" | "reachability" | "bindings" | "issues" | "jobs";
    state: EnvironmentHealthState;
    residual: string | null;
    href: string | null;
  }>;
}

const UNAVAILABLE_ENVIRONMENT_HEALTH: EnvironmentHealth = {
  state: "unknown",
  residual: "Health unavailable",
  signals: ["deploy", "reachability", "bindings", "issues", "jobs"].map((key) => ({
    key: key as EnvironmentHealth["signals"][number]["key"],
    state: "unknown",
    residual: "Health unavailable",
    href: null,
  })),
};

interface DevStatusOk {
  configured: true;
  devUrl: string | null;
  projectId: string;
  environmentId: string;
  serviceId: string;
  deployment: DevDeploymentSummary | null;
  lifecycle: StageLifecycleStatus;
  statusError: string | null;
  fetchedAt: string;
}

interface DevStatusMissing {
  configured: false;
  hasToken: boolean;
  missing: {
    projectId: boolean;
    environmentId: boolean;
    serviceId: boolean;
    devUrl: boolean;
  };
  devUrl: string | null;
}

type DevStatus = DevStatusOk | DevStatusMissing;

function useDevStatus(platformEnvironmentId: number) {
  return useQuery<DevStatus>({
    queryKey: ["/api/railway/environments", platformEnvironmentId, "status"],
    queryFn: async () => {
      const res = await fetch(`/api/railway/environments/${platformEnvironmentId}/status`, { credentials: "include" });
      if (res.status === 503) return (await res.json()) as DevStatus;
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      return (await res.json()) as DevStatus;
    },
    refetchInterval: (query) => {
      const data = query.state.data as DevStatus | undefined;
      if (data?.configured && statusFamily(data.deployment?.status) === "deploying") return 5_000;
      return 30_000;
    },
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
}

function DevelopmentPipelineCard({ platformEnvironmentId }: { platformEnvironmentId: number }) {
  const { data: status, isLoading, error, refetch, isFetching } = useDevStatus(platformEnvironmentId);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false);
  const [enableConfirmOpen, setEnableConfirmOpen] = useState(false);
  const actionMutation = useMutation({
    mutationFn: async ({ action, confirmation }: { action: "restart" | "full-rebuild" | "enable-warm-stage" | "sync-latest"; confirmation?: "FULL_REBUILD" | "ENABLE_WARM_STAGE" }) => {
      const needsKey = action === "full-rebuild" || action === "enable-warm-stage" || action === "sync-latest";
      const res = await fetch(`/api/railway/environments/${platformEnvironmentId}/actions/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ...(confirmation ? { confirmation } : {}),
          ...(needsKey ? { idempotencyKey: `stage-${action}:${platformEnvironmentId}:${Date.now()}` } : {}),
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Stage action failed");
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/railway/environments", platformEnvironmentId, "status"] });
      toast({
        title: result.action === "enable_warm_stage"
          ? "Warm Stage enabling"
          : result.action === "full_rebuild"
            ? "Full Rebuild triggered"
            : result.action === "sync_latest"
              ? "Sync Latest queued"
              : "Stage restart triggered",
        description: result.action === "enable_warm_stage"
          ? "Stage will restart into the warm workspace. Watch Runtime flip to Warm Workspace."
          : result.action === "full_rebuild"
            ? "Railway is rebuilding the Stage environment."
            : result.action === "sync_latest"
              ? `Target ${typeof result.targetCommitSha === "string" ? result.targetCommitSha.slice(0, 7) : "main"} — Stage will apply source without a cold image rebuild when lockfile matches.`
              : "The Stage service is restarting.",
      });
      setRebuildConfirmOpen(false);
      setEnableConfirmOpen(false);
    },
    onError: (actionError: Error) => toast({ title: "Stage action failed", description: actionError.message, variant: "destructive" }),
  });

  if (isLoading && !status) {
    return (
      <EnvironmentSection label="Build" storageKey={`platform-environment:${platformEnvironmentId}:section:build`}>
        <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading build status…</div>
      </EnvironmentSection>
    );
  }

  if (!status) {
    return (
      <EnvironmentSection label="Build" storageKey={`platform-environment:${platformEnvironmentId}:section:build`}>
        <ProfileTreeRow label="Status unavailable" icon={<AlertCircle className="h-3.5 w-3.5 text-warning" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact" actionContent={(
          <Button variant="ghost" size="icon" className="h-6 min-h-6 w-6 min-w-6" onClick={() => refetch()} disabled={isFetching} aria-label="Retry build status">
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        )}>
          <span className="truncate text-warning">{(error as Error)?.message ?? "Unknown error"}</span>
        </ProfileTreeRow>
      </EnvironmentSection>
    );
  }

  if (!status.configured || !status.deployment) {
    return (
      <EnvironmentSection label="Build" storageKey={`platform-environment:${platformEnvironmentId}:section:build`}>
        <ProfileTreeRow label="Status" icon={<Rocket className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
          <span className="text-muted-foreground">Not configured</span>
        </ProfileTreeRow>
      </EnvironmentSection>
    );
  }

  return (
    <EnvironmentSection label="Build" storageKey={`platform-environment:${platformEnvironmentId}:section:build`}>
      <ProfileTreeRow label="Lifecycle" icon={status.lifecycle.state === "rebuilding" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-active" /> : <Rocket className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact" actionContent={(
        <Button variant="ghost" size="icon" className="h-6 min-h-6 w-6 min-w-6" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh Stage lifecycle">
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      )}>
        <span className={cn(
          status.lifecycle.state === "failed" && "text-destructive",
          status.lifecycle.state === "degraded" && "text-warning",
          ["syncing", "restarting", "rebuilding"].includes(status.lifecycle.state) && "text-active",
        )}>{humanize(status.lifecycle.state)}</span>
      </ProfileTreeRow>
      <ProfileTreeRow label="Runtime" icon={<Server className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
        <span>{humanize(status.lifecycle.capabilities.runtimeMode)}</span>
      </ProfileTreeRow>
      <ProfileTreeRow label="Actions" icon={<Waypoints className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
        <div className="flex flex-wrap items-center gap-1">
          {status.lifecycle.capabilities.actions.includes("enable_warm_stage") && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setEnableConfirmOpen(true)} disabled={actionMutation.isPending}>Enable Warm Stage</Button>}
          {status.lifecycle.capabilities.actions.includes("sync_latest") && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => actionMutation.mutate({ action: "sync-latest" })} disabled={actionMutation.isPending}>Sync Latest</Button>}
          {status.lifecycle.capabilities.actions.includes("restart_stage") && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => actionMutation.mutate({ action: "restart" })} disabled={actionMutation.isPending}>Restart</Button>}
          {status.lifecycle.capabilities.actions.includes("full_rebuild") && <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-warning" onClick={() => setRebuildConfirmOpen(true)} disabled={actionMutation.isPending}>Full Rebuild</Button>}
        </div>
      </ProfileTreeRow>
      <ProfileTreeRow label="Active commit" icon={<GitBranch className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
        <span className="font-mono">{shortSha(status.lifecycle.activeCommitSha) || "—"}</span>
      </ProfileTreeRow>
      <ProfileTreeRow label="Target commit" icon={<GitMerge className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact">
        <span className="font-mono">{shortSha(status.lifecycle.targetCommitSha) || "—"}</span>
      </ProfileTreeRow>
      <ProfileTreeRow label="Provider" icon={<Server className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact" defaultOpen={Boolean(status.lifecycle.reason)} expandedContent={status.lifecycle.reason ? <p className="border-l border-border/30 pl-3 text-sm text-muted-foreground">{status.lifecycle.reason}</p> : undefined}>
        <span>{status.lifecycle.state === "rebuilding" ? "Railway is building the next deployment" : status.lifecycle.providerStatus ? humanize(status.lifecycle.providerStatus) : "Unavailable"}</span>
      </ProfileTreeRow>
      <AlertDialog open={enableConfirmOpen} onOpenChange={setEnableConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Warm Stage?</AlertDialogTitle>
            <AlertDialogDescription>This flips Stage onto the warm workspace and restarts it. Live stays on the immutable production artifact. Continue only if you want Stage to stop doing a full production rebuild on every change.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => actionMutation.mutate({ action: "enable-warm-stage", confirmation: "ENABLE_WARM_STAGE" })} disabled={actionMutation.isPending}>{actionMutation.isPending ? "Enabling…" : "Enable Warm Stage"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={rebuildConfirmOpen} onOpenChange={setRebuildConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run a Full Rebuild?</AlertDialogTitle>
            <AlertDialogDescription>This invokes Railway's cold rebuild path for Stage. It may take several minutes and replaces the current deployment. Continue only if recovery is necessary.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => actionMutation.mutate({ action: "full-rebuild", confirmation: "FULL_REBUILD" })} disabled={actionMutation.isPending} className="bg-warning text-warning-foreground hover:bg-warning/90">{actionMutation.isPending ? "Rebuilding…" : "Confirm Full Rebuild"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </EnvironmentSection>
  );
}

function EnvironmentPipelineCard({ details, environmentId, sourceEnvironmentId }: { details: EnvironmentDetails; environmentId: number; sourceEnvironmentId: number | null }) {
  const platformName = details.platform.name.toLowerCase();
  const productName = details.product.name.toLowerCase();
  const environmentName = details.environment.name.toLowerCase();

  if (platformName !== "mantra") return null;
  if (productName === "web" && environmentName === "stage") return <DevelopmentPipelineCard platformEnvironmentId={environmentId} />;
  if (productName === "web" && environmentName === "live" && sourceEnvironmentId) {
    return <DevPublishTab sourcePlatformEnvironmentId={sourceEnvironmentId} targetPlatformEnvironmentId={environmentId} appearance="tree" />;
  }
  if (productName === "mobile" && environmentName === "dev") return <MobileBuildCard appearance="tree" />;
  return null;
}

// --- Inline field helpers (People profile editor pattern) ---

function FieldValue({ value, mono }: { value?: string | number | boolean | null; mono?: boolean }) {
  const display = value === true ? "Yes" : value === false ? "No" : (value ?? "") === "" ? "Not configured" : String(value);
  return <span className={cn("truncate text-xs text-foreground", mono && "font-mono")}>{display}</span>;
}

function FieldInput({
  value,
  placeholder,
  mono,
  onSave,
}: {
  value: string;
  placeholder?: string;
  mono?: boolean;
  onSave: (v: string) => void;
}) {
  return (
    <Input
      key={value}
      defaultValue={value}
      placeholder={placeholder}
      className={cn(mono && "font-mono")}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next && next !== value) {
          onSave(next);
        } else if (!next) {
          e.target.value = value;
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

// --- Inline New Connection Form ---

function InlineConnectionForm({
  provider,
  onCreated,
  onCancel,
}: {
  provider: string;
  onCreated: (conn: ProviderConnection) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [credential, setCredential] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { toast } = useToast();

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/provider-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          label: label.trim(),
          accountType: "token",
          credential: credential.trim(),
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to create connection");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Connection created" });
      onCreated(data);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // We can't test without creating first, so just validate non-empty
      if (!credential.trim()) {
        setTestResult({ ok: false, message: "Token is required" });
        return;
      }
      // Quick validation: check token format
      if (provider === "github" && !credential.trim().startsWith("gh")) {
        setTestResult({ ok: false, message: "GitHub tokens typically start with 'gh'" });
        return;
      }
      setTestResult({ ok: true, message: `${humanize(provider)} token format looks valid` });
    } finally {
      setTesting(false);
    }
  };

  const canSave = label.trim().length > 0 && credential.trim().length > 0;

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">New {provider} connection</div>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={`Connection label (e.g. '${provider === "github" ? "My GitHub token" : provider === "cloudflare" ? "My Cloudflare token" : "My Railway token"}')`}
        className="h-8 text-sm"
      />
      <Input
        value={credential}
        onChange={(e) => setCredential(e.target.value)}
        placeholder={provider === "github" ? "GitHub personal access token" : provider === "cloudflare" ? "Cloudflare API token" : "Railway API token"}
        type="password"
        className="h-8 font-mono text-xs"
      />
      {testResult && (
        <div className={cn("flex items-center gap-2 text-xs", testResult.ok ? "text-emerald-500" : "text-destructive")}>
          {testResult.ok ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          {testResult.message}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleTest} disabled={!credential.trim() || testing}>
          {testing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Test
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={() => createMutation.mutate()} disabled={!canSave || createMutation.isPending}>
          {createMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

// --- Update Credential Form ---

function UpdateCredentialForm({
  connectionId,
  connectionLabel,
  provider,
  onDone,
}: {
  connectionId: number;
  connectionLabel: string;
  provider: string;
  onDone: () => void;
}) {
  const [credential, setCredential] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/provider-connections/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: credential.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to update credential");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/provider-connections"] });
      toast({ title: "Token updated", description: `Credential for "${connectionLabel}" has been replaced.` });
      onDone();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      // Save first, then test
      const saveRes = await fetch(`/api/provider-connections/${connectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: credential.trim() }),
      });
      if (!saveRes.ok) {
        const err = await saveRes.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to save credential");
      }
      const testRes = await fetch(`/api/provider-connections/${connectionId}/test`, { method: "POST" });
      if (!testRes.ok) throw new Error("Test request failed");
      return testRes.json() as Promise<{ ok: boolean; message: string }>;
    },
    onSuccess: (result) => {
      if (result.ok) {
        queryClient.invalidateQueries({ queryKey: ["/api/provider-connections"] });
        toast({ title: "Token verified", description: result.message });
        onDone();
      } else {
        toast({ title: "Test failed", description: result.message, variant: "destructive" });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const busy = updateMutation.isPending || testMutation.isPending;

  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Update token — {connectionLabel}
      </div>
      <Input
        value={credential}
        onChange={(e) => setCredential(e.target.value)}
        placeholder={provider === "github" ? "New GitHub personal access token" : provider === "cloudflare" ? "New Cloudflare API token" : "New Railway API token"}
        type="password"
        className="h-8 font-mono text-xs"
        autoFocus
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => testMutation.mutate()}
          disabled={!credential.trim() || busy}
        >
          {testMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Save & Test
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onDone} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={() => updateMutation.mutate()} disabled={!credential.trim() || busy}>
          {updateMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

// --- Connection Select ---

function ConnectionSelect({
  provider,
  value,
  onChange,
  onNewConnection,
}: {
  provider: string;
  value: string;
  onChange: (connectionId: string) => void;
  onNewConnection: () => void;
}) {
  const { data: connections } = useQuery<ProviderConnection[]>({
    queryKey: ["/api/provider-connections"],
  });

  const filtered = (connections || []).filter((c) => c.provider === provider);

  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v === "__new__") {
          onNewConnection();
        } else {
          onChange(v);
        }
      }}
    >
      <SelectTrigger>
        <SelectValue placeholder="Select connection" />
      </SelectTrigger>
      <SelectContent>
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">No {provider} connections</div>
        )}
        {filtered.map((c) => (
          <SelectItem key={c.id} value={String(c.id)}>
            {c.label}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value="__new__">
          <span className="flex items-center gap-1.5">
            <Plus className="h-3.5 w-3.5" /> New connection
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

// --- Source Binding Card ---

function SourceBindingCard({
  binding,
  environmentId,
}: {
  binding: EnvironmentBinding;
  environmentId: number;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: allConnections } = useQuery<ProviderConnection[]>({ queryKey: ["/api/provider-connections"] });
  const [showNewConn, setShowNewConn] = useState(false);
  const [showUpdateToken, setShowUpdateToken] = useState(false);

  const connectionId = binding.connection?.id ? String(binding.connection.id) : "";

  const saveMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/platforms/environments/${environmentId}/source-binding`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to save source binding");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/platforms/environments", environmentId, "details"] });
      toast({ title: "Source binding saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleNewConnectionCreated = (conn: ProviderConnection) => {
    queryClient.invalidateQueries({ queryKey: ["/api/provider-connections"] });
    setShowNewConn(false);
    saveMutation.mutate({ connectionId: conn.id });
  };

  return (
    <div>
      {binding.inferred && (
        <div className="flex justify-end px-2 pb-1">
          <Badge variant="outline">inferred</Badge>
        </div>
      )}
      <ProfileTreeRow label="Provider" icon={<Cable className="h-3.5 w-3.5" />} hasValue showEmpty>
        <FieldValue value={humanize(binding.provider || "github")} />
      </ProfileTreeRow>
      <ProfileTreeRow
        label="Connection"
        icon={<Link2 className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        actionContent={connectionId ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
            onClick={() => { setShowUpdateToken((v) => !v); setShowNewConn(false); }}
            title="Update API token"
            aria-label="Update API token"
          >
            <KeyRound className="h-3 w-3" />
          </Button>
        ) : undefined}
      >
        <ConnectionSelect
          provider="github"
          value={connectionId}
          onChange={(id) => { setShowUpdateToken(false); saveMutation.mutate({ connectionId: Number(id) }); }}
          onNewConnection={() => { setShowNewConn(true); setShowUpdateToken(false); }}
        />
      </ProfileTreeRow>
      {showNewConn && (
        <div className="px-2 py-2">
          <InlineConnectionForm
            provider="github"
            onCreated={handleNewConnectionCreated}
            onCancel={() => setShowNewConn(false)}
          />
        </div>
      )}
      {showUpdateToken && connectionId && (
        <div className="px-2 py-2">
          <UpdateCredentialForm
            connectionId={Number(connectionId)}
            connectionLabel={allConnections?.find((c) => c.id === Number(connectionId))?.label || "Connection"}
            provider="github"
            onDone={() => setShowUpdateToken(false)}
          />
        </div>
      )}
      <ProfileTreeRow label="Owner" icon={<User className="h-3.5 w-3.5" />} hasValue showEmpty>
        <FieldInput value={binding.owner || ""} mono placeholder="e.g. mantra-agent" onSave={(v) => saveMutation.mutate({ owner: v })} />
      </ProfileTreeRow>
      <ProfileTreeRow label="Repository" icon={<FolderGit2 className="h-3.5 w-3.5" />} hasValue showEmpty>
        <FieldInput value={binding.repo || ""} mono placeholder="e.g. mono" onSave={(v) => saveMutation.mutate({ repo: v })} />
      </ProfileTreeRow>
      <ProfileTreeRow label="Branch" icon={<GitBranch className="h-3.5 w-3.5" />} hasValue showEmpty>
        <FieldInput value={binding.branch || ""} mono placeholder="e.g. main" onSave={(v) => saveMutation.mutate({ branch: v })} />
      </ProfileTreeRow>
      <ProfileTreeRow
        label="Code indexing"
        icon={<Code2 className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        expandedContent={<CodeGraphTab hideSearch />}
      >
        <Switch
          checked={Boolean(binding.codeIndexingEnabled)}
          disabled={saveMutation.isPending}
          onCheckedChange={(checked) => saveMutation.mutate({ codeIndexingEnabled: checked })}
        />
      </ProfileTreeRow>
    </div>
  );
}

// --- Hosting Binding Card ---

function HostingBindingCard({
  binding,
  environmentId,
}: {
  binding: EnvironmentBinding;
  environmentId: number;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: allConnections } = useQuery<ProviderConnection[]>({ queryKey: ["/api/provider-connections"] });
  const [showNewConn, setShowNewConn] = useState(false);
  const [showUpdateToken, setShowUpdateToken] = useState(false);
  const resolvedProvider = binding.provider || binding.connection?.provider || "railway";
  // Provider select is client-local: the server infers provider from the bound connection.
  const [hostingProvider, setHostingProvider] = useState(resolvedProvider);

  const connectionId = binding.connection?.id ? String(binding.connection.id) : "";
  const isCloudflare = hostingProvider === "cloudflare";

  const saveMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/platforms/environments/${environmentId}/hosting-binding`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to save hosting binding");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/platforms/environments", environmentId, "details"] });
      toast({ title: "Hosting binding saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleNewConnectionCreated = (conn: ProviderConnection) => {
    queryClient.invalidateQueries({ queryKey: ["/api/provider-connections"] });
    setShowNewConn(false);
    saveMutation.mutate({ connectionId: conn.id });
  };

  return (
    <div>
      {binding.inferred && (
        <div className="flex justify-end px-2 pb-1">
          <Badge variant="outline">inferred</Badge>
        </div>
      )}
      <ProfileTreeRow label="Provider" icon={<Server className="h-3.5 w-3.5" />} hasValue showEmpty>
        <Select
          value={hostingProvider}
          onValueChange={(v) => { setHostingProvider(v); setShowNewConn(false); setShowUpdateToken(false); }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="railway">Railway</SelectItem>
            <SelectItem value="cloudflare">Cloudflare</SelectItem>
          </SelectContent>
        </Select>
      </ProfileTreeRow>
      <ProfileTreeRow
        label="Connection"
        icon={<Link2 className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        actionContent={connectionId ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
            onClick={() => { setShowUpdateToken((v) => !v); setShowNewConn(false); }}
            title="Update API token"
            aria-label="Update API token"
          >
            <KeyRound className="h-3 w-3" />
          </Button>
        ) : undefined}
      >
        <ConnectionSelect
          provider={hostingProvider}
          value={connectionId}
          onChange={(id) => { setShowUpdateToken(false); saveMutation.mutate({ connectionId: Number(id) }); }}
          onNewConnection={() => { setShowNewConn(true); setShowUpdateToken(false); }}
        />
      </ProfileTreeRow>
      {showNewConn && (
        <div className="px-2 py-2">
          <InlineConnectionForm
            provider={hostingProvider}
            onCreated={handleNewConnectionCreated}
            onCancel={() => setShowNewConn(false)}
          />
        </div>
      )}
      {showUpdateToken && connectionId && (
        <div className="px-2 py-2">
          <UpdateCredentialForm
            connectionId={Number(connectionId)}
            connectionLabel={allConnections?.find((c) => c.id === Number(connectionId))?.label || "Connection"}
            provider={hostingProvider}
            onDone={() => setShowUpdateToken(false)}
          />
        </div>
      )}
      {isCloudflare ? (
        <>
          <ProfileTreeRow label="Account ID" icon={<Hash className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.projectId || ""} mono placeholder="Cloudflare account ID" onSave={(v) => saveMutation.mutate({ projectId: v })} />
          </ProfileTreeRow>
          <ProfileTreeRow label="Pages project" icon={<FolderGit2 className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.projectName || ""} placeholder="e.g. website" onSave={(v) => saveMutation.mutate({ projectName: v })} />
          </ProfileTreeRow>
          <ProfileTreeRow label="Environment" icon={<Layers className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.providerEnvironmentId || ""} placeholder="e.g. production" onSave={(v) => saveMutation.mutate({ providerEnvironmentId: v })} />
          </ProfileTreeRow>
        </>
      ) : (
        <>
          <ProfileTreeRow label="Project ID" icon={<Hash className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.projectId || ""} mono placeholder="Railway project UUID" onSave={(v) => saveMutation.mutate({ projectId: v })} />
          </ProfileTreeRow>
          <ProfileTreeRow label="Project name" icon={<FolderGit2 className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.projectName || ""} placeholder="e.g. mantra" onSave={(v) => saveMutation.mutate({ projectName: v })} />
          </ProfileTreeRow>
          <ProfileTreeRow label="Env ID" icon={<Layers className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.providerEnvironmentId || ""} mono placeholder="Railway environment UUID" onSave={(v) => saveMutation.mutate({ providerEnvironmentId: v })} />
          </ProfileTreeRow>
          <ProfileTreeRow label="Env name" icon={<Layers className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.providerEnvironmentName || ""} placeholder="e.g. production" onSave={(v) => saveMutation.mutate({ providerEnvironmentName: v })} />
          </ProfileTreeRow>
          <ProfileTreeRow label="Service ID" icon={<Cpu className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.serviceId || ""} mono placeholder="Railway service UUID" onSave={(v) => saveMutation.mutate({ serviceId: v })} />
          </ProfileTreeRow>
          <ProfileTreeRow label="Service name" icon={<Cpu className="h-3.5 w-3.5" />} hasValue showEmpty>
            <FieldInput value={binding.serviceName || ""} placeholder="e.g. mono-prod" onSave={(v) => saveMutation.mutate({ serviceName: v })} />
          </ProfileTreeRow>
        </>
      )}
      <ProfileTreeRow label="Public URL" icon={<Globe className="h-3.5 w-3.5" />} hasValue showEmpty>
        <FieldInput value={binding.publicUrl || ""} mono placeholder="https://..." onSave={(v) => saveMutation.mutate({ publicUrl: v })} />
      </ProfileTreeRow>
      <ProfileTreeRow label="Static URL" icon={<ExternalLink className="h-3.5 w-3.5" />} hasValue={Boolean(binding.staticUrl)} showEmpty>
        <FieldInput value={binding.staticUrl || ""} mono placeholder="https://..." onSave={(v) => saveMutation.mutate({ staticUrl: v })} />
      </ProfileTreeRow>
    </div>
  );
}


type CloudflareState = "deployed" | "building" | "not_triggered" | "build_failed" | "configuration_error" | "authorization_required" | "provider_error";
type CloudflareTruth = { outcome: string; diagnostic?: string; diagnosis?: { state: CloudflareState; diagnostic: string }; project?: { productionBranch?: string | null; build?: { command?: string | null; destinationDirectory?: string | null; rootDirectory?: string | null }; deployments?: { automaticProductionDeployments?: boolean } }; deployments?: Array<{ id: string; status: string; commitHash?: string | null; branch?: string | null; createdAt?: string | null }> };

function CloudflarePagesCard({ environmentId }: { environmentId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching, refetch } = useQuery<CloudflareTruth>({ queryKey: ["/api/platforms/environments", environmentId, "cloudflare-pages"], staleTime: 15_000, refetchInterval: (q) => q.state.data?.diagnosis?.state === "building" ? 5_000 : false });
  const latest = data?.deployments?.[0];
  const state: CloudflareState = data?.outcome === "project_truth" ? data.diagnosis?.state || "provider_error" : "provider_error";
  const action = useMutation({ mutationFn: async (body: Record<string, unknown>) => { const res = await fetch(`/api/platforms/environments/${environmentId}/cloudflare-pages/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const result = await res.json(); if (!res.ok || ["rejected", "unsupported", "provider_error", "authorization_required"].includes(result.outcome)) throw new Error(result.diagnostic || "Cloudflare Pages action failed"); return result; }, onSuccess: (result) => { toast({ title: humanize(result.outcome) }); queryClient.invalidateQueries({ queryKey: ["/api/platforms/environments", environmentId, "cloudflare-pages"] }); queryClient.invalidateQueries({ queryKey: ["/api/platforms/environments", environmentId, "build-status"] }); }, onError: (error: Error) => toast({ title: "Cloudflare action failed", description: error.message, variant: "destructive" }) });
  const repair = () => { const project = data?.project; action.mutate({ action: "repair", repair: { productionBranch: project?.productionBranch || "main", buildCommand: project?.build?.command || "npm run build", destinationDirectory: project?.build?.destinationDirectory || "dist", rootDirectory: project?.build?.rootDirectory || "", deploymentsEnabled: true, productionDeploymentsEnabled: true } }); };
  const stateIcon = state === "deployed" ? <Check className="h-3.5 w-3.5 text-success" /> : state === "building" ? <Loader2 className="h-3.5 w-3.5 animate-spin text-active" /> : ["build_failed", "configuration_error", "authorization_required", "provider_error"].includes(state) ? <AlertCircle className="h-3.5 w-3.5 text-error" /> : <Globe className="h-3.5 w-3.5" />;
  return (
    <EnvironmentSection label="Build" storageKey={`platform-environment:${environmentId}:section:build`}>
      {isLoading ? <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading Cloudflare status…</div> : (
        <div>
          <ProfileTreeRow label="Status" icon={stateIcon} hasValue showEmpty mobileLayout="inline" valueLayout="compact" actionContent={<Button variant="ghost" size="icon" className="h-6 min-h-6 w-6 min-w-6" onClick={() => refetch()} disabled={isFetching} aria-label="Diagnose Cloudflare Pages"><RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /></Button>}><span>{humanize(state)}</span></ProfileTreeRow>
          <ProfileTreeRow label="Commit" icon={<GitBranch className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact"><span className="font-mono">{shortSha(latest?.commitHash) || "—"}</span></ProfileTreeRow>
          <ProfileTreeRow label="Production branch" icon={<GitBranch className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact"><span className="font-mono">{data?.project?.productionBranch || "Not configured"}</span></ProfileTreeRow>
          <ProfileTreeRow label="Build" icon={<Rocket className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact" defaultOpen={state === "building" || state === "build_failed"} expandedContent={<div className="space-y-2 border-l border-border/30 pl-3"><p className="text-sm text-muted-foreground">{data?.diagnosis?.diagnostic || data?.diagnostic || "Provider status unavailable."}</p><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => action.mutate({ action: "deploy" })} disabled={action.isPending || state === "building"}>Deploy</Button>{state === "build_failed" && latest ? <Button size="sm" variant="outline" onClick={() => action.mutate({ action: "retry", deploymentId: latest.id })} disabled={action.isPending}>Retry</Button> : null}{state === "building" && latest ? <Button size="sm" variant="destructive" onClick={() => action.mutate({ action: "cancel", deploymentId: latest.id })} disabled={action.isPending}>Cancel</Button> : null}{["configuration_error", "not_triggered"].includes(state) ? <Button size="sm" variant="outline" onClick={repair} disabled={action.isPending}>Safe repair</Button> : null}</div></div>}><span className="truncate font-mono">{data?.project?.build?.command || "No command"} → {data?.project?.build?.destinationDirectory || "No output"}</span></ProfileTreeRow>
          <ProfileTreeRow label="Last trigger" icon={<History className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" valueLayout="compact"><span>{relativeTime(latest?.createdAt)}</span></ProfileTreeRow>
        </div>
      )}
    </EnvironmentSection>
  );
}

function humanize(value?: string | null) {
  return (value || "none").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function shortSha(value?: string | null) {
  return value ? value.slice(0, 7) : "—";
}

// --- Collapsible Environment Section ---
// Styled like the Session Menu group headers (PINNED, ACTIVE, etc.)

function EnvironmentSection({
  label,
  defaultOpen = true,
  storageKey,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  storageKey?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    if (!storageKey || typeof window === "undefined") return defaultOpen;
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "true") return true;
    if (stored === "false") return false;
    return defaultOpen;
  });
  const [hasOpened, setHasOpened] = useState(open);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setHasOpened(true);
    if (storageKey && typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, String(nextOpen));
    }
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className="[content-visibility:auto] [contain-intrinsic-size:auto_240px]"
    >
      <CollapsibleTrigger className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md">
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-1 pb-2">
          {hasOpened ? children : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function VersionDocumentSection({ environmentId }: { environmentId: number }) {
  const { data } = useQuery<EnvironmentVersionDocument>({
    queryKey: ["/api/platforms/environments", environmentId, "version-document"],
    enabled: Number.isFinite(environmentId),
    staleTime: 30_000,
  });

  if (!data?.available) return null;

  return (
    <EnvironmentSection label="Version" storageKey={`platform-environment:${environmentId}:section:version`}>
      <SimpleTextFrame content={data.content} />
    </EnvironmentSection>
  );
}

const HEALTH_LABELS: Record<EnvironmentHealth["signals"][number]["key"], string> = {
  deploy: "Deploy",
  reachability: "Reachability",
  bindings: "Bindings",
  issues: "Issues",
  jobs: "Jobs",
};

function healthIcon(state: EnvironmentHealthState) {
  if (state === "healthy") return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  if (state === "unhealthy") return <AlertTriangle className="h-3.5 w-3.5 text-error" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
}

function EnvironmentHealthSection({ environmentId, health }: { environmentId: number; health: EnvironmentHealth }) {
  const [, setLocation] = useLocation();
  const valueClass = health.state === "healthy" ? "text-success" : health.state === "unhealthy" ? "text-error" : "text-muted-foreground";
  return (
    <EnvironmentSection label="Health" defaultOpen storageKey={`platform-environment:${environmentId}:section:health`}>
      <ProfileTreeRow label={health.state === "healthy" ? "Healthy" : health.residual || "Health unknown"} icon={healthIcon(health.state)} hasValue showEmpty defaultOpen={health.state !== "healthy"} expandedContent={(
        <div className="border-l border-border/30 pl-3">
          {health.signals.map((item) => (
            <ProfileTreeRow
              key={item.key}
              label={HEALTH_LABELS[item.key]}
              icon={healthIcon(item.state)}
              hasValue
              showEmpty
              defaultOpen={item.state !== "healthy"}
              actionContent={item.href ? <Button variant="ghost" size="sm" onClick={() => item.href?.startsWith("#") ? document.getElementById(item.href.slice(1))?.scrollIntoView({ behavior: "smooth" }) : setLocation(item.href)}>Open</Button> : undefined}
              expandedContent={item.residual ? <p className="border-l border-border/30 pl-3 text-sm text-muted-foreground">{item.residual}</p> : undefined}
            >
              <span className={item.state === "healthy" ? "text-success" : item.state === "unhealthy" ? "text-error" : "text-muted-foreground"}>
                {item.state === "healthy" ? "Healthy" : item.residual}
              </span>
            </ProfileTreeRow>
          ))}
        </div>
      )}>
        <span className={valueClass}>{health.state === "healthy" ? "Healthy" : health.residual}</span>
      </ProfileTreeRow>
    </EnvironmentSection>
  );
}

function EnvironmentDetailsConfigureCard({ details, environmentId }: { details: EnvironmentDetails; environmentId: number }) {
  return (
    <div className="space-y-1">
      <VersionDocumentSection environmentId={environmentId} />
      <div id="source"><EnvironmentSection label="Source" defaultOpen={false} storageKey={`platform-environment:${environmentId}:section:source`}>
        <SourceBindingCard binding={details.source} environmentId={environmentId} />
      </EnvironmentSection></div>
      <div id="hosting"><EnvironmentSection label="Hosting" defaultOpen={false} storageKey={`platform-environment:${environmentId}:section:hosting`}>
        <HostingBindingCard binding={details.hosting} environmentId={environmentId} />
      </EnvironmentSection></div>
    </div>
  );
}

// --- Page ---

export default function PlatformEnvironmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const environmentId = Number(id);

  const { data, isLoading } = useQuery<EnvironmentDetails>({
    queryKey: ["/api/platforms/environments", environmentId, "details"],
    enabled: Number.isFinite(environmentId),
  });

  const { data: buildStatus } = useQuery<BuildLifecycleStatus>({
    queryKey: ["/api/platforms/environments", environmentId, "build-status"],
    enabled: Number.isFinite(environmentId),
    refetchInterval: (query) => query.state.data?.activity.state === "building" ? 8000 : false,
    staleTime: 30_000,
  });

  const { data: health, isError: healthUnavailable } = useQuery<EnvironmentHealth>({
    queryKey: ["/api/platforms/environments", environmentId, "health"],
    enabled: Number.isFinite(environmentId),
    staleTime: 30_000,
  });

  useEffect(() => {
    markEnvironmentBuildSeen(environmentId, buildStatus);
  }, [environmentId, buildStatus]);

  const { data: platformTree = [] } = useQuery<PlatformTree[]>({ queryKey: ["/api/platforms"] });
  const sourceEnvironmentId = data
    ? platformTree
        .flatMap((platform) => platform.products ?? [])
        .find((product) => product.id === data.product.id)
        ?.environments?.find((environment) => environment.name.trim().toLowerCase() === "stage")?.id ?? null
    : null;

  usePageHeader({
    title: data ? `Platforms / ${data.product.name} / ${data.environment.name}` : "Environment",
    customContent: data ? (
      <div className="flex min-w-0 items-center gap-1 text-sm font-medium text-foreground">
        <button type="button" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground" onClick={() => setLocation("/platforms")}>Platforms</button>
        <span className="shrink-0 text-muted-foreground/60">/</span>
        <span className="truncate">{data.product.name} / {data.environment.name}</span>
      </div>
    ) : undefined,
  });

  if (!Number.isFinite(environmentId)) {
    setLocation("/platforms");
    return null;
  }

  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-9 w-48" />
        <div className="grid gap-4">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-4">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/platforms")}>Back to Platforms</Button>
        <p className="mt-4 text-sm text-muted-foreground">Environment not found.</p>
      </div>
    );
  }


  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-4">
        <EnvironmentHealthSection
          environmentId={environmentId}
          health={healthUnavailable ? UNAVAILABLE_ENVIRONMENT_HEALTH : health ?? UNAVAILABLE_ENVIRONMENT_HEALTH}
        />
        <div id="build"><EnvironmentPipelineCard details={data} environmentId={environmentId} sourceEnvironmentId={sourceEnvironmentId} /></div>
        {data.hosting.provider === "cloudflare" ? <CloudflarePagesCard environmentId={environmentId} /> : null}
        <EnvironmentDetailsConfigureCard details={data} environmentId={environmentId} />
      </div>
    </div>
  );
}
