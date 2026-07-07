
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../../auth";
import { createLogger } from "../../log";
import {
  fetchProjects,
  fetchDeployments,
  fetchDeploymentsForEnvironment,
  fetchDeploymentLogs,
  fetchBuildLogs,
  fetchServiceVariables,
  redeployDeployment,
  redeployServiceInstance,
  restartDeployment,
  stopDeployment,
  rollbackToDeployment,
  isRailwayConfigured,
  getDevConfig,
  isDevConfigComplete,
  getProdConfig,
  isProdConfigComplete,
  extractDeploymentMeta,
  getRailwayTokenDiagnostics,
  createServiceDomain,
  isAppService,
  RailwayApiError,
  type RailwayDeployment,
  type RailwayLogEntry,
  type RailwayProject,
  type RailwayService,
} from "./client";
import { setSecret } from "../../secrets-store";
import {
  checkPrereqs,
  getDisplayRun,
  startRun,
  cancelRun,
  retryRun,
  toPublicRun,
  reconcileLiveIntoDev,
  PublishInFlightError,
  PublishNotReadyError,
  NothingToPublishError,
  type PublicPublishRun,
} from "./publish";
import {
  compareRefs,
  getBranchHead,
  toPublishCommit,
  type PublishCommit,
} from "../github-pr";
import { storage } from "../../storage";

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

const deploymentsQuerySchema = z.object({
  projectId: z.string().min(1),
  serviceId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const logsParamsSchema = z.object({
  deploymentId: z.string().min(1),
});

const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const redeployBodySchema = z.object({
  deploymentId: z.string().min(1),
});

export function registerRailwayRoutes(app: Express) {
  app.get("/api/railway/status", requireAuth, async (_req: Request, res: Response) => {
    try {
      const configured = await isRailwayConfigured();
      res.json({ configured });
    } catch (err: unknown) {
      handleError(res, err, "status check failed");
    }
  });

  // Diagnostic endpoint: hits Railway with the configured token and returns
  // either who Railway thinks we are, or a structured failure reason. Used by
  // the Setup tab's "Test connection" button to give actionable feedback when
  // a token is rejected (wrong type, env-var being shadowed, etc).
  app.post("/api/railway/test", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const diag = await getRailwayTokenDiagnostics();
    if (diag.source === "none") {
      return res.status(400).json({
        ok: false,
        error: "No Railway API token configured.",
        diagnostics: diag,
      });
    }
    try {
      const result = await fetchProjects();
      return res.json({
        ok: true,
        me: result.me,
        projectCount: result.projects.length,
        diagnostics: diag,
      });
    } catch (err: unknown) {
      const status = err instanceof RailwayApiError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      return res.status(status >= 400 && status < 600 ? status : 500).json({
        ok: false,
        error: message,
        diagnostics: diag,
      });
    }
  });

  app.get("/api/railway/projects", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await fetchProjects();
      res.json(result);
    } catch (err: unknown) {
      handleError(res, err, "list projects failed");
    }
  });

  // Auto-resolve the dev target (service + URL) for a given project + env.
  // Returns the candidate app services in the project, the auto-picked one
  // when unambiguous, the resolved *.up.railway.app URL, and a flag
  // indicating whether the dev env still needs a domain generated.
  const autoResolveQuerySchema = z.object({
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
  });
  app.get("/api/railway/auto-resolve", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const parsed = autoResolveQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid query" });
    }
    try {
      const { projects } = await fetchProjects();
      const project: RailwayProject | undefined = projects.find((p) => p.id === parsed.data.projectId);
      if (!project) {
        return res.status(404).json({ error: "Project not found for the configured Railway token" });
      }
      const env = project.environments.find((e) => e.id === parsed.data.environmentId);
      if (!env) {
        return res.status(404).json({ error: "Environment not found in this project" });
      }
      const appServices = project.services.filter(isAppService);
      const services = appServices.map((s: RailwayService) => {
        const inst = s.instances.find((i) => i.environmentId === parsed.data.environmentId);
        const domain =
          inst?.customDomains?.[0]?.domain ?? inst?.serviceDomains?.[0]?.domain ?? null;
        return {
          id: s.id,
          name: s.name,
          devUrl: domain ? `https://${domain}` : null,
          hasDomain: !!domain,
          isCustomDomain: !!inst?.customDomains?.[0],
        };
      });
      const picked = services.length === 1 ? services[0] : null;
      return res.json({
        project: { id: project.id, name: project.name },
        environment: { id: env.id, name: env.name },
        services,
        pickedServiceId: picked?.id ?? null,
        devUrl: picked?.devUrl ?? null,
        needsDomain: !!picked && !picked.hasDomain,
      });
    } catch (err: unknown) {
      handleError(res, err, "auto-resolve failed");
    }
  });

  // Generate a *.up.railway.app domain for the configured dev service in the
  // configured dev environment, then persist the resulting URL to
  // RAILWAY_DEV_URL so the iframe preview picks it up immediately. Idempotent
  // re-invocations refresh the saved URL.
  const ensureDomainBodySchema = z.object({
    environmentId: z.string().min(1),
    serviceId: z.string().min(1),
    targetPort: z.number().int().min(1).max(65535).optional(),
  });
  app.post("/api/railway/ensure-dev-domain", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const parsed = ensureDomainBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid body" });
    }
    const actor = (req as any).user?.id ? String((req as any).user.id) : "admin";
    try {
      // Re-check current state to keep this idempotent: if a service or custom
      // domain is already attached for this env, return it instead of asking
      // Railway to mint a second one.
      const { projects } = await fetchProjects();
      let existingDomain: string | null = null;
      for (const p of projects) {
        const svc = p.services.find((s) => s.id === parsed.data.serviceId);
        const inst = svc?.instances.find((i) => i.environmentId === parsed.data.environmentId);
        existingDomain =
          inst?.customDomains?.[0]?.domain ?? inst?.serviceDomains?.[0]?.domain ?? null;
        if (existingDomain) break;
      }
      let domain = existingDomain;
      if (!domain) {
        const created = await createServiceDomain({
          environmentId: parsed.data.environmentId,
          serviceId: parsed.data.serviceId,
          targetPort: parsed.data.targetPort,
        });
        domain = created.domain;
      }
      const url = `https://${domain}`;
      await setSecret("RAILWAY_DEV_URL", url, actor);
      return res.json({ devUrl: url, domain, created: !existingDomain });
    } catch (err: unknown) {
      handleError(res, err, "generate dev domain failed");
    }
  });

  app.get("/api/railway/deployments", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const parsed = deploymentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid query" });
    }
    try {
      const deployments = await fetchDeployments(
        parsed.data.projectId,
        parsed.data.serviceId,
        parsed.data.limit ?? 10
      );
      res.json({ deployments });
    } catch (err: unknown) {
      handleError(res, err, "list deployments failed");
    }
  });

  app.get(
    "/api/railway/deployments/:deploymentId/logs",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const params = logsParamsSchema.safeParse(req.params);
      if (!params.success) {
        return res.status(400).json({ error: "Invalid deploymentId" });
      }
      const query = logsQuerySchema.safeParse(req.query);
      if (!query.success) {
        return res.status(400).json({ error: query.error.errors[0]?.message || "Invalid query" });
      }
      try {
        const logs = await fetchDeploymentLogs(params.data.deploymentId, query.data.limit ?? 200);
        res.json({ logs });
      } catch (err: unknown) {
        handleError(res, err, "fetch logs failed");
      }
    }
  );

  app.post("/api/railway/redeploy", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const parsed = redeployBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid body" });
    }
    try {
      const result = await redeployDeployment(parsed.data.deploymentId);
      res.json(result);
    } catch (err: unknown) {
      handleError(res, err, "redeploy failed");
    }
  });

  // Dev-environment scoped routes for the Dev page.
  // These read the configured dev project/env/service IDs from env vars,
  // so the client doesn't need to know them.


  /** @deprecated Headless browser auth now uses direct DB session injection via createScreenshotSession. */
  app.get("/api/railway/dev/automation-login-url", requireAuth, requireAdmin, (_req: Request, res: Response) => {
    res.status(410).json({ deprecated: true, message: "Use createScreenshotSession for headless auth" });
  });

  app.get("/api/railway/dev/status", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const cfg = await getDevConfig();
    const complete = isDevConfigComplete(cfg);
    if (!complete) {
      return res.status(503).json({
        configured: false,
        hasToken: cfg.hasToken,
        missing: {
          projectId: !cfg.projectId,
          environmentId: !cfg.environmentId,
          serviceId: !cfg.serviceId,
          devUrl: !cfg.devUrl,
        },
        devUrl: cfg.devUrl ?? null,
      });
    }
    // The /status endpoint must NEVER hard-fail when config is complete: the
    // iframe preview must remain reachable even if the Railway API is down.
    // We swallow Railway errors here, return 200 with a `statusError` field,
    // and let the client show a banner while still rendering the iframe.
    try {
      const deployments = await fetchDeploymentsForEnvironment(
        cfg.projectId!,
        cfg.serviceId!,
        cfg.environmentId!,
        1
      );
      const latest: RailwayDeployment | null = deployments[0] ?? null;
      const meta = extractDeploymentMeta(latest?.meta);
      res.json({
        configured: true,
        devUrl: cfg.devUrl ?? null,
        projectId: cfg.projectId,
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
        statusError: null,
        fetchedAt: new Date().toISOString(),
        deployment: latest
          ? {
              id: latest.id,
              status: latest.status,
              createdAt: latest.createdAt,
              updatedAt: latest.updatedAt,
              staticUrl: latest.staticUrl,
              url: latest.url,
              commitHash: meta.commitHash,
              commitMessage: meta.commitMessage,
              branch: meta.branch,
              repo: meta.repo,
            }
          : null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("dev status: Railway API unreachable, returning degraded status", { error: msg });
      res.json({
        configured: true,
        devUrl: cfg.devUrl ?? null,
        projectId: cfg.projectId,
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
        statusError: msg,
        fetchedAt: new Date().toISOString(),
        deployment: null,
      });
    }
  });

  app.get("/api/railway/dev/deployments", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getDevConfig();
    if (!isDevConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway dev environment not configured" });
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    try {
      const deployments = await fetchDeploymentsForEnvironment(
        cfg.projectId!,
        cfg.serviceId!,
        cfg.environmentId!,
        limit
      );
      res.json({
        deployments: deployments.map((d) => {
          const meta = extractDeploymentMeta(d.meta);
          return {
            id: d.id,
            status: d.status,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            staticUrl: d.staticUrl,
            url: d.url,
            commitHash: meta.commitHash,
            commitMessage: meta.commitMessage,
            commitAuthor: meta.commitAuthor,
            branch: meta.branch,
            repo: meta.repo,
          };
        }),
      });
    } catch (err: unknown) {
      handleError(res, err, "dev deployments failed");
    }
  });

  app.get("/api/railway/dev/logs", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getDevConfig();
    if (!isDevConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway dev environment not configured" });
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    try {
      // If client passes a deploymentId, use it. Otherwise fetch the latest deployment for the dev env.
      let deploymentId = typeof req.query.deploymentId === "string" ? req.query.deploymentId : null;
      if (!deploymentId) {
        const latest = await fetchDeploymentsForEnvironment(
          cfg.projectId!,
          cfg.serviceId!,
          cfg.environmentId!,
          1
        );
        if (latest.length === 0) {
          return res.json({ logs: [], deploymentId: null });
        }
        deploymentId = latest[0].id;
      }
      const logs = await fetchDeploymentLogs(deploymentId, limit);
      res.json({ logs, deploymentId });
    } catch (err: unknown) {
      handleError(res, err, "dev logs failed");
    }
  });

  app.get("/api/railway/prod/logs", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getProdConfig();
    if (!isProdConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway prod environment not configured" });
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    try {
      let deploymentId = typeof req.query.deploymentId === "string" ? req.query.deploymentId : null;
      if (!deploymentId) {
        const latest = await fetchDeploymentsForEnvironment(
          cfg.projectId!,
          cfg.serviceId!,
          cfg.environmentId!,
          1
        );
        if (latest.length === 0) {
          return res.json({ logs: [], deploymentId: null });
        }
        deploymentId = latest[0].id;
      }
      const logs = await fetchDeploymentLogs(deploymentId, limit);
      res.json({ logs, deploymentId });
    } catch (err: unknown) {
      handleError(res, err, "prod logs failed");
    }
  });

  // Live build logs for the current in-flight dev deployment. Resolves the
  // latest non-terminal deployment server-side, fetches both the build logs
  // and the deploy logs, and returns them merged in chronological order so
  // the client gets a single live-tailing stream that covers the whole
  // build → deploy lifecycle. Falls back to the most recent deployment when
  // there is no in-flight one (so the panel can still show the final lines
  // of a just-finished failure).
  app.get("/api/railway/dev/build-logs", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const cfg = await getDevConfig();
    if (!isDevConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway dev environment not configured" });
    }
    try {
      const deployments = await fetchDeploymentsForEnvironment(
        cfg.projectId!,
        cfg.serviceId!,
        cfg.environmentId!,
        5
      );
      if (deployments.length === 0) {
        return res.json({ logs: [], deploymentId: null, status: null });
      }
      const inFlightStatuses = new Set([
        "BUILDING",
        "DEPLOYING",
        "WAITING",
        "QUEUED",
        "INITIALIZING",
      ]);
      const inFlight = deployments.find((d) =>
        inFlightStatuses.has((d.status || "").toUpperCase())
      );
      const target = inFlight ?? deployments[0];
      // Fetch both streams concurrently; tolerate buildLogs failing (Railway
      // sometimes 404s the buildLogs query for very fresh deployments before
      // the builder picks them up).
      const [buildResult, deployResult] = await Promise.allSettled([
        fetchBuildLogs(target.id, 200),
        fetchDeploymentLogs(target.id, 200),
      ]);
      const build: RailwayLogEntry[] = buildResult.status === "fulfilled" ? buildResult.value : [];
      const deploy: RailwayLogEntry[] = deployResult.status === "fulfilled" ? deployResult.value : [];
      // Tag each line so the UI could differentiate later if it wants to —
      // the existing DevLogEntry shape only has timestamp/message/severity,
      // so we keep the wire-shape compatible and put the source into the
      // severity field only when no severity was already set.
      const merged: RailwayLogEntry[] = [...build, ...deploy].sort((a, b) => {
        const ta = Date.parse(a.timestamp);
        const tb = Date.parse(b.timestamp);
        if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
        if (Number.isNaN(ta)) return 1;
        if (Number.isNaN(tb)) return -1;
        return ta - tb;
      });
      res.json({
        logs: merged,
        deploymentId: target.id,
        status: target.status,
        inFlight: !!inFlight,
      });
    } catch (err: unknown) {
      handleError(res, err, "dev build logs failed");
    }
  });

  app.post("/api/railway/dev/redeploy", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getDevConfig();
    if (!isDevConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway dev environment not configured" });
    }
    try {
      // If a deploymentId is provided, redeploy that one. Otherwise redeploy the dev service instance.
      const deploymentId = typeof req.body?.deploymentId === "string" ? req.body.deploymentId : null;
      if (deploymentId) {
        const result = await redeployDeployment(deploymentId);
        return res.json({ ok: true, ...result });
      }
      const ok = await redeployServiceInstance(cfg.serviceId!, cfg.environmentId!);
      res.json({ ok });
    } catch (err: unknown) {
      handleError(res, err, "dev redeploy failed");
    }
  });

  app.post("/api/railway/dev/restart", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getDevConfig();
    if (!isDevConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway dev environment not configured" });
    }
    try {
      let deploymentId = typeof req.body?.deploymentId === "string" ? req.body.deploymentId : null;
      if (!deploymentId) {
        const latest = await fetchDeploymentsForEnvironment(
          cfg.projectId!,
          cfg.serviceId!,
          cfg.environmentId!,
          1
        );
        if (latest.length === 0) {
          return res.status(404).json({ error: "No deployment to restart" });
        }
        deploymentId = latest[0].id;
      }
      const ok = await restartDeployment(deploymentId);
      res.json({ ok, deploymentId });
    } catch (err: unknown) {
      handleError(res, err, "dev restart failed");
    }
  });

  app.post("/api/railway/dev/stop", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getDevConfig();
    if (!isDevConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway dev environment not configured" });
    }
    try {
      let deploymentId = typeof req.body?.deploymentId === "string" ? req.body.deploymentId : null;
      if (!deploymentId) {
        const latest = await fetchDeploymentsForEnvironment(
          cfg.projectId!,
          cfg.serviceId!,
          cfg.environmentId!,
          1
        );
        if (latest.length === 0) {
          return res.status(404).json({ error: "No deployment to stop" });
        }
        deploymentId = latest[0].id;
      }
      const ok = await stopDeployment(deploymentId);
      res.json({ ok, deploymentId });
    } catch (err: unknown) {
      handleError(res, err, "dev stop failed");
    }
  });

  const rollbackBodySchema = z.object({ deploymentId: z.string().min(1) });
  app.post("/api/railway/dev/rollback", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getDevConfig();
    if (!isDevConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway dev environment not configured" });
    }
    const parsed = rollbackBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid body" });
    }
    try {
      const ok = await rollbackToDeployment(parsed.data.deploymentId);
      res.json({ ok, deploymentId: parsed.data.deploymentId });
    } catch (err: unknown) {
      handleError(res, err, "dev rollback failed");
    }
  });

  app.get("/api/railway/dev/variables", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getDevConfig();
    if (!isDevConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway dev environment not configured" });
    }
    try {
      const all = await fetchServiceVariables(cfg.projectId!, cfg.environmentId!, cfg.serviceId!);
      const reveal = typeof req.query.reveal === "string" ? req.query.reveal : null;
      if (reveal) {
        if (!(reveal in all)) {
          return res.status(404).json({ error: "Variable not found" });
        }
        log.log(`Variable revealed: ${reveal}`);
        return res.json({ name: reveal, value: all[reveal] });
      }
      const names = Object.keys(all).sort();
      res.json({
        variables: names.map((name) => ({ name, masked: true })),
        projectId: cfg.projectId,
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
      });
    } catch (err: unknown) {
      handleError(res, err, "dev variables failed");
    }
  });

  // ── Production-environment status + build logs ─────────────────────────
  // Mirror of the dev status / build-logs endpoints scoped to the prod
  // Railway environment. Used by the Production tab to surface in-progress
  // Railway deploys (from publish runs *or* Railway-side redeploys) with the
  // same live-tailing build/deploy log panel the Development tab shows.

  app.get("/api/railway/prod/status", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const cfg = await getProdConfig();
    const complete = isProdConfigComplete(cfg);
    if (!complete) {
      return res.status(503).json({
        configured: false,
        hasToken: cfg.hasToken,
        missing: {
          projectId: !cfg.projectId,
          environmentId: !cfg.environmentId,
          serviceId: !cfg.serviceId,
          prodUrl: !cfg.prodUrl,
        },
        prodUrl: cfg.prodUrl ?? null,
      });
    }
    try {
      const deployments = await fetchDeploymentsForEnvironment(
        cfg.projectId!,
        cfg.serviceId!,
        cfg.environmentId!,
        1
      );
      const latest: RailwayDeployment | null = deployments[0] ?? null;
      const meta = extractDeploymentMeta(latest?.meta);
      res.json({
        configured: true,
        prodUrl: cfg.prodUrl ?? null,
        projectId: cfg.projectId,
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
        statusError: null,
        fetchedAt: new Date().toISOString(),
        deployment: latest
          ? {
              id: latest.id,
              status: latest.status,
              createdAt: latest.createdAt,
              updatedAt: latest.updatedAt,
              staticUrl: latest.staticUrl,
              url: latest.url,
              commitHash: meta.commitHash,
              commitMessage: meta.commitMessage,
              branch: meta.branch,
              repo: meta.repo,
            }
          : null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("prod status: Railway API unreachable, returning degraded status", { error: msg });
      res.json({
        configured: true,
        prodUrl: cfg.prodUrl ?? null,
        projectId: cfg.projectId,
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
        statusError: msg,
        fetchedAt: new Date().toISOString(),
        deployment: null,
      });
    }
  });

  app.get("/api/railway/prod/build-logs", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const cfg = await getProdConfig();
    if (!isProdConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway prod environment not configured" });
    }
    try {
      const deployments = await fetchDeploymentsForEnvironment(
        cfg.projectId!,
        cfg.serviceId!,
        cfg.environmentId!,
        5
      );
      if (deployments.length === 0) {
        return res.json({ logs: [], deploymentId: null, status: null });
      }
      const inFlightStatuses = new Set([
        "BUILDING",
        "DEPLOYING",
        "WAITING",
        "QUEUED",
        "INITIALIZING",
      ]);
      const inFlight = deployments.find((d) =>
        inFlightStatuses.has((d.status || "").toUpperCase())
      );
      const target = inFlight ?? deployments[0];
      const [buildResult, deployResult] = await Promise.allSettled([
        fetchBuildLogs(target.id, 200),
        fetchDeploymentLogs(target.id, 200),
      ]);
      const build: RailwayLogEntry[] = buildResult.status === "fulfilled" ? buildResult.value : [];
      const deploy: RailwayLogEntry[] = deployResult.status === "fulfilled" ? deployResult.value : [];
      const merged: RailwayLogEntry[] = [...build, ...deploy].sort((a, b) => {
        const ta = Date.parse(a.timestamp);
        const tb = Date.parse(b.timestamp);
        if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
        if (Number.isNaN(ta)) return 1;
        if (Number.isNaN(tb)) return -1;
        return ta - tb;
      });
      res.json({
        logs: merged,
        deploymentId: target.id,
        status: target.status,
        inFlight: !!inFlight,
      });
    } catch (err: unknown) {
      handleError(res, err, "prod build logs failed");
    }
  });

  // ── Production-environment redeploy / restart ─────────────────────────
  // Mirror of /api/railway/dev/redeploy and /dev/restart, scoped to the
  // prod Railway environment. Used by the Production tab to redeploy the
  // current prod service or restart its latest deployment without leaving
  // the xyz dev UI. Only non-destructive actions are exposed here —
  // stop/rollback are intentionally NOT mirrored to prod.
  app.post("/api/railway/prod/redeploy", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getProdConfig();
    if (!isProdConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway prod environment not configured" });
    }
    try {
      const deploymentId = typeof req.body?.deploymentId === "string" ? req.body.deploymentId : null;
      if (deploymentId) {
        const result = await redeployDeployment(deploymentId);
        return res.json({ ok: true, ...result });
      }
      const ok = await redeployServiceInstance(cfg.serviceId!, cfg.environmentId!);
      res.json({ ok });
    } catch (err: unknown) {
      handleError(res, err, "prod redeploy failed");
    }
  });

  app.post("/api/railway/prod/restart", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const cfg = await getProdConfig();
    if (!isProdConfigComplete(cfg)) {
      return res.status(503).json({ error: "Railway prod environment not configured" });
    }
    try {
      let deploymentId = typeof req.body?.deploymentId === "string" ? req.body.deploymentId : null;
      if (!deploymentId) {
        const latest = await fetchDeploymentsForEnvironment(
          cfg.projectId!,
          cfg.serviceId!,
          cfg.environmentId!,
          1
        );
        if (latest.length === 0) {
          return res.status(404).json({ error: "No deployment to restart" });
        }
        deploymentId = latest[0].id;
      }
      const ok = await restartDeployment(deploymentId);
      res.json({ ok, deploymentId });
    } catch (err: unknown) {
      handleError(res, err, "prod restart failed");
    }
  });

  // ── Publish (dev → live) ────────────────────────────────────────────────
  // Returns the static publish-tab summary: prereqs, dev/prod commits, the
  // commits that *would* be promoted, and the current/last in-flight run.
  app.get("/api/railway/publish/summary", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const prereqs = await checkPrereqs();
      const run = await getDisplayRun();

      const summary: PublishSummaryResponse = {
        ready: prereqs.ready,
        reason: prereqs.reason,
        repo: prereqs.repo ? `${prereqs.repo.owner}/${prereqs.repo.repo}` : null,
        devBranch: prereqs.devBranch,
        prodBranch: prereqs.prodCfg.liveBranch,
        prodUrl: prereqs.prodCfg.prodUrl ?? null,
        devCommit: null,
        prodCommit: null,
        aheadBy: 0,
        commits: [],
        compareError: null,
        run: toPublicRun(run),
      };

      if (prereqs.ready && prereqs.repo && prereqs.devBranch) {
        try {
          const cmp = await compareRefs(prereqs.repo, prereqs.prodCfg.liveBranch, prereqs.devBranch);
          summary.aheadBy = cmp.aheadBy;
          summary.commits = cmp.commits.map(toPublishCommit);
          // Branch heads are best-effort — failure here is fine.
          const [devHead, prodHead] = await Promise.all([
            getBranchHead(prereqs.repo, prereqs.devBranch).catch(() => null),
            getBranchHead(prereqs.repo, prereqs.prodCfg.liveBranch).catch(() => null),
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

  app.post("/api/railway/publish/start", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const actor = await resolvePublishActor(req);
      const run = await startRun(actor);
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
  app.post("/api/railway/publish/reconcile", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await reconcileLiveIntoDev();
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
      const actor = await resolvePublishActor(req);
      const run = await retryRun(actor);
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
