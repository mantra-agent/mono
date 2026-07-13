import type { Express, Request, Response } from "express";
import type { Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { executorManager } from "./executor-manager";
import { registerChatRoutes } from "./integrations/chat";
import { eventBus } from "./event-bus";
import type { IncomingMessage } from "http";
import { parse as parseUrl } from "url";
import { createLogger, registerLogSink } from "./log";
// Use createLogger for logging ONLY
import { setWsConnectionCount } from "./performance-monitor";
import { registerPeopleRoutes } from "./people-routes";
import { peopleStorage } from "./people-storage";
import { registerGoalRoutes } from "./goal-routes";
import { registerTagRoutes } from "./tag-routes";
import { registerCalendarRoutes } from "./calendar-routes";
import { registerObservationRoutes } from "./thought-routes";
import { registerTimerRoutes } from "./timer-routes";
import { registerMemoryRoutes, registerMigrationRoutes } from "./memory";
import { registerContextRoutes } from "./context-routes";
import { registerStrategyRoutes } from "./strategy-routes";
import { registerDecisionsRoutes } from "./decisions-routes";
import { registerThesisRoutes } from "./thesis-routes";
import { registerNewsRoutes } from "./news-routes";
import { registerObjectStorageRoutes } from "./object_storage";
import { registerSkillRoutes } from "./skill-routes";
import { registerPromptModuleRoutes } from "./prompt-module-routes";
import { registerDomainRoutes } from "./routes/index";
import { diagnoseGmailBatchRead } from "./bridge-tools";
import { registerExportRoutes } from "./export-routes";
import { registerReferenceRoutes } from "./reference-routes";
import { registerBackupRoutes } from "./routes/backup";
import { registerAdminRoutes } from "./routes/admin";
import { requireAuth, requireAdmin } from "./auth";
import { findOrphanedChildren, cleanupOrphanedChildren } from "./session-tree-cleanup";

const wsLog = createLogger("WS");

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  const serverStartTime = new Date();
  const wss = new WebSocketServer({ noServer: true });
  const eventsWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
    const pathname = parseUrl(request.url || "").pathname;
    wsLog.log(`upgrade path=${pathname} url=${request.url}`);

    if (pathname === "/ws") {
      wsLog.log(`upgrade → wss (dashboard logs)`);
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else if (pathname === "/ws/events") {
      wsLog.log(`upgrade → eventsWss (chat stream)`);
      eventsWss.handleUpgrade(request, socket, head, (ws) => {
        wsLog.log(`eventsWss handleUpgrade complete, emitting connection`);
        eventsWss.emit("connection", ws, request);
      });
    } else if (pathname === "/ws/twilio-media") {
      const handler = app.locals.twilioMediaUpgrade as ((request: IncomingMessage, socket: typeof socket, head: Buffer) => void) | undefined;
      if (!handler) { wsLog.warn("Twilio media upgrade handler unavailable"); socket.destroy(); }
      else handler(request, socket, head);
    } else if (pathname === "/ws/recall-participant-audio" || pathname === "/ws/recall-participant-audio/") {
      const handler = app.locals.recallMeetingAudioUpgrade as ((request: IncomingMessage, socket: typeof socket, head: Buffer) => void) | undefined;
      if (!handler) { wsLog.warn("Recall participant audio upgrade handler unavailable"); socket.destroy(); }
      else handler(request, socket, head);
    } else if (pathname === "/vite-hmr") {
      // Let Vite's HMR handler (registered later) handle this upgrade
    } else {
      wsLog.warn(`upgrade unknown path=${pathname} — destroying socket`);
      socket.destroy();
    }
  });

  const broadcastLog = (log: { level: string; message: string; source: string; bootId?: string }) => {
    const data = JSON.stringify({ type: "log", log: { ...log, timestamp: new Date().toISOString(), id: Date.now() } });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  };

  executorManager.onLog(broadcastLog);

  registerLogSink((entry) => {
    const log = { ...entry, bootId: eventBus.bootId };
    broadcastLog(log);
  });

  wss.on("connection", (ws) => {
    setWsConnectionCount(wss.clients.size + eventsWss.clients.size);
    ws.send(JSON.stringify({ type: "connected", message: "WebSocket connected to Mantra Dashboard" }));
    ws.on("close", () => {
      setWsConnectionCount(wss.clients.size + eventsWss.clients.size);
    });
  });

  await registerDomainRoutes(app, serverStartTime, wss, eventsWss);

  const routesLog = createLogger("routes");

  import("./capture-processor").then(({ initCaptureProcessor }) => {
    initCaptureProcessor();
  }).catch(err => {
    routesLog.warn("CaptureProcessor failed to initialize (non-fatal):", err instanceof Error ? err.message : String(err));
  });

  import("./people-storage").then(async ({ PeopleStorage }) => {
    try {
      const { db } = await import("./db");
      const { sql } = await import("drizzle-orm");
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS person_emails (
          email TEXT PRIMARY KEY,
          person_id TEXT NOT NULL,
          person_name TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'contact_info',
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const count = await PeopleStorage.rebuildEmailIndex();
      routesLog.info(`PersonEmailIndex: rebuilt ${count} email(s)`);
    } catch (err) {
      routesLog.warn("PersonEmailIndex: rebuild failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
  });

  await registerChatRoutes(app);

  // Confirmed user-data leak surfaces: route auth establishes request principal
  // for document-backed storage and external-account access before handlers run.
  app.use(["/api/people", "/api/life-goals", "/api/calendar", "/api/context", "/api/email-sync", "/api/gmail", "/api/twitter"], requireAuth);

  registerPeopleRoutes(app, peopleStorage);
  registerGoalRoutes(app);
  registerReferenceRoutes(app);
  registerTagRoutes(app);
  registerCalendarRoutes(app);
  registerTimerRoutes(app);
  registerMemoryRoutes(app);
  registerMigrationRoutes(app);
  registerContextRoutes(app);
  registerObservationRoutes(app);
  registerStrategyRoutes(app);
  registerDecisionsRoutes(app);
  registerThesisRoutes(app);
  registerNewsRoutes(app);
  registerObjectStorageRoutes(app);
  registerSkillRoutes(app);
  registerPromptModuleRoutes(app);
  registerExportRoutes(app);
  registerBackupRoutes(app);
  registerAdminRoutes(app);
  (async () => {
    try {
      const { documentStorage } = await import("./memory/document-storage");
      const journalDocs = await documentStorage.getDocumentsByType("journal" as any);
      if (journalDocs.length > 0) {
        for (const doc of journalDocs) {
          await documentStorage.deleteDocument("journal" as any, String(doc.id));
        }
        routesLog.log(`journal-cleanup: Deleted ${journalDocs.length} old documentStorage journal entries`);
      }
    } catch (err: any) {
      routesLog.warn(`journal-cleanup: Failed to clean old journal entries (non-fatal): ${err.message}`);
    }
  })();


  app.post("/api/client-error", async (req: Request, res: Response) => {
    try {
      const { endpoint, message, status: clientStatus, ts } = req.body || {};
      const logger = (await import("./log")).createLogger("client-beacon");
      logger.error(`[client-error] endpoint=${endpoint} status=${clientStatus} msg=${message} ts=${ts}`);
    } catch {}
    res.status(204).end();
  });

  function buildRepoUrlDisplay(): { repoUrlSet: boolean; repoUrlDisplay?: string } {
    const repoUrl = process.env.GITHUB_REPO_URL;
    let repoUrlDisplay: string | undefined;
    if (repoUrl) {
      try {
        const parsed = new URL(repoUrl);
        repoUrlDisplay = `${parsed.host}${parsed.pathname.replace(/\.git$/, "")}`;
      } catch {
        repoUrlDisplay = "(unparseable)";
      }
    }
    return { repoUrlSet: !!repoUrl, repoUrlDisplay };
  }

  async function validateGitHubToken(token: string): Promise<{ ok: true; login?: string } | { ok: false; status: number | null; error: string }> {
    try {
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (userRes.ok) {
        const user = await userRes.json() as { login?: string };
        return { ok: true, login: user?.login };
      }
      let detail = "";
      try {
        const body = await userRes.json() as { message?: string };
        if (body?.message) detail = `: ${body.message}`;
      } catch {}
      return {
        ok: false,
        status: userRes.status,
        error: `GitHub /user returned HTTP ${userRes.status}${detail}`,
      };
    } catch (err: any) {
      return {
        ok: false,
        status: null,
        error: `Could not reach GitHub: ${err?.message || String(err)}`,
      };
    }
  }

  // GitHub status — aggregates from github_credentials
  app.get("/api/integrations/github/status", async (_req: Request, res: Response) => {
    const { repoUrlSet, repoUrlDisplay } = buildRepoUrlDisplay();
    try {
      const { listCredentials } = await import("./github-credentials");
      const creds = await listCredentials();
      if (creds.length === 0) {
        return res.json({
          connected: false,
          status: "disconnected",
          error: "No GitHub credentials configured",
          repoUrlSet,
          repoUrlDisplay,
          credentials: [],
        });
      }
      // Validate default credential
      const defaultCred = creds.find((c) => c.isDefault) || creds[0];
      const { getGitHubAccessToken } = await import("./github-auth");
      const token = await getGitHubAccessToken();
      const result = await validateGitHubToken(token);
      if (!result.ok) {
        routesLog.warn(`github status: /user lookup failed: ${result.error}`);
        return res.json({
          connected: false,
          status: "error",
          error: result.error,
          repoUrlSet,
          repoUrlDisplay,
          credentials: creds,
        });
      }
      res.json({
        connected: true,
        status: "connected",
        login: result.login,
        repoUrlSet,
        repoUrlDisplay,
        credentials: creds,
      });
    } catch (err: any) {
      return res.json({
        connected: false,
        status: "disconnected",
        error: "No GitHub credentials configured",
        repoUrlSet,
        repoUrlDisplay,
        credentials: [],
      });
    }
  });

  // Multi-credential CRUD
  app.get("/api/integrations/github/credentials", requireAuth, async (_req: Request, res: Response) => {
    try {
      const { listCredentials } = await import("./github-credentials");
      const creds = await listCredentials();
      res.json({ ok: true, credentials: creds });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Failed to list credentials" });
    }
  });

  app.post("/api/integrations/github/credentials", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) return res.status(400).json({ ok: false, error: "Missing 'token' in request body" });

    const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const urlPatterns: string[] = Array.isArray(req.body?.urlPatterns) ? req.body.urlPatterns : [];
    const isDefault = !!req.body?.isDefault;

    // Validate PAT
    const { validateGitHubPAT, addCredential } = await import("./github-credentials");
    const validation = await validateGitHubPAT(token);
    if (!validation.ok) return res.status(400).json({ ok: false, error: validation.error });

    const finalLabel = label || validation.login || "GitHub";
    const finalPatterns = urlPatterns.length > 0
      ? urlPatterns
      : [`github.com/${validation.login}/*`];

    try {
      const cred = await addCredential(token, finalLabel, finalPatterns, isDefault, validation.login);
      routesLog.log(`POST /api/integrations/github/credentials: added id=${cred.id} login=${validation.login}`);
      res.json({ ok: true, credential: cred });
    } catch (err: any) {
      routesLog.error(`POST /api/integrations/github/credentials: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: err?.message || "Failed to add credential" });
    }
  });

  app.put("/api/integrations/github/credentials/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid credential ID" });

    const updates: { label?: string; urlPatterns?: string[]; isDefault?: boolean; token?: string } = {};
    if (typeof req.body?.label === "string") updates.label = req.body.label.trim();
    if (Array.isArray(req.body?.urlPatterns)) updates.urlPatterns = req.body.urlPatterns;
    if (typeof req.body?.isDefault === "boolean") updates.isDefault = req.body.isDefault;
    if (typeof req.body?.token === "string" && req.body.token.trim()) updates.token = req.body.token.trim();

    try {
      const { updateCredential } = await import("./github-credentials");
      const cred = await updateCredential(id, updates);
      if (!cred) return res.status(404).json({ ok: false, error: "Credential not found" });
      routesLog.log(`PUT /api/integrations/github/credentials/${id}: updated`);
      res.json({ ok: true, credential: cred });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Failed to update credential" });
    }
  });

  app.delete("/api/integrations/github/credentials/:id", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: "Invalid credential ID" });

    try {
      const { removeCredential } = await import("./github-credentials");
      const removed = await removeCredential(id);
      routesLog.log(`DELETE /api/integrations/github/credentials/${id}: removed=${removed}`);
      res.json({ ok: true, removed });
    } catch (err: any) {
      if (err.message?.includes("last remaining")) {
        return res.status(400).json({ ok: false, error: err.message });
      }
      res.status(500).json({ ok: false, error: err?.message || "Failed to remove credential" });
    }
  });

  app.post("/api/integrations/github/repo-url", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (url && !url.startsWith("https://")) {
      return res.status(400).json({ error: "URL must start with https://" });
    }
    try {
      const { setSetting } = await import("./system-settings");
      if (url) {
        await setSetting("system.github_repo_url", url);
        process.env.GITHUB_REPO_URL = url;
      } else {
        await setSetting("system.github_repo_url", null);
        delete process.env.GITHUB_REPO_URL;
      }
      const userId = req.session.userId || null;
      routesLog.log(`POST /api/integrations/github/repo-url saved by user=${userId} url=${url ? "(set)" : "(cleared)"}`);
      res.json({ ok: true, repoUrlSet: !!url });
    } catch (err: any) {
      routesLog.error(`POST /api/integrations/github/repo-url: ${err?.message || err}`);
      res.status(500).json({ ok: false, error: err?.message || "Failed to save repo URL" });
    }
  });

  app.get("/api/gitnexus-status", async (_req: Request, res: Response) => {
    try {
      const { getStatus } = await import("./gitnexus-bridge");
      const status = await getStatus();
      res.json(status);
    } catch (err: any) {
      res.json({ ready: false, phase: "error", errorDetail: err.message });
    }
  });

  app.post("/api/gitnexus/restart", async (_req: Request, res: Response) => {
    try {
      const { resetGitNexus, startGitNexus } = await import("./gitnexus-bridge");
      resetGitNexus();
      startGitNexus().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        routesLog.error("gitnexus restart route: startGitNexus threw:", msg);
      });
      res.status(202).json({ ok: true, message: "GitNexus indexing restarted" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/gitnexus/graph", async (req: Request, res: Response) => {
    try {
      const { getGraph } = await import("./gitnexus-graph");
      const MAX_GRAPH_LIMIT = 25_000;
      const limitParam = parseInt(req.query.limit as string);
      const limit = !isNaN(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_GRAPH_LIMIT) : undefined;
      const data = await getGraph(limit);
      res.json(data);
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Graph request failed" });
    }
  });

  app.post("/api/gitnexus/search", async (req: Request, res: Response) => {
    try {
      const { searchCodebase } = await import("./gitnexus-bridge");
      const result = await searchCodebase(req.body?.query || "");
      res.json(result);
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Search failed" });
    }
  });

  app.get("/api/gitnexus/architecture", async (_req: Request, res: Response) => {
    try {
      const { getArchitectureOverview } = await import("./gitnexus-graph");
      const data = await getArchitectureOverview();
      res.json(data);
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Architecture overview failed" });
    }
  });

  app.get("/api/gitnexus/clusters", async (_req: Request, res: Response) => {
    try {
      const { getClusters } = await import("./gitnexus-graph");
      const data = await getClusters();
      res.json(data);
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Cluster query failed" });
    }
  });

  app.get("/api/gitnexus/clusters/:name", async (req: Request, res: Response) => {
    try {
      const { getClusterDetail } = await import("./gitnexus-graph");
      const data = await getClusterDetail(req.params.name as string);
      res.json(data);
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Cluster detail query failed" });
    }
  });

  app.get("/api/gitnexus/processes", async (_req: Request, res: Response) => {
    try {
      const { getProcesses } = await import("./gitnexus-graph");
      const data = await getProcesses();
      res.json(data);
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Process query failed" });
    }
  });

  app.get("/api/gitnexus/processes/:name", async (req: Request, res: Response) => {
    try {
      const { getProcessDetail } = await import("./gitnexus-graph");
      const data = await getProcessDetail(req.params.name as string);
      res.json(data);
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Process detail query failed" });
    }
  });

  app.get("/api/gitnexus/source", async (req: Request, res: Response) => {
    try {
      const filePath = req.query.file as string;
      const startLine = parseInt(req.query.start as string) || 1;
      const endLine = parseInt(req.query.end as string) || startLine + 50;
      if (!filePath) return res.status(400).json({ error: "Missing file parameter" });

      const { resolve, join } = await import("path");
      const { readFile } = await import("fs/promises");
      const root = resolve(process.cwd());
      const full = join(root, filePath);
      if (!full.startsWith(root)) return res.status(403).json({ error: "Path outside workspace" });

      const content = await readFile(full, "utf-8");
      const lines = content.split("\n");
      const s = Math.max(0, startLine - 1);
      const e = Math.min(lines.length, endLine);
      const snippet = lines.slice(s, e);
      res.json({ file: filePath, startLine: s + 1, endLine: e, totalLines: lines.length, content: snippet.join("\n") });
    } catch (err: any) {
      res.status(404).json({ error: err.message || "File not found" });
    }
  });

  app.get("/api/gitnexus/schema", async (_req: Request, res: Response) => {
    try {
      const { getGraphSchema } = await import("./gitnexus-graph");
      const data = await getGraphSchema();
      res.json({ schema: data });
    } catch (err: any) {
      res.status(503).json({ error: err.message || "Schema request failed" });
    }
  });

  app.get("/api/email-sync/health", async (req: Request, res: Response) => {
    try {
      const { getEmailPipelineHealth } = await import("./email-sync");
      const { createLogger } = await import("./log");
      const log = createLogger("EmailSync");
      const health = await getEmailPipelineHealth();

      for (const account of health.accounts) {
        if (account.stale) {
          log.warn(`Stale cache for account ${account.accountId}: last success ${account.lastGoodAt || "never"} (${account.staleDurationMinutes ? account.staleDurationMinutes + "m ago" : "no sync recorded"})`);
        }
      }

      res.json({ ok: health.status !== "failed", status: health.status, anyStale: health.accounts.some(account => account.stale), accounts: health.accounts });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || "Failed to fetch sync health" });
    }
  });

  app.get("/api/diag/gmail", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ ok: false, error: "Diagnostic endpoint disabled in production" });
      return;
    }
    try {
      await diagnoseGmailBatchRead();
      res.json({ ok: true, message: "Gmail diagnostic complete — check server logs for [GmailDiag] output" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || "Diagnostic failed" });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    setTimeout(() => {
      diagnoseGmailBatchRead().catch((err) => {
        routesLog.error("GmailDiag startup diagnostic failed:", err);
      });
    }, 10_000);
  }

  app.get("/api/admin/sessions/orphans", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const candidates = await findOrphanedChildren();
      res.json({ ok: true, count: candidates.length, candidates });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Failed to scan orphans" });
    }
  });

  app.post("/api/admin/sessions/cleanup-orphans", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await cleanupOrphanedChildren();
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Cleanup failed" });
    }
  });

  app.get("/api/encryption/status", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const { scanEncryptionStatus } = await import("./encryption-status");
      const status = await scanEncryptionStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "Encryption status scan failed" });
    }
  });

  return httpServer;
}
