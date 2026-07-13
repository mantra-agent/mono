import {
  resolvePlatformEnvironment,
  resolveRunningPlatformEnvironment,
  type ResolvedPlatformEnvironment,
} from "../../platform-environment-resolver";
import {
  extractDeploymentMeta,
  fetchBuildLogs,
  fetchDeploymentLogs,
  fetchDeploymentsForEnvironment,
  fetchProjects,
  fetchServiceVariables,
  redeployDeployment,
  restartDeployment,
  type RailwayDeployment,
  type RailwayLogEntry,
} from "./client";

const IN_FLIGHT_STATUSES = new Set(["BUILDING", "DEPLOYING", "WAITING", "QUEUED", "INITIALIZING"]);

export interface RailwayEnvironmentControl {
  environment: ResolvedPlatformEnvironment;
  projectId: string;
  railwayEnvironmentId: string;
  serviceId: string;
  publicUrl: string | null;
  token: string;
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export async function resolveRailwayEnvironmentControl(
  platformEnvironmentId?: number,
  options: { allowCurrentRuntime?: boolean } = {},
): Promise<RailwayEnvironmentControl> {
  if (platformEnvironmentId !== undefined && !positiveInteger(platformEnvironmentId)) {
    throw new Error("platformEnvironmentId must be a positive integer");
  }
  const environment = platformEnvironmentId !== undefined
    ? await resolvePlatformEnvironment(platformEnvironmentId)
    : options.allowCurrentRuntime
      ? await resolveRunningPlatformEnvironment()
      : null;
  if (!environment) {
    throw new Error(
      platformEnvironmentId !== undefined
        ? `Platform Environment ${platformEnvironmentId} has no complete Railway hosting binding`
        : "platformEnvironmentId is required for cross-environment Railway operations; current-runtime self-inspection could not be resolved",
    );
  }
  return {
    environment,
    projectId: environment.providerConfiguration.projectId,
    railwayEnvironmentId: environment.providerConfiguration.environmentId,
    serviceId: environment.providerConfiguration.serviceId,
    publicUrl: environment.providerConfiguration.publicUrl,
    token: environment.credential,
  };
}

export async function verifyRailwayEnvironmentCapability(control: RailwayEnvironmentControl): Promise<{
  authenticated: boolean;
  projectVisible: boolean;
}> {
  const { projects } = await fetchProjects(control.token);
  return {
    authenticated: true,
    projectVisible: projects.some((project) => project.id === control.projectId),
  };
}

export async function fetchEnvironmentDeployments(
  control: RailwayEnvironmentControl,
  limit = 20,
): Promise<RailwayDeployment[]> {
  return fetchDeploymentsForEnvironment(
    control.projectId,
    control.serviceId,
    control.railwayEnvironmentId,
    limit,
    control.token,
  );
}

export async function fetchLatestEnvironmentDeployment(
  control: RailwayEnvironmentControl,
): Promise<RailwayDeployment | null> {
  const deployments = await fetchEnvironmentDeployments(control, 1);
  return deployments[0] ?? null;
}

export async function fetchEnvironmentRuntimeLogs(
  control: RailwayEnvironmentControl,
  deploymentId: string,
  limit = 200,
): Promise<RailwayLogEntry[]> {
  return fetchDeploymentLogs(deploymentId, limit, control.token);
}

export async function fetchEnvironmentBuildLogs(
  control: RailwayEnvironmentControl,
  deploymentId: string,
  limit = 200,
): Promise<RailwayLogEntry[]> {
  const [buildResult, deployResult] = await Promise.allSettled([
    fetchBuildLogs(deploymentId, limit, control.token),
    fetchDeploymentLogs(deploymentId, limit, control.token),
  ]);
  const build = buildResult.status === "fulfilled" ? buildResult.value : [];
  const deploy = deployResult.status === "fulfilled" ? deployResult.value : [];
  return [...build, ...deploy].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export async function resolveEnvironmentDeploymentId(
  control: RailwayEnvironmentControl,
  deploymentId?: string,
  preferInFlight = false,
): Promise<string | null> {
  if (deploymentId?.trim()) return deploymentId.trim();
  const deployments = await fetchEnvironmentDeployments(control, preferInFlight ? 5 : 1);
  if (preferInFlight) {
    const inFlight = deployments.find((deployment) => IN_FLIGHT_STATUSES.has((deployment.status || "").toUpperCase()));
    return (inFlight ?? deployments[0])?.id ?? null;
  }
  return deployments[0]?.id ?? null;
}

export async function listEnvironmentVariableNames(control: RailwayEnvironmentControl): Promise<string[]> {
  const variables = await fetchServiceVariables(
    control.projectId,
    control.railwayEnvironmentId,
    control.serviceId,
    control.token,
  );
  return Object.keys(variables).sort();
}

export async function redeployEnvironment(
  control: RailwayEnvironmentControl,
  deploymentId?: string,
): Promise<{ id: string; status: string }> {
  const resolvedDeploymentId = await resolveEnvironmentDeploymentId(control, deploymentId);
  if (!resolvedDeploymentId) throw new Error("No deployment exists for this Platform Environment");
  return redeployDeployment(resolvedDeploymentId, control.token);
}

export async function restartEnvironment(
  control: RailwayEnvironmentControl,
  deploymentId?: string,
): Promise<{ deploymentId: string; ok: boolean }> {
  const resolvedDeploymentId = await resolveEnvironmentDeploymentId(control, deploymentId);
  if (!resolvedDeploymentId) throw new Error("No deployment exists for this Platform Environment");
  return {
    deploymentId: resolvedDeploymentId,
    ok: await restartDeployment(resolvedDeploymentId, control.token),
  };
}

export function serializeEnvironmentDeployment(deployment: RailwayDeployment | null) {
  if (!deployment) return null;
  const meta = extractDeploymentMeta(deployment.meta);
  return {
    id: deployment.id,
    status: deployment.status,
    createdAt: deployment.createdAt,
    updatedAt: deployment.updatedAt,
    staticUrl: deployment.staticUrl,
    commitHash: meta.commitHash,
    commitMessage: meta.commitMessage,
    commitAuthor: meta.commitAuthor,
    branch: meta.branch,
    repo: meta.repo,
  };
}
