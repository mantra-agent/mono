// Use createLogger for logging ONLY
import type { Express } from "express";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { executorManager } from "../executor-manager";
import { eventBus } from "../event-bus";
import { getTimezone, writeTimezoneToUserMd, getLocalTimeString } from "../timezone";
import { readFile, writeFile, stat, access } from "fs/promises";
import { resolve } from "path";
import { z } from "zod";
import { createLogger, listLogFiles, readLogFile, readLogFileAsync, getCurrentLogFile, appendClientLog, resolveLogFilename, isVerboseEnabled, setVerboseEnabled } from "../log";
import { storage } from "../storage";

const log = createLogger("system-routes");
const CLIENT_LOG_MAX_ENTRIES_PER_MINUTE = 500;
const clientLogBudgets = new Map<string, { windowStartedAt: number; accepted: number }>();

function claimClientLogBudget(key: string, count: number): boolean {
  const now = Date.now();
  const current = clientLogBudgets.get(key);
  if (!current || now - current.windowStartedAt >= 60_000) {
    clientLogBudgets.set(key, { windowStartedAt: now, accepted: count });
    return count <= CLIENT_LOG_MAX_ENTRIES_PER_MINUTE;
  }
  if (current.accepted + count > CLIENT_LOG_MAX_ENTRIES_PER_MINUTE) return false;
  current.accepted += count;
  return true;
}

export async function registerSystemRoutes(app: Express, serverStartTime: Date) {
  // Diagnostic detail is intentionally process-local and defaults off on every boot.

  app.use(["/api/logs", "/api/server", "/api/boot-info", "/api/config", "/api/design-doc"], requireAuth, requirePermission("system:read"));
  app.post("/api/config", requirePermission("system:write"));

  app.get("/api/logs", async (req, res) => {
    try {
      const filename = req.query.file as string | undefined;
      let file: string;
      if (filename) {
        file = resolveLogFilename(filename);
      } else {
        file = getCurrentLogFile();
      }
      const level = req.query.level as string | undefined;
      const source = req.query.source as string | undefined;
      const since = req.query.since as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
      const offset = req.query.offset !== undefined ? parseInt(req.query.offset as string, 10) : undefined;

      const result = await readLogFileAsync(file, { limit, offset, level, source, since });
      res.json(result);
    } catch (error: any) {
      const status = error.message?.includes("Access denied") ? 403 : 500;
      res.status(status).json({ error: error.message });
    }
  });

  app.get("/api/logs/recent", async (req, res) => {
    try {
      const since = req.query.since as string | undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const level = req.query.level as string | undefined;
      const source = req.query.source as string | undefined;

      const entries = await readLogFile(getCurrentLogFile(), { limit, level, source, since, tail: true });
      res.json(entries);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/logs/files", async (_req, res) => {
    try {
      const files = await listLogFiles();
      const currentPath = getCurrentLogFile();
      const currentFilename = currentPath.split("/").pop() || currentPath;
      const safeFiles = files.map(f => ({
        filename: f.filename,
        size: f.size,
        createdAt: f.createdAt,
      }));
      res.json({
        current: currentFilename,
        files: safeFiles,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/logs/dismiss-errors", async (_req, res) => {
    try {
      await storage.dismissLogErrors();
      res.json({ success: true });
    } catch (error: any) {
      log.error("POST /api/logs/dismiss-errors error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/logs/unseen-errors", async (_req, res) => {
    try {
      const dismissedAt = await storage.getLogErrorDismissedAt();
      const dismissedMs = dismissedAt ? new Date(dismissedAt).getTime() : 0;

      const currentPath = getCurrentLogFile();
      const entries = await readLogFile(currentPath, { level: "error", tail: true });
      let latestErrorMs = 0;
      for (const entry of entries) {
        if (entry.ts) {
          const ts = new Date(entry.ts).getTime();
          if (ts > latestErrorMs) latestErrorMs = ts;
        }
      }

      const hasUnseen = latestErrorMs > 0 && latestErrorMs > dismissedMs;
      res.json({ hasUnseen, latestErrorAt: latestErrorMs > 0 ? new Date(latestErrorMs).toISOString() : null });
    } catch (error: any) {
      log.error("GET /api/logs/unseen-errors error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ── Diagnostic detail toggle (debug + verbose in production) ─────────
  app.get("/api/logs/verbose", requireAuth, requirePermission("system:read"), (_req, res) => {
    res.json({ enabled: isVerboseEnabled() });
  });

  app.put("/api/logs/verbose", requireAuth, requirePermission("system:write"), async (req, res) => {
    try {
      const enabled = !!req.body?.enabled;
      setVerboseEnabled(enabled);
      log.info(`Diagnostic detail logging ${enabled ? "enabled" : "disabled"}`);
      res.json({ enabled });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/client-logs", requireAuth, async (req, res) => {
    try {
      const { entries } = req.body || {};
      if (!Array.isArray(entries) || entries.length > 50) {
        return res.status(400).json({ error: "entries must be an array with at most 50 items" });
      }
      const budgetKey = req.principal?.accountId || req.principal?.userId || req.ip || "unknown";
      if (!claimClientLogBudget(budgetKey, entries.length)) {
        return res.status(429).json({ error: "client log rate limit exceeded" });
      }
      for (const entry of entries) {
        if (entry && typeof entry.level === "string" && typeof entry.source === "string" && typeof entry.message === "string") {
          appendClientLog(entry.level, entry.source, entry.message);
        }
      }
      res.status(204).end();
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/logs", async (_req, res) => {
    try {
      res.json({ message: "Log clearing not supported for file-based logs" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/server/start-time", (_req, res) => {
    res.json({ startTime: serverStartTime.toISOString() });
  });

  app.get("/api/boot-info", (_req, res) => {
    res.json({
      bootId: eventBus.bootId,
      bootTimestamp: eventBus.bootTimestamp,
      startTime: serverStartTime.toISOString(),
    });
  });

  app.get("/api/config", async (_req, res) => {
    try {
      const config = await executorManager.readConfig();
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const configBodySchema = z.object({
    model_provider: z.string().optional(),
    model_name: z.string().optional(),
    workspace_path: z.string().optional(),
    voice: z.string().optional(),
  }).passthrough();

  app.post("/api/config", async (req, res) => {
    try {
      const parsed = configBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid config data" });
      }

      const data = parsed.data;
      const configData: Record<string, any> = {};

      if (data.model_provider && data.model_name) {
        configData.agents = {
          defaults: {
            model: {
              primary: `${data.model_provider}/${data.model_name}`,
            },
          },
        };
      }

      await executorManager.writeConfig(configData);
      res.json({ message: "Configuration saved" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/settings/timezone", (_req, res) => {
    try {
      const timezone = getTimezone();
      const localTime = getLocalTimeString();
      res.json({ timezone, localTime });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const timezoneSchema = z.object({
    timezone: z.string().min(1).refine((val) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: val });
        return true;
      } catch {
        return false;
      }
    }, { message: "Invalid timezone identifier" }),
  });

  app.put("/api/settings/timezone", async (req, res) => {
    try {
      const parsed = timezoneSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid timezone" });
      }

      const { timezone } = parsed.data;
      writeTimezoneToUserMd(timezone);

      const status = await executorManager.getStatus();
      if (status.status === "running") {
        try { await executorManager.restart(); } catch (err) { log.warn("executor restart after timezone change failed", err); }
      }

      const localTime = getLocalTimeString();
      res.json({ message: `Timezone set to ${timezone}`, timezone, localTime });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const DESIGN_DOC_PATH = resolve("DESIGN.md");

  app.get("/api/design-doc", async (_req, res) => {
    try {
      try {
        await access(DESIGN_DOC_PATH);
      } catch {
        return res.json({ content: "", exists: false });
      }
      const content = await readFile(DESIGN_DOC_PATH, "utf-8");
      const fileStat = await stat(DESIGN_DOC_PATH);
      res.json({ content, exists: true, lastModified: fileStat.mtime.toISOString() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/design-doc", async (req, res) => {
    try {
      const { content } = req.body;
      if (typeof content !== "string") {
        return res.status(400).json({ error: "content is required and must be a string" });
      }
      await writeFile(DESIGN_DOC_PATH, content, "utf-8");
      const fileStat = await stat(DESIGN_DOC_PATH);
      res.json({ message: "Design doc saved", lastModified: fileStat.mtime.toISOString() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

}
