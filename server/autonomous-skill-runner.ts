import { chatFileStorage } from "./chat-file-storage";
import type { FileSession } from "./chat-file-storage";
import { storage } from "./storage";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import { contextBuilder } from "./context-builder";
import { getSkillProcess } from "./skill-seed";
import { getToolSchemas as getToolDefinitions, type ToolSchema as AgentToolDefinition } from "./tool-registry";
import { executeTool, executeBridgeTool } from "./bridge-tools";
import { agentExecutor, formatAbortDetails, type ExecutorRunResult } from "./agent-executor";
import { generateToolCallId } from "./file-storage/utils";
import { createInactivityTimer, raceAbort } from "./timeout";
import { ACTIVITY_THINKING, ACTIVITY_WORK, ACTIVITY_STRATEGY, ACTIVITY_MEMORY, ACTIVITY_FRAMING, BUILTIN_ACTIVITY_IDS, resolveActivityId, type ActivityId } from "./job-profiles";
import type { AdmissionTier } from "./run-admission";

import { getSideEffectTier, type SideEffectTier } from "./autonomy-tiers";
import { resolveCurrentProfileIdentity } from "./profile-identity";
import { getCurrentPrincipal } from "./principal-context";
import type { TrustedEngineeringDelegation } from "./agent-authority";
import { filterModToolSchemas, requireModSkillAccess } from "./mods/mod-access";
import { buildStructuralRunEvidence, evaluateStructuralItem } from "./skill-scoring";
import { resolveSkillRunName } from "./skill-identities";
import { BUILTIN_SKILL_DEFAULTS, type SkillDefault } from "./skill-defaults";
import type { ChecklistItem } from "@shared/schema";
import type { ChildMissionTerminalOutcome, SystemNotice } from "@shared/models/chat";

const logger = createLogger("AutonomousSkillRunner");
const lifecycleLog = createLogger("AutonomousLifecycle");

// Autonomous Skill entry points must inherit or restore one exact user owner
// before calling this module. Missing principal context fails closed below;
// Skill execution never guesses an account or falls back to system authority.
const treeLog = createLogger("SessionTree");
const councilLog = createLogger("Council");
const xMsgLog = createLogger("CrossSessionMsg");

export const sessionTreeLogger = treeLog;
export const councilLogger = councilLog;
export const crossSessionMsgLogger = xMsgLog;

async function conversationExists(sessionId: string): Promise<boolean> {
  const conv = await chatFileStorage.getSession(sessionId);
  return conv !== undefined;
}

/**
 * One attention state for autonomous runs: transcript system_notice widget +
 * session errorSeverity. Severity-only writes leave Inbox lit with an empty
 * opened session.
 */
async function recordAutonomousAttention(
  sessionId: string,
  severity: "warning" | "error",
  params: {
    errorType: string;
    description: string;
    actionHint: string;
    artifactKey?: string;
    terminationReason?: string;
    degradationReason?: string;
  },
): Promise<void> {
  const notice: SystemNotice = {
    severity,
    errorType: params.errorType,
    description: params.description,
    actionHint: params.actionHint,
    ...(params.terminationReason ? { terminationReason: params.terminationReason } : {}),
    ...(params.degradationReason
      ? { degradationReason: params.degradationReason as SystemNotice["degradationReason"] }
      : {}),
  };
  await chatFileStorage.recordSessionAttention(sessionId, notice, {
    artifactKey: params.artifactKey,
  });
}

/**
 * Pure empty_response means the model ended with no final text after work was
 * already preserved. That is a truthful degraded discriminant for transcript /
 * skill_run telemetry, not a user-facing "Processing stopped" page. Output-limit,
 * budget exhaustion, recovered tool failure, and structural misses still page.
 */
function shouldPageAutonomousDegradation(
  degradationReason: string | undefined,
): boolean {
  return degradationReason !== "empty_response";
}

function describeExecutorFailure(result: ExecutorRunResult): string {
  const abortSummary = formatAbortDetails(result.abortDetails);
  if (abortSummary) return `Skill run stopped by executor guard:\n\n${abortSummary}`;

  const durationMs = result.durationMs ?? 0;
  const duration = durationMs > 0 ? `${(durationMs / 60000).toFixed(1)}m` : "unknown duration";
  const toolCallCount = result.toolCalls?.length ?? 0;

  if (result.abortReason === "idle_timeout" || result.abortReason === "stream_idle_timeout" || result.abortReason === "pipeline_timeout" || result.abortReason === "zombie_timeout" || result.abortReason === "run_time_limit") {
    const guardLabel = result.abortReason === "run_time_limit"
      ? "execution hard-cap watchdog"
      : result.abortReason === "pipeline_timeout"
        ? "skill inactivity watchdog"
        : result.abortReason === "zombie_timeout"
          ? "executor zombie watchdog"
          : result.abortReason === "stream_idle_timeout"
            ? "model stream watchdog"
            : "idle-timeout watchdog";
    return [
      `Skill run stopped by ${guardLabel}.`,
      "This was not user-cancelled.",
      `Canonical reason: ${result.abortReason}.`,
      `Duration: ${duration}.`,
      `Work before stop: ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}.`,
      "Recovery: the plan executor may retry this step automatically. If it does not, resume the plan step.",
    ].join("\n\n");
  }

  if (result.abortReason === "cancelled") {
    return [
      "Skill run was cancelled by an upstream controller.",
      "This usually means a parent plan, stop action, superseding retry, or shutdown aborted the child run.",
      `Work before cancellation: ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}.`,
    ].join("\n\n");
  }

  if (result.abortReason === "circuit_breaker") {
    return [
      "Skill run stopped after repeated tool failure.",
      "Reason: the executor detected the same failing tool pattern repeating and stopped to avoid a loop.",
      `Work before stop: ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}.`,
      result.error ? `Cause: ${result.error}` : "Cause: repeated tool failure.",
    ].join("\n\n");
  }

  const errorMsg = [result.error, result.abortReason, result.terminationReason]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(": ") || "Unknown error";
  return `Skill run encountered an error: ${errorMsg}`;
}

/**
 * After toolCalls are durable (or persistence was skipped), release the
 * settling gate and apply any session.end / set_status that was deferred
 * while the run was still busy. Canonical write site for that deferred status.
 * @returns true if a deferred end was applied now OR earlier for this session
 *          (outer finalizers must not overwrite status in either case).
 */
async function applyPendingSessionEndAfterTools(sessionId: string): Promise<boolean> {
  const alreadyApplied = agentExecutor.hasDeferredOrAppliedSessionEnd(sessionId) &&
    !agentExecutor.peekPendingSessionEnd(sessionId);
  const pending = agentExecutor.takePendingSessionEnd(sessionId);
  agentExecutor.endSessionSettling(sessionId);
  if (!pending) {
    return alreadyApplied || agentExecutor.hasDeferredOrAppliedSessionEnd(sessionId);
  }

  if (pending.status === "failed") {
    await recordAutonomousAttention(sessionId, "error", {
      errorType: "something_went_wrong",
      description: pending.summary?.trim()
        ? `Session ended failed: ${pending.summary.trim()}`
        : "This autonomous run ended failed after deferred session status was applied.",
      actionHint: "Open the session, review the transcript, and retry or continue if needed.",
      artifactKey: `autonomous-attention:deferred-failed:${sessionId}`,
      terminationReason: "deferred_session_end_failed",
    }).catch(() => undefined);
  }
  await chatFileStorage
    .updateSessionStatus(sessionId, pending.status, pending.summary)
    .catch((e: unknown) => {
      logger.error(
        `[SkillChat] [${sessionId}] Failed to apply deferred session status ${pending.status}: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  await chatFileStorage.setSessionPinned(sessionId, false).catch(() => undefined);
  agentExecutor.markAppliedSessionEnd(sessionId, pending);
  return true;
}

async function persistExecutorResult(
  sessionId: string,
  result: ExecutorRunResult,
  fallbackContent: string,
  isError?: boolean,
  deferSettlementRelease = false,
): Promise<void> {
  try {
  if (!await conversationExists(sessionId)) {
    logger.warn(`[SkillChat] [${sessionId}] Session deleted mid-run — skipping persistExecutorResult`);
    return;
  }

  const content = result.content?.trim() || fallbackContent;
  const thinking = result.thinking || undefined;
  const model = result.model || undefined;

  let toolCalls: Array<{
    toolName: string;
    toolCallId: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    error?: string | Record<string, unknown>;
    failureKind?: import("@shared/tool-failure").ToolFailureKind;
    failureCode?: string;
    status: string;
    outcome: import("./agent-executor").ToolOutcome;
  }> | undefined;

  if (result.toolCalls && result.toolCalls.length > 0) {
    toolCalls = result.toolCalls.map((tc, i) => ({
      toolName: tc.name,
      toolCallId: tc.id || `tc-${sessionId.slice(0, 8)}-${i}`,
      arguments: tc.args,
      result: tc.result,
      error: tc.error && typeof tc.error !== "boolean" ? String(tc.error) : undefined,
      ...(tc.failureKind ? { failureKind: tc.failureKind } : {}),
      ...(tc.failureCode ? { failureCode: tc.failureCode } : {}),
      status: tc.error ? "error" : "done",
      outcome: tc.outcome,
    }));
  }

  await chatFileStorage.createMessage(
    sessionId,
    "assistant",
    content,
    thinking,
    toolCalls,
    model,
    result.systemSteps || undefined,
    result.cost || undefined,
    result.apiCallCount || undefined,
    result.segmentChronology || undefined,
    isError,
  );
  logger.log(`[SkillChat] [${sessionId}] Persisted executor result: contentLen=${content.length} thinking=${!!thinking} toolCalls=${toolCalls?.length ?? 0} model=${model || "unknown"} systemSteps=${result.systemSteps?.length ?? 0} chronology=${result.segmentChronology?.length ?? 0}`);
  } finally {
    // Tools are durable (or intentionally skipped). Ordinary autonomous runs
    // can now release settling and apply session.end. Plan children retain the
    // same fence until their source-owned mission outcome is durable, so the
    // parent monitor cannot observe saved without the terminal discriminant.
    if (!deferSettlementRelease) {
      await applyPendingSessionEndAfterTools(sessionId);
    }
  }
}

type ToolCallLog = Array<{ name: string; action?: string; error?: boolean; result?: string }>;

export interface SkillRunConfig {
  skillId: string;
  label: string;
  callType: "full" | "world" | "internal";
  includeSections?: string[];
  excludeSections?: string[];
  activity: ActivityId;
  temperature: number;
  timeoutMs: number;
  sessionType?: "autonomous" | "agent";
  admissionTier?: AdmissionTier;
  /** When true, autonomous runs may mint a visible conversation. Inspect skills stay silent. */
  mayInitiateConversation?: boolean;
}


function parseEstimatedDurationMs(duration: string | null | undefined): number | null {
  if (!duration) return null;
  const match = duration.match(/^(\d+)\s*(min|m|hr|h|hour|sec|s)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "min" || unit === "m") return value * 60 * 1000;
  if (unit === "hr" || unit === "h" || unit === "hour") return value * 60 * 60 * 1000;
  if (unit === "sec" || unit === "s") return value * 1000;
  return null;
}

export interface AutonomousRunResult {
  sessionId: string;
  status: "succeeded" | "degraded" | "failed" | "yielded";
  summary?: string;
  error?: string;
  /** Executor degradation discriminant; pure empty_response must not page attention. */
  degradationReason?: string;
  /** Source-owned Plan child terminal truth, preserved from AgentExecutor when applicable. */
  childMissionOutcome?: ChildMissionTerminalOutcome;
  /** Failed deterministic checklist requirements (present when status === "degraded"). */
  failedStructuralChecks?: string[];
  /** @deprecated Compatibility projection for callers expecting the old tool-only field. */
  failedToolChecks?: string[];
  durationMs: number;
}

const activeSkillRuns = new Set<string>();

/**
 * Terminal-time evaluation of the skill checklist's deterministic items
 * (kind "tool_invoked"), using the same shared evaluator the scorer uses —
 * one specification (the checklist), one evaluator, two invocation points.
 * Returns stable labels for failed structural checks. Fails closed on evidence
 * read errors so missing lineage or persisted tool evidence can never produce
 * a false green; async scoring later re-evaluates the identical contract.
 */
async function findFailedStructuralChecks(sessionId: string, skillName: string): Promise<string[]> {
  try {
    const skill = await storage.getSkillByName(skillName);
    const checklist = Array.isArray(skill?.checklist) ? (skill.checklist as ChecklistItem[]) : [];
    if (!checklist.some((c) => c?.kind === "tool_invoked" || c?.kind === "child_skill_invoked")) return [];
    const messages = await chatFileStorage.getMessagesBySession(sessionId);
    const evidence = await buildStructuralRunEvidence(sessionId, messages);
    const failed: string[] = [];
    for (const item of checklist) {
      const result = evaluateStructuralItem(item, evidence);
      if (!result || result.passed) continue;
      if (item.kind === "tool_invoked" && typeof item.tool === "string") {
        failed.push(`tool:${item.tool}${typeof item.action === "string" ? `:${item.action}` : ""}`);
      } else if (item.kind === "child_skill_invoked" && typeof item.skill === "string") {
        failed.push(`child_skill:${item.skill}`);
      }
    }
    return failed;
  } catch (err) {
    logger.error(`[SkillChat] [${sessionId}] Structural checklist evaluation failed closed: ${err instanceof Error ? err.message : String(err)}`);
    return ["structural_evaluation_unavailable"];
  }
}

function getSkillRunKey(skillId: string, intentionId?: string): string {
  const principal = getCurrentPrincipal();
  if (!principal?.userId || !principal.accountId) {
    throw new Error("Skill run coordination requires an explicit user principal");
  }
  return `${principal.accountId}:${principal.userId}:${intentionId || skillId}`;
}

export function isDuplicateSkillRun(skillId: string, intentionId?: string): boolean {
  return activeSkillRuns.has(getSkillRunKey(skillId, intentionId));
}

/**
 * Atomic claim of the per-skill single-flight lock. Returns true if the caller
 * acquired the lock, false if another caller already holds it. Callers MUST
 * pair every successful claim with releaseSkillRun() in a finally block.
 *
 * This exists so non-skill-runner entry points (manual API routes, programmatic
 * callers) can share the SAME dedupe set used by executeAutonomousSkillRun,
 * preventing manual + timer-triggered runs from racing.
 */
export function tryClaimSkillRun(skillId: string, intentionId?: string): boolean {
  const key = getSkillRunKey(skillId, intentionId);
  if (activeSkillRuns.has(key)) return false;
  activeSkillRuns.add(key);
  return true;
}

export function releaseSkillRun(skillId: string, intentionId?: string): void {
  activeSkillRuns.delete(getSkillRunKey(skillId, intentionId));
}

function findBuiltinSkillDefault(skillName: string): SkillDefault | undefined {
  const canonical = resolveSkillRunName(skillName);
  return BUILTIN_SKILL_DEFAULTS.find(
    (row) =>
      row.name === skillName
      || row.name === canonical
      || resolveSkillRunName(row.name) === canonical,
  );
}

function skillDefaultRunConfig(skillName: string): SkillRunConfig | undefined {
  const def = findBuiltinSkillDefault(skillName);
  if (!def?.callType || def.timeoutMs === undefined) return undefined;
  const resolvedActivity = resolveActivityId(def.activity || "");
  const activity: ActivityId = BUILTIN_ACTIVITY_IDS.includes(resolvedActivity)
    ? resolvedActivity
    : ACTIVITY_WORK;
  return {
    skillId: def.name,
    label: def.name,
    callType: def.callType,
    includeSections: def.includeSections,
    activity,
    temperature: def.temperature ?? 0.5,
    timeoutMs: def.timeoutMs,
    sessionType: def.sessionType,
    admissionTier: def.admissionTier,
    mayInitiateConversation: def.mayInitiateConversation,
  };
}

function skillMayInitiateConversation(skillName?: string): boolean {
  if (!skillName) return false;
  const canonical = resolveSkillRunName(skillName);
  return BUILTIN_SKILL_DEFAULTS.some(
    (def) =>
      def.mayInitiateConversation === true
      && (def.name === skillName || def.name === canonical || resolveSkillRunName(def.name) === canonical),
  );
}

async function getSkillTools(
  activity: ActivityId,
  sessionKey: string,
  sessionId: string,
  authoritySkillId?: string,
  authoritySkillName?: string,
  trustedDelegation?: import("./agent-authority").TrustedEngineeringDelegation,
  runtimeFence?: { runId: string; attemptId: string },
): Promise<{
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<import("./agent-executor").ToolExecutorResult>;
}> {
  const { filterToolSchemasForAuthority } = require("./agent-authority") as typeof import("./agent-authority");
  const authority = {
    origin: "autonomous" as const,
    trustedDelegation,
    activity,
    skillId: authoritySkillId,
    skillName: authoritySkillId ? authoritySkillName : undefined,
    mayInitiateConversation: skillMayInitiateConversation(authoritySkillName),
    runtimeRunId: runtimeFence?.runId,
    runtimeAttemptId: runtimeFence?.attemptId,
    sessionKey,
    sessionId,
  };
  const principal = getCurrentPrincipal();
  if (!principal) throw new Error("Skill tool discovery requires an explicit user principal");
  const authorityToolDefs = filterToolSchemasForAuthority(getToolDefinitions(), authority);
  const allToolDefs = await filterModToolSchemas(principal, authorityToolDefs);
  const tools = allToolDefs.map((t: AgentToolDefinition) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const toolExecutor = async (name: string, args: Record<string, unknown>) => {
    const toolCallId = generateToolCallId("auto-tc");
    const result = await executeTool(name, toolCallId, args, {
      sessionKey,
      sessionId,
      authority,
    });
    return { result: result.result, error: result.error, failure: result.failure, sideEffectOnly: result.sideEffectOnly, continuation: result.continuation };
  };

  return { tools, toolExecutor };
}

export async function executeAutonomousSkillRun(
  skillId: string | undefined | null,
  options: {
    preContext?: string;
    parentSessionId?: string;
    spawnReason?: string;
    spawnerTool?: string;
    spawnerSkillRun?: string;
    parentToolCallId?: string;
    onSessionCreated?: (sessionId: string) => void | Promise<void>;
    /**
     * Optional explicit model identifier (e.g. "anthropic/claude-opus-4-6").
     * When set, the agent executor pins to this model instead of routing by
     * activity. Used by Council to fan one skill into per-provider runs.
     */
    modelOverride?: string;
    /**
     * Optional override for the per-call sessionKey written to api_calls.
     * Defaults to `auto:${skillId}` (shared across all runs of that skill).
     * Council uses this to scope cumulative usage per council run by setting
     * a unique key like `council:${runId}` on every spawned advocate, so
     * `WHERE session_key = $1` reliably aggregates the run's child spend.
     */
    sessionKeyOverride?: string;
    /**
     * Optional override for the human-readable session title used by
     * `createAutonomousSession` and the initial `saveSession`. When set,
     * the runner uses this in place of `config.label` so callers (e.g.
     * Council spawning per-round advocates) can encode round/role context
     * into the sidebar title (e.g. "Advocate A — Round 2").
     */
    titleOverride?: string;
    /** Explicit persona applied before context assembly and first inference. */
    personaName?: "Engineer" | "Architect";
    /** Admission priority inherited from the root session that initiated this run. */
    admissionTier?: AdmissionTier;
    /** Stable root session identity shared by this run and all descendants. */
    lineageId?: string;
    /** Durable plan ownership metadata for plan child attempts. */
    planId?: string;
    stepId?: string;
    attemptId?: number;
    attemptNumber?: number;
    planPageRef?: string;
    workflowRunId?: string;
    workflowStageAttemptId?: number;
    /** Optional per-instance single-flight key for Skills that support concurrent durable runs. */
    coordinationKey?: string;
    /** Native Runtime attempt that already owns capacity for this Skill execution. */
    runtimeFence?: { runId: string; attemptId: string };
    /** Runtime-owned cancellation signal for a native fenced execution. */
    signal?: AbortSignal;
  } = {}
): Promise<AutonomousRunResult | null> {
  // ── Ensure user principal context ───────────────────────────────────
  // If no principal is in AsyncLocalStorage (e.g. called from timers,
  // hooks, email enrichment, or other fire-and-forget paths), resolve
  // the user principal and wrap the entire execution.  Callers that
  // already have a principal (e.g. HTTP routes via auth middleware,
  // child sessions inheriting parent context) pass through unchanged.
  if (!getCurrentPrincipal()) {
    throw new Error("Autonomous Skill execution requires an explicit owning principal");
  }

  // ── Skillless execution path ────────────────────────────────────────
  // When no skillId is provided but preContext exists, run the session
  // using preContext as the full instruction set. No skill DB lookup,
  // no SkillDefault entry needed. Used by the plan executor to
  // run plan steps without a dedicated skill.
  const isSkillless = !skillId;
  if (isSkillless && !options.preContext) {
    throw new Error("executeAutonomousSkillRun: either skillId or preContext is required");
  }

  let config: SkillRunConfig;
  if (isSkillless) {
    const label = options.titleOverride || "Skillless Session";
    config = {
      skillId: "",
      label,
      callType: "full",
      activity: ACTIVITY_WORK,
      temperature: 0.3,
      timeoutMs: 15 * 60 * 1000,
      sessionType: "agent",
    };
    logger.log(`[skillless] Using inline config — label="${label}" timeoutMs=${config.timeoutMs}`);
  } else {
    // Instance first: stamped SkillDefault, then DB dynamic fallback for
    // user-created skills.
    const requestedId = skillId;
    const canonicalName = resolveSkillRunName(requestedId);
    config = skillDefaultRunConfig(canonicalName)
      ?? skillDefaultRunConfig(requestedId)!;
    if (!config) {
      try {
        let dbSkill = await storage.getSkillByName(requestedId);
        if (!dbSkill && canonicalName !== requestedId) {
          dbSkill = await storage.getSkillByName(canonicalName);
        }
        if (!dbSkill) dbSkill = await storage.getSkill(requestedId);
        if (!dbSkill) {
          throw new Error(`No skill run config and no database record found for "${requestedId}"`, { cause: new Error("skill-not-found") });
        }
        if (dbSkill.status === "deprecated") {
          throw new Error(`Skill "${dbSkill.name}" is deprecated and cannot be run`, { cause: new Error("skill-deprecated") });
        }

        const resolvedName = resolveSkillRunName(dbSkill.name);
        const instanceByName = skillDefaultRunConfig(resolvedName) ?? skillDefaultRunConfig(dbSkill.name);
        if (instanceByName) {
          config = instanceByName;
          logger.log(`[skill:${requestedId}] Resolved UUID to SkillDefault config via db name="${dbSkill.name}" — timeout=${config.timeoutMs}ms`);
        } else {
          const resolvedActivity = resolveActivityId(dbSkill.activity || "");
          const activity: ActivityId = BUILTIN_ACTIVITY_IDS.includes(resolvedActivity) ? resolvedActivity : ACTIVITY_WORK;
          const DYNAMIC_FALLBACK_MIN_TIMEOUT_MS = 10 * 60 * 1000;
          const dbTimeoutMs = parseEstimatedDurationMs(dbSkill.estimatedDuration);
          const timeoutMs = Math.max(dbTimeoutMs ?? DYNAMIC_FALLBACK_MIN_TIMEOUT_MS, DYNAMIC_FALLBACK_MIN_TIMEOUT_MS);
          config = {
            skillId: dbSkill.name,
            label: dbSkill.name,
            callType: "full",
            activity,
            temperature: 0.5,
            timeoutMs,
            // No sessionType here — let the top-level default handle it
            // (autonomous for top-level runs, agent for child runs)
          };
          logger.log(`[skill:${requestedId}] Built dynamic config from database — label="${config.label}" activity=${activity} timeoutMs=${config.timeoutMs}${dbTimeoutMs ? " (from estimatedDuration)" : " (default)"}`);
        }
      } catch (err: unknown) {
        const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
        const resolveError = new Error(
          `phase=config-resolve FAILED for skill "${requestedId}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ) as Error & { code?: string };
        // Stable machine code so aggregates keep skill+phase identity without
        // tokenizing free-form messages (e.g. SKILL_CURATE_PHASE_CONFIG).
        resolveError.code = "SKILL_CONFIG_RESOLVE_FAILED";
        logger.error(
          `[skill:${requestedId}] phase=config-resolve FAILED — could not build dynamic config: ${errDetail}`,
          { error: resolveError, errorCode: resolveError.code, skillId: requestedId, phase: "config-resolve" },
        );
        throw resolveError;
      }
    } else if (canonicalName !== requestedId) {
      logger.log(`[skill:${requestedId}] Resolved alias to SkillDefault config "${canonicalName}" — timeout=${config.timeoutMs}ms`);
    }
  } // end skill-based config resolution

  if (!isSkillless) {
    const principal = getCurrentPrincipal();
    if (!principal) throw new Error(`Skill ${config.skillId} requires an explicit user principal`);
    await requireModSkillAccess(principal, config.skillId);
  }

  // Global per-skill dedupe is for top-level autoruns (e.g. cron-triggered
  // skills that should never overlap themselves). Parented child spawns
  // (e.g. Council fanning two `advocate` runs in parallel) are
  // already deduped at the spawn-tree level by the advisory lock + the
  // (parent, reason, skillRun) unique tuple in `session_tree`. Bypassing
  // this gate when a `parentSessionId` is present is required for
  // legitimate parallel fan-out.
  const coordinationKey = options.coordinationKey || skillId || "skillless";
  if (!options.runtimeFence && !isSkillless && !options.parentSessionId && isDuplicateSkillRun(coordinationKey)) {
    logger.log(`[skill:${skillId}] Coordination key ${coordinationKey} already running — skipping`);
    return null;
  }


  // Track whether *this* invocation registered the active-run marker so the
  // cleanup paths only delete it when we own it. Without this guard, a
  // parented child spawn could clear the marker that a concurrent top-level
  // run of the same skill is relying on for dedupe.
  let didRegisterActiveRun = false;
  if (!options.runtimeFence && !isSkillless && !options.parentSessionId) {
    activeSkillRuns.add(getSkillRunKey(coordinationKey));
    didRegisterActiveRun = true;
  }
  const startTime = Date.now();

  let addToMemory = true;
  let resolvedSessionType: "autonomous" | "agent" | null = null;
  let authoritySkillId: string | undefined;
  let resolvedPersona: import("./skill-persona-service").SkillPersonaResolution | null = null;
  if (!isSkillless) {
    logger.log(`[SkillChat] phase=skill-lookup — resolving skill record for "${skillId}" (config.skillId="${config.skillId}")`);
    try {
      let skillRecord = await storage.getSkillByName(config.skillId);
      if (!skillRecord && skillId !== config.skillId) skillRecord = await storage.getSkillByName(skillId!);
      if (!skillRecord) skillRecord = await storage.getSkill(skillId!);
      if (skillRecord) {
        authoritySkillId = skillRecord.id;
        if (skillRecord.addToMemory === false) {
          addToMemory = false;
        }
        if (skillRecord.sessionType === "autonomous" || skillRecord.sessionType === "agent") {
          resolvedSessionType = skillRecord.sessionType;
        }
        const rowTimeoutMs = parseEstimatedDurationMs(skillRecord.estimatedDuration);
        if (rowTimeoutMs && rowTimeoutMs > config.timeoutMs) {
          config = { ...config, timeoutMs: rowTimeoutMs };
        }
        try {
          const { resolveSkillRunPersona } = await import("./skill-persona-service");
          resolvedPersona = await resolveSkillRunPersona(skillRecord);
        } catch (personaResolveErr: unknown) {
          logger.warn(`[SkillChat] persona resolution failed for "${skillId}": ${personaResolveErr instanceof Error ? personaResolveErr.message : String(personaResolveErr)}`);
        }
      }
    } catch (e: unknown) {
      logger.error(`[SkillChat] phase=skill-lookup FAILED for "${skillId}": ${e instanceof Error ? (e.stack || e.message) : String(e)}`);
    }
  } else {
    logger.log(`[SkillChat] phase=skill-lookup — skipped (skillless execution)`);
  }

  // Pre-flight admission check: if this is a background-tier run and no
  // background slot is available, log clearly and skip the run rather than
  // creating a session, assembling context, and queueing for admission
  // only to be killed by the inactivity timer. The next scheduled trigger
  // will retry with a fresh start.
  if (!options.runtimeFence && !options.parentSessionId && !isSkillless && (config.admissionTier ?? "background") === "background") {
    try {
      const { admissionController } = await import("./run-admission");
      const activity = config.activity;
      const snapshot = admissionController.getAdmissionSnapshot();
      if (!admissionController.canAdmitBackground({ activity })) {
        logger.log(
          `[SkillChat] [${config.label}] Pre-flight: admission_deferred ` +
          `(snapshot: ${JSON.stringify(snapshot)}) — deferring skill run`
        );
        releaseSkillRun(coordinationKey);
        return null;
      }
    } catch (admCheckErr: unknown) {
      // Non-fatal: if the pre-flight check fails, proceed normally.
      logger.debug(`[SkillChat] Pre-flight admission check failed: ${admCheckErr instanceof Error ? admCheckErr.message : String(admCheckErr)}`);
    }
  }

  const { personaStorage } = await import("./file-storage/persona-storage");
  const explicitRunPersona = options.personaName
    ? await personaStorage.getByName(options.personaName)
    : null;
  if (options.personaName && !explicitRunPersona) {
    throw new Error(`Explicit run persona "${options.personaName}" is not visible to the current principal`);
  }
  const recommendedRunPersona = !explicitRunPersona && resolvedPersona
    ? await personaStorage.get(resolvedPersona.personaId)
    : null;
  if (resolvedPersona && !recommendedRunPersona) {
    logger.warn(`[SkillChat] Recommended persona ${resolvedPersona.personaId} (source=${resolvedPersona.source}) not found — creating the run without a persona`);
  }
  const initialRunPersona = explicitRunPersona ?? recommendedRunPersona;
  const initialPersonaSource = explicitRunPersona ? "explicit_run" : resolvedPersona?.source;

  let conversation: FileSession;
  let reusedRuntimeSession = false;
  // Top-level runs (hooks, timers, skills.run) default to "autonomous" so they
  // show in the SYSTEM category, not RECENT alongside user conversations.
  // Child runs (plan steps) keep "agent" since they're part of user-facing work.
  const defaultType = options.parentSessionId ? "agent" : "autonomous";
  const sessType = resolvedSessionType ?? config.sessionType ?? defaultType;
  // Defensive fallback: if a parent session is set but the caller didn't
  // provide a spawnerSkillRun, derive a stable one so this child still
  // participates in tuple idempotency under (parent, reason, skillRun).
  const effectiveSpawnerSkillRun = options.parentSessionId
    ? options.spawnerSkillRun ?? (isSkillless ? `skillless:${options.parentSessionId}` : `skill:${options.parentSessionId}:${skillId}`)
    : options.spawnerSkillRun;
  const effectiveSpawnReason = options.parentSessionId
    ? options.spawnReason ?? (isSkillless ? "skillless" : `skill:${skillId}`)
    : options.spawnReason;
  // Default spawnerTool so every parented child carries a non-null tool
  // attribution (e.g. "autonomous-skill-runner") even when the caller
  // forgot to supply one.
  const effectiveSpawnerTool = options.parentSessionId
    ? options.spawnerTool ?? "autonomous-skill-runner"
    : options.spawnerTool;
  const effectiveTitle = options.titleOverride ?? config.label;
  try {
    logger.log(`[SkillChat] phase=session-create — creating session for ${isSkillless ? "skillless" : `skill "${skillId}"`} title="${effectiveTitle}" type=${sessType} addToMemory=${addToMemory}${options.titleOverride ? ` (titleOverride applied)` : ""}`);
    const provenance = {
      triggerType: (options as any).hookTriggerId ? "hook" as const : "skill" as const,
      triggerId: (options as any).hookTriggerId || skillId || undefined,
      triggerName: (options as any).hookTriggerName || config.label,
    };
    if (options.runtimeFence && !options.parentSessionId) {
      const created = await chatFileStorage.createSessionOnce(
        effectiveTitle,
        `runtime:${options.runtimeFence.runId}`,
        undefined,
        {
          sessionType: sessType,
          personaId: initialRunPersona?.id,
          provenance,
        },
      );
      conversation = created.session;
      reusedRuntimeSession = created.outcome === "existing";
    } else {
      conversation = await chatFileStorage.createAutonomousSession(
        effectiveTitle,
        sessType,
        isSkillless ? `auto:skillless` : `auto:${skillId}`,
        undefined,
        undefined,
        options.parentSessionId
          ? {
              personaId: initialRunPersona?.id,
              parentSessionId: options.parentSessionId,
              spawnReason: effectiveSpawnReason,
              spawnerTool: effectiveSpawnerTool,
              spawnerSkillRun: effectiveSpawnerSkillRun,
              ...provenance,
            }
          : {
              personaId: initialRunPersona?.id,
              ...provenance,
            },
      );
    }
  } catch (err: unknown) {
    if (didRegisterActiveRun && skillId) activeSkillRuns.delete(getSkillRunKey(coordinationKey));
    const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
    logger.error(`[SkillChat] phase=session-create FAILED for skill "${config.label}": ${errDetail}`);
    throw new Error(`phase=session-create FAILED for skill "${config.label}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const sessionId = conversation.id;
  lifecycleLog.debug(
    `phase=created sessionId=${sessionId} parentSessionId=${options.parentSessionId ?? "none"} ` +
    `skillId=${skillId ?? "skillless"} activity=${config.activity} sessionType=${sessType} ` +
    `spawnReason=${effectiveSpawnReason ?? "none"}`,
  );
  logger.log(`[SkillChat] phase=pipeline-start — session created: ${sessionId} — starting skill "${config.label}"`);

  if (!isSkillless) {
    try {
      // parentSessionId + parentToolCallId are audit lineage for any spawner
      // (interactive chat or skill composition). parentSkillRunId is only set
      // when the parent session is itself a SkillRun — that is the sole
      // discriminant for true skill→skill composition / child_skill_invoked.
      // Interactive skills.run from chat has a parent session/tool-call but no
      // parent skill_runs row; keep the session/tool lineage and leave
      // parentSkillRunId null instead of failing closed.
      let parentSkillRunId: number | undefined;
      if (options.parentSessionId && options.parentToolCallId) {
        const parentRun = await storage.getSkillRunBySessionId(options.parentSessionId);
        if (parentRun) {
          parentSkillRunId = parentRun.id;
        } else {
          logger.log(
            `[SkillChat] [${sessionId}] Non-skill parent session ${options.parentSessionId} — ` +
              `launching without parentSkillRunId (interactive or non-skill spawner)`,
          );
        }
      }
      const persistedSkillRun = await storage.insertSkillRun({
        skillName: config.skillId,
        sessionId,
        parentSessionId: options.parentSessionId,
        parentSkillRunId,
        parentToolCallId: options.parentToolCallId,
        runtimeRunId: options.runtimeFence?.runId,
      });
      if (reusedRuntimeSession && persistedSkillRun.status !== "running" && persistedSkillRun.status !== "checkpoint") {
        return {
          sessionId,
          status: persistedSkillRun.status === "degraded" ? "degraded" : persistedSkillRun.status === "succeeded" ? "succeeded" : "failed",
          error: persistedSkillRun.failureReason ?? undefined,
          durationMs: persistedSkillRun.durationMs ?? 0,
        };
      }
      logger.log(`[SkillChat] [${sessionId}] Inserted skill_runs row for "${config.skillId}"${parentSkillRunId ? ` parentSkillRunId=${parentSkillRunId}` : ""}`);
    } catch (runInsertErr: unknown) {
      const message = runInsertErr instanceof Error ? runInsertErr.message : String(runInsertErr);
      logger.error(`[SkillChat] [${sessionId}] Failed to insert skill_runs row: ${message}`);
      await chatFileStorage.setEndReason(sessionId, "skill_run_lineage_persistence_failed").catch(() => undefined);
      await recordAutonomousAttention(sessionId, "error", {
        errorType: "something_went_wrong",
        description: "Failed to persist the skill-run lineage row for this autonomous session.",
        actionHint: "Retry the run. If it keeps failing, inspect skill_runs persistence and database health.",
        artifactKey: `autonomous-attention:skill-run-lineage:${sessionId}`,
        terminationReason: "skill_run_lineage_persistence_failed",
      }).catch(() => undefined);
      await chatFileStorage.updateSessionStatus(sessionId, "failed").catch(() => undefined);
      throw new Error(`SkillRun persistence failed for session ${sessionId}`, { cause: runInsertErr });
    }
  }

  // Persona is part of the creation write so the first session snapshot, child
  // block, context assembly, and model route all observe the same identity.
  if (initialRunPersona) {
    if (conversation.personaId !== initialRunPersona.id) {
      throw new Error(`Session ${sessionId} was created without persona ${initialRunPersona.id}`);
    }
    logger.log(`[SkillChat] [${sessionId}] Created with persona "${initialRunPersona.name}" (id=${initialRunPersona.id}, source=${initialPersonaSource})`);
  }

  if (options.onSessionCreated) {
    await options.onSessionCreated(sessionId);
  }

  if (options.parentSessionId) {
    treeLog.log(`spawn-request skill=${skillId} run=${sessionId} parent=${options.parentSessionId}`);
    await chatFileStorage.setParentSessionId(sessionId, options.parentSessionId, {
      spawnReason: effectiveSpawnReason,
      spawnerTool: effectiveSpawnerTool,
      spawnerSkillRun: effectiveSpawnerSkillRun,
    }).catch((e: unknown) => {
      logger.error(`[SkillChat] [${sessionId}] Failed to set parentSessionId: ${e instanceof Error ? e.message : String(e)}`);
      treeLog.warn(`spawn-failed skill=${skillId} run=${sessionId} parent=${options.parentSessionId} err=${e instanceof Error ? e.message : String(e)}`);
    });

    // Parent-launched skills are child sessions. Emit the same persisted + live
    // block used by session.spawn_child so the parent chat renders an inline
    // session widget instead of relying on a plain-text tool result.
    try {
      const { onChildSessionSpawned } = await import("./sessions/child-block-lifecycle");
      await onChildSessionSpawned(options.parentSessionId, sessionId, {
        spawnReason: effectiveSpawnReason,
        title: effectiveTitle,
        model: options.modelOverride,
        planId: options.planId,
        stepId: options.stepId,
        attemptId: options.attemptId,
        attemptNumber: options.attemptNumber,
        planPageRef: options.planPageRef,
        workflowRunId: options.workflowRunId,
        workflowStageAttemptId: options.workflowStageAttemptId,
      });
    } catch (lcErr: unknown) {
      logger.warn(`[SkillChat] [${sessionId}] Failed to emit child session block: ${lcErr instanceof Error ? lcErr.message : String(lcErr)}`);
    }

    if (skillId === "council" || config.skillId === "council") {
      councilLog.log(`spawn skill=${skillId} run=${sessionId} parent=${options.parentSessionId} timeoutMs=${config.timeoutMs}`);
    }
  }

  await chatFileStorage.updateSessionTitle(sessionId, effectiveTitle, {
    // When a parent provides titleOverride (e.g. "Step 1: ..."), lock the title
    // so the child agent's orient call won't overwrite it.
    source: options.titleOverride ? "manual" : "auto",
  }).catch((e: unknown) => {
    logger.error(`[SkillChat] [${sessionId}] Failed to update conversation title immediately after creation: ${e instanceof Error ? e.message : String(e)}`);
  });

  await chatFileStorage.updateSessionStatus(sessionId, "streaming").catch((e: unknown) => {
    logger.error(`[SkillChat] [${sessionId}] Failed to set early streaming status: ${e instanceof Error ? e.message : String(e)}`);
  });

  const sessionKey = options.sessionKeyOverride ?? `auto:${skillId}`;

  eventBus.publish({
    category: "chat",
    event: "chat.autonomous.started",
    payload: { sessionId, skillId, skillName: config.label, addToMemory, sessionKey },
  });

  // Register with one complete identity tuple before any autonomous stream event.
  const autonomousRunId = options.runtimeFence?.runId ?? `skill-run-${sessionId}`;
  const autonomousTurnId = `skill-turn-${sessionId}`;
  const autonomousAttemptId = `${autonomousRunId}-attempt-1`;
  try {
    const { sessionManager } = await import("./session-manager");
    sessionManager.registerSession(sessionId, sessionKey, "text", {
      runId: autonomousRunId,
      turnId: autonomousTurnId,
      assistantAttemptId: autonomousAttemptId,
    });
    sessionManager.applyEvent(sessionId, {
      type: "run_start",
      runId: autonomousRunId,
      turnId: autonomousTurnId,
      assistantAttemptId: autonomousAttemptId,
    });
  } catch (regErr) {
    logger.debug(`[SkillChat] [${sessionId}] sessionManager.registerSession skipped: ${regErr instanceof Error ? regErr.message : String(regErr)}`);
  }

  try {
    const result = config.skillId === "council"
      ? await runCouncilPipeline(config, sessionId, options)
      : await runSkillPipeline(config, sessionId, options, authoritySkillId);

    if (result.status === "yielded") {
      const error = "Execution yielded under genuine capacity pressure. The parent may retry or resume this child.";
      logger.warn(`[SkillChat] [${sessionId}] ${error}`);
      if (await conversationExists(sessionId)) {
        await chatFileStorage.setEndReason(sessionId, "yield_to_interactive").catch(() => undefined);
        await recordAutonomousAttention(sessionId, "warning", {
          errorType: "processing_stopped",
          description: "Execution yielded under genuine capacity pressure. The parent may retry or resume this child.",
          actionHint: "Retry or resume this child when interactive capacity is available.",
          artifactKey: `autonomous-attention:yielded:${sessionId}`,
          terminationReason: "yield_to_interactive",
        }).catch(() => undefined);
        await chatFileStorage.updateSessionStatus(sessionId, "failed");
      }
      if (!isSkillless) {
        const yieldedRun = await storage.updateSkillRunStatus(sessionId, "yielded", result.durationMs, error).catch((e: unknown) => {
          logger.error(`[SkillChat] [${sessionId}] Failed to update skill_runs status to yielded: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (!yieldedRun) {
          throw new Error(`SkillRun yielded-state persistence failed for session ${sessionId}`);
        }
      }
      if (options.parentSessionId) {
        const { onChildSessionCompleted } = await import("./sessions/child-block-lifecycle");
        const { updateSpawnStatus } = await import("./sessions/tree");
        await onChildSessionCompleted(options.parentSessionId, sessionId, {
          status: "failed",
          error,
          durationMs: result.durationMs,
        }).catch((e: unknown) => logger.warn(`[SkillChat] [${sessionId}] Failed to close yielded child block: ${e instanceof Error ? e.message : String(e)}`));
        await updateSpawnStatus(sessionId, "failed");
      }
      eventBus.publish({
        category: "chat",
        event: "chat.autonomous.yielded",
        payload: { sessionId, skillId, skillName: config.label, durationMs: result.durationMs, reason: "yield_to_interactive", terminal: true },
      });
      return { ...result, error };
    }

    if (await conversationExists(sessionId)) {
      let childMissionOutcome = result.childMissionOutcome;
      if (options.planId && options.stepId) {
        const { getPlanSteps } = await import("./plan-service");
        const terminalStep = (await getPlanSteps(options.planId)).find((step) => step.id === options.stepId);
        if (terminalStep?.status === "blocked" || terminalStep?.status === "needs_review") {
          childMissionOutcome = terminalStep.status;
        }
      }
      if (childMissionOutcome) {
        await chatFileStorage.setChildMissionOutcome(sessionId, childMissionOutcome);
      } else if (options.planId && options.stepId) {
        throw new Error(`Plan child ${sessionId} completed without an executor-owned mission terminal outcome`);
      }
      // Plan children kept AgentExecutor's settling fence closed across tool
      // persistence. Release it only after the terminal discriminant is durable;
      // a deferred session.end may now make the Session saved without racing the
      // parent monitor into a false missing-outcome failure.
      if (options.planId && options.stepId) {
        await applyPendingSessionEndAfterTools(sessionId);
      }
      const finalSessionStatus = result.status === "succeeded" || result.status === "degraded" ? "saved" : "failed";
      if (result.status === "failed") {
        await recordAutonomousAttention(sessionId, "error", {
          errorType: "something_went_wrong",
          description: result.error?.trim()
            ? `This autonomous run failed: ${result.error.trim()}`
            : "This autonomous run failed before producing a clean completion.",
          actionHint: "Open the session transcript, inspect the failure, and retry if needed.",
          artifactKey: `autonomous-attention:failed:${sessionId}`,
          terminationReason: result.error || "failed",
        }).catch((e: unknown) => {
          logger.error(`[SkillChat] [${sessionId}] Failed to record error attention: ${e instanceof Error ? e.message : String(e)}`);
        });
      } else if (
        result.status === "degraded" &&
        shouldPageAutonomousDegradation(result.degradationReason)
      ) {
        await recordAutonomousAttention(sessionId, "warning", {
          errorType: "processing_stopped",
          description: result.error?.trim()
            ? `This autonomous run finished degraded: ${result.error.trim()}`
            : "This autonomous run finished in a degraded state. Completed work was preserved.",
          actionHint: "Review the warning in this session, then continue or retry if the outcome is incomplete.",
          artifactKey: `autonomous-attention:degraded:${sessionId}`,
          terminationReason: result.error || "degraded",
          degradationReason: result.degradationReason,
        }).catch((e: unknown) => {
          logger.error(`[SkillChat] [${sessionId}] Failed to record degraded attention: ${e instanceof Error ? e.message : String(e)}`);
        });
      } else if (
        result.status === "degraded" &&
        result.degradationReason === "empty_response"
      ) {
        logger.log(
          `[SkillChat] [${sessionId}] empty_response preserved without paging attention ` +
          `(tools=${result.toolCalls?.length ?? 0})`,
        );
      }
      const endReason = result.status === "succeeded" ? "complete" : result.error || result.status;
      await chatFileStorage.setEndReason(sessionId, endReason).catch(() => undefined);
      if (options.parentSessionId) {
        treeLog.log(`end skill=${skillId} run=${sessionId} parent=${options.parentSessionId} status=${result.status} sessionStatus=${finalSessionStatus} endReason=${endReason} durationMs=${result.durationMs}`);
      }
      if (skillId === "council" || config.skillId === "council") {
        councilLog.log(`end skill=${skillId} run=${sessionId} status=${result.status} durationMs=${result.durationMs}`);
      }

      const existingSession = await chatFileStorage.getSession(sessionId).catch(() => undefined);
      const titleToUse = existingSession?.title || config.label;
      if (finalSessionStatus === "saved") {
        await chatFileStorage.saveSession(sessionId, titleToUse).catch((e: unknown) => {
          logger.error(`[SkillChat] [${sessionId}] Failed to save conversation after pipeline completion: ${e instanceof Error ? e.message : String(e)}`);
        });
      } else {
        await chatFileStorage.updateSessionTitle(sessionId, titleToUse).catch((e: unknown) => {
          logger.error(`[SkillChat] [${sessionId}] Failed to update title after pipeline failure: ${e instanceof Error ? e.message : String(e)}`);
        });
      }

      // If session.end deferred a terminal status, tools already applied it in
      // persistExecutorResult. Only write the pipeline's status when nothing is
      // pending and settling is clear (or apply the deferred end now).
      const appliedDeferred = await applyPendingSessionEndAfterTools(sessionId);
      if (!appliedDeferred) {
        logger.log(`[SkillChat] [${sessionId}] status → ${finalSessionStatus} (${result.status})`);
        await chatFileStorage.updateSessionStatus(sessionId, finalSessionStatus).catch((e: unknown) => {
          logger.error(`[SkillChat] [${sessionId}] Failed to set status to ${finalSessionStatus}: ${e instanceof Error ? e.message : String(e)}`);
        });
      } else {
        logger.log(`[SkillChat] [${sessionId}] status → deferred session.end applied after tools (${result.status})`);
        agentExecutor.clearAppliedSessionEnd(sessionId);
      }
      await chatFileStorage.setHasUnreadResult(sessionId, true).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to set hasUnreadResult: ${e instanceof Error ? e.message : String(e)}`);
      });

    } else {
      logger.warn(`[SkillChat] [${sessionId}] Session deleted mid-run — skipping post-pipeline writes`);
      await applyPendingSessionEndAfterTools(sessionId);
    }

    // Terminal gate for the checklist's deterministic items. A run that never
    // successfully invoked a tool its checklist requires must not terminate as
    // a clean success. Computed here — the single terminal-status mutation
    // point — so every launch path (timer, tool, hook) inherits the verdict.
    let runStatus: "succeeded" | "degraded" | "failed" =
      result.status === "succeeded" ? "succeeded"
      : result.status === "degraded" ? "degraded"
      : "failed";
    let failedStructuralChecks: string[] = [];
    if (runStatus === "succeeded" && config.skillId) {
      failedStructuralChecks = await findFailedStructuralChecks(sessionId, config.skillId);
      if (failedStructuralChecks.length > 0) runStatus = "degraded";
    }
    if (runStatus === "degraded" && options.parentSessionId) {
      const { updateSpawnStatus } = await import("./sessions/tree");
      await updateSpawnStatus(sessionId, "failed");
    }
    const terminalFailureReason = runStatus === "failed"
      ? result.error
      : runStatus === "degraded"
        ? result.status === "degraded"
          ? result.error || "executor_degraded"
          : `structural_requirements_failed: ${failedStructuralChecks.join(", ")}`
        : undefined;
    if (!isSkillless) {
      const settledRun = await storage.updateSkillRunStatus(sessionId, runStatus, result.durationMs, terminalFailureReason).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to update skill_runs status: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (!settledRun) {
        throw new Error(`SkillRun terminal persistence failed for session ${sessionId}`);
      }
    }
    if (runStatus === "degraded") {
      if (await conversationExists(sessionId)) {
        await chatFileStorage.setEndReason(sessionId, terminalFailureReason || "structural_requirements_failed").catch((e: unknown) => {
          logger.error(`[SkillChat] [${sessionId}] Failed to reconcile degraded endReason: ${e instanceof Error ? e.message : String(e)}`);
        });
        const reconcileDegradationReason =
          result.status === "degraded" ? result.degradationReason : undefined;
        // Structural misses have no degradationReason and must still page.
        // Pure empty_response already logged above and must not page twice.
        if (shouldPageAutonomousDegradation(reconcileDegradationReason)) {
          await recordAutonomousAttention(sessionId, "warning", {
            errorType: "processing_stopped",
            description: terminalFailureReason
              ? `This autonomous run finished degraded: ${terminalFailureReason}`
              : "This autonomous run finished degraded after structural requirements failed.",
            actionHint: "Review the warning in this session, then continue or retry if the outcome is incomplete.",
            artifactKey: `autonomous-attention:degraded:${sessionId}`,
            terminationReason: terminalFailureReason || "structural_requirements_failed",
            degradationReason: reconcileDegradationReason,
          }).catch((e: unknown) => {
            logger.error(`[SkillChat] [${sessionId}] Failed to reconcile degraded attention: ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      }
      const degradedReason = result.status === "degraded"
        ? result.error || "executor_degraded"
        : "structural_requirements_failed";
      logger.warn(`[SkillChat] [${sessionId}] Run degraded — reason=${degradedReason} failedStructuralChecks=${failedStructuralChecks.join(",") || "none"}`);
      eventBus.publish({
        category: "skill",
        event: "skill.run.degraded",
        payload: { sessionId, skillId, skillName: config.label, reason: degradedReason, failedStructuralChecks },
      });
    }

    eventBus.publish({
      category: "chat",
      event: runStatus === "succeeded"
        ? "chat.autonomous.completed"
        : runStatus === "degraded"
          ? "chat.autonomous.degraded"
          : "chat.autonomous.failed",
      payload: { sessionId, skillId, skillName: config.label, durationMs: result.durationMs, error: result.error, sessionType: sessType, ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}) },
    });
    lifecycleLog.debug(
      `phase=terminal sessionId=${sessionId} parentSessionId=${options.parentSessionId ?? "none"} ` +
      `skillId=${skillId ?? "skillless"} status=${runStatus} durationMs=${result.durationMs} ` +
      `error=${result.error ?? "none"}`,
    );

    if (runStatus === "degraded") {
      return {
        ...result,
        status: "degraded",
        failedStructuralChecks,
        failedToolChecks: failedStructuralChecks,
      };
    }
    return result;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;

    // Classify the failure reason for structured telemetry
    const failureReason = errMsg.includes("pipeline_timeout") ? "inactivity_timeout"
      : errMsg.includes("admission_timeout") ? "admission_timeout"
      : errMsg.includes("admission_aborted") ? "admission_aborted"
      : errMsg.includes("idle_timeout") ? "stream_idle_timeout"
      : errMsg.includes("yield_to_interactive") ? "yield_preempted"
      : errMsg.includes("overloaded_error") ? "api_overloaded"
      : "crashed";
    logger.error(`[SkillChat] Pipeline crashed for "${config.label}" (${sessionId}): ${errMsg} [failureReason=${failureReason}]`);

    if (await conversationExists(sessionId)) {
      await chatFileStorage.updateSessionStatus(sessionId, "failed").catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to set status to failed after crash: ${e instanceof Error ? e.message : String(e)}`);
      });
      await chatFileStorage.setEndReason(sessionId, "crashed").catch(() => undefined);
      if (options.parentSessionId) {
        treeLog.warn(`abort skill=${skillId} run=${sessionId} parent=${options.parentSessionId} reason=${failureReason} err=${errMsg} durationMs=${durationMs}`);
      }
      if (skillId === "council" || config.skillId === "council") {
        councilLog.error(`abort skill=${skillId} run=${sessionId} err=${errMsg} durationMs=${durationMs}`);
      }

      await recordAutonomousAttention(sessionId, "error", {
        errorType: "something_went_wrong",
        description: `Skill run failed: ${errMsg}`,
        actionHint: "Open the session transcript, inspect the crash, and retry if needed.",
        artifactKey: `autonomous-attention:crash:${sessionId}`,
        terminationReason: failureReason,
      }).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to record crash attention: ${e instanceof Error ? e.message : String(e)}`);
      });
      const crashSession = await chatFileStorage.getSession(sessionId).catch(() => undefined);
      const crashTitle = crashSession?.title || config.label;
      await chatFileStorage.updateSessionTitle(sessionId, `${crashTitle} (failed)`).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to update title after crash: ${e instanceof Error ? e.message : String(e)}`);
      });

      logger.log(`[SkillChat] [${sessionId}] status → failed (crashed)`);
    } else {
      logger.warn(`[SkillChat] [${sessionId}] Session deleted mid-run — skipping post-crash writes`);
    }

    if (!isSkillless) {
      await storage.updateSkillRunStatus(sessionId, "failed", durationMs, `${failureReason}: ${errMsg}`).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to update skill_runs status after crash: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
    }

    eventBus.publish({
      category: "chat",
      event: "chat.autonomous.failed",
      payload: { sessionId, skillId, skillName: config.label, error: errMsg, durationMs },
    });
    lifecycleLog.debug(
      `phase=terminal sessionId=${sessionId} parentSessionId=${options.parentSessionId ?? "none"} ` +
      `skillId=${skillId ?? "skillless"} status=failed failureReason=${failureReason} ` +
      `durationMs=${durationMs} error=${errMsg}`,
    );

    return { sessionId, status: "failed", error: errMsg, durationMs };
  } finally {
    if (didRegisterActiveRun && skillId) activeSkillRuns.delete(getSkillRunKey(coordinationKey));
    // Finalize with SessionManager so WS subscribers see the session end
    try {
      const { sessionManager } = await import("./session-manager");
      sessionManager.finalizeSession(sessionId);
    } catch {
      // best effort — session may not have been registered
    }
  }
}

async function runCouncilPipeline(
  config: SkillRunConfig,
  sessionId: string,
  options: { preContext?: string; parentSessionId?: string; spawnReason?: string; spawnerTool?: string; spawnerSkillRun?: string; modelOverride?: string; sessionKeyOverride?: string },
): Promise<AutonomousRunResult> {
  const startTime = Date.now();
  const question = (options.preContext ?? "").trim();
  if (!question) {
    const msg = "Council requires a question (preContext) to deliberate on";
    councilLog.error(`[Council] ${sessionId} ${msg}`);
    await chatFileStorage.createMessage(sessionId, "system", `[Council] ${msg}`).catch(() => undefined);
    return { sessionId, status: "failed", error: msg, durationMs: Date.now() - startTime };
  }

  const { runCouncil, buildProductionDeps } = await import("./council");
  const { getModelForTier, initProfiles } = await import("./job-profiles");
  await initProfiles();
  const deps = buildProductionDeps(sessionId, sessionId);
  try {
    const result = await runCouncil(
      {
        parentSessionId: sessionId,
        question,
        runId: sessionId,
        advocates: [
          { role: "Advocate A", model: getModelForTier("max") },
          { role: "Advocate B", model: getModelForTier("max") },
        ],
      },
      deps,
    );
    const durationMs = Date.now() - startTime;
    // Propagate structured non-success outcomes so the runner status,
    // skill_runs row, and downstream telemetry reflect what actually
    // happened. "degraded" still produced a synthesis so it counts as a
    // success at the runner layer, with the degradation noted in the
    // synthesis body.
    if (result.status === "failed") {
      return { sessionId, status: "failed", error: `council failed after ${result.rounds} round(s)`, durationMs };
    }
    const summaryPrefix = result.status === "degraded" ? "[degraded] " : "";
    return {
      sessionId,
      status: "succeeded",
      summary: `${summaryPrefix}${result.synthesis}`.slice(0, 2000),
      durationMs,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    councilLog.error(`[Council] ${sessionId} pipeline crashed: ${msg}`);
    await chatFileStorage.createMessage(sessionId, "system", `[Council] Council orchestration crashed: ${msg}`).catch(() => undefined);
    return { sessionId, status: "failed", error: msg, durationMs: Date.now() - startTime };
  }
}

async function runSkillPipeline(
  config: SkillRunConfig,
  sessionId: string,
  options: { preContext?: string; parentSessionId?: string; spawnReason?: string; spawnerTool?: string; spawnerSkillRun?: string; modelOverride?: string; sessionKeyOverride?: string; admissionTier?: AdmissionTier; lineageId?: string; runtimeFence?: { runId: string; attemptId: string }; signal?: AbortSignal },
  authoritySkillId: string | undefined,
): Promise<AutonomousRunResult> {
  const startTime = Date.now();
  const abortController = new AbortController();
  const abortFromRuntime = () => abortController.abort(options.signal?.reason ?? "runtime_cancelled");
  if (options.signal?.aborted) abortFromRuntime();
  else options.signal?.addEventListener("abort", abortFromRuntime, { once: true });
  const effectiveAdmissionTier = options.admissionTier ?? (options.parentSessionId ? "realtime" : (config.admissionTier ?? "background"));
  const effectiveLineageId = options.lineageId ?? options.parentSessionId ?? sessionId;

  // Deferred: inactivity timer starts only after admission is granted, not while
  // waiting in the admission queue. This prevents the timer from killing runs
  // that are legitimately queued for a slot during high concurrency.
  const inactivityTimer = createInactivityTimer(config.timeoutMs, () => {
    logger.warn(`[${sessionId}] Skill pipeline inactivity timeout after ${config.timeoutMs}ms — aborting`);
    treeLog.warn(`bounds skill=${config.skillId} run=${sessionId} decision=abort reason=inactivity_timeout timeoutMs=${config.timeoutMs}`);
    abortController.abort("pipeline_timeout");
  }, { deferred: true });
  treeLog.log(`bounds skill=${config.skillId} run=${sessionId} timeoutMs=${config.timeoutMs} temp=${config.temperature}`);

  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    logger.log(`[SkillChat] [${sessionId}] Assembling context (callType=${config.callType})`);
    const spine = await contextBuilder.resolve({
      callType: config.callType,
      llmMode: "text",
      activity: config.activity,
      sessionId,
      contextBuildId: `skill-run:${sessionId}`,
      includeSections: config.includeSections,
      excludeSections: config.excludeSections,
    });
    const systemPrompt = contextBuilder.renderToPrompt(spine);

    let instructions: string;
    if (!config.skillId) {
      // Skillless execution: preContext IS the full instruction set
      instructions = options.preContext || "";
      logger.log(`[SkillChat] [${sessionId}] Skillless mode — using preContext as instructions (${instructions.length} chars)`);
    } else {
      const promptId = config.skillId.replace(/:/g, "-").toLowerCase();
      let skillProcessText: string | undefined;
      try {
        skillProcessText = await getSkillProcess(promptId);
      } catch (error: unknown) {
        // Optional global Skill row may be absent. Skills stamped
        // allowMissingDefinition continue with launch preContext, else the
        // SkillDefault.process seed. Name-sets are gone — the instance flag
        // is the only discriminant. Fail closed when both are empty.
        const isMissingSkill = error instanceof Error
          && error.message.startsWith("Required skill not found in DB:");
        const skillDefault = findBuiltinSkillDefault(promptId);
        const allowMissingDefinition = skillDefault?.allowMissingDefinition === true;
        const defaultProcess = skillDefault?.process?.trim() || undefined;
        const hasLaunchInstructions = Boolean(options.preContext?.trim());
        if (
          !isMissingSkill
          || !allowMissingDefinition
          || (!hasLaunchInstructions && !defaultProcess)
        ) {
          throw error;
        }
        if (!hasLaunchInstructions) {
          skillProcessText = defaultProcess;
        }
        logger.warn(
          `[SkillChat] [${sessionId}] Skill "${promptId}" has no DB definition; allowMissingDefinition using ${hasLaunchInstructions ? "launch" : "SkillDefault.process"} instructions`,
        );
      }
      instructions = `[SKILL — ${config.label}]\n\n${skillProcessText ?? options.preContext}`;
      if (options.preContext && skillProcessText) {
        instructions = `[SKILL — ${config.label}]\n\n${options.preContext}\n\n${skillProcessText}`;
      }

      // First-wave work consumers: inject deterministic dependency gate over
      // resolveWorkDependencyContext so capacity/execution never treat blocked
      // work as executable. Fail-soft — never block skill launch on digest errors.
      try {
        const {
          isWorkDependencySkillConsumer,
          resolveCapacityDependencyDigest,
          skillDependencyPurpose,
        } = await import("./work-dependency-consumers");
        const consumerName = resolveSkillRunName(config.skillId) || config.skillId;
        if (isWorkDependencySkillConsumer(consumerName)) {
          const digest = await resolveCapacityDependencyDigest(skillDependencyPurpose(consumerName));
          if (digest.trim()) {
            instructions = `${instructions}\n\n${digest.trim()}`;
            logger.log(
              `[SkillChat] [${sessionId}] Injected work-dependency digest for skill=${consumerName} (${digest.length} chars)`,
            );
          }
        }
      } catch (depErr) {
        logger.warn(
          `[SkillChat] [${sessionId}] Work-dependency digest failed (fail-soft): ${depErr instanceof Error ? depErr.message : String(depErr)}`,
        );
      }
    }

    await chatFileStorage.createMessage(sessionId, "system_prompt", instructions);
    logger.log(`[SkillChat] [${sessionId}] Context assembled, instructions persisted`);

    logger.log(`[SkillChat] [${sessionId}] status → streaming`);
    await chatFileStorage.updateSessionStatus(sessionId, "streaming").catch((e: unknown) => {
      logger.error(`[SkillChat] [${sessionId}] Failed to set status to streaming: ${e instanceof Error ? e.message : String(e)}`);
    });

    const sessionKey = options.sessionKeyOverride ?? (config.skillId ? `auto:${config.skillId}` : `auto:skillless`);

    eventBus.publish({
      category: "chat",
      event: "chat.stream",
      payload: {
        type: "system_prompt_message",
        content: instructions,
        sessionId,
        title: config.label,
      },
      sessionKey,
    });
    const trustedDelegation: TrustedEngineeringDelegation | undefined = options.planId
      ? "plan"
      : options.workflowRunId
        ? "workflow"
        : undefined;
    const { tools, toolExecutor } = await getSkillTools(
      config.activity,
      sessionKey,
      sessionId,
      authoritySkillId,
      config.skillId,
      trustedDelegation,
      options.runtimeFence,
    );

    let toolCallCount = 0;
    const toolCallLog: Array<{ name: string; action?: string; error?: boolean; result?: string }> = [];
    const wrappedToolExecutor = toolExecutor
      ? async (name: string, args: Record<string, unknown>) => {
          inactivityTimer.reset();
          logger.log(`[SkillChat] [${sessionId}] Tool call: ${name}`);
          const result = await toolExecutor(name, args);
          inactivityTimer.reset();
          toolCallCount++;
          const resultStr = typeof result.result === "string" ? result.result : undefined;
          toolCallLog.push({ name, action: typeof args.action === "string" ? args.action : undefined, error: result.error, result: resultStr });
          return result;
        }
      : undefined;

    let stallWarningFired = false;
    stallTimer = setTimeout(() => {
      stallWarningFired = true;
      logger.warn(`[SkillChat] [${sessionId}] API stall warning — no executor activity after 120s`);
    }, 120_000);

    const onEvent = (event: Record<string, unknown>) => {
      if (event.type === "admitted") {
        // Admission granted — now start the inactivity timer.
        // Before this point, the executor was waiting in the admission queue,
        // which is not silence during work.
        inactivityTimer.start();
        lifecycleLog.debug(
          `phase=executor-started sessionId=${sessionId} parentSessionId=${options.parentSessionId ?? "none"} ` +
          `skillId=${config.skillId || "skillless"} activity=${config.activity} ` +
          `tier=${effectiveAdmissionTier} lineageId=${effectiveLineageId}`,
        );
        logger.log(`[SkillChat] [${sessionId}] Admission granted — inactivity timer started`);
        return;
      }
      inactivityTimer.reset();
      if (!stallWarningFired && stallTimer) {
        clearTimeout(stallTimer);
      }
    };

    lifecycleLog.debug(
      `phase=execution-requested sessionId=${sessionId} parentSessionId=${options.parentSessionId ?? "none"} ` +
      `skillId=${config.skillId || "skillless"} activity=${config.activity} ` +
      `tier=${effectiveAdmissionTier} lineageId=${effectiveLineageId} toolCount=${tools.length}`,
    );
    logger.log(`[SkillChat] [${sessionId}] Starting executor (${tools.length} tools, temp=${config.temperature})`);
    const result = await raceAbort(
      agentExecutor.run({
        sessionKey,
        sessionId,
        runId: options.runtimeFence?.runId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: instructions },
        ],
        tools: tools.length > 0 ? tools as any : undefined,
        toolExecutor: wrappedToolExecutor,
        activity: config.activity,
        model: options.modelOverride,
        temperature: config.temperature,
        signal: abortController.signal,
        onEvent: onEvent as any,
        querySubsystem: "autonomous",
        tier: effectiveAdmissionTier,
        lineageId: effectiveLineageId,
        capacityOwner: options.runtimeFence
          ? { kind: "runtime", runId: options.runtimeFence.runId, attemptId: options.runtimeFence.attemptId }
          : undefined,
        requireExplicitMissionCompletion: Boolean(options.planId && options.stepId),
      }),
      abortController.signal,
      15_000,
      `skill_pipeline_${config.skillId}`,
    );

    const durationMs = Date.now() - startTime;
    const content = result.content?.trim() || "";
    const deferSettlementRelease = Boolean(options.planId && options.stepId);

    if (result.status === "yielded") {
      logger.log(`[SkillChat] [${sessionId}] Skill run yielded to interactive session — deferring`);
      // No tool persistence on yield — still release the settling gate.
      await applyPendingSessionEndAfterTools(sessionId);
      return { sessionId, status: "yielded", summary: "Yielded to interactive session", durationMs };
    }

    if (result.status === "failed") {
      const abortSummary = formatAbortDetails(result.abortDetails);
      const errorMsg = abortSummary || result.abortReason || result.error || result.terminationReason || "Unknown error";
      await persistExecutorResult(sessionId, result, describeExecutorFailure(result), true, deferSettlementRelease).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to persist error result: ${e instanceof Error ? e.message : String(e)}`);
      });
      logger.warn(`[SkillChat] [${sessionId}] Skill failed: ${errorMsg} (${durationMs}ms, ${toolCallCount} tool calls)`);
      return {
        sessionId,
        status: "failed",
        error: errorMsg,
        durationMs,
        childMissionOutcome: result.childMissionOutcome,
      };
    }

    if (result.status === "degraded") {
      const reason = result.degradationReason || "executor_degraded";
      const responseLimit = result.responseGenerationLimit;
      const responseLimitDetail = responseLimit
        ? ` The final response used ${responseLimit.finalResponseOutputTokens} of ${responseLimit.configuredOutputTokens} configured output tokens.`
        : "";
      // One discriminant per decision: key the persisted notice off
      // degradationReason. Generation-limit copy is reserved for
      // empty_response_output_limit and must carry the bounded token
      // numbers when present — never as a fallback for empty_response.
      const degradedNotice =
        reason === "iteration_budget_exhausted" || reason === "tool_call_budget_exhausted"
          ? "The executor reached its bounded work budget. Completed work remains saved; continue in a later run."
          : reason === "empty_response_output_limit"
            ? `The model reached its response generation limit before producing final text.${responseLimitDetail} Completed tool work remains saved.`
            : reason === "empty_response"
              ? "The model finished without returning any visible text. Completed tool work remains saved."
              : reason === "tool_failure_recovered"
                ? "A tool returned a non-retryable failure. Completed work before the failure was preserved."
                : "This autonomous run finished in a degraded state. Completed work remains saved.";
      const degradedSummary =
        reason === "iteration_budget_exhausted" || reason === "tool_call_budget_exhausted"
          ? "Executor work budget exhausted; completed work remains saved."
          : reason === "empty_response_output_limit"
            ? "Executor reached the response generation limit; completed work remains saved."
            : reason === "empty_response"
              ? "Executor completed without final text; completed work remains saved."
              : reason === "tool_failure_recovered"
                ? "A tool failed; completed work before the failure remains saved."
                : "Executor finished degraded; completed work remains saved.";
      await persistExecutorResult(sessionId, result, degradedNotice, false, deferSettlementRelease).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to persist degraded result: ${e instanceof Error ? e.message : String(e)}`);
      });
      logger.warn(
        `[SkillChat] [${sessionId}] Skill degraded: ${reason} ` +
        `(${durationMs}ms, ${toolCallCount} tool calls)` +
        (responseLimit
          ? ` responseGenerationLimit=${responseLimit.configuredOutputTokens} finalResponseOutputTokens=${responseLimit.finalResponseOutputTokens}`
          : ""),
      );
      return {
        sessionId,
        status: "degraded",
        summary: degradedSummary,
        error: reason,
        degradationReason: reason,
        durationMs,
        childMissionOutcome: result.childMissionOutcome,
      };
    }

    await persistExecutorResult(sessionId, result, "Skill run completed.", false, deferSettlementRelease).catch((e: unknown) => {
      logger.error(`[SkillChat] [${sessionId}] Failed to persist success result: ${e instanceof Error ? e.message : String(e)}`);
    });

    logger.log(`[SkillChat] [${sessionId}] Skill completed: ${config.label} in ${durationMs}ms, ${toolCallCount} tool calls`);
    return {
      sessionId,
      status: "succeeded",
      summary: content.slice(0, 2000),
      durationMs,
      childMissionOutcome: result.childMissionOutcome,
    };

  } finally {
    options.signal?.removeEventListener("abort", abortFromRuntime);
    inactivityTimer.clear();
    if (stallTimer) clearTimeout(stallTimer);
  }
}

/**
 * Trigger an agent response on an existing child session that has no active run.
 *
 * Used by `message_child` to kick off an agent when the target session was
 * created by `spawn_child` (which creates an idle session with a warm-start
 * brief but no agent loop). The function:
 *
 * 1. Checks `agentExecutor.hasActiveRunForSession` — bails if a run exists
 * 2. Reads existing messages from the session
 * 3. Registers with SessionManager for streaming
 * 4. Builds context, assembles the message array
 * 5. Calls `agentExecutor.run()` to generate a response
 * 6. Persists the result and finalizes the session
 *
 * Fire-and-forget from the caller's perspective.
 */
export async function triggerResponseOnChildSession(sessionId: string): Promise<void> {
  // ── Ensure user principal context ───────────────────────────────────
  // This is a detached, fire-and-forget entry point: callers dispatch it
  // via `void triggerResponseOnChildSession(...)` from cross-session message
  // tool handlers, so a user principal is not reliably present in
  // AsyncLocalStorage by the time the run reaches the tracked inference
  // boundary. Without one, currentOwnership() (fail-closed by design) throws
  // and every inference-audit (CostTracker) write for the child run is dropped.
  // Resolve the autonomous principal and wrap the whole execution, exactly as
  // executeAutonomousSkillRun does. Callers that already hold a principal
  // (interactive parents inheriting context) pass through unchanged.
  if (!getCurrentPrincipal()) {
    throw new Error(`Child session response requires the originating user principal: ${sessionId}`);
  }

  // Gate: if the session already has an active agent run, do nothing —
  // the existing run will pick up the new message naturally.
  if (agentExecutor.hasActiveRunForSession(sessionId)) {
    logger.log(`[triggerResponse] sessionId=${sessionId} — active run exists, skipping`);
    return;
  }

  const conv = await chatFileStorage.getSession(sessionId);
  if (!conv) {
    logger.warn(`[triggerResponse] sessionId=${sessionId} — session not found`);
    return;
  }

  const existingMessages = await chatFileStorage.getMessagesBySession(sessionId);
  if (existingMessages.length === 0) {
    logger.warn(`[triggerResponse] sessionId=${sessionId} — no messages to process`);
    return;
  }

  const sessionKey = conv.sessionKey || `auto:child:${sessionId}`;
  logger.log(`[triggerResponse] sessionId=${sessionId} — starting agent run (${existingMessages.length} messages)`);

  // Register with SessionManager so inline child widgets receive streaming content
  try {
    const { sessionManager } = await import("./session-manager");
    sessionManager.registerSession(sessionId, sessionKey, "text");
  } catch (regErr) {
    logger.debug(`[triggerResponse] [${sessionId}] sessionManager.registerSession skipped: ${regErr instanceof Error ? regErr.message : String(regErr)}`);
  }

  await chatFileStorage.updateSessionStatus(sessionId, "streaming").catch((e: unknown) => {
    logger.error(`[triggerResponse] [${sessionId}] Failed to set status to streaming: ${e instanceof Error ? e.message : String(e)}`);
  });

  // Build system prompt from context builder
  let systemPrompt: string;
  try {
    const spine = await contextBuilder.resolve({
      callType: "full",
      llmMode: "text",
      activity: ACTIVITY_WORK,
      sessionId,
      contextBuildId: `child-session:${sessionId}:response`,
    });
    systemPrompt = contextBuilder.renderToPrompt(spine);
  } catch (err) {
    logger.warn(`[triggerResponse] [${sessionId}] context build failed, using minimal prompt: ${err instanceof Error ? err.message : String(err)}`);
    const { agentName } = await resolveCurrentProfileIdentity();
    systemPrompt = `Your name is ${agentName}. Your type is Agent. Respond to the messages in this session.`;
  }

  // Assemble executor messages from session history
  const executorMessages: Array<{ role: "system" | "user" | "assistant"; content: string; thinking?: string; toolCalls?: any[] }> = [
    { role: "system", content: systemPrompt },
  ];

  for (const msg of existingMessages) {
    const content = msg.content || "";
    if (msg.role === "system" || msg.role === "system_prompt") {
      // Warm-start brief / system instructions → treat as user instruction
      executorMessages.push({ role: "user", content });
    } else if (msg.role === "cross_session") {
      // Cross-session message from parent → treat as user instruction
      executorMessages.push({ role: "user", content });
    } else if (msg.role === "user") {
      executorMessages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      executorMessages.push({
        role: "assistant",
        content,
        thinking: msg.thinking || undefined,
        toolCalls: (msg.toolCalls || undefined) as any,
      });
    }
  }

  const trustedDelegation = conv.spawnerTool === "plan-executor"
    ? "plan" as const
    : conv.spawnerTool === "workflow-executor"
      ? "workflow" as const
      : conv.spawnerTool === "session.spawn_child.engineering"
        ? "child" as const
        : undefined;
  // 5th arg is authoritySkillName; trustedDelegation is the 6th.
  const { tools, toolExecutor } = await getSkillTools(
    ACTIVITY_WORK,
    sessionKey,
    sessionId,
    undefined,
    undefined,
    trustedDelegation,
  );

  let finalStatus: "succeeded" | "failed" = "succeeded";
  let finalSummary = "Child session response completed";

  try {
    const result = await agentExecutor.run({
      sessionKey,
      sessionId,
      messages: executorMessages as any,
      tools: tools.length > 0 ? (tools as any) : undefined,
      toolExecutor,
      activity: ACTIVITY_WORK,
      temperature: 0.3,
      querySubsystem: "autonomous",
      tier: "request",
      requireExplicitMissionCompletion: conv.spawnerTool === "plan-executor",
    });

    if (result.status === "failed" || result.status === "degraded") {
      finalStatus = "failed";
      finalSummary = result.status === "degraded"
        ? result.degradationReason || "executor_degraded"
        : result.error || describeExecutorFailure(result);
    }

    await persistExecutorResult(sessionId, result, "Child session completed.", result.status === "failed").catch((e: unknown) => {
      logger.error(`[triggerResponse] [${sessionId}] Failed to persist result: ${e instanceof Error ? e.message : String(e)}`);
    });

    logger.log(`[triggerResponse] [${sessionId}] completed — status=${result.status} contentLen=${result.content?.length || 0}`);
  } catch (err: unknown) {
    finalStatus = "failed";
    finalSummary = err instanceof Error ? err.message : String(err);
    logger.error(`[triggerResponse] [${sessionId}] agent run failed: ${finalSummary}`);
    await persistExecutorResult(
      sessionId,
      { content: "", status: "failed", error: finalSummary } as any,
      `Agent run failed: ${finalSummary}`,
      true,
    ).catch(() => {});
  } finally {
    // A completed child session remains a durable chat document. The session row's
    // status is the only lifecycle source of truth.
    // If tools already persisted, settling is clear and any deferred session.end
    // was applied there. If not (crash before persist), apply now.
    const appliedDeferred = await applyPendingSessionEndAfterTools(sessionId);
    if (!appliedDeferred) {
      const childFinalStatus = finalStatus === "succeeded" ? "saved" : "failed";
      await chatFileStorage.updateSessionStatus(sessionId, childFinalStatus).catch((e: unknown) => {
        logger.error(`[triggerResponse] [${sessionId}] Failed to set final status to ${childFinalStatus}: ${e instanceof Error ? e.message : String(e)}`);
      });
    } else {
      agentExecutor.clearAppliedSessionEnd(sessionId);
    }
    await chatFileStorage.setEndReason(sessionId, finalStatus === "succeeded" ? "complete" : finalSummary).catch(() => undefined);

    try {
      const { sessionManager } = await import("./session-manager");
      sessionManager.finalizeSession(sessionId);
    } catch {}

    // Emit completion event for inline widget lifecycle
    try {
      const parentSessionId = conv.parentSessionId;
      if (parentSessionId) {
        const { onChildSessionCompleted } = await import("./sessions/child-block-lifecycle");
        await onChildSessionCompleted(parentSessionId, sessionId, {
          status: finalStatus,
          summary: finalSummary,
          durationMs: 0,
        });
      }
    } catch (lcErr) {
      logger.debug(`[triggerResponse] [${sessionId}] lifecycle completion event failed: ${lcErr instanceof Error ? lcErr.message : String(lcErr)}`);
    }
  }
}



(async () => {
  try {
    const { cleanupOrphanedSubsessions } = await import("./sessions/cleanup-orphans");
    await cleanupOrphanedSubsessions();
  } catch (err) {
    logger.error(`[BootCleanup] orphan sub-session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
})();
