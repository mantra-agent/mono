import { useState, useMemo, useEffect, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, ExternalLink, FileText, Globe, Loader2, PlugZap, RefreshCw, Rocket, Wand2, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { SecretControl } from "@/components/SecretControl";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

interface SecretMetadataDto {
  name: string;
  section: string;
  label: string;
  description?: string;
  isSet: boolean;
  status: "set" | "not_set" | "invalid";
  source: "db" | "env" | "none";
  last4: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface RailwayTestResult {
  ok: boolean;
  error?: string;
  me?: { id: string; email: string | null; name: string | null } | null;
  projectCount?: number;
  diagnostics: {
    source: "db" | "env" | "none";
    length: number;
    last4: string | null;
    envAlsoSet: boolean;
  };
}

function RailwayConnectionTester() {
  const { toast } = useToast();
  const [result, setResult] = useState<RailwayTestResult | null>(null);

  const mutation = useMutation({
    mutationFn: async (): Promise<RailwayTestResult> => {
      const res = await fetch("/api/railway/test", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const text = await res.text();
      const looksHtml = text.trimStart().startsWith("<");
      if (looksHtml) {
        throw new Error(
          `Server returned HTML instead of JSON (status ${res.status}). ` +
            `The /api/railway/test endpoint is not registered in the running server — ` +
            `try a hard refresh (Cmd/Ctrl+Shift+R) so the page reconnects.`
        );
      }
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Could not parse server response (status ${res.status}): ${text.slice(0, 200)}`);
      }
      const data = parsed as Partial<RailwayTestResult> & { error?: string };
      if (!res.ok && !data.diagnostics) {
        throw new Error(data.error || `Request failed with status ${res.status}`);
      }
      return {
        ok: data.ok ?? res.ok,
        error: data.error,
        me: data.me,
        projectCount: data.projectCount,
        diagnostics: data.diagnostics ?? { source: "none", length: 0, last4: null, envAlsoSet: false },
      };
    },
    onSuccess: (data) => {
      setResult(data);
      if (data.ok) {
        const who = data.me?.email || data.me?.name || `${data.projectCount ?? 0} project(s) visible`;
        toast({ title: "Railway connected", description: who });
        queryClient.invalidateQueries({ queryKey: ["/api/railway/projects"] });
        queryClient.invalidateQueries({ queryKey: ["/api/railway/status"] });
      }
    },
    onError: (err: Error) => {
      setResult({ ok: false, error: err.message, diagnostics: { source: "none", length: 0, last4: null, envAlsoSet: false } });
    },
  });

  const diag = result?.diagnostics;
  const showOverrideHint =
    !!diag && diag.envAlsoSet && diag.source === "db" && result?.ok === false;

  return (
    <div className="space-y-2" data-testid="railway-connection-tester">
      <Button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        size="sm"
        variant="outline"
        data-testid="button-railway-test"
      >
        {mutation.isPending ? (
          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
        ) : (
          <PlugZap className="h-3.5 w-3.5 mr-2" />
        )}
        Test connection
      </Button>

      {result && (
        <div
          className={cn(
            "rounded-md border p-3 text-xs space-y-1.5",
            result.ok
              ? "border-success/30 bg-success/5"
              : "border-destructive/40 bg-destructive/5"
          )}
          data-testid="text-railway-test-result"
        >
          <div className="flex items-center gap-2 font-medium">
            {result.ok ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-success-foreground" />
                <span>
                  Connected as {result.me?.email || result.me?.name || result.me?.id} ·{" "}
                  {result.projectCount} project{result.projectCount === 1 ? "" : "s"}
                </span>
              </>
            ) : (
              <>
                <XCircle className="h-3.5 w-3.5 text-destructive" />
                <span className="break-words">{result.error || "Request failed"}</span>
              </>
            )}
          </div>
          {diag && (
            <div className="font-mono text-xs text-muted-foreground">
              token source={diag.source} · length={diag.length}
              {diag.last4 ? ` · last4=${diag.last4}` : ""}
              {diag.envAlsoSet ? " · env-var=set" : ""}
            </div>
          )}
          {showOverrideHint && (
            <div className="text-xs text-muted-foreground">
              The token you saved here is overriding the host{" "}
              <code className="font-mono">RAILWAY_API_TOKEN</code> env var. If the env var was
              working before, click the trash icon next to the saved token above to fall back to
              it.
            </div>
          )}
          {!result.ok && /not authorized|unauthorized|401/i.test(result.error || "") && (
            <div className="text-xs text-muted-foreground">
              Most common causes: (1) the token is a project or team token, but listing projects
              requires a Personal Access Token from{" "}
              <a
                className="underline"
                href="https://railway.com/account/tokens"
                target="_blank"
                rel="noreferrer"
              >
                railway.com/account/tokens
              </a>
              ; (2) the token was revoked or expired; (3) only part of the token was pasted.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RailwayServiceDto {
  id: string;
  name: string;
  createdAt?: string | null;
}

interface RailwayEnvironmentDto {
  id: string;
  name: string;
}

interface RailwayProjectDto {
  id: string;
  name: string;
  description?: string | null;
  services: RailwayServiceDto[];
  environments: RailwayEnvironmentDto[];
}

interface RailwayMeDto {
  id: string;
  email: string | null;
  name: string | null;
}

interface RailwayDeploymentDto {
  id: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  staticUrl?: string | null;
  url?: string | null;
}

interface RailwayLogDto {
  timestamp: string;
  message: string;
  severity?: string | null;
}

function formatRailwayTimestamp(ts: string | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function railwayStatusColor(status: string): string {
  const s = (status || "").toUpperCase();
  if (s === "SUCCESS") return "bg-success";
  if (s === "FAILED" || s === "CRASHED") return "bg-error";
  if (s === "BUILDING" || s === "DEPLOYING" || s === "WAITING" || s === "QUEUED" || s === "INITIALIZING") {
    return "bg-warning";
  }
  if (s === "REMOVED" || s === "SLEEPING" || s === "SKIPPED") return "bg-neutral";
  return "bg-neutral/70";
}

function RailwayManagementSection() {
  const { toast } = useToast();
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);

  const { data: status, isLoading: statusLoading } = useQuery<{ configured: boolean }>({
    queryKey: ["/api/railway/status"],
  });

  const { data: projectsData, isLoading: projectsLoading, error: projectsError, refetch: refetchProjects } = useQuery<{
    me: RailwayMeDto;
    projects: RailwayProjectDto[];
  }>({
    queryKey: ["/api/railway/projects"],
    enabled: status?.configured === true,
    retry: false,
  });

  const projects = projectsData?.projects ?? [];

  const selectedContext = useMemo(() => {
    if (!selectedServiceId) return null;
    for (const project of projects) {
      const service = project.services.find((s) => s.id === selectedServiceId);
      if (service) return { project, service };
    }
    return null;
  }, [projects, selectedServiceId]);

  const { data: deploymentsData, isLoading: deploymentsLoading, refetch: refetchDeployments } = useQuery<{
    deployments: RailwayDeploymentDto[];
  }>({
    queryKey: ["/api/railway/deployments", selectedContext?.project.id, selectedContext?.service.id],
    queryFn: async () => {
      const params = new URLSearchParams({
        projectId: selectedContext!.project.id,
        serviceId: selectedContext!.service.id,
        limit: "10",
      });
      const res = await fetch(`/api/railway/deployments?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load deployments");
      return res.json();
    },
    enabled: !!selectedContext,
  });

  const deployments = deploymentsData?.deployments ?? [];

  useEffect(() => {
    if (deployments.length === 0) {
      setSelectedDeploymentId(null);
      return;
    }
    if (!selectedDeploymentId || !deployments.some((d) => d.id === selectedDeploymentId)) {
      setSelectedDeploymentId(deployments[0].id);
    }
  }, [deployments, selectedDeploymentId]);

  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery<{ logs: RailwayLogDto[] }>({
    queryKey: ["/api/railway/deployments", selectedDeploymentId, "logs"],
    queryFn: async () => {
      const res = await fetch(
        `/api/railway/deployments/${encodeURIComponent(selectedDeploymentId!)}/logs?limit=200`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load logs");
      return res.json();
    },
    enabled: !!selectedDeploymentId,
  });

  const redeployMutation = useMutation({
    mutationFn: async (deploymentId: string) => {
      const res = await apiRequest("POST", "/api/railway/redeploy", { deploymentId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Redeploy triggered" });
      refetchDeployments();
    },
    onError: (err: Error) => {
      toast({ title: "Redeploy failed", description: err.message, variant: "destructive" });
    },
  });

  if (statusLoading) {
    return (
      <Card data-testid="card-railway-management">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Rocket className="h-4 w-4" /> Railway Deployments
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!status?.configured) {
    return (
      <Card data-testid="card-railway-management">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Rocket className="h-4 w-4" /> Railway Deployments
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground" data-testid="text-railway-not-configured">
            Set the Railway API token above to manage projects and view deployment logs.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="card-railway-management">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Rocket className="h-4 w-4" /> Railway Deployments
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetchProjects()}
          disabled={projectsLoading}
          data-testid="button-refresh-railway-projects"
        >
          <RefreshCw className={cn("h-4 w-4", projectsLoading && "animate-spin")} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {projectsData?.me && (
          <p className="text-xs text-muted-foreground" data-testid="text-railway-me">
            Connected as {projectsData.me.email || projectsData.me.name || projectsData.me.id}
          </p>
        )}

        {projectsError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="text-railway-error">
            {(projectsError as Error).message}
          </div>
        ) : projectsLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-railway-no-projects">
            No Railway projects found for this token.
          </p>
        ) : (
          <div className="space-y-3">
            {projects.map((project) => (
              <div
                key={project.id}
                className="rounded-md border p-3 space-y-2"
                data-testid={`card-railway-project-${project.id}`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium" data-testid={`text-railway-project-name-${project.id}`}>
                      {project.name}
                    </p>
                    {project.description && (
                      <p className="text-xs text-muted-foreground">{project.description}</p>
                    )}
                  </div>
                  <Badge variant="secondary" className="text-xs" data-testid={`badge-railway-services-${project.id}`}>
                    {project.services.length} service{project.services.length === 1 ? "" : "s"}
                  </Badge>
                </div>
                {project.services.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No services in this project.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {project.services.map((service) => {
                      const isActive = service.id === selectedServiceId;
                      return (
                        <Button
                          key={service.id}
                          variant={isActive ? "default" : "outline"}
                          size="sm"
                          onClick={() => {
                            setSelectedServiceId(service.id);
                            setSelectedDeploymentId(null);
                          }}
                          className="toggle-elevate"
                          data-testid={`button-railway-service-${service.id}`}
                        >
                          {service.name}
                        </Button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {selectedContext && (
          <div className="space-y-3 border-t pt-4" data-testid="section-railway-deployments">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium" data-testid="text-railway-selected-service">
                {selectedContext.project.name} / {selectedContext.service.name}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refetchDeployments()}
                disabled={deploymentsLoading}
                data-testid="button-refresh-railway-deployments"
              >
                <RefreshCw className={cn("h-4 w-4", deploymentsLoading && "animate-spin")} />
              </Button>
            </div>

            {deploymentsLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : deployments.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-railway-no-deployments">
                No deployments found for this service.
              </p>
            ) : (
              <div className="space-y-2">
                {deployments.map((deployment) => {
                  const isActive = deployment.id === selectedDeploymentId;
                  return (
                    <div
                      key={deployment.id}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md border p-2",
                        isActive && "border-primary bg-primary/5"
                      )}
                      data-testid={`card-railway-deployment-${deployment.id}`}
                    >
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-3 text-left"
                        onClick={() => setSelectedDeploymentId(deployment.id)}
                        data-testid={`button-railway-deployment-${deployment.id}`}
                      >
                        <span className={cn("h-2 w-2 rounded-full", railwayStatusColor(deployment.status))} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-mono" data-testid={`text-railway-deployment-id-${deployment.id}`}>
                            {deployment.id.slice(0, 8)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {deployment.status} · {formatRailwayTimestamp(deployment.createdAt)}
                          </p>
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => redeployMutation.mutate(deployment.id)}
                        disabled={redeployMutation.isPending}
                        data-testid={`button-railway-redeploy-${deployment.id}`}
                      >
                        {redeployMutation.isPending && redeployMutation.variables === deployment.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {selectedDeploymentId && (
              <div className="space-y-2" data-testid="section-railway-logs">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <FileText className="h-3 w-3" /> Recent logs
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => refetchLogs()}
                    disabled={logsLoading}
                    data-testid="button-refresh-railway-logs"
                  >
                    <RefreshCw className={cn("h-3 w-3", logsLoading && "animate-spin")} />
                  </Button>
                </div>
                {logsLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : !logsData?.logs || logsData.logs.length === 0 ? (
                  <p className="text-xs text-muted-foreground" data-testid="text-railway-no-logs">
                    No log entries available for this deployment yet.
                  </p>
                ) : (
                  <div
                    className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs"
                    data-testid="text-railway-logs"
                  >
                    {logsData.logs.map((entry, idx) => (
                      <div key={idx} className="flex gap-2 py-0.5">
                        <span className="shrink-0 text-muted-foreground">
                          {formatRailwayTimestamp(entry.timestamp)}
                        </span>
                        <span className="whitespace-pre-wrap break-all">{entry.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface AutoResolveServiceDto {
  id: string;
  name: string;
  devUrl: string | null;
  hasDomain: boolean;
  isCustomDomain: boolean;
}
interface AutoResolveResponse {
  project: { id: string; name: string };
  environment: { id: string; name: string };
  services: AutoResolveServiceDto[];
  pickedServiceId: string | null;
  devUrl: string | null;
  needsDomain: boolean;
}

function setSecretApi(name: string, value: string) {
  return apiRequest("POST", "/api/secrets/set", { name, value });
}

/**
 * Guided wizard that turns "what's my dev project / env / service / URL" into
 * a few dropdowns + an auto-detection step. Persists each selection back to
 * the secrets store so the Dev page picks them up immediately.
 */
function RailwayConfigWizard({ tokenSet }: { tokenSet: boolean }) {
  const { toast } = useToast();

  const { data: projectsData, isLoading: projectsLoading, error: projectsError, refetch: refetchProjects } = useQuery<{
    projects: RailwayProjectDto[];
  }>({
    queryKey: ["/api/railway/projects"],
    enabled: tokenSet,
    retry: false,
  });

  const projects = projectsData?.projects ?? [];

  const [projectId, setProjectId] = useState<string>("");
  const [environmentId, setEnvironmentId] = useState<string>("");
  const [overrideServiceId, setOverrideServiceId] = useState<string>("");

  // Persist selections as the user makes them so the Dev page reflects them
  // without an explicit Save click.
  const persistProject = useMutation({
    mutationFn: (id: string) => setSecretApi("RAILWAY_PROJECT_ID", id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] }),
  });
  const persistEnv = useMutation({
    mutationFn: (id: string) => setSecretApi("RAILWAY_DEV_ENVIRONMENT_ID", id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] }),
  });
  const persistService = useMutation({
    mutationFn: (id: string) => setSecretApi("RAILWAY_DEV_SERVICE_ID", id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] }),
  });
  const persistUrl = useMutation({
    mutationFn: (url: string) => setSecretApi("RAILWAY_DEV_URL", url),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] }),
  });

  // Auto-pick if there is exactly one project visible — and persist it so the
  // Dev page sees the selection without a manual click.
  useEffect(() => {
    if (!projectId && projects.length === 1) {
      const id = projects[0].id;
      setProjectId(id);
      persistProject.mutate(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, projectId]);

  const selectedProject = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);

  // When project changes, prefer an env named dev/preview/staging, else only
  // one. Auto-picks are persisted too so saved settings stick.
  useEffect(() => {
    if (!selectedProject) {
      setEnvironmentId("");
      return;
    }
    if (environmentId && selectedProject.environments.some((e) => e.id === environmentId)) return;
    const devEnv = selectedProject.environments.find((e) => /dev|preview|staging/i.test(e.name));
    const pick = devEnv?.id ?? (selectedProject.environments.length === 1 ? selectedProject.environments[0].id : "");
    setEnvironmentId(pick);
    if (pick) persistEnv.mutate(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject, environmentId]);

  const { data: resolved, isFetching: resolving, refetch: refetchResolved } = useQuery<AutoResolveResponse>({
    queryKey: ["/api/railway/auto-resolve", projectId, environmentId],
    queryFn: async () => {
      const params = new URLSearchParams({ projectId, environmentId });
      const res = await fetch(`/api/railway/auto-resolve?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error || "auto-resolve failed");
      }
      return res.json();
    },
    enabled: !!projectId && !!environmentId,
    retry: false,
  });

  const effectiveServiceId =
    overrideServiceId ||
    resolved?.pickedServiceId ||
    (resolved && resolved.services.length === 1 ? resolved.services[0].id : "");

  const effectiveService = resolved?.services.find((s) => s.id === effectiveServiceId) ?? null;

  // Auto-save resolved service id and URL so the Dev page picks them up
  // without requiring an explicit "Save" click.
  useEffect(() => {
    if (effectiveServiceId) persistService.mutate(effectiveServiceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveServiceId]);
  useEffect(() => {
    if (effectiveService?.devUrl) persistUrl.mutate(effectiveService.devUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveService?.devUrl]);

  const generateDomain = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/railway/ensure-dev-domain", {
        environmentId,
        serviceId: effectiveServiceId,
      });
      return res.json() as Promise<{ devUrl: string; domain: string; created: boolean }>;
    },
    onSuccess: (data) => {
      toast({
        title: data.created ? "Dev domain generated" : "Dev domain refreshed",
        description: data.devUrl,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/secrets/metadata"] });
      queryClient.invalidateQueries({ queryKey: ["/api/railway/projects"] });
      refetchProjects();
      refetchResolved();
    },
    onError: (err: Error) => {
      toast({ title: "Generate domain failed", description: err.message, variant: "destructive" });
    },
  });

  if (!tokenSet) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground" data-testid="text-wizard-needs-token">
        Save and verify your Railway token above, then this wizard will guide you through the rest.
      </div>
    );
  }

  if (projectsLoading) {
    return (
      <div className="space-y-2" data-testid="wizard-loading">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (projectsError) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive" data-testid="text-wizard-projects-error">
        Could not list Railway projects: {(projectsError as Error).message}. Run Test connection above to diagnose.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="railway-config-wizard">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground flex items-center gap-1.5" htmlFor="select-railway-project">
          Project
          {persistProject.isPending && <Loader2 className="h-3 w-3 animate-spin" data-testid="status-saving-project" />}
          {persistProject.isSuccess && !persistProject.isPending && (
            <span className="text-success-foreground inline-flex items-center gap-0.5" data-testid="status-saved-project">
              <CheckCircle2 className="h-3 w-3" /> saved
            </span>
          )}
        </Label>
        <Select
          value={projectId}
          onValueChange={(val) => {
            setProjectId(val);
            setOverrideServiceId("");
            persistProject.mutate(val);
          }}
        >
          <SelectTrigger id="select-railway-project" data-testid="select-railway-project">
            <SelectValue placeholder={projects.length === 0 ? "No projects visible" : "Select a project…"} />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id} data-testid={`option-railway-project-${p.id}`}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedProject && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1.5" htmlFor="select-railway-env">
            Dev environment
            {persistEnv.isPending && <Loader2 className="h-3 w-3 animate-spin" data-testid="status-saving-env" />}
            {persistEnv.isSuccess && !persistEnv.isPending && (
              <span className="text-success-foreground inline-flex items-center gap-0.5" data-testid="status-saved-env">
                <CheckCircle2 className="h-3 w-3" /> saved
              </span>
            )}
          </Label>
          <Select
            value={environmentId}
            onValueChange={(val) => {
              setEnvironmentId(val);
              setOverrideServiceId("");
              persistEnv.mutate(val);
            }}
          >
            <SelectTrigger id="select-railway-env" data-testid="select-railway-env">
              <SelectValue placeholder="Select an environment…" />
            </SelectTrigger>
            <SelectContent>
              {selectedProject.environments.map((e) => (
                <SelectItem key={e.id} value={e.id} data-testid={`option-railway-env-${e.id}`}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {projectId && environmentId && (
        <div className="rounded-md border bg-muted/20 p-3 space-y-2" data-testid="card-railway-resolved">
          {resolving && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Auto-detecting service and dev URL…
            </div>
          )}

          {!resolving && resolved && (
            <>
              {resolved.services.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No app services found in this environment. Create a service in Railway first, then come back.
                </div>
              )}

              {resolved.services.length > 1 && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground" htmlFor="select-railway-service">
                    Dev service ({resolved.services.length} candidates)
                  </Label>
                  <Select value={effectiveServiceId} onValueChange={(v) => setOverrideServiceId(v)}>
                    <SelectTrigger id="select-railway-service" data-testid="select-railway-service">
                      <SelectValue placeholder="Pick the dev service…" />
                    </SelectTrigger>
                    <SelectContent>
                      {resolved.services.map((s) => (
                        <SelectItem key={s.id} value={s.id} data-testid={`option-railway-service-${s.id}`}>
                          {s.name} {s.hasDomain ? "" : "(no domain yet)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {effectiveService && (
                <>
                  <div className="text-xs flex items-center gap-2 flex-wrap">
                    <Wand2 className="h-3.5 w-3.5 text-success-foreground" />
                    <span>Service:</span>
                    <span className="font-medium" data-testid="text-resolved-service">
                      {effectiveService.name}
                    </span>
                    {resolved.services.length === 1 && <Badge variant="outline" className="text-xs">auto-detected</Badge>}
                  </div>

                  {effectiveService.devUrl ? (
                    <div className="text-xs flex items-center gap-2 flex-wrap">
                      <Globe className="h-3.5 w-3.5 text-success-foreground" />
                      <span>Dev URL:</span>
                      <a
                        href={effectiveService.devUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono underline hover:no-underline inline-flex items-center gap-1"
                        data-testid="link-resolved-url"
                      >
                        {effectiveService.devUrl}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                      {effectiveService.isCustomDomain && (
                        <Badge variant="outline" className="text-xs">custom domain</Badge>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="text-xs text-muted-foreground">
                        This service has no public domain in the dev environment yet.
                      </div>
                      <Button
                        size="sm"
                        onClick={() => generateDomain.mutate()}
                        disabled={generateDomain.isPending || !effectiveServiceId}
                        data-testid="button-generate-dev-domain"
                      >
                        {generateDomain.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                        ) : (
                          <Globe className="h-3.5 w-3.5 mr-2" />
                        )}
                        Generate Railway dev domain
                      </Button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Combined Railway setup pane: API token entry + guided dev-target wizard +
 * deployments browser. Used by the Dev page's Setup tab.
 *
 * `children`, when provided, are rendered at the bottom of the same scrollable
 * wrapper. The Dev page uses this slot to append the read-only environment
 * variables view, so Config and Setup live on a single page.
 */
function RailwayTreeSection({ label, children, initialOpen = false }: { label: string; children: ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-1.5 rounded-md px-2 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/70">
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent><div className="space-y-0">{children}</div></CollapsibleContent>
    </Collapsible>
  );
}

export function RailwaySetupTab({ children }: { children?: ReactNode }) {
  const { data: secretsMeta } = useQuery<{ secrets: SecretMetadataDto[] }>({
    queryKey: ["/api/secrets/metadata"],
  });
  const tokenSet = !!secretsMeta?.secrets.find((secret) => secret.name === "RAILWAY_API_TOKEN")?.isSet;
  const [showOverrides, setShowOverrides] = useState(false);

  return (
    <div className="min-w-0 space-y-2" data-testid="railway-setup-tab">
      {children}

      <RailwayTreeSection label="LEGACY">
        <p className="px-2 py-1.5 text-sm text-muted-foreground">
          Fallback configuration used by Publish and older Railway operations. Keep this complete until connector-backed publishing replaces it.
        </p>
        <ProfileTreeRow
          label="API token"
          icon={<PlugZap className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          defaultOpen={!tokenSet}
          expandedContent={<div className="space-y-3"><SecretControl name="RAILWAY_API_TOKEN" /><RailwayConnectionTester /></div>}
        >
          <span className={tokenSet ? "text-active" : "text-muted-foreground"}>{tokenSet ? "Configured" : "Required"}</span>
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Development target"
          icon={<Wand2 className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          expandedContentClassName="space-y-3"
          expandedContent={
            <>
              <RailwayConfigWizard tokenSet={tokenSet} />
              <button type="button" className="text-xs text-cta hover:text-active" onClick={() => setShowOverrides((value) => !value)} data-testid="button-toggle-overrides">
                {showOverrides ? "Hide" : "Show"} advanced overrides
              </button>
              {showOverrides && <div className="space-y-2" data-testid="section-overrides"><SecretControl name="RAILWAY_DEV_SERVICE_ID" /><SecretControl name="RAILWAY_DEV_URL" /></div>}
            </>
          }
        >
          <span className="text-muted-foreground">Fallback</span>
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Production target"
          icon={<Rocket className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          expandedContentClassName="space-y-2"
          expandedContent={<><SecretControl name="RAILWAY_PROD_ENVIRONMENT_ID" /><SecretControl name="RAILWAY_PROD_SERVICE_ID" /><SecretControl name="RAILWAY_PROD_URL" /><SecretControl name="RAILWAY_LIVE_BRANCH" /></>}
        >
          <span className="text-muted-foreground">Publish fallback</span>
        </ProfileTreeRow>
        <ProfileTreeRow
          label="Railway management"
          icon={<Rocket className="h-3.5 w-3.5" />}
          hasValue
          showEmpty
          expandedContent={<RailwayManagementSection />}
          expandedContentClassName="min-w-0"
        >
          <span className="text-muted-foreground">Legacy API</span>
        </ProfileTreeRow>
      </RailwayTreeSection>
    </div>
  );
}
