// Use createLogger for logging ONLY
import type { Express } from "express";
import { getHeapStatistics } from "node:v8";
import { executorManager } from "../executor-manager";
import { getPerformanceDiagnostics } from "../performance-monitor";
import { setTierModel } from "../job-profiles";
import { z } from "zod";
import { createLogger } from "../log";
import { BOOT_ID } from "../db";
import { getSecret, getSecretSync } from "../secrets-store";

const log = createLogger("SetupRoutes");

export async function registerSetupRoutes(app: Express) {
  app.get("/api/diagnostics/performance", (_req, res) => {
    try {
      res.json(getPerformanceDiagnostics());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/setup/status", (_req, res) => {
    try {
      const status = executorManager.getSetupStatus();
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/setup/reset", async (_req, res) => {
    try {
      const status = await executorManager.getStatus();
      if (status.status === "running") {
        await executorManager.stop();
      }
      await executorManager.resetConfig();
      res.json({ message: "Setup has been reset. You can now reconfigure Mantra." });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const setupConfigureSchema = z.object({
    provider: z.enum(["anthropic", "openai"]),
  });

  app.get("/api/setup/secrets-status", async (_req, res) => {
    const [elevenlabsConnected, gmailReadAccess, gmailHealthResult, openaiSubscriptionConnected] = await Promise.all([
      !!getSecretSync("ELEVENLABS_API_KEY"),
      (async () => {
        try {
          const { listGmailAccounts, getAccountScopes } = await import("../gmail");
          const accounts = await listGmailAccounts();
          for (const a of accounts) {
            const scopes = await getAccountScopes(a.id);
            if (scopes.hasGmailRead) return true;
          }
          return false;
        } catch { return false; }
      })(),
      (async () => {
        try {
          const { listGmailAccounts, getAccountScopes, verifyAccountTokenHealth } = await import("../gmail");
          const accounts = await listGmailAccounts();
          if (accounts.length === 0) return { healthy: false, configured: false };
          for (const a of accounts) {
            const scopes = await getAccountScopes(a.id);
            if (scopes.hasGmailRead) {
              const health = await verifyAccountTokenHealth(a.id);
              return { ...health, configured: true };
            }
          }
          return { healthy: false, configured: false };
        } catch { return { healthy: false, configured: false }; }
      })(),
      (async () => {
        try {
          const { getAccount } = await import("../connected-accounts");
          const { createNamedSystemPrincipal } = await import("../principal");
          const { runWithPrincipal } = await import("../principal-context");
          const acct = await runWithPrincipal(createNamedSystemPrincipal("openai-subscription-check"), () => getAccount("openai-subscription-primary"));
          return !!acct;
        } catch { return false; }
      })(),
    ]);

    res.json({
      anthropic: !!getSecretSync("ANTHROPIC_API_KEY"),
      openai: !!getSecretSync("OPENAI_API_KEY"),
      brave: !!getSecretSync("BRAVE_API_KEY") || !!getSecretSync("BRAVE_SEARCH_API_KEY"),
      elevenlabs: elevenlabsConnected,
      gmail: gmailReadAccess,
      gmailHealthy: gmailHealthResult.configured ? gmailHealthResult.healthy : undefined,
      gdrive: !!getSecretSync("GOOGLE_CLIENT_ID") && !!getSecretSync("GOOGLE_CLIENT_SECRET"),
      twitter: await (async () => {
        try {
          const { isTwitterConnected } = await import("../twitter");
          return isTwitterConnected();
        } catch { return false; }
      })(),
      notion: !!getSecretSync("NOTION_API_KEY"),
      plaid: !!getSecretSync("PLAID_CLIENT_ID"),
      github: await (async () => {
        try {
          const { credentialCount } = await import("../github-credentials");
          return (await credentialCount()) > 0;
        } catch { return !!getSecretSync("GITHUB_TOKEN"); }
      })(),
      openaiSubscription: openaiSubscriptionConnected,
      claudeCli: !!getSecretSync("CLAUDE_CODE_OAUTH_TOKEN"),
      expo: !!await getSecret("EXPO_ACCESS_TOKEN"),
      recall: !!(await getSecret("RECALL_API_KEY") && await getSecret("RECALL_REGION")),
      twilio: !!(await getSecret("TWILIO_ACCOUNT_SID") && await getSecret("TWILIO_AUTH_TOKEN") && await getSecret("TWILIO_PHONE_NUMBER")),
      deepgram: !!await getSecret("DEEPGRAM_API_KEY"),
      cartesia: !!(await getSecret("CARTESIA_API_KEY") && await getSecret("CARTESIA_VOICE_ID")),
      sentry: !!(getSecretSync("EXPO_PUBLIC_SENTRY_DSN") && getSecretSync("SENTRY_AUTH_TOKEN") && getSecretSync("SENTRY_ORG") && getSecretSync("SENTRY_PROJECT")),
      sendgrid: !!(getSecretSync("SENDGRID_API_KEY") && getSecretSync("SENDGRID_FROM_EMAIL")),
      phone: false,
      meta: !!(await (async () => {
        try {
          const { getSetting } = await import("../system-settings");
          const cfg = await getSetting<any>("integration.meta.wearables");
          return cfg?.enabled || cfg?.applicationId || cfg?.universalLink;
        } catch { return null; }
      })()),
      automationAuth: !!(await (async () => {
        try {
          const { getAutomationAuthToken } = await import("../automation-auth-token");
          return await getAutomationAuthToken();
        } catch { return null; }
      })()),
    });
  });

  app.post("/api/setup/configure", async (req, res) => {
    try {
      const parsed = setupConfigureSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      const { provider } = parsed.data;

      const apiKey = provider === "anthropic"
        ? getSecretSync("ANTHROPIC_API_KEY")
        : getSecretSync("OPENAI_API_KEY");

      if (!apiKey) {
        return res.status(400).json({
          error: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} API key not configured — add ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} in Settings → Secrets.`,
        });
      }

      await executorManager.ensureDirectoriesAsync();

      const modelPrimary = provider === "anthropic"
        ? "anthropic/claude-sonnet-4-6"
        : "openai/gpt-4o";

      await setTierModel("high", modelPrimary);
      res.json({ message: "Configuration saved successfully" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const personalitySchema = z.object({
    content: z.string().min(1, "Personality content is required"),
  });

  app.post("/api/setup/personality", async (req, res) => {
    try {
      const parsed = personalitySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }

      await executorManager.ensureDirectoriesAsync();
      await executorManager.writeWorkspaceFile("IDENTITY.md", parsed.data.content);
      res.json({ message: "Personality saved successfully" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/setup/personality", async (_req, res) => {
    try {
      const content = await executorManager.readWorkspaceFile("IDENTITY.md");
      res.json({ content: content || "" });
    } catch (error: any) {
      res.json({ content: "" });
    }
  });

  // These constants apply ONLY to /api/health/deep. The plain /api/health is
  // intentionally a process-only liveness probe — see Task #995. Keeping the
  // deep probe gives operators the same JSON shape this endpoint used to
  // return, but the watchdog never depends on it.
  const HEALTH_PROBE_TIMEOUT_MS = 2000;
  const HEALTH_PROBE_BUDGET_MS = 2000;
  const POOL_SATURATION_DEGRADED_MS = 5000;

  // /api/health: TRIVIAL liveness probe. Must not import or call any DB
  // function, must not await any I/O, must complete in <10ms even when the
  // pg pool is fully saturated. The watchdog (process-wrapper.ts) uses this
  // as the primary HTTP liveness signal; gating it on DB state is what
  // produced the 2026-04 wedges (moklk0c9-dntj, mokxxfcy-3wx6).
  app.get("/api/health", (_req, res) => {
    // Trivial liveness payload per Task #995 spec: { ok, uptime, mem }.
    // Anything richer (bootId, pool state, db probe) belongs on
    // /api/health/deep so the watchdog probe stays minimal and never
    // depends on subsystems.
    const mem = process.memoryUsage();
    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      mem: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
      },
    });
  });

  // /api/health/deep: full degraded-state probe (DB probe + saturation). Same
  // JSON shape and 200/503 mapping that /api/health used to return — preserved
  // verbatim for operator dashboards and gateway diagnostics.
  app.get("/api/health/deep", async (_req, res) => {
    const { probeDb, getDbSaturationInfo } = await import("../db");
    const mem = process.memoryUsage();
    const maxHeapBytes = getHeapStatistics().heap_size_limit;
    const maxHeapMB = Math.round((maxHeapBytes / 1024 / 1024) * 10) / 10;
    const heapUsedPct = Math.round((mem.heapUsed / maxHeapBytes) * 1000) / 10;

    const probe = await probeDb(HEALTH_PROBE_TIMEOUT_MS);
    const sat = getDbSaturationInfo();

    const reasons: string[] = [];
    if (!probe.ok) reasons.push(`db_probe_failed:${probe.error || "unknown"}`);
    else if (probe.durationMs > HEALTH_PROBE_BUDGET_MS) reasons.push(`db_probe_slow:${probe.durationMs}ms`);
    if (sat.saturatedForMs > POOL_SATURATION_DEGRADED_MS) {
      reasons.push(`pool_saturated:${sat.saturatedForMs}ms waiting=${sat.waiting}`);
    }

    const degraded = reasons.length > 0;
    const status = degraded ? 503 : 200;

    res.status(status).json({
      status: degraded ? "degraded" : "ok",
      degraded,
      reasons,
      bootId: BOOT_ID,
      uptime: process.uptime(),
      db: {
        probe,
        pool: { total: sat.total, idle: sat.idle, waiting: sat.waiting },
        saturatedForMs: sat.saturatedForMs,
        lastSuccessfulProbeAt: sat.lastSuccessfulProbeAt,
      },
      memory: {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        maxHeapMB,
        heapUsedPct,
      },
    });
  });
}
