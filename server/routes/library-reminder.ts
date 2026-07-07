import type { Express, Request, Response } from "express";
import { timerStorage } from "../file-storage";
import { timerScheduler } from "../timer-scheduler";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { db } from "../db";
import { libraryPages } from "@shared/schema";
import { eq } from "drizzle-orm";

const log = createLogger("LibraryReminder");

export const LIBRARY_REMINDER_PREFIX = "library-reminder:";

function buildReminderName(pageId: string, pageTitle?: string): string {
  const label = pageTitle?.slice(0, 40) || pageId;
  return `Library Reminder (${label})`;
}

export function extractLibraryPageId(timer: { description: string }): string | null {
  if (timer.description.startsWith(LIBRARY_REMINDER_PREFIX)) {
    return timer.description.slice(LIBRARY_REMINDER_PREFIX.length);
  }
  return null;
}

async function findActiveReminder(pageId: string) {
  const allTimers = await timerStorage.getAll();
  return allTimers.find(
    (t) =>
      t.type === "reminder" &&
      t.enabled &&
      t.description === `${LIBRARY_REMINDER_PREFIX}${pageId}`
  );
}

export function registerLibraryReminderRoutes(app: Express): void {
  app.get("/api/info/library/:id/reminder", requireAuth, async (req: Request, res: Response) => {
    try {
      const pageId = req.params.id;
      const [page] = await db
        .select({ id: libraryPages.id })
        .from(libraryPages)
        .where(eq(libraryPages.id, pageId));
      if (!page) {
        res.status(404).json({ error: "Library page not found" });
        return;
      }
      const timer = await findActiveReminder(pageId);
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
      log.error("GET library reminder error:", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to check reminder" });
    }
  });

  app.post("/api/info/library/:id/reminder", requireAuth, async (req: Request, res: Response) => {
    try {
      const pageId = req.params.id;
      const [page] = await db
        .select({ id: libraryPages.id, title: libraryPages.title })
        .from(libraryPages)
        .where(eq(libraryPages.id, pageId));
      if (!page) {
        res.status(404).json({ error: "Library page not found" });
        return;
      }

      const { fireAt, nextBoot, dismiss } = req.body as {
        fireAt?: string;
        nextBoot?: boolean;
        dismiss?: boolean;
      };

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

      // Remove any existing reminder for this page
      const existing = await findActiveReminder(pageId);
      if (existing) {
        await timerStorage.delete(existing.id);
        log.log(`Deleted existing reminder timerId=${existing.id} for page=${pageId}`);
      }

      // Create the reminder timer
      const timer = await timerStorage.create({
        name: buildReminderName(pageId, page.title ?? undefined),
        description: `${LIBRARY_REMINDER_PREFIX}${pageId}`,
        type: "reminder",
        prompt: "",
        schedules: [scheduleEntry],
        enabled: true,
        timezone: "UTC",
      });

      // Move to snoozed section instead of dismissing
      if (dismiss !== false) {
        const snoozedUntil = fireAtIso
          ? new Date(fireAtIso)
          : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // nextBoot: snooze for a year
        await db
          .update(libraryPages)
          .set({
            surface: true,
            surfaceUntil: snoozedUntil,
            surfaceSection: "snoozed",
            updatedAt: new Date(),
          })
          .where(eq(libraryPages.id, pageId));
      }

      log.log(`Created library reminder timerId=${timer.id} page=${pageId} ${nextBoot ? "nextBoot=true" : `fireAt=${fireAtIso}`}`);

      await timerScheduler.rescheduleAll();

      res.status(201).json({
        active: true,
        timerId: timer.id,
        fireAt: fireAtIso,
        nextBoot: !!nextBoot,
      });
    } catch (error: unknown) {
      log.error("POST library reminder error:", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to set reminder" });
    }
  });

  app.delete("/api/info/library/:id/reminder", requireAuth, async (req: Request, res: Response) => {
    try {
      const pageId = req.params.id;
      const [page] = await db
        .select({ id: libraryPages.id })
        .from(libraryPages)
        .where(eq(libraryPages.id, pageId));
      if (!page) {
        res.status(404).json({ error: "Library page not found" });
        return;
      }
      const timer = await findActiveReminder(pageId);
      if (!timer) {
        res.status(404).json({ error: "No active reminder found" });
        return;
      }

      await timerStorage.delete(timer.id);
      await timerScheduler.rescheduleAll();
      log.log(`Cancelled library reminder timerId=${timer.id} page=${pageId}`);

      res.json({ success: true });
    } catch (error: unknown) {
      log.error("DELETE library reminder error:", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to cancel reminder" });
    }
  });
}
