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
import { registerPdfRoutes } from "./routes/pdf";
import { registerCompanyRoutes } from "./company-routes";
import { registerBusinessModelRoutes } from "./business-model-routes";
import { registerBusinessBudgetRoutes } from "./business-budget-routes";
import { registerBusinessHiringRoutes } from "./business-hiring-routes";
import { registerBusinessPlanRoutes } from "./business-plan-routes";
import { registerJobRoleRoutes } from "./job-role-routes";
import { registerMetricsRoutes } from "./metrics-routes";
import { registerBusinessDefinitionRoutes } from "./business-definition-routes";
import { peopleStorage } from "./people-storage";
import { registerGoalRoutes } from "./goal-routes";
import { registerTagRoutes } from "./tag-routes";
import { registerObjectGrantRoutes } from "./object-grant-routes";
import { registerTeamRoutes } from "./team-routes";
import { registerOrganizationRoutes } from "./organization-routes";
import { registerDriveResourceRoutes } from "./drive-resource-routes";
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
import { registerAgendaRoutes } from "./agenda-routes";
import { registerPromptModuleRoutes } from "./prompt-module-routes";
import { registerDomainRoutes } from "./routes/index";
import { diagnoseGmailBatchRead } from "./bridge-tools";
import { registerExportRoutes } from "./export-routes";
import { registerReferenceRoutes } from "./reference-routes";
import { registerLifeAddressingCutoverRoutes } from "./life-addressing-cutover-routes";
import { registerRuntimeRoutes } from "./runtime-routes";
import { registerBackupRoutes } from "./routes/backup";
import { registerAdminRoutes } from "./routes/admin";
import { registerMeetingDistributionRoutes } from "./routes/meeting-distributions";
import { registerMeetingPolicyRoutes } from "./routes/meeting-policy";
import { registerMeetingLifecycleRoutes } from "./routes/meeting-lifecycle";
import { registerMeetingSpeakerRoutes } from "./routes/meeting-speakers";
import { registerMeetingAudioSourceRoutes } from "./routes/meeting-audio-sources";
import { registerMeetingsRoutes } from "./routes/meetings";
import { registerMeetingAudioRetentionRoutes } from "./routes/meeting-audio-retention";
import { requireAuth, requireAdmin } from "./auth";
import { findOrphanedChildren, cleanupOrphanedChildren } from "./session-tree-cleanup";
import { resolveUserPrincipalForSessionRequest } from "./client-presence";
import type { Principal } from "./principal";
import { principalHasPermission } from "./permissions";

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
      resolveUserPrincipalForSessionRequest(request).then((principal) => {
        if (!principal || !principalHasPermission(principal, "system:read")) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        const origin = request.headers.origin;
        const host = request.headers["x-forwarded-host"]?.toString().split(",")[0]?.trim() || request.headers.host;
        if (origin && host && new URL(origin).host !== host) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        (request as IncomingMessage & { dashboardPrincipal: Principal }).dashboardPrincipal = principal;
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
      }).catch(() => socket.destroy());
    } else if (pathname === "/ws/events") {
      resolveUserPrincipalForSessionRequest(request)
        .then((principal) => {
          if (!principal || principal.actorType !== "user" || !principal.userId || !principal.accountId) {
            wsLog.warn("eventsWss upgrade rejected: authentication required");
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          (request as IncomingMessage & { eventPrincipal: Principal }).eventPrincipal = principal;
          wsLog.log(`upgrade → eventsWss account=${principal.accountId}`);
          eventsWss.handleUpgrade(request, socket, head, (ws) => {
            wsLog.log("eventsWss handleUpgrade complete, emitting connection");
            eventsWss.emit("connection", ws, request);
          });
        })
        .catch((error) => {
          wsLog.error("eventsWss upgrade authentication failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          socket.destroy();
        });
    } else if (pathname === "/ws/recall-participant-audio" || pathname === "/ws/recall-participant-audio/") {
      const handler = app.locals.recallMeetingAudioUpgrade as ((request: IncomingMessage, socket: typeof socket, head: Buffer) => void) | undefined;
      if (!handler) { wsLog.warn("Recall participant audio upgrade handler unavailable"); socket.destroy(); }
      else handler(request, socket, head);
    } else if (pathname === "/ws/native-meeting-audio") {
      resolveUserPrincipalForSessionRequest(request)
        .then((principal) => {
          if (!principal || principal.actorType !== "user" || !principal.userId || !principal.accountId) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          const origin = request.headers.origin;
          const host = request.headers["x-forwarded-host"]?.toString().split(",")[0]?.trim() || request.headers.host;
          if (origin && host && new URL(origin).host !== host) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          const handler = app.locals.nativeMeetingAudioUpgrade as ((request: IncomingMessage & { nativeMeetingPrincipal?: Principal }, socket: typeof socket, head: Buffer) => void) | undefined;
          if (!handler) {
            wsLog.warn("Native meeting audio upgrade handler unavailable");
            socket.destroy();
            return;
          }
          (request as IncomingMessage & { nativeMeetingPrincipal?: Principal }).nativeMeetingPrincipal = principal;
          handler(request, socket, head);
        })
        .catch((error) => {
          wsLog.error("native meeting audio upgrade authentication failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          socket.destroy();
        });
    } else if (pathname === "/ws/meeting-visualizer") {
      const handler = app.locals.meetingVisualizerUpgrade as ((request: IncomingMessage, socket: typeof socket, head: Buffer) => void) | undefined;
      if (!handler) { wsLog.warn("Meeting visualizer upgrade handler unavailable"); socket.destroy(); }
      else handler(request, socket, head);
    } else if (pathname === "/vite-hmr") {
      resolveUserPrincipalForSessionRequest(request)
        .then((principal) => {
          if (!principal || principal.actorType !== "user" || !principal.userId) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
          }
        })
        .catch(() => {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
        });
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

  wss.on("connection", (ws, request) => {
    const principal = (request as IncomingMessage & { dashboardPrincipal?: Principal }).dashboardPrincipal;
    if (!principal || !principalHasPermission(principal, "system:read")) return ws.close(1008, "Permission required");
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

  await registerChatRoutes(app);

  // Confirmed user-data leak surfaces: route auth establishes request principal
  // for document-backed storage and external-account access before handlers run.
  app.use(["/api/people", "/api/life-goals", "/api/calendar", "/api/context", "/api/email-sync", "/api/gmail", "/api/twitter", "/api/objects"], requireAuth);

  registerPeopleRoutes(app, peopleStorage);
  registerPdfRoutes(app);
  registerCompanyRoutes(app);
  registerBusinessModelRoutes(app);
  registerBusinessBudgetRoutes(app);
  registerBusinessHiringRoutes(app);
  registerBusinessPlanRoutes(app);
  registerJobRoleRoutes(app);
  registerMetricsRoutes(app);
  registerBusinessDefinitionRoutes(app);
  registerGoalRoutes(app);
  registerReferenceRoutes(app);
  registerLifeAddressingCutoverRoutes(app);
  registerRuntimeRoutes(app);
  registerTagRoutes(app);
  registerObjectGrantRoutes(app);
  registerTeamRoutes(app);
  registerOrganizationRoutes(app);
  registerDriveResourceRoutes(app);
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
  registerAgendaRoutes(app);
  registerPromptModuleRoutes(app);
  registerExportRoutes(app);
  registerBackupRoutes(app);
  registerAdminRoutes(app);
  registerMeetingDistributionRoutes(app);
  registerMeetingPolicyRoutes(app);
  registerMeetingLifecycleRoutes(app);
  registerMeetingSpeakerRoutes(app);
  registerMeetingAudioSourceRoutes(app);
  registerMeetingsRoutes(app);
  registerMeetingAudioRetentionRoutes(app);
  (async () => {
    try {
      const { documentStorage } = await import("./memory/document-storage");
      const journalDocs = await documentStorage.getDocumentsByType("journal" as any);
      if (journalDocs.length > 0) {
        for (const doc of journalDocs) {
          await documentStorage.deleteDocument("journal" as any, doc.docId);
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
