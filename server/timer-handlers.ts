import type { Timer, TimerRun } from "@shared/models/timers";

export type TimerHandlerResult =
  | { outcome: "success"; output?: unknown }
  | { outcome: "skipped"; reason: string; output?: unknown }
  | { outcome: "failed"; error: string; output?: unknown }
  | { outcome: "deferred"; reason: string; output?: unknown }
  | { outcome: "degraded"; reason: string; output?: unknown };

export interface TimerHandler {
  execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult>;
}
