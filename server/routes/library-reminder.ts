import type { Express, Request, Response } from "express";
import { timerStorage } from "../file-storage";
import { timerScheduler } from "../timer-scheduler";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { db } from "../db";
import { libraryPages } from "@shared/schema";
import { eq } from "drizzle-orm";
import { requireCurrentUserPrincipal } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope } from "../scoped-storage";
import { publishLibraryChanged } from "../library-save";
import {
  findActiveLibraryReminder,
  LIBRARY_REMINDER_PREFIX,
} from "../library-reminders";

const log = createLogger("LibraryReminder");

function buildReminderName(pageId: string, pageTitle?: string): string {
  const label = pageTitle?.slice(0, 40) || pageId;
  return `Library Reminder (${label})`;
}

export function registerLibraryReminderRoutes(app: Express): void {
  app.get("/api/info/library/:id/reminder", requireAuth, async (req: Request, res: Response) => {
    try {
      const pageId = req.params.id;
      const [page] = await db
        .select({ id: libraryPages.id })
        .from(libraryPages)
        .where(combineWithVisibleScope(requireCurrentUserPrincipal(), {
          scope: libraryPages.scope,
          ownerUserId: libraryPages.ownerUserId,
          accountId: libraryPages.accountId,
          vaultId: libraryPages.vaultId,
        }, eq(libraryPages.id, pageId)));
      if (!page) {
        res.status(404).json({ error: "Library page not found" });
        return;
      }
      const timer = await findActiveLibraryReminder(pageId);
      if (!timer) {
        res.json({ active: false });
        return;
      }
      const nextRunTimes = timerScheduler.getNextRunTimes();
      const schedule = timer.schedules[0];
      const nextBoot = !!schedule?.fireOnNextBoot;
      const nextBuild = !!schedule?.fireOnNextBuild;
      const fireAt = nextBoot || nextBuild ? null : (schedule?.fireAt || nextRunTimes[timer.id] || null);
      res.json({
        active: true,
        timerId: timer.id,
        fireAt,
        nextBoot,
        nextBuild,
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
        .where(combineWithWritableScope(requireCurrentUserPrincipal(), {
          scope: libraryPages.scope,
          ownerUserId: libraryPages.ownerUserId,
          accountId: libraryPages.accountId,
          vaultId: libraryPages.vaultId,
        }, eq(libraryPages.id, pageId)));
      if (!page) {
        res.status(404).json({ error: "Library page not found" });
        return;
      }

      const { fireAt, nextBoot, nextBuild, dismiss } = req.body as {
        fireAt?: string;
        nextBoot?: boolean;
        nextBuild?: boolean;
        dismiss?: boolean;
      };

      let scheduleEntry: { id: string; frequency: "once"; fireAt?: string; fireOnNextBoot?: boolean; fireOnNextBuild?: boolean };
      let fireAtIso: string | null = null;

      if (nextBoot || nextBuild) {
        scheduleEntry = {
          id: `sched-reminder-${Date.now().toString(36)}`,
          frequency: "once",
          ...(nextBuild ? { fireOnNextBuild: true } : { fireOnNextBoot: true }),
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

      const existing = await findActiveLibraryReminder(pageId);
      const timer = await timerStorage.create({
        name: buildReminderName(pageId, page.title ?? undefined),
        description: `${LIBRARY_REMINDER_PREFIX}${pageId}`,
        type: "reminder",
        prompt: "",
        schedules: [scheduleEntry],
        enabled: true,
        timezone: "UTC",
      });

      if (dismiss !== false) {
        const snoozedUntil = fireAtIso
          ? new Date(fireAtIso)
          : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
        const [updatedPage] = await db
          .update(libraryPages)
          .set({
            surface: true,
            surfaceUntil: snoozedUntil,
            surfaceSection: "snoozed",
            updatedAt: new Date(),
          })
          .where(combineWithWritableScope(requireCurrentUserPrincipal(), {
            scope: libraryPages.scope,
            ownerUserId: libraryPages.ownerUserId,
            accountId: libraryPages.accountId,
            vaultId: libraryPages.vaultId,
          }, eq(libraryPages.id, pageId)))
          .returning();
        if (!updatedPage) {
          await timerStorage.delete(timer.id);
          res.status(404).json({ error: "Library page not found or not writable" });
          return;
        }
        publishLibraryChanged("snoozed", updatedPage);
      }

      if (existing) {
        const deleted = await timerStorage.delete(existing.id);
        if (!deleted) {
          await timerStorage.delete(timer.id);
          throw new Error(`Failed to replace existing reminder ${existing.id}`);
        }
        log.log(`Replaced existing reminder timerId=${existing.id} for page=${pageId}`);
      }

      log.log(`Created library reminder timerId=${timer.id} page=${pageId} ${nextBuild ? "nextBuild=true" : nextBoot ? "nextBoot=true" : `fireAt=${fireAtIso}`}`);

      await timerScheduler.rescheduleAll();

      res.status(201).json({
        active: true,
        timerId: timer.id,
        fireAt: fireAtIso,
        nextBoot: !!nextBoot && !nextBuild,
        nextBuild: !!nextBuild,
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
        .select({ id: libraryPages.id, surfaceUntil: libraryPages.surfaceUntil })
        .from(libraryPages)
        .where(combineWithWritableScope(requireCurrentUserPrincipal(), {
          scope: libraryPages.scope,
          ownerUserId: libraryPages.ownerUserId,
          accountId: libraryPages.accountId,
          vaultId: libraryPages.vaultId,
        }, eq(libraryPages.id, pageId)));
      if (!page) {
        res.status(404).json({ error: "Library page not found" });
        return;
      }
      const timer = await findActiveLibraryReminder(pageId);
      if (!timer) {
        res.status(404).json({ error: "No active reminder found" });
        return;
      }

      const now = Date.now();
      const existingUntil = page.surfaceUntil?.getTime() ?? 0;
      const inboxUntil = new Date(Math.max(existingUntil, now + 24 * 60 * 60 * 1000));
      const [updatedPage] = await db
        .update(libraryPages)
        .set({
          surface: true,
          surfaceUntil: inboxUntil,
          surfaceSection: "inbox",
          updatedAt: new Date(),
        })
        .where(combineWithWritableScope(requireCurrentUserPrincipal(), {
          scope: libraryPages.scope,
          ownerUserId: libraryPages.ownerUserId,
          accountId: libraryPages.accountId,
          vaultId: libraryPages.vaultId,
        }, eq(libraryPages.id, pageId)))
        .returning();
      if (!updatedPage) {
        res.status(404).json({ error: "Library page not found or not writable" });
        return;
      }

      const deleted = await timerStorage.delete(timer.id);
      if (!deleted) {
        throw new Error(`Failed to cancel reminder ${timer.id}`);
      }
      await timerScheduler.rescheduleAll();
      publishLibraryChanged("reminder_cancelled", updatedPage);
      log.log(`Cancelled library reminder timerId=${timer.id} page=${pageId}`);

      res.json({ success: true });
    } catch (error: unknown) {
      log.error("DELETE library reminder error:", error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: "Failed to cancel reminder" });
    }
  });
}
