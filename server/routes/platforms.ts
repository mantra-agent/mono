import type { Express } from "express";
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { getSecretSync } from "../secrets-store";
import { getProviderCredential } from "../provider-credential-store";
import { getLatestDeploymentByToken } from "../integrations/railway/client";
import { getCloudflareLatestDeployment } from "../services/provider-connection-service";
import { environmentHostingBindings, environmentRuntimeVariables, environmentSourceBindings, environmentCapabilityBindings, environmentContextArtifacts, insertPlatformProductEnvironmentSchema, insertPlatformProductSchema, insertPlatformSchema, platformProductEnvironments, platformProducts, platforms, providerConnections, upsertSourceBindingSchema, upsertHostingBindingSchema, upsertCapabilityBindingSchema, upsertContextArtifactSchema, type EnvironmentSourceBinding, type EnvironmentHostingBinding, type EnvironmentRuntimeVariable, type ProviderConnection, type EnvironmentCapabilityBinding } from "@shared/models/platforms";
import { encrypt, getEncryptionKey } from "../encryption";
import { getCloudflarePagesProjectTruth, triggerCloudflarePagesProductionDeployment, retryCloudflarePagesDeployment, cancelCloudflarePagesDeployment, repairCloudflarePagesProject, type CloudflareProjectRepair } from "../platforms/cloudflare-pages-service";
import { deleteEnvironmentBuildLifecycleConfigs, disableEnvironmentBuildLifecycleConfig, getEnvironmentBuildLifecycleConfig, getEnvironmentBuildStatus, listEnvironmentBuildWorkflows, setEnvironmentBuildLifecycleConfig, startEnvironmentBuildWorkflow } from "../platforms/build-lifecycle-service";

const log = createLogger("PlatformRoutes");
const platformScopeColumns = { scope: platforms.scope, ownerUserId: platforms.ownerUserId, accountId: platforms.accountId };

function visiblePlatform(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), platformScopeColumns, predicate);
}

const providerConnectionScopeColumns = { scope: providerConnections.scope, ownerUserId: providerConnections.ownerUserId, accountId: providerConnections.accountId };

function visibleProviderConnection(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), providerConnectionScopeColumns, predicate);
}

function writablePlatform(predicate?: SQL): SQL {
  return combineWithWritableScope(getCurrentPrincipalOrSystem(), platformScopeColumns, predicate);
}



type RuntimeVariableTemplate = { key: string; category: string; required: boolean; source: string };

const runtimeVariableTemplates: RuntimeVariableTemplate[] = [
  { key: "DATABASE_URL", category: "data", required: true, source: "railway-variable" },
  { key: "SESSION_SECRET", category: "boot-critical", required: true, source: "railway-variable" },
  { key: "ENCRYPTION_KEY", category: "boot-critical", required: true, source: "railway-variable" },
  { key: "ENCRYPTION_KEY_PREVIOUS", category: "boot-critical", required: false, source: "railway-variable" },
  { key: "PUBLIC_URL", category: "runtime", required: true, source: "railway-variable" },
  { key: "NODE_ENV", category: "runtime", required: true, source: "railway-variable" },
  { key: "PORT", category: "runtime", required: true, source: "railway-variable" },
  { key: "TZ", category: "runtime", required: false, source: "railway-variable" },
  { key: "S3_ACCESS_KEY_ID", category: "storage", required: false, source: "railway-variable" },
  { key: "S3_SECRET_ACCESS_KEY", category: "storage", required: false, source: "railway-variable" },
  { key: "S3_BUCKET", category: "storage", required: false, source: "railway-variable" },
  { key: "S3_ENDPOINT", category: "storage", required: false, source: "railway-variable" },
  { key: "S3_REGION", category: "storage", required: false, source: "railway-variable" },
  { key: "GITHUB_TOKEN", category: "source", required: false, source: "legacy-secret" },
  { key: "GITHUB_WEBHOOK_SECRET", category: "source", required: false, source: "app-secret" },
];

function environmentKind(name: string): "development" | "staging" | "production" | "custom" {
  const normalized = name.trim().toLowerCase();
  if (["dev", "development"].includes(normalized)) return "development";
  if (["stage", "staging"].includes(normalized)) return "staging";
  if (["prod", "production", "live"].includes(normalized)) return "production";
  return "custom";
}

function inferredBranch(name: string): string {
  const kind = environmentKind(name);
  if (kind === "production") return "live";
  if (kind === "staging") return "staging";
  return "main";
}

function configKeyForEnvironment(name: string, suffix: string): string | null {
  const kind = environmentKind(name);
  if (kind === "development") return `RAILWAY_DEV_${suffix}`;
  if (kind === "production") return `RAILWAY_PROD_${suffix}`;
  return null;
}

function inferredEnvironmentConfig(environmentName: string) {
  const environmentIdKey = configKeyForEnvironment(environmentName, "ENVIRONMENT_ID");
  const serviceIdKey = configKeyForEnvironment(environmentName, "SERVICE_ID");
  const urlKey = configKeyForEnvironment(environmentName, "URL");
  return {
    source: {
      provider: "github",
      owner: "",
      repo: "",
      branch: inferredBranch(environmentName),
      autoDeploy: true,
      inferred: true,
    },
    hosting: {
      provider: "railway",
      projectId: getSecretSync("RAILWAY_PROJECT_ID") || process.env.RAILWAY_PROJECT_ID || "",
      projectName: process.env.RAILWAY_PROJECT_NAME || "mantra",
      providerEnvironmentId: environmentIdKey ? getSecretSync(environmentIdKey) || process.env[environmentIdKey] || "" : "",
      providerEnvironmentName: environmentKind(environmentName),
      serviceId: serviceIdKey ? getSecretSync(serviceIdKey) || process.env[serviceIdKey] || "" : "",
      serviceName: process.env.RAILWAY_SERVICE_NAME || "mantra",
      publicUrl: urlKey ? getSecretSync(urlKey) || process.env[urlKey] || "" : "",
      staticUrl: process.env.RAILWAY_STATIC_URL || "",
      inferred: true,
    },
  };
}

function routeError(error: unknown, operation: string): { message: string; operation: string } {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${operation} failed: ${message}`);
  return { message, operation };
}

function platformIdParam(value: string): number {
  const id = Number.parseInt(value, 10);
  if (!Number.isFinite(id)) throw new Error("Invalid platform id");
  return id;
}

async function ensurePlatformWritable(platformId: number): Promise<boolean> {
  const rows = await db.select({ id: platforms.id }).from(platforms).where(writablePlatform(eq(platforms.id, platformId))).limit(1);
  return rows.length > 0;
}

async function ensureProductWritable(platformId: number, productId: number): Promise<boolean> {
  if (!(await ensurePlatformWritable(platformId))) return false;
  const rows = await db
    .select({ id: platformProducts.id })
    .from(platformProducts)
    .where(and(eq(platformProducts.id, productId), eq(platformProducts.platformId, platformId)))
    .limit(1);
  return rows.length > 0;
}

/** Verify environment exists and belongs to a writable platform. Returns the environment row or null. */
async function ensureEnvironmentWritable(environmentId: number) {
  const [row] = await db
    .select({
      environmentId: platformProductEnvironments.id,
      productId: platformProducts.id,
      platformId: platforms.id,
      environmentName: platformProductEnvironments.name,
    })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(platformProductEnvironments.id, environmentId), writablePlatform()))
    .limit(1);
  return row || null;
}

export function registerPlatformRoutes(app: Express): void {
  app.use("/api/platforms", requireAuth);

  app.get("/api/platforms", async (_req, res) => {
    try {
      const rows = await db.select().from(platforms).where(visiblePlatform()).orderBy(desc(platforms.updatedAt));
      const products = await db
        .select()
        .from(platformProducts)
        .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
        .where(visiblePlatform())
        .orderBy(platformProducts.platformId, platformProducts.name);
      const environments = await db
        .select()
        .from(platformProductEnvironments)
        .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
        .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
        .where(visiblePlatform())
        .orderBy(platformProductEnvironments.productId, platformProductEnvironments.name);
      const environmentsByProduct = new Map<number, typeof platformProductEnvironments.$inferSelect[]>();
      for (const row of environments) {
        const list = environmentsByProduct.get(row.platform_product_environments.productId) || [];
        list.push(row.platform_product_environments);
        environmentsByProduct.set(row.platform_product_environments.productId, list);
      }
      const productsByPlatform = new Map<number, (typeof platformProducts.$inferSelect & { environments: typeof platformProductEnvironments.$inferSelect[] })[]>();
      for (const row of products) {
        const list = productsByPlatform.get(row.platform_products.platformId) || [];
        list.push({ ...row.platform_products, environments: environmentsByProduct.get(row.platform_products.id) || [] });
        productsByPlatform.set(row.platform_products.platformId, list);
      }
      res.json(rows.map(platform => ({ ...platform, products: productsByPlatform.get(platform.id) || [] })));
    } catch (error: unknown) {
      const err = routeError(error, "list_platforms");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });



  app.get("/api/platforms/environments/:environmentId/details", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const [row] = await db
        .select()
        .from(platformProductEnvironments)
        .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
        .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
        .where(and(eq(platformProductEnvironments.id, environmentId), visiblePlatform()))
        .limit(1);
      if (!row) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "get_environment_details" });

      // Gracefully handle missing tables during migration period
      let sourceRows: EnvironmentSourceBinding[] = [];
      let hostingRows: EnvironmentHostingBinding[] = [];
      let runtimeRows: EnvironmentRuntimeVariable[] = [];
      let connectionRows: ProviderConnection[] = [];
      let capabilityRows: EnvironmentCapabilityBinding[] = [];
      let contextArtifactRows: { id: number; environmentId: number; kind: string; libraryPageId: string; createdAt: Date | null; updatedAt: Date | null; pageTitle: string | null }[] = [];
      try {
        sourceRows = await db
          .select()
          .from(environmentSourceBindings)
          .where(eq(environmentSourceBindings.environmentId, environmentId));
        hostingRows = await db
          .select()
          .from(environmentHostingBindings)
          .where(eq(environmentHostingBindings.environmentId, environmentId));
        runtimeRows = await db
          .select()
          .from(environmentRuntimeVariables)
          .where(eq(environmentRuntimeVariables.environmentId, environmentId));
        connectionRows = await db
          .select()
          .from(providerConnections)
          .where(visibleProviderConnection());
        capabilityRows = await db
          .select()
          .from(environmentCapabilityBindings)
          .where(eq(environmentCapabilityBindings.environmentId, environmentId));
      } catch (err) {
        log.debug("Binding table query failed, using inferred config", { error: err instanceof Error ? err.message : String(err) });
      }

      // Context artifacts in a separate try/catch so binding failures don't silently kill artifact loading
      try {
        const { libraryPages } = await import("@shared/models/info");
        contextArtifactRows = await db
          .select({
            id: environmentContextArtifacts.id,
            environmentId: environmentContextArtifacts.environmentId,
            kind: environmentContextArtifacts.kind,
            libraryPageId: environmentContextArtifacts.libraryPageId,
            createdAt: environmentContextArtifacts.createdAt,
            updatedAt: environmentContextArtifacts.updatedAt,
            pageTitle: libraryPages.title,
          })
          .from(environmentContextArtifacts)
          .leftJoin(libraryPages, eq(environmentContextArtifacts.libraryPageId, libraryPages.id))
          .where(eq(environmentContextArtifacts.environmentId, environmentId));
      } catch (err) {
        log.warn("Context artifact query failed", { error: err instanceof Error ? err.message : String(err), environmentId });
      }

      const inferred = inferredEnvironmentConfig(row.platform_product_environments.name);
      const source = sourceRows[0]
        ? { ...sourceRows[0], connection: connectionRows.find(connection => connection.id === sourceRows[0].connectionId) || null, inferred: false }
        : { ...inferred.source, connection: null };
      const hosting = hostingRows[0]
        ? { ...hostingRows[0], connection: connectionRows.find(connection => connection.id === hostingRows[0].connectionId) || null, inferred: false }
        : { ...inferred.hosting, connection: null };
      const persistedKeys = new Set(runtimeRows.map(variable => variable.key));
      const variables = [
        ...runtimeRows.map(variable => ({ ...variable, inferred: false })),
        ...runtimeVariableTemplates
          .filter(variable => !persistedKeys.has(variable.key))
          .map(variable => ({
            id: null,
            environmentId,
            ...variable,
            configured: Boolean(getSecretSync(variable.key) || process.env[variable.key]),
            secretRef: null,
            lastVerifiedAt: null,
            inferred: true,
          })),
      ];

      res.json({
        platform: row.platforms,
        product: row.platform_products,
        environment: {
          ...row.platform_product_environments,
          kind: environmentKind(row.platform_product_environments.name),
          status: hostingRows[0] || sourceRows[0] || environmentKind(row.platform_product_environments.name) !== "staging" ? "configured" : "planned",
        },
        source,
        hosting,
        runtimeVariables: variables,
        capabilities: capabilityRows.map(r => ({
          ...r,
          secretEnvelope: undefined,
          hasSecret: !!r.secretEnvelope,
          connection: r.connectionId ? connectionRows.find(c => c.id === r.connectionId) || null : null,
        })),
        contextArtifacts: contextArtifactRows.map(r => ({
          id: r.id,
          environmentId: r.environmentId,
          kind: r.kind,
          libraryPageId: r.libraryPageId,
          pageTitle: r.pageTitle || "Untitled",
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })),
        services: {
          database: variables.find(variable => variable.key === "DATABASE_URL") || null,
          objectStorage: variables.filter(variable => variable.category === "storage"),
        },
        deploymentState: {
          status: "read-only",
          latestDeploymentId: null,
          latestCommitSha: null,
          deployedAt: null,
          note: "Deployment state remains sourced from existing Railway tooling until cutover.",
        },
        promotion: {
          mode: "branch-merge",
          sourceBranch: inferredBranch(row.platform_product_environments.name),
          targetBranch: environmentKind(row.platform_product_environments.name) === "development" ? "staging" : environmentKind(row.platform_product_environments.name) === "staging" ? "live" : null,
        },
      });
    } catch (error: unknown) {
      const err = routeError(error, "get_environment_details");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/platforms/environments/:environmentId/build-lifecycle", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const lifecycle = await getEnvironmentBuildLifecycleConfig(environmentId, { includeDisabled: req.query.includeDisabled === "true" });
      if (!lifecycle) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "get_build_lifecycle" });
      res.json(lifecycle);
    } catch (error: unknown) {
      const err = routeError(error, "get_build_lifecycle");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.put("/api/platforms/environments/:environmentId/build-lifecycle", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const config = await setEnvironmentBuildLifecycleConfig(environmentId, req.body || {});
      res.json(config);
    } catch (error: unknown) {
      const err = routeError(error, "set_build_lifecycle");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/platforms/environments/:environmentId/build-lifecycle/disable", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      res.json({ disabled: true, config: await disableEnvironmentBuildLifecycleConfig(environmentId) });
    } catch (error: unknown) {
      const err = routeError(error, "disable_build_lifecycle");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/platforms/environments/:environmentId/build-lifecycle", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      res.json(await deleteEnvironmentBuildLifecycleConfigs(environmentId));
    } catch (error: unknown) {
      const err = routeError(error, "delete_build_lifecycle");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  async function cloudflareContext(environmentId: number) {
    const writable = await ensureEnvironmentWritable(environmentId);
    if (!writable) throw new Error(`Environment ${environmentId} not found or not writable`);
    const [binding] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, environmentId)).limit(1);
    if (!binding || binding.provider !== "cloudflare" || !binding.connectionId || !binding.projectId || !binding.projectName) throw new Error("Environment has no complete Cloudflare Pages hosting binding");
    const [connection] = await db.select({ credentialRef: providerConnections.credentialRef }).from(providerConnections).where(visibleProviderConnection(eq(providerConnections.id, binding.connectionId))).limit(1);
    if (!connection?.credentialRef) throw new Error("Cloudflare provider connection has no credential");
    const token = await getProviderCredential(connection.credentialRef);
    if (!token) throw new Error("Cloudflare provider credential could not be decrypted");
    return { token, accountId: binding.projectId, projectName: binding.projectName };
  }

  app.get("/api/platforms/environments/:environmentId/cloudflare-pages", requirePermission("build:read"), async (req, res) => {
    try { const c = await cloudflareContext(platformIdParam(req.params.environmentId)); res.json(await getCloudflarePagesProjectTruth(c.token, c.accountId, c.projectName)); }
    catch (error) { const err = routeError(error, "get_cloudflare_pages_project"); res.status(400).json({ outcome: "provider_error", diagnostic: err.message }); }
  });

  app.post("/api/platforms/environments/:environmentId/cloudflare-pages/actions", requirePermission("build:write"), async (req, res) => {
    try {
      const c = await cloudflareContext(platformIdParam(req.params.environmentId));
      const action = String(req.body?.action || "");
      const deploymentId = typeof req.body?.deploymentId === "string" ? req.body.deploymentId : "";
      if (action === "deploy") return res.json(await triggerCloudflarePagesProductionDeployment(c.token, c.accountId, c.projectName));
      if (action === "retry" && deploymentId) return res.json(await retryCloudflarePagesDeployment(c.token, c.accountId, c.projectName, deploymentId));
      if (action === "cancel" && deploymentId) return res.json(await cancelCloudflarePagesDeployment(c.token, c.accountId, c.projectName, deploymentId));
      if (action === "repair") return res.json(await repairCloudflarePagesProject(c.token, c.accountId, c.projectName, (req.body?.repair || {}) as CloudflareProjectRepair));
      return res.status(400).json({ outcome: "rejected", diagnostic: "Unsupported Cloudflare Pages action or missing deployment ID" });
    } catch (error) { const err = routeError(error, "cloudflare_pages_action"); res.status(400).json({ outcome: "provider_error", diagnostic: err.message }); }
  });

  app.get("/api/platforms/environments/:environmentId/build-status", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const status = await getEnvironmentBuildStatus(environmentId);
      if (!status) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "get_build_status" });
      res.json(status);
    } catch (error: unknown) {
      const err = routeError(error, "get_build_status");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/platforms/environments/:environmentId/build-workflows", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const workflows = await listEnvironmentBuildWorkflows(environmentId, Number(req.query.limit) || 20);
      if (!workflows) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "list_environment_workflows" });
      res.json(workflows);
    } catch (error: unknown) {
      const err = routeError(error, "list_environment_workflows");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/platforms/environments/:environmentId/build-workflows/start", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      res.status(201).json(await startEnvironmentBuildWorkflow(environmentId, req.body || {}));
    } catch (error: unknown) {
      const err = routeError(error, "start_build_workflow");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  // Fetch live deployment status for an environment (provider-aware: Railway or Cloudflare Pages)
  app.get("/api/platforms/environments/:environmentId/status", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);

      // Look up hosting binding with connection
      let hostingRow: { provider: string; connectionId: number | null; projectId: string | null; projectName: string | null; serviceId: string | null; providerEnvironmentId: string | null; publicUrl: string | null } | undefined;
      try {
        const rows = await db
          .select({
            provider: environmentHostingBindings.provider,
            connectionId: environmentHostingBindings.connectionId,
            projectId: environmentHostingBindings.projectId,
            projectName: environmentHostingBindings.projectName,
            serviceId: environmentHostingBindings.serviceId,
            providerEnvironmentId: environmentHostingBindings.providerEnvironmentId,
            publicUrl: environmentHostingBindings.publicUrl,
          })
          .from(environmentHostingBindings)
          .innerJoin(platformProductEnvironments, eq(environmentHostingBindings.environmentId, platformProductEnvironments.id))
          .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
          .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
          .where(and(eq(environmentHostingBindings.environmentId, environmentId), visiblePlatform()))
          .limit(1);
        hostingRow = rows[0];
      } catch (err) {
        log.debug("Hosting binding table query failed", { error: err instanceof Error ? err.message : String(err) });
      }

      if (!hostingRow?.connectionId) {
        return res.json({
          available: false,
          reason: "No hosting connection configured",
          deployment: null,
          urlReachable: null,
        });
      }

      // Get the credential ref and decrypt token
      const [connection] = await db
        .select({ credentialRef: providerConnections.credentialRef, provider: providerConnections.provider })
        .from(providerConnections)
        .where(visibleProviderConnection(eq(providerConnections.id, hostingRow.connectionId)))
        .limit(1);

      if (!connection?.credentialRef) {
        return res.json({
          available: false,
          reason: "Connection has no stored credential",
          deployment: null,
          urlReachable: null,
        });
      }

      const token = await getProviderCredential(connection.credentialRef);
      if (!token) {
        return res.json({
          available: false,
          reason: "Could not decrypt credential",
          deployment: null,
          urlReachable: null,
        });
      }

      // Fetch latest deployment based on provider
      let deployment: Record<string, unknown> | null = null;
      const hostingProvider = hostingRow.provider || connection.provider || "railway";

      if (hostingProvider === "cloudflare") {
        // Cloudflare Pages: projectId = account ID, projectName = Pages project name
        if (hostingRow.projectId && hostingRow.projectName) {
          try {
            const cfEnv = hostingRow.providerEnvironmentId || "production";
            const latest = await getCloudflareLatestDeployment(token, hostingRow.projectId, hostingRow.projectName, cfEnv);
            if (latest) {
              deployment = {
                id: latest.id,
                status: latest.status,
                environment: latest.environment,
                commitSha: latest.commitHash,
                commitMessage: latest.commitMessage,
                branch: latest.branch,
                url: latest.url,
                deployedAt: latest.createdAt,
              };
            }
          } catch (err) {
            log.warn(`Cloudflare Pages status fetch failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      } else {
        // Railway (default)
        if (hostingRow.serviceId && hostingRow.providerEnvironmentId && hostingRow.projectId) {
          try {
            const latest = await getLatestDeploymentByToken(token, hostingRow.projectId, hostingRow.serviceId, hostingRow.providerEnvironmentId);
            if (latest) {
              deployment = {
                id: latest.id,
                status: latest.status,
                commitSha: latest.commitHash,
                deployedAt: latest.createdAt,
              };
            }
          } catch (err) {
            log.warn(`Railway status fetch failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      // URL reachability check
      let urlReachable: boolean | null = null;
      const publicUrl = hostingRow.publicUrl;
      if (publicUrl) {
        try {
          const healthUrl = publicUrl.startsWith("http") ? publicUrl : `https://${publicUrl}`;
          const healthRes = await fetch(healthUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
          urlReachable = healthRes.ok;
        } catch (err) {
          log.debug("URL reachability check failed", { url: publicUrl, error: err instanceof Error ? err.message : String(err) });
          urlReachable = false;
        }
      }

      res.json({
        available: true,
        provider: hostingProvider,
        deployment,
        urlReachable,
        publicUrl,
      });
    } catch (error: unknown) {
      const err = routeError(error, "get_environment_status");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // Upsert source binding for an environment
  app.put("/api/platforms/environments/:environmentId/source-binding", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const env = await ensureEnvironmentWritable(environmentId);
      if (!env) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "upsert_source_binding" });

      const parsed = upsertSourceBindingSchema.parse(req.body);
      
      // Verify connectionId is visible to the current user before saving
      if (parsed.connectionId) {
        const [conn] = await db.select({ id: providerConnections.id }).from(providerConnections)
          .where(visibleProviderConnection(eq(providerConnections.id, parsed.connectionId))).limit(1);
        if (!conn) return res.status(404).json({ error: `Connection ${parsed.connectionId} not found`, operation: "upsert_source_binding" });
      }
      
      const values: Record<string, unknown> = { environmentId, updatedAt: sql`CURRENT_TIMESTAMP` };
      if (parsed.connectionId !== undefined) values.connectionId = parsed.connectionId;
      if (parsed.owner !== undefined) values.owner = parsed.owner;
      if (parsed.repo !== undefined) values.repo = parsed.repo;
      if (parsed.branch !== undefined) values.branch = parsed.branch;
      if (parsed.autoDeploy !== undefined) values.autoDeploy = parsed.autoDeploy;
      if (parsed.codeIndexingEnabled !== undefined) values.codeIndexingEnabled = parsed.codeIndexingEnabled;

      const [existing] = await db
        .select({ id: environmentSourceBindings.id })
        .from(environmentSourceBindings)
        .where(eq(environmentSourceBindings.environmentId, environmentId))
        .limit(1);

      if (existing) {
        await db
          .update(environmentSourceBindings)
          .set(values)
          .where(eq(environmentSourceBindings.id, existing.id));
      } else {
        values.provider = "github";
        await db.insert(environmentSourceBindings).values(values as typeof environmentSourceBindings.$inferInsert);
      }

      // Return the full environment details so the client gets the updated state
      // Redirect internally to the details handler by re-requesting
      const [sourceRow] = await db.select().from(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, environmentId));
      const connection = sourceRow?.connectionId
        ? (await db.select().from(providerConnections).where(visibleProviderConnection(eq(providerConnections.id, sourceRow.connectionId))).limit(1))[0] || null
        : null;
      res.json({ ...sourceRow, connection, inferred: false });
    } catch (error: unknown) {
      const err = routeError(error, "upsert_source_binding");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  // Upsert hosting binding for an environment
  app.put("/api/platforms/environments/:environmentId/hosting-binding", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const env = await ensureEnvironmentWritable(environmentId);
      if (!env) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "upsert_hosting_binding" });

      const parsed = upsertHostingBindingSchema.parse(req.body);
      
      // Verify connectionId is visible to the current user before saving
      if (parsed.connectionId) {
        const [conn] = await db.select({ id: providerConnections.id }).from(providerConnections)
          .where(visibleProviderConnection(eq(providerConnections.id, parsed.connectionId))).limit(1);
        if (!conn) return res.status(404).json({ error: `Connection ${parsed.connectionId} not found`, operation: "upsert_hosting_binding" });
      }
      
      const values: Record<string, unknown> = { environmentId, updatedAt: sql`CURRENT_TIMESTAMP` };
      if (parsed.connectionId !== undefined) values.connectionId = parsed.connectionId;
      if (parsed.projectId !== undefined) values.projectId = parsed.projectId;
      if (parsed.projectName !== undefined) values.projectName = parsed.projectName;
      if (parsed.providerEnvironmentId !== undefined) values.providerEnvironmentId = parsed.providerEnvironmentId;
      if (parsed.providerEnvironmentName !== undefined) values.providerEnvironmentName = parsed.providerEnvironmentName;
      if (parsed.serviceId !== undefined) values.serviceId = parsed.serviceId;
      if (parsed.serviceName !== undefined) values.serviceName = parsed.serviceName;
      if (parsed.publicUrl !== undefined) values.publicUrl = parsed.publicUrl;
      if (parsed.staticUrl !== undefined) values.staticUrl = parsed.staticUrl;

      const [existing] = await db
        .select({ id: environmentHostingBindings.id })
        .from(environmentHostingBindings)
        .where(eq(environmentHostingBindings.environmentId, environmentId))
        .limit(1);

      // Infer provider from the linked connection when creating a new binding
      if (parsed.connectionId) {
        const [linkedConn] = await db.select({ provider: providerConnections.provider }).from(providerConnections)
          .where(visibleProviderConnection(eq(providerConnections.id, parsed.connectionId))).limit(1);
        if (linkedConn?.provider) values.provider = linkedConn.provider;
      }

      if (existing) {
        await db
          .update(environmentHostingBindings)
          .set(values)
          .where(eq(environmentHostingBindings.id, existing.id));
      } else {
        if (!values.provider) values.provider = "railway";
        await db.insert(environmentHostingBindings).values(values as typeof environmentHostingBindings.$inferInsert);
      }

      const [hostingRow] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, environmentId));
      const connection = hostingRow?.connectionId
        ? (await db.select().from(providerConnections).where(visibleProviderConnection(eq(providerConnections.id, hostingRow.connectionId))).limit(1))[0] || null
        : null;
      res.json({ ...hostingRow, connection, inferred: false });
    } catch (error: unknown) {
      const err = routeError(error, "upsert_hosting_binding");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/platforms", async (req, res) => {
    try {
      const parsed = insertPlatformSchema.parse(req.body);
      const principal = getCurrentPrincipalOrSystem();
      const [created] = await db.insert(platforms).values({ ...parsed, ...ownedInsertValues(principal, platformScopeColumns) }).returning();
      res.status(201).json({ ...created, products: [] });
    } catch (error: unknown) {
      const err = routeError(error, "create_platform");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.patch("/api/platforms/:id", async (req, res) => {
    try {
      const id = platformIdParam(req.params.id);
      const parsed = insertPlatformSchema.partial().parse(req.body);
      const [updated] = await db.update(platforms).set({ ...parsed, updatedAt: sql`CURRENT_TIMESTAMP` }).where(writablePlatform(eq(platforms.id, id))).returning();
      if (!updated) return res.status(404).json({ error: `Platform ${id} not found`, operation: "update_platform" });
      res.json(updated);
    } catch (error: unknown) {
      const err = routeError(error, "update_platform");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/platforms/:id", async (req, res) => {
    try {
      const id = platformIdParam(req.params.id);
      const [deleted] = await db.delete(platforms).where(writablePlatform(eq(platforms.id, id))).returning({ id: platforms.id });
      if (!deleted) return res.status(404).json({ error: `Platform ${id} not found`, operation: "delete_platform" });
      res.json({ success: true });
    } catch (error: unknown) {
      const err = routeError(error, "delete_platform");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/platforms/:id/products", async (req, res) => {
    try {
      const platformId = platformIdParam(req.params.id);
      if (!(await ensurePlatformWritable(platformId))) return res.status(404).json({ error: `Platform ${platformId} not found`, operation: "create_platform_product" });
      const parsed = insertPlatformProductSchema.parse(req.body);
      const [created] = await db.insert(platformProducts).values({ ...parsed, platformId }).returning();
      const defaultEnvironments = ["dev", "stage", "live"].map((name) => ({ productId: created.id, name }));
      const environments = await db.insert(platformProductEnvironments).values(defaultEnvironments).returning();
      await db.update(platforms).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(writablePlatform(eq(platforms.id, platformId)));
      res.status(201).json({ ...created, environments });
    } catch (error: unknown) {
      const err = routeError(error, "create_platform_product");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.patch("/api/platforms/:platformId/products/:productId", async (req, res) => {
    try {
      const platformId = platformIdParam(req.params.platformId);
      const productId = platformIdParam(req.params.productId);
      if (!(await ensurePlatformWritable(platformId))) return res.status(404).json({ error: `Platform ${platformId} not found`, operation: "update_platform_product" });
      const parsed = insertPlatformProductSchema.partial().parse(req.body);
      const [updated] = await db.update(platformProducts).set({ ...parsed, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(platformProducts.id, productId), eq(platformProducts.platformId, platformId))).returning();
      if (!updated) return res.status(404).json({ error: `Product ${productId} not found`, operation: "update_platform_product" });
      await db.update(platforms).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(writablePlatform(eq(platforms.id, platformId)));
      res.json(updated);
    } catch (error: unknown) {
      const err = routeError(error, "update_platform_product");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });


  app.post("/api/platforms/:platformId/products/:productId/environments", async (req, res) => {
    try {
      const platformId = platformIdParam(req.params.platformId);
      const productId = platformIdParam(req.params.productId);
      if (!(await ensureProductWritable(platformId, productId))) return res.status(404).json({ error: `Product ${productId} not found`, operation: "create_product_environment" });
      const parsed = insertPlatformProductEnvironmentSchema.parse(req.body);
      const [created] = await db.insert(platformProductEnvironments).values({ ...parsed, productId }).returning();
      await db.update(platformProducts).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(platformProducts.id, productId), eq(platformProducts.platformId, platformId)));
      await db.update(platforms).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(writablePlatform(eq(platforms.id, platformId)));
      res.status(201).json(created);
    } catch (error: unknown) {
      const err = routeError(error, "create_product_environment");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/platforms/:platformId/products/:productId/environments/:environmentId", async (req, res) => {
    try {
      const platformId = platformIdParam(req.params.platformId);
      const productId = platformIdParam(req.params.productId);
      const environmentId = platformIdParam(req.params.environmentId);
      if (!(await ensureProductWritable(platformId, productId))) return res.status(404).json({ error: `Product ${productId} not found`, operation: "delete_product_environment" });
      const [deleted] = await db.delete(platformProductEnvironments).where(and(eq(platformProductEnvironments.id, environmentId), eq(platformProductEnvironments.productId, productId))).returning({ id: platformProductEnvironments.id });
      if (!deleted) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "delete_product_environment" });
      await db.update(platformProducts).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(platformProducts.id, productId), eq(platformProducts.platformId, platformId)));
      await db.update(platforms).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(writablePlatform(eq(platforms.id, platformId)));
      res.json({ success: true });
    } catch (error: unknown) {
      const err = routeError(error, "delete_product_environment");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/platforms/:platformId/products/:productId", async (req, res) => {
    try {
      const platformId = platformIdParam(req.params.platformId);
      const productId = platformIdParam(req.params.productId);
      if (!(await ensurePlatformWritable(platformId))) return res.status(404).json({ error: `Platform ${platformId} not found`, operation: "delete_platform_product" });
      const [deleted] = await db.delete(platformProducts).where(and(eq(platformProducts.id, productId), eq(platformProducts.platformId, platformId))).returning({ id: platformProducts.id });
      if (!deleted) return res.status(404).json({ error: `Product ${productId} not found`, operation: "delete_platform_product" });
      await db.update(platforms).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(writablePlatform(eq(platforms.id, platformId)));
      res.json({ success: true });
    } catch (error: unknown) {
      const err = routeError(error, "delete_platform_product");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // ---------------------------------------------------------------------------
  // Capability bindings — provider-specific service bindings (R2, Pages, etc.)
  // ---------------------------------------------------------------------------

  // List capability bindings for an environment
  app.get("/api/platforms/environments/:environmentId/capability-bindings", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      let rows: EnvironmentCapabilityBinding[] = [];
      try {
        rows = await db
          .select()
          .from(environmentCapabilityBindings)
          .where(eq(environmentCapabilityBindings.environmentId, environmentId))
          .orderBy(environmentCapabilityBindings.capabilityType);
      } catch {
        // Table may not exist yet during migration
      }
      // Strip secret envelopes from response
      res.json(rows.map(r => ({ ...r, secretEnvelope: undefined, hasSecret: !!r.secretEnvelope })));
    } catch (error: unknown) {
      const err = routeError(error, "list_capability_bindings");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // Upsert capability binding for an environment
  app.put("/api/platforms/environments/:environmentId/capability-bindings", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const env = await ensureEnvironmentWritable(environmentId);
      if (!env) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "upsert_capability_binding" });

      const { secret, ...rest } = req.body as Record<string, unknown>;
      const parsed = upsertCapabilityBindingSchema.parse(rest);

      // Verify connectionId if provided
      if (parsed.connectionId) {
        const [conn] = await db.select({ id: providerConnections.id }).from(providerConnections)
          .where(visibleProviderConnection(eq(providerConnections.id, parsed.connectionId))).limit(1);
        if (!conn) return res.status(404).json({ error: `Connection ${parsed.connectionId} not found`, operation: "upsert_capability_binding" });
      }

      const values: Record<string, unknown> = {
        environmentId,
        capabilityType: parsed.capabilityType,
        provider: parsed.provider,
        config: parsed.config,
        enabled: parsed.enabled,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      };
      if (parsed.connectionId !== undefined) values.connectionId = parsed.connectionId;

      // Encrypt capability-specific secret if provided (e.g. R2 S3 access keys as JSON)
      if (secret && typeof secret === "string" && secret.trim()) {
        const envelope = await encrypt(secret.trim(), getEncryptionKey());
        values.secretEnvelope = envelope;
        values.secretLast4 = secret.trim().length >= 4 ? secret.trim().slice(-4) : "****";
      }

      // Upsert by (environmentId, capabilityType, provider) unique constraint
      const [existing] = await db
        .select({ id: environmentCapabilityBindings.id })
        .from(environmentCapabilityBindings)
        .where(and(
          eq(environmentCapabilityBindings.environmentId, environmentId),
          eq(environmentCapabilityBindings.capabilityType, parsed.capabilityType),
          eq(environmentCapabilityBindings.provider, parsed.provider),
        ))
        .limit(1);

      let row: EnvironmentCapabilityBinding;
      if (existing) {
        [row] = await db
          .update(environmentCapabilityBindings)
          .set(values)
          .where(eq(environmentCapabilityBindings.id, existing.id))
          .returning();
      } else {
        [row] = await db
          .insert(environmentCapabilityBindings)
          .values(values as typeof environmentCapabilityBindings.$inferInsert)
          .returning();
      }

      // Re-warm storage config if this is an object_storage binding
      if (parsed.capabilityType === "object_storage") {
        import("../object_storage/s3-backend").then(m => m.warmStorageConfig()).catch(() => {});
      }

      res.json({ ...row, secretEnvelope: undefined, hasSecret: !!row.secretEnvelope });
    } catch (error: unknown) {
      const err = routeError(error, "upsert_capability_binding");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  // Delete a capability binding
  app.delete("/api/platforms/environments/:environmentId/capability-bindings/:bindingId", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const bindingId = platformIdParam(req.params.bindingId);
      const env = await ensureEnvironmentWritable(environmentId);
      if (!env) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "delete_capability_binding" });

      const [deleted] = await db
        .delete(environmentCapabilityBindings)
        .where(and(
          eq(environmentCapabilityBindings.id, bindingId),
          eq(environmentCapabilityBindings.environmentId, environmentId),
        ))
        .returning({ id: environmentCapabilityBindings.id });

      if (!deleted) return res.status(404).json({ error: `Binding ${bindingId} not found`, operation: "delete_capability_binding" });

      // Re-warm storage config in case an object_storage binding was removed
      import("../object_storage/s3-backend").then(m => m.warmStorageConfig()).catch(() => {});

      res.json({ success: true });
    } catch (error: unknown) {
      const err = routeError(error, "delete_capability_binding");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // ── Context Artifacts ──

  // List context artifacts for an environment
  app.get("/api/platforms/environments/:environmentId/context-artifacts", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const { libraryPages } = await import("@shared/models/info");
      const rows = await db
        .select({
          id: environmentContextArtifacts.id,
          environmentId: environmentContextArtifacts.environmentId,
          kind: environmentContextArtifacts.kind,
          libraryPageId: environmentContextArtifacts.libraryPageId,
          createdAt: environmentContextArtifacts.createdAt,
          updatedAt: environmentContextArtifacts.updatedAt,
          pageTitle: libraryPages.title,
        })
        .from(environmentContextArtifacts)
        .leftJoin(libraryPages, eq(environmentContextArtifacts.libraryPageId, libraryPages.id))
        .where(eq(environmentContextArtifacts.environmentId, environmentId));

      res.json(rows.map(r => ({
        id: r.id,
        environmentId: r.environmentId,
        kind: r.kind,
        libraryPageId: r.libraryPageId,
        pageTitle: r.pageTitle || "Untitled",
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })));
    } catch (error: unknown) {
      const err = routeError(error, "list_context_artifacts");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // Upsert context artifact for an environment
  app.put("/api/platforms/environments/:environmentId/context-artifacts", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const env = await ensureEnvironmentWritable(environmentId);
      if (!env) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "save_context_artifact" });

      const parsed = upsertContextArtifactSchema.parse(req.body);

      // Verify library page exists
      const { libraryPages } = await import("@shared/models/info");
      const [page] = await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(eq(libraryPages.id, parsed.libraryPageId)).limit(1);
      if (!page) return res.status(404).json({ error: `Library page ${parsed.libraryPageId} not found`, operation: "save_context_artifact" });

      // Prevent duplicate: same environment + kind + libraryPageId
      const [existingDup] = await db
        .select({ id: environmentContextArtifacts.id })
        .from(environmentContextArtifacts)
        .where(and(
          eq(environmentContextArtifacts.environmentId, environmentId),
          eq(environmentContextArtifacts.kind, parsed.kind),
          eq(environmentContextArtifacts.libraryPageId, parsed.libraryPageId),
        ))
        .limit(1);

      if (existingDup) {
        // Already linked — return existing without error
        return res.json({ ...existingDup, kind: parsed.kind, libraryPageId: parsed.libraryPageId, pageTitle: page.title || "Untitled", environmentId });
      }

      const [saved] = await db
        .insert(environmentContextArtifacts)
        .values({ environmentId, kind: parsed.kind, libraryPageId: parsed.libraryPageId })
        .returning();

      res.json({ ...saved, pageTitle: page.title || "Untitled" });
    } catch (error: unknown) {
      const err = routeError(error, "save_context_artifact");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  // Delete context artifact by ID or by (kind + libraryPageId) for an environment
  app.delete("/api/platforms/environments/:environmentId/context-artifacts/:kindOrId", async (req, res) => {
    try {
      const environmentId = platformIdParam(req.params.environmentId);
      const kindOrId = req.params.kindOrId;
      const env = await ensureEnvironmentWritable(environmentId);
      if (!env) return res.status(404).json({ error: `Environment ${environmentId} not found`, operation: "delete_context_artifact" });

      // Try numeric ID first
      const numericId = parseInt(kindOrId, 10);
      let deleted;
      if (!isNaN(numericId)) {
        [deleted] = await db
          .delete(environmentContextArtifacts)
          .where(and(
            eq(environmentContextArtifacts.id, numericId),
            eq(environmentContextArtifacts.environmentId, environmentId),
          ))
          .returning({ id: environmentContextArtifacts.id });
      }

      // Fallback: delete by kind (backward compat — deletes first match)
      if (!deleted) {
        [deleted] = await db
          .delete(environmentContextArtifacts)
          .where(and(
            eq(environmentContextArtifacts.environmentId, environmentId),
            eq(environmentContextArtifacts.kind, kindOrId),
          ))
          .returning({ id: environmentContextArtifacts.id });
      }

      if (!deleted) return res.status(404).json({ error: `Context artifact '${kindOrId}' not found for environment ${environmentId}`, operation: "delete_context_artifact" });

      res.json({ success: true });
    } catch (error: unknown) {
      const err = routeError(error, "delete_context_artifact");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });
}
