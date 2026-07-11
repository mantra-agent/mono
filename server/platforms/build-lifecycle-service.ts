import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { getProviderCredential } from "../provider-credential-store";
import { combineWithVisibleScope, combineWithWritableScope } from "../scoped-storage";
import { getLatestDeploymentByToken } from "../integrations/railway/client";
import { getCloudflareLatestDeployment } from "../services/provider-connection-service";
import {
  createWorkflowRun,
  listWorkflowRuns,
  seedBuildWorkflowTemplate,
  startWorkflowRun,
} from "../workflows/workflow-service";
import { workflowRuns, workflowStageAttempts } from "@shared/schema";
import {
  environmentBuildLifecycleConfigs,
  environmentHostingBindings,
  environmentSourceBindings,
  patchBuildLifecycleConfigSchema,
  platformProductEnvironments,
  platformProducts,
  platforms,
  providerConnections,
  upsertBuildLifecycleConfigSchema,
  type EnvironmentBuildLifecycleConfig,
  type EnvironmentHostingBinding,
  type PatchBuildLifecycleConfig,
  type UpsertBuildLifecycleConfig,
} from "@shared/models/platforms";

const platformScopeColumns = { scope: platforms.scope, ownerUserId: platforms.ownerUserId, accountId: platforms.accountId };
const providerConnectionScopeColumns = { scope: providerConnections.scope, ownerUserId: providerConnections.ownerUserId, accountId: providerConnections.accountId };
const workflowRunScopeColumns = { scope: workflowRuns.scope, ownerUserId: workflowRuns.ownerUserId, accountId: workflowRuns.accountId };
const workflowAttemptScopeColumns = { scope: workflowStageAttempts.scope, ownerUserId: workflowStageAttempts.ownerUserId, accountId: workflowStageAttempts.accountId };

function visiblePlatform(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), platformScopeColumns, predicate);
}

function writablePlatform(predicate?: SQL): SQL {
  return combineWithWritableScope(getCurrentPrincipalOrSystem(), platformScopeColumns, predicate);
}

function visibleProviderConnection(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), providerConnectionScopeColumns, predicate);
}

function visibleWorkflowRun(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), workflowRunScopeColumns, predicate);
}

function visibleWorkflowAttempt(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), workflowAttemptScopeColumns, predicate);
}

async function getVisibleEnvironment(environmentId: number) {
  const [row] = await db
    .select({
      environment: platformProductEnvironments,
      product: platformProducts,
      platform: platforms,
    })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(platformProductEnvironments.id, environmentId), visiblePlatform()))
    .limit(1);
  return row || null;
}

async function getWritableEnvironment(environmentId: number) {
  const [row] = await db
    .select({
      environment: platformProductEnvironments,
      product: platformProducts,
      platform: platforms,
    })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(platformProductEnvironments.id, environmentId), writablePlatform()))
    .limit(1);
  return row || null;
}

function insertValues(environmentId: number, input: UpsertBuildLifecycleConfig) {
  const parsed = upsertBuildLifecycleConfigSchema.parse(input);
  return {
    environmentId,
    workflowTemplateId: parsed.workflowTemplateId,
    providerKind: parsed.providerKind,
    deployPolicy: parsed.deployPolicy,
    acceptanceTarget: parsed.acceptanceTarget,
    authMode: parsed.authMode,
    retryPolicy: parsed.retryPolicy,
    gatePolicy: parsed.gatePolicy,
    evidenceConfig: parsed.evidenceConfig,
    docsConfig: parsed.docsConfig,
    enabled: parsed.enabled,
    disabledAt: parsed.enabled ? null : sql`CURRENT_TIMESTAMP`,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };
}

function patchValues(input: PatchBuildLifecycleConfig) {
  const parsed = patchBuildLifecycleConfigSchema.parse(input);
  const values: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
  if (parsed.workflowTemplateId !== undefined) values.workflowTemplateId = parsed.workflowTemplateId;
  if (parsed.providerKind !== undefined) values.providerKind = parsed.providerKind;
  if (parsed.deployPolicy !== undefined) values.deployPolicy = parsed.deployPolicy;
  if (parsed.acceptanceTarget !== undefined) values.acceptanceTarget = parsed.acceptanceTarget;
  if (parsed.authMode !== undefined) values.authMode = parsed.authMode;
  if (parsed.retryPolicy !== undefined) values.retryPolicy = parsed.retryPolicy;
  if (parsed.gatePolicy !== undefined) values.gatePolicy = parsed.gatePolicy;
  if (parsed.evidenceConfig !== undefined) values.evidenceConfig = parsed.evidenceConfig;
  if (parsed.docsConfig !== undefined) values.docsConfig = parsed.docsConfig;
  if (parsed.enabled !== undefined) {
    values.enabled = parsed.enabled;
    values.disabledAt = parsed.enabled ? null : sql`CURRENT_TIMESTAMP`;
  }
  return values;
}

export type EnvironmentBuildLifecycleContext = {
  platform: typeof platforms.$inferSelect;
  product: typeof platformProducts.$inferSelect;
  environment: typeof platformProductEnvironments.$inferSelect;
  config: EnvironmentBuildLifecycleConfig | null;
};

export type EnvironmentBuildStatus = {
  environment: { id: number; name: string };
  product: { id: number; name: string };
  platform: { id: number; name: string };
  lifecycle: EnvironmentBuildLifecycleConfig | null;
  acceptance: ReturnType<typeof buildLifecycleAcceptanceConfig> | null;
  source: Record<string, unknown> | null;
  hosting: Record<string, unknown> | null;
  providers: {
    railway?: Record<string, unknown> | null;
    eas: Record<string, unknown> | null;
    cloudflare_pages?: Record<string, unknown> | null;
  };
  workflows: {
    recent: unknown[];
  };
  activity: {
    state: "building" | "idle";
    workflowRunId: string | null;
    stageAttemptId: number | null;
  };
  checkedAt: string;
};

export async function getEnvironmentBuildLifecycleConfig(environmentId: number, options: { includeDisabled?: boolean } = {}): Promise<EnvironmentBuildLifecycleContext | null> {
  const env = await getVisibleEnvironment(environmentId);
  if (!env) return null;
  const clauses: SQL[] = [eq(environmentBuildLifecycleConfigs.environmentId, environmentId)];
  if (!options.includeDisabled) clauses.push(eq(environmentBuildLifecycleConfigs.enabled, true));
  const [config] = await db
    .select()
    .from(environmentBuildLifecycleConfigs)
    .where(and(...clauses))
    .orderBy(desc(environmentBuildLifecycleConfigs.enabled), desc(environmentBuildLifecycleConfigs.updatedAt))
    .limit(1);
  return { ...env, config: config || null };
}

export async function createEnvironmentBuildLifecycleConfig(environmentId: number, input: UpsertBuildLifecycleConfig): Promise<EnvironmentBuildLifecycleConfig> {
  const env = await getWritableEnvironment(environmentId);
  if (!env) throw new Error(`Environment ${environmentId} not found or not writable`);
  const values = insertValues(environmentId, input);
  const [created] = await db.transaction(async (tx) => {
    if (values.enabled) {
      await tx
        .update(environmentBuildLifecycleConfigs)
        .set({ enabled: false, disabledAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(eq(environmentBuildLifecycleConfigs.environmentId, environmentId), eq(environmentBuildLifecycleConfigs.enabled, true)));
    }
    return tx.insert(environmentBuildLifecycleConfigs).values(values as typeof environmentBuildLifecycleConfigs.$inferInsert).returning();
  });
  return created;
}

export async function updateEnvironmentBuildLifecycleConfig(configId: number, input: PatchBuildLifecycleConfig): Promise<EnvironmentBuildLifecycleConfig> {
  const parsed = patchBuildLifecycleConfigSchema.parse(input);
  const [existing] = await db
    .select({ config: environmentBuildLifecycleConfigs, environmentId: environmentBuildLifecycleConfigs.environmentId })
    .from(environmentBuildLifecycleConfigs)
    .innerJoin(platformProductEnvironments, eq(environmentBuildLifecycleConfigs.environmentId, platformProductEnvironments.id))
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(environmentBuildLifecycleConfigs.id, configId), writablePlatform()))
    .limit(1);
  if (!existing) throw new Error(`Build lifecycle config ${configId} not found or not writable`);

  const values = patchValues(parsed);
  const [updated] = await db.transaction(async (tx) => {
    if (parsed.enabled === true) {
      await tx
        .update(environmentBuildLifecycleConfigs)
        .set({ enabled: false, disabledAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(eq(environmentBuildLifecycleConfigs.environmentId, existing.environmentId), eq(environmentBuildLifecycleConfigs.enabled, true), ne(environmentBuildLifecycleConfigs.id, configId)));
    }
    return tx.update(environmentBuildLifecycleConfigs).set(values).where(eq(environmentBuildLifecycleConfigs.id, configId)).returning();
  });
  return updated;
}

export async function setEnvironmentBuildLifecycleConfig(environmentId: number, input: UpsertBuildLifecycleConfig): Promise<EnvironmentBuildLifecycleConfig> {
  const existing = await getEnvironmentBuildLifecycleConfig(environmentId);
  if (existing?.config) return updateEnvironmentBuildLifecycleConfig(existing.config.id, input);
  return createEnvironmentBuildLifecycleConfig(environmentId, input);
}

export async function disableEnvironmentBuildLifecycleConfig(environmentId: number): Promise<EnvironmentBuildLifecycleConfig | null> {
  const env = await getWritableEnvironment(environmentId);
  if (!env) throw new Error(`Environment ${environmentId} not found or not writable`);
  const [disabled] = await db
    .update(environmentBuildLifecycleConfigs)
    .set({ enabled: false, disabledAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(environmentBuildLifecycleConfigs.environmentId, environmentId), eq(environmentBuildLifecycleConfigs.enabled, true)))
    .returning();
  return disabled || null;
}

export async function deleteEnvironmentBuildLifecycleConfigs(environmentId: number): Promise<{ deleted: number }> {
  const env = await getWritableEnvironment(environmentId);
  if (!env) throw new Error(`Environment ${environmentId} not found or not writable`);
  const deleted = await db.delete(environmentBuildLifecycleConfigs).where(eq(environmentBuildLifecycleConfigs.environmentId, environmentId)).returning({ id: environmentBuildLifecycleConfigs.id });
  return { deleted: deleted.length };
}

function cleanConnection(connection: typeof providerConnections.$inferSelect | null | undefined) {
  if (!connection) return null;
  return { id: connection.id, provider: connection.provider, label: connection.label, status: connection.status, lastVerifiedAt: connection.lastVerifiedAt };
}

async function getBindingContext(environmentId: number) {
  const [source] = await db.select().from(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, environmentId)).limit(1);
  const [hosting] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, environmentId)).limit(1);
  const ids = [source?.connectionId, hosting?.connectionId].filter((id): id is number => typeof id === "number");
  const connections = ids.length
    ? await Promise.all(ids.map(async (id) => {
      const [conn] = await db.select().from(providerConnections).where(visibleProviderConnection(eq(providerConnections.id, id))).limit(1);
      return conn || null;
    }))
    : [];
  const connectionFor = (id: number | null | undefined) => connections.find((conn) => conn?.id === id) || null;
  return { source, hosting, sourceConnection: connectionFor(source?.connectionId), hostingConnection: connectionFor(hosting?.connectionId) };
}

async function composeRailwayStatus(hosting: typeof environmentHostingBindings.$inferSelect | undefined, connection: typeof providerConnections.$inferSelect | null | undefined) {
  const base = {
    available: false,
    degraded: false,
    reason: "Railway hosting binding is not configured",
    deployment: null as null | Record<string, unknown>,
    publicUrl: hosting?.publicUrl || null,
    urlReachable: null as boolean | null,
  };
  if (!hosting) return base;
  if (!hosting.connectionId) return { ...base, reason: "Railway hosting binding has no provider connection" };
  if (!hosting.projectId || !hosting.serviceId || !hosting.providerEnvironmentId) return { ...base, reason: "Railway hosting binding is incomplete" };
  if (!connection?.credentialRef) return { ...base, reason: "Railway provider connection has no stored credential" };
  const token = await getProviderCredential(connection.credentialRef);
  if (!token) return { ...base, reason: "Could not decrypt Railway credential" };

  let urlReachable: boolean | null = null;
  if (hosting.publicUrl) {
    try {
      const healthUrl = hosting.publicUrl.startsWith("http") ? hosting.publicUrl : `https://${hosting.publicUrl}`;
      const response = await fetch(healthUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      urlReachable = response.ok;
    } catch {
      urlReachable = false;
    }
  }

  try {
    const latest = await getLatestDeploymentByToken(token, hosting.projectId, hosting.serviceId, hosting.providerEnvironmentId);
    return {
      available: true,
      degraded: false,
      reason: null,
      deployment: latest ? { id: latest.id, status: latest.status, commitSha: latest.commitHash, commitMessage: latest.commitMessage, deployedAt: latest.createdAt } : null,
      publicUrl: hosting.publicUrl || null,
      urlReachable,
    };
  } catch (err) {
    return { ...base, degraded: true, reason: err instanceof Error ? err.message : String(err), publicUrl: hosting.publicUrl || null, urlReachable };
  }
}

async function composeEasStatus() {
  try {
    const expo = await import("../integrations/expo");
    const config = expo.getProjectConfig?.();
    if (!config?.projectId) {
      return { available: false, degraded: true, reason: "Expo project config is unavailable", latestBuild: null, latestLocalRun: null };
    }
    const [builds, latestLocalRun] = await Promise.all([
      expo.listBuilds(config.projectId, 1).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })),
      expo.getLatestEasRun().catch(() => null),
    ]);
    if (!Array.isArray(builds)) {
      return { available: false, degraded: true, reason: builds.error, latestBuild: null, latestLocalRun };
    }
    const latest = builds[0] || null;
    return {
      available: true,
      degraded: false,
      reason: null,
      latestBuild: latest ? { id: latest.id, status: latest.status, platform: latest.platform, profile: latest.buildProfile, createdAt: latest.createdAt, completedAt: latest.completedAt, artifacts: latest.artifacts } : null,
      latestLocalRun,
    };
  } catch (err) {
    return { available: false, degraded: true, reason: err instanceof Error ? err.message : String(err), latestBuild: null, latestLocalRun: null };
  }
}

async function composeCloudflarePageStatus(hosting: typeof environmentHostingBindings.$inferSelect | undefined, connection: typeof providerConnections.$inferSelect | null | undefined) {
  const base = {
    available: false,
    degraded: false,
    reason: "Cloudflare Pages hosting binding is not configured",
    deployment: null as null | Record<string, unknown>,
    publicUrl: hosting?.publicUrl || null,
    urlReachable: null as boolean | null,
  };
  if (!hosting || hosting.provider !== "cloudflare") return base;
  if (!hosting.connectionId) return { ...base, reason: "Cloudflare Pages hosting binding has no provider connection" };
  // projectId stores the Cloudflare account ID, projectName stores the Pages project name
  if (!hosting.projectId || !hosting.projectName) return { ...base, reason: "Cloudflare Pages hosting binding is incomplete (need accountId in projectId and project name in projectName)" };
  if (!connection?.credentialRef) return { ...base, reason: "Cloudflare provider connection has no stored credential" };
  const token = await getProviderCredential(connection.credentialRef);
  if (!token) return { ...base, reason: "Could not decrypt Cloudflare credential" };

  let urlReachable: boolean | null = null;
  if (hosting.publicUrl) {
    try {
      const healthUrl = hosting.publicUrl.startsWith("http") ? hosting.publicUrl : `https://${hosting.publicUrl}`;
      const response = await fetch(healthUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      urlReachable = response.ok;
    } catch {
      urlReachable = false;
    }
  }

  const environment = hosting.providerEnvironmentId || "production";
  try {
    const latest = await getCloudflareLatestDeployment(token, hosting.projectId, hosting.projectName, environment);
    return {
      available: true,
      degraded: false,
      reason: null,
      deployment: latest ? {
        id: latest.id,
        status: latest.status,
        environment: latest.environment,
        commitHash: latest.commitHash,
        commitMessage: latest.commitMessage,
        branch: latest.branch,
        url: latest.url,
        deployedAt: latest.createdAt,
      } : null,
      publicUrl: hosting.publicUrl || null,
      urlReachable,
    };
  } catch (err) {
    return { ...base, degraded: true, reason: err instanceof Error ? err.message : String(err), publicUrl: hosting.publicUrl || null, urlReachable };
  }
}

async function getEnvironmentBuildActivity(environmentId: number, workflowTemplateId?: string | null): Promise<EnvironmentBuildStatus["activity"]> {
  const runClauses: SQL[] = [
    eq(workflowRuns.linkedEnvironmentId, environmentId),
    eq(workflowRuns.status, "active"),
    isNull(workflowRuns.archivedAt),
  ];
  if (workflowTemplateId) runClauses.push(eq(workflowRuns.templateId, workflowTemplateId));

  const activeRuns = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(visibleWorkflowRun(and(...runClauses)))
    .orderBy(desc(workflowRuns.updatedAt))
    .limit(5);
  if (!activeRuns.length) return { state: "idle", workflowRunId: null, stageAttemptId: null };

  const runIds = activeRuns.map((run) => run.id);
  const [activeAttempt] = await db
    .select({ id: workflowStageAttempts.id, workflowRunId: workflowStageAttempts.workflowRunId })
    .from(workflowStageAttempts)
    .where(visibleWorkflowAttempt(and(
      inArray(workflowStageAttempts.workflowRunId, runIds),
      eq(workflowStageAttempts.status, "active"),
      isNull(workflowStageAttempts.completedAt),
    )))
    .orderBy(desc(workflowStageAttempts.updatedAt))
    .limit(1);

  return activeAttempt
    ? { state: "building", workflowRunId: activeAttempt.workflowRunId, stageAttemptId: activeAttempt.id }
    : { state: "idle", workflowRunId: null, stageAttemptId: null };
}

export async function getEnvironmentBuildStatus(environmentId: number): Promise<EnvironmentBuildStatus | null> {
  const lifecycle = await getEnvironmentBuildLifecycleConfig(environmentId, { includeDisabled: true });
  if (!lifecycle) return null;
  const { source, hosting, sourceConnection, hostingConnection } = await getBindingContext(environmentId);
  const providerKind = lifecycle.config?.providerKind || "railway";
  const [railway, eas, cloudflarePages, recentWorkflows, activity] = await Promise.all([
    providerKind === "railway" || !providerKind ? composeRailwayStatus(hosting, hostingConnection) : Promise.resolve(null),
    composeEasStatus(),
    providerKind === "cloudflare_pages" ? composeCloudflarePageStatus(hosting, hostingConnection) : Promise.resolve(null),
    listWorkflowRuns({ environmentId, templateId: lifecycle.config?.workflowTemplateId || undefined, limit: 5 }),
    getEnvironmentBuildActivity(environmentId, lifecycle.config?.workflowTemplateId),
  ]);
  return {
    platform: { id: lifecycle.platform.id, name: lifecycle.platform.name },
    product: { id: lifecycle.product.id, name: lifecycle.product.name },
    environment: { id: lifecycle.environment.id, name: lifecycle.environment.name },
    lifecycle: lifecycle.config,
    acceptance: lifecycle.config ? buildLifecycleAcceptanceConfig(lifecycle.config, { hosting }) : null,
    source: source ? { id: source.id, provider: source.provider, connectionId: source.connectionId, connection: cleanConnection(sourceConnection), owner: source.owner, repo: source.repo, branch: source.branch, autoDeploy: source.autoDeploy, codeIndexingEnabled: source.codeIndexingEnabled } : null,
    hosting: hosting ? { id: hosting.id, provider: hosting.provider, connectionId: hosting.connectionId, connection: cleanConnection(hostingConnection), projectId: hosting.projectId, projectName: hosting.projectName, providerEnvironmentId: hosting.providerEnvironmentId, providerEnvironmentName: hosting.providerEnvironmentName, serviceId: hosting.serviceId, serviceName: hosting.serviceName, publicUrl: hosting.publicUrl, staticUrl: hosting.staticUrl } : null,
    providers: { ...(railway ? { railway } : {}), eas, ...(cloudflarePages ? { cloudflare_pages: cloudflarePages } : {}) },
    workflows: { recent: recentWorkflows },
    activity,
    checkedAt: new Date().toISOString(),
  };
}


function lifecycleDeployPolicy(config: EnvironmentBuildLifecycleConfig): Record<string, unknown> {
  return config.deployPolicy && typeof config.deployPolicy === "object" && !Array.isArray(config.deployPolicy)
    ? config.deployPolicy as Record<string, unknown>
    : {};
}

function deploymentPolicyMode(config: EnvironmentBuildLifecycleConfig): string {
  const policy = lifecycleDeployPolicy(config);
  return typeof policy.mode === "string" && policy.mode.trim() ? policy.mode.trim() : "manual";
}

function cleanRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function configuredAcceptanceTargetUrl(target: Record<string, unknown>, hosting?: Pick<EnvironmentHostingBinding, "publicUrl"> | null): string | null {
  const explicit = typeof target.url === "string" && target.url.trim() ? target.url.trim() : "";
  const raw = explicit || hosting?.publicUrl || "";
  if (!raw) return null;
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function buildLifecycleAcceptanceConfig(config: EnvironmentBuildLifecycleConfig, bindings: { hosting?: Pick<EnvironmentHostingBinding, "publicUrl"> | null } = {}) {
  const target = cleanRecord(config.acceptanceTarget);
  const evidence = cleanRecord(config.evidenceConfig);
  const targetUrl = configuredAcceptanceTargetUrl(target, bindings.hosting);
  const routePath = typeof target.routePath === "string" && target.routePath.trim() ? target.routePath.trim() : null;
  const healthCheckPath = typeof target.healthCheckPath === "string" && target.healthCheckPath.trim() ? target.healthCheckPath.trim() : null;
  const screenshotRoutePath = typeof target.screenshotRoutePath === "string" && target.screenshotRoutePath.trim() ? target.screenshotRoutePath.trim() : null;
  const requiresAuth = config.authMode !== "none";
  const missing = [
    !targetUrl ? "targetUrl" : null,
    requiresAuth && !config.authMode ? "authMode" : null,
  ].filter((item): item is string => Boolean(item));
  return {
    configured: Boolean(targetUrl) && missing.length === 0,
    targetUrl,
    target: { ...target, url: targetUrl, routePath, healthCheckPath, screenshotRoutePath },
    authMode: config.authMode,
    evidenceConfig: evidence,
    missing,
  };
}

function deriveBuildLifecycleGatePolicy(environmentName: string, config: EnvironmentBuildLifecycleConfig): Record<string, unknown> {
  const configured = config.gatePolicy && typeof config.gatePolicy === "object" && !Array.isArray(config.gatePolicy)
    ? { ...(config.gatePolicy as Record<string, unknown>) }
    : {};
  const policy = lifecycleDeployPolicy(config);
  const mode = deploymentPolicyMode(config);
  const environmentKind = environmentName.trim().toLowerCase();
  const productionLike = ["live", "prod", "production"].includes(environmentKind);
  const requiresPromotionGate = mode === "manual_promote" || productionLike;
  const requiredGates = Array.isArray(configured.requiredGates) ? [...configured.requiredGates] : [];
  if (requiresPromotionGate && !requiredGates.includes("manual_promote")) requiredGates.push("manual_promote");
  return {
    ...configured,
    deployPolicyMode: mode,
    requireHumanApproval: configured.requireHumanApproval === true || policy.requireApproval === true || requiresPromotionGate,
    ...(requiredGates.length ? { requiredGates } : {}),
    ...(requiresPromotionGate ? { productionPromotionHardGate: true } : {}),
  };
}

function buildLifecycleSnapshot(lifecycle: EnvironmentBuildLifecycleContext, bindings: Awaited<ReturnType<typeof getBindingContext>>) {
  const config = lifecycle.config;
  if (!config) throw new Error("Cannot snapshot missing build lifecycle config");
  return {
    snapshottedAt: new Date().toISOString(),
    platform: { id: lifecycle.platform.id, name: lifecycle.platform.name },
    product: { id: lifecycle.product.id, name: lifecycle.product.name },
    environment: { id: lifecycle.environment.id, name: lifecycle.environment.name, kind: lifecycle.environment.kind, status: lifecycle.environment.status },
    config: {
      id: config.id,
      workflowTemplateId: config.workflowTemplateId,
      providerKind: config.providerKind,
      deployPolicy: config.deployPolicy,
      acceptanceTarget: config.acceptanceTarget,
      acceptance: buildLifecycleAcceptanceConfig(config, { hosting: bindings.hosting }),
      authMode: config.authMode,
      retryPolicy: config.retryPolicy,
      gatePolicy: deriveBuildLifecycleGatePolicy(lifecycle.environment.name, config),
      evidenceConfig: config.evidenceConfig,
      docsConfig: config.docsConfig,
      enabled: config.enabled,
      updatedAt: config.updatedAt,
    },
    source: bindings.source ? { id: bindings.source.id, provider: bindings.source.provider, connectionId: bindings.source.connectionId, owner: bindings.source.owner, repo: bindings.source.repo, branch: bindings.source.branch, autoDeploy: bindings.source.autoDeploy, codeIndexingEnabled: bindings.source.codeIndexingEnabled } : null,
    hosting: bindings.hosting ? { id: bindings.hosting.id, provider: bindings.hosting.provider, connectionId: bindings.hosting.connectionId, projectId: bindings.hosting.projectId, projectName: bindings.hosting.projectName, providerEnvironmentId: bindings.hosting.providerEnvironmentId, providerEnvironmentName: bindings.hosting.providerEnvironmentName, serviceId: bindings.hosting.serviceId, serviceName: bindings.hosting.serviceName, publicUrl: bindings.hosting.publicUrl, staticUrl: bindings.hosting.staticUrl } : null,
    deploySemantics: {
      mode: deploymentPolicyMode(config),
      autoOnPushAllowed: deploymentPolicyMode(config) === "auto_on_push",
      manualPromoteHardGate: deriveBuildLifecycleGatePolicy(lifecycle.environment.name, config).productionPromotionHardGate === true,
    },
  };
}

export async function listEnvironmentBuildWorkflows(environmentId: number, limit = 20) {
  const lifecycle = await getEnvironmentBuildLifecycleConfig(environmentId, { includeDisabled: true });
  if (!lifecycle) return null;
  return listWorkflowRuns({ environmentId, templateId: lifecycle.config?.workflowTemplateId || undefined, limit });
}

export async function startEnvironmentBuildWorkflow(environmentId: number, input: { title?: string; objective?: string; start?: boolean; parentSessionId?: string; createdBySessionId?: string } = {}) {
  const lifecycle = await getEnvironmentBuildLifecycleConfig(environmentId);
  if (!lifecycle) throw new Error(`Environment ${environmentId} not found or has no enabled build lifecycle config`);
  if (!lifecycle.config?.enabled) throw new Error(`Environment ${environmentId} has no enabled build lifecycle config`);
  await seedBuildWorkflowTemplate();
  const bindings = await getBindingContext(environmentId);
  const snapshot = buildLifecycleSnapshot(lifecycle, bindings);
  const gatePolicy = snapshot.config.gatePolicy;
  const title = input.title?.trim() || `Build ${lifecycle.platform.name} / ${lifecycle.product.name} / ${lifecycle.environment.name}`;
  const objective = input.objective?.trim() || `Run ${lifecycle.config.workflowTemplateId} for ${lifecycle.platform.name} / ${lifecycle.product.name} / ${lifecycle.environment.name}. Deploy policy: ${snapshot.deploySemantics.mode}${snapshot.deploySemantics.manualPromoteHardGate ? " with manual promotion hard gate" : ""}.`;
  const run = await createWorkflowRun({
    templateId: lifecycle.config.workflowTemplateId || "build-v1",
    title,
    objective,
    linkedPlatformId: lifecycle.platform.id,
    linkedProductId: lifecycle.product.id,
    linkedEnvironmentId: lifecycle.environment.id,
    parentSessionId: input.parentSessionId,
    createdBySessionId: input.createdBySessionId,
    autonomyPolicy: gatePolicy,
    retryPolicy: lifecycle.config.retryPolicy,
    lifecycleSnapshot: snapshot,
  });
  return input.start === false ? run : startWorkflowRun(run.run.id);
}
