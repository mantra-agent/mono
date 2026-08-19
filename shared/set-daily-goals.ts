/**
 * Set Daily Goals launch body. Procedure lives on the Wellness skill;
 * buttons compose this contract, never a row-local prompt.
 */
export const SET_DAILY_GOALS_SKILL = "set-daily-goals";
export const SET_DAILY_GOALS_TITLE = "Set Daily Goals";
export const SET_DAILY_GOALS_PERSONA = "Coach";

export function composeSetDailyGoalsLaunchMessage(): string {
  return [
    `Run the ${SET_DAILY_GOALS_TITLE} skill (\`${SET_DAILY_GOALS_SKILL}\`).`,
    "You are Coach. Conversation-first. Today-horizon only.",
    "Do not mutate today-goals or write @page:intentions until Ray confirms the set.",
    "Never call set_daily_plan. Never mint a dated Daily Plan page. Never surface Intentions.",
  ].join("\n");
}
