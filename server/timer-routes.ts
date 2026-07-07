// Use createLogger for logging ONLY
import type { Express, Request, Response } from "express";
import { timerStorage } from "./file-storage";
import { timerScheduler } from "./timer-scheduler";
import { insertTimerSchema } from "@shared/models/timers";
import type { Timer, TimerWithNextRun } from "@shared/models/timers";
import { ZodError } from "zod";
import type { BusEvent } from "./event-bus";
import { createLogger } from "./log";

const log = createLogger("TimerRoutes");

interface ImportResult { name: string; action: string; error?: string }

function safeItemName(item: unknown): string {
  if (item && typeof item === "object" && "name" in item && typeof (item as Record<string, unknown>).name === "string") {
    return (item as Record<string, unknown>).name as string;
  }
  return "unknown";
}

const updateTimerSchema = insertTimerSchema.partial();

function paramId(req: Request): string {
  return String(req.params.id);
}

async function buildEnrichedTimers(): Promise<{ timers: TimerWithNextRun[]; globalPaused: boolean }> {
  const timers = await timerStorage.getAll();
  const nextRunTimes = timerScheduler.getNextRunTimes();
  const globalPaused = timerScheduler.isGlobalPaused();

  const enriched: TimerWithNextRun[] = await Promise.all(
    timers.map(async (r) => {
      const recentRuns = await timerStorage.getRuns(r.id, 10);
      const nextRunAt = nextRunTimes[r.id];

      const successCount = recentRuns.filter((run) => run.status === "success").length;
      const errorCount = recentRuns.filter((run) => run.status === "error").length;
      const durations = recentRuns.filter((run) => run.durationMs).map((run) => run.durationMs!);
      const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

      let currentStreak = 0;
      let streakType: "success" | "error" | "none" = "none";
      for (const run of recentRuns) {
        if (run.status === "success") {
          if (streakType === "none") streakType = "success";
          if (streakType === "success") currentStreak++;
          else break;
        } else if (run.status === "error") {
          if (streakType === "none") streakType = "error";
          if (streakType === "error") currentStreak++;
          else break;
        } else {
          break;
        }
      }

      return {
        ...r,
        nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : undefined,
        lastRun: recentRuns[0] || undefined,
        recentRuns,
        stats: {
          totalRuns: recentRuns.length,
          successCount,
          errorCount,
          avgDurationMs,
          currentStreak,
          streakType,
        },
      };
    })
  );

  return { timers: enriched, globalPaused };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleListTimers(_req: Request, res: Response, listKey: string): Promise<void> {
  try {
    const { timers, globalPaused } = await buildEnrichedTimers();
    res.json({ [listKey]: timers, globalPaused });
  } catch (error: unknown) {
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleSchedulerStatus(_req: Request, res: Response): Promise<void> {
  try {
    const state = await timerStorage.getSchedulerState();
    res.json(state);
  } catch (error: unknown) {
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleSchedulerPause(_req: Request, res: Response): Promise<void> {
  try {
    await timerScheduler.setGlobalPaused(true);
    res.json({ globalPaused: true });
  } catch (error: unknown) {
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleSchedulerResume(_req: Request, res: Response): Promise<void> {
  try {
    await timerScheduler.setGlobalPaused(false);
    res.json({ globalPaused: false });
  } catch (error: unknown) {
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleGetTimer(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req);
    const timer = await timerStorage.get(id);
    if (!timer) { res.status(404).json({ error: "Timer not found" }); return; }

    const recentRuns = await timerStorage.getRuns(timer.id, 50);
    const nextRunTimes = timerScheduler.getNextRunTimes();
    const nextRunAt = nextRunTimes[timer.id];

    res.json({
      ...timer,
      nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : undefined,
      recentRuns,
    });
  } catch (error: unknown) {
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleCreateTimer(req: Request, res: Response): Promise<void> {
  try {
    const parsed = insertTimerSchema.parse(req.body);
    const timer = await timerStorage.create(parsed);
    await timerScheduler.rescheduleAll();
    res.status(201).json(timer);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleUpdateTimer(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req);
    const parsed = updateTimerSchema.parse(req.body);
    const timer = await timerStorage.update(id, parsed);
    if (!timer) { res.status(404).json({ error: "Timer not found" }); return; }
    await timerScheduler.rescheduleAll();
    res.json(timer);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: "Validation failed", details: error.errors });
      return;
    }
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleDeleteTimer(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req);
    const success = await timerStorage.delete(id);
    if (!success) { res.status(404).json({ error: "Timer not found" }); return; }
    await timerScheduler.rescheduleAll();
    res.json({ success: true });
  } catch (error: unknown) {
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleGetRuns(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req);
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const runs = await timerStorage.getRuns(id, limit);
    res.json({ runs });
  } catch (error: unknown) {
    res.status(500).json({ error: errMsg(error) });
  }
}

async function handleRunNow(req: Request, res: Response): Promise<void> {
  try {
    const id = paramId(req);
    const timer = await timerStorage.get(id);
    if (!timer) { res.status(404).json({ error: "Timer not found" }); return; }

    const scheduleId = timer.schedules[0]?.id || "manual";
    res.json({ status: "started", timerId: id });

    timerScheduler.executeTimer(id, scheduleId, "manual").catch((err: unknown) => {
      log.error("Manual run error:", errMsg(err));
    });
  } catch (error: unknown) {
    res.status(500).json({ error: errMsg(error) });
  }
}

function stripTimerForExport(timer: Timer) {
  const { id, createdAt, updatedAt, ...rest } = timer;
  return rest;
}

function registerRouteSet(app: Express, prefix: string, listKey: string): void {
  app.get(`${prefix}`, (req, res) => handleListTimers(req, res, listKey));
  app.get(`${prefix}/scheduler/status`, handleSchedulerStatus);
  app.post(`${prefix}/scheduler/pause`, handleSchedulerPause);
  app.post(`${prefix}/scheduler/resume`, handleSchedulerResume);

  app.get(`${prefix}/export`, async (_req: Request, res: Response) => {
    try {
      const allTimers = await timerStorage.getAll();
      const exported = allTimers.map(stripTimerForExport);
      res.setHeader("Content-Disposition", `attachment; filename="timers-export-${new Date().toISOString().slice(0, 10)}.json"`);
      res.setHeader("Content-Type", "application/json");
      log.log(`Export all timers count=${exported.length}`);
      res.json(exported);
    } catch (err: unknown) {
      log.error("GET export error:", errMsg(err));
      res.status(500).json({ error: "Failed to export timers" });
    }
  });

  app.post(`${prefix}/import`, async (req: Request, res: Response) => {
    try {
      const payload = req.body;
      const items: unknown[] = Array.isArray(payload) ? payload : [payload];
      const results: ImportResult[] = [];
      const allTimers = await timerStorage.getAll();
      const nameToId = new Map<string, string>();
      const skillKeyToId = new Map<string, string>();
      for (const t of allTimers) {
        nameToId.set(t.name, t.id);
        if (t.skillId) skillKeyToId.set(`${t.type}:${t.skillId}`, t.id);
      }

      for (const item of items) {
        const itemName = safeItemName(item);
        try {
          const obj = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
          if (obj.schedules && Array.isArray(obj.schedules)) {
            obj.schedules = obj.schedules.map((s: unknown) => {
              const sched = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
              return {
                ...sched,
                id: (typeof sched.id === "string" && sched.id) || "s-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              };
            });
          }
          const parsed = insertTimerSchema.safeParse(obj);
          if (!parsed.success) {
            results.push({ name: itemName, action: "error", error: `Validation: ${parsed.error.errors.map(e => e.message).join(", ")}` });
            continue;
          }
          const existingId = (parsed.data.skillId ? skillKeyToId.get(`${parsed.data.type}:${parsed.data.skillId}`) : undefined)
            || nameToId.get(parsed.data.name);
          if (existingId) {
            await timerStorage.update(existingId, parsed.data);
            nameToId.set(parsed.data.name, existingId);
            if (parsed.data.skillId) skillKeyToId.set(`${parsed.data.type}:${parsed.data.skillId}`, existingId);
            results.push({ name: parsed.data.name, action: "updated" });
            log.log(`Import timer updated name=${parsed.data.name}`);
          } else {
            const created = await timerStorage.create(parsed.data);
            nameToId.set(parsed.data.name, created.id);
            if (parsed.data.skillId) skillKeyToId.set(`${parsed.data.type}:${parsed.data.skillId}`, created.id);
            results.push({ name: parsed.data.name, action: "created" });
            log.log(`Import timer created name=${parsed.data.name}`);
          }
        } catch (err: unknown) {
          results.push({ name: itemName, action: "error", error: errMsg(err) });
          log.error(`Import timer error name=${itemName}:`, errMsg(err));
        }
      }

      await timerScheduler.rescheduleAll();
      log.log(`Import timers complete total=${items.length} created=${results.filter(r => r.action === "created").length} updated=${results.filter(r => r.action === "updated").length} errors=${results.filter(r => r.action === "error").length}`);
      res.json({ results });
    } catch (err: unknown) {
      log.error("POST import error:", errMsg(err));
      res.status(500).json({ error: "Failed to import timers" });
    }
  });

  app.get(`${prefix}/:id/export`, async (req: Request, res: Response) => {
    try {
      const id = paramId(req);
      const timer = await timerStorage.get(id);
      if (!timer) { res.status(404).json({ error: "Timer not found" }); return; }
      const exported = stripTimerForExport(timer);
      res.setHeader("Content-Disposition", `attachment; filename="timer-${timer.name.replace(/\s+/g, "-").toLowerCase()}.json"`);
      res.setHeader("Content-Type", "application/json");
      log.log(`Export timer name=${timer.name} id=${timer.id}`);
      res.json(exported);
    } catch (err: unknown) {
      log.error("GET :id/export error:", errMsg(err));
      res.status(500).json({ error: "Failed to export timer" });
    }
  });

  app.get(`${prefix}/:id`, handleGetTimer);
  app.post(`${prefix}`, handleCreateTimer);
  app.patch(`${prefix}/:id`, handleUpdateTimer);
  app.delete(`${prefix}/:id`, handleDeleteTimer);
  app.get(`${prefix}/:id/runs`, handleGetRuns);
  app.post(`${prefix}/:id/run`, handleRunNow);
}

const NEXUS_READY_TIMEOUT_MS = 5 * 60 * 1000;
const schedulerLog = createLogger("TimerScheduler");

export function registerTimerRoutes(app: Express): void {
  registerRouteSet(app, "/api/timers", "timers");
  registerRouteSet(app, "/api/responsibilities", "responsibilities");

  deferSchedulerUntilNexusReady();
}

// The scheduler must wait until gitnexus is *actually* done initializing (or
// known to have failed/degraded), not until "boot_complete" — because boot_complete
// fires on httpServer.listen, well before gitnexus indexing finishes. The pre-fix
// `else if` chain meant boot_complete won the race, so the scheduler started while
// gitnexus was still indexing. Pair that with the 32-bit setTimeout overflow and
// you get the timer stampede that wedged the event loop in incident `mooppudm-l8pk`.
//
// Listen ONLY to nexus_* signals here. The 5-min ceiling is a last-resort fallback
// when nothing comes through (e.g. nexus_degraded path).
function deferSchedulerUntilNexusReady(): void {
  let started = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const startScheduler = (trigger: string) => {
    if (started) return;
    started = true;

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }

    schedulerLog.log(`Starting — ${trigger}`);
    timerScheduler.start().catch((err: unknown) => {
      schedulerLog.error("Scheduler start error:", errMsg(err));
    });
  };

  import("./event-bus").then(({ eventBus }) => {
    const listener = (busEvent: BusEvent) => {
      if (busEvent.event === "system:nexus_ready") {
        startScheduler("nexus_ready received");
      } else if (busEvent.event === "system:nexus_failed") {
        startScheduler("nexus_failed received");
      } else if (busEvent.event === "system:nexus_degraded") {
        startScheduler("nexus_degraded received");
      }
    };
    eventBus.on("event", listener);
    unsubscribe = () => eventBus.off("event", listener);
    schedulerLog.log(`Deferring start until nexus_ready / nexus_failed / nexus_degraded (timeout: ${NEXUS_READY_TIMEOUT_MS / 1000}s)`);
  }).catch(() => {
    startScheduler("event_bus_import_failed");
  });

  timeoutHandle = setTimeout(() => {
    startScheduler(`nexus signal timeout after ${Math.round(NEXUS_READY_TIMEOUT_MS / 1000)}s, starting scheduler with degraded code-intel`);
  }, NEXUS_READY_TIMEOUT_MS);
}

export const registerResponsibilityRoutes = registerTimerRoutes;
