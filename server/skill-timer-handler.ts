// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { createLogger } from "./log";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";
import { getCurrentPrincipal } from "./principal-context";
import { enqueueTimerSkillRuntimeRun } from "./runtime/proof-path-handlers";

const log = createLogger("SkillTimerHandler");

export class SkillTimerHandler implements TimerHandler {
  async execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult> {
    let skillId = timer.skillId;
    if (!skillId) {
      log.debug(`Skill timer "${timer.name}" has no skillId — yielding skipped result`);
      return { outcome: "skipped", reason: "missing_skill_id" };
    }

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(skillId)) {
      try {
        const { storage } = await import("./storage");
        const dbSkill = await storage.getSkill(skillId);
        if (dbSkill) {
          log.debug(`Resolved UUID skillId="${skillId}" to name="${dbSkill.name}" for timer "${timer.name}"`);
          skillId = dbSkill.name;
        }
      } catch (err) {
        log.debug(`Failed to resolve UUID skillId="${skillId}" for timer "${timer.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const principal = getCurrentPrincipal();
    if (!principal) throw new Error(`Skill Timer "${timer.name}" lost its owning principal`);
    const preContext = timer.prompt?.trim() || undefined;
    const result = await enqueueTimerSkillRuntimeRun(principal, timer, run, skillId, preContext);
    log.log(`Skill Timer "${timer.name}" enqueued Runtime runId=${result.run.id} disposition=${result.disposition} timerRunId=${run.id}`);
    return {
      outcome: "accepted",
      output: { runtimeRunId: result.run.id, runtimeDisposition: result.disposition, skillId },
    };
  }
}
