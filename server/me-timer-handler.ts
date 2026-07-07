// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { eventBus } from "./event-bus";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";

export class MeTimerHandler implements TimerHandler {
  async execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult> {
    eventBus.publish({
      category: "timer",
      event: "timer:reminder",
      payload: {
        runId: run.id,
        timerId: timer.id,
        name: timer.name,
        prompt: timer.prompt,
      },
    });
    return { outcome: "success" };
  }

}
