import type { Timer } from "@shared/models/timers";
import { timerStorage } from "./file-storage";

export const LIBRARY_REMINDER_PREFIX = "library-reminder:";
const DEFERRED_REMINDER_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

export function extractLibraryPageId(timer: Pick<Timer, "description">): string | null {
  return timer.description.startsWith(LIBRARY_REMINDER_PREFIX)
    ? timer.description.slice(LIBRARY_REMINDER_PREFIX.length)
    : null;
}

export async function findActiveLibraryReminder(pageId: string): Promise<Timer | undefined> {
  const allTimers = await timerStorage.getAll();
  return allTimers.find(
    timer => timer.type === "reminder"
      && timer.enabled
      && timer.description === `${LIBRARY_REMINDER_PREFIX}${pageId}`,
  );
}

interface ReminderSurfaceProjection {
  surfaceUntil: Date;
  surfaceSection: "inbox" | "snoozed";
}

function reminderSurfaceProjection(timer: Timer, nowMs: number): ReminderSurfaceProjection | null {
  const schedule = timer.schedules[0];
  if (!schedule) return null;
  if (schedule.fireOnNextBoot || schedule.fireOnNextBuild) {
    return {
      surfaceUntil: new Date(nowMs + DEFERRED_REMINDER_WINDOW_MS),
      surfaceSection: "snoozed",
    };
  }
  if (!schedule.fireAt) return null;
  const fireAt = new Date(schedule.fireAt);
  if (!Number.isFinite(fireAt.getTime())) return null;
  if (fireAt.getTime() > nowMs) {
    return { surfaceUntil: fireAt, surfaceSection: "snoozed" };
  }
  return {
    surfaceUntil: new Date(nowMs + 24 * 60 * 60 * 1000),
    surfaceSection: "inbox",
  };
}

export async function projectActiveLibraryReminders<
  T extends {
    id: string;
    surface: boolean | null;
    surfaceUntil: Date | null;
    surfaceSection: string | null;
  },
>(pages: T[], now = new Date()): Promise<T[]> {
  const nowMs = now.getTime();
  const projections = new Map<string, ReminderSurfaceProjection>();
  for (const timer of await timerStorage.getAll()) {
    if (timer.type !== "reminder" || !timer.enabled) continue;
    const pageId = extractLibraryPageId(timer);
    const projection = reminderSurfaceProjection(timer, nowMs);
    if (pageId && projection) projections.set(pageId, projection);
  }
  if (projections.size === 0) return pages;

  return pages.map(page => {
    const projection = projections.get(page.id);
    if (!projection) return page;
    return {
      ...page,
      surface: true,
      ...projection,
    };
  });
}
