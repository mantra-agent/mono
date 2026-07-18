import type { Goal } from "@shared/schema";
import { eventBus } from "./event-bus";
import { goalsService } from "./goals-service";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { runWithPrincipal } from "./principal-context";
import { getDateInTimezone, getTimezone } from "./timezone";

const log = createLogger("FtuePriorities");

const FTUE_SAY_HELLO_TITLE = "Say hello";
const FTUE_ADD_FIRST_GOAL_TITLE = "Add first goal";

type UserPrincipal = Principal & { userId: string; accountId: string };

function today(): string {
  return getDateInTimezone(getTimezone());
}

async function publishGoalMutation(action: string, title: string, goalId?: string): Promise<void> {
  try {
    const { invalidateSimpleFeedCache } = await import("./simple/generate-feed");
    invalidateSimpleFeedCache();
    eventBus.publish({
      category: "goals",
      event: "data:goals_changed",
      payload: {
        date: today(),
        sessionType: "daily",
        change: { domain: "priority", action, title, periodLabel: "Daily", source: "ftue", goalId: goalId ?? null },
      },
    });
  } catch (err) {
    log.warn("goal mutation notification failed", err instanceof Error ? err.message : String(err));
  }
}

export async function seedFtuePrioritiesForUser(principal: UserPrincipal): Promise<void> {
  await runWithPrincipal(principal, async () => {
    const date = today();
    let seeded = false;

    // Create FTUE goals if they don't already exist for today
    for (const title of [FTUE_SAY_HELLO_TITLE, FTUE_ADD_FIRST_GOAL_TITLE]) {
      const result = await goalsService.createPriority(title, "today", date, { source: "ftue" });
      if (result.created) seeded = true;
    }

    if (seeded) {
      await publishGoalMutation("add", "FTUE goals");
      log.log("seeded FTUE goals", { userId: principal.userId, date });
    }
  });
}

export async function completeFtueSayHello(principal: UserPrincipal): Promise<void> {
  await runWithPrincipal(principal, async () => {
    const date = today();
    const result = await goalsService.markPriorityStatus(FTUE_SAY_HELLO_TITLE, "completed", "today", date);
    if ("updated" in result && !result.alreadySet) {
      await publishGoalMutation("mark_status", FTUE_SAY_HELLO_TITLE, result.updated.id);
      log.log("completed FTUE Say hello", { userId: principal.userId, date });
    }
  });
}

export async function completeFtueFirstGoalAndAddGoalPriority(principal: UserPrincipal, goal: Pick<Goal, "id" | "shortName">): Promise<void> {
  await runWithPrincipal(principal, async () => {
    const date = today();

    // Mark "Add first goal" as completed — only create the linked daily goal
    // if the FTUE step actually existed and wasn't already done.
    // Without this gate, every user-created goal spawns a duplicate child.
    const markResult = await goalsService.markPriorityStatus(FTUE_ADD_FIRST_GOAL_TITLE, "completed", "today", date);
    const ftueJustCompleted = "updated" in markResult && !markResult.alreadySet;
    if (ftueJustCompleted && "updated" in markResult) {
      await publishGoalMutation("mark_status", FTUE_ADD_FIRST_GOAL_TITLE, markResult.updated.id);
    }

    // Only create the linked daily goal when we actually just completed the FTUE step
    if (ftueJustCompleted) {
      const goalTitle = goal.shortName.trim();
      if (goalTitle) {
        const createResult = await goalsService.createPriority(goalTitle, "today", date, { source: "ftue" });
        if (createResult.created) {
          try {
            await goalsService.linkParent(createResult.goal.id, goal.id);
          } catch (err) {
            log.warn(`Failed to link FTUE goal parent: ${err instanceof Error ? err.message : String(err)}`);
          }
          await publishGoalMutation("add", goalTitle, createResult.goal.id);
        }
      }
    }

    log.log("completed FTUE first goal step", { userId: principal.userId, goalId: goal.id, date, ftueJustCompleted });
  });
}
