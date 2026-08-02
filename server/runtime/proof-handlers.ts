import type { Principal } from "../principal";
import { getCurrentPrincipal } from "../principal-context";
import { storage } from "../storage";
import { parseReferenceText } from "@shared/reference-parser";
import { runtimeHandlerRegistry, type RuntimeHandler } from "./runtime-handler";

interface SkillExecuteInput {
  skillId: string;
  preContext?: string;
  timerId?: string;
  timerRunId?: string;
}

interface MemorySourceInput {
  queueId: number;
  sourceVersion: number;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Runtime handler input must be an object"), { status: 400 });
  }
  return value as Record<string, unknown>;
}

function optionalBoundedString(value: unknown, label: string, max: number): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw Object.assign(new Error(`${label} must be a string`), { status: 400 });
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  return normalized;
}

const skillExecuteHandler: RuntimeHandler<SkillExecuteInput> = {
  key: "skill.execute",
  version: 1,
  inputSchemaVersion: 1,
  resourcePool: "background_agent",
  executorProfile: "in_process_trusted",
  requiredCapabilities: ["skill.execute"],
  inputSchema: {
    parse(value) {
      const input = requireObject(value);
      const skillId = optionalBoundedString(input.skillId, "skillId", 100);
      if (!skillId) throw Object.assign(new Error("skillId is required"), { status: 400 });
      return {
        skillId,
        preContext: optionalBoundedString(input.preContext, "preContext", 32_000),
        timerId: optionalBoundedString(input.timerId, "timerId", 200),
        timerRunId: optionalBoundedString(input.timerRunId, "timerRunId", 200),
      };
    },
  },
  async authorize(principal, input) {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      return { allowed: false, reasonCode: "authority_subject_missing" };
    }
    const skill = await storage.getSkillByName(input.skillId) ?? await storage.getSkill(input.skillId);
    return skill && skill.status !== "deprecated"
      ? { allowed: true, reasonCode: "skill_visible", decisionRef: `skill:${skill.id}` }
      : { allowed: false, reasonCode: "skill_unavailable" };
  },
  async execute(context, input) {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      return {
        kind: "complete",
        outcome: "blocked",
        reasonCode: "authority_subject_missing",
        attribution: "authority",
        outputRefs: [],
        verificationLevel: "observed",
      };
    }
    await context.appendEvidence({
      eventType: "mutation",
      reasonCode: "skill_execution_started",
      payload: { effectIdempotencyKey: context.effectIdempotencyKey("skill-execution") },
    });
    const { executeAutonomousSkillRun } = await import("../autonomous-skill-runner");
    const result = await executeAutonomousSkillRun(input.skillId, {
      preContext: input.preContext,
      runtimeRunId: context.fence.runId,
      sessionKeyOverride: `runtime:${context.fence.runId}`,
      lineageId: context.fence.runId,
    });
    if (!result) {
      return {
        kind: "complete",
        outcome: "failed",
        reasonCode: "skill_execution_not_started",
        attribution: "handler",
        outputRefs: [],
        verificationLevel: "observed",
      };
    }

    if (input.timerId && input.timerRunId) {
      const { timerStorage } = await import("../file-storage");
      const timer = await timerStorage.getForScheduler(input.timerId);
      if (timer) {
        const timerRuns = await timerStorage.getRunsForScheduler(timer, 100);
        const timerRun = timerRuns.find((candidate) => candidate.id === input.timerRunId);
        if (timerRun?.runtimeRunId !== context.fence.runId) {
          return { kind: "complete", outcome: "needs_review", reasonCode: "timer_projection_mismatch", attribution: "producer", outputRefs: [`@session:${result.sessionId}`], verificationLevel: "observed" };
        }
        await timerStorage.updateRun(timer, input.timerRunId, {
          status: result.status === "succeeded" ? "success" : result.status === "degraded" ? "degraded" : "error",
          completedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          sessionId: result.sessionId,
          error: result.status === "succeeded" ? "" : result.error ?? result.status,
        });
      }
    }

    await context.appendEvidence({
      eventType: "verification",
      reasonCode: "skill_run_projected",
      payload: {
        sessionId: result.sessionId,
        status: result.status,
        durationMs: result.durationMs,
        failedStructuralChecks: result.failedStructuralChecks ?? [],
      },
    });
    const outputRefs = [
      `@session:${result.sessionId}`,
      ...parseReferenceText(result.summary ?? "")
        .filter((part) => part.kind === "reference")
        .map((part) => part.kind === "reference" ? `@${part.ref.type}:${part.ref.id}` : "")
        .filter(Boolean),
    ].slice(0, 100);
    if (result.status === "succeeded") {
      return { kind: "complete", outcome: "succeeded", reasonCode: "skill_completed", attribution: "handler", outputRefs, verificationLevel: "observed" };
    }
    if (result.status === "degraded") {
      return { kind: "complete", outcome: "degraded", reasonCode: "skill_quality_degraded", attribution: "handler", outputRefs, verificationLevel: "observed" };
    }
    return { kind: "complete", outcome: "failed", reasonCode: "skill_execution_failed", attribution: "handler", outputRefs, verificationLevel: "observed" };
  },
};

const memorySourceHandler: RuntimeHandler<MemorySourceInput> = {
  key: "memory.source.process",
  version: 1,
  inputSchemaVersion: 1,
  resourcePool: "short_worker",
  executorProfile: "in_process_trusted",
  requiredCapabilities: ["memory.source.process"],
  inputSchema: {
    parse(value) {
      const input = requireObject(value);
      if (!Number.isInteger(input.queueId) || Number(input.queueId) < 1) throw Object.assign(new Error("queueId is invalid"), { status: 400 });
      if (!Number.isInteger(input.sourceVersion) || Number(input.sourceVersion) < 1) throw Object.assign(new Error("sourceVersion is invalid"), { status: 400 });
      return { queueId: Number(input.queueId), sourceVersion: Number(input.sourceVersion) };
    },
  },
  async authorize(principal: Principal, input) {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      return { allowed: false, reasonCode: "authority_subject_missing" };
    }
    const { getByIdForRuntime } = await import("../memory/vnext-source-queue");
    const row = await getByIdForRuntime(input.queueId, principal);
    return row && row.sourceVersion === input.sourceVersion
      ? { allowed: true, reasonCode: "memory_source_visible", decisionRef: `memory-source:${row.id}:v${row.sourceVersion}` }
      : { allowed: false, reasonCode: "memory_source_superseded" };
  },
  async execute(context, input) {
    const principal = getCurrentPrincipal();
    if (!principal?.userId || !principal.accountId) {
      return { kind: "complete", outcome: "blocked", reasonCode: "authority_subject_missing", attribution: "authority", outputRefs: [], verificationLevel: "observed" };
    }
    const { getByIdForRuntime } = await import("../memory/vnext-source-queue");
    const row = await getByIdForRuntime(input.queueId, principal);
    if (!row || row.sourceVersion !== input.sourceVersion || row.runtimeRunId !== context.fence.runId) {
      return { kind: "complete", outcome: "cancelled", reasonCode: "source_version_superseded", attribution: "producer", outputRefs: [], verificationLevel: "verified" };
    }
    try {
      const { processRuntimeMemorySource } = await import("../memory/vnext-source-poller");
      const result = await processRuntimeMemorySource(
        row,
        context.fence.runId,
        principal,
        context.effectIdempotencyKey("apply-observation"),
      );
      await context.appendEvidence({
        eventType: "mutation",
        reasonCode: "memory_observation_applied",
        payload: {
          queueId: row.id,
          sourceVersion: row.sourceVersion,
          created: result.created,
          reinforced: result.reinforced,
          skipped: result.skipped,
          contentHash: result.contentHash,
        },
      });
      await context.appendEvidence({
        eventType: "verification",
        reasonCode: "memory_source_completed",
        payload: { queueId: row.id, sourceVersion: row.sourceVersion },
      });
      return { kind: "complete", outcome: "succeeded", reasonCode: "memory_source_processed", attribution: "handler", outputRefs: [], verificationLevel: "verified" };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "source_version_superseded") {
        return { kind: "complete", outcome: "cancelled", reasonCode: "source_version_superseded", attribution: "producer", outputRefs: [], verificationLevel: "verified" };
      }
      throw error;
    }
  },
};

runtimeHandlerRegistry.register(skillExecuteHandler);
runtimeHandlerRegistry.register(memorySourceHandler);
