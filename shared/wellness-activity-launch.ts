/**
 * Closed Wellness activity launch / completion contract.
 * Code may switch on these kinds. Code may not switch on activity name.
 */

export const WELLNESS_LAUNCH_KINDS = ["log", "screen", "skill"] as const;
export type WellnessLaunchKind = (typeof WELLNESS_LAUNCH_KINDS)[number];

export const WELLNESS_COMPLETION_SOURCES = [
  "wellness_log",
  "journal_entry",
  "today_goal_mutated",
] as const;
export type WellnessCompletionSource = (typeof WELLNESS_COMPLETION_SOURCES)[number];

export interface WellnessLaunchFields {
  launchKind?: string | null;
  launchTarget?: string | null;
  completionSource?: string | null;
}

export function wellnessLaunchKind(value: string | null | undefined): WellnessLaunchKind {
  if (value === "screen" || value === "skill") return value;
  return "log";
}

export function wellnessCompletionSource(
  value: string | null | undefined,
): WellnessCompletionSource {
  if (value === "journal_entry" || value === "today_goal_mutated") return value;
  return "wellness_log";
}

/** Habits / heatmap must not write or delete a wellness_log for these rows. */
export function wellnessRefusesManualLog(activity: WellnessLaunchFields): boolean {
  const launch = wellnessLaunchKind(activity.launchKind);
  const completion = wellnessCompletionSource(activity.completionSource);
  return launch === "screen" || launch === "skill"
    || completion === "journal_entry"
    || completion === "today_goal_mutated";
}

/** No wellness_log may exist for this completion source, even from a dedicated screen. */
export function wellnessRefusesAnyLog(activity: WellnessLaunchFields): boolean {
  return wellnessLaunchKind(activity.launchKind) === "skill"
    || wellnessCompletionSource(activity.completionSource) === "today_goal_mutated";
}

export const WELLNESS_LAUNCH_BACKFILL: Array<{
  names: string[];
  launchKind: WellnessLaunchKind;
  launchTarget: string | null;
  completionSource: WellnessCompletionSource;
}> = [
  {
    names: ["Gratitude"],
    launchKind: "screen",
    launchTarget: "navigation.gratitude.open",
    completionSource: "journal_entry",
  },
  {
    names: ["Reflection", "Reflections"],
    launchKind: "screen",
    launchTarget: "navigation.reflections.open",
    completionSource: "journal_entry",
  },
  {
    names: ["Intentions"],
    launchKind: "skill",
    launchTarget: "set-daily-goals",
    completionSource: "today_goal_mutated",
  },
];
