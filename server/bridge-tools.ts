import { readFile, readdir, mkdir } from "fs/promises";
import { join, resolve, relative, basename, dirname } from "path";
import type { SQL } from "drizzle-orm";
import { recordToolCallStart, recordToolCallEnd } from "./file-storage";
import { MIME_MAP } from "./lib/mime";
import { getInstanceName } from "@shared/instance-config";
import { objectStorageService } from "./object_storage";
import { ObjectPermission, setObjectAclPolicy } from "./object_storage/objectAcl";
import {
  checkGmailPermission,
  createGmailHandler,
  type GmailSubHandler,
} from "./tools/handlers/gmail-boundary";
import { createGmailReadHandlers } from "./tools/handlers/gmail-read";
import { gmailDraftHandlers } from "./tools/handlers/gmail-drafts";
import { createGmailProviderHandlers } from "./tools/handlers/gmail-provider";
import { handleGmailTriageLog } from "./tools/handlers/gmail-triage";
import { handleGmailPipelineAction } from "./tools/handlers/gmail-pipeline";
import { handleGmailMailboxRead } from "./tools/handlers/gmail-mailbox-read";
import { handleGmailMailboxWrite } from "./tools/handlers/gmail-mailbox-write";
import { strategyCoreHandlers, type StrategySubHandler } from "./tools/handlers/strategy-core";
import { strategyStateHandlers } from "./tools/handlers/strategy-state";
import { strategyMoveMutationHandlers } from "./tools/handlers/strategy-move-mutations";
import { strategyMoveReadHandlers } from "./tools/handlers/strategy-move-reads";
import { strategyEvaluationHandlers } from "./tools/handlers/strategy-evaluation";
import { strategySupportHandlers } from "./tools/handlers/strategy-support";
import { strategyAssumptionHandlers } from "./tools/handlers/strategy-assumptions";
import { strategyArtifactHandlers } from "./tools/handlers/strategy-artifacts";
export { handleGmailDraftFromReview } from "./tools/handlers/gmail-drafts";
export { diagnoseGmailBatchRead } from "./tools/handlers/gmail-provider";
import { isSimilarText } from "./utils/text-similarity";
import { safeStringify } from "./utils/safe-stringify";
import { eventBus } from "./event-bus";
import { ACTIVITY_CHAT, ACTIVITY_FRAMING, type ActivityId } from "./job-profiles";
import { semanticTierSchema, type SemanticTier } from "@shared/model-connectors";
import { formatTaskForBridge } from "./lib/task-format";
import { WORKSPACE_DIR } from "./paths";
import { pathExists, resolveWorkspacePath } from "./fs-utils";
import {
  scratchEditFailure,
  authorityDenialFailure,
  toolFailureFromError,
  classifyGitError,
  classifyGitHubApiStatus,
  inputFailure,
  internalFailure,
  permissionFailure,
  transientFailure,
  type ToolFailure,
} from "./tool-failure";
import { extractToolFailureKind, inferFailureKind } from "@shared/tool-failure";
import { COGNITION_ACTION_TOOL_ALIASES, resolveRegisteredTool } from "./tool-registry";
import { prepareToolInvocation } from "./tools/invocation";
import { assertRegisteredToolHandlers } from "./tools/registry-validation";
import { composeToolDomainHandlers } from "./tools/domain-adapters";
import { buildExecutionHandlers } from "./tools/handlers/build-execution";
import { classifyFilesToolError, persistentFileHandlers } from "./tools/handlers/files";
import { workspaceTools } from "./tools/handlers/workspace";
import { webTools } from "./tools/handlers/web";
import { codeIntelTools } from "./tools/handlers/code-intel";
import { memoryTools } from "./tools/handlers/memory";
import { phoneCallHandler } from "./tools/handlers/phone";
import { contractReject } from "./tools/shared/failures";
import { peopleReadHandlers } from "./tools/handlers/people-read";
import { peopleRelationshipHandlers } from "./tools/handlers/people-relationships";
import { peopleInteractionHandlers } from "./tools/handlers/people-interactions";
import { peopleMutationHandlers } from "./tools/handlers/people-mutations";
import { peopleImportHandlers } from "./tools/handlers/people-imports";
import { companiesHandler } from "./tools/handlers/companies";
import { twitterHandler } from "./tools/handlers/twitter";
import { notionHandler } from "./tools/handlers/notion";
import { decisionsHandler } from "./tools/handlers/decisions";
import type {
  ToolExecutionResult as ToolResult,
  ToolHandler,
  ToolHandlerResult,
  ToolInvocationContext as BridgeToolContext,
} from "./tools/contracts";
import { sensitiveOwnershipValues } from "./sensitive-scope";
import { visibleFinanceForCurrentPrincipal } from "./finance-scope";
// Priority handling delegated to GoalsService

import { createLogger } from "./log";

const toolExec = createLogger("ToolExec");

async function isSpecSkillSession(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    const session = await chatFileStorage.getSession(sessionId);
    if (!session) return false;
    const values = [
      session.sessionKey,
      session.triggerId,
      session.spawnReason,
      session.spawnerSkillRun,
    ]
      .filter((value): value is string => typeof value === "string")
      .map(value => value.toLowerCase());

    return values.some(value =>
      value === "auto:spec" ||
      value === "spec" ||
      value === "skill:spec" ||
      value.includes(":spec")
    );
  } catch (err: unknown) {
    toolExec.warn(`Spec skill session guard lookup failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function normalizeSkillIdentifier(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isSpecChildSpawnRequest(...values: unknown[]): boolean {
  return values
    .map(value => String(value ?? "").trim().toLowerCase())
    .filter(Boolean)
    .some(value =>
      value === "spec" ||
      value === "skill:spec" ||
      /(^|[^a-z0-9])spec([^a-z0-9]|$)/.test(value) ||
      value.includes("spec skill") ||
      value.includes("run spec") ||
      value.includes("skills.run") && value.includes("spec")
    );
}

export type {
  ToolExecutionResult as ToolResult,
  ToolHandler,
  ToolHandlerResult,
  ToolInvocationContext as BridgeToolContext,
} from "./tools/contracts";



/**
 * Classify system-tool caught errors. Schema gaps and runtime defects are
 * internal; only leave truly untyped surprises unclassified.
 */
function classifySystemToolError(err: unknown): ToolFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (
    /^(?:Invalid history rollup |History rollup summary must contain |History rollup candidate is no longer current|History rollup source entries changed; list candidates again)/i.test(message)
  ) {
    return inputFailure("system_input_invalid", message.slice(0, 160));
  }
  if (
    /pgCode=42P01|undefined_table|relation .* does not exist/i.test(message)
  ) {
    return internalFailure("system_schema_missing", message.slice(0, 160));
  }
  if (/is not defined|Cannot read propert|TypeError|ReferenceError/i.test(message)) {
    return internalFailure("system_internal_error", message.slice(0, 160));
  }
  return internalFailure("system_internal_error", message.slice(0, 160));
}

type TaskAssignmentToolPatch = {
  assigneeSubjectType: "user" | "invited_subject";
  assigneeSubjectId: string;
};

function taskAssignmentFromToolArgs(
  args: Record<string, any>,
): { assignment?: TaskAssignmentToolPatch; error?: string } {
  const rawId = args.assigneeSubjectId;
  const normalizedId = typeof rawId === "string" ? rawId.trim() : "";
  if (!normalizedId || normalizedId === "__omit__") return {};

  const rawType = args.assigneeSubjectType;
  const normalizedType = typeof rawType === "string" ? rawType.trim() : "";
  if (normalizedType !== "user" && normalizedType !== "invited_subject") {
    return { error: "Task assignment requires assigneeSubjectType when assigneeSubjectId is provided" };
  }

  return {
    assignment: {
      assigneeSubjectType: normalizedType,
      assigneeSubjectId: normalizedId,
    },
  };
}

/**
 * Write-boundary validation for deterministic checklist items. The checklist
 * is the single quality-specification surface; tool references inside it must
 * name real registry tools, or a typo would silently degrade every future run.
 * Returns an error message, or null when valid.
 */
async function validateChecklistToolRefs(checklist: unknown): Promise<string | null> {
  if (!Array.isArray(checklist)) return null;
  const deterministic = checklist.filter(
    (item): item is { check?: unknown; kind?: unknown; tool?: unknown; action?: unknown } =>
      !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "tool_invoked",
  );
  const childSkills = checklist.filter(
    (item): item is { check?: unknown; kind?: unknown; skill?: unknown } =>
      !!item && typeof item === "object" && (item as { kind?: unknown }).kind === "child_skill_invoked",
  );
  const missingChildSkills = childSkills.filter((item) => typeof item.skill !== "string" || item.skill.trim().length === 0);
  if (missingChildSkills.length > 0) {
    return `Checklist items with kind "child_skill_invoked" require a skill name (${missingChildSkills.length} item(s) missing one).`;
  }
  if (deterministic.length === 0) return null;
  const missing = deterministic.filter((item) => typeof item.tool !== "string" || item.tool.trim().length === 0);
  if (missing.length > 0) {
    return `Checklist items with kind "tool_invoked" require a tool name (${missing.length} item(s) missing one).`;
  }
  const { getBridgeToolNames } = await import("./tool-registry");
  const known = await getBridgeToolNames();
  const unknown = deterministic
    .map((item) => (item.tool as string).trim())
    .filter((tool) => !known.has(tool));
  if (unknown.length > 0) {
    return `Unknown tool name(s) in deterministic checklist items: ${unknown.join(", ")}. Use tools(action=list) for valid names.`;
  }
  const { getToolSchemas } = await import("./tool-registry");
  const schemas = new Map(getToolSchemas().map((schema) => [schema.name, schema]));
  const invalidActions = deterministic.flatMap((item) => {
    if (item.action === undefined) return [];
    if (typeof item.action !== "string" || !item.action.trim()) {
      return [`${String(item.tool)}:(missing action)`];
    }
    const tool = (item.tool as string).trim();
    const action = item.action.trim();
    const actionSchema = schemas.get(tool)?.parameters?.properties?.action;
    return Array.isArray(actionSchema?.enum) && actionSchema.enum.includes(action)
      ? []
      : [`${tool}:${action}`];
  });
  if (invalidActions.length > 0) {
    return `Unknown tool action(s) in deterministic checklist items: ${invalidActions.join(", ")}. Use tools(action=get) for valid actions.`;
  }
  return null;
}

function normalizeScoreThreshold(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function formatChecklistForXyz(checklist: unknown): string {
  if (!Array.isArray(checklist) || checklist.length === 0) {
    return "Checklist: (no structured checklist defined — scorer will fall back to default checks)";
  }
  const lines = checklist.map((item: unknown, i: number) => {
    const obj = (item ?? {}) as { check?: unknown; weight?: unknown; kind?: unknown; tool?: unknown; action?: unknown; skill?: unknown };
    const text = typeof obj.check === "string" ? obj.check : JSON.stringify(item);
    const weight = typeof obj.weight === "number" ? obj.weight : 1;
    const deterministic = obj.kind === "tool_invoked" && typeof obj.tool === "string"
      ? `, requires:${obj.tool}${typeof obj.action === "string" ? `:${obj.action}` : ""}`
      : obj.kind === "child_skill_invoked" && typeof obj.skill === "string"
        ? `, requires-child-skill:${obj.skill}`
        : "";
    return `${i + 1}. ${text} (w:${weight}${deterministic})`;
  });
  return `Checklist (${checklist.length} weighted items used by the scorer):\n${lines.join("\n")}`;
}

async function safeInvalidateCalendarCache(source: string): Promise<void> {
  try {
    const { invalidateCalendarCache } = await import("./context-builder");
    invalidateCalendarCache();
  } catch (e: any) {
    toolExec.warn(`Failed to invalidate calendar cache after ${source}: ${e?.message}`);
  }
}



const peopleSubHandlers: Record<string, (args: Record<string, any>) => Promise<ToolHandlerResult>> = {
  ...peopleReadHandlers,
  ...peopleInteractionHandlers,
  ...peopleRelationshipHandlers,
  ...peopleMutationHandlers,
  ...peopleImportHandlers,
};

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePayload {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePayload[];
  filename?: string;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePayload;
  [key: string]: unknown;
}

function extractHeaders(msg: GmailMessage): { from: string; subject: string; date: string; headers: GmailHeader[] } {
  const headers = msg.payload?.headers || [];
  return {
    from: headers.find(h => h.name === 'From')?.value || 'Unknown',
    subject: headers.find(h => h.name === 'Subject')?.value || '(no subject)',
    date: headers.find(h => h.name === 'Date')?.value || '',
    headers,
  };
}

function formatMessageLine(msg: GmailMessage, messageId: string, acctId: string, acctLabel?: string): string {
  const { from, subject, date } = extractHeaders(msg);
  const tag = acctLabel ? `[${acctLabel}] ` : '';
  return `- ${tag}**${subject}** from ${from} (${date}) [id:${messageId}|acct:${acctId}]`;
}

interface GmailAccountTarget { id: string; label: string }

function resolveTargetAccounts(
  resolvedAccountId: string | undefined,
  accounts: GmailAccountTarget[],
): GmailAccountTarget[] {
  if (accounts.length === 0) {
    return [];
  }
  if (resolvedAccountId) {
    const acct = accounts.find(a => a.id === resolvedAccountId);
    if (!acct) {
      toolExec.error(`resolveTargetAccounts: specified account ${resolvedAccountId} not found in ${accounts.length} connected accounts`);
      return [];
    }
    return [acct];
  }
  if (accounts.length <= 1) {
    return [accounts[0]];
  }
  return accounts;
}

interface ListMultiAccountOptions {
  paginate?: boolean;
  paginationCap?: number;
}


async function listMessagesMultiAccount(
  query: string | undefined,
  maxResults: number,
  targetAccounts: GmailAccountTarget[],
  caller: string,
  options?: ListMultiAccountOptions,
): Promise<{ stubs: Array<{ id: string; acctId: string; acctLabel: string }>; errors: string[] }> {
  const { listMessages } = await import("./gmail");
  const { createLogger } = await import("./log");
  const log = createLogger(`BridgeTools:${caller}`);
  const stubs: Array<{ id: string; acctId: string; acctLabel: string }> = [];
  const errors: string[] = [];
  for (const acct of targetAccounts) {
    try {
      const results = await listMessages(query, maxResults, acct.id, {
        paginate: options?.paginate,
        paginationCap: options?.paginationCap,
      });
      log.debug(`list acct=${acct.id} query="${query || '(none)'}" results=${results.length}`);
      for (const s of results) {
        if (s.id) stubs.push({ id: s.id as string, acctId: acct.id, acctLabel: acct.label });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`list FAILED for account "${acct.label}" (${acct.id}): ${errMsg}`);
      errors.push(`Account "${acct.label}" (${acct.id}): ${errMsg}`);
    }
  }

  return { stubs, errors };
}

function formatListErrors(errors: string[], fallbackMessage: string, expectData = false): ToolHandlerResult {
  if (errors.length > 0) {
    return {
      result: `Gmail API errors prevented fetching messages:\n${errors.join("\n")}\n\nThis likely means the account tokens need to be refreshed. The user should re-authorize the Gmail accounts in Settings → Connections.`,
      error: true,
    };
  }
  return { result: fallbackMessage, ...(expectData ? { error: true } : {}) };
}

function findTextBody(payload: GmailMessagePayload | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = findTextBody(part);
      if (text) return text;
    }
  }
  return '';
}

interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

function findAttachments(payload: GmailMessagePayload | undefined): GmailAttachment[] {
  if (!payload) return [];
  const attachments: GmailAttachment[] = [];
  function walk(part: GmailMessagePayload) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  if (payload.parts) payload.parts.forEach(walk);
  return attachments;
}

async function handleGmailEmailCache(args: Record<string, any>): Promise<ToolHandlerResult> {
  const result = await handleGmailMailboxRead(args)
    ?? await handleGmailMailboxWrite(args)
    ?? await handleGmailPipelineAction(args);
  if (result) return result;
  const subAction = args.cache_action || "get_untriaged";

  return { result: `Unknown cache_action "${subAction}". Use "get_untriaged", "mark_triaged", "get_unenriched", "store_enrichment", "search", "sync_status", "pipeline_counts", "get_message", "diagnose", or "run_downstream".`, error: true };
}

const gmailSharedDependencies = {
  resolveTargetAccounts,
  listMessagesMultiAccount,
  formatListErrors,
  extractHeaders,
  findTextBody,
};

const gmailReadHandlers = createGmailReadHandlers({
  ...gmailSharedDependencies,
  formatMessageLine,
  findAttachments,
  logReadFallback: (accountId, error) => toolExec.debug("gmail read account fallback", accountId, error),
});

const gmailProviderHandlers = createGmailProviderHandlers(gmailSharedDependencies);

const gmailSubHandlers: Record<string, GmailSubHandler> = {
  ...gmailReadHandlers,
  ...gmailProviderHandlers,
  ...gmailDraftHandlers,
  triage_log: handleGmailTriageLog,
  email_cache: handleGmailEmailCache,
};

const gmailHandler = createGmailHandler(gmailSubHandlers);

const STRATEGY_ACTIONS = "list_scenarios, get_scenario, create_scenario, update_scenario, delete_scenario, list_actors, get_actor, add_actor, update_actor, remove_actor, get_move_tree, get_move, get_move_path, create_move, update_move, delete_move, reparent_move, list_child_moves, list_move_definitions, get_move_definition, create_move_definition, update_move_definition, delete_move_definition, set_actor_states, link_assumption_to_move, unlink_assumption_from_move, list_notes, add_note, update_note, delete_note, list_context, add_context, update_context, delete_context, add_end_condition, list_end_conditions, update_end_condition, delete_end_condition, add_assumption, list_assumptions, update_assumption, delete_assumption, cascade_assumption, list_artifacts, get_artifact, create_artifact, delete_artifact, evaluate_move, list_states, get_state, create_state, update_state, delete_state, set_end_condition_effect";

const strategySubHandlers: Record<string, StrategySubHandler> = {
  ...strategyCoreHandlers,
  ...strategyStateHandlers,
  ...strategyMoveMutationHandlers,
  ...strategyMoveReadHandlers,
  ...strategyEvaluationHandlers,
  ...strategySupportHandlers,
  ...strategyAssumptionHandlers,
  ...strategyArtifactHandlers,
};

export interface CrossSessionDeps {
  storage: import("./chat-file-storage").IChatFileStorage;
  publishEvent?: (
    sessionKey: string,
    payload: {
      type: "cross_session_message";
      sessionId: string;
      fromSessionId: string;
      toSessionId: string;
      direction: "sibling" | "parent" | "child" | "direct";
      content: string;
      chainId: string;
      depth: number;
    },
  ) => void;
}

export async function handleCrossSessionMessage(
  args: Record<string, any>,
  direction: "sibling" | "parent" | "child",
  depsOverride?: CrossSessionDeps,
): Promise<ToolHandlerResult> {
  const fromSessionId: string | undefined = args._sessionId;
  const content: string = (args.content ?? "").toString();
  if (!fromSessionId) {
    return contractReject("No active session — cross-session messaging requires an active conversation context.", "session_input_invalid");
  }
  if (!content.trim()) {
    return contractReject("Missing 'content' — message body cannot be empty.", "session_input_invalid");
  }

  const storage = depsOverride?.storage || (await import("./chat-file-storage")).chatFileStorage;
  const {
    buildSessionFetcher,
    buildChildrenFetcher,
    buildRecentInboundFetcher,
    validateCrossSessionScope,
    resolveSiblingBySpawnReason,
    nextChainToken,
  } = await import("./session-tree");

  const sessFetch = buildSessionFetcher(storage);
  const childrenFetch = buildChildrenFetcher(storage);
  const inboundFetch = buildRecentInboundFetcher(storage);

  const caller = await sessFetch(fromSessionId);
  if (!caller) {
    return contractReject(`Caller session ${fromSessionId} not found.`, "session_input_invalid");
  }

  let target: { id: string; parentSessionId?: string; sessionKey?: string | null; title?: string } | undefined;

  if (direction === "parent") {
    if (!caller.parentSessionId) {
      toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} direction=parent reason=no_parent`);
      return contractReject("This session has no parent to message.", "session_input_invalid");
    }
    target = await sessFetch(caller.parentSessionId);
    if (!target) {
      return contractReject(`Parent session ${caller.parentSessionId} not found.`, "session_input_invalid");
    }
  } else if (direction === "child") {
    const toSessionId: string | undefined = args.toSessionId;
    const toSpawnReason: string | undefined = args.toSpawnReason;
    if (!toSessionId && !toSpawnReason) {
      return contractReject("Missing target — provide 'toSessionId' or 'toSpawnReason' to identify the child.", "session_input_invalid");
    }
    if (toSessionId) {
      target = await sessFetch(toSessionId);
      if (!target) {
        return contractReject(`Target session ${toSessionId} not found.`, "session_input_invalid");
      }
    } else if (toSpawnReason) {
      // Resolve a child of the caller by spawn reason. Reuse
      // `resolveSiblingBySpawnReason` semantics by walking the caller's own
      // children directly (not siblings).
      const reason = toSpawnReason.trim();
      const children = await childrenFetch(fromSessionId);
      const exact = children.find(s => s.id !== fromSessionId && s.spawnReason === reason);
      let matched = exact;
      if (!matched) {
        matched = children.find(s => {
          if (s.id === fromSessionId) return false;
          if (s.spawnReason) return false;
          if (s.title === reason) return true;
          if (s.sessionKey === reason) return true;
          if (s.sessionKey === `auto:${reason}`) return true;
          return false;
        });
      }
      if (!matched) {
        toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} direction=child reason=spawn_reason_not_found spawnReason=${toSpawnReason}`);
        return contractReject(`No child session matched spawn reason "${toSpawnReason}".`, "session_input_invalid");
      }
      target = matched;
    }
  } else {
    const toSessionId: string | undefined = args.toSessionId;
    const toSpawnReason: string | undefined = args.toSpawnReason;
    if (!toSessionId && !toSpawnReason) {
      return contractReject("Missing target — provide 'toSessionId' or 'toSpawnReason'.", "session_input_invalid");
    }
    if (toSessionId) {
      target = await sessFetch(toSessionId);
      if (!target) {
        return contractReject(`Target session ${toSessionId} not found.`, "session_input_invalid");
      }
    } else if (toSpawnReason) {
      target = await resolveSiblingBySpawnReason(caller, toSpawnReason, childrenFetch);
      if (!target) {
        toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} direction=sibling reason=spawn_reason_not_found spawnReason=${toSpawnReason}`);
        return contractReject(`No sibling session matched spawn reason "${toSpawnReason}".`, "session_input_invalid");
      }
    }
  }

  if (!target) {
    return contractReject("Could not resolve target session.", "session_input_invalid");
  }

  const scope = validateCrossSessionScope(caller, target, direction);
  if (!scope.ok) {
    toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} to=${target.id} direction=${direction} reason=${scope.reason}`);
    return contractReject(`Scope rejected: ${scope.reason}`, "session_input_invalid");
  }

  const recentInbound = await inboundFetch(fromSessionId);
  const chain = nextChainToken(recentInbound);
  if (!chain.ok) {
    toolExec.warn(
      `[CrossSessionMsg] event=chain-cap-abort from=${fromSessionId} fromRunId=${caller.spawnerSkillRun || "-"} to=${target.id} toRunId=${target.spawnerSkillRun || "-"} direction=${direction} chainId=${chain.chainId} depth=${chain.depth} cap=${chain.cap}`,
    );
    return contractReject(chain.reason, "session_input_invalid");
  }

  const { fromMessage, toMessage } = await storage.createCrossSessionMessage(
    fromSessionId,
    target.id,
    content,
    direction,
    { chainId: chain.chainId, depth: chain.depth },
  );

  const fromRunId = caller.spawnerSkillRun || "-";
  const toRunId = target.spawnerSkillRun || "-";
  toolExec.log(
    `[CrossSessionMsg] event=sent from=${fromSessionId} fromRunId=${fromRunId} to=${target.id} toRunId=${toRunId} direction=${direction} chainId=${chain.chainId} depth=${chain.depth} cap=${chain.cap} fromMsgId=${fromMessage?.id || "?"} contentLen=${content.length}`,
  );
  toolExec.log(
    `[CrossSessionMsg] event=receive sessionId=${target.id} runId=${toRunId} from=${fromSessionId} fromRunId=${fromRunId} direction=${direction} chainId=${chain.chainId} depth=${chain.depth} toMsgId=${toMessage?.id || "?"} contentLen=${content.length}`,
  );

  const publish =
    depsOverride?.publishEvent ||
    ((sessionKey: string, payload: any) => {
      eventBus.publish({
        category: "chat",
        event: "chat.cross_session_message",
        sessionKey,
        payload,
      });
    });

  try {
    const fromConv = await storage.getSession(fromSessionId);
    const toConv = await storage.getSession(target.id);
    const basePayload = {
      type: "cross_session_message" as const,
      fromSessionId,
      toSessionId: target.id,
      direction,
      content,
      chainId: chain.chainId,
      depth: chain.depth,
      fromLabel: fromConv?.title,
      toLabel: toConv?.title,
    };
    publish(fromConv?.sessionKey || `dashboard:${fromSessionId}`, { ...basePayload, sessionId: fromSessionId });
    if (target.id !== fromSessionId) {
      publish(toConv?.sessionKey || `dashboard:${target.id}`, { ...basePayload, sessionId: target.id });
    }
  } catch (e: any) {
    toolExec.warn(`[CrossSessionMsg] event publish failed: ${e?.message || e}`);
  }

  // When messaging a child session, trigger an agent run if none is active.
  // This uses the same execution path as spawn_child auto-start so child
  // sessions have one source of truth for response activation.
  if (direction === "child") {
    await triggerChildSessionResponse(target.id, "CrossSessionMsg");
  }

  return { result: `Sent ${direction} message to ${target.title || target.id} (${target.id}). Chain depth ${chain.depth}/${chain.cap}.` };
}


export async function handleAnySessionMessage(
  args: Record<string, any>,
  depsOverride?: CrossSessionDeps,
): Promise<ToolHandlerResult> {
  const fromSessionId: string | undefined = args._sessionId;
  const toSessionId: string | undefined = (args.toSessionId || args.sessionId)?.toString().trim();
  const content: string = (args.content ?? args.message ?? "").toString();

  if (!fromSessionId) {
    return contractReject("No active session — session messaging requires an active conversation context.", "session_input_invalid");
  }
  if (!toSessionId) {
    return contractReject("Missing target — provide 'sessionId' or 'toSessionId'.", "session_input_invalid");
  }
  if (!content.trim()) {
    return contractReject("Missing 'content' — message body cannot be empty.", "session_input_invalid");
  }
  if (toSessionId === fromSessionId) {
    return contractReject("Cannot message self.", "session_input_invalid");
  }

  const storage = depsOverride?.storage || (await import("./chat-file-storage")).chatFileStorage;
  const { buildSessionFetcher, buildRecentInboundFetcher, nextChainToken } = await import("./session-tree");
  const sessFetch = buildSessionFetcher(storage);
  const inboundFetch = buildRecentInboundFetcher(storage);

  const [caller, target] = await Promise.all([sessFetch(fromSessionId), sessFetch(toSessionId)]);
  if (!caller) {
    return contractReject(`Caller session ${fromSessionId} not found.`, "session_input_invalid");
  }
  if (!target) {
    return contractReject(`Target session ${toSessionId} not found.`, "session_input_invalid");
  }

  const { validateCrossSessionScope } = await import("./session-tree");
  const directions: Array<"parent" | "child" | "sibling"> = ["parent", "child", "sibling"];
  const scopedDirection = directions.find(direction => validateCrossSessionScope(caller, target, direction).ok);
  if (!scopedDirection) {
    toolExec.warn(`[CrossSessionMsg] event=scope-reject from=${fromSessionId} to=${target.id} direction=direct reason=not_direct_relative`);
    return contractReject("Direct session messaging is limited to a parent, child, or sibling in the same session tree.", "session_input_invalid");
  }

  const recentInbound = await inboundFetch(fromSessionId);
  const chain = nextChainToken(recentInbound);
  if (!chain.ok) {
    toolExec.warn(
      `[CrossSessionMsg] event=chain-cap-abort from=${fromSessionId} fromRunId=${caller.spawnerSkillRun || "-"} to=${target.id} toRunId=${target.spawnerSkillRun || "-"} direction=direct chainId=${chain.chainId} depth=${chain.depth} cap=${chain.cap}`,
    );
    return contractReject(chain.reason, "session_input_invalid");
  }

  const { fromMessage, toMessage } = await storage.createCrossSessionMessage(
    fromSessionId,
    target.id,
    content,
    "direct",
    { chainId: chain.chainId, depth: chain.depth },
  );

  const fromRunId = caller.spawnerSkillRun || "-";
  const toRunId = target.spawnerSkillRun || "-";
  toolExec.log(
    `[CrossSessionMsg] event=sent from=${fromSessionId} fromRunId=${fromRunId} to=${target.id} toRunId=${toRunId} direction=direct chainId=${chain.chainId} depth=${chain.depth} cap=${chain.cap} fromMsgId=${fromMessage?.id || "?"} contentLen=${content.length}`,
  );
  toolExec.log(
    `[CrossSessionMsg] event=receive sessionId=${target.id} runId=${toRunId} from=${fromSessionId} fromRunId=${fromRunId} direction=direct chainId=${chain.chainId} depth=${chain.depth} toMsgId=${toMessage?.id || "?"} contentLen=${content.length}`,
  );

  const publish =
    depsOverride?.publishEvent ||
    ((sessionKey: string, payload: any) => {
      eventBus.publish({
        category: "chat",
        event: "chat.cross_session_message",
        sessionKey,
        payload,
      });
    });

  try {
    const fromConv = await storage.getSession(fromSessionId);
    const toConv = await storage.getSession(target.id);
    const basePayload = {
      type: "cross_session_message" as const,
      fromSessionId,
      toSessionId: target.id,
      direction: "direct" as const,
      content,
      chainId: chain.chainId,
      depth: chain.depth,
      fromLabel: fromConv?.title,
      toLabel: toConv?.title,
    };
    publish(fromConv?.sessionKey || `dashboard:${fromSessionId}`, { ...basePayload, sessionId: fromSessionId });
    publish(toConv?.sessionKey || `dashboard:${target.id}`, { ...basePayload, sessionId: target.id });
  } catch (e: any) {
    toolExec.warn(`[CrossSessionMsg] direct event publish failed: ${e?.message || e}`);
  }

  await triggerChildSessionResponse(target.id, "session.send_message");

  return { result: `Sent direct message to ${target.title || target.id} (${target.id}). Chain depth ${chain.depth}/${chain.cap}.` };
}

export async function triggerChildSessionResponse(childSessionId: string, source: string): Promise<void> {
  try {
    const { triggerResponseOnChildSession } = await import("./autonomous-skill-runner");
    // Fire-and-forget: don't block the parent's tool return on the child run.
    // triggerResponseOnChildSession is idempotent via agentExecutor.hasActiveRunForSession.
    void triggerResponseOnChildSession(childSessionId).catch((err: unknown) => {
      toolExec.warn(`[${source}] triggerResponseOnChildSession failed for ${childSessionId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (importErr: any) {
    toolExec.warn(`[${source}] failed to import triggerResponseOnChildSession: ${importErr?.message || importErr}`);
  }
}

async function buildFallbackBrief(opts: {
  parentSessionId: string;
  childTopic: string;
  reason?: string;
}): Promise<string> {
  const { chatFileStorage } = await import("./chat-file-storage");
  const parent = await chatFileStorage.getSession(opts.parentSessionId);
  const messages = await chatFileStorage.getMessagesBySession(opts.parentSessionId);
  const recent = messages.slice(-10).filter(m => m.role === "user" || m.role === "assistant");
  const transcript = recent
    .map(m => `[${m.role}]: ${(m.content || "").slice(0, 800)}`)
    .join("\n\n");
  const lines: string[] = [];
  lines.push(`# Warm-start brief from parent session`);
  lines.push("");
  lines.push(`## Parent`);
  lines.push(`- Title: ${parent?.title || "(untitled)"}`);
  lines.push(`- Session ID: ${opts.parentSessionId}`);
  if (parent?.topics && parent.topics.length > 0) {
    lines.push(`- Topics: ${parent.topics.join(", ")}`);
  }
  lines.push("");
  lines.push(`## Spawn`);
  lines.push(`- Child topic: ${opts.childTopic}`);
  if (opts.reason) lines.push(`- Reason: ${opts.reason}`);
  lines.push("");
  if (transcript) {
    lines.push(`## Recent transcript (last ${recent.length} messages)`);
    lines.push(transcript);
  }
  return lines.join("\n");
}

async function buildWarmStartBrief(opts: {
  parentSessionId: string;
  childTopic: string;
  reason?: string;
}): Promise<string> {
  const { chatFileStorage } = await import("./chat-file-storage");
  const parent = await chatFileStorage.getSession(opts.parentSessionId);
  const messages = await chatFileStorage.getMessagesBySession(opts.parentSessionId);
  const userAssistantMsgs = messages.filter(m => m.role === "user" || m.role === "assistant");
  const keepRecent = Math.min(6, Math.floor(userAssistantMsgs.length / 2));
  const olderMessages = keepRecent > 0 && userAssistantMsgs.length > keepRecent
    ? userAssistantMsgs.slice(0, -keepRecent)
    : userAssistantMsgs.slice(0, Math.max(0, userAssistantMsgs.length - keepRecent));

  const serializedAll = userAssistantMsgs
    .map(m => `[${m.role}]: ${(m.content || "").slice(0, 2000)}`)
    .join("\n\n");

  // 1) generateTitleSummaryTags over the entire transcript for title/summary/tags.
  let summaryBlock = "";
  let tagsBlock = "";
  if (serializedAll.length > 80) {
    try {
      const { generateTitleSummaryTags } = await import("./title-summary-tags");
      const tst = await generateTitleSummaryTags({
        content: serializedAll,
        source: `session:${opts.parentSessionId}`,
        title: parent?.title || null,
      });
      if (tst.summary) summaryBlock = tst.summary;
      const mergedTags = Array.from(new Set([...(parent?.topics ?? []), ...(tst.tags ?? [])]));
      if (mergedTags.length > 0) tagsBlock = mergedTags.join(", ");
    } catch (err: unknown) {
      toolExec.warn(`[buildWarmStartBrief] generateTitleSummaryTags failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!tagsBlock && parent?.topics && parent.topics.length > 0) {
    tagsBlock = parent.topics.join(", ");
  }

  // 2) chat-compactrunhistory-backed summarization for the older chunk.
  let condensedTranscript = "";
  if (olderMessages.length >= 4) {
    try {
      const { chatCompletion } = await import("./model-client");
      const { getPromptModulePromptEntry } = await import("./prompt-modules");
      const { ACTIVITY_FRAMING } = await import("./job-profiles");
      let systemMsg = "Summarize this conversation history concisely. Preserve key decisions, facts discussed, user requests, and any commitments made. Output a dense summary paragraph.";
      let maxTokens = 1500;
      try {
        const entry = await getPromptModulePromptEntry("chat-compactrunhistory", ACTIVITY_FRAMING);
        if (entry?.prompt) systemMsg = entry.prompt;
      } catch { /* keep defaults */ }
      const compactInput = olderMessages
        .map(m => `[${m.role}]: ${(m.content || "").length > 2000 ? m.content.slice(0, 2000) + "..." : m.content}`)
        .join("\n\n");
      const result = await chatCompletion({
        activity: ACTIVITY_FRAMING,
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: compactInput },
        ],
        maxTokens,
        metadata: { source: "warm-start-compaction", activity: ACTIVITY_FRAMING },
      });
      if (result?.content) condensedTranscript = result.content.trim();
    } catch (err: unknown) {
      toolExec.warn(`[buildWarmStartBrief] compactrunhistory summarization failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3) Recent verbatim tail.
  const recentTail = userAssistantMsgs
    .slice(-keepRecent)
    .map(m => `[${m.role}]: ${(m.content || "").slice(0, 1200)}`)
    .join("\n\n");

  const lines: string[] = [];
  lines.push(`# Warm-start brief from parent session`);
  lines.push("");
  lines.push(`## Parent`);
  lines.push(`- Title: ${parent?.title || "(untitled)"}`);
  lines.push(`- Session ID: ${opts.parentSessionId}`);
  if (tagsBlock) lines.push(`- Topics: ${tagsBlock}`);
  lines.push("");
  lines.push(`## Spawn`);
  lines.push(`- Child topic: ${opts.childTopic}`);
  if (opts.reason) lines.push(`- Reason: ${opts.reason}`);
  lines.push("");
  if (summaryBlock) {
    lines.push(`## Key decisions / summary`);
    lines.push(summaryBlock);
    lines.push("");
  }
  if (condensedTranscript) {
    lines.push(`## Condensed earlier transcript`);
    lines.push(condensedTranscript);
    lines.push("");
  }
  if (recentTail) {
    lines.push(`## Recent transcript tail`);
    lines.push(recentTail);
  }
  return lines.join("\n");
}

export const bridgeHandlers: Record<string, ToolHandler> = {

  async message_sibling(args) {
    return handleCrossSessionMessage(args, "sibling");
  },

  async message_parent(args) {
    return handleCrossSessionMessage(args, "parent");
  },

  async message_child(args) {
    return handleCrossSessionMessage(args, "child");
  },

  async agent_profile(args) {
    const { getCurrentPrincipal } = await import("./principal-context");
    const principal = getCurrentPrincipal();
    if (!principal?.userId) return { result: "No authenticated user context", error: true };

    const { agentProfiles } = await import("@shared/schema");
    const { db } = await import("./db");
    const { eq, sql } = await import("drizzle-orm");
    const profileWhere = principal.instanceId
      ? eq(agentProfiles.instanceId, principal.instanceId)
      : eq(agentProfiles.userId, principal.userId);

    const action = args.action;
    if (action === "get") {
      const [profile] = await db
        .select({ agentName: agentProfiles.agentName, metadata: agentProfiles.metadata, relationshipState: agentProfiles.relationshipState })
        .from(agentProfiles)
        .where(profileWhere)
        .limit(1);
      if (!profile) return { result: "No agent profile found", error: true };
      return { result: JSON.stringify(profile) };
    }

    if (action === "update") {
      const updates: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
      let updatedAgentName: string | undefined;
      if (args.agentName) {
        const name = String(args.agentName).trim().slice(0, 80);
        if (name.length < 1) return { result: "Agent name must be at least 1 character", error: true };
        updates.agentName = name;
        updatedAgentName = name;
      }
      if (args.metadata && typeof args.metadata === "object") {
        const [existing] = await db
          .select({ metadata: agentProfiles.metadata })
          .from(agentProfiles)
          .where(profileWhere)
          .limit(1);
        const merged = { ...(existing?.metadata as Record<string, unknown> || {}), ...args.metadata };
        updates.metadata = merged;
      }
      await db
        .update(agentProfiles)
        .set(updates)
        .where(profileWhere);
      eventBus.publish({
        category: "agent",
        event: "data:profiles_changed",
        payload: { source: "agent_profile_tool", userId: principal.userId },
      });
      if (updatedAgentName && principal.accountId) {
        const { ensureAgentLibraryRoot } = await import("./onboarding");
        await ensureAgentLibraryRoot({ ...principal, userId: principal.userId, accountId: principal.accountId }, updatedAgentName);
      }
      const [updated] = await db
        .select({ agentName: agentProfiles.agentName, metadata: agentProfiles.metadata })
        .from(agentProfiles)
        .where(profileWhere)
        .limit(1);
      return { result: `Agent profile updated: ${JSON.stringify(updated)}` };
    }

    return { result: `Unknown action: ${action}`, error: true };
  },

  async orient(args) {
    const sessionId = args._sessionId;
    if (!sessionId) {
      return {
        result: "No active session — orient tool requires an active conversation context.",
        error: true,
        failure: inputFailure("orient_no_session"),
      };
    }

    const hasTitle = args.title !== undefined;
    const hasTopics = args.topics !== undefined;
    const hasPersona = args.persona !== undefined;

    if (!hasTitle && !hasTopics && !hasPersona) {
      return { result: "No orientation parameters provided. Pass at least one of: title, topics, persona.", error: true };
    }

    const { chatFileStorage } = await import("./chat-file-storage");
    const { hasSessionTitle } = await import("./session-orientation");
    const existingSession = await chatFileStorage.getSession(sessionId);
    const alreadyTitled = hasSessionTitle(existingSession?.title);
    if (!alreadyTitled && (!hasTitle || !hasPersona)) {
      return {
        result: "First-turn orientation requires a title and a selectable persona. Use Companion when the opening has no job. Root is never a session seat.",
        error: true,
      };
    }

    // First-turn enforcement: a meaningful title and a selectable persona are
    // required. Title-only is not orientation. Root is never a session seat.

    let validatedTitle: string | undefined;
    if (hasTitle) {
      validatedTitle = args.title?.trim();
      if (!validatedTitle) return { result: "Title must not be empty", error: true };
      if (validatedTitle.split(/\s+/).length > 3) return { result: "Title must be 1-3 words", error: true };
    }

    let cleanedTopics: string[] | undefined;
    if (hasTopics) {
      if (!Array.isArray(args.topics)) return { result: `Expected 'topics' to be an array of strings, got ${args.topics === null ? "null" : typeof args.topics}`, error: true };
      cleanedTopics = args.topics.filter((t: unknown) => typeof t === "string" && t.trim()).map((t: string) => t.trim()).slice(0, 8);
    }

    let resolvedPersona: { id: number; name: string } | undefined;
    if (hasPersona) {
      const { personaStorage } = await import("./file-storage/persona-storage");
      const numId = Number(args.persona);
      if (!isNaN(numId) && String(numId) === String(args.persona)) {
        const p = await personaStorage.getById?.(numId) ?? (await personaStorage.list()).find(x => x.id === numId);
        if (!p) return { result: `Persona with id ${numId} not found`, error: true };
        if (p.isSystem) return { result: `${p.name} is not a selectable session seat`, error: true };
        resolvedPersona = { id: p.id, name: p.name };
      } else {
        const found = await personaStorage.getByName(args.persona);
        if (!found) return { result: `Persona "${args.persona}" not found`, error: true };
        if (found.isSystem) return { result: `${found.name} is not a selectable session seat`, error: true };
        resolvedPersona = { id: found.id, name: found.name };
      }
    }

    const results: string[] = [];

    if (validatedTitle) {
      const existing = await chatFileStorage.getSession(sessionId);
      if (existing?.manualTitle) {
        results.push(`Title preserved as manually set "${existing.title}"`);
      } else {
        await chatFileStorage.updateSessionTitle(sessionId, validatedTitle, { source: "orient" });
        results.push(`Title set to "${validatedTitle}"`);
      }
    }

    if (cleanedTopics) {
      await chatFileStorage.updateSessionTopics(sessionId, cleanedTopics);
      results.push(`Topics set: ${cleanedTopics.join(", ")}`);
    }

    if (validatedTitle || cleanedTopics) {
      const conv = await chatFileStorage.getSession(sessionId);
      const sessionKey = conv?.sessionKey || `dashboard:${sessionId}`;
      eventBus.publish({
        category: "chat",
        event: "chat.stream",
        payload: { type: "session_updated", sessionId, title: conv?.title, topics: conv?.topics || [] },
        sessionKey,
      });

      // Refresh session memory mirror so title/topics/tags stay in sync
      chatFileStorage.syncSessionMemoryMirror(sessionId).catch(() => {});
    }

    if (resolvedPersona) {
      const preserveExisting = args._orientationPersonaPolicy === "preserve_existing";
      // The user can pin a persona from the UI. A pin is authoritative: the agent's
      // autonomous mid-session switch (the non-preserve orient path) must not override it.
      const pinnedSession = preserveExisting ? null : await chatFileStorage.getSession(sessionId);
      if (pinnedSession?.personaPinnedByUser) {
        const { personaStorage } = await import("./file-storage/persona-storage");
        const pinnedPersona = pinnedSession.personaId ? await personaStorage.get(pinnedSession.personaId) : null;
        results.push(`Persona is pinned by the user${pinnedPersona ? ` to ${pinnedPersona.name}` : ""} for this session; not switching to ${resolvedPersona.name}. If the user wants a different persona, they can pick one (or Auto) from the persona icon.`);
      } else {
        // A user session must bind to the user's own persona row, never a read-only
        // seed. Selecting a seed materializes (or reuses) the user's copy so it can
        // carry context/tool bundle configuration. System principals keep the seed.
        const { personaStorage } = await import("./file-storage/persona-storage");
        const owned = await personaStorage.ensureOwnedCopy(resolvedPersona.id);
        const targetId = owned?.id ?? resolvedPersona.id;
        const { setSessionPersona, setSessionPersonaIfUnset } = await import("./session-persona");
        const selection = preserveExisting
          ? await setSessionPersonaIfUnset(sessionId, targetId)
          : null;
        const activated = preserveExisting
          ? selection?.persona ?? null
          : await setSessionPersona(sessionId, targetId);
        if (!activated) return { result: `Persona with id ${targetId} not found`, error: true };
        if (!preserveExisting || selection?.applied) {
          eventBus.publish({
            category: "agent",
            event: "cognition.persona.switched",
            payload: { sessionId, personaId: activated.id, personaName: activated.name },
          });
          results.push(`Persona activated for this session: ${activated.name} (id=${activated.id})`);
        } else {
          results.push(`Persona preserved for this session: ${activated.name} (id=${activated.id})`);
        }
      }
    }

    if (args.reasoning) {
      results.push(`Reasoning: ${args.reasoning}`);
    }

    return { result: results.join("; ") };
  },

  async session(args) {
    const action = args.action;

    // Canonical Session-family surface. Delegate to the mature implementations so
    // retries, event emission, and relationship checks remain byte-for-byte shared.
    if (action === "initiate" || action === "set_attention") {
      return bridgeHandlers.converse({ ...args, action });
    }
    if (action === "message_parent") return handleCrossSessionMessage(args, "parent");
    if (action === "message_child") return handleCrossSessionMessage(args, "child");
    if (action === "message_sibling") return handleCrossSessionMessage(args, "sibling");

    const sessionId = args._sessionId;
    if (!sessionId) return contractReject("No active session — session tool requires an active conversation context.", "session_input_invalid");

    const { chatFileStorage } = await import("./chat-file-storage");

    if (action === "get") {
      const targetId = args.sessionId || sessionId;
      const conv = await chatFileStorage.getSession(targetId);
      if (!conv) return contractReject(`Session "${targetId}" not found`, "session_input_invalid");
      const parts = [
        `**Session: ${conv.title}** (id: ${conv.id})`,
        `Turn: ${conv.status === "streaming" ? "active" : "idle"} | Status: ${conv.status} | Type: ${conv.sessionType}`,
        `Created: ${conv.createdAt} | Updated: ${conv.updatedAt}`,
      ];
      if (conv.parentSessionId) parts.push(`Parent Session: ${conv.parentSessionId}`);
      // Provenance
      const provParts: string[] = [];
      if (conv.triggerType) provParts.push(`${conv.triggerType}${conv.triggerName ? ` → "${conv.triggerName}"` : ""}${conv.triggerId ? ` (${conv.triggerId})` : ""}`);
      if (conv.rootSessionId) provParts.push(`Root: ${conv.rootSessionId}`);
      if (conv.depth !== undefined && conv.depth !== null) provParts.push(`Depth: ${conv.depth}`);
      if (provParts.length > 0) parts.push(`Provenance: ${provParts.join(" | ")}`);
      if (conv.topics && conv.topics.length > 0) parts.push(`Topics: ${conv.topics.join(", ")}`);
      if (conv.agenda) parts.push(`Agenda: ${conv.agenda.items.length} item${conv.agenda.items.length === 1 ? "" : "s"}`);
      if (conv.messageCount !== undefined) parts.push(`Messages: ${conv.messageCount}`);
      return { result: parts.join("\n") };
    }

    if (action === "get_agenda" || action === "list_agenda") {
      const targetId = args.sessionId || sessionId;
      const conv = await chatFileStorage.getSession(targetId);
      if (!conv) return contractReject(`Session "${targetId}" not found`, "session_input_invalid");
      return { result: safeStringify({ sessionId: targetId, agenda: conv.agenda ?? null }, { label: "bridge.session.agenda" }) };
    }

    if (action === "set_agenda") {
      const targetId = args.sessionId || sessionId;
      if (!Array.isArray(args.agenda)) return contractReject("Missing 'agenda' items for set_agenda", "session_input_invalid");
      try {
        const updated = await chatFileStorage.setSessionAgenda(targetId, args.agenda);
        if (!updated?.agenda) return contractReject(`Session "${targetId}" not found`, "session_input_invalid");
        return { result: safeStringify({ sessionId: targetId, agenda: updated.agenda }, { label: "bridge.session.agenda.set" }) };
      } catch (err: unknown) {
        return contractReject(`Invalid session agenda: ${err instanceof Error ? err.message : String(err)}`, "session_input_invalid");
      }
    }

    if (action === "apply_agenda_template") {
      const targetId = args.sessionId || sessionId;
      const agendaId = typeof args.agendaId === "string" ? args.agendaId.trim() : "";
      if (!agendaId) return contractReject("Missing 'agendaId' for apply_agenda_template", "session_input_invalid");
      const [{ agendaDefinitionStorage }, { instantiateAgendaDefinition }] = await Promise.all([
        import("./agenda-storage"),
        import("@shared/models/agendas"),
      ]);
      const definition = await agendaDefinitionStorage.get(agendaId);
      if (!definition) return contractReject(`Agenda template "${agendaId}" not found`, "session_input_invalid");
      try {
        const instantiated = instantiateAgendaDefinition(definition);
        const updated = await chatFileStorage.setSessionAgenda(targetId, instantiated.items);
        if (!updated?.agenda) return contractReject(`Session "${targetId}" not found`, "session_input_invalid");
        return { result: safeStringify({ sessionId: targetId, appliedTemplate: { id: definition.id, name: definition.name }, agenda: updated.agenda }, { label: "bridge.session.agenda.apply" }) };
      } catch (err: unknown) {
        return contractReject(`Invalid session agenda from template: ${err instanceof Error ? err.message : String(err)}`, "session_input_invalid");
      }
    }

    const agendaTransitionStatus = action === "complete_agenda_item"
      ? "complete"
      : action === "skip_agenda_item"
        ? "skipped"
        : action === "defer_agenda_item"
          ? "deferred"
          : null;

    if (action === "update_agenda_item" || agendaTransitionStatus) {
      const targetId = args.sessionId || sessionId;
      const itemId = typeof args.itemId === "string" ? args.itemId.trim() : "";
      if (!itemId && action !== "complete_agenda_item") {
        return contractReject(`Missing 'itemId' for ${action}`, "session_input_invalid");
      }
      const patch = agendaTransitionStatus
        ? {
            status: agendaTransitionStatus,
            ...(agendaTransitionStatus === "complete" ? { resolution: args.resolution } : {}),
          }
        : args.item;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        return contractReject("Missing sparse 'item' patch for update_agenda_item", "session_input_invalid");
      }
      if (agendaTransitionStatus === "complete" && (typeof args.resolution !== "string" || !args.resolution.trim())) {
        return contractReject("Missing 'resolution' for complete_agenda_item", "session_input_invalid");
      }
      try {
        const updated = await chatFileStorage.updateSessionAgendaItem(targetId, itemId || undefined, patch);
        if (!updated?.agenda) return contractReject(`Session "${targetId}" has no agenda`, "session_input_invalid");
        const resolvedItemId = itemId
          || updated.agenda.items.find((candidate) => candidate.status === "complete" && candidate.resolution === (typeof args.resolution === "string" ? args.resolution.trim() : undefined))?.id
          || updated.agenda.items.find((candidate) => candidate.status === "complete")?.id;
        const item = resolvedItemId
          ? updated.agenda.items.find((candidate) => candidate.id === resolvedItemId)
          : undefined;
        return { result: safeStringify({ sessionId: targetId, item, agenda: updated.agenda }, { label: "bridge.session.agenda.item" }) };
      } catch (err: unknown) {
        return contractReject(`Invalid agenda item update: ${err instanceof Error ? err.message : String(err)}`, "session_input_invalid");
      }
    }

    if (action === "send_message") {
      return handleAnySessionMessage(args);
    }

    if (action === "set_status") {
      const requested = args.runStatus;
      const status = requested === "resolved" ? "saved" : requested;
      if (!status || !["saved", "failed"].includes(status)) {
        return contractReject("Missing or invalid 'runStatus' parameter. Must be resolved/saved or failed. Session lifecycle is stored in session.status.", "session_input_invalid");
      }

      // Defer terminal status while the executor is still live or tools are
      // still being persisted. Premature "saved" lets child monitors complete
      // steps before extractSuccessfulToolInvocations can see durable tools.
      const { agentExecutor } = await import("./agent-executor");
      if (agentExecutor.isSessionBusy(sessionId)) {
        if (status === "failed") {
          await chatFileStorage.setErrorSeverity(sessionId, "error").catch(() => {});
        }
        agentExecutor.markPendingSessionEnd(sessionId, status as "saved" | "failed");
        return {
          result: `Session status "${status === "saved" ? "complete" : status}" deferred until tool persistence completes`,
          // Successful terminal status is intentional completion — stop the loop
          // without requiring a final assistant narration (silent skill contract).
          ...(status === "saved" ? { continuation: "session_complete" as const } : {}),
        };
      }

      if (status === "failed") {
        await chatFileStorage.setErrorSeverity(sessionId, "error");
      }
      await chatFileStorage.updateSessionStatus(sessionId, status);
      await chatFileStorage.setSessionPinned(sessionId, false);
      try {
        const { runDeferredPostRunVerify } = await import("./autonomous-skill-runner");
        await runDeferredPostRunVerify(sessionId);
      } catch (e: unknown) {
        toolExec.warn(`[converse] [${sessionId}] deferred postRunVerify on set_status ${status} failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      return {
        result: `Session status set to "${status === "saved" ? "complete" : status}"`,
        ...(status === "saved" ? { continuation: "session_complete" as const } : {}),
      };
    }

    if (action === "end") {
      const summary = args.summary || "Session ended";
      const conv = await chatFileStorage.getSession(sessionId);
      const sessionKey = conv?.sessionKey || `dashboard:${sessionId}`;

      // Durable status "saved" must wait until toolCalls are persisted, otherwise
      // plan/workflow child monitors race extractSuccessfulToolInvocations.
      const { agentExecutor } = await import("./agent-executor");
      if (agentExecutor.isSessionBusy(sessionId)) {
        agentExecutor.markPendingSessionEnd(sessionId, "saved", summary);
        await chatFileStorage.setEndReason(sessionId, summary).catch(() => {});
        await chatFileStorage.setSessionPinned(sessionId, false).catch(() => {});
        eventBus.publish({
          category: "chat",
          event: "session.end",
          payload: { sessionId, summary, deferred: true },
          sessionKey,
        });
        return {
          result: `Session end deferred until tool persistence completes. Summary: ${summary}`,
          // Intentional silent completion for tool-only autonomous skills.
          continuation: "session_complete" as const,
        };
      }

      await chatFileStorage.updateSessionStatus(sessionId, "saved", summary);
      await chatFileStorage.setSessionPinned(sessionId, false);

      try {
        const { runDeferredPostRunVerify } = await import("./autonomous-skill-runner");
        await runDeferredPostRunVerify(sessionId);
      } catch (e: unknown) {
        toolExec.warn(`[converse] [${sessionId}] deferred postRunVerify on session end failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      eventBus.publish({
        category: "chat",
        event: "session.end",
        payload: { sessionId, summary },
        sessionKey,
      });

      return {
        result: `Session ended and completed. Summary: ${summary}`,
        continuation: "session_complete" as const,
      };
    }

    if (action === "list") {
      const allConvs = await chatFileStorage.getAllSessions();
      let filtered = allConvs;
      if (args.type) filtered = filtered.filter(c => c.sessionType === args.type);
      if (args.status) filtered = filtered.filter(c => c.status === args.status);
      const limit = Math.min(args.limit || 50, 200);
      filtered = filtered.slice(0, limit);
      return { result: safeStringify({ total: filtered.length, items: filtered.map(c => ({ id: c.id, title: c.title, type: c.sessionType, status: c.status, messageCount: c.messageCount || 0, updatedAt: c.updatedAt })) }, { label: "bridge.session.list" }) };
    }

    if (action === "search") {
      const startedAt = performance.now();
      const query = args.query?.trim();
      if (!query) return contractReject("Missing 'query' parameter for search", "session_input_invalid");
      const importStartedAt = performance.now();
      let importMs = 0;
      const limit = Math.min(args.limit || 10, 50);
      let diagnosticsStatus: "success" | "failure" = "failure";
      let diagnosticsSource: "target" | "legacy" | undefined;
      let resultCount = 0;
      let totalCount = 0;
      let queryBuildMs = 0;
      let resultDbMs = 0;
      let countDbMs = 0;
      let snippetHydrationMs = 0;
      let searchTotalMs = 0;
      let handlerPhase: "import" | "search" | "formatting" = "import";
      const emitSearchTiming = (timing: {
        status: "success" | "failure";
        totalMs: number;
        [key: string]: unknown;
      }): void => {
        const observable = timing.status === "failure" || timing.totalMs >= 1_000 || Math.random() < 0.01;
        const write = observable ? toolExec.info : toolExec.debug;
        write("Session search timing", timing);
      };
      try {
        const { searchSessionSummaries } = await import("./chat-file-storage");
        importMs = performance.now() - importStartedAt;
        handlerPhase = "search";
        const matches = await searchSessionSummaries(query, 24 * 30, limit, diagnostics => {
          diagnosticsStatus = diagnostics.status;
          diagnosticsSource = diagnostics.source;
          resultCount = diagnostics.resultCount;
          totalCount = diagnostics.totalCount;
          queryBuildMs = diagnostics.queryBuildMs;
          resultDbMs = diagnostics.resultDbMs;
          countDbMs = diagnostics.countDbMs;
          snippetHydrationMs = diagnostics.snippetHydrationMs;
          searchTotalMs = diagnostics.totalMs;
        });
        handlerPhase = "formatting";
        const formattingStartedAt = performance.now();
        const result = safeStringify({ query, total: matches.length, items: matches.map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, snippet: s.snippet.slice(0, 200) })) }, { label: "bridge.session.search" });
        const formattingMs = performance.now() - formattingStartedAt;
        const totalMs = performance.now() - startedAt;
        emitSearchTiming({
          status: diagnosticsStatus,
          phase: handlerPhase,
          source: diagnosticsSource,
          queryLength: query.length,
          limit,
          resultCount,
          totalCount,
          candidateDbMs: 0,
          queryBuildMs: Number(queryBuildMs.toFixed(2)),
          resultDbMs: Number(resultDbMs.toFixed(2)),
          countDbMs: Number(countDbMs.toFixed(2)),
          snippetHydrationMs: Number(snippetHydrationMs.toFixed(2)),
          importMs: Number(importMs.toFixed(2)),
          formattingMs: Number(formattingMs.toFixed(2)),
          otherMs: Number(Math.max(0, totalMs - importMs - searchTotalMs - formattingMs).toFixed(2)),
          totalMs: Number(totalMs.toFixed(2)),
        });
        return { result };
      } catch (error) {
        const totalMs = performance.now() - startedAt;
        if (handlerPhase === "import") {
          importMs = performance.now() - importStartedAt;
        }
        emitSearchTiming({
          status: diagnosticsStatus,
          phase: handlerPhase,
          source: diagnosticsSource,
          queryLength: query.length,
          limit,
          resultCount,
          totalCount,
          candidateDbMs: 0,
          queryBuildMs: Number(queryBuildMs.toFixed(2)),
          resultDbMs: Number(resultDbMs.toFixed(2)),
          countDbMs: Number(countDbMs.toFixed(2)),
          snippetHydrationMs: Number(snippetHydrationMs.toFixed(2)),
          importMs: Number(importMs.toFixed(2)),
          formattingMs: 0,
          otherMs: Number(Math.max(0, totalMs - importMs - searchTotalMs).toFixed(2)),
          totalMs: Number(totalMs.toFixed(2)),
        });
        const { SessionSearchError } = await import("./chat-file-storage");
        if (error instanceof SessionSearchError) {
          return contractReject(error.message, "session_input_invalid");
        }
        return {
          result: "Session search is temporarily unavailable. Please try again.",
          error: true,
        };
      }
    }

    if (action === "get_messages") {
      const targetId = args.sessionId || sessionId;
      const messages = await chatFileStorage.getMessagesBySession(targetId);
      const limit = Math.min(args.limit || 50, 200);
      const sliced = messages.slice(-limit);
      return { result: safeStringify({ sessionId: targetId, total: messages.length, returned: sliced.length, messages: sliced.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })) }, { label: "bridge.session.messages" }) };
    }

    if (action === "spawn_child") {
      const topicRaw: string | undefined = (args.topic ?? args.title ?? "").toString().trim();
      if (!topicRaw) return contractReject("Missing 'topic' (or 'title') for spawn_child", "session_input_invalid");
      const reason: string | undefined = args.reason ? String(args.reason).trim() : undefined;
      const explicitSpawnReason: string | undefined = args.spawnReason ? String(args.spawnReason).trim() : undefined;
      const requestedDelegation = args.delegation === "engineering" ? "engineering" : "conversation";
      const { authorizeToolInvocation } = await import("./agent-authority");
      const delegationAuthority = authorizeToolInvocation("git", { action: "clone" }, args._authorityContext || {});
      if (requestedDelegation === "engineering" && !delegationAuthority.allowed) {
        return contractReject(`Engineering child delegation denied: ${delegationAuthority.reason}`, "session_input_invalid");
      }
      // Children inherit the spawner's server-validated authority. The optional
      // delegation argument selects persona mode; it is not an authority token.
      const engineeringDelegation = delegationAuthority.allowed;
      const delegation = engineeringDelegation ? "engineering" : "conversation";
      const shortTitle = topicRaw.split(/\s+/).slice(0, 5).join(" ");
      const spawnReason = explicitSpawnReason || `spawn_child:${topicRaw.slice(0, 60)}`;
      const spawnerTool = engineeringDelegation ? "session.spawn_child.engineering" : "session.spawn_child";
      const spawnerSkillRun = `session.spawn_child:${sessionId}:${spawnReason}:${delegation}`;
      let agenda: import("@shared/models/chat").SessionAgenda | undefined;
      try {
        agenda = Array.isArray(args.agenda)
          ? (await import("./chat-file-storage")).normalizeSessionAgenda(args.agenda)
          : undefined;
      } catch (err: unknown) {
        return contractReject(`Invalid child session agenda: ${err instanceof Error ? err.message : String(err)}`, "session_input_invalid");
      }

      if (await isSpecSkillSession(sessionId) && isSpecChildSpawnRequest(topicRaw, reason, explicitSpawnReason, spawnReason)) {
        return contractReject(
          "Guard blocked recursive spec child launch: this session is already the spec skill. Continue producing the current spec artifact instead of spawning another spec session.",
          "session_input_invalid",
        );
      }

      try {
        const { recordSpawn } = await import("./sessions/tree");
        const spawnResult = await recordSpawn(
          sessionId,
          { spawnReason, spawnerTool, spawnerSkillRun },
          async () => {
            let personaId: number | undefined;
            if (requestedDelegation === "engineering") {
              const { personaStorage } = await import("./file-storage/persona-storage");
              const engineerPersona = await personaStorage.getByName("Engineer");
              if (!engineerPersona) {
                throw new Error("Engineer persona is not visible to the current principal");
              }
              personaId = engineerPersona.id;
            }
            const created = await chatFileStorage.createAutonomousSession(
              shortTitle,
              "agent",
              undefined,
              undefined,
              undefined,
              { personaId, agenda, parentSessionId: sessionId, spawnReason, spawnerTool, spawnerSkillRun, triggerType: "spawn" as const, triggerId: sessionId, triggerName: shortTitle },
            );
            return { sessionId: created.id };
          },
        );
        const childId = spawnResult.sessionId;

        if (spawnResult.reused) {
          const childConv = await chatFileStorage.getSession(childId);
          const childMessages = await chatFileStorage.getMessagesBySession(childId);
          const hasAssistantResponse = childMessages.some(m => m.role === "assistant");
          const authorityNote = engineeringDelegation
            ? "Authority inherited from the spawner. Independently authorized engineering tools remain subject to their own gates and the child's session-scoped clone."
            : "Authority inherited from the spawner; engineering tools remain unavailable because the spawner could not delegate them.";
          if (!hasAssistantResponse && childMessages.length > 0) {
            await triggerChildSessionResponse(childId, "session.spawn_child.reused");
            return { result: `Reused existing child session ${childId}${childConv?.title ? ` (${childConv.title})` : ""} for spawn reason "${spawnReason}". Started execution. ${authorityNote}` };
          }
          return { result: `Reused existing child session ${childId}${childConv?.title ? ` (${childConv.title})` : ""} for spawn reason "${spawnReason}". ${authorityNote}` };
        }

        // Build the warm-start brief from existing summarization paths.
        let brief = "";
        try {
          brief = await buildWarmStartBrief({
            parentSessionId: sessionId,
            childTopic: topicRaw,
            reason,
          });
        } catch (briefErr: unknown) {
          toolExec.warn(`[session.spawn_child] warm-start brief failed: ${briefErr instanceof Error ? briefErr.message : String(briefErr)}`);
          // Fallback: assemble a minimal brief without LLM-based summaries.
          brief = await buildFallbackBrief({
            parentSessionId: sessionId,
            childTopic: topicRaw,
            reason,
          });
        }

        // Seat the brief as the first child message (system role).
        await chatFileStorage.createMessage(childId, "system", brief);

        // Drop a cross-session reference into the parent thread so the
        // existing inline-session-blocks renderer picks it up.
        const childConv = await chatFileStorage.getSession(childId);
        const parentRefContent = `Spawned child session "${childConv?.title || shortTitle}" (${childId})${reason ? ` — reason: ${reason}` : ""}`;
        await chatFileStorage.createCrossSessionMessage(
          sessionId,
          childId,
          parentRefContent,
          "child",
        );

        // Publish event to the parent so live UI sees the new linkage.
        try {
          const parentConv = await chatFileStorage.getSession(sessionId);
          eventBus.publish({
            category: "chat",
            event: "chat.cross_session_message",
            sessionKey: parentConv?.sessionKey || `dashboard:${sessionId}`,
            payload: {
              type: "cross_session_message",
              sessionId,
              fromSessionId: sessionId,
              toSessionId: childId,
              direction: "child",
              content: parentRefContent,
              chainId: "",
              depth: 0,
              fromLabel: parentConv?.title,
              toLabel: childConv?.title,
            } as any,
          });
        } catch (e: any) {
          toolExec.warn(`[session.spawn_child] event publish failed: ${e?.message || e}`);
        }

        // Emit child_session_block so inline widget renders in parent
        try {
          const { onChildSessionSpawned } = await import("./sessions/child-block-lifecycle");
          await onChildSessionSpawned(sessionId, childId, {
            spawnReason,
            title: shortTitle,
          });
        } catch (e: any) {
          toolExec.warn(`[session.spawn_child] child block emission failed: ${e?.message || e}`);
        }

        await triggerChildSessionResponse(childId, "session.spawn_child");

        toolExec.log(`[session.spawn_child] parent=${sessionId} child=${childId} spawnReason=${spawnReason} briefLen=${brief.length} autoStart=true delegation=${delegation}`);
        const authorityNote = engineeringDelegation
          ? "Authority inherited from the spawner. Independently authorized engineering tools remain subject to their own gates and the child's session-scoped clone."
          : "Authority inherited from the spawner; engineering tools remain unavailable because the spawner could not delegate them.";
        return {
          result: [
            `Spawned child session ${childId}${childConv?.title ? ` (${childConv.title})` : ""}.`,
            `Warm-start brief seated (${brief.length} chars). Started execution.`,
            authorityNote,
          ].join(" "),
        };
      } catch (err: any) {
        return contractReject(`spawn_child failed: ${err?.message || err}`, "session_input_invalid");
      }
    }

    return contractReject(`Unknown session action: ${action}. Available: get, get_agenda, list_agenda, set_agenda, apply_agenda_template, update_agenda_item, complete_agenda_item, skip_agenda_item, defer_agenda_item, set_status, end, list, search, get_messages, spawn_child, send_message`, "session_input_invalid");
  },

  async create_task(args) {
    const { fileTaskStorage } = await import("./file-storage/tasks");
    const { chatFileStorage } = await import("./chat-file-storage");

    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) {
      return {
        result: "Missing task title",
        error: true,
        failure: inputFailure("task_missing_title"),
      };
    }
    // Schema and storage both treat description as optional (default "").
    // Hard-requiring it here was a validation thrash wall against the advertised contract.
    const description = typeof args.description === "string" ? args.description.trim() : "";

    const owner = args.owner === "xyz" ? "agent" : (args.owner || "me");
    const milestoneId = typeof args.milestoneId === "number" ? args.milestoneId : Number(args.milestoneId);
    if (!Number.isInteger(milestoneId) || milestoneId <= 0) {
      return {
        result: `Invalid milestoneId: ${args.milestoneId ?? "missing"}. Every task requires a positive milestone id; find an appropriate milestone or ask the user where the task belongs.`,
        error: true,
        failure: inputFailure("task_milestone_required", String(args.milestoneId ?? "missing")),
      };
    }

    let projectId: number | null = null;
    if (args.projectId !== undefined && args.projectId !== null && args.projectId !== "") {
      const parsed = typeof args.projectId === "number" ? args.projectId : Number(args.projectId);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return {
          result: `Invalid projectId: ${args.projectId}. Pass a positive integer project id, or omit projectId.`,
          error: true,
          failure: inputFailure("task_update_project_not_found", String(args.projectId)),
        };
      }
      projectId = parsed;
    }

    const sourceSessionId = typeof args._sessionId === "string" && args._sessionId.trim() ? args._sessionId.trim() : null;
    let sourceSessionLine = "";
    let sourceMeetingVaultId: string | undefined;
    let sourceIsMeeting = false;
    if (sourceSessionId) {
      const sourceSession = await chatFileStorage.getSession(sourceSessionId).catch(() => undefined);
      const titlePart = sourceSession?.title ? ` (${sourceSession.title})` : "";
      sourceSessionLine = `Source session: @session:${sourceSessionId}${titlePart}`;
      if (sourceSession?.type === "meeting") {
        sourceIsMeeting = true;
        if (!sourceSession.vaultId) {
          return { result: `Meeting session ${sourceSessionId} has no pinned vault`, error: true };
        }
        sourceMeetingVaultId = sourceSession.vaultId;
      }
    }

    try {
      const context = sourceSessionLine || "";
      const assignmentInput = taskAssignmentFromToolArgs(args);
      if (assignmentInput.error) return { result: assignmentInput.error, error: true };

      const taskData = {
        title,
        description,
        priority: args.priority || "mid",
        owner,
        ...assignmentInput.assignment,
        projectId,
        status: args.status || "ready",
        requiresReview: args.requiresReview ?? false,
        impact: args.impact ?? null,
        effort: args.effort ?? null,
        blockedBy: args.blockedBy,
        milestoneId,
        ...(sourceMeetingVaultId ? { vaultId: sourceMeetingVaultId } : {}),
        context,
        deadline: args.deadline ?? null,
      };
      const task = await fileTaskStorage.createTask(
        taskData,
        sourceIsMeeting
          ? { originType: "meeting", originId: sourceSessionId }
          : { originType: "manual" },
      );
      const assignee = task.assigneeSubjectType && task.assigneeSubjectId
        ? `, assignee: ${task.assigneeSubjectType}:${task.assigneeSubjectId}`
        : "";
      return { result: `Task created: "${task.title}" (ID: ${task.id}, priority: ${task.priority}, owner: ${task.owner}${assignee}${task.milestoneId ? `, milestone: ${task.milestoneId}` : ""})${sourceSessionId ? `, source: @session:${sourceSessionId}` : ""}` };
    } catch (err: any) {
      const failure = toolFailureFromError(err);
      if (failure) {
        return { result: err instanceof Error ? err.message : String(err), error: true, failure };
      }
      // milestoneId without projectId is a deterministic input wall from storage.
      if (typeof err?.message === "string" && /milestoneId requires projectId/i.test(err.message)) {
        return {
          result: err.message,
          error: true,
          failure: inputFailure("task_update_milestone_requires_project"),
        };
      }
      return { result: `Failed to create task: ${err.message}`, error: true };
    }
  },

  async complete_task(args) {
    const { fileTaskStorage } = await import("./file-storage/tasks");

    let task: any = null;
    if (args.taskId) {
      task = await fileTaskStorage.getTask(args.taskId);
    }
    if (!task && args.title) {
      const tasks = await fileTaskStorage.getTasks({});
      task = tasks.find((t: any) => t.title.toLowerCase().includes(args.title.toLowerCase()));
    }
    if (!task) return { result: `Task not found: ${args.taskId || args.title}`, error: true };

    try {
      const updated = await fileTaskStorage.updateTask(task.id, { status: "done" });
      if (!updated) return { result: `Failed to update task ${task.id}`, error: true };
      return { result: `Task completed: "${updated.title}" (ID: ${updated.id})` };
    } catch (err: any) {
      return { result: `Failed to complete task: ${err.message}`, error: true };
    }
  },

  async delete_task(args) {
    const { fileTaskStorage } = await import("./file-storage/tasks");

    let task: any = null;
    if (args.taskId) {
      task = await fileTaskStorage.getTask(args.taskId);
    }
    if (!task && args.title) {
      const tasks = await fileTaskStorage.getTasks({});
      task = tasks.find((t: any) => t.title.toLowerCase().includes(args.title.toLowerCase()));
    }
    if (!task) return { result: `Task not found: ${args.taskId || args.title}`, error: true };

    try {
      const deleted = await fileTaskStorage.deleteTask(task.id);
      if (!deleted) return { result: `Failed to delete task ${task.id}`, error: true };
      return { result: `Task deleted: "${task.title}" (ID: ${task.id})` };
    } catch (err: any) {
      return { result: `Failed to delete task: ${err.message}`, error: true };
    }
  },

  async update_task(args) {
    const { fileTaskStorage } = await import("./file-storage/tasks");

    let task: any = null;
    if (args.taskId) {
      task = await fileTaskStorage.getTask(args.taskId);
    }
    if (!task && args.title) {
      const tasks = await fileTaskStorage.getTasks({});
      task = tasks.find((t: any) => t.title.toLowerCase().includes(args.title.toLowerCase()));
    }
    if (!task) return { result: `Task not found: ${args.taskId || args.title}`, error: true };

    const command: Record<string, unknown> = {};
    if (args.newTitle !== undefined) command.title = args.newTitle;
    if (args.description !== undefined) command.description = args.description;
    if (args.priority !== undefined) command.priority = args.priority;
    if (args.status !== undefined) command.status = args.status;
    if (args.impact !== undefined) command.impact = args.impact;
    if (args.effort !== undefined) command.effort = args.effort;
    if (args.owner !== undefined) command.owner = args.owner;
    const assignmentInput = taskAssignmentFromToolArgs(args);
    if (assignmentInput.error) return { result: assignmentInput.error, error: true };
    if (assignmentInput.assignment) Object.assign(command, assignmentInput.assignment);
    if (args.requiresReview !== undefined) command.requiresReview = args.requiresReview;
    if (args.projectId !== undefined) command.projectId = args.projectId;
    if (args.milestoneId !== undefined) command.milestoneId = args.milestoneId;
    if (args.deadline !== undefined) command.deadline = args.deadline;
    if (args.blockedBy !== undefined) command.blockedBy = args.blockedBy;
    const clearFields = Array.isArray(args.clearFields)
      ? args.clearFields.filter((field: unknown): field is string => typeof field === "string")
      : [];
    if (clearFields.includes("projectId") || clearFields.includes("milestoneId")) {
      return {
        result: "Task project and milestone placement cannot be cleared; move the task by setting a valid projectId and milestoneId together.",
        error: true,
        failure: inputFailure("task_placement_clear_forbidden"),
      };
    }
    if (clearFields.length > 0) command.clearFields = clearFields;
    if (args.confirmDestructiveUpdate !== undefined) command.confirmDestructiveUpdate = args.confirmDestructiveUpdate;
    if (args.destructiveUpdateReason !== undefined) command.destructiveUpdateReason = args.destructiveUpdateReason;

    try {
      const sourceSessionId = typeof args._sessionId === "string" && args._sessionId.trim() ? args._sessionId.trim() : null;
      let provenance: { originType: "meeting" | "manual"; originId?: string | null } = { originType: "manual" };
      if (sourceSessionId) {
        const { chatFileStorage } = await import("./chat-file-storage");
        const sourceSession = await chatFileStorage.getSession(sourceSessionId).catch(() => undefined);
        if (sourceSession?.type === "meeting") provenance = { originType: "meeting", originId: sourceSessionId };
      }
      const updated = await fileTaskStorage.updateTask(task.id, command, provenance);
      if (!updated) return { result: `Failed to update task ${task.id}`, error: true };
      return { result: `Task updated: "${updated.title}"` };
    } catch (err: any) {
      const failure = toolFailureFromError(err);
      if (failure) {
        return { result: `Failed to update task: ${err.message}`, error: true, failure };
      }
      if (typeof err?.message === "string" && /milestoneId requires projectId/i.test(err.message)) {
        return {
          result: `Failed to update task: ${err.message}`,
          error: true,
          failure: inputFailure("task_update_milestone_requires_project"),
        };
      }
      return {
        result: `Failed to update task: ${err.message}`,
        error: true,
        failure: internalFailure("task_update_internal", err instanceof Error ? err.message : String(err)),
      };
    }
  },

  async issues(args) {
    const { storage } = await import("./storage");
    const action = (args.action as string | undefined) || "create";

    if (action === "list_errors") {
      const { listRecentApplicationErrors } = await import("./error-telemetry");
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      const offset = Math.max(Number(args.offset) || 0, 0);
      const errors = await listRecentApplicationErrors(limit, offset);
      if (errors.length === 0) {
        return { result: "No aggregated application errors found." };
      }
      return {
        result: JSON.stringify({
          errors,
          offset,
          nextOffset: errors.length === limit ? offset + errors.length : null,
          hasMore: errors.length === limit,
          count: errors.length,
        }),
      };
    }

    if (action === "dismiss_error") {
      const { dismissApplicationError } = await import("./error-telemetry");
      const fingerprint = typeof args.fingerprint === "string" ? args.fingerprint.trim() : "";
      if (!fingerprint) {
        return { result: "dismiss_error requires a fingerprint (64-char hex from list_errors).", error: true };
      }
      const dismissed = await dismissApplicationError(fingerprint);
      return {
        result: dismissed
          ? `Dismissed error ${fingerprint}. It will resurface if the same error recurs.`
          : `No active error found for fingerprint ${fingerprint} (already dismissed or unknown).`,
      };
    }

    if (action === "list") {
      const allowedStatuses = new Set(["open", "in_progress", "in_review", "resolved"]);
      const status = typeof args.status === "string" && args.status.trim()
        ? args.status.trim()
        : undefined;
      const excludeStatus = typeof args.excludeStatus === "string" && args.excludeStatus.trim()
        ? args.excludeStatus.trim()
        : undefined;
      if (status && !allowedStatuses.has(status)) {
        return { result: `Invalid Issue status '${status}'`, error: true };
      }
      if (excludeStatus && !allowedStatuses.has(excludeStatus)) {
        return { result: `Invalid excluded Issue status '${excludeStatus}'`, error: true };
      }
      const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      try {
        const issues = await storage.getIssues({ status, excludeStatus, lightweight: true });
        // Human reports are a triage queue, never autonomous Regression or repair work.
        const actionableIssues = issues.filter((issue) => issue.kind !== "reported");
        const page = actionableIssues.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          result: JSON.stringify({
            issues: page,
            offset,
            nextOffset: nextOffset < actionableIssues.length ? nextOffset : null,
            hasMore: nextOffset < actionableIssues.length,
            total: actionableIssues.length,
          }),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { result: `Failed to list Issues: ${message}`, error: true };
      }
    }

    if (action === "list_reported") {
      const allowedStatuses = new Set(["open", "in_progress", "in_review", "resolved"]);
      const status = typeof args.status === "string" && args.status.trim()
        ? args.status.trim()
        : undefined;
      const excludeStatus = typeof args.excludeStatus === "string" && args.excludeStatus.trim()
        ? args.excludeStatus.trim()
        : undefined;
      if (status && !allowedStatuses.has(status)) {
        return { result: `Invalid Issue status '${status}'`, error: true };
      }
      if (excludeStatus && !allowedStatuses.has(excludeStatus)) {
        return { result: `Invalid excluded Issue status '${excludeStatus}'`, error: true };
      }
      const limit = Math.max(1, Math.min(Number(args.limit) || 100, 500));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      try {
        const { requireCurrentPrincipal } = await import("./principal-context");
        const { principalHasPermission } = await import("./permissions");
        const principal = requireCurrentPrincipal();
        if (!principalHasPermission(principal, "system:read")) {
          return { result: "Permission required: system:read", error: true };
        }
        const issues = await storage.getIssuesForAdmin(principal, { status, excludeStatus, lightweight: true });
        const reportedIssues = issues.filter((issue) => issue.kind === "reported");
        const page = reportedIssues.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          result: JSON.stringify({
            issues: page,
            offset,
            nextOffset: nextOffset < reportedIssues.length ? nextOffset : null,
            hasMore: nextOffset < reportedIssues.length,
            total: reportedIssues.length,
          }),
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { result: `Failed to list reported Issues: ${message}`, error: true };
      }
    }

    if (action === "get" || action === "resolve") {
      const rawId = args.id;
      if (rawId === undefined || rawId === null || rawId === "") {
        return { result: "Missing issue id", error: true };
      }
      const idNum = typeof rawId === "number" ? rawId : Number(String(rawId).trim());
      if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0) {
        return { result: `Invalid issue id '${rawId}'; expected a positive integer`, error: true };
      }
      try {
        // Own Issues use ordinary principal scope. Cross-owner browser reports
        // (kind=reported) require the Build admin triage path, which restores the
        // reporter principal under system:read / system:write.
        const { requireCurrentPrincipal } = await import("./principal-context");
        const { principalHasPermission } = await import("./permissions");
        const principal = requireCurrentPrincipal();
        if (action === "get") {
          const issue = principalHasPermission(principal, "system:read")
            ? await storage.getIssueForAdmin(principal, idNum)
            : await storage.getIssue(idNum);
          if (!issue) return { result: `Issue ${idNum} not found`, error: true };
          return { result: JSON.stringify(issue) };
        }

        const evidence = typeof args.evidence === "string" ? args.evidence.trim() : "";
        if (!evidence || evidence.length > 2_000) {
          return { result: "resolve requires an affirmative evidence note of 1-2000 characters", error: true };
        }
        const issue = principalHasPermission(principal, "system:write")
          ? await storage.resolveIssueWithEvidenceForAdmin(principal, idNum, evidence)
          : await storage.resolveIssueWithEvidence(idNum, evidence);
        if (!issue) return { result: `Issue ${idNum} not found`, error: true };
        return { result: JSON.stringify(issue) };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { result: `Failed to ${action} issue ${idNum}: ${message}`, error: true };
      }
    }

    if (action === "create") {
      const title = args.title;
      if (!title) {
        return {
          result: "Missing issue title",
          error: true,
          failure: inputFailure("issue_create_missing_title"),
        };
      }
      const reproSteps = typeof args.reproSteps === "string" ? args.reproSteps.trim() : "";
      if (!reproSteps) {
        return {
          result: "Missing issue reproSteps. Do not file title-only shells — include explicit reproduction steps.",
          error: true,
          failure: inputFailure("issue_create_missing_repro"),
        };
      }
      try {
        const platformEnvironmentId =
          typeof args.platformEnvironmentId === "number" && Number.isInteger(args.platformEnvironmentId) && args.platformEnvironmentId > 0
            ? args.platformEnvironmentId
            : typeof args.platformEnvironmentId === "string" && args.platformEnvironmentId.trim()
              ? Number(args.platformEnvironmentId)
              : null;
        const buildId = typeof args.buildId === "string" && args.buildId.trim()
          ? args.buildId.trim()
          : null;
        const issue = await storage.createIssue({
          title,
          description: args.description || "",
          reproSteps,
          status: "open",
          page: null,
          screenshot: null,
          logs: null,
          platformEnvironmentId: Number.isInteger(platformEnvironmentId) && (platformEnvironmentId as number) > 0
            ? (platformEnvironmentId as number)
            : null,
          buildId,
        });
        return {
          result: `Issue created: "${issue.title}" (ID: ${issue.id}, env=${issue.platformEnvironmentId}, build=${issue.buildId})`,
        };
      } catch (err: any) {
        const isValidation = err?.name === "IssueCreateValidationError";
        return {
          result: `Failed to create issue: ${err.message}`,
          error: true,
          failure: isValidation
            ? inputFailure(err.code || "issue_create_validation")
            : undefined,
        };
      }
    }

    if (action === "add_note") {
      const rawId = args.id;
      if (rawId === undefined || rawId === null || rawId === "") {
        return { result: "Missing issue id", error: true };
      }
      const idNum = typeof rawId === "number" ? rawId : Number(String(rawId).trim());
      if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0) {
        return { result: `Invalid issue id '${rawId}'; expected a positive integer`, error: true };
      }
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text || text.length > 5_000) {
        return { result: "add_note requires a text entry of 1-5000 characters", error: true };
      }
      try {
        const { requireCurrentPrincipal } = await import("./principal-context");
        const { principalHasPermission } = await import("./permissions");
        const principal = requireCurrentPrincipal();
        const issue = principalHasPermission(principal, "system:write")
          ? await storage.addIssueNoteForAdmin(principal, idNum, text, "agent")
          : await storage.addIssueNote(idNum, text, "agent");
        if (!issue) return { result: `Issue ${idNum} not found`, error: true };
        return { result: JSON.stringify(issue) };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { result: `Failed to add note to issue ${idNum}: ${message}`, error: true };
      }
    }

    if (action === "delete") {
      const rawId = args.id;
      if (rawId === undefined || rawId === null || rawId === "") {
        return { result: "Missing issue id", error: true };
      }
      const idNum = typeof rawId === "number" ? rawId : Number(String(rawId).trim());
      if (!Number.isFinite(idNum) || !Number.isInteger(idNum) || idNum <= 0) {
        return { result: `Invalid issue id '${rawId}'; expected a positive integer`, error: true };
      }
      if (args.confirm !== true) {
        return {
          result: "delete requires confirm=true. Permanent removal is intentional (e.g. Issue → Feature conversion), not ordinary resolution.",
          error: true,
          failure: inputFailure("issue_delete_unconfirmed"),
        };
      }
      try {
        const { requireCurrentPrincipal } = await import("./principal-context");
        const { principalHasPermission } = await import("./permissions");
        const principal = requireCurrentPrincipal();
        // Own Issues delete under ordinary scope. Cross-owner browser reports
        // require the Build admin path under system:write, matching HTTP delete.
        const deleted = principalHasPermission(principal, "system:write")
          ? await storage.deleteIssueForAdmin(principal, idNum)
          : await storage.deleteIssue(idNum);
        if (!deleted) return { result: `Issue ${idNum} not found`, error: true };
        return { result: JSON.stringify({ success: true, id: idNum, deleted: true }) };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { result: `Failed to delete issue ${idNum}: ${message}`, error: true };
      }
    }

    return { result: `Unknown issues action: ${action}. Available: create, list, list_reported, get, resolve, add_note, delete, list_errors, dismiss_error`, error: true };
  },

  async goals(args) {
    const { goalsService } = await import("./goals-service");

    const action = args.action || "list";

    async function resolveLibraryPageUUID(rawId: string): Promise<{ uuid: string } | { error: string }> {
      const { db } = await import("./db");
      const { libraryPages } = await import("@shared/models/info");
      const { eq } = await import("drizzle-orm");
      const { requireCurrentPrincipal } = await import("./principal-context");
      const { combineWithVisibleScope } = await import("./scoped-storage");
      const principal = requireCurrentPrincipal();
      const scope = { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId };
      const byId = await db.select({ id: libraryPages.id }).from(libraryPages).where(combineWithVisibleScope(principal, scope, eq(libraryPages.id, rawId)));
      if (byId[0]) return { uuid: byId[0].id };
      const bySlug = await db.select({ id: libraryPages.id }).from(libraryPages).where(combineWithVisibleScope(principal, scope, eq(libraryPages.slug, rawId)));
      if (bySlug[0]) return { uuid: bySlug[0].id };
      return { error: `Library page "${rawId}" not found. Use the exact id or slug returned by the library tool when creating/updating the page.` };
    }

    function parseLocalDate(date: string, label: string): { date: Date } | { error: string } {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `Invalid '${label}' format: expected YYYY-MM-DD` };
      const [year, month, day] = date.split("-").map(Number);
      const parsed = new Date(date + "T12:00:00");
      if (isNaN(parsed.getTime()) || parsed.getFullYear() !== year || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) {
        return { error: `Invalid '${label}' value: date does not exist` };
      }
      return { date: parsed };
    }

    async function setCheckInArtifact(
      artifactAction: string,
      args: Record<string, any>,
    ): Promise<ToolHandlerResult> {
      const rawPageId = args.libraryPageId;
      if (!rawPageId) return { result: "Missing libraryPageId parameter", error: true };
      const resolved = await resolveLibraryPageUUID(String(rawPageId));
      if ("error" in resolved) return { result: resolved.error, error: true };
      const libraryPageId = resolved.uuid;
      const { setArtifact } = await import("./period-artifact-storage");
      const { getDateInTimezone } = await import("./timezone");

      if (artifactAction === "set_review" || artifactAction === "set_daily_plan") {
        const date = args.date ? String(args.date) : getDateInTimezone();
        const parsed = parseLocalDate(date, "date");
        if ("error" in parsed) return { result: parsed.error, error: true };
        const updates = artifactAction === "set_review" ? { reviewPageId: libraryPageId } : { dailyPlanPageId: libraryPageId };
        await setArtifact(date, "daily", updates);
        const field = artifactAction === "set_review" ? "reviewPageId" : "dailyPlanPageId";
        return { result: `${field} set for ${date}: ${libraryPageId}` };
      }

      if (artifactAction === "set_weekly_reflection" || artifactAction === "set_weekly_plan") {
        const baseStr = args.week ? String(args.week) : getDateInTimezone();
        const parsed = parseLocalDate(baseStr, "week");
        if ("error" in parsed) return { result: parsed.error, error: true };
        const d = parsed.date;
        const day = d.getDay();
        const diff = day === 0 ? 6 : day - 1;
        const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
        const mondayDate = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
        const field = artifactAction === "set_weekly_reflection" ? "weeklyReflectionPageId" : "weeklyPlanPageId";
        await setArtifact(mondayDate, "weekly", { [field]: libraryPageId });
        return { result: `${field} set for week of ${mondayDate}: ${libraryPageId}` };
      }

      if (artifactAction === "set_monthly_plan" || artifactAction === "set_monthly_reflection") {
        let firstOfMonth: string;
        if (args.month) {
          const monthStr = String(args.month);
          if (!/^\d{4}-\d{2}$/.test(monthStr)) return { result: "Invalid 'month' format: expected YYYY-MM", error: true };
          const parsed = new Date(monthStr + "-01T12:00:00");
          if (isNaN(parsed.getTime()) || parsed.getMonth() !== parseInt(monthStr.slice(5, 7), 10) - 1) {
            return { result: "Invalid 'month' value: month does not exist", error: true };
          }
          firstOfMonth = `${monthStr}-01`;
        } else {
          const todayStr = getDateInTimezone();
          const d = new Date(todayStr + "T12:00:00");
          firstOfMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
        }
        const field = artifactAction === "set_monthly_plan" ? "monthlyPlanPageId" : "monthlyReflectionPageId";
        await setArtifact(firstOfMonth, "monthly", { [field]: libraryPageId });
        return { result: `${field} set for month of ${firstOfMonth}: ${libraryPageId}` };
      }

      if (artifactAction === "set_quarterly_plan" || artifactAction === "set_quarterly_reflection") {
        let firstOfQuarter: string;
        if (args.quarter) {
          const quarterStr = String(args.quarter);
          const match = quarterStr.match(/^(\d{4})-Q([1-4])$/);
          if (!match) return { result: "Invalid 'quarter' format: expected YYYY-QN", error: true };
          const year = Number(match[1]);
          const q = Number(match[2]);
          firstOfQuarter = `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01`;
        } else {
          const todayStr = getDateInTimezone();
          const d = new Date(todayStr + "T12:00:00");
          const startMonth = Math.floor(d.getMonth() / 3) * 3 + 1;
          firstOfQuarter = `${d.getFullYear()}-${String(startMonth).padStart(2, "0")}-01`;
        }
        const field = artifactAction === "set_quarterly_plan" ? "quarterlyPlanPageId" : "quarterlyReflectionPageId";
        await setArtifact(firstOfQuarter, "quarterly", { [field]: libraryPageId });
        return { result: `${field} set for quarter of ${firstOfQuarter}: ${libraryPageId}` };
      }

      return { result: `Unknown goals artifact action: ${artifactAction}`, error: true };
    }

    async function getDailyArtifacts(args: Record<string, any>): Promise<ToolHandlerResult> {
      const { getArtifacts } = await import("./period-artifact-storage");
      const date = args.date || (await import("./timezone")).getDateInTimezone();
      const parsed = parseLocalDate(String(date), "date");
      if ("error" in parsed) return { result: parsed.error, error: true };
      const artifacts = await getArtifacts(String(date), "daily");
      const lines: string[] = [`Daily artifacts for ${date}:`];
      lines.push(artifacts?.briefPageId ? `- Brief: ${artifacts.briefPageId}${artifacts.briefViewedAt ? ` (viewed ${artifacts.briefViewedAt})` : ""}` : "- Brief: not set");
      lines.push(artifacts?.reviewPageId ? `- Review: ${artifacts.reviewPageId}${artifacts.reviewViewedAt ? ` (viewed ${artifacts.reviewViewedAt})` : ""}` : "- Review: not set");
      if (artifacts?.dailyPlanPageId) lines.push(`- Daily plan: ${artifacts.dailyPlanPageId}`);
      return { result: lines.join("\n") };
    }

    try {
      switch (action) {
        case "list": {
          // The agent goals tool is a management surface: it must see dormant goals to update/reactivate them.
          const goals = await goalsService.listAll({ ...(args.filters || {}), includeDormant: true });
          if (goals.length === 0) return { result: "No goals in the system yet." };
          const lines = goals.map(g => `- ${g.shortName} [goal:${g.id}] (${g.horizon}, ${g.status || "active"}${(g.tags || []).length > 0 ? `, tags: ${g.tags.join(", ")}` : ""})`);
          return { result: `${goals.length} goals:\n${lines.join("\n")}` };
        }
        case "get": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          const parts = [`**${goal.shortName}** [goal:${goal.id}] — ${goal.horizon} — ${goal.status || "active"}`];
          parts.push(`Description: ${goal.description}`);
          if (goal.tags.length > 0) parts.push(`Tags: ${goal.tags.join(", ")}`);
          parts.push(`Owner: ${goal.owner}`);
          if (goal.parentId) parts.push(`Parent: ${goal.parentId}`);
          if (goal.notes.length > 0) parts.push(`Notes: ${goal.notes.map(n => n.content).join("; ")}`);
          return { result: parts.join("\n") };
        }
        case "create": {
          const shortName = args.shortName;
          if (!shortName) return { result: "Missing goal shortName", error: true };
          const { goal } = await goalsService.create({
            shortName,
            description: args.description || shortName,
            rawInput: args.rawInput || shortName,
            horizon: args.horizon || "this_year",
            owner: args.owner || "me",
            tags: args.tags || [],
            status: args.status || "active",
            targetDate: args.targetDate,
            periodDate: args.periodDate,
            periodWeek: args.periodWeek,
            periodMonth: args.periodMonth,
            source: args.source,
            blockedBy: args.blockedBy,
          });
          return { result: `Goal created: "${goal.shortName}" [goal:${goal.id}] (horizon: ${goal.horizon}, status: ${goal.status}, tags: ${goal.tags.join(", ") || "none"})` };
        }
        case "update": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const updates: Record<string, any> = {};
          if (args.shortName) updates.shortName = args.shortName;
          if (args.description) updates.description = args.description;
          if (args.horizon) updates.horizon = args.horizon;
          if (args.owner) updates.owner = args.owner;
          if (args.status) updates.status = args.status;
          if (args.targetDate !== undefined) updates.targetDate = args.targetDate;
          if (args.periodDate !== undefined) updates.periodDate = args.periodDate;
          if (args.periodWeek !== undefined) updates.periodWeek = args.periodWeek;
          if (args.periodMonth !== undefined) updates.periodMonth = args.periodMonth;
          if (args.source !== undefined) updates.source = args.source;
          if (args.blockedBy !== undefined) updates.blockedBy = args.blockedBy;
          const goal = await goalsService.update(id, updates);
          return { result: `Goal updated: "${goal.shortName}" [goal:${id}] — ${Object.entries(updates).map(([k, v]) => `${k}: ${v}`).join(", ")}` };
        }
        case "search": {
          const query = args.query;
          if (!query) return { result: "Missing search query", error: true };
          const results = await goalsService.listAll({ search: query, includeDormant: true });
          if (results.length === 0) return { result: `No goals matching "${query}"` };
          const lines = results.map(g => `- ${g.shortName} [goal:${g.id}] (${g.horizon}, ${g.status || "active"}${(g.tags || []).length > 0 ? `, tags: ${g.tags.join(", ")}` : ""})`);
          return { result: `Found ${results.length} goals:\n${lines.join("\n")}` };
        }
        case "set_parent": {
          const id = args.id;
          const parentId = args.parentId;
          if (!id || !parentId) return { result: "Missing goal id or parentId", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          if (goal.parentId && goal.parentId !== parentId) {
            await goalsService.update(id, { parentId: null });
          }
          await goalsService.update(id, { parentId });
          return { result: `Parent set: [goal:${parentId}] → [goal:${id}]` };
        }
        case "unlink_parent": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          await goalsService.update(id, { parentId: null });
          return { result: `Parent unlinked from goal [goal:${id}]` };
        }
        case "delete": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          await goalsService.delete(id);
          return { result: `Goal deleted: "${goal.shortName}" [goal:${id}]` };
        }
        case "list_relationships": {
          const id = args.id;
          if (!id) return { result: "Missing goal id", error: true };
          const goal = await goalsService.get(id);
          if (!goal) return { result: `Goal ${id} not found`, error: true };
          const relationships = await goalsService.getRelationshipsDetail(id);
          if (relationships.length === 0) return { result: `No relationships linked to [goal:${id}]` };
          const lines = relationships.map(r => `- ${r.label} [@${r.targetType}:${r.targetId}] (link ${r.linkId})`);
          return { result: `${relationships.length} relationships for [goal:${id}]:\n${lines.join("\n")}` };
        }
        case "add_relationship": {
          const id = args.id;
          const targetType = args.targetType;
          const targetId = args.targetId;
          if (!id) return { result: "Missing goal id", error: true };
          if (targetType !== "person" && targetType !== "meeting") return { result: "targetType must be 'person' or 'meeting'", error: true };
          if (!targetId) return { result: "Missing targetId", error: true };
          const rel = await goalsService.addRelationship(id, targetType, String(targetId));
          return { result: `Linked @${targetType}:${rel.targetId} to [goal:${id}] (link ${rel.linkId})` };
        }
        case "remove_relationship": {
          const id = args.id;
          const linkId = args.linkId;
          if (!id || !linkId) return { result: "Missing goal id or linkId", error: true };
          await goalsService.removeRelationship(id, String(linkId));
          return { result: `Relationship ${linkId} removed from [goal:${id}]` };
        }
        case "set_review":
        case "set_daily_plan":
        case "set_weekly_reflection":
        case "set_weekly_plan":
        case "set_monthly_plan":
        case "set_monthly_reflection":
        case "set_quarterly_plan":
        case "set_quarterly_reflection":
          return await setCheckInArtifact(action, args);
        case "get_daily_artifacts":
          return await getDailyArtifacts(args);
        default:
          return { result: `Unknown goals action: ${action}. Available: list, get, create, update, delete, search, set_parent, unlink_parent, list_relationships, add_relationship, remove_relationship, set_review, set_daily_plan, get_daily_artifacts, set_weekly_reflection, set_weekly_plan, set_monthly_plan, set_monthly_reflection, set_quarterly_plan, set_quarterly_reflection`, error: true };
      }
    } catch (err: any) {
      return { result: `Goals tool error: ${err.message}`, error: true };
    }
  },

  blocking_graph: async (args) => {
    try {
      const { blockingGraphService } = await import("./blocking-graph-service");
      const action = args.action || "list_blockers";
      if (action === "list_blockers") {
        if (!args.sourceAddress) return { result: "Missing sourceAddress", error: true };
        return { result: JSON.stringify(await blockingGraphService.listBlockers({ sourceAddress: String(args.sourceAddress), lifecycle: args.lifecycle, cursor: args.cursor, limit: args.limit })) };
      }
      if (action === "list_blocked_items") {
        if (!args.targetAddress) return { result: "Missing targetAddress", error: true };
        return { result: JSON.stringify(await blockingGraphService.listBlockedItems({ targetAddress: String(args.targetAddress), lifecycle: args.lifecycle, cursor: args.cursor, limit: args.limit })) };
      }
      if (action === "add_blocker") {
        if (!args.sourceAddress || !args.targetAddress || !args.idempotencyKey) return { result: "add_blocker requires sourceAddress, targetAddress, and idempotencyKey", error: true };
        const edge = await blockingGraphService.createBlockedBy({ sourceAddress: String(args.sourceAddress), targetAddress: String(args.targetAddress), idempotencyKey: String(args.idempotencyKey), ...(args.provenanceAddress ? { provenanceAddress: String(args.provenanceAddress) } : {}) });
        return { result: JSON.stringify(edge), sideEffectOnly: true };
      }
      if (action === "remove_blocker") {
        if (!args.sourceAddress || !args.linkId) return { result: "remove_blocker requires sourceAddress and linkId", error: true };
        const edge = await blockingGraphService.retireBlockedBy({ sourceAddress: String(args.sourceAddress), linkId: String(args.linkId) });
        return { result: JSON.stringify(edge), sideEffectOnly: true };
      }
      return { result: `Unknown blocking_graph action: ${action}`, error: true };
    } catch (error) {
      return { result: `Blocking graph error: ${error instanceof Error ? error.message : String(error)}`, error: true };
    }
  },
  companies: companiesHandler,

  async people(args) {
    const action = args.action || "list";
    const handler = peopleSubHandlers[action];
    if (!handler) return { result: `Unknown people action: ${action}. Available: list, get, get_many, get_vault_memberships, add_vault_membership, remove_vault_membership, set_vault_memberships, query, search, agenda, add_note, update_note, delete_note, log_interaction, get_interactions, update_interaction, delete_interaction, update_relationship_profile, update_network_profile, update_capital, add_commitment, update_commitment, ask_route, add_relationship_memory, get_relationship_memories, enrichment_prompt, create, update, set_daily_contact, scan_imports, scan_ignored, search_import_candidates, list_import_candidates, get_import_candidate, find_import_matches, add_import_candidate, merge_import_candidate, skip_import_candidate, undo_import_decision, preview_import_batch, apply_import_batch, get_import_batch`, error: true };
    try {
      return await handler(args);
    } catch (err: any) {
      return { result: `People tool error: ${err.message}`, error: true };
    }
  },

  twitter: twitterHandler,

  gmail: gmailHandler,

  notion: notionHandler,

  async add_meeting(args) {
    try {
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      const start = typeof args.start === "string" ? args.start.trim() : "";
      const end = typeof args.end === "string" && args.end.trim() ? args.end.trim() : undefined;
      if (!summary) return { result: "Missing meeting summary/title", error: true };
      if (!start) return { result: "Missing start time. Provide an ISO 8601 datetime.", error: true };

      const { getTimezone } = await import("./timezone");
      const { requireCurrentPrincipal } = await import("./principal-context");
      const { meetingDraftStorage } = await import("./meeting-draft-storage");
      const principal = requireCurrentPrincipal();
      const attendees = Array.isArray(args.attendees)
        ? args.attendees.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0).map((value: string) => value.trim())
        : [];
      const draft = await meetingDraftStorage.create(principal, {
        sessionId: typeof args._sessionId === "string" ? args._sessionId : undefined,
        googleAccountId: typeof args.accountId === "string" ? args.accountId : undefined,
        calendarId: typeof args.calendarId === "string" ? args.calendarId : "primary",
        summary,
        start,
        end,
        timeZone: typeof args.timeZone === "string" && args.timeZone.trim() ? args.timeZone.trim() : getTimezone(),
        attendees,
        location: typeof args.location === "string" && args.location.trim() ? args.location.trim() : undefined,
        description: typeof args.description === "string" && args.description.trim() ? args.description.trim() : undefined,
        visibility: args.visibility,
      });
      return { result: `Meeting draft ready for human review: @meeting_draft:${draft.id}` };
    } catch (err: any) {
      return { result: `Failed to create meeting draft: ${err.message}`, error: true };
    }
  },

  // Guarded, single-purpose calendar-write tool: creates one timed block on the
  // user's OWN primary Google Calendar. External invites are unrepresentable by
  // construction — there is no attendees input — so this tool can never fan out
  // beyond the user's own calendar.
  async create_calendar_block(args) {
    try {
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      if (!summary) return { result: "Missing event title (summary).", error: true };

      const start = typeof args.start === "string" ? args.start.trim() : "";
      const end = typeof args.end === "string" ? args.end.trim() : "";
      if (!start || !end) {
        return { result: "Both start and end are required as ISO 8601 datetimes (timed events only).", error: true };
      }
      const startMs = Date.parse(start);
      const endMs = Date.parse(end);
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        return { result: "start and end must be valid ISO 8601 datetimes, e.g. 2026-07-29T14:00:00.", error: true };
      }
      if (endMs <= startMs) {
        return { result: "end must be after start.", error: true };
      }

      // GATE 1 — calendarCreate permission. checkGmailPermission resolves the
      // account through principal-scoped helpers before checking permission.
      const permCheck = await checkGmailPermission(args.accountId, "calendarCreate", "create calendar events");
      if (permCheck.denied) {
        toolExec.warn(`create_calendar_block blocked: calendarCreate denied (account=${args.accountId ?? "auto"})`);
        return permCheck.result;
      }

      const { getAccountScopes, listGmailAccounts } = await import("./gmail");
      const { hasCalendarAccess, createEvent } = await import("./google-calendar");

      // Resolve the concrete primary-calendar account (principal-scoped). When no
      // account was supplied, pick the first visible account with calendar access.
      let accountId = permCheck.resolvedAccountId;
      if (!accountId) {
        const accounts = await listGmailAccounts();
        for (const a of accounts) {
          if (await hasCalendarAccess(a.id)) { accountId = a.id; break; }
        }
      }
      if (!accountId) {
        toolExec.warn("create_calendar_block blocked: no connected Google account with calendar access");
        return { result: "No connected Google account has Calendar access. Connect or re-authorize Google Calendar in Settings → Integrations.", error: true };
      }

      // GATE 2 — calendar scope on the chosen account. Fail loudly with a helpful message.
      const scopes = await getAccountScopes(accountId);
      if (!scopes.hasCalendar) {
        toolExec.warn(`create_calendar_block blocked: account=${accountId} missing calendar scope`);
        return { result: "That Google account is not authorized for Calendar. Re-authorize Google Calendar in Settings → Integrations.", error: true };
      }

      const timeZone = typeof args.timeZone === "string" && args.timeZone.trim() ? args.timeZone.trim() : "America/Chicago";
      const description = typeof args.description === "string" && args.description.trim() ? args.description.trim() : undefined;
      const location = typeof args.location === "string" && args.location.trim() ? args.location.trim() : undefined;

      // Reuse the canonical createEvent write path. calendarId is always 'primary'
      // and there is deliberately no attendees field.
      const created = await createEvent(accountId, "primary", {
        summary,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        start: { dateTime: start, timeZone },
        end: { dateTime: end, timeZone },
      });

      await safeInvalidateCalendarCache("create_calendar_block");
      toolExec.info(`create_calendar_block created event id=${created.id} account=${accountId} start=${created.start?.dateTime ?? start}`);
      const startStr = created.start?.dateTime ?? start;
      const endStr = created.end?.dateTime ?? end;
      return {
        result: `Calendar block created: "${created.summary}" ${startStr} → ${endStr} (id ${created.id})${created.htmlLink ? ` — ${created.htmlLink}` : ""}`,
      };
    } catch (err: any) {
      toolExec.error(`create_calendar_block failed: ${err?.message ?? err}`);
      return { result: `Failed to create calendar block: ${err?.message ?? "unknown error"}. If Google Calendar access was revoked, re-authorize it in Settings → Integrations.`, error: true };
    }
  },

  async list_meetings(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarView", "view calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      const { listAllEvents, hasCalendarAccess } = await import("./google-calendar");
      const { listGmailAccounts } = await import("./gmail");

      const accounts = await listGmailAccounts();
      const connected = [];
      for (const a of accounts) {
        if (await hasCalendarAccess(a.id)) connected.push(a);
      }
      if (connected.length === 0) return {
        result: "No Google accounts with calendar access. Connect one in Settings > Integrations.",
        error: true,
        // Missing optional connector readiness is caller-correctable input, not run-terminal authority loss.
        failure: inputFailure("integration_not_configured", "google_calendar_access"),
      };

      const now = new Date();
      const defaultMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const timeMin = args.from || now.toISOString();
      const timeMax = args.to || defaultMax.toISOString();
      const maxResults = args.limit || 20;

      const { events, errors } = await listAllEvents({ timeMin, timeMax, maxResults });

      if (events.length === 0 && errors.length > 0) {
        const errorDetails = errors.map(e => `- Account ${e.accountId}: ${e.message}`).join("\n");
        return { result: `Failed to retrieve calendar events:\n${errorDetails}`, error: true };
      }

      if (events.length === 0) return { result: "No upcoming meetings found in the specified time range." };

      const formatTime = (iso: string) => {
        if (!iso || iso.length <= 10) return iso;
        try { return new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
        catch { return iso; }
      };

      const { listMetadataByEvents, getLinkedPeopleByMetadataIds, makeMetaKey } = await import("./calendar-metadata");

      const eventIdentities = events.filter(e => e.id).map(e => ({
        googleEventId: e.id,
        accountId: e.accountId,
        calendarId: e.calendarId,
      }));
      const allMeta = await listMetadataByEvents(eventIdentities).catch(() => []);
      const metaIds = allMeta.map(m => m.id);
      const allLinkedPeople = await getLinkedPeopleByMetadataIds(metaIds).catch(() => []);

      type MetaPerson = typeof allLinkedPeople[number];

      const metaByKey = new Map(allMeta.map(m => [makeMetaKey(m.googleEventId, m.accountId, m.calendarId), m]));
      const peopleByMetaId = new Map<number, MetaPerson[]>();
      for (const p of allLinkedPeople) {
        if (!peopleByMetaId.has(p.metadataId)) peopleByMetaId.set(p.metadataId, []);
        peopleByMetaId.get(p.metadataId)!.push(p);
      }

      const lines = events.map(e => {
        const attendees = (e.attendees || []).filter((a: any) => !a.self);
        const attendeeStr = attendees.length > 0 ? ` (with ${attendees.map((a: any) => a.displayName || a.email).slice(0, 4).join(", ")}${attendees.length > 4 ? ` +${attendees.length - 4}` : ""})` : "";
        const loc = e.location ? ` @ ${e.location}` : "";

        const meta = metaByKey.get(makeMetaKey(e.id, e.accountId, e.calendarId));
        let metaBadge = "";
        if (meta) {
          const linkedPeople = peopleByMetaId.get(meta.id) ?? [];

          if (meta.eventType === "meeting" && linkedPeople.length > 0) {
            metaBadge = ` [meeting — ${linkedPeople.map(p => p.personName).join(", ")}]`;
          } else {
            metaBadge = ` [${meta.eventType}]`;
          }
        }

        return `- ${formatTime(e.start?.dateTime || e.start?.date || "")} — **${e.summary}**${attendeeStr}${loc}${metaBadge} [id: ${e.id}, cal: ${e.calendarId}, acct: ${e.accountId}]`;
      });

      let result = `${events.length} meetings:\n${lines.join("\n")}`;
      if (errors.length > 0) {
        const errorDetails = errors.map(e => `- Account ${e.accountId}: ${e.message}`).join("\n");
        result += `\n\n⚠️ Some accounts had errors:\n${errorDetails}`;
      }

      return { result };
    } catch (err: any) {
      return { result: `Failed to list meetings: ${err.message}`, error: true };
    }
  },

  async update_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarEdit", "edit calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      const { updateEvent, hasCalendarAccess } = await import("./google-calendar");
      const { listGmailAccounts } = await import("./gmail");
      const { getTimezone } = await import("./timezone");

      const eventId = args.eventId;
      if (!eventId) return { result: "Missing eventId", error: true };

      const accounts = await listGmailAccounts();
      const connected = [];
      for (const a of accounts) {
        if (await hasCalendarAccess(a.id)) connected.push(a);
      }
      if (connected.length === 0) return {
        result: "No Google accounts with calendar access.",
        error: true,
        // Missing optional connector readiness is caller-correctable input, not run-terminal authority loss.
        failure: inputFailure("integration_not_configured", "google_calendar_access"),
      };

      const accountId = args.accountId || connected[0].id;
      const calendarId = args.calendarId || "primary";
      const tz = getTimezone();

      const updates: any = {};
      if (args.summary) updates.summary = args.summary;
      if (args.description) updates.description = args.description;
      if (args.location) updates.location = args.location;
      if (args.start) {
        updates.start = typeof args.start === "string"
          ? { dateTime: args.start, timeZone: tz }
          : args.start;
      }
      if (args.end) {
        updates.end = typeof args.end === "string"
          ? { dateTime: args.end, timeZone: tz }
          : args.end;
      }
      if (args.attendees) {
        updates.attendees = args.attendees.map((a: any) =>
          typeof a === "string" ? { email: a } : a
        );
      }
      if (args.visibility) updates.visibility = args.visibility;

      const updated = await updateEvent(accountId, calendarId, eventId, updates);
      await safeInvalidateCalendarCache("update_meeting");
      const changeStr = Object.keys(updates).join(", ");
      return { result: `Meeting updated: "${updated.summary}" — changed: ${changeStr}` };
    } catch (err: any) {
      return { result: `Failed to update meeting: ${err.message}`, error: true };
    }
  },

  async delete_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarDelete", "delete calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      const { deleteEvent, hasCalendarAccess } = await import("./google-calendar");
      const { listGmailAccounts } = await import("./gmail");

      const eventId = args.eventId;
      if (!eventId) return { result: "Missing eventId", error: true };

      const accounts = await listGmailAccounts();
      const connected = [];
      for (const a of accounts) {
        if (await hasCalendarAccess(a.id)) connected.push(a);
      }
      if (connected.length === 0) return {
        result: "No Google accounts with calendar access.",
        error: true,
        // Missing optional connector readiness is caller-correctable input, not run-terminal authority loss.
        failure: inputFailure("integration_not_configured", "google_calendar_access"),
      };

      const accountId = args.accountId || connected[0].id;
      const calendarId = args.calendarId || "primary";

      await deleteEvent(accountId, calendarId, eventId);
      await safeInvalidateCalendarCache("delete_meeting");
      return { result: `Meeting deleted (id: ${eventId})` };
    } catch (err: any) {
      return { result: `Failed to delete meeting: ${err.message}`, error: true };
    }
  },

  async set_metadata_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarEdit", "edit calendar event metadata");
      if (calPermCheck.denied) return calPermCheck.result;

      const { setMetadata, EVENT_TYPES, classifyEventByTitle, getLinkedPeople, autoLogMeetingInteractions } = await import("./calendar-metadata");
      const googleEventId = args.googleEventId || args.eventId;
      const accountId = args.accountId;
      const calendarId = args.calendarId || "primary";
      if (!googleEventId) return { result: "Missing googleEventId", error: true };
      if (!accountId) return { result: "Missing accountId", error: true };

      let eventType = args.eventType;
      let summary = args.summary;
      let eventEndTime: string | undefined;
      let eventDate: string | undefined;

      let attendeeEmails: string[] | undefined = args.attendeeEmails;
      if (!attendeeEmails || attendeeEmails.length === 0) {
        try {
          const { getEvent } = await import("./google-calendar");
          const calEvent = await getEvent(accountId, calendarId, googleEventId);
          if (!summary) summary = calEvent.summary || "";
          eventEndTime = calEvent.end?.dateTime || calEvent.end?.date;
          eventDate = (calEvent.start?.dateTime || calEvent.start?.date || "").slice(0, 10);
          attendeeEmails = (calEvent.attendees || [])
            .filter((a: any) => a.email && !a.self)
            .map((a: any) => a.email as string);
        } catch (_) {
          attendeeEmails = [];
        }
      }

      if (!eventType && summary) {
        eventType = classifyEventByTitle(summary) || "meeting";
      }
      if (!eventType) return { result: `Missing eventType. Valid types: ${EVENT_TYPES.join(", ")}`, error: true };
      if (!EVENT_TYPES.includes(eventType)) {
        return { result: `Invalid eventType "${eventType}". Valid types: ${EVENT_TYPES.join(", ")}`, error: true };
      }

      const speakerPolicy = typeof args.sharedRoom === "boolean"
        ? { mode: args.sharedRoom ? "shared_room" as const : "participant_streams" as const }
        // Legacy attendee-email input now toggles the meeting-level topology.
        // The room occupants never need to match a calendar identity.
        : args.sharedAudioAttendeeEmail
          ? { mode: "shared_room" as const }
          : args.sharedAudioAttendeeEmail === null
            ? { mode: "participant_streams" as const }
            : undefined;
      const meta = await setMetadata(googleEventId, accountId, calendarId, eventType, args.notes, attendeeEmails, undefined, undefined, speakerPolicy);
      if (args.agendaLibraryPageId || args.agenda !== undefined) {
        const { setMeetingAgendaPage } = await import("./calendar-metadata");
        await setMeetingAgendaPage(meta, args.agendaLibraryPageId, args.agenda, summary || "Meeting");
      }
      const linkedPeople = await getLinkedPeople(meta.id);
      const peopleStr = linkedPeople.length > 0
        ? ` Auto-linked people: ${linkedPeople.map(p => p.personName).join(", ")}.`
        : "";

      // Auto-log meeting interactions for linked people when the event has ended
      let interactionStr = "";
      if (linkedPeople.length > 0 && eventEndTime) {
        const hasEnded = new Date(eventEndTime) <= new Date();
        if (hasEnded) {
          const logDate = eventDate || new Date().toISOString().slice(0, 10);
          const logResults = await autoLogMeetingInteractions(linkedPeople, summary || "Meeting", logDate);
          const logged = logResults.filter(r => r.logged);
          if (logged.length > 0) {
            interactionStr = ` Auto-logged interactions (responseOwed +3d) for: ${logged.map(r => r.personName).join(", ")}.`;
          }
        } else {
          const { createLogger } = await import("./log");
          createLogger("BridgeTools:set_metadata").debug(`skipping auto-log — event "${summary}" has not ended yet (ends ${eventEndTime})`);
        }
      }

      return { result: `Metadata set for event ${googleEventId}: type=${eventType}${args.notes ? `, notes recorded` : ""}${args.agendaLibraryPageId || args.agenda !== undefined ? `, agenda page linked` : ""}.${peopleStr}${interactionStr} (metadataId: ${meta.id})` };
    } catch (err: any) {
      return { result: `Failed to set metadata: ${err.message}`, error: true };
    }
  },

  async get_metadata_meeting(args) {
    try {
      const calPermCheck = await checkGmailPermission(args.accountId, "calendarView", "view calendar event metadata");
      if (calPermCheck.denied) return calPermCheck.result;

      const { getMetadata, getLinkedPeople, getLinkedArtifacts, resolveMeetingAgendaPage } = await import("./calendar-metadata");
      const googleEventId = args.googleEventId || args.eventId;
      const accountId = args.accountId;
      const calendarId = args.calendarId || "primary";
      if (!googleEventId) return { result: "Missing googleEventId", error: true };
      if (!accountId) return { result: "Missing accountId", error: true };

      const meta = await getMetadata(googleEventId, accountId, calendarId);
      if (!meta) return { result: `No metadata found for event ${googleEventId}` };

      const [people, artifacts, agendaPage] = await Promise.all([
        getLinkedPeople(meta.id),
        getLinkedArtifacts(meta.id),
        resolveMeetingAgendaPage(meta),
      ]);

      const lines: string[] = [
        `Event: ${googleEventId}`,
        `Type: ${meta.eventType}`,
        ...(meta.notes ? [`Notes: ${meta.notes}`] : []),
        ...(agendaPage ? [`Agenda: @page:${agendaPage.id}`] : meta.agenda ? [`Legacy private agenda:\n${meta.agenda}`] : []),
      ];


      if (people.length > 0) {
        lines.push(`Linked people: ${people.map(p => p.personName).join(", ")}`);
      }

      if (artifacts.length > 0) {
        lines.push(`Linked artifacts:`);
        for (const a of artifacts) {
          const label = a.title || a.libraryPageId;
          lines.push(`  - [linkId: ${a.id}] ${label} (${a.artifactKind}) @page:${a.libraryPageId}`);
        }
      }

      return { result: lines.join("\n") };
    } catch (err: any) {
      return { result: `Failed to get metadata: ${err.message}`, error: true };
    }
  },

  async link_artifact_meeting(args) {
    try {
      const { linkArtifact, getMetadataByIds, setMeetingAgendaPage } = await import("./calendar-metadata");
      const metadataId = args.metadataId;
      const libraryPageId = args.libraryPageId || args.pageId || args.artifactId;
      const artifactKind = String(args.artifactKind || args.kind || "").trim();
      if (!metadataId) return { result: "Missing metadataId", error: true };
      if (!libraryPageId) return { result: "Missing libraryPageId", error: true };
      if (!artifactKind) return { result: "Missing artifactKind. Use set_metadata with agendaLibraryPageId for meeting preparation, or provide an explicit non-preparation kind such as research, follow_up, or recap.", error: true };

      const metaRows = await getMetadataByIds([metadataId]);
      if (!metaRows[0]) return { result: `No calendar event metadata found for id ${metadataId}`, error: true };
      const accountId = metaRows[0].accountId;

      const calPermCheck = await checkGmailPermission(accountId, "calendarEdit", "link artifacts to calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      let title = args.title;
      try {
        const { getVisibleLibraryPage } = await import("./calendar-metadata");
        const page = await getVisibleLibraryPage(String(libraryPageId));
        if (!page) return { result: `Library page not found: ${libraryPageId}`, error: true };
        title = title || page.title;
        if (artifactKind === "agenda" || artifactKind === "brief") {
          const canonicalPage = await setMeetingAgendaPage(metaRows[0], page.id);
          return { result: `Canonical meeting preparation page: @page:${canonicalPage.id}. Update this page for agenda or brief preparation.` };
        }
        const link = await linkArtifact(metadataId, page.id, artifactKind, title, args.source || "meetings_tool");
        return { result: `Linked artifact "${title || page.id}" to calendar event metadata (linkId: ${link.id})` };
      } catch (lookupErr: any) {
        return { result: `Failed to resolve library page: ${lookupErr.message}`, error: true };
      }
    } catch (err: any) {
      return { result: `Failed to link artifact: ${err.message}`, error: true };
    }
  },

  async unlink_artifact_meeting(args) {
    try {
      const { unlinkArtifact, getLinkedArtifactById, getMetadataByIds } = await import("./calendar-metadata");
      const linkId = args.linkId;
      if (!linkId) return { result: "Missing linkId", error: true };

      const artifactLink = await getLinkedArtifactById(linkId);
      if (!artifactLink) return { result: `Artifact link ${linkId} not found`, error: true };

      const metaRows = await getMetadataByIds([artifactLink.metadataId]);
      if (!metaRows[0]) return { result: `Calendar event metadata not found for link ${linkId}`, error: true };
      const accountId = metaRows[0].accountId;

      const calPermCheck = await checkGmailPermission(accountId, "calendarEdit", "remove artifact links from calendar events");
      if (calPermCheck.denied) return calPermCheck.result;

      await unlinkArtifact(linkId);
      return { result: `Artifact link ${linkId} removed` };
    } catch (err: any) {
      return { result: `Failed to unlink artifact: ${err.message}`, error: true };
    }
  },

  async scenarios(args) {
    const { strategyStorage } = await import("./strategy-storage");
    const action = args.action || "list_scenarios";
    const handler = strategySubHandlers[action];
    if (!handler) return { result: `Unknown scenarios action: ${action}. Available: ${STRATEGY_ACTIONS}`, error: true };
    try {
      return await handler(args, strategyStorage);
    } catch (err: any) {
      return { result: `Strategy tool error: ${err.message}`, error: true };
    }
  },

  decisions: decisionsHandler,


  async work(args) {
    const { fileProjectStorage } = await import("./file-storage/projects");
    const { fileTaskStorage } = await import("./file-storage/tasks");
    const { goalsService: goalsServiceWork } = await import("./goals-service");
    const { chatFileStorage } = await import("./chat-file-storage");

    const action = args.action || "status";
    const sourceSessionId = typeof args._sessionId === "string" && args._sessionId.trim() ? args._sessionId.trim() : null;
    const sourceSession = sourceSessionId
      ? await chatFileStorage.getSession(sourceSessionId).catch(() => undefined)
      : undefined;
    if (sourceSession?.type === "meeting" && !sourceSession.vaultId) {
      return { result: `Meeting session ${sourceSessionId} has no pinned vault`, error: true };
    }
    const sourceMeetingVaultId = sourceSession?.type === "meeting" ? sourceSession.vaultId : undefined;

    try {
      switch (action) {
        case "create_project": {
          if (!args.title) return { result: "Missing required field: title", error: true };
          const { insertProjectSchema: projectInsertSchema } = await import("../shared/models/work");
          const input = projectInsertSchema.parse({
            title: args.title,
            ...(args.description !== undefined && { description: args.description }),
            ...(args.status !== undefined && { status: args.status }),
            ...(args.priority !== undefined && { priority: args.priority }),
            ...(args.owner !== undefined && { owner: args.owner }),
            ...(args.dueDate !== undefined && { dueDate: args.dueDate }),
            ...(args.tags !== undefined && { tags: args.tags }),
            ...(args.people !== undefined && { people: args.people }),
            ...(args.goalId !== undefined && { goalId: args.goalId }),
            ...(args.blockedBy !== undefined && { blockedBy: args.blockedBy }),
            ...(sourceMeetingVaultId ? { vaultId: sourceMeetingVaultId } : {}),
          });
          const project = await fileProjectStorage.createProject(
            input,
            sourceSession?.type === "meeting" && sourceSessionId
              ? { originType: "meeting", originId: sourceSessionId }
              : undefined,
          );
          return { result: `Project created successfully. ID: ${project.id}, title: "${project.title}", status: ${project.status}, priority: ${project.priority}.` };
        }
        case "status":
        case "list_projects": {
          const statusFilter = args.status || undefined;
          const projects = await fileProjectStorage.getProjects(statusFilter ? { status: statusFilter } : undefined);
          if (projects.length === 0) return { result: statusFilter ? `No ${statusFilter} projects.` : "No projects found." };
          const allGoals = await goalsServiceWork.listAll({ includeDormant: true });
          const goalMap = new Map(allGoals.map((g: any) => [g.id, g.shortName]));

          const projectsByStatus = new Map<string, any[]>();
          for (const p of projects) {
            const s = p.status || "unknown";
            if (!projectsByStatus.has(s)) projectsByStatus.set(s, []);
            projectsByStatus.get(s)!.push(p);
          }

          const statusOrder = ["active", "planning", "idea", "completed", "archived"];
          const sortedStatuses = [...projectsByStatus.keys()].sort((a, b) => {
            const ia = statusOrder.indexOf(a);
            const ib = statusOrder.indexOf(b);
            return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
          });

          const taskCounts = await fileTaskStorage.getTaskCountsByProject(projects.map((project: any) => project.id));
          const sections: string[] = [];
          for (const status of sortedStatuses) {
            const group = projectsByStatus.get(status)!;
            const lines = group.map((p: any) => {
              const milestoneCount = p.milestones?.length || 0;
              const taskCount = taskCounts.get(p.id) ?? 0;
              const goalPart = p.goalId ? `, goalId: ${p.goalId}, goalName: "${goalMap.get(p.goalId) || "unknown"}"` : "";
              return `- **${p.title}** (id: ${p.id}, ${p.status}${goalPart}) — ${milestoneCount} milestones, ${taskCount} tasks`;
            });
            sections.push(`## ${status.charAt(0).toUpperCase() + status.slice(1)}\n${lines.join("\n")}`);
          }

          const label = statusFilter ? `${projects.length} ${statusFilter} projects` : `${projects.length} projects across all statuses`;
          return { result: `${label}:\n\n${sections.join("\n\n")}` };
        }
        case "get_project": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const project = await fileProjectStorage.getProject(Number(projectId));
          if (!project) return { result: `Project ${projectId} not found`, error: true };
          const [statusCounts, taskPage] = await Promise.all([
            fileTaskStorage.getTaskStatusCounts(project.id),
            fileTaskStorage.getTaskPage({
              projectId: project.id,
              statuses: ["active", "ready", "on_hold"],
              limit: 12,
              offset: 0,
            }),
          ]);
          const totalTasks = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
          let goalName = "";
          if (project.goalId) {
            const goal = await goalsServiceWork.get(project.goalId);
            goalName = goal ? goal.shortName : project.goalId;
          }
          const parts = [`**${project.title}** (id: ${project.id}, ${project.status}, priority: ${project.priority}${project.goalId ? `, goalId: ${project.goalId}, goalName: "${goalName}"` : ""})`];
          if (project.description) parts.push(`Description: ${project.description}`);
          if (project.milestones?.length) {
            parts.push(`Milestones: ${project.milestones.map((m: any) => `[${m.id}] ${m.name} (${m.status || "pending"})`).join(", ")}`);
          }
          parts.push(`Task summary (${totalTasks} total): active ${statusCounts.active}, ready ${statusCounts.ready}, on_hold ${statusCounts.on_hold}, done ${statusCounts.done}.`);
          if (taskPage.tasks.length > 0) {
            const taskLines = taskPage.tasks.map((task: any) => formatTaskForBridge(task));
            const remaining = Math.max(0, statusCounts.active + statusCounts.ready + statusCounts.on_hold - taskPage.tasks.length);
            parts.push(`Actionable tasks (showing ${taskPage.tasks.length}${remaining ? `, ${remaining} more` : ""}):\n${taskLines.join("\n")}\nUse work.list_tasks with id=${project.id}, taskStatus, limit, and offset for a bounded page.`);
          } else {
            parts.push("No actionable tasks. Use work.list_tasks with taskStatus=done for completed history.");
          }
          if (project.notes?.length) {
            const noteLines = project.notes.map((n: any) => `  - [${n.id}] ${n.content.slice(0, 100)}${n.content.length > 100 ? "..." : ""}`);
            parts.push(`Notes (${project.notes.length}):\n${noteLines.join("\n")}`);
          }
          if (project.files?.length) {
            const fileLines = project.files.map((f: any) => `  - [${f.id}] ${f.name} (${f.mimeType})`);
            parts.push(`Files (${project.files.length}):\n${fileLines.join("\n")}`);
          }
          return { result: parts.join("\n") };
        }
        case "list_tasks": {
          const projectId = args.id;
          const limit = Math.max(1, Math.min(parseInt(args.limit) || 25, 100));
          const offset = Math.max(0, Math.min(parseInt(args.offset) || 0, 10_000));
          const status = args.taskStatus || (["on_hold", "ready", "active", "done"].includes(args.status) ? args.status : undefined);
          const page = await fileTaskStorage.getTaskPage({
            ...(projectId ? { projectId: Number(projectId) } : {}),
            ...(status ? { status } : {}),
            limit,
            offset,
          });
          if (page.total === 0) return { result: projectId ? `No tasks for project ${projectId}.` : "No tasks found." };
          const lines = page.tasks.map((task: any) => formatTaskForBridge(task));
          const shownFrom = page.tasks.length > 0 ? offset + 1 : 0;
          const shownTo = offset + page.tasks.length;
          const remaining = Math.max(0, page.total - shownTo);
          const parts = [`${page.total} total tasks${projectId ? ` for project ${projectId}` : ""}${status ? ` with status ${status}` : ""} (showing ${shownFrom}–${shownTo}):\n${lines.join("\n")}`];
          if (remaining > 0) parts.push(`\n→ ${remaining} more. Use offset=${shownTo} for the next bounded page.`);
          return { result: parts.join("") };
        }
        case "add_file": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const project = await fileProjectStorage.getProject(Number(projectId));
          if (!project) return { result: `Project ${projectId} not found`, error: true };
          const { requireCurrentUserPrincipal } = await import("./principal-context");
          const principal = requireCurrentUserPrincipal();
          const workspacePath = args.workspacePath;
          let objectKey = args.fileObjectKey;
          let fileName = args.fileName;
          let fileSize = args.fileSize || 0;
          let mimeType = args.fileMimeType || "";

          if (workspacePath) {
            const { promises: fs } = await import("fs");
            const { join, basename, extname, resolve } = await import("path");
            const { WORKSPACE_DIR } = await import("./paths");
            const absPath = resolve(WORKSPACE_DIR, workspacePath);
            if (!absPath.startsWith(WORKSPACE_DIR + "/")) {
              return { result: "workspacePath must be within the workspace directory", error: true };
            }
            try {
              await fs.access(absPath);
            } catch {
              return { result: `File not found at workspace path: ${workspacePath}`, error: true };
            }
            const stat = await fs.stat(absPath);
            fileSize = stat.size;
            if (!fileName) fileName = basename(absPath);
            if (!mimeType) {
              const ext = extname(fileName).toLowerCase();
              mimeType = MIME_MAP[ext] || "application/octet-stream";
            }

            const fileBuffer = await fs.readFile(absPath);
            const uploaded = await objectStorageService.uploadObjectEntity(fileBuffer, {
              extension: extname(fileName),
              contentType: mimeType,
              principal,
              acl: {
                owner: principal.userId,
                ownerUserId: principal.userId,
                accountId: principal.accountId,
                createdByUserId: principal.userId,
                scope: "user",
                visibility: "private",
              },
            });
            objectKey = uploaded.objectPath;
          }

          if (!fileName || !objectKey) return { result: "Missing fileName or fileObjectKey (or workspacePath)", error: true };
          if (!mimeType) mimeType = "application/octet-stream";
          if (!workspacePath) {
            const normalizedObjectPath = objectKey.startsWith("/objects/") ? objectKey : `/objects/${objectKey}`;
            const objectFile = await objectStorageService.getObjectEntityFile(normalizedObjectPath, principal);
            const canReadObject = await objectStorageService.canAccessObjectEntity({
              principal,
              objectFile,
              requestedPermission: ObjectPermission.READ,
            });
            if (!canReadObject) {
              return { result: "Cannot attach an object that is not visible to the current user", error: true };
            }
            objectKey = normalizedObjectPath;
          }
          const fileEntry = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            name: fileName,
            mimeType,
            objectKey,
            size: fileSize,
            uploadedAt: new Date().toISOString(),
          };
          const fileProject = await fileProjectStorage.addFile(Number(projectId), fileEntry);
          if (!fileProject) return { result: `Project ${projectId} not found`, error: true };
          return { result: `File "${fileName}" attached to project ${projectId} (file id: ${fileEntry.id}, stored in object storage)` };
        }
        case "read_file": {
          const projectId = args.id;
          const fileId = args.fileId;
          if (!projectId || !fileId) return { result: "Missing project id or file id", error: true };
          const proj = await fileProjectStorage.getProject(Number(projectId));
          if (!proj) return { result: `Project ${projectId} not found`, error: true };
          const fileEntry = proj.files.find((f: any) => f.id === fileId);
          if (!fileEntry) return { result: `File ${fileId} not found in project ${projectId}`, error: true };
          const textTypes = ["text/", "application/json", "application/xml", "application/javascript", "application/typescript", "application/x-yaml", "application/yaml", "application/toml"];
          const textExts = [".md", ".txt", ".json", ".yaml", ".yml", ".xml", ".csv", ".js", ".ts", ".py", ".sh", ".toml", ".ini", ".cfg", ".html", ".css", ".svg", ".log"];
          const isText = textTypes.some(t => fileEntry.mimeType.startsWith(t)) ||
            fileEntry.mimeType === "application/octet-stream" && textExts.some(ext => fileEntry.name.toLowerCase().endsWith(ext));
          if (!isText) return { result: `File "${fileEntry.name}" is a binary file (${fileEntry.mimeType}) and cannot be read as text. It can be viewed in the web UI.`, error: true };
          try {
            const objectPath = fileEntry.objectKey.startsWith("/objects/") ? fileEntry.objectKey : `/objects/${fileEntry.objectKey}`;
            const objectFile = await objectStorageService.getObjectEntityFile(objectPath);
            const [buffer] = await objectFile.download();
            const content = buffer.toString("utf-8");
            const offset = typeof args?.offset === "number" && args.offset >= 0 ? args.offset : 0;
            const limit = typeof args?.limit === "number" && args.limit > 0 ? args.limit : undefined;
            if (offset > 0 || limit !== undefined) {
              const slice = limit !== undefined ? content.slice(offset, offset + limit) : content.slice(offset);
              return { result: `File "${fileEntry.name}" (offset=${offset}, showing ${slice.length} of ${content.length} chars):\n\n${slice}` };
            }
            if (content.length > 50000) {
              const { indexAndArchiveWithFallback } = await import("./content-indexer");
              const refBlock = await indexAndArchiveWithFallback({
                content,
                sourceType: "file",
                sourceLabel: fileEntry.name,
              });
              return { result: `File "${fileEntry.name}" (${content.length} chars):\n\n${refBlock}` };
            }
            return { result: `File "${fileEntry.name}" (${content.length} chars):\n\n${content}` };
          } catch (err: any) {
            return { result: `Failed to read file "${fileEntry.name}": ${err.message}`, error: true };
          }
        }
        case "remove_file": {
          const projectId = args.id;
          const fileId = args.fileId;
          if (!projectId || !fileId) return { result: "Missing project id or file id", error: true };
          const removedFile = await fileProjectStorage.removeFile(Number(projectId), fileId);
          if (!removedFile) return { result: `Project ${projectId} or file ${fileId} not found`, error: true };
          return { result: `File "${removedFile.name}" removed from project ${projectId}` };
        }
        case "add_milestone": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const name = args.name;
          if (!name) return { result: "Missing milestone name", error: true };
          const milestoneProject = await fileProjectStorage.addMilestone(
            Number(projectId),
            {
              name,
              status: args.milestoneStatus,
              startDate: args.startDate || null,
              dueDate: args.dueDate || null,
              blockedBy: args.blockedBy,
            },
            sourceSession?.type === "meeting" && sourceSessionId
              ? { originType: "meeting", originId: sourceSessionId }
              : undefined,
          );
          if (!milestoneProject) return { result: `Project ${projectId} not found`, error: true };
          const addedMilestone = milestoneProject.milestones.reduce((latest, milestone) =>
            !latest || milestone.id > latest.id ? milestone : latest,
          null as (typeof milestoneProject.milestones)[number] | null);
          if (!addedMilestone) return { result: `Milestone "${name}" was added but could not be reloaded`, error: true };
          return { result: `Milestone "${name}" added to project ${projectId} (milestone id: ${addedMilestone.id})` };
        }
        case "update_milestone": {
          const projectId = args.id;
          const milestoneId = args.milestoneId;
          if (!projectId || !milestoneId) return { result: "Missing project id or milestone id", error: true };
          const preUpdateProject = await fileProjectStorage.getProject(Number(projectId));
          if (!preUpdateProject) return { result: `Project ${projectId} not found`, error: true };
          if (!preUpdateProject.milestones.some(m => m.id === Number(milestoneId))) {
            return { result: `Milestone ${milestoneId} not found in project ${projectId}`, error: true };
          }
          const updates: Record<string, string | number | null> = {};
          if (args.name) updates.name = args.name;
          const msStatus = args.milestoneStatus;
          if (msStatus) updates.status = msStatus;
          if (args.startDate) updates.startDate = args.startDate;
          if (args.dueDate) updates.dueDate = args.dueDate;
          if (args.order !== undefined) updates.order = args.order;
          if (args.blockedBy !== undefined) updates.blockedBy = args.blockedBy;
          await fileProjectStorage.updateMilestone(Number(projectId), Number(milestoneId), updates);
          return { result: `Milestone ${milestoneId} updated on project ${projectId}` };
        }
        case "remove_milestone": {
          const projectId = args.id;
          const milestoneId = args.milestoneId;
          if (!projectId || !milestoneId) return { result: "Missing project id or milestone id", error: true };
          const preRemoveProject = await fileProjectStorage.getProject(Number(projectId));
          if (!preRemoveProject) return { result: `Project ${projectId} not found`, error: true };
          if (!preRemoveProject.milestones.some(m => m.id === Number(milestoneId))) {
            return { result: `Milestone ${milestoneId} not found in project ${projectId}`, error: true };
          }
          await fileProjectStorage.removeMilestone(Number(projectId), Number(milestoneId));
          return { result: `Milestone ${milestoneId} removed from project ${projectId}` };
        }
        case "set_goal": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const goalId = args.goalId || null;
          if (goalId) {
            const goal = await goalsServiceWork.get(goalId);
            if (!goal) return { result: `Goal ${goalId} not found`, error: true };
          }
          const updated = await fileProjectStorage.updateProject(Number(projectId), { goalId });
          if (!updated) return { result: `Project ${projectId} not found`, error: true };
          if (goalId) {
            const goal = await goalsServiceWork.get(goalId);
            return { result: `Project ${projectId} linked to goal "${goal?.shortName || goalId}"` };
          }
          return { result: `Goal cleared from project ${projectId}` };
        }
        case "update_project": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };

          const { sanitizePatch, PatchGuardError, logPatchClearAudit } = await import("./lib/patch-guard");

          const raw: Record<string, unknown> = {};
          if (args.title !== undefined) raw.title = args.title;
          if (args.description !== undefined) raw.description = args.description;
          if (args.status !== undefined) raw.status = args.status;
          if (args.priority !== undefined) raw.priority = args.priority;
          if (args.owner !== undefined) raw.owner = args.owner;
          if (args.dueDate !== undefined) raw.dueDate = args.dueDate;
          if (args.tags !== undefined) raw.tags = args.tags;
          if (args.people !== undefined) raw.people = args.people;
          if (args.goalId !== undefined) raw.goalId = args.goalId;
          if (args.clearFields !== undefined) raw.clearFields = args.clearFields;
          if (args.confirmDestructiveUpdate !== undefined) raw.confirmDestructiveUpdate = args.confirmDestructiveUpdate;
          if (args.destructiveUpdateReason !== undefined) raw.destructiveUpdateReason = args.destructiveUpdateReason;

          try {
            const { patch: updates, clearFields, destructiveUpdateReason } = sanitizePatch(raw, {
              protectedFields: ['title', 'description'] as Array<keyof any>,
              clearableFields: ['description'] as Array<keyof any>,
              destructiveFields: ['description'] as Array<keyof any>,
            });

            // Apply explicit clears as null values
            for (const field of clearFields) {
              (updates as Record<string, unknown>)[field as string] = null;
            }
            logPatchClearAudit(toolExec, {
              operation: "projects.update_project",
              entityType: "project",
              entityId: projectId,
              clearFields,
              destructiveUpdateReason,
            });

            if (Object.keys(updates).length === 0) return { result: "No fields to update after sanitization. Empty strings on protected fields are dropped — use clearFields to explicitly clear a field.", error: true };

            const updatedProject = await fileProjectStorage.updateProject(Number(projectId), updates);
            if (!updatedProject) return { result: `Project ${projectId} not found`, error: true };
            return { result: `Project ${projectId} updated: ${Object.keys(updates).join(", ")}` };
          } catch (err: any) {
            if (err instanceof PatchGuardError) {
              return { result: `Patch guard rejected update: ${err.message}${err.required ? ` Required: ${JSON.stringify(err.required)}` : ''}`, error: true };
            }
            return { result: `Failed to update project: ${err instanceof Error ? err.message : String(err)}`, error: true };
          }
        }
        case "set_status": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const newStatus = args.status;
          if (!newStatus) return { result: "Missing status. Options: idea, planning, active, on_hold, completed", error: true };
          const validStatuses = ["idea", "planning", "active", "on_hold", "completed"];
          if (!validStatuses.includes(newStatus)) return { result: `Invalid status "${newStatus}". Options: ${validStatuses.join(", ")}`, error: true };
          const statusProject = await fileProjectStorage.updateProject(Number(projectId), { status: newStatus });
          if (!statusProject) return { result: `Project ${projectId} not found`, error: true };
          return { result: `Project ${projectId} status set to "${newStatus}"` };
        }
        case "delete_project": {
          const projectId = args.id;
          if (!projectId) return { result: "Missing project id", error: true };
          const deleted = await fileProjectStorage.deleteProject(Number(projectId));
          if (!deleted) return { result: `Project ${projectId} not found`, error: true };
          return { result: `Project ${projectId} deleted` };
        }
        default:
          return contractReject(
            `Unknown work action: ${action}. Available: create_project, update_project, set_status, delete_project, status, list_projects, get_project, list_tasks, set_goal, add_note, update_note, remove_note, read_note, add_file, read_file, remove_file, add_milestone, update_milestone, remove_milestone`,
            "work_input_invalid",
            String(action ?? "missing"),
          );
      }
    } catch (err: any) {
      return { result: `Work tool error: ${err.message}`, error: true };
    }
  },
  async git(args) {
    const { execFile } = await import("child_process");
    const { constants } = await import("fs");
    const { createHash } = await import("crypto");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { resolve, basename, relative, sep } = await import("path");
    const { mkdir: mkdirAsync, writeFile: writeFileAsync, unlink: unlinkAsync, access: accessAsync, symlink: symlinkAsync, readFile: readFileAsync, rm: rmAsync, lstat: lstatAsync, readlink: readlinkAsync } = await import("fs/promises");

    async function dirExists(p: string): Promise<boolean> {
      try { await accessAsync(p); return true; } catch { return false; }
    }

    async function executableExists(p: string): Promise<boolean> {
      try { await accessAsync(p, constants.X_OK); return true; } catch { return false; }
    }

    const REPOS_DIR = resolve(WORKSPACE_DIR, "repos");
    const MAX_OUTPUT = 10000;
    const action = args.action;

    if (!action) return { result: "Missing action parameter", error: true };

    const SAFE_REF = /^[a-zA-Z0-9_.\/~@^{}\-]+$/;
    const SAFE_BRANCH = /^[a-zA-Z0-9_.\/-]+$/;

    function sanitizeRef(val: string | undefined): string | null {
      if (!val) return null;
      if (!SAFE_REF.test(val)) return null;
      return val;
    }

    function sanitizeBranch(val: string | undefined): string | null {
      if (!val) return null;
      if (!SAFE_BRANCH.test(val)) return null;
      return val;
    }

    function truncate(output: string, limit = MAX_OUTPUT): string {
      if (output.length <= limit) return output;
      return output.slice(0, limit) + `\n... [truncated, ${output.length - limit} chars omitted]`;
    }

    function scrubTokens(text: string): string {
      return text
        .replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@")
        .replace(/https:\/\/[^@\s]+@github\.com/g, "https://***@github.com");
    }

    function resolveRepoDir(directory?: string): string | null {
      if (!directory) return null;
      const dir = resolve(REPOS_DIR, directory);
      const rel = relative(REPOS_DIR, dir);
      if (rel.startsWith("..") || rel.startsWith(sep)) return null;
      if (rel.length === 0) return null;
      return dir;
    }

    const SELF_DIR_ALIASES = new Set([".", "self", ""]);

    // Session isolation: extract the first 8 chars of the calling session ID.
    // Every clone gets a session-scoped directory. Write operations are restricted
    // to directories owned by the calling session. Read operations are unrestricted.
    const callingSessionId: string | undefined = args._sessionId;
    const sessionSuffix = callingSessionId ? callingSessionId.slice(0, 8) : "";

    function isOwnedBySession(dirName: string): boolean {
      if (!sessionSuffix) return true; // no session context → skip check (e.g. system calls)
      return dirName.endsWith(`-${sessionSuffix}`);
    }

    function requireWriteOwnership(dirName: string): string | null {
      if (!isOwnedBySession(dirName)) {
        return `Directory repos/${dirName} belongs to another session. Clone your own copy with git(action: "clone") or git(action: "clone_from_environment", platformEnvironmentId: <id>). Each session operates on its own working tree.`;
      }
      return null;
    }

    async function listSessionOwnedRepositories(): Promise<string[]> {
      if (!callingSessionId) return [];
      let entries: Awaited<ReturnType<typeof readdir>>;
      try {
        entries = await readdir(REPOS_DIR, { withFileTypes: true });
      } catch {
        return [];
      }
      const candidates = entries
        .filter((entry) => entry.isDirectory() && isOwnedBySession(entry.name))
        .map((entry) => entry.name)
        .sort();
      const repositories: string[] = [];
      for (const candidate of candidates) {
        if (await dirExists(resolve(REPOS_DIR, candidate, ".git"))) repositories.push(candidate);
      }
      return repositories;
    }

    function nearMissSessionClone(requested: string, repositories: string[]): string | null {
      const needle = requested.trim().replace(/^repos\//, "");
      if (!needle || repositories.length === 0) return null;
      const prefixHits = repositories.filter(
        (name) => name.startsWith(needle) || needle.startsWith(name),
      );
      if (prefixHits.length === 1) return prefixHits[0];
      const suffixHits = repositories.filter(
        (name) => name.endsWith(needle) || needle.endsWith(name),
      );
      if (suffixHits.length === 1) return suffixHits[0];
      return null;
    }

    /** Explicit-miss recovery: teach omit-directory / exact sole clone, not workspace "." */
    async function gitDirectoryNotFoundMessage(requested?: string): Promise<string> {
      const requestedLabel = typeof requested === "string" ? requested.trim() : "";
      const repositories = await listSessionOwnedRepositories();
      const head = requestedLabel
        ? `Repository directory not found: \`${requestedLabel}\`.`
        : "Repository directory not found.";

      if (repositories.length === 1) {
        const sole = repositories[0];
        const near = requestedLabel ? nearMissSessionClone(requestedLabel, repositories) : null;
        const nearLine =
          near && near !== requestedLabel
            ? ` Closest session clone looks like \`${near}\`.`
            : "";
        return (
          `${head}${nearLine} Omit \`directory\` to use your sole session clone (\`${sole}\`), ` +
          `or pass that exact name. Do not use "." unless you intentionally want the workspace root (read-only depth-1 deploy checkout).`
        );
      }

      if (repositories.length > 1) {
        return (
          `${head} This session owns multiple clones (${repositories.join(", ")}). ` +
          `Pass \`directory\` with one exact name. Do not use "." for write work.`
        );
      }

      return (
        `${head} No session-owned repository clone exists. ` +
        `Clone first with git(action: "clone", ...), then omit \`directory\` or pass the returned clone name. ` +
        `Do not use "." unless you intentionally want the workspace root.`
      );
    }

    async function resolveImplicitSessionCloneDirectory(): Promise<
      | { directory: string }
      | { error: string; code: "git_directory_not_found" | "git_directory_ambiguous" }
      | null
    > {
      const explicitDirectory = typeof args.directory === "string" ? args.directory.trim() : "";
      if (!callingSessionId || explicitDirectory.length > 0) return null;

      const repositories = await listSessionOwnedRepositories();
      if (repositories.length === 1) return { directory: repositories[0] };
      if (repositories.length === 0) {
        return {
          error: "No session-owned repository clone exists. Clone the repository first with git(action: \"clone\", ...).",
          code: "git_directory_not_found",
        };
      }
      return {
        error: `Multiple session-owned repository clones exist: ${repositories.join(", ")}. Pass directory to choose one.`,
        code: "git_directory_ambiguous",
      };
    }

    async function resolveReadOnlyRepoDir(directory?: string): Promise<string | null> {
      if (directory === undefined || directory === null || SELF_DIR_ALIASES.has(directory)) {
        const gitDir = resolve(WORKSPACE_DIR, ".git");
        if (await dirExists(gitDir)) return WORKSPACE_DIR;
        return null;
      }
      return resolveRepoDir(directory);
    }

    async function git(gitArgs: string[], cwd: string, env?: Record<string, string>): Promise<string> {
      const { stdout } = await execFileAsync("git", gitArgs, {
        cwd,
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 5,
        encoding: "utf-8",
        env: { ...process.env, ...env },
      });
      return stdout.toString().trim();
    }

    type GitAuthMode = "platform" | "legacy";
    type GitAuthCandidate = {
      mode: GitAuthMode;
      token: string;
      context: Record<string, unknown>;
    };

    function parseGitHubRepoUrl(repoUrl?: string): { owner: string; repo: string } | null {
      if (!repoUrl) return null;
      try {
        const parsed = new URL(repoUrl);
        if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;
        const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
        if (parts.length < 2 || !parts[0] || !parts[1]) return null;
        return { owner: parts[0], repo: parts[1] };
      } catch {
        return null;
      }
    }

    async function createAskpassEnv(token: string): Promise<Record<string, string>> {
      // Use unique askpass file per invocation to avoid race conditions between concurrent sessions.
      const askpassId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const askpass = resolve(`/tmp/.git-askpass-${askpassId}.sh`);
      await writeFileAsync(askpass, `#!/bin/sh\necho "${token}"\n`, { mode: 0o700 });
      return { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" };
    }

    async function resolvePlatformGitAuth(repoUrl?: string): Promise<GitAuthCandidate | null> {
      const repoRef = parseGitHubRepoUrl(repoUrl);
      if (!repoRef) return null;

      const explicitEnvironmentId = Number.isFinite(Number(args.platformEnvironmentId)) ? Number(args.platformEnvironmentId) : null;
      const explicitConnectionId = Number.isFinite(Number(args.connectionId)) ? Number(args.connectionId) : null;

      try {
        const { resolveGitSource } = await import("./git-source-resolver");
        const source = await resolveGitSource({
          repoUrl,
          platformEnvironmentId: explicitEnvironmentId,
          connectionId: explicitConnectionId,
          branch: sanitizeBranch(args.branch),
          matchBranch: action === "clone",
          requireIndexingEnabled: false,
        });
        if (!source) {
          toolExec.debug("git.clone.platform_auth_no_binding", {
            owner: repoRef.owner,
            repo: repoRef.repo,
            platformEnvironmentId: explicitEnvironmentId,
            connectionId: explicitConnectionId,
          });
          return null;
        }
        toolExec.log("git.clone.platform_auth_resolved", {
          owner: source.owner,
          repo: source.repo,
          platformEnvironmentId: source.environmentId,
          connectionId: source.connectionId,
          branch: source.branch || null,
        });
        return {
          mode: "platform",
          token: source.token,
          context: {
            platformEnvironmentId: source.environmentId,
            connectionId: source.connectionId,
            owner: source.owner,
            repo: source.repo,
            branch: source.branch || null,
          },
        };
      } catch (err: any) {
        toolExec.warn("git.clone.platform_auth_lookup_failed", {
          owner: repoRef.owner,
          repo: repoRef.repo,
          platformEnvironmentId: explicitEnvironmentId,
          connectionId: explicitConnectionId,
          error: err?.message || String(err),
        });
        return null;
      }
    }

    async function resolveGitHubApiToken(repoUrl: string): Promise<string> {
      const platform = await resolvePlatformGitAuth(repoUrl);
      if (platform) {
        toolExec.log("git.api.platform_auth_selected", {
          mode: platform.mode,
          ...platform.context,
        });
        return platform.token;
      }

      throw new Error(`No active Platform source binding with a credential exists for ${scrubTokens(repoUrl)}`);
    }

    async function getAuthEnv(repoUrl?: string): Promise<Record<string, string>> {
      const platform = repoUrl ? await resolvePlatformGitAuth(repoUrl) : null;
      if (platform) {
        toolExec.log("git.auth.platform_auth_selected", {
          mode: platform.mode,
          ...platform.context,
        });
        return createAskpassEnv(platform.token);
      }

      throw new Error(
        repoUrl
          ? `No active Platform source binding with a credential exists for ${scrubTokens(repoUrl)}`
          : "Git authentication requires a repository URL resolved through a Platform source binding",
      );
    }

    async function ensureWorkspaceDependenciesHydrated(): Promise<string> {
      const packageLockPath = resolve(WORKSPACE_DIR, "package-lock.json");
      const rootNodeModules = resolve(WORKSPACE_DIR, "node_modules");
      const stampPath = resolve(rootNodeModules, ".xyz-hydrated-lock-hash");
      const requiredBins = ["tsx", "tsc", "vite"];

      const lockfile = await readFileAsync(packageLockPath, "utf-8");
      const lockHash = createHash("sha256").update(lockfile).digest("hex");

      if (!await dirExists(rootNodeModules)) {
        throw new Error("workspace dependency image contract failed: node_modules missing");
      }

      let stampedHash = "";
      try {
        stampedHash = (await readFileAsync(stampPath, "utf-8")).trim();
      } catch {
        throw new Error("workspace dependency image contract failed: hydration stamp missing");
      }

      if (stampedHash !== lockHash) {
        throw new Error("workspace dependency image contract failed: package-lock hash differs from the built dependency tree");
      }

      for (const bin of requiredBins) {
        const binPath = resolve(rootNodeModules, ".bin", bin);
        if (!await executableExists(binPath)) {
          throw new Error(`workspace dependency image contract failed: required binary missing: ${bin}`);
        }
      }

      return "workspace dependencies verified from immutable runtime image";
    }

    async function ensureCloneUsesSharedNodeModules(targetDir: string, dirName: string): Promise<string> {
      const hydrationStatus = await ensureWorkspaceDependenciesHydrated();

      // Post-clone: symlink node_modules from workspace root so builds work
      // without a full npm install in each session-scoped clone.
      const rootNodeModules = resolve(WORKSPACE_DIR, "node_modules");
      const clonedNodeModules = resolve(targetDir, "node_modules");
      let shouldCreateSymlink = true;

      try {
        const nodeModulesStat = await lstatAsync(clonedNodeModules);
        if (!nodeModulesStat.isSymbolicLink()) {
          await rmAsync(clonedNodeModules, { recursive: true, force: true });
          toolExec.warn(`post-clone: removed local node_modules in ${dirName}; replacing with shared workspace symlink`);
        } else {
          const currentTarget = resolve(targetDir, await readlinkAsync(clonedNodeModules));
          if (currentTarget === rootNodeModules) {
            shouldCreateSymlink = false;
          } else {
            await unlinkAsync(clonedNodeModules);
            toolExec.warn(`post-clone: replaced stale node_modules symlink in ${dirName} (${currentTarget} → ${rootNodeModules})`);
          }
        }
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }

      if (shouldCreateSymlink) {
        try {
          await symlinkAsync(rootNodeModules, clonedNodeModules, "dir");
          toolExec.log(`post-clone: symlinked node_modules from workspace root into ${dirName}`);
        } catch (symErr: any) {
          throw new Error(`post-clone: node_modules symlink failed: ${symErr.message}`);
        }
      }

      return hydrationStatus;
    }

    async function getRemoteUrl(dir: string): Promise<string | undefined> {
      try {
        return await git(["config", "--get", "remote.origin.url"], dir);
      } catch {
        return undefined;
      }
    }

    async function cleanupAskpass(env?: Record<string, string>) {
      try {
        if (env?.GIT_ASKPASS) {
          await unlinkAsync(env.GIT_ASKPASS);
        }
      } catch (err) { toolExec.debug("askpass cleanup failed", err); }
    }

    function triggerMobileBuildFromMainGitChange(input: { sourceRef?: string | null; reason: string }) {
      const sourceRef = input.sourceRef?.trim() || null;
      import("./system-settings")
        .then(({ getSetting }) => getSetting<boolean>("system.mobile_auto_build"))
        .then((autoBuildEnabled) => {
          if (autoBuildEnabled === false) {
            toolExec.log("Git tool main change skipped mobile build: auto-build is disabled", {
              reason: input.reason,
              sourceRef,
            });
            return { triggered: false, reason: "auto_build_disabled" };
          }
          return import("./integrations/expo")
            .then(({ triggerMainMobileBuild }) => triggerMainMobileBuild({
              profile: "preview",
              platform: "ios",
              sourceRef,
              reason: input.reason,
            }));
        })
        .then(result => {
          toolExec.log("Git tool main change mobile build trigger completed", {
            reason: input.reason,
            sourceRef,
            triggered: result.triggered,
            resultReason: result.reason,
            existingRunId: result.existingRunId,
          });
        })
        .catch((error: any) => {
          toolExec.error("Git tool main change mobile build trigger failed", {
            reason: input.reason,
            sourceRef,
            error: error?.message || String(error),
            stack: error?.stack,
          });
        });
    }

    /** After merge/push to Stage-bound main, queue Warm Stage Sync Latest. Fail-soft; never blocks git. */
    function triggerStageSyncFromMainGitChange(input: {
      sourceRef?: string | null;
      reason: string;
      owner?: string | null;
      repo?: string | null;
    }) {
      const sourceRef = input.sourceRef?.trim() || null;
      if (!sourceRef) {
        toolExec.log("Git tool main change skipped Stage Sync Latest: missing commit SHA", {
          reason: input.reason,
        });
        return;
      }
      import("./stage-sync")
        .then(({ queueStageSyncLatest }) => queueStageSyncLatest({
          commitSha: sourceRef,
          reason: input.reason,
          owner: input.owner,
          repo: input.repo,
        }))
        .then((result) => {
          toolExec.log("Git tool main change Stage Sync Latest trigger completed", {
            reason: input.reason,
            sourceRef,
            triggered: result.triggered,
            resultReason: result.reason,
            environmentId: result.environmentId,
            targetCommitSha: result.targetCommitSha,
            deploymentId: result.deploymentId,
          });
        })
        .catch((error: any) => {
          toolExec.error("Git tool main change Stage Sync Latest trigger failed", {
            reason: input.reason,
            sourceRef,
            error: error?.message || String(error),
            stack: error?.stack,
          });
        });
    }

    try {
      const implicitSessionClone = action === "clone" || action === "clone_from_environment"
        ? null
        : await resolveImplicitSessionCloneDirectory();
      if (implicitSessionClone && "error" in implicitSessionClone) {
        return contractReject(implicitSessionClone.error, implicitSessionClone.code);
      }
      if (implicitSessionClone) args.directory = implicitSessionClone.directory;

      switch (action) {
        case "clone":
        case "clone_from_environment": {
          // Sparse-patch normalization: empty strings / non-positive IDs are absence, not routing.
          const requestedEnvironmentId = Number(args.platformEnvironmentId);
          const hasEnvironmentId = Number.isInteger(requestedEnvironmentId) && requestedEnvironmentId > 0;
          // Absorb the transitional dialect: clone + platformEnvironmentId means environment clone.
          const environmentClone = action === "clone_from_environment" || (action === "clone" && hasEnvironmentId);
          if (action === "clone_from_environment" && !hasEnvironmentId) {
            return contractReject(
              "clone_from_environment requires a positive platformEnvironmentId.",
              "git_platform_environment_required",
            );
          }

          const nonEmpty = (value: unknown): value is string =>
            typeof value === "string" && value.trim().length > 0;
          // Caller-owned coordinates remain forbidden. connectionId is never caller-owned on clone —
          // the authorized source binding supplies it — so ignore dumped/stale connectionId values.
          if (nonEmpty(args.url) || nonEmpty(args.directory) || nonEmpty(args.branch)) {
            return contractReject(
              "Clone routing is owned by the Platform source binding; url, directory, and branch are not accepted. Use bare clone or clone_from_environment with platformEnvironmentId.",
              "git_clone_routing_forbidden",
            );
          }

          const { resolveGitCloneSource } = await import("./git-source-resolver");
          const source = await resolveGitCloneSource(
            environmentClone ? requestedEnvironmentId : null,
          );
          if (!source) {
            const target = environmentClone
              ? `Platform Environment #${requestedEnvironmentId}`
              : "canonical Mantra / Web / stage";
            return contractReject(
              `No active GitHub source binding with an available provider credential exists for ${target}.`,
              "git_source_binding_unavailable",
            );
          }

          const url = source.repoUrl;
          if (!await dirExists(REPOS_DIR)) await mkdirAsync(REPOS_DIR, { recursive: true });

          // Session isolation: destination identity is derived only from the authorized source binding.
          const repositoryName = source.repo.replace(/[^a-zA-Z0-9._-]/g, "-");
          const baseName = environmentClone
            ? `${repositoryName}-env-${source.environmentId}`
            : repositoryName;
          const dirName = sessionSuffix ? `${baseName}-${sessionSuffix}` : baseName;
          const targetDir = resolveRepoDir(dirName);
          if (!targetDir) return contractReject("Invalid source-bound repository name", "git_directory_required");

          // Idempotent: if this session already cloned here, return the existing clone.
          if (await dirExists(targetDir)) {
            const hydrationStatus = await ensureCloneUsesSharedNodeModules(targetDir, dirName);
            const log = await git(["log", "--oneline", "-5"], targetDir);
            const currentBranch = await git(["branch", "--show-current"], targetDir);
            return { result: `Already cloned at repos/${dirName} (reusing existing clone)\nBranch: ${currentBranch}\nDependencies: ${hydrationStatus}\nRecent commits:\n${log}` };
          }

          const cloneArgs = ["clone", "--branch", source.branch, url, targetDir];
          const effectiveAction = environmentClone ? "clone_from_environment" : "clone";
          const sourceContext = {
            platformEnvironmentId: source.environmentId,
            connectionId: source.connectionId,
            owner: source.owner,
            repo: source.repo,
            branch: source.branch,
          };
          const authEnv = await createAskpassEnv(source.token);
          try {
            toolExec.log("git.clone.source_bound_attempt", {
              directory: dirName,
              action: effectiveAction,
              requestedAction: action,
              ...sourceContext,
            });
            await git(cloneArgs, REPOS_DIR, authEnv);
          } catch (err: any) {
            const message = scrubTokens(err?.stderr || err?.message || String(err));
            await rmAsync(targetDir, { recursive: true, force: true });
            toolExec.warn("git.clone.source_bound_failed", {
              directory: dirName,
              action: effectiveAction,
              requestedAction: action,
              error: message,
              ...sourceContext,
            });
            const failure = classifyGitError(err);
            return {
              result: `Git clone failed for the authorized Platform source binding.\n${message}`,
              error: true,
              ...(failure ? { failure } : {}),
            };
          } finally {
            await cleanupAskpass(authEnv);
          }

          const hydrationStatus = await ensureCloneUsesSharedNodeModules(targetDir, dirName);
          const log = await git(["log", "--oneline", "-5"], targetDir);
          const currentBranch = await git(["branch", "--show-current"], targetDir);
          return {
            result: `Cloned into repos/${dirName}\nBranch: ${currentBranch}\nAuth: platform source binding\nSource context: ${JSON.stringify(sourceContext)}\nDependencies: ${hydrationStatus}\nRecent commits:\n${log}`,
          };
        }

        case "pull": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) {
            return contractReject(
              "Cannot pull into the workspace root. Pull only works on cloned repos in repos/.",
              "git_workspace_root_forbidden",
            );
          }
          const ownershipErr = requireWriteOwnership(args.directory);
          if (ownershipErr) return contractReject(ownershipErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) {
            return contractReject(
              await gitDirectoryNotFoundMessage(args.directory),
              "git_directory_not_found",
            );
          }

          const remoteUrl = await getRemoteUrl(dir);
          const authEnv = await getAuthEnv(remoteUrl);
          try {
            const pullArgs = ["pull"];
            const branch = sanitizeBranch(args.branch);
            if (branch) pullArgs.push("origin", branch);
            const output = await git(pullArgs, dir, authEnv);
            return { result: truncate(output) };
          } finally {
            cleanupAskpass(authEnv);
          }
        }

        case "status": {
          const dir = await resolveReadOnlyRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const currentBranch = await git(["branch", "--show-current"], dir);
          const status = await git(["status", "--short"], dir);

          let result = `Branch: ${currentBranch}\n`;
          result += status || "(clean working tree)";
          return { result: truncate(result) };
        }

        case "log": {
          const dir = await resolveReadOnlyRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          // If workspace root is shallow, warn the caller
          if (SELF_DIR_ALIASES.has(args.directory || ".") || !args.directory) {
            const isShallow = (await git(["rev-parse", "--is-shallow-repository"], dir)).trim();
            if (isShallow === "true") {
              return { result: "The workspace root is a Railway shallow clone (depth 1). For full git history, use the GitHub API (fetchGitHubCommits, fetchMergedPRs) or clone the repo into repos/ first." };
            }
          }

          const count = Math.min(args.count || 20, 100);
          const logArgs = ["log", "--oneline", `--format=%h %an | %s (%cr)`, `-${count}`];
          if (args.grep) {
            const grepVal = String(args.grep).slice(0, 200);
            logArgs.push(`--grep=${grepVal}`);
          }

          const output = await git(logArgs, dir);
          return { result: truncate(output) };
        }

        case "diff": {
          const dir = await resolveReadOnlyRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const diffArgs = ["diff"];
          const r1 = sanitizeRef(args.ref1);
          const r2 = sanitizeRef(args.ref2);
          if (r1 && r2) { diffArgs.push(r1, r2); }
          else if (r1) { diffArgs.push(r1); }
          if (args.file) { diffArgs.push("--", String(args.file)); }

          const output = await git(diffArgs, dir);
          return { result: output ? truncate(output) : "(no differences)" };
        }

        case "branch": {
          const subAction = args.branchAction || "list";
          if (subAction === "list") {
            const dir = await resolveReadOnlyRepoDir(args.directory);
            if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");
            const output = await git(["branch", "-a"], dir);
            return { result: output };
          }
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return contractReject("Branch create/switch only works on cloned repos in repos/, not the workspace root.", "git_workspace_root_forbidden");
          const branchOwnerErr = requireWriteOwnership(args.directory);
          if (branchOwnerErr) return contractReject(branchOwnerErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");
          switch (subAction) {
            case "create": {
              const name = sanitizeBranch(args.name);
              if (!name) return { result: "Missing or invalid branch name", error: true };
              await git(["checkout", "-b", name], dir);
              return { result: `Created and switched to branch: ${name}` };
            }
            case "switch": {
              const name = sanitizeBranch(args.name);
              if (!name) return { result: "Missing or invalid branch name", error: true };
              await git(["checkout", name], dir);
              return { result: `Switched to branch: ${name}` };
            }
            default:
              return contractReject(`Unknown branch action: ${subAction}. Use list, create, or switch.`, "git_invalid_action");
          }
        }

        case "checkout": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return contractReject("Checkout only works on cloned repos in repos/, not the workspace root.", "git_workspace_root_forbidden");
          const checkoutOwnerErr = requireWriteOwnership(args.directory);
          if (checkoutOwnerErr) return contractReject(checkoutOwnerErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const prNumber = Number(args.pr_number);
          if (Number.isInteger(prNumber) && prNumber > 0) {
            if (args.file) return contractReject("file cannot be combined with pr_number checkout", "git_invalid_action");
            const localBranch = `pr-${prNumber}`;
            const remoteUrl = await getRemoteUrl(dir);
            const authEnv = await getAuthEnv(remoteUrl);
            try {
              await git(["fetch", "origin", `pull/${prNumber}/head`], dir, authEnv);
            } finally {
              cleanupAskpass(authEnv);
            }
            await git(["checkout", "-B", localBranch, "FETCH_HEAD"], dir);
            return { result: `Checked out PR #${prNumber} on local branch: ${localBranch}` };
          }

          const ref = sanitizeRef(args.ref);
          if (!ref) return contractReject("Missing or invalid ref/branch to checkout; pass pr_number to check out a pull request", "git_invalid_action");

          const checkoutArgs = ["checkout", ref];
          if (args.file) checkoutArgs.push("--", String(args.file));

          await git(checkoutArgs, dir);
          let current: string;
          try { current = await git(["branch", "--show-current"], dir); } catch { current = ref; }
          return { result: `Checked out: ${current || ref}` };
        }

        case "show": {
          const dir = await resolveReadOnlyRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const ref = sanitizeRef(args.ref) || "HEAD";
          const output = await git(["show", "--stat", "--format=Commit: %H%nAuthor: %an <%ae>%nDate: %ci%n%n%s%n%n%b", ref], dir);
          return { result: truncate(output) };
        }

        case "add": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return contractReject("git add only works on cloned repos in repos/, not the workspace root.", "git_workspace_root_forbidden");
          const addOwnerErr = requireWriteOwnership(args.directory);
          if (addOwnerErr) return contractReject(addOwnerErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const files: string[] = Array.isArray(args.files) && args.files.length > 0
            ? args.files.map((f: string) => String(f))
            : ["."];
          await git(["add", ...files], dir);
          const staged = await git(["diff", "--cached", "--name-only"], dir);
          return { result: staged ? `Staged files:\n${staged}` : "(no changes to stage)" };
        }

        case "commit": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return contractReject("git commit only works on cloned repos in repos/, not the workspace root.", "git_workspace_root_forbidden");
          const commitOwnerErr = requireWriteOwnership(args.directory);
          if (commitOwnerErr) return contractReject(commitOwnerErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const message = args.message;
          if (!message || typeof message !== "string" || !message.trim()) {
            return contractReject("Missing commit message", "git_invalid_action");
          }

          const currentName = await git(["config", "--get", "user.name"], dir).catch(() => "");
          const currentEmail = await git(["config", "--get", "user.email"], dir).catch(() => "");
          if (!currentName) await git(["config", "user.name", getInstanceName()], dir);
          if (!currentEmail) await git(["config", "user.email", "xyz@xyz.bot"], dir);

          const output = await git(["commit", "-m", message.trim()], dir);
          const hash = await git(["rev-parse", "--short", "HEAD"], dir);
          return { result: `Committed ${hash}\n${truncate(output)}` };
        }

        case "push": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return contractReject("git push only works on cloned repos in repos/, not the workspace root.", "git_workspace_root_forbidden");
          const pushOwnerErr = requireWriteOwnership(args.directory);
          if (pushOwnerErr) return contractReject(pushOwnerErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const pushRemoteUrl = await getRemoteUrl(dir);
          const authEnv = await getAuthEnv(pushRemoteUrl);
          try {
            const currentBranch = await git(["branch", "--show-current"], dir);
            const branch = sanitizeBranch(args.branch) || currentBranch;
            if (!branch) return { result: "Could not determine branch to push", error: true };

            const hasUpstream = await git(["config", `branch.${branch}.remote`], dir).catch(() => "");
            const pushArgs = ["push"];
            if (args.force) pushArgs.push("--force");
            if (!hasUpstream) pushArgs.push("-u");
            pushArgs.push("origin", branch);

            const output = await git(pushArgs, dir, authEnv);
            if (branch === "main") {
              const sourceRef = await git(["rev-parse", "HEAD"], dir).catch(() => null);
              triggerMobileBuildFromMainGitChange({
                sourceRef,
                reason: `git_tool_push:main:${sourceRef || "unknown"}`,
              });
              const pushRepo = pushRemoteUrl.match(/github\.com[:/]([^\/]+)\/(.+?)(?:\.git)?$/);
              triggerStageSyncFromMainGitChange({
                sourceRef,
                reason: `git_tool_push:main:${sourceRef || "unknown"}`,
                owner: pushRepo?.[1] ?? null,
                repo: pushRepo?.[2] ?? null,
              });
            }
            return { result: scrubTokens(output || `Pushed branch ${branch} to origin`) };
          } finally {
            cleanupAskpass(authEnv);
          }
        }

        case "create_pr": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return contractReject("create_pr only works on cloned repos in repos/, not the workspace root.", "git_workspace_root_forbidden");
          const prOwnerErr = requireWriteOwnership(args.directory);
          if (prOwnerErr) return contractReject(prOwnerErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const title = args.title;
          if (!title || typeof title !== "string" || !title.trim()) {
            return contractReject("Missing PR title", "git_invalid_action");
          }

          const remoteUrl = await git(["config", "--get", "remote.origin.url"], dir);
          const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
          if (!match) return { result: `Could not parse owner/repo from remote URL: ${scrubTokens(remoteUrl)}`, error: true };
          const [, owner, repo] = match;

          const head = await git(["branch", "--show-current"], dir);
          if (!head) return { result: "Could not determine current branch. Make sure you are on a feature branch.", error: true };

          const base = sanitizeBranch(args.base) || "main";

          const token = await resolveGitHubApiToken(remoteUrl);

          const prBody: Record<string, unknown> = {
            title: title.trim(),
            head,
            base,
            draft: !!args.draft,
          };
          if (args.body && typeof args.body === "string") prBody.body = args.body;

          const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify(prBody),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => "unknown error");
            const failure = classifyGitHubApiStatus(response.status);
            return { result: `GitHub API error (${response.status}): ${scrubTokens(errText)}`, error: true, ...(failure ? { failure } : {}) };
          }

          const pr = await response.json() as { number: number; html_url: string; title: string };
          return { result: `PR #${pr.number} created: ${pr.html_url}\nTitle: ${pr.title}` };
        }
        case "merge_pr": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return contractReject("merge_pr only works on cloned repos in repos/, not the workspace root.", "git_workspace_root_forbidden");
          const mergeOwnerErr = requireWriteOwnership(args.directory);
          if (mergeOwnerErr) return contractReject(mergeOwnerErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const prNumber = args.pr_number;
          if (!prNumber) return contractReject("Missing pr_number parameter", "git_invalid_action");

          const remoteUrl = await git(["config", "--get", "remote.origin.url"], dir);
          const match = remoteUrl.match(/github\.com[:/]([^\/]+)\/(.+?)(?:\.git)?$/);
          if (!match) return { result: `Could not parse owner/repo from remote URL: ${scrubTokens(remoteUrl)}`, error: true };
          const [, owner, repo] = match;

          const token = await resolveGitHubApiToken(remoteUrl);

          const mergeBody: Record<string, unknown> = {
            merge_method: args.merge_method || "squash",
          };
          if (args.commit_title && typeof args.commit_title === "string") mergeBody.commit_title = args.commit_title;
          if (args.commit_message && typeof args.commit_message === "string") mergeBody.commit_message = args.commit_message;

          const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          if (!prResponse.ok) {
            const errText = await prResponse.text().catch(() => "unknown error");
            const failure = classifyGitHubApiStatus(prResponse.status);
            return { result: `GitHub API error (${prResponse.status}): ${scrubTokens(errText)}`, error: true, ...(failure ? { failure } : {}) };
          }

          const prDetails = await prResponse.json() as { base?: { ref?: string } };
          const baseBranch = prDetails.base?.ref || "";

          const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
            method: "PUT",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify(mergeBody),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => "unknown error");
            const failure = classifyGitHubApiStatus(response.status);
            return { result: `GitHub API error (${response.status}): ${scrubTokens(errText)}`, error: true, ...(failure ? { failure } : {}) };
          }

          const result = await response.json() as { sha: string; message: string; merged: boolean };
          if (!result.merged) return { result: `Merge failed: ${result.message}`, error: true, failure: inputFailure("git_state_conflict", "merge_not_applied") };
          // Bridge merge path bypasses mergePR(); write the CODE heatmap ledger here.
          void import("./integrations/merged-pr-ledger")
            .then(({ recordMergedPullRequestFromGithub }) =>
              recordMergedPullRequestFromGithub(
                { owner, repo },
                prNumber,
                result.sha ?? null,
                "live",
              ),
            )
            .catch(() => undefined);
          if (baseBranch === "main") {
            triggerMobileBuildFromMainGitChange({
              sourceRef: result.sha,
              reason: `git_tool_merge_pr:${prNumber}:main:${result.sha || "unknown"}`,
            });
            triggerStageSyncFromMainGitChange({
              sourceRef: result.sha,
              reason: `git_tool_merge_pr:${prNumber}:main:${result.sha || "unknown"}`,
              owner,
              repo,
            });
          }
          return { result: `PR #${prNumber} merged successfully.\nSHA: ${result.sha}\nMessage: ${result.message}` };
        }

        case "delete_branch": {
          if (!args.directory || SELF_DIR_ALIASES.has(args.directory)) return contractReject("delete_branch only works on cloned repos in repos/, not the workspace root.", "git_workspace_root_forbidden");
          const delBranchOwnerErr = requireWriteOwnership(args.directory);
          if (delBranchOwnerErr) return contractReject(delBranchOwnerErr, "git_session_ownership");
          const dir = resolveRepoDir(args.directory);
          if (!dir || !await dirExists(dir)) return contractReject(await gitDirectoryNotFoundMessage(args.directory), "git_directory_not_found");

          const branchName = sanitizeBranch(args.branch);
          if (!branchName) return { result: "Missing or invalid branch name", error: true };

          const remoteUrl = await git(["config", "--get", "remote.origin.url"], dir);
          const match = remoteUrl.match(/github\.com[:/]([^\/]+)\/(.+?)(?:\.git)?$/);
          if (!match) return { result: `Could not parse owner/repo from remote URL: ${scrubTokens(remoteUrl)}`, error: true };
          const [, owner, repo] = match;

          const token = await resolveGitHubApiToken(remoteUrl);

          const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`, {
            method: "DELETE",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          if (!response.ok && response.status !== 422) {
            const errText = await response.text().catch(() => "unknown error");
            const failure = classifyGitHubApiStatus(response.status);
            return { result: `GitHub API error (${response.status}): ${scrubTokens(errText)}`, error: true, ...(failure ? { failure } : {}) };
          }

          return { result: `Remote branch '${branchName}' deleted from origin.` };
        }


        default:
          return contractReject(`Unknown git action: ${action}. Available: clone, pull, status, log, diff, branch, checkout, show, add, commit, push, create_pr, merge_pr, delete_branch`, "git_invalid_action");
      }
    } catch (err: any) {
      const msg = err.stderr?.toString?.() || err.stdout?.toString?.() || err.message || String(err);
      // Subprocess rejections are expected git/auth/state/network failures when
      // classifyGitError matches; unmatched stay red (true surprise).
      const failure = classifyGitError(err);
      return {
        result: `Git error: ${truncate(scrubTokens(msg), 2000)}`,
        error: true,
        ...(failure ? { failure } : {}),
      };
    }
  },

  async pronunciation(args) {
    const action = args.action || "list";

    try {
      const { listEntries, addEntry, updateEntry, removeEntry } = await import("./pronunciation");

      switch (action) {
        case "list": {
          const entries = await listEntries();
          if (entries.length === 0) return { result: "No pronunciation entries yet. Add one with action: 'add', word, and alias." };
          const lines = entries.map(e => `- "${e.word}" → "${e.alias}"`);
          return { result: `${entries.length} pronunciation entries:\n${lines.join("\n")}` };
        }
        case "add": {
          const word = args.word as string;
          const alias = args.alias as string;
          if (!word || !alias) return { result: "Missing word or alias (pronunciation)", error: true };
          const entry = await addEntry(word, alias);
          return { result: `Pronunciation added: "${entry.word}" → "${entry.alias}". This will take effect on the next voice session.` };
        }
        case "update": {
          const word = args.word as string;
          const alias = args.alias as string;
          if (!word || !alias) return { result: "Missing word or alias (pronunciation)", error: true };
          const entry = await updateEntry(word, alias);
          return { result: `Pronunciation updated: "${entry.word}" → "${entry.alias}"` };
        }
        case "remove": {
          const word = args.word as string;
          if (!word) return { result: "Missing word to remove", error: true };
          await removeEntry(word);
          return { result: `Pronunciation removed for "${word}"` };
        }
        default:
          return { result: `Unknown pronunciation action: ${action}. Available: list, add, update, remove`, error: true };
      }
    } catch (err: any) {
      return { result: `Pronunciation tool error: ${err.message}`, error: true };
    }
  },

  async rules(args) {
    const { fileRuleStorage } = await import("./file-storage/rules");
    const action = args.action || "list";

    try {
      switch (action) {
        case "list": {
          const all = await fileRuleStorage.getAll();
          if (all.length === 0) return { result: "No personal Rules saved yet." };
          const lines = all.map((rule) =>
            `- [${rule.id}] ${rule.rule}${rule.tags.length > 0 ? ` (tags: ${rule.tags.join(", ")})` : ""}`,
          );
          return { result: `${all.length} personal Rules:
${lines.join("\n")}` };
        }
        case "get": {
          const id = args.id;
          if (!id) return { result: "Missing Rule id", error: true };
          const rule = await fileRuleStorage.getById(id);
          if (!rule) return { result: `Rule ${id} not found`, error: true };
          return {
            result: [
              `**Rule**: ${rule.rule}`,
              `ID: ${rule.id}`,
              `Tags: ${rule.tags.length > 0 ? rule.tags.join(", ") : "none"}`,
            ].join("\n"),
          };
        }
        case "save":
        case "create": {
          const ruleText = typeof args.rule === "string" ? args.rule.trim() : "";
          if (!ruleText) return { result: "Missing Rule text", error: true };
          const existingRules = await fileRuleStorage.getAll().catch(() => []);
          const duplicate = existingRules.find((rule) => isSimilarText(rule.rule, ruleText));
          if (duplicate) {
            return { result: `Equivalent personal Rule already exists: "${duplicate.rule}" (ID: ${duplicate.id})` };
          }
          const rule = await fileRuleStorage.create({
            rule: ruleText,
            tags: args.tags,
          });
          eventBus.publish({ category: "agent", event: "data:rule_created", payload: { id: rule.id, rule: rule.rule } });
          return { result: `Personal Rule saved: "${rule.rule}" (ID: ${rule.id})` };
        }
        case "update": {
          const id = args.id;
          if (!id) return { result: "Missing Rule id", error: true };
          const updates: Record<string, unknown> = {};
          if (typeof args.rule === "string" && args.rule.trim()) updates.rule = args.rule.trim();
          if (Array.isArray(args.tags) && args.tags.length > 0) updates.tags = args.tags;
          const updated = await fileRuleStorage.update(id, updates);
          if (!updated) return { result: `Rule ${id} not found`, error: true };
          eventBus.publish({ category: "agent", event: "data:rule_updated", payload: { id, fields: Object.keys(updates) } });
          return { result: `Personal Rule updated: "${updated.rule}"` };
        }
        case "delete": {
          const id = args.id;
          if (!id) return { result: "Missing Rule id", error: true };
          const deleted = await fileRuleStorage.delete(id);
          if (!deleted) return { result: `Rule ${id} not found`, error: true };
          return { result: `Rule ${id} deleted.` };
        }
        default:
          return { result: `Unknown rules action: ${action}. Available: list, get, save, create, update, delete`, error: true };
      }
    } catch (err: any) {
      return { result: `Rules tool error: ${err.message}`, error: true };
    }
  },

  async skills(args) {
    const action = args.action || "list";
    const { storage } = await import("./storage");

    try {
      switch (action) {
        case "list": {
          const filters: { status?: string; category?: string } = {};
          if (args.status) filters.status = args.status;
          if (args.category) filters.category = args.category;
          const allSkills = await storage.getSkills(Object.keys(filters).length > 0 ? filters : undefined);
          if (allSkills.length === 0) return { result: "No skills found." };
          const lines = allSkills.map(s =>
            `- **${s.name}** (${s.category || "general"}) [${s.status}]\n  ${s.description?.slice(0, 120) || "No description"}${s.author === "system" ? " [built-in]" : ""}`
          );
          return { result: `${allSkills.length} skills:\n${lines.join("\n")}` };
        }
        case "get": {
          const identifier = args.name;
          if (!identifier) return { result: "Missing skill name", error: true };
          let skill = await storage.getSkillByName(identifier);
          if (!skill) skill = await storage.getSkill(identifier);
          if (!skill) return { result: `Skill "${identifier}" not found`, error: true };
          const parts = [
            `**${skill.name}** (id: ${skill.id})`,
            `Category: ${skill.category || "general"} | Activity: ${skill.activity || "n/a"} | Status: ${skill.status}`,
            `Author: ${skill.author || "user"} | Version: ${skill.version} | Session Type: ${skill.sessionType || "default (autonomous)"}`,
          ];
          if (skill.description) parts.push(`Description: ${skill.description}`);
          parts.push(`\nProcess:\n${skill.process}`);
          if (skill.whenToUse) parts.push(`\nWhen To Use:\n${skill.whenToUse}`);
          if (skill.outputSpec) parts.push(`Output Spec:\n${skill.outputSpec}`);
          const deterministicTools = Array.isArray(skill.checklist)
            ? (skill.checklist as Array<{ kind?: unknown; tool?: unknown; action?: unknown }>)
                .filter((c) => !!c && c.kind === "tool_invoked" && typeof c.tool === "string")
                .map((c) => `${c.tool}${typeof c.action === "string" ? `:${c.action}` : ""}`)
            : [];
          if (deterministicTools.length > 0) {
            parts.push(`Deterministic tool checks (from checklist): ${deterministicTools.join(", ")} — a run without a successful invocation of each terminates degraded.`);
          }
          if (typeof skill.scoreThreshold === "number") {
            parts.push(`Score threshold: scored runs below ${Math.round(skill.scoreThreshold * 100)}% checklist pass rate reconcile to degraded.`);
          }
          parts.push(`\n${formatChecklistForXyz(skill.checklist)}`);
          return { result: parts.join("\n") };
        }
        case "create": {
          if (!args.name || !args.process) return { result: "Missing required fields: name, process", error: true };
          const checklistError = await validateChecklistToolRefs(args.checklist);
          if (checklistError) return { result: checklistError, error: true };
          const newSkill = await storage.createSkill({
            name: args.name,
            description: args.description || "",
            process: args.process,
            whenToUse: args.whenToUse || "",
            outputSpec: args.outputSpec || "",
            qualityCriteria: "",
            checklist: Array.isArray(args.checklist) ? args.checklist : [],
            ...(args.scoreThreshold !== undefined ? { scoreThreshold: normalizeScoreThreshold(args.scoreThreshold) } : {}),
            status: "active",
            author: getInstanceName(),
            version: args.version || "1.0",
            category: args.category || "general",
            activity: args.activity || ACTIVITY_FRAMING,
            sessionType: args.sessionType || null,
          } as any);
          return { result: `Created skill "${newSkill.name}" (id: ${newSkill.id})` };
        }
        case "update": {
          const id = args.id;
          if (!id) return { result: "Missing skill id", error: true };
          const existing = await storage.getSkill(id);
          if (!existing) return { result: `Skill "${id}" not found`, error: true };
          const updates: Record<string, unknown> = {};
          for (const key of ["name", "description", "process", "whenToUse", "outputSpec", "status", "version", "category", "activity", "sessionType"]) {
            if (args[key] !== undefined) updates[key] = args[key];
          }
          if (args.checklist !== undefined) {
            const checklistError = await validateChecklistToolRefs(args.checklist);
            if (checklistError) return { result: checklistError, error: true };
            updates.checklist = Array.isArray(args.checklist) ? args.checklist : [];
          }
          if (args.scoreThreshold !== undefined) updates.scoreThreshold = args.scoreThreshold === null ? null : normalizeScoreThreshold(args.scoreThreshold);
          const updated = await storage.updateSkill(id, updates);
          if (!updated) return { result: `Failed to update skill "${id}"`, error: true };
          const forked = existing.scope === "global" && updated.id !== existing.id;
          return { result: `${forked ? "Created private override for" : "Updated"} skill "${updated.name}" (id: ${updated.id})` };
        }
        case "edit": {
          const id = args.id;
          if (!id) return { result: "Missing skill id", error: true };
          const existing = await storage.getSkill(id);
          if (!existing) return { result: `Skill "${id}" not found`, error: true };
          const oldString = args.old_string;
          const newString = args.new_string;
          if (oldString === undefined) return { result: "Missing old_string", error: true };
          if (newString === undefined) return { result: "Missing new_string", error: true };
          const editableFields = ["process", "outputSpec", "description", "whenToUse"];
          const field = (args.field as string) || "process";
          if (!editableFields.includes(field)) {
            return { result: `Invalid field "${field}". Editable fields: ${editableFields.join(", ")}`, error: true };
          }
          const currentContent = String((existing as any)[field] || "");
          if (!currentContent) return { result: `Skill "${existing.name}" has no ${field} content to edit.`, error: true };
          const occurrences = currentContent.split(oldString).length - 1;
          if (occurrences === 0) {
            return { result: `old_string not found in skill "${existing.name}" ${field}`, error: true };
          }
          const replaceAll = args.replace_all === true;
          if (occurrences > 1 && !replaceAll) {
            return { result: `old_string found ${occurrences} times in "${existing.name}" ${field}. Use replace_all: true to replace all, or provide more context to make it unique.`, error: true };
          }
          const updatedContent = replaceAll ? currentContent.split(oldString).join(newString) : currentContent.replace(oldString, newString);
          const replacements = replaceAll ? occurrences : 1;
          const updated = await storage.updateSkill(id, { [field]: updatedContent } as any);
          if (!updated) return { result: `Failed to edit skill "${id}"`, error: true };
          const lengthDelta = updatedContent.length - currentContent.length;
          toolExec.log(`skills.edit: skill=${updated.id} field=${field} replacements=${replacements} lengthDelta=${lengthDelta > 0 ? "+" : ""}${lengthDelta}`);
          const forked = existing.scope === "global" && updated.id !== existing.id;
          return { result: `${forked ? "Created private override for" : "Edited"} skill "${updated.name}" (id: ${updated.id}) — ${field}, ${replacements} replacement${replacements > 1 ? "s" : ""}` };
        }
        case "set_persona": {
          const identifier = args.id || args.name;
          if (!identifier) return { result: "Missing skill id or name", error: true };
          let skill = await storage.getSkill(identifier);
          if (!skill) skill = await storage.getSkillByName(identifier);
          if (!skill) return { result: `Skill "${identifier}" not found`, error: true };
          const personaId = args.personaId;
          if (personaId !== null && (typeof personaId !== "number" || !Number.isInteger(personaId))) {
            return { result: "personaId must be an integer or null", error: true };
          }
          const { setSkillPersonaPreference } = await import("./skill-persona-service");
          await setSkillPersonaPreference(skill.id, personaId);
          if (personaId === null) {
            return { result: `Cleared persona override for "${skill.name}"; it will use the product recommendation.` };
          }
          const { personaStorage } = await import("./file-storage/persona-storage");
          const persona = await personaStorage.get(personaId);
          return { result: `Set persona override for "${skill.name}" to ${persona?.name || personaId}.` };
        }
        case "delete": {
          const id = args.id;
          if (!id) return { result: "Missing skill id", error: true };
          const existing = await storage.getSkill(id);
          if (!existing) return { result: `Skill "${id}" not found`, error: true };
          if (existing.scope === "global") return { result: `Cannot delete global skill template "${existing.name}". Edit it to create a private override.`, error: true };
          await storage.deleteSkill(id);
          return { result: `Deleted skill "${existing.name}" (id: ${id})` };
        }
        case "search": {
          const query = (args.query || "").toLowerCase();
          if (!query) return { result: "Missing search query", error: true };
          const allSkills = await storage.getSkills();
          const matches = allSkills.filter(s =>
            s.name.toLowerCase().includes(query) ||
            (s.description || "").toLowerCase().includes(query) ||
            (s.category || "").toLowerCase().includes(query) ||
            (s.process || "").toLowerCase().includes(query)
          );
          if (matches.length === 0) return { result: `No skills matching "${query}"` };
          const lines = matches.map(s =>
            `- **${s.name}** (${s.category || "general"}) [${s.status}]\n  ${s.description?.slice(0, 120) || "No description"}${s.author === "system" ? " [built-in]" : ""}`
          );
          return { result: `${matches.length} skills matching "${query}":\n${lines.join("\n")}` };
        }
        case "run": {
          const requestedSkill = args.id || args.name;
          if (!requestedSkill) return { result: "Missing skill ID or name (use 'id' or 'name' parameter)", error: true };
          let targetSkill = await storage.getSkill(requestedSkill);
          if (!targetSkill) targetSkill = await storage.getSkillByName(requestedSkill);
          if (!targetSkill) return { result: `Skill "${requestedSkill}" not found`, error: true };
          const skillId = targetSkill.id;

          const callingConversationId = args._sessionId;
          if (normalizeSkillIdentifier(skillId) === "spec" && await isSpecSkillSession(callingConversationId)) {
            return {
              result: "Guard blocked recursive spec skill launch: this session is already the spec skill. Continue producing the current spec artifact instead of starting another spec run.",
              error: true,
            };
          }

          const { executeAutonomousSkillRun } = await import("./autonomous-skill-runner");

          const waitForResult = args.wait !== false;
          const preContext = args.preContext;
          const runOptions: {
            preContext?: string;
            parentSessionId?: string;
            spawnReason?: string;
            spawnerTool?: string;
            spawnerSkillRun?: string;
            parentToolCallId?: string;
            onSessionCreated?: (id: string) => void;
          } = {
            preContext,
            parentSessionId: callingConversationId || undefined,
            spawnReason: callingConversationId ? `skill:${skillId}` : undefined,
            spawnerTool: "skills.run",
            parentToolCallId: callingConversationId ? String(args._toolCallId || "") || undefined : undefined,
            // Freshness + replay safety: one provider tool call owns one child
            // spawn tuple. A replay of that exact call converges; a later call
            // from the same parent creates a fresh child SkillRun.
            spawnerSkillRun: callingConversationId
              ? `skills.run:${callingConversationId}:${String(args._toolCallId || "missing")}:${skillId}`
              : undefined,
          };

          if (waitForResult) {
            const result = await executeAutonomousSkillRun(skillId, runOptions);
            if (!result) return { result: `Skill "${skillId}" could not be started — not found in registry or database, or already running`, error: true };

            const output = result.summary?.trim();
            return {
              result: [
                `Skill "${skillId}" ${result.status} in ${Math.round(result.durationMs / 1000)}s. Session: ${result.sessionId}${result.error ? ` Error: ${result.error}` : ""}`,
                output ? `Output:\n${output}` : "",
              ].filter(Boolean).join("\n"),
            };
          } else {
            let childSessionId: string | null = null;
            const sessionCreatedPromise = new Promise<string>((resolve) => {
              runOptions.onSessionCreated = (id: string) => {
                childSessionId = id;
                resolve(id);
              };
            });

            const runPromise = executeAutonomousSkillRun(skillId, runOptions);

            const raceResult = await Promise.race([
              runPromise,
              sessionCreatedPromise.then(() => "session_created" as const),
              new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 5000)),
            ]);

            if (raceResult === null) {
              return { result: `Skill "${skillId}" could not be started — not found in registry or database, or already running`, error: true };
            }

            if (typeof raceResult === "object" && raceResult !== null && "sessionId" in raceResult) {
              const result = raceResult as { sessionId: string; status: string; durationMs: number; error?: string };
              return {
                result: `Skill "${skillId}" ${result.status} in ${Math.round(result.durationMs / 1000)}s. Session: ${result.sessionId}${result.error ? ` Error: ${result.error}` : ""}`,
              };
            }

            return {
              result: `Skill "${skillId}" spawned (fire-and-forget). Status: started. Session: ${childSessionId || "pending"}. The run is executing in the background.`,
            };
          }
        }
        case "runs": {
          const skillName = args.name as string;
          const limit = typeof args.limit === "number" ? args.limit : 20;
          if (!skillName) return { result: "Missing 'name' parameter", error: true };
          const runs = await storage.getSkillRuns(skillName, limit);

          // Pull failure context (endReason + last crash/error snippet) from
          // the chat session for each run. skill_runs has no dedicated error
          // column — the dashboard surfaces this by reading the underlying
          // session, so we mirror that here for Agent.
          const { chatFileStorage } = await import("./chat-file-storage");
          const enriched = await Promise.all(runs.map(async (r) => {
            let endReason: string | undefined;
            let failureReason: string | null = null;
            try {
              const session = await chatFileStorage.getSession(r.sessionId);
              endReason = session?.endReason;
              if (r.status === "failed") {
                if (endReason && endReason !== "complete") {
                  failureReason = endReason;
                }
                // For crashes/failures, try to surface the last assistant or
                // system message as additional context.
                try {
                  const messages = await chatFileStorage.getMessagesBySession(r.sessionId);
                  for (let i = messages.length - 1; i >= 0; i--) {
                    const m = messages[i];
                    if (m.role === "system" || m.role === "assistant") {
                      const snippet = (m.content || "").slice(0, 240);
                      if (snippet.trim()) {
                        failureReason = failureReason
                          ? `${failureReason}: ${snippet}`
                          : snippet;
                      }
                      break;
                    }
                  }
                } catch {}
              }
            } catch {}
            return {
              id: r.id,
              sessionId: r.sessionId,
              status: r.status,
              endReason: endReason ?? null,
              failureReason,
              startedAt: r.startedAt,
              completedAt: r.completedAt,
              durationMs: r.durationMs,
              passRate: r.passRate,
              checklistTotal: r.checklistTotal,
              checklistPassed: r.checklistPassed,
              comparativeWinner: r.comparativeWinner,
              comparativeReason: r.comparativeReason,
            };
          }));

          return {
            result: JSON.stringify({
              skillName,
              count: enriched.length,
              runs: enriched,
            }),
          };
        }
        case "scores": {
          const skillName = args.name as string;
          const limit = typeof args.limit === "number" ? args.limit : 20;
          if (!skillName) return { result: "Missing 'name' parameter", error: true };

          const runs = await storage.getSkillRuns(skillName, limit);
          const scoredRuns = runs.filter(r => r.passRate !== null && r.passRate !== undefined);

          const scoreView = scoredRuns.map(r => ({
            id: r.id,
            source: "skill_runs" as const,
            sessionId: r.sessionId,
            status: r.status,
            checklistTotal: r.checklistTotal,
            checklistPassed: r.checklistPassed,
            checklistResults: r.checklistResults,
            comparativeWinner: r.comparativeWinner,
            comparativeReason: r.comparativeReason,
            passRate: r.passRate as number,
            durationMs: r.durationMs,
            scoredAt: r.completedAt ?? r.startedAt,
          }));

          return {
            result: JSON.stringify({
              skillName,
              source: "skill_runs",
              totalRuns: runs.length,
              scoredRuns: scoredRuns.length,
              scores: scoreView,
              trend: scoreView.length >= 2
                ? (scoreView[0].passRate > scoreView[scoreView.length - 1].passRate ? "improving" : scoreView[0].passRate === scoreView[scoreView.length - 1].passRate ? "stable" : "declining")
                : "insufficient_data",
            }),
          };
        }
        default:
          return { result: `Unknown skills action: ${action}. Available: list, get, create, update, edit, set_persona, delete, search, run, runs, scores`, error: true };
      }
    } catch (err: any) {
      return { result: `Skills tool error: ${err.message}`, error: true };
    }
  },

  async router(args) {
    const action = args.action || "list_inference_calls";

    const resolveDiagnosticTier = (profile: string | undefined): SemanticTier | undefined => {
      if (!profile) return undefined;
      const parsed = semanticTierSchema.safeParse(String(profile).toLowerCase());
      return parsed.success ? parsed.data : undefined;
    };

    try {
      switch (action) {
        case "list_inference_calls": {
          const { fileApiCallStorage } = await import("./file-storage/api-calls");
          const limit = Math.max(1, Math.min(parseInt(args.limit) || 50, 200));
          const offset = Math.max(0, Math.min(parseInt(args.offset) || 0, 10_000));
          const { eventBus } = await import("./event-bus");
          const bootTime = new Date(eventBus.bootTimestamp);
          const calls = await fileApiCallStorage.getApiCalls(limit + 1, offset, undefined, {
            ...(args.profile ? { profile: String(args.profile) } : {}),
            ...(args.model ? { model: String(args.model) } : {}),
            ...(args.runId ? { runId: String(args.runId) } : {}),
            ...(args.sessionId ? { sessionId: String(args.sessionId) } : {}),
            ...(args.status === "complete" ? { since: bootTime } : {}),
            ...(args.status === "past" ? { before: bootTime } : {}),
          });

          if (calls.length === 0) return { result: "No inference calls found matching the criteria." };
          const page = calls.slice(0, limit);
          const lines = page.map(c => {
            const ts = c.timestamp instanceof Date ? c.timestamp.toISOString() : c.timestamp;
            const settled = typeof c.durationMs === "number"
              || (c.inputTokens || 0) > 0
              || (c.outputTokens || 0) > 0
              || (c.totalTokens || 0) > 0
              || !!c.stopReason;
            const cost = settled
              ? (c.costTotal ? "$" + c.costTotal.toFixed(4) : "$0")
              : "pending";
            const tokens = settled
              ? `in:${c.inputTokens || 0} out:${c.outputTokens || 0}`
              : "in:pending out:pending";
            const duration = typeof c.durationMs === "number"
              ? `${(c.durationMs / 1000).toFixed(1)}s`
              : (settled ? "n/a" : "in-flight");
            const metadata = c.metadata && typeof c.metadata === "object" ? c.metadata as Record<string, unknown> : {};
            const routing = metadata.routing && typeof metadata.routing === "object" ? metadata.routing as Record<string, unknown> : null;
            const latency = metadata.latency && typeof metadata.latency === "object" ? metadata.latency as Record<string, unknown> : null;
            const reasoning = metadata.reasoning && typeof metadata.reasoning === "object" ? metadata.reasoning as Record<string, unknown> : null;
            const reasoningEffort =
              typeof metadata.reasoningEffort === "string"
                ? metadata.reasoningEffort
                : (typeof reasoning?.effort === "string" ? reasoning.effort : null);
            const reasoningSourceKind =
              typeof metadata.reasoningSourceKind === "string"
                ? metadata.reasoningSourceKind
                : (typeof reasoning?.sourceKind === "string" ? reasoning.sourceKind : null);
            const ttft = typeof latency?.providerTtftMs === "number" ? `${latency.providerTtftMs}ms` : null;
            const ttfp = typeof latency?.firstProgressMs === "number" ? `${latency.firstProgressMs}ms` : null;
            const runId = typeof metadata.runId === "string" ? metadata.runId : null;
            const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : null;
            const iteration = typeof metadata.iteration === "number" ? metadata.iteration : null;
            const connectorLabel = typeof routing?.connectorLabel === "string" ? routing.connectorLabel : null;
            const connectorProvider = typeof routing?.connectorProvider === "string"
              ? routing.connectorProvider
              : (typeof c.provider === "string" ? c.provider : null);
            const requestedTier = typeof routing?.requestedTier === "string" ? routing.requestedTier : null;
            const correlation = [
              settled ? null : "status:in-flight",
              connectorProvider ? `provider:${connectorProvider}` : null,
              connectorLabel ? `connector:${connectorLabel}` : null,
              requestedTier ? `tier:${requestedTier}` : null,
              reasoningEffort ? `reasoning:${reasoningEffort}` : null,
              reasoningSourceKind ? `reasoningSource:${reasoningSourceKind}` : null,
              ttft ? `ttft:${ttft}` : null,
              ttfp ? `ttfp:${ttfp}` : null,
              runId ? `run:${runId}` : null,
              sessionId ? `session:${sessionId}` : null,
              iteration != null ? `iteration:${iteration}` : null,
              !sessionId && c.sessionKey ? `sessionKey:${c.sessionKey}` : null,
            ].filter(Boolean).join(" ");
            return `- [${ts}] id:${c.id} model:${c.model} profile:${c.profile || "unknown"} cost:${cost} ${tokens} dur:${duration}${correlation ? ` ${correlation}` : ""}`;
          });
          const more = calls.length > limit ? `\n→ More results available. Use offset=${offset + limit}.` : "";
          return { result: `${page.length} inference calls (offset ${offset}):\n${lines.join("\n")}${more}` };
        }
        case "get_inference_call": {
          const id = parseInt(args.id || "");
          if (isNaN(id)) return { result: "Missing or invalid inference call id", error: true };
          const { fileApiCallStorage } = await import("./file-storage/api-calls");
          const call = await fileApiCallStorage.getApiCall(id, false);
          if (!call) return { result: `Inference call ${id} not found`, error: true };
          const ts = call.timestamp instanceof Date ? call.timestamp.toISOString() : call.timestamp;
          const metadata = call.metadata && typeof call.metadata === "object" ? call.metadata as Record<string, unknown> : {};
          const settled = typeof call.durationMs === "number"
            || (call.inputTokens || 0) > 0
            || (call.outputTokens || 0) > 0
            || (call.totalTokens || 0) > 0
            || !!call.stopReason;
          const routing = metadata.routing && typeof metadata.routing === "object" ? metadata.routing as Record<string, unknown> : null;
          const latency = metadata.latency && typeof metadata.latency === "object" ? metadata.latency as Record<string, unknown> : null;
          const reasoning = metadata.reasoning && typeof metadata.reasoning === "object" ? metadata.reasoning as Record<string, unknown> : null;
          const reasoningEffort =
            typeof metadata.reasoningEffort === "string"
              ? metadata.reasoningEffort
              : (typeof reasoning?.effort === "string" ? reasoning.effort : "n/a");
          const reasoningSourceKind =
            typeof metadata.reasoningSourceKind === "string"
              ? metadata.reasoningSourceKind
              : (typeof reasoning?.sourceKind === "string" ? reasoning.sourceKind : "n/a");
          const thinkingSent =
            typeof metadata.thinkingSent === "string"
              ? metadata.thinkingSent
              : (typeof reasoning?.thinkingSent === "string" ? reasoning.thinkingSent : "n/a");
          const parts = [
            `**Inference Call #${call.id}**`,
            `Model: ${call.model} | Provider: ${call.provider}`,
            `Profile: ${call.profile || "unknown"}`,
            routing
              ? `Routing: connector=${typeof routing.connectorLabel === "string" ? routing.connectorLabel : "n/a"} (${typeof routing.connectorProvider === "string" ? routing.connectorProvider : "n/a"}#${typeof routing.connectorId === "number" ? routing.connectorId : "n/a"}) tier=${typeof routing.requestedTier === "string" ? routing.requestedTier : "n/a"} resolved=${typeof routing.resolvedModel === "string" ? routing.resolvedModel : call.model}`
              : "Routing: n/a",
            `Reasoning: effort=${reasoningEffort} source=${reasoningSourceKind} thinkingSent=${thinkingSent}`,
            latency
              ? `Latency: ttft=${typeof latency.providerTtftMs === "number" ? `${latency.providerTtftMs}ms` : "n/a"} ttfp=${typeof latency.firstProgressMs === "number" ? `${latency.firstProgressMs}ms` : "n/a"} firstSdk=${typeof latency.firstSdkEventMs === "number" ? `${latency.firstSdkEventMs}ms` : "n/a"} firstThinking=${typeof latency.firstThinkingMs === "number" ? `${latency.firstThinkingMs}ms` : "n/a"}`
              : "Latency: n/a",
            settled
              ? `Tokens: ${call.inputTokens} in / ${call.outputTokens} out (${call.totalTokens} total)`
              : "Tokens: pending (in-flight; usage settles when the provider attempt completes)",
            `Cache: ${call.cacheReadTokens || 0} read / ${call.cacheWriteTokens || 0} write`,
            settled
              ? "Cost: $" + (call.costTotal || 0).toFixed(4) + " (input: $" + (call.costInput || 0).toFixed(4) + ", output: $" + (call.costOutput || 0).toFixed(4) + ")"
              : "Cost: pending",
            `Duration: ${call.durationMs ? `${(call.durationMs / 1000).toFixed(1)}s` : (settled ? "n/a" : "in-flight")}`,
            `Status: ${settled ? "settled" : "in-flight"}`,
            `Timestamp: ${ts}`,
            `Stop Reason: ${call.stopReason || "n/a"}`,
            `Run: ${typeof metadata.runId === "string" ? metadata.runId : "n/a"}`,
            `Session: ${typeof metadata.sessionId === "string" ? metadata.sessionId : "n/a"}`,
            `Session Key: ${call.sessionKey || "n/a"}`,
            `Activity: ${typeof metadata.activity === "string" ? metadata.activity : "n/a"}`,
            `Source: ${typeof metadata.source === "string" ? metadata.source : "n/a"}`,
            `Capture: ${call.captureId ? `@inference_context:${call.captureId}` : "n/a"}`,
          ];
          return { result: parts.join("\n") };
        }
        case "eval": {
          const systemPrompt = String(args.systemPrompt || "");
          const userPrompt = String(args.userPrompt || "");
          if (!systemPrompt.trim() && !userPrompt.trim()) return { result: "Missing systemPrompt or userPrompt", error: true };

          const maxPromptChars = 120_000;
          if (systemPrompt.length + userPrompt.length > maxPromptChars) {
            return { result: `Prompt too large for router.eval (${systemPrompt.length + userPrompt.length} chars > ${maxPromptChars})`, error: true };
          }
          const maxTokens = Math.max(1, Math.min(parseInt(args.maxTokens) || 1200, 4000));
          const temperatureRaw = typeof args.temperature === "number" ? args.temperature : parseFloat(args.temperature);
          const temperature = Number.isFinite(temperatureRaw) ? Math.max(0, Math.min(temperatureRaw, 1)) : 0.2;
          const requestedProfile = args.profile ? String(args.profile) : undefined;
          const diagnosticTier = resolveDiagnosticTier(requestedProfile);
          if (requestedProfile && !diagnosticTier) {
            return { result: "router.eval profile is now a diagnostic semantic-tier override. Use max, high, balanced, or fast.", error: true };
          }
          const activity = args.activityId ? String(args.activityId) as ActivityId : ACTIVITY_CHAT;
          const sessionKey = `router_eval:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

          const { chatCompletion } = await import("./model-client");
          const result = await chatCompletion({
            activity,
            messages: [
              ...(systemPrompt.trim() ? [{ role: "system" as const, content: systemPrompt }] : []),
              { role: "user" as const, content: userPrompt },
            ],
            jsonMode: !!args.jsonMode,
            maxTokens,
            temperature,
            semanticTierOverride: diagnosticTier,
            overrideReason: diagnosticTier ? "router.eval diagnostic semantic-tier override" : undefined,
            metadata: {
              source: "router.eval",
              activity,
              sessionKey,
              toolName: "router",
              ...(args.metadata && typeof args.metadata === "object" ? args.metadata : {}),
            },
          });

          let parsedJson: unknown = undefined;
          if (args.jsonMode) {
            try {
              const { extractJson } = await import("./utils/extract-json");
              parsedJson = JSON.parse(extractJson(result.content));
            } catch (jsonErr: unknown) {
              parsedJson = { parseError: jsonErr instanceof Error ? jsonErr.message : String(jsonErr) };
            }
          }

          const { fileApiCallStorage } = await import("./file-storage/api-calls");
          const recent = await fileApiCallStorage.getApiCalls(10, 0);
          const audit = recent.find(c => c.sessionKey === sessionKey);
          return {
            result: JSON.stringify({
              provider: result.provider,
              model: result.model,
              requestedProfile: requestedProfile ?? null,
              requestedSemanticTier: diagnosticTier ?? null,
              resolvedTier: result.metadata?.routing?.tier ?? audit?.metadata?.routing?.tier ?? audit?.profile ?? null,
              auditProfile: audit?.profile ?? null,
              activity,
              inputTokens: result.usage?.promptTokens ?? null,
              outputTokens: result.usage?.completionTokens ?? null,
              totalTokens: result.usage?.totalTokens ?? null,
              inferenceCallId: audit?.id ?? null,
              rawOutput: result.content,
              parsedJson,
            }, null, 2),
          };
        }
        default:
          return { result: `Unknown router action: ${action}. Available: eval, list_inference_calls, get_inference_call`, error: true };
      }
    } catch (err: any) {
      return { result: `Router tool error: ${err.message}`, error: true };
    }
  },

  async converse(args) {
    const action = args.action || "initiate";

    if (action === "set_attention") {
      const sessionId = args.sessionId;
      if (!sessionId) return contractReject("Missing 'sessionId' parameter for set_attention action", "session_input_invalid");
      try {
        const { chatFileStorage } = await import("./chat-file-storage");
        const conv = await chatFileStorage.getSession(sessionId);
        if (!conv) return contractReject(`Session ${sessionId} not found`, "session_input_invalid");
        const isPinned = (args.isPinned ?? args.needsAttention) !== false;
        await chatFileStorage.setSessionPinned(sessionId, isPinned);
        return { result: `Session ${sessionId} pin flag set to ${isPinned}` };
      } catch (err: any) {
        return contractReject(`set_attention error: ${err.message}`, "session_input_invalid");
      }
    }

    const topic = args.topic?.trim();
    const message = args.message?.trim();
    if (!topic) return contractReject("Missing 'topic' parameter", "session_input_invalid");
    if (!message) return contractReject("Missing 'message' parameter", "session_input_invalid");

    try {
      const { chatFileStorage } = await import("./chat-file-storage");

      const shortTitle = topic.split(/\s+/).slice(0, 3).join(" ");
      const callingSessionId: string | undefined = args._sessionId || undefined;
      const spawnReason = `converse:${topic.slice(0, 40)}`;
      let agenda: import("@shared/models/chat").SessionAgenda | undefined;
      try {
        agenda = Array.isArray(args.agenda)
          ? (await import("./chat-file-storage")).normalizeSessionAgenda(args.agenda)
          : undefined;
      } catch (err: unknown) {
        return contractReject(`Invalid conversation agenda: ${err instanceof Error ? err.message : String(err)}`, "session_input_invalid");
      }

      let convId: string;
      {
        // Converse sessions are always top-level so they appear in the main
        // SessionMenu. Never parent them under the calling autonomous session,
        // which would hide them behind the autonomous-sessions fold.
        const created = await chatFileStorage.createAutonomousSession(
          shortTitle,
          "agent",
          undefined,
          undefined,
          undefined,
          { agenda, spawnReason, spawnerTool: "converse.initiate", triggerType: "agent" as const, triggerId: callingSessionId || undefined, triggerName: topic },
        );
        convId = created.id;
      }
      const conv = { id: convId };

      const fullMessage = message;
      await chatFileStorage.createMessage(conv.id, "assistant", fullMessage);
      await chatFileStorage.setSessionPinned(conv.id, true);
      // Mark unread so the session gets unread emphasis in the session menu and
      // trips the global notification indicator, matching timer/reminder-initiated
      // sessions. Cleared when the user opens the conversation.
      await chatFileStorage.setHasUnreadResult(conv.id, true);
      await chatFileStorage.saveSession(conv.id, shortTitle);

      const { eventBus } = await import("./event-bus");
      eventBus.publish({
        category: "chat",
        event: "chat.xyz.initiated",
        payload: { sessionId: conv.id, topic },
      });

      return { result: `Created conversation "${topic}" (${conv.id}) pinned and marked unread. It will stay highlighted in the session menu until the user opens it.` };
    } catch (err: any) {
      return { result: `Failed to create conversation: ${err.message}`, error: true };
    }
  },


  async memory_graph(args) {
    return {
      result: JSON.stringify({
        deprecated: true,
        storage: "memory_entries",
        message: "Legacy memory_graph is retired. Use vNext claim graph endpoints and memory tool actions: search_claims, vnext_claim_detail, get_entity_links, and run_vnext_lifecycle.",
        requestedAction: args?.action || "create_link",
      }),
      error: true,
    };
  },
  async list_amortizations(_args: Record<string, any>): Promise<ToolHandlerResult> {
    const log = createLogger("BridgeTools:list_amortizations");
    try {
      const { listAmortizationsWithTxn } = await import("./finance-amortization");
      const rows = await listAmortizationsWithTxn({ activeOnly: false });
      if (rows.length === 0) return { result: "No transaction amortizations configured." };
      const lines = rows.map(r => {
        const status = r.isActive ? (r.orphaned ? "ORPHANED" : "active") : "inactive";
        const txnLabel = r.txnMonth ? `${r.txnMonth} ${r.txnName ?? ""}` : `(deleted txn #${r.transactionId})`;
        return `- #${r.id} [${status}] ${txnLabel}: $${r.originalAmount.toLocaleString()} spread over ${r.spreadMonths}mo from ${r.startMonth} (${r.category})${r.notes ? ` — ${r.notes}` : ""}`;
      });
      return { result: `**Transaction Amortizations** (${rows.length})\n${lines.join("\n")}` };
    } catch (e: any) {
      log.error("[Finance] list_amortizations error:", e?.message);
      return { result: `Error listing amortizations: ${e?.message}`, error: true };
    }
  },

  async amortize(args: Record<string, any>): Promise<ToolHandlerResult> {
    const log = createLogger("BridgeTools:amortize");
    try {
      const { createAmortization, updateAmortization } = await import("./finance-amortization");

      // Update existing amortization when an `id` is provided.
      const idArg = args.id;
      const id = typeof idArg === "number" ? idArg : (typeof idArg === "string" && idArg.length > 0 ? parseInt(idArg) : NaN);
      if (!isNaN(id)) {
        const patch: Partial<{ spreadMonths: number; startMonth: string; category: string; isActive: boolean; notes: string | null }> = {};
        if (typeof args.spreadMonths === "number") {
          if (args.spreadMonths < 1 || args.spreadMonths > 120) return { result: "spreadMonths must be 1-120", error: true };
          patch.spreadMonths = args.spreadMonths;
        }
        if (typeof args.startMonth === "string") {
          if (!/^\d{4}-\d{2}$/.test(args.startMonth)) return { result: "startMonth must be YYYY-MM", error: true };
          patch.startMonth = args.startMonth;
        }
        if (typeof args.category === "string") patch.category = args.category;
        if (typeof args.isActive === "boolean") patch.isActive = args.isActive;
        if (typeof args.notes === "string" || args.notes === null) patch.notes = args.notes;
        const row = await updateAmortization(id, patch);
        if (!row) return { result: `Amortization #${id} not found`, error: true };
        return { result: `Updated amortization #${row.id}.` };
      }

      // Otherwise create a new amortization.
      if (typeof args.transactionId !== "string") return { result: "transactionId is required (Plaid transaction ID string)", error: true };
      if (typeof args.originalAmount !== "number") return { result: "originalAmount is required", error: true };
      if (typeof args.spreadMonths !== "number" || args.spreadMonths < 1 || args.spreadMonths > 120) return { result: "spreadMonths must be 1-120", error: true };
      if (typeof args.startMonth !== "string" || !/^\d{4}-\d{2}$/.test(args.startMonth)) return { result: "startMonth must be YYYY-MM", error: true };
      if (typeof args.category !== "string") return { result: "category is required", error: true };
      const row = await createAmortization({
        transactionId: args.transactionId,
        originalAmount: args.originalAmount,
        spreadMonths: args.spreadMonths,
        startMonth: args.startMonth,
        category: args.category,
        isActive: args.isActive !== false,
        notes: typeof args.notes === "string" ? args.notes : null,
      });
      return { result: `Created amortization #${row.id}: $${row.originalAmount.toLocaleString()} spread over ${row.spreadMonths}mo from ${row.startMonth}.` };
    } catch (e: any) {
      log.error("[Finance] amortize error:", e?.message);
      return { result: `Error amortizing transaction: ${e?.message}`, error: true };
    }
  },

  async remove_amortization(args: Record<string, any>): Promise<ToolHandlerResult> {
    const log = createLogger("BridgeTools:remove_amortization");
    try {
      const id = typeof args.id === "number" ? args.id : parseInt(args.id);
      if (isNaN(id)) return { result: "id is required (numeric)", error: true };
      const { softDeleteAmortization } = await import("./finance-amortization");
      const ok = await softDeleteAmortization(id);
      if (!ok) return { result: `Amortization #${id} not found`, error: true };
      return { result: `Deactivated amortization #${id}.` };
    } catch (e: any) {
      log.error("[Finance] remove_amortization error:", e?.message);
      return { result: `Error removing amortization: ${e?.message}`, error: true };
    }
  },

  async get_finance_summary(): Promise<ToolHandlerResult> {
    try {
      const { getFinanceSummary, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV in Settings → Connections.` };
      }
      const summary = await getFinanceSummary();
      if (summary.accountCount === 0) return { result: "No financial accounts connected yet. Connect a bank account in Settings → Connections." };
      const parts: string[] = [];

      if (summary.trajectory) {
        const t = summary.trajectory;
        const statusLabel = t.trajectoryStatus === "on_track" ? "On Track" : t.trajectoryStatus === "drifting" ? "Drifting" : "Off Track";
        parts.push(`**Financial Trajectory** [${statusLabel}]`);
        parts.push(`Net Worth: $${t.currentNetWorth.toLocaleString()} → $${t.projectedNetWorth12mo.toLocaleString()} (projected 12mo)`);
        parts.push(`Monthly Net Cash Flow: $${t.monthlyNetCashFlow.toLocaleString()}/mo`);
        parts.push(`Liquid Cash: $${t.liquidCash.toLocaleString()} | Total Liabilities: $${t.totalLiabilities.toLocaleString()}`);
        if (t.lastCompletedMonth) {
          const lm = t.lastCompletedMonth;
          parts.push(``);
          parts.push(`Last Completed Month (${lm.month}):`);
          parts.push(`  Income: expected $${lm.expectedIncome.toLocaleString()}, actual $${lm.actualIncome.toLocaleString()}`);
          parts.push(`  Spending: expected $${lm.expectedSpending.toLocaleString()}, actual $${lm.actualSpending.toLocaleString()}`);
          parts.push(`  Net Cash Flow: expected $${lm.expectedNetCashFlow.toLocaleString()}, actual $${lm.actualNetCashFlow.toLocaleString()}` + (lm.netCashFlowDeviationPct !== null ? ` (${lm.netCashFlowDeviationPct >= 0 ? "+" : ""}${lm.netCashFlowDeviationPct.toFixed(1)}%)` : ""));
          if (lm.topDivergentCategories.length > 0) {
            parts.push(`  Top Divergences:`);
            for (const c of lm.topDivergentCategories) {
              const sign = c.deltaAbs >= 0 ? "+" : "";
              parts.push(`    - ${c.category}: ${sign}$${c.deltaAbs.toFixed(0)}` + (c.deltaPct !== null ? ` (${sign}${c.deltaPct.toFixed(0)}%)` : ""));
            }
          }
        }
        parts.push(``);
      }

      parts.push(`**Snapshot**`);
      parts.push(`Net Worth: $${summary.netWorth.toLocaleString()}`);
      parts.push(`Total Assets: $${summary.totalAssets.toLocaleString()}`);
      parts.push(`Total Liabilities: $${summary.totalLiabilities.toLocaleString()}`);
      parts.push(`Accounts: ${summary.accountCount}`);
      if (summary.savingsRate !== null) parts.push(`Savings Rate (30-day, trailing): ${summary.savingsRate}%`);
      if (Object.keys(summary.spendingByCategory).length > 0) {
        const catLines = Object.entries(summary.spendingByCategory)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, amount]) => `  - ${cat}: $${amount.toFixed(2)}`);
        parts.push(`\nSpending by Category (30-day):\n${catLines.join("\n")}`);
      }
      if (Object.keys(summary.investmentAllocation).length > 0) {
        const allocLines = Object.entries(summary.investmentAllocation)
          .sort((a, b) => b[1] - a[1])
          .map(([type, pct]) => `  - ${type}: ${pct}%`);
        parts.push(`\nInvestment Allocation:\n${allocLines.join("\n")}`);
      }
      if (summary.recurringObligations > 0) parts.push(`\nRecurring Obligations: $${summary.recurringObligations.toLocaleString()}/month`);
      return { result: parts.join("\n") };
    } catch (err: any) {
      return { result: `Finance summary error: ${err.message}`, error: true };
    }
  },

  async get_accounts(): Promise<ToolHandlerResult> {
    try {
      const { getAccountsList, getPlaidItems, isPlaidConfigured } = await import("./plaid-service");
      const { db } = await import("./db");
      const { manualAssets, manual401kAccounts, incomeDeductions, incomeSources } = await import("@shared/schema");

      const parts: string[] = ["**Account Balances**\n"];

      if (isPlaidConfigured()) {
        const items = await getPlaidItems();
        const accounts = await getAccountsList();
        const byItem = new Map<string, typeof accounts>();
        for (const a of accounts) {
          const list = byItem.get(a.itemId) || [];
          list.push(a);
          byItem.set(a.itemId, list);
        }
        for (const item of items) {
          parts.push(`**${item.institutionName}** ${item.healthy ? "✓" : "⚠ " + (item.healthError || "unhealthy")}`);
          const itemAccounts = byItem.get(item.itemId) || [];
          for (const a of itemAccounts) {
            const bal = a.currentBalance !== null ? `$${a.currentBalance.toLocaleString()}` : "N/A";
            const avail = a.availableBalance !== null ? ` (available: $${a.availableBalance.toLocaleString()})` : "";
            const limit = a.creditLimit !== null ? ` (limit: $${a.creditLimit.toLocaleString()})` : "";
            parts.push(`  - ${a.name} [${a.type}/${a.subtype || "—"}]: ${bal}${avail}${limit}`);
          }
        }
      }

      const assets = await db.select().from(manualAssets).where(visibleFinanceForCurrentPrincipal(manualAssets));
      if (assets.length > 0) {
        parts.push("\n**Manual Assets**");
        for (const a of assets) {
          parts.push(`  - ${a.name} [${a.category}]: $${a.currentValue.toLocaleString()}`);
        }
      }

      const [k401Rows, deductionRows, sourceRows] = await Promise.all([
        db.select().from(manual401kAccounts).where(visibleFinanceForCurrentPrincipal(manual401kAccounts)),
        db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
        db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
      ]);
      if (k401Rows.length > 0) {
        const FREQ_MULT: Record<string, number> = { weekly: 52/12, biweekly: 26/12, semimonthly: 2, monthly: 1, quarterly: 1/3, annually: 1/12 };
        const deductionMap = new Map(deductionRows.map(d => [d.id, d]));
        const sourceMap = new Map(sourceRows.map(s => [s.id, s]));
        parts.push("\n**401k Accounts**");
        for (const a of k401Rows) {
          const ded = a.linkedDeductionId ? deductionMap.get(a.linkedDeductionId) : null;
          const source = ded ? sourceMap.get(ded.sourceId) : null;
          const mult = source ? (FREQ_MULT[source.payFrequency] || 1) : 1;
          const monthly = ded ? ded.amount * mult : 0;
          parts.push(`  - ${a.name}: $${a.currentBalance.toLocaleString()}${monthly > 0 ? ` (contribution $${monthly.toFixed(0)}/mo)` : ""}`);
        }
      }

      if (parts.length <= 1) return { result: "No financial accounts connected, no manual assets, and no 401k accounts." };
      return { result: parts.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Accounts error: ${msg}`, error: true };
    }
  },

  async get_transactions(args: Record<string, any>): Promise<ToolHandlerResult> {
    try {
      const { getTransactions, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.` };
      }
      const { transactions: txns } = await getTransactions({
        startDate: args.startDate,
        endDate: args.endDate,
        category: args.category,
        accountId: args.accountId,
        limit: args.limit,
      });
      if (txns.length === 0) return { result: "No transactions found for the given filters." };
      const lines = txns.map((t: any) => {
        const sign = t.amount >= 0 ? "-" : "+";
        const absAmt = Math.abs(t.amount).toFixed(2);
        const merchant = t.merchantName || t.name;
        const cat = t.categoryPrimary ? ` [${t.categoryPrimary}]` : "";
        const pending = t.pending ? " (pending)" : "";
        return `${t.date} ${sign}$${absAmt} ${merchant}${cat}${pending}`;
      });
      return { result: `${txns.length} transactions:\n${lines.join("\n")}` };
    } catch (err: any) {
      return { result: `Transactions error: ${err.message}`, error: true };
    }
  },

  async get_holdings(): Promise<ToolHandlerResult> {
    try {
      const { getHoldingsList, isPlaidConfigured } = await import("./plaid-service");
      const { db } = await import("./db");
      const { manual401kAccounts, incomeDeductions, incomeSources } = await import("@shared/schema");

      const [k401Rows, deductionRows, sourceRows] = await Promise.all([
        db.select().from(manual401kAccounts).where(visibleFinanceForCurrentPrincipal(manual401kAccounts)),
        db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
        db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
      ]);

      let holdings: any[] = [];
      if (isPlaidConfigured()) {
        holdings = await getHoldingsList();
      }

      if (holdings.length === 0 && k401Rows.length === 0) {
        if (!isPlaidConfigured()) {
          const { getPlaidConfigDiagnostics } = await import("./plaid-service");
          const diag = getPlaidConfigDiagnostics();
          const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
          return { result: `No investment holdings found. Plaid is not configured: ${issues.join("; ")}.` };
        }
        return { result: "No investment holdings found." };
      }

      const parts: string[] = [];

      if (holdings.length > 0) {
        const lines = holdings.map((h: any) => {
          const ticker = h.tickerSymbol ? ` (${h.tickerSymbol})` : "";
          const value = h.institutionValue ? `$${h.institutionValue.toFixed(2)}` : "N/A";
          const costBasis = h.costBasis ? `cost basis: $${h.costBasis.toFixed(2)}` : "";
          return `- ${h.securityName || "Unknown"}${ticker}: ${h.quantity} shares @ ${value}${costBasis ? ` (${costBasis})` : ""}`;
        });
        const brokerageTotal = holdings.reduce((s: number, h: any) => s + (h.institutionValue || 0), 0);
        parts.push(`**Brokerage Holdings (${holdings.length})**\nSubtotal: $${brokerageTotal.toLocaleString()}\n${lines.join("\n")}`);
      }

      if (k401Rows.length > 0) {
        const FREQ_MULT: Record<string, number> = { weekly: 52/12, biweekly: 26/12, semimonthly: 2, monthly: 1, quarterly: 1/3, annually: 1/12 };
        const deductionMap = new Map(deductionRows.map(d => [d.id, d]));
        const sourceMap = new Map(sourceRows.map(s => [s.id, s]));
        const k401Total = k401Rows.reduce((s, a) => s + a.currentBalance, 0);
        const lines = k401Rows.map(a => {
          const ded = a.linkedDeductionId ? deductionMap.get(a.linkedDeductionId) : null;
          const source = ded ? sourceMap.get(ded.sourceId) : null;
          const mult = source ? (FREQ_MULT[source.payFrequency] || 1) : 1;
          const monthly = ded ? ded.amount * mult : 0;
          return `- **${a.name}**: balance $${a.currentBalance.toLocaleString()}${monthly > 0 ? `, contribution $${monthly.toFixed(0)}/mo` : ""}`;
        });
        parts.push(`**401k Accounts (${k401Rows.length})**\nSubtotal: $${k401Total.toLocaleString()}\n${lines.join("\n")}`);
      }

      const brokerageTotal = holdings.reduce((s: number, h: any) => s + (h.institutionValue || 0), 0);
      const k401Total = k401Rows.reduce((s, a) => s + a.currentBalance, 0);
      const grandTotal = brokerageTotal + k401Total;
      parts.push(`\n**Total Invested: $${grandTotal.toLocaleString()}**`);

      return { result: parts.join("\n\n") };
    } catch (err: any) {
      return { result: `Holdings error: ${err.message}`, error: true };
    }
  },

  async get_liabilities(): Promise<ToolHandlerResult> {
    try {
      const { db } = await import("./db");
      const { manualLiabilities, debtPayments, plaidLiabilities: plaidLiabilitiesTable, financedAssets, plaidTransactions } = await import("@shared/schema");
      const { desc, inArray, lt, and } = await import("drizzle-orm");

      const [manual, plaid, payments, financedAssetRows] = await Promise.all([
        db.select().from(manualLiabilities).where(visibleFinanceForCurrentPrincipal(manualLiabilities)),
        db.select().from(plaidLiabilitiesTable).where(visibleFinanceForCurrentPrincipal(plaidLiabilitiesTable)),
        db.select().from(debtPayments).where(visibleFinanceForCurrentPrincipal(debtPayments)).orderBy(desc(debtPayments.date)),
        db.select().from(financedAssets).where(visibleFinanceForCurrentPrincipal(financedAssets)),
      ]);

      let autoPayments: Array<{ source: "auto"; liabilityType: string; liabilityId: number; amount: number; date: string; notes: string | null }> = [];
      if (plaid.length > 0) {
        const accountIds = plaid.map(l => l.accountId);
        const txns = await db.select().from(plaidTransactions)
          .where(visibleFinanceForCurrentPrincipal(plaidTransactions, and(inArray(plaidTransactions.accountId, accountIds), lt(plaidTransactions.amount, 0))))
          .orderBy(desc(plaidTransactions.date));
        const accountToLiability = new Map(plaid.map(l => [l.accountId, l]));
        autoPayments = txns.map(t => {
          const liability = accountToLiability.get(t.accountId)!;
          return {
            source: "auto" as const,
            liabilityType: "plaid",
            liabilityId: liability.id,
            amount: Math.abs(t.amount),
            date: t.date,
            notes: t.merchantName || t.name,
          };
        });
      }

      const allPayments = [
        ...payments.map(p => ({ source: "manual" as const, liabilityType: p.liabilityType, liabilityId: p.liabilityId, amount: p.amount, date: p.date, notes: p.notes })),
        ...autoPayments,
      ].sort((a, b) => b.date.localeCompare(a.date));

      const lines: string[] = [];
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const paymentsThisMonth = allPayments.filter(p => p.date.startsWith(currentMonth));
      let totalDebt = 0;
      let totalMin = 0;

      for (const p of plaid) {
        const payCount = allPayments.filter(pay => pay.liabilityType === "plaid" && pay.liabilityId === p.id).length;
        const parts = [`- [Plaid] ${p.liabilityType}`];
        if (p.balance !== null) { parts.push(`balance: $${p.balance.toFixed(2)}`); totalDebt += p.balance; }
        if (p.aprPercentage !== null) parts.push(`APR: ${p.aprPercentage}%`);
        if (p.minimumPayment !== null) { parts.push(`min: $${p.minimumPayment.toFixed(2)}`); totalMin += p.minimumPayment; }
        if (p.nextPaymentDueDate) parts.push(`due: ${p.nextPaymentDueDate}`);
        if (payCount > 0) parts.push(`${payCount} payments logged`);
        if (p.notes) parts.push(`notes: ${p.notes}`);
        lines.push(parts.join(", "));
      }

      for (const m of manual) {
        const payCount = allPayments.filter(pay => pay.liabilityType === "manual" && pay.liabilityId === m.id).length;
        const parts = [`- [Manual] ${m.name} (${m.category})`];
        parts.push(`balance: $${m.balance.toFixed(2)}`);
        totalDebt += m.balance;
        if (m.aprPercentage !== null) parts.push(`APR: ${m.aprPercentage}%`);
        if (m.minimumPayment !== null) { parts.push(`min: $${m.minimumPayment.toFixed(2)}`); totalMin += m.minimumPayment; }
        if (m.nextPaymentDueDate) parts.push(`due: ${m.nextPaymentDueDate}`);
        if (payCount > 0) parts.push(`${payCount} payments logged`);
        if (m.notes) parts.push(`notes: ${m.notes}`);
        lines.push(parts.join(", "));
      }

      for (const fa of financedAssetRows) {
        if (fa.loanBalance && fa.loanBalance > 0) {
          const parts = [`- [Financed] ${fa.name} (${fa.category})`];
          parts.push(`loan balance: $${fa.loanBalance.toFixed(2)}`);
          totalDebt += fa.loanBalance;
          if (fa.loanApr !== null && fa.loanApr !== undefined) parts.push(`APR: ${fa.loanApr}%`);
          if (fa.monthlyPayment !== null && fa.monthlyPayment !== undefined) { parts.push(`payment: $${fa.monthlyPayment.toFixed(2)}/mo`); totalMin += fa.monthlyPayment; }
          if (fa.notes) parts.push(`notes: ${fa.notes}`);
          lines.push(parts.join(", "));
        }
      }

      const totalPaidThisMonth = paymentsThisMonth.reduce((s, p) => s + p.amount, 0);
      const header = `Total debt: $${totalDebt.toFixed(2)}, min payments: $${totalMin.toFixed(2)}/mo, paid this month: $${totalPaidThisMonth.toFixed(2)} (${paymentsThisMonth.length} payments)`;

      const totalLineItems = plaid.length + manual.length + financedAssetRows.filter(fa => fa.loanBalance && fa.loanBalance > 0).length;
      if (lines.length === 0) return { result: "No liabilities found (Plaid, manual, or financed)." };
      return { result: `${header}\n\n${totalLineItems} liabilities:\n${lines.join("\n")}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Liabilities error: ${msg}`, error: true };
    }
  },

  async get_debt_payments(): Promise<ToolHandlerResult> {
    try {
      const { db } = await import("./db");
      const { debtPayments, manualLiabilities, plaidLiabilities: plaidLiabilitiesTable, plaidTransactions } = await import("@shared/schema");
      const { desc, inArray, lt, and } = await import("drizzle-orm");

      const [manualPayments, manual, plaid] = await Promise.all([
        db.select().from(debtPayments).where(visibleFinanceForCurrentPrincipal(debtPayments)).orderBy(desc(debtPayments.date)),
        db.select().from(manualLiabilities).where(visibleFinanceForCurrentPrincipal(manualLiabilities)),
        db.select().from(plaidLiabilitiesTable).where(visibleFinanceForCurrentPrincipal(plaidLiabilitiesTable)),
      ]);

      let autoPayments: Array<{ source: "auto"; liabilityType: string; liabilityId: number; amount: number; date: string; notes: string | null }> = [];
      if (plaid.length > 0) {
        const accountIds = plaid.map(l => l.accountId);
        const txns = await db.select().from(plaidTransactions)
          .where(visibleFinanceForCurrentPrincipal(plaidTransactions, and(inArray(plaidTransactions.accountId, accountIds), lt(plaidTransactions.amount, 0))))
          .orderBy(desc(plaidTransactions.date));
        const accountToLiability = new Map(plaid.map(l => [l.accountId, l]));
        autoPayments = txns.map(t => {
          const liability = accountToLiability.get(t.accountId)!;
          return {
            source: "auto" as const,
            liabilityType: "plaid",
            liabilityId: liability.id,
            amount: Math.abs(t.amount),
            date: t.date,
            notes: t.merchantName || t.name,
          };
        });
      }

      const allPayments = [
        ...manualPayments.map(p => ({ source: "manual" as const, liabilityType: p.liabilityType, liabilityId: p.liabilityId, amount: p.amount, date: p.date, notes: p.notes })),
        ...autoPayments,
      ].sort((a, b) => b.date.localeCompare(a.date));

      if (allPayments.length === 0) return { result: "No debt payments recorded." };

      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const thisMonth = allPayments.filter(p => p.date.startsWith(currentMonth));
      const totalAll = allPayments.reduce((s, p) => s + p.amount, 0);
      const totalThisMonth = thisMonth.reduce((s, p) => s + p.amount, 0);
      const manualCount = allPayments.filter(p => p.source === "manual").length;
      const autoCount = allPayments.filter(p => p.source === "auto").length;

      const balanceLines: string[] = [];
      for (const m of manual) {
        const paid = allPayments.filter(p => p.liabilityType === "manual" && p.liabilityId === m.id).reduce((s, p) => s + p.amount, 0);
        balanceLines.push(`- [Manual] ${m.name}: balance $${m.balance.toFixed(2)}, paid $${paid.toFixed(2)}`);
      }
      for (const p of plaid) {
        const paid = allPayments.filter(pay => pay.liabilityType === "plaid" && pay.liabilityId === p.id).reduce((s, pay) => s + pay.amount, 0);
        if (paid > 0) {
          balanceLines.push(`- [Plaid] ${p.liabilityType}: balance $${(p.balance || 0).toFixed(2)}, paid $${paid.toFixed(2)}`);
        }
      }

      const recent = allPayments.slice(0, 10).map(p => {
        const parts = [`- ${p.date}: $${p.amount.toFixed(2)} [${p.source}] (${p.liabilityType} #${p.liabilityId})`];
        if (p.notes) parts.push(`"${p.notes}"`);
        return parts.join(" ");
      });

      const header = `${allPayments.length} total payments ($${totalAll.toFixed(2)}), ${thisMonth.length} this month ($${totalThisMonth.toFixed(2)})\n${manualCount} manual, ${autoCount} auto-detected from Plaid transactions`;
      const sections = [header];
      if (balanceLines.length > 0) sections.push(`\nPer-liability balances:\n${balanceLines.join("\n")}`);
      sections.push(`\nRecent payments:\n${recent.join("\n")}`);

      return { result: sections.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Debt payments error: ${msg}`, error: true };
    }
  },

  async get_categories(): Promise<ToolHandlerResult> {
    try {
      const { db } = await import("./db");
      const { expenseCategories, merchantCategoryOverrides } = await import("@shared/schema");

      const [cats, overrides] = await Promise.all([
        db.select().from(expenseCategories).where(visibleFinanceForCurrentPrincipal(expenseCategories)),
        db.select().from(merchantCategoryOverrides).where(visibleFinanceForCurrentPrincipal(merchantCategoryOverrides)),
      ]);

      if (cats.length === 0) return { result: "No expense categories configured yet." };

      const catById = new Map(cats.map(c => [c.id, c]));
      const catLines = cats
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(c => {
          const plaid = c.plaidCategory ? ` → ${c.plaidCategory}` : "";
          const def = c.isDefault ? " (default)" : "";
          return `- ${c.name}${plaid}${def}`;
        });

      const parts = [`${cats.length} categories:\n${catLines.join("\n")}`];

      if (overrides.length > 0) {
        const overrideLines = overrides.map(o => {
          const cat = catById.get(o.categoryId);
          return `- "${o.merchantName}" → ${cat?.name || `category #${o.categoryId}`}`;
        });
        parts.push(`\n${overrides.length} merchant overrides:\n${overrideLines.join("\n")}`);
      }

      return { result: parts.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Categories error: ${msg}`, error: true };
    }
  },

  async get_budget(args: Record<string, unknown>): Promise<ToolHandlerResult> {
    try {
      const { isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV. Budget comparisons require transaction data from Plaid.` };
      }

      const { db } = await import("./db");
      const { budgetEntries, plaidTransactions, expenseCategories, merchantCategoryOverrides } = await import("@shared/schema");
      const { and, gte, lte } = await import("drizzle-orm");

      const mode = typeof args.mode === "string" ? args.mode : "this_month";
      const month = typeof args.month === "string" ? args.month : null;
      const now = new Date();
      let startDate: string;
      let endDate: string;
      let divisor = 1;

      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const [year, mon] = month.split("-").map(Number);
        const monthStart = new Date(year, mon - 1, 1);
        startDate = monthStart.toISOString().split("T")[0];
        const monthEnd = new Date(year, mon, 0);
        endDate = monthEnd.toISOString().split("T")[0];
      } else if (mode === "last_month") {
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startDate = lastMonth.toISOString().split("T")[0];
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = lastMonthEnd.toISOString().split("T")[0];
      } else if (mode === "trailing_avg") {
        const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);
        startDate = twelveMonthsAgo.toISOString().split("T")[0];
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = lastMonthEnd.toISOString().split("T")[0];
        divisor = 12;
      } else {
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        startDate = thisMonthStart.toISOString().split("T")[0];
        endDate = now.toISOString().split("T")[0];
      }

      const { listAmortizationsWithTxn, getAmortizedSpendingForMonth } = await import("./finance-amortization");
      const [budgets, txns, catRows, overrideRows, amortizations] = await Promise.all([
        db.select().from(budgetEntries).where(visibleFinanceForCurrentPrincipal(budgetEntries)),
        db.select().from(plaidTransactions).where(visibleFinanceForCurrentPrincipal(plaidTransactions, and(gte(plaidTransactions.date, startDate), lte(plaidTransactions.date, endDate)))),
        db.select().from(expenseCategories).where(visibleFinanceForCurrentPrincipal(expenseCategories)),
        db.select().from(merchantCategoryOverrides).where(visibleFinanceForCurrentPrincipal(merchantCategoryOverrides)),
        listAmortizationsWithTxn({ activeOnly: true }),
      ]);

      const catById = new Map(catRows.map(c => [c.id, c]));
      const catByPlaid = new Map(catRows.filter(c => c.plaidCategory).map(c => [c.plaidCategory!, c]));
      const merchantMap = new Map(overrideRows.map(o => [o.merchantName.toLowerCase(), o.categoryId]));

      let income = 0;
      let spending = 0;
      const spendingByCategory: Record<string, number> = {};
      // Track per-month spending for amortization overlay
      const spendingByMonthByCategory: Record<string, Record<string, number>> = {};

      for (const txn of txns) {
        if (txn.amount < 0) {
          income += Math.abs(txn.amount);
        } else {
          spending += txn.amount;
          let cat = txn.categoryPrimary || "UNCATEGORIZED";
          const merchant = (txn.merchantName || txn.name || "").toLowerCase();
          const overrideCatId = merchantMap.get(merchant);
          if (overrideCatId !== undefined) {
            const catObj = catById.get(overrideCatId);
            cat = catObj?.plaidCategory || catObj?.name || cat;
          }
          spendingByCategory[cat] = (spendingByCategory[cat] || 0) + txn.amount;
          const m = txn.date.substring(0, 7);
          if (!spendingByMonthByCategory[m]) spendingByMonthByCategory[m] = {};
          spendingByMonthByCategory[m][cat] = (spendingByMonthByCategory[m][cat] || 0) + txn.amount;
        }
      }

      // Apply amortization overlay: rebuild spendingByCategory & spending from per-month adjusted spending
      if (amortizations.length > 0) {
        const monthsInRange = Object.keys(spendingByMonthByCategory);
        // Also include any month that an amortization spreads into (within range),
        // plus the txn's own month so the lump-subtraction fires even when the
        // spread starts later than the txn month.
        const startM = startDate.substring(0, 7);
        const endM = endDate.substring(0, 7);
        for (const a of amortizations) {
          if (!a.isActive || a.orphaned) continue;
          for (let i = 0; i < a.spreadMonths; i++) {
            const [sy, sm] = a.startMonth.split("-").map(Number);
            const d = new Date(sy, sm - 1 + i, 1);
            const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            if (m >= startM && m <= endM && !monthsInRange.includes(m)) monthsInRange.push(m);
          }
          if (a.txnMonth && a.txnMonth >= startM && a.txnMonth <= endM && !monthsInRange.includes(a.txnMonth)) {
            monthsInRange.push(a.txnMonth);
          }
        }
        const newTotals: Record<string, number> = {};
        let newSpending = 0;
        for (const m of monthsInRange) {
          const adjusted = getAmortizedSpendingForMonth(m, spendingByMonthByCategory[m] || {}, amortizations);
          for (const [cat, amt] of Object.entries(adjusted)) {
            newTotals[cat] = (newTotals[cat] || 0) + amt;
            newSpending += amt;
          }
        }
        for (const k of Object.keys(spendingByCategory)) delete spendingByCategory[k];
        for (const [k, v] of Object.entries(newTotals)) spendingByCategory[k] = v;
        spending = newSpending;
      }

      if (divisor > 1) {
        income = income / divisor;
        spending = spending / divisor;
        for (const cat in spendingByCategory) {
          spendingByCategory[cat] = Math.round(spendingByCategory[cat] / divisor * 100) / 100;
        }
      }

      const totalBudget = budgets.reduce((s, b) => s + b.monthlyAmount, 0);
      const modeLabel = mode === "trailing_avg" ? "12-month trailing average" : mode === "last_month" ? "last month" : "this month";

      const lines: string[] = [];
      lines.push(`**Budget vs Actual (${modeLabel})**`);
      lines.push(`Period: ${startDate} to ${endDate}`);
      lines.push(`Total Budget: $${totalBudget.toFixed(2)}/mo`);
      lines.push(`Actual Spending: $${Math.round(spending * 100) / 100}`);
      lines.push(`Income: $${Math.round(income * 100) / 100}`);
      lines.push(`Remaining: $${(totalBudget - spending).toFixed(2)} (note: income is actual-to-date vs full-month budget)`);

      if (budgets.length > 0) {
        lines.push("");
        const budgetLines = budgets
          .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
          .map(b => {
            const cat = catByPlaid.get(b.category);
            const catName = cat?.name || b.category;
            const actual = spendingByCategory[b.category] || 0;
            const pct = b.monthlyAmount > 0 ? Math.round((actual / b.monthlyAmount) * 100) : 0;
            const status = pct > 100 ? "OVER" : pct > 80 ? "WARNING" : "OK";
            return `- ${catName}: budget $${b.monthlyAmount} vs actual $${actual.toFixed(2)} (${pct}%) [${status}]`;
          });
        lines.push(`Per-category:\n${budgetLines.join("\n")}`);
      }

      return { result: lines.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Budget error: ${msg}`, error: true };
    }
  },

  async get_income(): Promise<ToolHandlerResult> {
    try {
      const { db } = await import("./db");
      const { incomeSources, incomeDeductions, incomeDeposits } = await import("@shared/schema");

      const FREQ: Record<string, number> = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1, annually: 1 / 12 };

      const [sources, deductions, deposits] = await Promise.all([
        db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
        db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
        db.select().from(incomeDeposits).where(visibleFinanceForCurrentPrincipal(incomeDeposits)),
      ]);

      if (sources.length === 0) return { result: "No income sources configured yet. Add income sources in the Finance → Income tab." };

      const lines: string[] = [];
      let totalMonthlyGross = 0;
      let totalMonthlyNet = 0;

      for (const src of sources) {
        const mult = FREQ[src.payFrequency] || 1;
        const srcDeductions = deductions.filter(d => d.sourceId === src.id);
        const srcDeposits = deposits.filter(d => d.sourceId === src.id);
        const totalDed = srcDeductions.reduce((s, d) => s + d.amount, 0);
        const takeHome = src.grossPay - totalDed;
        const monthlyGross = src.grossPay * mult;
        const monthlyNet = takeHome * mult;

        const active = src.isActive ? "" : " (INACTIVE)";
        lines.push(`**${src.name}**${active}`);
        lines.push(`  Gross: $${src.grossPay.toFixed(2)}/${src.payFrequency} ($${monthlyGross.toFixed(2)}/mo)`);

        if (srcDeductions.length > 0) {
          const monthlyTotalDed = totalDed * mult;
          const dedLines = srcDeductions.map(d => {
            const monthlyDed = d.amount * mult;
            return `    - ${d.name} (${(d as any).category || ""}): $${monthlyDed.toFixed(2)}/mo ($${d.amount.toFixed(2)}/${src.payFrequency === "annually" ? "yr" : src.payFrequency === "monthly" ? "mo" : "paycheck"})`;
          });
          lines.push(`  Deductions: $${monthlyTotalDed.toFixed(2)}/mo\n${dedLines.join("\n")}`);
        }

        lines.push(`  Take-home: $${takeHome.toFixed(2)}/${src.payFrequency} ($${monthlyNet.toFixed(2)}/mo)`);

        if (srcDeposits.length > 0) {
          const depLines = srcDeposits.map(d => `    - ${(d as any).accountName || d.accountLabel || ""}: $${d.amount.toFixed(2)} (${(d as any).depositType || ""})`);
          lines.push(`  Deposits:\n${depLines.join("\n")}`);
        }

        lines.push("");

        if (src.isActive) {
          totalMonthlyGross += monthlyGross;
          totalMonthlyNet += monthlyNet;
        }
      }

      lines.push(`**Totals (active sources)**`);
      lines.push(`Monthly Gross: $${totalMonthlyGross.toFixed(2)}`);
      lines.push(`Monthly Net: $${totalMonthlyNet.toFixed(2)}`);

      return { result: lines.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Income error: ${msg}`, error: true };
    }
  },

  async get_recurring(): Promise<ToolHandlerResult> {
    try {
      const { getRecurringTransactions, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.` };
      }
      const txns = await getRecurringTransactions();
      if (txns.length === 0) return { result: "No recurring transactions identified yet." };
      const streamMap = new Map<string, { name: string; amount: number; count: number }>();
      for (const t of txns) {
        const key = t.recurringStreamId || t.name;
        const existing = streamMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          streamMap.set(key, { name: t.merchantName || t.name, amount: t.amount, count: 1 });
        }
      }
      const lines = Array.from(streamMap.values())
        .sort((a, b) => b.amount - a.amount)
        .map(s => `- ${s.name}: $${Math.abs(s.amount).toFixed(2)} (${s.count} occurrences)`);
      return { result: `${streamMap.size} recurring streams:\n${lines.join("\n")}` };
    } catch (err: any) {
      return { result: `Recurring error: ${err.message}`, error: true };
    }
  },

  async get_forecast(args: Record<string, unknown>): Promise<ToolHandlerResult> {
    try {
      const months = typeof args.months === "number" ? args.months : 12;
      const { fetchAndComputeForecast } = await import("./routes/finance");
      const forecast = await fetchAndComputeForecast({ months, pastMonths: 3 });

      const fmt = (n: number) => {
        if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
        return `$${n.toFixed(0)}`;
      };

      const lines: string[] = [];

      const current = forecast.months.find(m => m.isCurrent);
      if (current) {
        lines.push(`=== CURRENT MONTH (${current.month}) ===`);
        lines.push(`Income: Gross ${fmt(current.income.gross)}/mo, Net ${fmt(current.income.net)}/mo${current.income.actual !== null ? `, Actual ${fmt(current.income.actual)}` : ""}`);
        lines.push(`Taxes: ${fmt(current.taxes)}/mo | 401k/Retirement: ${fmt(current.retirement401k)}/mo`);

        const dedEntries = Object.entries(current.deductions);
        if (dedEntries.length > 0) {
          lines.push(`Deductions: ${dedEntries.map(([k, v]) => `${k}: ${fmt(v)}`).join(", ")}`);
        }

        const expEntries = Object.entries(current.expenses).sort((a, b) => b[1] - a[1]);
        if (expEntries.length > 0) {
          lines.push(`Expenses (${fmt(current.totalExpenses)} total):`);
          for (const [cat, amt] of expEntries) {
            lines.push(`  ${cat}: ${fmt(amt)}`);
          }
        }

        lines.push(`Investments: ${fmt(current.investments)}`);
        const invEntries = Object.entries(current.investmentBreakdown);
        if (invEntries.length > 0) {
          for (const [name, val] of invEntries) {
            lines.push(`  ${name}: ${fmt(val)}`);
          }
        }

        if (current.manual401kBalance > 0) {
          lines.push(`401k Accounts: ${fmt(current.manual401kBalance)}`);
          const k401Entries = Object.entries(current.manual401kBreakdown);
          for (const [name, val] of k401Entries) {
            lines.push(`  ${name}: ${fmt(val)}`);
          }
        }

        lines.push(`Assets: ${fmt(current.assets)} (Cash: ${fmt(current.cashBalance)}, Financed: ${fmt(current.financedAssetValue)}, Manual: ${fmt(current.manualAssetValue)})`);

        lines.push(`Liabilities: ${fmt(current.liabilities)} (Financed Loans: ${fmt(current.financedLoanBalance)})`);
        const liabEntries = Object.entries(current.liabilityBreakdown);
        if (liabEntries.length > 0) {
          for (const [name, bal] of liabEntries) {
            lines.push(`  ${name}: ${fmt(bal)}`);
          }
        }

        lines.push(`Debt Payments: ${fmt(current.totalDebtPayments)}/mo`);
        lines.push(`Net Cash Flow: ${fmt(current.netCashFlow)}/mo`);
        lines.push(`Net Worth: ${fmt(current.cumulativeNetWorth)}`);
        lines.push("");
      }

      const pastMonths = forecast.months.filter(m => m.isPast);
      if (pastMonths.length > 0) {
        lines.push(`=== PAST MONTHS (Actuals) ===`);
        for (const pm of pastMonths) {
          const actualIncome = pm.income.actual !== null ? fmt(pm.income.actual) : "N/A";
          const topExpenses = Object.entries(pm.expenses).sort((a, b) => b[1] - a[1]).slice(0, 5);
          const expStr = topExpenses.map(([c, a]) => `${c}: ${fmt(a)}`).join(", ");
          lines.push(`${pm.month}: Income ${actualIncome}, Expenses ${fmt(pm.totalExpenses)} [${expStr}], Cash Flow ${fmt(pm.netCashFlow)}, NW ${fmt(pm.cumulativeNetWorth)}`);
        }
        lines.push("");
      }

      const futureMonths = forecast.months.filter(m => !m.isPast && !m.isCurrent);
      if (futureMonths.length > 0) {
        lines.push(`=== PROJECTIONS (${forecast.growthRate}% annual growth) ===`);
        const milestoneIndices = new Set<number>();
        const targets = [2, 5, 11, 23, 35, 47, 59];
        for (const t of targets) {
          if (t < futureMonths.length) milestoneIndices.add(t);
        }
        if (futureMonths.length > 0) milestoneIndices.add(0);
        if (futureMonths.length > 1) milestoneIndices.add(futureMonths.length - 1);

        const showAll = futureMonths.length <= 12;

        for (let i = 0; i < futureMonths.length; i++) {
          if (!showAll && !milestoneIndices.has(i)) continue;
          const fm = futureMonths[i];
          const invBreak = Object.entries(fm.investmentBreakdown).map(([n, v]) => `${n}: ${fmt(v)}`).join(", ");
          const liabBreak = Object.entries(fm.liabilityBreakdown).map(([n, v]) => `${n}: ${fmt(v)}`).join(", ");
          const expBreak = Object.entries(fm.expenses).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, a]) => `${c}: ${fmt(a)}`).join(", ");

          const k401Break = Object.entries(fm.manual401kBreakdown).map(([n, v]) => `${n}: ${fmt(v)}`).join(", ");

          lines.push(`--- ${fm.month} ---`);
          lines.push(`Income: Net ${fmt(fm.income.net)} | Expenses: ${fmt(fm.totalExpenses)} [${expBreak}]`);
          lines.push(`Cash Flow: ${fmt(fm.netCashFlow)} | Cash: ${fmt(fm.cashBalance)}`);
          lines.push(`Investments: ${fmt(fm.investments)}${invBreak ? ` (${invBreak})` : ""}`);
          if (fm.manual401kBalance > 0) {
            lines.push(`401k: ${fmt(fm.manual401kBalance)}${k401Break ? ` (${k401Break})` : ""}`);
          }
          lines.push(`Liabilities: ${fmt(fm.liabilities)}${liabBreak ? ` (${liabBreak})` : ""}`);
          lines.push(`Net Worth: ${fmt(fm.cumulativeNetWorth)}`);
        }
      }

      return { result: lines.join("\n") };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Forecast error: ${msg}`, error: true };
    }
  },

  async link_account(): Promise<ToolHandlerResult> {
    try {
      const { createLinkToken, isPlaidConfigured, getPlaidConfigDiagnostics } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV in environment secrets first.` };
      }
      const { linkToken } = await createLinkToken();
      return { result: `Link token created. The user can connect their bank account through the Plaid Link flow in Settings → Connections. Link token: ${linkToken}` };
    } catch (err: any) {
      return { result: `Link account error: ${err.message}`, error: true };
    }
  },

  async refresh_data(): Promise<ToolHandlerResult> {
    try {
      const { refreshAllItems, isPlaidConfigured, getPlaidConfigDiagnostics, getPlaidItems } = await import("./plaid-service");
      if (!isPlaidConfigured()) {
        const diag = getPlaidConfigDiagnostics();
        const issues = [...diag.missing.map((v: string) => `${v} is not set`), ...diag.invalid.map((v: string) => `${v} is invalid (must be sandbox, development, or production)`)];
        return { result: `Plaid is not configured. ${issues.join("; ")}. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.` };
      }
      const items = await getPlaidItems();
      if (items.length === 0) return { result: "No financial accounts connected yet." };
      await refreshAllItems();
      return { result: `Refreshed financial data for ${items.length} connected institution(s). Latest transactions, holdings, and liabilities are now up to date.` };
    } catch (err: any) {
      return { result: `Refresh error: ${err.message}`, error: true };
    }
  },


  async meta(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    const allowed = new Set(["queue", "call", "results", "commands", "status", "preflight", "initialize", "listDevices", "requestCamera", "register", "connect", "capture"]);
    if (!action) return { result: "Missing 'action' parameter", error: true };
    if (!allowed.has(action)) {
      return { result: `Unknown meta action: ${action}. Allowed: queue, call, results, commands, status, preflight, initialize, listDevices, requestCamera, register, connect, capture`, error: true };
    }

    try {
      const bridge = await import("./routes/mobile-dat-debug");
      if (action === "results" || action === "commands") {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
        return { result: JSON.stringify(bridge.listMobileDATDebugState(limit), null, 2) };
      }

      const datAction = action === "queue" || action === "call" ? String(args.datAction || "") : action;
      const datAllowed = new Set(["status", "preflight", "initialize", "listDevices", "requestCamera", "register", "connect", "capture"]);
      if (!datAllowed.has(datAction)) return { result: `Missing or invalid datAction. Allowed DAT actions: ${[...datAllowed].join(", ")}`, error: true };

      const params = args.params && typeof args.params === "object" ? args.params : {};
      const note = typeof args.note === "string" ? args.note : null;
      const command = bridge.queueMobileDATDebugCommand({ action: datAction as any, params, note });
      const wait = action === "call" || args.wait === true || !["queue"].includes(action);
      if (!wait) return { result: JSON.stringify({ queued: true, command }, null, 2) };

      const timeoutMs = Math.min(120000, Math.max(1000, Number(args.timeoutMs) || 30000));
      const result = await bridge.waitForMobileDATDebugResult(command.id, timeoutMs);
      if (!result) {
        return {
          result: JSON.stringify({
            queued: true,
            timedOut: true,
            command,
            message: "Command queued but no iOS result arrived before timeout. Open the mobile debug overlay so it can poll and execute commands.",
          }, null, 2),
        };
      }
      return { result: JSON.stringify({ command, result }, null, 2), error: result.status === "error" || result.status === "crashed" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { result: `Meta tool failed: ${message}`, error: true };
    }
  },

  async meeting_bot(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    if (!["join", "status", "diagnostics", "leave", "recap"].includes(action)) {
      return { result: `Unknown meeting_bot action: ${action}. Allowed: join, status, diagnostics, leave, recap`, error: true };
    }

    if (action === "diagnostics") {
      const { getRecallDeliveryDiagnostics } = await import("./integrations/recall/delivery-diagnostics");
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      return { result: JSON.stringify({ deliveries: await getRecallDeliveryDiagnostics(limit) }, null, 2) };
    }

    const { chatStorage } = await import("./integrations/chat/storage");

    if (action === "status" || action === "leave" || action === "recap") {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return { result: "Missing sessionId", error: true };
      const session = await chatStorage.getSession(sessionId);
      if (!session || session.type !== "meeting" || !session.meeting) {
        return { result: `No meeting session found for id ${sessionId}`, error: true };
      }
      if (action === "status") {
        return {
          result: JSON.stringify({
            sessionId,
            title: session.meeting.title || session.title,
            botStatus: session.meeting.botStatus,
            statusDetail: session.meeting.statusDetail,
            participants: session.meeting.participants,
            startedAt: session.meeting.startedAt,
            endedAt: session.meeting.endedAt,
            recap: session.meeting.recap,
            link: `/session?c=${sessionId}`,
          }),
        };
      }
      if (action === "recap") {
        const { getCurrentPrincipal } = await import("./principal-context");
        const principal = getCurrentPrincipal();
        if (!principal || principal.actorType !== "user" || !principal.userId || !principal.accountId) {
          return { result: "A user principal is required to prepare recap drafts.", error: true };
        }
        const meeting = session.meeting;
        if (meeting.ownerUserId !== principal.userId || meeting.principalAccountId !== principal.accountId) {
          return { result: `No meeting session found for id ${sessionId}`, error: true };
        }

        let recap = meeting.recap;
        if (!recap || recap.status !== "ready") {
          const { finalizeMeetingSession } = await import("./meeting/recap");
          const finalization = await finalizeMeetingSession(sessionId);
          if (finalization.outcome === "failed") {
            return { result: `Meeting recap is not ready: ${finalization.recap.error ?? "recap generation failed"}`, error: true };
          }
          if (finalization.outcome === "already_generating") {
            return { result: "Meeting recap is still generating. Try again after it is ready.", error: true };
          }
          recap = finalization.recap;
        }

        if (!recap || recap.status !== "ready") {
          return { result: "Meeting recap is not ready yet.", error: true };
        }

        const { distributeRecap } = await import("./meeting/distribution");
        await distributeRecap(sessionId, meeting, recap, principal, { retryFailed: true });

        const { db } = await import("./db");
        const { meetingRecapDistributions } = await import("@shared/schema");
        const { combineWithVisibleScope } = await import("./scoped-storage");
        const { eq } = await import("drizzle-orm");
        const scopeColumns = {
          scope: meetingRecapDistributions.scope,
          ownerUserId: meetingRecapDistributions.ownerUserId,
          accountId: meetingRecapDistributions.accountId,
        };
        const distributions = await db
          .select({
            attendeeEmail: meetingRecapDistributions.attendeeEmail,
            attendeeName: meetingRecapDistributions.attendeeName,
            draftId: meetingRecapDistributions.draftId,
            status: meetingRecapDistributions.status,
            error: meetingRecapDistributions.error,
          })
          .from(meetingRecapDistributions)
          .where(
            combineWithVisibleScope(
              principal,
              scopeColumns,
              eq(meetingRecapDistributions.sessionId, sessionId),
            ),
          )
          .orderBy(meetingRecapDistributions.createdAt);

        const draftIds = distributions
          .map((row) => row.draftId)
          .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
        const updated = await chatStorage.getSession(sessionId);
        const refs = draftIds.map((id) => `@email_draft:${id}`).join(" ");
        const summary = draftIds.length > 0
          ? `Recap draft widget${draftIds.length === 1 ? "" : "s"} ready for review: ${refs}`
          : `No recap draft widgets were created for this meeting.`;
        return {
          result: JSON.stringify({
            sessionId,
            title: updated?.meeting?.title || updated?.title || meeting.title || session.title,
            recap: updated?.meeting?.recap ?? recap,
            distributions,
            draftIds,
            link: `/session?c=${sessionId}`,
            message: summary,
          }, null, 2) + (refs ? `

${refs}` : ""),
          data: { draftIds },
        };
      }
      // leave — delegate to the same owner-scoped lifecycle boundary as HTTP.
      const { getCurrentPrincipal } = await import("./principal-context");
      const principal = getCurrentPrincipal();
      if (!principal) {
        return { result: "A user principal is required to remove a meeting bot.", error: true };
      }
      const { requestMeetingBotLeave } = await import("./meeting/leave");
      const leave = await requestMeetingBotLeave(sessionId, principal);
      if (leave.outcome === "not_found") {
        return { result: `No meeting session found for id ${sessionId}`, error: true };
      }
      if (leave.outcome === "not_leaveable") {
        return { result: `The meeting bot is no longer active (${leave.session.meeting?.botStatus ?? "unknown"}).`, error: true };
      }
      if (leave.outcome === "failed") {
        return { result: `Failed to remove bot from call: ${leave.error}`, error: true };
      }
      return {
        result: JSON.stringify({
          sessionId,
          botStatus: leave.session.meeting?.botStatus,
          outcome: leave.outcome,
        }),
      };
    }

    // join — delegates to the canonical join path in server/meeting/join.ts
    const { joinMeetingByUrl, MeetingJoinError, MEETING_URL_RE } = await import("./meeting/join");
    const { meetingUrlForEvent } = await import("./meeting/identity");

    let meetingUrl = typeof args.url === "string" ? args.url.trim() : "";
    let resolvedTitle = typeof args.title === "string" && args.title.trim() ? args.title.trim() : "";
    let resolvedAgenda: string | undefined;
    let explicitEvent: import("./meeting/identity").ExplicitMeetingEventIdentity | undefined;

    if (meetingUrl && !MEETING_URL_RE.test(meetingUrl)) {
      return { result: `That doesn't look like a Zoom or Google Meet link: ${meetingUrl}`, error: true };
    }

    if (!meetingUrl) {
      // Resolve from the calendar: current or next event (±15 min back, 8h ahead) with a meeting link.
      try {
        const { listAllEvents } = await import("./google-calendar");
        const now = Date.now();
        const { events } = await listAllEvents({
          timeMin: new Date(now - 15 * 60000).toISOString(),
          timeMax: new Date(now + 8 * 3600000).toISOString(),
          maxResults: 25,
        });
        const sorted = (events || []).slice().sort((a, b) => {
          const ta = new Date(a.start?.dateTime || a.start?.date || 0).getTime();
          const tb = new Date(b.start?.dateTime || b.start?.date || 0).getTime();
          return ta - tb;
        });
        for (const ev of sorted) {
          const found = meetingUrlForEvent(ev);
          if (found) {
            meetingUrl = found;
            if (!resolvedTitle) resolvedTitle = ev.summary || "";
            const { getMetadata } = await import("./calendar-metadata");
            const metadata = await getMetadata(ev.id, ev.accountId, ev.calendarId);
            resolvedAgenda = metadata?.agenda?.trim() || undefined;
            explicitEvent = {
              accountId: ev.accountId,
              calendarId: ev.calendarId,
              providerEventId: ev.id,
              iCalUID: ev.iCalUID,
              recurringEventId: ev.recurringEventId,
              originalStartTime: ev.originalStartTime?.dateTime || ev.originalStartTime?.date,
              eventStart: ev.start.dateTime || ev.start.date || undefined,
              eventEnd: ev.end.dateTime || ev.end.date || undefined,
              title: ev.summary || undefined,
              agenda: resolvedAgenda,
              attendees: ev.attendees,
            };
            break;
          }
        }
      } catch (err) {
        return { result: `Calendar lookup failed while resolving the meeting link: ${err instanceof Error ? err.message : String(err)}`, error: true };
      }
      if (!meetingUrl) {
        return { result: "No meeting URL provided and no upcoming calendar event with a Zoom/Meet link was found. Paste the meeting link.", error: true };
      }
    }

    let joined;
    try {
      joined = await joinMeetingByUrl({
        meetingUrl,
        title: resolvedTitle || "Meeting",
        agenda: resolvedAgenda,
        explicitEvent,
      });
    } catch (err) {
      if (err instanceof MeetingJoinError) {
        return { result: err.message, error: true };
      }
      return { result: `Meeting join failed: ${err instanceof Error ? err.message : String(err)}`, error: true };
    }

    return {
      result: JSON.stringify({
        sessionId: joined.sessionId,
        botId: joined.botId,
        botStatus: "dialing",
        platform: joined.platform,
        title: joined.title,
        link: `/session?c=${joined.sessionId}`,
        note: "Bot 'Mantra Agent' is joining the call. If it lands in the waiting room, admit it from the participants panel. Live attributed transcript streams into the linked meeting session.",
      }),
    };
  },

  async expo(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) return { result: "Missing 'action' parameter", error: true };
    const allowed = new Set(["status", "projects", "builds", "build", "build_logs", "start_build", "cancel"]);
    if (!allowed.has(action)) {
      return { result: `Unknown expo action: ${action}. Allowed: status, projects, builds, build, build_logs, start_build, cancel`, error: true };
    }

    try {
      const expo = await import("./integrations/expo");
      const token = await expo.getExpoToken();
      if (!token) return { result: "Expo is not configured. Missing EXPO_ACCESS_TOKEN integration secret.", error: true };

      switch (action) {
        case "status": {
          const viewer = await expo.getViewer();
          return {
            result: JSON.stringify({
              connected: true,
              username: viewer.username,
              primaryAccount: viewer.primaryAccount,
              accounts: viewer.accounts,
            }),
          };
        }
        case "projects": {
          const projects = await expo.listProjects();
          return { result: JSON.stringify({ count: projects.length, projects }) };
        }
        case "builds": {
          const projectId = typeof args.projectId === "string" && args.projectId.trim()
            ? args.projectId.trim()
            : expo.getProjectConfig().projectId;
          if (!projectId) return { result: "Missing projectId and mobile Expo config has no Expo projectId.", error: true };
          const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
          const builds = await expo.listBuilds(projectId, limit);
          return { result: JSON.stringify({ projectId, count: builds.length, builds }) };
        }
        case "build": {
          const buildId = typeof args.buildId === "string" ? args.buildId.trim() : "";
          if (!buildId) return { result: "Missing buildId", error: true };
          const build = await expo.getBuild(buildId);
          return { result: JSON.stringify({ build }) };
        }
        case "start_build": {
          const expectedSourceRef = typeof args.expectedSourceRef === "string"
            ? args.expectedSourceRef.trim().toLowerCase()
            : "";
          if (!/^[a-f0-9]{40}$/.test(expectedSourceRef)) {
            return { result: "start_build requires expectedSourceRef as a full 40-character Git commit SHA.", error: true };
          }
          const run = await expo.easBuild("preview", "ios", "main", {
            cancelExisting: false,
            expectedSourceRef,
          });
          return {
            result: JSON.stringify({
              started: run.ok,
              runId: run.runId,
              sourceRef: run.sourceRef,
              profile: "preview",
              platform: "ios",
              providerCommandAccepted: run.ok,
              error: run.error,
              guidance: run.guidance,
            }),
            error: !run.ok,
          };
        }
        case "cancel": {
          const buildId = typeof args.buildId === "string" ? args.buildId.trim() : "";
          if (buildId) {
            const cancelled = await expo.cancelBuild(buildId);
            return { result: JSON.stringify({ cancelled: [cancelled] }) };
          }
          const projectId = typeof args.projectId === "string" && args.projectId.trim()
            ? args.projectId.trim()
            : expo.getProjectConfig().projectId;
          if (!projectId) return { result: "Missing buildId/projectId and mobile Expo config has no Expo projectId.", error: true };
          const platform = typeof args.platform === "string" && args.platform.trim() ? args.platform.trim() : undefined;
          const profile = typeof args.profile === "string" && args.profile.trim() ? args.profile.trim() : undefined;
          const cancelled = await expo.cancelInProgressBuilds({ projectId, platform, profile });
          return { result: JSON.stringify({ projectId, platform, profile, cancelled }) };
        }
        case "build_logs": {
          let buildId = typeof args.buildId === "string" ? args.buildId.trim() : "";
          if (!buildId) {
            const projectId = typeof args.projectId === "string" && args.projectId.trim()
              ? args.projectId.trim()
              : expo.getProjectConfig().projectId;
            if (!projectId) return { result: "Missing buildId/projectId and mobile Expo config has no Expo projectId.", error: true };
            const builds = await expo.listBuilds(projectId, 1);
            buildId = builds[0]?.id || "";
            if (!buildId) return { result: JSON.stringify({ projectId, buildId: null, excerpts: [] }) };
          }
          const report = await expo.getBuildLogReport(buildId);
          return {
            result: JSON.stringify({
              buildId,
              build: report.build,
              fetchedUrls: report.fetchedUrls,
              failedUrls: report.failedUrls,
              textBytes: report.textBytes,
              excerpts: report.excerpts,
            }),
          };
        }
      }
      return { result: `Unhandled expo action: ${action}`, error: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Expo ${action} failed: ${msg}`, error: true };
    }
  },

  async railway(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    const platformEnvironmentId = typeof args.platformEnvironmentId === "number"
      && Number.isInteger(args.platformEnvironmentId)
      && args.platformEnvironmentId > 0
      ? args.platformEnvironmentId
      : undefined;
    if (!action) return contractReject("Missing 'action' parameter", "railway_missing_action");

    const allowed = new Set(["status", "deployments", "logs", "build_logs", "list_variables", "redeploy", "restart"]);
    if (!allowed.has(action)) {
      return contractReject(
        `Unknown railway action: ${action}. Allowed: ${[...allowed].join(", ")}. Destructive actions are intentionally not exposed.`,
        "railway_action_not_allowed",
      );
    }

    const selfInspectionActions = new Set(["status", "logs", "build_logs"]);
    if (platformEnvironmentId === undefined && !selfInspectionActions.has(action)) {
      return contractReject(
        `platformEnvironmentId is required for Railway ${action}; omission is permitted only for current-runtime status, logs, and build_logs.`,
        "railway_missing_platform_environment",
      );
    }

    const {
      resolveRailwayEnvironmentControl,
      fetchEnvironmentDeployments,
      fetchEnvironmentRuntimeLogs,
      fetchEnvironmentBuildLogs,
      resolveEnvironmentDeploymentId,
      listEnvironmentVariableNames,
      redeployEnvironment,
      restartEnvironment,
      serializeEnvironmentDeployment,
    } = await import("./integrations/railway/environment-control");
    const { RailwayApiError } = await import("./integrations/railway/client");

    let environmentLabel = platformEnvironmentId ? `platformEnvironment:${platformEnvironmentId}` : "current-runtime";
    try {
      const control = await resolveRailwayEnvironmentControl(platformEnvironmentId, {
        allowCurrentRuntime: platformEnvironmentId === undefined && selfInspectionActions.has(action),
      });
      environmentLabel = `${control.environment.platformName} / ${control.environment.productName} / ${control.environment.platformEnvironmentName}`;
      const base = {
        platformEnvironmentId: control.environment.platformEnvironmentId,
        environment: environmentLabel,
        url: control.publicUrl,
      };

      switch (action) {
        case "status": {
          const deployments = await fetchEnvironmentDeployments(control, 1);
          return { result: JSON.stringify({ ...base, deployment: serializeEnvironmentDeployment(deployments[0] ?? null) }) };
        }
        case "deployments": {
          const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
          const deployments = await fetchEnvironmentDeployments(control, limit);
          return {
            result: JSON.stringify({
              ...base,
              count: deployments.length,
              deployments: deployments.map(serializeEnvironmentDeployment),
            }),
          };
        }
        case "logs": {
          const limit = Math.min(500, Math.max(1, Number(args.limit) || 200));
          const deploymentId = await resolveEnvironmentDeploymentId(
            control,
            typeof args.deploymentId === "string" ? args.deploymentId : undefined,
          );
          if (!deploymentId) return { result: JSON.stringify({ ...base, deploymentId: null, logs: [] }) };
          const logs = await fetchEnvironmentRuntimeLogs(control, deploymentId, limit);
          return { result: JSON.stringify({ ...base, deploymentId, count: logs.length, logs }) };
        }
        case "build_logs": {
          const limit = Math.min(500, Math.max(1, Number(args.limit) || 200));
          const deploymentId = await resolveEnvironmentDeploymentId(
            control,
            typeof args.deploymentId === "string" ? args.deploymentId : undefined,
            true,
          );
          if (!deploymentId) return { result: JSON.stringify({ ...base, deploymentId: null, logs: [] }) };
          const logs = await fetchEnvironmentBuildLogs(control, deploymentId, limit);
          return { result: JSON.stringify({ ...base, deploymentId, count: logs.length, logs }) };
        }
        case "list_variables": {
          const names = await listEnvironmentVariableNames(control);
          return { result: JSON.stringify({ ...base, count: names.length, names }) };
        }
        case "redeploy": {
          const deployment = await redeployEnvironment(
            control,
            typeof args.deploymentId === "string" ? args.deploymentId : undefined,
          );
          return { result: JSON.stringify({ ...base, ok: true, deploymentId: deployment.id, status: deployment.status }) };
        }
        case "restart": {
          const result = await restartEnvironment(
            control,
            typeof args.deploymentId === "string" ? args.deploymentId : undefined,
          );
          return { result: JSON.stringify({ ...base, ...result }) };
        }
      }
      return { result: `Unhandled railway action: ${action}`, error: true };
    } catch (err: unknown) {
      if (err instanceof RailwayApiError) {
        return { result: `Railway ${action} (${environmentLabel}) failed: ${err.message} (status=${err.status})`, error: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Railway ${action} (${environmentLabel}) failed: ${msg}`, error: true };
    }
  },

  async platforms(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) return { result: "Missing 'action' parameter", error: true };

    const allowed = new Set(["list_connections", "get_connection", "test_connection", "list_environments", "get_environment", "get_environment_status", "provision_database_roles", "get_build_lifecycle", "set_build_lifecycle", "disable_build_lifecycle", "delete_build_lifecycle", "get_build_status", "start_build_workflow", "list_environment_workflows", "create_platform", "update_platform", "list_products", "create_product", "update_product", "create_product_legacy", "update_product_legacy", "create_environment", "update_environment", "delete_environment", "save_source_binding", "save_hosting_binding", "create_connection", "get_cloudflare_pages_project", "deploy_cloudflare_pages", "cancel_cloudflare_pages_deployment", "poll_cloudflare_pages_deployment", "repair_cloudflare_pages_project", "list_features", "get_feature", "create_feature", "update_feature", "archive_feature", "delete_feature", "link_feature_kpi", "unlink_feature_kpi", "list_feature_sessions", "list_feature_history"]);
    if (!allowed.has(action)) {
      return { result: `Unknown platforms action: ${action}. Allowed: ${[...allowed].join(", ")}`, error: true };
    }

    try {
      const { db } = await import("./db");
      const { eq, and, inArray, sql: sqlTag, desc } = await import("drizzle-orm");
      const {
        providerConnections,
        environmentSourceBindings,
        environmentHostingBindings,
        environmentRuntimeVariables,
        platforms: platformsTable,
        productPlatformAssociations,
        products,
        platformProductEnvironments,
        insertProviderConnectionSchema,
        insertPlatformSchema,
        insertPlatformProductSchema,
        insertPlatformProductEnvironmentSchema,
      } = await import("@shared/models/platforms");
      const { requireCurrentPrincipal } = await import("./principal-context");
      const { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } = await import("./scoped-storage");
      const { storeProviderCredential, getProviderCredential, deleteProviderCredential } = await import("./provider-credential-store");
      const { getVisibleEnvironment, getWritableEnvironment, getVisibleProduct, getWritableProduct } = await import("./platforms/platform-access");

      const connScopeColumns = { scope: providerConnections.scope, ownerUserId: providerConnections.ownerUserId, accountId: providerConnections.accountId };
      const platScopeColumns = { scope: platformsTable.scope, ownerUserId: platformsTable.ownerUserId, accountId: platformsTable.accountId };

      const visibleConn = (pred?: SQL) => combineWithVisibleScope(requireCurrentPrincipal(), connScopeColumns, pred);
      const writableConn = (pred?: SQL) => combineWithWritableScope(requireCurrentPrincipal(), connScopeColumns, pred);
      const visiblePlat = (pred?: SQL) => combineWithVisibleScope(requireCurrentPrincipal(), platScopeColumns, pred);
      const writablePlat = (pred?: SQL) => combineWithWritableScope(requireCurrentPrincipal(), platScopeColumns, pred);
      const positiveId = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

      if (action === "provision_database_roles") {
        const environmentId = positiveId(args.id);
        if (!environmentId) return { result: "A valid Platform Environment id is required", error: true };
        const principal = requireCurrentPrincipal();
        const { provisionDatabaseRoles } = await import("./platform-role-provisioning");
        const result = await provisionDatabaseRoles({
          environmentId,
          idempotencyKey: typeof args.idempotencyKey === "string" ? args.idempotencyKey.trim() : "",
          confirmation: typeof args.confirmation === "string" ? args.confirmation : "",
          allowLive: args.allowLive === true,
          actorUserId: principal.userId ?? null,
        });
        return { result: JSON.stringify(result, null, 2) };
      }

      // ── list_connections ──
      if (action === "list_connections") {
        const rows = await db.select({
          id: providerConnections.id,
          provider: providerConnections.provider,
          label: providerConnections.label,
          accountType: providerConnections.accountType,
          status: providerConnections.status,
          lastVerifiedAt: providerConnections.lastVerifiedAt,
          createdAt: providerConnections.createdAt,
        }).from(providerConnections).where(visibleConn()).orderBy(providerConnections.updatedAt);
        return { result: JSON.stringify(rows, null, 2) };
      }

      // ── get_connection ──
      if (action === "get_connection") {
        const id = typeof args.id === "number" ? args.id : null;
        if (!id) return { result: "Missing 'id' parameter for get_connection", error: true };
        const [row] = await db.select({
          id: providerConnections.id,
          provider: providerConnections.provider,
          label: providerConnections.label,
          accountType: providerConnections.accountType,
          status: providerConnections.status,
          credentialRef: providerConnections.credentialRef,
          lastVerifiedAt: providerConnections.lastVerifiedAt,
          createdAt: providerConnections.createdAt,
          updatedAt: providerConnections.updatedAt,
        }).from(providerConnections).where(visibleConn(eq(providerConnections.id, id))).limit(1);
        if (!row) return { result: `Connection ${id} not found`, error: true };
        return { result: JSON.stringify({ ...row, hasCredential: !!row.credentialRef, credentialRef: undefined }, null, 2) };
      }

      // ── test_connection ──
      if (action === "test_connection") {
        const id = typeof args.id === "number" ? args.id : null;
        if (!id) return { result: "Missing 'id' parameter for test_connection", error: true };
        const [conn] = await db.select().from(providerConnections).where(visibleConn(eq(providerConnections.id, id))).limit(1);
        if (!conn) return { result: `Connection ${id} not found`, error: true };
        if (!conn.credentialRef) return { result: "No credential stored for this connection." };

        const token = await getProviderCredential(conn.credentialRef);
        if (!token) return { result: "Credential could not be decrypted or is missing." };

        const { testRailwayToken, testGitHubToken } = await import("./services/provider-connection-service");
        let testResult: { ok: boolean; message: string; projects?: Array<{ id: string; name: string }> };

        if (conn.provider === "railway") {
          testResult = await testRailwayToken(token);
        } else if (conn.provider === "github") {
          testResult = await testGitHubToken(token);
        } else {
          testResult = { ok: false, message: `No test implementation for provider: ${conn.provider}` };
        }

        if (testResult.ok) {
          await db.update(providerConnections).set({ lastVerifiedAt: sqlTag`CURRENT_TIMESTAMP`, status: "active", updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(providerConnections.id, id));
        }
        return { result: JSON.stringify(testResult, null, 2) };
      }

      // ── create_connection ──
      if (action === "create_connection") {
        const provider = typeof args.provider === "string" ? args.provider.trim() : "";
        const label = typeof args.label === "string" ? args.label.trim() : "";
        const credential = typeof args.credential === "string" ? args.credential.trim() : "";
        if (!provider || !label) return { result: "Missing 'provider' and/or 'label' for create_connection", error: true };

        const principal = requireCurrentPrincipal();
        const parsed = insertProviderConnectionSchema.parse({ provider, label });
        const [created] = await db.insert(providerConnections).values({ ...parsed, ...ownedInsertValues(principal, connScopeColumns) }).returning();

        if (credential) {
          const ref = await storeProviderCredential(created.id, credential, principal.userId ?? null);
          await db.update(providerConnections).set({ credentialRef: ref, updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(providerConnections.id, created.id));
        }

        return { result: JSON.stringify({ id: created.id, provider: created.provider, label: created.label, hasCredential: !!credential, status: created.status }, null, 2) };
      }


      // ── create_platform ──
      if (action === "create_platform") {
        const principal = requireCurrentPrincipal();
        const parsed = insertPlatformSchema.parse({
          name: typeof args.name === "string" ? args.name : "",
          description: typeof args.description === "string" ? args.description : "",
          status: typeof args.status === "string" ? args.status : undefined,
        });
        const [created] = await db.insert(platformsTable).values({ ...parsed, ...ownedInsertValues(principal, platScopeColumns) }).returning();
        return { result: JSON.stringify({ ...created, products: [] }, null, 2) };
      }

      // ── update_platform ──
      if (action === "update_platform") {
        const id = positiveId(args.id);
        if (!id) return { result: "Missing positive 'id' parameter for update_platform", error: true };
        const patch: Record<string, unknown> = { updatedAt: sqlTag`CURRENT_TIMESTAMP` };
        if (typeof args.name === "string") patch.name = args.name.trim();
        if (typeof args.description === "string") patch.description = args.description;
        if (typeof args.status === "string") patch.status = args.status;
        const parsed = insertPlatformSchema.partial().parse(patch);
        const [updated] = await db.update(platformsTable).set({ ...parsed, updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, id))).returning();
        if (!updated) return { result: `Platform ${id} not found or not writable`, error: true };
        return { result: JSON.stringify(updated, null, 2) };
      }

      if (["list_features", "get_feature", "create_feature", "update_feature", "archive_feature", "delete_feature", "link_feature_kpi", "unlink_feature_kpi", "list_feature_sessions", "list_feature_history"].includes(action)) {
        const { featureStorage } = await import("./feature-storage");
        if (action === "list_features") {
          return {
            result: JSON.stringify(await featureStorage.list({
              productId: positiveId(args.productId),
              search: typeof args.search === "string" ? args.search : undefined,
              includeArchived: args.includeArchived === true,
            }), null, 2),
          };
        }
        // create does not take a Feature id — must run before the featureId gate
        if (action === "create_feature") {
          return { result: JSON.stringify(await featureStorage.create(args), null, 2) };
        }
        const featureId = typeof args.featureId === "string" && args.featureId.trim()
          ? args.featureId.trim()
          : typeof args.id === "string" && args.id.trim()
            ? args.id.trim()
            : "";
        if (!featureId) return { result: "Feature id is required (featureId)", error: true };
        if (action === "get_feature") return { result: JSON.stringify(await featureStorage.get(featureId), null, 2) };
        if (action === "update_feature") return { result: JSON.stringify(await featureStorage.update(featureId, args), null, 2) };
        if (action === "archive_feature") return { result: JSON.stringify(await featureStorage.archive(featureId, args), null, 2) };
        if (action === "delete_feature") return { result: JSON.stringify({ success: await featureStorage.permanentlyDelete(featureId, args.confirm === true) }, null, 2) };
        if (action === "link_feature_kpi") return { result: JSON.stringify(await featureStorage.linkKpi(featureId, String(args.kpiAddress), String(args.idempotencyKey)), null, 2) };
        if (action === "list_feature_sessions") {
          const sessions = await featureStorage.listSessions(featureId);
          if (!sessions) return { result: "Feature not found", error: true };
          return { result: JSON.stringify(sessions, null, 2) };
        }
        if (action === "list_feature_history") {
          const history = await featureStorage.listHistory(featureId, {
            limit: typeof args.limit === "number" ? args.limit : undefined,
            toStage: typeof args.toStage === "string" ? args.toStage : undefined,
            toStatus: typeof args.toStatus === "string" ? args.toStatus : undefined,
            fromStage: typeof args.fromStage === "string" ? args.fromStage : undefined,
            fromStatus: typeof args.fromStatus === "string" ? args.fromStatus : undefined,
          });
          if (!history) return { result: "Feature not found", error: true };
          return { result: JSON.stringify(history, null, 2) };
        }
        return { result: JSON.stringify(await featureStorage.unlinkKpi(featureId, String(args.linkId)), null, 2) };
      }

      // ── list_products ──
      if (action === "list_products") {
        const { productStorage } = await import("./product-storage");
        return { result: JSON.stringify(await productStorage.list(), null, 2) };
      }

      // ── create_product ──
      if (action === "create_product") {
        const { productStorage } = await import("./product-storage");
        const platformIds = Array.isArray(args.platformIds)
          ? args.platformIds.filter((value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0)
          : (positiveId(args.id) ? [positiveId(args.id)!] : []);
        const created = await productStorage.create({
          name: typeof args.name === "string" ? args.name : "",
          description: typeof args.description === "string" ? args.description : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          vaultId: typeof args.vaultId === "string" ? args.vaultId : args.vaultId === null ? null : undefined,
          platformIds,
        });
        return { result: JSON.stringify(created, null, 2) };
      }

      // ── update_product ──
      if (action === "update_product") {
        const productId = positiveId(args.id);
        if (!productId) return { result: "Missing positive product 'id' parameter for update_product", error: true };
        const { productStorage } = await import("./product-storage");
        const updated = await productStorage.update(productId, {
          name: typeof args.name === "string" ? args.name : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          status: typeof args.status === "string" ? args.status : undefined,
          vaultId: typeof args.vaultId === "string" ? args.vaultId : args.vaultId === null ? null : undefined,
        });
        if (!updated) return { result: `Product ${productId} not found or not writable`, error: true };
        return { result: JSON.stringify(updated, null, 2) };
      }

      // ── create_product_legacy ──
      if (action === "create_product_legacy") {
        return { result: "create_product_legacy is frozen. Create Products with create_product.", error: true };
      }

      // ── update_product_legacy ──
      if (action === "update_product_legacy") {
        const productId = positiveId(args.id);
        if (!productId) return { result: "Missing positive product 'id' parameter for update_product_legacy", error: true };
        const productAccess = await getWritableProduct(productId);
        if (!productAccess) return { result: `Product ${productId} not found or not writable`, error: true };
        const prod = productAccess.product;
        const plat = productAccess.platform;
        const patch: Record<string, unknown> = { updatedAt: sqlTag`CURRENT_TIMESTAMP` };
        if (typeof args.name === "string") patch.name = args.name.trim();
        if (typeof args.description === "string") patch.description = args.description;
        if (typeof args.status === "string") patch.status = args.status;
        const parsed = insertPlatformProductSchema.partial().parse(patch);
        const [updated] = await db.update(products).set({ ...parsed, updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(products.id, productId)).returning();
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, plat.id)));
        return { result: JSON.stringify({ ...updated, platformId: plat.id }, null, 2) };
      }

      // ── create_environment ──
      if (action === "create_environment") {
        const productId = positiveId(args.id);
        if (!productId) return { result: "Missing positive product 'id' parameter for create_environment", error: true };
        const productAccess = await getWritableProduct(productId);
        if (!productAccess) return { result: `Product ${productId} not found or not writable`, error: true };
        const prod = productAccess.product;
        const plat = productAccess.platform;
        const parsed = insertPlatformProductEnvironmentSchema.parse({ name: typeof args.name === "string" ? args.name : "" });
        const [created] = await db.insert(platformProductEnvironments).values({ ...parsed, productId, platformId: plat.id }).returning();
        await db.update(products).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(products.id, productId));
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, plat.id)));
        return { result: JSON.stringify(created, null, 2) };
      }

      // ── update_environment ──
      if (action === "update_environment") {
        const envId = positiveId(args.id);
        if (!envId) return { result: "Missing positive environment 'id' parameter for update_environment", error: true };
        const environmentAccess = await getWritableEnvironment(envId);
        if (!environmentAccess) return { result: `Environment ${envId} not found or not writable`, error: true };
        const env = environmentAccess.environment;
        const prod = environmentAccess.product;
        const plat = environmentAccess.platform;
        const parsed = insertPlatformProductEnvironmentSchema.partial().parse({ name: typeof args.name === "string" ? args.name : undefined });
        const [updated] = await db.update(platformProductEnvironments).set({ ...parsed, updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(platformProductEnvironments.id, envId)).returning();
        await db.update(products).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(products.id, prod.id));
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, plat.id)));
        return { result: JSON.stringify(updated, null, 2) };
      }

      // ── list_environments ──
      if (action === "list_environments") {
        const plats = await db.select().from(platformsTable).where(visiblePlat()).orderBy(desc(platformsTable.updatedAt));
        const platformIds = plats.map(platform => platform.id);
        const associated = platformIds.length > 0
          ? await db.select({
              product: products,
              platformId: productPlatformAssociations.platformId,
            }).from(productPlatformAssociations)
              .innerJoin(products, eq(productPlatformAssociations.productId, products.id))
              .where(inArray(productPlatformAssociations.platformId, platformIds))
              .orderBy(products.name)
          : [];
        const prods = associated.map((row) => ({ ...row.product, platformId: row.platformId }));
        const productIds = prods.map(product => product.id);
        const envs = productIds.length > 0
          ? await db.select().from(platformProductEnvironments).where(inArray(platformProductEnvironments.productId, productIds)).orderBy(platformProductEnvironments.name)
          : [];
        const environmentIds = envs.map(environment => environment.id);

        // Batch-fetch bindings only for environments whose parent Platform is visible.
        let allSourceBindings: Array<{ environmentId: number; provider: string | null; owner: string | null; repo: string | null; branch: string | null; connectionId: number | null }> = [];
        let allHostingBindings: Array<{ environmentId: number; provider: string | null; projectName: string | null; providerEnvironmentName: string | null; serviceName: string | null; connectionId: number | null }> = [];
        try {
          if (environmentIds.length > 0) allSourceBindings = await db.select({
            environmentId: environmentSourceBindings.environmentId,
            provider: environmentSourceBindings.provider,
            owner: environmentSourceBindings.owner,
            repo: environmentSourceBindings.repo,
            branch: environmentSourceBindings.branch,
            connectionId: environmentSourceBindings.connectionId,
          }).from(environmentSourceBindings).where(inArray(environmentSourceBindings.environmentId, environmentIds));
        } catch (err) {
          toolExec.debug("Source bindings table query failed, using empty set", { error: err instanceof Error ? err.message : String(err) });
        }
        try {
          if (environmentIds.length > 0) allHostingBindings = await db.select({
            environmentId: environmentHostingBindings.environmentId,
            provider: environmentHostingBindings.provider,
            projectName: environmentHostingBindings.projectName,
            providerEnvironmentName: environmentHostingBindings.providerEnvironmentName,
            serviceName: environmentHostingBindings.serviceName,
            connectionId: environmentHostingBindings.connectionId,
          }).from(environmentHostingBindings).where(inArray(environmentHostingBindings.environmentId, environmentIds));
        } catch (err) {
          toolExec.debug("Hosting bindings table query failed, using empty set", { error: err instanceof Error ? err.message : String(err) });
        }

        // Index bindings by environmentId for O(1) lookup
        const sourceByEnvId = new Map(allSourceBindings.map(sb => [sb.environmentId, sb]));
        const hostingByEnvId = new Map(allHostingBindings.map(hb => [hb.environmentId, hb]));

        // Index products by platformId and environments by productId
        const prodsByPlatId = new Map<number, typeof prods>();
        for (const prod of prods) {
          const list = prodsByPlatId.get(prod.platformId) ?? [];
          list.push(prod);
          prodsByPlatId.set(prod.platformId, list);
        }
        const envsByProdId = new Map<number, typeof envs>();
        for (const env of envs) {
          const list = envsByProdId.get(env.productId) ?? [];
          list.push(env);
          envsByProdId.set(env.productId, list);
        }

        const result = plats.map(plat => ({
          id: plat.id,
          name: plat.name,
          status: plat.status,
          products: (prodsByPlatId.get(plat.id) ?? []).map(prod => ({
            id: prod.id,
            name: prod.name,
            status: prod.status,
            environments: (envsByProdId.get(prod.id) ?? []).map(env => {
              const sb = sourceByEnvId.get(env.id);
              const hb = hostingByEnvId.get(env.id);
              return {
                id: env.id,
                name: env.name,
                source: sb ? { provider: sb.provider, owner: sb.owner, repo: sb.repo, branch: sb.branch, connectionId: sb.connectionId, codeIndexingEnabled: sb.codeIndexingEnabled } : null,
                hosting: hb ? { provider: hb.provider, projectName: hb.projectName, providerEnvironmentName: hb.providerEnvironmentName, serviceName: hb.serviceName, connectionId: hb.connectionId } : null,
              };
            }),
          })),
        }));
        return { result: JSON.stringify(result, null, 2) };
      }

      // ── get_environment ──
      if (action === "get_environment") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' parameter for get_environment", error: true };

        const environmentAccess = await getVisibleEnvironment(envId);
        if (!environmentAccess) return { result: `Environment ${envId} not accessible`, error: true };
        const env = environmentAccess.environment;
        const prod = environmentAccess.product;
        const plat = environmentAccess.platform;

        let sourceBinding: Record<string, unknown> | null = null;
        let hostingBinding: Record<string, unknown> | null = null;
        let runtimeVars: Array<{ key: string; category: string | null; required: boolean | null; configured: boolean | null; source: string | null }> = [];
        try {
          const [sb] = await db.select().from(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, envId)).limit(1);
          sourceBinding = sb || null;
        } catch (err) {
          toolExec.debug("Source binding query failed", { error: err instanceof Error ? err.message : String(err) });
        }
        try {
          const [hb] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId)).limit(1);
          hostingBinding = hb || null;
        } catch (err) {
          toolExec.debug("Hosting binding query failed", { error: err instanceof Error ? err.message : String(err) });
        }
        try {
          runtimeVars = await db.select().from(environmentRuntimeVariables).where(eq(environmentRuntimeVariables.environmentId, envId));
        } catch (err) {
          toolExec.debug("Runtime variables query failed", { error: err instanceof Error ? err.message : String(err) });
        }

        return { result: JSON.stringify({
          environment: { id: env.id, name: env.name },
          product: prod ? { id: prod.id, name: prod.name } : null,
          platform: { id: plat.id, name: plat.name },
          sourceBinding: sourceBinding ? { provider: sourceBinding.provider, connectionId: sourceBinding.connectionId, owner: sourceBinding.owner, repo: sourceBinding.repo, branch: sourceBinding.branch, autoDeploy: sourceBinding.autoDeploy, codeIndexingEnabled: sourceBinding.codeIndexingEnabled } : null,
          hostingBinding: hostingBinding ? { provider: hostingBinding.provider, connectionId: hostingBinding.connectionId, projectId: hostingBinding.projectId, projectName: hostingBinding.projectName, providerEnvironmentId: hostingBinding.providerEnvironmentId, providerEnvironmentName: hostingBinding.providerEnvironmentName, serviceId: hostingBinding.serviceId, serviceName: hostingBinding.serviceName, publicUrl: hostingBinding.publicUrl } : null,
          runtimeVariables: runtimeVars.map(v => ({ key: v.key, category: v.category, required: v.required, configured: v.configured, source: v.source })),
        }, null, 2) };
      }

      // ── Cloudflare Pages provider controls ──
      if (["get_cloudflare_pages_project", "deploy_cloudflare_pages", "cancel_cloudflare_pages_deployment", "poll_cloudflare_pages_deployment", "repair_cloudflare_pages_project"].includes(action)) {
        const envId = positiveId(args.id);
        if (!envId) return { result: "Missing positive environment id", error: true };
        const principal = requireCurrentPrincipal();
        const { principalHasPermission } = await import("./permissions");
        if (!(await getVisibleEnvironment(envId))) return { result: `Environment ${envId} not accessible`, error: true };
        const permission = action === "get_cloudflare_pages_project" || action === "poll_cloudflare_pages_deployment" ? "build:read" : "build:write";
        if (!principalHasPermission(principal, permission)) return { result: `Permission required: ${permission}`, error: true };
        const [binding] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId)).limit(1);
        if (!binding || binding.provider !== "cloudflare" || !binding.connectionId || !binding.projectId || !binding.projectName) return { result: "Environment has no complete Cloudflare Pages hosting binding", error: true };
        const [connection] = await db.select().from(providerConnections).where(visibleConn(eq(providerConnections.id, binding.connectionId))).limit(1);
        if (!connection?.credentialRef) return { result: "Cloudflare provider connection has no credential", error: true };
        const token = await getProviderCredential(connection.credentialRef);
        if (!token) return { result: "Cloudflare provider credential could not be decrypted", error: true };
        const controls = await import("./platforms/cloudflare-pages-service");
        if (action === "get_cloudflare_pages_project") return { result: JSON.stringify(await controls.getCloudflarePagesProjectTruth(token, binding.projectId, binding.projectName)) };
        const deploymentId = typeof args.deploymentId === "string" && args.deploymentId.trim() ? args.deploymentId.trim() : null;
        if ((action === "cancel_cloudflare_pages_deployment" || action === "poll_cloudflare_pages_deployment") && !deploymentId) return { result: "deploymentId is required", error: true };
        let outcome;
        if (action === "cancel_cloudflare_pages_deployment") outcome = await controls.cancelCloudflarePagesDeployment(token, binding.projectId, binding.projectName, deploymentId!);
        else if (action === "poll_cloudflare_pages_deployment") outcome = await controls.pollCloudflarePagesDeployment(token, binding.projectId, binding.projectName, deploymentId!);
        else if (action === "repair_cloudflare_pages_project") outcome = await controls.repairCloudflarePagesProject(token, binding.projectId, binding.projectName, args.cloudflareRepair && typeof args.cloudflareRepair === "object" ? args.cloudflareRepair as controls.CloudflareProjectRepair : {});
        else outcome = deploymentId ? await controls.retryCloudflarePagesDeployment(token, binding.projectId, binding.projectName, deploymentId) : await controls.triggerCloudflarePagesProductionDeployment(token, binding.projectId, binding.projectName);
        return { result: JSON.stringify(outcome), error: outcome.outcome === "provider_error" || outcome.outcome === "rejected" };
      }

      // ── get_environment_status ──
      if (action === "get_environment_status") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' parameter for get_environment_status", error: true };

        const environmentAccess = await getVisibleEnvironment(envId);
        if (!environmentAccess) return { result: `Environment ${envId} not found`, error: true };

        let hostingBinding: Record<string, unknown> | null = null;
        try {
          const [hb] = await db.select().from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId)).limit(1);
          hostingBinding = hb || null;
        } catch (err) {
          toolExec.debug("Hosting binding query failed for status check", { error: err instanceof Error ? err.message : String(err) });
        }

        if (!hostingBinding || !hostingBinding.connectionId) {
          return { result: JSON.stringify({ status: "no_binding", message: "No hosting binding configured for this environment." }) };
        }

        // Get the token from the connection
        const [conn] = await db.select().from(providerConnections).where(visibleConn(eq(providerConnections.id, hostingBinding.connectionId))).limit(1);
        if (!conn?.credentialRef) {
          return { result: JSON.stringify({ status: "no_credential", message: "Hosting connection has no credential." }) };
        }
        const token = await getProviderCredential(conn.credentialRef);
        if (!token) {
          return { result: JSON.stringify({ status: "credential_error", message: "Could not decrypt hosting credential." }) };
        }

        // Dispatch based on hosting provider
        const hostingProvider = (hostingBinding.provider as string) || conn.provider || "railway";
        let deployment: Record<string, unknown> | null = null;

        if (hostingProvider === "cloudflare") {
          // Cloudflare Pages: projectId = account ID, projectName = Pages project name
          const { getCloudflareLatestDeployment } = await import("./services/provider-connection-service");
          if (hostingBinding.projectId && hostingBinding.projectName) {
            try {
              const cfEnv = (hostingBinding.providerEnvironmentId as string) || "production";
              const latest = await getCloudflareLatestDeployment(token, hostingBinding.projectId as string, hostingBinding.projectName as string, cfEnv);
              if (latest) {
                deployment = {
                  id: latest.id,
                  status: latest.status,
                  environment: latest.environment,
                  commitHash: latest.commitHash,
                  commitMessage: latest.commitMessage,
                  branch: latest.branch,
                  url: latest.url,
                  createdAt: latest.createdAt,
                };
              }
            } catch (err) {
              return { result: JSON.stringify({ status: "api_error", provider: "cloudflare", message: err instanceof Error ? err.message : String(err) }) };
            }
          }
        } else {
          // Railway (default)
          const { getLatestDeploymentByToken } = await import("./integrations/railway/client");
          if (hostingBinding.serviceId && hostingBinding.providerEnvironmentId && hostingBinding.projectId) {
            try {
              const latest = await getLatestDeploymentByToken(token, hostingBinding.projectId as string, hostingBinding.serviceId as string, hostingBinding.providerEnvironmentId as string);
              if (latest) {
                deployment = {
                  id: latest.id,
                  status: latest.status,
                  commitHash: latest.commitHash,
                  commitMessage: latest.commitMessage,
                  createdAt: latest.createdAt,
                };
              }
            } catch (err) {
              return { result: JSON.stringify({ status: "api_error", provider: "railway", message: err instanceof Error ? err.message : String(err) }) };
            }
          }
        }

        // URL reachability check
        let urlReachable: boolean | null = null;
        const checkUrl = hostingBinding.publicUrl as string | null;
        if (checkUrl) {
          try {
            const urlRes = await fetch(checkUrl.startsWith("http") ? checkUrl : `https://${checkUrl}`, { method: "HEAD", signal: AbortSignal.timeout(5000) });
            urlReachable = urlRes.ok;
          } catch (err) {
            toolExec.debug("URL reachability check failed", { url: checkUrl, error: err instanceof Error ? err.message : String(err) });
            urlReachable = false;
          }
        }

        return { result: JSON.stringify({
          environment: environmentAccess.environment.name,
          provider: hostingProvider,
          deployment,
          url: checkUrl || null,
          urlReachable,
        }, null, 2) };
      }


      // ── build lifecycle config/status/workflows ──
      if (["get_build_lifecycle", "set_build_lifecycle", "disable_build_lifecycle", "delete_build_lifecycle", "get_build_status", "start_build_workflow", "list_environment_workflows"].includes(action)) {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: `Missing 'id' (environment ID) for ${action}`, error: true };
        const lifecycle = await import("./platforms/build-lifecycle-service");
        if (action === "get_build_lifecycle") {
          const result = await lifecycle.getEnvironmentBuildLifecycleConfig(envId, { includeDisabled: args.includeDisabled === true });
          if (!result) return { result: `Environment ${envId} not found`, error: true };
          return { result: JSON.stringify(result, null, 2) };
        }
        if (action === "set_build_lifecycle") {
          const input = {
            workflowTemplateId: args.workflowTemplateId,
            providerKind: args.providerKind,
            deployPolicy: args.deployPolicy,
            acceptanceTarget: args.acceptanceTarget,
            authMode: args.authMode,
            retryPolicy: args.retryPolicy,
            gatePolicy: args.gatePolicy,
            evidenceConfig: args.evidenceConfig,
            docsConfig: args.docsConfig,
            enabled: args.enabled,
          };
          const result = await lifecycle.setEnvironmentBuildLifecycleConfig(envId, input);
          return { result: JSON.stringify({ saved: true, config: result }, null, 2) };
        }
        if (action === "disable_build_lifecycle") {
          const result = await lifecycle.disableEnvironmentBuildLifecycleConfig(envId);
          return { result: JSON.stringify({ disabled: true, config: result }, null, 2) };
        }
        if (action === "delete_build_lifecycle") {
          const result = await lifecycle.deleteEnvironmentBuildLifecycleConfigs(envId);
          return { result: JSON.stringify(result, null, 2) };
        }
        if (action === "get_build_status") {
          const result = await lifecycle.getEnvironmentBuildStatus(envId);
          if (!result) return { result: `Environment ${envId} not found`, error: true };
          return { result: JSON.stringify(result, null, 2) };
        }
        if (action === "start_build_workflow") {
          const sessionId = typeof args._sessionId === "string" ? args._sessionId.trim() : "";
          const result = await lifecycle.startEnvironmentBuildWorkflow(envId, {
            title: typeof args.title === "string" ? args.title : undefined,
            objective: typeof args.objective === "string" ? args.objective : undefined,
            start: typeof args.start === "boolean" ? args.start : undefined,
            ...(sessionId ? { parentSessionId: sessionId, createdBySessionId: sessionId } : {}),
          });
          return { result: `${JSON.stringify(result, null, 2)}\n\n@workflow:${result.run.id}` };
        }
        if (action === "list_environment_workflows") {
          const result = await lifecycle.listEnvironmentBuildWorkflows(envId, typeof args.limit === "number" ? args.limit : 20);
          if (!result) return { result: `Environment ${envId} not found`, error: true };
          return { result: JSON.stringify(result, null, 2) };
        }
      }

      // ── delete_environment ──
      if (action === "delete_environment") {
        const envId = positiveId(args.id);
        if (!envId) return { result: "Missing positive environment 'id' parameter for delete_environment", error: true };
        const environmentAccess = await getWritableEnvironment(envId);
        if (!environmentAccess) return { result: `Environment ${envId} not found or not writable`, error: true };
        const env = environmentAccess.environment;
        const prod = environmentAccess.product;
        await db.delete(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId));
        await db.delete(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, envId));
        const [deleted] = await db.delete(platformProductEnvironments).where(eq(platformProductEnvironments.id, envId)).returning();
        await db.update(products).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(eq(products.id, prod.id));
        await db.update(platformsTable).set({ updatedAt: sqlTag`CURRENT_TIMESTAMP` }).where(writablePlat(eq(platformsTable.id, environmentAccess.platform.id)));
        return { result: JSON.stringify({ deleted: true, environment: deleted }, null, 2) };
      }

      // ── save_source_binding ──
      if (action === "save_source_binding") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' (environment ID) for save_source_binding", error: true };

        const environmentAccess = await getWritableEnvironment(envId);
        if (!environmentAccess) return { result: `Environment ${envId} not found or not writable`, error: true };

        // Verify connectionId is visible to the current user before saving
        if (typeof args.connectionId === "number") {
          const [conn] = await db.select({ id: providerConnections.id }).from(providerConnections)
            .where(visibleConn(eq(providerConnections.id, args.connectionId))).limit(1);
          if (!conn) return { result: `Connection ${args.connectionId} not found or not visible`, error: true };
        }

        const values: Record<string, unknown> = { environmentId: envId, updatedAt: sqlTag`CURRENT_TIMESTAMP` };
        if (typeof args.connectionId === "number") values.connectionId = args.connectionId;
        if (typeof args.owner === "string") values.owner = args.owner;
        if (typeof args.repo === "string") values.repo = args.repo;
        if (typeof args.branch === "string") values.branch = args.branch;
        if (typeof args.autoDeploy === "boolean") values.autoDeploy = args.autoDeploy;
        if (typeof args.codeIndexingEnabled === "boolean") values.codeIndexingEnabled = args.codeIndexingEnabled;
        values.provider = "github";

        // Upsert
        const [existing] = await db.select({ id: environmentSourceBindings.id }).from(environmentSourceBindings).where(eq(environmentSourceBindings.environmentId, envId)).limit(1);
        let saved;
        if (existing) {
          [saved] = await db.update(environmentSourceBindings).set(values).where(eq(environmentSourceBindings.id, existing.id)).returning();
        } else {
          values.createdAt = sqlTag`CURRENT_TIMESTAMP`;
          [saved] = await db.insert(environmentSourceBindings).values(values).returning();
        }
        return { result: JSON.stringify({ saved: true, binding: { id: saved.id, environmentId: saved.environmentId, provider: saved.provider, owner: saved.owner, repo: saved.repo, branch: saved.branch, connectionId: saved.connectionId, codeIndexingEnabled: saved.codeIndexingEnabled } }, null, 2) };
      }

      // ── save_hosting_binding ──
      if (action === "save_hosting_binding") {
        const envId = typeof args.id === "number" ? args.id : null;
        if (!envId) return { result: "Missing 'id' (environment ID) for save_hosting_binding", error: true };

        const environmentAccess = await getWritableEnvironment(envId);
        if (!environmentAccess) return { result: `Environment ${envId} not found or not writable`, error: true };

        // Verify connectionId is visible to the current user before saving
        if (typeof args.connectionId === "number") {
          const [conn] = await db.select({ id: providerConnections.id }).from(providerConnections)
            .where(visibleConn(eq(providerConnections.id, args.connectionId))).limit(1);
          if (!conn) return { result: `Connection ${args.connectionId} not found or not visible`, error: true };
        }

        const values: Record<string, unknown> = { environmentId: envId, updatedAt: sqlTag`CURRENT_TIMESTAMP` };
        if (typeof args.connectionId === "number") values.connectionId = args.connectionId;
        if (typeof args.projectId === "string") values.projectId = args.projectId;
        if (typeof args.projectName === "string") values.projectName = args.projectName;
        if (typeof args.providerEnvironmentId === "string") values.providerEnvironmentId = args.providerEnvironmentId;
        if (typeof args.providerEnvironmentName === "string") values.providerEnvironmentName = args.providerEnvironmentName;
        if (typeof args.serviceId === "string") values.serviceId = args.serviceId;
        if (typeof args.serviceName === "string") values.serviceName = args.serviceName;
        if (typeof args.publicUrl === "string") values.publicUrl = args.publicUrl;
        values.provider = "railway";

        // Upsert
        const [existing] = await db.select({ id: environmentHostingBindings.id }).from(environmentHostingBindings).where(eq(environmentHostingBindings.environmentId, envId)).limit(1);
        let saved;
        if (existing) {
          [saved] = await db.update(environmentHostingBindings).set(values).where(eq(environmentHostingBindings.id, existing.id)).returning();
        } else {
          values.createdAt = sqlTag`CURRENT_TIMESTAMP`;
          [saved] = await db.insert(environmentHostingBindings).values(values).returning();
        }
        return { result: JSON.stringify({ saved: true, binding: { id: saved.id, environmentId: saved.environmentId, provider: saved.provider, projectId: saved.projectId, projectName: saved.projectName, providerEnvironmentId: saved.providerEnvironmentId, serviceName: saved.serviceName, connectionId: saved.connectionId } }, null, 2) };
      }

      return { result: `Unhandled platforms action: ${action}`, error: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Platforms ${action} failed: ${msg}`, error: true };
    }
  },


  async sentry(args: Record<string, any>): Promise<ToolHandlerResult> {
    // Compatibility alias: models sometimes emit list for the issues inventory.
    const rawAction = typeof args.action === "string" ? args.action.trim() : "";
    const action = rawAction === "list" ? "issues" : rawAction;
    if (!action) {
      return contractReject("Missing 'action' parameter", "system_input_invalid", "sentry_missing_action");
    }
    const allowed = new Set([
      "status",
      "issues",
      "issue",
      "events",
      "latest_event",
      "uptime",
      "sync_availability",
      "resolve",
      "unresolve",
      "ignore",
    ]);
    if (!allowed.has(action)) {
      // Caller-correctable action miss — amber input, never Executor TOOL_FAILED_SENTRY.
      return contractReject(
        `Unknown sentry action: ${rawAction}. Allowed: ${[...allowed].join(", ")}.`,
        "system_input_invalid",
        "sentry_unknown_action",
      );
    }

    const requireIssueId = (): string | ToolHandlerResult => {
      const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
      if (!issueId) {
        return contractReject(
          "Missing 'issueId' parameter",
          "system_input_invalid",
          "sentry_missing_issue_id",
        );
      }
      return issueId;
    };

    const {
      getSentryConfig,
      isSentryConfigured,
      fetchIssues,
      fetchIssue,
      fetchIssueEvents,
      fetchLatestEvent,
      updateIssueStatus,
      SentryApiError,
    } = await import("./integrations/sentry/client");

    const cfg = await getSentryConfig();
    if (!isSentryConfigured(cfg)) {
      const missing: string[] = [];
      if (!cfg.dsn) missing.push("SENTRY_DSN");
      if (!cfg.hasToken) missing.push("SENTRY_AUTH_TOKEN");
      if (!cfg.org) missing.push("SENTRY_ORG");
      if (!cfg.project) missing.push("SENTRY_PROJECT");
      if (action === "status") {
        return {
          result: JSON.stringify({ configured: false, status: "not_configured", missing }),
        };
      }
      const detail = missing.join(", ");
      return {
        result: `Sentry not configured. Missing: ${detail}. Add them via the Integrations page.`,
        error: true,
        // Optional telemetry readiness gap — surface and continue; do not terminalize the run.
        failure: inputFailure("integration_not_configured", detail),
      };
    }

    const org = cfg.org;
    const project = cfg.project;

    try {
      switch (action) {
        case "status": {
          return {
            result: JSON.stringify({
              configured: true,
              org,
              project,
              url: `https://sentry.io/organizations/${org}/issues/?project=&query=is%3Aunresolved`,
            }),
          };
        }
        case "uptime": {
          const { getSentryAvailabilityStatus } = await import("./sentry-availability");
          return { result: JSON.stringify(await getSentryAvailabilityStatus()) };
        }
        case "sync_availability": {
          const { syncSentryAvailability } = await import("./sentry-availability");
          return { result: JSON.stringify(await syncSentryAvailability()) };
        }
        case "issues": {
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
          const query = typeof args.query === "string" ? args.query : "is:unresolved";
          const sort = typeof args.sort === "string" ? args.sort : "date";
          const issues = await fetchIssues(org, project, { query, sort, limit });
          const items = issues.map((i) => ({
            id: i.id,
            shortId: i.shortId,
            title: i.title,
            culprit: i.culprit,
            level: i.level,
            status: i.status,
            count: i.count,
            userCount: i.userCount,
            firstSeen: i.firstSeen,
            lastSeen: i.lastSeen,
            platform: i.platform,
            permalink: i.permalink,
          }));
          return { result: JSON.stringify({ count: items.length, issues: items }) };
        }
        case "issue": {
          const issueIdOrReject = requireIssueId();
          if (typeof issueIdOrReject !== "string") return issueIdOrReject;
          const issue = await fetchIssue(org, issueIdOrReject);
          return { result: JSON.stringify(issue) };
        }
        case "events": {
          const issueIdOrReject = requireIssueId();
          if (typeof issueIdOrReject !== "string") return issueIdOrReject;
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 10));
          const full = args.full !== false;
          const events = await fetchIssueEvents(org, issueIdOrReject, { full, limit });
          return { result: JSON.stringify({ issueId: issueIdOrReject, count: events.length, events }) };
        }
        case "latest_event": {
          const issueIdOrReject = requireIssueId();
          if (typeof issueIdOrReject !== "string") return issueIdOrReject;
          const event = await fetchLatestEvent(org, issueIdOrReject);
          return { result: JSON.stringify(event) };
        }
        case "resolve": {
          const issueIdOrReject = requireIssueId();
          if (typeof issueIdOrReject !== "string") return issueIdOrReject;
          const updated = await updateIssueStatus(org, issueIdOrReject, "resolved");
          return { result: JSON.stringify({ ok: true, id: updated.id, status: updated.status }) };
        }
        case "unresolve": {
          const issueIdOrReject = requireIssueId();
          if (typeof issueIdOrReject !== "string") return issueIdOrReject;
          const updated = await updateIssueStatus(org, issueIdOrReject, "unresolved");
          return { result: JSON.stringify({ ok: true, id: updated.id, status: updated.status }) };
        }
        case "ignore": {
          const issueIdOrReject = requireIssueId();
          if (typeof issueIdOrReject !== "string") return issueIdOrReject;
          const updated = await updateIssueStatus(org, issueIdOrReject, "ignored");
          return { result: JSON.stringify({ ok: true, id: updated.id, status: updated.status }) };
        }
      }
      return contractReject(
        `Unhandled sentry action: ${action}`,
        "system_input_invalid",
        "sentry_unhandled_action",
      );
    } catch (err: unknown) {
      if (err instanceof SentryApiError) {
        const failure = toolFailureFromError(err);
        // Invalid search queries are caller input — keep the message actionable
        // and omit raw provider body noise when we already classified it.
        const detailSuffix =
          failure?.code === "system_input_invalid"
            ? ""
            : err.details
              ? ` — ${JSON.stringify(err.details)}`
              : "";
        return {
          result: `Sentry ${action} failed: ${err.message} (status=${err.status})${detailSuffix}`,
          error: true,
          ...(failure ? { failure } : {}),
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Sentry ${action} failed: ${msg}`, error: true };
    }
  },
  async jobs(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = String(args.action || "");
    try {
      const { jobRoleStorage } = await import("./job-role-storage");
      const { jobRoleCreateSchema, jobRoleUpdateSchema } = await import("@shared/models/job-roles");
      switch (action) {
        case "list":
          return { result: JSON.stringify({ roles: await jobRoleStorage.list({ query: args.query, limit: args.limit }) }, null, 2) };
        case "get":
          if (!args.id) return { result: "Missing 'id' parameter", error: true };
          return { result: JSON.stringify(await jobRoleStorage.get(String(args.id)), null, 2) };
        case "create": {
          const input = jobRoleCreateSchema.parse({
            title: args.title,
            description: args.description ?? "",
            team: args.team ?? "Engineering",
            annualSalaryMin: args.annualSalaryMin ?? 0,
            annualSalaryMax: args.annualSalaryMax ?? 0,
            targetBonusPercent: args.targetBonusPercent ?? 0,
            equityShareCount: args.equityShareCount ?? 0,
            scorecardPageId: args.scorecardPageId,
          });
          const role = await jobRoleStorage.create(input);
          return { result: JSON.stringify(role, null, 2) };
        }
        case "update": {
          if (!args.id) return { result: "Missing 'id' parameter", error: true };
          const patch = jobRoleUpdateSchema.parse(Object.fromEntries(
            ["title", "description", "team", "annualSalaryMin", "annualSalaryMax", "targetBonusPercent", "equityShareCount", "scorecardPageId", "clearFields"]
              .filter((key) => args[key] !== undefined)
              .map((key) => [key, args[key]]),
          ));
          const role = await jobRoleStorage.update(String(args.id), patch);
          return { result: JSON.stringify(role, null, 2) };
        }
        case "delete": {
          if (!args.id) return { result: "Missing 'id' parameter", error: true };
          const role = await jobRoleStorage.delete(String(args.id));
          return { result: JSON.stringify({ deleted: true, role }, null, 2) };
        }
        default:
          return { result: `Unknown jobs action: ${action}. Available: list, get, create, update, delete`, error: true };
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const message = code === "23505" ? "A role with this title already exists" : error instanceof Error ? error.message : String(error);
      return { result: `Jobs ${action || "operation"} failed: ${message}`, error: true };
    }
  },

  async tasks(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      create: (a) => bridgeHandlers.create_task(a),
      complete: (a) => bridgeHandlers.complete_task(a),
      delete: (a) => bridgeHandlers.delete_task(a),
      update: (a) => bridgeHandlers.update_task(a),
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown tasks action: ${action}. Available: create, complete, delete, update`, error: true };
    return handler(args);
  },

  async finance(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      summary: (a) => bridgeHandlers.get_finance_summary(a),
      accounts: (a) => bridgeHandlers.get_accounts(a),
      transactions: (a) => bridgeHandlers.get_transactions(a),
      holdings: (a) => bridgeHandlers.get_holdings(a),
      liabilities: (a) => bridgeHandlers.get_liabilities(a),
      debt_payments: (a) => bridgeHandlers.get_debt_payments(a),
      categories: (a) => bridgeHandlers.get_categories(a),
      budget: (a) => bridgeHandlers.get_budget(a),
      income: (a) => bridgeHandlers.get_income(a),
      recurring: (a) => bridgeHandlers.get_recurring(a),
      forecast: (a) => bridgeHandlers.get_forecast(a),
      assets: async () => {
        try {
          const { db } = await import("./db");
          const { financedAssets, manualAssets, manual401kAccounts, incomeDeductions, incomeSources } = await import("@shared/schema");

          const [financedRows, manualRows, k401Rows, deductionRows, sourceRows] = await Promise.all([
            db.select().from(financedAssets).where(visibleFinanceForCurrentPrincipal(financedAssets)),
            db.select().from(manualAssets).where(visibleFinanceForCurrentPrincipal(manualAssets)),
            db.select().from(manual401kAccounts).where(visibleFinanceForCurrentPrincipal(manual401kAccounts)),
            db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
            db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
          ]);

          if (financedRows.length === 0 && manualRows.length === 0 && k401Rows.length === 0) {
            return { result: "No assets tracked yet." };
          }

          const parts: string[] = [];
          let combinedTotal = 0;

          if (financedRows.length > 0) {
            const totalValue = financedRows.reduce((s, r) => s + (r.currentValue || 0), 0);
            const totalLoans = financedRows.reduce((s, r) => s + (r.loanBalance || 0), 0);
            const totalEquity = totalValue - totalLoans;
            combinedTotal += totalEquity;
            const lines = financedRows.map(r => {
              const equity = (r.currentValue || 0) - (r.loanBalance || 0);
              return `- **${r.name}** (${r.category}): value $${(r.currentValue || 0).toLocaleString()}, loan balance $${(r.loanBalance || 0).toLocaleString()}, equity $${equity.toLocaleString()}${r.monthlyPayment ? `, payment $${r.monthlyPayment}/mo` : ""}${r.loanApr ? `, ${r.loanApr}% APR` : ""}`;
            });
            parts.push(`**Financed Assets (${financedRows.length})**\nValue: $${totalValue.toLocaleString()} | Loans: $${totalLoans.toLocaleString()} | Equity: $${totalEquity.toLocaleString()}\n${lines.join("\n")}`);
          }

          if (manualRows.length > 0) {
            const manualTotal = manualRows.reduce((s, r) => s + r.currentValue, 0);
            combinedTotal += manualTotal;
            const lines = manualRows.map(r => `- **${r.name}** [${r.category}]: $${r.currentValue.toLocaleString()}`);
            parts.push(`**Manual Assets (${manualRows.length})**\nTotal: $${manualTotal.toLocaleString()}\n${lines.join("\n")}`);
          }

          if (k401Rows.length > 0) {
            const FREQ_MULT: Record<string, number> = { weekly: 52/12, biweekly: 26/12, semimonthly: 2, monthly: 1, quarterly: 1/3, annually: 1/12 };
            const deductionMap = new Map(deductionRows.map(d => [d.id, d]));
            const sourceMap = new Map(sourceRows.map(s => [s.id, s]));
            const k401Total = k401Rows.reduce((s, a) => s + a.currentBalance, 0);
            combinedTotal += k401Total;
            const lines = k401Rows.map(a => {
              const ded = a.linkedDeductionId ? deductionMap.get(a.linkedDeductionId) : null;
              const source = ded ? sourceMap.get(ded.sourceId) : null;
              const mult = source ? (FREQ_MULT[source.payFrequency] || 1) : 1;
              const monthly = ded ? ded.amount * mult : 0;
              return `- **${a.name}**: balance $${a.currentBalance.toLocaleString()}${monthly > 0 ? `, contribution $${monthly.toFixed(0)}/mo` : ""}`;
            });
            parts.push(`**401k Accounts (${k401Rows.length})**\nTotal: $${k401Total.toLocaleString()}\n${lines.join("\n")}`);
          }

          parts.push(`\n**Combined Asset Total: $${combinedTotal.toLocaleString()}**`);
          return { result: parts.join("\n\n") };
        } catch (e: any) { return { result: `Error fetching assets: ${e.message}`, error: true }; }
      },
      goals: async (a) => {
        try {
          const { db } = await import("./db");
          const { financialGoals, plaidAccounts, insertFinancialGoalSchema } = await import("@shared/schema");
          const { eq } = await import("drizzle-orm");
          const goalAction = a.goal_action || "list";

          if (goalAction === "list") {
            const goals = await db.select().from(financialGoals).where(visibleFinanceForCurrentPrincipal(financialGoals));
            if (goals.length === 0) return { result: "No financial goals set yet. Create one with goal_action: 'create'." };
            const accounts = await db.select().from(plaidAccounts).where(visibleFinanceForCurrentPrincipal(plaidAccounts));
            const accountMap = new Map(accounts.map(a => [a.accountId, a]));
            const lines = goals.map(g => {
              let computedAmount = g.currentAmount || 0;
              const linkedNames: string[] = [];
              if (g.linkedAccountIds && g.linkedAccountIds.length > 0) {
                computedAmount = 0;
                for (const aid of g.linkedAccountIds) {
                  const acct = accountMap.get(aid);
                  if (acct) {
                    computedAmount += acct.currentBalance || 0;
                    linkedNames.push(acct.officialName || acct.name || aid);
                  }
                }
              }
              const pct = g.targetAmount > 0 ? Math.min(100, Math.round((computedAmount / g.targetAmount) * 100)) : 0;
              let line = `- **${g.name}** [id:${g.id}] (${g.category}): $${computedAmount.toLocaleString()} / $${g.targetAmount.toLocaleString()} (${pct}%)`;
              if (g.targetDate) line += ` — target: ${g.targetDate}`;
              if (linkedNames.length > 0) line += ` — linked: ${linkedNames.join(", ")}`;
              if (g.notes) line += `\n  Notes: ${g.notes}`;
              return line;
            });
            return { result: `Financial Goals (${goals.length}):\n${lines.join("\n")}` };
          }

          if (goalAction === "create") {
            if (!a.name || !a.targetAmount || !a.category) {
              return { result: "Required: name, targetAmount, category. Optional: currentAmount, targetDate, notes, linkedAccountIds (array of Plaid account IDs).", error: true };
            }
            const parsed = insertFinancialGoalSchema.parse({
              name: a.name,
              targetAmount: Number(a.targetAmount),
              currentAmount: Number(a.currentAmount || 0),
              category: a.category,
              targetDate: a.targetDate || null,
              notes: a.notes || null,
              linkedAccountIds: a.linkedAccountIds || null,
            });
            if ((parsed.category?.toLowerCase().includes("emergency") || parsed.category?.toLowerCase().includes("savings")) &&
                (!parsed.linkedAccountIds || parsed.linkedAccountIds.length === 0)) {
              const depositoryAccounts = await db.select({ accountId: plaidAccounts.accountId })
                .from(plaidAccounts).where(eq(plaidAccounts.type, "depository"));
              if (depositoryAccounts.length > 0) {
                parsed.linkedAccountIds = depositoryAccounts.map(a => a.accountId);
              }
            }
            const [goal] = await db.insert(financialGoals).values(parsed).returning();
            return { result: `Created financial goal: "${goal.name}" (id:${goal.id}) — $${goal.targetAmount.toLocaleString()} target in ${goal.category}.` };
          }

          if (goalAction === "update") {
            if (!a.id) return { result: "Required: id. Provide fields to update: name, targetAmount, currentAmount, category, targetDate, notes, linkedAccountIds.", error: true };
            const id = Number(a.id);
            const updates: Record<string, any> = { updatedAt: new Date() };
            if (a.name !== undefined) updates.name = a.name;
            if (a.targetAmount !== undefined) updates.targetAmount = Number(a.targetAmount);
            if (a.currentAmount !== undefined) updates.currentAmount = Number(a.currentAmount);
            if (a.category !== undefined) updates.category = a.category;
            if (a.targetDate !== undefined) updates.targetDate = a.targetDate;
            if (a.notes !== undefined) updates.notes = a.notes;
            if (a.linkedAccountIds !== undefined) updates.linkedAccountIds = a.linkedAccountIds;
            const [updated] = await db.update(financialGoals).set(updates).where(eq(financialGoals.id, id)).returning();
            if (!updated) return { result: `Goal id:${id} not found.`, error: true };
            return { result: `Updated goal "${updated.name}" (id:${updated.id}): target $${updated.targetAmount.toLocaleString()}, current $${(updated.currentAmount || 0).toLocaleString()}.` };
          }

          if (goalAction === "delete") {
            if (!a.id) return { result: "Required: id of the goal to delete.", error: true };
            const id = Number(a.id);
            const [deleted] = await db.delete(financialGoals).where(eq(financialGoals.id, id)).returning();
            if (!deleted) return { result: `Goal id:${id} not found.`, error: true };
            return { result: `Deleted goal "${deleted.name}" (id:${deleted.id}).` };
          }

          return { result: `Unknown goal_action: ${goalAction}. Available: list, create, update, delete.`, error: true };
        } catch (e: any) { return { result: `Error managing financial goals: ${e.message}`, error: true }; }
      },
      import_transactions: async () => {
        return { result: "CSV import is available through the Finance > Transactions tab. Click 'Import CSV' to upload a bank CSV file. The system will auto-detect columns, map merchant names to Plaid categories using existing transaction data and keyword matching, deduplicate against existing transactions, and import them. Supported formats: most bank CSV exports with date, description, and amount columns (or separate debit/credit columns).", error: false };
      },
      link_account: (a) => bridgeHandlers.link_account(a),
      refresh: (a) => bridgeHandlers.refresh_data(a),
      amortize: (a) => bridgeHandlers.amortize(a),
      list_amortizations: (a) => bridgeHandlers.list_amortizations(a),
      remove_amortization: (a) => bridgeHandlers.remove_amortization(a),
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown finance action: ${action}. Available: summary, accounts, transactions, holdings, liabilities, debt_payments, categories, budget, income, recurring, forecast, assets, goals, import_transactions, link_account, refresh, amortize, list_amortizations, remove_amortization`, error: true };
    return handler(args);
  },

  async meetings(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      create_calendar_block: (a) => bridgeHandlers.create_calendar_block(a),
      join: (a) => bridgeHandlers.meeting_bot(a),
      status: (a) => bridgeHandlers.meeting_bot(a),
      diagnostics: (a) => bridgeHandlers.meeting_bot(a),
      recap: (a) => bridgeHandlers.meeting_bot(a),
      leave: (a) => bridgeHandlers.meeting_bot(a),
      add: (a) => bridgeHandlers.add_meeting(a),
      list: (a) => bridgeHandlers.list_meetings(a),
      update: (a) => bridgeHandlers.update_meeting(a),
      delete: (a) => bridgeHandlers.delete_meeting(a),
      set_metadata: (a) => bridgeHandlers.set_metadata_meeting(a),
      get_metadata: (a) => bridgeHandlers.get_metadata_meeting(a),
      link_artifact: (a) => bridgeHandlers.link_artifact_meeting(a),
      unlink_artifact: (a) => bridgeHandlers.unlink_artifact_meeting(a),
      records: async (a) => {
        const { listCompletedMeetings } = await import("./meetings/meeting-index");
        const notesFilter = a.notesFilter === "with_notes" || a.notesFilter === "without_notes" || a.notesFilter === "any"
          ? a.notesFilter
          : a.hasNotes === true
            ? "with_notes"
            : "any";
        const result = await listCompletedMeetings({
          query: typeof a.query === "string" ? a.query : undefined,
          notesFilter,
          startAfter: typeof a.startAfter === "string" ? a.startAfter : undefined,
          startBefore: typeof a.startBefore === "string" ? a.startBefore : undefined,
          limit: typeof a.limit === "number" ? a.limit : undefined,
          offset: typeof a.offset === "number" ? a.offset : undefined,
        });
        return { result: JSON.stringify(result, null, 2) };
      },
      count: async () => {
        const { getMeetingCounts } = await import("./meetings/meeting-index");
        return { result: JSON.stringify(await getMeetingCounts(), null, 2) };
      },
      get: async (a) => {
        const id = String(a.meetingId || a.id || "").trim();
        if (!id) return { result: "Missing meetingId", error: true };
        const { getMeetingRecord } = await import("./meetings/meeting-index");
        const meeting = await getMeetingRecord(id);
        return meeting
          ? { result: JSON.stringify(meeting, null, 2) }
          : { result: `Meeting not found: ${id}`, error: true };
      },
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown meetings action: ${action}. Available: add, list, update, delete, set_metadata, get_metadata, link_artifact, unlink_artifact, records, count, get`, error: true };
    return handler(args);
  },

  async tools(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) {
      return contractReject(
        "Missing action parameter. Available: list, get",
        "tools_input_invalid",
      );
    }

    if (action === "list") {
      const { getToolSchemas } = await import("./tool-registry");
      const { filterToolSchemasForAuthority } = await import("./agent-authority");
      const schemas = filterToolSchemasForAuthority(
        getToolSchemas(),
        args._authorityContext || {},
      );
      const lines = schemas.map((schema) =>
        `- **${schema.name}** (${schema.category}): ${schema.description.slice(0, 80)}...`
      );
      return { result: `Authority-allowed tools (${lines.length}):\n${lines.join("\n")}` };
    }

    if (action === "get") {
      const toolName = args.tool;
      if (!toolName) {
        return contractReject(
          "Missing tool parameter for get action",
          "tools_input_invalid",
        );
      }
      const { getToolSchemas } = await import("./tool-registry");
      const { filterToolSchemasForAuthority } = await import("./agent-authority");
      const schemas = filterToolSchemasForAuthority(
        getToolSchemas(),
        args._authorityContext || {},
      );
      const meta = schemas.find((schema) => schema.name === toolName);
      if (!meta) {
        return {
          result: `Tool unavailable under current execution authority: ${toolName}`,
          error: true,
          failure: inputFailure("tools_authority_denied", toolName),
        };
      }

      let detail = `## ${toolName}\n${meta.description}\nCategory: ${meta.category}`;
      if (meta.parameters?.properties) {
        const params = Object.entries(meta.parameters.properties).map(([k, v]) => {
          const prop = v as { description?: string; type?: string; enum?: unknown[] };
          const allowedValues = Array.isArray(prop.enum) ? ` Allowed: ${prop.enum.join(", ")}.` : "";
          return `  - ${k}: ${prop.description || prop.type || ""}${allowedValues}${meta.parameters?.required?.includes(k) ? " (required)" : ""}`;
        });
        detail += `\nParameters:\n${params.join("\n")}`;
      }

      try {
        const { TOOL_DETAILS } = await import("./tool-details");
        const details = TOOL_DETAILS[toolName];
        if (details) {
          detail += `\n\n### Detailed Documentation\n${details.description}`;
          if (details.whenToUse) detail += `\n\n### When to Use\n${details.whenToUse}`;
          if (details.example) detail += `\n\n### Examples\n${details.example}`;
          if (details.actions) {
            const schemaRequired = Array.isArray(meta.parameters?.required)
              ? (meta.parameters.required as string[])
              : [];
            const actionLines = Object.entries(details.actions).map(([name, info]) => {
              // Merge live schema-required params (e.g. universal reasoning) so action
              // docs cannot understate the callable contract when TOOL_DETAILS drifts.
              const required = Array.from(new Set([...(info.requiredParams ?? []), ...schemaRequired]));
              const optional = (info.optionalParams ?? []).filter((p) => !required.includes(p));
              let line = `  - **${name}**: ${info.description}`;
              if (required.length) line += ` | Required: ${required.join(", ")}`;
              if (optional.length) line += ` | Optional: ${optional.join(", ")}`;
              return line;
            });
            detail += `\n\n### Actions\n${actionLines.join("\n")}`;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        detail += `\n\n(Detailed docs unavailable: ${msg})`;
      }

      const supportsRunHydration =
        args._authorityContext?.origin === "interactive" &&
        typeof args._sessionId === "string" &&
        args._sessionId.length > 0;
      return supportsRunHydration
        ? {
            result: `${detail}\n\nThe complete callable schema for \`${toolName}\` is now loaded for this run. You may call it directly on the next step.`,
            continuation: "tool_schema_refresh",
          }
        : { result: detail };
    }

    return contractReject(
      `Unknown tools action: ${action}. Available: list, get`,
      "tools_input_invalid",
    );
  },

  async content(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter. Available: queue_draft, list, suggest_times, x_status, x_post, x_reply, x_lookup, x_delete, x_news_search, x_news_lookup", error: true };

    const xAction = typeof action === "string" && action.startsWith("x_") ? action.slice(2) : null;
    if (xAction) {
      return bridgeHandlers.twitter({ ...args, action: xAction });
    }

    if (action === "queue_draft") {
      const { createContent } = await import("./content-storage");
      const platform = args.platform || "x";
      const content = args.content;
      if (!content) return { result: "Missing content parameter", error: true };
      const post = await createContent({
        platform,
        content,
        threadParts: args.threadParts || null,
        metadata: args.metadata || null,
        status: "draft",
      });
      // Record session artifact link
      const { recordSessionArtifact } = await import("./session-artifacts");
      recordSessionArtifact(args._sessionId, "content_draft", String(post.id), { platform: post.platform });
      return { result: `Draft queued successfully.\nID: ${post.id}\nContent: ${post.content.slice(0, 100)}${post.content.length > 100 ? "..." : ""}\nStatus: draft\nPlatform: ${post.platform}` };
    }

    if (action === "list") {
      const { listContent } = await import("./content-storage");
      const posts = await listContent({
        status: args.status || undefined,
        limit: args.limit ? parseInt(args.limit, 10) : 20,
      });
      if (posts.length === 0) return { result: "No posts found in content queue." };
      const lines = posts.map(p => {
        let line = `- [${p.status}] ${p.content.slice(0, 80)}${p.content.length > 80 ? "..." : ""}`;
        if (p.scheduledAt) line += ` (scheduled: ${new Date(p.scheduledAt).toLocaleString("en-US", { timeZone: "America/Chicago" })})`;
        if (p.platformUrl) line += ` → ${p.platformUrl}`;
        return line;
      });
      return { result: `Content queue (${posts.length} posts):\n${lines.join("\n")}` };
    }

    if (action === "suggest_times") {
      const { suggestPostingTimes } = await import("./content-publisher");
      const { getScheduledPostsInRange } = await import("./content-storage");
      const count = parseInt(args.count || "7", 10);
      const startDate = args.startDate || new Date().toISOString();
      const endDate = args.endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const existing = await getScheduledPostsInRange(startDate, endDate);
      const existingTimes = existing.filter(p => p.scheduledAt).map(p => new Date(p.scheduledAt!));
      const times = suggestPostingTimes(count, startDate, endDate, existingTimes);
      return { result: `Suggested posting times (${times.length}):\n${times.map(t => `- ${new Date(t).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`).join("\n")}` };
    }

    return { result: `Unknown content action: ${action}. Available: queue_draft, list, suggest_times`, error: true };
  },

  async memory_ops(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = String(args.action || "");
    try {
      switch (action) {
        case "run_full_sleep_cycle": {
          const includeGSI = args.includeGSI === true || args.includeGSI === "true" || args.include_gsi === true || args.include_gsi === "true";
          const { runFullSleepCycle } = await import("./sleep-cycle");
          const result = await runFullSleepCycle({ includeGSI });
          const parts = [
            `Full sleep cycle complete (${result.durationMs}ms)${result.timedOut ? ` — TIMED OUT (${result.abortReason || "unknown"})` : ""}:`,
          ];
          if (result.vnextLifecycle) {
            const lc = result.vnextLifecycle;
            parts.push(`  vNext lifecycle: ${lc.scanned} scanned, ${lc.canonicalized} canonicalized, ${lc.retired} retired, ${lc.decayed} decayed, ${lc.errors} errors`);
            parts.push(`  Bridges: ${lc.bridges.created} created, ${lc.bridges.replaced} replaced, ${lc.bridges.finalEdges} final edges (${lc.bridges.scanned} scanned)`);
          } else {
            parts.push("  vNext lifecycle: did not complete");
          }
          parts.push(`  REM: ${result.rem.seedCount} seeds, ${result.rem.sessionCount} sessions, ${result.rem.domainsWoven} domains. Dream: "${result.rem.dreamTitle || "none"}"`);
          if (result.gsi) {
            parts.push(`  GSI: ${(result.gsi.overall * 100).toFixed(1)}% (connectivity=${(result.gsi.connectivity * 100).toFixed(1)}%, linkQuality=${(result.gsi.linkQuality * 100).toFixed(1)}%, orphanRate=${(result.gsi.orphanRate * 100).toFixed(1)}%, clusterBalance=${(result.gsi.clusterBalance * 100).toFixed(1)}%, decayHealth=${(result.gsi.decayHealth * 100).toFixed(1)}%)`);
          }
          if (result.errors.length > 0) {
            parts.push(`  Errors (${result.errors.length}): ${result.errors.join("; ")}`);
          }
          if (result.rem.dreamInsight) {
            parts.push("", `Dream insight: ${result.rem.dreamInsight}`);
          }
          if (result.rem.dreamNarrative) {
            parts.push("", "Dream narrative (file to Library per skill instructions):", result.rem.dreamNarrative);
          }
          return { result: parts.join("\n") };
        }
        case "compute_gsi": {
          const { computeGSI } = await import("./memory/graph-metrics");
          const gsi = await computeGSI();
          return { result: `GSI Score: ${(gsi.overall * 100).toFixed(1)}% — connectivity=${(gsi.connectivity * 100).toFixed(1)}%, linkQuality=${(gsi.linkQuality * 100).toFixed(1)}%, orphanRate=${(gsi.orphanRate * 100).toFixed(1)}%, clusterBalance=${(gsi.clusterBalance * 100).toFixed(1)}%, decayHealth=${(gsi.decayHealth * 100).toFixed(1)}% (${gsi.details.activeClaims} active claims)` };
        }
        case "run_rem": {
          const { runREMPhase } = await import("./memory/dream-engine");
          const rem = await runREMPhase();
          const remParts = [
            `REM phase complete (${rem.durationMs}ms): ${rem.seedCount} seeds, ${rem.sessionCount} sessions, ${rem.domainsWoven} domains. Dream: "${rem.dreamTitle || "none"}"`,
          ];
          if (rem.dreamInsight) remParts.push(`Dream insight: ${rem.dreamInsight}`);
          if (rem.dreamNarrative) remParts.push("", "Dream narrative (file to Library per skill instructions):", rem.dreamNarrative);
          if (rem.errors.length > 0) remParts.push(`Errors: ${rem.errors.join("; ")}`);
          return { result: remParts.join("\n") };
        }
        default:
          return { result: `Unknown memory_ops action: "${action}". Valid actions: run_full_sleep_cycle, compute_gsi, run_rem`, error: true };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `memory_ops(${action}) error: ${msg}`, error: true };
    }
  },

  async get_system_state(_args: Record<string, any>): Promise<ToolHandlerResult> {
    try {
      const parts: string[] = ["## System State Summary"];

      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const counts = await memoryVnextClaimStorage.getCounts();
        parts.push(`**Memory:** ${counts.total} vNext claims — source refs: ${counts.sourceRefs}, entity links: ${counts.entityLinks}, claim links: ${counts.claimLinks}`);
      } catch { parts.push("**Memory:** vNext unavailable"); }

      try {
        const { storage } = await import("./storage");
        const skills = await storage.getSkills({ status: "active" });
        parts.push(`**Skills:** ${skills.length} active`);
      } catch { parts.push("**Skills:** unavailable"); }

      try {
        const caps = await specStorage.listSystemCapabilities();
        const health = await specStorage.getUserStoryHealthSummary();
        const active = caps.filter(c => c.status === "active").length;
        const degraded = caps.filter(c => c.status === "degraded").length;
        const missing = caps.filter(c => c.status === "missing").length;
        parts.push(`**Capabilities:** ${caps.length} total — active: ${active}, degraded: ${degraded}, missing: ${missing}`);
        parts.push(`**User Stories:** passing: ${health.passing}, blocked: ${health.blocked}, untested: ${health.untested}, failing: ${health.failing}`);
      } catch { parts.push("**Capabilities:** unavailable"); }

      // Intentions system removed — autonomy skill handles autonomous work

      try {
        const { goalsService: goalsServiceState } = await import("./goals-service");
        const goals = await goalsServiceState.listAll({ includeDormant: true });
        parts.push(`**Goals:** ${goals.length} total`);
      } catch { parts.push("**Goals:** unavailable"); }

      try {
        const { peopleStorage } = await import("./people-storage");
        const people = await peopleStorage.listPeople();
        const byTier: Record<string, number> = {};
        for (const p of people) {
          const tier = p.cabinetLevel || "unknown";
          byTier[tier] = (byTier[tier] || 0) + 1;
        }
        parts.push(`**People:** ${people.length} total — ${Object.entries(byTier).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
      } catch { parts.push("**People:** unavailable"); }

      try {
        const { db } = await import("./db");
        const { connectedAccounts } = await import("@shared/schema");
        const accounts = await db.select().from(connectedAccounts);
        const byProvider: Record<string, number> = {};
        let healthy = 0;
        let unhealthy = 0;
        for (const a of accounts) {
          byProvider[a.provider] = (byProvider[a.provider] || 0) + 1;
          if (a.healthy === false) { unhealthy++; } else { healthy++; }
        }
        parts.push(`**Connected Accounts:** ${accounts.length} total (healthy: ${healthy}, unhealthy: ${unhealthy}) — ${Object.entries(byProvider).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
      } catch { parts.push("**Connected Accounts:** unavailable"); }

      try {
        const { fileProjectStorage } = await import("./file-storage/projects");
        const projects = await fileProjectStorage.getProjects();
        const byStatus: Record<string, number> = {};
        for (const p of projects) {
          const proj = p as unknown as Record<string, unknown>;
          const st = String(proj.status || "unknown");
          byStatus[st] = (byStatus[st] || 0) + 1;
        }
        parts.push(`**Projects:** ${projects.length} total — ${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
      } catch { parts.push("**Projects:** unavailable"); }

      try {
        const { admissionController } = await import("./run-admission");
        const schedulingState = admissionController.getState();
        const tierCounts = admissionController.getTierCounts();
        const activeSlots = admissionController.getSlots().map(s => ({
          runId: s.runId,
          tier: s.tier,
          yieldRequested: s.yieldRequested,
        }));
        const queueDepth = admissionController.getQueueDepth();
        const tierSummary = Object.entries(tierCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ");
        parts.push(`**Scheduling:** state=${schedulingState}, activeSlots=${activeSlots.length}, queueDepth=${queueDepth}${tierSummary ? ` — tiers: ${tierSummary}` : ""}`);
        if (activeSlots.length > 0) {
          parts.push(`  Slots: ${activeSlots.map(s => `${s.runId}(${s.tier}${s.yieldRequested ? ",yielding" : ""})`).join(", ")}`);
        }
      } catch { parts.push("**Scheduling:** unavailable"); }

      try {
        const { getInFlightStats } = await import("./db");
        const dbStats = getInFlightStats();
        const breakdown = Object.entries(dbStats.bySubsystem).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ");
        parts.push(`**DB In-Flight:** ${dbStats.total} total${breakdown ? ` — ${breakdown}` : ""}`);
      } catch { parts.push("**DB In-Flight:** unavailable"); }

      try {
        const { getDbSaturationInfo } = await import("./db");
        const sat = getDbSaturationInfo();
        const probeMs = sat.lastProbeDurationMs === null ? "—" : `${sat.lastProbeDurationMs}ms`;
        const satFor = sat.saturatedForMs > 0 ? `, saturatedFor=${sat.saturatedForMs}ms` : "";
        parts.push(`**DB Pool:** total=${sat.total}, idle=${sat.idle}, waiting=${sat.waiting}${satFor}, lastProbe=${probeMs}`);
      } catch { parts.push("**DB Pool:** unavailable"); }

      try {
        const { getSlowQueryStats } = await import("./db");
        const s = getSlowQueryStats();
        const last = s.lastSlowDurationMs === null ? "none" : `${s.lastSlowDurationMs}ms`;
        const fp = s.lastQueryFingerprint ? ` fingerprint=${s.lastQueryFingerprint}` : "";
        const sql = s.lastSqlSnippet ? ` sql=${JSON.stringify(s.lastSqlSnippet)}` : "";
        parts.push(`**Slow Queries:** lastMin=${s.lastMinute}, last10m=${s.lastTenMinutes}, threshold=${s.thresholdMs}ms, lastSlow=${last}${fp}${sql}`);
      } catch { parts.push("**Slow Queries:** unavailable"); }

      try {
        const pm = await import("./performance-monitor");
        const cur = pm.getLatestEventLoopLag?.() ?? 0;
        const diag = pm.getPerformanceDiagnostics?.();
        const max = diag?.eventLoopLag?.max ?? 0;
        const avg = diag?.eventLoopLag?.avg ?? 0;
        parts.push(`**Event Loop:** current=${Math.round(cur * 100) / 100}ms, avg=${Math.round(avg * 100) / 100}ms, max=${Math.round(max * 100) / 100}ms`);
      } catch { parts.push("**Event Loop:** unavailable"); }

      try {
        const { agentExecutor } = await import("./agent-executor");
        const { ACTIVITY_CHAT } = await import("./job-profiles");
        const runs = agentExecutor.getActiveRuns();
        const chat = runs.filter(r => r.activity === ACTIVITY_CHAT).length;
        const aborted = runs.filter(r => r.aborted).length;
        parts.push(`**Executor:** activeRuns=${runs.length} (chat=${chat}, aborted=${aborted})`);
      } catch { parts.push("**Executor:** unavailable"); }

      try {
        const { admissionController } = await import("./run-admission");
        const slots = admissionController.getSlots();
        const suspendedSlots = admissionController.getSuspendedSlots();
        if (slots.length === 0) {
          parts.push(`**Admission Slots:** none`);
        } else {
          const now = Date.now();
          const summary = slots.map(s => `${s.runId.slice(0, 8)}(${s.tier},${Math.round((now - s.grantedAt) / 1000)}s${s.yieldRequested ? ",yielding" : ""})`).join(", ");
          parts.push(`**Admission Slots:** ${slots.length} — ${summary}`);
        }
        if (suspendedSlots.length > 0) {
          parts.push(`**Suspended Admission:** ${suspendedSlots.length} — ${suspendedSlots.map((slot) => `${slot.runId.slice(0, 8)}(${slot.tier})`).join(", ")}`);
        }
      } catch { parts.push("**Admission Slots:** unavailable"); }

      try {
        const { getZombieMetrics } = await import("./cli-sdk-adapter");
        const z = getZombieMetrics();
        parts.push(`**Zombies:** active=${z.active}, peak=${z.peak}`);
      } catch { parts.push("**Zombies:** unavailable"); }

      try {
        const { agentExecutor } = await import("./agent-executor");
        const { admissionController } = await import("./run-admission");
        const { getZombieMetrics } = await import("./cli-sdk-adapter");
        const runs = agentExecutor.getActiveRuns();
        const slots = admissionController.getSlots();
        const suspendedSlots = admissionController.getSuspendedSlots();
        const zombies = getZombieMetrics();
        const { classifyRunDivergence } = await import("./run-divergence");
        const divergence = classifyRunDivergence({
          runs,
          slots,
          suspendedSlots,
          activeZombies: zombies.active,
        });
        parts.push(`**Books vs Reality:** drift=${divergence.value}${divergence.detail === "in sync" ? " (in sync)" : ` — ${divergence.detail}`}`);
      } catch { parts.push("**Books vs Reality:** unavailable"); }

      try {
        const { getBrowserStats, isBrowserLaunching } = await import("./browser-manager");
        const bs = getBrowserStats();
        const launching = isBrowserLaunching() ? ", launching" : "";
        parts.push(`**Browser Manager:** activeBrowsers=${bs.activeBrowsers}, activePages=${bs.activePages}, queued=${bs.queued}${launching}`);
      } catch { parts.push("**Browser Manager:** unavailable"); }

      return { result: parts.join("\n") };
    } catch (err: any) {
      return { result: `get_system_state error: ${err.message}`, error: true };
    }
  },

  library: async (args) => {
    const { db } = await import("./db");
    const { libraryPages, libraryAnnotations, libraryPageLinks } = await import("@shared/models/info");
    const { eq, desc, asc, ilike, or, and, sql } = await import("drizzle-orm");
    const { requireCurrentPrincipal } = await import("./principal-context");
    const { combineWithVisibleScope, combineWithWritableScope, visibleScopePredicate } = await import("./scoped-storage");
    const { authorizedScopePredicate } = await import("./authorize");
    const { libraryPageIsLive } = await import("./library-trash");

    const action = args.action;
    const principal = requireCurrentPrincipal();
    // objectId carries libraryPages.id so authorize() can OR in cross-user object_grants (read|write|admin).
    const libScopeColumns = { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId, objectId: libraryPages.id };
    // Canonical authorization spine: vault-gated ownership OR a live direct grant. Never bypass.
    const visibleLib = (predicate?: SQL) => {
      const owned = combineWithVisibleScope(principal, libScopeColumns, predicate ? and(predicate, libraryPageIsLive()) : libraryPageIsLive());
      return authorizedScopePredicate(principal, owned, "library_page", libScopeColumns, "read");
    };
    const writableLib = (predicate?: SQL) => {
      const owned = combineWithWritableScope(principal, libScopeColumns, predicate);
      return authorizedScopePredicate(principal, owned, "library_page", libScopeColumns, "write");
    };

    function publishLibraryChanged(action: string, page?: { id?: string | null; title?: string | null; surface?: boolean | null; surfaceUntil?: Date | string | null }) {
      eventBus.publish({
        category: "system",
        event: "data:library_changed",
        payload: {
          source: "library_tool",
          action,
          pageId: page?.id ?? null,
          title: page?.title ?? null,
          surface: page?.surface ?? null,
          surfaceUntil: page?.surfaceUntil instanceof Date ? page.surfaceUntil.toISOString() : (page?.surfaceUntil ?? null),
        },
      });
    }

    const { buildLibrarySurfaceSet } = await import("./library-save");

    try {
      // ── Breadcrumb helper ──────────────────────────────────────
      async function buildBreadcrumbMap(): Promise<Map<string, { title: string; parentId: string | null }>> {
        const allPages = await db.select({
          id: libraryPages.id,
          title: libraryPages.title,
          parentId: libraryPages.parentId,
        }).from(libraryPages).where(visibleLib());
        const map = new Map<string, { title: string; parentId: string | null }>();
        for (const p of allPages) map.set(p.id, { title: p.title, parentId: p.parentId });
        return map;
      }

      function getBreadcrumb(pageId: string, map: Map<string, { title: string; parentId: string | null }>): string {
        const chain: string[] = [];
        let currentId: string | null = map.get(pageId)?.parentId ?? null;
        const seen = new Set<string>();
        while (currentId && map.has(currentId) && !seen.has(currentId)) {
          seen.add(currentId);
          chain.unshift(map.get(currentId)!.title);
          currentId = map.get(currentId)!.parentId;
        }
        return chain.length > 0 ? chain.join(" > ") : "root";
      }

      // ── Vault helpers ──────────────────────────────────────────
      // `vaults` is the sole vault-identity authority; library_pages.vault_id
      // is canonical page membership. Resolve id -> name once per call.
      async function buildVaultMap(): Promise<Map<string, { name: string }>> {
        const map = new Map<string, { name: string }>();
        if (!principal.accountId) return map;
        const { vaults } = await import("@shared/models/vaults");
        const rows = await db.select({
          id: vaults.id, name: vaults.name,
        }).from(vaults).where(eq(vaults.accountId, principal.accountId));
        for (const v of rows) map.set(v.id, { name: v.name });
        return map;
      }
      function vaultLabel(vaultId: string | null, vmap: Map<string, { name: string }>): string {
        if (!vaultId) return "Unassigned";
        return vmap.get(vaultId)?.name ?? `vault ${vaultId.slice(0, 8)}`;
      }

      // ── Library page actions ──────────────────────────────────────
      if (action === "list_library_pages" || action === "list") {
        const vaultFilter = typeof args.vaultId === "string" && args.vaultId ? eq(libraryPages.vaultId, args.vaultId) : undefined;
        const limitRaw = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 50;
        const limit = Math.min(200, Math.max(1, limitRaw));
        const pages = await db.select({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          oneLiner: libraryPages.oneLiner,
          summary: libraryPages.summary,
          vaultId: libraryPages.vaultId,
          updatedAt: libraryPages.updatedAt,
        }).from(libraryPages).where(visibleLib(vaultFilter)).orderBy(desc(libraryPages.updatedAt)).limit(limit);
        if (pages.length === 0) return { result: "No library pages found." };
        const bcMap = await buildBreadcrumbMap();
        const vmap = await buildVaultMap();
        return { result: `Library pages (${pages.length}):\n${pages.map(p => {
          const location = getBreadcrumb(p.id, bcMap);
          const ol = p.oneLiner ? ` — ${p.oneLiner}` : "";
          const sum = p.summary ? `\n  ${p.summary}` : "";
          return `- [${p.id}] **${p.title}** · vault: ${vaultLabel(p.vaultId, vmap)} · in ${location} (/${p.slug})${ol}${sum}`;
        }).join("\n")}` };
      }

      if (action === "search_library_pages" || action === "search") {
        const q = args.query || "";
        if (!q) return { result: "Provide a query for search.", error: true };
        const words = q.trim().split(/\s+/).filter(Boolean);
        const wordConditions = words.map((word) =>
          or(
            ilike(libraryPages.title, `%${word}%`),
            ilike(libraryPages.oneLiner, `%${word}%`),
            ilike(libraryPages.summary, `%${word}%`),
            sql`array_to_string(${libraryPages.tags}, ' ') ilike ${'%' + word + '%'}`,
            ilike(libraryPages.plainTextContent, `%${word}%`),
          )
        );
        const whereClause = wordConditions.length === 1 ? wordConditions[0] : and(...wordConditions);
        const vaultFilter = typeof args.vaultId === "string" && args.vaultId ? eq(libraryPages.vaultId, args.vaultId) : undefined;
        const limitRaw = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 20;
        const limit = Math.min(200, Math.max(1, limitRaw));
        const pages = await db.select({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          oneLiner: libraryPages.oneLiner,
          summary: libraryPages.summary,
          vaultId: libraryPages.vaultId,
          plainTextContent: libraryPages.plainTextContent,
        }).from(libraryPages).where(visibleLib(vaultFilter ? and(whereClause, vaultFilter) : whereClause)).limit(limit);
        if (pages.length === 0) return { result: `No library pages matching "${q}".` };
        const bcMap = await buildBreadcrumbMap();
        const vmap = await buildVaultMap();
        return { result: `Search results for "${q}":\n${pages.map(p => {
          const breadcrumb = getBreadcrumb(p.id, bcMap);
          const path = breadcrumb === "root" ? p.title : `${breadcrumb} > ${p.title}`;
          const ol = p.oneLiner ? `\n  ${p.oneLiner}` : "";
          const sum = p.summary ? `\n  ${p.summary}` : "";
          const snippet = (!p.oneLiner && !p.summary) ? `\n  ${(p.plainTextContent || "").slice(0, 500)}` : "";
          return `- [${p.id}] **${p.title}** · vault: ${vaultLabel(p.vaultId, vmap)} (${path})${ol}${sum}${snippet}`;
        }).join("\n\n")}` };
      }

      if (action === "browse_tree" || action === "tree") {
        const vaultFilter = typeof args.vaultId === "string" && args.vaultId ? eq(libraryPages.vaultId, args.vaultId) : undefined;
        const allPages = await db.select({
          id: libraryPages.id,
          title: libraryPages.title,
          slug: libraryPages.slug,
          parentId: libraryPages.parentId,
          emoji: libraryPages.emoji,
          oneLiner: libraryPages.oneLiner,
          vaultId: libraryPages.vaultId,
          ownerUserId: libraryPages.ownerUserId,
        }).from(libraryPages).where(visibleLib(vaultFilter)).orderBy(asc(libraryPages.sortOrder), asc(libraryPages.title));

        if (allPages.length === 0) return { result: "No library pages found." };

        type TreeNode = (typeof allPages)[number] & { children: TreeNode[] };
        const formatTree = (nodes: TreeNode[], indent: number): string => {
          return nodes.map(n => {
            const prefix = "  ".repeat(indent) + "- ";
            const emoji = n.emoji ? `${n.emoji} ` : "";
            const ol = n.oneLiner ? ` — ${n.oneLiner}` : "";
            const line = `${prefix}${emoji}**${n.title}** [${n.id}] (/${n.slug})${ol}`;
            const childLines = n.children.length > 0 ? "\n" + formatTree(n.children, indent + 1) : "";
            return line + childLines;
          }).join("\n");
        };

        // Group strictly by Vault so every page renders under its own Vault.
        // Within a Vault, a page is a root when it has no parent or its parent
        // is not part of the same Vault's visible page set (surfaces orphans
        // instead of silently dropping them).
        const vmap = await buildVaultMap();
        const visSet = principal.visibleVaultIds && principal.visibleVaultIds.length > 0 ? new Set(principal.visibleVaultIds) : null;
        const byVault = new Map<string, TreeNode[]>();
        const sharedNodes: TreeNode[] = [];
        for (const p of allPages) {
          const vaultVisible = Boolean(p.vaultId && visSet?.has(p.vaultId));
          const grantOnly = Boolean(principal.userId && p.ownerUserId && p.ownerUserId !== principal.userId);
          if (grantOnly && !vaultVisible) {
            sharedNodes.push({ ...p, children: [] });
            continue;
          }
          const key = p.vaultId ?? "__unassigned__";
          if (!byVault.has(key)) byVault.set(key, []);
          byVault.get(key)!.push({ ...p, children: [] });
        }

        const orderedKeys = Array.from(byVault.keys()).sort((a, b) => {
          if (a === "__unassigned__") return 1;
          if (b === "__unassigned__") return -1;
          return vaultLabel(a, vmap).localeCompare(vaultLabel(b, vmap));
        });

        const formatShared = () => {
          if (sharedNodes.length === 0) return "";
          const idSet = new Set(sharedNodes.map(n => n.id));
          const nodeById = new Map(sharedNodes.map(n => [n.id, n]));
          const roots: TreeNode[] = [];
          for (const n of sharedNodes) {
            if (n.parentId && idSet.has(n.parentId)) {
              nodeById.get(n.parentId)!.children.push(n);
            } else {
              roots.push(n);
            }
          }
          return `## Shared — ${sharedNodes.length} pages\n${formatTree(roots, 0)}`;
        };

        const sections = orderedKeys.map(key => {
          const nodes = byVault.get(key)!;
          const idSet = new Set(nodes.map(n => n.id));
          const nodeById = new Map(nodes.map(n => [n.id, n]));
          const roots: TreeNode[] = [];
          for (const n of nodes) {
            if (n.parentId && idSet.has(n.parentId)) {
              nodeById.get(n.parentId)!.children.push(n);
            } else {
              roots.push(n);
            }
          }
          const name = key === "__unassigned__" ? "Unassigned (no Vault)" : vaultLabel(key, vmap);
          const idTag = key === "__unassigned__" ? "" : ` [${key}]`;
          const flags = key === "__unassigned__"
            ? ""
            : ` (${visSet ? (visSet.has(key) ? "visible" : "hidden") : "visible"}${principal.activeVaultId === key ? ", active" : ""})`;
          return `## ${name}${idTag}${flags} — ${nodes.length} pages\n${formatTree(roots, 0)}`;
        });

        const sharedSection = formatShared();
        const allSections = sharedSection ? [...sections, sharedSection] : sections;
        const groupCount = byVault.size + (sharedNodes.length > 0 ? 1 : 0);
        return { result: `Library tree — ${groupCount} groups, ${allPages.length} pages:\n\n${allSections.join("\n\n")}` };
      }

      if (action === "get_library_page" || action === "get") {
        const id = args.id;
        if (!id) {
          return {
            result: "Provide an id or slug.",
            error: true,
            failure: inputFailure("library_input_invalid", "missing_id"),
          };
        }
        const byId = await db.select().from(libraryPages).where(visibleLib(eq(libraryPages.id, id)));
        const page = byId[0] || (await db.select().from(libraryPages).where(visibleLib(eq(libraryPages.slug, id))))[0];
        if (!page) {
          return {
            result: `Library page "${id}" not found.`,
            error: true,
            failure: inputFailure("library_input_invalid", "page_not_found"),
          };
        }
        const annotations = await db.select().from(libraryAnnotations).where(eq(libraryAnnotations.pageId, page.id));
        const annotationText = annotations.length > 0
          ? `\n\n**Agent Annotations:**\n${annotations.map(a => `- [${a.annotationType}] ${a.content}`).join("\n")}`
          : "";
        const statusLine = page.status ? `\n**Status:** ${page.status}` : "";
        const surfaceLine = page.surface && page.surfaceUntil ? `\n**Surfaced Until:** ${page.surfaceUntil instanceof Date ? page.surfaceUntil.toISOString() : page.surfaceUntil}` : "";
        const tagsLine = page.tags && page.tags.length > 0 ? `\n**Tags:** ${page.tags.join(", ")}` : "";
        const getVmap = await buildVaultMap();
        const vaultLine = `\n**Vault:** ${vaultLabel(page.vaultId ?? null, getVmap)}${page.vaultId ? ` [${page.vaultId}]` : ""}`;
        const { tiptapToMarkdown } = await import("@shared/markdown-tiptap");
        const mdContent = page.content ? tiptapToMarkdown(page.content as any) : (page.plainTextContent || "[no content]");
        return { result: `# ${page.title}${tagsLine}${statusLine}${surfaceLine}${vaultLine}\n\n${mdContent}${annotationText}\n\n**Parent ID:** ${page.parentId || "none"}` };
      }

      if (action === "list_vaults") {
        if (!principal.accountId) return { result: "No account in context; cannot list vaults.", error: true };
        const { vaults } = await import("@shared/models/vaults");
        const vaultRows = await db.select({
          id: vaults.id, name: vaults.name, isDefault: vaults.isDefault, isArchived: vaults.isArchived,
        }).from(vaults).where(eq(vaults.accountId, principal.accountId)).orderBy(asc(vaults.position), asc(vaults.createdAt));
        if (vaultRows.length === 0) return { result: "No vaults found for this account." };
        // Live page counts per vault, account-scoped (independent of visibility toggles),
        // so the inventory is complete even for vaults hidden from the current view.
        const countRows = await db.select({
          vaultId: libraryPages.vaultId, n: sql<number>`count(*)::int`,
        }).from(libraryPages).where(and(eq(libraryPages.accountId, principal.accountId), libraryPageIsLive())).groupBy(libraryPages.vaultId);
        const countMap = new Map<string, number>();
        let unassigned = 0;
        for (const r of countRows) { if (r.vaultId) countMap.set(r.vaultId, Number(r.n)); else unassigned = Number(r.n); }
        const visSet = principal.visibleVaultIds && principal.visibleVaultIds.length > 0 ? new Set(principal.visibleVaultIds) : null;
        const lines = vaultRows.map(v => {
          const flags: string[] = [];
          if (v.isDefault) flags.push("default");
          if (v.isArchived) flags.push("archived");
          flags.push(visSet ? (visSet.has(v.id) ? "visible" : "hidden") : "visible");
          if (principal.activeVaultId === v.id) flags.push("active");
          return `- **${v.name}** [${v.id}] — ${countMap.get(v.id) ?? 0} pages (${flags.join(", ")})`;
        });
        const unassignedLine = unassigned > 0 ? `\n- **(Unassigned — no Vault)** — ${unassigned} pages` : "";
        return { result: `Vaults (${vaultRows.length}) for this account:\n${lines.join("\n")}${unassignedLine}` };
      }

      // ─── Library page mutations ────────────────────────────────────────
      // create/update/edit/delete coordinate through the Library service or
      // direct transactions that acquire the same parent advisory locks used
      // by reorder, so tool writes do not race user reparenting.
      const { acquireLibraryParentLocks, isSerializationConflict, runWithDatabaseTransaction } = await import("./db");

      if (action === "create_library_page" || action === "create" || action === "create_spec") {
        const title = args.title || "Untitled";
        const tags: string[] = Array.isArray(args.tags) ? args.tags : (action === "create_spec" ? ["spec"] : []);
        const status = args.status || null;
        const plain = args.plainTextContent || "";
        const { createFiledLibraryPage, isCanonicalVaultFolder } = await import("./library-save");
        try {
          const page = await createFiledLibraryPage({
            title,
            markdown: plain,
            canonicalFolder: isCanonicalVaultFolder(args.canonicalFolder) ? args.canonicalFolder : null,
            explicitParentId: args.parentId || null,
            tags,
            status,
            structuralRole: args.structuralRole || null,
            createdBySessionId: args._sessionId || null,
            surface: args.surface,
            surfaceDurationHours: args.surfaceDurationHours,
            surfaceReason: args.surfaceReason,
            surfaceSection: args.surfaceSection,
          });
          const linkSyntax = ` [page:${page.slug}]`;

          // Record session artifact link
          const { recordSessionArtifact } = await import("./session-artifacts");
          await recordSessionArtifact(args._sessionId, "library_page", page.slug, { title: page.title, pageId: page.id });
          return {
            result: `Page created: [${page.id}] **${page.title}** (/${page.slug})${linkSyntax} under ${page.filingResolution.parentTitle}`,
            resolution: page.filingResolution,
          };
        } catch (err: any) {
          if (isSerializationConflict(err)) {
            toolExec.warn(`create_library_page: serialization conflict — retryable: ${err.message}`);
            return { result: `Library write conflicted with a concurrent reorder, please retry: ${err.message}`, error: true };
          }
          throw err;
        }
      }

      if (action === "update_library_page" || action === "update") {
        const id = args.id;
        if (!id) return { result: "Provide an id to update.", error: true };
        const parentIdProvided = args.parentId !== undefined;
        const vaultProvided = args.destinationVaultId !== undefined;
        const structureRequested =
          parentIdProvided
          || vaultProvided
          || args.tags !== undefined
          || args.surface !== undefined
          || args.surfaceDurationHours !== undefined
          || args.surfaceReason !== undefined
          || args.surfaceSection !== undefined;
        const lookup = structureRequested
          ? (predicate?: SQL) => combineWithWritableScope(principal, libScopeColumns, predicate)
          : writableLib;
        const byId = await db.select({ id: libraryPages.id, parentId: libraryPages.parentId }).from(libraryPages).where(lookup(eq(libraryPages.id, id)));
        const resolved = byId[0] || (await db.select({ id: libraryPages.id, parentId: libraryPages.parentId }).from(libraryPages).where(lookup(eq(libraryPages.slug, id))))[0];
        if (!resolved) return { result: structureRequested ? `Write access does not include moving, tagging, or surfacing "${id}".` : `Library page "${id}" not found.`, error: true };
        const resolvedId = resolved.id;
        const oldParentId = resolved.parentId;

        const setData: Partial<typeof libraryPages.$inferInsert> & { updatedAt: Date } = { updatedAt: new Date() };
        if (args.title) { setData.title = args.title; setData.slug = (args.title as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page"; }
        if (args.plainTextContent !== undefined) {
          const { syncContentFields } = await import("@shared/markdown-tiptap");
          const synced = syncContentFields({ markdown: args.plainTextContent as string });
          setData.content = synced.content;
          setData.plainTextContent = synced.plainTextContent;
        }
        // "" and the string "null" both mean the vault root (no parent); a real
        // id string is a reparent. When only destinationVaultId is supplied, the
        // intent is "move to that vault's root", so the destination parent is null.
        // Without this, a vault-only move silently no-ops (parent unchanged) and a
        // "null" string is looked up as a page id and 404s — the exact failure that
        // blocked cross-vault moves through this tool.
        const normalizedExplicitParent =
          args.parentId === "" || args.parentId === "null"
            ? null
            : (args.parentId as string | null);
        const newParentId = parentIdProvided
          ? normalizedExplicitParent
          : vaultProvided
            ? null
            : oldParentId;
        const shouldMove = parentIdProvided || vaultProvided;
        let movedPage: typeof libraryPages.$inferSelect | null = null;
        if (shouldMove) {
          const { moveLibraryPage } = await import("./library-move");
          const moveResult = await moveLibraryPage(
            {
              pageId: resolvedId,
              destinationParentId: newParentId,
              destinationVaultId: args.destinationVaultId as string | undefined,
            },
            principal,
          );
          movedPage = moveResult.page;
        }
        if (args.tags !== undefined) setData.tags = args.tags as string[];
        if (args.status !== undefined) setData.status = args.status as string | null;
        if (args.oneLiner !== undefined) setData.oneLiner = args.oneLiner as string | null;
        if (args.summary !== undefined) setData.summary = args.summary as string | null;
        Object.assign(setData, buildLibrarySurfaceSet(args));

        try {
          const updated = await db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
            // Lock the old parent always, plus the new parent when it's
            // changing. Sorted dedup happens inside the helper.
            const lockTargets = shouldMove && newParentId !== oldParentId
              ? [oldParentId, newParentId]
              : [oldParentId];
            await acquireLibraryParentLocks(tx, lockTargets);
            const hasMetadataUpdates = Object.keys(setData).some((key) => key !== "updatedAt");
            if (!hasMetadataUpdates && movedPage) return movedPage;
            const [row] = await tx.update(libraryPages).set(setData).where(lookup(eq(libraryPages.id, resolvedId))).returning();
            if (row && args.plainTextContent !== undefined) {
              const { indexLibraryPageReferences } = await import("./library-reference-index");
              await indexLibraryPageReferences(principal, row);
            }
            return row;
          }));
          if (!updated) return { result: `Library page "${id}" not found.`, error: true };

          const substantiveChange = args.plainTextContent !== undefined || args.title !== undefined;
          if (substantiveChange) {
            try {
              const { upsertLibraryPageMemory } = await import("./routes/library");
              await upsertLibraryPageMemory(updated);
            } catch (memErr: unknown) {
              toolExec.warn(`update_library_page: memory reset failed for page ${updated.id}: ${memErr instanceof Error ? memErr.message : String(memErr)}`);
            }
          }

          if (args.tags !== undefined || args.title !== undefined) {
            const { syncLibraryPageTags } = await import("./library-tag-sync");
            syncLibraryPageTags(updated.id, updated.title, updated.tags);
          }
          publishLibraryChanged(updated.surface ? "surfaced" : "updated", updated);

          // Record session artifact link
          const { recordSessionArtifact } = await import("./session-artifacts");
          await recordSessionArtifact(args._sessionId, "library_page", updated.slug || args.id, { title: updated.title, pageId: updated.id });
          return { result: `Library page updated: [${updated.id}] **${updated.title}**` };
        } catch (err: any) {
          if (isSerializationConflict(err)) {
            toolExec.warn(`update_library_page: serialization conflict (page=${resolvedId} oldParent=${oldParentId} newParent=${newParentId}) — retryable: ${err.message}`);
            return { result: `Library write conflicted with a concurrent reorder, please retry: ${err.message}`, error: true };
          }
          throw err;
        }
      }

      if (action === "edit_library_page" || action === "edit") {
        const id = args.id;
        if (!id) {
          return {
            result: "Provide an id or slug to edit.",
            error: true,
            failure: inputFailure("library_input_invalid", "missing_id"),
          };
        }
        const oldString = args.old_string;
        const newString = args.new_string;
        if (oldString === undefined) {
          return {
            result: "Missing old_string",
            error: true,
            failure: inputFailure("library_input_invalid", "missing_old_string"),
          };
        }
        if (newString === undefined) {
          return {
            result: "Missing new_string",
            error: true,
            failure: inputFailure("library_input_invalid", "missing_new_string"),
          };
        }

        const byId = await db.select().from(libraryPages).where(writableLib(eq(libraryPages.id, id)));
        const page = byId[0] || (await db.select().from(libraryPages).where(writableLib(eq(libraryPages.slug, id))))[0];
        if (!page) {
          return {
            result: `Library page "${id}" not found.`,
            error: true,
            failure: inputFailure("library_input_invalid", "page_not_found"),
          };
        }
        if (
          args.surface !== undefined
          || args.surfaceDurationHours !== undefined
          || args.surfaceReason !== undefined
          || args.surfaceSection !== undefined
        ) {
          const owned = await db.select({ id: libraryPages.id }).from(libraryPages).where(combineWithWritableScope(principal, libScopeColumns, eq(libraryPages.id, page.id))).limit(1);
          if (!owned[0]) {
            return {
              result: `Write access does not include surfacing "${id}".`,
              error: true,
              failure: inputFailure("library_input_invalid", "surface_not_writable"),
            };
          }
        }

        const { tiptapToMarkdown } = await import("@shared/markdown-tiptap");
        const currentContent = page.plainTextContent || (page.content ? tiptapToMarkdown(page.content as any) : "");
        if (!currentContent) {
          return {
            result: `Library page "${id}" has no content to edit.`,
            error: true,
            failure: inputFailure("library_input_invalid", "empty_content"),
          };
        }

        const occurrences = currentContent.split(oldString).length - 1;
        if (occurrences === 0) {
          return {
            result: `old_string not found in library page "${page.title}"`,
            error: true,
            failure: inputFailure("library_input_invalid", "old_string_not_found"),
          };
        }

        const replaceAll = args.replace_all === true;
        if (occurrences > 1 && !replaceAll) {
          return {
            result: `old_string found ${occurrences} times in "${page.title}". Use replace_all: true to replace all, or provide more context to make it unique.`,
            error: true,
            failure: inputFailure("library_input_invalid", "old_string_ambiguous"),
          };
        }

        const updatedContent = replaceAll ? currentContent.split(oldString).join(newString) : currentContent.replace(oldString, newString);
        const replacements = replaceAll ? occurrences : 1;

        const { syncContentFields } = await import("@shared/markdown-tiptap");
        const synced = syncContentFields({ markdown: updatedContent });

        try {
          const updated = await db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
            await acquireLibraryParentLocks(tx, [page.parentId]);
            const [row] = await tx.update(libraryPages).set({
              content: synced.content,
              plainTextContent: synced.plainTextContent,
              ...buildLibrarySurfaceSet(args),
              updatedAt: new Date(),
            }).where(writableLib(eq(libraryPages.id, page.id))).returning();
            if (row) {
              const { indexLibraryPageReferences } = await import("./library-reference-index");
              await indexLibraryPageReferences(principal, row);
            }
            return row;
          }));

          if (!updated) return { result: `Failed to update library page "${id}".`, error: true };

          publishLibraryChanged(updated.surface ? "surfaced" : "updated", updated);

          const lengthDelta = updatedContent.length - currentContent.length;
          toolExec.log(`edit_library_page: page=${updated.id} replacements=${replacements} lengthDelta=${lengthDelta > 0 ? "+" : ""}${lengthDelta}`);

          try {
            const { upsertLibraryPageMemory } = await import("./routes/library");
            await upsertLibraryPageMemory(updated);
          } catch (memErr: unknown) {
            toolExec.warn(`edit_library_page: memory sync failed for page ${updated.id}: ${memErr instanceof Error ? memErr.message : String(memErr)}`);
          }

          // Record session artifact link
          const { recordSessionArtifact: recordArtifactEdit } = await import("./session-artifacts");
          await recordArtifactEdit(args._sessionId, "library_page", page.slug || args.id, { title: updated.title, pageId: updated.id });
          return { result: `Library page edited: [${updated.id}] **${updated.title}** (${replacements} replacement${replacements > 1 ? "s" : ""})` };
        } catch (err: any) {
          if (isSerializationConflict(err)) {
            toolExec.warn(`edit_library_page: serialization conflict (page=${page.id} parent=${page.parentId}) — retryable: ${err.message}`);
            return { result: `Library write conflicted with a concurrent reorder, please retry: ${err.message}`, error: true };
          }
          throw err;
        }
      }

      if (action === "dismiss_library_page" || action === "desurface_library_page" || action === "dismiss" || action === "desurface") {
        const id = args.id;
        if (!id) return { result: "Provide an id or slug to dismiss.", error: true };
        const ownedWritable = (predicate?: SQL) => combineWithWritableScope(principal, libScopeColumns, predicate);
        const byId = await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(ownedWritable(eq(libraryPages.id, id)));
        const page = byId[0] || (await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(ownedWritable(eq(libraryPages.slug, id))))[0];
        if (!page) return { result: `Write access does not include surfacing "${id}".`, error: true };
        const [updated] = await db.update(libraryPages).set({
          surface: false,
          surfaceUntil: null,
          surfaceReason: null,
          surfaceSection: null,
          updatedAt: new Date(),
        }).where(eq(libraryPages.id, page.id)).returning();
        if (!updated) return { result: `Library page "${id}" not found.`, error: true };
        publishLibraryChanged("desurfaced", updated);
        return { result: `Library page dismissed from surfacing: [${updated.id}] **${updated.title}**` };
      }

      if (action === "delete_library_page" || action === "delete") {
        const id = args.id;
        if (!id) return { result: "Provide an id to delete.", error: true };
        const ownedWritable = (predicate?: SQL) => combineWithWritableScope(principal, libScopeColumns, predicate);
        const byId = await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(ownedWritable(eq(libraryPages.id, id)));
        const resolved = byId[0] || (await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(ownedWritable(eq(libraryPages.slug, id))))[0];
        if (!resolved) return { result: `Library page "${id}" not found.`, error: true };
        try {
          // Soft-delete: write a library_page_trash sidecar row across the page and its whole subtree.
          // Rows remain with vault/parent/placements intact for later restore;
          // every read path excludes pages with a sidecar row so it disappears everywhere.
          const { softDeleteLibrarySubtree } = await import("./library-domain");
          const { trashedCount } = await softDeleteLibrarySubtree(principal, resolved.id);
          if (trashedCount === 0) return { result: `Library page "${id}" not found.`, error: true };
          publishLibraryChanged("deleted", { id: resolved.id, title: resolved.title });
          const subtreeNote = trashedCount > 1 ? ` (with ${trashedCount - 1} descendant page${trashedCount - 1 > 1 ? "s" : ""})` : "";
          return { result: `Library page "${resolved.title}" moved to Trash${subtreeNote}.` };
        } catch (err: any) {
          if (isSerializationConflict(err)) {
            toolExec.warn(`delete_library_page: serialization conflict (page=${resolved.id}) — retryable: ${err.message}`);
            return { result: `Library write conflicted with a concurrent reorder, please retry: ${err.message}`, error: true };
          }
          throw err;
        }
      }



      if (action === "link_pages") {
        const fromPageId = args.fromPageId || args.sourceId;
        const toPageId = args.toPageId || args.targetId;
        if (!fromPageId || !toPageId) {
          return {
            result: "Provide fromPageId and toPageId to link pages.",
            error: true,
            failure: inputFailure("library_input_invalid", "missing_link_endpoints"),
          };
        }
        if (fromPageId === toPageId) {
          return {
            result: "fromPageId and toPageId must be different pages.",
            error: true,
            failure: inputFailure("library_input_invalid", "self_link"),
          };
        }

        const resolveVisiblePageId = async (idOrSlug: string): Promise<string | null> => {
          const byId = await db
            .select({ id: libraryPages.id })
            .from(libraryPages)
            .where(visibleLib(eq(libraryPages.id, idOrSlug)))
            .limit(1);
          if (byId[0]) return byId[0].id;
          const bySlug = await db
            .select({ id: libraryPages.id })
            .from(libraryPages)
            .where(visibleLib(eq(libraryPages.slug, idOrSlug)))
            .limit(1);
          return bySlug[0]?.id ?? null;
        };

        const sourcePageId = await resolveVisiblePageId(String(fromPageId));
        if (!sourcePageId) {
          return {
            result: `Source library page "${fromPageId}" not found.`,
            error: true,
            failure: inputFailure("library_input_invalid", "source_not_found"),
          };
        }
        const targetPageId = await resolveVisiblePageId(String(toPageId));
        if (!targetPageId) {
          return {
            result: `Target library page "${toPageId}" not found.`,
            error: true,
            failure: inputFailure("library_input_invalid", "target_not_found"),
          };
        }

        const linkPrincipal = principal;
        const { ownedInsertValues: ownedInsertForLink } = await import("./scoped-storage");
        const linkScopeColumns = {
          scope: libraryPageLinks.scope,
          ownerUserId: libraryPageLinks.ownerUserId,
          accountId: libraryPageLinks.accountId,
        };
        // uk_library_page_links is (source, target) only — retries and dual writers
        // must converge without throwing. Match HTTP PATCH + library-link-graph.
        const inserted = await db
          .insert(libraryPageLinks)
          .values({
            sourcePageId,
            targetPageId,
            ...ownedInsertForLink(linkPrincipal, linkScopeColumns),
            createdByUserId: linkPrincipal.userId ?? undefined,
            updatedByUserId: linkPrincipal.userId ?? undefined,
          })
          .onConflictDoNothing()
          .returning({ id: libraryPageLinks.id });

        if (inserted[0]) {
          return {
            result: `Pages linked: ${sourcePageId} → ${targetPageId} (link id: ${inserted[0].id})`,
          };
        }

        const [existing] = await db
          .select({ id: libraryPageLinks.id })
          .from(libraryPageLinks)
          .where(
            and(
              eq(libraryPageLinks.sourcePageId, sourcePageId),
              eq(libraryPageLinks.targetPageId, targetPageId),
            ),
          )
          .limit(1);
        if (existing) {
          return {
            result: `Pages already linked: ${sourcePageId} → ${targetPageId} (link id: ${existing.id})`,
          };
        }
        return {
          result: `Unable to link pages ${sourcePageId} → ${targetPageId}.`,
          error: true,
          failure: inputFailure("library_input_invalid", "link_not_created"),
        };
      }

      if (action === "annotate") {
        const id = args.id;
        const content = args.content;
        if (!id || !content) return { result: "Provide id or slug and content for annotation.", error: true };
        const byId = await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug }).from(libraryPages).where(visibleLib(eq(libraryPages.id, id)));
        const page = byId[0] || (await db.select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug }).from(libraryPages).where(visibleLib(eq(libraryPages.slug, id))))[0];
        if (!page) return { result: `Library page "${id}" not found.`, error: true };
        const annotationType = args.annotationType || "observation";
        const { requireCurrentPrincipal: getPrincipalForAnnotation } = await import("./principal-context");
        const { ownedInsertValues: ownedInsertForAnnotation } = await import("./scoped-storage");
        const annotationScopeColumns = { scope: libraryAnnotations.scope, ownerUserId: libraryAnnotations.ownerUserId, accountId: libraryAnnotations.accountId };
        const [annotation] = await db.insert(libraryAnnotations).values({
          pageId: page.id,
          content,
          annotationType,
          ...ownedInsertForAnnotation(getPrincipalForAnnotation(), annotationScopeColumns),
        }).returning();
        return { result: `Annotation added to page [${page.id}] **${page.title}**: [${annotation.annotationType}] ${annotation.content}` };
      }

      return { result: `Unknown library action: ${action}. Available: list_library_pages, get_library_page, create_library_page, update_library_page, edit_library_page, dismiss_library_page, delete_library_page, search_library_pages, search, browse_tree, tree, list_vaults, link_pages, annotate`, error: true };
    } catch (err: any) {
      return { result: `library tool error: ${err.message}`, error: true };
    }
  },

  async images(args: Record<string, any>): Promise<ToolHandlerResult> {
    const { createLogger } = await import("./log");
    const log = createLogger("Images");
    const action = args.action;
    if (!action) return { result: "Missing action parameter. Use: generate, edit, or analyze", error: true };

    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      async generate(a) {
        const prompt = a.prompt;
        if (!prompt) return { result: "Missing prompt for image generation", error: true };
        const size = a.size || "1024x1024";
        const quality = a.quality;
        const background = a.background;
        const outputFormat = a.outputFormat || "png";

        // Validate size
        if (size && size !== "1024x1024") {
          const match = size.match(/^(\d+)x(\d+)$/);
          if (!match) return { result: "Invalid size format. Use WIDTHxHEIGHT, e.g. 1920x1080", error: true };
          const [, wStr, hStr] = match;
          const w = parseInt(wStr);
          const h = parseInt(hStr);
          if (w % 16 !== 0 || h % 16 !== 0) return { result: `Invalid size: both dimensions must be divisible by 16. ${w}%16=${w % 16}, ${h}%16=${h % 16}`, error: true };
          if (w > 4096 || h > 4096) return { result: `Size too large: max 4096px per edge. Got ${w}x${h}`, error: true };
          const ratio = Math.max(w, h) / Math.min(w, h);
          if (ratio > 3) return { result: `Aspect ratio too extreme: max 3:1. Got ${ratio.toFixed(1)}:1`, error: true };
        }

        log.debug(`[Images] generate: prompt="${prompt.slice(0, 80)}" size=${size} quality=${quality || "auto"} format=${outputFormat}`);
        try {
          const { generateImageBuffer } = await import("./integrations/image/client");
          const buffer = await generateImageBuffer(prompt, { size, quality, background, outputFormat });

          const ext = outputFormat === "jpeg" ? ".jpg" : `.${outputFormat}`;
          const contentType = outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";
          const fileName = `generated-image${ext}`;

          const { objectPath } = await objectStorageService.uploadObjectEntity(buffer, {
            extension: ext,
            contentType,
            acl: { owner: "system", visibility: "public" },
          });
          const downloadLink = `${objectPath}?name=${encodeURIComponent(fileName)}`;
          log.debug(`[Images] generate complete: ${buffer.length} bytes → ${downloadLink}`);
          // Auto-register in media registry
          try {
            const [{ registerMediaItem }, { requireCurrentPrincipal }] = await Promise.all([
              import("./media/media-storage"),
              import("./principal-context"),
            ]);
            await registerMediaItem({
              name: fileName,
              mediaType: "image",
              source: "generated",
              objectPath,
              mimeType: contentType,
              fileSize: buffer.length,
              width: parseInt(size.split("x")[0]) || 1024,
              height: parseInt(size.split("x")[1]) || 1024,
              metadata: { prompt: prompt.slice(0, 500) },
            }, requireCurrentPrincipal());
          } catch (regErr: any) {
            log.warn(`[Images] media registry write failed: ${regErr.message}`);
          }
          return { result: `![${fileName}](${downloadLink})\n[Download](${downloadLink})` };
        } catch (err: any) {
          log.error(`[Images] generate error: ${err.message}`);
          return { result: `Image generation failed: ${err.message}`, error: true };
        }
      },

      async edit(a) {
        const prompt = a.prompt;
        const imagePaths: string[] = a.images;
        if (!prompt) return { result: "Missing prompt for image editing", error: true };
        if (!imagePaths || !Array.isArray(imagePaths) || imagePaths.length === 0) {
          return { result: "Missing images array (workspace file paths) for image editing", error: true };
        }
        const outputFormat = a.outputFormat || "png";
        log.debug(`[Images] edit: prompt="${prompt.slice(0, 80)}" images=${imagePaths.length} format=${outputFormat}`);
        try {
          const path = await import("path");
          const fsp = (await import("fs")).promises;
          const os = await import("os");
          const tempFiles: string[] = [];

          // Resolve paths: object storage paths get downloaded to temp files,
          // local paths get resolved normally
          const absolutePaths = await Promise.all(imagePaths.map(async (p: string) => {
            if (p.startsWith("/objects/")) {
              const cleanPath = p.split("?")[0];
              const objectFile = await objectStorageService.getObjectEntityFile(cleanPath);
              const [downloaded] = await objectFile.download();
              const buf = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
              const ext = path.default.extname(cleanPath) || ".png";
              const tmpPath = path.default.join(os.tmpdir(), `img-edit-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
              await fsp.writeFile(tmpPath, buf);
              tempFiles.push(tmpPath);
              log.debug(`[Images] edit: downloaded object storage ${p} → ${tmpPath} (${buf.length} bytes)`);
              return tmpPath;
            }
            return path.default.isAbsolute(p) ? p : path.default.resolve(path.default.join(WORKSPACE_DIR, p));
          }));

          const { editImages } = await import("./integrations/image/client");
          let buffer: Buffer;
          try {
            buffer = await editImages(absolutePaths, prompt);
          } finally {
            // Clean up temp files
            for (const tmp of tempFiles) {
              fsp.unlink(tmp).catch(() => {});
            }
          }

          const ext = outputFormat === "jpeg" ? ".jpg" : `.${outputFormat}`;
          const contentType = outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";
          const fileName = `edited-image${ext}`;

          const { objectPath } = await objectStorageService.uploadObjectEntity(buffer, {
            extension: ext,
            contentType,
            acl: { owner: "system", visibility: "public" },
          });
          const downloadLink = `${objectPath}?name=${encodeURIComponent(fileName)}`;
          log.debug(`[Images] edit complete: ${buffer.length} bytes → ${downloadLink}`);
          // Auto-register in media registry
          try {
            const [{ registerMediaItem }, { requireCurrentPrincipal }] = await Promise.all([
              import("./media/media-storage"),
              import("./principal-context"),
            ]);
            await registerMediaItem({
              name: fileName,
              mediaType: "image",
              source: "generated",
              objectPath,
              mimeType: contentType,
              fileSize: buffer.length,
              metadata: { prompt: prompt.slice(0, 500) },
            }, requireCurrentPrincipal());
          } catch (regErr: any) {
            log.warn(`[Images] media registry write failed: ${regErr.message}`);
          }
          return { result: `![${fileName}](${downloadLink})\n[Download](${downloadLink})` };
        } catch (err: any) {
          log.error(`[Images] edit error: ${err.message}`);
          return { result: `Image editing failed: ${err.message}`, error: true };
        }
      },

      async analyze(a) {
        const prompt = a.prompt || "Analyze this image thoroughly. Cover the following:\n1. **Text & numbers**: Extract any visible text, labels, captions, watermarks, or numerical values verbatim.\n2. **Objects & subjects**: Identify key objects, people, animals, or landmarks. Note positions, scale, and spatial relationships between them.\n3. **Scene & context**: Describe the setting, environment, and what appears to be happening.\n4. **Colors & visual style**: Note dominant colors, palette, lighting, contrast, and whether it looks like a photo, illustration, screenshot, diagram, meme, etc.\n5. **Tone & composition**: Describe the mood, framing, perspective, and any artistic or design choices.\n6. **Notable details**: Call out anything unusual, subtle, or potentially significant that might be easy to miss.\nBe specific and concrete rather than vague. Quote text exactly as it appears. If something is ambiguous, say so.";
        const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
        log.debug(`[Images] analyze: prompt="${prompt.slice(0, 80)}"`);

        let imageBase64: string;
        let mediaType: string = a.mediaType || "image/png";

        try {
          if (a.path) {
            const pathMod = await import("path");
            const ext = pathMod.default.extname(a.path).toLowerCase();
            mediaType = ext === ".png" ? "image/png"
              : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
              : ext === ".gif" ? "image/gif"
              : ext === ".webp" ? "image/webp"
              : mediaType;

            let fileBuf: Buffer;
            if (a.path.startsWith("/objects/")) {
              // Read from object storage (R2)
              const cleanPath = a.path.split("?")[0];
              const objectFile = await objectStorageService.getObjectEntityFile(cleanPath);
              const [downloaded] = await objectFile.download();
              fileBuf = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded);
              log.debug(`[Images] analyze: read from object storage ${a.path} (${fileBuf.length} bytes)`);
            } else {
              // Read from local filesystem
              const fsp = (await import("fs")).promises;
              const absPath = pathMod.default.isAbsolute(a.path)
                ? a.path
                : pathMod.default.resolve(pathMod.default.join(WORKSPACE_DIR, a.path));
              fileBuf = await fsp.readFile(absPath);
              log.debug(`[Images] analyze: read file ${a.path} (${fileBuf.length} bytes)`);
            }

            if (fileBuf.length > MAX_IMAGE_SIZE) {
              return { result: `Image file too large (${(fileBuf.length / 1024 / 1024).toFixed(1)}MB, max 10MB)`, error: true };
            }
            imageBase64 = fileBuf.toString("base64");
          } else if (a.url) {
            log.debug(`[Images] analyze: fetching URL ${a.url}`);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000);
            try {
              const { fetchUntrustedUrl } = await import("./untrusted-url");
              const resp = await fetchUntrustedUrl(a.url, { signal: controller.signal });
              clearTimeout(timeout);
              if (!resp.ok) {
                return { result: `Failed to fetch image from URL: ${resp.status} ${resp.statusText}`, error: true };
              }
              const ct = resp.headers.get("content-type") || "";
              if (!ct.startsWith("image/")) {
                return { result: `URL does not point to an image (content-type: ${ct})`, error: true };
              }
              mediaType = ct.split(";")[0].trim();
              const arrayBuf = await resp.arrayBuffer();
              if (arrayBuf.byteLength > MAX_IMAGE_SIZE) {
                return { result: `Image from URL too large (${(arrayBuf.byteLength / 1024 / 1024).toFixed(1)}MB, max 10MB)`, error: true };
              }
              imageBase64 = Buffer.from(arrayBuf).toString("base64");
              log.debug(`[Images] analyze: fetched URL (${arrayBuf.byteLength} bytes)`);
            } catch (fetchErr: any) {
              clearTimeout(timeout);
              if (fetchErr.name === "AbortError") {
                return { result: "Image URL fetch timed out (30s)", error: true };
              }
              return { result: `Failed to fetch image: ${fetchErr.message}`, error: true };
            }
          } else if (a.base64) {
            imageBase64 = a.base64;
            log.debug(`[Images] analyze: using inline base64 (${a.base64.length} chars)`);
          } else {
            return { result: "Missing image source. Provide one of: path (workspace file), url (image URL), or base64 (raw data)", error: true };
          }

          // Route through the active connector pool. Multimodal image_url is supported by
          // openai / openai-subscription / grok-subscription / anthropic; claude-cli
          // flattens content via buildPrompt and will fail — model-client walks the
          // pool and surfaces the first successful connector (or the last error).
          const dataUrl = `data:${mediaType};base64,${imageBase64}`;
          const { chatCompletion } = await import("./model-client");
          const activity = (await import("./job-profiles")).ACTIVITY_MEDIA;
          const depthTier =
            a.depth === "deep" ? "max" as const
              : a.depth === "quick" ? "fast" as const
                : undefined;
          const visionMessages = [
            { role: "user" as const, content: [
              { type: "image_url" as const, image_url: { url: dataUrl } },
              { type: "text" as const, text: prompt },
            ] },
          ];
          log.debug(
            `[Images] analyze: connector pool activity=${activity}` +
            `${depthTier ? ` tier=${depthTier}` : " tier=persona/default"}`,
          );
          const completion = await chatCompletion({
            activity,
            ...(depthTier
              ? {
                  semanticTierOverride: depthTier,
                  overrideReason: `images.analyze depth=${a.depth} maps to semantic tier ${depthTier}`,
                }
              : {}),
            metadata: { source: "bridge-tool", toolName: "images.analyze", activity },
            maxTokens: 4000,
            messages: visionMessages,
          });
          const description = completion.content.trim() || "Unable to describe image";
          log.debug(`[Images] analyze complete: ${description.length} chars`);
          let result = description;
          const objectPath = typeof a.path === "string" ? a.path.split("?")[0] : "";
          if (objectPath.startsWith("/objects/uploads/")) {
            try {
              const {
                deriveUploadDisplayName,
                renameUploadResourceDisplayName,
              } = await import("./upload-resource-service");
              const currentName = objectPath.split("/").pop() || objectPath;
              const renamed = await renameUploadResourceDisplayName({
                objectPath,
                name: deriveUploadDisplayName(description, currentName),
              });
              if (renamed && renamed.previousName !== renamed.name) {
                result = `${description}\n\nRenamed in Files to ${renamed.name}.`;
              }
            } catch (renameErr: any) {
              log.warn(`[Images] upload rename skipped: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`);
            }
          }
          return { result };
        } catch (err: any) {
          log.error(`[Images] analyze error: ${err.message}`);
          return { result: `Image analysis failed: ${err.message}`, error: true };
        }
      },
    };

    const handler = sub[action];
    if (!handler) return { result: `Unknown images action: ${action}. Available: generate, edit, analyze`, error: true };
    return handler(args);
  },

  async captures(args: Record<string, any>): Promise<ToolHandlerResult> {
    const { db } = await import("./db");
    const { captures } = await import("@shared/schema");
    const { desc, gte, eq, and, sql } = await import("drizzle-orm");

    const action = args.action;
    if (!action) return { result: "Missing action. Available: list, reclassify, digest", error: true };

    try {
      if (action === "list") {
        const status = args.status;
        const limit = Math.min(args.limit || 50, 200);
        const conditions: any[] = [];
        if (status) conditions.push(eq(captures.status, status));
        if (args.since) {
          const sinceDate = new Date(args.since);
          if (!isNaN(sinceDate.getTime())) conditions.push(gte(captures.createdAt, sinceDate));
        }
        const where = conditions.length > 0
          ? conditions.length === 1 ? conditions[0] : and(...conditions)
          : undefined;
        const rows = await db.select().from(captures).where(where).orderBy(desc(captures.createdAt)).limit(limit);
        if (rows.length === 0) return { result: "No captures found." };
        const lines = rows.map(c =>
          `- [${c.status}] "${c.rawText.slice(0, 80)}" → ${c.classifiedType || "unclassified"} (confidence: ${c.classificationConfidence ?? "n/a"}, routed: ${c.routedTo || "n/a"})`
        );
        return { result: `${rows.length} capture(s):\n${lines.join("\n")}` };
      }

      if (action === "reclassify") {
        const id = args.id;
        const type = args.type;
        if (!id || !type) return { result: "Provide id and type for reclassify.", error: true };
        const [existing] = await db.select().from(captures).where(eq(captures.id, id));
        if (!existing) return { result: `Capture ${id} not found.`, error: true };
        await db.update(captures).set({ classifiedType: type, status: "pending", errorMessage: null, processedAt: null }).where(eq(captures.id, id));
        const { eventBus: eb } = await import("./event-bus");
        eb.publish({ category: "system", event: "capture.created", payload: { captureId: id, reclassify: true, overrideType: type, context: args.context } });
        return { result: `Capture ${id} set to reclassify as "${type}".` };
      }

      if (action === "digest") {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const rows = await db.select().from(captures).where(gte(captures.createdAt, since)).orderBy(desc(captures.createdAt));
        if (rows.length === 0) return { result: "No captures in the last 24 hours." };
        const routed = rows.filter(c => c.status === "routed");
        const manual = rows.filter(c => c.status === "manual");
        const failed = rows.filter(c => c.status === "failed");
        const pending = rows.filter(c => c.status === "pending" || c.status === "processing");
        const parts = [`## Quick Captures (last 24h)\n`, `**Routed:** ${routed.length} | **Manual:** ${manual.length} | **Failed:** ${failed.length} | **Pending:** ${pending.length}\n`];
        if (routed.length > 0) {
          parts.push("### Auto-routed");
          routed.forEach(c => parts.push(`- ✅ "${c.rawText.slice(0, 80)}" → ${c.routedTo} (${c.classifiedType})`));
        }
        if (manual.length > 0) {
          parts.push("\n### Needs your input");
          manual.forEach(c => parts.push(`- ❓ "${c.rawText.slice(0, 80)}" — ${c.classifiedType || "unclassified"} (${c.classificationConfidence?.toFixed(2) ?? "n/a"} confidence)`));
        }
        if (failed.length > 0) {
          parts.push("\n### Failed");
          failed.forEach(c => parts.push(`- ❌ "${c.rawText.slice(0, 80)}" — ${c.errorMessage || "unknown error"}`));
        }
        return { result: parts.join("\n") };
      }

      return { result: `Unknown captures action: ${action}. Available: list, reclassify, digest`, error: true };
    } catch (err: any) {
      return { result: `Captures tool error: ${err.message}`, error: true };
    }
  },

  async hooks(args) {
    const action = args.action;
    if (!action) return { result: "Missing 'action' parameter. Available: list, get, create, update, delete, test", error: true };

    try {
      const hookStorage = await import("./hook-storage");
      const { hookExecutor } = await import("./hook-executor");

      if (action === "list") {
        const hooks = await hookStorage.listHooks();
        return { result: safeStringify({ total: hooks.length, hooks: hooks.map(h => ({ id: h.id, name: h.name, eventPattern: h.eventPattern, actionType: h.actionType, enabled: h.enabled, cooldownSeconds: h.cooldownSeconds, maxFirings: h.maxFirings })) }, { label: "bridge.hooks.list" }) };
      }

      if (action === "get") {
        const id = args.id as number | undefined;
        const name = args.name as string | undefined;
        let hook;
        if (id) {
          hook = await hookStorage.getHook(id);
        } else if (name) {
          hook = await hookStorage.getHookByName(name);
        } else {
          return { result: "Missing 'id' or 'name' parameter", error: true };
        }
        if (!hook) return { result: "Hook not found", error: true };
        const executions = await hookStorage.getExecutions(hook.id, 5);
        return { result: safeStringify({ hook, recentExecutions: executions }, { label: "bridge.hooks.detail" }) };
      }

      if (action === "create") {
        if (!args.name || !args.eventPattern || !args.actionType || !args.actionConfig) {
          return { result: "Missing required fields: name, eventPattern, actionType, actionConfig", error: true };
        }
        if (!["run_skill", "initiate_conversation", "tool_call"].includes(args.actionType)) {
          return { result: "actionType must be one of: run_skill, initiate_conversation, tool_call", error: true };
        }
        const hook = await hookStorage.createHook({
          name: args.name as string,
          description: args.description as string | undefined,
          eventPattern: args.eventPattern as string,
          condition: args.condition,
          actionType: args.actionType as string,
          actionConfig: typeof args.actionConfig === "string" ? JSON.parse(args.actionConfig) : args.actionConfig,
          cooldownSeconds: args.cooldownSeconds as number | undefined,
          enabled: args.enabled !== false,
          maxFirings: args.maxFirings as number | undefined ?? null,
          createdBy: args.createdBy as string || getInstanceName(),
        });
        hookExecutor.invalidateCache();
        return { result: JSON.stringify({ created: true, hook: { id: hook.id, name: hook.name, eventPattern: hook.eventPattern, actionType: hook.actionType } }) };
      }

      if (action === "update") {
        const id = args.id as number;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const updateData: any = {};
        if (args.name !== undefined) updateData.name = args.name;
        if (args.description !== undefined) updateData.description = args.description;
        if (args.eventPattern !== undefined) updateData.eventPattern = args.eventPattern;
        if (args.condition !== undefined) updateData.condition = args.condition;
        if (args.actionType !== undefined) updateData.actionType = args.actionType;
        if (args.actionConfig !== undefined) updateData.actionConfig = typeof args.actionConfig === "string" ? JSON.parse(args.actionConfig) : args.actionConfig;
        if (args.cooldownSeconds !== undefined) updateData.cooldownSeconds = args.cooldownSeconds;
        if (args.enabled !== undefined) updateData.enabled = args.enabled;
        if (args.maxFirings !== undefined) updateData.maxFirings = args.maxFirings;
        const hook = await hookStorage.updateHook(id, updateData);
        if (!hook) return { result: "Hook not found", error: true };
        hookExecutor.invalidateCache();
        return { result: JSON.stringify({ updated: true, hook: { id: hook.id, name: hook.name, enabled: hook.enabled } }) };
      }

      if (action === "delete") {
        const id = args.id as number;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const existing = await hookStorage.getHook(id);
        if (!existing) return { result: "Hook not found", error: true };
        await hookStorage.deleteHook(id);
        hookExecutor.invalidateCache();
        return { result: JSON.stringify({ deleted: true, name: existing.name }) };
      }

      if (action === "test") {
        const hookId = args.id as number | undefined;
        const eventId = args.eventId as string | undefined;
        if (!hookId) return { result: "Missing 'id' parameter (hook ID)", error: true };
        const hook = await hookStorage.getHook(hookId);
        if (!hook) return { result: "Hook not found", error: true };

        let testEvent: any;
        if (eventId) {
          const { requireCurrentPrincipal } = await import("./principal-context");
          const eventPrincipal = requireCurrentPrincipal();
          const recentEvents = eventBus.getRecentEvents(500, undefined, eventPrincipal);
          testEvent = recentEvents.find(e => e.id === eventId);
          if (!testEvent) return { result: "Event not found in current process buffer", error: true };
        } else {
          testEvent = {
            id: "test-event",
            timestamp: Date.now(),
            category: "test",
            event: args.testEvent || "test.event",
            payload: args.testPayload || {},
            bootId: eventBus.bootId,
          };
        }

        const result = hookExecutor.testHook(
          { eventPattern: hook.eventPattern, condition: hook.condition, actionConfig: hook.actionConfig },
          testEvent
        );
        return { result: JSON.stringify({ hook: { id: hook.id, name: hook.name }, event: { id: testEvent.id, event: testEvent.event }, ...result }) };
      }

      return { result: `Unknown hooks action: ${action}. Available: list, get, create, update, delete, test`, error: true };
    } catch (err: any) {
      const failure = toolFailureFromError(err);
      if (failure?.code === "hook_name_conflict") {
        return {
          result: `Hook name already exists. Choose a different name or update the existing hook. (${err.message})`,
          error: true,
          failure,
        };
      }
      return {
        result: `Hooks tool error: ${err.message}`,
        error: true,
        ...(failure ? { failure } : {}),
      };
    }
  },

};

export async function executeBridgeTool(
  toolName: string,
  toolCallId: string,
  args: Record<string, any>,
  context?: BridgeToolContext,
): Promise<{ result: string; error?: boolean; data?: Record<string, unknown>; failure?: ToolFailure }> {
  const result = await executeTool(toolName, toolCallId, args, context);
  // Propagate the optional structured `data` payload (e.g. park_idea
  // returns { parked: true, id }) so consumers of executeBridgeTool can
  // do machine-readable handling instead of parsing the result string.
  return { result: result.result, error: result.error, data: result.data, failure: result.failure };
}


const SHELL_DENYLIST = [
  /\brm\s+-[^\s]*r[^\s]*f\b/i,
  /\brm\s+-[^\s]*f[^\s]*r\b/i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bformat\s+(c:|\/dev\/)/i,
  /\bmkfs\b/i,
  /\bdd\s+.*\bof=\/dev\//i,
  />\s*\/dev\/(sda|hda|nvme|vda)/i,
  /\bshred\b/i,
  /\bfdisk\b/i,
];

// Task #1007 step 6: shell stdout/stderr stream to per-call temp files
// under WORKSPACE_DIR/.tmp/shell so the main heap never holds the full
// output. Threshold for triggering off-thread indexing matches the prior
// behaviour (>30 KB triggers the indexer; smaller is returned inline).
const SHELL_TMP_DIR = join(WORKSPACE_DIR, ".tmp", "shell");
const SHELL_HOME_DIR = join(SHELL_TMP_DIR, "home");
const SHELL_INDEX_THRESHOLD_BYTES = 30_000;

function createIsolatedShellEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: SHELL_HOME_DIR,
    TMPDIR: SHELL_TMP_DIR,
    XDG_CONFIG_HOME: join(SHELL_HOME_DIR, ".config"),
    XDG_CACHE_HOME: join(SHELL_HOME_DIR, ".cache"),
    XDG_DATA_HOME: join(SHELL_HOME_DIR, ".local", "share"),
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
    TZ: process.env.TZ || "UTC",
    CI: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: "/dev/null",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    npm_config_userconfig: "/dev/null",
    ENABLE_DB_CLEANUP: "false",
  };
}
const SHELL_INDEX_CHUNK_SIZE = 80_000;
let _shellTmpDirEnsured = false;
async function ensureShellTmpDir(): Promise<void> {
  if (_shellTmpDirEnsured) return;
  await mkdir(SHELL_HOME_DIR, { recursive: true });
  _shellTmpDirEnsured = true;
}

function newShellCallId(): string {
  return `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellCmdPreview(cmd: string, max = 200): string {
  // Strict ≤max output — slice to max-1 before appending the single-char
  // ellipsis so a "max=120" preview never produces a 121-char string.
  const trimmed = cmd.length > max ? cmd.slice(0, max - 1) + "…" : cmd;
  return JSON.stringify(trimmed);
}

// Task #1007 step 7: run the indexer's CPU/string-heavy prep work in a
// worker thread, then do the network/DB I/O on main with a small payload.
// The worker resolves the temp file's path itself and never sends the
// full content back to main.
async function runShellIndexWorker(filePath: string): Promise<{ ok: true; byteCount: number; headChunk: string; totalChars: number } | { ok: false; error: string }> {
  const path = await import("path");
  const fs = await import("fs");
  const { fileURLToPath } = await import("url");
  const { Worker } = await import("worker_threads");
  // Resolve worker artifact relative to *this* module's dir, the same
  // way heartbeat-worker is resolved in server/index.ts. In dev (tsx)
  // the .ts source is loaded directly; in prod the bundle ships
  // dist/shell-index-worker.mjs (see script/build.ts). Use
  // fileURLToPath rather than URL.pathname so encoded characters and
  // non-Linux path conventions decode correctly.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tsPath = path.join(here, "shell-index-worker.ts");
  const mjsPath = path.join(here, "shell-index-worker.mjs");
  const jsPath = path.join(here, "shell-index-worker.js");
  let workerPath: string | null = null;
  if (fs.existsSync(tsPath)) workerPath = tsPath;
  else if (fs.existsSync(mjsPath)) workerPath = mjsPath;
  else if (fs.existsSync(jsPath)) workerPath = jsPath;
  if (!workerPath) {
    return { ok: false, error: `shell-index-worker artifact not found in ${here}` };
  }
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (r: { ok: true; byteCount: number; headChunk: string; totalChars: number } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    try {
      const worker = new Worker(workerPath!, {
        workerData: { filePath, indexChunkSize: SHELL_INDEX_CHUNK_SIZE },
      });
      worker.once("message", (msg: any) => {
        if (msg && msg.ok === true && typeof msg.headChunk === "string") {
          settle({ ok: true, byteCount: Number(msg.byteCount) || 0, headChunk: msg.headChunk, totalChars: Number(msg.totalChars) || 0 });
        } else {
          settle({ ok: false, error: String(msg?.error || "unknown worker error") });
        }
      });
      worker.once("error", (err) => {
        settle({ ok: false, error: `worker_error:${err?.message || String(err)}` });
      });
      worker.once("exit", (code) => {
        if (code !== 0) settle({ ok: false, error: `worker_exit:${code}` });
      });
    } catch (err: any) {
      settle({ ok: false, error: `worker_spawn_failed:${err?.message || String(err)}` });
    }
  });
}


function formatContextHealthNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatContextHealthLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function formatContextHealthSummary(summary: import("@shared/context-health").ContextHealthSummary): string {
  return JSON.stringify({
    generatedAt: summary.generatedAt,
    windowHours: summary.windowHours,
    rowLimit: summary.rowLimit,
    scope: summary.measurementContract.scope,
    source: summary.measurementContract.source,
    comparablePopulation: summary.measurementContract.comparablePopulation,
    contextTokenDefinition: summary.measurementContract.contextTokenDefinition,
    budgetContract: summary.measurementContract.budgets,
    rows: {
      total: summary.callCount,
      comparable: summary.comparableCallCount,
      excluded: summary.excludedCallCount,
      callsPerHour: summary.callsPerHour,
    },
    contextTokensComparableOnly: {
      average: summary.avgContextTokens,
      median: summary.medianContextTokens,
      p95: summary.p95ContextTokens,
      max: summary.maxContextTokens,
      display: `${formatContextHealthNumber(summary.medianContextTokens)} median / ${formatContextHealthNumber(summary.p95ContextTokens)} p95 / ${formatContextHealthNumber(summary.maxContextTokens)} max`,
      note: "Only per-call rows with known context windows and in-window context tokens are included. Non-comparable CLI cumulative counters are excluded and never reported as prompt/context size.",
      contextWindowSource: summary.measurementContract.contextWindowSource,
      distribution: summary.contextTokenDistribution,
    },
    exclusions: {
      contract: summary.measurementContract.exclusions,
      observed: summary.exclusionReasons.map((reason) => ({
        reason: formatContextHealthLabel(reason.reason),
        count: reason.count,
      })),
    },
    providerTtfp: {
      sampleCount: summary.ttfpSampleCount,
      averageMs: summary.avgTtfpMs,
      p95Ms: summary.p95TtfpMs,
      p95BudgetMs: summary.budgets.providerTtfpP95Ms,
      note: "Time to first progress (thinking, text, or tool-use) — primary felt-latency budget.",
    },
    providerTtft: {
      sampleCount: summary.ttftSampleCount,
      averageMs: summary.avgTtftMs,
      p95Ms: summary.p95TtftMs,
      p95BudgetMs: summary.budgets.providerTtftP95Ms,
      note: "Time to first visible text token — secondary metric.",
    },
    outcomes: {
      success: summary.successCount,
      error: summary.errorCount,
      aborted: summary.abortedCount,
      partial: summary.partialCount,
      errorRate: summary.errorRate,
    },
    providerCoverage: summary.byProvider.map((row) => ({
      provider: row.provider,
      rows: row.callCount,
      comparableRows: row.comparableCallCount,
      excludedRows: row.excludedCallCount,
      exclusions: row.exclusionReasons.map((reason) => ({ reason: formatContextHealthLabel(reason.reason), count: reason.count })),
    })),
    modelRows: summary.byModel.map((row) => ({
      provider: row.provider,
      model: row.model,
      tier: row.tier,
      reasoningEffort: row.reasoningEffort,
      reasoningSourceKind: row.reasoningSourceKind,
      usageSemantics: row.usageSemantics,
      contextWindow: row.contextWindow,
      contextWindowStatus: row.contextWindowStatus,
      exclusionReasons: row.exclusionReasons.map((reason) => ({ reason: formatContextHealthLabel(reason.reason), count: reason.count })),
      rows: row.callCount,
      comparableRows: row.comparableCallCount,
      excludedRows: row.excludedCallCount,
      contextTokensComparableOnly: {
        average: row.avgContextTokens,
        median: row.medianContextTokens,
        p95: row.p95ContextTokens,
        max: row.maxContextTokens,
      },
      avgTtfpMs: row.avgTtfpMs,
      avgTtftMs: row.avgTtftMs,
    })),
    raw: summary,
  });
}

const systemTools: Record<string, ToolHandler> = {
  async shell(args) {
    const command = args.command;
    if (!command) return { result: "Missing command", error: true };

    const timeoutMs = Math.min(args.timeout || 30000, 120000);

    const { validateShellCommand, shellDenialGuidance } = await import("./agent-authority");
    const shellPolicy = validateShellCommand(command);
    if (!shellPolicy.allowed) {
      eventBus.publish({ category: "agent", event: "tool:shell_denied", payload: { reason: shellPolicy.reason } });
      // Teaching denial: name the sanctioned alternative alongside the machine reason so a rejected
      // call adapts instead of thrashing on variants. Guidance is sourced from agent-authority,
      // colocated with the policy that emits the reason — never hand-authored here, which drifts.
      const guidance = shellDenialGuidance(shellPolicy.reason);
      const denyDetail = guidance
        ? `Shell command blocked by deterministic allowlist: ${shellPolicy.reason}. ${guidance}`
        : `Shell command blocked by deterministic allowlist: ${shellPolicy.reason}`;
      return {
        result: denyDetail,
        error: true,
        failure: inputFailure("shell_policy_denied", shellPolicy.reason),
      };
    }

    const deniedPattern = SHELL_DENYLIST.find(pat => pat.test(command));
    if (deniedPattern) {
      eventBus.publish({
        category: "agent",
        event: "tool:shell_denied",
        payload: { command, reason: "destructive_pattern", pattern: deniedPattern.toString() },
      });
      return {
        result: `Shell command blocked: matches destructive-command denylist. Command requires explicit human confirmation before execution.`,
        error: true,
        failure: inputFailure("shell_policy_denied", "destructive_pattern"),
      };
    }

    // Git write vs read-only misuse is classified inside validateShellCommand
    // (git_write_blocked vs shell_git_read_only). Do not re-parse here — dual
    // admitters drift and collapse distinct recovery paths into one reason.

    eventBus.publish({
      category: "agent",
      event: "tool:shell_exec",
      payload: { command, timeoutMs },
    });

    // Task #1007 steps 3 + 6: every shell call emits three structured log
    // lines (dispatch, spawned, exit) and streams stdout/stderr to per-
    // call temp files instead of buffering 1 MB on the main heap. A
    // wedged shell tool now produces dispatch + spawned without an exit
    // line, so operators can identify the wedged command + pid from
    // logs alone (the gap that hid the bootId=molg5r37-3wwh wedge).
    const callId = newShellCallId();
    const startedAt = Date.now();
    await ensureShellTmpDir();
    const stdoutPath = join(SHELL_TMP_DIR, `${callId}.out`);
    const stderrPath = join(SHELL_TMP_DIR, `${callId}.err`);

    const fs = await import("fs");
    const fsp = await import("fs/promises");
    const { spawn } = await import("child_process");

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutStream = fs.createWriteStream(stdoutPath);
    const stderrStream = fs.createWriteStream(stderrPath);
    // Late writes after .end() are theoretically prevented by the
    // child.on("close") finalize trigger below, but in case any
    // straggling chunk does land we swallow the EPIPE / "write after
    // end" rather than letting it propagate as an uncaughtException.
    stdoutStream.on("error", (err: any) => toolExec.log(`[Shell] stdout write error callId=${callId} ${err?.message || err}`));
    stderrStream.on("error", (err: any) => toolExec.log(`[Shell] stderr write error callId=${callId} ${err?.message || err}`));

    toolExec.log(`[Shell] dispatch callId=${callId} cmd=${shellCmdPreview(command, 200)} cwd=${WORKSPACE_DIR} timeoutMs=${timeoutMs}`);

    return await new Promise<{ result: string; error?: boolean }>((resolveResult) => {
      let settled = false;
      let timedOut = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let child: import("child_process").ChildProcessWithoutNullStreams;
      try {
        child = spawn("/bin/sh", ["-c", command], {
          cwd: WORKSPACE_DIR,
          env: createIsolatedShellEnvironment(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        toolExec.log(`[Shell] exit callId=${callId} pid=- exitCode=- signal=- stdoutBytes=0 stderrBytes=0 elapsedMs=${Date.now() - startedAt} spawnError=${err?.message || String(err)}`);
        try { stdoutStream.end(); } catch {}
        try { stderrStream.end(); } catch {}
        fsp.unlink(stdoutPath).catch(() => {});
        fsp.unlink(stderrPath).catch(() => {});
        resolveResult({ result: `Shell spawn failed: ${err?.message || String(err)}`, error: true });
        return;
      }

      const pid = child.pid;
      toolExec.log(`[Shell] spawned callId=${callId} pid=${pid} cmd=${shellCmdPreview(command, 120)}`);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        stdoutStream.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderrStream.write(chunk);
      });

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch {}
      }, timeoutMs);

      const finalize = async (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }

        // Wait for both write streams to finish flushing so byte counts
        // and disk content are coherent before we read them back.
        await Promise.all([
          new Promise<void>((r) => stdoutStream.end(() => r())),
          new Promise<void>((r) => stderrStream.end(() => r())),
        ]);

        const elapsedMs = Date.now() - startedAt;
        toolExec.log(`[Shell] exit callId=${callId} pid=${pid} exitCode=${exitCode} signal=${signal ?? "null"} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes} elapsedMs=${elapsedMs}${timedOut ? " timedOut=true" : ""}`);

        try {
          // Infrastructure failure: timeout, signal kill, or missing exit
          // code (spawn/error path). These are tool failures.
          // Clean non-zero exits are NOT — rg/grep miss, git status 1, etc.
          // are process status the model must read, not is_error/reliability
          // failures. Keep the exit header + stdout/stderr body either way.
          if (timedOut) {
            const [stdoutText, stderrText] = await Promise.all([
              fsp.readFile(stdoutPath, "utf-8").catch(() => ""),
              fsp.readFile(stderrPath, "utf-8").catch(() => ""),
            ]);
            const output = [stdoutText.trim(), stderrText.trim()].filter(Boolean).join("\n");
            resolveResult({ result: `Command timed out after ${timeoutMs}ms\n${output}`.trim(), error: true });
            return;
          }
          if (signal || typeof exitCode !== "number") {
            const [stdoutText, stderrText] = await Promise.all([
              fsp.readFile(stdoutPath, "utf-8").catch(() => ""),
              fsp.readFile(stderrPath, "utf-8").catch(() => ""),
            ]);
            const output = [stdoutText.trim(), stderrText.trim()].filter(Boolean).join("\n");
            const header = signal
              ? `Command terminated by signal ${signal}`
              : `Command failed (exit ${exitCode ?? "?"})`;
            resolveResult({
              result: `${header}\n${output || ""}`.trim() || header,
              error: true,
            });
            return;
          }
          if (exitCode !== 0) {
            const [stdoutText, stderrText] = await Promise.all([
              fsp.readFile(stdoutPath, "utf-8").catch(() => ""),
              fsp.readFile(stderrPath, "utf-8").catch(() => ""),
            ]);
            const output = [stdoutText.trim(), stderrText.trim()].filter(Boolean).join("\n");
            // Tool contract fulfilled: process ran to completion. Exit status
            // is payload for the model — do not set error/is_error.
            resolveResult({
              result: `Command failed (exit ${exitCode})\n${output || ""}`.trim() || `Command failed (exit ${exitCode})`,
            });
            return;
          }

          // Success path. Stay off the main heap whenever the output
          // is large: route to the worker for read+trim+slice, then
          // archive via the streaming indexer. Below threshold, read
          // back inline (small payload — a few tens of KB at most).
          if (stdoutBytes > SHELL_INDEX_THRESHOLD_BYTES) {
            const workerResult = await runShellIndexWorker(stdoutPath);
            if (workerResult.ok) {
              const { indexAndArchiveFromFileWithFallback } = await import("./content-indexer");
              const refBlock = await indexAndArchiveFromFileWithFallback({
                filePath: stdoutPath,
                sourceType: "shell",
                sourceLabel: command.slice(0, 200),
                byteCount: workerResult.byteCount,
                headChunk: workerResult.headChunk,
                totalChars: workerResult.totalChars,
              });
              resolveResult({ result: refBlock });
              return;
            }
            // Worker failed — degrade gracefully by reading on main
            // (still better than wedging the call). This path is
            // exceptional; the warn surfaces it for diagnosis.
            toolExec.log(`[Shell] index worker failed callId=${callId} error=${workerResult.error} — falling back to main-thread indexing`);
            const stdoutText = await fsp.readFile(stdoutPath, "utf-8");
            const trimmed = stdoutText.trim();
            const { indexAndArchiveWithFallback } = await import("./content-indexer");
            const refBlock = await indexAndArchiveWithFallback({
              content: trimmed,
              sourceType: "shell",
              sourceLabel: command.slice(0, 200),
            });
            resolveResult({ result: refBlock });
            return;
          }

          const stdoutText = await fsp.readFile(stdoutPath, "utf-8");
          const trimmed = stdoutText.trim();
          resolveResult({ result: trimmed || "(no output)" });
        } catch (err: any) {
          resolveResult({ result: `Shell post-processing error: ${err?.message || String(err)}`, error: true });
        } finally {
          // Always unlink the temp files. Object storage upload (when
          // it happens) streams from disk inside indexAndArchiveFrom
          // FileWithFallback and completes before we get here, so it's
          // safe to delete now.
          fsp.unlink(stdoutPath).catch(() => {});
          fsp.unlink(stderrPath).catch(() => {});
        }
      };

      child.on("error", (err: any) => {
        toolExec.log(`[Shell] child error callId=${callId} pid=${pid} err=${err?.message || String(err)}`);
        // child.on("error") fires before "close" for spawn failures and
        // does not necessarily produce a close event afterwards.
        // Synthesize a finalize so we always emit one [Shell] exit line
        // and always release the temp files.
        void finalize(null, null);
      });
      // Use "close" rather than "exit" — Node fires "exit" the moment
      // the child process terminates, BEFORE the stdio "data" events
      // for any final chunks have been delivered. Finalizing on "exit"
      // races trailing output (truncated stdoutBytes / indexed
      // content) and risks "write after end" on the temp file streams.
      // "close" fires only after the process has ended AND its stdio
      // streams have been fully drained and closed, so byte counts
      // and on-disk content are coherent by the time finalize runs.
      child.on("close", (code, signal) => {
        void finalize(code, signal);
      });
    });
  },

  async indexed_content(args) {
    const action = args.action;
    if (!action) return { result: "Missing action. Available: list, get, read_section", error: true };

    try {
      const { db } = await import("./db");
      const { indexedContent } = await import("@shared/schema");
      const { desc, eq } = await import("drizzle-orm");
      const { requireCurrentPrincipal } = await import("./principal-context");
      const { combineWithSensitiveVisible } = await import("./sensitive-scope");
      const ownerColumns = {
        ownerUserId: indexedContent.ownerUserId,
        principalAccountId: indexedContent.principalAccountId,
        vaultId: indexedContent.vaultId,
      };
      const visible = (predicate?: SQL) =>
        combineWithSensitiveVisible(ownerColumns, predicate, requireCurrentPrincipal());

      switch (action) {
        case "list": {
          const limit = Math.min(args.limit || 20, 100);
          const predicate = args.sourceType
            ? eq(indexedContent.sourceType, args.sourceType)
            : undefined;
          const rows = await db.select({
            id: indexedContent.id,
            sourceType: indexedContent.sourceType,
            sourceLabel: indexedContent.sourceLabel,
            byteCount: indexedContent.byteCount,
            createdAt: indexedContent.createdAt,
          }).from(indexedContent)
            .where(visible(predicate))
            .orderBy(desc(indexedContent.createdAt))
            .limit(limit);
          if (rows.length === 0) return { result: "No indexed content found." };
          const lines = rows.map(r => `- [${r.id}] ${r.sourceType}: ${r.sourceLabel} (${r.byteCount.toLocaleString()} bytes, ${r.createdAt?.toISOString() || "unknown"})`);
          return { result: `${rows.length} indexed items:
${lines.join("\n")}` };
        }
        case "get": {
          const id = args.id;
          if (!id) return { result: "Missing id parameter", error: true };
          const rows = await db.select().from(indexedContent)
            .where(visible(eq(indexedContent.id, id)))
            .limit(1);
          if (rows.length === 0) return { result: `Indexed content "${id}" not found`, error: true };
          const row = rows[0];
          const idx = row.index as any;
          const parts: string[] = [];
          parts.push(`**${row.sourceType}: ${row.sourceLabel}**`);
          parts.push(`ID: ${row.id} | Size: ${row.byteCount.toLocaleString()} bytes | Created: ${row.createdAt?.toISOString() || "unknown"}`);
          if (idx?.keyFacts?.length > 0) {
            parts.push(`
**Key Facts:**`);
            for (const f of idx.keyFacts) parts.push(`- ${f}`);
          }
          if (idx?.sections?.length > 0) {
            parts.push(`
**Sections:**`);
            idx.sections.forEach((section: any, index: number) => {
              parts.push(`  ${index}. ${section.title} (offset: ${section.byteOffset}, length: ${section.byteLength})`);
              for (const fact of section.keyFacts || []) parts.push(`     - ${fact}`);
            });
          }
          if (idx?.identifiers?.length > 0) parts.push(`
**Identifiers:** ${idx.identifiers.join(", ")}`);
          return { result: parts.join("\n") };
        }
        case "read_section": {
          const id = args.id;
          if (!id) return { result: "Missing id parameter", error: true };
          const rows = await db.select().from(indexedContent)
            .where(visible(eq(indexedContent.id, id)))
            .limit(1);
          if (rows.length === 0) return { result: `Indexed content "${id}" not found`, error: true };
          const row = rows[0];
          let charOffset = args.charOffset as number | undefined;
          let charLength = args.charLength as number | undefined;
          if (args.sectionIndex !== undefined) {
            const idx = row.index as any;
            const section = idx?.sections?.[args.sectionIndex];
            if (!section) return { result: `Section index ${args.sectionIndex} not found (${idx?.sections?.length || 0} sections available)`, error: true };
            charOffset = section.byteOffset;
            charLength = section.byteLength;
          }
          const { readVisibleIndexedContent } = await import("./content-indexer");
          const archived = await readVisibleIndexedContent({ id, charOffset, charLength });
          if (!archived) return { result: `Failed to read indexed content "${id}"`, error: true };
          const content = archived.content;
          const maxDisplay = 50000;
          if (content.length > maxDisplay) {
            return { result: `Section content (${content.length} chars, showing first ${maxDisplay}):

${content.slice(0, maxDisplay)}

[Use charOffset/charLength for pagination — total section: ${content.length} chars]` };
          }
          return { result: content };
        }
        default:
          return { result: `Unknown action: ${action}. Available: list, get, read_section`, error: true };
      }
    } catch (err: any) {
      return { result: `indexed_content error: ${err.message}`, error: true };
    }
  },
};


function retiredLegacyMemoryAction(action: string, replacement: string): ToolHandlerResult {
  return {
    result: JSON.stringify({
      status: "retired",
      action,
      storage: "memory_entries",
      message: `Legacy memory action "${action}" has been retired because memory_entries is archived and no longer a runtime read/write surface.`,
      migration: replacement,
    }),
    error: true,
  };
}

async function recordMetacognitiveObservationTool(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { isMetacognitiveObservationType, recordMetacognitiveObservation } = await import("./memory/metacognitive-observations");
  const type = args.type;
  if (!isMetacognitiveObservationType(type)) {
    return { result: "Invalid type — must be one of: pattern, gap, change, connection, opportunity", error: true };
  }
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) {
    return { result: "Content is required and cannot be empty", error: true };
  }
  try {
    const observation = await recordMetacognitiveObservation({
      type,
      content,
      sessionId: typeof args._sessionId === "string" ? args._sessionId : null,
    });
    toolExec.log(`observe tool: recorded provisional claim id=${observation.claimId} type=${type}`);
    return { result: `Observation recorded (${type}): ${observation.id}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    toolExec.error(`observe tool failed: ${msg}`);
    return { result: `Failed to save observation: ${msg}`, error: true };
  }
}

const umbrellaHandlers: Record<string, ToolHandler> = {
  async scratch(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      read: workspaceTools.read_scratch,
      write: workspaceTools.write_scratch,
      edit: workspaceTools.edit_scratch,
      patch: async (input) => {
        try {
          const { applyScratchRepositoryPatch } = await import("./tools/scratch-patch");
          const result = await applyScratchRepositoryPatch({
            repositoryDirectory: String(input.repositoryDirectory || ""),
            patch: String(input.patch || ""),
            sessionId: String(input._sessionId || ""),
          });
          return { result: JSON.stringify(result) };
        } catch (error) {
          return {
            result: `Repository patch rejected: ${error instanceof Error ? error.message : String(error)}`,
            error: true,
            failure: inputFailure("scratch_patch_rejected"),
          };
        }
      },
      list: workspaceTools.list_scratch,
      search: workspaceTools.search_scratch,
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown scratch action: ${action}`, error: true };
    return handler(args);
  },
  async files(args) {
    const action = args.action;
    if (!action) {
      return contractReject("Missing action parameter", "files_input_invalid");
    }

    // Bound-drive file body: action=read with drive identity (not object-storage filePath).
    const isBoundDriveRead =
      action === "read" &&
      !args.filePath &&
      (args.driveResourceId || (args.provider && args.providerFileId));

    if (isBoundDriveRead) {
      const vaultId = typeof args.vaultId === "string" ? args.vaultId.trim() : undefined;
      const driveResourceId =
        typeof args.driveResourceId === "string" ? args.driveResourceId.trim() : undefined;
      const provider = typeof args.provider === "string" ? args.provider.trim() : undefined;
      const providerFileId =
        typeof args.providerFileId === "string" ? args.providerFileId.trim() : undefined;
      try {
        const { filesApi } = await import("./files-api");
        const payload = await filesApi.read({
          vaultId,
          driveResourceId,
          provider: provider as any,
          providerFileId,
        });
        // Completeness contract: sourceBytes/stagedBytes/complete/next are authoritative.
        // Inline text/base64 are previews only; full body is always via archive when next is set.
        const MAX_CHARS = 100_000;
        const text =
          typeof payload.text === "string" && payload.text.length > MAX_CHARS
            ? payload.text.slice(0, MAX_CHARS)
            : payload.text;
        const base64 =
          typeof payload.base64 === "string" && payload.base64.length > MAX_CHARS
            ? payload.base64.slice(0, MAX_CHARS)
            : payload.base64;
        return {
          result: JSON.stringify(
            {
              metadata: payload.metadata,
              contentType: payload.contentType,
              text,
              base64,
              sourceBytes: payload.sourceBytes,
              stagedBytes: payload.stagedBytes,
              byteLength: payload.byteLength,
              complete: payload.complete,
              truncated: payload.truncated || undefined,
              next: payload.next,
              cache: payload.cache,
              archive: payload.archive
                ? {
                    id: payload.archive.id,
                    byteCount: payload.archive.byteCount,
                    encoding: payload.archive.encoding,
                    encryption: payload.archive.encryption,
                    retrieval: payload.archive.retrieval,
                    reused: payload.archive.reused,
                  }
                : null,
            },
            null,
            2,
          ),
        };
      } catch (err: any) {
        return {
          result: `Bound-drive read failed: ${err.message}`,
          error: true,
          failure: classifyFilesToolError(err),
        };
      }
    }

    const sub: Record<string, ToolHandler> = {
      write: persistentFileHandlers.write_file,
      read: persistentFileHandlers.read_file,
      list: persistentFileHandlers.list_files,
      listBound: persistentFileHandlers.listBound,
      listChildren: persistentFileHandlers.listChildren,
      getMetadata: persistentFileHandlers.getMetadata,
      authorize: persistentFileHandlers.authorize,
    };
    const handler = sub[action];
    if (!handler) {
      return contractReject(
        `Unknown files action: ${action}`,
        "files_input_invalid",
      );
    }
    const result = await handler(args);
    // Record session artifact link for writes
    if (action === "write" && !result.error && result.result) {
      const { recordSessionArtifact } = await import("./session-artifacts");
      // Extract the object path from the result text
      const pathMatch = result.result.match(/\(([/]objects\/[^\s)]+)/);
      const objectPath = pathMatch?.[1] || args.fileName;
      recordSessionArtifact(args._sessionId, "file", objectPath, { fileName: args.fileName, contentType: args.contentType });
    }
    return result;
  },
  async pdf(args) {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (!action) {
      return contractReject("Missing action parameter", "pdf_input_invalid");
    }

    const sourceInput = {
      documentId: typeof args.documentId === "string" ? args.documentId.trim() : undefined,
      driveResourceId: typeof args.driveResourceId === "string" ? args.driveResourceId.trim() : undefined,
      provider: typeof args.provider === "string" ? args.provider.trim() : undefined,
      providerFileId: typeof args.providerFileId === "string" ? args.providerFileId.trim() : undefined,
      vaultId: typeof args.vaultId === "string" ? args.vaultId.trim() : undefined,
      objectPath: typeof args.objectPath === "string" ? args.objectPath.trim() : undefined,
      uploadId: typeof args.uploadId === "string" ? args.uploadId.trim() : undefined,
    };

    const classifyPdfError = (err: unknown): ToolFailure | undefined => {
      if (!err || typeof err !== "object") return undefined;
      const status = (err as { status?: unknown }).status;
      if (status === 401 || status === 403) return permissionFailure("pdf_access_denied", `http_${status}`);
      if (status === 408 || status === 429 || (typeof status === "number" && status >= 500)) {
        return transientFailure("pdf_provider_transient", `http_${status}`);
      }
      if (typeof status === "number" && status >= 400) {
        return inputFailure("pdf_input_invalid", `http_${status}`);
      }
      const filesFailure = classifyFilesToolError(err);
      if (filesFailure) return filesFailure;
      return undefined;
    };

    try {
      const {
        openPdf,
        extractPdfText,
        generatePdf,
        listDocumentArtifacts,
      } = await import("./pdf-service");

      if (action === "open") {
        const opened = await openPdf(sourceInput as any);
        return { result: JSON.stringify(opened, null, 2) };
      }

      if (action === "extract") {
        const extracted = await extractPdfText({
          ...(sourceInput as any),
          startPage: typeof args.startPage === "number" ? args.startPage : undefined,
          maxPages: typeof args.maxPages === "number" ? args.maxPages : undefined,
        });
        return { result: JSON.stringify(extracted, null, 2) };
      }

      if (action === "generate") {
        const generated = await generatePdf({
          title: typeof args.title === "string" ? args.title : "",
          blocks: Array.isArray(args.blocks) ? args.blocks : undefined,
          vaultId: sourceInput.vaultId,
        });
        if (args._sessionId) {
          const { recordSessionArtifact } = await import("./session-artifacts");
          recordSessionArtifact(args._sessionId, "file", generated.objectPath, {
            documentId: generated.documentId,
            title: generated.title,
            sourceKind: "generated",
          });
        }
        return { result: JSON.stringify(generated, null, 2) };
      }

      if (action === "list") {
        const listed = await listDocumentArtifacts({
          vaultId: sourceInput.vaultId,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          offset: typeof args.offset === "number" ? args.offset : undefined,
        });
        return { result: JSON.stringify(listed, null, 2) };
      }

      return contractReject(`Unknown pdf action: ${action}`, "pdf_input_invalid");
    } catch (err: any) {
      const failure = classifyPdfError(err)
        ?? (action === "extract"
          ? internalFailure("pdf_extract_failed")
          : action === "generate"
            ? internalFailure("pdf_generate_failed")
            : undefined);
      return {
        result: `pdf.${action} failed: ${err?.message || String(err)}`,
        error: true,
        failure,
      };
    }
  },
  async weather(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    try {
      const weatherMod = await import("./weather");
      const handlers: Record<string, (a: Record<string, any>) => Promise<string>> = {
        current: weatherMod.getCurrentWeather,
        forecast: weatherMod.getDailyForecast,
        hourly: weatherMod.getHourlyForecast,
        alerts: weatherMod.getAlerts,
        historical: weatherMod.getHistoricalWeather,
      };
      const handler = handlers[action];
      if (!handler) return { result: `Unknown weather action: ${action}`, error: true };
      const result = await handler(args);
      return { result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Weather error: ${msg}`, error: true };
    }
  },
  async web(args) {
    const action = args.action;
    if (!action) {
      return contractReject("Missing action parameter", "web_input_invalid");
    }
    const sub: Record<string, ToolHandler> = {
      search: webTools.web_search,
      fetch: webTools.web_fetch,
      test: webTools.web_test,
      screenshot: webTools.web_test, // deprecated alias
    };
    const handler = sub[action];
    if (!handler) {
      return contractReject(`Unknown web action: ${action}`, "web_input_invalid");
    }
    return handler(args);
  },
  async memory(args) {
    let action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      read: memoryTools.memory_read,
      write: memoryTools.memory_write,
      read_entry: memoryTools.memory_read_entry,
      search: memoryTools.memory_search,
    };
    const handler = sub[action];
    if (handler) {
      const result = await handler(args);
      // Record session artifact link for memory file writes
      if (action === "write" && !result.error && args.file) {
        const { recordSessionArtifact } = await import("./session-artifacts");
        recordSessionArtifact(args._sessionId, "memory_entry", args.file, {});
      }
      return result;
    }
    // Compatibility alias: memory.get is the public name for vnext_claim_detail.
    // Retarget the local dispatch variable (not just args.action) so the
    // downstream `action === "vnext_claim_detail"` branch actually matches;
    // fall through in-place — do not re-enter a missing bridgeHandlers.memory binding.
    if (action === "get") {
      action = "vnext_claim_detail";
      args.action = "vnext_claim_detail";
    }
    const retiredLegacyCrudActions: Record<string, string> = {
      create_link: "No faithful generic vNext equivalent exists for arbitrary memory_links writes. Use run_vnext_lifecycle to create source/entity/claim links, or use vnext_claim_detail to inspect existing graph provenance.",
      update_entry: "memory_entries updates are retired. vNext claims are extracted, sourced, linked, canonicalized, or retired through run_vnext_lifecycle; inspect them with vnext_claim_detail.",
      delete_entry: "memory_entries deletion is retired. Archived rows are preserved. For vNext, use lifecycle retirement through vNext maintenance rather than deleting source-backed claims.",
    };
    if (Object.prototype.hasOwnProperty.call(retiredLegacyCrudActions, action)) {
      return retiredLegacyMemoryAction(action, retiredLegacyCrudActions[action]);
    }
    const retiredLegacyMaintenanceActions = new Set([
      "consolidate_short",
      "integrate_mid_to_long",
      "run_myelination",
      "run_memory_decay",
      "run_memory_reinforcement",
      "run_nrem",
    ]);
    if (retiredLegacyMaintenanceActions.has(action)) {
      return {
        result: `Memory action "${action}" is retired. Legacy memory propagation and maintenance are disabled; use run_vnext_lifecycle, run_full_sleep_cycle, compute_gsi, or run_rem.`,
        error: true,
      };
    }

    const opsActions = new Set(["run_full_sleep_cycle", "compute_gsi", "run_rem"]);
    if (opsActions.has(action)) {
      const bridge = bridgeHandlers.memory_ops;
      if (bridge) return bridge(args);
      return { result: `memory_ops bridge handler not found`, error: true };
    }
    if (action === "link_entity") {
      const claimId = typeof args.id === "number" ? args.id : typeof args.claimId === "number" ? args.claimId : null;
      const entityType = args.entityType as string;
      const entityId = args.entityId as string;
      if (claimId === null) return { result: "Missing 'id' parameter (vNext claim ID)", error: true };
      if (!entityType) return { result: "Missing 'entityType' parameter", error: true };
      if (!entityId) return { result: "Missing 'entityId' parameter", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        await memoryVnextClaimStorage.linkClaimToEntity(claimId, entityType, entityId, { method: "manual_tool" });
        return { result: JSON.stringify({ linked: true, storage: "memory_vnext_claims", claimId, entityType, entityId }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to link vNext claim entity: ${msg}`, error: true };
      }
    }
    if (action === "get_entity_links") {
      const claimId = typeof args.id === "number" ? args.id : typeof args.claimId === "number" ? args.claimId : null;
      if (claimId === null) return { result: "Missing 'id' parameter (vNext claim ID)", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const links = await memoryVnextClaimStorage.listEntityLinks(claimId);
        return { result: JSON.stringify({ storage: "memory_vnext_claims", claimId, total: links.length, links }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get vNext claim entity links: ${msg}`, error: true };
      }
    }
    if (action === "get_many") {
      const ids = args.ids;
      if (!ids || !Array.isArray(ids) || ids.length === 0) return { result: "Missing or empty 'ids' array", error: true };
      if (ids.length > 100) return { result: "Too many IDs — max 100 per call", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const numericIds = ids.map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && Number.isInteger(id));
        if (numericIds.length === 0) return { result: "No valid numeric vNext claim IDs provided", error: true };
        const details = await Promise.all(numericIds.map((id: number) => memoryVnextClaimStorage.getClaimDetail(id)));
        const foundIds = details.flatMap((detail) => detail ? [detail.claim.id] : []);
        await memoryVnextClaimStorage.touchClaims(foundIds);
        const claims = details.filter(Boolean).map((detail: any) => ({
          id: detail.claim.id,
          storage: "memory_vnext_claims",
          title: detail.claim.title || detail.claim.content,
          content: detail.claim.content,
          claimType: detail.claim.claimType,
          confidence: detail.claim.confidence,
          extractionConfidence: detail.claim.confidence,
          integrationLevel: detail.dimensions.integration.level,
          claimCertainty: detail.dimensions.certainty,
          strengthProjection: detail.dimensions.strength,
          temporalApplicability: detail.dimensions.temporalApplicability,
          lifecycleStage: detail.claim.lifecycleStage,
          source: detail.claim.source,
          sourceId: detail.claim.sourceId,
          topics: detail.claim.topics || [],
          createdAt: detail.claim.createdAt?.toISOString?.() ?? null,
          sourceCount: detail.sources.length,
          entityLinkCount: detail.entityLinks.length,
          claimLinkCount: detail.claimLinks.length,
        }));
        return { result: JSON.stringify({ storage: "memory_vnext_claims", total: claims.length, requested: numericIds.length, claims }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get vNext claims: ${msg}`, error: true };
      }
    }
    if (action === "count") {
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const counts = await memoryVnextClaimStorage.getCounts();
        return { result: JSON.stringify({ storage: "memory_vnext_claims", ...counts }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to count vNext claims: ${msg}`, error: true };
      }
    }
    const retiredNoFaithfulEquivalent: Record<string, string> = {
      bulk_delete: "Legacy bulk deletion is retired and archived memory_entries are preserved. vNext claims should be retired by lifecycle policy rather than bulk-deleted through this tool.",
      find_duplicates: "Legacy duplicate cluster inspection is retired. vNext claim deduplication runs inside extraction and lifecycle maintenance; use search_claims/search plus vnext_claim_detail for inspection.",
    };
    if (Object.prototype.hasOwnProperty.call(retiredNoFaithfulEquivalent, action)) {
      return retiredLegacyMemoryAction(action, retiredNoFaithfulEquivalent[action]);
    }
    if (action === "list_sources") {
      const claimId = typeof args.memoryId === "number" ? args.memoryId : typeof args.id === "number" ? args.id : null;
      if (claimId === null) return { result: "Missing 'memoryId' or 'id' parameter (vNext claim ID)", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const sources = await memoryVnextClaimStorage.listSourceRefs(claimId);
        return { result: JSON.stringify({ storage: "memory_vnext_claims", claimId, total: sources.length, sources }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to list vNext claim sources: ${msg}`, error: true };
      }
    }
    if (action === "add_source") {
      const claimId = typeof args.memoryId === "number" ? args.memoryId : typeof args.id === "number" ? args.id : null;
      if (claimId === null) return { result: "Missing 'memoryId' or 'id' parameter (vNext claim ID)", error: true };
      if (typeof args.sourceType !== "string") return { result: "Missing 'sourceType' parameter (e.g. 'library', 'session', 'chat_journal')", error: true };
      if (typeof args.sourceId !== "string") return { result: "Missing 'sourceId' parameter", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const ref = await memoryVnextClaimStorage.addSourceRef(claimId, {
          sourceType: args.sourceType as string,
          sourceId: args.sourceId as string,
          relationship: (args.relationship as string) ?? "extracted_from",
          context: (args.context as string) ?? "",
          quote: (args.quote as string | null) ?? null,
          strength: typeof args.strength === "number" ? args.strength : 1,
          clarity: typeof args.clarity === "number" ? args.clarity : null,
          certainty: typeof args.relationshipCertainty === "number" ? args.relationshipCertainty : null,
          sourceObservedAt: typeof args.sourceObservedAt === "string" ? new Date(args.sourceObservedAt) : null,
          sourceLineageKey: typeof args.sourceLineageKey === "string" ? args.sourceLineageKey : null,
          independence: args.sourceIndependence === "independent" || args.sourceIndependence === "same_lineage" || args.sourceIndependence === "unknown"
            ? args.sourceIndependence
            : "unknown",
          producerMethod: typeof args.producerMethod === "string" ? args.producerMethod : "memory_tool",
          derivationVersion: typeof args.derivationVersion === "string" ? args.derivationVersion : null,
          provenance: args.sourceProvenance && typeof args.sourceProvenance === "object" ? args.sourceProvenance : {},
        });
        return { result: JSON.stringify({ created: Boolean(ref), storage: "memory_vnext_claims", claimId, source: ref }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to add vNext claim source: ${msg}`, error: true };
      }
    }
    if (action === "delete_source") {
      const sourceRefId = typeof args.sourceRefId === "number" ? args.sourceRefId : (typeof args.id === "number" ? args.id : null);
      if (sourceRefId === null) return { result: "Missing 'sourceRefId' (or 'id') parameter", error: true };
      try {
        const { db } = await import("./db");
        const { memoryVnextSourceRefs } = await import("../shared/models/memory");
        const { eq } = await import("drizzle-orm");
        const { combineWithWritableScope } = await import("./scoped-storage");
        const { requireCurrentPrincipal } = await import("./principal-context");
        const deleted = await db.delete(memoryVnextSourceRefs).where(combineWithWritableScope(requireCurrentPrincipal(), {
          scope: memoryVnextSourceRefs.scope,
          ownerUserId: memoryVnextSourceRefs.ownerUserId,
          accountId: memoryVnextSourceRefs.accountId,
        }, eq(memoryVnextSourceRefs.id, sourceRefId))).returning();
        if (deleted.length === 0) return { result: JSON.stringify({ deleted: false, storage: "memory_vnext_claims", reason: "not_found" }) };
        return { result: JSON.stringify({ deleted: true, storage: "memory_vnext_claims", id: sourceRefId }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to delete vNext claim source: ${msg}`, error: true };
      }
    }
    if (action === "run_vnext_lifecycle") {
      try {
        const { runVnextLifecycle } = await import("./memory/vnext-lifecycle");
        const { eventBus } = await import("./event-bus");
        const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 200) : undefined;
        const result = await runVnextLifecycle({ limit, trigger: "manual_tool" });
        eventBus.publish({
          category: "memory",
          event: "entries_changed",
          payload: { action: "vnext_lifecycle", storage: "memory_vnext_claims", ...result, level: result.errors > 0 ? "warn" : "info" },
        });
        toolExec.info(`[memory.vnext] lifecycle_run runId=${result.runId} scanned=${result.scanned} sourced=${result.sourced} linked=${result.linked} canonicalized=${result.canonicalized} retired=${result.retired} skipped=${result.skipped} errors=${result.errors}`);
        return { result: JSON.stringify({ triggered: true, storage: "memory_vnext_claims", ...result }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to run vNext lifecycle: ${msg}`, error: true };
      }
    }
    if (action === "vnext_claim_counts") {
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const counts = await memoryVnextClaimStorage.getCounts();
        toolExec.debug(`[memory.vnext] claim_counts total=${counts.total} sourceRefs=${counts.sourceRefs} entityLinks=${counts.entityLinks} claimLinks=${counts.claimLinks}`);
        return { result: JSON.stringify({ storage: "memory_vnext_claims", ...counts }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to count vNext claims: ${msg}`, error: true };
      }
    }
    if (action === "vnext_claim_detail") {
      const claimId = typeof args.id === "number" ? args.id : typeof args.claimId === "number" ? args.claimId : null;
      if (claimId === null) return { result: "Missing vNext claim id", error: true };
      try {
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const detail = await memoryVnextClaimStorage.getClaimDetail(claimId);
        if (!detail) return { result: JSON.stringify({ found: false, storage: "memory_vnext_claims", id: claimId }) };
        await memoryVnextClaimStorage.touchClaim(claimId);
        const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
        return { result: JSON.stringify({
          found: true,
          storage: "memory_vnext_claims",
          claim: {
            ...detail.claim,
            lifecycleStageUpdatedAt: iso(detail.claim.lifecycleStageUpdatedAt),
            lastRecalledAt: iso(detail.claim.lastRecalledAt),
            activeTouchedAt: iso(detail.claim.activeTouchedAt),
            createdAt: iso(detail.claim.createdAt),
            updatedAt: iso(detail.claim.updatedAt),
          },
          sources: detail.sources.map(r => ({ ...r, createdAt: iso(r.createdAt) })),
          entityLinks: detail.entityLinks.map(r => ({ ...r, createdAt: iso(r.createdAt) })),
          claimLinks: detail.claimLinks.map(r => ({ ...r, createdAt: iso(r.createdAt) })),
          claimLinkEvidence: detail.claimLinkEvidence.map(r => ({ ...r, createdAt: iso(r.createdAt) })),
          transitionPaths: detail.transitionPaths.map(path => ({
            path: { ...path.path, createdAt: iso(path.path.createdAt), updatedAt: iso(path.path.updatedAt) },
            members: path.members.map(member => ({
              ...member,
              createdAt: iso(member.createdAt),
              claim: {
                ...member.claim,
                observedAt: iso(member.claim.observedAt), validFrom: iso(member.claim.validFrom), validUntil: iso(member.claim.validUntil),
                occurredAt: iso(member.claim.occurredAt), expectedBy: iso(member.claim.expectedBy),
                lifecycleStageUpdatedAt: iso(member.claim.lifecycleStageUpdatedAt), lastRecalledAt: iso(member.claim.lastRecalledAt),
                activeTouchedAt: iso(member.claim.activeTouchedAt), createdAt: iso(member.claim.createdAt), updatedAt: iso(member.claim.updatedAt),
              },
            })),
            edges: path.edges.map(edge => ({
              ...edge,
              createdAt: iso(edge.createdAt),
              claimLink: { ...edge.claimLink, createdAt: iso(edge.claimLink.createdAt) },
              evidence: edge.evidence.map(item => ({ ...item, createdAt: iso(item.createdAt) })),
            })),
          })),
          dimensions: {
            ...detail.dimensions,
            strength: {
              ...detail.dimensions.strength,
              latestEventAt: iso(detail.dimensions.strength.latestEventAt),
              recentEvidence: detail.dimensions.strength.recentEvidence.map(event => ({
                ...event,
                occurredAt: iso(event.occurredAt),
              })),
            },
            sourceClarity: {
              ...detail.dimensions.sourceClarity,
              evidence: detail.dimensions.sourceClarity.evidence.map(evidence => ({
                ...evidence,
                sourceObservedAt: iso(evidence.sourceObservedAt),
              })),
            },
            temporalApplicability: {
              ...detail.dimensions.temporalApplicability,
              evaluatedAt: iso(detail.dimensions.temporalApplicability.evaluatedAt),
              observedAt: iso(detail.dimensions.temporalApplicability.observedAt),
              validFrom: iso(detail.dimensions.temporalApplicability.validFrom),
              validUntil: iso(detail.dimensions.temporalApplicability.validUntil),
              occurredAt: iso(detail.dimensions.temporalApplicability.occurredAt),
              expectedBy: iso(detail.dimensions.temporalApplicability.expectedBy),
            },
          },
          lifecycle: {
            ...detail.lifecycle,
            stageUpdatedAt: iso(detail.lifecycle.stageUpdatedAt),
            lastRecalledAt: iso(detail.lifecycle.lastRecalledAt),
            activeTouchedAt: iso(detail.lifecycle.activeTouchedAt),
            createdAt: iso(detail.lifecycle.createdAt),
            updatedAt: iso(detail.lifecycle.updatedAt),
          },
        }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get vNext claim detail: ${msg}`, error: true };
      }
    }
    if (action === "search_claims") {
      try {
        if (args.storage === "legacy" || typeof args.integrationStage === "string") {
          return { result: "Legacy claim search has been retired. search_claims reads memory_vnext_claims only; use lifecycleStage instead of integrationStage.", error: true };
        }
        const { memoryVnextClaimStorage } = await import("./memory/vnext-claim-storage");
        const limit = typeof args.limit === "number" ? Math.min(args.limit, 100) : 20;
        const offset = typeof args.offset === "number" ? Math.max(args.offset, 0) : 0;
        const rows = await memoryVnextClaimStorage.searchClaims({
          claimType: typeof args.claimType === "string" ? args.claimType : undefined,
          hasEntityLinks: typeof args.hasEntityLinks === "boolean" ? args.hasEntityLinks : undefined,
          entityId: typeof args.entityId === "string" ? args.entityId : undefined,
          createdAfter: typeof args.createdAfter === "string" ? args.createdAfter : undefined,
          createdBefore: typeof args.createdBefore === "string" ? args.createdBefore : undefined,
          lifecycleStage: typeof args.lifecycleStage === "string" ? args.lifecycleStage : undefined,
          limit,
          offset,
        });
        toolExec.debug(`[memory.vnext] search_claims count=${rows.length} offset=${offset} limit=${limit}`);
        return { result: JSON.stringify({
          total: rows.length,
          storage: "memory_vnext_claims",
          includeVnext: true,
          includeLegacy: false,
          claims: rows.map((claim) => ({
            id: claim.id,
            storage: "memory_vnext_claims",
            title: claim.title || claim.content,
            content: claim.content.slice(0, 500),
            claimType: claim.claimType,
            confidence: claim.confidence,
            extractedFrom: claim.sourceMemoryId ?? null,
            source: claim.source,
            sourceId: claim.sourceId,
            entityMentions: claim.entityMentions || [],
            lifecycleStage: claim.lifecycleStage,
            lifecycleStageUpdatedAt: claim.lifecycleStageUpdatedAt?.toISOString() ?? null,
            tags: claim.topics || [],
            createdAt: claim.createdAt?.toISOString() ?? null,
          })),
        }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to search vNEXT claims: ${msg}`, error: true };
      }
    }

    return { result: `Unknown memory action: ${action}`, error: true };
  },
  async settings(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };

    const ALLOWED_PREFIXES = ["memory.", "system.", "skill.", "hygiene."];

    try {
      const { getSetting, setSetting, deleteSetting } = await import("./system-settings");

      if (action === "get") {
        const key = args.key;
        if (!key) return { result: "Missing 'key' parameter", error: true };
        if (!ALLOWED_PREFIXES.some(p => key.startsWith(p))) {
          return { result: `Key "${key}" not allowed. Keys must start with one of: ${ALLOWED_PREFIXES.join(", ")}`, error: true };
        }
        const value = await getSetting(key);
        return { result: JSON.stringify({ key, value: value ?? null }) };
      }

      if (action === "set") {
        const key = args.key;
        if (!key) return { result: "Missing 'key' parameter", error: true };
        if (!ALLOWED_PREFIXES.some(p => key.startsWith(p))) {
          return { result: `Key "${key}" not allowed. Keys must start with one of: ${ALLOWED_PREFIXES.join(", ")}`, error: true };
        }
        if (args.value === undefined) return { result: "Missing 'value' parameter", error: true };
        await setSetting(key, args.value);
        return { result: JSON.stringify({ key, value: args.value, status: "saved" }) };
      }

      if (action === "delete") {
        const key = args.key;
        if (!key) return { result: "Missing 'key' parameter", error: true };
        if (!ALLOWED_PREFIXES.some(p => key.startsWith(p))) {
          return { result: `Key "${key}" not allowed. Keys must start with one of: ${ALLOWED_PREFIXES.join(", ")}`, error: true };
        }
        const deleted = await deleteSetting(key);
        return { result: JSON.stringify({ key, deleted }) };
      }

      return { result: `Unknown settings action: ${action}. Available: get, set, delete`, error: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Settings error: ${msg}`, error: true };
    }
  },
  async code(args) {
    const action = args.action;
    if (!action) return contractReject("Missing action parameter", "code_missing_action");
    const sub: Record<string, ToolHandler> = {
      query: codeIntelTools.code_query,
      context: codeIntelTools.code_context,
      impact: codeIntelTools.code_impact,
      changes: codeIntelTools.code_changes,
      architecture: codeIntelTools.code_architecture,
      modules: codeIntelTools.code_modules,
      flows: codeIntelTools.code_flows,
      rename: codeIntelTools.code_rename,
      schema: codeIntelTools.code_schema,
      cypher: codeIntelTools.code_cypher,
    };
    const handler = sub[action];
    if (!handler) return contractReject(`Unknown code action: ${action}`, "code_unknown_action");
    return handler(args);
  },
  async docx(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };
    const sub: Record<string, ToolHandler> = {
      read: workspaceTools.read_docx,
      write: workspaceTools.write_docx,
      edit: workspaceTools.edit_docx,
      clone: workspaceTools.clone_docx,
    };
    const handler = sub[action];
    if (!handler) return { result: `Unknown docx action: ${action}`, error: true };
    const result = await handler(args);
    // Record session artifact link for write/clone
    if ((action === "write" || action === "clone") && !result.error) {
      const { recordSessionArtifact } = await import("./session-artifacts");
      const docxPath = action === "write" ? args.path : (args.output_path || args.source_path);
      recordSessionArtifact(args._sessionId, "docx", docxPath, {});
    }
    return result;
  },
  observe: recordMetacognitiveObservationTool,
  async system(args) {
    const action = args.action as string;
    if (!action) return { result: "Missing action parameter", error: true };
    if (action === "state") {
      const bridge = bridgeHandlers.get_system_state;
      if (bridge) return bridge(args);
      return { result: "get_system_state handler not found", error: true };
    }
    if (action === "log_files") {
      try {
        const { listLogFiles } = await import("./log");
        const files = await listLogFiles();
        if (files.length === 0) {
          return { result: "No log files found." };
        }
        const lines = files.map(f => {
          const sizeKB = (f.size / 1024).toFixed(1);
          return `${f.filename}  (${sizeKB} KB, ${f.createdAt})`;
        });
        return { result: `${files.length} log file(s) available:\n${lines.join("\n")}\n\nUse the logs action with file parameter to read a specific file.` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to list log files: ${msg}`, error: true };
      }
    }
    if (action === "logs") {
      try {
        const { readLogFile, getCurrentLogFile, listLogFiles, resolveLogFilename } = await import("./log");
        const file = args.file ? resolveLogFilename(args.file as string) : getCurrentLogFile();
        const entries = await readLogFile(file, {
          limit: args.limit as number | undefined,
          level: args.level as string | undefined,
          source: args.source as string | undefined,
        });
        if (entries.length === 0) {
          const files = await listLogFiles();
          const fileList = files.slice(0, 5).map(f => f.filename).join(", ");
          return { result: `No log entries found matching the filters. Available log files: ${fileList || "none"}. Use log_files action to see all files, or logs action with file parameter to read a specific file.` };
        }
        const lines = entries.map(e => {
          const ts = e.ts.slice(11, 23);
          return `[${ts}] [${e.level.toUpperCase().padEnd(5)}] [${e.source}] ${e.message}`;
        });
        return { result: `${entries.length} log entries:\n${lines.join("\n")}` };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to retrieve logs: ${msg}`, error: true };
      }
    }
    if (action === "budget") {
      return { result: JSON.stringify({ mode: "unlimited", budgetEnforced: false, message: "Skill budgets are disabled; usage is tracked for observability only." }) };
    }

    if (action === "frontend_performance") {
      try {
        const { requireCurrentUserPrincipal } = await import("./principal-context");
        const { getBrowserTelemetrySummary } = await import("./browser-telemetry-storage");
        const hoursRaw = args.hours === undefined ? 24 : Number(args.hours);
        const summary = await getBrowserTelemetrySummary(requireCurrentUserPrincipal(), Number.isFinite(hoursRaw) ? hoursRaw : 24);
        return { result: JSON.stringify(summary) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get frontend performance summary: ${msg}`, error: true };
      }
    }

    if (action === "context_health") {
      try {
        const { requireCurrentPrincipal } = await import("./principal-context");
        const { principalHasPermission } = await import("./permissions");
        const principal = requireCurrentPrincipal();
        if (!principalHasPermission(principal, "system:read")) {
          return { result: "Permission required: system:read", error: true };
        }
        const { getContextHealthSummary } = await import("./context-health-storage");
        const hoursRaw = args.hours === undefined ? 24 : Number(args.hours);
        const summary = await getContextHealthSummary(Number.isFinite(hoursRaw) ? hoursRaw : 24);
        return { result: formatContextHealthSummary(summary) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get context health summary: ${msg}`, error: true };
      }
    }
    if (action === "events") {
      try {
        const { requireCurrentPrincipal } = await import("./principal-context");
        const principal = requireCurrentPrincipal();
        const limit = (args.limit as number) || 100;
        let payloadQuery: Record<string, unknown> | undefined;
        if (args.payloadQuery) {
          payloadQuery = typeof args.payloadQuery === "string" ? JSON.parse(args.payloadQuery) : args.payloadQuery;
        }
        const result = eventBus.queryRecentEvents({
          limit,
          offset: (args.offset as number) || 0,
          principal,
          filter: {
            category: args.category as string | undefined,
            event: args.event as string | undefined,
            runId: args.runId as string | undefined,
            sessionKey: args.sessionKey as string | undefined,
            startTimestamp: args.startDate ? new Date(args.startDate as string).getTime() : undefined,
            endTimestamp: args.endDate ? new Date(args.endDate as string).getTime() : undefined,
            payloadQuery,
          },
        });
        return { result: JSON.stringify({ total: result.total, source: "in-memory", events: result.events.map(e => ({ id: e.id, timestamp: new Date(e.timestamp).toISOString(), category: e.category, event: e.event, runId: e.runId || null })) }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const { requireCurrentPrincipal } = await import("./principal-context");
        const fallbackEvents = eventBus.getRecentEvents((args.limit as number) || 100, {
          category: args.category as string | undefined,
          runId: args.runId as string | undefined,
          event: args.event as string | undefined,
        }, requireCurrentPrincipal());
        return { result: JSON.stringify({ total: fallbackEvents.length, source: "in-memory", events: fallbackEvents.map(e => ({ id: e.id, timestamp: new Date(e.timestamp).toISOString(), category: e.category, event: e.event, runId: e.runId || null })) }) };
      }
    }
    if (action === "active_runs") {
      try {
        const { requireCurrentPrincipal } = await import("./principal-context");
        const runs = eventBus.getActiveRuns(requireCurrentPrincipal());
        return { result: JSON.stringify({ total: runs.length, runs: runs.map(r => ({ runId: r.runId, startedAt: new Date(r.startedAt).toISOString(), events: r.events, lastEvent: r.lastEvent })) }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get active runs: ${msg}`, error: true };
      }
    }
    if (action === "clear_active_run") {
      try {
        const runId = String(args.runId || args.id || "").trim();
        if (!runId) return { result: "Missing runId parameter", error: true };
        const reason = String(args.reason || "manual_cleanup").trim() || "manual_cleanup";
        const { requireCurrentPrincipal } = await import("./principal-context");
        const result = eventBus.clearActiveRun(runId, reason, requireCurrentPrincipal());
        return { result: JSON.stringify(result), error: !result.cleared };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to clear active run: ${msg}`, error: true };
      }
    }
    if (action === "accounts") {
      try {
        const { listAccounts } = await import("./connected-accounts");
        const provider = args.provider as string | undefined;
        const accounts = await listAccounts(provider);
        return { result: JSON.stringify({ total: accounts.length, filters: { provider: provider || null }, accounts: accounts.map(a => ({ accountId: a.accountId, provider: a.provider, email: a.email || null, label: a.label || null, healthy: a.healthy ?? null })) }) };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to list accounts: ${msg}`, error: true };
      }
    }
    if (action === "tool_output_pressure") {
      try {
        const { getCurrentPrincipal } = await import("./principal-context");
        const principal = getCurrentPrincipal();
        if (!principal) {
          return {
            result: "Authenticated principal required",
            error: true,
            failure: permissionFailure("system_principal_required"),
          };
        }
        const { rankToolOutputPressure } = await import("./tool-output-pressure");
        const report = await rankToolOutputPressure({ principal, hours: args.hours as number | undefined, limit: args.limit as number | undefined, offset: args.offset as number | undefined });
        return { result: JSON.stringify(report) };
      } catch (err: unknown) {
        return {
          result: `Failed to rank tool-output pressure: ${err instanceof Error ? err.message : String(err)}`,
          error: true,
          failure: classifySystemToolError(err),
        };
      }
    }
    if (action === "reliability") {
      try {
        const detail =
          typeof args.detail === "string" && args.detail.trim()
            ? args.detail.trim()
            : "summary";

        if (detail === "turn_failures") {
          const { listReliabilityTurnFailures } = await import("./reliability-outcomes");
          const failures = await listReliabilityTurnFailures({
            hours: typeof args.hours === "number" ? args.hours : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
          });
          return { result: JSON.stringify(failures, null, 2) };
        }

        if (detail === "tool_failures") {
          const { listReliabilityToolFailures } = await import("./reliability-outcomes");
          const failures = await listReliabilityToolFailures({
            hours: typeof args.hours === "number" ? args.hours : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined,
            failureKind: typeof args.failureKind === "string" ? args.failureKind : undefined,
            tool: typeof args.tool === "string" ? args.tool : undefined,
            code: typeof args.code === "string" ? args.code : undefined,
          });
          return { result: JSON.stringify(failures, null, 2) };
        }

        if (detail !== "summary") {
          return contractReject(
            `Unknown reliability detail '${detail}'. Use 'summary', 'turn_failures', or 'tool_failures'.`,
            "system_input_invalid",
          );
        }

        const { getReliabilityOutcomeSummary } = await import("./reliability-outcomes");
        const summary = await getReliabilityOutcomeSummary(args.hours);
        return { result: JSON.stringify(summary, null, 2) };
      } catch (e) {
        return {
          result: `Failed to load reliability outcomes: ${e instanceof Error ? e.message : String(e)}`,
          error: true,
          failure: classifySystemToolError(e),
        };
      }
    }
    if (action === "list_history_rollup_candidates") {
      try {
        const { listHistoryRollupCandidates } = await import("./historical-continuity");
        return { result: JSON.stringify(await listHistoryRollupCandidates()) };
      } catch (err: unknown) {
        return {
          result: `Failed to list historical continuity rollup candidates: ${err instanceof Error ? err.message : String(err)}`,
          error: true,
          failure: classifySystemToolError(err),
        };
      }
    }
    if (action === "save_history_rollup") {
      try {
        const { saveHistoryRollup } = await import("./historical-continuity");
        return {
          result: JSON.stringify(await saveHistoryRollup({
            vaultId: String(args.vaultId || ""),
            level: String(args.rollupLevel || ""),
            timezone: String(args.timezone || ""),
            bucketStart: String(args.bucketStart || ""),
            sourceEntryIds: Array.isArray(args.sourceEntryIds) ? args.sourceEntryIds.map(String) : [],
            summary: String(args.summary || ""),
          })),
        };
      } catch (err: unknown) {
        return {
          result: `Failed to save historical continuity rollup: ${err instanceof Error ? err.message : String(err)}`,
          error: true,
          failure: classifySystemToolError(err),
        };
      }
    }
    if (action === "tool_stats") {
      try {
        const { getToolStats } = await import("./file-storage/tool-stats");
        const stats = getToolStats();
        return {
          result: JSON.stringify({
            scope: "cumulative",
            window: null,
            note: "Tool statistics are lifetime cumulative counters persisted across process restarts; time-window filtering is not supported.",
            total: stats.length,
            tools: stats,
          }),
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: `Failed to get tool stats: ${msg}`, error: true };
      }
    }
    return { result: `Unknown system action: ${action}. Available: state, logs, log_files, budget, frontend_performance, context_health, reliability, tool_output_pressure, list_history_rollup_candidates, save_history_rollup, events, active_runs, clear_active_run, accounts, tool_stats`, error: true };
  },
  async timers(args) {
    const action = args.action as string;
    if (!action) return { result: "Missing action parameter", error: true };
    try {
      const { timerStorage } = await import("./file-storage/timers");
      const { timerTypes } = await import("@shared/models/timers");
      type TimerType = typeof timerTypes[number];
      type Schedule = import("@shared/models/timers").Schedule;
      if (action === "list") {
        const name = (args.name as string | undefined)?.trim();
        const limit = Math.min((args.limit as number) || 100, 100);
        const timers = name ? await timerStorage.searchByName(name, limit) : await timerStorage.getAll();
        const items = name ? timers : timers.slice(0, limit);
        return { result: JSON.stringify({ total: timers.length, items }) };
      }
      if (action === "get") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const timer = await timerStorage.getByIdOrName(id);
        if (!timer) return { result: `Timer "${id}" not found.`, error: true };
        return { result: JSON.stringify(timer) };
      }
      if (action === "runs") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const limit = (args.limit as number) || 20;
        const runs = await timerStorage.getRuns(id, limit);
        return { result: JSON.stringify({ timerId: id, total: runs.length, items: runs }) };
      }
      if (action === "create") {
        const name = args.name as string;
        if (!name) return { result: "Missing 'name' parameter", error: true };
        const typeStr = args.type as string;
        if (!typeStr) return { result: "Missing 'type' parameter", error: true };
        if (!timerTypes.includes(typeStr as TimerType)) {
          return { result: `Invalid type "${typeStr}". Must be one of: ${timerTypes.join(", ")}`, error: true };
        }
        const timer = await timerStorage.create({
          name,
          description: (args.description as string) || "",
          type: typeStr as TimerType,
          prompt: (args.prompt as string) || "",
          skillId: args.skillId as string | undefined,
          schedules: (args.schedules as Schedule[]) || [],
          enabled: args.enabled !== undefined ? Boolean(args.enabled) : true,
          timezone: (args.timezone as string) || "America/New_York",
        });
        return { result: JSON.stringify(timer) };
      }
      if (action === "update") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const updates: Partial<Omit<import("@shared/models/timers").Timer, "id" | "createdAt">> = {};
        if (args.name !== undefined) updates.name = args.name as string;
        if (args.description !== undefined) updates.description = args.description as string;
        if (args.prompt !== undefined) updates.prompt = args.prompt as string;
        if (args.skillId !== undefined) updates.skillId = args.skillId as string;
        if (args.schedules !== undefined) updates.schedules = args.schedules as Schedule[];
        if (args.enabled !== undefined) updates.enabled = Boolean(args.enabled);
        if (args.timezone !== undefined) updates.timezone = args.timezone as string;
        const updated = await timerStorage.update(id, updates);
        if (!updated) return { result: `Timer "${id}" not found.`, error: true };
        return { result: JSON.stringify(updated) };
      }
      if (action === "delete") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const deleted = await timerStorage.delete(id);
        if (!deleted) return { result: `Timer "${id}" not found or already deleted.`, error: true };
        return { result: JSON.stringify({ deleted: true, id }) };
      }
      if (action === "trigger") {
        const id = args.id as string;
        if (!id) return { result: "Missing 'id' parameter", error: true };
        const timer = await timerStorage.get(id);
        if (!timer) return { result: `Timer "${id}" not found.`, error: true };
        const scheduleId = (args.scheduleId as string) || timer.schedules[0]?.id || "manual";
        const { timerScheduler } = await import("./timer-scheduler");
        const run = await timerScheduler.executeTimer(id, scheduleId, "manual");
        if (!run) return { result: JSON.stringify({ triggered: false, id, reason: "Timer disabled or not found" }) };
        return { result: JSON.stringify({ triggered: true, id, runId: run.id, status: run.status }) };
      }
      return { result: `Unknown timers action: ${action}. Available: list, get, runs, create, update, delete, trigger`, error: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Timers error: ${msg}`, error: true };
    }
  },
  async health(args) {
    const action = args.action as string;
    if (!action) return { result: "Missing action parameter", error: true };
    try {
      const { queryHealthSummary, queryHealthMetrics, queryActivityStatus, logWellnessActivity, queryWellnessActivities, createWellnessActivity, updateWellnessActivity, archiveWellnessActivity, queryActivityLogs, deleteWellnessLog } = await import("./routes/wellness");
      if (action === "summary") {
        const summary = await queryHealthSummary();
        return { result: JSON.stringify(summary) };
      }
      if (action === "metrics") {
        const rows = await queryHealthMetrics({
          type: args.type as string | undefined,
          days: (args.days as number) || 30,
        });
        return { result: JSON.stringify({ total: rows.length, items: rows }) };
      }
      if (action === "list_activities") {
        const activities = await queryWellnessActivities();
        return { result: JSON.stringify({ total: activities.length, items: activities }) };
      }
      if (action === "log_activity") {
        const activityId = args.activityId as number | undefined;
        const name = args.name as string | undefined;
        const notes = args.notes as string | undefined;
        const dateStr = args.date as string | undefined;
        if (!activityId && !name) {
          return { result: "Either activityId or name is required for log_activity", error: true };
        }
        let resolvedId = activityId;
        if (!resolvedId && name) {
          const activities = await queryWellnessActivities();
          const lower = name.toLowerCase();
          const match = activities.find(a => a.name.toLowerCase() === lower)
            || activities.find(a => a.name.toLowerCase().includes(lower));
          if (!match) {
            return { result: `No activity found matching "${name}"`, error: true };
          }
          resolvedId = match.id;
        }
        let completedAt: Date | undefined;
        if (dateStr) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
          }
          completedAt = new Date(dateStr + "T12:00:00.000Z");
          if (isNaN(completedAt.getTime())) {
            return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
          }
          const { userDateStr } = await import("./utils/user-time");
          const todayStr = userDateStr();
          if (dateStr > todayStr) {
            return { result: "Future dates are not allowed", error: true };
          }
        }
        const result = await logWellnessActivity(resolvedId!, { notes, completedAt });
        if ("duplicate" in result) {
          const msg = dateStr ? "Activity was already logged for that date" : "Activity was already logged within the last 60 seconds";
          return { result: msg, error: true };
        }
        return { result: JSON.stringify({ logged: true, entry: result }) };
      }
      if (action === "delete_log") {
        const logId = args.logId as number | undefined;
        if (!logId) {
          return { result: "logId is required for delete_log", error: true };
        }
        const deleted = await deleteWellnessLog(logId);
        if (!deleted) {
          return { result: `Log ${logId} not found`, error: true };
        }
        return { result: JSON.stringify({ deleted: true, logId }) };
      }
      if (action === "activity_status") {
        const statuses = await queryActivityStatus();
        const grouped: Record<string, typeof statuses> = { overdue: [], due_soon: [], on_track: [], never_done: [] };
        for (const s of statuses) {
          grouped[s.status].push(s);
        }
        const counts = {
          overdue: grouped.overdue.length,
          due_soon: grouped.due_soon.length,
          on_track: grouped.on_track.length,
          never_done: grouped.never_done.length,
          total: statuses.length,
        };
        return { result: JSON.stringify({ counts, grouped }) };
      }
      if (action === "create_activity") {
        const name = args.name as string | undefined;
        const intervalDays = args.intervalDays as number | undefined;
        const category = args.category as string | undefined;
        if (!name || !intervalDays) {
          return { result: "name and intervalDays are required for create_activity (category auto-derived from interval if omitted)", error: true };
        }
        const activity = await createWellnessActivity({
          name,
          intervalDays,
          category,
          benefit: (args.benefit as string) || null,
          risk: (args.risk as string) || null,
          linkedMetricType: (args.linkedMetricType as string) || null,
          greatThreshold: (args.greatThreshold as number) ?? null,
          goodThreshold: (args.goodThreshold as number) ?? null,
          windowStart: (args.windowStart as number) ?? null,
          windowEnd: (args.windowEnd as number) ?? null,
        });
        return { result: JSON.stringify({ created: true, activity }) };
      }
      if (action === "update_activity") {
        const activityId = args.activityId as number | undefined;
        const name = args.name as string | undefined;
        if (!activityId && !name) {
          return { result: "Either activityId or name is required for update_activity", error: true };
        }
        let resolvedId = activityId;
        if (!resolvedId && name) {
          const activities = await queryWellnessActivities();
          const lower = name.toLowerCase();
          const match = activities.find(a => a.name.toLowerCase() === lower)
            || activities.find(a => a.name.toLowerCase().includes(lower));
          if (!match) return { result: `No activity found matching "${name}"`, error: true };
          resolvedId = match.id;
        }
        const updates: Record<string, any> = {};
        if (args.newName !== undefined) updates.name = args.newName as string;
        if (args.benefit !== undefined) updates.benefit = args.benefit as string;
        if (args.risk !== undefined) updates.risk = args.risk as string;
        if (args.intervalDays !== undefined) updates.intervalDays = args.intervalDays as number;
        if (args.category !== undefined) updates.category = args.category as string;
        if (args.linkedMetricType !== undefined) updates.linkedMetricType = args.linkedMetricType as string | null;
        if (args.greatThreshold !== undefined) updates.greatThreshold = args.greatThreshold as number | null;
        if (args.goodThreshold !== undefined) updates.goodThreshold = args.goodThreshold as number | null;
        if (args.windowStart !== undefined) updates.windowStart = args.windowStart as number | null;
        if (args.windowEnd !== undefined) updates.windowEnd = args.windowEnd as number | null;
        if (Object.keys(updates).length === 0) {
          return { result: "No fields to update. Provide at least one of: newName, benefit, risk, intervalDays, category, linkedMetricType, greatThreshold, goodThreshold, windowStart, windowEnd", error: true };
        }
        const result = await updateWellnessActivity(resolvedId!, updates);
        if (!result) return { result: `Activity ${resolvedId} not found`, error: true };
        const response: Record<string, any> = { updated: true, activity: result.activity };
        if (result.warning) response.warning = result.warning;
        return { result: JSON.stringify(response) };
      }
      if (action === "delete_activity") {
        const activityId = args.activityId as number | undefined;
        const name = args.name as string | undefined;
        if (!activityId && !name) {
          return { result: "Either activityId or name is required for delete_activity", error: true };
        }
        let resolvedId = activityId;
        if (!resolvedId && name) {
          const activities = await queryWellnessActivities();
          const lower = name.toLowerCase();
          const match = activities.find(a => a.name.toLowerCase() === lower)
            || activities.find(a => a.name.toLowerCase().includes(lower));
          if (!match) return { result: `No activity found matching "${name}"`, error: true };
          resolvedId = match.id;
        }
        const activity = await archiveWellnessActivity(resolvedId!);
        if (!activity) return { result: `Activity ${resolvedId} not found`, error: true };
        return { result: JSON.stringify({ deleted: true, activity }) };
      }
      if (action === "activity_logs") {
        const activityId = args.activityId as number | undefined;
        const limit = (args.days as number) || 50;
        const logs = await queryActivityLogs(activityId, limit);
        return { result: JSON.stringify({ total: logs.length, items: logs }) };
      }
      if (action === "save_gratitude") {
        const content = args.content as string | undefined;
        const dateStr = args.date as string | undefined;
        if (!content) {
          return { result: "content is required for save_gratitude", error: true };
        }
        if (content.length > 5000) {
          return { result: "content must be 5000 characters or fewer", error: true };
        }
        if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
        }
        const { upsertGratitudeEntry } = await import("./routes/wellness");
        const entry = await upsertGratitudeEntry(content, dateStr);
        return { result: JSON.stringify({ saved: true, entry }) };
      }
      if (action === "get_gratitude") {
        const { userDateStr } = await import("./utils/user-time");
        const dateStr = (args.date as string) || userDateStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
        }
        const { getGratitudeEntry } = await import("./routes/wellness");
        const entry = await getGratitudeEntry(dateStr);
        if (!entry) return { result: `No gratitude entry found for ${dateStr}` };
        return { result: JSON.stringify(entry) };
      }
      if (action === "list_gratitudes") {
        const limit = (args.limit as number) || 30;
        const { listGratitudeEntries } = await import("./routes/wellness");
        const entries = await listGratitudeEntries(limit);
        return { result: JSON.stringify({ total: entries.length, items: entries }) };
      }
      if (action === "save_learning") {
        const content = args.content as string | undefined;
        const dateStr = args.date as string | undefined;
        if (!content) {
          return { result: "content is required for save_learning", error: true };
        }
        if (content.length > 5000) {
          return { result: "content must be 5000 characters or fewer", error: true };
        }
        if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
        }
        const { upsertLearningEntry } = await import("./routes/wellness");
        const entry = await upsertLearningEntry(content, dateStr);
        return { result: JSON.stringify({ saved: true, entry }) };
      }
      if (action === "get_learning") {
        const { userDateStr } = await import("./utils/user-time");
        const dateStr = (args.date as string) || userDateStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return { result: "Invalid date format. Use YYYY-MM-DD", error: true };
        }
        const { getLearningEntry } = await import("./routes/wellness");
        const entry = await getLearningEntry(dateStr);
        if (!entry) return { result: `No learning entry found for ${dateStr}` };
        return { result: JSON.stringify(entry) };
      }
      if (action === "list_learnings") {
        const limit = (args.limit as number) || 30;
        const { listLearningEntries } = await import("./routes/wellness");
        const entries = await listLearningEntries(limit);
        return { result: JSON.stringify({ total: entries.length, items: entries }) };
      }
      return { result: `Unknown health action: ${action}. Available: summary, metrics, list_activities, log_activity, activity_status, create_activity, update_activity, delete_activity, activity_logs, delete_log, save_gratitude, get_gratitude, list_gratitudes, save_learning, get_learning, list_learnings`, error: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Health error: ${msg}`, error: true };
    }
  },

  async exec(args) {
    const { execSkillStorage, execExperienceStorage, execPassionStorage, execMetricsStorage, execEducationStorage } = await import("./exec-storage");
    const { opportunityStorage } = await import("./opportunity-storage");
    const { eventBus } = await import("./event-bus");
    const { insertExecSkillSchema, insertExecExperienceSchema, insertOpportunitySchema, insertExecPassionSchema, createOpportunityInteractionSchema, updateOpportunityInteractionSchema } = await import("@shared/schema");

    const action = (args.action as string | undefined) || "list_skills";
    const { getCurrentPrincipal } = await import("./principal-context");
    const principal = getCurrentPrincipal();
    if (!principal?.userId) return { result: "No authenticated user context for exec tool", error: true };
    const userId = principal.userId;

    const publish = (source: string): void => {
      eventBus.publish({ category: "system", event: "data:exec_changed", payload: { source: `bridge_tool:${source}` } });
    };

    type ExecArgs = {
      action?: string; id?: number; name?: string; category?: string;
      skillType?: string; proficiency?: string; energyLevel?: string;
      domain?: string; narrative?: string; years?: number;
      keyOutcomes?: string[]; transferableAssets?: string[];
      title?: string; description?: string; type?: string; status?: string;
      probability?: number; isFullTime?: boolean; hoursPerWeek?: number;
      timeCommitmentPeriod?: string; timeHorizonMonths?: number;
      evInputs?: Record<string, any>; contactPersonId?: string; championPersonId?: string; followUpBy?: string; followUpNote?: string;
      sourceType?: string; sourceSignalId?: string; requiredSkills?: string[];
      statusFilter?: string; typeFilter?: string;
      opportunityId?: number; skillId?: number; experienceId?: number; associationId?: number;
      personId?: string; interactionId?: string; date?: string; summary?: string; direction?: string; meaningfulness?: string; responseOwed?: boolean; responseDueBy?: string | null; capitalImpact?: string; tags?: string[];
      content?: string; tier?: string; position?: number; sourceRef?: string;
      jdText?: string; format?: string; jobUrl?: string;
      startDate?: string; endDate?: string; company?: string;
      location?: string; nextSteps?: string; priority?: string;
      teamSizePeak?: number; directReports?: number;
      pnlOwned?: string; budgetManaged?: string; fundingRaised?: string; companyContext?: string;
      metric?: string; value?: string; context?: string; verifiedAt?: Date | string | null;
      institution?: string; degree?: string | null; field?: string | null; year?: string | null; notes?: string | null;
      kind?: string; fileName?: string;
    };
    const a = args as ExecArgs;

    try {
      switch (action) {
        // ── Skills ──────────────────────────────────────────────
        case "list_skills": {
          const list = await execSkillStorage.list(userId);
          if (list.length === 0) return { result: "No skills found." };
          const lines = list.map(s => {
            const typePart = s.skillType ? ` type=${s.skillType}` : "";
            return `[${s.id}] ${s.name} — ${s.category || "uncategorized"}, ${s.proficiency || "?"}, energy=${s.energyLevel || "?"}${typePart}`;
          });
          return { result: `${list.length} skill(s):\n${lines.join("\n")}` };
        }
        case "get_skill": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const s = await execSkillStorage.get(a.id);
          if (!s) return { result: `Skill ${a.id} not found`, error: true };
          const skillExps = await execExperienceStorage.getExperienceForSkill(a.id);
          const expPart = skillExps.length
            ? `\n  experience: ${skillExps.map(e => `${e.company || ""} — ${e.domain}`).join("; ")}`
            : "";
          return { result: `[${s.id}] ${s.name}\n  category=${s.category || "?"} type=${s.skillType || "applied"}\n  proficiency=${s.proficiency || "?"} energy=${s.energyLevel || "?"}${expPart}` };
        }
        case "create_skill": {
          if (typeof a.name !== "string" || !a.name) return { result: "Missing required: name", error: true };
          const fields: Record<string, unknown> = { name: a.name };
          if (a.category !== undefined) fields.category = a.category;
          if (a.skillType !== undefined) fields.skillType = a.skillType;
          if (a.proficiency !== undefined) fields.proficiency = a.proficiency;
          if (a.energyLevel !== undefined) fields.energyLevel = a.energyLevel;
          const parsed = insertExecSkillSchema.parse(fields);
          const row = await execSkillStorage.create(userId, parsed);
          publish("create_skill");
          return { result: `Created skill ${row.id} "${row.name}".` };
        }
        case "update_skill": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const updates: Record<string, unknown> = {};
          if (a.name !== undefined) updates.name = a.name;
          if (a.category !== undefined) updates.category = a.category;
          if (a.skillType !== undefined) updates.skillType = a.skillType;
          if (a.proficiency !== undefined) updates.proficiency = a.proficiency;
          if (a.energyLevel !== undefined) updates.energyLevel = a.energyLevel;
          if (Object.keys(updates).length === 0) return { result: "No fields to update", error: true };
          const parsed = insertExecSkillSchema.partial().parse(updates);
          const row = await execSkillStorage.update(a.id, parsed);
          if (!row) return { result: `Skill ${a.id} not found`, error: true };
          publish("update_skill");
          return { result: `Updated skill ${row.id} "${row.name}".` };
        }
        case "delete_skill": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const deleted = await execSkillStorage.delete(a.id);
          if (!deleted) return { result: `Skill ${a.id} not found`, error: true };
          publish("delete_skill");
          return { result: `Deleted skill ${a.id}.` };
        }

        // ── Experience ─────────────────────────────────────────
        case "list_experience": {
          const list = await execExperienceStorage.listWithSkills(userId);
          if (list.length === 0) return { result: "No experience entries found." };
          const lines = list.map(e => {
            const dateRange = e.startDate ? `${e.startDate} – ${e.endDate || "Present"}` : "";
            const company = e.company ? `${e.company} — ` : "";
            const skillNames = (e.linkedSkills || []).map(s => s.name).join(", ");
            const skillPart = skillNames ? ` skills=[${skillNames}]` : "";
            return `[${e.id}] ${company}${e.domain} — ${e.years ?? "?"} years${dateRange ? ` (${dateRange})` : ""}${skillPart}${e.narrative ? `: ${e.narrative.slice(0, 80)}${e.narrative.length > 80 ? "…" : ""}` : ""}`;
          });
          return { result: `${list.length} experience(s):\n${lines.join("\n")}` };
        }
        case "get_experience": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const e = await execExperienceStorage.getWithSkills(a.id);
          if (!e) return { result: `Experience ${a.id} not found`, error: true };
          const dateRange = e.startDate ? ` (${e.startDate} – ${e.endDate || "Present"})` : "";
          const company = e.company ? `${e.company} — ` : "";
          const titlePart = e.title ? ` | ${e.title}` : "";
          const scopeParts: string[] = [];
          if (e.location) scopeParts.push(`location=${e.location}`);
          if (e.teamSizePeak) scopeParts.push(`team=${e.teamSizePeak}`);
          if (e.directReports) scopeParts.push(`reports=${e.directReports}`);
          if (e.pnlOwned) scopeParts.push(`P&L=${e.pnlOwned}`);
          if (e.budgetManaged) scopeParts.push(`budget=${e.budgetManaged}`);
          if (e.fundingRaised) scopeParts.push(`raised=${e.fundingRaised}`);
          const parts = [
            `[${e.id}] ${company}${e.domain}${titlePart} — ${e.years ?? "?"} years${dateRange}`,
            scopeParts.length ? `  scope: ${scopeParts.join(", ")}` : null,
            e.companyContext ? `  context: ${e.companyContext}` : null,
            e.narrative ? `  ${e.narrative}` : null,
            (e.keyOutcomes || []).length ? `  outcomes: ${e.keyOutcomes.join("; ")}` : null,
            (e.linkedSkills || []).length ? `  skills: ${e.linkedSkills.map(s => `${s.name} (${s.proficiency || "?"})`).join(", ")}` : null,
            (e.transferableAssets || []).length ? `  legacyAssets: ${e.transferableAssets.join("; ")}` : null,
          ].filter((l): l is string => Boolean(l));
          return { result: parts.join("\n") };
        }
        case "create_experience": {
          if (typeof a.domain !== "string" || !a.domain) return { result: "Missing required: domain", error: true };
          const fields: Record<string, unknown> = { domain: a.domain };
          if (a.narrative !== undefined) fields.narrative = a.narrative;
          if (a.years !== undefined) fields.years = a.years;
          if (a.keyOutcomes !== undefined) fields.keyOutcomes = a.keyOutcomes;
          if (a.transferableAssets !== undefined) fields.transferableAssets = a.transferableAssets;
          if (a.startDate !== undefined) fields.startDate = a.startDate;
          if (a.endDate !== undefined) fields.endDate = a.endDate;
          if (a.company !== undefined) fields.company = a.company;
          if (a.title !== undefined) fields.title = a.title;
          if (a.location !== undefined) fields.location = a.location;
          if (a.teamSizePeak !== undefined) fields.teamSizePeak = a.teamSizePeak;
          if (a.directReports !== undefined) fields.directReports = a.directReports;
          if (a.pnlOwned !== undefined) fields.pnlOwned = a.pnlOwned;
          if (a.budgetManaged !== undefined) fields.budgetManaged = a.budgetManaged;
          if (a.fundingRaised !== undefined) fields.fundingRaised = a.fundingRaised;
          if (a.companyContext !== undefined) fields.companyContext = a.companyContext;
          const parsed = insertExecExperienceSchema.parse(fields);
          const row = await execExperienceStorage.create(userId, parsed);
          publish("create_experience");
          return { result: `Created experience ${row.id} "${row.domain}".` };
        }
        case "update_experience": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const updates: Record<string, unknown> = {};
          if (a.domain !== undefined) updates.domain = a.domain;
          if (a.narrative !== undefined) updates.narrative = a.narrative;
          if (a.years !== undefined) updates.years = a.years;
          if (a.keyOutcomes !== undefined) updates.keyOutcomes = a.keyOutcomes;
          if (a.transferableAssets !== undefined) updates.transferableAssets = a.transferableAssets;
          if (a.startDate !== undefined) updates.startDate = a.startDate;
          if (a.endDate !== undefined) updates.endDate = a.endDate;
          if (a.company !== undefined) updates.company = a.company;
          if (a.title !== undefined) updates.title = a.title;
          if (a.location !== undefined) updates.location = a.location;
          if (a.teamSizePeak !== undefined) updates.teamSizePeak = a.teamSizePeak;
          if (a.directReports !== undefined) updates.directReports = a.directReports;
          if (a.pnlOwned !== undefined) updates.pnlOwned = a.pnlOwned;
          if (a.budgetManaged !== undefined) updates.budgetManaged = a.budgetManaged;
          if (a.fundingRaised !== undefined) updates.fundingRaised = a.fundingRaised;
          if (a.companyContext !== undefined) updates.companyContext = a.companyContext;
          if (Object.keys(updates).length === 0) return { result: "No fields to update", error: true };
          const parsed = insertExecExperienceSchema.partial().parse(updates);
          const row = await execExperienceStorage.update(a.id, parsed);
          if (!row) return { result: `Experience ${a.id} not found`, error: true };
          publish("update_experience");
          return { result: `Updated experience ${row.id} "${row.domain}".` };
        }
        case "delete_experience": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const deleted = await execExperienceStorage.delete(a.id);
          if (!deleted) return { result: `Experience ${a.id} not found`, error: true };
          publish("delete_experience");
          return { result: `Deleted experience ${a.id}.` };
        }

        // ── Experience ↔ Skill Linking ──────────────────────────
        case "link_skill_to_experience": {
          const expId = a.experienceId ?? a.id;
          const skId = a.skillId;
          if (typeof expId !== "number") return { result: "Missing required: experienceId (or id)", error: true };
          if (typeof skId !== "number") return { result: "Missing required: skillId", error: true };
          await execExperienceStorage.linkSkill(expId, skId);
          publish("link_skill_to_experience");
          return { result: `Linked skill ${skId} to experience ${expId}.` };
        }
        case "unlink_skill_from_experience": {
          const expId = a.experienceId ?? a.id;
          const skId = a.skillId;
          if (typeof expId !== "number") return { result: "Missing required: experienceId (or id)", error: true };
          if (typeof skId !== "number") return { result: "Missing required: skillId", error: true };
          const removed = await execExperienceStorage.unlinkSkill(expId, skId);
          if (!removed) return { result: `Link not found for skill ${skId} on experience ${expId}`, error: true };
          publish("unlink_skill_from_experience");
          return { result: `Unlinked skill ${skId} from experience ${expId}.` };
        }

        // ── Opportunities ──────────────────────────────────────
        case "list_opportunities": {
          const filters: { status?: string; type?: string } = {};
          if (a.statusFilter) filters.status = a.statusFilter;
          if (a.typeFilter) filters.type = a.typeFilter;
          const list = await opportunityStorage.listWithSkills(principal, filters);
          if (list.length === 0) return { result: "No opportunities found." };
          const lines = list.map(o => {
            const ev = o.computedEv != null ? `${Math.round(o.computedEv).toLocaleString()}` : "—";
            const skillNames = (o.linkedSkills || []).map(s => s.name).join(", ");
            const skillPart = skillNames ? ` skills=[${skillNames}]` : "";
            return `[${o.id}] ${o.title} — ${o.type}, ${o.status}, EV=${ev}, prob=${Math.round((o.probability ?? 0) * 100)}%${skillPart}`;
          });
          return { result: `${list.length} opportunity(ies):\n${lines.join("\n")}` };
        }
        case "get_opportunity": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const o = await opportunityStorage.getWithSkills(a.id, principal);
          if (!o) return { result: `Opportunity ${a.id} not found`, error: true };
          const artifacts = await opportunityStorage.getArtifacts(a.id);
          const ev = o.computedEv != null ? `${Math.round(o.computedEv).toLocaleString()}` : "—";
          const parts = [
            `[${o.id}] ${o.title}`,
            `  type=${o.type} status=${o.status} probability=${Math.round((o.probability ?? 0) * 100)}%`,
            `  EV=${ev}`,
            o.companyId ? `  company: @company:${o.companyId}` : o.company ? `  company: ${o.company}` : null,
            o.location ? `  location: ${o.location}` : null,
            o.priority ? `  priority: ${o.priority}` : null,
            o.vaultId ? `  vault: ${o.vaultId}` : `  vault: unassigned`,
            o.description ? `  description: ${o.description.slice(0, 200)}${o.description.length > 200 ? "…" : ""}` : null,
            o.nextSteps ? `  nextSteps: ${o.nextSteps.slice(0, 200)}${o.nextSteps.length > 200 ? "…" : ""}` : null,
            o.isFullTime ? `  Full time` : o.hoursPerWeek ? `  ${o.hoursPerWeek} hrs/${o.timeCommitmentPeriod || "week"}` : null,
            o.timeHorizonMonths ? `  Income starts in ${o.timeHorizonMonths} months` : null,
            o.contactPersonId ? `  contact: ${o.contactPersonId}` : null,
            o.championPersonId ? `  champion: ${o.championPersonId}` : null,
            o.followUpBy ? `  followUpBy: ${o.followUpBy}` : null,
            o.followUpNote ? `  followUpNote: ${o.followUpNote}` : null,
            o.sourceType !== "manual" ? `  source: ${o.sourceType}${o.sourceSignalId ? ` signal=${o.sourceSignalId}` : ""}` : null,
            (o.linkedSkills || []).length ? `  linkedSkills: ${o.linkedSkills!.map(s => `${s.name} (${s.proficiency || "?"}/${s.energyLevel || "?"})`).join(", ")}` : null,
            (o.requiredSkills || []).length ? `  requiredSkills(legacy): ${o.requiredSkills.join(", ")}` : null,
            artifacts.length ? `  artifacts: ${artifacts.map(x => `${x.kind}:${x.libraryPageId}${x.sessionId ? ` session=${x.sessionId}` : ""}`).join(", ")}` : null,
            `  evInputs: ${JSON.stringify(o.evInputs)}`,
          ].filter((l): l is string => Boolean(l));
          return { result: parts.join("\n") };
        }
        case "create_opportunity": {
          if (typeof a.title !== "string" || !a.title) return { result: "Missing required: title", error: true };
          if (typeof a.type !== "string" || !a.type) return { result: "Missing required: type", error: true };
          const fields: Record<string, unknown> = { title: a.title, type: a.type };
          if (a.description !== undefined) fields.description = a.description;
          if (a.status !== undefined) fields.status = a.status;
          if (a.probability !== undefined) fields.probability = a.probability;
          if (a.isFullTime !== undefined) fields.isFullTime = a.isFullTime;
          if (a.hoursPerWeek !== undefined) fields.hoursPerWeek = a.hoursPerWeek;
          if (a.timeCommitmentPeriod !== undefined) fields.timeCommitmentPeriod = a.timeCommitmentPeriod;
          if (a.timeHorizonMonths !== undefined) fields.timeHorizonMonths = a.timeHorizonMonths;
          if (a.evInputs !== undefined) fields.evInputs = a.evInputs;
          if (a.company !== undefined) fields.company = a.company;
          if (a.companyId !== undefined) fields.companyId = a.companyId;
          if (a.location !== undefined) fields.location = a.location;
          if (a.nextSteps !== undefined) fields.nextSteps = a.nextSteps;
          if (a.priority !== undefined) fields.priority = a.priority;
          if (a.contactPersonId !== undefined) fields.contactPersonId = a.contactPersonId;
          if (a.sourceType !== undefined) fields.sourceType = a.sourceType;
          if (a.sourceSignalId !== undefined) fields.sourceSignalId = a.sourceSignalId;
          if (a.requiredSkills !== undefined) fields.requiredSkills = a.requiredSkills;
          if (a.jdText !== undefined) fields.jdText = a.jdText;
          if (a.jobUrl !== undefined) fields.jobUrl = a.jobUrl;
          if (a.championPersonId !== undefined) fields.championPersonId = a.championPersonId;
          if (a.followUpBy !== undefined) fields.followUpBy = a.followUpBy;
          if (a.followUpNote !== undefined) fields.followUpNote = a.followUpNote;
          if (a.vaultId !== undefined) fields.vaultId = a.vaultId;
          const parsed = insertOpportunitySchema.parse(fields);
          const row = await opportunityStorage.create(principal, parsed);
          publish("create_opportunity");
          return { result: `Created opportunity ${row.id} "${row.title}" (EV=${Math.round(row.computedEv ?? 0).toLocaleString()}).` };
        }
        case "update_opportunity": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const updates: Record<string, unknown> = {};
          if (a.title !== undefined) updates.title = a.title;
          if (a.description !== undefined) updates.description = a.description;
          if (a.type !== undefined) updates.type = a.type;
          if (a.status !== undefined) updates.status = a.status;
          if (a.probability !== undefined) updates.probability = a.probability;
          if (a.isFullTime !== undefined) updates.isFullTime = a.isFullTime;
          if (a.hoursPerWeek !== undefined) updates.hoursPerWeek = a.hoursPerWeek;
          if (a.timeCommitmentPeriod !== undefined) updates.timeCommitmentPeriod = a.timeCommitmentPeriod;
          if (a.timeHorizonMonths !== undefined) updates.timeHorizonMonths = a.timeHorizonMonths;
          if (a.evInputs !== undefined) updates.evInputs = a.evInputs;
          if (a.company !== undefined) updates.company = a.company;
          if (a.companyId !== undefined) updates.companyId = a.companyId;
          if (a.location !== undefined) updates.location = a.location;
          if (a.nextSteps !== undefined) updates.nextSteps = a.nextSteps;
          if (a.priority !== undefined) updates.priority = a.priority;
          if (a.contactPersonId !== undefined) updates.contactPersonId = a.contactPersonId;
          if (a.sourceType !== undefined) updates.sourceType = a.sourceType;
          if (a.sourceSignalId !== undefined) updates.sourceSignalId = a.sourceSignalId;
          if (a.requiredSkills !== undefined) updates.requiredSkills = a.requiredSkills;
          if (a.jdText !== undefined) updates.jdText = a.jdText;
          if (a.jobUrl !== undefined) updates.jobUrl = a.jobUrl;
          if (a.championPersonId !== undefined) updates.championPersonId = a.championPersonId;
          if (a.followUpBy !== undefined) updates.followUpBy = a.followUpBy;
          if (a.followUpNote !== undefined) updates.followUpNote = a.followUpNote;
          if (a.vaultId !== undefined) updates.vaultId = a.vaultId;
          if (Object.keys(updates).length === 0) return { result: "No fields to update", error: true };
          const parsed = insertOpportunitySchema.partial().parse(updates);
          const row = await opportunityStorage.update(a.id, parsed, principal);
          if (!row) return { result: `Opportunity ${a.id} not found`, error: true };
          publish("update_opportunity");
          return { result: `Updated opportunity ${row.id} "${row.title}" (EV=${Math.round(row.computedEv ?? 0).toLocaleString()}).` };
        }
        case "delete_opportunity": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const deleted = await opportunityStorage.delete(a.id, principal);
          if (!deleted) return { result: `Opportunity ${a.id} not found`, error: true };
          publish("delete_opportunity");
          return { result: `Deleted opportunity ${a.id}.` };
        }

        // ── Opportunity ↔ Person interaction activities ───────
        case "list_opportunity_activities": {
          const opportunityId = a.opportunityId ?? a.id;
          if (typeof opportunityId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          const activities = await opportunityStorage.listActivities(opportunityId, principal);
          if (activities.length === 0) return { result: "No linked activities." };
          return { result: activities.map(activity => `[${activity.associationId}] ${activity.interaction.date} ${activity.personName}: ${activity.interaction.summary} ${activity.reference}`).join("\n") };
        }
        case "create_or_link_opportunity_activity": {
          const opportunityId = a.opportunityId ?? a.id;
          if (typeof opportunityId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          const input = createOpportunityInteractionSchema.parse({
            personId: a.personId, interactionId: a.interactionId, date: a.date, type: a.type,
            summary: a.summary, context: a.context, direction: a.direction, meaningfulness: a.meaningfulness,
            responseOwed: a.responseOwed, responseDueBy: a.responseDueBy, capitalImpact: a.capitalImpact, tags: a.tags,
          });
          const activity = await opportunityStorage.createOrLinkActivity(opportunityId, input, principal);
          publish("create_or_link_opportunity_activity");
          return { result: `Linked activity ${activity.associationId} to opportunity ${opportunityId}: ${activity.reference}` };
        }
        case "update_opportunity_activity": {
          const opportunityId = a.opportunityId ?? a.id;
          if (typeof opportunityId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          if (typeof a.associationId !== "number") return { result: "Missing required: associationId", error: true };
          const updates = updateOpportunityInteractionSchema.parse({
            date: a.date, type: a.type, summary: a.summary, context: a.context, direction: a.direction,
            meaningfulness: a.meaningfulness, responseOwed: a.responseOwed, responseDueBy: a.responseDueBy,
            capitalImpact: a.capitalImpact, tags: a.tags,
          });
          const activity = await opportunityStorage.updateActivity(opportunityId, a.associationId, updates, principal);
          if (!activity) return { result: "Activity association not found", error: true };
          publish("update_opportunity_activity");
          return { result: `Updated ${activity.reference}.` };
        }
        case "unlink_opportunity_activity": {
          const opportunityId = a.opportunityId ?? a.id;
          if (typeof opportunityId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          if (typeof a.associationId !== "number") return { result: "Missing required: associationId", error: true };
          const removed = await opportunityStorage.unlinkActivity(opportunityId, a.associationId, principal);
          if (!removed) return { result: "Activity association not found", error: true };
          publish("unlink_opportunity_activity");
          return { result: `Unlinked activity ${a.associationId} from opportunity ${opportunityId}. The Person interaction was preserved.` };
        }

        // ── Opportunity ↔ Skill Linking ────────────────────────
        case "link_skill": {
          const oppId = a.opportunityId ?? a.id;
          const skId = a.skillId;
          if (typeof oppId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          if (typeof skId !== "number") return { result: "Missing required: skillId", error: true };
          await opportunityStorage.linkSkill(oppId, skId);
          publish("link_skill");
          return { result: `Linked skill ${skId} to opportunity ${oppId}.` };
        }
        case "unlink_skill": {
          const oppId = a.opportunityId ?? a.id;
          const skId = a.skillId;
          if (typeof oppId !== "number") return { result: "Missing required: opportunityId (or id)", error: true };
          if (typeof skId !== "number") return { result: "Missing required: skillId", error: true };
          const removed = await opportunityStorage.unlinkSkill(oppId, skId);
          if (!removed) return { result: `Link not found for skill ${skId} on opportunity ${oppId}`, error: true };
          publish("unlink_skill");
          return { result: `Unlinked skill ${skId} from opportunity ${oppId}.` };
        }

        // ── Mission (canonical) / Passions (legacy) ─────────
        case "list_mission":
        case "list_passions": {
          const list = await execPassionStorage.list(userId);
          if (list.length === 0) return { result: "No passions found." };
          const grouped: Record<string, typeof list> = {};
          for (const p of list) {
            const t = p.tier || "unknown";
            (grouped[t] ??= []).push(p);
          }
          const sections = Object.entries(grouped).map(([tier, items]) => {
            const lines = items.map(p => `  [${p.id}] ${p.title ?? "(untitled)"} — ${(p.content ?? "").slice(0, 80)}${(p.content ?? "").length > 80 ? "…" : ""}`);
            return `${tier} (${items.length}):\n${lines.join("\n")}`;
          });
          return { result: `${list.length} passion(s):\n${sections.join("\n\n")}` };
        }
        case "get_mission_item":
        case "get_passion": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const p = await execPassionStorage.get(a.id);
          if (!p) return { result: `Passion ${a.id} not found`, error: true };
          const parts = [
            `[${p.id}] ${p.title ?? "(untitled)"}`,
            `  tier=${p.tier} position=${p.position ?? "?"}`,
            p.content ? `  ${p.content}` : null,
            p.sourceRef ? `  source: ${p.sourceRef}` : null,
          ].filter((l): l is string => Boolean(l));
          return { result: parts.join("\n") };
        }
        case "create_mission_item":
        case "create_passion": {
          if (typeof a.tier !== "string" || !a.tier) return { result: "Missing required: tier", error: true };
          if (typeof a.content !== "string" || !a.content) return { result: "Missing required: content", error: true };
          const fields: Record<string, unknown> = { tier: a.tier, content: a.content };
          if (a.title !== undefined) fields.title = a.title;
          if (a.position !== undefined) fields.position = a.position;
          if (a.sourceRef !== undefined) fields.sourceRef = a.sourceRef;
          const parsed = insertExecPassionSchema.parse(fields);
          const row = await execPassionStorage.create(userId, parsed);
          publish("create_passion");
          return { result: `Created passion ${row.id} "${row.title ?? row.tier}".` };
        }
        case "update_mission_item":
        case "update_passion": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const updates: Record<string, unknown> = {};
          if (a.tier !== undefined) updates.tier = a.tier;
          if (a.content !== undefined) updates.content = a.content;
          if (a.title !== undefined) updates.title = a.title;
          if (a.position !== undefined) updates.position = a.position;
          if (a.sourceRef !== undefined) updates.sourceRef = a.sourceRef;
          if (Object.keys(updates).length === 0) return { result: "No fields to update", error: true };
          const parsed = insertExecPassionSchema.partial().parse(updates);
          const row = await execPassionStorage.update(a.id, parsed);
          if (!row) return { result: `Passion ${a.id} not found`, error: true };
          publish("update_passion");
          return { result: `Updated passion ${row.id} "${row.title ?? row.tier}".` };
        }
        case "delete_mission_item":
        case "delete_passion": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const deleted = await execPassionStorage.delete(a.id);
          if (!deleted) return { result: `Passion ${a.id} not found`, error: true };
          publish("delete_passion");
          return { result: `Deleted passion ${a.id}.` };
        }

        // ── Metrics / Education / Artifacts ───────────────────
        case "list_metrics": {
          const rows = await execMetricsStorage.list(userId, a.experienceId);
          return { result: JSON.stringify(rows, null, 2) };
        }
        case "create_metric": {
          if (!a.metric || !a.value) return { result: "Missing required: metric, value", error: true };
          const row = await execMetricsStorage.create(userId, { experienceId: a.experienceId ?? null, metric: a.metric, value: a.value, context: a.context ?? null, verifiedAt: a.verifiedAt ? new Date(a.verifiedAt) : null });
          publish("create_metric");
          return { result: `Created metric ${row.id}.` };
        }
        case "update_metric": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const row = await execMetricsStorage.update(a.id, { experienceId: a.experienceId, metric: a.metric, value: a.value, context: a.context, verifiedAt: a.verifiedAt ? new Date(a.verifiedAt) : undefined });
          if (!row) return { result: `Metric ${a.id} not found`, error: true };
          publish("update_metric");
          return { result: `Updated metric ${a.id}.` };
        }
        case "delete_metric": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const ok = await execMetricsStorage.delete(a.id);
          if (!ok) return { result: `Metric ${a.id} not found`, error: true };
          publish("delete_metric");
          return { result: `Deleted metric ${a.id}.` };
        }
        case "list_education": {
          const rows = await execEducationStorage.list(userId);
          return { result: JSON.stringify(rows, null, 2) };
        }
        case "create_education": {
          if (!a.institution) return { result: "Missing required: institution", error: true };
          const row = await execEducationStorage.create(userId, { institution: a.institution, degree: a.degree, field: a.field, year: a.year, notes: a.notes });
          publish("create_education");
          return { result: `Created education ${row.id}.` };
        }
        case "update_education": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const row = await execEducationStorage.update(a.id, { institution: a.institution, degree: a.degree, field: a.field, year: a.year, notes: a.notes });
          if (!row) return { result: `Education ${a.id} not found`, error: true };
          publish("update_education");
          return { result: `Updated education ${a.id}.` };
        }
        case "delete_education": {
          if (typeof a.id !== "number") return { result: "Missing required: id", error: true };
          const ok = await execEducationStorage.delete(a.id);
          if (!ok) return { result: `Education ${a.id} not found`, error: true };
          publish("delete_education");
          return { result: `Deleted education ${a.id}.` };
        }
        case "set_artifact": {
          const id = a.opportunityId ?? a.id;
          if (typeof id !== "number" || typeof a.kind !== "string") return { result: "Missing required: opportunityId, kind", error: true };
          if (a.libraryPageId === null || a.libraryPageId === undefined) {
            const deleted = await opportunityStorage.deleteArtifact(id, a.kind as any);
            if (!deleted) return { result: `No ${a.kind} artifact found on opportunity ${id}`, error: true };
            publish("set_artifact");
            return { result: `Cleared ${a.kind} artifact from opportunity ${id}.` };
          }
          const row = await opportunityStorage.upsertArtifact(id, a.kind as any, {
            libraryPageId: a.libraryPageId,
            sessionId: a._sessionId ?? null,
          });
          publish("set_artifact");
          return { result: `Set ${a.kind} artifact on opportunity ${id} → library page ${a.libraryPageId} (artifact #${row.id}).` };
        }
        case "get_opportunity_artifacts": {
          const id = a.opportunityId ?? a.id;
          if (typeof id !== "number") return { result: "Missing required: opportunityId", error: true };
          const rows = await opportunityStorage.getArtifacts(id);
          return { result: JSON.stringify(rows, null, 2) };
        }
        case "render_artifact_docx": {
          const id = a.opportunityId ?? a.id;
          if (typeof id !== "number" || typeof a.kind !== "string" || !a.content) return { result: "Missing required: opportunityId, kind, content", error: true };
          const { renderArtifactDocx } = await import("./artifact-docx");
          const fileName = await renderArtifactDocx(a.kind as "resume" | "cover_letter", a.content, a.fileName);
          if (a.kind === "resume" || a.kind === "cover_letter") await opportunityStorage.setArtifactDocx(id, a.kind, fileName);
          // Record session artifact link
          const { recordSessionArtifact: recordDocxArtifact } = await import("./session-artifacts");
          recordDocxArtifact(args._sessionId, "docx", fileName, { opportunityId: id, kind: a.kind });
          return { result: `Artifact DOCX generated: ${fileName}` };
        }

        default:
          return {
            result: `Unknown exec action: ${action}. Available: list_skills, get_skill, create_skill, update_skill, delete_skill, list_experience, get_experience, create_experience, update_experience, delete_experience, link_skill_to_experience, unlink_skill_from_experience, list_opportunities, get_opportunity, create_opportunity, update_opportunity, delete_opportunity, list_opportunity_activities, create_or_link_opportunity_activity, update_opportunity_activity, unlink_opportunity_activity, link_skill, unlink_skill, list_passions/list_mission, get_passion/get_mission_item, create_passion/create_mission_item, update_passion/update_mission_item, delete_passion/delete_mission_item, list_metrics, create_metric, update_metric, delete_metric, list_education, create_education, update_education, delete_education, set_artifact, get_opportunity_artifacts, render_artifact_docx`,
            error: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `exec error: ${msg}`, error: true };
    }
  },

  async theses(args) {
    const { thesisStorage } = await import("./thesis-storage");
    const { eventBus } = await import("./event-bus");
    const { thesisStatuses, thesisConvictions, predictionOutcomes } = await import("@shared/schema");

    const action = (args.action as string | undefined) || "list";

    const publish = (source: string): void => {
      eventBus.publish({ category: "system", event: "data:theses_changed", payload: { source: `bridge_tool:${source}` } });
    };

    const requireString = (v: unknown, name: string): string => {
      if (typeof v !== "string" || !v) throw new Error(`Missing required: ${name}`);
      return v;
    };

    type ThesesArgs = {
      action?: string; id?: string; title?: string; statement?: string;
      tags?: string[]; status?: string; conviction?: string; successorId?: string;
      content?: string; sourceUrl?: string; position?: number;
      claim?: string; deadline?: string; outcome?: string;
      evidenceId?: string; predictionId?: string;
    };
    const a = args as ThesesArgs;

    try {
      switch (action) {
        case "list": {
          const statusRaw = a.status;
          let status: undefined | string;
          if (statusRaw && statusRaw !== "all") {
            if (!(thesisStatuses as readonly string[]).includes(statusRaw)) {
              return { result: `Invalid status: ${statusRaw}. Use draft, active, superseded, invalidated, or all.`, error: true };
            }
            status = statusRaw;
          }
          const list = await thesisStorage.list(status ? { status: status as any } : undefined);
          if (list.length === 0) return { result: status ? `No ${status} theses.` : "No theses found." };
          const lines = list.map(t => {
            const tags = (t.tags || []).join(", ");
            return `[${t.id}] ${t.title} (${t.status}, ${t.conviction})${tags ? ` [${tags}]` : ""}`;
          });
          return { result: `${list.length} thesis/theses:\n${lines.join("\n")}` };
        }
        case "get": {
          const id = requireString(a.id, "id");
          const t = await thesisStorage.get(id);
          if (!t) return { result: `Thesis ${id} not found`, error: true };
          const evidence = await thesisStorage.listEvidence(id);
          const predictions = await thesisStorage.listPredictions(id);
          const sections = [
            `[${t.id}] ${t.title}`,
            `  status=${t.status} conviction=${t.conviction}`,
            t.statement ? `  statement: ${t.statement}` : null,
            (t.tags || []).length ? `  tags: ${t.tags!.join(", ")}` : null,
            t.successorId ? `  successor: ${t.successorId}` : null,
            evidence.length ? `\nEvidence (${evidence.length}):\n${evidence.map(e => `  - [${e.id}] ${e.content}${e.sourceUrl ? ` (${e.sourceUrl})` : ""}`).join("\n")}` : null,
            predictions.length ? `\nPredictions (${predictions.length}):\n${predictions.map(p => `  - [${p.id}] ${p.outcome} — ${p.claim}${p.deadline ? ` (due ${p.deadline})` : ""}`).join("\n")}` : null,
          ].filter((l): l is string => Boolean(l));
          return { result: sections.join("\n") };
        }
        case "create": {
          const title = requireString(a.title, "title");
          const fields: Record<string, unknown> = { title };
          if (typeof a.statement === "string") fields.statement = a.statement;
          if (Array.isArray(a.tags)) fields.tags = a.tags;
          if (typeof a.conviction === "string") {
            if (!(thesisConvictions as readonly string[]).includes(a.conviction)) {
              return { result: `Invalid conviction: ${a.conviction}. Use low or high.`, error: true };
            }
            fields.conviction = a.conviction;
          }
          if (typeof a.status === "string") fields.status = a.status;
          const row = await thesisStorage.create(fields as any);
          publish("create");
          return { result: `Created thesis ${row.id} "${row.title}" (${row.status}, ${row.conviction}).` };
        }
        case "update": {
          const id = requireString(a.id, "id");
          const updates: Record<string, unknown> = {};
          if (a.title !== undefined) updates.title = String(a.title);
          if (a.statement !== undefined) updates.statement = String(a.statement);
          if (Array.isArray(a.tags)) updates.tags = a.tags;
          if (a.conviction !== undefined) {
            if (!(thesisConvictions as readonly string[]).includes(a.conviction)) {
              return { result: `Invalid conviction: ${a.conviction}. Use low or high.`, error: true };
            }
            updates.conviction = a.conviction;
          }
          if (a.status !== undefined) {
            if (!(thesisStatuses as readonly string[]).includes(a.status)) {
              return { result: `Invalid status: ${a.status}. Use draft, active, superseded, invalidated.`, error: true };
            }
            updates.status = a.status;
          }
          if (a.successorId !== undefined) updates.successorId = a.successorId;
          if (a.status === "superseded" && a.successorId === id) {
            return { result: "Cannot supersede to self.", error: true };
          }
          const row = await thesisStorage.update(id, updates);
          if (!row) return { result: `Thesis ${id} not found`, error: true };
          publish("update");
          return { result: `Updated thesis ${row.id}.` };
        }
        case "delete": {
          const id = requireString(a.id, "id");
          const ok = await thesisStorage.delete(id);
          if (!ok) return { result: `Thesis ${id} not found`, error: true };
          publish("delete");
          return { result: `Deleted thesis ${id}.` };
        }
        case "add_evidence": {
          const id = requireString(a.id, "id");
          const content = requireString(a.content, "content");
          const t = await thesisStorage.get(id);
          if (!t) return { result: `Thesis ${id} not found`, error: true };
          const row = await thesisStorage.addEvidence({
            thesisId: id,
            content,
            sourceUrl: typeof a.sourceUrl === "string" ? a.sourceUrl : undefined,
            position: typeof a.position === "number" ? a.position : undefined,
          });
          publish("add_evidence");
          return { result: `Added evidence ${row.id} to thesis ${id}.` };
        }
        case "update_evidence": {
          const eid = requireString(a.evidenceId, "evidenceId");
          const updates: Record<string, unknown> = {};
          if (typeof a.content === "string") updates.content = a.content;
          if (typeof a.sourceUrl === "string") updates.sourceUrl = a.sourceUrl;
          if (typeof a.position === "number") updates.position = a.position;
          const row = await thesisStorage.updateEvidence(eid, updates);
          if (!row) return { result: `Evidence ${eid} not found`, error: true };
          publish("update_evidence");
          return { result: `Updated evidence ${eid}.` };
        }
        case "remove_evidence": {
          const eid = requireString(a.evidenceId, "evidenceId");
          const ok = await thesisStorage.removeEvidence(eid);
          if (!ok) return { result: `Evidence ${eid} not found`, error: true };
          publish("remove_evidence");
          return { result: `Removed evidence ${eid}.` };
        }
        case "add_prediction": {
          const id = requireString(a.id, "id");
          const claim = requireString(a.claim, "claim");
          const t = await thesisStorage.get(id);
          if (!t) return { result: `Thesis ${id} not found`, error: true };
          const row = await thesisStorage.addPrediction({
            thesisId: id,
            claim,
            deadline: typeof a.deadline === "string" ? a.deadline : undefined,
            conviction: typeof a.conviction === "string" ? a.conviction as any : undefined,
          });
          publish("add_prediction");
          return { result: `Added prediction ${row.id} to thesis ${id} (conviction: ${row.conviction ?? "low"}).` };
        }
        case "resolve_prediction": {
          const pid = requireString(a.predictionId, "predictionId");
          const outcome = requireString(a.outcome, "outcome");
          if (!(predictionOutcomes as readonly string[]).includes(outcome)) {
            return { result: `Invalid outcome: ${outcome}. Use pending, correct, incorrect, expired.`, error: true };
          }
          const resolutionNotes = typeof a.resolutionNotes === "string" ? a.resolutionNotes : undefined;
          const row = await thesisStorage.resolvePrediction(pid, outcome as any, resolutionNotes);
          if (!row) return { result: `Prediction ${pid} not found`, error: true };
          publish("resolve_prediction");
          return { result: `Resolved prediction ${pid} as ${outcome}.` };
        }
        case "remove_prediction": {
          const pid = requireString(a.predictionId, "predictionId");
          const ok = await thesisStorage.removePrediction(pid);
          if (!ok) return { result: `Prediction ${pid} not found`, error: true };
          publish("remove_prediction");
          return { result: `Removed prediction ${pid}.` };
        }
        default:
          return {
            result: `Unknown theses action: ${action}. Available: list, get, create, update, delete, add_evidence, update_evidence, remove_evidence, add_prediction, resolve_prediction, remove_prediction`,
            error: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `Theses error: ${msg}`, error: true };
    }
  },
  async news(args) {
    const action = args.action as string;
    if (!action) return { result: "Missing action parameter", error: true };
    try {
      const { signalStorage } = await import("./news-storage");
      const adapters = await import("./news-adapters");

      switch (action) {
        case "summary": {
          const summary = await signalStorage.getNewsSummary();
          return { result: JSON.stringify(summary) };
        }
        case "scan": {
          const { runLandscapeScan } = await import("./news-scan-service");
          const result = await runLandscapeScan();
          return {
            result: JSON.stringify(result),
            error: result.outcome === "failed",
          };
        }

        case "list_signals": {
          const opts: any = {};
          if (args.status) opts.status = args.status;
          if (args.source_type) opts.sourceType = args.source_type;
          if (args.limit) opts.limit = Number(args.limit);
          if (args.offset) opts.offset = Number(args.offset);
          if (args.min_relevance) opts.minRelevance = Number(args.min_relevance);
          if (args.curation_status) opts.curationStatus = args.curation_status;
          if (args.has_curation !== undefined) opts.hasCuration = args.has_curation === true || args.has_curation === "true";
          if (args.matched_topic) opts.matchedTopic = args.matched_topic;
          if (args.query) opts.query = args.query;
          if (args.created_after) opts.createdAfter = new Date(args.created_after);
          if (args.created_before) opts.createdBefore = new Date(args.created_before);
          const { items, total } = await signalStorage.listSignals(opts);
          return { result: JSON.stringify({ total, count: items.length, items }) };
        }

        case "get_signal": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const signal = await signalStorage.getSignal(id);
          if (!signal) return { result: `Signal "${id}" not found`, error: true };
          return { result: JSON.stringify(signal) };
        }

        case "dismiss_signal": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const updated = await signalStorage.updateSignalStatus(id, "dismissed");
          if (!updated) return { result: `Signal "${id}" not found`, error: true };
          return { result: `Signal ${id} dismissed.` };
        }

        case "save_signal": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const updated = await signalStorage.updateSignalStatus(id, "saved");
          if (!updated) return { result: `Signal "${id}" not found`, error: true };
          return { result: `Signal ${id} saved.` };
        }

        case "surface_signal": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const updated = await signalStorage.surfaceSignal(id);
          if (!updated) return { result: `Signal "${id}" not found`, error: true };
          return { result: `Signal ${id} surfaced.` };
        }

        case "add_source": {
          const sourceType = args.source_type as string;
          const value = args.value as string;
          if (!sourceType) return { result: "Missing 'source_type' parameter. Options: x_account, subreddit, rss_feed, pinned_topic, hackernews, github_repo, polymarket, stocktwits, arxiv, youtube_channel", error: true };
          if (!value) return { result: "Missing 'value' parameter", error: true };
          const source = await signalStorage.addSource({ sourceType, value });
          return { result: `Added source: ${sourceType} = "${value}" (id: ${source.id})` };
        }

        case "add_topic": {
          const value = args.value as string;
          if (!value) return { result: "Missing 'value' parameter — the topic to add", error: true };
          // Dedup check
          const existing = await signalStorage.listSources({ sourceType: "pinned_topic" });
          if (existing.some(s => s.value.toLowerCase() === value.toLowerCase())) {
            return { result: `Topic "${value}" already exists.` };
          }
          const source = await signalStorage.addSource({ sourceType: "pinned_topic", value });
          return { result: `Added topic: "${value}" (id: ${source.id})` };
        }

        case "list_sources": {
          const sourceType = args.source_type as string | undefined;
          const sources = await signalStorage.listSources(sourceType ? { sourceType } : undefined);
          return { result: JSON.stringify({ total: sources.length, sources }) };
        }

        case "update_source": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const updates: any = {};
          if (args.value !== undefined) updates.value = args.value;
          if (args.enabled !== undefined) updates.enabled = args.enabled;
          if (args.source_type !== undefined) updates.sourceType = args.source_type;
          const source = await signalStorage.updateSource(id, updates);
          if (!source) return { result: `Source "${id}" not found`, error: true };
          return { result: `Source ${id} updated.` };
        }

        case "delete_source": {
          const id = args.id as string;
          if (!id) return { result: "Missing 'id' parameter", error: true };
          const deleted = await signalStorage.deleteSource(id);
          if (!deleted) return { result: `Source "${id}" not found`, error: true };
          return { result: `Source ${id} deleted.` };
        }

        case "list_scan_runs": {
          const limit = args.limit ? Number(args.limit) : 10;
          const runs = await signalStorage.listScanRuns(limit);
          return { result: JSON.stringify({ total: runs.length, runs }) };
        }

        case "interest_graph": {
          const graph = await adapters.buildInterestGraph();
          const queries = adapters.generateSearchQueries(graph);
          return { result: JSON.stringify({ topics: graph, searchQueries: queries }) };
        }

        case "batch_curate": {
          const decisions = args.decisions as Array<{
            fingerprint: string;
            isRelevant: boolean;
            score: number;
            title: string;
            reason: string;
            matchedTopics: string[];
            summary?: string;
          }>;
          if (!decisions || !Array.isArray(decisions)) {
            return { result: "Missing 'decisions' array parameter", error: true };
          }
          const { bufferCurationDecisions } = await import("./news-curation-handoff");
          const { requireCurrentPrincipal: _getPrincipal } = await import("./principal-context");
          const _principal = _getPrincipal();
          if (!_principal.userId) {
            return {
              result: JSON.stringify({
                status: "failed",
                buffered: 0,
                error: "No user principal in context; curation decisions cannot be buffered.",
              }),
              error: true,
            };
          }
          // batch_curate does not persist curation to signal rows — it hands decisions
          // off to an in-progress news scan, which applies them. Report the true outcome
          // and fail loudly when invoked standalone with no scan consumer to apply them.
          const outcome = await bufferCurationDecisions(_principal.userId, decisions);
          if (outcome.status === "no_consumer") {
            return {
              result: JSON.stringify({
                status: "no_consumer",
                buffered: outcome.buffered,
                error: `No active news scan is consuming curation. batch_curate only hands decisions off to an in-progress scan, which applies them to signal rows; it does not persist curation on its own. Invoked with no scan consumer present, so these ${outcome.buffered} decisions were not buffered and cannot be applied. Run curation through a news scan.`,
              }),
              error: true,
            };
          }
          return {
            result: JSON.stringify({
              status: "buffered",
              buffered: outcome.buffered,
              note: `Handed ${outcome.buffered} decisions off to the active scan consumer, which will apply them to signal rows and clear the buffer. batch_curate does not persist curation directly.`,
            }),
          };
        }

        default:
          return {
            result: `Unknown news action: ${action}. Available: summary, scan, list_signals, get_signal, dismiss_signal, save_signal, surface_signal, add_source, add_topic, list_sources, update_source, delete_source, list_scan_runs, interest_graph, batch_curate`,
            error: true,
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: `News error: ${msg}`, error: true };
    }
  },
  async landscape(args) {
    return umbrellaHandlers.news(args);
  },
};

const cognitionTools: Record<string, ToolHandler> = {
  async cognition(args) {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };

    // Canonical model-visible home for self-observation and profile state. Delegate
    // to existing handlers so validation, provenance, and profile permissions stay
    // at their deterministic per-action authority boundaries.
    if (action === "observe") {
      return recordMetacognitiveObservationTool({ ...args, type: args.observation_type, content: args.observation });
    }
    if (action === "get_profile" || action === "update_profile") {
      return bridgeHandlers.agent_profile({ ...args, action: action === "get_profile" ? "get" : "update" });
    }

    const sub: Record<string, (a: Record<string, any>) => Promise<ToolHandlerResult>> = {
      set_emotion: async (a) => {
        const { fileEmotionalStateStorage } = await import("./file-storage/emotional-state");
        const stateName = a.state_name || a.stateName;
        if (!stateName) return { result: "Missing state_name", error: true };
        const entry = await fileEmotionalStateStorage.record({
          stateName,
          valence: a.valence ?? 0,
          arousal: a.arousal ?? 0.5,
          triggers: a.triggers || [],
          context: a.context || "",
          narrative: a.narrative || "",
          source: "explicit",
        });
        eventBus.publish({
          category: "agent",
          event: "cognition.emotion.changed",
          payload: { stateId: entry.id, stateName: entry.stateName, valence: entry.valence, arousal: entry.arousal },
        });
        return { result: `Emotional state set: ${entry.stateName} (v=${entry.valence}, a=${entry.arousal}, id=${entry.id})` };
      },

      get_emotion: async () => {
        const { fileEmotionalStateStorage } = await import("./file-storage/emotional-state");
        const current = await fileEmotionalStateStorage.getCurrent();
        if (!current) return { result: "No emotional state currently set." };
        const parts = [
          `**${current.stateName}**`,
          `Valence: ${current.valence} | Arousal: ${current.arousal}`,
          current.stale ? "⚠️ Stale (>4h old)" : `Set: ${current.createdAt}`,
        ];
        if (current.narrative) parts.push(`Narrative: ${current.narrative}`);
        if (current.triggers.length > 0) parts.push(`Triggers: ${current.triggers.join(", ")}`);
        if (current.context) parts.push(`Context: ${current.context}`);
        return { result: parts.join("\n") };
      },

      emotion_history: async (a) => {
        const { fileEmotionalStateStorage } = await import("./file-storage/emotional-state");
        const limit = a.limit || 10;
        const entries = await fileEmotionalStateStorage.getRecent(limit);
        if (entries.length === 0) return { result: "No emotional state history." };
        const lines = entries.map(e =>
          `- [${e.createdAt}] ${e.stateName} (v=${e.valence}, a=${e.arousal})${e.stale ? " ⚠️stale" : ""}${e.triggers.length ? ` — ${e.triggers.join(", ")}` : ""}`
        );
        return { result: `${entries.length} emotional states:\n${lines.join("\n")}` };
      },

      get_persona: async () => {
        const { resolveSessionPersona } = await import("./session-persona");
        const active = await resolveSessionPersona(args._sessionId);
        if (!active) return { result: "No persona available.", error: true };
        const parts = [
          `**${active.name}** (id=${active.id})`,
          active.description,
        ];
        if (active.expressionTags.length > 0) parts.push(`Expression tags: ${active.expressionTags.join(", ")}`);
        if (Object.keys(active.cognitiveOverrides).length > 0) {
          parts.push(`Cognitive overrides: ${JSON.stringify(active.cognitiveOverrides)}`);
        }
        if (active.promptOverlay) parts.push(`Overlay: ${active.promptOverlay.slice(0, 200)}${active.promptOverlay.length > 200 ? "..." : ""}`);
        const ctxKeys = active.contextSections ? Object.keys(active.contextSections) : [];
        if (ctxKeys.length > 0) parts.push(`Context sections: ${JSON.stringify(active.contextSections)}`);
        parts.push(
          active.toolBundle && active.toolBundle.length > 0
            ? `Tool bundle (${active.toolBundle.length}): ${active.toolBundle.join(", ")}`
            : "Tool bundle: empty — passthrough (all tools loaded; no per-persona gating in effect)"
        );
        return { result: parts.join("\n") };
      },

      list_personas: async () => {
        const { personaStorage } = await import("./file-storage/persona-storage");
        const all = (await personaStorage.list()).filter(p => !p.isSystem);
        if (all.length === 0) return { result: "No personas found." };
        const { resolveSessionPersona } = await import("./session-persona");
        const active = await resolveSessionPersona(args._sessionId);
        const lines = all.map(p => {
          const bundle = p.toolBundle && p.toolBundle.length > 0 ? `${p.toolBundle.length} bundled` : "all (passthrough)";
          const lineage = p.templatePersonaId != null ? `, template=${p.templatePersonaId}` : "";
          return `- ${p.id === active?.id ? "▶ " : ""}**${p.name}** (id=${p.id}, ${p.source}${lineage}, tools: ${bundle})${p.isDefault ? " [default]" : ""} — ${p.description}`;
        });
        return { result: `${all.length} personas:\n${lines.join("\n")}` };
      },

      resolve_toolset: async (a) => {
        // Evaluate the persona bound as the pure function it is: run the REAL
        // runtime gate (filterToolsForPersonaBundle) over the full tool catalog,
        // never a re-derivation of core ∪ bundle. This is the leading, pre-call
        // gauge — deterministic and knowable before any inference runs.
        const { filterToolsForPersonaBundle, getToolCatalog, CORE_TOOL_NAMES } = await import("./tool-registry");
        let persona: import("./file-storage/persona-storage").PersonaEntry | null | undefined;
        if (a.id) {
          const { personaStorage } = await import("./file-storage/persona-storage");
          persona = (await personaStorage.list()).find(p => p.id === Number(a.id));
          if (!persona) return { result: `Persona ${a.id} not found`, error: true };
        } else {
          const { resolveSessionPersona } = await import("./session-persona");
          persona = await resolveSessionPersona(args._sessionId);
          if (!persona) return { result: "No persona available.", error: true };
        }
        const catalog = getToolCatalog();
        const bundle = persona.toolBundle ?? [];
        const resolved = filterToolsForPersonaBundle(catalog, bundle);
        const resolvedNames = new Set(resolved.map(t => t.name));
        const core = resolved.filter(t => CORE_TOOL_NAMES.has(t.name)).map(t => t.name);
        const bundled = resolved.filter(t => !CORE_TOOL_NAMES.has(t.name)).map(t => t.name);
        const onDemand = catalog.filter(t => !resolvedNames.has(t.name)).map(t => t.name);
        const header = `**${persona.name}** (id=${persona.id}) — resolved tool set`;
        if (bundle.length === 0) {
          return { result: [
            header,
            `Tool bundle empty → passthrough: all ${catalog.length} tools load up front (no persona gating in effect).`,
            `Session authority may still restrict which of these are actually callable.`,
          ].join("\n") };
        }
        return { result: [
          header,
          `${resolved.length} resolved = ${core.length} core + ${bundled.length} bundled (of ${catalog.length} total; ${onDemand.length} load on demand via tools.get).`,
          ``,
          `Core (${core.length}): ${core.join(", ")}`,
          `Bundled (${bundled.length}): ${bundled.join(", ")}`,
          ``,
          `On-demand (${onDemand.length}): ${onDemand.join(", ")}`,
        ].join("\n") };
      },

      create_persona: async (a) => {
        if (!a.name) return { result: "Missing persona name", error: true };
        const { personaStorage } = await import("./file-storage/persona-storage");
        const persona = await personaStorage.create({
          name: a.name,
          description: a.description,
          promptOverlay: a.prompt_overlay || a.promptOverlay,
          expressionTags: a.expression_tags || a.expressionTags,
          cognitiveOverrides: a.cognitive_overrides ?? a.cognitiveOverrides,
          contextSections: a.context_sections ?? a.contextSections,
          toolBundle: a.tool_bundle ?? a.toolBundle,
        });
        return { result: `Persona created: ${persona.name} (id=${persona.id})` };
      },

      update_global_persona_template: async (a) => {
        const toolBundle = a.tool_bundle ?? a.toolBundle;
        if (!Array.isArray(toolBundle) || toolBundle.length === 0) {
          return { result: "A non-empty tool bundle is required", error: true };
        }
        const { personaStorage } = await import("./file-storage/persona-storage");
        let templateId = a.id != null ? Number(a.id) : NaN;
        if (!Number.isFinite(templateId) || templateId <= 0) {
          const name = typeof a.name === "string" ? a.name.trim() : "";
          if (!name) return { result: "Missing persona id or name", error: true };
          const resolved = await personaStorage.getGlobalSeedTemplateByName(name);
          if (!resolved) return { result: `Global persona template named ${name} not found`, error: true };
          templateId = resolved.id;
        }
        const updated = await personaStorage.updateGlobalTemplateToolBundle(templateId, toolBundle);
        if (!updated) return { result: `Global persona template ${templateId} not found`, error: true };
        return { result: `Global persona template updated: ${updated.name} (id=${updated.id}, tools=${updated.toolBundle.join(", ")})` };
      },

      update_persona: async (a) => {
        if (!a.id) return { result: "Missing persona id", error: true };
        const { personaStorage } = await import("./file-storage/persona-storage");
        // Editing a seed copy-on-writes into the user's own persona row, so the
        // edit lands on an editable copy rather than failing against a read-only seed.
        const owned = await personaStorage.ensureOwnedCopy(Number(a.id));
        if (!owned) return { result: `Persona ${a.id} not found`, error: true };
        const updated = await personaStorage.update(owned.id, {
          name: a.name,
          description: a.description,
          promptOverlay: a.prompt_overlay || a.promptOverlay,
          expressionTags: a.expression_tags || a.expressionTags,
          cognitiveOverrides: a.cognitive_overrides ?? a.cognitiveOverrides,
          contextSections: a.context_sections ?? a.contextSections,
          toolBundle: a.tool_bundle ?? a.toolBundle,
        });
        if (!updated) return { result: `Persona ${a.id} is read-only or not found`, error: true };
        return { result: `Persona updated: ${updated.name} (id=${updated.id})` };
      },
    };

    const handler = sub[action];
    if (!handler) return { result: `Unknown cognition action: ${action}. Available: ${Object.keys(sub).join(", ")}`, error: true };
    try {
      return await handler(args);
    } catch (err: any) {
      return { result: `cognition.${action} error: ${err.message}`, error: true };
    }
  },

  async backup(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = args.action;
    if (!action) return { result: "Missing action parameter", error: true };

    const { createBackup, listBackups, getBackup, deleteBackup } = await import("./backup-storage");

    try {
      switch (action) {
        case "create": {
          const job = await createBackup("manual");
          return { result: `Backup started. Job ID: ${job.id}\nStatus: ${job.status}\nThe backup is running in the background. Use \`backup list\` to check progress.` };
        }
        case "list": {
          const limit = Number(args.limit) || 20;
          const backups = await listBackups(limit);
          if (backups.length === 0) return { result: "No backups found." };
          const lines = backups.map((b: any) => {
            const date = new Date(b.created_at).toLocaleString();
            const size = b.compressed_size ? `${(b.compressed_size / 1024 / 1024).toFixed(1)} MB` : "—";
            return `${b.id} | ${date} | ${b.trigger_type} | ${b.status} | ${size} | ${b.table_count ?? "—"} tables | ${b.total_rows ?? "—"} rows | ${b.duration_ms ? `${(b.duration_ms / 1000).toFixed(1)}s` : "—"}`;
          });
          return { result: `Backups (${backups.length}):\n${lines.join("\n")}` };
        }
        case "get": {
          if (!args.id) return { result: "Missing id parameter", error: true };
          const backup = await getBackup(args.id);
          if (!backup) return { result: `Backup ${args.id} not found`, error: true };
          let detail = `Backup: ${backup.id}\nStatus: ${backup.status}\nTrigger: ${backup.trigger_type}\nCreated: ${backup.created_at}\nSize: ${backup.compressed_size ? `${(backup.compressed_size / 1024 / 1024).toFixed(1)} MB` : "—"}\nTables: ${backup.table_count ?? "—"}\nRows: ${backup.total_rows ?? "—"}\nDuration: ${backup.duration_ms ? `${(backup.duration_ms / 1000).toFixed(1)}s` : "—"}`;
          if (backup.error) detail += `\nError: ${backup.error}`;
          if (backup.table_manifest && typeof backup.table_manifest === "object") {
            const entries = Object.entries(backup.table_manifest);
            if (entries.length > 0 && entries.length <= 120) {
              detail += "\n\nTable manifest:";
              for (const [table, info] of entries) {
                detail += `\n  ${table}: ${(info as any).rows ?? "?"} rows`;
              }
            }
          }
          return { result: detail };
        }
        case "restore": {
          return {
            result: "backup.restore is not available to agents, including dry-run restore. Use the human Dev Database restore flow for any restore operation.",
            error: true,
          };
        }
        case "delete": {
          if (!args.id) return { result: "Missing id parameter", error: true };
          await deleteBackup(args.id);
          return { result: `Backup ${args.id} deleted.` };
        }
        default:
          return { result: `Unknown backup action: ${action}. Available: create, list, get, delete`, error: true };
      }
    } catch (err: any) {
      return { result: `backup.${action} error: ${err.message}`, error: true };
    }
  },

  async routers(args: Record<string, any>): Promise<ToolHandlerResult> {
    const action = typeof args.action === "string" ? args.action : "";
    if (!action) return { result: "Missing action parameter", error: true };

    const allowed = new Set([
      "list",
      "get",
      "list_legacy",
      "create",
      "move_connector",
      "set_account_router",
    ]);
    if (!allowed.has(action)) {
      return {
        result: `Unknown routers action: ${action}. Available: ${[...allowed].join(", ")}`,
        error: true,
      };
    }

    try {
      const { requireCurrentPrincipal } = await import("./principal-context");
      const { principalHasPermission } = await import("./permissions");
      const principal = requireCurrentPrincipal();
      const readOk = principalHasPermission(principal, "system:read");
      const writeOk = principalHasPermission(principal, "system:write");
      const usersWriteOk = principalHasPermission(principal, "users:write");

      const {
        listRouters,
        getRouter,
        listLegacyModelConnectors,
        createRouter,
        moveConnectorToRouter,
        setAccountRouter,
      } = await import("./router-storage");

      if (action === "list" || action === "get" || action === "list_legacy") {
        if (!readOk) {
          return { result: "Permission denied: system:read required", error: true };
        }
        if (action === "list") {
          const routers = await listRouters();
          return { result: JSON.stringify({ count: routers.length, routers }, null, 2) };
        }
        if (action === "get") {
          const id = typeof args.id === "string" ? args.id.trim() : "";
          if (!id) return { result: "Missing id (Router UUID)", error: true };
          const router = await getRouter(id);
          if (!router) return { result: `Router ${id} not found`, error: true };
          return { result: JSON.stringify({ router }, null, 2) };
        }
        const connectors = await listLegacyModelConnectors();
        return {
          result: JSON.stringify({
            count: connectors.length,
            connectors: connectors.map((c) => ({
              id: c.id,
              provider: c.provider,
              label: c.label,
              status: c.status,
              priorityPinned: c.priorityPinned,
              sortOrder: c.sortOrder,
              hasCredential: Boolean(c.credentialRef),
              routerId: c.routerId,
            })),
          }, null, 2),
        };
      }

      if (!writeOk) {
        return { result: "Permission denied: system:write required", error: true };
      }

      if (action === "create") {
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) return { result: "Missing name for create", error: true };
        const router = await createRouter(name);
        return { result: JSON.stringify({ router }, null, 2) };
      }

      if (action === "move_connector") {
        const connectorId = Number(args.connectorId);
        if (!Number.isFinite(connectorId) || connectorId <= 0) {
          return { result: "Missing or invalid connectorId", error: true };
        }
        let routerId: string | null = null;
        if (args.routerId === null || args.routerId === undefined || args.routerId === "") {
          routerId = null;
        } else if (typeof args.routerId === "string") {
          routerId = args.routerId.trim() || null;
        } else {
          return { result: "routerId must be a UUID string or null", error: true };
        }
        const connector = await moveConnectorToRouter(connectorId, routerId);
        return {
          result: JSON.stringify({
            connector: {
              id: connector.id,
              provider: connector.provider,
              label: connector.label,
              status: connector.status,
              routerId: connector.routerId,
              sortOrder: connector.sortOrder,
              priorityPinned: connector.priorityPinned,
            },
          }, null, 2),
        };
      }

      if (!usersWriteOk) {
        return { result: "Permission denied: users:write required for Account router assignment", error: true };
      }
      const accountId = typeof args.accountId === "string" ? args.accountId.trim() : "";
      if (!accountId) return { result: "Missing accountId", error: true };
      let routerId: string | null = null;
      if (args.routerId === null || args.routerId === undefined || args.routerId === "") {
        routerId = null;
      } else if (typeof args.routerId === "string") {
        routerId = args.routerId.trim() || null;
      } else {
        return { result: "routerId must be a UUID string or null", error: true };
      }
      const result = await setAccountRouter(accountId, routerId);
      return { result: JSON.stringify(result, null, 2) };
    } catch (err: any) {
      return { result: `routers.${action} error: ${err.message}`, error: true };
    }
  },
};

const localHandlers: Record<string, ToolHandler> = {
  phone_call: phoneCallHandler,
  ...buildExecutionHandlers,
  ...workspaceTools,
  ...persistentFileHandlers,
  ...systemTools,
  ...webTools,
  ...memoryTools,
  ...codeIntelTools,
  ...umbrellaHandlers,
  ...cognitionTools,
};

const DISPATCH_MAP = composeToolDomainHandlers([
  localHandlers,
  bridgeHandlers,
]);

assertRegisteredToolHandlers(DISPATCH_MAP);

const SIDE_EFFECT_ONLY_ACTIONS: Record<string, Set<string>> = {
  session: new Set(["set_status", "end", "send_message"]),
  companies: new Set(["create", "update", "delete", "add_person", "remove_person", "add_opportunity", "remove_opportunity"]),
  agendas: new Set(["create", "update", "delete"]),
  jobs: new Set(["create", "update", "delete"]),
  people: new Set(["create", "update", "merge", "add_note", "update_note", "delete_note", "log_interaction", "update_interaction", "delete_interaction", "set_daily_contact", "add_vault_membership", "remove_vault_membership", "set_vault_memberships"]),
  calendar: new Set(["create", "update", "delete"]),
  memory: new Set(["write"]),
  settings: new Set(["set", "delete"]),
  observe: new Set(["pattern", "gap", "change", "connection", "opportunity"]),
  cognition: new Set(["set_emotion", "create_persona", "update_persona", "update_global_persona_template"]),
  pronunciation: new Set(["add", "update", "remove"]),
  decisions: new Set(["create", "update", "delete", "lock", "reopen", "add_update", "edit_update", "delete_update", "add_link", "remove_link"]),
  plan: new Set(["update_step", "add_steps", "pause", "unlink_session"]),
  routers: new Set(["create", "move_connector", "set_account_router"]),
  blocking_graph: new Set(["add_blocker", "remove_blocker"]),
};

const SIDE_EFFECT_ONLY_TOOLS = new Set([
  "write_scratch", "edit_scratch", "write_file", "write_docx", "edit_docx", "clone_docx",
  "memory_write",
  "orient",
]);

function isSideEffectOnly(toolName: string, args: Record<string, any>): boolean {
  if (SIDE_EFFECT_ONLY_TOOLS.has(toolName)) return true;

  const actionSet = SIDE_EFFECT_ONLY_ACTIONS[toolName];
  if (actionSet) {
    const action = args.action as string;
    if (action && actionSet.has(action)) return true;
    if (toolName === "observe") return true;
  }

  return false;
}


type CodingSubdir = "client" | "server" | "mobile";
type CodingReferenceId = "root_agents" | "design_md" | `subdir_agents:${CodingSubdir}`;

type EngineeringContextRoot = {
  root: string;
  reason: string;
};

const ENGINEERING_TOOL_NAMES = new Set(["code", "shell", "python", "git", "npm_dependencies", "system", "railway", "sentry"]);
const ENGINEERING_REF_CACHE = new Map<string, Set<string>>();
const ENGINEERING_CONTEXT_LOAD_QUEUE = new Map<string, Promise<string | null>>();
const ENGINEERING_ROOT_REPO_HINTS = ["repos/", "AGENTS.md", "DESIGN.md", "npm run build", "git ", "server/", "client/", "mobile/", "shared/"];
const CODING_SUBDIRS: CodingSubdir[] = ["client", "server", "mobile"];

function shouldEnsureCodingContext(toolName: string, args: Record<string, any>): boolean {
  if (toolName === "code" || toolName === "git" || toolName === "railway") return true;
  if (toolName === "system") {
    const action = String(args.action || "");
    return ["logs", "log_files", "state", "events", "active_runs", "clear_active_run", "tool_stats"].includes(action);
  }
  if (toolName === "shell") {
    const command = String(args.command || "");
    return ENGINEERING_ROOT_REPO_HINTS.some(hint => command.includes(hint));
  }
  return ENGINEERING_TOOL_NAMES.has(toolName);
}

function collectPathHints(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    if (/(^|[\s'"`])(client|server|mobile|shared)\//.test(value) || value.includes("repos/")) {
      paths.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathHints(item, paths);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectPathHints(item, paths);
  }
}

function resolveUnderWorkspace(pathValue: string): string | null {
  const trimmed = pathValue.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return null;
  const resolved = resolve(WORKSPACE_DIR, trimmed);
  if (resolved === WORKSPACE_DIR || resolved.startsWith(`${WORKSPACE_DIR}/`)) return resolved;
  return null;
}

function repoRootFromResolvedPath(resolvedPath: string | null): string | null {
  if (!resolvedPath?.startsWith(`${WORKSPACE_DIR}/repos/`)) return null;
  const relativeRepoPath = relative(resolve(WORKSPACE_DIR, "repos"), resolvedPath);
  const [repoDir] = relativeRepoPath.split("/");
  if (!repoDir || repoDir === ".." || repoDir.includes("..")) return null;
  return resolve(WORKSPACE_DIR, "repos", repoDir);
}

function firstRepoPathFromCommand(command: string): string | null {
  const cdMatch = command.match(/(?:^|[;&|]\s*)cd\s+(['"]?)([^'"`\s;&|]+)\1/);
  if (cdMatch?.[2]) {
    const repoRoot = repoRootFromResolvedPath(resolveUnderWorkspace(cdMatch[2]));
    if (repoRoot) return repoRoot;
  }

  const absoluteRepoMatch = command.match(/\/app\/repos\/[^\s'"`;&|)]+/);
  if (absoluteRepoMatch?.[0]) {
    const repoRoot = repoRootFromResolvedPath(resolveUnderWorkspace(absoluteRepoMatch[0]));
    if (repoRoot) return repoRoot;
  }

  const relativeRepoMatch = command.match(/(?:^|[\s'"`])(repos\/[^\s'"`;&|)]+)/);
  if (relativeRepoMatch?.[1]) {
    const repoRoot = repoRootFromResolvedPath(resolveUnderWorkspace(relativeRepoMatch[1]));
    if (repoRoot) return repoRoot;
  }

  return null;
}

function resolveEngineeringContextRoot(toolName: string, args: Record<string, any>): EngineeringContextRoot {
  if (toolName === "shell") {
    const commandRoot = firstRepoPathFromCommand(String(args.command || ""));
    if (commandRoot) return { root: commandRoot, reason: "shell command targets repos clone" };
  }

  if (toolName === "git") {
    const action = String(args.action || "").trim();
    if (action === "clone") {
      return { root: WORKSPACE_DIR, reason: "git clone runs before target repo instructions exist" };
    }

    const directory = String(args.directory || "").trim();
    if (directory && directory !== "." && directory !== "self") {
      const repoRoot = directory.startsWith("repos/")
        ? resolveUnderWorkspace(directory)
        : resolveUnderWorkspace(`repos/${directory}`);
      if (repoRoot?.startsWith(`${WORKSPACE_DIR}/repos/`)) return { root: repoRoot, reason: "git directory targets repos clone" };
    }
  }

  return { root: WORKSPACE_DIR, reason: "workspace root default" };
}

function touchedCodingSubdirs(args: Record<string, any>): CodingSubdir[] {
  const pathHints = new Set<string>();
  collectPathHints(args, pathHints);
  const combined = [...pathHints, String(args.command || "")].join("\n");
  return CODING_SUBDIRS.filter(dir => combined.includes(`${dir}/`));
}

function requiredCodingReferences(toolName: string, args: Record<string, any>): CodingReferenceId[] {
  const refs = new Set<CodingReferenceId>(["root_agents"]);
  for (const dir of touchedCodingSubdirs(args)) refs.add(`subdir_agents:${dir}`);

  const pathHints = new Set<string>();
  collectPathHints(args, pathHints);
  const combined = [...pathHints, String(args.command || "")].join("\n");
  if (/(^|[\s'"`])(client|mobile)\//.test(combined) || /context-page|session-details|component|tsx|css|DESIGN\.md/.test(combined)) refs.add("design_md");
  return [...refs];
}

function cacheKeyForContext(root: string, context?: BridgeToolContext): string {
  return `${context?.sessionId || context?.sessionKey || "global"}:${root}`;
}

async function readInstructionFile(root: string, relativePath: string): Promise<string> {
  const absolutePath = resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
    throw new Error(`Instruction path escapes context root: ${relativePath}`);
  }
  return readFile(absolutePath, "utf-8");
}

async function loadSubdirAgent(root: string, dir: CodingSubdir): Promise<string> {
  const relativePath = `${dir}/AGENTS.md`;
  const absolutePath = resolve(root, relativePath);
  if (!(await pathExists(absolutePath))) {
    return `\n## ${relativePath}\n\n_Not found under effective root ${root}. Continuing because subtree AGENTS files are optional unless repository policy declares them required._`;
  }
  return `\n## ${relativePath}\n\n${await readInstructionFile(root, relativePath)}`;
}

async function loadMissingCodingContext(
  toolName: string,
  args: Record<string, any>,
  context?: BridgeToolContext,
): Promise<string | null> {
  if (!shouldEnsureCodingContext(toolName, args)) return null;

  const contextRoot = resolveEngineeringContextRoot(toolName, args);
  const requiredRefs = requiredCodingReferences(toolName, args);
  const cacheKey = cacheKeyForContext(contextRoot.root, context);
  const loadedRefs = ENGINEERING_REF_CACHE.get(cacheKey) || new Set<string>();
  const missing = requiredRefs.filter(ref => !loadedRefs.has(ref));
  if (missing.length === 0) return null;

  const parts: string[] = [
    "# Engineering Context Preflight",
    `The runtime loaded the required coding context before executing this engineering tool.`,
    `Instruction root: ${contextRoot.root} (${contextRoot.reason}).`,
  ];
  // Shell always spawns with cwd=WORKSPACE_DIR. Instruction root may point at a repos/*
  // clone for AGENTS.md loading, but that is not the process cwd — relative paths and
  // `git -C` must still be rooted at the workspace, or the command fails after admission.
  if (toolName === "shell") {
    parts.push(
      `Shell cwd is always ${WORKSPACE_DIR} (not the instruction root). Use workspace-relative paths or git -C repos/<clone>; do not assume the process started inside the clone.`,
    );
  }

  // AGENTS.md is advisory: load if present, note if absent, never block
  if (missing.includes("root_agents")) {
    try {
      parts.push(`\n## AGENTS.md\n\n${await readInstructionFile(contextRoot.root, "AGENTS.md")}`);
      loadedRefs.add("root_agents");
    } catch {
      parts.push(`\n## AGENTS.md\n\n_AGENTS.md not found under ${contextRoot.root}; proceeding without repo-specific architecture context. Universal coding process is loaded from Library._`);
      loadedRefs.add("root_agents");
    }
  }

  const subdirRefs = missing.filter((ref): ref is `subdir_agents:${CodingSubdir}` => ref.startsWith("subdir_agents:"));
  for (const ref of subdirRefs) {
    const dir = ref.slice("subdir_agents:".length) as CodingSubdir;
    parts.push(await loadSubdirAgent(contextRoot.root, dir));
    loadedRefs.add(ref);
  }

  if (missing.includes("design_md")) {
    let designLoaded = false;

    // Strategy 1: Product-owned design_system pages visible to the principal.
    try {
      const { listVisibleProductContextPages } = await import("./platforms/context-artifact-access");
      const pages = await listVisibleProductContextPages(["design_system"]);
      const contents = pages.map(page => page.content.trim()).filter(Boolean);
      if (contents.length > 0) {
        parts.push(`\n## DESIGN.md\n\n${contents.join("\n\n---\n\n")}`);
        designLoaded = true;
      }
    } catch {
      // Fall through to filesystem
    }

    // Strategy 2: Filesystem fallback
    if (!designLoaded) {
      try {
        parts.push(`\n## DESIGN.md\n\n${await readInstructionFile(contextRoot.root, "DESIGN.md")}`);
        designLoaded = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Required coding context missing: DESIGN.md under ${contextRoot.root} (${message})`);
      }
    }

    if (designLoaded) loadedRefs.add("design_md");
  }

  ENGINEERING_REF_CACHE.set(cacheKey, loadedRefs);
  eventBus.publish({
    category: "agent",
    event: "tool:coding_context_loaded",
    payload: {
      toolName,
      refs: [...loadedRefs],
      effectiveRoot: contextRoot.root,
      effectiveRootReason: contextRoot.reason,
      sessionId: context?.sessionId,
      sessionKey: context?.sessionKey,
    },
  });
  return parts.join("\n\n");
}

async function ensureCodingContextLoaded(
  toolName: string,
  args: Record<string, any>,
  context?: BridgeToolContext,
): Promise<string | null> {
  if (!shouldEnsureCodingContext(toolName, args)) return null;
  const contextRoot = resolveEngineeringContextRoot(toolName, args);
  const queueKey = cacheKeyForContext(contextRoot.root, context);
  const prior = ENGINEERING_CONTEXT_LOAD_QUEUE.get(queueKey) ?? Promise.resolve(null);
  const current = prior
    .catch(() => null)
    .then(() => loadMissingCodingContext(toolName, args, context));
  ENGINEERING_CONTEXT_LOAD_QUEUE.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (ENGINEERING_CONTEXT_LOAD_QUEUE.get(queueKey) === current) {
      ENGINEERING_CONTEXT_LOAD_QUEUE.delete(queueKey);
    }
  }
}

export async function executeTool(
  toolName: string,
  toolCallId: string,
  args: Record<string, any>,
  context?: BridgeToolContext,
): Promise<ToolResult> {
  const startTime = Date.now();

  // Models often emit cognition actions as bare tool names (e.g. set_emotion).
  // Alias resolution maps the name to cognition; inject action when absent so
  // schema validation still requires the umbrella contract.
  const invocationArgs: Record<string, any> = { ...(args ?? {}) };
  if (
    COGNITION_ACTION_TOOL_ALIASES.has(toolName) &&
    (invocationArgs.action === undefined || invocationArgs.action === null || invocationArgs.action === "")
  ) {
    invocationArgs.action = toolName;
  }

  const registeredTool = resolveRegisteredTool(toolName);
  if (!registeredTool) {
    const durationMs = Date.now() - startTime;
    toolExec.log(`rejected tool=${toolName} callId=${toolCallId} reason=unregistered_tool`);
    return {
      result: `Unknown tool: ${toolName}`,
      error: true,
      sideEffectOnly: true,
      durationMs,
      failure: inputFailure("tool_unregistered", toolName),
    };
  }
  const resolvedName = registeredTool.name;
  const handler = DISPATCH_MAP[resolvedName];
  if (!handler) {
    const durationMs = Date.now() - startTime;
    toolExec.error(`rejected tool=${toolName} callId=${toolCallId} reason=registered_handler_missing`);
    return {
      result: `Registered tool unavailable: ${resolvedName}`,
      error: true,
      sideEffectOnly: true,
      durationMs,
      failure: internalFailure("tool_registered_handler_missing", resolvedName),
    };
  }
  const prepared = prepareToolInvocation(resolvedName, invocationArgs, registeredTool.schema);
  if (prepared.outcome === "invalid") {
    const durationMs = Date.now() - startTime;
    toolExec.log(`rejected tool=${toolName} callId=${toolCallId} reason=${prepared.error}`);
    return {
      result: prepared.error,
      error: true,
      durationMs,
      failure: inputFailure("tool_schema_invalid", prepared.error),
    };
  }
  const normalizedArgs = prepared.args;
  const { authorizeToolInvocation } = await import("./agent-authority");
  const authority = authorizeToolInvocation(resolvedName, normalizedArgs, {
    ...context?.authority,
    sessionId: context?.sessionId,
    sessionKey: context?.sessionKey,
  });
  if (!authority.allowed) {
    const durationMs = Date.now() - startTime;
    toolExec.warn(`rejected tool=${toolName} callId=${toolCallId} reason=authority_denied detail=${authority.reason}`);
    eventBus.publish({
      category: "agent",
      event: "tool:authority_denied",
      payload: { toolName, action: normalizedArgs.action || null, reason: authority.reason, sessionId: context?.sessionId || null },
    });
    return { result: `Tool execution denied by deterministic authority policy: ${authority.reason}`, error: true, sideEffectOnly: true, durationMs, failure: authorityDenialFailure("tool_authority_denied", { resourceKey: resolvedName }) };
  }
  const { getCurrentPrincipal } = await import("./principal-context");
  const principal = getCurrentPrincipal();
  if (!principal) {
    const durationMs = Date.now() - startTime;
    return { result: "Tool execution denied: missing_principal", error: true, sideEffectOnly: true, durationMs };
  }
  try {
    const { requireModToolAccess } = await import("./mods/mod-access");
    await requireModToolAccess(principal, resolvedName);
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const reason = error instanceof Error ? error.message : "mod_inactive";
    toolExec.warn(`rejected tool=${toolName} callId=${toolCallId} reason=${reason}`);
    return { result: "Tool execution denied: owning Mod is inactive", error: true, sideEffectOnly: true, durationMs, failure: authorityDenialFailure(reason, { resourceKey: resolvedName }) };
  }
  if (prepared.droppedEmptyKeys.length > 0) {
    toolExec.verbose(() => `normalized tool=${toolName} callId=${toolCallId} droppedEmptyKeys=${prepared.droppedEmptyKeys.join(",")}`);
  }

  toolExec.verbose(() => `dispatch tool=${toolName} callId=${toolCallId} argKeys=${Object.keys(normalizedArgs).join(",")}`);

  const enrichedArgs = { ...normalizedArgs };
  // Universal _sessionId/_sessionKey injection — all tools get session context.
  // Authority context is server-derived and injected only after public argument
  // validation so capability introspection can describe this exact execution.
  if (context?.sessionId) enrichedArgs._sessionId = context.sessionId;
  enrichedArgs._toolCallId = toolCallId;
  if (context?.sessionKey) enrichedArgs._sessionKey = context.sessionKey;
  if (context?.clientId) enrichedArgs._clientId = context.clientId;
  if (context?.uiNarrationState) enrichedArgs._uiNarrationState = context.uiNarrationState;
  enrichedArgs._authorityContext = {
    ...context?.authority,
    sessionId: context?.sessionId,
    sessionKey: context?.sessionKey,
  };
  if (resolvedName === "orient" && context?.orientationPersonaPolicy) {
    enrichedArgs._orientationPersonaPolicy = context.orientationPersonaPolicy;
  }
  if (toolName === "converse" && enrichedArgs.action === "set_attention" && !enrichedArgs.sessionId && context?.sessionId) {
    enrichedArgs.sessionId = context.sessionId;
  }

  let codingContextPrelude: string | null = null;
  try {
    codingContextPrelude = await ensureCodingContextLoaded(resolvedName, enrichedArgs, context);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    toolExec.warn(`rejected tool=${toolName} callId=${toolCallId} reason=coding_context_missing error=${err.message}`);
    return { result: `Engineering preflight blocked tool execution: ${err.message}`, error: true, durationMs };
  }

  recordToolCallStart(toolCallId, toolName);
  let _wwTrackEnd: ((id: string) => void) | null = null;
  try {
    const ww = require("./wedge-watchdog");
    ww.trackToolDispatchStart(toolCallId, toolName, context?.sessionId);
    _wwTrackEnd = ww.trackToolDispatchEnd;
  } catch { /* watchdog not available */ }

  try {
    const outcome = await handler(enrichedArgs);
    const durationMs = Date.now() - startTime;
    // Handlers emit ToolFailure on `failure.kind`; accept flattened failureKind too.
    const explicitFailureKind = extractToolFailureKind(outcome);
    // Last-resort inference: a failed outcome no classifier claimed is phrase-
    // matched against a tight avoidable-failure allow-list so predictable
    // failures render amber instead of red. Never overrides an explicit kind.
    const outcomeFailureKind =
      outcome.error && !explicitFailureKind
        ? inferFailureKind(outcome.result)
        : explicitFailureKind;
    recordToolCallEnd(toolCallId, !!outcome.error, outcomeFailureKind);
    _wwTrackEnd?.(toolCallId);
    const sideEffectOnly = !outcome.error && isSideEffectOnly(resolvedName, normalizedArgs);
    // Preflight equips successful engineering work with AGENTS/CODING context.
    // Never bury a tool error under thousands of instruction tokens — that
    // hides the failure the model must correct and drives over-correction.
    const resultWithPrelude =
      codingContextPrelude && !outcome.error
        ? `${codingContextPrelude}

---

# Tool Result

${outcome.result}`
        : outcome.result;
    // Fast non-error completions are verbose; slow (>=5s) or errored are info
    if (!outcome.error && durationMs < 5000) {
      toolExec.verbose(() => `complete tool=${toolName} callId=${toolCallId} duration=${durationMs}ms sideEffectOnly=${sideEffectOnly} resultLen=${resultWithPrelude?.length}`);
    } else {
      toolExec.log(`complete tool=${toolName} callId=${toolCallId} duration=${durationMs}ms error=${!!outcome.error} sideEffectOnly=${sideEffectOnly} resultLen=${resultWithPrelude?.length}`);
    }
    // Keep the returned payload's failureKind consistent with what telemetry
    // recorded, but only when inference supplied one the outcome lacked.
    const inferredFailureKindAddon =
      outcome.error && !explicitFailureKind && outcomeFailureKind
        ? { failureKind: outcomeFailureKind }
        : {};
    return { ...outcome, result: resultWithPrelude, sideEffectOnly, durationMs, ...inferredFailureKindAddon };
  } catch (err: any) {
    const durationMs = Date.now() - startTime;
    const thrownFailure = toolFailureFromError(err);
    // Explicit classifier first; fall back to phrase inference on the error
    // message so predictable thrown failures render amber instead of red.
    const thrownFailureKind =
      thrownFailure?.kind ??
      extractToolFailureKind(err) ??
      inferFailureKind(err?.message) ??
      undefined;
    recordToolCallEnd(toolCallId, true, thrownFailureKind);
    _wwTrackEnd?.(toolCallId);
    // Contained handler throw: executeTool completed its contract by returning
    // error:true to the model. Log warn so ERRORS does not page every tool name
    // tokenized from this line (e.g. complete tool=orient → COMPLETE_TOOL_ORIENT_CALLID).
    // True producer defects must log.error at the throw site with a stable code.
    toolExec.warn(
      `complete tool=${toolName} callId=${toolCallId} duration=${durationMs}ms error=true exception=${err.message}`,
    );
    return {
      result: `Tool execution error: ${err.message}`,
      error: true,
      durationMs,
      ...(thrownFailure ? { failure: thrownFailure } : {}),
      ...(thrownFailureKind ? { failureKind: thrownFailureKind } : {}),
    };
  }
}


