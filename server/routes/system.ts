// Use createLogger for logging ONLY
import type { Express } from "express";
import { requireAuth } from "../auth";
import { claimBrowserTelemetryBudget, enqueueBrowserTelemetry, getBrowserTelemetrySummary, logBrowserTelemetryIngestFailure, parseBrowserTelemetryBatch, pruneExpiredBrowserTelemetry } from "../browser-telemetry-storage";
import { requirePermission } from "../permissions";
import { executorManager } from "../executor-manager";
import { eventBus } from "../event-bus";
import { getTimezone } from "../timezone";
import { readFile, writeFile, stat, access } from "fs/promises";
import { resolve } from "path";
import { z } from "zod";
import { createLogger, listLogFiles, readLogFile, readLogFileAsync, getCurrentLogFile, appendClientLog, resolveLogFilename, isVerboseEnabled, setVerboseEnabled } from "../log";
import { storage } from "../storage";
import { db } from "../db";
import { userProfiles } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { getPrincipal } from "../principal";

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

  // Public client-safe Sentry bootstrap (DSN only). Covered by /api/public/* policy.
  app.get("/api/public/sentry-bootstrap", async (_req, res) => {
    try {
      const { resolveSentryDsnSync } = await import("../integrations/sentry/config");
      const dsn = resolveSentryDsnSync();
      res.setHeader("Cache-Control", "no-store");
      res.json({
        dsn,
        environment:
          process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
          process.env.NODE_ENV ||
          "development",
        release: process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null,
      });
    } catch (err) {
      log.warn(`Sentry bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
      res.setHeader("Cache-Control", "no-store");
      res.json({ dsn: null, environment: null, release: null });
    }
  });

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

  app.post("/api/browser-telemetry", requireAuth, async (req, res) => {
    try {
      const events = parseBrowserTelemetryBatch(req.body || {});
      const budgetKey = req.principal?.accountId || req.principal?.userId || req.ip || "unknown";
      if (!claimBrowserTelemetryBudget(budgetKey, events.length)) {
        return res.status(429).json({ error: "browser telemetry rate limit exceeded" });
      }
      // Accept immediately; durable insert runs on the serial log-sink lane so
      // continuous browser samples never hold request workers or foreground pool.
      const accepted = enqueueBrowserTelemetry(req.principal!, events);
      if (Math.random() < 0.01) void pruneExpiredBrowserTelemetry().catch(logBrowserTelemetryIngestFailure);
      res.status(202).json({ accepted });
    } catch (error: any) {
      logBrowserTelemetryIngestFailure(error);
      if (error?.name === "ZodError") return res.status(400).json({ error: "invalid browser telemetry payload" });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/browser-telemetry/summary", requireAuth, async (req, res) => {
    try {
      const hours = typeof req.query.hours === "string" ? Number(req.query.hours) : 24;
      res.json(await getBrowserTelemetrySummary(req.principal!, Number.isFinite(hours) ? hours : 24));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/performance/build-deployments", requireAuth, requirePermission("build:read"), async (req, res) => {
    try {
      const { getBuildDeploymentTimingSummary } = await import("../mods/build-deployment-home");
      res.json(await getBuildDeploymentTimingSummary(req.principal!));
    } catch (error: any) {
      log.error("Build deployment timing summary failed", { errorName: error?.name || typeof error });
      res.status(500).json({ error: "Build deployment timing is temporarily unavailable" });
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
          if (entry.level === "error" && entry.aggregate && typeof entry.aggregate === "object") {
            const { enqueueApplicationErrorProjection } = await import("../error-telemetry");
            enqueueApplicationErrorProjection(entry.aggregate);
          }
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

  function formatLocalTimeInTimezone(timezone: string): string {
    return new Date().toLocaleString("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  async function resolvePrincipalTimezone(userId: string, accountId: string | null | undefined): Promise<string> {
    const conditions = [eq(userProfiles.userId, userId)];
    if (accountId) conditions.push(eq(userProfiles.accountId, accountId));
    const [profile] = await db
      .select({ timezone: userProfiles.timezone })
      .from(userProfiles)
      .where(and(...conditions))
      .limit(1);
    const candidate = typeof profile?.timezone === "string" ? profile.timezone.trim() : "";
    if (candidate) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: candidate });
        return candidate;
      } catch {
        // fall through to process default
      }
    }
    return getTimezone();
  }

  // Account timezone is principal-owned user_profiles.timezone (not process-global system_settings).
  app.get("/api/settings/timezone", requireAuth, async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal?.userId) return res.status(401).json({ error: "Authentication required" });
      const timezone = await resolvePrincipalTimezone(principal.userId, principal.accountId);
      res.json({ timezone, localTime: formatLocalTimeInTimezone(timezone) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/settings/timezone", requireAuth, async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal?.userId || !principal.accountId) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const parsed = timezoneSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid timezone" });
      }

      const { timezone } = parsed.data;
      const updated = await db
        .update(userProfiles)
        .set({ timezone, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(eq(userProfiles.userId, principal.userId), eq(userProfiles.accountId, principal.accountId)))
        .returning({ timezone: userProfiles.timezone });
      if (updated.length === 0) {
        // Replay-safe create when foundation rows lag behind first Account open.
        await db.insert(userProfiles).values({
          userId: principal.userId,
          accountId: principal.accountId,
          timezone,
        }).onConflictDoUpdate({
          target: userProfiles.userId,
          set: { accountId: principal.accountId, timezone, updatedAt: sql`CURRENT_TIMESTAMP` },
        });
      }

      res.json({
        message: `Timezone set to ${timezone}`,
        timezone,
        localTime: formatLocalTimeInTimezone(timezone),
      });
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
