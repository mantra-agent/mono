// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { SYSTEM_TIMER_SKILL_ALIASES } from "./system-timer-registry";
import { createLogger } from "./log";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";

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
      const contract = this.buildParameterizedContract(
        "reflect",
        cadence ?? "weekly",
      );
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
    } else if (skillId === "plan") {
      const cadence = this.getSkillCadence(timer, skillId);
      const contract = this.buildParameterizedContract(
        "plan",
        cadence ?? "weekly",
      );
      preContext = [
        contract,
        "conversationMode: true",
        "firstTurnInstruction: Start a short planning conversation. Do not create goals, create a Library artifact, or call priorities metadata until Ray confirms the goal set.",
        "contextPolicy: Use only parent goals, existing target-period goals, and future calendar/project constraints if needed. Do not load past reflections or finance transactions unless Ray explicitly asks.",
      ].join("\n");
    }

    log.debug(
      `[timer:${timer.name}] phase=skill-import — importing autonomous skill runner`,
    );
    const { executeAutonomousSkillRun } =
      await import("./autonomous-skill-runner");
    log.debug(
      `[timer:${timer.name}] phase=pipeline-start — launching executeAutonomousSkillRun for skillId=${skillId}`,
    );
    const result = await executeAutonomousSkillRun(skillId, { preContext });
    if (!result) {
      log.debug(
        `Skill timer "${timer.name}" skillId=${skillId} did not start — yielding deferred result: admission_deferred_or_already_running`,
      );
      return {
        outcome: "deferred",
        reason: "admission_deferred_or_already_running",
      };
    }

    if (result.status === "yielded") {
      log.debug(
        `Skill timer "${timer.name}" skillId=${skillId} yielded to interactive session — yielding skipped result`,
      );
      return { outcome: "skipped", reason: "yield_to_interactive" };
    }

    if (result.status !== "succeeded") {
      const errorMsg =
        result.error || `Skill run finished with status: ${result.status}`;
      throw new Error(errorMsg);
    }
    log.log(
      `Skill timer "${timer.name}" autonomous run completed sessionId=${result.sessionId} status=${result.status}`,
    );
    return {
      outcome: "success",
      output: { sessionId: result.sessionId, skillRunStatus: result.status },
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
    kind: "plan" | "reflect",
    cadence: "daily" | "weekly" | "monthly" | "quarterly" | "annual",
  ): string {
    const now = new Date();
    const targetHorizonByCadence: Record<typeof cadence, string> = {
      daily: "today",
      weekly: "this_week",
      monthly: "this_month",
      quarterly: "this_quarter",
      annual: "this_year",
    };
    const parentHorizonByCadence: Record<typeof cadence, string> = {
      daily: "this_week",
      weekly: "this_month",
      monthly: "this_quarter",
      quarterly: "this_year",
      annual: "three_year",
    };
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
      `# Parameterized ${kind === "plan" ? "Plan" : "Reflect"} Request`,
      `cadence: ${cadence}`,
      kind === "plan" ? `targetLabel: ${label}` : `periodLabel: ${label}`,
      kind === "plan"
        ? `targetHorizon: ${targetHorizonByCadence[cadence]}`
        : undefined,
      kind === "plan"
        ? `parentHorizon: ${parentHorizonByCadence[cadence]}`
        : undefined,
      `artifactPurpose: Scheduled ${cadence} ${kind}`,
      `surfacePolicy: always`,
    ]
      .filter(Boolean)
      .join("\n");
  }

}
