export type WeeklyGoalPlanningTarget = "this_week" | "next_week";

export const PLAN_WEEK_SKILL = "plan-week";
export const PLAN_WEEK_TITLE = "Plan Week";
export const PLAN_WEEK_PERSONA = "Producer";

const ISO_WEEK_PATTERN = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;

function getZonedDateParts(now: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function isoWeekKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function weeklyGoalPeriodKey(
  now: Date,
  timezone: string,
  target: WeeklyGoalPlanningTarget,
): string {
  const parts = getZonedDateParts(now, timezone);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (target === "next_week") date.setUTCDate(date.getUTCDate() + 7);
  return isoWeekKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Bounded launch context for the reusable Plan Week Skill. Omit to plan the current ISO week. */
export function composePlanWeekLaunchContext(periodWeek?: string): string | undefined {
  if (periodWeek === undefined) return undefined;
  if (!ISO_WEEK_PATTERN.test(periodWeek)) throw new Error(`Invalid ISO periodWeek: ${periodWeek}`);
  return `Plan Week parameters:\nperiodWeek: ${periodWeek}`;
}
