// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { isAgentType } from "@shared/instance-config";
import { AgentTimerHandler } from "./agent-timer-handler";
import { MeTimerHandler } from "./me-timer-handler";
import { ReminderTimerHandler } from "./reminder-timer-handler";
import { SkillTimerHandler } from "./skill-timer-handler";
import { SystemTimerHandler } from "./system-timer-handler";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";

export class TimerHandlerRouter implements TimerHandler {
  private readonly agentTimerHandler = new AgentTimerHandler();
  private readonly systemTimerHandler = new SystemTimerHandler();
  private readonly meTimerHandler = new MeTimerHandler();
  private readonly skillTimerHandler = new SkillTimerHandler();
  private readonly reminderTimerHandler = new ReminderTimerHandler(
    this.agentTimerHandler,
  );

  async execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult> {
    if (isAgentType(timer.type)) {
      return this.agentTimerHandler.execute(timer, run);
    }

    if (timer.type === "system") {
      return this.systemTimerHandler.execute(timer, run);
    }

    if (timer.type === "me") {
      return this.meTimerHandler.execute(timer, run);
    }

    if (timer.type === "skill") {
      return this.skillTimerHandler.execute(timer, run);
    }

    if (timer.type === "reminder") {
      return this.reminderTimerHandler.execute(timer, run);
    }

    return {
      outcome: "failed",
      error: `Unsupported timer type: ${timer.type}`,
    };
  }
}

export const timerHandlerRouter = new TimerHandlerRouter();
