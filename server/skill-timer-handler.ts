// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { SYSTEM_TIMER_SKILL_ALIASES } from "./system-timer-registry";
import { createLogger } from "./log";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";
import {
  buildScheduledPlanPeriodContract,
  renderScheduledPlanPeriodContract,
} from "./planning-period-contract";
import { getCurrentPrincipal } from "./principal-context";
import { enqueueTimerSkillRuntimeRun } from "./runtime/proof-path-handlers";

const log = createLogger("SkillTimerHandler");

export class SkillTimerHandler implements TimerHandler {
  async execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult> {
    let skillId = timer.skillId;
    if (!skillId) {
      log.debug(
        `Skill timer "${timer.name}" has no skillId — yielding skipped result`,
      );
      return { outcome: "skipped", reason: "missing_skill_id" };
    }

    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(skillId)) {
      try {
        const { storage } = await import("./storage");
        const dbSkill = await storage.getSkill(skillId);
        if (dbSkill) {
          log.debug(
            `Resolved UUID skillId="${skillId}" to name="${dbSkill.name}" for timer "${timer.name}"`,
          );
          skillId = dbSkill.name;
        }
      } catch (err) {
        log.debug(
          `Failed to resolve UUID skillId="${skillId}" for timer "${timer.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (SYSTEM_TIMER_SKILL_ALIASES[skillId]) {
      log.debug(
        `Normalized skillId="${skillId}" to "${SYSTEM_TIMER_SKILL_ALIASES[skillId]}" for timer "${timer.name}"`,
      );
      skillId = SYSTEM_TIMER_SKILL_ALIASES[skillId];
    }

    const retiredLegacyMemorySkillIds = new Set([
      "consolidate",
      "integrate",
      "memory-consolidate",
      "memory-integrate",
    ]);
    if (retiredLegacyMemorySkillIds.has(skillId)) {
      log.warn(
        `Retired legacy memory lifecycle timer blocked: timer="${timer.name}" skillId=${skillId}`,
      );
      return {
        outcome: "skipped",
        reason: "retired_legacy_memory_lifecycle",
        output: { skillId },
      };
    }

    log.debug(`Executing skill timer "${timer.name}" skillId=${skillId}`);

    let preContext: string | undefined;
    log.debug(
      `[timer:${timer.name}] phase=pre-context — building preContext for skillId=${skillId}`,
    );
    if (skillId === "brief-daily") {
      const { buildDailyBriefPreContext } = await import("./thoughts");
      const data = await buildDailyBriefPreContext();
      if (!data) {
        log.debug(
          `Skill timer "${timer.name}" brief-daily precondition not met — yielding skipped result`,
        );
        return {
          outcome: "skipped",
          reason: "brief_daily_precondition_not_met",
        };
      }
      preContext = data.preContext;
    } else if (skillId === "reflect") {
      const cadence = this.getSkillCadence(timer, skillId);
      const contract = this.buildParameterizedContract(cadence ?? "weekly");
      if (cadence === "daily") {
        const { buildDailyReflectPreContext } = await import("./thoughts");
        const data = await buildDailyReflectPreContext();
        if (!data) {
          log.debug(
            `Skill timer "${timer.name}" reflect daily preContext unavailable — running parameterized Reflect with contract only`,
          );
        }
        preContext = data?.preContext
          ? `${contract}\n\n${data.preContext}`
          : contract;
      } else if (cadence === "weekly") {
        const { buildWeeklyReflectPreContext } = await import("./thoughts");
        const data = await buildWeeklyReflectPreContext();
        if (!data) {
          log.debug(
            `Skill timer "${timer.name}" reflect weekly preContext unavailable — running parameterized Reflect with contract only`,
          );
        }
        preContext = data?.preContext
          ? `${contract}\n\n${data.preContext}`
          : contract;
      } else if (cadence === "monthly") {
        const { buildMonthlyReflectPreContext } = await import("./thoughts");
        const data = await buildMonthlyReflectPreContext();
        if (!data) {
          log.debug(
            `Skill timer "${timer.name}" reflect monthly preContext unavailable — running parameterized Reflect with contract only`,
          );
        }
        preContext = data?.preContext
          ? `${contract}\n\n${data.preContext}`
          : contract;
      } else if (cadence === "quarterly") {
        preContext = contract;
      } else {
        preContext = contract;
      }
    } else if (skillId === "regression" && run.metadata?.eventType === "build.acceptance.passed") {
      preContext = [
        "# Accepted Build Deployment",
        `workflowRunId: ${String(run.metadata.workflowRunId ?? "unknown")}`,
        `workflowStageAttemptId: ${String(run.metadata.workflowStageAttemptId ?? "unknown")}`,
        `platformEnvironmentId: ${String(run.metadata.platformEnvironmentId ?? "unknown")}`,
        `deploymentId: ${String(run.metadata.deploymentId ?? "unknown")}`,
        `revision: ${String(run.metadata.revision ?? "unknown")}`,
        `acceptedAt: ${String(run.metadata.acceptedAt ?? run.intendedFireAt ?? run.startedAt)}`,
        "Review the unresolved Issue queue against this accepted deployment using the ordinary Regression Skill contract.",
      ].join("\n");
    } else if (skillId === "plan") {
      const cadence = this.getSkillCadence(timer, skillId) ?? "weekly";
      const anchorSource = run.intendedFireAt
        ? "timerRun.intendedFireAt"
        : "timerRun.startedAt";
      const contract = buildScheduledPlanPeriodContract({
        cadence,
        anchorAt: run.intendedFireAt ?? run.startedAt,
        anchorSource,
        timezone: timer.timezone,
      });
      preContext = [
        renderScheduledPlanPeriodContract(contract),
        "conversationMode: true",
        "firstTurnInstruction: Start a short planning conversation. Review the current period only to classify existing goals as complete, carry forward, change, or drop; then align goals for the next target period. Do not mutate goals, create a Library artifact, or call check-in metadata until Ray confirms the target-period goal set.",
        "contextPolicy: Load parent goals for parentPeriod, existing target-horizon goals scoped to targetPeriod, and review-period goals only for the narrow transition review. Do not load reflections or finance unless Ray explicitly asks.",
        "mutationPolicy: After confirmation, mutate only targetPeriod goals and create/link only the targetPeriod plan artifact. Never rewrite reviewPeriod goals as part of planning.",
      ].join("\n");
    }

    const principal = getCurrentPrincipal();
    if (!principal) throw new Error(`Skill Timer "${timer.name}" lost its owning principal`);
    const result = await enqueueTimerSkillRuntimeRun(principal, timer, run, skillId, preContext);
    log.log(
      `Skill Timer "${timer.name}" enqueued Runtime runId=${result.run.id} disposition=${result.disposition} timerRunId=${run.id}`,
    );
    return {
      outcome: "success",
      output: {
        runtimeRunId: result.run.id,
        runtimeDisposition: result.disposition,
        skillId,
      },
    };
  }

  private getSkillCadence(
    timer: Timer,
    skillId: string,
  ): "daily" | "weekly" | "monthly" | "quarterly" | "annual" | null {
    const promptMatch = timer.prompt.match(/cadence=([a-z]+)/);
    const promptCadence = promptMatch?.[1];
    if (
      promptCadence === "daily" ||
      promptCadence === "weekly" ||
      promptCadence === "monthly" ||
      promptCadence === "quarterly" ||
      promptCadence === "annual"
    ) {
      return promptCadence;
    }

    const name = timer.name.toLowerCase();
    if (name.includes("daily")) return "daily";
    if (name.includes("weekly")) return "weekly";
    if (name.includes("monthly")) return "monthly";
    if (name.includes("quarterly")) return "quarterly";
    if (name.includes("annual")) return "annual";

    return null;
  }

  private buildParameterizedContract(
    cadence: "daily" | "weekly" | "monthly" | "quarterly" | "annual",
  ): string {
    const now = new Date();
    const label =
      cadence === "monthly"
        ? new Intl.DateTimeFormat("en-US", {
            month: "long",
            year: "numeric",
          }).format(now)
        : cadence === "quarterly"
          ? `Q${Math.floor(now.getMonth() / 3) + 1} ${now.getFullYear()}`
          : cadence === "annual"
            ? String(now.getFullYear())
            : new Intl.DateTimeFormat("en-CA", {
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(now);

    return [
      "# Parameterized Reflect Request",
      `cadence: ${cadence}`,
      `periodLabel: ${label}`,
      `artifactPurpose: Scheduled ${cadence} reflect`,
      "surfacePolicy: always",
    ].join("\n");
  }

}
