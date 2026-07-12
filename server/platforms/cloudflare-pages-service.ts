import { createLogger } from "../log";

const log = createLogger("CloudflarePages");
const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 30;

type CfError = { code?: number; message?: string };
type Envelope<T> = { success?: boolean; result?: T; errors?: CfError[]; result_info?: { page?: number; total_pages?: number } };
type SourceConfig = {
  deployments_enabled?: boolean; production_deployments_enabled?: boolean; preview_deployment_setting?: string;
  production_branch?: string; owner?: string; repo_name?: string; pr_comments_enabled?: boolean;
  preview_branch_includes?: string[]; preview_branch_excludes?: string[]; preview_path_includes?: string[]; preview_path_excludes?: string[];
};
type ProjectResult = {
  id: string; name: string; production_branch?: string;
  build_config?: { build_command?: string; destination_dir?: string; root_dir?: string };
  source?: { type?: string; config?: SourceConfig } | null;
};
type DeploymentResult = {
  id: string; environment?: string; url?: string; created_on?: string; modified_on?: string;
  latest_stage?: { name?: string; status?: string };
  stages?: Array<{ name?: string; status?: string }>;
  deployment_trigger?: { metadata?: { commit_hash?: string; commit_message?: string; branch?: string } };
};
export type CloudflareProjectRepair = {
  buildCommand?: string; destinationDirectory?: string; rootDirectory?: string; productionBranch?: string;
  deploymentsEnabled?: boolean; productionDeploymentsEnabled?: boolean; previewDeploymentSetting?: "all" | "none" | "custom";
  previewBranchIncludes?: string[]; previewBranchExcludes?: string[]; previewPathIncludes?: string[]; previewPathExcludes?: string[];
};
export type CloudflareOperationOutcome =
  | { outcome: "project_truth"; project: Awaited<ReturnType<typeof readProject>>; deployments: ReturnType<typeof normalizeDeployment>[]; diagnosis: ReturnType<typeof diagnose> }
  | { outcome: "triggered" | "retried" | "cancelled" | "repaired" | "terminal"; deployment?: ReturnType<typeof normalizeDeployment>; project?: Awaited<ReturnType<typeof readProject>> }
  | { outcome: "authorization_required" | "unsupported" | "rejected" | "provider_error" | "timed_out"; diagnostic: string; status?: number; deployment?: ReturnType<typeof normalizeDeployment> };

function diagnostic(body: Envelope<unknown>, fallback: string) { return body.errors?.map(e => e.message).filter(Boolean).join("; ") || fallback; }
async function request<T>(token: string, path: string, init?: RequestInit): Promise<{ status: number; body: Envelope<T> }> {
  try {
    const response = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await response.text();
    let body: Envelope<T> = {};
    if (text) try { body = JSON.parse(text) as Envelope<T>; } catch { body = { errors: [{ message: "Cloudflare returned a non-JSON response" }] }; }
    return { status: response.status, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Cloudflare Pages request failed", { path, method: init?.method ?? "GET", error: message });
    return { status: 0, body: { errors: [{ message }] } };
  }
}
function normalizeDeployment(value: DeploymentResult) {
  const stage = value.latest_stage;
  return { id: value.id, status: stage?.name && stage?.status ? `${stage.name}:${stage.status}` : "unknown", environment: value.environment ?? null,
    commitHash: value.deployment_trigger?.metadata?.commit_hash ?? null, commitMessage: value.deployment_trigger?.metadata?.commit_message ?? null,
    branch: value.deployment_trigger?.metadata?.branch ?? null, url: value.url ?? null, createdAt: value.created_on ?? null, modifiedAt: value.modified_on ?? null };
}
function diagnose(project: Awaited<ReturnType<typeof readProject>>, deployments: ReturnType<typeof normalizeDeployment>[]) {
  const latest = deployments[0];
  if (!project.gitIntegration.connected) return { state: "authorization_required" as const, diagnostic: "Connect or reconnect the Git repository in Cloudflare Dashboard > Workers & Pages > project > Settings > Builds & deployments. Cloudflare requires repository authorization in the dashboard." };
  if (!latest) return { state: "not_triggered" as const, diagnostic: "No Cloudflare Pages deployment exists for this project." };
  const status = latest.status.toLowerCase();
  if (status.includes("queued") || status.includes("active") || status.includes("running")) return { state: "building" as const, diagnostic: "Cloudflare Pages deployment is still in progress." };
  if (status.includes("failure") || status.includes("failed")) return { state: "build_failed" as const, diagnostic: "The latest Cloudflare Pages deployment failed." };
  if (!project.build.destinationDirectory) return { state: "configuration_error" as const, diagnostic: "Cloudflare Pages has no build output directory configured." };
  return { state: "deployed" as const, diagnostic: "Latest Cloudflare Pages deployment is terminal and successful." };
}
async function readProject(token: string, accountId: string, projectName: string) {
  const { status, body } = await request<ProjectResult>(token, `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}`);
  if (status >= 400 || !body.success || !body.result) throw new Error(`Cloudflare Pages project query failed (HTTP ${status}): ${diagnostic(body, "unknown provider error")}`);
  const project = body.result; const config = project.source?.config;
  return { projectId: project.id, projectName: project.name, productionBranch: config?.production_branch ?? project.production_branch ?? null,
    gitIntegration: { connected: Boolean(project.source && config?.owner && config?.repo_name), type: project.source?.type ?? null, owner: config?.owner ?? null, repository: config?.repo_name ?? null },
    build: { command: project.build_config?.build_command ?? null, destinationDirectory: project.build_config?.destination_dir ?? null, rootDirectory: project.build_config?.root_dir ?? null },
    deployments: { enabled: config?.deployments_enabled ?? null, productionEnabled: config?.production_deployments_enabled ?? null, previewSetting: config?.preview_deployment_setting ?? null,
      automaticProductionDeployments: Boolean(config?.deployments_enabled && config?.production_deployments_enabled), prCommentsEnabled: config?.pr_comments_enabled ?? null,
      previewBranchIncludes: config?.preview_branch_includes ?? [], previewBranchExcludes: config?.preview_branch_excludes ?? [], previewPathIncludes: config?.preview_path_includes ?? [], previewPathExcludes: config?.preview_path_excludes ?? [] } };
}
export async function listCloudflarePagesDeployments(token: string, accountId: string, projectName: string, limit = 20) {
  const bounded = Math.max(1, Math.min(limit, 100));
  const { status, body } = await request<DeploymentResult[]>(token, `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments?per_page=${bounded}`);
  if (status >= 400 || !body.success || !body.result) throw new Error(`Cloudflare Pages deployment query failed (HTTP ${status}): ${diagnostic(body, "unknown provider error")}`);
  return body.result.map(normalizeDeployment);
}
export async function getCloudflarePagesProjectTruth(token: string, accountId: string, projectName: string): Promise<CloudflareOperationOutcome> {
  try { const [project, deployments] = await Promise.all([readProject(token, accountId, projectName), listCloudflarePagesDeployments(token, accountId, projectName)]); return { outcome: "project_truth", project, deployments, diagnosis: diagnose(project, deployments) }; }
  catch (error) { return { outcome: "provider_error", diagnostic: error instanceof Error ? error.message : String(error) }; }
}
async function deploymentMutation(kind: "triggered" | "retried", token: string, accountId: string, projectName: string, suffix = "") : Promise<CloudflareOperationOutcome> {
  const path = `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments${suffix}`;
  const { status, body } = await request<DeploymentResult>(token, path, { method: "POST", body: JSON.stringify({}) });
  if (status < 400 && body.success && body.result) { log.info(`Cloudflare Pages deployment ${kind}`, { accountId, projectName, deploymentId: body.result.id }); return { outcome: kind, deployment: normalizeDeployment(body.result) }; }
  const detail = diagnostic(body, `HTTP ${status}`);
  if ((status === 400 || status === 403) && /authoriz|github|gitlab|repository|oauth/i.test(detail)) return { outcome: "authorization_required", diagnostic: `${detail}. Reconnect Git in the Cloudflare dashboard; the API cannot complete Git OAuth authorization.`, status };
  if ([400,404,405].includes(status)) return { outcome: "unsupported", diagnostic: detail, status };
  if ([401,403].includes(status)) return { outcome: "rejected", diagnostic: detail, status };
  return { outcome: "provider_error", diagnostic: detail, status };
}
export const triggerCloudflarePagesProductionDeployment = (t:string,a:string,p:string) => deploymentMutation("triggered",t,a,p);
export const retryCloudflarePagesDeployment = (t:string,a:string,p:string,d:string) => deploymentMutation("retried",t,a,p,`/${encodeURIComponent(d)}/retry`);
export async function cancelCloudflarePagesDeployment(token:string, accountId:string, projectName:string, deploymentId:string): Promise<CloudflareOperationOutcome> {
  const path=`/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(deploymentId)}`;
  const {status,body}=await request<unknown>(token,path,{method:"DELETE"});
  if(status<400&&body.success){ log.info("Cloudflare Pages deployment cancelled",{accountId,projectName,deploymentId}); return {outcome:"cancelled"}; }
  const detail=diagnostic(body,`HTTP ${status}`); if([400,404,405,409].includes(status)) return {outcome:"unsupported",diagnostic:detail,status}; if([401,403].includes(status)) return {outcome:"rejected",diagnostic:detail,status}; return {outcome:"provider_error",diagnostic:detail,status};
}
export async function pollCloudflarePagesDeployment(token:string,accountId:string,projectName:string,deploymentId:string): Promise<CloudflareOperationOutcome> {
  const path=`/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments/${encodeURIComponent(deploymentId)}`;
  for(let attempt=0;attempt<MAX_POLL_ATTEMPTS;attempt++){ const {status,body}=await request<DeploymentResult>(token,path); if(status>=400||!body.success||!body.result)return {outcome:"provider_error",diagnostic:diagnostic(body,`HTTP ${status}`),status}; const deployment=normalizeDeployment(body.result); if(!/(queued|active|running|idle:active)/i.test(deployment.status))return {outcome:"terminal",deployment}; await new Promise(resolve=>setTimeout(resolve,POLL_INTERVAL_MS)); }
  return {outcome:"timed_out",diagnostic:"Cloudflare Pages deployment did not reach a terminal state within 60 seconds."};
}
export async function repairCloudflarePagesProject(token:string,accountId:string,projectName:string,repair:CloudflareProjectRepair): Promise<CloudflareOperationOutcome> {
  const build_config={build_command:repair.buildCommand,destination_dir:repair.destinationDirectory,root_dir:repair.rootDirectory};
  const config={production_branch:repair.productionBranch,deployments_enabled:repair.deploymentsEnabled,production_deployments_enabled:repair.productionDeploymentsEnabled,preview_deployment_setting:repair.previewDeploymentSetting,preview_branch_includes:repair.previewBranchIncludes,preview_branch_excludes:repair.previewBranchExcludes,preview_path_includes:repair.previewPathIncludes,preview_path_excludes:repair.previewPathExcludes};
  const clean=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined));
  const payload=clean({build_config:clean(build_config),source:{config:clean(config)}});
  const path=`/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}`;
  const {status,body}=await request<ProjectResult>(token,path,{method:"PATCH",body:JSON.stringify(payload)});
  if(status<400&&body.success)return {outcome:"repaired",project:await readProject(token,accountId,projectName)};
  const detail=diagnostic(body,`HTTP ${status}`); if(/authoriz|oauth|repository connection/i.test(detail))return {outcome:"authorization_required",diagnostic:`${detail}. Git OAuth reconnection is dashboard-only.`,status}; if([400,404,405].includes(status))return {outcome:"unsupported",diagnostic:detail,status}; if([401,403].includes(status))return {outcome:"rejected",diagnostic:detail,status}; return {outcome:"provider_error",diagnostic:detail,status};
}
