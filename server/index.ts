import "./runtime-process-guard";
// Use createLogger for logging ONLY
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { setupAuth } from "./auth";
import { registerApiPolicy } from "./api-policy";
import { createServer } from "http";
import { executorManager } from "./executor-manager";
import { apiTimingMiddleware, startEventLoopMonitor, recordBootTiming } from "./performance-monitor";
import { startMemoryWatchdog } from "./memory-watchdog";
import { describeServiceInstanceLimits, fetchServiceInstanceLimits, resolveServiceInstanceMemoryMB } from "./integrations/railway/client";
import { resolveRailwayEnvironmentControl } from "./integrations/railway/environment-control";
import { initTimezone, getTimezone } from "./timezone";
import { initProfiles } from "./job-profiles";
import { migrateLegacyModelProfiles } from "./model-connectors";
import { spawn } from "child_process";
import { resolve as resolvePath } from "path";
import { createLogger } from "./log";
import { bootTracker, registerBootStatusRoute } from "./boot-tracker";
import { runSchemaBootstrap } from "./schema-bootstrap";
import { isRecoverablePostgresConnectionError } from "./postgres-errors";
import { closeDatabasePools } from "./db";
import { admissionController } from "./run-admission";
import { timerScheduler } from "./timer-scheduler";
import { closeBrowser } from "./browser-manager";
import { stopMemoryWatchdog } from "./memory-watchdog";
import { stopSnapshotHeartbeat } from "./wedge-watchdog";
import { beginRuntimeProcessLifecycle, markRuntimeProcessTermination, type RuntimeTerminationInput } from "./runtime-process-lifecycle";

const serverLog = createLogger("Server");

const timezoneReady = initTimezone().catch(err => {
  serverLog.error("Timezone init failed:", err.message);
});

process.on("uncaughtException", (error, origin) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  if (isRecoverablePostgresConnectionError(error)) {
    serverLog.warn(`transient postgres connection exception origin=${origin}: ${error.message}; process remains available`);
    return;
  }
  serverLog.error(`[FATAL] uncaughtException (origin=${origin}):`, message);
});

process.on("unhandledRejection", (reason) => {
  if (isRecoverablePostgresConnectionError(reason)) {
    const error = reason as Error;
    serverLog.warn(`transient postgres connection rejection: ${error.message}; process remains available`);
    return;
  }
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
  serverLog.error(`unhandledRejection:`, message);
});

import { addObjectAclsTable } from "./migrations/add-object-acls";
import { ensureVaults } from "./migrations/ensure-vaults";
import { migrateProjectNotesSpecToLibrary } from "./migrations/migrate-project-notes-spec-to-library";
import { adoptRayPersonalLibraryIndex } from "./migrations/adopt-ray-personal-library-index";

const objectAclsMigrationReady = addObjectAclsTable();
const vaultsMigrationReady = objectAclsMigrationReady.then(() => ensureVaults());


import { registerSessionOutputBufferListener } from "./session-output-buffer-listener";
registerSessionOutputBufferListener();


import { loadEncryptionKeys } from "./encryption";
loadEncryptionKeys();

const _BOOTSTRAP_ENV_VARS = ["DATABASE_URL", "SESSION_SECRET", "ENCRYPTION_KEY"] as const;
{
  const missing = _BOOTSTRAP_ENV_VARS.filter(v => !process.env[v]);
  if (missing.length > 0) {
    serverLog.error(`Missing required bootstrap env vars: ${missing.join(", ")}. These must be set in the host environment before starting the server.`);
    throw new Error(`Missing required bootstrap environment variables: ${missing.join(", ")}.`);
  } else {
    serverLog.log("Bootstrap env vars present (DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY)");
  }
}

import { loadAllSecrets } from "./secrets-store";
await loadAllSecrets();

// Migrate legacy GITHUB_TOKEN to multi-credential system
try {
  const { migrateGitHubToken } = await import("./github-auth");
  await migrateGitHubToken();
} catch (err: any) {
  serverLog.warn(`GitHub credential migration skipped: ${err?.message || err}`);
}

// Load GITHUB_REPO_URL from system settings if not already in env
if (!process.env.GITHUB_REPO_URL) {
  try {
    const { getSetting } = await import("./system-settings");
    const saved = await getSetting<string>("system.github_repo_url");
    if (saved) {
      process.env.GITHUB_REPO_URL = saved;
      serverLog.log("GITHUB_REPO_URL loaded from system settings");
    }
  } catch (err: any) {
    serverLog.warn(`Failed to load GITHUB_REPO_URL from settings: ${err?.message || err}`);
  }
}

// Boot-time encryption status scan (Task #1036). Logs an INFO line with
// counts; emits an ERROR `encryption_key_mismatch` line if any app secret
// or connected account fails to decrypt with the current ENCRYPTION_KEY.
import { scanEncryptionStatus, formatEncryptionStatusLog } from "./encryption-status";
try {
  const encStatus = await scanEncryptionStatus();
  serverLog.log(`INFO ${formatEncryptionStatusLog(encStatus)}`);
  const undAppNames = encStatus.appSecrets.undecryptableNames;
  const undAcctIds = encStatus.connectedAccounts.undecryptableAccountIds;
  if (encStatus.appSecrets.undecryptable > 0 || encStatus.connectedAccounts.undecryptable > 0) {
    serverLog.error(
      `ERROR encryption_key_mismatch app_secrets=[${undAppNames.join(",")}]` +
      ` connected_accounts=[${undAcctIds.join(",")}]` +
      ` current_key_fp=${encStatus.currentKeyFingerprint} previous_key_set=${encStatus.previousKeySet}`
    );
  }
} catch (err: any) {
  serverLog.warn(`encryption status scan failed at boot: ${err?.message || err}`);
}

// One-shot Claude CLI runtime probe (Task #1045). Emits a single greppable
// `cli_runtime_probe` INFO line covering: cli.js path & existence/size,
// runtime dir depth-1 file count + total bytes, node version / cwd / NODE_ENV,
// OAuth token presence/length/fingerprint (never the token itself), and warm
// pool size. Catches "the runtime didn't get bundled into the Railway image"
// or "the OAuth token is missing in this env" before any user request hits
// the CLI provider. Sits right after the encryption_status scan from #1036.
try {
  const { probeCliRuntime } = await import("./cli-sdk-adapter");
  const p = probeCliRuntime();
  serverLog.log(
    `cli_runtime_probe cli_path=${p.cliPath} cli_path_exists=${p.cliPathExists} ` +
    `cli_path_size_bytes=${p.cliPathSizeBytes ?? "null"} ` +
    `runtime_dir_file_count=${p.runtimeDirFileCount ?? "null"} ` +
    `runtime_dir_total_bytes=${p.runtimeDirTotalBytes ?? "null"} ` +
    `node_version=${p.nodeVersion} cwd=${p.cwd} node_env=${p.nodeEnv} ` +
    `oauth_token_present=${p.oauthTokenPresent} oauth_token_len=${p.oauthTokenLen} ` +
    `oauth_token_fp=${p.oauthTokenFp} warm_pool_size=${p.warmPoolSize}`,
  );
} catch (err) {
  serverLog.warn(`cli_runtime_probe failed: ${err instanceof Error ? err.message : String(err)}`);
}

import "./autonomous-skill-runner";

const app = express();
const httpServer = createServer(app);
installGracefulShutdown();

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// Global browser boundary. Keep this small enough for the current SPA while
// denying framing, MIME confusion, ambient device APIs, and insecure transport.
const configuredFrameAncestors = process.env.CSP_FRAME_ANCESTORS?.trim();
const frameAncestors = configuredFrameAncestors || "'self'";
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https: wss:",
    "frame-src 'self' https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    `frame-ancestors ${frameAncestors}`,
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use((req, _res, next) => {
  if (req.path.startsWith("/api/voice/llm/")) {
    serverLog.log(`[VoiceLlmTrap] INCOMING ${req.method} ${req.path} content-type=${req.headers["content-type"]} content-length=${req.headers["content-length"]} user-agent=${req.headers["user-agent"]} host=${req.headers["host"]} x-forwarded-for=${req.headers["x-forwarded-for"]} ts=${new Date().toISOString()}`);
  }
  next();
});

app.use(
  express.json({
    limit: "50mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use((req, _res, next) => {
  if (req.path.startsWith("/api/voice/llm/") && req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    const bodyKeys = Object.keys(req.body);
    const hasSessionId = "sessionId" in req.body;
    const hasConversationId = "sessionId" in req.body;
    serverLog.log(`[VoiceLlmTrap] BODY keys=[${bodyKeys.join(",")}] hasSessionId=${hasSessionId} hasConversationId=${hasConversationId} ts=${new Date().toISOString()}`);
  }
  next();
});

app.use(express.urlencoded({ extended: false }));
app.use(apiTimingMiddleware);

// Wedge-watchdog HTTP req tracking: name the offender if a request hangs
// while the event loop or DB pool is wedged. Lazy-require so import order
// stays clean and the watchdog can be skipped if unavailable.
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  if (req.path === "/api/health" || req.path === "/api/diag/inflight") return next();
  let trackEnd: ((id: string) => void) | null = null;
  let id: string | null = null;
  try {
    const ww = require("./wedge-watchdog");
    id = `${req.method}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    ww.trackHttpReqStart(id, req.method, req.path);
    trackEnd = ww.trackHttpReqEnd;
  } catch { /* watchdog not available */ }
  if (id && trackEnd) {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      trackEnd!(id!);
    };
    res.on("finish", end);
    res.on("close", end);
  }
  next();
});

// Maintenance middleware: returns 503 for non-allowlisted /api routes when
// the instance is in maintenance mode (see server/maintenance.ts). Used by
// the DB sync flow on the dev instance — quiesces HTTP traffic while
// tables are being truncated and re-imported, then a clean restart lifts
// the flag and clears all in-memory caches.
import("./maintenance").then(({ maintenanceMiddleware }) => {
  app.use(maintenanceMiddleware);
}).catch((err) => {
  serverLog.warn("Maintenance middleware unavailable; continuing without maintenance-mode guard:", err);
});

registerBootStatusRoute(app);

export function log(message: string, source = "express", level: "debug" | "info" | "verbose" = "info") {
  const sourceLog = createLogger(source);
  if (level === "verbose") {
    sourceLog.verbose(message);
  } else if (level === "debug") {
    sourceLog.debug(message);
  } else {
    sourceLog.log(message);
  }
}

const SENSITIVE_KEYS = new Set([
  "tokens", "access_token", "refresh_token", "token", "authorization",
  "client_secret", "api_key", "apiKey", "secret", "password",
  "ct", "tag", "iv", "salt",
]);

function sensitiveFieldReplacer(key: string, value: unknown): unknown {
  if (SENSITIVE_KEYS.has(key) && value && typeof value === "string") {
    return "[REDACTED]";
  }
  return value;
}

const POLLING_ENDPOINTS = new Set([
  "/api/gateway/status",
  "/api/sessions",
  "/api/build/status",
  "/api/inference/stats",
  "/api/gitnexus-status",
  "/api/health",
]);

const NOISY_REQUEST_ENDPOINTS = new Set([
  "/api/client-logs",
  "/api/browser-telemetry",
]);

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse && !POLLING_ENDPOINTS.has(path)) {
        let bodyStr: string;
        if (Array.isArray(capturedJsonResponse)) {
          bodyStr = `[Array(${capturedJsonResponse.length})]`;
        } else {
          bodyStr = JSON.stringify(capturedJsonResponse, sensitiveFieldReplacer);
          if (bodyStr.length > 500) {
            bodyStr = bodyStr.slice(0, 500) + "…[truncated]";
          }
        }
        logLine += ` :: ${bodyStr}`;
      }

      // Successful GET/HEAD/OPTIONS = debug (high-frequency polling/render).
      // Errors (4xx/5xx) and mutations (POST/PUT/DELETE/PATCH) = info.
      const isReadOnly = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
      const isSuccess = res.statusCode < 400;
      const isNoisy = NOISY_REQUEST_ENDPOINTS.has(path);
      const level = isNoisy ? "verbose" as const : (isReadOnly && isSuccess) ? "debug" as const : "info" as const;
      log(logLine, "express", level);
    }
  });

  next();
});


(async () => {
  const t0 = Date.now();
  const bootPhases: { name: string; durationMs: number }[] = [];

  // Resolve runtime identity first: which platform/env/host this process IS.
  // The async Platforms lookup is cached for the process lifetime, adopts the
  // hosting binding's publicUrl as the canonical public base URL and logs
  // loudly when the runtime binding cannot be resolved.
  const { resolveRuntimeIdentity, describeRuntimeIdentity } = await import("./runtime-identity");
  const runtimeIdentity = await resolveRuntimeIdentity();
  log(`[startup] ${describeRuntimeIdentity(runtimeIdentity)}`, "boot");

  await timezoneReady;

  bootTracker.startPhase("database");
  const tMigrate0 = Date.now();
  await runSchemaBootstrap("boot");
  await beginRuntimeProcessLifecycle();
  // Persona templates and skill recommendations are a runtime invariant, not
  // optional background maintenance. Complete them before accepting requests
  // so the first skill run after boot cannot observe a half-seeded state.
  const { personaStorage } = await import("./file-storage/persona-storage");
  await personaStorage.seedDefaults();
  const { seedSkillPersonaRecommendations } = await import("./skill-seed");
  await seedSkillPersonaRecommendations();
  const { runDocumentStoreWorkspaceMigrationBootstrap } = await import("./memory/document-store-bootstrap");
  await runDocumentStoreWorkspaceMigrationBootstrap();
  const { purgeRetiredBeliefs } = await import("./memory/retired-beliefs-purge");
  await purgeRetiredBeliefs();
  const { ensurePermissionSchema } = await import("./permissions");
  await ensurePermissionSchema();
  const migrateMs = Date.now() - tMigrate0;
  bootPhases.push({ name: "Boot Migrations", durationMs: migrateMs });
  log(`[startup] boot migrations: ${migrateMs}ms`, "boot");

  try {
    const { warmStorageConfig } = await import("./object_storage/s3-backend");
    await warmStorageConfig();
    log("[startup] storage config warm-up complete", "boot");
  } catch (err: any) {
    log(`[startup] storage config warm-up failed (legacy fallback active): ${err?.message || err}`, "boot");
  }

  try {
    const { seedBuildWorkflowTemplate } = await import("./workflows/workflow-service");
    await seedBuildWorkflowTemplate();
    log("[startup] workflow seed: build-v1 ready", "boot");
  } catch (err: any) {
    log(`[startup] workflow seed failed: ${err?.message || err}`, "boot");
  }

  try {
    const { recoverInterruptedBackups } = await import("./backup-storage");
    const tBackupRecovery0 = Date.now();
    const backupRecovery = await recoverInterruptedBackups();
    const backupRecoveryMs = Date.now() - tBackupRecovery0;
    bootPhases.push({ name: "Backup Startup Recovery", durationMs: backupRecoveryMs });
    if (backupRecovery.cancelled > 0) {
      log(`[startup] backup recovery: cancelled=${backupRecovery.cancelled} ids=${backupRecovery.ids.join(",")} in ${backupRecoveryMs}ms`, "boot");
    } else {
      log(`[startup] backup recovery: no interrupted backups in ${backupRecoveryMs}ms`, "boot");
    }
  } catch (err: any) {
    log(`[startup] backup recovery failed: ${err?.message || err}`, "boot");
  }

  bootTracker.completePhase("database");

  bootTracker.startPhase("skills_library");
  // The former purpose-to-folder registry is retained only as a deprecated
  // compatibility resolver. It is no longer seeded or exposed as a Library
  // knowledge index; vault-aware Index pages are user/account scoped.

  try {
    const { ensureEmailTriageLibraryPage } = await import("./skill-seed");
    await ensureEmailTriageLibraryPage();
  } catch (err: unknown) {
    log(`[startup] email-triage library page seed failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
  }
  bootTracker.completePhase("skills_library");

  bootTracker.startPhase("memory");
  log("[startup] legacy memory maintenance disabled; compatibility reads remain available", "boot");

  // Plan crash recovery — mark any plans interrupted by shutdown as paused
  try {
    const { recoverInterruptedPlans } = await import("./plan-executor");
    const tPlanRecovery0 = Date.now();
    const recovered = await recoverInterruptedPlans();
    const planRecoveryMs = Date.now() - tPlanRecovery0;
    if (recovered > 0) {
      bootPhases.push({ name: "Plan Recovery", durationMs: planRecoveryMs });
      log(`[startup] plan crash recovery: ${recovered} plan(s) paused in ${planRecoveryMs}ms`, "boot");
    }
  } catch (err: unknown) {
    log(`[startup] plan crash recovery failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
  }

  bootTracker.completePhase("memory");

  bootTracker.startPhase("routes_auth");
  const tProfiles0 = Date.now();
  await initProfiles();
  await migrateLegacyModelProfiles();
  const profilesMs = Date.now() - tProfiles0;
  bootPhases.push({ name: "Model Profiles", durationMs: profilesMs });
  log(`[startup] model profiles loaded: ${profilesMs}ms`, "boot");

  // Orientation sits directly on the first-turn critical path. Build the exact
  // routed Haiku worker now and wait for its CLI initialize handshake before
  // accepting requests. Failure degrades to the normal cold path.
  const tOrientationWarm0 = Date.now();
  try {
    const { prewarmOrientationClassifier } = await import("./orientation-bootstrap");
    await prewarmOrientationClassifier();
    log(`[startup] orientation classifier ready: ${Date.now() - tOrientationWarm0}ms`, "boot");
  } catch (err) {
    log(`[startup] orientation classifier prewarm degraded: ${err instanceof Error ? err.message : String(err)}`, "boot");
  }

  const tAuth0 = Date.now();
  setupAuth(app);
  registerApiPolicy(app);
  const authMs = Date.now() - tAuth0;
  bootPhases.push({ name: "Auth Setup", durationMs: authMs });
  log(`[startup] auth setup: ${authMs}ms`, "boot");


  await objectAclsMigrationReady;
  await migrateProjectNotesSpecToLibrary();
  await vaultsMigrationReady;
  await adoptRayPersonalLibraryIndex();

  const tRoutes0 = Date.now();
  await registerRoutes(httpServer, app);
  const routesMs = Date.now() - tRoutes0;
  bootPhases.push({ name: "Routes", durationMs: routesMs });
  log(`[startup] routes registered: ${routesMs}ms`, "boot");
  bootTracker.completePhase("routes_auth");

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = status >= 500 ? "Internal Server Error" : (err.message || "Request failed");

    serverLog.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  bootTracker.startPhase("server");
  const tStatic0 = Date.now();
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
    const staticMs = Date.now() - tStatic0;
    bootPhases.push({ name: "Static Files", durationMs: staticMs });
    log(`[startup] static files: ${staticMs}ms`, "boot");
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
    const viteMs = Date.now() - tStatic0;
    bootPhases.push({ name: "Vite Dev Server", durationMs: viteMs });
    log(`[startup] vite dev server: ${viteMs}ms`, "boot");
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    async () => {
      bootTracker.completePhase("server");

      const totalMs = Date.now() - t0;
      recordBootTiming(bootPhases, totalMs);
      log(`[startup] total boot: ${totalMs}ms — serving on port ${port}`, "boot");

      // Signal the watchdog that boot migrations + route registration + listen are complete.
      // The watchdog scans stdout for this marker and uses it to (a) clear its hard boot
      // deadline and (b) start applying HTTP health probes.
      try {
        process.stdout.write("\n__BOOT_COMPLETE__\n");
      } catch {}

      // Worker-thread heartbeat (Task #995). Spawn a tiny worker that posts a
      // heartbeat every 1s. Forward each beat to the wrapper over IPC. If the
      // main thread is wedged by sync work, the worker keeps beating but the
      // forwarder silently can't run, so the wrapper sees staleness and kills.
      try {
        const { Worker } = await import("worker_threads");
        const path = await import("path");
        const fs = await import("fs");
        // In dev (tsx) we run the .ts directly; in prod the bundle ships
        // dist/heartbeat-worker.mjs as a sibling artifact (see script/build.ts).
        // Resolve relative to this module's dir so both layouts work.
        const here = path.dirname(new URL(import.meta.url).pathname);
        const tsPath = path.join(here, "heartbeat-worker.ts");
        const mjsPath = path.join(here, "heartbeat-worker.mjs");
        const jsPath = path.join(here, "heartbeat-worker.js");
        let workerPath: string | null = null;
        if (fs.existsSync(tsPath)) workerPath = tsPath;
        else if (fs.existsSync(mjsPath)) workerPath = mjsPath;
        else if (fs.existsSync(jsPath)) workerPath = jsPath;
        if (!workerPath) {
          // Fail closed (Task #995). The watchdog uses worker IPC as the
          // primary liveness signal; without it we'd silently degrade to
          // stdout-only detection in production. Force a non-zero exit so
          // the wrapper logs a clear cause and restarts. If the missing
          // artifact is structural (build pipeline regression), the
          // wrapper's repeated-quick-restart guard will eventually surface
          // it as a hard fail rather than masking the regression.
          const msg = `[heartbeat] artifact not found in ${here} (looked for heartbeat-worker.{ts,mjs,js}) — refusing to boot without canary`;
          log(msg, "boot");
          try {
            if (typeof process.send === "function") {
              process.send({ type: "worker_dead", reason: "artifact_missing" });
            }
          } catch {}
          setTimeout(() => { process.exit(79); }, 50).unref();
          throw new Error(msg);
        }
        const worker = new Worker(workerPath, {
          // tsx workers need execArgv; try first with default and let Node
          // pick. If we ever ship a bundle, mjsPath is plain JS and works.
        });
        worker.on("message", (msg: { type?: string; t?: number }) => {
          if (msg?.type === "alive" && typeof process.send === "function") {
            try { process.send({ type: "alive", t: msg.t ?? Date.now() }); } catch {}
          }
        });
        // Worker is the canary (Task #995). Treat any worker error or exit
        // as a hard fatal: notify the wrapper explicitly over IPC, then
        // exit. The wrapper's restart loop will spin a fresh process. This
        // satisfies the "worker exit propagates to the parent as a hard
        // kill condition" requirement — we don't depend on heartbeat
        // staleness alone to detect canary loss.
        const onCanaryLoss = (reason: string) => {
          log(`[heartbeat] canary lost (${reason}) — exiting for restart`, "boot");
          try {
            if (typeof process.send === "function") {
              process.send({ type: "worker_dead", reason });
            }
          } catch {}
          // Small delay so the IPC message has a chance to flush before exit.
          // Exit code 79 is reserved here for "worker canary dead" so the
          // wrapper can distinguish this from a generic crash or from the
          // memory-pressure exit (code 78). The wrapper's restart loop owns
          // the actual respawn.
          setTimeout(() => { process.exit(79); }, 50).unref();
        };
        worker.on("error", (err) => {
          onCanaryLoss(`error:${(err as any)?.message || err}`);
        });
        worker.on("exit", (code) => {
          onCanaryLoss(`exit:code=${code}`);
        });
        // Note: we deliberately do NOT call worker.unref() — we want this
        // worker tied to process lifetime so an exit really means the
        // canary is dead, not just that the loop ran out of work.
      } catch (err) {
        // Fail closed (Task #995): if we cannot start the canary we lose
        // the primary liveness signal, so we must not continue serving.
        // Notify the wrapper over IPC and exit with the canary-dead code
        // so the wrapper restart loop owns the respawn (and its
        // repeated-quick-restart guard surfaces structural regressions).
        log(`[heartbeat] failed to start worker: ${(err as any)?.message || err} — exiting`, "boot");
        try {
          if (typeof process.send === "function") {
            process.send({ type: "worker_dead", reason: `start_failed:${(err as any)?.message || err}` });
          }
        } catch {}
        setTimeout(() => { process.exit(79); }, 50).unref();
      }

      startEventLoopMonitor();
      executorManager.startSupervisor();
      executorManager.start().catch((err) => {
        log(`[startup] executorManager.start failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
      });

      // Plan recovery is continuous, bounded, and replay-safe. Boot recovery
      // handles immediate prior-boot ownership; this sweep closes gaps after
      // transient database failures without creating a second mutation path.
      const PLAN_RECOVERY_INTERVAL_MS = 60_000;
      const runPlanRecovery = () => {
        import("./plan-executor").then(async ({ recoverInterruptedPlans }) => {
          const recovered = await recoverInterruptedPlans();
          if (recovered > 0) {
            log(`[scheduled] plan recovery: recovered=${recovered}`, "boot");
          }
        }).catch((err) => {
          log(`[scheduled] plan recovery failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
        });
      };
      setInterval(runPlanRecovery, PLAN_RECOVERY_INTERVAL_MS).unref();

      // Periodic prune of completed/abandoned voice_session_active rows so the
      // table (and its partial index) stay compact. Retention is configurable
      // via VOICE_SESSION_RETENTION_DAYS (default 30 days). Runs once per day.
      const VOICE_SESSION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
      setInterval(() => {
        import("./storage").then(async ({ storage }) => {
          const days = Math.max(1, parseInt(process.env.VOICE_SESSION_RETENTION_DAYS || "30", 10) || 30);
          const { deleted, remaining } = await storage.pruneVoiceSessions(days);
          log(`[scheduled] voice_session_active prune: deleted=${deleted} remaining=${remaining} retentionDays=${days}`, "boot");
        }).catch((err) => {
          log(`[scheduled] voice_session_active prune failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
        });
      }, VOICE_SESSION_PRUNE_INTERVAL_MS).unref();

      // vNext source poller: extract claims from settled session/library_page sources.
      // Runs once shortly after boot, then every 5 minutes. Sources must be quiet
      // for 30 minutes before extraction; the boot run makes the processor visible
      // immediately and catches any backlog from a restart.
      const VNEXT_SOURCE_POLLER_INTERVAL_MS = 5 * 60 * 1000;
      const runVnextSourcePoller = () => {
        import("./memory/vnext-source-poller").then(async ({ processSettledSources }) => {
          const result = await processSettledSources();
          log(
            `[scheduled] vnext source poller: processed=${result.processed} created=${result.totalCreated} reinforced=${result.totalReinforced} skipped=${result.totalSkipped} errors=${result.errors}`,
            "boot",
          );
        }).catch((err) => {
          log(`[scheduled] vnext source poller failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
        });
      };
      setTimeout(runVnextSourcePoller, 30_000).unref();
      setInterval(runVnextSourcePoller, VNEXT_SOURCE_POLLER_INTERVAL_MS).unref();

      // Meeting auto-join scheduler: joins the Recall.ai bot to calendar
      // events whose per-event agent toggle is enabled, at start time.
      // Ticks every minute; each tick atomically claims due rows.
      const runMeetingAutoJoin = () => {
        import("./meeting/auto-join").then(({ runMeetingAutoJoinTick }) => runMeetingAutoJoinTick()).catch((err) => {
          log(`[scheduled] meeting auto-join tick failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
        });
      };
      setTimeout(runMeetingAutoJoin, 20_000).unref();
      setInterval(runMeetingAutoJoin, 60_000).unref();

      resolveRailwayEnvironmentControl(undefined, { allowCurrentRuntime: true })
        .then(async (control) => {
          const limits = await fetchServiceInstanceLimits(
            control.serviceId,
            control.railwayEnvironmentId,
            control.token,
          );
          const maxMemoryMB = resolveServiceInstanceMemoryMB(limits);
          if (maxMemoryMB === null) {
            throw new Error(`Railway serviceInstanceLimits returned no supported memory field: ${describeServiceInstanceLimits(limits)}`);
          }
          log(`[startup] Memory watchdog limit resolved from Railway serviceInstanceLimits: maxMemory=${maxMemoryMB}MB ${describeServiceInstanceLimits(limits)}`, "boot");
          startMemoryWatchdog({
            maxMemoryMB,
            onGracefulShutdown: () => shutdownApplication({
              terminationKind: "unclean",
              cause: "memory_pressure",
              exitCode: parseInt(process.env.MEMORY_PRESSURE_EXIT_CODE || "78", 10),
              signal: null,
            }),
          });
        })
        .catch((err) => {
          serverLog.error(`[startup] Memory watchdog disabled: Railway serviceInstanceLimits could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
        });

      // Pool-wedge self-exit watchdog: if the pool heartbeat goes silent
      // for ~90s while real work is in flight (in-flight queries or pool
      // waiters), dump pg_stat_activity and exit so the supervisor restarts
      // us. This is the safety net for the deadlock-prevention work in
      // task-959 — it should almost never fire in healthy operation.
      import("./db").then(({ startPoolWedgeWatchdog }) => {
        startPoolWedgeWatchdog({ silenceMs: 90_000, intervalMs: 15_000 });
        log("[boot] pool-wedge watchdog armed (silenceMs=90000 exit=79)", "boot");
      }).catch((err) => {
        log(`[boot] failed to arm pool-wedge watchdog: ${err instanceof Error ? err.message : String(err)}`, "boot");
      });

      // Generalized wedge watchdog: per-subsystem in-flight tracking +
      // SIGKILL-survivable death rattle dump + periodic snapshot heartbeat.
      Promise.all([
        import("./wedge-watchdog"),
        import("./agent-executor"),
        import("./db"),
        import("./integrations/chat/routes"),
      ]).then(([ww, ae, db, chatRoutes]) => {
        ww.registerExecutorRunsAccessor(() => ae.agentExecutor.getActiveRuns());
        ww.registerChatStreamAccessor(() => chatRoutes.getInFlightChatSessions());
        ww.registerDbPoolAccessor(() => {
          const stats = db.getInFlightStats();
          const lr = db.getLongRunningQueries(500);
          const sat = db.getDbSaturationInfo();
          return {
            inFlight: stats.total,
            waiting: sat.waiting,
            total: sat.total,
            idle: sat.idle,
            longRunning: lr.rows,
          };
        });
        ww.startSnapshotHeartbeat(10_000);
        log(`[boot] wedge watchdog armed (snapshot every 10s, exit=${ww.WEDGE_EXIT_CODE})`, "boot");
      }).catch((err) => {
        log(`[boot] failed to arm wedge watchdog: ${err instanceof Error ? err.message : String(err)}`, "boot");
      });

      import("./plaid-service").then(({ healStuckSyncs, isPlaidConfigured }) => {
        if (isPlaidConfigured()) {
          healStuckSyncs().then((count) => {
            if (count > 0) log(`[startup] healed ${count} stuck Plaid sync(s)`, "boot");
          }).catch((err) => {
            log(`[startup] healStuckSyncs failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
          });
        }
      }).catch(() => {});

      import("./memory/memory-listener").then(({ registerMemoryListener }) => {
        registerMemoryListener();
        log("[startup] memory listener registered", "boot");
      }).catch((err) => {
        log(`[startup] memory listener registration failed: ${err.message}`, "boot");
      });

      import("./memory/long-title-maintenance").then(async ({ logMemoryDiagnostics }) => {
        await logMemoryDiagnostics();
        log("[startup] legacy memory diagnostics complete; maintenance writes disabled", "boot");
      }).catch((err) => {
        log(`[startup] legacy memory diagnostics failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
      });

      import("./plaid-service").then(async ({ reconcileWebhookUrls, isPlaidConfigured }) => {
        if (isPlaidConfigured()) {
          await reconcileWebhookUrls();
          log("[startup] Plaid webhook URL reconciliation complete", "boot");
        }
      }).catch((err) => {
        log(`[startup] Plaid webhook reconciliation skipped: ${err.message}`, "boot");
      });

      import("./memory/document-storage").then(async ({ documentStorage }) => {
        try {
          const stats = await documentStorage.getStats();
          const totalDocs = Object.values(stats).reduce((a, b) => a + b, 0);
          log(`[startup] workspace_documents: ${totalDocs} docs in DB`, "boot");
        } catch (err: any) {
          log(`[startup] workspace document check failed: ${err.message}`, "boot");
        }
      }).catch(err => serverLog.warn("workspace document check failed", err));

      bootTracker.startPhase("code_intelligence");
      import("./gitnexus-bridge").then(async ({ loadPersistedState, startGitNexus, isIndexingEnabled }) => {
        // User-controlled kill switch (Build → Code Graph). When disabled we
        // skip indexing entirely so dev / Railway boots don't pay the cost
        // and don't surface spurious failures. Mark the boot phase complete
        // and publish nexus_ready so deferred services (timer scheduler,
        // embeddings listener, etc.) start normally.
        const enabled = await isIndexingEnabled().catch(() => true);
        if (!enabled) {
          log('[gitnexus] indexing disabled by setting — skipping startGitNexus', 'boot');
          bootTracker.completePhase("code_intelligence");
          import("./event-bus").then(({ eventBus }) => {
            eventBus.publish({
              category: "system",
              event: "system:nexus_ready",
              payload: { reason: "indexing_disabled" },
            });
          }).catch(() => { /* best-effort */ });
          startDeferredBackgroundServices();
          return;
        }
        const launchGitNexus = () => {
          startGitNexus().catch((err: unknown) => {
            log('[gitnexus] startup call threw: ' + (err instanceof Error ? err.message : String(err)), 'boot');
            bootTracker.failPhase("code_intelligence", err instanceof Error ? err.message : String(err));
            startDeferredBackgroundServices();
          });
        };
        loadPersistedState().then(launchGitNexus).catch((err: unknown) => {
          log('[gitnexus] loadPersistedState threw: ' + (err instanceof Error ? err.message : String(err)), 'boot');
          launchGitNexus();
        });
      }).catch((err: unknown) => {
        log('[gitnexus] failed to import gitnexus-bridge: ' + (err instanceof Error ? err.message : String(err)), 'boot');
        bootTracker.failPhase("code_intelligence", err instanceof Error ? err.message : String(err));
        startDeferredBackgroundServices();
      });

      import("./event-bus").then(({ eventBus }) => {
        const listener = (busEvent: any) => {
          if (busEvent.event === "system:nexus_ready") {
            bootTracker.completePhase("code_intelligence");
            eventBus.off("event", listener);
            startDeferredBackgroundServices();
          } else if (busEvent.event === "system:nexus_failed") {
            bootTracker.failPhase("code_intelligence", "nexus analysis failed");
            eventBus.off("event", listener);
            startDeferredBackgroundServices();
          }
        };
        eventBus.on("event", listener);
      }).catch(() => {
        bootTracker.failPhase("code_intelligence", "event bus unavailable");
        startDeferredBackgroundServices();
      });

      // Raised from 120s → 300s (Task #1025): on cold-storage Railway redeploys
      // the gitnexus analyze pass routinely runs 3–5 minutes. The previous 2-min
      // ceiling pretended success (`completePhase`) at 120s and let the scheduler
      // start while indexing was still hammering the pool, contributing to the
      // ~44min wedge. We now wait 5 minutes and, if still active, mark the phase
      // *degraded* (not done) and publish `system:nexus_degraded` so listeners
      // (e.g. the timer scheduler) know to start in a degraded mode rather than
      // assume gitnexus is happy.
      const CODE_INTEL_TIMEOUT_MS = 300_000;
      setTimeout(() => {
        const status = bootTracker.getStatus();
        const ciPhase = status.phases.find(p => p.name === "code_intelligence");
        if (ciPhase && ciPhase.status === "active") {
          log(`[gitnexus] code_intelligence phase exceeded ${CODE_INTEL_TIMEOUT_MS / 1000}s ceiling — marking degraded and proceeding`, "boot");
          bootTracker.markPhaseDegraded(
            "code_intelligence",
            `nexus_ready not received within ${CODE_INTEL_TIMEOUT_MS / 1000}s`,
          );
          import("./event-bus").then(({ eventBus }) => {
            eventBus.publish({
              category: "system",
              event: "system:nexus_degraded",
              payload: { reason: "boot_timeout", timeoutMs: CODE_INTEL_TIMEOUT_MS },
            });
          }).catch(() => { /* best-effort */ });
          startDeferredBackgroundServices();
        }
      }, CODE_INTEL_TIMEOUT_MS);

    },
  );
})();

const SHUTDOWN_TIMEOUT_MS = Math.max(1_000, parseInt(process.env.APP_SHUTDOWN_TIMEOUT_MS || "8000", 10));
let shutdownInstalled = false;
let shutdownPromise: Promise<void> | null = null;

function closeHttpServer(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), Math.max(500, SHUTDOWN_TIMEOUT_MS - 1_000));
    timeout.unref();
    httpServer.close(() => {
      clearTimeout(timeout);
      resolve();
    });
    httpServer.closeIdleConnections?.();
  });
}

async function shutdownApplication(input: RuntimeTerminationInput): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const startedAt = Date.now();
    serverLog.info(`process_lifecycle ${JSON.stringify({
      event: "graceful_shutdown_started",
      bootId: process.env.WATCHDOG_BOOT_ID || null,
      signal: input.signal,
      cause: input.cause,
      exitCode: input.exitCode,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    })}`);

    timerScheduler.stop();
    admissionController.shutdown();
    executorManager.stopSupervisor();
    await executorManager.stop().catch((error) => {
      serverLog.warn(`executor shutdown degraded: ${error instanceof Error ? error.message : String(error)}`);
    });
    stopMemoryWatchdog();
    stopSnapshotHeartbeat();

    await Promise.race([
      Promise.allSettled([closeHttpServer(), closeBrowser()]),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS - 500)),
    ]);

    const terminationRecorded = await markRuntimeProcessTermination(input).catch((error) => {
      serverLog.warn(`process lifecycle termination persistence failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    await closeDatabasePools();
    serverLog.info(`process_lifecycle ${JSON.stringify({
      event: "graceful_shutdown_complete",
      bootId: process.env.WATCHDOG_BOOT_ID || null,
      signal: input.signal,
      cause: input.cause,
      exitCode: input.exitCode,
      terminationRecorded,
      elapsedMs: Date.now() - startedAt,
    })}`);
  })();
  return shutdownPromise;
}

function installGracefulShutdown(): void {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdownApplication({
        terminationKind: "clean",
        cause: "provider_or_operator_signal",
        exitCode: 0,
        signal,
      }).then(() => process.exit(0)).catch((error) => {
        serverLog.error(`graceful shutdown failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        process.exit(1);
      });
    });
  }
}

let deferredServicesStarted = false;
function startDeferredBackgroundServices(): void {
  if (deferredServicesStarted) return;
  deferredServicesStarted = true;

  bootTracker.startPhase("background_services");

  const services: Promise<void>[] = [];

  services.push(
    import("./skill-scoring").then(({ registerSkillScoringListener }) => {
      registerSkillScoringListener();
      log("[startup] skill scoring listener registered", "boot");
    }).catch((err) => {
      log(`[startup] skill scoring listener registration failed: ${err.message}`, "boot");
    })
  );

  services.push(
    import("./gitnexus-embeddings").then(({ initCodeEmbeddingListener }) => {
      initCodeEmbeddingListener();
      log("[startup] code embedding listener registered", "boot");
    }).catch((err) => {
      log(`[startup] code embedding listener registration failed: ${err.message}`, "boot");
    })
  );

  services.push(
    import("./context-builder").then(({ startCalendarBackgroundRefresh }) => {
      startCalendarBackgroundRefresh();
      log("[startup] Calendar background refresh started", "boot");
    }).catch(err => {
      log(`[startup] Calendar background refresh failed to start: ${err.message}`, "boot");
    })
  );

  services.push(
    import("./hook-executor").then(({ hookExecutor }) => {
      return hookExecutor.initialize().then(() => {
        log("[startup] hook executor initialized", "boot");
      });
    }).catch((err) => {
      log(`[startup] hook executor initialization failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
    })
  );

  services.push(
    import("./gmail").then(async ({ listGmailAccounts, verifyAccountTokenHealth, clearHealthCache }) => {
      const accounts = await listGmailAccounts();
      log(`[startup] Checking scope health for ${accounts.length} Google account(s)`, "boot");
      for (const account of accounts) {
        clearHealthCache(account.id);
        const health = await verifyAccountTokenHealth(account.id);
        if (!health.healthy) {
          log(`[startup] Google account ${account.email} unhealthy: ${health.error}`, "boot");
        } else if (health.missingScopes && health.missingScopes.length > 0) {
          log(`[startup] Google account ${account.email} missing scopes: ${health.missingScopes.join(", ")}`, "boot");
        }
      }
    }).catch(err => {
      log(`[startup] Google account scope check failed: ${err instanceof Error ? err.message : String(err)}`, "boot");
    })
  );

  Promise.allSettled(services).then(async () => {
    bootTracker.completePhase("background_services");

    bootTracker.markReady();

  });
}

