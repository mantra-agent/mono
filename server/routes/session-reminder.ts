import type { Express, Request, Response } from "express";
import { timerStorage } from "../file-storage";
import { timerScheduler } from "../timer-scheduler";
import { chatFileStorage } from "../chat-file-storage";
import { createLogger } from "../log";
import { requireAuth } from "../auth";

const log = createLogger("SessionReminder");

const SESSION_REMINDER_PREFIX = "session-reminder:";

function buildReminderName(sessionId: string): string {
  return `Session Reminder (${sessionId})`;
}

function extractSessionId(timer: { description: string }): string | null {
  if (timer.description.startsWith(SESSION_REMINDER_PREFIX)) {
    return timer.description.slice(SESSION_REMINDER_PREFIX.length);
  }
  return null;
}

async function findActiveReminder(sessionId: string) {
  const allTimers = await timerStorage.getAll();
  return allTimers.find(
    (t) =>
      t.type === "reminder" &&
      t.enabled &&
      t.description === `${SESSION_REMINDER_PREFIX}${sessionId}`
  );
}

export function registerSessionReminderRoutes(app: Express): void {
  app.get("/api/sessions/:id/reminder", requireAuth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id;
      const session = await chatFileStorage.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const timer = await findActiveReminder(sessionId);
      if (!timer) {
        res.json({ active: false });
        return;
      }
      const nextRunTimes = timerScheduler.getNextRunTimes();
      const schedule = timer.schedules[0];
      const nextBoot = !!schedule?.fireOnNextBoot;
      const fireAt = nextBoot ? null : (schedule?.fireAt || nextRunTimes[timer.id] || null);
      res.json({
        active: true,
        timerId: timer.id,
        fireAt,
        nextBoot,
      });
    } catch (error: unknown) {
      log.error("GET reminder error:", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to check reminder" });
    }
  });

  app.post("/api/sessions/:id/reminder", requireAuth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id;
      const session = await chatFileStorage.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const { fireAt, nextBoot } = req.body as { fireAt?: string; nextBoot?: boolean };

      let scheduleEntry: { id: string; frequency: "once"; fireAt?: string; fireOnNextBoot?: boolean };
      let fireAtIso: string | null = null;

      if (nextBoot) {
        scheduleEntry = {
          id: `sched-reminder-${Date.now().toString(36)}`,
          frequency: "once",
          fireOnNextBoot: true,
        };
      } else {
        if (!fireAt) {
          res.status(400).json({ error: "fireAt or nextBoot is required" });
          return;
        }
        const fireDate = new Date(fireAt);
        if (isNaN(fireDate.getTime()) || fireDate.getTime() <= Date.now()) {
          res.status(400).json({ error: "fireAt must be a valid future date" });
          return;
        }
        fireAtIso = fireDate.toISOString();
        scheduleEntry = {
          id: `sched-reminder-${Date.now().toString(36)}`,
          frequency: "once",
          fireAt: fireAtIso,
        };
      }

      const existing = await findActiveReminder(sessionId);
      if (existing) {
        await timerStorage.delete(existing.id);
        log.log(`Deleted existing reminder timerId=${existing.id} for session=${sessionId}`);
      }

      const timer = await timerStorage.create({
        name: buildReminderName(sessionId),
        description: `${SESSION_REMINDER_PREFIX}${sessionId}`,
        type: "reminder",
        prompt: "",
        schedules: [scheduleEntry],
        enabled: true,
        timezone: "UTC",
      });

      log.log(`Created session reminder timerId=${timer.id} session=${sessionId} ${nextBoot ? "nextBoot=true" : `fireAt=${fireAtIso}`}`);

      await timerScheduler.rescheduleAll();

      res.status(201).json({
        active: true,
        timerId: timer.id,
        fireAt: fireAtIso,
        nextBoot: !!nextBoot,
      });
    } catch (error: unknown) {
      log.error("POST reminder error:", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to set reminder" });
    }
  });

  app.delete("/api/sessions/:id/reminder", requireAuth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.params.id;
      const session = await chatFileStorage.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      const timer = await findActiveReminder(sessionId);
      if (!timer) {
        res.status(404).json({ error: "No active reminder found" });
        return;
      }

      await timerStorage.delete(timer.id);
      await timerScheduler.rescheduleAll();
      log.log(`Cancelled session reminder timerId=${timer.id} session=${sessionId}`);

      res.json({ success: true });
    } catch (error: unknown) {
      log.error("DELETE reminder error:", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to cancel reminder" });
    }
  });
}

export { SESSION_REMINDER_PREFIX, extractSessionId };
