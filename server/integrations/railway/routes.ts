import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../../auth";
import { createLogger } from "../../log";
import { RailwayApiError } from "./client";
import {
  fetchEnvironmentBuildLogs,
  fetchEnvironmentDeployments,
  fetchEnvironmentRuntimeLogs,
  listEnvironmentVariableNames,
  redeployEnvironment,
  resolveEnvironmentDeploymentId,
  resolveRailwayEnvironmentControl,
  restartEnvironment,
  serializeEnvironmentDeployment,
  verifyRailwayEnvironmentCapability,
} from "./environment-control";
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
import { getReleaseVersionSummary, type VersionIncrement } from "./release-versioning";
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
  const environmentParamsSchema = z.object({
    platformEnvironmentId: z.coerce.number().int().positive(),
  });
  const deploymentQuerySchema = z.object({
    deploymentId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });
  const deploymentBodySchema = z.object({ deploymentId: z.string().min(1).optional() });

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

  app.get("/api/railway/status", requireAuth, async (_req: Request, res: Response) => {
    try {
      const control = await resolveRailwayEnvironmentControl(undefined, { allowCurrentRuntime: true });
      const capability = await verifyRailwayEnvironmentCapability(control);
      res.json({
        configured: capability.authenticated && capability.projectVisible,
        platformEnvironmentId: control.environment.platformEnvironmentId,
        bindingResolved: true,
        authenticated: capability.authenticated,
        projectVisible: capability.projectVisible,
      });
    } catch (error) {
      res.json({ configured: false, platformEnvironmentId: null, bindingResolved: false, authenticated: false, projectVisible: false,
        error: error instanceof Error ? error.message : String(error) });
    }
  });


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

  app.get("/api/railway/environments/:platformEnvironmentId/status", requireAuth, requireAdmin, async (req, res) => {
    const control = await parseEnvironment(req, res);
    if (!control) return;
    try {
      const deployments = await fetchEnvironmentDeployments(control, 1);
      res.json({
        configured: true,
        platformEnvironmentId: control.environment.platformEnvironmentId,
        environmentName: control.environment.platformEnvironmentName,
        publicUrl: control.publicUrl,
        projectId: control.projectId,
        environmentId: control.railwayEnvironmentId,
        serviceId: control.serviceId,
        deployment: serializeEnvironmentDeployment(deployments[0] ?? null),
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

  const legacyPaths = [
    "/api/railway/test", "/api/railway/projects", "/api/railway/auto-resolve", "/api/railway/ensure-dev-domain",
    "/api/railway/deployments", "/api/railway/deployments/:deploymentId/logs", "/api/railway/redeploy",
    "/api/railway/dev/status", "/api/railway/dev/deployments", "/api/railway/dev/logs", "/api/railway/dev/build-logs",
    "/api/railway/dev/redeploy", "/api/railway/dev/restart", "/api/railway/dev/stop", "/api/railway/dev/rollback",
    "/api/railway/dev/variables", "/api/railway/prod/status", "/api/railway/prod/logs", "/api/railway/prod/build-logs",
    "/api/railway/prod/redeploy", "/api/railway/prod/restart",
  ];
  const legacyGone = (_req: Request, res: Response) => res.status(410).json({
    error: "Legacy Railway routing was removed. Use /api/railway/environments/:platformEnvironmentId/... with a canonical Platform Environment ID.",
  });
  for (const path of legacyPaths) {
    app.get(path, requireAuth, requireAdmin, legacyGone);
    app.post(path, requireAuth, requireAdmin, legacyGone);
  }

  // ── Publish (dev → live) ────────────────────────────────────────────────
  // Returns the static publish-tab summary: prereqs, dev/prod commits, the
  // commits that *would* be promoted, and the current/last in-flight run.
  app.get("/api/railway/publish/summary", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const prereqs = await checkPrereqs();
      const run = await getDisplayRun();
      const versioning = await getReleaseVersionSummary();

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
        versioning,
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
      const parsed = z.object({ increment: z.enum(["minor", "major", "flagship"]) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Choose a minor, major, or flagship version increment." });
      const actor = await resolvePublishActor(req);
      const run = await startRun(actor, parsed.data.increment as VersionIncrement);
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
