// Use createLogger for logging ONLY
import type { Express } from "express";
import { executorManager } from "../executor-manager";
import { getCached } from "./shared";
import { join } from "path";
import { createLogger } from "../log";
import { requireAuth } from "../auth";

const log = createLogger("GatewayRoutes");

// Per-process cache of which `safeSection` ids have already logged a failure.
// Used by sections that opt in via `silentRepeatFailures: true` to avoid
// spamming the System Logs every ~2s when a section's underlying module is
// genuinely unavailable in this build (e.g. browser-manager when playwright's
// dep chain fails to resolve in the deployed image). The first failure is
// logged once with the underlying error + requireStack; subsequent polls
// return the unknown fallback silently.
const sectionFailureLogged = new Set<string>();

export async function registerGatewayRoutes(app: Express) {
  app.use(["/api/gateway/sessions", "/api/gateway/conversations"], requireAuth);
  app.get("/api/gateway/status", async (_req, res) => {
    try {
      const statusPromise = getCached("agent:status", 2000, () => executorManager.getStatus());
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Agent status timeout")), 5000)
      );
      const status = await Promise.race([statusPromise, timeoutPromise]);
      res.json(status);
    } catch (error: any) {
      res.json({ status: "unknown", error: error.message });
    }
  });

  app.post("/api/gateway/start", async (_req, res) => {
    try {
      const message = await executorManager.start();
      res.json({ message });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/gateway/stop", async (_req, res) => {
    try {
      const message = await executorManager.stop();
      res.json({ message });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/gateway/restart", async (_req, res) => {
    try {
      const message = await executorManager.restart();
      res.json({ message });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gateway/processes", async (req, res) => {
    const EXPECTED_PROCESS_COUNT = 7;
    const pid = process.pid;
    const uptime = Math.floor(process.uptime());
    const failures: string[] = [];

    type ProcessEntry = {
      id: string;
      name: string;
      description: string;
      status: string;
      pid: number;
      uptime: number;
      actions: string[];
      details: Record<string, unknown> | null;
    };

    async function safeSection<T>(
      id: string,
      fallback: ProcessEntry,
      fn: () => Promise<T> | T,
      build: (value: T) => ProcessEntry,
      opts?: { silentRepeatFailures?: boolean },
    ): Promise<ProcessEntry> {
      try {
        const value = await fn();
        return build(value);
      } catch (err: any) {
        failures.push(`${id}: ${err?.message || String(err)}`);
        if (opts?.silentRepeatFailures) {
          if (!sectionFailureLogged.has(id)) {
            sectionFailureLogged.add(id);
            const msg = err?.message || String(err);
            const code = err?.code ? ` code=${err.code}` : "";
            const stack = Array.isArray(err?.requireStack) ? ` requireStack=${err.requireStack.join("|")}` : "";
            log.warn(
              `processes section "${id}" failed (further failures silenced for this process): ${msg}${code}${stack}`,
            );
          }
          // Subsequent polls: silently return fallback so the System Logs
          // view is not flooded ~every 2s with the same unresolvable error.
        } else {
          log.error(`processes section "${id}" failed:`, err);
        }
        return fallback;
      }
    }

    const unknownEntry = (id: string, name: string, description: string, actions: string[]): ProcessEntry => ({
      id,
      name,
      description,
      status: "unknown",
      pid,
      uptime,
      actions,
      details: null,
    });

    const processes: ProcessEntry[] = [];

    processes.push(await safeSection(
      "agent-executor",
      unknownEntry("agent-executor", "Agent Executor", "Core AI agent that handles conversations and autonomous tasks", ["pause", "restart"]),
      async () => {
        const { agentExecutor } = await import("../agent-executor");
        const agentStatus = await executorManager.getStatus();
        return { agentExecutor, agentStatus };
      },
      ({ agentExecutor, agentStatus }) => ({
        id: "agent-executor",
        name: "Agent Executor",
        description: "Core AI agent that handles conversations and autonomous tasks",
        status: agentStatus.status === "running" ? "running" : "stopped",
        pid,
        uptime: agentStatus.uptime ?? uptime,
        actions: ["pause", "restart"],
        details: { activeRuns: agentExecutor.getActiveRunCount() },
      }),
    ));

    processes.push(await safeSection(
      "timer-scheduler",
      unknownEntry("timer-scheduler", "Timer Scheduler", "Runs scheduled tasks like memory consolidation, sleep cycle, and reflections", ["pause", "restart"]),
      async () => (await import("../timer-scheduler")).timerScheduler,
      (timerScheduler) => ({
        id: "timer-scheduler",
        name: "Timer Scheduler",
        description: "Runs scheduled tasks like memory consolidation, sleep cycle, and reflections",
        status: timerScheduler.isPaused() ? "paused" : timerScheduler.isRunning() ? "running" : "stopped",
        pid,
        uptime,
        actions: ["pause", "restart"],
        details: { inFlight: timerScheduler.getInFlightCount() },
      }),
    ));

    processes.push(await safeSection(
      "performance-monitor",
      unknownEntry("performance-monitor", "Performance Monitor", "Tracks event loop lag, CPU, memory, and request throughput", []),
      async () => (await import("../performance-monitor")).getLatestEventLoopLag,
      (getLatestEventLoopLag) => ({
        id: "performance-monitor",
        name: "Performance Monitor",
        description: "Tracks event loop lag, CPU, memory, and request throughput",
        status: "running",
        pid,
        uptime,
        actions: [],
        details: { eventLoopLag: Math.round(getLatestEventLoopLag() * 100) / 100 },
      }),
    ));

    processes.push({
      id: "memory-watchdog",
      name: "Memory Watchdog",
      description: "Monitors heap usage and triggers emergency GC or restarts under pressure",
      status: "running",
      pid,
      uptime,
      actions: [],
      details: null,
    });

    type NormalizedBrowserStats = {
      activeBrowsers: number;
      activePages: number;
      queued: number;
      available: boolean;
    };

    const numOrZero = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;

    processes.push(await safeSection<NormalizedBrowserStats>(
      "browser-manager",
      unknownEntry("browser-manager", "Browser Manager", "Manages headless Chromium lifecycle, page slots, and idle cleanup", ["restart"]),
      async () => {
        // Belt-and-braces: getBrowserStats() is already un-throwable, but if a
        // future regression or a failed dynamic import returns something
        // missing/wrong-shaped, treat it as "unknown" rather than letting
        // safeSection log a stack trace every ~2s.
        const mod = await import("../browser-manager");
        const fn = mod?.getBrowserStats;
        if (typeof fn !== "function") {
          return { activeBrowsers: 0, activePages: 0, queued: 0, available: false };
        }
        const raw: unknown = fn();
        if (!raw || typeof raw !== "object") {
          return { activeBrowsers: 0, activePages: 0, queued: 0, available: false };
        }
        const r = raw as Record<string, unknown>;
        return {
          activeBrowsers: numOrZero(r.activeBrowsers),
          activePages: numOrZero(r.activePages),
          queued: numOrZero(r.queued),
          available: true,
        };
      },
      (browserStats) => ({
        id: "browser-manager",
        name: "Browser Manager",
        description: "Manages headless Chromium lifecycle, page slots, and idle cleanup",
        status: !browserStats.available ? "unknown" : browserStats.activeBrowsers > 0 ? "running" : "idle",
        pid,
        uptime,
        actions: ["restart"],
        details: {
          activeBrowsers: browserStats.activeBrowsers,
          activePages: browserStats.activePages,
          queued: browserStats.queued,
        },
      }),
      // Silence repeat failures: this section polls every ~2s. If the
      // dynamic import of ../browser-manager throws (e.g. MODULE_NOT_FOUND
      // for a transitive playwright dep that didn't make it into the
      // deployed image), log it once with the requireStack and then return
      // the unknownEntry silently on subsequent polls instead of flooding
      // the System Logs view.
      { silentRepeatFailures: true },
    ));

    processes.push(await safeSection(
      "run-admission",
      unknownEntry("run-admission", "Run Admission Controller", "Prioritizes and throttles LLM runs across communication, realtime, request, and background tiers", ["restart"]),
      async () => (await import("../run-admission")).admissionController,
      (admissionController) => {
        const tierCounts = admissionController.getTierCounts();
        const inFlightSlots = Object.values(tierCounts).reduce((s, n) => s + n, 0);
        const state = admissionController.getState();
        return {
          id: "run-admission",
          name: "Run Admission Controller",
          description: "Prioritizes and throttles LLM runs across communication, realtime, request, and background tiers",
          status: state === "active" ? "running" : state === "cooling_down" ? "running" : "idle",
          pid,
          uptime,
          actions: ["restart"],
          details: {
            state,
            inFlight: inFlightSlots,
            queued: admissionController.getQueueDepth(),
          },
        };
      },
    ));

    processes.push(await safeSection(
      "event-bus",
      unknownEntry("event-bus", "Event Bus", "In-process pub/sub that dispatches real-time events to subscribers and persistence", ["restart"]),
      async () => (await import("../event-bus")).eventBus,
      (eventBus) => ({
        id: "event-bus",
        name: "Event Bus",
        description: "In-process pub/sub that dispatches real-time events to subscribers and persistence",
        status: "running",
        pid,
        uptime,
        actions: ["restart"],
        details: {
          subscribers: eventBus.listenerCount("event"),
          buffered: eventBus.getBufferSize(),
        },
      }),
    ));

    if (processes.length < EXPECTED_PROCESS_COUNT || failures.length > 0) {
      log.warn(`processes endpoint returned ${processes.length}/${EXPECTED_PROCESS_COUNT} entries; failures=${failures.length ? failures.join("; ") : "none"}`);
    }

    let resources: import("@shared/system-resources").SystemResourcesData | null = null;
    try {
      const [{ getDbSaturationInfo, getInFlightStats, getSlowQueryStats, getInFlightHighThreshold, getLongRunningQueries }, { agentExecutor }, { admissionController }, { getZombieMetrics }, perfMon, { getRealtimeTransportMetrics }, { sessionManager }] = await Promise.all([
        import("../db"),
        import("../agent-executor"),
        import("../run-admission"),
        import("../cli-sdk-adapter"),
        import("../performance-monitor"),
        import("../realtime-transport-metrics"),
        import("../session-manager"),
      ]);

      const now = Date.now();
      const dbInfo = getDbSaturationInfo();
      const inFlight = getInFlightStats();
      const longRunning = getLongRunningQueries();
      const slow = getSlowQueryStats();
      const runs = agentExecutor.getActiveRuns();
      const slots = admissionController.getSlots();
      const tierCounts = admissionController.getTierCounts();
      const queuedByTier = admissionController.getQueuedByTier();
      const queueDepth = admissionController.getQueueDepth();
      const admissionState = admissionController.getState();
      const zombies = getZombieMetrics();
      const diag = perfMon.getPerformanceDiagnostics?.();
      const elCurrent = perfMon.getLatestEventLoopLag?.() ?? 0;
      const elMax = diag?.eventLoopLag?.max ?? 0;
      const elAvg = diag?.eventLoopLag?.avg ?? 0;
      const transportMetrics = getRealtimeTransportMetrics();
      const sessionMetrics = sessionManager.getSubscriptionMetrics();

      const slotRunIds = new Set(slots.map(s => s.runId));
      let divergence = 0;
      const divergenceParts: string[] = [];
      for (const r of runs) {
        if (!r.aborted && !slotRunIds.has(r.runId)) {
          divergence++;
        }
      }
      if (divergence > 0) divergenceParts.push(`${divergence} executor run(s) without admission slot`);
      if (zombies.active > 0 && runs.filter(r => r.aborted).length < zombies.active) {
        const delta = zombies.active - runs.filter(r => r.aborted).length;
        divergence += delta;
        divergenceParts.push(`${delta} unattributed zombie(s)`);
      }

      resources = {
        generatedAt: now,
        dbPool: {
          total: dbInfo.total,
          idle: dbInfo.idle,
          waiting: dbInfo.waiting,
          saturatedForMs: dbInfo.saturatedForMs,
          lastProbeDurationMs: dbInfo.lastProbeDurationMs,
          lastSuccessfulProbeAt: dbInfo.lastSuccessfulProbeAt,
          general: dbInfo.general,
          voice: dbInfo.voice,
        },
        inFlight: {
          total: inFlight.total,
          submitted: inFlight.submitted,
          waiting: inFlight.waiting,
          executing: inFlight.executing,
          highThreshold: getInFlightHighThreshold(),
          bySubsystem: inFlight.bySubsystem,
        },
        longRunningQueries: longRunning,
        slowQueries: slow,
        executor: {
          activeRuns: runs.length,
          runs: runs.map(r => ({
            runId: r.runId,
            sessionId: r.sessionId ?? null,
            model: r.model ?? null,
            activity: r.activity ?? null,
            ageMs: now - r.startedAt,
            aborted: !!r.aborted,
          })),
        },
        admission: {
          state: admissionState,
          queueDepth,
          tierCounts,
          queuedByTier,
          slots: slots.map(s => ({
            runId: s.runId,
            tier: s.tier,
            ageMs: now - s.grantedAt,
            yieldRequested: s.yieldRequested,
          })),
        },
        zombies: { active: zombies.active, peak: zombies.peak },
        eventLoop: {
          currentMs: Math.round(elCurrent * 100) / 100,
          maxMs: Math.round(elMax * 100) / 100,
          avgMs: Math.round(elAvg * 100) / 100,
        },
        realtime: {
          ...transportMetrics,
          sessionOwnerLinks: sessionMetrics.ownerLinks,
          staleSessionSocketLinks: sessionMetrics.staleSocketLinks,
          pendingSubscribedSessions: sessionMetrics.pendingSessions,
          liveSessions: sessionMetrics.liveSessions,
          streamingSessions: sessionMetrics.streamingSessions,
          subscriptionDivergence: Math.abs(transportMetrics.sessionSocketLinks - sessionMetrics.socketLinks),
        },
        memory: {
          rss: diag?.memoryUsage?.rss ?? process.memoryUsage().rss,
          heapUsed: diag?.memoryUsage?.heapUsed ?? process.memoryUsage().heapUsed,
          heapTotal: diag?.memoryUsage?.heapTotal ?? process.memoryUsage().heapTotal,
          external: diag?.memoryUsage?.external ?? process.memoryUsage().external,
          maxMemoryBytes: diag?.memoryUsage?.maxMemoryBytes ?? null,
          maxMemoryMB: diag?.memoryUsage?.maxMemoryMB ?? null,
          rssUsedPct: diag?.memoryUsage?.rssUsedPct ?? null,
          limitSource: diag?.memoryUsage?.limitSource ?? null,
        },
        divergence: {
          value: divergence,
          detail: divergenceParts.length > 0 ? divergenceParts.join("; ") : "in sync",
        },
      };
    } catch (err: any) {
      failures.push(`resources: ${err?.message || String(err)}`);
      log.error("resources section failed:", err);
    }

    res.json({ processes, failures: failures.length > 0 ? failures : undefined, resources });
  });

  // Dedicated low-cadence endpoint for frontend browser telemetry summary.
  // Kept separate from /api/gateway/processes (2s poll) because getBrowserTelemetrySummary
  // performs a 24h window scan of up to 5,000 rows. The Performance page fetches this
  // every 30s via a separate useQuery with refetchInterval 30_000.
  app.get("/api/gateway/frontend-experience", requireAuth, async (req, res) => {
    try {
      const { getBrowserTelemetrySummary } = await import("../browser-telemetry-storage");
      const summary = req.principal ? await getBrowserTelemetrySummary(req.principal, 24) : null;
      res.json({ frontendExperience: summary });
    } catch (err: any) {
      log.error("frontend-experience endpoint failed:", err);
      res.status(500).json({ error: err?.message || String(err) });
    }
  });

    // Diagnostic endpoint that proves "books == reality" for the abort/admission
  // accounting fixed in task #853. It cross-checks four independent sources of
  // truth — executor activeRuns, admission slots, CLI zombie counter, DB pool —
  // and reports the divergences. Production used to wedge silently when these
  // drifted; with this endpoint a single curl tells you whether the slot count
  // matches the runs that actually own them and whether residual zombies are
  // still pinning resources after their slot was released.
  app.get("/api/gateway/diagnostics/admission", async (_req, res) => {
    try {
      const [{ agentExecutor }, { admissionController }, { getZombieMetrics }, { pool }] = await Promise.all([
        import("../agent-executor"),
        import("../run-admission"),
        import("../cli-sdk-adapter"),
        import("../db"),
      ]);

      const activeRuns = agentExecutor.getActiveRuns();
      const slots = admissionController.getSlots();
      const tierCounts = admissionController.getTierCounts();
      const zombies = getZombieMetrics();

      const runIds = new Set(activeRuns.map(r => r.runId));
      const slotIds = new Set(slots.map(s => s.runId));
      const slotsWithoutRuns = slots.filter(s => !runIds.has(s.runId)).map(s => s.runId);
      const runsWithoutSlots = activeRuns.filter(r => !slotIds.has(r.runId)).map(r => r.runId);

      const divergence = {
        // Slots we are still holding for runs the executor has already forgotten.
        // In a healthy world this is empty; non-empty means a leak the way #853
        // describes — admission says busy, executor says nothing is running.
        slotsWithoutActiveRun: slotsWithoutRuns,
        // Runs the executor knows about that have no admission slot. Should also
        // be empty under the new ordering (drain → release → delete) but is
        // briefly populated during the post-abort drain window.
        runsWithoutAdmissionSlot: runsWithoutSlots,
        // Zombies past slot release. Should be 0 under the new contract; if not,
        // residual CLI subprocesses outlived their drain grace.
        zombiesActive: zombies.active,
      };

      res.json({
        timestamp: Date.now(),
        executor: {
          activeRunCount: activeRuns.length,
          activeRuns: activeRuns.map(r => ({
            runId: r.runId,
            ageMs: Date.now() - r.startedAt,
            sessionId: r.sessionId,
            activity: r.activity,
            model: r.model,
          })),
        },
        admission: {
          state: admissionController.getState(),
          slotCount: slots.length,
          tierCounts,
          queueDepth: admissionController.getQueueDepth(),
          slots: slots.map(s => ({
            runId: s.runId,
            tier: s.tier,
            ageMs: Date.now() - s.grantedAt,
            yieldRequested: s.yieldRequested,
            sessionId: s.sessionId,
            activity: s.activity,
          })),
        },
        zombies,
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
        divergence,
        healthy:
          divergence.slotsWithoutActiveRun.length === 0 &&
          divergence.zombiesActive === 0,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`diagnostics/admission failed: ${msg}`);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/gateway/processes/:id/:action", async (req, res) => {
    const { id, action } = req.params;
    try {
      if (action !== "pause" && action !== "restart") {
        return res.status(400).json({ error: `Unknown action: ${action}` });
      }

      if (id === "agent-executor") {
        if (action === "pause") {
          const message = await executorManager.stop();
          return res.json({ message });
        } else {
          const message = await executorManager.restart();
          return res.json({ message });
        }
      }

      if (id === "timer-scheduler") {
        const { timerScheduler } = await import("../timer-scheduler");
        if (action === "pause") {
          await timerScheduler.setGlobalPaused(true);
          return res.json({ message: "Timer scheduler paused" });
        } else {
          await timerScheduler.setGlobalPaused(false);
          return res.json({ message: "Timer scheduler resumed" });
        }
      }

      if (id === "browser-manager") {
        if (action === "restart") {
          const { closeBrowser } = await import("../browser-manager");
          await closeBrowser();
          return res.json({ message: "Browser manager restarted (headless browser closed; will relaunch on next fetch)" });
        }
        return res.status(400).json({ error: `Browser manager does not support ${action}` });
      }

      if (id === "run-admission") {
        if (action === "restart") {
          const { admissionController } = await import("../run-admission");
          admissionController.reset();
          return res.json({ message: "Run admission controller reset" });
        }
        return res.status(400).json({ error: `Run admission controller does not support ${action}` });
      }

      if (id === "event-bus") {
        if (action === "restart") {
          const { eventBus } = await import("../event-bus");
          eventBus.clear();
          return res.json({ message: "Event bus buffer cleared" });
        }
        return res.status(400).json({ error: `Event bus does not support ${action}` });
      }

      return res.status(400).json({ error: `Process ${id} does not support ${action}` });
    } catch (error: any) {
      log.error(`process action ${id}/${action} failed:`, error);
      res.status(500).json({ error: error.message });
    }
  });


  app.get("/api/gateway/sessions", async (_req, res) => {
    try {
      const { chatFileStorage } = await import("../chat-file-storage");
      const conversations = await chatFileStorage.getSavedSessions();
      const { getModelForActivity, DEFAULT_ACTIVITY_ROUTING } = await import("../job-profiles");
      const defaultTier = DEFAULT_ACTIVITY_ROUTING.chat || "high";
      const sessions = conversations.map(c => ({
        key: c.sessionKey || `dashboard:${c.id}`,
        sessionId: c.id,
        label: c.title || "Untitled",
        createdAt: c.createdAt,
        lastActivity: c.updatedAt,
        messageCount: 0,
        modelTier: c.modelTier || defaultTier,
        model: undefined,
      }));
      res.json(sessions);
    } catch (error: any) {
      res.json([]);
    }
  });

  app.get("/api/gateway/sessions/:key/history", async (req, res) => {
    try {
      const sessionKey = req.params.key;
      const { chatFileStorage } = await import("../chat-file-storage");
      const allConvs = await chatFileStorage.getSavedSessions();
      const conv = allConvs.find(c => (c.sessionKey || `dashboard:${c.id}`) === sessionKey);
      if (!conv) {
        return res.json([]);
      }
      const messages = await chatFileStorage.getMessagesBySession(conv.id);
      const history = messages.map(m => ({
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        toolCalls: m.toolCalls,
        timestamp: m.createdAt,
      }));
      res.json(history);
    } catch (error: any) {
      res.json([]);
    }
  });

  app.delete("/api/gateway/sessions/:key", async (req, res) => {
    try {
      const sessionKey = req.params.key;
      const { chatFileStorage } = await import("../chat-file-storage");
      const cleared = await chatFileStorage.clearSession(sessionKey);
      if (!cleared) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json({ message: "Session cleared" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/gateway/sessions/:key/tier", async (req, res) => {
    try {
      const sessionKey = req.params.key;
      const { tier } = req.body;
      const validTiers = ["auto", "max", "high", "balanced", "fast"];
      if (tier === undefined || tier === null || !validTiers.includes(String(tier))) {
        return res.status(400).json({ error: "Invalid tier. Must be one of: " + validTiers.join(", ") });
      }
      const { chatFileStorage } = await import("../chat-file-storage");
      const updated = await chatFileStorage.updateModelTier(sessionKey, tier);
      if (!updated) {
        return res.status(404).json({ error: "Session not found" });
      }
      res.json({ message: "Tier updated", tier: tier === "auto" ? null : tier });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/gateway/conversations/:id/attention", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const rawPinned = req.body?.isPinned ?? req.body?.needsAttention;
      if (typeof rawPinned !== "boolean") {
        return res.status(400).json({ error: "isPinned (boolean) is required" });
      }
      const isPinned = rawPinned;
      const { chatFileStorage } = await import("../chat-file-storage");
      const allConvs = await chatFileStorage.getAllSessions();
      const conv = allConvs.find(c => c.id === sessionId);
      if (!conv) {
        return res.status(404).json({ error: "Session not found" });
      }
      await chatFileStorage.setSessionPinned(sessionId, isPinned);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/gateway/conversations/:id/read", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { chatFileStorage } = await import("../chat-file-storage");
      const allConvs = await chatFileStorage.getAllSessions();
      const conv = allConvs.find(c => c.id === sessionId);
      if (!conv) {
        return res.status(404).json({ error: "Session not found" });
      }
      await chatFileStorage.setHasUnreadResult(sessionId, false);
      await chatFileStorage.setErrorSeverity(sessionId, null);
      res.json({ message: "Marked as read" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gateway/sessions/:key/context", async (req, res) => {
    try {
      const sessionKey = req.params.key;
      const { chatFileStorage } = await import("../chat-file-storage");
      const allConvs = await chatFileStorage.getAllSessions();
      const conv = allConvs.find(c => (c.sessionKey || `dashboard:${c.id}`) === sessionKey);
      if (!conv) {
        return res.status(404).json({ error: "Session not found" });
      }
      const storedPrompt = await chatFileStorage.getInitialContext(conv.id);
      const tier = conv.modelTier || "high";

      const { fileApiCallStorage } = await import("../file-storage/api-calls");
      const llmUsage = await fileApiCallStorage.getTokenUsageBySession(sessionKey);

      if (storedPrompt) {
        const { estimateTokens } = await import("../agent-context");
        const promptTokens = estimateTokens(storedPrompt);
        const peakTokens = llmUsage.peakInputTokens > 0 ? llmUsage.peakInputTokens : promptTokens;
        res.json({
          systemPrompt: storedPrompt,
          tokenUsage: {
            systemPrompt: promptTokens,
            total: peakTokens,
            llmCalls: llmUsage.calls,
            llmInputTokens: llmUsage.inputTokens,
            llmOutputTokens: llmUsage.outputTokens,
            llmTotalTokens: llmUsage.totalTokens,
            cost: llmUsage.cost,
          },
          tier,
          assembledAt: conv.updatedAt || conv.createdAt,
        });
      } else {
        const peakTokens = llmUsage.peakInputTokens > 0 ? llmUsage.peakInputTokens : 0;
        res.json({
          systemPrompt: null,
          tokenUsage: peakTokens > 0 ? {
            systemPrompt: 0,
            total: peakTokens,
            llmCalls: llmUsage.calls,
            llmInputTokens: llmUsage.inputTokens,
            llmOutputTokens: llmUsage.outputTokens,
            llmTotalTokens: llmUsage.totalTokens,
            cost: llmUsage.cost,
          } : null,
          tier,
          assembledAt: null,
        });
      }
    } catch (error: any) {
      log.error("session context error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/gateway/sessions/:key/api-calls", async (req, res) => {
    try {
      const sessionKey = req.params.key;
      const { fileApiCallStorage } = await import("../file-storage/api-calls");
      const calls = await fileApiCallStorage.getApiCallsBySession(sessionKey);
      res.json(calls);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/performance/calls/:id/content", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid call ID" });
      const { fileApiCallStorage } = await import("../file-storage/api-calls");
      const content = await fileApiCallStorage.getApiCallContent(id);
      if (!content) return res.status(404).json({ error: "API call not found" });
      res.json(content);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

}
