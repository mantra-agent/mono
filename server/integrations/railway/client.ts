import { eq } from "drizzle-orm";
import { db } from "../../db";
import { getProviderCredential } from "../../provider-credential-store";
import { providerConnections } from "@shared/models/platforms";
import { createLogger } from "../../log";

const log = createLogger("RailwayClient");

const RAILWAY_GRAPHQL_ENDPOINT = "https://backboard.railway.app/graphql/v2";

/** Resolve the credential attached to a canonical Railway provider connection. */
export async function getRailwayTokenForConnection(connectionId: number): Promise<string> {
  const [conn] = await db
    .select({ provider: providerConnections.provider, credentialRef: providerConnections.credentialRef })
    .from(providerConnections)
    .where(eq(providerConnections.id, connectionId))
    .limit(1);
  if (!conn) throw new RailwayApiError(`Provider connection ${connectionId} not found`, 404);
  if (conn.provider !== "railway") throw new RailwayApiError(`Connection ${connectionId} is not a Railway connection (provider=${conn.provider})`, 400);
  if (!conn.credentialRef) throw new RailwayApiError(`Connection ${connectionId} has no stored credential`, 400);
  const token = await getProviderCredential(conn.credentialRef);
  if (!token) throw new RailwayApiError(`Failed to decrypt credential for connection ${connectionId}`, 500);
  return token;
}

export interface RailwayServiceInstanceSummary {
  environmentId: string;
  /** Docker image source — set for template/db services like Postgres */
  sourceImage: string | null;
  /** Git repo source — set for repo-deployed app services */
  sourceRepo: string | null;
  /** Generated *.up.railway.app domains for this service in this env */
  serviceDomains: Array<{ id: string; domain: string }>;
  /** User-attached custom domains for this service in this env */
  customDomains: Array<{ id: string; domain: string }>;
}

export interface RailwayService {
  id: string;
  name: string;
  createdAt?: string | null;
  /** Per-environment instance summaries; used to classify app vs db and resolve URLs */
  instances: RailwayServiceInstanceSummary[];
}

export interface RailwayEnvironment {
  id: string;
  name: string;
}

export interface RailwayProject {
  id: string;
  name: string;
  description?: string | null;
  createdAt?: string | null;
  services: RailwayService[];
  environments: RailwayEnvironment[];
}

/**
 * Heuristic: a Railway service is treated as a deployable "app" (vs a managed
 * database) when at least one of its instances is sourced from a git repo, or
 * when it has any service-domain in any environment. Postgres/MySQL/Redis
 * template services are sourced from a docker image and never have public
 * service domains, so they get filtered out.
 */
export function isAppService(service: RailwayService): boolean {
  return service.instances.some((inst) => !!inst.sourceRepo || inst.serviceDomains.length > 0);
}

export interface RailwayDeployment {
  id: string;
  status: string;
  staticUrl?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  url?: string | null;
  meta?: Record<string, unknown> | null;
  environmentId?: string | null;
  serviceId?: string | null;
}

export interface RailwayLogEntry {
  timestamp: string;
  message: string;
  severity?: string | null;
}

export class RailwayApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "RailwayApiError";
    this.status = status;
    this.details = details;
  }
}

async function railwayRequest<T>(query: string, variables?: Record<string, unknown>, token?: string): Promise<T> {
  if (!token) {
    throw new RailwayApiError("A Railway provider connector credential is required", 400);
  }
  let res: Response;
  try {
    res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RailwayApiError(`Railway request failed: ${msg}`, 502);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RailwayApiError(`Railway returned non-JSON response (HTTP ${res.status})`, res.status || 502);
  }

  if (!res.ok) {
    const message = (body as any)?.errors?.[0]?.message || (body as any)?.message || `HTTP ${res.status}`;
    const hint = res.status === 401 || /not authorized/i.test(String(message)) ? " [connector authentication rejected]" : "";
    throw new RailwayApiError(`Railway API error: ${message}${hint}`, res.status, body);
  }

  const errors = (body as any)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const message = errors.map((e: any) => e?.message).filter(Boolean).join("; ") || "GraphQL error";
    const hint = /not authorized|unauthorized/i.test(message) ? " [connector authentication rejected]" : "";
    throw new RailwayApiError(`Railway API error: ${message}${hint}`, 400, errors);
  }

  return (body as any).data as T;
}

// IMPORTANT: We use the top-level `projects` field, NOT `me { projects }`.
// Railway's `me` resolver rejects Personal Access Tokens with "Not Authorized"
// even when those same PATs can list projects via `projects`. The previous
// `me { projects { … } }` shape worked historically but now fails on every PAT
// — see the trace traceId in railway logs and probe in commit history.
//
// Each service also pulls its serviceInstances so the client can:
//   1. Tell apps apart from databases (apps have source.repo set; DB template
//      services like Postgres only have source.image), and
//   2. Resolve the public dev URL without a second API round-trip — the
//      generated *.up.railway.app domain lives at
//      service.serviceInstances[…].domains.serviceDomains.
const PROJECTS_QUERY = `
  query XyzRailwayProjects($workspaceId: String) {
    projects(first: 100, workspaceId: $workspaceId) {
      edges {
        node {
          id
          name
          description
          createdAt
          services {
            edges {
              node {
                id
                name
                createdAt
                serviceInstances {
                  edges {
                    node {
                      environmentId
                      source { image repo }
                      domains {
                        serviceDomains { id domain }
                        customDomains { id domain }
                      }
                    }
                  }
                }
              }
            }
          }
          environments {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      }
    }
  }
`;

interface RawServiceInstanceNode {
  environmentId: string;
  source: { image: string | null; repo: string | null } | null;
  domains: {
    serviceDomains: Array<{ id: string; domain: string }> | null;
    customDomains: Array<{ id: string; domain: string }> | null;
  } | null;
}

interface RawProjectsResponse {
  projects: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        description: string | null;
        createdAt: string | null;
        services: {
          edges: Array<{
            node: {
              id: string;
              name: string;
              createdAt: string | null;
              serviceInstances?: { edges: Array<{ node: RawServiceInstanceNode }> } | null;
            };
          }>;
        };
        environments: { edges: Array<{ node: { id: string; name: string } }> };
      };
    }>;
  };
}

export interface RailwayMe {
  id: string;
  email: string | null;
  name: string | null;
  workspaces?: Array<{ id: string; name: string }>;
}

const ME_QUERY = `
  query XyzRailwayMe {
    me {
      id
      email
      name
      workspaces { id name }
    }
  }
`;

/**
 * Best-effort fetch of the authenticated identity. Returns null if Railway
 * rejects the `me` query (some token scopes can list projects but not query
 * `me`), so callers can degrade gracefully instead of failing the whole call.
 */
export async function fetchMe(token?: string): Promise<RailwayMe | null> {
  try {
    const data = await railwayRequest<{ me: RailwayMe }>(ME_QUERY, undefined, token);
    return data.me ?? null;
  } catch {
    return null;
  }
}


const SERVICE_INSTANCE_LIMITS_QUERY = `
  query XyzRailwayServiceInstanceLimits($serviceId: String!, $environmentId: String!) {
    serviceInstanceLimits(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

export interface RailwayServiceInstanceLimits {
  memoryGB?: number | null;
  memory?: number | null;
  memoryMb?: number | null;
  memoryMB?: number | null;
  memoryBytes?: number | null;
  vCPUs?: number | null;
  cpu?: number | null;
  containers?: unknown;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safePrimitiveEntries(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (["string", "number", "boolean"].includes(typeof entry) || entry === null) {
      return [`${path}=${String(entry)}`];
    }
    if (Array.isArray(entry)) {
      return [`${path}[${entry.length}]`];
    }
    if (isPlainObject(entry)) {
      return [`${path}{${Object.keys(entry).join(",") || "empty"}}`];
    }
    return [];
  });
}

export function describeServiceInstanceLimits(limits: RailwayServiceInstanceLimits): string {
  const safeEntries = safePrimitiveEntries(limits);
  return safeEntries.length > 0 ? safeEntries.join(" ") : `keys=${Object.keys(limits).join(",") || "none"}`;
}

function resolveMemoryMBFromValue(value: unknown): number | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.memoryGB === "number" && Number.isFinite(value.memoryGB) && value.memoryGB > 0) {
    return Math.floor(value.memoryGB * 1024);
  }
  if (typeof value.memory === "number" && Number.isFinite(value.memory) && value.memory > 0) {
    return Math.floor(value.memory * 1024);
  }
  const memoryMb = typeof value.memoryMb === "number" ? value.memoryMb : value.memoryMB;
  if (typeof memoryMb === "number" && Number.isFinite(memoryMb) && memoryMb > 0) {
    return Math.floor(memoryMb);
  }
  if (typeof value.memoryBytes === "number" && Number.isFinite(value.memoryBytes) && value.memoryBytes > 0) {
    return Math.floor(value.memoryBytes / 1024 / 1024);
  }
  return null;
}

export function resolveServiceInstanceMemoryMB(limits: RailwayServiceInstanceLimits): number | null {
  const direct = resolveMemoryMBFromValue(limits);
  if (direct !== null) return direct;

  const containers = limits.containers;
  if (Array.isArray(containers)) {
    for (const container of containers) {
      const fromContainer = resolveMemoryMBFromValue(container);
      if (fromContainer !== null) return fromContainer;
    }
    return null;
  }
  if (isPlainObject(containers)) {
    const fromContainer = resolveMemoryMBFromValue(containers);
    if (fromContainer !== null) return fromContainer;
    for (const container of Object.values(containers)) {
      const fromNestedContainer = resolveMemoryMBFromValue(container);
      if (fromNestedContainer !== null) return fromNestedContainer;
    }
  }
  return null;
}

export async function fetchServiceInstanceLimits(serviceId: string, environmentId: string, token?: string): Promise<RailwayServiceInstanceLimits> {
  const data = await railwayRequest<{ serviceInstanceLimits: RailwayServiceInstanceLimits | null }>(
    SERVICE_INSTANCE_LIMITS_QUERY,
    { serviceId, environmentId },
    token,
  );
  if (!data.serviceInstanceLimits || typeof data.serviceInstanceLimits !== "object") {
    throw new RailwayApiError("Railway serviceInstanceLimits returned no limits object", 502, data);
  }
  return data.serviceInstanceLimits;
}

export async function fetchProjects(token?: string): Promise<{ me: RailwayMe | null; projects: RailwayProject[] }> {
  const me = await fetchMe(token);

  // Railway scopes projects under workspaces. Query each workspace for its
  // projects and merge results. Falls back to unscoped query when no workspaces
  // are available (e.g. older token types).
  const workspaces = me?.workspaces ?? [];
  const mapEdges = (data: RawProjectsResponse): RailwayProject[] =>
    (data.projects?.edges || []).map(({ node }) => ({
      id: node.id,
      name: node.name,
      description: node.description,
      createdAt: node.createdAt,
      services: (node.services?.edges || []).map((e) => ({
        id: e.node.id,
        name: e.node.name,
        createdAt: e.node.createdAt,
        instances: (e.node.serviceInstances?.edges || []).map((ie) => ({
          environmentId: ie.node.environmentId,
          sourceImage: ie.node.source?.image ?? null,
          sourceRepo: ie.node.source?.repo ?? null,
          serviceDomains: (ie.node.domains?.serviceDomains ?? []).map((d) => ({ id: d.id, domain: d.domain })),
          customDomains: (ie.node.domains?.customDomains ?? []).map((d) => ({ id: d.id, domain: d.domain })),
        })),
      })),
      environments: (node.environments?.edges || []).map((e) => ({
        id: e.node.id,
        name: e.node.name,
      })),
    }));

  if (workspaces.length === 0) {
    // No workspaces found — try unscoped query as fallback
    const data = await railwayRequest<RawProjectsResponse>(PROJECTS_QUERY, undefined, token);
    return { me, projects: mapEdges(data) };
  }

  const allProjects: RailwayProject[] = [];
  for (const ws of workspaces) {
    try {
      const data = await railwayRequest<RawProjectsResponse>(PROJECTS_QUERY, { workspaceId: ws.id }, token);
      allProjects.push(...mapEdges(data));
    } catch (err) {
      log.warn(`Failed to list projects for workspace ${ws.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { me, projects: allProjects };
}

const SERVICE_DOMAIN_CREATE = `
  mutation XyzCreateServiceDomain($input: ServiceDomainCreateInput!) {
    serviceDomainCreate(input: $input) {
      id
      domain
    }
  }
`;

/**
 * Generate a *.up.railway.app service domain for a service in an environment.
 * Equivalent to clicking "Generate Domain" in the Railway dashboard. Idempotent
 * from the caller's perspective: if a domain already exists Railway will
 * either reuse it or return a fresh one — callers should re-fetch the project
 * afterwards to read the canonical list.
 */
export async function createServiceDomain(input: {
  environmentId: string;
  serviceId: string;
  targetPort?: number;
}, token?: string): Promise<{ id: string; domain: string }> {
  const data = await railwayRequest<{ serviceDomainCreate: { id: string; domain: string } }>(
    SERVICE_DOMAIN_CREATE,
    { input },
    token,
  );
  return data.serviceDomainCreate;
}

const DEPLOYMENTS_QUERY = `
  query XyzRailwayDeployments($projectId: String!, $serviceId: String!, $first: Int!) {
    deployments(
      first: $first
      input: { projectId: $projectId, serviceId: $serviceId }
    ) {
      edges {
        node {
          id
          status
          staticUrl
          url
          createdAt
          updatedAt
          environmentId
          serviceId
          meta
        }
      }
    }
  }
`;

interface RawDeploymentsResponse {
  deployments: {
    edges: Array<{
      node: {
        id: string;
        status: string;
        staticUrl: string | null;
        url: string | null;
        createdAt: string | null;
        updatedAt: string | null;
        environmentId: string | null;
        serviceId: string | null;
        meta: Record<string, unknown> | null;
      };
    }>;
  };
}

export async function fetchDeployments(
  projectId: string,
  serviceId: string,
  limit = 10,
  token?: string,
): Promise<RailwayDeployment[]> {
  const data = await railwayRequest<RawDeploymentsResponse>(DEPLOYMENTS_QUERY, {
    projectId,
    serviceId,
    first: limit,
  }, token);
  return (data.deployments?.edges || []).map(({ node }) => ({
    id: node.id,
    status: node.status,
    staticUrl: node.staticUrl,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    environmentId: node.environmentId,
    serviceId: node.serviceId,
    meta: node.meta,
  }));
}

const DEPLOYMENT_LOGS_QUERY = `
  query XyzRailwayDeploymentLogs($deploymentId: String!, $limit: Int!) {
    deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

interface RawLogsResponse {
  deploymentLogs: Array<{ timestamp: string; message: string; severity: string | null }>;
}

export async function fetchDeploymentLogs(deploymentId: string, limit = 200, token?: string): Promise<RailwayLogEntry[]> {
  const data = await railwayRequest<RawLogsResponse>(DEPLOYMENT_LOGS_QUERY, {
    deploymentId,
    limit,
  }, token);
  return (data.deploymentLogs || []).map((entry) => ({
    timestamp: entry.timestamp,
    message: entry.message,
    severity: entry.severity,
  }));
}

const BUILD_LOGS_QUERY = `
  query XyzRailwayBuildLogs($deploymentId: String!, $limit: Int!) {
    buildLogs(deploymentId: $deploymentId, limit: $limit) {
      timestamp
      message
      severity
    }
  }
`;

interface RawBuildLogsResponse {
  buildLogs: Array<{ timestamp: string; message: string; severity: string | null }>;
}

export async function fetchBuildLogs(deploymentId: string, limit = 200, token?: string): Promise<RailwayLogEntry[]> {
  const data = await railwayRequest<RawBuildLogsResponse>(BUILD_LOGS_QUERY, {
    deploymentId,
    limit,
  }, token);
  return (data.buildLogs || []).map((entry) => ({
    timestamp: entry.timestamp,
    message: entry.message,
    severity: entry.severity,
  }));
}

const REDEPLOY_MUTATION = `
  mutation XyzRailwayRedeploy($id: String!) {
    deploymentRedeploy(id: $id) {
      id
      status
    }
  }
`;

export async function redeployDeployment(deploymentId: string, token?: string): Promise<{ id: string; status: string }> {
  const data = await railwayRequest<{ deploymentRedeploy: { id: string; status: string } }>(
    REDEPLOY_MUTATION,
    { id: deploymentId },
    token,
  );
  log.log(`Triggered redeploy of ${deploymentId} -> ${data.deploymentRedeploy.status}`);
  return data.deploymentRedeploy;
}

const RESTART_MUTATION = `
  mutation XyzRailwayRestart($id: String!) {
    deploymentRestart(id: $id)
  }
`;

export async function restartDeployment(deploymentId: string, token?: string): Promise<boolean> {
  const data = await railwayRequest<{ deploymentRestart: boolean }>(RESTART_MUTATION, { id: deploymentId }, token);
  log.log(`Triggered restart of ${deploymentId}`);
  return !!data.deploymentRestart;
}

const STOP_MUTATION = `
  mutation XyzRailwayStop($id: String!) {
    deploymentStop(id: $id)
  }
`;

export async function stopDeployment(deploymentId: string, token?: string): Promise<boolean> {
  const data = await railwayRequest<{ deploymentStop: boolean }>(STOP_MUTATION, { id: deploymentId }, token);
  log.log(`Triggered stop of ${deploymentId}`);
  return !!data.deploymentStop;
}

const ROLLBACK_MUTATION = `
  mutation XyzRailwayRollback($id: String!) {
    deploymentRollback(id: $id)
  }
`;

export async function rollbackToDeployment(deploymentId: string, token?: string): Promise<boolean> {
  const data = await railwayRequest<{ deploymentRollback: boolean }>(ROLLBACK_MUTATION, { id: deploymentId }, token);
  log.log(`Triggered rollback to ${deploymentId}`);
  return !!data.deploymentRollback;
}

const SERVICE_INSTANCE_REDEPLOY_MUTATION = `
  mutation XyzRailwayServiceRedeploy($serviceId: String!, $environmentId: String!) {
    serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
  }
`;

export async function redeployServiceInstance(
  serviceId: string,
  environmentId: string,
  token?: string,
): Promise<boolean> {
  const data = await railwayRequest<{ serviceInstanceRedeploy: boolean }>(
    SERVICE_INSTANCE_REDEPLOY_MUTATION,
    { serviceId, environmentId },
    token,
  );
  log.log(`Triggered service instance redeploy for service=${serviceId} env=${environmentId}`);
  return !!data.serviceInstanceRedeploy;
}

const VARIABLES_QUERY = `
  query XyzRailwayVariables($projectId: String!, $environmentId: String!, $serviceId: String!) {
    variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
  }
`;

export async function fetchServiceVariables(
  projectId: string,
  environmentId: string,
  serviceId: string,
  token?: string,
): Promise<Record<string, string>> {
  const data = await railwayRequest<{ variables: Record<string, string> | null }>(VARIABLES_QUERY, {
    projectId,
    environmentId,
    serviceId,
  }, token);
  return data.variables ?? {};
}

const DEPLOYMENTS_FOR_ENV_QUERY = `
  query XyzRailwayDeploymentsForEnv($projectId: String!, $serviceId: String!, $environmentId: String!, $first: Int!) {
    deployments(
      first: $first
      input: { projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId }
    ) {
      edges {
        node {
          id
          status
          staticUrl
          url
          createdAt
          updatedAt
          environmentId
          serviceId
          meta
        }
      }
    }
  }
`;

export async function fetchDeploymentsForEnvironment(
  projectId: string,
  serviceId: string,
  environmentId: string,
  limit = 20,
  token?: string,
): Promise<RailwayDeployment[]> {
  const data = await railwayRequest<RawDeploymentsResponse>(DEPLOYMENTS_FOR_ENV_QUERY, {
    projectId,
    serviceId,
    environmentId,
    first: limit,
  }, token);
  return (data.deployments?.edges || []).map(({ node }) => ({
    id: node.id,
    status: node.status,
    staticUrl: node.staticUrl,
    url: node.url,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    environmentId: node.environmentId,
    serviceId: node.serviceId,
    meta: node.meta,
  }));
}

// ── Shared deployment status query ──

export interface LatestDeployment {
  id: string;
  status: string;
  commitHash: string | null;
  commitMessage: string | null;
  createdAt: string | null;
}

/**
 * Fetch the latest deployment for a Railway service+environment using a pre-resolved token.
 * Returns null if no deployments exist. Throws on API errors.
 */
export async function getLatestDeploymentByToken(
  token: string,
  projectId: string,
  serviceId: string,
  environmentId: string,
): Promise<LatestDeployment | null> {
  const query = `query ($projectId: String!, $serviceId: String!, $environmentId: String!) {
    deployments(first: 1, input: { projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId }) {
      edges { node { id status createdAt meta } }
    }
  }`;
  const data = await railwayRequest<Record<string, unknown>>(query, { projectId, serviceId, environmentId }, token);
  const edges = (data?.deployments as { edges?: Array<{ node: Record<string, unknown> }> })?.edges ?? [];
  const node = edges[0]?.node;
  if (!node) return null;
  const meta = extractDeploymentMeta(node.meta as Record<string, unknown> | null);
  return {
    id: node.id as string,
    status: node.status as string,
    commitHash: meta.commitHash || null,
    commitMessage: meta.commitMessage || null,
    createdAt: (node.createdAt as string) || null,
  };
}

export interface RailwayDeploymentMeta {
  commitHash?: string | null;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  branch?: string | null;
  repo?: string | null;
}

export function extractDeploymentMeta(meta: Record<string, unknown> | null | undefined): RailwayDeploymentMeta {
  if (!meta || typeof meta !== "object") return {};
  const m = meta as Record<string, unknown>;
  const pick = (key: string): string | null => {
    const v = m[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    commitHash: pick("commitHash") || pick("commitSha"),
    commitMessage: pick("commitMessage"),
    commitAuthor: pick("commitAuthor"),
    branch: pick("branch"),
    repo: pick("repo"),
  };
}
