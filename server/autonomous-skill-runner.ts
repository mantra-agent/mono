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
import { isAgentType } from "@shared/instance-config";
import { getCurrentPrincipal, runWithPrincipal } from "./principal-context";
import type { Principal } from "./principal";

const logger = createLogger("AutonomousSkillRunner");
const lifecycleLog = createLogger("AutonomousLifecycle");

// ── Autonomous principal resolution ─────────────────────────────────
// Every autonomous skill run must execute inside a user principal context.
// Without this, all scoped writes (sessions, memory, check-ins, thoughts,
// library pages, etc.) default to the system principal (ownerUserId=null,
// scope='system') and become invisible to user-scoped reads.
//
// This is resolved once and cached for the process lifetime.
let _cachedAutonomousPrincipal: Principal | null = null;

async function resolveAutonomousPrincipal(): Promise<Principal> {
  if (_cachedAutonomousPrincipal) return _cachedAutonomousPrincipal;
  try {
    const { resolveUserIdentityFoundation } = await import("./principal");
    const { getUserEffectivePermissions } = await import("./permissions");
    const users = await storage.getUsers();
    const user = users.find(u => u.role === "admin") || users[0];
    if (!user) {
      logger.warn("resolveAutonomousPrincipal: no users found, falling back to named system principal");
      const { createNamedSystemPrincipal } = await import("./principal");
      return createNamedSystemPrincipal("autonomous-skill-runner");
    }
    const foundation = await resolveUserIdentityFoundation(user.id);
    const permissions = await getUserEffectivePermissions(user.id);
    _cachedAutonomousPrincipal = {
      actorType: "user",
      userId: user.id,
      accountId: foundation.accountId,
      role: foundation.role,
      scopes: ["system:read", "system:write"],
      permissions,
      isAdmin: user.role === "admin",
      impersonation: null,
      source: "autonomous",
      visibleVaultIds: user.visibleVaultIds ?? [],
      activeVaultId: user.activeVaultId ?? null,
    };
    logger.log(`resolveAutonomousPrincipal: resolved userId=${user.id} accountId=${foundation.accountId}`);
    return _cachedAutonomousPrincipal;
  } catch (err) {
    logger.error("resolveAutonomousPrincipal failed, falling back to named system principal:", err instanceof Error ? err.message : String(err));
    const { createNamedSystemPrincipal } = await import("./principal");
    return createNamedSystemPrincipal("autonomous-skill-runner");
  }
}
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

function describeExecutorFailure(result: ExecutorRunResult): string {
  const abortSummary = formatAbortDetails(result.abortDetails);
  if (abortSummary) return `Skill run stopped by executor guard:\n\n${abortSummary}`;

  const durationMs = result.durationMs ?? 0;
  const duration = durationMs > 0 ? `${(durationMs / 60000).toFixed(1)}m` : "unknown duration";
  const toolCallCount = result.toolCalls?.length ?? 0;

  if (result.abortReason === "idle_timeout") {
    return [
      "Skill run stopped by idle-timeout watchdog.",
      "This was not user-cancelled.",
      `Reason: no executor stream/tool activity was observed before the idle timeout (${duration}).`,
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

async function persistExecutorResult(
  sessionId: string,
  result: ExecutorRunResult,
  fallbackContent: string,
  isError?: boolean,
): Promise<void> {
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
    status: string;
  }> | undefined;

  if (result.toolCalls && result.toolCalls.length > 0) {
    toolCalls = result.toolCalls.map((tc, i) => ({
      toolName: tc.name,
      toolCallId: tc.id || `tc-${sessionId.slice(0, 8)}-${i}`,
      arguments: tc.args,
      result: tc.result,
      error: tc.error && typeof tc.error !== "boolean" ? String(tc.error) : undefined,
      status: tc.error ? "error" : "done",
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
}

async function persistCrashMessage(
  sessionId: string,
  errorMessage: string,
  context: string,
): Promise<void> {
  if (!await conversationExists(sessionId)) {
    logger.warn(`[SkillChat] [${sessionId}] Session deleted mid-run — skipping persistCrashMessage`);
    return;
  }
  await chatFileStorage.createMessage(sessionId, "system", `${context}: ${errorMessage}`, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
  logger.log(`[SkillChat] [${sessionId}] Persisted crash message: ${context}`);
}

type ToolCallLog = Array<{ name: string; action?: string; error?: boolean; result?: string }>;

const deferredPostRunVerify = new Map<string, { toolCalls: ToolCallLog; verifyFn: (sessionId: string, toolCalls: ToolCallLog) => Promise<void> }>();

export async function runDeferredPostRunVerify(sessionId: string): Promise<void> {
  const deferred = deferredPostRunVerify.get(sessionId);
  if (!deferred) return;
  deferredPostRunVerify.delete(sessionId);
  try {
    await deferred.verifyFn(sessionId, deferred.toolCalls);
  } catch (err: unknown) {
    logger.error(`[SkillChat] [${sessionId}] deferred postRunVerify failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pageWritePostRunVerify(sessionId: string, toolCalls: ToolCallLog): Promise<void> {
  const wrotePage = toolCalls.some(t => t.name === "library" && (t.action === "create_library_page" || t.action === "update_library_page") && !t.error);
  const attentionSucceeded = toolCalls.some(t => (t.name === "converse" && t.action === "set_attention" && !t.error) || (t.name === "set_attention" && !t.error));

  await verifyPageCreated(sessionId, toolCalls, wrotePage, attentionSucceeded);
  await verifyAttentionSet(sessionId, toolCalls, attentionSucceeded);
  await verifyPageLinkPosted(sessionId, toolCalls, wrotePage);
}
async function dailyBriefSurfacePostRunVerify(sessionId: string, toolCalls: ToolCallLog): Promise<void> {
  const pageResults = toolCalls
    .filter(t => t.name === "library" && (t.action === "create_library_page" || t.action === "update_library_page") && !t.error && t.result)
    .map(t => t.result!);
  if (pageResults.length === 0) {
    logger.warn(`[daily-brief] [${sessionId}] Post-run: no Library page write detected, cannot enforce INBOX surfacing`);
    return;
  }

  const slugMatch = pageResults
    .map(r => r.match(/\[page:([^\]]+)\]/))
    .find(Boolean);

  const { getDateInTimezone } = await import("./timezone");
  const fallbackSlug = `daily-brief-${getDateInTimezone()}`;
  const pageId = slugMatch?.[1] || fallbackSlug;
  const result = await executeTool("library", generateToolCallId("auto-tc"), {
    action: "update_library_page",
    id: pageId,
    surface: true,
    surfaceDurationHours: 24,
    surfaceReason: "Daily Brief",
    surfaceSection: "inbox",
  }, {
    sessionId,
    sessionKey: `auto:brief-daily`,
  });

  if (result.error) {
    logger.warn(`[daily-brief] [${sessionId}] Failed to enforce Library INBOX surfacing for ${pageId}: ${result.result}`);
    return;
  }

  logger.log(`[daily-brief] [${sessionId}] Enforced Library INBOX surfacing for ${pageId}`);
}


async function verifyPageCreated(
  sessionId: string,
  toolCalls: ToolCallLog,
  wrotePage: boolean,
  attentionSucceeded: boolean,
): Promise<void> {
  if (wrotePage) return;
  if (attentionSucceeded) {
    logger.log(`[spec] [${sessionId}] Post-run: no page created but attention was set — likely awaiting user clarification, skipping fallback`);
    return;
  }

  const anyLibrary = toolCalls.some(t => t.name === "library");
  const detail = anyLibrary
    ? "library was called but never with a page-write action"
    : "library tool was never called";
  logger.warn(`[spec] [${sessionId}] Post-run: no page created — ${detail}`);
}

async function verifyAttentionSet(
  sessionId: string,
  toolCalls: ToolCallLog,
  attentionSucceeded: boolean,
): Promise<void> {
  if (attentionSucceeded) return;
  const attentionAttempted = toolCalls.some(t => (t.name === "converse" && t.action === "set_attention") || t.name === "set_attention");
  const reason = attentionAttempted
    ? "converse(set_attention) was called but failed"
    : "converse(set_attention) was never called";
  logger.warn(`[spec] [${sessionId}] Post-run check: ${reason} — auto-flagging conversation`);
  await chatFileStorage.setSessionPinned(sessionId, true);
}

async function verifyPageLinkPosted(
  sessionId: string,
  toolCalls: ToolCallLog,
  wrotePage: boolean,
): Promise<void> {
  if (!wrotePage) return;
  const messages = await chatFileStorage.getMessagesBySession(sessionId);
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const hasPageLink = assistantMessages.some((m) => /\[page:[^\]]+\]/.test(m.content));
  if (hasPageLink) return;

  const pageResults = toolCalls
    .filter(t => t.name === "library" && (t.action === "create_library_page" || t.action === "update_library_page") && !t.error && t.result)
    .map(t => t.result!);
  const slugMatch = pageResults
    .map(r => r.match(/\[page:([^\]]+)\]/))
    .find(m => m);
  const pageRef = slugMatch ? `[page:${slugMatch[1]}]` : null;
  logger.warn(`[spec] [${sessionId}] Post-run check: no [page:slug] link found in assistant messages — injecting page link`);
  await chatFileStorage.createMessage(sessionId, "system",
    pageRef
      ? `[auto] The page was created successfully: ${pageRef}`
      : `[auto] A page was created but the link could not be determined. Check the library.`
  ).catch((e: unknown) => {
    logger.error(`[spec] [${sessionId}] Failed to persist page link message: ${e instanceof Error ? e.message : String(e)}`);
  });
}

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
  postRunVerify?: (sessionId: string, toolCalls: Array<{ name: string; action?: string; error?: boolean; result?: string }>) => Promise<void>;
}


function isAnnualReflectRun(config: SkillRunConfig, preContext?: string): boolean {
  if (config.skillId === "reflect-annual") return true;
  if (config.skillId !== "reflect") return false;
  return /["']?cadence["']?\s*[:=]\s*["']?annual["']?/i.test(preContext || "");
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

const SKILL_RUN_CONFIGS: Record<string, SkillRunConfig> = {
  "consolidate": {
    skillId: "consolidate",
    label: "Consolidate",
    callType: "internal",
    activity: ACTIVITY_MEMORY,
    temperature: 0.2,
    timeoutMs: 5 * 60 * 1000,
  },
  "integrate": {
    skillId: "integrate",
    label: "Integrate",
    callType: "internal",
    activity: ACTIVITY_MEMORY,
    temperature: 0.2,
    timeoutMs: 5 * 60 * 1000,
  },
  "sleep": {
    skillId: "sleep",
    label: "Sleep",
    callType: "internal",
    activity: ACTIVITY_MEMORY,
    temperature: 0.5,
    timeoutMs: 10 * 60 * 1000,
  },
  "reflect": {
    skillId: "reflect",
    label: "Reflect",
    callType: "internal",
    includeSections: ["world_model.people.self.principles", "world_model.calendar", "world_model.active_work.tasks", "world_model.active_work.projects", "thoughts"],
    activity: ACTIVITY_THINKING,
    temperature: 0.6,
    timeoutMs: 10 * 60 * 1000,
  },
  "plan": {
    skillId: "plan",
    label: "Plan",
    callType: "full",
    activity: ACTIVITY_WORK,
    temperature: 0.5,
    timeoutMs: 10 * 60 * 1000,
    sessionType: "agent",
  },
  "enrich-email": {
    skillId: "enrich-email",
    label: "Enrich Email",
    callType: "full",
    activity: ACTIVITY_WORK,
    temperature: 0.3,
    timeoutMs: 8 * 60 * 1000,
    sessionType: "autonomous",
    // Email enrichment is part of the user-facing inbound communications
    // pipeline. It must not be deferred merely because the user is active.
    admissionTier: "realtime",
  },
  "brief-daily": {
    skillId: "brief-daily",
    label: "Daily Brief",
    callType: "internal",
    activity: ACTIVITY_WORK,
    temperature: 0.4,
    timeoutMs: 3 * 60 * 1000,
    sessionType: "agent",
    async postRunVerify(sessionId: string, toolCalls: Array<{ name: string; action?: string; error?: boolean; result?: string }>) {
      await dailyBriefSurfacePostRunVerify(sessionId, toolCalls);
    },
  },
};

export interface AutonomousRunResult {
  sessionId: string;
  status: "succeeded" | "failed" | "yielded";
  summary?: string;
  error?: string;
  durationMs: number;
}

const activeSkillRuns = new Set<string>();

export function isDuplicateSkillRun(skillId: string, intentionId?: string): boolean {
  const key = intentionId || skillId;
  return activeSkillRuns.has(key);
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
  const key = intentionId || skillId;
  if (activeSkillRuns.has(key)) return false;
  activeSkillRuns.add(key);
  return true;
}

export function releaseSkillRun(skillId: string, intentionId?: string): void {
  const key = intentionId || skillId;
  activeSkillRuns.delete(key);
}

function getSkillRunKey(skillId: string, intentionId?: string): string {
  return intentionId || skillId;
}

export function getRegisteredSkillIds(): string[] {
  return Object.keys(SKILL_RUN_CONFIGS);
}

function getSkillTools(activity: ActivityId, sessionKey: string, sessionId: string): {
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<{ result: string; error: boolean }>;
} {
  const allToolDefs = getToolDefinitions();
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
    });
    return { result: result.result, error: result.error, sideEffectOnly: result.sideEffectOnly, continuation: result.continuation };
  };

  return { tools, toolExecutor: toolExecutor as any };
}

export async function executeAutonomousSkillRun(
  skillId: string | undefined | null,
  options: {
    preContext?: string;
    parentSessionId?: string;
    spawnReason?: string;
    spawnerTool?: string;
    spawnerSkillRun?: string;
    onSessionCreated?: (sessionId: string) => void;
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
  } = {}
): Promise<AutonomousRunResult | null> {
  // ── Ensure user principal context ───────────────────────────────────
  // If no principal is in AsyncLocalStorage (e.g. called from timers,
  // hooks, email enrichment, or other fire-and-forget paths), resolve
  // the user principal and wrap the entire execution.  Callers that
  // already have a principal (e.g. HTTP routes via auth middleware,
  // child sessions inheriting parent context) pass through unchanged.
  if (!getCurrentPrincipal()) {
    const principal = await resolveAutonomousPrincipal();
    return runWithPrincipal(principal, () => executeAutonomousSkillRun(skillId, options));
  }

  // ── Skillless execution path ────────────────────────────────────────
  // When no skillId is provided but preContext exists, run the session
  // using preContext as the full instruction set. No skill DB lookup,
  // no SKILL_RUN_CONFIGS entry needed. Used by the plan executor to
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
  config = SKILL_RUN_CONFIGS[skillId]!;
  if (!config) {
    // Fallback: look up the skill in the database and check if its name matches a hardcoded config
    try {
      let dbSkill = await storage.getSkillByName(skillId);
      if (!dbSkill) dbSkill = await storage.getSkill(skillId);
      if (!dbSkill) {
        throw new Error(`No skill run config and no database record found for "${skillId}"`, { cause: new Error("skill-not-found") });
      }

      const hardcodedByName = SKILL_RUN_CONFIGS[dbSkill.name];
      if (hardcodedByName) {
        config = hardcodedByName;
        logger.log(`[skill:${skillId}] Resolved UUID to hardcoded config via db name="${dbSkill.name}" — timeout=${config.timeoutMs}ms`);
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
        logger.log(`[skill:${skillId}] Built dynamic config from database — label="${config.label}" activity=${activity} timeoutMs=${config.timeoutMs}${dbTimeoutMs ? " (from estimatedDuration)" : " (default)"}`);
      }
    } catch (err: unknown) {
      const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
      logger.error(`[skill:${skillId}] phase=config-resolve FAILED — could not build dynamic config: ${errDetail}`);
      throw new Error(`phase=config-resolve FAILED for skill "${skillId}": ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
  } // end skill-based config resolution

  // Global per-skill dedupe is for top-level autoruns (e.g. cron-triggered
  // skills that should never overlap themselves). Parented child spawns
  // (e.g. Council fanning two `advocate` runs in parallel) are
  // already deduped at the spawn-tree level by the advisory lock + the
  // (parent, reason, skillRun) unique tuple in `session_tree`. Bypassing
  // this gate when a `parentSessionId` is present is required for
  // legitimate parallel fan-out.
  if (!isSkillless && !options.parentSessionId && isDuplicateSkillRun(skillId!)) {
    logger.log(`[skill:${skillId}] Already running — skipping`);
    return null;
  }


  // Track whether *this* invocation registered the active-run marker so the
  // cleanup paths only delete it when we own it. Without this guard, a
  // parented child spawn could clear the marker that a concurrent top-level
  // run of the same skill is relying on for dedupe.
  let didRegisterActiveRun = false;
  if (!isSkillless && !options.parentSessionId) {
    activeSkillRuns.add(skillId!);
    didRegisterActiveRun = true;
  }
  const startTime = Date.now();

  let addToMemory = true;
  let resolvedSessionType: "autonomous" | "agent" | null = null;
  let resolvedPersona: import("./skill-persona-service").SkillPersonaResolution | null = null;
  if (!isSkillless) {
    logger.log(`[SkillChat] phase=skill-lookup — resolving skill record for "${skillId}" (config.skillId="${config.skillId}")`);
    try {
      let skillRecord = await storage.getSkillByName(config.skillId);
      if (!skillRecord && skillId !== config.skillId) skillRecord = await storage.getSkillByName(skillId!);
      if (!skillRecord) skillRecord = await storage.getSkill(skillId!);
      if (skillRecord) {
        if (skillRecord.addToMemory === false) {
          addToMemory = false;
        }
        if (skillRecord.sessionType === "autonomous" || skillRecord.sessionType === "agent") {
          resolvedSessionType = skillRecord.sessionType;
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
  if (!options.parentSessionId && !isSkillless && (config.admissionTier ?? "background") === "background") {
    try {
      const { admissionController } = await import("./run-admission");
      const activity = config.activity;
      const snapshot = admissionController.getAdmissionSnapshot({ activity });
      if (!admissionController.canAdmitBackground({ activity })) {
        logger.log(
          `[SkillChat] [${config.label}] Pre-flight: admission_deferred ` +
          `(snapshot: ${JSON.stringify(snapshot)}) — deferring skill run`
        );
        releaseSkillRun(skillId!);
        return null;
      }
    } catch (admCheckErr: unknown) {
      // Non-fatal: if the pre-flight check fails, proceed normally.
      logger.debug(`[SkillChat] Pre-flight admission check failed: ${admCheckErr instanceof Error ? admCheckErr.message : String(admCheckErr)}`);
    }
  }

  let conversation: FileSession;
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
    conversation = await chatFileStorage.createAutonomousSession(
      effectiveTitle,
      sessType,
      isSkillless ? `auto:skillless` : `auto:${skillId}`,
      undefined,
      undefined,
      options.parentSessionId
        ? {
            parentSessionId: options.parentSessionId,
            spawnReason: effectiveSpawnReason,
            spawnerTool: effectiveSpawnerTool,
            spawnerSkillRun: effectiveSpawnerSkillRun,
            triggerType: (options as any).hookTriggerId ? "hook" as const : "skill" as const,
            triggerId: (options as any).hookTriggerId || skillId || undefined,
            triggerName: (options as any).hookTriggerName || config.label,
          }
        : {
            triggerType: (options as any).hookTriggerId ? "hook" as const : "skill" as const,
            triggerId: (options as any).hookTriggerId || skillId || undefined,
            triggerName: (options as any).hookTriggerName || config.label,
          },
    );
  } catch (err: unknown) {
    if (didRegisterActiveRun && skillId) activeSkillRuns.delete(skillId);
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
      await storage.insertSkillRun({ skillName: config.skillId, sessionId });
      logger.log(`[SkillChat] [${sessionId}] Inserted skill_runs row for "${config.skillId}"`);
    } catch (runInsertErr: unknown) {
      logger.error(`[SkillChat] [${sessionId}] Failed to insert skill_runs row: ${runInsertErr instanceof Error ? runInsertErr.message : String(runInsertErr)}`);
    }
  }

  // Apply the resolved skill persona through the canonical mutation path so
  // persona-driven semantic-tier model routing picks it up. Resolution chain:
  // user_override → skill_persona_legacy → skill_recommendation (lineage).
  if (resolvedPersona != null) {
    try {
      const { setSessionPersona } = await import("./session-persona");
      const persona = await setSessionPersona(sessionId, resolvedPersona.personaId);
      if (persona) {
        logger.log(`[SkillChat] [${sessionId}] Applied skill persona "${persona.name}" (id=${persona.id}, source=${resolvedPersona.source})`);
      } else {
        logger.warn(`[SkillChat] [${sessionId}] Skill persona id=${resolvedPersona.personaId} (source=${resolvedPersona.source}) not found — falling back to default persona resolution`);
      }
    } catch (personaErr: unknown) {
      logger.warn(`[SkillChat] [${sessionId}] Failed to apply skill persona id=${resolvedPersona.personaId}: ${personaErr instanceof Error ? personaErr.message : String(personaErr)}`);
    }
  }

  if (options.onSessionCreated) {
    options.onSessionCreated(sessionId);
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

  // Register with SessionManager so WS subscribers (inline child widgets) receive live streaming content
  try {
    const { sessionManager } = await import("./session-manager");
    sessionManager.registerSession(sessionId, sessionKey, "text");
  } catch (regErr) {
    logger.debug(`[SkillChat] [${sessionId}] sessionManager.registerSession skipped: ${regErr instanceof Error ? regErr.message : String(regErr)}`);
  }

  try {
    const result = config.skillId === "council"
      ? await runCouncilPipeline(config, sessionId, options)
      : await runSkillPipeline(config, sessionId, options);

    if (result.status === "yielded") {
      const error = "Execution yielded under genuine capacity pressure. The parent may retry or resume this child.";
      logger.warn(`[SkillChat] [${sessionId}] ${error}`);
      if (await conversationExists(sessionId)) {
        await chatFileStorage.setEndReason(sessionId, "yield_to_interactive").catch(() => undefined);
        await chatFileStorage.setErrorSeverity(sessionId, "warn").catch(() => undefined);
        await chatFileStorage.updateSessionStatus(sessionId, "failed");
      }
      storage.updateSkillRunStatus(sessionId, "yielded", result.durationMs, error).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to update skill_runs status to yielded: ${e instanceof Error ? e.message : String(e)}`);
      });
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
      const finalSessionStatus = result.status === "succeeded" ? "saved" : "failed";
      if (finalSessionStatus === "failed") {
        await chatFileStorage.setErrorSeverity(sessionId, "error").catch((e: unknown) => {
          logger.error(`[SkillChat] [${sessionId}] Failed to set errorSeverity: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
      const endReason = result.status === "succeeded" ? "complete" : result.error || "error";
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

      logger.log(`[SkillChat] [${sessionId}] status → ${finalSessionStatus} (${result.status})`);
      await chatFileStorage.updateSessionStatus(sessionId, finalSessionStatus).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to set status to ${finalSessionStatus}: ${e instanceof Error ? e.message : String(e)}`);
      });
      await chatFileStorage.setHasUnreadResult(sessionId, true).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to set hasUnreadResult: ${e instanceof Error ? e.message : String(e)}`);
      });

    } else {
      logger.warn(`[SkillChat] [${sessionId}] Session deleted mid-run — skipping post-pipeline writes`);
    }

    const runStatus = result.status === "succeeded" ? "succeeded" : "failed";
    storage.updateSkillRunStatus(sessionId, runStatus, result.durationMs, runStatus === "failed" ? result.error : undefined).catch((e: unknown) => {
      logger.error(`[SkillChat] [${sessionId}] Failed to update skill_runs status: ${e instanceof Error ? e.message : String(e)}`);
    });

    eventBus.publish({
      category: "chat",
      event: result.status === "succeeded" ? "chat.autonomous.completed" : "chat.autonomous.failed",
      payload: { sessionId, skillId, skillName: config.label, durationMs: result.durationMs, error: result.error, sessionType: sessType, ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}) },
    });
    lifecycleLog.debug(
      `phase=terminal sessionId=${sessionId} parentSessionId=${options.parentSessionId ?? "none"} ` +
      `skillId=${skillId ?? "skillless"} status=${result.status} durationMs=${result.durationMs} ` +
      `error=${result.error ?? "none"}`,
    );

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
      await chatFileStorage.setErrorSeverity(sessionId, "error").catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to set errorSeverity after crash: ${e instanceof Error ? e.message : String(e)}`);
      });
      await chatFileStorage.setEndReason(sessionId, "crashed").catch(() => undefined);
      if (options.parentSessionId) {
        treeLog.warn(`abort skill=${skillId} run=${sessionId} parent=${options.parentSessionId} reason=${failureReason} err=${errMsg} durationMs=${durationMs}`);
      }
      if (skillId === "council" || config.skillId === "council") {
        councilLog.error(`abort skill=${skillId} run=${sessionId} err=${errMsg} durationMs=${durationMs}`);
      }

      await persistCrashMessage(sessionId, errMsg, "Skill run failed").catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to persist crash message: ${e instanceof Error ? e.message : String(e)}`);
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

    storage.updateSkillRunStatus(sessionId, "failed", durationMs, `${failureReason}: ${errMsg}`).catch((e: unknown) => {
      logger.error(`[SkillChat] [${sessionId}] Failed to update skill_runs status after crash: ${e instanceof Error ? e.message : String(e)}`);
    });

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
    if (didRegisterActiveRun && skillId) activeSkillRuns.delete(skillId);
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
  options: { preContext?: string; parentSessionId?: string; spawnReason?: string; spawnerTool?: string; spawnerSkillRun?: string; modelOverride?: string; sessionKeyOverride?: string; admissionTier?: AdmissionTier; lineageId?: string }
): Promise<AutonomousRunResult> {
  const startTime = Date.now();
  const abortController = new AbortController();
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
      const skillProcessText = await getSkillProcess(promptId);
      instructions = `[SKILL — ${config.label}]\n\n${skillProcessText}`;
      if (options.preContext) {
        instructions = `[SKILL — ${config.label}]\n\n${options.preContext}\n\n${skillProcessText}`;
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
    const { tools, toolExecutor } = getSkillTools(config.activity, sessionKey, sessionId);

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
      }),
      abortController.signal,
      15_000,
      `skill_pipeline_${config.skillId}`,
    );

    const durationMs = Date.now() - startTime;
    const content = result.content?.trim() || "";

    if (result.status === "yielded") {
      logger.log(`[SkillChat] [${sessionId}] Skill run yielded to interactive session — deferring`);
      return { sessionId, status: "yielded", summary: "Yielded to interactive session", durationMs };
    }

    if (result.status === "failed") {
      const abortSummary = formatAbortDetails(result.abortDetails);
      const errorMsg = abortSummary || [result.error, result.abortReason, result.terminationReason]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .join(": ") || "Unknown error";
      await persistExecutorResult(sessionId, result, describeExecutorFailure(result), true).catch((e: unknown) => {
        logger.error(`[SkillChat] [${sessionId}] Failed to persist error result: ${e instanceof Error ? e.message : String(e)}`);
      });
      logger.warn(`[SkillChat] [${sessionId}] Skill failed: ${errorMsg} (${durationMs}ms, ${toolCallCount} tool calls)`);
      return { sessionId, status: "failed", error: errorMsg, durationMs };
    }

    await persistExecutorResult(sessionId, result, "Skill run completed.").catch((e: unknown) => {
      logger.error(`[SkillChat] [${sessionId}] Failed to persist success result: ${e instanceof Error ? e.message : String(e)}`);
    });

    if (isAnnualReflectRun(config, options.preContext) && content) {
      try {
        const { saveJournalToLibrary } = await import("./thoughts");
        const { stripLeadingProse } = await import("./temporal-log");
        const today = new Date().toISOString().split("T")[0];
        await saveJournalToLibrary(
          stripLeadingProse(content),
          `${today} — Annual Reflection`,
          ["annual-reflection", "identity"],
          "annual-reflections",
        );
      } catch (journalErr: unknown) {
        logger.error(`[SkillChat] [${sessionId}] JOURNAL SAVE FAILED for annual reflect: ${journalErr instanceof Error ? journalErr.message : String(journalErr)}`);
      }
    }

    if (content) {
      try {
        if (isAnnualReflectRun(config, options.preContext)) {
          const { writeAnnualTemporalLayers } = await import("./temporal-log");
          await writeAnnualTemporalLayers(content);
        }
      } catch (tlErr: unknown) {
        logger.error(`[SkillChat] [${sessionId}] Temporal log write failed for ${config.skillId}: ${tlErr instanceof Error ? tlErr.message : String(tlErr)}`);
      }
    }

    if (config.postRunVerify) {
      if (isAgentType(config.sessionType)) {
        logger.log(`[SkillChat] [${sessionId}] Deferring postRunVerify for Agent session — will run when session completes`);
        deferredPostRunVerify.set(sessionId, { toolCalls: toolCallLog, verifyFn: config.postRunVerify });
      } else {
        try {
          await config.postRunVerify(sessionId, toolCallLog);
        } catch (verifyErr: unknown) {
          logger.error(`[SkillChat] [${sessionId}] postRunVerify failed: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`);
        }
      }
    }

    logger.log(`[SkillChat] [${sessionId}] Skill completed: ${config.label} in ${durationMs}ms, ${toolCallCount} tool calls`);
    return { sessionId, status: "succeeded", summary: content.slice(0, 2000), durationMs };

  } finally {
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
    });
    systemPrompt = contextBuilder.renderToPrompt(spine);
  } catch (err) {
    logger.warn(`[triggerResponse] [${sessionId}] context build failed, using minimal prompt: ${err instanceof Error ? err.message : String(err)}`);
    systemPrompt = "You are Agent, a synthetic intelligence assistant. Respond to the messages in this session.";
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

  const { tools, toolExecutor } = getSkillTools(ACTIVITY_WORK, sessionKey, sessionId);

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
    });

    if (result.status === "failed") {
      finalStatus = "failed";
      finalSummary = result.error || describeExecutorFailure(result);
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
    const childFinalStatus = finalStatus === "succeeded" ? "saved" : "failed";
    await chatFileStorage.updateSessionStatus(sessionId, childFinalStatus).catch((e: unknown) => {
      logger.error(`[triggerResponse] [${sessionId}] Failed to set final status to ${childFinalStatus}: ${e instanceof Error ? e.message : String(e)}`);
    });
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
