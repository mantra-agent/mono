export type WeeklyGoalPlanningTarget = "this_week" | "next_week";

export interface WeeklyGoalPlanningContext {
  target: WeeklyGoalPlanningTarget;
  periodWeek: string;
}

export function weeklyGoalPeriodKey(
  date: Date,
  timezone: string,
  target: WeeklyGoalPlanningTarget,
): string {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const targetDate = new Date(`${localDate}T12:00:00Z`);
  if (target === "next_week") targetDate.setUTCDate(targetDate.getUTCDate() + 7);
  const dayOfWeek = targetDate.getUTCDay() || 7;
  targetDate.setUTCDate(targetDate.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(targetDate.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((targetDate.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${targetDate.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

export function composeWeeklyGoalPlanningMessage({
  target,
  periodWeek,
}: WeeklyGoalPlanningContext): string {
  const label = target === "next_week" ? "next week" : "this week";
  return [
    `Plan ${label}'s goals for ${periodWeek}.`,
    "Use the canonical goals system and keep the conversation focused on selecting or refining up to three active this_week goals scoped to that exact periodWeek.",
    "Inspect existing goals for that week before creating anything, reuse equivalent goals, and do not change goals assigned to another week.",
  ].join(" ");
}
