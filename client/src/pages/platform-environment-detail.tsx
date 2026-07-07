import { useState, useCallback } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, CircleDashed, Pencil, Plus, Loader2, Check, X, RefreshCw, Globe, AlertCircle, Rocket, KeyRound, Waypoints, Settings2, ExternalLink, Play, History, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
import { detailedStatusLabel, familyClasses, relativeTime, statusFamily } from "@/components/build-status-panel";

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


interface BuildLifecycleConfigDraft {
  workflowTemplateId: string;
  providerKind: string;
  deployMode: string;
  sourceBranch: string;
  targetBranch: string;
  requireApproval: boolean;
  acceptanceUrl: string;
  routePath: string;
  healthCheckPath: string;
  screenshotRoutePath: string;
  authMode: string;
  maxAttempts: string;
  backoffSeconds: string;
  requireHumanApproval: boolean;
  requireScreenshot: boolean;
  requireLogs: boolean;
  requireProviderStatus: boolean;
  updateWorkflowPage: boolean;
  artifactPageId: string;
  enabled: boolean;
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
    };
  };
  workflows: { recent: WorkflowRunSummary[] };
  checkedAt: string;
}

// --- Read-only helpers ---

function ValueRow({ label, value, mono }: { label: string; value?: string | number | boolean | null; mono?: boolean }) {
  const display = value === true ? "yes" : value === false ? "no" : value || "Not configured";
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/40 py-2 last:border-0">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("min-w-0 truncate text-sm text-foreground", mono && "font-mono text-xs")}>{display}</div>
    </div>
  );
}

function EditableRow({
  label,
  value,
  onChange,
  mono,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/40 py-2 last:border-0 items-center">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || label}
        className={cn("h-8 text-sm", mono && "font-mono text-xs")}
      />
    </div>
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
  onUpdateCredential,
}: {
  provider: string;
  value: string;
  onChange: (connectionId: string) => void;
  onNewConnection: () => void;
  onUpdateCredential?: () => void;
}) {
  const { data: connections } = useQuery<ProviderConnection[]>({
    queryKey: ["/api/provider-connections"],
  });

  const filtered = (connections || []).filter((c) => c.provider === provider);

  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/40 py-2 last:border-0 items-center">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connection</div>
      <div className="flex items-center gap-2">
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
          <SelectTrigger className="h-8 flex-1 text-sm">
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
        {value && onUpdateCredential && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={onUpdateCredential}
            title="Update API token"
          >
            <KeyRound className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

// --- Source Binding Card ---

interface SourceDraft {
  connectionId: string;
  owner: string;
  repo: string;
  branch: string;
  codeIndexingEnabled: boolean;
}

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
  const [editing, setEditing] = useState(false);
  const [showNewConn, setShowNewConn] = useState(false);
  const [showUpdateToken, setShowUpdateToken] = useState(false);
  const [draft, setDraft] = useState<SourceDraft>({
    connectionId: binding.connection?.id ? String(binding.connection.id) : "",
    owner: binding.owner || "",
    repo: binding.repo || "",
    branch: binding.branch || "",
    codeIndexingEnabled: Boolean(binding.codeIndexingEnabled),
  });

  const resetDraft = useCallback(() => {
    setDraft({
      connectionId: binding.connection?.id ? String(binding.connection.id) : "",
      owner: binding.owner || "",
      repo: binding.repo || "",
      branch: binding.branch || "",
      codeIndexingEnabled: Boolean(binding.codeIndexingEnabled),
    });
    setShowNewConn(false);
    setShowUpdateToken(false);
  }, [binding]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (draft.connectionId) body.connectionId = Number(draft.connectionId);
      if (draft.owner) body.owner = draft.owner;
      if (draft.repo) body.repo = draft.repo;
      if (draft.branch) body.branch = draft.branch;
      body.codeIndexingEnabled = draft.codeIndexingEnabled;

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
      setEditing(false);
      setShowNewConn(false);
      toast({ title: "Source binding saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleCancel = () => {
    resetDraft();
    setEditing(false);
  };

  const handleNewConnectionCreated = (conn: ProviderConnection) => {
    queryClient.invalidateQueries({ queryKey: ["/api/provider-connections"] });
    setDraft((d) => ({ ...d, connectionId: String(conn.id) }));
    setShowNewConn(false);
  };

  if (!editing) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Source Binding</CardTitle>
              <CardDescription>What code this environment runs.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {binding.inferred && <Badge variant="outline">inferred</Badge>}
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => { resetDraft(); setEditing(true); }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ValueRow label="Provider" value={binding.provider} />
          <ValueRow label="Connection" value={binding.connection?.label || "No connection selected"} />
          <ValueRow label="Repository" value={`${binding.owner || ""}/${binding.repo || ""}`} mono />
          <ValueRow label="Branch" value={binding.branch} mono />
          <ValueRow label="Auto deploy" value={binding.autoDeploy} />
          <ValueRow label="Code indexing" value={binding.codeIndexingEnabled ? "Enabled" : "Disabled"} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Source Binding</CardTitle>
            <CardDescription>What code this environment runs.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-0">
        <ValueRow label="Provider" value={binding.provider} />
        <ConnectionSelect
          provider="github"
          value={draft.connectionId}
          onChange={(id) => { setDraft((d) => ({ ...d, connectionId: id })); setShowUpdateToken(false); }}
          onNewConnection={() => { setShowNewConn(true); setShowUpdateToken(false); }}
          onUpdateCredential={() => { setShowUpdateToken(true); setShowNewConn(false); }}
        />
        {showNewConn && (
          <div className="py-2">
            <InlineConnectionForm
              provider="github"
              onCreated={handleNewConnectionCreated}
              onCancel={() => setShowNewConn(false)}
            />
          </div>
        )}
        {showUpdateToken && draft.connectionId && (
          <div className="py-2">
            <UpdateCredentialForm
              connectionId={Number(draft.connectionId)}
              connectionLabel={allConnections?.find((c) => c.id === Number(draft.connectionId))?.label || "Connection"}
              provider="github"
              onDone={() => setShowUpdateToken(false)}
            />
          </div>
        )}
        <EditableRow label="Owner" value={draft.owner} onChange={(v) => setDraft((d) => ({ ...d, owner: v }))} mono placeholder="e.g. bridgeops2030" />
        <EditableRow label="Repository" value={draft.repo} onChange={(v) => setDraft((d) => ({ ...d, repo: v }))} mono placeholder="e.g. xyz" />
        <EditableRow label="Branch" value={draft.branch} onChange={(v) => setDraft((d) => ({ ...d, branch: v }))} mono placeholder="e.g. main" />
        <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/40 py-3 items-start">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Code indexing</div>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm text-foreground">Enable GitNexus for this environment</div>
              <p className="text-xs text-muted-foreground">Turn this on only for the canonical repo/branch you want indexed. Duplicate live/main environments and small repos can stay off.</p>
            </div>
            <Switch
              checked={draft.codeIndexingEnabled}
              onCheckedChange={(checked) => setDraft((d) => ({ ...d, codeIndexingEnabled: checked }))}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 pt-3">
          <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Hosting Binding Card ---

interface HostingDraft {
  hostingProvider: string;
  connectionId: string;
  projectId: string;
  projectName: string;
  providerEnvironmentId: string;
  providerEnvironmentName: string;
  serviceId: string;
  serviceName: string;
  publicUrl: string;
  staticUrl: string;
}

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
  const [editing, setEditing] = useState(false);
  const [showNewConn, setShowNewConn] = useState(false);
  const [showUpdateToken, setShowUpdateToken] = useState(false);
  const resolvedProvider = binding.provider || binding.connection?.provider || "railway";
  const [draft, setDraft] = useState<HostingDraft>({
    hostingProvider: resolvedProvider,
    connectionId: binding.connection?.id ? String(binding.connection.id) : "",
    projectId: binding.projectId || "",
    projectName: binding.projectName || "",
    providerEnvironmentId: binding.providerEnvironmentId || "",
    providerEnvironmentName: binding.providerEnvironmentName || "",
    serviceId: binding.serviceId || "",
    serviceName: binding.serviceName || "",
    publicUrl: binding.publicUrl || "",
    staticUrl: binding.staticUrl || "",
  });

  const resetDraft = useCallback(() => {
    setDraft({
      hostingProvider: binding.provider || binding.connection?.provider || "railway",
      connectionId: binding.connection?.id ? String(binding.connection.id) : "",
      projectId: binding.projectId || "",
      projectName: binding.projectName || "",
      providerEnvironmentId: binding.providerEnvironmentId || "",
      providerEnvironmentName: binding.providerEnvironmentName || "",
      serviceId: binding.serviceId || "",
      serviceName: binding.serviceName || "",
      publicUrl: binding.publicUrl || "",
      staticUrl: binding.staticUrl || "",
    });
    setShowNewConn(false);
    setShowUpdateToken(false);
  }, [binding]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      if (draft.connectionId) body.connectionId = Number(draft.connectionId);
      if (draft.projectId) body.projectId = draft.projectId;
      if (draft.projectName) body.projectName = draft.projectName;
      if (draft.providerEnvironmentId) body.providerEnvironmentId = draft.providerEnvironmentId;
      if (draft.providerEnvironmentName) body.providerEnvironmentName = draft.providerEnvironmentName;
      if (draft.serviceId) body.serviceId = draft.serviceId;
      if (draft.serviceName) body.serviceName = draft.serviceName;
      if (draft.publicUrl) body.publicUrl = draft.publicUrl;
      if (draft.staticUrl) body.staticUrl = draft.staticUrl;

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
      setEditing(false);
      setShowNewConn(false);
      toast({ title: "Hosting binding saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleCancel = () => {
    resetDraft();
    setEditing(false);
  };

  const handleNewConnectionCreated = (conn: ProviderConnection) => {
    queryClient.invalidateQueries({ queryKey: ["/api/provider-connections"] });
    setDraft((d) => ({ ...d, connectionId: String(conn.id) }));
    setShowNewConn(false);
  };

  if (!editing) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Hosting Binding</CardTitle>
              <CardDescription>Where this environment runs.</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {binding.inferred && <Badge variant="outline">inferred</Badge>}
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => { resetDraft(); setEditing(true); }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ValueRow label="Provider" value={humanize(resolvedProvider)} />
          <ValueRow label="Connection" value={binding.connection?.label || "No connection selected"} />
          {resolvedProvider === "cloudflare" ? (
            <>
              <ValueRow label="Account ID" value={binding.projectId} mono />
              <ValueRow label="Pages project" value={binding.projectName} />
              <ValueRow label="Environment" value={binding.providerEnvironmentId || "production"} />
            </>
          ) : (
            <>
              <ValueRow label="Project" value={binding.projectName || binding.projectId} />
              <ValueRow label="Environment" value={binding.providerEnvironmentName || binding.providerEnvironmentId} />
              <ValueRow label="Service" value={binding.serviceName || binding.serviceId} />
            </>
          )}
          <ValueRow label="Public URL" value={binding.publicUrl} mono />
          {binding.staticUrl && <ValueRow label="Static URL" value={binding.staticUrl} mono />}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Hosting Binding</CardTitle>
            <CardDescription>Where this environment runs.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-0">
        <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/40 py-2 items-center">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Provider</div>
          <Select value={draft.hostingProvider} onValueChange={(v) => { setDraft((d) => ({ ...d, hostingProvider: v, connectionId: "" })); setShowNewConn(false); setShowUpdateToken(false); }}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="railway">Railway</SelectItem>
              <SelectItem value="cloudflare">Cloudflare</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <ConnectionSelect
          provider={draft.hostingProvider}
          value={draft.connectionId}
          onChange={(id) => { setDraft((d) => ({ ...d, connectionId: id })); setShowUpdateToken(false); }}
          onNewConnection={() => { setShowNewConn(true); setShowUpdateToken(false); }}
          onUpdateCredential={() => { setShowUpdateToken(true); setShowNewConn(false); }}
        />
        {showNewConn && (
          <div className="py-2">
            <InlineConnectionForm
              provider={draft.hostingProvider}
              onCreated={handleNewConnectionCreated}
              onCancel={() => setShowNewConn(false)}
            />
          </div>
        )}
        {showUpdateToken && draft.connectionId && (
          <div className="py-2">
            <UpdateCredentialForm
              connectionId={Number(draft.connectionId)}
              connectionLabel={allConnections?.find((c) => c.id === Number(draft.connectionId))?.label || "Connection"}
              provider={draft.hostingProvider}
              onDone={() => setShowUpdateToken(false)}
            />
          </div>
        )}
        {draft.hostingProvider === "cloudflare" ? (
          <>
            <EditableRow label="Account ID" value={draft.projectId} onChange={(v) => setDraft((d) => ({ ...d, projectId: v }))} mono placeholder="Cloudflare account ID" />
            <EditableRow label="Pages project" value={draft.projectName} onChange={(v) => setDraft((d) => ({ ...d, projectName: v }))} placeholder="e.g. website" />
            <EditableRow label="Environment" value={draft.providerEnvironmentId} onChange={(v) => setDraft((d) => ({ ...d, providerEnvironmentId: v }))} placeholder="e.g. production" />
          </>
        ) : (
          <>
            <EditableRow label="Project ID" value={draft.projectId} onChange={(v) => setDraft((d) => ({ ...d, projectId: v }))} mono placeholder="Railway project UUID" />
            <EditableRow label="Project name" value={draft.projectName} onChange={(v) => setDraft((d) => ({ ...d, projectName: v }))} placeholder="e.g. xyz" />
            <EditableRow label="Env ID" value={draft.providerEnvironmentId} onChange={(v) => setDraft((d) => ({ ...d, providerEnvironmentId: v }))} mono placeholder="Railway environment UUID" />
            <EditableRow label="Env name" value={draft.providerEnvironmentName} onChange={(v) => setDraft((d) => ({ ...d, providerEnvironmentName: v }))} placeholder="e.g. production" />
            <EditableRow label="Service ID" value={draft.serviceId} onChange={(v) => setDraft((d) => ({ ...d, serviceId: v }))} mono placeholder="Railway service UUID" />
            <EditableRow label="Service name" value={draft.serviceName} onChange={(v) => setDraft((d) => ({ ...d, serviceName: v }))} placeholder="e.g. xyz-prod" />
          </>
        )}
        <EditableRow label="Public URL" value={draft.publicUrl} onChange={(v) => setDraft((d) => ({ ...d, publicUrl: v }))} mono placeholder="https://..." />
        <EditableRow label="Static URL" value={draft.staticUrl} onChange={(v) => setDraft((d) => ({ ...d, staticUrl: v }))} mono placeholder="https://..." />
        <div className="flex items-center gap-2 pt-3">
          <Button variant="ghost" size="sm" onClick={handleCancel}>Cancel</Button>
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Deployment Status Card ---

interface DeploymentStatus {
  available: boolean;
  reason?: string;
  deployment: {
    id: string | null;
    status: string;
    commitSha: string | null;
    deployedAt: string | null;
  } | null;
  urlReachable: boolean | null;
  publicUrl?: string | null;
}

function statusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status.toUpperCase()) {
    case "SUCCESS": return "default";
    case "BUILDING": case "DEPLOYING": case "INITIALIZING": return "secondary";
    case "FAILED": case "CRASHED": return "destructive";
    default: return "outline";
  }
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}

function humanize(value?: string | null) {
  return (value || "none").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function shortSha(value?: string | null) {
  return value ? value.slice(0, 7) : "—";
}

function workflowBadgeClass(status?: string | null) {
  const classes: Record<string, string> = {
    active: "bg-info/15 text-info border-info/20",
    completed: "bg-success/15 text-success border-success/20",
    needs_review: "bg-warning/15 text-warning border-warning/20",
    blocked: "bg-destructive/15 text-destructive border-destructive/20",
    failed: "bg-destructive/15 text-destructive border-destructive/20",
    paused: "bg-warning/15 text-warning border-warning/20",
    canceled: "bg-muted text-muted-foreground border-border",
    draft: "bg-secondary text-secondary-foreground border-border",
  };
  return classes[status || "draft"] || classes.draft;
}

function policyLine(status: BuildLifecycleStatus | undefined, fallback: EnvironmentDetails) {
  const source = status?.source || fallback.source;
  const lifecycle = status?.lifecycle;
  const deployPolicy = configRecord(lifecycle?.deployPolicy);
  const branch = stringValue(deployPolicy.sourceBranch, source?.branch || fallback.promotion.sourceBranch || "branch not set");
  const deployMode = stringValue(deployPolicy.mode, source?.autoDeploy ? "auto_on_push" : "manual");
  const provider = lifecycle?.providerKind || status?.hosting?.provider || fallback.hosting.provider || "provider";
  const gate = deployMode === "manual_promote" ? "manual promote gate" : deployMode === "auto_on_push" ? "auto on push" : "manual run";
  return `${humanize(provider)} · ${branch} · ${gate}`;
}

function activeWorkflow(recent: WorkflowRunSummary[] = []) {
  return recent.find((run) => ["active", "needs_review", "blocked", "paused"].includes(run.status)) || recent[0] || null;
}

function providerBuildLine(status: BuildLifecycleStatus | undefined) {
  const railway = status?.providers.railway;
  const deployment = railway?.deployment;
  if (deployment) {
    return `${detailedStatusLabel(deployment.status)} · ${shortSha(deployment.commitSha)} · ${relativeTime(deployment.deployedAt)}`;
  }

  const cfPages = status?.providers.cloudflare_pages;
  const cfDeployment = cfPages?.deployment;
  if (cfDeployment) {
    return `${detailedStatusLabel(cfDeployment.status)} · ${shortSha(cfDeployment.commitSha)} · ${relativeTime(cfDeployment.deployedAt)}`;
  }

  const eas = status?.providers.eas?.latestBuild;
  if (eas) {
    return `EAS ${detailedStatusLabel(eas.status)} · ${eas.platform || "platform"} · ${relativeTime(eas.completedAt || eas.createdAt)}`;
  }

  return railway?.reason || cfPages?.reason || status?.providers.eas?.reason || "No provider build yet";
}


function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number | null = null) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function configRecord(value: Record<string, unknown> | null | undefined) {
  return value || {};
}

function configDraft(config: BuildLifecycleConfig | null | undefined, details: EnvironmentDetails): BuildLifecycleConfigDraft {
  const deployPolicy = configRecord(config?.deployPolicy);
  const acceptanceTarget = configRecord(config?.acceptanceTarget);
  const retryPolicy = configRecord(config?.retryPolicy);
  const gatePolicy = configRecord(config?.gatePolicy);
  const evidenceConfig = configRecord(config?.evidenceConfig);
  const docsConfig = configRecord(config?.docsConfig);

  return {
    workflowTemplateId: config?.workflowTemplateId || "build-v1",
    providerKind: config?.providerKind || details.hosting.provider || "railway",
    deployMode: stringValue(deployPolicy.mode, details.source.autoDeploy ? "auto_on_push" : "manual"),
    sourceBranch: stringValue(deployPolicy.sourceBranch, details.source.branch || details.promotion.sourceBranch || ""),
    targetBranch: stringValue(deployPolicy.targetBranch, details.promotion.targetBranch || ""),
    requireApproval: booleanValue(deployPolicy.requireApproval, false),
    acceptanceUrl: stringValue(acceptanceTarget.url, details.hosting.publicUrl || details.hosting.staticUrl || ""),
    routePath: stringValue(acceptanceTarget.routePath, "/"),
    healthCheckPath: stringValue(acceptanceTarget.healthCheckPath, ""),
    screenshotRoutePath: stringValue(acceptanceTarget.screenshotRoutePath, ""),
    authMode: typeof config?.authMode === "string" ? config.authMode : "platform_binding",
    maxAttempts: String(numberValue(retryPolicy.maxAttempts, 3) ?? 3),
    backoffSeconds: numberValue(retryPolicy.backoffSeconds) === null ? "" : String(numberValue(retryPolicy.backoffSeconds)),
    requireHumanApproval: booleanValue(gatePolicy.requireHumanApproval, false),
    requireScreenshot: booleanValue(evidenceConfig.requireScreenshot, true),
    requireLogs: booleanValue(evidenceConfig.requireLogs, true),
    requireProviderStatus: booleanValue(evidenceConfig.requireProviderStatus, true),
    updateWorkflowPage: booleanValue(docsConfig.updateWorkflowPage, true),
    artifactPageId: stringValue(docsConfig.artifactPageId, ""),
    enabled: config?.enabled ?? true,
  };
}

function draftPayload(draft: BuildLifecycleConfigDraft) {
  const maxAttempts = Number(draft.maxAttempts) || 3;
  const backoffSeconds = draft.backoffSeconds.trim() ? Number(draft.backoffSeconds) : undefined;
  return {
    workflowTemplateId: draft.workflowTemplateId.trim() || "build-v1",
    providerKind: draft.providerKind,
    deployPolicy: {
      mode: draft.deployMode,
      sourceBranch: draft.sourceBranch.trim() || undefined,
      targetBranch: draft.targetBranch.trim() || null,
      requireApproval: draft.requireApproval,
    },
    acceptanceTarget: {
      url: draft.acceptanceUrl.trim() || null,
      routePath: draft.routePath.trim() || null,
      healthCheckPath: draft.healthCheckPath.trim() || null,
      screenshotRoutePath: draft.screenshotRoutePath.trim() || null,
    },
    authMode: draft.authMode,
    retryPolicy: {
      maxAttempts: Math.max(1, Math.min(20, maxAttempts)),
      ...(backoffSeconds === undefined ? {} : { backoffSeconds: Math.max(0, Math.min(3600, backoffSeconds)) }),
    },
    gatePolicy: {
      requireHumanApproval: draft.requireHumanApproval,
    },
    evidenceConfig: {
      requireScreenshot: draft.requireScreenshot,
      requireLogs: draft.requireLogs,
      requireProviderStatus: draft.requireProviderStatus,
    },
    docsConfig: {
      updateWorkflowPage: draft.updateWorkflowPage,
      artifactPageId: draft.artifactPageId.trim() || null,
    },
    enabled: draft.enabled,
  };
}

function jsonSummary(value: Record<string, unknown> | null | undefined, empty = "default") {
  const entries = Object.entries(value || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return empty;
  return entries.map(([key, value]) => `${humanize(key)}: ${typeof value === "boolean" ? (value ? "yes" : "no") : String(value)}`).join(" · ");
}

function SwitchRow({ label, description, checked, onCheckedChange }: { label: string; description?: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border/50 bg-muted/20 p-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function LifecycleConfigDetails({ config }: { config: BuildLifecycleConfig | null | undefined }) {
  if (!config) {
    return <p className="text-sm text-muted-foreground">No lifecycle config is enabled for this environment.</p>;
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="grid gap-2 md:grid-cols-2">
        <ValueRow label="Template" value={config.workflowTemplateId} mono />
        <ValueRow label="Provider" value={config.providerKind} />
        <ValueRow label="Auth" value={typeof config.authMode === "string" ? config.authMode : jsonSummary(config.authMode)} />
        <ValueRow label="Updated" value={new Date(config.updatedAt).toLocaleString()} />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-md border border-border/50 bg-background/60 p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Deploy</div>
          <div className="text-muted-foreground">{jsonSummary(config.deployPolicy)}</div>
        </div>
        <div className="rounded-md border border-border/50 bg-background/60 p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Acceptance</div>
          <div className="text-muted-foreground">{jsonSummary(config.acceptanceTarget, "no target")}</div>
        </div>
        <div className="rounded-md border border-border/50 bg-background/60 p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Evidence</div>
          <div className="text-muted-foreground">{jsonSummary(config.evidenceConfig)}</div>
        </div>
        <div className="rounded-md border border-border/50 bg-background/60 p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Gates / retry</div>
          <div className="text-muted-foreground">{jsonSummary({ ...config.gatePolicy, ...config.retryPolicy })}</div>
        </div>
      </div>
      <details className="rounded-md border border-border/50 bg-background/60">
        <summary className="cursor-pointer list-none p-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Raw tool-maintained fields</summary>
        <pre className="max-h-72 overflow-auto border-t border-border/50 p-3 text-xs text-muted-foreground">{JSON.stringify({ deployPolicy: config.deployPolicy, acceptanceTarget: config.acceptanceTarget, authMode: config.authMode, retryPolicy: config.retryPolicy, gatePolicy: config.gatePolicy, evidenceConfig: config.evidenceConfig, docsConfig: config.docsConfig }, null, 2)}</pre>
      </details>
    </div>
  );
}


function ConfigureLifecycleSheet({
  open,
  onOpenChange,
  environmentId,
  details,
  config,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: number;
  details: EnvironmentDetails;
  config: BuildLifecycleConfig | null | undefined;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<BuildLifecycleConfigDraft>(() => configDraft(config, details));

  const reset = useCallback(() => setDraft(configDraft(config, details)), [config, details]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/platforms/environments/${environmentId}/build-lifecycle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(draft)),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to save build lifecycle");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Build lifecycle saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/platforms/environments", environmentId, "build-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/platforms/environments", environmentId, "build-lifecycle"] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Could not save lifecycle", description: err.message, variant: "destructive" });
    },
  });

  const disableMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/platforms/environments/${environmentId}/build-lifecycle/disable`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || "Failed to disable build lifecycle");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Build lifecycle disabled" });
      queryClient.invalidateQueries({ queryKey: ["/api/platforms/environments", environmentId, "build-status"] });
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Could not disable lifecycle", description: err.message, variant: "destructive" });
    },
  });

  const busy = saveMutation.isPending || disableMutation.isPending;

  return (
    <Sheet open={open} onOpenChange={(next) => { if (next) reset(); onOpenChange(next); }}>
      <SheetContent className="flex w-full flex-col overflow-hidden p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border/60 p-4">
          <SheetTitle>Configure build lifecycle</SheetTitle>
          <SheetDescription>{details.platform.name} / {details.product.name} / {details.environment.name}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-medium text-foreground">Core protocol</h3>
              <p className="text-xs text-muted-foreground">The fields users should reason about. Advanced JSON remains collapsed and tool-maintained.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label="Template">
                <Input value={draft.workflowTemplateId} onChange={(e) => setDraft((d) => ({ ...d, workflowTemplateId: e.target.value }))} className="h-9 font-mono text-xs" />
              </FormField>
              <FormField label="Provider">
                <Select value={draft.providerKind} onValueChange={(providerKind) => setDraft((d) => ({ ...d, providerKind }))}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="railway">Railway</SelectItem>
                    <SelectItem value="cloudflare_pages">Cloudflare Pages</SelectItem>
                    <SelectItem value="eas">EAS</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Deploy policy">
                <Select value={draft.deployMode} onValueChange={(deployMode) => setDraft((d) => ({ ...d, deployMode }))}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="auto_on_push">Auto on push</SelectItem>
                    <SelectItem value="manual_promote">Manual promote</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Auth mode">
                <Select value={draft.authMode} onValueChange={(authMode) => setDraft((d) => ({ ...d, authMode }))}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="provider_connection">Provider connection</SelectItem>
                    <SelectItem value="platform_binding">Platform binding</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
            </div>
            <SwitchRow label="Lifecycle enabled" description="Disabled configs remain in history but cannot launch build workflows." checked={draft.enabled} onCheckedChange={(enabled) => setDraft((d) => ({ ...d, enabled }))} />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-foreground">Deployment target</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label="Source branch"><Input value={draft.sourceBranch} onChange={(e) => setDraft((d) => ({ ...d, sourceBranch: e.target.value }))} className="h-9 font-mono text-xs" /></FormField>
              <FormField label="Target branch"><Input value={draft.targetBranch} onChange={(e) => setDraft((d) => ({ ...d, targetBranch: e.target.value }))} className="h-9 font-mono text-xs" placeholder="optional" /></FormField>
              <FormField label="Acceptance URL"><Input value={draft.acceptanceUrl} onChange={(e) => setDraft((d) => ({ ...d, acceptanceUrl: e.target.value }))} className="h-9 text-xs" placeholder="https://..." /></FormField>
              <FormField label="Route path"><Input value={draft.routePath} onChange={(e) => setDraft((d) => ({ ...d, routePath: e.target.value }))} className="h-9 font-mono text-xs" placeholder="/" /></FormField>
            </div>
            <SwitchRow label="Require approval before deploy/promotion" checked={draft.requireApproval} onCheckedChange={(requireApproval) => setDraft((d) => ({ ...d, requireApproval }))} />
          </section>

          <details className="rounded-xl border bg-background/60">
            <summary className="cursor-pointer list-none p-3 text-sm font-medium">Advanced evidence, gates, and docs</summary>
            <div className="space-y-4 border-t border-border/50 p-3">
              <div className="grid gap-3 md:grid-cols-2">
                <FormField label="Health check path"><Input value={draft.healthCheckPath} onChange={(e) => setDraft((d) => ({ ...d, healthCheckPath: e.target.value }))} className="h-9 font-mono text-xs" placeholder="/health" /></FormField>
                <FormField label="Screenshot route"><Input value={draft.screenshotRoutePath} onChange={(e) => setDraft((d) => ({ ...d, screenshotRoutePath: e.target.value }))} className="h-9 font-mono text-xs" placeholder="/" /></FormField>
                <FormField label="Max attempts"><Input value={draft.maxAttempts} onChange={(e) => setDraft((d) => ({ ...d, maxAttempts: e.target.value }))} className="h-9" inputMode="numeric" /></FormField>
                <FormField label="Backoff seconds"><Input value={draft.backoffSeconds} onChange={(e) => setDraft((d) => ({ ...d, backoffSeconds: e.target.value }))} className="h-9" inputMode="numeric" placeholder="optional" /></FormField>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <SwitchRow label="Human gate" checked={draft.requireHumanApproval} onCheckedChange={(requireHumanApproval) => setDraft((d) => ({ ...d, requireHumanApproval }))} />
                <SwitchRow label="Provider status evidence" checked={draft.requireProviderStatus} onCheckedChange={(requireProviderStatus) => setDraft((d) => ({ ...d, requireProviderStatus }))} />
                <SwitchRow label="Screenshot evidence" checked={draft.requireScreenshot} onCheckedChange={(requireScreenshot) => setDraft((d) => ({ ...d, requireScreenshot }))} />
                <SwitchRow label="Log evidence" checked={draft.requireLogs} onCheckedChange={(requireLogs) => setDraft((d) => ({ ...d, requireLogs }))} />
                <SwitchRow label="Update workflow page" checked={draft.updateWorkflowPage} onCheckedChange={(updateWorkflowPage) => setDraft((d) => ({ ...d, updateWorkflowPage }))} />
              </div>
              <FormField label="Artifact page ID">
                <Input value={draft.artifactPageId} onChange={(e) => setDraft((d) => ({ ...d, artifactPageId: e.target.value }))} className="h-9 font-mono text-xs" placeholder="optional Library page slug/id" />
              </FormField>
              <FormField label="Payload preview">
                <Textarea readOnly value={JSON.stringify(draftPayload(draft), null, 2)} className="min-h-48 font-mono text-xs text-muted-foreground" />
              </FormField>
            </div>
          </details>
        </div>

        <SheetFooter className="border-t border-border/60 p-4">
          {config ? (
            <Button variant="ghost" onClick={() => disableMutation.mutate()} disabled={busy}>Disable</Button>
          ) : null}
          <div className="flex-1" />
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => saveMutation.mutate()} disabled={busy}>
            {saveMutation.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Save lifecycle
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function WorkflowRunRow({ run, compact = false }: { run: WorkflowRunSummary; compact?: boolean }) {
  return (
    <a href={`/workflows/${run.id}`} className={cn("block rounded-lg border border-border/50 bg-background/50 p-3 transition-colors hover:bg-accent/40", compact && "p-2")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{run.title}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{humanize(run.currentStageKey || "not started")}</span>
            <span>Updated {relativeTime(run.updatedAt)}</span>
          </div>
        </div>
        <Badge variant="outline" className={cn("shrink-0 text-xs", workflowBadgeClass(run.status))}>{humanize(run.status)}</Badge>
      </div>
    </a>
  );
}

function BuildLifecycleCard({ environmentId, details }: { environmentId: number; details: EnvironmentDetails }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [configureOpen, setConfigureOpen] = useState(false);
  const { data, isLoading, isFetching, refetch } = useQuery<BuildLifecycleStatus>({
    queryKey: ["/api/platforms/environments", environmentId, "build-status"],
    enabled: Number.isFinite(environmentId),
    refetchInterval: (query) => {
      const recent = query.state.data?.workflows.recent || [];
      return recent.some((run) => ["active", "needs_review"].includes(run.status)) ? 8000 : false;
    },
    staleTime: 30_000,
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/platforms/environments/${environmentId}/build-workflows/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to start workflow" }));
        throw new Error(err.error || "Failed to start workflow");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Build workflow started" });
      queryClient.invalidateQueries({ queryKey: ["/api/platforms/environments", environmentId, "build-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/workflows/runs"] });
    },
    onError: (err: Error) => {
      toast({ title: "Could not start build", description: err.message, variant: "destructive" });
    },
  });

  const activeProvider = data?.providers.railway || data?.providers.cloudflare_pages;
  const activeDeploymentStatus = data?.providers.railway?.deployment?.status || data?.providers.cloudflare_pages?.deployment?.status;
  const family = statusFamily(activeDeploymentStatus);
  const runs = data?.workflows.recent || [];
  const activeRuns = runs.filter((run) => ["active", "needs_review", "blocked", "paused"].includes(run.status));
  const latestCompleted = runs.find((run) => ["completed", "failed", "canceled"].includes(run.status));
  const active = activeWorkflow(runs);
  const providerLabel = activeProvider?.available ? detailedStatusLabel(activeDeploymentStatus) : activeProvider?.degraded ? "Degraded" : data?.lifecycle?.enabled ? "Configured" : "Not configured";
  const providerClasses = activeProvider?.available ? familyClasses[family] : activeProvider?.degraded ? familyClasses.failed : data?.lifecycle?.enabled ? familyClasses.running : familyClasses.unknown;
  const canStart = Boolean(data?.lifecycle?.enabled) && !startMutation.isPending;

  return (
    <Card className={cn("overflow-hidden border-l-4 bg-muted/30", providerClasses.border)}>
      <CardHeader className="border-b bg-card/80 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="truncate text-base">{details.environment.name}</CardTitle>
              <Badge variant="outline" className={cn("gap-1 text-xs", providerClasses.badge)}>
                <span className={cn("h-1.5 w-1.5 rounded-full", providerClasses.dot)} />
                {providerLabel}
              </Badge>
            </div>
            <CardDescription>{policyLine(data, details)}</CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()} disabled={isFetching} title="Refresh status" aria-label="Refresh build lifecycle status">
              <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => setConfigureOpen(true)}>
              <Settings2 className="h-3.5 w-3.5" />
              Configure
            </Button>
            <Button size="sm" className="h-8 gap-1.5" onClick={() => startMutation.mutate()} disabled={!canStart}>
              {startMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-3">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <div className="min-w-0 rounded-xl border bg-background/50 p-3">
                <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Waypoints className="h-3.5 w-3.5" />Workflow</div>
                {active ? (
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={cn("text-xs", workflowBadgeClass(active.status))}>{humanize(active.status)}</Badge>
                      <span className="truncate text-xs text-muted-foreground">{humanize(active.currentStageKey)}</span>
                    </div>
                    <div className="truncate text-sm font-medium">{active.title}</div>
                    <div className="text-xs text-muted-foreground">Updated {relativeTime(active.updatedAt)}</div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No workflow runs yet</div>
                )}
              </div>
              <div className="min-w-0 rounded-xl border bg-background/50 p-3">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Provider build</div>
                <div className="truncate text-sm font-medium">{providerBuildLine(data)}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{data?.hosting?.serviceName || data?.hosting?.projectName || "Hosting target not configured"}</div>
              </div>
              <div className="min-w-0 rounded-xl border bg-background/50 p-3">
                <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5" />Acceptance</div>
                <div className="truncate text-sm font-medium">{data?.hosting?.publicUrl || data?.hosting?.staticUrl || "No public URL"}</div>
                <div className="mt-1 text-xs text-muted-foreground">Checked {relativeTime(data?.checkedAt)}</div>
              </div>
              <div className="min-w-0 rounded-xl border bg-background/50 p-3">
                <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><History className="h-3.5 w-3.5" />Run history</div>
                <div className="truncate text-sm font-medium">{runs.length ? `${runs.length} recent · ${activeRuns.length} active` : "No runs yet"}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{latestCompleted ? `Latest ${humanize(latestCompleted.status)} ${relativeTime(latestCompleted.updatedAt)}` : "Start a workflow to create history"}</div>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
              <details className="rounded-xl border bg-background/50">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 text-sm font-medium">
                  <span className="flex items-center gap-2"><Settings2 className="h-4 w-4 text-muted-foreground" /> Lifecycle configuration</span>
                  <span className="text-xs text-muted-foreground">Summary</span>
                </summary>
                <div className="border-t border-border/50 p-3">
                  <LifecycleConfigDetails config={data?.lifecycle} />
                </div>
              </details>

              <div className="rounded-xl border bg-background/50 p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium"><Waypoints className="h-4 w-4 text-muted-foreground" /> Active / latest runs</div>
                  <span className="text-xs text-muted-foreground">{runs.length} recent</span>
                </div>
                <div className="space-y-2">
                  {runs.slice(0, 4).map((run) => <WorkflowRunRow key={run.id} run={run} compact />)}
                  {!runs.length ? <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">No build workflow runs yet.</div> : null}
                </div>
              </div>
            </div>

            {runs.length > 4 ? (
              <details className="rounded-xl border bg-background/50">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 text-sm font-medium">
                  <span className="flex items-center gap-2"><History className="h-4 w-4 text-muted-foreground" /> Full run history</span>
                  <span className="text-xs text-muted-foreground">{runs.length} runs</span>
                </summary>
                <div className="grid gap-2 border-t border-border/50 p-3 md:grid-cols-2">
                  {runs.map((run) => <WorkflowRunRow key={run.id} run={run} />)}
                </div>
              </details>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {active ? (
                <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
                  <a href={`/workflows/${active.id}`}><Waypoints className="h-3.5 w-3.5" />Open workflow</a>
                </Button>
              ) : latestCompleted ? (
                <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
                  <a href={`/workflows/${latestCompleted.id}`}><Waypoints className="h-3.5 w-3.5" />Open latest workflow</a>
                </Button>
              ) : null}
              {(data?.hosting?.publicUrl || data?.hosting?.staticUrl) ? (
                <Button asChild variant="ghost" size="sm" className="h-8 gap-1.5">
                  <a href={(data.hosting.publicUrl || data.hosting.staticUrl || "").startsWith("http") ? (data.hosting.publicUrl || data.hosting.staticUrl || "") : `https://${data.hosting.publicUrl || data.hosting.staticUrl}`} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open app</a>
                </Button>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
      <ConfigureLifecycleSheet
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        environmentId={environmentId}
        details={details}
        config={data?.lifecycle}
      />
    </Card>
  );
}

function DeploymentStatusCard({
  environmentId,
  hasConfiguredHosting,
}: {
  environmentId: number;
  hasConfiguredHosting: boolean;
}) {
  const { data, isLoading, isFetching, refetch } = useQuery<DeploymentStatus>({
    queryKey: ["/api/platforms/environments", environmentId, "status"],
    enabled: hasConfiguredHosting,
    staleTime: 30_000,
  });

  if (!hasConfiguredHosting) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Deployment State</CardTitle>
          <CardDescription>Read-only until hosting binding is configured.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
            <Rocket className="h-5 w-5" />
            <span>Configure a hosting binding with a connection to see live deployment status.</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Deployment State</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data?.available) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Deployment State</CardTitle>
              <CardDescription>{data?.reason || "Status unavailable"}</CardDescription>
            </div>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
            <AlertCircle className="h-5 w-5" />
            <span>{data?.reason || "Could not fetch deployment status."}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const dep = data.deployment;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Deployment State</CardTitle>
            <CardDescription>Live deployment status</CardDescription>
          </div>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/40 py-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</div>
          <div>
            <Badge variant={statusBadgeVariant(dep?.status || "unknown")}>
              {statusLabel(dep?.status || "unknown")}
            </Badge>
          </div>
        </div>
        <ValueRow label="Commit" value={dep?.commitSha ? dep.commitSha.slice(0, 7) : "—"} mono />
        <ValueRow label="Deployed at" value={dep?.deployedAt ? new Date(dep.deployedAt).toLocaleString() : "—"} />
        <div className="grid grid-cols-[9rem_1fr] gap-3 border-b border-border/40 py-2 last:border-0">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">URL Health</div>
          <div className="flex items-center gap-2 text-sm">
            {data.urlReachable === true && (
              <>
                <Globe className="h-4 w-4 text-emerald-500" />
                <span className="text-emerald-500">Reachable</span>
              </>
            )}
            {data.urlReachable === false && (
              <>
                <AlertCircle className="h-4 w-4 text-destructive" />
                <span className="text-destructive">Unreachable</span>
              </>
            )}
            {data.urlReachable === null && <span className="text-muted-foreground">No public URL</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Config Card (read-only) ---

function ConfigCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
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

  usePageHeader({ title: data ? `${data.product.name} / ${data.environment.name}` : "Environment" });

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

  const configuredVariables = data.runtimeVariables.filter((v) => v.configured).length;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setLocation("/platforms")}>
          <ArrowLeft className="h-4 w-4" /> Platforms
        </Button>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">{data.platform.name} / {data.product.name}</div>
          <h1 className="truncate text-2xl font-semibold text-foreground">{data.environment.name}</h1>
        </div>
      </div>

      <div className="grid gap-4">
        <ConfigCard title="Identity">
          <ValueRow label="Platform" value={data.platform.name} />
          <ValueRow label="Product" value={data.product.name} />
          <ValueRow label="Environment" value={data.environment.name} />
          <ValueRow label="Kind" value={data.environment.kind} />
          <ValueRow label="Status" value={data.environment.status} />
        </ConfigCard>

        <BuildLifecycleCard environmentId={environmentId} details={data} />

        <details className="rounded-xl border bg-card text-card-foreground shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-medium">
            <span className="flex items-center gap-2"><Settings2 className="h-4 w-4 text-muted-foreground" /> Environment Details / Configure</span>
            <span className="text-xs text-muted-foreground">Bindings, promotion, variables</span>
          </summary>
          <div className="grid gap-4 border-t border-border/50 p-4">
            <SourceBindingCard binding={data.source} environmentId={environmentId} />
            <HostingBindingCard binding={data.hosting} environmentId={environmentId} />

            <DeploymentStatusCard
              environmentId={environmentId}
              hasConfiguredHosting={!data.hosting.inferred && !!data.hosting.connection}
            />

            <ConfigCard title="Promotion" description="Branch promotion path for this environment.">
              <ValueRow label="Source branch" value={data.promotion.sourceBranch} mono />
              <ValueRow label="Target branch" value={data.promotion.targetBranch || "—"} mono />
              <ValueRow label="Mode" value={data.promotion.mode} />
            </ConfigCard>
          </div>
        </details>

        <ConfigCard title="Runtime Variables" description={`${configuredVariables} of ${data.runtimeVariables.length} detected from current runtime/secrets.`}>
          <div className="space-y-1">
            {data.runtimeVariables.map((variable) => (
              <div key={variable.key} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent/40">
                {variable.configured ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <CircleDashed className="h-4 w-4 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{variable.key}</span>
                <Badge variant="outline" className="shrink-0">{variable.category}</Badge>
                {variable.required && <Badge className="shrink-0">required</Badge>}
              </div>
            ))}
          </div>
        </ConfigCard>
      </div>
    </div>
  );
}
