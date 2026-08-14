import type { Express, Request, Response } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { environmentSourceBindings } from "@shared/models/platforms";
import { privilegedAccessAudit } from "@shared/schema";
import { ADVISORY_LOCK_NS, acquireAdvisoryTransactionLock } from "../../db";
import { requireAuth, requireAdmin } from "../../auth";
import { db } from "../../db";
import { requirePermission } from "../../permissions";
import { composeStageLifecycleStatus, deriveStageLifecycleCapabilities, isMantraWebStageIdentity } from "../../platforms/stage-lifecycle-status";
import { getEnvironmentBuildLifecycleConfig, setEnvironmentBuildLifecycleConfig } from "../../platforms/build-lifecycle-service";
import { createLogger } from "../../log";
import { RailwayApiError } from "./client";
import {
  fetchEnvironmentBuildLogs,
  fetchEnvironmentDeployments,
  enableWarmStageRuntimeVariable,
  fetchEnvironmentRuntimeLogs,
  findInFlightEnvironmentDeployment,
  listEnvironmentVariableNames,
  redeployEnvironment,
  resolveEnvironmentDeploymentId,
  resolveRailwayEnvironmentControl,
  restartEnvironment,
  serializeEnvironmentDeployment,
  setStageSyncTargetVariable,
  verifyRailwayEnvironmentCapability,
} from "./environment-control";
import { readStageSyncStatus, resolveBoundBranchHead, writeStageSyncStatus } from "../../stage-sync";
import {
  checkPrereqs,
  getDisplayRun,
  startRun,
  buildDraftPreview,
  cancelRun,
  retryRun,
  toPublicRun,
  reconcileLiveIntoDev,
  PublishInFlightError,
  PublishNotReadyError,
  NothingToPublishError,
  type PublicPublishRun,
} from "./publish";
import { getReleaseVersionSummary, type VersionIncrement } from "./release-versioning";
import {
  compareRefs,
  getBranchHead,
  toPublishCommit,
  type PublishCommit,
} from "../github-pr";
import { storage } from "../../storage";
import { requireModRouteGroup } from "../../mods/mod-access";
const requireActiveBuild = requireModRouteGroup("build.railway");
interface PublishCommitHead {
  sha: string;
  shortSha: string;
  message: string;
}

/**
 * Wire format returned by GET /api/railway/publish/summary. Mirrored on the
 * client in `client/src/components/dev-publish-tab.tsx` (PublishSummary).
 */
interface PublishSummaryResponse {
  ready: boolean;
  sourcePlatformEnvironmentId: number;
  targetPlatformEnvironmentId: number;
  reason: string | null;
  repo: string | null;
  devBranch: string | null;
  prodBranch: string;
  prodUrl: string | null;
  devCommit: PublishCommitHead | null;
  prodCommit: PublishCommitHead | null;
  aheadBy: number;
  commits: PublishCommit[];
  compareError: string | null;
  versioning: Awaited<ReturnType<typeof getReleaseVersionSummary>>;
  run: PublicPublishRun | null;
}

/** Extract the publish actor (user id + display name) from the request. */
async function resolvePublishActor(req: Request): Promise<{ id: string; name: string | null }> {
  const userId = req.session?.userId ?? "";
  const user = userId ? await storage.getUser(userId) : null;
  return {
    id: userId || "admin",
    name: user?.email ?? null,
  };
}

const log = createLogger("RailwayRoutes");

function handleError(res: Response, err: unknown, fallback = "Railway request failed") {
  if (err instanceof RailwayApiError) {
    return res.status(err.status >= 400 && err.status < 600 ? err.status : 500).json({ error: err.message });
  }
  const msg = err instanceof Error ? err.message : String(err);
  log.error(`${fallback}: ${msg}`);
  return res.status(500).json({ error: msg || fallback });
}

export function registerRailwayRoutes(app: Express) {
  app.use("/api/railway", requireAuth, requireActiveBuild);

  const environmentParamsSchema = z.object({
    platformEnvironmentId: z.coerce.number().int().positive(),
  });
  const deploymentQuerySchema = z.object({
    deploymentId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  const deploymentBodySchema = z.object({ deploymentId: z.string().min(1).optional() });
  const fullRebuildBodySchema = z.object({
    deploymentId: z.string().min(1).optional(),
    confirmation: z.literal("FULL_REBUILD"),
    idempotencyKey: z.string().trim().min(8).max(200),
  });
  const enableWarmStageBodySchema = z.object({
    confirmation: z.literal("ENABLE_WARM_STAGE"),
    idempotencyKey: z.string().trim().min(8).max(200),
  });
  const syncLatestBodySchema = z.object({
    idempotencyKey: z.string().trim().min(8).max(200),
  });
  const publishContextSchema = z.object({
    sourcePlatformEnvironmentId: z.coerce.number().int().positive(),
    targetPlatformEnvironmentId: z.coerce.number().int().positive(),
  });
  const parsePublishContext = (input: unknown) => publishContextSchema.safeParse(input);
  const releaseNotesSchema = z.object({
    newFeatures: z.array(z.string()).default([]),
    improvements: z.array(z.string()).default([]),
    fixes: z.array(z.string()).default([]),
  });

  const parseEnvironment = async (req: Request, res: Response) => {
    const parsed = environmentParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "platformEnvironmentId must be a positive integer" });
      return null;
    }
    try {
      return await resolveRailwayEnvironmentControl(parsed.data.platformEnvironmentId);
    } catch (error) {
      handleError(res, error, "Platform Environment resolution failed");
      return null;
    }
  };

  app.get("/api/railway/runtime/status", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const control = await resolveRailwayEnvironmentControl(undefined, { allowCurrentRuntime: true });
      const deployments = await fetchEnvironmentDeployments(control, 1);
      res.json({
        configured: true,
        platformEnvironmentId: control.environment.platformEnvironmentId,
        environmentName: control.environment.platformEnvironmentName,
        devUrl: control.publicUrl,
        prodUrl: control.publicUrl,
        projectId: control.projectId,
        environmentId: control.railwayEnvironmentId,
        serviceId: control.serviceId,
        deployment: serializeEnvironmentDeployment(deployments[0] ?? null),
        statusError: null,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      handleError(res, error, "runtime status failed");
    }
  });


  app.get("/api/railway/runtime/deployments", requireAuth, requireAdmin, async (req, res) => {
    const parsed = deploymentQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid deployments query" });
    try {
      const control = await resolveRailwayEnvironmentControl(undefined, { allowCurrentRuntime: true });
      const deployments = await fetchEnvironmentDeployments(control, Math.min(parsed.data.limit ?? 20, 50));
      res.json({ platformEnvironmentId: control.environment.platformEnvironmentId,
        deployments: deployments.map(serializeEnvironmentDeployment) });
    } catch (error) {
      handleError(res, error, "runtime deployments failed");
    }
  });


  app.get("/api/railway/runtime/logs", requireAuth, requireAdmin, async (req, res) => {
    const parsed = deploymentQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid logs query" });
    try {
      const control = await resolveRailwayEnvironmentControl(undefined, { allowCurrentRuntime: true });
      const deploymentId = await resolveEnvironmentDeploymentId(control, parsed.data.deploymentId);
      const logs = deploymentId ? await fetchEnvironmentRuntimeLogs(control, deploymentId, parsed.data.limit ?? 200) : [];
      res.json({ platformEnvironmentId: control.environment.platformEnvironmentId, deploymentId, logs });
    } catch (error) {
      handleError(res, error, "runtime logs failed");
    }
  });

  app.get("/api/railway/runtime/variables", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const control = await resolveRailwayEnvironmentControl(undefined, { allowCurrentRuntime: true });
      const names = await listEnvironmentVariableNames(control);
      res.json({ platformEnvironmentId: control.environment.platformEnvironmentId,
        variables: names.map((name) => ({ name, value: "", source: "Railway", isSecret: true })) });
    } catch (error) {
      handleError(res, error, "runtime variables failed");
    }
  });

  app.get("/api/railway/environments/:platformEnvironmentId/status", requireAuth, requireActiveBuild, requirePermission("build:read"), async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    try {
      const [source] = await db.select({
        owner: environmentSourceBindings.owner,
        repo: environmentSourceBindings.repo,
        branch: environmentSourceBindings.branch,
      }).from(environmentSourceBindings)
        .where(eq(environmentSourceBindings.environmentId, control.environment.platformEnvironmentId))
        .limit(1);
      const [lifecycleResult, deploymentsResult, targetResult, warmSyncResult] = await Promise.allSettled([
        getEnvironmentBuildLifecycleConfig(control.environment.platformEnvironmentId, { includeDisabled: true }),
        fetchEnvironmentDeployments(control, 20),
        source?.owner && source.repo && source.branch
          ? getBranchHead({ owner: source.owner, repo: source.repo }, source.branch)
          : Promise.resolve(null),
        readStageSyncStatus(control.environment.platformEnvironmentId),
      ]);
      const deployments = deploymentsResult.status === "fulfilled" ? deploymentsResult.value : [];
      const targetCommitSha = targetResult.status === "fulfilled" ? targetResult.value?.sha ?? null : null;
      const warmSync = warmSyncResult.status === "fulfilled" ? warmSyncResult.value : null;
      const lifecycleConfig = lifecycleResult.status === "fulfilled" ? lifecycleResult.value?.config : null;
      const deployPolicy = lifecycleConfig?.deployPolicy && typeof lifecycleConfig.deployPolicy === "object" && !Array.isArray(lifecycleConfig.deployPolicy)
        ? lifecycleConfig.deployPolicy as Record<string, unknown>
        : {};
      const lifecycle = composeStageLifecycleStatus({
        deployments,
        targetCommitSha,
        warmSync: warmSync
          ? {
            activeCommitSha: warmSync.activeCommitSha,
            targetCommitSha: warmSync.targetCommitSha,
            status: warmSync.status,
            reason: warmSync.reason,
          }
          : null,
        capabilities: deriveStageLifecycleCapabilities(deployPolicy, lifecycleConfig?.providerKind || "railway", {
          platformName: control.environment.platformName,
          productName: control.environment.productName,
          environmentName: control.environment.platformEnvironmentName,
        }),
        providerError: deploymentsResult.status === "rejected"
          ? (deploymentsResult.reason instanceof Error ? deploymentsResult.reason.message : "Railway deployment truth is unavailable.")
          : targetResult.status === "rejected"
            ? "The bound source branch head could not be resolved."
            : null,
      });
      res.json({
        configured: true,
        platformEnvironmentId: control.environment.platformEnvironmentId,
        environmentName: control.environment.platformEnvironmentName,
        publicUrl: control.publicUrl,
        projectId: control.projectId,
        environmentId: control.railwayEnvironmentId,
        serviceId: control.serviceId,
        deployment: serializeEnvironmentDeployment(deployments[0] ?? null),
        lifecycle,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      handleError(res, error, "environment status failed");
    }
  });

  app.post("/api/railway/environments/:platformEnvironmentId/test", requireAuth, requireAdmin, async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    try {
      const capability = await verifyRailwayEnvironmentCapability(control);
      res.json({ ok: capability.authenticated && capability.projectVisible, ...capability,
        platformEnvironmentId: control.environment.platformEnvironmentId });
    } catch (error) {
      handleError(res, error, "environment connector test failed");
    }
  });

  app.get("/api/railway/environments/:platformEnvironmentId/deployments", requireAuth, requireAdmin, async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    const parsed = deploymentQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid deployments query" });
    try {
      const deployments = await fetchEnvironmentDeployments(control, Math.min(parsed.data.limit ?? 20, 50));
      res.json({ platformEnvironmentId: control.environment.platformEnvironmentId,
        deployments: deployments.map(serializeEnvironmentDeployment) });
    } catch (error) {
      handleError(res, error, "environment deployments failed");
    }
  });

  app.get("/api/railway/environments/:platformEnvironmentId/logs", requireAuth, requireAdmin, async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    const parsed = deploymentQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid logs query" });
    try {
      const deploymentId = await resolveEnvironmentDeploymentId(control, parsed.data.deploymentId);
      const logs = deploymentId ? await fetchEnvironmentRuntimeLogs(control, deploymentId, parsed.data.limit ?? 200) : [];
      res.json({ platformEnvironmentId: control.environment.platformEnvironmentId, deploymentId, logs });
    } catch (error) {
      handleError(res, error, "environment logs failed");
    }
  });

  app.get("/api/railway/environments/:platformEnvironmentId/build-logs", requireAuth, requireAdmin, async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    const parsed = deploymentQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid build logs query" });
    try {
      const deploymentId = await resolveEnvironmentDeploymentId(control, parsed.data.deploymentId, true);
      const logs = deploymentId ? await fetchEnvironmentBuildLogs(control, deploymentId, parsed.data.limit ?? 200) : [];
      res.json({ platformEnvironmentId: control.environment.platformEnvironmentId, deploymentId, logs });
    } catch (error) {
      handleError(res, error, "environment build logs failed");
    }
  });

  app.get("/api/railway/environments/:platformEnvironmentId/variables", requireAuth, requireAdmin, async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    try {
      const names = await listEnvironmentVariableNames(control);
      res.json({ platformEnvironmentId: control.environment.platformEnvironmentId, names });
    } catch (error) {
      handleError(res, error, "environment variables failed");
    }
  });

  app.post("/api/railway/environments/:platformEnvironmentId/actions/restart", requirePermission("build:write"), async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    const lifecycle = await getEnvironmentBuildLifecycleConfig(control.environment.platformEnvironmentId, { includeDisabled: true });
    const policy = lifecycle?.config?.deployPolicy && typeof lifecycle.config.deployPolicy === "object" && !Array.isArray(lifecycle.config.deployPolicy) ? lifecycle.config.deployPolicy as Record<string, unknown> : {};
    const capabilities = deriveStageLifecycleCapabilities(policy, lifecycle?.config?.providerKind || "railway", {
      platformName: control.environment.platformName,
      productName: control.environment.productName,
      environmentName: control.environment.platformEnvironmentName,
    });
    if (!capabilities.actions.includes("restart_stage")) return res.status(409).json({ error: "Restart Stage is not enabled by this environment lifecycle contract" });
    const parsed = deploymentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid Stage restart request" });
    try {
      res.json({ ok: true, action: "restart_stage", ...(await restartEnvironment(control, parsed.data.deploymentId)) });
    } catch (error) {
      handleError(res, error, "Stage restart failed");
    }
  });

  app.post("/api/railway/environments/:platformEnvironmentId/actions/sync-latest", requirePermission("build:write"), async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    if (!isMantraWebStageIdentity({
      platformName: control.environment.platformName,
      productName: control.environment.productName,
      environmentName: control.environment.platformEnvironmentName,
    })) {
      return res.status(409).json({ error: "Sync Latest is available only on Mantra Web Stage" });
    }
    const lifecycle = await getEnvironmentBuildLifecycleConfig(control.environment.platformEnvironmentId, { includeDisabled: true });
    const policy = lifecycle?.config?.deployPolicy && typeof lifecycle.config.deployPolicy === "object" && !Array.isArray(lifecycle.config.deployPolicy)
      ? lifecycle.config.deployPolicy as Record<string, unknown>
      : {};
    const capabilities = deriveStageLifecycleCapabilities(policy, lifecycle?.config?.providerKind || "railway", {
      platformName: control.environment.platformName,
      productName: control.environment.productName,
      environmentName: control.environment.platformEnvironmentName,
    });
    if (!capabilities.actions.includes("sync_latest")) {
      return res.status(409).json({ error: "Sync Latest requires Warm Stage (runtimeMode=warm_workspace)" });
    }
    const parsed = syncLatestBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Sync Latest requires an idempotencyKey" });
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: "Authentication required" });

    const [source] = await db.select({
      owner: environmentSourceBindings.owner,
      repo: environmentSourceBindings.repo,
      branch: environmentSourceBindings.branch,
    }).from(environmentSourceBindings)
      .where(eq(environmentSourceBindings.environmentId, control.environment.platformEnvironmentId))
      .limit(1);
    if (!source?.owner || !source.repo || !source.branch) {
      return res.status(409).json({ error: "Stage has no bound source owner/repo/branch" });
    }

    const action = "platform_environment.sync_latest";
    const idempotencyKey = parsed.data.idempotencyKey;
    const existing = await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.MOD_LIFECYCLE, `sync-latest:${control.environment.platformEnvironmentId}:${idempotencyKey}`);
      const [row] = await tx.select({ id: privilegedAccessAudit.id, metadata: privilegedAccessAudit.metadata })
        .from(privilegedAccessAudit)
        .where(and(eq(privilegedAccessAudit.action, action), sql`${privilegedAccessAudit.metadata}->>'idempotencyKey' = ${idempotencyKey}`))
        .limit(1);
      if (row) return { ...row, replayed: true };
      const [created] = await tx.insert(privilegedAccessAudit).values({
        actorType: principal.actorType,
        actorUserId: principal.userId,
        actorAccountId: principal.accountId,
        action,
        reason: "Human Sync Latest for Warm Stage workspace",
        scopes: ["build:write", `platform_environment:${control.environment.platformEnvironmentId}`],
        metadata: { idempotencyKey, environmentId: control.environment.platformEnvironmentId, status: "started" },
      }).returning({ id: privilegedAccessAudit.id });
      return { id: created.id, metadata: { status: "started" }, replayed: false };
    });
    const existingMetadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
      ? existing.metadata as Record<string, unknown>
      : {};
    if (existing.replayed && existingMetadata.status === "completed") {
      return res.json({ ok: true, action: "sync_latest", replayed: true, ...(existingMetadata.result as Record<string, unknown>) });
    }
    if (existing.replayed && existingMetadata.status === "started") {
      return res.status(409).json({ error: "This Sync Latest request is already in progress; use a new idempotencyKey after checking Stage state." });
    }

    try {
      const head = await resolveBoundBranchHead({ owner: source.owner, repo: source.repo }, source.branch);
      await writeStageSyncStatus(control.environment.platformEnvironmentId, {
        targetCommitSha: head.sha,
        status: "pending",
        reason: `Queued ${head.sha.slice(0, 7)} for warm apply`,
      });
      await setStageSyncTargetVariable(control, head.sha);
      const inFlight = await findInFlightEnvironmentDeployment(control);
      if (inFlight) {
        const result = {
          targetCommitSha: head.sha,
          targetCommitMessage: head.message,
          deploymentId: inFlight.id,
          restarted: false,
          deferred: true,
          reason: "in_flight_deploy",
        };
        await db.update(privilegedAccessAudit).set({
          metadata: {
            idempotencyKey,
            environmentId: control.environment.platformEnvironmentId,
            status: "completed",
            result,
          },
        }).where(eq(privilegedAccessAudit.id, existing.id));
        return res.json({ ok: true, action: "sync_latest", replayed: false, ...result });
      }
      const restart = await restartEnvironment(control);
      const result = {
        targetCommitSha: head.sha,
        targetCommitMessage: head.message,
        deploymentId: restart.deploymentId,
        restarted: restart.ok,
      };
      await db.update(privilegedAccessAudit).set({
        metadata: {
          idempotencyKey,
          environmentId: control.environment.platformEnvironmentId,
          status: "completed",
          result,
        },
      }).where(eq(privilegedAccessAudit.id, existing.id));
      res.json({ ok: true, action: "sync_latest", replayed: false, ...result });
    } catch (error) {
      await db.update(privilegedAccessAudit).set({
        metadata: { idempotencyKey, environmentId: control.environment.platformEnvironmentId, status: "failed" },
      }).where(eq(privilegedAccessAudit.id, existing.id));
      handleError(res, error, "Stage Sync Latest failed");
    }
  });

  app.post("/api/railway/environments/:platformEnvironmentId/actions/full-rebuild", requirePermission("build:write"), async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    const lifecycle = await getEnvironmentBuildLifecycleConfig(control.environment.platformEnvironmentId, { includeDisabled: true });
    const policy = lifecycle?.config?.deployPolicy && typeof lifecycle.config.deployPolicy === "object" && !Array.isArray(lifecycle.config.deployPolicy) ? lifecycle.config.deployPolicy as Record<string, unknown> : {};
    const capabilities = deriveStageLifecycleCapabilities(policy, lifecycle?.config?.providerKind || "railway", {
      platformName: control.environment.platformName,
      productName: control.environment.productName,
      environmentName: control.environment.platformEnvironmentName,
    });
    if (capabilities.fullRebuildProvider !== "railway") return res.status(409).json({ error: "Full Rebuild is not backed by the Railway provider for this environment" });
    const parsed = fullRebuildBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Full Rebuild requires confirmation and an idempotencyKey" });
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: "Authentication required" });
    const action = "platform_environment.full_rebuild";
    const idempotencyKey = parsed.data.idempotencyKey;
    let auditId: number;
    const existing = await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.MOD_LIFECYCLE, `full-rebuild:${control.environment.platformEnvironmentId}:${idempotencyKey}`);
      const [row] = await tx.select({ id: privilegedAccessAudit.id, metadata: privilegedAccessAudit.metadata })
        .from(privilegedAccessAudit)
        .where(and(eq(privilegedAccessAudit.action, action), sql`${privilegedAccessAudit.metadata}->>'idempotencyKey' = ${idempotencyKey}`))
        .limit(1);
      if (row) return { ...row, replayed: true };
      const [created] = await tx.insert(privilegedAccessAudit).values({
        actorType: principal.actorType,
        actorUserId: principal.userId,
        actorAccountId: principal.accountId,
        action,
        reason: "Human-confirmed Stage Full Rebuild recovery action",
        scopes: ["build:write", `platform_environment:${control.environment.platformEnvironmentId}`],
        metadata: { idempotencyKey, environmentId: control.environment.platformEnvironmentId, status: "started" },
      }).returning({ id: privilegedAccessAudit.id });
      return { id: created.id, metadata: { status: "started" }, replayed: false };
    });
    auditId = existing.id;
    const existingMetadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? existing.metadata as Record<string, unknown> : {};
    if (existing.replayed && existingMetadata.status === "completed") return res.json({ ok: true, action: "full_rebuild", replayed: true, ...(existingMetadata.result as Record<string, unknown>) });
    if (existing.replayed && existingMetadata.status === "started") return res.status(409).json({ error: "This Full Rebuild request is already in progress or was interrupted; use a new idempotencyKey after checking Stage state." });
    try {
      const deployment = await redeployEnvironment(control, parsed.data.deploymentId);
      const result = { deploymentId: deployment.id, status: deployment.status };
      await db.update(privilegedAccessAudit).set({ metadata: { idempotencyKey, environmentId: control.environment.platformEnvironmentId, status: "completed", result } }).where(eq(privilegedAccessAudit.id, auditId));
      res.json({ ok: true, action: "full_rebuild", replayed: false, ...result });
    } catch (error) {
      await db.update(privilegedAccessAudit).set({ metadata: { idempotencyKey, environmentId: control.environment.platformEnvironmentId, status: "failed" } }).where(eq(privilegedAccessAudit.id, auditId));
      handleError(res, error, "Stage Full Rebuild failed");
    }
  });

  app.post("/api/railway/environments/:platformEnvironmentId/actions/enable-warm-stage", requirePermission("build:write"), async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    if (!isMantraWebStageIdentity({
      platformName: control.environment.platformName,
      productName: control.environment.productName,
      environmentName: control.environment.platformEnvironmentName,
    })) {
      return res.status(409).json({ error: "Enable Warm Stage is available only on Mantra Web Stage" });
    }
    const lifecycle = await getEnvironmentBuildLifecycleConfig(control.environment.platformEnvironmentId, { includeDisabled: true });
    const policy = lifecycle?.config?.deployPolicy && typeof lifecycle.config.deployPolicy === "object" && !Array.isArray(lifecycle.config.deployPolicy)
      ? lifecycle.config.deployPolicy as Record<string, unknown>
      : {};
    const capabilities = deriveStageLifecycleCapabilities(policy, lifecycle?.config?.providerKind || "railway", {
      platformName: control.environment.platformName,
      productName: control.environment.productName,
      environmentName: control.environment.platformEnvironmentName,
    });
    if (!capabilities.actions.includes("enable_warm_stage")) {
      return res.status(409).json({ error: "Warm Stage is already enabled for this environment" });
    }
    const parsed = enableWarmStageBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Enable Warm Stage requires confirmation and an idempotencyKey" });
    const principal = req.principal;
    if (!principal) return res.status(401).json({ error: "Authentication required" });
    const action = "platform_environment.enable_warm_stage";
    const idempotencyKey = parsed.data.idempotencyKey;
    const existing = await db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.MOD_LIFECYCLE, `enable-warm-stage:${control.environment.platformEnvironmentId}:${idempotencyKey}`);
      const [row] = await tx.select({ id: privilegedAccessAudit.id, metadata: privilegedAccessAudit.metadata })
        .from(privilegedAccessAudit)
        .where(and(eq(privilegedAccessAudit.action, action), sql`${privilegedAccessAudit.metadata}->>'idempotencyKey' = ${idempotencyKey}`))
        .limit(1);
      if (row) return { ...row, replayed: true };
      const [created] = await tx.insert(privilegedAccessAudit).values({
        actorType: principal.actorType,
        actorUserId: principal.userId,
        actorAccountId: principal.accountId,
        action,
        reason: "Human-confirmed Enable Warm Stage activation",
        scopes: ["build:write", `platform_environment:${control.environment.platformEnvironmentId}`],
        metadata: { idempotencyKey, environmentId: control.environment.platformEnvironmentId, status: "started" },
      }).returning({ id: privilegedAccessAudit.id });
      return { id: created.id, metadata: { status: "started" }, replayed: false };
    });
    const existingMetadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata) ? existing.metadata as Record<string, unknown> : {};
    if (existing.replayed && existingMetadata.status === "completed") return res.json({ ok: true, action: "enable_warm_stage", replayed: true, ...(existingMetadata.result as Record<string, unknown>) });
    if (existing.replayed && existingMetadata.status === "started") return res.status(409).json({ error: "This Enable Warm Stage request is already in progress or was interrupted; use a new idempotencyKey after checking Stage state." });
    try {
      const nextPolicy = {
        ...policy,
        runtimeMode: "warm_workspace",
        syncOnPush: false,
        dependencyPolicy: "rebuild_on_lockfile_change",
        fullRebuildProvider: "railway",
        requireProductionBuild: false,
        requireHumanPromotion: false,
      };
      await setEnvironmentBuildLifecycleConfig(control.environment.platformEnvironmentId, {
        ...(lifecycle?.config ? {
          workflowTemplateId: lifecycle.config.workflowTemplateId,
          providerKind: lifecycle.config.providerKind,
          acceptanceTarget: lifecycle.config.acceptanceTarget,
          authMode: lifecycle.config.authMode,
          retryPolicy: lifecycle.config.retryPolicy,
          gatePolicy: lifecycle.config.gatePolicy,
          evidenceConfig: lifecycle.config.evidenceConfig,
          docsConfig: lifecycle.config.docsConfig,
          enabled: lifecycle.config.enabled,
        } : { providerKind: "railway", enabled: true }),
        deployPolicy: nextPolicy,
      });
      await enableWarmStageRuntimeVariable(control);
      const restart = await restartEnvironment(control);
      const result = { deploymentId: restart.deploymentId, restarted: restart.ok };
      await db.update(privilegedAccessAudit).set({
        metadata: { idempotencyKey, environmentId: control.environment.platformEnvironmentId, status: "completed", result },
      }).where(eq(privilegedAccessAudit.id, existing.id));
      res.json({ ok: true, action: "enable_warm_stage", replayed: false, ...result });
    } catch (error) {
      await db.update(privilegedAccessAudit).set({
        metadata: { idempotencyKey, environmentId: control.environment.platformEnvironmentId, status: "failed" },
      }).where(eq(privilegedAccessAudit.id, existing.id));
      handleError(res, error, "Enable Warm Stage failed");
    }
  });

  app.post("/api/railway/environments/:platformEnvironmentId/redeploy", requireAuth, requireAdmin, async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    const parsed = deploymentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid redeploy request" });
    try {
      const deployment = await redeployEnvironment(control, parsed.data.deploymentId);
      res.json({ ok: true, deploymentId: deployment.id, status: deployment.status });
    } catch (error) {
      handleError(res, error, "environment redeploy failed");
    }
  });

  app.post("/api/railway/environments/:platformEnvironmentId/restart", requireAuth, requireAdmin, async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    const parsed = deploymentBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid restart request" });
    try {
      res.json(await restartEnvironment(control, parsed.data.deploymentId));
    } catch (error) {
      handleError(res, error, "environment restart failed");
    }
  });

  // ── Publish (dev → live) ────────────────────────────────────────────────
  // Returns the static publish-tab summary: prereqs, dev/prod commits, the
  // commits that *would* be promoted, and the current/last in-flight run.
  app.get("/api/railway/publish/summary", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const parsedContext = parsePublishContext(req.query);
      const run = await getDisplayRun();
      let context = parsedContext.success ? parsedContext.data : null;
      const query = req.query as Record<string, unknown>;
      const hasPartialContext = query.sourcePlatformEnvironmentId !== undefined || query.targetPlatformEnvironmentId !== undefined;
      if (!context && !hasPartialContext && run) {
        context = {
          sourcePlatformEnvironmentId: run.sourcePlatformEnvironmentId,
          targetPlatformEnvironmentId: run.targetPlatformEnvironmentId,
        };
        log.warn("Publish summary used persisted-run context fallback", {
          sourcePlatformEnvironmentId: context.sourcePlatformEnvironmentId,
          targetPlatformEnvironmentId: context.targetPlatformEnvironmentId,
        });
      }
      if (!context) return res.status(400).json({ error: "sourcePlatformEnvironmentId and targetPlatformEnvironmentId are required." });
      const prereqs = await checkPrereqs(context.sourcePlatformEnvironmentId, context.targetPlatformEnvironmentId);
      const versioning = await getReleaseVersionSummary(context.targetPlatformEnvironmentId);

      const summary: PublishSummaryResponse = {
        ready: prereqs.ready,
        sourcePlatformEnvironmentId: context.sourcePlatformEnvironmentId,
        targetPlatformEnvironmentId: context.targetPlatformEnvironmentId,
        reason: prereqs.reason,
        repo: prereqs.repo ? `${prereqs.repo.owner}/${prereqs.repo.repo}` : null,
        devBranch: prereqs.devBranch,
        prodBranch: prereqs.prodBranch,
        prodUrl: prereqs.prodUrl,
        devCommit: null,
        prodCommit: null,
        aheadBy: 0,
        commits: [],
        compareError: null,
        versioning,
        run: toPublicRun(run),
      };

      if (prereqs.ready && prereqs.repo && prereqs.devBranch) {
        try {
          const cmp = await compareRefs(prereqs.repo, prereqs.prodBranch, prereqs.devBranch);
          summary.aheadBy = cmp.aheadBy;
          summary.commits = cmp.commits.map(toPublishCommit);
          // Branch heads are best-effort — failure here is fine.
          const [devHead, prodHead] = await Promise.all([
            getBranchHead(prereqs.repo, prereqs.devBranch).catch(() => null),
            getBranchHead(prereqs.repo, prereqs.prodBranch).catch(() => null),
          ]);
          if (devHead) summary.devCommit = { sha: devHead.sha, shortSha: devHead.sha.slice(0, 7), message: devHead.message };
          if (prodHead) summary.prodCommit = { sha: prodHead.sha, shortSha: prodHead.sha.slice(0, 7), message: prodHead.message };
        } catch (err) {
          // Surface compare-only failures without flipping ready=false — the
          // user can still see the prereq status while we report the issue.
          summary.compareError = err instanceof Error ? err.message : String(err);
        }
      }
      return res.json(summary);
    } catch (err: unknown) {
      handleError(res, err, "publish summary failed");
    }
  });

  // Lightweight, environment-independent publish run status. The publish run is
  // a global singleton (getDisplayRun); consumers that only need the current
  // run status — e.g. the sidebar Build indicator — must read it here instead
  // of the env-scoped summary, which requires source/target environment IDs.
  app.get("/api/railway/publish/run", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const run = await getDisplayRun();
      return res.json({ run: toPublicRun(run) });
    } catch (err: unknown) {
      handleError(res, err, "publish run status failed");
    }
  });

  // Read-only preview: generate the release-notes draft the human is about to
  // approve, WITHOUT promoting anything. Powers the review-and-approve modal.
  app.post("/api/railway/publish/draft-notes", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const parsed = publishContextSchema.extend({ increment: z.enum(["minor", "major", "flagship"]) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Choose a version increment and provide source/target Platform Environment IDs." });
      const preview = await buildDraftPreview(
        parsed.data.increment as VersionIncrement,
        parsed.data.sourcePlatformEnvironmentId,
        parsed.data.targetPlatformEnvironmentId,
      );
      res.json({ ok: true, preview });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof NothingToPublishError) {
        return res.status(409).json({ error: msg, code: "nothing_to_publish" });
      }
      if (err instanceof PublishNotReadyError) {
        return res.status(422).json({ error: msg, code: "publish_not_ready" });
      }
      handleError(res, err, "release notes preview failed");
    }
  });

  app.post("/api/railway/publish/start", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const parsed = publishContextSchema
        .extend({
          increment: z.enum(["minor", "major", "flagship"]),
          approvedNotes: releaseNotesSchema.optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Choose a version increment and provide source/target Platform Environment IDs." });
      const actor = await resolvePublishActor(req);
      const run = await startRun(
        actor,
        parsed.data.increment as VersionIncrement,
        parsed.data.sourcePlatformEnvironmentId,
        parsed.data.targetPlatformEnvironmentId,
        parsed.data.approvedNotes,
      );
      res.json({ ok: true, run: toPublicRun(run) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Publish start refused: ${msg}`);
      // 409 for in-flight / nothing-to-publish — concurrent or no-op
      // situations the user can immediately retry. Each gets a stable
      // machine-readable `code` so the client doesn't have to regex-match
      // the human-readable message.
      if (err instanceof PublishInFlightError) {
        return res.status(409).json({ error: msg, code: "publish_in_flight" });
      }
      if (err instanceof NothingToPublishError) {
        return res.status(409).json({ error: msg, code: "nothing_to_publish" });
      }
      // 422 for setup/prereq failures — there's nothing wrong with the
      // server, the user just needs to fix their Railway/GitHub config.
      if (err instanceof PublishNotReadyError) {
        return res.status(422).json({ error: msg, code: "publish_not_ready" });
      }
      handleError(res, err, "publish start failed");
    }
  });

  app.post("/api/railway/publish/cancel", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const ok = cancelRun();
    if (!ok) return res.status(404).json({ error: "No publish in flight." });
    res.json({ ok: true });
  });

  // Reconcile `live → dev` end-to-end: open (or reuse) a PR from `live` →
  // `dev`, poll mergeability, and merge it via the GitHub Merge API with
  // `merge_method: "merge"` (NOT squash) so live's drift commits land on dev
  // verbatim and the diverged-live publish failure clears. The user never
  // visits GitHub. Surfaced from the Publish tab's failure card; gated
  // client-side behind a confirm dialog. Idempotent — calling it after the
  // PR is already merged returns `merged: true` without erroring.
  app.post("/api/railway/publish/reconcile", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const context = parsePublishContext(req.body);
      if (!context.success) return res.status(400).json({ error: "sourcePlatformEnvironmentId and targetPlatformEnvironmentId are required." });
      const result = await reconcileLiveIntoDev(context.data.sourcePlatformEnvironmentId, context.data.targetPlatformEnvironmentId);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof NothingToPublishError) {
        return res.status(409).json({ error: msg, code: "nothing_to_reconcile" });
      }
      if (err instanceof PublishNotReadyError) {
        return res.status(422).json({ error: msg, code: "publish_not_ready" });
      }
      handleError(res, err, "publish reconcile failed");
    }
  });

  app.post("/api/railway/publish/retry", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const context = parsePublishContext(req.body);
      if (!context.success) return res.status(400).json({ error: "sourcePlatformEnvironmentId and targetPlatformEnvironmentId are required." });
      const actor = await resolvePublishActor(req);
      const run = await retryRun(actor, context.data.sourcePlatformEnvironmentId, context.data.targetPlatformEnvironmentId);
      res.json({ ok: true, run: toPublicRun(run) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof PublishInFlightError) {
        return res.status(409).json({ error: msg, code: "publish_in_flight" });
      }
      if (/no failed run|no failed stage/i.test(msg)) {
        return res.status(409).json({ error: msg, code: "no_failed_run" });
      }
      if (err instanceof PublishNotReadyError) {
        return res.status(422).json({ error: msg, code: "publish_not_ready" });
      }
      handleError(res, err, "publish retry failed");
    }
  });
}
