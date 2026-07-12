import { createLogger } from "../log";

const log = createLogger("CloudflarePages");
const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;

type CfError = { code?: number; message?: string };
type Envelope<T> = { success?: boolean; result?: T; errors?: CfError[] };
type SourceConfig = {
  deployments_enabled?: boolean;
  production_deployments_enabled?: boolean;
  preview_deployment_setting?: string;
  production_branch?: string;
  owner?: string;
  repo_name?: string;
};
type ProjectResult = {
  id: string; name: string; production_branch?: string;
  build_config?: { build_command?: string; destination_dir?: string; root_dir?: string };
  source?: { type?: string; config?: SourceConfig } | null;
};
type DeploymentResult = {
  id: string; environment?: string; url?: string; created_on?: string;
  latest_stage?: { name?: string; status?: string };
  deployment_trigger?: { metadata?: { commit_hash?: string; commit_message?: string; branch?: string } };
};

export type CloudflareDeploymentOutcome =
  | { outcome: "triggered" | "retried"; deployment: ReturnType<typeof normalizeDeployment> }
  | { outcome: "unsupported" | "rejected" | "provider_error"; diagnostic: string; status?: number };

function diagnostic(body: Envelope<unknown>, fallback: string): string {
  return body.errors?.map(error => error.message).filter(Boolean).join("; ") || fallback;
}
async function request<T>(token: string, path: string, init?: RequestInit): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.json() as Envelope<T>;
  return { status: response.status, body };
}
function normalizeDeployment(value: DeploymentResult) {
  return {
    id: value.id,
    status: value.latest_stage?.name && value.latest_stage?.status ? `${value.latest_stage.name}:${value.latest_stage.status}` : "unknown",
    environment: value.environment ?? null,
    commitHash: value.deployment_trigger?.metadata?.commit_hash ?? null,
    commitMessage: value.deployment_trigger?.metadata?.commit_message ?? null,
    branch: value.deployment_trigger?.metadata?.branch ?? null,
    url: value.url ?? null,
    createdAt: value.created_on ?? null,
  };
}

export async function getCloudflarePagesProjectTruth(token: string, accountId: string, projectName: string) {
  const { status, body } = await request<ProjectResult>(token, `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}`);
  if (status >= 400 || !body.success || !body.result) throw new Error(`Cloudflare Pages project query failed (HTTP ${status}): ${diagnostic(body, "unknown provider error")}`);
  const project = body.result;
  const config = project.source?.config;
  const automaticProductionDeployments = Boolean(config?.deployments_enabled && config?.production_deployments_enabled);
  return {
    projectId: project.id,
    projectName: project.name,
    productionBranch: config?.production_branch ?? project.production_branch ?? null,
    source: project.source ? { type: project.source.type ?? null, owner: config?.owner ?? null, repository: config?.repo_name ?? null } : null,
    build: { command: project.build_config?.build_command ?? null, destinationDirectory: project.build_config?.destination_dir ?? null, rootDirectory: project.build_config?.root_dir ?? null },
    deployments: { enabled: config?.deployments_enabled ?? null, productionEnabled: config?.production_deployments_enabled ?? null, previewSetting: config?.preview_deployment_setting ?? null, automaticProductionDeployments },
  };
}

export async function triggerCloudflarePagesProductionDeployment(token: string, accountId: string, projectName: string): Promise<CloudflareDeploymentOutcome> {
  const path = `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments`;
  const { status, body } = await request<DeploymentResult>(token, path, { method: "POST", body: JSON.stringify({}) });
  if (status < 400 && body.success && body.result) {
    log.info("Cloudflare Pages production deployment triggered", { accountId, projectName, deploymentId: body.result.id });
    return { outcome: "triggered", deployment: normalizeDeployment(body.result) };
  }
  const detail = diagnostic(body, `HTTP ${status}`);
  if (status === 400 || status === 404 || status === 405) return { outcome: "unsupported", diagnostic: detail, status };
  if (status === 401 || status === 403) return { outcome: "rejected", diagnostic: detail, status };
  log.error("Cloudflare Pages production deployment failed", { accountId, projectName, status, diagnostic: detail });
  return { outcome: "provider_error", diagnostic: detail, status };
}

export async function retryCloudflarePagesDeployment(token: string, accountId: string, projectName: string, deploymentId: string): Promise<CloudflareDeploymentOutcome> {
  const path = `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(deploymentId)}/retry`;
  const { status, body } = await request<DeploymentResult>(token, path, { method: "POST", body: JSON.stringify({}) });
  if (status < 400 && body.success && body.result) {
    log.info("Cloudflare Pages deployment retried", { accountId, projectName, deploymentId: body.result.id, retriedDeploymentId: deploymentId });
    return { outcome: "retried", deployment: normalizeDeployment(body.result) };
  }
  const detail = diagnostic(body, `HTTP ${status}`);
  if (status === 400 || status === 404 || status === 405) return { outcome: "unsupported", diagnostic: detail, status };
  if (status === 401 || status === 403) return { outcome: "rejected", diagnostic: detail, status };
  log.error("Cloudflare Pages deployment retry failed", { accountId, projectName, deploymentId, status, diagnostic: detail });
  return { outcome: "provider_error", diagnostic: detail, status };
}
