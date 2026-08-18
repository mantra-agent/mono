// Use createLogger for logging ONLY
import { canonicalSystemStepId } from "./streaming-reducers";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import { getContextWindow } from "./model-registry";
import { safeStringify } from "./utils/safe-stringify";

const log = createLogger("Executor");

type ExecutorErrorCode =
  | "EXECUTOR_UNEXPECTED_TOOL_RESOLVED"
  | "EXECUTOR_TOOL_OUTCOME_FAILED"
  | "EXECUTOR_POST_ABORT_DRAIN_TIMEOUT"
  | "EXECUTOR_EMERGENCY_COMPACTION_FAILED"
  | "EXECUTOR_STREAM_IDLE_TIMEOUT"
  | "EXECUTOR_EMERGENCY_COMPACTION_RETRY_LIMIT"
  | "EXECUTOR_REPEATED_TOOL_FAILURE"
  | "EXECUTOR_RUN_ERROR"
  | "EXECUTOR_DRAIN_BACKGROUND_THREW";

/** Upper-snake machine code for error aggregates (mirrors shared/error-callsite). */
function toExecutorErrorCode(raw: unknown, fallback: ExecutorErrorCode): string {
  if (typeof raw !== "string" && typeof raw !== "number") return fallback;
  const code = String(raw).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const compact = code.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return /^[A-Z][A-Z0-9_]{1,47}$/.test(compact) ? compact.slice(0, 48) : fallback;
}

/**
 * Normalize Executor failures into real Error instances with stable product codes.
 * String-only log.error lines that embed sessionId/tokens trip SECRET_LIKE in
 * deriveSafeErrorClassifier and collapse aggregates to Executor:Error:UNCLASSIFIED.
 */
function attributableExecutorError(
  error: unknown,
  code: string,
): Error & { code: string } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const coded = normalized as Error & { code: string };
  const stable = toExecutorErrorCode(code, "EXECUTOR_TOOL_OUTCOME_FAILED");
  if (!/^[A-Z][A-Z0-9_]{1,48}$/.test(coded.code ?? "")) coded.code = stable;
  return coded;
}

import { writeJournal, publishJournalToUI, type JournalEntry } from "./chat-journal";
import { ACTIVITY_CHAT, type ActivityId } from "./job-profiles";
import { resolveModelCandidates, type ModelRoutingDecision } from "./model-routing";
import { resolveSessionModelTierOverride } from "./session-model-tier-override";
import { resolveThinkingConfig, thinkingBudgetToTier, type ResolvedThinking, type ThinkingTierConfig } from "./thinking-config";
import { getThinkingInfo, getModelName } from "./model-registry";
// logApiCall import removed — inference recording is handled at the model-client
// boundary (recordInference). See logIterationCost comment for context.
import { generateToolCallId } from "./file-storage/utils";
import { STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_EXTENDED_MS, POST_ABORT_DRAIN_GRACE_MS } from "./timeout";
import pLimit from "p-limit";
import { withQueryAttributionAsync } from "./db";
import { abortTrace } from "./abort-trace";
import type { ContinuationCapsule, ExecutorStreamEvent, ModelProviderFailureInfo, PersonaSnapshot, TerminalDegradationReason } from "@shared/models/chat";
import type { SegmentChronologyEntry, SystemStepRecord } from "./chat-file-storage";
import { ModelProviderError, isModelContextOverflow, type StreamEvent as ModelStreamEvent, type StreamMessage } from "./model-client";
import {
  ContextHardLimitExceededError,
  applyTokenEstimateCalibration,
  estimateMessageInputTokens,
  estimateMessagesInputTokens,
  estimateToolDefinitionTokens,
  getContextRequestBudget,
  recordTokenEstimateCalibration,
  type ContextRequestBudget,
} from "./context-budget";
import { archiveLargeToolOutput, estimateToolOutputSize } from "./tool-output-artifacts";
import {
  createRunConvergenceState,
  evidenceHash,
  getRunConvergenceConfig,
  isDurableMutation,
  normalizedInvocationSignature,
  terminalDirective,
  type RunConvergenceState,
} from "./run-convergence";

import { buildContinuationCapsule, renderContinuationCapsule, type ContinuationCapsuleEntry } from "./continuation-capsule";

/** In-flight run progress used to build supersession handoff capsules. */
type ActiveRunProgress = {
  abort: AbortController;
  createdAt: number;
  startedAt?: number;
  lastActivityAt?: number;
  admitted: boolean;
  sessionId?: string;
  model?: string;
  activity?: string;
  sessionKey?: string;
  requestContent?: string;
  aborted?: boolean;
  hardCapMs?: number;
  streamIdleDeadlineAt?: number;
  /** True once any tool_use begins — durable evidence the run was acting. */
  hasStartedActing?: boolean;
  toolNames?: string[];
  /** Last non-empty assistant text streamed this run (truncated). */
  lastAssistantText?: string;
  objectiveHint?: string;
};

/**
 * Pending supersession/approval capsules keyed by chat sessionId.
 * Written when a run is aborted mid-flight (or when approval is detected);
 * consumed once by the replacement run so stance survives cold restart.
 */
type SessionHandoff = {
  capsule: ContinuationCapsule;
  priorRequestContent?: string;
  hadProgress: boolean;
  createdAt: number;
};

function normalizeMcpToolName(name: string | undefined): string | undefined {
  if (!name) return name;
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  return match ? match[2] : name;
}

function trimOpenLoop(loops: string[], item: string, max = 8): string[] {
  const next = loops.filter((loop) => loop !== item);
  next.push(item);
  return next.length > max ? next.slice(-max) : next;
}

export interface ExecutorMessage {
  role: "system" | "user" | "assistant" | "tool_result";
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
}

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image_url";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  image_url?: { url: string };
}

import type { ToolDefinition } from "@shared/models/tools";
import {
  extractToolFailureKind,
  inferFailureKind,
  isClassifiedToolFailureKind,
  type ToolFailureKind,
} from "@shared/tool-failure";
import {
  toolFailureFromError,
  type ToolFailure,
} from "./tool-failure";
import { ToolOperationRecovery, type ToolRecoveryDecision } from "./tool-operation-recovery";
export type { ToolDefinition };

/**
 * Prefer extractToolFailureKind (nested failure.kind or flattened failureKind).
 * Also accept a bare ToolFailure / { kind } so call sites can pass failure alone.
 */
function resolvedToolFailureKind(...sources: unknown[]): ToolFailureKind | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const fromShapes = extractToolFailureKind(source);
    if (isClassifiedToolFailureKind(fromShapes)) return fromShapes;
    const bareKind = (source as { kind?: unknown }).kind;
    if (isClassifiedToolFailureKind(bareKind)) return bareKind;
  }
  return undefined;
}

/**
 * Privacy-safe machine code for failed tool outcomes.
 * Prefer the handler's ToolFailure.code. When handlers omit it, emit a stable
 * synthetic code so error aggregates never collapse to UNCLASSIFIED merely
 * because the log line also carries session/run identifiers.
 */
function resolveToolOutcomeFailureCode(args: {
  failure?: ToolFailure;
  failureKind?: ToolFailureKind;
  flattenedCode?: string;
  toolName?: string;
}): string | undefined {
  const explicit =
    (typeof args.failure?.code === "string" && args.failure.code.trim()) ||
    (typeof args.flattenedCode === "string" && args.flattenedCode.trim()) ||
    "";
  if (explicit) return explicit;
  // No handler code: fold the stable tool identity into the synthetic code so
  // privacy-safe error aggregates split by owning tool
  // (Executor:Error:TOOL_FAILED_<TOOL>) instead of collapsing every uncoded
  // failure into one anonymous TOOL_FAILED bucket. Tool names are a fixed,
  // non-user vocabulary, so this discriminant leaks no user data.
  const toolSuffix =
    typeof args.toolName === "string"
      ? args.toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
      : "";
  const base = args.failureKind ? `tool_${args.failureKind}` : "tool_failed";
  return toolSuffix ? `${base}_${toolSuffix}` : base;
}

export type ToolContinuation =
  | "persona_switch"
  | "tool_schema_refresh"
  | "await_user"
  | "provider_system_tool"
  /** Successful session.end / set_status=saved: stop the loop without requiring final assistant text. */
  | "session_complete";
export type ToolOutcome = "succeeded" | "degraded" | "failed" | "cancelled";

export type ToolExecutorResult = {
  /** Exact result for canonical transcript persistence and user-visible streaming. */
  result: string;
  /** Optional ephemeral result returned only to the provider's current working set. */
  providerResult?: string;
  error?: boolean;
  /** Structured source classification consumed by run-scoped recovery policy. */
  failure?: ToolFailure;
  /**
   * Flattened kind from bridge dispatch inference / telemetry.
   * Prefer extractToolFailureKind over reading failure?.kind alone —
   * dispatch may only set this field when the handler lacked failure.kind.
   */
  failureKind?: ToolFailureKind;
  /** Flattened producer code when present without a nested failure object. */
  failureCode?: string;
  /** One discriminated recovery decision computed by the run-scoped ledger. */
  recoveryDecision?: ToolRecoveryDecision;
  outcome?: ToolOutcome;
  sideEffectOnly?: boolean;
  continuation?: ToolContinuation;
  normalizedArguments?: Record<string, unknown>;
};

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
  context?: { toolCallId: string; order: number },
) => Promise<ToolExecutorResult>;

export type { ExecutorStreamEvent };
export type StreamEvent = ExecutorStreamEvent;

export interface ExecutorRunOptions {
  sessionKey: string;
  sessionId?: string;
  /** Canonical run identity when the caller begins durable work before executor initialization. */
  runId?: string;
  messages: ExecutorMessage[];
  contextPressure?: {
    preRunTokens: number;
    threshold: number;
    durableCompactionAttempted: boolean;
    durableCompactionApplied: boolean;
    contextTokens?: number;
    messageCount?: number;
    toolCount?: number;
    contextWindow?: number;
    contextLimit?: number;
  };
  tools?: ToolDefinition[];
  toolExecutor?: ToolExecutor;
  activity?: ActivityId;
  model?: string;
  /** Canonical router decision when a caller must resolve before context assembly. Mutually exclusive with model. */
  routingDecision?: ModelRoutingDecision;
  /** Diagnostic tier override for specialized callers. Prefer routingDecision for pre-resolved routing. */
  routingTier?: string;
  temperature?: number;
  /** Maximum provider iterations admitted for this run. Clamped to the Core executor ceiling. */
  maxIterations?: number;
  /** Maximum actual tool executions admitted across both SDK- and executor-owned paths. */
  maxToolCalls?: number;
  thinkingBudget?: number;
  thinking?: ThinkingTierConfig;
  signal?: AbortSignal;
  onEvent?: (event: StreamEvent) => void;
  querySubsystem?: import("./db").QuerySubsystem;
  tier?: import("./run-admission").AdmissionTier;
  /** Capacity is normally acquired through the legacy façade; native Runtime handlers already own a fenced attempt. */
  capacityOwner?: { kind: "legacy_admission" } | { kind: "runtime"; runId: string; attemptId: string };
  /** Stable root identity shared by parent and descendant runs for lineage-safe admission. */
  lineageId?: string;
  /** Voice session ID for claiming pre-warmed CLI handles on the first turn. */
  voiceSessionId?: string;
  /** Outer Diagnostic span created before context assembly. */
  diagnosticTurnId?: string;
  /**
   * Optional extras for the executor-owned persona-switch refresh path.
   * When sessionId is set, the executor always re-resolves routing, system
   * prompt, tools, and persona after a mid-run orient switch — callers no
   * longer supply a refresh plugin.
   */
  personaSwitchRefresh?: {
    origin?: import("./agent-authority").ToolInvocationOrigin;
    trustedDelegation?: import("./agent-authority").TrustedEngineeringDelegation;
    skillId?: string;
    skillName?: string;
    mayInitiateConversation?: boolean;
    runtimeRunId?: string;
    runtimeAttemptId?: string;
    callType?: import("@shared/context-spine").ContextCallType;
    includeSections?: string[];
    excludeSections?: string[];
    profile?: "chat" | "voice" | "background";
    conversationHistory?: Array<{
      role: "user" | "assistant" | "tool" | "system";
      content: string;
      toolCallId?: string;
      toolCalls?: unknown[];
      thinking?: string;
    }>;
    currentMessage?: string;
    meetingContext?: string;
  };
  /** Resolve one authority-allowed tool schema after tools.get requests progressive hydration. */
  refreshToolSchema?: (toolName: string) => Promise<ToolDefinition | null>;
  /**
   * Authority-allowed tools NOT in the persona-hydrated `tools` set. Registered
   * with the provider as cheap passthrough stubs so a direct model call against
   * one auto-hydrates and runs in-turn instead of hard-failing the run. After a
   * stub is used, its real schema is hydrated via `refreshToolSchema`.
   */
  authorityStubTools?: ToolDefinition[];
  /** Require Plan children to explicitly assert their terminal mission outcome. */
  requireExplicitMissionCompletion?: boolean;
}

function toolTransfersExecutionToChild(name: string, args: Record<string, unknown>): boolean {
  if (name === "plan") return args.action === "execute" || args.action === "resume";
  if (name === "skills") return args.action === "run";
  if (name === "session") return args.action === "spawn_child";
  if (name === "workflows") return args.action === "start_run" || args.action === "resume_run";
  return false;
}

/**
 * True when a child-launching tool would enqueue work into a nested Runtime
 * scheduler while the parent already holds a Runtime capacity fence.
 *
 * skills.run is intentional synchronous composition: the child skill run does
 * not take a Runtime fence (no runtimeFence), so it must be allowed under a
 * Runtime-owned parent. Blocking it breaks brief-daily (and any checklist
 * child_skill_invoked skill) that composes via skills.run wait=true.
 */
function toolRequiresNestedRuntimeScheduler(name: string, args: Record<string, unknown>): boolean {
  if (name === "skills" && args.action === "run") return false;
  if (name === "plan" && args.action === "execute") return false;
  return toolTransfersExecutionToChild(name, args);
}

export type AbortReason = "idle_timeout" | "stream_idle_timeout" | "pipeline_timeout" | "run_time_limit" | "cancelled" | "superseded" | "error" | "circuit_breaker" | "zombie_timeout";

/** Runtime set of valid AbortReason values — used to validate signal reasons from AbortController.
 *  Single source of truth: keep in sync with the AbortReason union above. */
const VALID_ABORT_REASONS: ReadonlySet<string> = new Set<AbortReason>([
  "idle_timeout", "stream_idle_timeout", "pipeline_timeout", "run_time_limit", "cancelled", "superseded", "error", "circuit_breaker", "zombie_timeout",
]);

function getAbortReason(signal: AbortSignal, fallback: AbortReason = "cancelled"): AbortReason {
  return typeof signal.reason === "string" && VALID_ABORT_REASONS.has(signal.reason)
    ? signal.reason as AbortReason
    : fallback;
}

export interface RepeatedToolFailureDetails {
  type: "repeated_tool_failure";
  toolNames: string[];
  consecutiveFailures: number;
  failedCalls: Array<{ name: string; args: Record<string, unknown>; error: string }>;
}

export type AbortDetails = RepeatedToolFailureDetails;
export type { TerminationReason } from "@shared/models/chat";
import type { ChildMissionTerminalOutcome, TerminationReason } from "@shared/models/chat";

export interface ExecutorRunResult {
  status: "succeeded" | "degraded" | "failed" | "yielded";
  /** Source-owned terminal truth; consumers must not infer mission completion from tools or Session lifecycle. */
  childMissionOutcome: ChildMissionTerminalOutcome;
  degradationReason?: TerminalDegradationReason;
  /** Successful intentional stop that does not require visible assistant prose. */
  intentionalStopReason?: "awaiting_user" | "session_complete";
  lastStopReason?: string;
  content: string;
  thinking: string;
  toolCalls: Array<{
    id?: string;
    name: string;
    args: Record<string, unknown>;
    result: string;
    /** Ephemeral provider-facing projection for the current cycle (exact until consumed). */
    providerResult?: string;
    /** Receipt/ref form used after the provider has consumed the exact result once. */
    outcome: ToolOutcome;
    error?: boolean;
    failureKind?: import("@shared/tool-failure").ToolFailureKind;
    /** Stable producer code preserved for reliability filtering and trend analysis. */
    failureCode?: string;
    durationMs: number;
    parentId?: string;
  }>;
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  responseGenerationLimit?: {
    configuredOutputTokens: number;
    finalResponseOutputTokens: number;
  };
  iterations: number;
  terminationReason: TerminationReason;
  durationMs: number;
  aborted: boolean;
  abortReason?: AbortReason;
  abortDetails?: AbortDetails;
  error?: string;
  providerFailure?: ModelProviderFailureInfo;
  streamDiagnostics?: {
    eventCount: number;
    elapsedMs: number;
    lastEventType: string;
  };
  segmentChronology?: SegmentChronologyEntry[];
  systemSteps?: SystemStepRecord[];
  cost?: number;
  apiCallCount?: number;
  runId?: string;
}

const THINKING_TAG_REGEX = /<\s*think(?:ing)?\s*>([\s\S]*?)<\s*\/\s*think(?:ing)?\s*>/gi;

function extractThinkingFromText(text: string): { thinking: string; clean: string } {
  const parts: string[] = [];
  let match;
  const regex = new RegExp(THINKING_TAG_REGEX.source, "gi");
  while ((match = regex.exec(text)) !== null) {
    const part = (match[1] ?? "").trim();
    if (part) parts.push(part);
  }
  const clean = text.replace(new RegExp(THINKING_TAG_REGEX.source, "gi"), "").trim();
  return { thinking: parts.join("\n"), clean };
}

function estimateTotalTokens(messages: ExecutorMessage[]): number {
  return estimateMessagesInputTokens(messages);
}

function formatInputContextDetail(contextPressure: ExecutorRunOptions["contextPressure"]): string | undefined {
  if (!contextPressure) return undefined;
  const tokens = contextPressure.contextTokens ?? contextPressure.preRunTokens;
  const threshold = contextPressure.threshold;
  const pieces = [`input≈${tokens.toLocaleString()} tok`];
  if (threshold > 0) pieces.push(`toolSoftTrim=${threshold.toLocaleString()}`);
  if (contextPressure.contextWindow) pieces.push(`window=${contextPressure.contextWindow.toLocaleString()}`);
  if (contextPressure.messageCount != null) pieces.push(`msgs=${contextPressure.messageCount}`);
  if (contextPressure.toolCount != null) pieces.push(`tools=${contextPressure.toolCount}`);
  if (contextPressure.durableCompactionApplied) pieces.push("durable=applied");
  else if (contextPressure.durableCompactionAttempted) pieces.push("durable=attempted");
  return pieces.join(" · ");
}

/** Human-readable model identity for the Response span: display name, provider, routing tier. */
function formatModelConnectionDetail(ctx: RunIterationContext): string {
  const raw = ctx.resolvedModel || ctx.modelString;
  const modelId = raw.includes("/") ? raw.split("/").slice(1).join("/") : raw;
  const name = getModelName(modelId);
  const provider = ctx.resolvedProvider || ctx.routingDecision.provider;
  const tier = ctx.routingTier;
  return [name, provider, tier ? `tier=${tier}` : undefined].filter(Boolean).join(" \u00b7 ");
}

/** Compact key=value detail for dispatch diagnostics (pool acquisition, auth, build, TTFB). */
function formatDispatchDetail(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) return undefined;
  const pieces: string[] = [];
  if (typeof metadata.poolHit === "boolean") pieces.push(metadata.poolHit ? "pool=warm" : "pool=cold");
  if (typeof metadata.preSdkMs === "number") pieces.push(`pre=${metadata.preSdkMs}ms`);
  if (typeof metadata.sdkImportMs === "number" && metadata.sdkImportMs > 0) pieces.push(`import=${metadata.sdkImportMs}ms`);
  if (typeof metadata.poolAcquireMs === "number") pieces.push(`acquire=${metadata.poolAcquireMs}ms`);
  if (typeof metadata.authMs === "number") pieces.push(`auth=${metadata.authMs}ms`);
  if (typeof metadata.buildMs === "number") pieces.push(`build=${metadata.buildMs}ms`);
  if (typeof metadata.headersMs === "number") pieces.push(`ttfb=${metadata.headersMs}ms`);
  if (typeof metadata.status === "number") pieces.push(`status=${metadata.status}`);
  if (typeof metadata.attempt === "number" && metadata.attempt > 1) pieces.push(`attempt=${metadata.attempt}`);
  return pieces.length > 0 ? pieces.join(" \u00b7 ") : undefined;
}

function normalizeToolFailureSignature(call: { name: string; args: Record<string, unknown>; result: string }): string {
  const args = safeStringify(call.args, { maxBytes: 8 * 1024, label: "agent-executor.repeatedToolFailure.args" });
  return `${call.name}::${args}::${call.result}`;
}

/** Identical non-transient failures trip quickly — the model is stuck on bad args/authority. */
const CIRCUIT_BREAKER_THRESHOLD_DEFAULT = 2;
/**
 * Pure-transient batches (every failed call is `failureKind: "transient"`) get more room.
 * GitHub 503 / rate-limit blips must not kill a shipping turn after two identical retries.
 * Still bounded so a sustained outage cannot spin forever.
 */
const CIRCUIT_BREAKER_THRESHOLD_TRANSIENT = 5;

function circuitBreakerThresholdForFailures(
  failedCalls: Array<{ failureKind?: ToolFailureKind }>,
): number {
  if (failedCalls.length > 0 && failedCalls.every((fc) => fc.failureKind === "transient")) {
    return CIRCUIT_BREAKER_THRESHOLD_TRANSIENT;
  }
  return CIRCUIT_BREAKER_THRESHOLD_DEFAULT;
}

export function formatAbortDetails(details?: AbortDetails): string | undefined {
  if (!details) return undefined;

  if (details.type === "repeated_tool_failure") {
    const [first] = details.failedCalls;
    const toolLabel = details.toolNames.join(", ");
    const args = first
      ? safeStringify(first.args, { maxBytes: 2 * 1024, label: "agent-executor.repeatedToolFailure.userArgs" })
      : "{}";
    const error = first?.error || "Unknown tool error";

    return [
      `Repeated tool failure: ${toolLabel} failed identically ${details.consecutiveFailures} times.`,
      `Arguments: ${args}`,
      `Error: ${error}`,
    ].join("\n");
  }

  return undefined;
}

const CONTEXT_LIMIT_PATTERNS = [
  /context.?length/i,
  /prompt.?too.?long/i,
  /maximum.?context/i,
  /token.?limit/i,
  /exceeds.*max.*tokens/i,
  /request too large/i,
  /single[- ]exchange conversation cannot be compacted/i,
  /cannot be compacted/i,
];

function isContextLengthError(error: unknown): boolean {
  if (isModelContextOverflow(error)) return true;
  const errorObj = error as Record<string, unknown> | null | undefined;
  const msg = (error instanceof Error ? error.message : String(error)) || (errorObj && typeof errorObj === "object" ? String(errorObj.error || "") : "") || String(error);
  return CONTEXT_LIMIT_PATTERNS.some(p => p.test(msg));
}

interface CompactToolResultsOpts {
  contentLimit: number;
  previewLength: number;
  formatPrefix: (content: string) => string;
  preserveAfterLastAssistant: boolean;
  truncateTextBlocks: boolean;
  textBlockLimit: number;
  textBlockPreviewLength: number;
  actionName: string;
}

function compactToolResults(messages: ExecutorMessage[], opts: CompactToolResultsOpts): { messages: ExecutorMessage[]; compacted: boolean } {
  const beforeTokens = estimateTotalTokens(messages);
  const compacted = [...messages];
  let didCompact = false;
  const lastAssistantIdx = compacted.reduce((acc, m, i) => m.role === "assistant" ? i : acc, -1);
  let toolResultsCompacted = 0;
  let thinkingBlocksRemoved = 0;
  let textBlocksTruncated = 0;
  let totalCharsSaved = 0;

  for (let i = 0; i < compacted.length; i++) {
    const msg = compacted[i];

    if (msg.role === "tool_result" && Array.isArray(msg.content)) {
      const shouldProcess = opts.preserveAfterLastAssistant ? i < lastAssistantIdx : true;
      if (shouldProcess) {
        const blocks = msg.content as ContentBlock[];
        let blockChanged = false;
        const newBlocks = blocks.map(block => {
          if (block.type === "tool_result" && block.content && block.content.length > opts.contentLimit) {
            const originalLen = block.content.length;
            const preview = block.content.slice(0, opts.previewLength);
            const compactedContent = `${opts.formatPrefix(block.content)} ${preview}...`;
            totalCharsSaved += originalLen - compactedContent.length;
            toolResultsCompacted++;
            blockChanged = true;
            return { ...block, content: compactedContent };
          }
          return block;
        });
        if (blockChanged) {
          compacted[i] = { ...msg, content: newBlocks };
          didCompact = true;
        }
      }
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const shouldStripThinking = opts.preserveAfterLastAssistant ? i < lastAssistantIdx - 1 : true;
      const blocks = msg.content as ContentBlock[];
      const thinkingBlocks = blocks.filter(b => b.type === "thinking");
      const hadThinking = shouldStripThinking && thinkingBlocks.length > 0;
      let textTruncated = false;

      let newBlocks = hadThinking ? blocks.filter(b => b.type !== "thinking") : [...blocks];

      if (opts.truncateTextBlocks) {
        newBlocks = newBlocks.map(b => {
          if (b.type === "text" && b.text && b.text.length > opts.textBlockLimit && i < lastAssistantIdx) {
            totalCharsSaved += b.text.length - (opts.textBlockPreviewLength + 15);
            textBlocksTruncated++;
            textTruncated = true;
            return { ...b, text: b.text.slice(0, opts.textBlockPreviewLength) + "... [compacted]" };
          }
          return b;
        });
      }

      if (hadThinking) thinkingBlocksRemoved += thinkingBlocks.length;
      if (hadThinking || textTruncated) {
        compacted[i] = { ...msg, content: newBlocks };
        didCompact = true;
      }
    }
  }

  if (didCompact) {
    const afterTokens = estimateTotalTokens(compacted);
    log.debug(`${opts.actionName} compacted: toolResults=${toolResultsCompacted} thinkingBlocksRemoved=${thinkingBlocksRemoved} textBlocksTruncated=${textBlocksTruncated} charsSaved=${totalCharsSaved} tokens=${beforeTokens}→${afterTokens}`);
  } else {
    log.debug(`${opts.actionName} skipped: no compactable content found (tool results >${opts.contentLimit} chars${opts.preserveAfterLastAssistant ? " before last assistant" : ""}, thinking blocks${opts.truncateTextBlocks ? `, or text >${opts.textBlockLimit} chars` : ""}). messages=${messages.length} lastAssistantIdx=${lastAssistantIdx}`);
  }

  return { messages: compacted, compacted: didCompact };
}

function compactMidTurnToolSoftTrim(messages: ExecutorMessage[]): { messages: ExecutorMessage[]; compacted: boolean } {
  return compactToolResults(messages, {
    contentLimit: 500,
    previewLength: 200,
    formatPrefix: (content: string) => {
      const lines = content.split("\n").length;
      return `[Compacted: ${lines} lines]`;
    },
    preserveAfterLastAssistant: true,
    truncateTextBlocks: false,
    textBlockLimit: 200,
    textBlockPreviewLength: 150,
    actionName: "Mid-turn tool soft trim",
  });
}

interface MidTurnHistoryHardTrimTelemetry {
  strategy: "deterministic_capsule";
  rangeStartIdx?: number;
  rangeEndIdx?: number;
  pairCount?: number;
  sourceChars?: number;
  capsuleChars?: number;
  skippedReason?: string;
  durationMs: number;
}

type MidTurnCompactionAction =
  | "none"
  | "mid_turn_tool_soft_trim"
  | "mid_turn_history_hard_trim"
  | "mid_turn_history_reset"
  | "single_exchange_body_bound";

interface CompactionTelemetry {
  action: MidTurnCompactionAction;
  outcome: "skipped" | "applied";
  trigger: "mid-run" | "emergency";
  preToolRunPressure?: boolean;
  reason: string;
  contextLimit: number;
  outputReserve: number;
  hardInputLimit: number;
  toolDefinitionTokens: number;
  toolSoftTrimThreshold: number;
  historyHardTrimThreshold: number;
  historyResetThreshold: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  messagesBefore: number;
  messagesAfter: number;
  hasRunMidTurnHistoryHardTrim: boolean;
  historyHardTrim?: MidTurnHistoryHardTrimTelemetry;
}

interface PreparedHistoryHardTrimCapsule {
  range: { startIdx: number; endIdx: number; pairCount: number };
  content: string;
  sourceChars: number;
}

function findCompactableRange(messages: ExecutorMessage[]): { startIdx: number; endIdx: number; pairCount: number } | null {
  let firstIterationIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "assistant" && Array.isArray(messages[i].content)) {
      firstIterationIdx = i;
      break;
    }
  }
  if (firstIterationIdx < 0) return null;

  const preservePairs = 3;
  let pairsFromEnd = 0;
  let preserveStart = messages.length;
  for (let i = messages.length - 1; i >= firstIterationIdx; i--) {
    if (messages[i].role === "assistant" && Array.isArray(messages[i].content)) {
      pairsFromEnd++;
      if (pairsFromEnd >= preservePairs) {
        preserveStart = i;
        break;
      }
    }
  }

  if (preserveStart <= firstIterationIdx) return null;

  let pairCount = 0;
  for (let i = firstIterationIdx; i < preserveStart; i++) {
    if (messages[i].role === "assistant") pairCount++;
  }
  if (pairCount < 2) return null;

  return { startIdx: firstIterationIdx, endIdx: preserveStart - 1, pairCount };
}

function executorEntriesForCapsule(
  messages: ExecutorMessage[],
  startIdx: number,
  endIdx: number,
): { entries: ContinuationCapsuleEntry[]; sourceChars: number } {
  const entries: ContinuationCapsuleEntry[] = [];
  const toolEntryById = new Map<string, ContinuationCapsuleEntry>();
  let sourceChars = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const message = messages[i];
    if (typeof message.content === "string") {
      sourceChars += message.content.length;
      entries.push(message.role === "tool_result"
        ? {
            role: "tool",
            toolName: message.name,
            toolResult: message.content,
            toolCallId: message.toolCallId,
          }
        : { role: message.role, content: message.content });
      continue;
    }

    const textParts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        sourceChars += block.text.length;
        textParts.push(block.text);
        continue;
      }
      if (block.type === "tool_use") {
        const args = block.input || {};
        const serializedArgs = safeStringify(args, {
          maxBytes: 8_000,
          maxDepth: 5,
          maxKeys: 24,
          maxArrayItems: 24,
          maxStrLen: 1_200,
          label: "agent-executor.compaction-capsule.tool-args",
        });
        sourceChars += serializedArgs.length;
        const toolEntry: ContinuationCapsuleEntry = {
          role: "tool",
          toolName: block.name,
          toolArguments: args,
          toolCallId: block.id,
        };
        entries.push(toolEntry);
        if (block.id) toolEntryById.set(block.id, toolEntry);
        continue;
      }
      if (block.type === "tool_result") {
        const result = block.content || "";
        sourceChars += result.length;
        const existing = block.tool_use_id ? toolEntryById.get(block.tool_use_id) : undefined;
        if (existing) {
          existing.toolResult = result;
          existing.isError = block.is_error;
        } else {
          entries.push({
            role: "tool",
            toolName: message.name,
            toolResult: result,
            toolCallId: block.tool_use_id,
            isError: block.is_error,
          });
        }
      }
    }
    if (textParts.length > 0) {
      entries.push({ role: message.role === "tool_result" ? "tool" : message.role, content: textParts.join("\n") });
    }
  }

  return { entries, sourceChars };
}

function prepareMidTurnHistoryHardTrimCapsule(messages: ExecutorMessage[]): PreparedHistoryHardTrimCapsule | null {
  const range = findCompactableRange(messages);
  if (!range) return null;
  const normalized = executorEntriesForCapsule(messages, range.startIdx, range.endIdx);
  if (normalized.sourceChars < 200) return null;
  const capsule = buildContinuationCapsule(normalized.entries);
  const content = `[Working Context Capsule]\n\n${renderContinuationCapsule(capsule)}`;
  return { range, content, sourceChars: normalized.sourceChars };
}

function compactMidTurnHistoryHardTrim(
  messages: ExecutorMessage[],
  prepared = prepareMidTurnHistoryHardTrimCapsule(messages),
): { messages: ExecutorMessage[]; compacted: boolean; summaryContent?: string; telemetry: MidTurnHistoryHardTrimTelemetry } {
  const startedAt = Date.now();
  const beforeTokens = estimateTotalTokens(messages);
  if (!prepared) {
    const telemetry: MidTurnHistoryHardTrimTelemetry = {
      strategy: "deterministic_capsule",
      skippedReason: "no_compactable_range",
      durationMs: Date.now() - startedAt,
    };
    log.debug(`Mid-turn history hard trim skipped: no compactable range found. messages=${messages.length}`);
    return { messages, compacted: false, telemetry };
  }

  const { range, content, sourceChars } = prepared;
  const capsuleMessage: ExecutorMessage = { role: "system", content };
  const compacted = [
    ...messages.slice(0, range.startIdx),
    capsuleMessage,
    ...messages.slice(range.endIdx + 1),
  ];
  const afterTokens = estimateTotalTokens(compacted);
  const telemetry: MidTurnHistoryHardTrimTelemetry = {
    rangeStartIdx: range.startIdx,
    rangeEndIdx: range.endIdx,
    pairCount: range.pairCount,
    sourceChars,
    capsuleChars: content.length,
    strategy: "deterministic_capsule",
    durationMs: Date.now() - startedAt,
  };
  log.debug(`Mid-turn history hard trim completed deterministically: pairs=${range.pairCount} range=${range.startIdx}-${range.endIdx} messagesRemoved=${messages.length - compacted.length} tokens=${beforeTokens}→${afterTokens} sourceChars=${sourceChars} capsuleChars=${content.length}`);
  return { messages: compacted, compacted: true, summaryContent: content, telemetry };
}

function compactMidTurnHistoryReset(messages: ExecutorMessage[]): { messages: ExecutorMessage[]; compacted: boolean } {
  return compactToolResults(messages, {
    contentLimit: 100,
    previewLength: 100,
    formatPrefix: () => "[Aggressively compacted]",
    preserveAfterLastAssistant: false,
    truncateTextBlocks: true,
    textBlockLimit: 200,
    textBlockPreviewLength: 150,
    actionName: "Mid-turn history reset",
  });
}

/**
 * Single-exchange / irreducible-body preflight.
 *
 * Multi-turn compaction needs assistant/tool pairs. When the first exchange
 * itself exceeds the hard input limit (system + tools + attachments + user),
 * history compaction is a no-op and the provider rejects with "Prompt is too
 * long · single-exchange conversation cannot be compacted." Bound only
 * non-protected message bodies; never strip the primary system/instruction
 * message, compaction markers, or working-context capsules.
 */
const SINGLE_EXCHANGE_BODY_MIN_CHARS = 4_000;
const SINGLE_EXCHANGE_BODY_SAFETY_TOKENS = 2_048;

function isProtectedSingleExchangeMessage(
  message: ExecutorMessage,
  index: number,
  messages: readonly ExecutorMessage[],
): boolean {
  if (message.model === "compaction-marker") return true;
  if (typeof message.content === "string") {
    const content = message.content;
    if (
      content.startsWith("[Working Context Capsule]")
      || content.startsWith("[Compaction Summary]")
      || content.includes("<security")
      || content.includes("## Security")
      || content.includes("SECURITY.md")
    ) {
      return true;
    }
  }
  // Primary assembled system prompt is load-bearing instruction/security context.
  if (message.role === "system") {
    const firstSystemIdx = messages.findIndex((entry) => entry.role === "system");
    if (firstSystemIdx === index) return true;
  }
  return false;
}

function boundTextBody(text: string, maxChars: number): { text: string; changed: boolean } {
  if (!text || text.length <= maxChars) return { text, changed: false };
  const floor = Math.max(SINGLE_EXCHANGE_BODY_MIN_CHARS, Math.min(maxChars, text.length));
  if (text.length <= floor) return { text, changed: false };
  const headBudget = Math.max(1_500, Math.floor(floor * 0.72));
  const tailBudget = Math.max(0, floor - headBudget - 220);
  const head = text.slice(0, headBudget).trimEnd();
  const tail = tailBudget > 0 ? text.slice(-tailBudget).trimStart() : "";
  const omitted = text.length - head.length - tail.length;
  const notice =
    `\n\n[Single-exchange context bound: omitted ${omitted.toLocaleString()} chars before provider dispatch. ` +
    `Required instructions and security context were retained. Retrieve archived depth with indexed_content when needed.]\n\n`;
  return {
    text: tail ? `${head}${notice}${tail}` : `${head}${notice}`,
    changed: true,
  };
}

function boundContentBlocks(
  blocks: ContentBlock[],
  maxChars: number,
): { blocks: ContentBlock[]; changed: boolean; charsBefore: number; charsAfter: number } {
  let charsBefore = 0;
  let charsAfter = 0;
  let changed = false;
  const next = blocks.map((block) => {
    if (block.type === "tool_result" && typeof block.content === "string") {
      charsBefore += block.content.length;
      const bounded = boundTextBody(block.content, maxChars);
      charsAfter += bounded.text.length;
      if (bounded.changed) {
        changed = true;
        return { ...block, content: bounded.text };
      }
      return block;
    }
    if (block.type === "text" && typeof block.text === "string") {
      charsBefore += block.text.length;
      const bounded = boundTextBody(block.text, maxChars);
      charsAfter += bounded.text.length;
      if (bounded.changed) {
        changed = true;
        return { ...block, text: bounded.text };
      }
      return block;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      charsBefore += block.thinking.length;
      // Thinking is never required instruction/security context — drop aggressively.
      if (block.thinking.length > 500) {
        changed = true;
        charsAfter += 0;
        return null;
      }
      charsAfter += block.thinking.length;
      return block;
    }
    const serialized = typeof block === "object" ? JSON.stringify(block) : String(block ?? "");
    charsBefore += serialized.length;
    charsAfter += serialized.length;
    return block;
  }).filter((block): block is ContentBlock => block != null);
  return { blocks: next, changed, charsBefore, charsAfter };
}

function boundSingleExchangeBodies(
  messages: ExecutorMessage[],
  budget: ContextRequestBudget,
  toolDefinitionTokens: number,
): { messages: ExecutorMessage[]; compacted: boolean; bodiesBound: number; charsSaved: number } {
  const hardCeiling = Math.max(
    0,
    budget.hardInputLimit - toolDefinitionTokens - SINGLE_EXCHANGE_BODY_SAFETY_TOKENS,
  );
  if (hardCeiling <= 0) {
    return { messages, compacted: false, bodiesBound: 0, charsSaved: 0 };
  }

  // Measure protected vs reducible mass so we only spend the residual budget
  // on non-protected bodies (attachments, oversized user/tool text).
  let protectedTokens = 0;
  const reducibleIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const tokens = estimateMessageInputTokens(message);
    if (isProtectedSingleExchangeMessage(message, i, messages)) {
      protectedTokens += tokens;
    } else {
      reducibleIdx.push(i);
    }
  }

  const residualTokens = Math.max(0, hardCeiling - protectedTokens);
  if (reducibleIdx.length === 0 || residualTokens <= 0) {
    return { messages, compacted: false, bodiesBound: 0, charsSaved: 0 };
  }

  // Newest reducible message (usually the current user turn) keeps the largest share.
  const weights = reducibleIdx.map((_, offset) => {
    const fromEnd = reducibleIdx.length - 1 - offset;
    return fromEnd === 0 ? 4 : fromEnd === 1 ? 2 : 1;
  });
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const charsPerToken = 4;
  let bodiesBound = 0;
  let charsSaved = 0;
  const next = messages.map((message) => ({ ...message }));

  for (let offset = 0; offset < reducibleIdx.length; offset++) {
    const index = reducibleIdx[offset];
    const message = next[index];
    const shareTokens = Math.max(
      Math.floor((residualTokens * weights[offset]) / weightSum),
      Math.floor(SINGLE_EXCHANGE_BODY_MIN_CHARS / charsPerToken),
    );
    const maxChars = Math.max(SINGLE_EXCHANGE_BODY_MIN_CHARS, shareTokens * charsPerToken);

    if (typeof message.content === "string") {
      const before = message.content.length;
      const bounded = boundTextBody(message.content, maxChars);
      if (bounded.changed) {
        next[index] = { ...message, content: bounded.text };
        bodiesBound += 1;
        charsSaved += Math.max(0, before - bounded.text.length);
      }
      continue;
    }

    if (Array.isArray(message.content)) {
      const bounded = boundContentBlocks(message.content as ContentBlock[], maxChars);
      if (bounded.changed) {
        next[index] = { ...message, content: bounded.blocks };
        bodiesBound += 1;
        charsSaved += Math.max(0, bounded.charsBefore - bounded.charsAfter);
      }
    }
  }

  return {
    messages: next,
    compacted: bodiesBound > 0,
    bodiesBound,
    charsSaved,
  };
}

async function runCompaction(
  messages: ExecutorMessage[],
  budget: ContextRequestBudget,
  toolDefinitionTokens: number,
  publish: (type: JournalEntry["type"], extra?: Partial<JournalEntry>) => void,
  hasRunMidTurnHistoryHardTrim: boolean,
  resolvedModel: string,
): Promise<{ messages: ExecutorMessage[]; action: MidTurnCompactionAction; summaryContent?: string; telemetry: CompactionTelemetry }> {
  const toolSoftTrimThreshold = budget.thresholds.midTurnToolSoftTrim;
  const historyHardTrimThreshold = budget.thresholds.midTurnHistoryHardTrim;
  const historyResetThreshold = budget.thresholds.midTurnHistoryReset;
  const estimateRequestTokens = async (requestMessages: ExecutorMessage[]) =>
    applyTokenEstimateCalibration(
      resolvedModel,
      estimateTotalTokens(requestMessages) + toolDefinitionTokens,
    );

  let currentTokens = await estimateRequestTokens(messages);
  const tokensBefore = currentTokens;
  const messagesBefore = messages.length;
  const preToolRunPressure = messages.every(m => m.role !== "tool_result");
  let action: MidTurnCompactionAction = "none";
  let summaryContent: string | undefined;
  let historyHardTrimTelemetry: MidTurnHistoryHardTrimTelemetry | undefined;

  if (currentTokens <= toolSoftTrimThreshold) {
    log.debug(
      `Compaction not needed: request=${currentTokens} tokens <= toolSoftTrim=${toolSoftTrimThreshold} ` +
        `historyReset=${historyResetThreshold} hard=${budget.hardInputLimit}`,
    );
    return {
      messages,
      action: "none",
      telemetry: {
        action: "none",
        outcome: "skipped",
        trigger: "mid-run",
        preToolRunPressure,
        reason: "below_threshold",
        contextLimit: budget.contextWindow,
        outputReserve: budget.outputReserve,
        hardInputLimit: budget.hardInputLimit,
        toolDefinitionTokens,
        toolSoftTrimThreshold,
        historyHardTrimThreshold,
        historyResetThreshold,
        tokensBefore,
        tokensAfter: currentTokens,
        tokensSaved: 0,
        messagesBefore,
        messagesAfter: messages.length,
        hasRunMidTurnHistoryHardTrim,
      },
    };
  }

  log.debug(
    `Compaction needed: request=${currentTokens} tokens > toolSoftTrim=${toolSoftTrimThreshold} ` +
      `historyReset=${historyResetThreshold} hard=${budget.hardInputLimit}`,
  );
  const compactionStepId = `compaction-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  publish("compacting", { stepId: compactionStepId, status: "active", content: "Working context compression started..." });
  const preparedHistoryHardTrimCapsule = currentTokens > historyHardTrimThreshold
    ? prepareMidTurnHistoryHardTrimCapsule(messages)
    : null;

  const toolSoftTrim = compactMidTurnToolSoftTrim(messages);
  if (toolSoftTrim.compacted) {
    messages = toolSoftTrim.messages;
    currentTokens = await estimateRequestTokens(messages);
    action = "mid_turn_tool_soft_trim";
    log.debug(`Mid-turn tool soft trim complete: ${currentTokens} tokens`);
  }

  if (currentTokens > historyHardTrimThreshold) {
    log.debug(
      `Mid-turn history hard trim needed: request=${currentTokens} tokens > ` +
        `historyHardTrim=${historyHardTrimThreshold} historyReset=${historyResetThreshold} hard=${budget.hardInputLimit}`,
    );
    publish("compacting", { stepId: compactionStepId, status: "active", content: "Folding earlier working context..." });
    const historyHardTrim = compactMidTurnHistoryHardTrim(messages, preparedHistoryHardTrimCapsule);
    historyHardTrimTelemetry = historyHardTrim.telemetry;
    if (historyHardTrim.compacted) {
      messages = historyHardTrim.messages;
      currentTokens = await estimateRequestTokens(messages);
      action = "mid_turn_history_hard_trim";
      summaryContent = historyHardTrim.summaryContent;
      log.debug(`Mid-turn history hard trim complete: ${currentTokens} tokens`);
    }
  }

  if (currentTokens > historyResetThreshold) {
    log.debug(
      `Mid-turn history reset needed: ${currentTokens} tokens > ` +
        `historyReset=${historyResetThreshold} hard=${budget.hardInputLimit}`,
    );
    publish("compacting", { stepId: compactionStepId, status: "active", content: "Resetting working context..." });
    const historyReset = compactMidTurnHistoryReset(messages);
    if (historyReset.compacted) {
      messages = historyReset.messages;
      currentTokens = await estimateRequestTokens(messages);
      action = "mid_turn_history_reset";
      log.debug(`Mid-turn history reset complete: ${currentTokens} tokens`);
    }
  }

  // First-exchange / irreducible bodies: history compaction cannot help when
  // there are no assistant/tool pairs. Bound oversized non-protected bodies
  // before the hard-limit fail-closed gate.
  if (currentTokens > budget.hardInputLimit) {
    publish("compacting", {
      stepId: compactionStepId,
      status: "active",
      content: "Bounding oversized single-exchange content before provider dispatch...",
    });
    const singleExchange = boundSingleExchangeBodies(messages, budget, toolDefinitionTokens);
    if (singleExchange.compacted) {
      messages = singleExchange.messages;
      currentTokens = await estimateRequestTokens(messages);
      action = "single_exchange_body_bound";
      log.warn(
        `Single-exchange body bound applied: request=${currentTokens} tokens hard=${budget.hardInputLimit} ` +
          `bodiesBound=${singleExchange.bodiesBound} charsSaved=${singleExchange.charsSaved}`,
      );
    }
  }

  publish("compacting", {
    stepId: compactionStepId,
    status: "done",
    content: action !== "none" ? `Working context action applied: ${action}.` : "Working context compression checked; no changes needed.",
  });

  return {
    messages,
    action,
    summaryContent,
    telemetry: {
      action,
      outcome: action !== "none" ? "applied" : "skipped",
      trigger: "mid-run",
      preToolRunPressure,
      reason: tokensBefore > toolSoftTrimThreshold ? "above_threshold" : "below_threshold",
      contextLimit: budget.contextWindow,
      outputReserve: budget.outputReserve,
      hardInputLimit: budget.hardInputLimit,
      toolDefinitionTokens,
      toolSoftTrimThreshold,
      historyHardTrimThreshold,
      historyResetThreshold,
      tokensBefore,
      tokensAfter: currentTokens,
      tokensSaved: tokensBefore - currentTokens,
      messagesBefore,
      messagesAfter: messages.length,
      hasRunMidTurnHistoryHardTrim,
      historyHardTrim: historyHardTrimTelemetry,
    },
  };
}

interface RunIterationContext {
  runId: string;
  modelString: string;
  emit: (event: StreamEvent) => void;
  journal: (type: JournalEntry["type"], extra?: Partial<JournalEntry>) => void;
  publish: (type: JournalEntry["type"], extra?: Partial<JournalEntry>) => void;
  allThinking: string[];
  resolvedToolCalls: ExecutorRunResult["toolCalls"];
  totalUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  responseGenerationLimit: {
    configuredOutputTokens: number;
    finalResponseOutputTokens: number;
  };
  /**
   * Raw (pre-calibration) baseline estimate for the current iteration's request,
   * paired with provider-reported input after the call so the estimator can learn.
   */
  preflightRawEstimateTokens: number;
  resolvedModel: string;
  resolvedProvider: string;
  routingDecision: ModelRoutingDecision;
  routingTier: string;
  iteration: number;
  emergencyCompactionRetries: number;
  emptyFinalTurnRetries: number;
  streamIdleRecoveryAttempts: number;
  aborted: boolean;
  abortReason?: AbortReason;
  abortDetails?: AbortDetails;
  iterationThinking: string;
  iterationText: string;
  iterationUsage: { inputTokens: number; outputTokens: number; totalTokens: number };
  iterationUsageMetadata?: Record<string, unknown>;
  pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  sdkHandledToolIds: Set<string>;
  /** Stub (un-hydrated authority) tools called this iteration, awaiting real-schema hydration. */
  autohydratePending: Set<string>;
  /** Stub tools whose real schema has already been hydrated into the tool set this run. */
  autohydratedToolNames: Set<string>;
  /** Cache tool call arguments in sdk_owned mode so tool_result_resolved can look them up. */
  toolCallArgsCache: Map<string, Record<string, unknown>>;
  /** Determines who owns tool execution for this run. */
  executionMode: "sdk_owned" | "executor_owned";
  lastStreamDiagnostics?: { eventCount: number; elapsedMs: number; lastEventType: string };
  iterationStopReason?: string;
  lastIterationFailureKey?: string;
  consecutiveFailureIterations: number;
  budgets: {
    maxIterations: number;
    maxToolCalls: number;
    toolCallsUsed: number;
  };
  budgetExhaustion?: {
    kind: "iterations" | "tool_calls";
    limit: number;
    used: number;
  };
  // Last error string yielded by the model adapter via {type:"error", error:"…"}.
  // Captured here so result.error reflects the real underlying message even when
  // an upstream abort or other path bypasses the run's outer catch block.
  lastError?: string;
  providerFailure?: ModelProviderFailureInfo;
  pendingCostLogs: Promise<void>[];
  // All non-cost-log background work the run launched (CLI iterator-return chains
  // after force-abort, interrupt acks, generator-return on idle timeout, ...).
  // The run's finally drains this set before releasing its admission slot, so we
  // can never report "slot free" while the work that slot launched is still
  // consuming the pool / event loop. Bounded by POST_ABORT_DRAIN_GRACE_MS.
  backgroundWork: Set<Promise<void>>;
  llmCallStartTime?: number;
  llmConnectedTime?: number;
  /** Wall-clock of the first visible output (thinking/text/tool) for this iteration. */
  firstOutputTime?: number;
  llmRequestSentEmitted?: boolean;
  firstTokenEmitted?: boolean;
  llmConnectedEmitted?: boolean;
  llmConnectedDoneEmitted?: boolean;
  llmHeadersEmitted?: boolean;
  activeResponsePhase?: { step: "llm_request_sent" | "llm_wait_provider" | "llm_wait_first_token" | "llm_receive_stream"; stepId: string };
  thinkingStepActive?: boolean;
  activeToolUseSteps: Map<string, number>;
  activeSystemSpans: Map<string, { id: string; startedAt: number; parentId?: string; detail?: string; metadata?: Record<string, unknown>; diagnosticVisibility?: "default" | "raw" | "hidden"; childMode?: "serial" | "parallel" }>;
  // Chronology state — built incrementally by processStreamEvent
  segmentChronology: SegmentChronologyEntry[];
  systemStepsData: SystemStepRecord[];
  chronologyThinkingIdx: number;
  chronologyThinkingBuf: string;
  chronologyContentIdx: number;
  chronologyContentBuf: string;
  chronologyIterationContentPrefix: string;
  // Task #1007 step 4: timestamp captured when tool_use is received from
  // the model stream. Compared against the moment executeOne actually
  // begins to detect dispatch-gap regressions (e.g. main-thread blocked
  // between stream-end and tool dispatch). Edge-triggered; one warn line
  // per call when delta > DISPATCH_GAP_WARN_MS. No polling, no interval.
  toolUseReceivedAt: Map<string, number>;
  /** One recovery ledger for the complete run; never reset between model iterations. */
  operationRecovery: ToolOperationRecovery;
  terminalToolFailure?: { toolName: string; result: string; failure: ToolFailure };
  diagnosticLastStep?: "model_response" | "tool_batch" | "terminal";
  /**
   * Bounded ring buffer of recent execution breadcrumbs (phase transitions and
   * tool dispatch). Dumped on the error path to triangulate the crash lead-up,
   * such as a runtime circular-import TDZ that surfaces mid-run at a lazy
   * `await import(...)`. Entries carry tool name + call id only — never tool
   * input — so no user content is logged. Capped in pushExecTrace().
   */
  execTrace: Array<{ t: number; label: string; meta?: string }>;
  diagnosticLastModelStopReason?: string;
  diagnosticLastAssistantTextLength: number;
  /** Visible (thinking-stripped, trimmed) text length of the LAST completed model turn. Classifier discriminant for empty final turns. */
  diagnosticLastAssistantVisibleTextLength: number;
  diagnosticLastToolCallId?: string;
  diagnosticLastToolBatchCompletedAt?: number;
  diagnosticHadToolErrors: boolean;
  diagnosticFailedToolCount: number;
  personaSwitchRequested?: { toolCallId: string };
  toolSchemaRefreshRequested?: { toolCallId: string; toolName: string };
  awaitUserRequested?: { toolCallId: string };
  sessionCompleteRequested?: { toolCallId: string };
  intentionallyAwaitingUser: boolean;
  /** True when a successful session.end / set_status=saved intentionally completed the run. */
  intentionallyCompletedSession: boolean;
  /** Bounded re-drive count when a Plan child naturally stops without a terminal assertion. */
  missionCompletionAssertionRetries: number;
  iterationToolCalls: Array<{ id: string; name: string; args: Record<string, unknown>; order: number }>;
  convergence: RunConvergenceState;
}

const ZOMBIE_CHECK_INTERVAL_MS = 60_000;
const ZOMBIE_IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const ZOMBIE_HARD_CAP_MS = 40 * 60 * 1000;

const DEFAULT_MAX_ITERATIONS = 256;
const HARD_MAX_ITERATIONS = 256;
const DEFAULT_MAX_TOOL_CALLS = 256;
const HARD_MAX_TOOL_CALLS = 256;

function resolveRunBudget(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Executor run budget must be a positive finite number; received ${String(value)}`);
  }
  return Math.min(Math.floor(value), ceiling);
}

const ITERATION_CONTENT_SEPARATOR = "\n\n";
// A completed model turn (no tool calls, no await-user pause) that produces no
// visible text is never a clean success — it is a known provider failure mode.
// Grok/xAI can return end_turn with 0 output tokens after a long tool-use
// sequence (cline #6269, litellm #17136), and the same class appears on other
// providers (DeepSeek #1453, GPT-4o content=None). Re-drive this many times
// before accepting the empty completion. Attempt 1 is a pure re-sample;
// later attempts inject a max_tokens-style continuation nudge (community
// remedy when unchanged-context retries still return empty). Bounded so a
// deterministically-empty context cannot loop.
const MAX_EMPTY_FINAL_TURN_RETRIES = 3;
const EMPTY_FINAL_TURN_NUDGE =
  "[System: Your previous completion returned no visible text after the latest tool results. Continue from the current state: give a brief status and either take the next tool action or finish with a short answer. Do not repeat prior tool narration.]";

/**
 * Merge every model iteration's visible prose into the durable assistant body.
 * Tool-call preambles were already streamed to the user, so finalization must
 * preserve them rather than replace them with the post-tool response.
 *
 * The chronology producer applies the same separator before the first content
 * segment of each later text-producing iteration. This keeps the durable body
 * and its chronological content projection identical by construction.
 */
export function mergeIterationResults(
  results: Array<{ content: string; continuationType?: "tool_call" | "max_tokens" }>,
): string {
  return results
    .map((result) => result.content)
    .filter(Boolean)
    .join(ITERATION_CONTENT_SEPARATOR);
}

export type PendingSessionEnd = {
  status: "saved" | "failed";
  summary?: string;
  requestedAt: number;
};

/**
 * Push a bounded execution breadcrumb onto the run's trace ring. Additive
 * diagnostics only — records phase + tool name/call-id, NEVER tool input, so no
 * user content (S1–S3) enters logs. The ring is capped at TRACE_RING_MAX and
 * dumped on the executor error path to triangulate the operation in flight when
 * a runtime crash (e.g. a lazy-import circular-dependency TDZ) fires. Module-
 * level so it is `this`-independent at every call site.
 */
const TRACE_RING_MAX = 60;
function pushExecTrace(ctx: RunIterationContext, label: string, meta?: string): void {
  const ring = ctx.execTrace;
  if (!ring) return;
  ring.push({ t: Date.now(), label, meta });
  if (ring.length > TRACE_RING_MAX) ring.shift();
}

export class AgentExecutor extends EventEmitter {
  private activeRuns = new Map<string, ActiveRunProgress>();
  /** One pending handoff per session — consumed by the next processChatStream. */
  private sessionHandoffs = new Map<string, SessionHandoff>();
  /**
   * Session IDs whose executor run has returned but whose toolCalls have not
   * yet been persisted by the caller (skill-runner / chat routes). Prevents
   * child monitors from treating mid-run session.end "saved" as completion
   * before extractSuccessfulToolInvocations can see durable tool evidence.
   */
  private settlingSessions = new Map<string, number>();
  /**
   * Terminal status requested via session.end / set_status while a run was
   * still active or settling. Applied only after tool persistence.
   */
  private pendingSessionEnds = new Map<string, PendingSessionEnd>();
  /** Terminal ends already applied after tool persistence — outer finalizers must not clobber. */
  private appliedSessionEnds = new Map<string, PendingSessionEnd>();
  private zombieCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    this.startZombieDetection();
  }

  private startZombieDetection(): void {
    // Zombie detection used to be observe-only — we logged a warning and walked
    // away, which let leaked admission slots accumulate silently. Now we ACT:
    // any run still alive past the inactivity threshold or its execution hard
    // cap gets the matching inactivity or execution-limit reason. The run's
    // own finally then does the bounded drain and slot release. We skip already-
    // aborted runs so the drain grace window can finish without us re-firing.
    this.zombieCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const [runId, run] of this.activeRuns) {
        if (!run.admitted || run.startedAt === undefined || run.lastActivityAt === undefined) {
          continue;
        }
        const ageMs = now - run.startedAt;
        const idleMs = now - run.lastActivityAt;
        const hardCap = run.hardCapMs ?? ZOMBIE_HARD_CAP_MS;
        const streamDeadlineActive = run.streamIdleDeadlineAt !== undefined && now <= run.streamIdleDeadlineAt;
        if ((!streamDeadlineActive && idleMs > ZOMBIE_IDLE_THRESHOLD_MS) || (hardCap > 0 && ageMs > hardCap)) {
          if (run.abort.signal.aborted) {
            log.warn(`zombie activeRun still draining runId=${runId} sessionId=${run.sessionId} model=${run.model} activity=${run.activity} ageMs=${ageMs} idleMs=${idleMs} — already aborted, awaiting drain`);
            continue;
          }
          const exceededIdleLimit = idleMs > ZOMBIE_IDLE_THRESHOLD_MS;
          const reason: AbortReason = exceededIdleLimit ? "zombie_timeout" : "run_time_limit";
          log.warn(`activeRun watchdog stopped runId=${runId} sessionId=${run.sessionId} model=${run.model} activity=${run.activity} ageMs=${ageMs} idleMs=${idleMs} reason=${reason}`);
          this.abortRun(runId, reason);
        }
      }
    }, ZOMBIE_CHECK_INTERVAL_MS);
    if (this.zombieCheckTimer.unref) this.zombieCheckTimer.unref();
  }

  getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  getChatActiveRunCount(): number {
    let count = 0;
    for (const run of this.activeRuns.values()) {
      if (run.activity === ACTIVITY_CHAT || run.activity === "voice") {
        count++;
      }
    }
    return count;
  }

  getActiveRuns(): Array<{ runId: string; createdAt: number; startedAt: number; lastActivityAt: number; admitted: boolean; sessionId?: string; model?: string; activity?: string; sessionKey?: string; requestContent?: string; aborted?: boolean }> {
    return Array.from(this.activeRuns.entries()).map(([runId, run]) => ({
      runId,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? run.createdAt,
      lastActivityAt: run.lastActivityAt ?? run.createdAt,
      admitted: run.admitted,
      sessionId: run.sessionId,
      model: run.model,
      activity: run.activity,
      sessionKey: run.sessionKey,
      requestContent: run.requestContent,
      aborted: !!run.aborted,
    }));
  }

  /** Override the hard cap for a session's active run. Pass 0 to disable. */
  setRunHardCap(sessionId: string, ms: number): void {
    for (const run of this.activeRuns.values()) {
      if (run.sessionId === sessionId) {
        run.hardCapMs = ms;
        return;
      }
    }
  }

  /** Touch lastActivityAt for the active run belonging to a session, keeping the zombie idle timer fresh. */
  heartbeatRunBySessionId(sessionId: string): void {
    for (const run of this.activeRuns.values()) {
      if (run.sessionId === sessionId && run.admitted) {
        run.lastActivityAt = Date.now();
        return;
      }
    }
  }

  private abortActiveRun(runId: string, run: { abort: AbortController; aborted?: boolean; sessionId?: string; sessionKey?: string }, reason: AbortReason): void {
    abortTrace("agent_executor.abortActiveRun", {
      runId,
      sessionId: run.sessionId,
      sessionKey: run.sessionKey,
      reason,
    }, "warn");
    run.aborted = true;
    if (!run.abort.signal.aborted) {
      run.abort.abort(reason);
    }
  }

  abortRun(runId: string, reason: AbortReason = "cancelled"): boolean {
    const run = this.activeRuns.get(runId);
    if (run) {
      this.abortActiveRun(runId, run, reason);
      return true;
    }
    return false;
  }

  hasActiveRunForSession(sessionId: string): boolean {
    for (const run of this.activeRuns.values()) {
      if (run.sessionId === sessionId) return true;
    }
    return false;
  }

  /** True while a run is live OR tools from a just-finished run are still being persisted. */
  isSessionBusy(sessionId: string): boolean {
    return this.hasActiveRunForSession(sessionId) || this.settlingSessions.has(sessionId);
  }

  beginSessionSettling(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.settlingSessions.set(sessionId, Date.now());
  }

  endSessionSettling(sessionId: string | undefined): void {
    if (!sessionId) return;
    this.settlingSessions.delete(sessionId);
  }

  markPendingSessionEnd(
    sessionId: string,
    status: "saved" | "failed",
    summary?: string,
  ): void {
    this.pendingSessionEnds.set(sessionId, {
      status,
      summary: summary?.trim() ? summary.trim() : undefined,
      requestedAt: Date.now(),
    });
  }

  takePendingSessionEnd(sessionId: string): PendingSessionEnd | undefined {
    const pending = this.pendingSessionEnds.get(sessionId);
    if (!pending) return undefined;
    this.pendingSessionEnds.delete(sessionId);
    return pending;
  }

  peekPendingSessionEnd(sessionId: string): PendingSessionEnd | undefined {
    return this.pendingSessionEnds.get(sessionId);
  }

  markAppliedSessionEnd(sessionId: string, end: PendingSessionEnd): void {
    this.appliedSessionEnds.set(sessionId, end);
  }

  clearAppliedSessionEnd(sessionId: string): void {
    this.appliedSessionEnds.delete(sessionId);
  }

  /** True if a deferred end is pending or was already applied for this session. */
  hasDeferredOrAppliedSessionEnd(sessionId: string): boolean {
    return this.pendingSessionEnds.has(sessionId) || this.appliedSessionEnds.has(sessionId);
  }

  /** True if any active run for this session has started tools or streamed assistant text. */
  sessionRunHasProgress(sessionId: string): boolean {
    for (const run of this.activeRuns.values()) {
      if (run.sessionId === sessionId && (run.hasStartedActing || !!run.lastAssistantText)) {
        return true;
      }
    }
    return false;
  }

  /** Record that a run began acting (tool_use) so supersession can set approved stance. */
  markRunActing(runId: string, toolName?: string): void {
    const run = this.activeRuns.get(runId);
    if (!run) return;
    run.hasStartedActing = true;
    run.lastActivityAt = Date.now();
    if (toolName) {
      const names = run.toolNames ?? [];
      if (!names.includes(toolName)) names.push(toolName);
      run.toolNames = names.slice(-12);
    }
  }

  /** Keep a rolling slice of assistant text for supersession capsule objective/resume. */
  noteRunAssistantText(runId: string, text: string): void {
    const run = this.activeRuns.get(runId);
    if (!run || !text.trim()) return;
    const trimmed = text.trim();
    run.lastAssistantText = (run.lastAssistantText ? `${run.lastAssistantText}\n${trimmed}` : trimmed).slice(-2000);
    run.lastActivityAt = Date.now();
  }

  /**
   * Snapshot a ContinuationCapsule from the dying run so the replacement inherits
   * objective + executionStance. Only written on supersession (follow-up abort).
   */
  private snapshotSupersessionHandoff(sessionId: string, run: ActiveRunProgress): void {
    const prior = this.sessionHandoffs.get(sessionId)?.capsule;
    const toolNames = run.toolNames ?? [];
    const hasProgress = !!(run.hasStartedActing || run.lastAssistantText);
    const stance: ContinuationCapsule["executionStance"] =
      run.hasStartedActing || prior?.executionStance === "approved_to_execute"
        ? "approved_to_execute"
        : prior?.executionStance;
    const entries: ContinuationCapsuleEntry[] = [];
    if (run.requestContent) {
      entries.push({
        role: "user",
        content: run.requestContent.slice(0, 4000),
        createdAt: new Date(run.createdAt).toISOString(),
      });
    }
    if (run.lastAssistantText) {
      entries.push({
        role: "assistant",
        content: run.lastAssistantText.slice(0, 4000),
        createdAt: new Date().toISOString(),
      });
    }
    for (const name of toolNames) {
      entries.push({
        role: "tool",
        toolName: name,
        content: "started",
        createdAt: new Date().toISOString(),
      });
    }
    const capsule = buildContinuationCapsule(entries, prior, {
      latestUserInstruction: prior?.latestUserInstruction,
      executionStance: stance,
      stanceReason: run.hasStartedActing
        ? `superseded while executing${toolNames.length ? ` (${toolNames.slice(-4).join(", ")})` : ""}`
        : hasProgress
          ? "superseded after assistant progress"
          : "superseded before first model output — continue prior mission",
    });
    if (!capsule.objective && run.objectiveHint) {
      capsule.objective = run.objectiveHint;
    }
    if (!capsule.resumePoint) {
      capsule.resumePoint = run.hasStartedActing
        ? "Continue the approved mission from the interrupted tool/work stream. Do not re-ask permission."
        : "Continue the prior turn's mission; the follow-up aborted a zero-output run.";
    }
    if (stance === "approved_to_execute" && !capsule.openLoops.includes("approved execution in progress")) {
      capsule.openLoops = trimOpenLoop(capsule.openLoops, "approved execution in progress");
    }
    this.sessionHandoffs.set(sessionId, {
      capsule,
      priorRequestContent: run.requestContent,
      hadProgress: hasProgress,
      createdAt: Date.now(),
    });
    log.info(
      `supersession handoff stored sessionId=${sessionId} stance=${capsule.executionStance ?? "none"} hadProgress=${hasProgress} tools=${toolNames.length}`,
    );
  }

  /** Peek sticky handoff (does not clear). Approved stance stays until clearSessionHandoff. */
  peekSessionHandoff(sessionId: string): SessionHandoff | undefined {
    return this.sessionHandoffs.get(sessionId);
  }

  /**
   * Consume handoff for injection into the next run.
   * Approved-to-execute handoffs remain sticky (peek semantics) so every restart
   * sees the discriminant until the mission completes or the user redirects.
   */
  takeSessionHandoff(sessionId: string): SessionHandoff | undefined {
    const handoff = this.sessionHandoffs.get(sessionId);
    if (!handoff) return undefined;
    if (handoff.capsule.executionStance !== "approved_to_execute") {
      this.sessionHandoffs.delete(sessionId);
    }
    return handoff;
  }

  /** Set or reinforce session stance from an approval signal outside supersession. */
  reinforceSessionStance(
    sessionId: string,
    input: {
      latestUserInstruction: string;
      objective?: string;
      stanceReason: string;
    },
  ): ContinuationCapsule {
    const prior = this.sessionHandoffs.get(sessionId)?.capsule;
    const capsule = buildContinuationCapsule([], prior, {
      latestUserInstruction: input.latestUserInstruction,
      executionStance: "approved_to_execute",
      stanceReason: input.stanceReason,
    });
    if (input.objective) capsule.objective = input.objective;
    if (!capsule.resumePoint) {
      capsule.resumePoint = "Execute the approved instruction. Do not re-derive or re-ask.";
    }
    capsule.openLoops = trimOpenLoop(capsule.openLoops, "approved execution in progress");
    this.sessionHandoffs.set(sessionId, {
      capsule,
      priorRequestContent: input.latestUserInstruction,
      hadProgress: false,
      createdAt: Date.now(),
    });
    return capsule;
  }

  clearSessionHandoff(sessionId: string, reason: string): void {
    if (this.sessionHandoffs.delete(sessionId)) {
      log.info(`session handoff cleared sessionId=${sessionId} reason=${reason}`);
    }
  }

  // Returns the count of runs aborted (was previously a boolean that early-
  // returned on first match, leaving N-1 runs still consuming admission slots
  // and DB connections — root cause of the 2026-04-23 stop-button wedge).
  abortByChatSessionId(sessionId: string, reason: AbortReason = "cancelled"): number {
    let count = 0;
    for (const [runId, run] of this.activeRuns) {
      if (run.sessionId === sessionId) {
        // Supersession is the cold-restart boundary that previously dropped intent.
        // Snapshot stance/objective before the abort tears the run down.
        if (reason === "superseded") {
          this.snapshotSupersessionHandoff(sessionId, run);
        }
        this.abortActiveRun(runId, run, reason);
        count++;
      }
    }
    return count;
  }

  abortVoiceSession(sessionId: string, sessionKey: string): { aborted: boolean; runsKilled: number } {
    let runsKilled = 0;
    const killedRunIds: string[] = [];
    for (const [runId, run] of this.activeRuns) {
      if (run.sessionKey === sessionKey || (sessionId && run.sessionId === sessionId)) {
        this.abortActiveRun(runId, run, "cancelled");
        killedRunIds.push(runId);
        runsKilled++;
      }
    }
    if (killedRunIds.length > 0) {
      log.log(`abortVoiceSession: marked ${killedRunIds.length} runs as aborted: [${killedRunIds.join(", ")}] sessionId=${sessionId} sessionKey=${sessionKey}`);
    }
    return { aborted: runsKilled > 0, runsKilled };
  }

  countActiveVoiceRuns(activity: string): number {
    let count = 0;
    for (const run of this.activeRuns.values()) {
      if (run.activity === activity && !run.aborted) count++;
    }
    return count;
  }

  hasActiveVoiceRun(sessionId: string, sessionKey: string): boolean {
    const matching: Array<{ runId: string; aborted: boolean; ageMs: number }> = [];
    let hasNonAborted = false;
    for (const [runId, run] of this.activeRuns) {
      if (run.sessionKey === sessionKey || (sessionId && run.sessionId === sessionId)) {
        const entry = { runId, aborted: !!run.aborted, ageMs: Date.now() - (run.startedAt ?? run.createdAt) };
        matching.push(entry);
        if (!run.aborted) hasNonAborted = true;
      }
    }
    if (matching.length > 0) {
      const summary = matching.map(m => `${m.runId}(aborted=${m.aborted},age=${m.ageMs}ms)`).join(", ");
      log.debug(`hasActiveVoiceRun: found ${matching.length} matching runs [${summary}] returning=${hasNonAborted} sessionId=${sessionId} sessionKey=${sessionKey}`);
    }
    return hasNonAborted;
  }

  abortAll(): void {
    for (const [runId, run] of this.activeRuns) {
      this.abortActiveRun(runId, run, "cancelled");
    }
  }

  private flushChronologyThinking(ctx: RunIterationContext): void {
    if (ctx.chronologyThinkingIdx >= 0 && ctx.chronologyThinkingBuf) {
      const entry = ctx.segmentChronology[ctx.chronologyThinkingIdx];
      if (entry && entry.s === "thinking") {
        (entry as { s: "thinking"; c: string }).c = ctx.chronologyThinkingBuf;
      }
    }
    ctx.chronologyThinkingIdx = -1;
    ctx.chronologyThinkingBuf = "";
  }

  private flushChronologyContent(ctx: RunIterationContext): void {
    if (ctx.chronologyContentIdx >= 0 && ctx.chronologyContentBuf) {
      const entry = ctx.segmentChronology[ctx.chronologyContentIdx];
      if (entry && entry.s === "content") {
        (entry as { s: "content"; c: string }).c = ctx.chronologyContentBuf;
      }
    }
    ctx.chronologyContentIdx = -1;
    ctx.chronologyContentBuf = "";
  }

  private responseParentId(ctx: RunIterationContext): string {
    return `system-llm_call-model-${ctx.runId}-${ctx.iteration}`;
  }

  private startResponsePhase(
    ctx: RunIterationContext,
    step: NonNullable<RunIterationContext["activeResponsePhase"]>["step"],
    detail?: string,
  ): void {
    const stepId = `${ctx.runId}-${ctx.iteration}-${step}`;
    ctx.publish("system_step", {
      step,
      status: "started",
      stepId,
      parentId: this.responseParentId(ctx),
      detail,
    });
    ctx.activeResponsePhase = { step, stepId };
  }

  private finishResponsePhase(ctx: RunIterationContext, status: "done" | "error", detail?: string): void {
    const phase = ctx.activeResponsePhase;
    if (!phase) return;
    ctx.publish("system_step", { step: phase.step, status, stepId: phase.stepId, detail });
    ctx.activeResponsePhase = undefined;
  }

  private transitionResponsePhase(
    ctx: RunIterationContext,
    next: NonNullable<RunIterationContext["activeResponsePhase"]>["step"],
    completedDetail?: string,
  ): void {
    this.finishResponsePhase(ctx, "done", completedDetail);
    this.startResponsePhase(ctx, next);
  }

  private markFirstResponseOutput(
    ctx: RunIterationContext,
    options: ExecutorRunOptions,
    outputType: "thinking" | "text" | "tool",
  ): void {
    if (ctx.firstTokenEmitted || !ctx.llmCallStartTime) return;
    const occurredAt = Date.now();
    ctx.firstTokenEmitted = true;
    ctx.firstOutputTime = occurredAt;
    if (!ctx.llmConnectedEmitted) {
      ctx.llmConnectedEmitted = true;
      ctx.llmConnectedTime = occurredAt;
    }
    this.transitionResponsePhase(ctx, "llm_receive_stream");
    ctx.publish("system_step", {
      step: "first_token",
      status: "done",
      timingKind: "milestone",
      occurredAt,
      parentId: this.responseParentId(ctx),
      detail: formatInputContextDetail(options.contextPressure),
      metadata: { ...options.contextPressure, outputType },
    });
  }

  /**
   * Persist the model call's timing breakdown as a single diagnostic step on
   * every assistant message, for ALL providers/models/tiers. It reads the
   * already-computed provider `cliTiming` split (Claude CLI path) and falls back
   * to executor-tracked phase timestamps for other providers, so a slow
   * first-token turn shows exactly where the time went: prefill, pool/queue,
   * queue→first-event, thinking/pre-text, and decode. This is a read of existing
   * spans/telemetry, not new phase instrumentation.
   */
  private emitModelCallTimingStep(ctx: RunIterationContext, modelSpanId: string): void {
    if (!ctx.llmCallStartTime) return;
    const meta = (ctx.iterationUsageMetadata ?? {}) as Record<string, unknown>;
    const cli = (meta.cliTiming as Record<string, unknown> | undefined) ?? undefined;
    const now = Date.now();
    const start = ctx.llmCallStartTime;

    const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
    const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

    // Prefer the provider-computed breakdown; fall back to executor-tracked phase
    // timestamps so the step is populated for every provider, not just the CLI.
    const totalMs = num(cli?.totalMs) ?? now - start;
    const preSdkMs = num(cli?.preSdkMs);
    const poolAcquireMs = num(cli?.poolAcquireMs);
    const sdkImportMs = num(cli?.sdkImportMs);
    const firstEventAt = num(cli?.firstEventAt) ?? ctx.llmConnectedTime ?? null;
    const firstTextAt = num(cli?.firstTextAt) ?? ctx.firstOutputTime ?? null;
    const queueToFirstEventMs =
      num(cli?.sdkToFirstEventMs) ?? (firstEventAt != null ? firstEventAt - start : null);
    const firstEventToFirstTextMs =
      num(cli?.firstEventToFirstTextMs) ??
      (firstEventAt != null && firstTextAt != null ? firstTextAt - firstEventAt : null);
    const ttftMs = num(cli?.totalTtftMs) ?? (firstTextAt != null ? firstTextAt - start : null);
    const decodeMs = num(cli?.afterFirstTextMs) ?? (firstTextAt != null ? now - firstTextAt : null);

    // Thinking timing — captured even when thinking is not persisted as visible
    // content (closes the thinkingLen=0 blind spot).
    const msToFirstThinkingDelta = num(cli?.msToFirstThinkingDelta);
    const firstEventToFirstThinkingMs = num(cli?.firstEventToFirstThinkingMs);
    const thinkingChars = num(cli?.thinkingChars) ?? ctx.iterationThinking.length;

    // Felt-latency primary: first *progress* (thinking, text, or tool-use). Falls
    // back to the executor's first-output timestamp for non-CLI providers, since
    // that milestone already fires on the earliest of thinking/text/tool.
    const msToFirstProgress =
      num(cli?.msToFirstProgress) ?? (ctx.firstOutputTime != null ? ctx.firstOutputTime - start : null);
    const firstEventToFirstProgressMs = num(cli?.firstEventToFirstProgressMs);

    // Streaming shape: did incremental deltas arrive, or did text come buffered
    // in the terminal event? Decisive buffered-vs-incremental signal for a
    // collapsed TTFT.
    const sawStreamDeltas = bool(cli?.sawStreamDeltas);
    const firstEventType = typeof cli?.firstEventType === "string" ? cli.firstEventType : null;

    // Token-accounting semantics: mark cumulative-session counts so the UI does
    // not present them as this-turn output.
    const usageSemantics =
      (meta.usageSemantics as string | undefined) ??
      ((meta.tokenAccounting as Record<string, unknown> | undefined)?.usageSemantics as string | undefined) ??
      "unknown";
    const outputCumulative = usageSemantics === "cumulative_provider_session";

    const fmt = (ms: number | null): string | null =>
      ms == null ? null : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

    const detailParts: string[] = [];
    const push = (labelText: string, ms: number | null) => {
      const f = fmt(ms);
      if (f) detailParts.push(`${labelText} ${f}`);
    };
    push("prefill", preSdkMs);
    push("pool", poolAcquireMs);
    push("queue→1st-event", queueToFirstEventMs);
    push(thinkingChars > 0 ? "think→text" : "pre-text", firstEventToFirstTextMs);
    push("decode", decodeMs);
    const detail = `${fmt(totalMs)} total${detailParts.length ? " · " + detailParts.join(" · ") : ""}`;

    ctx.publish("system_step", {
      step: "model_call_timing",
      status: "done",
      stepId: modelSpanId,
      elapsedMs: Math.max(0, Math.round(totalMs)),
      selfTimeMs: Math.max(0, Math.round(totalMs)),
      parentId: canonicalSystemStepId("llm_call", modelSpanId),
      detail,
      metadata: {
        provider: ctx.resolvedProvider,
        model: ctx.resolvedModel,
        routingTier: ctx.routingTier,
        totalMs,
        ttftMs,
        preSdkMs,
        poolAcquireMs,
        sdkImportMs,
        queueToFirstEventMs,
        firstEventToFirstTextMs,
        decodeMs,
        msToFirstThinkingDelta,
        firstEventToFirstThinkingMs,
        msToFirstProgress,
        firstEventToFirstProgressMs,
        thinkingChars,
        firstEventType,
        sawStreamDeltas,
        poolHit: bool(cli?.poolHit),
        poolEligible: bool(cli?.poolEligible),
        outputTokens: ctx.iterationUsage.outputTokens,
        outputTokensAreCumulativeSession: outputCumulative,
        usageSemantics,
        tokenAccountingNote: outputCumulative
          ? "Output/token counts are cumulative for the provider session, not this turn."
          : undefined,
      },
    });
  }

  private async processStreamEvent(
    event: ModelStreamEvent,
    ctx: RunIterationContext,
    options: ExecutorRunOptions,
  ): Promise<void> {
    switch (event.type) {
      case "ttft_breakdown": {
        const breakdown = (event as unknown as { breakdown: Record<string, unknown> }).breakdown;
        eventBus.publish({
          category: "agent",
          event: "agent.ttft_breakdown",
          payload: { ...breakdown, runId: ctx.runId, source: options.activity || "agent" },
          runId: ctx.runId,
          sessionKey: options.sessionKey,
        });
        // Forward through onEvent so voice/streaming consumers can display the breakdown.
        ctx.emit(event as unknown as StreamEvent);
        break;
      }
      case "request_sent": {
        if (!ctx.llmCallStartTime || ctx.llmRequestSentEmitted) break;
        ctx.llmRequestSentEmitted = true;
        this.transitionResponsePhase(ctx, "llm_wait_provider", formatDispatchDetail((event as { metadata?: Record<string, unknown> }).metadata));
        break;
      }
      case "headers_received": {
        if (ctx.llmHeadersEmitted) break;
        ctx.llmHeadersEmitted = true;
        if (ctx.activeResponsePhase?.step !== "llm_wait_provider") break;
        this.transitionResponsePhase(ctx, "llm_wait_first_token", formatDispatchDetail((event as { metadata?: Record<string, unknown> }).metadata));
        break;
      }
      case "connected": {
        // Connector readiness is provider-specific raw telemetry, not an additive phase.
        const now = Date.now();
        if (!ctx.llmConnectedEmitted) {
          ctx.llmConnectedEmitted = true;
          ctx.llmConnectedTime = now;
          if (ctx.activeResponsePhase?.step === "llm_wait_provider") {
            this.transitionResponsePhase(ctx, "llm_wait_first_token");
          }
        }
        if (!ctx.llmConnectedDoneEmitted) {
          ctx.llmConnectedDoneEmitted = true;
          ctx.publish("system_step", {
            step: "llm_connected",
            status: "done",
            timingKind: "milestone",
            diagnosticVisibility: "raw",
            occurredAt: now,
            parentId: this.responseParentId(ctx),
          });
        }
        break;
      }

      case "attempt_reset": {
        // A transient provider failure voided the prior attempt's streamed
        // reasoning; the replacement attempt re-derives it from scratch. Drop
        // the uncommitted accumulation so chronology, the persisted thinking
        // record, and next-iteration conversation context cannot stitch two
        // attempts together.
        ctx.chronologyThinkingBuf = "";
        ctx.iterationThinking = "";
        if (ctx.chronologyThinkingIdx >= 0) {
          const entry = ctx.segmentChronology[ctx.chronologyThinkingIdx];
          if (entry && entry.s === "thinking") (entry as { s: "thinking"; c: string }).c = "";
        }
        log.debug(`attempt_reset voided replayed reasoning runId=${ctx.runId} iteration=${ctx.iteration}`);
        break;
      }

      case "thinking_delta": {
        this.markFirstResponseOutput(ctx, options, "thinking");
        if (!ctx.thinkingStepActive) {
          ctx.thinkingStepActive = true;
          ctx.publish("system_step", { step: "thinking", status: "started", parentId: `system-llm_call-model-${ctx.runId}-${ctx.iteration}` });
        }
        // Chronology: start a thinking segment if not already in one
        if (ctx.chronologyThinkingIdx < 0) {
          this.flushChronologyContent(ctx);
          ctx.chronologyThinkingIdx = ctx.segmentChronology.length;
          ctx.segmentChronology.push({ s: "thinking", c: "" });
        }
        ctx.chronologyThinkingBuf += event.content || "";
        ctx.iterationThinking += event.content || "";
        ctx.publish("thinking", { content: event.content });
        eventBus.publish({
          category: "agent",
          event: "agent.thinking",
          payload: { content: event.content, runId: ctx.runId, source: options.activity || "agent" },
          runId: ctx.runId,
          sessionKey: options.sessionKey,
        });
        break;
      }

      case "text_delta": {
        this.markFirstResponseOutput(ctx, options, "text");
        if (ctx.thinkingStepActive) {
          ctx.thinkingStepActive = false;
          ctx.publish("system_step", { step: "thinking", status: "done" });
        }
        // Chronology: flush thinking, start content segment
        this.flushChronologyThinking(ctx);

        const raw = event.content || "";
        const { thinking: tagThinking, clean } = extractThinkingFromText(ctx.iterationText + raw);

        if (tagThinking && tagThinking.length > ctx.iterationThinking.length) {
          const delta = tagThinking.slice(ctx.iterationThinking.length);
          ctx.iterationThinking = tagThinking;
          ctx.publish("thinking", { content: delta });
        }

        const prevClean = extractThinkingFromText(ctx.iterationText).clean;
        if (clean.length > prevClean.length) {
          const textDelta = clean.slice(prevClean.length);
          // Chronology: accumulate content
          if (ctx.chronologyContentIdx < 0) {
            ctx.chronologyContentIdx = ctx.segmentChronology.length;
            ctx.segmentChronology.push({ s: "content", c: "" });
            ctx.chronologyContentBuf = ctx.chronologyIterationContentPrefix;
            ctx.chronologyIterationContentPrefix = "";
          }
          ctx.chronologyContentBuf += textDelta;
          ctx.publish("delta", { content: textDelta });
          // Snapshot rolling assistant text for supersession handoff capsules.
          this.noteRunAssistantText(ctx.runId, textDelta);
        }

        ctx.iterationText += raw;
        break;
      }

      case "tool_use_start": {
        this.markFirstResponseOutput(ctx, options, "tool");
        this.markRunActing(ctx.runId, normalizeMcpToolName(event.toolName) || event.toolName);
        if (ctx.thinkingStepActive) {
          ctx.thinkingStepActive = false;
          ctx.publish("system_step", { step: "thinking", status: "done" });
        }
        const toolCallId = event.toolCallId || generateToolCallId();
        const normalizedName = normalizeMcpToolName(event.toolName) || "unknown";
        ctx.pendingToolCalls.push({
          id: toolCallId,
          name: normalizedName,
          input: {},
        });
        // Chronology: flush buffers before tool execution
        this.flushChronologyThinking(ctx);
        this.flushChronologyContent(ctx);

        log.verbose(() => `tool_use_start id=${toolCallId} name=${normalizedName} iteration=${ctx.iteration}`);
        ctx.publish("tool_call", { toolName: normalizedName, toolCallId, parentId: `system-llm_call-model-${ctx.runId}-${ctx.iteration}` });
        ctx.activeToolUseSteps.set(toolCallId, Date.now());
        ctx.publish("system_step", { step: "tool_use", status: "started", detail: normalizedName, stepId: toolCallId, parentId: `tool-${toolCallId}` });
        break;
      }

      case "tool_use_update": {
        // Early reasoning extracted from partial OpenAI argument deltas — update the existing tool step's narrative
        const narrative = event.narrative;
        const updateCallId = event.toolCallId;
        if (narrative && updateCallId) {
          ctx.publish("tool_call", { toolCallId: updateCallId, narrative, parentId: `system-llm_call-model-${ctx.runId}-${ctx.iteration}` });
        }
        break;
      }

      case "tool_use": {
        const toolCallId = event.toolCallId || generateToolCallId();
        const normalizedName = normalizeMcpToolName(event.toolName) || "unknown";
        const existingIdx = ctx.pendingToolCalls.findIndex(tc => tc.id === toolCallId);
        if (existingIdx >= 0) {
          ctx.pendingToolCalls[existingIdx].input = event.arguments || {};
        } else {
          ctx.pendingToolCalls.push({
            id: toolCallId,
            name: normalizedName,
            input: event.arguments || {},
          });
        }
        // Task #1007 step 4: capture the moment we observed the model's
        // tool_use so executeOne can compute the dispatch gap. Edge-
        // triggered warn fires if we don't reach "Tool starting" within
        // DISPATCH_GAP_WARN_MS — surfaces main-thread blocks that
        // happen between stream-end and tool dispatch (the exact gap
        // that hid in the bootId=molg5r37-3wwh wedge).
        ctx.toolUseReceivedAt.set(toolCallId, Date.now());
        // Task #1007 step 5: include a 120-char cmd preview when this
        // is a shell call so the very first log line for a tool dispatch
        // identifies the command. Previously the command never reached
        // stdout until/unless the shell handler emitted its own logs.
        let cmdPreview = "";
        if (normalizedName === "shell" && event.arguments && typeof (event.arguments as Record<string, unknown>).command === "string") {
          const cmd = String((event.arguments as Record<string, unknown>).command);
          cmdPreview = ` cmd=${JSON.stringify(cmd.slice(0, 120))}`;
        }
        const reasoning = (event.arguments as Record<string, unknown>)?.reasoning as string | undefined;
        log.verbose(() => `tool_use received id=${toolCallId} name=${normalizedName} iteration=${ctx.iteration} pendingToolCalls=${ctx.pendingToolCalls.length} inputKeys=${Object.keys(event.arguments || {}).join(",")}${cmdPreview}`);
        ctx.publish("tool_call", { toolName: normalizedName, toolCallId, arguments: event.arguments, narrative: reasoning });
        break;
      }

      case "usage":
        if (event.usage) {
          ctx.iterationUsage = { ...event.usage };
          ctx.responseGenerationLimit.finalResponseOutputTokens = event.usage.outputTokens;
          ctx.iterationUsageMetadata = (event as { metadata?: Record<string, unknown> }).metadata;
          ctx.totalUsage.inputTokens += event.usage.inputTokens;
          ctx.totalUsage.outputTokens += event.usage.outputTokens;
          ctx.totalUsage.totalTokens += event.usage.totalTokens;

          // Learn from real provider-reported per-call input. Skip:
          // - self-measured char estimates (would train the model on itself)
          // - claude-cli (stream usage is cumulative / not a clean per-call actual)
          // - zero/empty usage and already-consumed preflight pairs
          const usageMeta = (event as { metadata?: Record<string, unknown> }).metadata;
          const tokenAccounting = (usageMeta?.tokenAccounting ?? null) as Record<string, unknown> | null;
          const selfMeasured = tokenAccounting?.contextTokenSource === "self_measured_chars";
          const provider = ctx.resolvedProvider || ctx.routingDecision?.provider || "";
          const isCli = provider === "claude-cli";
          if (
            !selfMeasured
            && !isCli
            && ctx.preflightRawEstimateTokens >= 500
            && event.usage.inputTokens >= 500
          ) {
            const raw = ctx.preflightRawEstimateTokens;
            const actual = event.usage.inputTokens;
            // Consume the pair so a second usage event in the same iteration
            // cannot double-train on the same preflight.
            ctx.preflightRawEstimateTokens = 0;
            void recordTokenEstimateCalibration(
              ctx.resolvedModel || ctx.modelString,
              raw,
              actual,
            );
          }
        }
        if (event.model) {
          ctx.resolvedModel = event.model;
          const parts = ctx.modelString.split("/");
          ctx.resolvedProvider = parts.length >= 2 ? parts[0] : "openai";
        }
        if ("stopReason" in event && typeof event.stopReason === "string") {
          ctx.iterationStopReason = event.stopReason;
        }
        break;

      case "tool_call_resolved": {
        this.markFirstResponseOutput(ctx, options, "tool");
        if (ctx.thinkingStepActive) {
          ctx.thinkingStepActive = false;
          ctx.publish("system_step", { step: "thinking", status: "done" });
        }
        const toolCallId = event.toolCallId || generateToolCallId();
        const normalizedName = normalizeMcpToolName(event.toolName) || "unknown";
        log.verbose(() => `tool_call_resolved id=${toolCallId} name=${normalizedName} iteration=${ctx.iteration} mode=${ctx.executionMode}`);
        // Auto-hydrate detection: the model called an authority-allowed tool that
        // the persona pre-load heuristic did not hydrate. It still executed in-turn
        // via the stub (the bridge resolves any authority tool by name); flag it for
        // performance tracking and queue its real schema for hydration so the rest
        // of the turn is fully typed. This must never break an otherwise good turn.
        if (
          !ctx.autohydratedToolNames.has(normalizedName) &&
          options.authorityStubTools?.some((t) => t.name === normalizedName) &&
          !(options.tools || []).some((t) => t.name === normalizedName)
        ) {
          ctx.autohydratePending.add(normalizedName);
          eventBus.publish({
            category: "agent",
            event: "agent.tool_autohydrate",
            payload: { toolName: normalizedName, runId: ctx.runId, iteration: ctx.iteration, source: options.activity || "agent" },
            runId: ctx.runId,
            sessionKey: options.sessionKey,
          });
          log.warn(`autohydrate: un-hydrated authority tool "${normalizedName}" called directly runId=${ctx.runId} iteration=${ctx.iteration} — executed in-turn, hydrating real schema for subsequent calls`);
        }
        if (ctx.executionMode === "sdk_owned") {
          // SDK owns execution — route directly to resolvedToolCalls for persistence.
          // Do NOT push to pendingToolCalls. This is the structural fix: SDK-handled
          // tools never enter the pending list, so the post-stream executor has
          // nothing to execute. No filter needed.
          log.verbose(() => `[ToolExec] mode=sdk_owned tool=${normalizedName} id=${toolCallId} → tracked (SDK handled, skipping pendingToolCalls)`);
          if (event.arguments) {
            ctx.toolCallArgsCache.set(toolCallId, event.arguments as Record<string, unknown>);
          }
          // Clean up entry pushed by tool_use_start (which fires before resolved and pushes unconditionally)
          const pidx = ctx.pendingToolCalls.findIndex(tc => tc.id === toolCallId);
          if (pidx >= 0) ctx.pendingToolCalls.splice(pidx, 1);
        } else {
          // executor_owned mode should not receive tool_call_resolved — log as unexpected
          log.error(
            "executor.unexpected_tool_resolved",
            attributableExecutorError(
              `mode=executor_owned received tool_call_resolved id=${toolCallId} name=${normalizedName}`,
              "EXECUTOR_UNEXPECTED_TOOL_RESOLVED",
            ),
            { operation: "tool_call_resolved", toolCallId, toolName: normalizedName },
          );
          ctx.pendingToolCalls.push({ id: toolCallId, name: normalizedName, input: event.arguments || {} });
        }
        if (!ctx.iterationToolCalls.some((call) => call.id === toolCallId)) {
          ctx.iterationToolCalls.push({
            id: toolCallId,
            name: normalizedName,
            args: (event.arguments || {}) as Record<string, unknown>,
            order: ctx.iterationToolCalls.length,
          });
        }
        // Mark as SDK-handled for backwards-compat (safety net during soak period)
        ctx.sdkHandledToolIds.add(toolCallId);
        // Flush chronology buffers so thinking/content before this tool call gets its own segment
        this.flushChronologyThinking(ctx);
        this.flushChronologyContent(ctx);
        ctx.publish("tool_call", { toolName: normalizedName, toolCallId, arguments: event.arguments, parentId: `system-llm_call-model-${ctx.runId}-${ctx.iteration}` });
        ctx.activeToolUseSteps.set(toolCallId, Date.now());
        ctx.publish("system_step", { step: "tool_use", status: "started", detail: normalizedName || "unknown", stepId: toolCallId, parentId: `tool-${toolCallId}` });
        eventBus.publish({
          category: "tool",
          event: "agent.tool_call",
          payload: { toolName: normalizedName, toolCallId, arguments: event.arguments, runId: ctx.runId, source: options.activity || "agent", resolvedBySdk: true },
          runId: ctx.runId,
          sessionKey: options.sessionKey,
        });
        break;
      }

      case "tool_result_resolved": {
        const toolCallId = event.toolCallId;
        const normalizedName = normalizeMcpToolName(event.toolName);
        log.verbose(() => `tool_result_resolved id=${toolCallId} name=${normalizedName} error=${!!event.error} resultLen=${event.result?.length || 0} (SDK handled)`);
        // Look up actual arguments from pendingToolCalls (executor_owned) or args cache (sdk_owned)
        const matchingCall = ctx.pendingToolCalls.find(tc => tc.id === toolCallId);
        const cachedArgs = ctx.toolCallArgsCache.get(toolCallId || "");
        if (toolCallId) ctx.toolCallArgsCache.delete(toolCallId);
        const toolIdx = ctx.resolvedToolCalls.length;
        const resolvedArgs = matchingCall?.input || cachedArgs || event.arguments || {};
        this.recordToolOutcome({
          ctx,
          options,
          id: toolCallId,
          name: normalizedName || event.toolName,
          input: resolvedArgs,
          result: event.result,
          providerResult: event.providerResult,
          outcome: event.outcome ?? (event.error ? "failed" : "succeeded"),
          durationMs: event.durationMs ?? 0,
          failure: event.failure,
          failureKind: resolvedToolFailureKind(event),
          failureCode:
            typeof event.failure?.code === "string"
              ? event.failure.code
              : typeof event.failureCode === "string"
                ? event.failureCode
                : undefined,
          recoveryDecision: event.recoveryDecision,
        });
        if (toolCallId && !ctx.iterationToolCalls.some((call) => call.id === toolCallId)) {
          ctx.iterationToolCalls.push({
            id: toolCallId,
            name: normalizedName || event.toolName,
            args: resolvedArgs,
            order: event.order ?? ctx.iterationToolCalls.length,
          });
        }
        if (event.continuation === "persona_switch" && toolCallId) {
          ctx.personaSwitchRequested = { toolCallId };
        }
        if (event.continuation === "tool_schema_refresh" && toolCallId) {
          const requestedTool = typeof resolvedArgs.tool === "string" ? resolvedArgs.tool.trim() : "";
          if (requestedTool) {
            ctx.toolSchemaRefreshRequested = { toolCallId, toolName: requestedTool };
          }
        }
        if ((event.continuation === "await_user" || event.continuation === "provider_system_tool") && toolCallId) {
          ctx.awaitUserRequested = { toolCallId };
        }
        if (event.continuation === "session_complete" && toolCallId) {
          ctx.sessionCompleteRequested = { toolCallId };
        }
        // Chronology: record tool entry pointing to resolvedToolCalls index
        ctx.segmentChronology.push({ s: "tool", i: toolIdx });
        ctx.publish("tool_result", {
          toolCallId,
          toolName: normalizedName,
          arguments: resolvedArgs,
          result: event.result,
          error: event.error ? event.result : undefined,
          // SSOT: accept failure.kind or flattened failureKind from dispatch.
          failureKind: resolvedToolFailureKind(event),
          ...(event.failure?.code
            ? { failureCode: event.failure.code }
            : typeof event.failureCode === "string" && event.failureCode.trim()
              ? { failureCode: event.failureCode.trim() }
              : {}),
        });
        const toolStepStartResolved = ctx.activeToolUseSteps.get(toolCallId || "");
        if (toolStepStartResolved && toolCallId) {
          ctx.activeToolUseSteps.delete(toolCallId);
          ctx.publish("system_step", { step: "tool_use", status: event.error ? "error" : "done", elapsedMs: Date.now() - toolStepStartResolved, detail: normalizedName || event.toolName, stepId: toolCallId });
        }
        eventBus.publish({
          category: "tool",
          event: "agent.tool_result",
          payload: { toolCallId, toolName: normalizedName, arguments: resolvedArgs, result: event.result, error: event.error, runId: ctx.runId, source: options.activity || "agent", resolvedBySdk: true },
          runId: ctx.runId,
          sessionKey: options.sessionKey,
        });
        if (event.recoveryDecision === "quarantined" && event.failure) {
          const toolName = normalizedName || event.toolName;
          // Permission quarantine is run-terminal (authority cannot be restored).
          // Input quarantine (e.g. shell_policy_denied exact-repeat) is operation-local:
          // refuse the repeat, keep the model stream so the agent can pivot.
          if (event.failure.kind === "permission") {
            ctx.terminalToolFailure ??= {
              toolName,
              result: event.result,
              failure: event.failure,
            };
            log.warn(`[ToolRecovery] sdk failure quarantined runId=${ctx.runId} tool=${toolName} code=${event.failure.code} resource=${event.failure.resourceKey ?? "unknown"}`);
          } else {
            log.warn(`[ToolRecovery] sdk operation quarantined (non-terminal) runId=${ctx.runId} tool=${toolName} kind=${event.failure.kind} code=${event.failure.code} resource=${event.failure.resourceKey ?? "unknown"}`);
          }
        }
        break;
      }

      case "error": {
        ctx.lastError = event.error || ctx.lastError || "Stream error";
        ctx.providerFailure = event.providerFailure || ctx.providerFailure;
        const streamError = event.providerFailure
          ? new ModelProviderError(event.providerFailure)
          : new Error(ctx.lastError);
        if (!isContextLengthError(streamError)) {
          ctx.publish("error", { error: ctx.lastError, providerFailure: ctx.providerFailure });
        }
        throw streamError;
      }
    }
  }

  private async executeToolWithRecovery(
    ctx: RunIterationContext,
    name: string,
    args: Record<string, unknown>,
    execute: () => Promise<ToolExecutorResult>,
  ): Promise<ToolExecutorResult> {
    const normalizedName = normalizeMcpToolName(name) || name;
    if (ctx.budgets.toolCallsUsed >= ctx.budgets.maxToolCalls) {
      ctx.budgetExhaustion ??= {
        kind: "tool_calls",
        limit: ctx.budgets.maxToolCalls,
        used: ctx.budgets.toolCallsUsed,
      };
      log.warn(
        `agent.loop.budget_exhausted runId=${ctx.runId} kind=tool_calls ` +
        `limit=${ctx.budgets.maxToolCalls} used=${ctx.budgets.toolCallsUsed} deniedTool=${normalizedName}`,
      );
      return {
        result: `Tool execution budget exhausted after ${ctx.budgets.toolCallsUsed} calls. No additional tool was executed.`,
        error: true,
        outcome: "cancelled",
        recoveryDecision: "none",
      };
    }
    ctx.budgets.toolCallsUsed++;
    const result = await ctx.operationRecovery.execute(ctx.runId, normalizedName, args, execute);
    if (result.recoveryDecision === "quarantined" && result.failure) {
      // Permission quarantine is run-terminal (authority cannot be restored).
      // Input quarantine (e.g. shell_policy_denied exact-repeat) is operation-local:
      // refuse the repeat, keep the model stream so the agent can pivot.
      if (result.failure.kind === "permission") {
        ctx.terminalToolFailure ??= {
          toolName: normalizedName,
          result: result.result,
          failure: result.failure,
        };
        log.warn(`[ToolRecovery] quarantined runId=${ctx.runId} tool=${normalizedName} code=${result.failure.code} resource=${result.failure.resourceKey ?? "unknown"}`);
      } else {
        log.warn(`[ToolRecovery] operation quarantined (non-terminal) runId=${ctx.runId} tool=${normalizedName} kind=${result.failure.kind} code=${result.failure.code} resource=${result.failure.resourceKey ?? "unknown"}`);
      }
    } else if (result.recoveryDecision === "read_required") {
      log.warn(`[ToolRecovery] read-required runId=${ctx.runId} tool=${normalizedName} code=${result.failure?.code ?? "unknown"}`);
    }
    return result;
  }

  private async executeToolCalls(
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    ctx: RunIterationContext,
    options: ExecutorRunOptions,
    messages: ExecutorMessage[],
    cleanText: string,
  ): Promise<{ toolResults: ContentBlock[]; continuation?: ToolExecutorResult["continuation"] }> {
    const assistantContent: ContentBlock[] = [];
    if (ctx.iterationThinking) {
      assistantContent.push({ type: "thinking", thinking: ctx.iterationThinking });
    }
    if (cleanText) {
      assistantContent.push({ type: "text", text: cleanText });
    }
    for (const tc of toolCalls) {
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    messages.push({ role: "assistant", content: assistantContent });

    const toolResults: ContentBlock[] = [];
    log.verbose(() => `Executing ${toolCalls.length} tool calls for iteration ${ctx.iteration}: ${toolCalls.map(tc => `${tc.name}(${tc.id})`).join(", ")}`);

    const WRITE_TOOLS = new Set([
      "write_scratch", "edit_scratch", "write_file", "delete_file", "create_directory",
      "send_email", "send_message", "tasks", "update_task", "complete_task", "delete_task",
      "set_goal", "update_goal", "delete_goal",
      "store_memory", "update_memory", "delete_memory",
      "set_belief", "update_belief",
      "scenarios",
    ]);

    const UMBRELLA_WRITE_ACTIONS: Record<string, Set<string>> = {
      scratch: new Set(["write", "edit"]),
      files: new Set(["write"]),
      memory: new Set(["write"]),
      docx: new Set(["write", "edit", "clone"]),
      meetings: new Set(["add", "update", "delete"]),
      stories: new Set(["capture", "update", "supersede", "delete"]),
      capabilities: new Set(["create", "update", "delete", "audit", "sync", "record_validation", "link_story", "unlink_story"]),
    };

    const getResourceTarget = (tc: { name: string; input: Record<string, unknown> }): string | null => {
      const input = tc.input;
      const pathArg = input.path || input.filePath || input.file_path || input.fileName || input.file_name || input.name;
      if (typeof pathArg === "string") return `file:${pathArg}`;

      const idArg = input.id || input.eventId || input.event_id || input.goalId || input.goal_id || input.taskId || input.task_id;
      if (typeof idArg === "string") return `entity:${tc.name.split("_")[0]}:${idArg}`;

      return null;
    };

    const isWriteTool = (tc: { name: string; input: Record<string, unknown> }): boolean => {
      if (WRITE_TOOLS.has(tc.name)) return true;
      const umbrellaWriteSet = UMBRELLA_WRITE_ACTIONS[tc.name];
      if (umbrellaWriteSet && typeof tc.input.action === "string") {
        return umbrellaWriteSet.has(tc.input.action);
      }
      const actionArg = tc.input.action;
      if (typeof actionArg === "string") {
        const writePatterns = ["create", "update", "delete", "set", "add", "remove", "write", "edit", "send", "post"];
        if (writePatterns.some(wp => (actionArg as string).toLowerCase().includes(wp))) return true;
      }
      return false;
    };

    type ToolBatch = { concurrent: boolean; tools: typeof toolCalls };
    const batches: ToolBatch[] = [];
    let currentReadBatch: typeof toolCalls = [];
    const mutatedResources = new Set<string>();

    const flushReadBatch = () => {
      if (currentReadBatch.length > 0) {
        batches.push({ concurrent: true, tools: currentReadBatch });
        currentReadBatch = [];
      }
    };

    for (const tc of toolCalls) {
      const target = getResourceTarget(tc);
      const isWrite = isWriteTool(tc);

      if (isWrite) {
        flushReadBatch();
        batches.push({ concurrent: false, tools: [tc] });
        if (target) mutatedResources.add(target);
        log.verbose(() => `Mutating tool "${tc.name}" → serial${target ? ` (resource=${target})` : ""}`);
      } else if (target && mutatedResources.has(target)) {
        flushReadBatch();
        batches.push({ concurrent: false, tools: [tc] });
        log.verbose(() => `Read tool "${tc.name}" on mutated resource="${target}" → serial`);
      } else {
        currentReadBatch.push(tc);
      }
    }
    flushReadBatch();

    const concurrentCount = batches.filter(b => b.concurrent).reduce((n, b) => n + b.tools.length, 0);
    const serialCount = batches.filter(b => !b.concurrent).reduce((n, b) => n + b.tools.length, 0);
    const executionMode = serialCount > 0 && concurrentCount > 0
      ? "mixed" : serialCount > 0 ? "serial" : "concurrent";
    log.verbose(() => `Tool execution plan: mode=${executionMode} batches=${batches.length} concurrent=${concurrentCount} serial=${serialCount}`);

    const executeOne = async (tc: typeof toolCalls[0]) => {
      pushExecTrace(ctx, "tool:start", `${tc.name}#${tc.id}`);
      eventBus.publish({
        category: "tool",
        event: "agent.tool_call",
        payload: { toolName: tc.name, toolCallId: tc.id, arguments: tc.input, runId: ctx.runId, source: options.activity || "agent" },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });

      const toolStart = Date.now();
      const markRunToolActivity = () => {
        const runEntry = this.activeRuns.get(ctx.runId);
        if (runEntry) runEntry.lastActivityAt = Date.now();
      };
      markRunToolActivity();
      const toolHeartbeat = setInterval(markRunToolActivity, 30_000);
      if (toolHeartbeat.unref) toolHeartbeat.unref();
      // Task #1007 step 4: edge-triggered dispatch-gap warn. The
      // tool_use_received timestamp was captured when the model stream
      // surfaced this call; if more than DISPATCH_GAP_WARN_MS elapsed
      // before we got here, the main thread was wedged on something
      // between stream-end and tool dispatch (the exact pattern that
      // hid in bootId=molg5r37-3wwh, where two parallel shell calls
      // received tool_use but never produced "Tool starting" until the
      // watchdog SIGKILL'd the process). One-shot per call, no polling.
      const receivedAt = ctx.toolUseReceivedAt.get(tc.id);
      if (receivedAt !== undefined) {
        const waitedMs = toolStart - receivedAt;
        ctx.toolUseReceivedAt.delete(tc.id);
        if (waitedMs > 2000) {
          log.warn(`[Executor] dispatch slow callId=${tc.id} name=${tc.name} waitedMs=${waitedMs}`);
        }
        eventBus.publish({
          category: "agent",
          event: "agent.stage_timing",
          payload: {
            runId: ctx.runId,
            sessionId: options.sessionId || null,
            iteration: ctx.iteration,
            stage: "tool_dispatch",
            outcome: waitedMs > 2000 ? "degraded" : "succeeded",
            durationMs: waitedMs,
            toolCallId: tc.id,
            toolName: tc.name,
            source: options.activity || "agent",
          },
          runId: ctx.runId,
          sessionKey: options.sessionKey,
        });
      }
      log.verbose(() => `Tool "${tc.name}" starting id=${tc.id} inputKeys=${Object.keys(tc.input).join(",") || "none"} runId=${ctx.runId}`);
      let toolResult: ToolExecutorResult;
      try {
        toolResult = await this.executeToolWithRecovery(ctx, tc.name, tc.input, async () => {
          if (toolTransfersExecutionToChild(tc.name, tc.input)) {
            if (options.capacityOwner?.kind === "runtime" && toolRequiresNestedRuntimeScheduler(tc.name, tc.input)) {
              throw new Error("Native Runtime handlers cannot transfer execution into a nested scheduler");
            }
            const { admissionController } = await import("./run-admission");
            return admissionController.withSuspendedSlot(ctx.runId, () => options.toolExecutor!(tc.name, tc.input));
          }
          return options.toolExecutor!(tc.name, tc.input);
        });
      } catch (err: unknown) {
        // Mirror bridge-tools catch: explicit ToolFailure first, then
        // phrase inference so predictable throws render amber, not red.
        const thrownFailure = toolFailureFromError(err);
        const errMessage = err instanceof Error ? err.message : String(err);
        const thrownKind =
          resolvedToolFailureKind(thrownFailure, err) ??
          (inferFailureKind(errMessage) ?? undefined);
        toolResult = {
          result: `Tool execution error: ${errMessage}`,
          error: true,
          outcome: "failed",
          ...(thrownFailure ? { failure: thrownFailure } : {}),
          ...(thrownKind ? { failureKind: thrownKind } : {}),
        };
      } finally {
        clearInterval(toolHeartbeat);
        markRunToolActivity();
      }

      // Tool handlers are dynamically registered and can violate the compile-time
      // ToolExecutorResult contract. Normalize once at the executor boundary so
      // persistence, streaming, and provider delivery share one canonical string
      // representation instead of crashing on structured data.
      const rawToolResult = toolResult as ToolExecutorResult & {
        result: unknown;
        providerResult?: unknown;
      };
      if (typeof rawToolResult.result !== "string") {
        log.warn(
          `Tool "${tc.name}" returned non-string result; normalized type=${rawToolResult.result === null ? "null" : typeof rawToolResult.result}`,
        );
        toolResult.result = rawToolResult.result == null ? "" : safeStringify(rawToolResult.result);
      }
      if (rawToolResult.providerResult !== undefined && typeof rawToolResult.providerResult !== "string") {
        log.warn(
          `Tool "${tc.name}" returned non-string providerResult; normalized type=${rawToolResult.providerResult === null ? "null" : typeof rawToolResult.providerResult}`,
        );
        toolResult.providerResult = rawToolResult.providerResult == null ? "" : safeStringify(rawToolResult.providerResult);
      }

      const durationMs = Date.now() - toolStart;
      log.verbose(() => `Tool "${tc.name}" completed in ${durationMs}ms error=${!!toolResult.error} sideEffectOnly=${!!toolResult.sideEffectOnly} resultLen=${toolResult.result.length}`);

      return { tc, toolResult, durationMs };
    };

    let continuation: ToolExecutorResult["continuation"];

    const processResult = async (tc: typeof toolCalls[0], toolResult: ToolExecutorResult, durationMs: number) => {
      const canonicalArgs = toolResult.normalizedArguments ?? tc.input;
      await archiveLargeToolOutput({
        toolName: tc.name,
        action: typeof canonicalArgs.action === "string" ? canonicalArgs.action : undefined,
        toolCallId: tc.id,
        result: toolResult.result,
        error: toolResult.error,
        sessionId: options.sessionId,
        runId: ctx.runId,
      });
      const toolIdx = ctx.resolvedToolCalls.length;
      const resultTokens = estimateToolOutputSize(toolResult.result).estimatedTokens;
      this.emitContextGrowthCanary({
        ctx,
        options,
        boundary: "tool_result_reinjection",
        messageTokens: estimateTotalTokens(messages) + resultTokens,
        toolResultTokens: resultTokens,
        // getContextRequestBudget expects a numeric context window, not a model id.
        // Passing modelString coerced through boundedTokenCount and permanently emitted budgetTokens:0.
        budgetTokens: getContextRequestBudget(getContextWindow(ctx.modelString)).hardInputLimit,
        toolCallId: tc.id,
        toolName: tc.name,
      });
      this.recordToolOutcome({
        ctx,
        options,
        id: tc.id,
        name: tc.name,
        input: canonicalArgs,
        result: toolResult.result,
        providerResult: toolResult.result,
        outcome: toolResult.outcome ?? (toolResult.error ? "failed" : "succeeded"),
        durationMs,
        failure: toolResult.failure,
        failureKind: resolvedToolFailureKind(toolResult),
        failureCode:
          typeof toolResult.failure?.code === "string"
            ? toolResult.failure.code
            : typeof toolResult.failureCode === "string"
              ? toolResult.failureCode
              : undefined,
        recoveryDecision: toolResult.recoveryDecision,
      });
      // Chronology: record tool entry pointing to resolvedToolCalls index
      ctx.segmentChronology.push({ s: "tool", i: toolIdx });
      continuation = toolResult.continuation || continuation;

      ctx.publish("tool_result", {
        toolCallId: tc.id,
        toolName: tc.name,
        arguments: canonicalArgs,
        result: toolResult.result,
        error: toolResult.error ? toolResult.result : undefined,
        // SSOT: accept failure.kind or flattened failureKind from dispatch.
        failureKind: resolvedToolFailureKind(toolResult),
        ...(toolResult.failure?.code
          ? { failureCode: toolResult.failure.code }
          : typeof toolResult.failureCode === "string" &&
              toolResult.failureCode.trim()
            ? { failureCode: toolResult.failureCode.trim() }
            : {}),
      });
      const toolStepStart = ctx.activeToolUseSteps.get(tc.id);
      if (toolStepStart) {
        ctx.activeToolUseSteps.delete(tc.id);
        ctx.publish("system_step", { step: "tool_use", status: toolResult.error ? "error" : "done", elapsedMs: Date.now() - toolStepStart, detail: tc.name, stepId: tc.id });
      }
      eventBus.publish({
        category: "tool",
        event: "agent.tool_result",
        payload: { toolCallId: tc.id, toolName: tc.name, arguments: canonicalArgs, result: toolResult.result, error: toolResult.error, runId: ctx.runId, source: options.activity || "agent" },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });

      return { type: "tool_result" as const, tool_use_id: tc.id, content: toolResult.result, is_error: toolResult.error };
    };

    const toolExecLimit = pLimit(4);
    for (const batch of batches) {
      if (batch.concurrent && batch.tools.length > 1) {
        const results = await Promise.all(batch.tools.map(tc =>
          toolExecLimit(() => withQueryAttributionAsync(options.querySubsystem || "tool-exec", () => executeOne(tc), `tool:${tc.name}`))
        ));
        for (const { tc, toolResult, durationMs } of results) {
          toolResults.push(await processResult(tc, toolResult, durationMs));
        }
      } else {
        for (const tc of batch.tools) {
          const { toolResult, durationMs } = await withQueryAttributionAsync(options.querySubsystem || "tool-exec", () => executeOne(tc), `tool:${tc.name}`);
          toolResults.push(await processResult(tc, toolResult, durationMs));
        }
      }
    }

    return { toolResults, continuation };
  }

  // Inference recording is handled at the model-client boundary (recordInference)
  // which fires inside chatCompletionStream/chatCompletion. This method previously
  // called logApiCall a second time, causing every streaming call to be recorded
  // twice with different session_keys and profiles — inflating token counts by ~32%.
  // The boundary recording now receives sessionKey via InferenceMetadata, so the
  // correct session grouping is preserved without a duplicate write.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private logIterationCost(
    _messages: ExecutorMessage[],
    _iterationText: string,
    _ctx: RunIterationContext,
    _options: ExecutorRunOptions,
    _iterStartTime: number,
    _abortController: AbortController,
  ): void {
    // No-op: boundary tracking in model-client.ts handles inference recording.
  }

  private recordToolOutcome(args: {
    ctx: RunIterationContext;
    options: ExecutorRunOptions;
    id: string;
    name: string;
    input: Record<string, unknown>;
    result: string;
    providerResult?: string;
    outcome: ToolOutcome;
    durationMs: number;
    failure?: ToolFailure;
    /** Flattened kind from bridge inference when failure.kind was absent. */
    failureKind?: ToolFailureKind;
    /** Flattened code from stream/dispatch when failure.code was absent. */
    failureCode?: string;
    recoveryDecision?: ToolRecoveryDecision;
  }): void {
    const {
      ctx, options, id, name, input, result, outcome, durationMs, failure, recoveryDecision,
      providerResult, failureKind: flattenedFailureKind, failureCode: flattenedFailureCode,
    } = args;
    const error = outcome === "failed" || outcome === "cancelled";
    // Prefer structured failure; also accept flattened kind from dispatch.
    // Last resort: phrase-match the tool result text so residual uncoded
    // handler strings still carry a kind before aggregate projection.
    const failureKind =
      resolvedToolFailureKind(failure, { failureKind: flattenedFailureKind }) ??
      (error ? inferFailureKind(result) ?? undefined : undefined);
    const failureCode = error
      ? resolveToolOutcomeFailureCode({
          failure,
          failureKind,
          flattenedCode: flattenedFailureCode,
          toolName: name,
        })
      : failure?.code ?? flattenedFailureCode;
    ctx.resolvedToolCalls.push({
      id,
      name,
      args: input,
      result,
      ...(providerResult !== undefined ? { providerResult } : {}),
      outcome,
      error: error || undefined,
      ...(failureKind ? { failureKind } : {}),
      ...(failureCode ? { failureCode } : {}),
      durationMs,
      parentId: `system-llm_call-model-${ctx.runId}-${ctx.iteration}`,
    });

    // One discriminant per decision: surface ToolFailure fields on the outcome log so
    // deterministic denials (shell policy, scratch edit) are diagnosable without re-running.
    // Failed outcomes always carry failureCode so privacy-safe aggregates classify
    // even when session/run ids poison message-token fallback.
    const metadata: Record<string, unknown> = {
      runId: ctx.runId,
      sessionId: options.sessionId,
      toolCallId: id,
      toolName: name,
      outcome,
      durationMs,
      iteration: ctx.iteration,
      executionMode: ctx.executionMode,
    };
    if (failureKind) metadata.failureKind = failureKind;
    if (failureCode) metadata.failureCode = failureCode;
    if (failure?.detail) metadata.failureDetail = failure.detail;
    if (failure?.resourceKey) metadata.resourceKey = failure.resourceKey;
    if (recoveryDecision) metadata.recoveryDecision = recoveryDecision;
    if (outcome === "failed" || outcome === "cancelled") {
      // Prefer the handler's machine code; fall back to kind-derived synthetic codes.
      const outcomeCode = toExecutorErrorCode(failureCode, "EXECUTOR_TOOL_OUTCOME_FAILED");
      const outcomeError = attributableExecutorError(
        `tool=${name} outcome=${outcome}${failureCode ? ` code=${failureCode}` : ""}`,
        outcomeCode,
      );
      // Amber classes (permission/input/transient) are expected caller/policy
      // outcomes — keep them observable at warn without polluting product-error
      // aggregates (log.error → application_error_aggregates). Only internal
      // defects and unclassified failures remain product errors.
      const isAmberOutcome =
        failureKind === "permission" ||
        failureKind === "input" ||
        failureKind === "transient";
      if (isAmberOutcome) {
        log.warn("agent.tool_outcome", outcomeError, metadata);
      } else {
        log.error("agent.tool_outcome", outcomeError, metadata);
      }
    } else if (outcome === "degraded") {
      log.warn("agent.tool_outcome", metadata);
    } else {
      log.debug("agent.tool_outcome", metadata);
    }
    eventBus.publish({
      category: "agent",
      event: "agent.stage_timing",
      payload: {
        ...metadata,
        stage: "tool_execution",
      },
      runId: ctx.runId,
      sessionKey: options.sessionKey,
    });
  }

  private emitContextGrowthCanary(args: {
    ctx: RunIterationContext;
    options: ExecutorRunOptions;
    boundary: "tool_result_reinjection" | "pre_inference";
    messageTokens: number;
    toolResultTokens: number;
    budgetTokens: number;
    toolCallId?: string;
    toolName?: string;
  }): void {
    const { ctx, options, boundary, messageTokens, toolResultTokens, budgetTokens, toolCallId, toolName } = args;
    const ratio = budgetTokens > 0 ? messageTokens / budgetTokens : 0;
    const event = {
      event: "agent.context_growth_canary",
      runId: ctx.runId,
      sessionId: options.sessionId,
      iteration: ctx.iteration,
      boundary,
      messageTokens,
      toolResultTokens,
      budgetTokens,
      ratio: Number(ratio.toFixed(4)),
      toolCallId,
      toolName,
    };
    if (messageTokens > budgetTokens) {
      log.warn("agent.context_growth_canary", event);
    } else {
      log.debug("agent.context_growth_canary", event);
    }
  }

  // Drain the run's owned background work — pending cost-log inserts and any
  // adapter-spawned cleanup chains — before releasing the admission slot. Bounded
  // by POST_ABORT_DRAIN_GRACE_MS so a hung CLI subprocess can't pin the slot
  // forever. A single structured warn line is emitted on grace expiry so
  // production can correlate residual zombie counts to specific runs.
  private async drainBackgroundWork(ctx: RunIterationContext, runId: string, startTime: number): Promise<void> {
    const all: Promise<void>[] = [...ctx.pendingCostLogs, ...ctx.backgroundWork];
    if (all.length === 0) return;
    const elapsedSinceStart = Date.now() - startTime;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">(resolve => {
      timer = setTimeout(() => resolve("timeout"), POST_ABORT_DRAIN_GRACE_MS);
    });
    const settled = Promise.allSettled(all).then(() => "settled" as const);
    try {
      const outcome = await Promise.race([settled, deadline]);
      if (outcome === "timeout") {
        log.error(
          "executor.post_abort_drain_timeout",
          attributableExecutorError(
            `post-abort drain timeout pendingCostLogs=${ctx.pendingCostLogs.length} backgroundWork=${ctx.backgroundWork.size} elapsedSinceStart=${elapsedSinceStart}ms graceMs=${POST_ABORT_DRAIN_GRACE_MS}`,
            "EXECUTOR_POST_ABORT_DRAIN_TIMEOUT",
          ),
          {
            operation: "post_abort_drain",
            runId,
            pendingCostLogs: ctx.pendingCostLogs.length,
            backgroundWork: ctx.backgroundWork.size,
            elapsedSinceStartMs: elapsedSinceStart,
            graceMs: POST_ABORT_DRAIN_GRACE_MS,
          },
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private registerBackgroundWork(ctx: RunIterationContext, p: Promise<void>): void {
    // Wrap so the registry self-cleans on settle, and we never let a rejection
    // escape as an unhandled rejection (it has already been logged at source).
    const wrapped: Promise<void> = p.then(
      () => undefined,
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`backgroundWork rejected runId=${ctx.runId}: ${msg}`);
      },
    );
    ctx.backgroundWork.add(wrapped);
    wrapped.finally(() => ctx.backgroundWork.delete(wrapped));
  }

  private synthesizeToolFailureRecovery(ctx: RunIterationContext): string {
    const terminal = ctx.terminalToolFailure;
    if (!terminal) return ctx.allText.join("");

    const completedCount = ctx.resolvedToolCalls.filter((call) => call.outcome === "succeeded").length;
    const completedSentence = completedCount > 0
      ? `I preserved the work completed before the failure (${completedCount} successful tool operation${completedCount === 1 ? "" : "s"}).`
      : "No completed operation was discarded.";
    const detail = terminal.result.trim().replace(/\s+/g, " ");
    const boundedDetail = detail.length > 600 ? `${detail.slice(0, 597)}...` : detail;

    return [
      completedSentence,
      `I stopped because ${terminal.toolName} returned a non-retryable ${terminal.failure.kind} failure (${terminal.failure.code}).`,
      boundedDetail ? `Unresolved operation: ${boundedDetail}` : "The unresolved operation requires corrected input or permission before it can continue.",
    ].join("\n\n");
  }

  private synthesizeBudgetExhaustion(ctx: RunIterationContext): string {
    const exhaustion = ctx.budgetExhaustion;
    if (!exhaustion) return ctx.allText.join("");
    const completedTools = ctx.resolvedToolCalls.filter((call) => call.outcome === "succeeded").length;
    const workSummary = completedTools > 0
      ? `I preserved ${completedTools} completed tool operation${completedTools === 1 ? "" : "s"}.`
      : "No completed operation was discarded.";
    const budgetLabel = exhaustion.kind === "iterations" ? "model-iteration" : "tool-call";
    return [
      workSummary,
      `I stopped after reaching this run's ${budgetLabel} budget (${exhaustion.used}/${exhaustion.limit}).`,
      "Send another message to continue from the saved state.",
    ].join("\n\n");
  }

  private preserveInterruptedProviderOutput(ctx: RunIterationContext): string {
    this.flushChronologyThinking(ctx);
    this.flushChronologyContent(ctx);
    const partialContent = ctx.segmentChronology
      .filter((entry): entry is Extract<SegmentChronologyEntry, { s: "content" }> => entry.s === "content")
      .map((entry) => entry.c)
      .join("");
    if (!partialContent.trim() || !ctx.providerFailure) return "";

    const marker = "\n\n[Response interrupted by the model provider. The partial response above was preserved.]";
    const preservedContent = `${partialContent}${marker}`;
    const lastContentIndex = ctx.segmentChronology.findLastIndex((entry) => entry.s === "content");
    if (lastContentIndex >= 0) {
      const entry = ctx.segmentChronology[lastContentIndex] as Extract<SegmentChronologyEntry, { s: "content" }>;
      ctx.segmentChronology[lastContentIndex] = { s: "content", c: `${entry.c}${marker}` };
    }
    ctx.publish("delta", { content: marker });
    log.warn("executor.provider_partial_output_preserved", {
      operation: "provider_partial_output_preserved",
      runId: ctx.runId,
      partialContentLength: partialContent.length,
      providerCode: ctx.providerFailure.providerCode,
    });
    return preservedContent;
  }

  private async publishRunResult(
    ctx: RunIterationContext,
    options: ExecutorRunOptions,
    startTime: number,
    finalContent: string,
    terminationReason: TerminationReason,
  ): Promise<ExecutorRunResult> {
    if (ctx.terminalToolFailure || ctx.budgetExhaustion) {
      finalContent = ctx.terminalToolFailure
        ? this.synthesizeToolFailureRecovery(ctx)
        : this.synthesizeBudgetExhaustion(ctx);
      terminationReason = "complete";
      ctx.aborted = false;
      ctx.abortReason = undefined;
      ctx.abortDetails = undefined;
      ctx.intentionallyAwaitingUser = false;
      ctx.lastError = undefined;
      ctx.allText = [finalContent];
      ctx.iterationText = finalContent;
      ctx.diagnosticLastAssistantVisibleTextLength = finalContent.trim().length;
      ctx.contentBuf = "";
      ctx.thinkingBuf = "";
      ctx.chronologyContentBuf = "";
      ctx.chronologyThinkingBuf = "";
      ctx.segmentChronology = [{ s: "content", c: finalContent }];
      ctx.publish("attempt_reset", {});
      ctx.publish("text_delta", { content: finalContent });
    }
    const allThinkingContent = ctx.allThinking.join("\n\n");

    // Flush pending chronology buffers
    this.flushChronologyThinking(ctx);
    this.flushChronologyContent(ctx);

    // Fallback: if no content entry exists in chronology but finalContent is non-empty, append one
    if (!ctx.segmentChronology.some(e => e.s === "content") && finalContent) {
      ctx.segmentChronology.push({ s: "content", c: finalContent });
    }

    // Compute cost and apiCallCount
    const { getModelCost } = await import("./model-registry");
    const costRates = getModelCost(ctx.resolvedModel);
    const turnCost = (ctx.totalUsage.inputTokens * costRates.input) + (ctx.totalUsage.outputTokens * costRates.output);
    const turnApiCallCount = ctx.iteration || 1;

    const lastStopReason = ctx.diagnosticLastModelStopReason;
    // Empty final text on a completed turn is never a clean success unless the
    // executor intentionally stopped to await the user (e.g. question widget)
    // or a successful session.end / set_status=saved completed the work without
    // requiring a closing narration (silent autonomous skills such as enrich-email).
    // Retries fire on last-turn empty (Grok/xAI empty end_turn after tools).
    // User-facing empty_response requires the whole run to lack visible
    // assistant text: intermediate tool narration already streamed and saved is
    // a completed response, not an unfinished turn. Only a fully blank body
    // after exhausted MAX_EMPTY_FINAL_TURN_RETRIES is degraded. Classify at the
    // producer so consumers key off one discriminant.
    const emptyCompletedResponse =
      !ctx.aborted &&
      terminationReason === "complete" &&
      ctx.diagnosticLastAssistantVisibleTextLength === 0 &&
      finalContent.trim().length === 0 &&
      !ctx.intentionallyAwaitingUser &&
      !ctx.intentionallyCompletedSession;
    if (
      !emptyCompletedResponse &&
      !ctx.aborted &&
      terminationReason === "complete" &&
      ctx.diagnosticLastAssistantVisibleTextLength === 0 &&
      finalContent.trim().length > 0 &&
      !ctx.intentionallyAwaitingUser &&
      !ctx.intentionallyCompletedSession
    ) {
      log.log(
        `agent.run.empty_final_accepted_with_prior_content runId=${ctx.runId} sessionId=${options.sessionId || "none"} ` +
        `contentLen=${finalContent.length} emptyFinalTurnRetries=${ctx.emptyFinalTurnRetries} model=${ctx.resolvedModel}`,
      );
    }
    const degradationReason: TerminalDegradationReason | undefined =
      ctx.terminalToolFailure
        ? "tool_failure_recovered"
        : ctx.budgetExhaustion?.kind === "iterations"
          ? "iteration_budget_exhausted"
          : ctx.budgetExhaustion?.kind === "tool_calls"
            ? "tool_call_budget_exhausted"
            : emptyCompletedResponse
              ? lastStopReason === "max_tokens"
                ? "empty_response_output_limit"
                : "empty_response"
              : undefined;
    const status: ExecutorRunResult["status"] =
      degradationReason ? "degraded"
      : terminationReason === "yield_to_interactive" ? "yielded"
      : terminationReason === "complete" ? "succeeded"
      : "failed";
    const childMissionOutcome: ChildMissionTerminalOutcome =
      degradationReason === "iteration_budget_exhausted" || degradationReason === "tool_call_budget_exhausted"
        ? "resumable_budget_exhausted"
        : status === "succeeded" && ctx.intentionallyCompletedSession
          ? "mission_completed"
          : status === "yielded" || (ctx.aborted && ctx.abortReason === "cancelled")
            ? "cancelled"
            : status === "failed"
              ? "failed"
              : "abandoned";

    log.log(`run complete runId=${ctx.runId} status=${status} childMissionOutcome=${childMissionOutcome} iterations=${ctx.iteration} terminationReason=${terminationReason} degradationReason=${degradationReason ?? "none"} thinkingLen=${allThinkingContent.length} toolCallsCount=${ctx.resolvedToolCalls.length} contentLen=${finalContent.length} model=${ctx.resolvedModel}`);
    if (degradationReason) {
      log.warn(`agent.run.degraded runId=${ctx.runId} sessionId=${options.sessionId || "none"} reason=${degradationReason} lastStopReason=${lastStopReason} iterations=${ctx.iteration} toolCallsCount=${ctx.resolvedToolCalls.length}`);
    }

    ctx.publish("done", {
      terminationReason,
      abortReason: ctx.abortReason,
      degradationReason,
      lastStopReason,
      iterationsUsed: ctx.iteration,
      messageId: ctx.runId ? `done:${ctx.runId}` : undefined,
    });

    const terminalDurationMs = Date.now() - startTime;
    const terminalDecision = {
      runId: ctx.runId,
      sessionId: options.sessionId || null,
      status,
      childMissionOutcome,
      reason: degradationReason ?? (ctx.aborted ? (ctx.abortReason ?? terminationReason) : terminationReason),
      iterations: ctx.iteration,
      durationMs: terminalDurationMs,
      lastStep: ctx.diagnosticLastStep || "terminal",
      lastStopReason: lastStopReason || null,
      lastToolCallId: ctx.diagnosticLastToolCallId || null,
      hadToolErrors: ctx.diagnosticHadToolErrors,
      failedToolCount: ctx.diagnosticFailedToolCount,
      assistantTextLength: finalContent.length,
      lastAssistantTextLength: ctx.diagnosticLastAssistantTextLength,
      lastAssistantVisibleTextLength: ctx.diagnosticLastAssistantVisibleTextLength,
      emptyFinalTurnRetries: ctx.emptyFinalTurnRetries,
      budgetExhaustion: ctx.budgetExhaustion ?? null,
      responseGenerationLimit: degradationReason === "empty_response_output_limit"
        ? ctx.responseGenerationLimit
        : null,
      toolCallsUsed: ctx.budgets.toolCallsUsed,
      maxToolCalls: ctx.budgets.maxToolCalls,
      maxIterations: ctx.budgets.maxIterations,
      finalMessageId: ctx.runId ? `done:${ctx.runId}` : null,
      source: options.activity || "agent",
    };
    log.log(`agent.run.terminal_decision ${safeStringify(terminalDecision, { maxBytes: 4096, label: "agent-executor.terminalDecision" })}`);
    eventBus.publish({
      category: "agent",
      event: "agent.run.terminal_decision",
      payload: terminalDecision,
      runId: ctx.runId,
      sessionKey: options.sessionKey,
    });
    if (terminalDecision.lastStep === "tool_batch" && terminationReason === "complete") {
      const elapsedSinceToolMs = ctx.diagnosticLastToolBatchCompletedAt ? Date.now() - ctx.diagnosticLastToolBatchCompletedAt : null;
      log.warn(`agent.run.completed_immediately_after_tools runId=${ctx.runId} sessionId=${options.sessionId || "none"} elapsedMsSinceLastToolResult=${elapsedSinceToolMs ?? "unknown"} assistantTextLengthAfterTools=${finalContent.length} hadToolErrors=${ctx.diagnosticHadToolErrors}`);
      eventBus.publish({
        category: "agent",
        event: "agent.run.completed_immediately_after_tools",
        payload: {
          runId: ctx.runId,
          sessionId: options.sessionId || null,
          elapsedMsSinceLastToolResult: elapsedSinceToolMs,
          assistantTextLengthAfterTools: finalContent.length,
          hadToolErrors: ctx.diagnosticHadToolErrors,
          failedToolCount: ctx.diagnosticFailedToolCount,
          source: options.activity || "agent",
        },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });
    }

    eventBus.publish({
      category: "agent",
      event: status === "degraded"
        ? "agent.run.degraded"
        : ctx.aborted
          ? "agent.run.aborted"
          : "agent.run.complete",
      payload: { ...terminalDecision, durationMs: terminalDurationMs },
      runId: ctx.runId,
      sessionKey: options.sessionKey,
    });

    return {
      status,
      childMissionOutcome,
      degradationReason,
      intentionalStopReason: ctx.intentionallyAwaitingUser
        ? "awaiting_user"
        : ctx.intentionallyCompletedSession
          ? "session_complete"
          : undefined,
      lastStopReason,
      content: finalContent,
      thinking: allThinkingContent,
      toolCalls: ctx.resolvedToolCalls,
      model: ctx.resolvedModel,
      provider: ctx.resolvedProvider,
      usage: ctx.totalUsage,
      responseGenerationLimit: degradationReason === "empty_response_output_limit"
        ? ctx.responseGenerationLimit
        : undefined,
      iterations: ctx.iteration,
      terminationReason,
      durationMs: Date.now() - startTime,
      aborted: ctx.aborted,
      abortReason: ctx.abortReason,
      abortDetails: ctx.abortDetails,
      error: ctx.lastError,
      providerFailure: ctx.providerFailure,
      streamDiagnostics: ctx.lastStreamDiagnostics,
      segmentChronology: ctx.segmentChronology.length > 0 ? ctx.segmentChronology : undefined,
      systemSteps: ctx.systemStepsData.length > 0 ? ctx.systemStepsData : undefined,
      cost: turnCost,
      apiCallCount: turnApiCallCount,
      runId: ctx.runId,
    };
  }

  private async initializeRun(options: ExecutorRunOptions): Promise<{
    runId: string;
    abortController: AbortController;
    startTime: number;
    modelString: string;
    maxTokens: number;
    /** Reserve value for getContextRequestBudget (explicit config or maxTokens). */
    outputReserveTokens: number;
    /** True when outputReserveTokens came from an explicit per-tier maxOutputTokens. */
    outputReserveIsExplicit: boolean;
    thinkingBudget: number;
    thinking: ResolvedThinking;
    routingTier: string;
    routingDecision: ModelRoutingDecision;
    ctx: RunIterationContext;
  }> {
    const runId = options.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const abortController = new AbortController();
    const startTime = Date.now();

    let requestContent: string | undefined;
    let objectiveHint: string | undefined;
    try {
      // Prefer the latest user text — used as supersession capsule objective/instruction.
      for (let i = (options.messages?.length || 0) - 1; i >= 0; i--) {
        const msg = options.messages![i];
        if (msg.role !== "user") continue;
        const text = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b: any) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
            : "";
        if (text.trim()) {
          requestContent = text.trim().slice(0, 4000);
          objectiveHint = text.trim().slice(0, 280);
          break;
        }
      }
      if (!requestContent) {
        const msgPreview = options.messages?.slice(-5) || [];
        requestContent = safeStringify(msgPreview, { maxBytes: 4 * 1024, label: "agent-executor.requestPreview" }).slice(0, 2000);
      }
    } catch (err) { log.warn("request content serialization failed", err); }
    this.activeRuns.set(runId, {
      abort: abortController,
      createdAt: startTime,
      admitted: false,
      sessionId: options.sessionId,
      model: undefined,
      activity: options.activity || ACTIVITY_CHAT,
      sessionKey: options.sessionKey,
      requestContent,
      objectiveHint,
      hasStartedActing: false,
      toolNames: [],
    });

    const activityForRouting = options.activity || ACTIVITY_CHAT;
    if (options.model && options.routingDecision) {
      throw new Error("AgentExecutor accepts either model or routingDecision, not both");
    }
    const sessionTierOverride = !options.model && !options.routingDecision
      ? await resolveSessionModelTierOverride({
          source: "agent-executor",
          sessionId: options.sessionId,
          sessionKey: options.sessionKey,
          activity: activityForRouting,
        })
      : null;
    const routingDecision = options.routingDecision ?? (await resolveModelCandidates(activityForRouting, options.model
      ? { model: options.model, overrideReason: "executor caller requested explicit model override" }
      : sessionTierOverride
        ? { semanticTierOverride: sessionTierOverride, overrideReason: "session model tier override", sessionId: options.sessionId }
        : { sessionId: options.sessionId }))[0];
    const modelString = routingDecision.modelString;
    const tierThinking: ThinkingTierConfig = options.thinking
      ? options.thinking
      : options.thinkingBudget !== undefined
      ? thinkingBudgetToTier(options.thinkingBudget)
      : { type: "disabled" };
    const parsedModelForResolve = modelString.includes("/") ? modelString.split("/").slice(1).join("/") : modelString;
    const thinking = resolveThinkingConfig(parsedModelForResolve, tierThinking);
    const routingTier = options.routingTier || routingDecision.tier;
    const thinkingBudget = thinking.thinking.type === "enabled" ? (thinking.thinking.budgetTokens ?? 0) : 0;
    const runEntry = this.activeRuns.get(runId);
    if (runEntry) runEntry.model = modelString;
    const { getMaxOutputTokens: getModelMax } = await import("./model-registry");
    const parsedModelId = modelString.includes("/") ? modelString.split("/").slice(1).join("/") : modelString;
    let maxTokens = getModelMax(parsedModelId);
    // Honor a per-tier Claude CLI output cap so the context budget's output reserve
    // (and thus the derived hard input limit) reflects the configured output ceiling,
    // matching the CLAUDE_CODE_MAX_OUTPUT_TOKENS the worker actually runs with.
    const cliMaxOutputCap = routingDecision.provider === "claude-cli"
      ? (routingDecision.modelConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens
      : undefined;
    if (cliMaxOutputCap) maxTokens = Math.min(maxTokens, cliMaxOutputCap);
    // An explicit per-tier output configuration (any provider) is the user's
    // chosen operating output ceiling. Honor it as the budget's output reserve
    // so the derived hard input limit and the gauge's reserved-output wedge
    // reflect the real setting instead of the fixed 32k default clamp.
    const configuredMaxOutput = (routingDecision.modelConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens;
    let outputReserveIsExplicit = typeof configuredMaxOutput === "number" && configuredMaxOutput > 0;
    let outputReserveTokens = outputReserveIsExplicit ? (configuredMaxOutput as number) : maxTokens;

    const emit = (event: StreamEvent) => {
      options.onEvent?.(event);
      this.emit("stream", { runId, ...event });
    };

    const journal = (type: JournalEntry["type"], extra?: Partial<JournalEntry>) => {
      if (!options.sessionId) {
        log.warn(`journal skipped — no sessionId for type=${type} sessionKey=${options.sessionKey} runId=${runId}`);
        return;
      }
      writeJournal({ ts: Date.now(), type, sessionKey: options.sessionKey, sessionId: options.sessionId, source: "agent", runId, ...extra });
    };

    const journalCategory =
      options.sessionKey?.startsWith("thought:") ? "thought" as const :
      options.sessionKey?.startsWith("auto:") ? "chat" as const :
      "chat" as const;

    const publish = (type: JournalEntry["type"], extra?: Partial<JournalEntry>) => {
      const event: StreamEvent = { type: type as StreamEvent["type"] };
      if (extra?.content !== undefined) event.content = extra.content;
      if (extra?.toolName) event.toolName = extra.toolName;
      if (extra?.toolCallId) event.toolCallId = extra.toolCallId;
      if (extra?.arguments) event.arguments = extra.arguments;
      if (extra?.result !== undefined) event.result = typeof extra.result === "string" ? extra.result : safeStringify(extra.result, { maxBytes: 64 * 1024, label: "agent-executor.eventExtra.result" });
      if (extra?.error) event.error = extra.error;
      if (extra?.providerFailure) event.providerFailure = extra.providerFailure;
      if (extra?.status) (event as unknown as Record<string, unknown>).status = extra.status;
      if (extra?.stepId) (event as unknown as Record<string, unknown>).stepId = extra.stepId;
      if (extra?.step) event.step = extra.step;
      if (extra?.narrative) event.narrative = extra.narrative;
      if (extra?.model) event.model = extra.model;
      if (extra?.autoTier) event.autoTier = extra.autoTier;
      if (extra?.persona) event.persona = extra.persona;
      if (extra?.detail) event.detail = extra.detail;
      if (extra?.metadata) event.metadata = extra.metadata as Record<string, unknown>;
      if (extra?.elapsedMs !== undefined) event.elapsedMs = extra.elapsedMs;
      event.timingKind = extra?.timingKind;
      event.diagnosticVisibility = extra?.diagnosticVisibility;
      event.childMode = extra?.childMode;
      event.occurredAt = extra?.occurredAt;
      const explicitStepId = extra?.stepId as string | undefined;
      const spanKey = extra?.step ? `${String(extra.step)}:${explicitStepId || "default"}` : undefined;
      if (type === "system_step" && extra?.step && spanKey) {
        const status = extra.status;
        if (extra.timingKind === "milestone") {
          const occurredAt = extra.occurredAt ?? Date.now();
          event.stepId = explicitStepId || `system-${String(extra.step)}-${ctx.iteration}-${occurredAt}`;
          event.startedAt = occurredAt;
          event.endedAt = occurredAt;
          event.occurredAt = occurredAt;
          event.elapsedMs = undefined;
          event.parentId = extra.parentId as string | undefined;
        } else if (status === "started" || status === "active") {
          const startedAt = Date.now();
          const id = explicitStepId
            ? canonicalSystemStepId(String(extra.step), explicitStepId)
            : `system-${String(extra.step)}-${ctx.iteration}-${startedAt}`;
          const parentId = extra.parentId as string | undefined;
          ctx.activeSystemSpans.set(spanKey, {
            id,
            startedAt,
            parentId,
            detail: extra.detail,
            metadata: extra.metadata as Record<string, unknown> | undefined,
            diagnosticVisibility: extra.diagnosticVisibility,
            childMode: extra.childMode,
          });
          event.timingKind = "span";
          event.stepId = id;
          event.startedAt = startedAt;
          event.parentId = parentId;
        } else if (status === "done" || status === "error") {
          const span = ctx.activeSystemSpans.get(spanKey);
          const endedAt = Date.now();
          if (span) ctx.activeSystemSpans.delete(spanKey);
          event.stepId = span?.id || (explicitStepId ? canonicalSystemStepId(String(extra.step), explicitStepId) : undefined);
          event.startedAt = span?.startedAt ?? (extra.elapsedMs != null ? endedAt - extra.elapsedMs : endedAt);
          event.endedAt = endedAt;
          event.parentId = (extra.parentId as string | undefined) ?? span?.parentId;
          event.detail = extra.detail ?? span?.detail;
          event.metadata = (extra.metadata as Record<string, unknown> | undefined) ?? span?.metadata;
          event.diagnosticVisibility = extra.diagnosticVisibility ?? span?.diagnosticVisibility;
          event.childMode = extra.childMode ?? span?.childMode;
          event.timingKind = "span";
          event.elapsedMs = Math.max(0, endedAt - event.startedAt);
          event.selfTimeMs = extra.selfTimeMs;
        }
      }
      // Chronology: capture completed system steps
      if (type === "system_step" && extra?.step && (extra?.status === "done" || extra?.status === "error")) {
        const stepIdx = ctx.systemStepsData.length;
        ctx.systemStepsData.push({
          id: event.stepId,
          name: extra.step as string,
          status: extra.status as "done" | "error",
          elapsedMs: event.elapsedMs,
          detail: event.detail,
          metadata: event.metadata,
          parentId: event.parentId,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          selfTimeMs: event.selfTimeMs,
          timingKind: event.timingKind,
          diagnosticVisibility: event.diagnosticVisibility,
          childMode: event.childMode,
          occurredAt: event.occurredAt,
        });
        ctx.segmentChronology.push({ s: "system", i: stepIdx });
      }
      emit(event);
      if (options.sessionId) {
        journal(type, { ...extra, stepId: event.stepId, parentId: event.parentId, startedAt: event.startedAt, endedAt: event.endedAt, selfTimeMs: event.selfTimeMs, timingKind: event.timingKind, diagnosticVisibility: event.diagnosticVisibility, childMode: event.childMode, occurredAt: event.occurredAt, elapsedMs: event.elapsedMs });
      } else {
        log.warn(`publish without sessionId — type=${type} sessionKey=${options.sessionKey} runId=${runId}`);
        publishJournalToUI({
          ts: Date.now(), type, sessionKey: options.sessionKey,
          sessionId: "", source: "agent", runId,
          ...extra,
        }, journalCategory);
      }
    };

    const ctx: RunIterationContext = {
      runId, modelString, emit, journal, publish,
      execTrace: [],
      allThinking: [], resolvedToolCalls: [],
      totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      responseGenerationLimit: {
        configuredOutputTokens: maxTokens,
        finalResponseOutputTokens: 0,
      },
      preflightRawEstimateTokens: 0,
      resolvedModel: modelString, resolvedProvider: routingDecision.provider, routingDecision, routingTier,
      iteration: 0, emergencyCompactionRetries: 0, emptyFinalTurnRetries: 0, streamIdleRecoveryAttempts: 0, aborted: false,
      iterationThinking: "", iterationText: "",
      iterationUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      pendingToolCalls: [],
      sdkHandledToolIds: new Set(),
      autohydratePending: new Set(),
      autohydratedToolNames: new Set(),
      toolCallArgsCache: new Map(),
      executionMode: options.toolExecutor ? "sdk_owned" : "executor_owned",
      consecutiveFailureIterations: 0,
      pendingCostLogs: [],
      backgroundWork: new Set<Promise<void>>(),
      firstTokenEmitted: false,
      thinkingStepActive: false,
      activeToolUseSteps: new Map(),
      activeSystemSpans: new Map(),
      toolUseReceivedAt: new Map(),
      operationRecovery: new ToolOperationRecovery(),
      budgets: {
        maxIterations: resolveRunBudget(options.maxIterations, DEFAULT_MAX_ITERATIONS, HARD_MAX_ITERATIONS),
        maxToolCalls: resolveRunBudget(options.maxToolCalls, DEFAULT_MAX_TOOL_CALLS, HARD_MAX_TOOL_CALLS),
        toolCallsUsed: 0,
      },
      diagnosticLastAssistantTextLength: 0,
      diagnosticLastAssistantVisibleTextLength: 0,
      diagnosticHadToolErrors: false,
      diagnosticFailedToolCount: 0,
      iterationToolCalls: [],
      intentionallyAwaitingUser: false,
      intentionallyCompletedSession: false,
      missionCompletionAssertionRetries: 0,
      segmentChronology: [],
      systemStepsData: [],
      chronologyThinkingIdx: -1,
      chronologyThinkingBuf: "",
      chronologyContentIdx: -1,
      chronologyContentBuf: "",
      chronologyIterationContentPrefix: "",
      convergence: createRunConvergenceState(),
    };

    if (options.signal) {
      const mapUpstreamReason = () => {
        if (!ctx.abortReason) {
          ctx.abortReason = getAbortReason(options.signal!);
        }
        abortTrace("agent_executor.signal_listener", {
          runId,
          sessionId: options.sessionId,
          sessionKey: options.sessionKey,
          reason: ctx.abortReason,
        }, "warn");
        abortController.abort(ctx.abortReason);
      };
      options.signal.addEventListener("abort", mapUpstreamReason);
      if (options.signal.aborted) {
        mapUpstreamReason();
      }
    }

    eventBus.publish({
      category: "agent",
      event: "agent.run.start",
      payload: { runId, model: modelString, activity: options.activity, source: options.activity || "agent" },
      runId,
      sessionKey: options.sessionKey,
    });
    log.log(
      `run START runId=${runId} executionMode=${ctx.executionMode} model=${modelString} ` +
      `activity=${options.activity || "agent"} sessionKey=${options.sessionKey} ` +
      `maxIterations=${ctx.budgets.maxIterations} maxToolCalls=${ctx.budgets.maxToolCalls}`,
    );
    ctx.publish("run_start", { runId });
    const persona = options.sessionId
      ? await import("./session-persona")
          .then(({ resolveSessionPersonaSnapshot }) => resolveSessionPersonaSnapshot(options.sessionId))
      : undefined;
    ctx.publish("model_info", {
      model: modelString,
      autoTier: String(routingTier),
      persona,
    });

    return {
      runId,
      abortController,
      startTime,
      modelString,
      maxTokens,
      outputReserveTokens,
      outputReserveIsExplicit,
      thinkingBudget,
      thinking,
      routingTier,
      routingDecision,
      ctx,
    };
  }

  private async handleEmergencyCompaction(
    messages: ExecutorMessage[],
    options: ExecutorRunOptions,
    publish: RunIterationContext["publish"],
    toolDefinitionTokens = 0,
  ): Promise<{ compacted: boolean; hasRunMidTurnHistoryHardTrim: boolean }> {
    const emergencyTokensBefore = estimateTotalTokens(messages);
    const emergencyMessagesBefore = messages.length;
    log.warn(
      `context.overflow provider rejected request; attempting emergency compaction ` +
        `sessionId=${options.sessionId || "none"} estimatedMessageTokens=${emergencyTokensBefore} ` +
        `messages=${emergencyMessagesBefore}`,
    );
    const compactionStepId = `emergency-compaction-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    publish("compacting", { stepId: compactionStepId, status: "active", content: "Context too large. Compressing working context..." });

    let hasRunMidTurnHistoryHardTrim = false;
    const historyHardTrim = compactMidTurnHistoryHardTrim(messages);
    if (historyHardTrim.compacted) {
      messages.splice(0, messages.length, ...historyHardTrim.messages);
      if (historyHardTrim.summaryContent) {
        hasRunMidTurnHistoryHardTrim = true;
        const tokensAfter = estimateTotalTokens(messages);
        log.info(
          `context.reduction action=mid_turn_history_hard_trim trigger=provider_overflow outcome=applied ` +
            `sessionId=${options.sessionId || "none"} tokensBefore=${emergencyTokensBefore} ` +
            `tokensAfter=${tokensAfter} tokensSaved=${emergencyTokensBefore - tokensAfter} ` +
            `messagesBefore=${emergencyMessagesBefore} messagesAfter=${messages.length} ` +
            `summaryLen=${historyHardTrim.summaryContent.length}`,
        );
        eventBus.publish({ category: "system", event: "compaction.applied", payload: { sessionId: options.sessionId || null, trigger: "emergency", action: "mid_turn_history_hard_trim", outcome: "applied", tokensBefore: emergencyTokensBefore, tokensAfter, tokensSaved: emergencyTokensBefore - tokensAfter, messagesBefore: emergencyMessagesBefore, messagesAfter: messages.length, summaryLength: historyHardTrim.summaryContent.length, historyHardTrim: historyHardTrim.telemetry } });
      }
    }
    const historyReset = compactMidTurnHistoryReset(messages);
    if (historyReset.compacted) messages.splice(0, messages.length, ...historyReset.messages);

    // Provider overflow on a single exchange has no compactable history pairs.
    // Bound oversized non-protected bodies using the same hard-input envelope.
    // Prefer the live model id when present; fall back to a Claude-class window.
    const emergencyModel =
      typeof (options as { model?: string }).model === "string" && (options as { model?: string }).model
        ? (options as { model: string }).model
        : "claude-opus-4-6";
    const emergencyBudget = getContextRequestBudget(getContextWindow(emergencyModel), 0, false);
    const singleExchange = boundSingleExchangeBodies(
      messages,
      emergencyBudget,
      Math.max(0, toolDefinitionTokens),
    );
    if (singleExchange.compacted) {
      messages.splice(0, messages.length, ...singleExchange.messages);
      log.warn(
        `context.reduction action=single_exchange_body_bound trigger=provider_overflow outcome=applied ` +
          `sessionId=${options.sessionId || "none"} bodiesBound=${singleExchange.bodiesBound} ` +
          `charsSaved=${singleExchange.charsSaved}`,
      );
    }

    const compacted = historyHardTrim.compacted || historyReset.compacted || singleExchange.compacted;
    const emergencyTokensAfter = estimateTotalTokens(messages);
    if (compacted) {
      const action = historyReset.compacted
        ? "mid_turn_history_reset"
        : "mid_turn_history_hard_trim";
      log.info(
        `context.reduction action=${action} trigger=provider_overflow outcome=complete ` +
          `sessionId=${options.sessionId || "none"} tokensBefore=${emergencyTokensBefore} ` +
          `tokensAfter=${emergencyTokensAfter} tokensSaved=${emergencyTokensBefore - emergencyTokensAfter} ` +
          `messagesBefore=${emergencyMessagesBefore} messagesAfter=${messages.length}`,
      );
    } else {
      const reason = "no_compactable_history";
      log.error(
        "executor.emergency_compaction_failed",
        attributableExecutorError(
          `emergency compaction failed reason=${reason} tokensBefore=${emergencyTokensBefore} tokensAfter=${emergencyTokensAfter}`,
          "EXECUTOR_EMERGENCY_COMPACTION_FAILED",
        ),
        {
          operation: "emergency_compaction",
          trigger: "provider_overflow",
          reason,
          tokensBefore: emergencyTokensBefore,
          tokensAfter: emergencyTokensAfter,
          messagesBefore: emergencyMessagesBefore,
          messagesAfter: messages.length,
        },
      );
      eventBus.publish({
        category: "system",
        event: "compaction.failed",
        payload: {
          sessionId: options.sessionId || null,
          trigger: "emergency",
          action: "emergency_compaction",
          outcome: "failed",
          reason,
          tokensBefore: emergencyTokensBefore,
          tokensAfter: emergencyTokensAfter,
          tokensSaved: 0,
          messagesBefore: emergencyMessagesBefore,
          messagesAfter: messages.length,
        },
      });
    }
    publish("compacting", {
      stepId: compactionStepId,
      status: compacted ? "done" : "error",
      content: compacted ? "Emergency working context compression complete." : "Emergency working context compression could not reduce context.",
    });
    return { compacted, hasRunMidTurnHistoryHardTrim };
  }

  private async executeIteration(
    messages: ExecutorMessage[],
    ctx: RunIterationContext,
    options: ExecutorRunOptions,
    abortController: AbortController,
    modelString: string,
    maxTokens: number,
    thinkingBudget: number,
    thinking: ResolvedThinking,
    routingTier: string,
    routingDecision: ModelRoutingDecision,
    chatCompletionStream: typeof import("./model-client")["chatCompletionStream"],
    contextBudget: ContextRequestBudget,
    toolDefinitionTokens: number,
    hasRunMidTurnHistoryHardTrim: boolean,
  ): Promise<{
    finalContent: string;
    shouldContinue: boolean;
    hasRunMidTurnHistoryHardTrim: boolean;
    exitCause?: "natural_stop" | "aborted" | "circuit_breaker";
    continuationType?: "tool_call" | "max_tokens";
    personaSwitchRequested?: boolean;
    toolSchemaRefreshRequested?: { toolCallId: string; toolName: string };
    awaitUserRequested?: boolean;
  }> {
    const iterStartTime = Date.now();
    const resolvedToolCallsBeforeIteration = ctx.resolvedToolCalls.length;
    ctx.personaSwitchRequested = undefined;
    ctx.toolSchemaRefreshRequested = undefined;
    ctx.awaitUserRequested = undefined;
    ctx.sessionCompleteRequested = undefined;
    ctx.iterationToolCalls = [];
    log.verbose(() => `Iteration ${ctx.iteration + 1} starting, messageCount=${messages.length}, model=${modelString}`);

    const tokensBefore = estimateTotalTokens(messages);
    const messagesBefore = messages.length;
    const compactionResult = await runCompaction(
      messages,
      contextBudget,
      toolDefinitionTokens,
      ctx.publish,
      hasRunMidTurnHistoryHardTrim,
      ctx.resolvedModel || ctx.modelString,
    );
    if (compactionResult.action !== "none") {
      messages.splice(0, messages.length, ...compactionResult.messages);
      const tokensAfter = estimateTotalTokens(messages);
      log.info(
        `context.reduction action=${compactionResult.action} trigger=threshold outcome=applied ` +
          `sessionId=${options.sessionId || "none"} runId=${ctx.runId} ` +
          `tokensBefore=${tokensBefore} tokensAfter=${tokensAfter} tokensSaved=${tokensBefore - tokensAfter} ` +
          `messagesBefore=${messagesBefore} messagesAfter=${messages.length}`,
      );

      const compactionElapsed = Date.now() - iterStartTime;
      const isFirstIterationPreToolCompression = ctx.iteration === 0 && compactionResult.telemetry.preToolRunPressure;
      const pressureSuffix = isFirstIterationPreToolCompression
        ? " · pre-run request context compressed before the first model call"
        : " · current-run working context only; saved conversation unchanged";
      // Before the first model call, request-level pressure still belongs to the
      // between-turn lifecycle. Reserve the amber working-context event for
      // recovery after the turn has actually begun.
      const compressionStep = isFirstIterationPreToolCompression
        ? "session_compaction"
        : "working_context_compression";
      ctx.publish("system_step", { step: compressionStep, status: "started", detail: `action=${compactionResult.action} tokens=${tokensBefore}→${tokensAfter}${pressureSuffix}` });
      ctx.publish("system_step", { step: compressionStep, status: "done", elapsedMs: compactionElapsed, detail: `action=${compactionResult.action} tokens=${tokensBefore}→${tokensAfter}${pressureSuffix}` });

      if (isFirstIterationPreToolCompression) {
        log.warn(`First-iteration working-context compression indicates missed durable context pressure sessionId=${options.sessionId || "none"} runId=${ctx.runId} tokensBefore=${tokensBefore} tokensAfter=${tokensAfter}`);
        eventBus.publish({
          category: "system",
          event: "context_pressure.pre_run_compression",
          payload: {
            sessionId: options.sessionId || null,
            runId: ctx.runId,
            tokensBefore,
            tokensAfter,
            action: compactionResult.action,
            durableCompactionAttempted: options.contextPressure?.durableCompactionAttempted ?? false,
            durableCompactionApplied: options.contextPressure?.durableCompactionApplied ?? false,
          },
          runId: ctx.runId,
          sessionKey: options.sessionKey,
        });
      }

      if (compactionResult.action === "mid_turn_history_hard_trim" && compactionResult.summaryContent) {
        hasRunMidTurnHistoryHardTrim = true;
        log.debug(`Mid-run compaction applied in-memory: sessionId=${options.sessionId || "none"} action=${compactionResult.action} tokensBefore=${tokensBefore} tokensAfter=${tokensAfter} messagesBefore=${messagesBefore} messagesAfter=${messages.length} summaryLen=${compactionResult.summaryContent.length}`);
        eventBus.publish({ category: "system", event: "compaction.applied", payload: { sessionId: options.sessionId || null, runId: ctx.runId, ...compactionResult.telemetry, tokensBefore, tokensAfter, tokensSaved: tokensBefore - tokensAfter, messagesBefore, messagesAfter: messages.length, summaryLength: compactionResult.summaryContent.length } });
      }
    }

    // Raw baseline (prose 4.0 / JSON 5.5) before per-model calibration. Stored so
    // the post-call usage handler can learn actual÷estimate from real provider input.
    const rawRequestTokens = estimateTotalTokens(messages) + toolDefinitionTokens;
    ctx.preflightRawEstimateTokens = rawRequestTokens;
    const requestTokens = await applyTokenEstimateCalibration(
      ctx.resolvedModel || ctx.modelString,
      rawRequestTokens,
    );
    const pressureModelRaw = ctx.resolvedModel || ctx.modelString;
    const pressureModelName = getModelName(
      pressureModelRaw.includes("/") ? pressureModelRaw.split("/").slice(1).join("/") : pressureModelRaw,
    );
    ctx.publish("context_pressure", {
      inputTokens: requestTokens,
      hardInputLimit: contextBudget.hardInputLimit,
      contextWindow: contextBudget.contextWindow,
      modelName: pressureModelName,
      outputReserve: contextBudget.outputReserve,
      betweenTurnHistoryReset: contextBudget.thresholds.betweenTurnHistoryReset,
      midTurnToolSoftTrim: contextBudget.thresholds.midTurnToolSoftTrim,
      midTurnHistoryHardTrim: contextBudget.thresholds.midTurnHistoryHardTrim,
      midTurnHistoryReset: contextBudget.thresholds.midTurnHistoryReset,
    });
    if (requestTokens > contextBudget.hardInputLimit) {
      throw new ContextHardLimitExceededError(requestTokens, contextBudget);
    }

    ctx.iteration++;
    ctx.iterationThinking = "";
    ctx.iterationText = "";
    ctx.chronologyIterationContentPrefix = ctx.segmentChronology.some(
      (entry) => entry.s === "content" && entry.c.length > 0,
    )
      ? ITERATION_CONTENT_SEPARATOR
      : "";
    ctx.iterationUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    ctx.pendingToolCalls = [];
    ctx.iterationStopReason = undefined;
    ctx.firstTokenEmitted = false;
    ctx.llmRequestSentEmitted = false;
    ctx.llmConnectedEmitted = false;
    ctx.llmConnectedDoneEmitted = false;
    ctx.llmHeadersEmitted = false;
    ctx.activeResponsePhase = undefined;
    ctx.thinkingStepActive = false;

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let streamGenerator: AsyncGenerator<any> | null = null;
    let streamEventCount = 0;
    let lastEventType = "none";
    let idleExtendedForPartialContent = false;
    let streamIdleRecoveryRequested = false;
    const streamAttemptController = new AbortController();
    const abortStreamAttemptFromRun = () => streamAttemptController.abort(abortController.signal.reason);
    if (abortController.signal.aborted) abortStreamAttemptFromRun();
    else abortController.signal.addEventListener("abort", abortStreamAttemptFromRun, { once: true });
    const streamLoopStart = Date.now();

    const thinkingInfo = getThinkingInfo(modelString);
    const resolvedThinkingActive = thinking.thinking.type !== "disabled";
    const reasoningStream = thinkingInfo.level !== "none" || resolvedThinkingActive;
    const idleTimeoutMs = reasoningStream ? STREAM_IDLE_TIMEOUT_EXTENDED_MS : STREAM_IDLE_TIMEOUT_MS;
    const runEntry = this.activeRuns.get(ctx.runId);

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (runEntry) runEntry.streamIdleDeadlineAt = Date.now() + idleTimeoutMs;
      idleTimer = setTimeout(() => {
        const elapsedMs = Date.now() - streamLoopStart;
        const hasPartialContent = ctx.iterationText.length > 0;
        const tokensAccumulated = ctx.iterationUsage.totalTokens;

        const pendingToolCallCount = ctx.pendingToolCalls.length;
        const activeToolUseStepCount = ctx.activeToolUseSteps.size;

        // Tool execution can be owned by the provider/SDK and still occur inside
        // this stream loop. In that phase the last stream event is often
        // tool_use_start, then the provider goes quiet while the tool runs. That
        // is progress, not model idleness. Defer the stream idle abort while a
        // tool is active/pending, bounded by the extended idle window so a truly
        // wedged provider still fails loudly.
        if ((pendingToolCallCount > 0 || activeToolUseStepCount > 0) && elapsedMs < STREAM_IDLE_TIMEOUT_EXTENDED_MS) {
          log.warn(
            `Stream idle timeout deferred — tool activity pending. ` +
            `iteration=${ctx.iteration} runId=${ctx.runId} streamEvents=${streamEventCount} ` +
            `elapsedMs=${elapsedMs} lastEventType=${lastEventType} ` +
            `pendingToolCalls=${pendingToolCallCount} activeToolUseSteps=${activeToolUseStepCount}`
          );
          resetIdleTimer();
          return;
        }

        // If text has been generated (partial content exists) and we haven't
        // already extended once, give the model one more timeout window. This
        // handles the case where the model processes many tool results, emits
        // some text_delta events, then enters a long internal computation phase
        // (e.g. extended thinking synthesis) with no events for a prolonged
        // period. Without this extension, the idle detector kills active work.
        if (hasPartialContent && !idleExtendedForPartialContent) {
          idleExtendedForPartialContent = true;
          log.warn(
            `Stream idle timeout deferred — partial content detected, extending once. ` +
            `iteration=${ctx.iteration} runId=${ctx.runId} streamEvents=${streamEventCount} ` +
            `elapsedMs=${elapsedMs} lastEventType=${lastEventType} textLength=${ctx.iterationText.length}`
          );
          resetIdleTimer();
          return;
        }

        const canRecover = !hasPartialContent
          && pendingToolCallCount === 0
          && activeToolUseStepCount === 0
          && ctx.streamIdleRecoveryAttempts === 0;
        const diagnostics = {
          operation: "stream_idle_timeout",
          runId: ctx.runId,
          iteration: ctx.iteration,
          idleTimeoutMs,
          streamEvents: streamEventCount,
          elapsedMs,
          lastEventType,
          tokensAccumulated,
          hasPartialContent,
          pendingToolCalls: pendingToolCallCount,
          resolvedToolCalls: ctx.resolvedToolCalls.length,
          recoveryAttempt: ctx.streamIdleRecoveryAttempts + 1,
        };
        ctx.lastStreamDiagnostics = { eventCount: streamEventCount, elapsedMs, lastEventType };
        if (canRecover) {
          streamIdleRecoveryRequested = true;
          log.warn("executor.stream_idle_recovery", diagnostics);
          streamAttemptController.abort("stream_idle_recovery");
        } else {
          log.warn("executor.stream_idle_exhausted", diagnostics);
          ctx.abortReason = "stream_idle_timeout";
          abortController.abort(ctx.abortReason);
        }
        if (streamGenerator) {
          // Force-close the generator and HAND THE CLEANUP CHAIN to the run's
          // background-work registry. Previously we used .catch(() => {}) here,
          // which detached the cleanup from the run entirely and let the
          // admission slot release before the underlying CLI subprocess actually
          // wound down — the precise leak this task fixes.
          const closePromise: Promise<void> = streamGenerator.return(undefined).then(
            () => undefined,
            (err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              log.warn(`generator.return() rejected after idle timeout runId=${ctx.runId}: ${msg}`);
            },
          );
          this.registerBackgroundWork(ctx, closePromise);
          log.debug(`Generator force-close registered after idle timeout runId=${ctx.runId}`);
        }
      }, idleTimeoutMs);
    };

    const modelSpanId = `model-${ctx.runId}-${ctx.iteration}`;
    try {
      ctx.llmCallStartTime = Date.now();
      ctx.publish("system_step", { step: "llm_call", status: "started", stepId: modelSpanId, parentId: options.diagnosticTurnId, detail: formatModelConnectionDetail(ctx), childMode: "serial" });
      ctx.llmRequestSentEmitted = false;
      ctx.llmConnectedEmitted = false;
      ctx.llmConnectedDoneEmitted = false;
      ctx.llmHeadersEmitted = false;
      ctx.activeResponsePhase = undefined;
      this.startResponsePhase(ctx, "llm_request_sent");

      const boundedToolExecutor = options.toolExecutor
        ? async (name: string, args: Record<string, unknown>, toolContext?: { toolCallId: string; order: number }) => {
            const execute = () => options.toolExecutor!(name, args);
            if (
              toolTransfersExecutionToChild(name, args)
              && options.capacityOwner?.kind === "runtime"
              && toolRequiresNestedRuntimeScheduler(name, args)
            ) {
              throw new Error("Native Runtime handlers cannot transfer execution into a nested scheduler");
            }
            const result = await this.executeToolWithRecovery(ctx, name, args, async () => (
              toolTransfersExecutionToChild(name, args)
                ? (await import("./run-admission")).admissionController.withSuspendedSlot(ctx.runId, execute)
                : execute()
            ));
            const callId = toolContext?.toolCallId || generateToolCallId();
            const canonicalArgs = result.normalizedArguments ?? args;
            await archiveLargeToolOutput({
              toolName: name,
              action: typeof canonicalArgs.action === "string" ? canonicalArgs.action : undefined,
              toolCallId: callId,
              result: result.result,
              error: result.error,
              sessionId: options.sessionId,
              runId: ctx.runId,
            });
            const resultTokens = estimateToolOutputSize(result.result).estimatedTokens;
            this.emitContextGrowthCanary({
              ctx,
              options,
              boundary: "tool_result_reinjection",
              messageTokens: estimateTotalTokens(messages) + resultTokens,
              toolResultTokens: resultTokens,
              budgetTokens: contextBudget.hardInputLimit,
              toolCallId: callId,
              toolName: name,
            });
            return {
              ...result,
              providerResult: result.result,
            };
          }
        : undefined;

      const providerMessages = messages;
      const rawMessageTokens = estimateTotalTokens(providerMessages);
      const rawToolResultTokens = providerMessages.reduce((total, message) => {
        if (message.role !== "tool_result" || !Array.isArray(message.content)) return total;
        return total + message.content.reduce((messageTotal, block) => {
          if (block.type !== "tool_result" || typeof block.content !== "string") return messageTotal;
          return messageTotal + estimateToolOutputSize(block.content).estimatedTokens;
        }, 0);
      }, 0);
      this.emitContextGrowthCanary({
        ctx,
        options,
        boundary: "pre_inference",
        messageTokens: rawMessageTokens,
        toolResultTokens: rawToolResultTokens,
        budgetTokens: contextBudget.hardInputLimit,
      });
      const pendingToolResultMessages = providerMessages.filter(m => m.role === "tool_result").length;
      log.debug(
        `agent.loop.model_request runId=${ctx.runId} sessionId=${options.sessionId || "none"} ` +
        `iteration=${ctx.iteration} pendingToolResults=${pendingToolResultMessages} ` +
        `messageCount=${providerMessages.length} measurand=raw_input rawTokens=${rawMessageTokens}`,
      );
      eventBus.publish({
        category: "agent",
        event: "agent.loop.model_request",
        payload: {
          runId: ctx.runId,
          sessionId: options.sessionId || null,
          iteration: ctx.iteration,
          pendingToolResults: pendingToolResultMessages,
          messageCount: providerMessages.length,
          rawInputTokens: rawMessageTokens,
          source: options.activity || "agent",
        },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });

      streamGenerator = chatCompletionStream({
        model: modelString,
        routingDecision,
        metadata: {
          source: "agent-executor",
          workloadSource: options.activity ? `agent:${options.activity}` : "agent:chat",
          runId: ctx.runId,
          sessionId: options.sessionId,
          sessionKey: options.sessionKey,
          iteration: ctx.iteration,
          activity: options.activity,
        },
        activity: options.activity,
        messages: providerMessages.map(m => ({ role: m.role as StreamMessage["role"], content: m.content, toolCallId: m.toolCallId, name: m.name })),
        tools: ctx.convergence.terminalRequired ? [] : options.tools,
        stubTools: options.authorityStubTools,
        toolExecutor: boundedToolExecutor,
        maxTokens,
        temperature: options.temperature,
        thinkingBudget,
        thinking,
        routingTier,
        signal: streamAttemptController.signal,
        // Adapter cleanup chains (interrupt acks, force-abort iterator-return)
        // are now owned by the run via this registry. The run's finally awaits
        // the registry before releasing the admission slot, so abort can no
        // longer leak CLI subprocesses past the slot release.
        registerBackgroundWork: (p) => this.registerBackgroundWork(ctx, p),
        // Plumb correlators so the CLI adapter's `cli_subprocess_crash` line
        // can be tied back to a specific run/conversation. Both nullable.
        runId: ctx.runId,
        convId: options.sessionId,
        voiceSessionId: options.voiceSessionId,
      });

      resetIdleTimer();
      log.debug(`Stream loop started iteration=${ctx.iteration} runId=${ctx.runId}`);

      for await (const event of streamGenerator) {
        streamEventCount++;
        lastEventType = event.type || "unknown";
        resetIdleTimer();
        if (abortController.signal.aborted) {
          ctx.aborted = true;
          if (!ctx.abortReason) {
            ctx.abortReason = getAbortReason(abortController.signal);
          }
          break;
        }
        await this.processStreamEvent(event, ctx, options);
        const runEntry = this.activeRuns.get(ctx.runId);
        if (runEntry) runEntry.lastActivityAt = Date.now();
        if (ctx.terminalToolFailure) {
          log.warn(`[ToolRecovery] stopping model stream after quarantined failure runId=${ctx.runId} code=${ctx.terminalToolFailure.failure.code}`);
          break;
        }
      }

      if (!ctx.aborted && abortController.signal.aborted) {
        ctx.aborted = true;
        if (!ctx.abortReason) {
          ctx.abortReason = getAbortReason(abortController.signal);
        }
      }
      if (streamIdleRecoveryRequested && !abortController.signal.aborted) {
        ctx.streamIdleRecoveryAttempts++;
        ctx.iterationThinking = "";
        ctx.thinkingBuf = "";
        ctx.chronologyThinkingBuf = "";
        ctx.publish("attempt_reset", {});
        log.warn("executor.stream_idle_recovered", {
          operation: "stream_idle_recovered",
          runId: ctx.runId,
          iteration: ctx.iteration,
          recoveryAttempt: ctx.streamIdleRecoveryAttempts,
          nextAction: "retry_routed_stream",
        });
        return { finalContent: "", shouldContinue: true, hasRunMidTurnHistoryHardTrim };
      }
      const responseStatus = ctx.aborted ? "error" : "done";
      this.finishResponsePhase(ctx, responseStatus);
      if (ctx.thinkingStepActive) {
        ctx.thinkingStepActive = false;
        ctx.publish("system_step", { step: "thinking", status: responseStatus });
      }

      this.emitModelCallTimingStep(ctx, modelSpanId);
      ctx.publish("system_step", { step: "llm_call", status: responseStatus, stepId: modelSpanId });

      const modelCompletedAt = Date.now();
      const ttftMs = ctx.firstOutputTime && ctx.llmCallStartTime
        ? ctx.firstOutputTime - ctx.llmCallStartTime
        : null;
      const decodeMs = ctx.firstOutputTime
        ? modelCompletedAt - ctx.firstOutputTime
        : null;
      eventBus.publish({
        category: "agent",
        event: "agent.stage_timing",
        payload: {
          runId: ctx.runId,
          sessionId: options.sessionId || null,
          iteration: ctx.iteration,
          stage: "model",
          outcome: responseStatus === "done" ? "succeeded" : "failed",
          durationMs: ctx.llmCallStartTime ? modelCompletedAt - ctx.llmCallStartTime : null,
          ttftMs,
          decodeMs,
          effectiveReasoningEffort: routingDecision.modelConfig?.reasoningEffort ?? thinking ?? null,
          model: modelString,
          source: options.activity || "agent",
        },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });

      ctx.lastStreamDiagnostics = {
        eventCount: streamEventCount,
        elapsedMs: Date.now() - streamLoopStart,
        lastEventType,
      };
      log.debug(`Stream loop ended iteration=${ctx.iteration} events=${streamEventCount} elapsed=${ctx.lastStreamDiagnostics.elapsedMs}ms aborted=${ctx.aborted} abortReason=${ctx.abortReason ?? "none"} runId=${ctx.runId}`);
      ctx.diagnosticLastStep = "model_response";
      ctx.diagnosticLastModelStopReason = ctx.iterationStopReason || "end_turn";
      pushExecTrace(ctx, "model_response", `iter=${ctx.iteration} stop=${ctx.diagnosticLastModelStopReason}`);

      ctx.diagnosticLastAssistantTextLength = ctx.iterationText.length;
      log.debug(`agent.loop.model_response runId=${ctx.runId} sessionId=${options.sessionId || "none"} iteration=${ctx.iteration} stopReason=${ctx.diagnosticLastModelStopReason} toolCallCount=${ctx.pendingToolCalls.length} assistantTextLength=${ctx.iterationText.length} streamEvents=${streamEventCount}`);
      eventBus.publish({
        category: "agent",
        event: "agent.loop.model_response",
        payload: {
          runId: ctx.runId,
          sessionId: options.sessionId || null,
          iteration: ctx.iteration,
          stopReason: ctx.diagnosticLastModelStopReason,
          toolCallCount: ctx.pendingToolCalls.length,
          assistantTextLength: ctx.iterationText.length,
          streamEvents: streamEventCount,
          source: options.activity || "agent",
        },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });
    } catch (streamErr: unknown) {
      if (streamIdleRecoveryRequested && !abortController.signal.aborted) {
        ctx.streamIdleRecoveryAttempts++;
        ctx.iterationThinking = "";
        ctx.thinkingBuf = "";
        ctx.chronologyThinkingBuf = "";
        ctx.publish("attempt_reset", {});
        log.warn("executor.stream_idle_recovered", {
          operation: "stream_idle_recovered",
          runId: ctx.runId,
          iteration: ctx.iteration,
          recoveryAttempt: ctx.streamIdleRecoveryAttempts,
          nextAction: "retry_routed_stream",
        });
        return { finalContent: "", shouldContinue: true, hasRunMidTurnHistoryHardTrim };
      }
      const providerFailure = streamErr instanceof ModelProviderError
        ? streamErr.providerFailure
        : undefined;
      if (providerFailure) {
        ctx.lastError = providerFailure.userMessage;
        ctx.providerFailure = providerFailure;
      }
      this.finishResponsePhase(ctx, "error");
      ctx.publish("system_step", { step: "llm_call", status: "error", stepId: modelSpanId });
      if (ctx.thinkingStepActive) {
        ctx.thinkingStepActive = false;
        ctx.publish("system_step", { step: "thinking", status: "error" });
      }
      if (isContextLengthError(streamErr)) {
        const MAX_EMERGENCY_RETRIES = 3;
        ctx.emergencyCompactionRetries++;
        if (ctx.emergencyCompactionRetries > MAX_EMERGENCY_RETRIES) {
          log.error(
            "executor.emergency_compaction_retry_limit",
            attributableExecutorError(
              `Emergency compaction retry limit reached (${MAX_EMERGENCY_RETRIES}). Context is fundamentally too large.`,
              "EXECUTOR_EMERGENCY_COMPACTION_RETRY_LIMIT",
            ),
            {
              operation: "emergency_compaction_retry_limit",
              runId: ctx.runId,
              maxRetries: MAX_EMERGENCY_RETRIES,
              tokens: estimateTotalTokens(messages),
              messages: messages.length,
            },
          );
          throw streamErr;
        }
        log.debug(`Emergency compaction attempt ${ctx.emergencyCompactionRetries}/${MAX_EMERGENCY_RETRIES} runId=${ctx.runId}`);
        const emergency = await this.handleEmergencyCompaction(
          messages,
          options,
          ctx.publish,
          toolDefinitionTokens,
        );
        if (emergency.compacted) {
          if (emergency.hasRunMidTurnHistoryHardTrim) hasRunMidTurnHistoryHardTrim = true;
          ctx.providerFailure = undefined;
          ctx.lastError = undefined;
          return { finalContent: "", shouldContinue: true, hasRunMidTurnHistoryHardTrim };
        }
      }
      if (providerFailure) {
        ctx.publish("error", { error: providerFailure.userMessage, providerFailure });
      }
      throw streamErr;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      abortController.signal.removeEventListener("abort", abortStreamAttemptFromRun);
      if (runEntry) runEntry.streamIdleDeadlineAt = undefined;
    }

    // Zombie abort detection: when the zombie detector fires abortRun()
    // directly on the executor's AbortController, the for-await loop may
    // exit via generator completion (no more events yielded) rather than
    // the in-loop abort check. In that case ctx.aborted is still false
    // even though the signal has fired. Catch that here so the abort
    // propagates correctly through exitCause → terminationReason → the
    // error path in runSkillPipeline (red error widget + failed status).
    if (!ctx.aborted && abortController.signal.aborted) {
      ctx.aborted = true;
      if (!ctx.abortReason) {
        ctx.abortReason = getAbortReason(abortController.signal);
      }
      log.warn(`Post-loop abort detection: signal was aborted but ctx.aborted was false. Set abortReason=${ctx.abortReason} runId=${ctx.runId}`);
    }

    if (ctx.aborted) return { finalContent: "", shouldContinue: false, hasRunMidTurnHistoryHardTrim, exitCause: ctx.abortReason === "circuit_breaker" ? "circuit_breaker" : "aborted" };

    this.logIterationCost(messages, ctx.iterationText, ctx, options, iterStartTime, abortController);

    if (ctx.iterationThinking) {
      ctx.allThinking.push(ctx.iterationThinking);
      this.flushChronologyThinking(ctx);
      ctx.publish("thinking_complete", { content: ctx.iterationThinking });
    }
    // Flush content buffer at iteration boundary (before tool execution may add more entries)
    this.flushChronologyContent(ctx);

    const cleanText = extractThinkingFromText(ctx.iterationText).clean;
    // Record this turn's visible (thinking-stripped, trimmed) text length. Every
    // non-aborted iteration passes through here, so at terminal time this holds
    // the FINAL turn's length. publishRunResult classifies an empty final turn on
    // this last-turn signal rather than the merged run content, so an empty
    // completion after earlier tool narration is no longer masked into a success.
    ctx.diagnosticLastAssistantVisibleTextLength = cleanText.trim().length;

    if (ctx.iterationStopReason === "max_tokens" && ctx.pendingToolCalls.length > 0) {
      const incomplete = ctx.pendingToolCalls.filter(tc => Object.keys(tc.input).length === 0);
      if (incomplete.length > 0) {
        log.debug(`max_tokens truncated ${incomplete.length} tool call(s) mid-stream — continuing without incomplete calls: ${incomplete.map(tc => tc.name).join(", ")} runId=${ctx.runId}`);
        ctx.pendingToolCalls = ctx.pendingToolCalls.filter(tc => Object.keys(tc.input).length > 0);

        if (ctx.pendingToolCalls.length === 0) {
          const partialContent = ctx.iterationText || "";
          if (partialContent) {
            messages.push({ role: "assistant", content: partialContent });
          }
          messages.push({ role: "user", content: "[System: Your previous response reached the provider output boundary while building a tool call. The tool call was incomplete and could not be executed. Continue the task and retry the tool call with valid complete arguments.]" });
          return { finalContent: cleanText, shouldContinue: true, hasRunMidTurnHistoryHardTrim, continuationType: "max_tokens" };
        }
      }
    }

    if (ctx.awaitUserRequested) {
      const toolCallId = ctx.awaitUserRequested.toolCallId;
      ctx.awaitUserRequested = undefined;
      ctx.intentionallyAwaitingUser = true;
      ctx.publish("tool_use_pause", { content: "" });
      log.log(`await-user boundary requested runId=${ctx.runId} sessionId=${options.sessionId || "none"} toolCallId=${toolCallId}`);
      return {
        finalContent: cleanText,
        shouldContinue: false,
        hasRunMidTurnHistoryHardTrim,
        exitCause: "natural_stop",
        awaitUserRequested: true,
      };
    }

    if (ctx.sessionCompleteRequested) {
      const toolCallId = ctx.sessionCompleteRequested.toolCallId;
      ctx.sessionCompleteRequested = undefined;
      ctx.intentionallyCompletedSession = true;
      ctx.publish("tool_use_pause", { content: "" });
      log.log(`session-complete boundary requested runId=${ctx.runId} sessionId=${options.sessionId || "none"} toolCallId=${toolCallId}`);
      return {
        finalContent: cleanText,
        shouldContinue: false,
        hasRunMidTurnHistoryHardTrim,
        exitCause: "natural_stop",
      };
    }

    if (ctx.toolSchemaRefreshRequested) {
      const iterationResults = ctx.resolvedToolCalls.slice(resolvedToolCallsBeforeIteration);
      const resultsById = new Map(iterationResults.map((call) => [call.id, call]));
      const orderedCalls = ctx.iterationToolCalls
        .filter((call) => resultsById.has(call.id))
        .sort((a, b) => a.order - b.order);
      const assistantContent: ContentBlock[] = [];
      if (cleanText) assistantContent.push({ type: "text", text: cleanText });
      for (const call of orderedCalls) {
        assistantContent.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({
        role: "tool_result",
        content: orderedCalls.map((call) => {
          const result = resultsById.get(call.id)!;
          return {
            type: "tool_result" as const,
            tool_use_id: call.id,
            content: result.result,
            is_error: !!result.error,
          };
        }),
      });
      const request = ctx.toolSchemaRefreshRequested;
      ctx.toolSchemaRefreshRequested = undefined;
      ctx.publish("tool_use_pause", { content: "" });
      log.log(`tool-schema refresh boundary requested runId=${ctx.runId} sessionId=${options.sessionId || "none"} toolCallId=${request.toolCallId} tool=${request.toolName}`);
      return {
        finalContent: cleanText,
        shouldContinue: true,
        hasRunMidTurnHistoryHardTrim,
        continuationType: "tool_call",
        toolSchemaRefreshRequested: request,
      };
    }

    if (ctx.personaSwitchRequested) {
      const iterationResults = ctx.resolvedToolCalls.slice(resolvedToolCallsBeforeIteration);
      const resultsById = new Map(iterationResults.map((call) => [call.id, call]));
      const orderedCalls = ctx.iterationToolCalls
        .filter((call) => resultsById.has(call.id))
        .sort((a, b) => a.order - b.order);
      if (orderedCalls.length !== iterationResults.length) {
        throw new Error(`Persona switch transcript mismatch: announced=${ctx.iterationToolCalls.length} resolved=${iterationResults.length} ordered=${orderedCalls.length}`);
      }
      const assistantContent: ContentBlock[] = [];
      if (cleanText) assistantContent.push({ type: "text", text: cleanText });
      for (const call of orderedCalls) {
        assistantContent.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({
        role: "tool_result",
        content: orderedCalls.map((call) => {
          const result = resultsById.get(call.id)!;
          return {
            type: "tool_result" as const,
            tool_use_id: call.id,
            content: result.result,
            is_error: !!result.error,
          };
        }),
      });
      const toolCallId = ctx.personaSwitchRequested.toolCallId;
      ctx.personaSwitchRequested = undefined;
      ctx.publish("tool_use_pause", { content: "" });
      log.log(`persona switch boundary requested runId=${ctx.runId} sessionId=${options.sessionId || "none"} toolCallId=${toolCallId}`);
      return {
        finalContent: cleanText,
        shouldContinue: true,
        hasRunMidTurnHistoryHardTrim,
        continuationType: "tool_call",
        personaSwitchRequested: true,
      };
    }

    // === Execution ownership gate ===
    // In sdk_owned mode, pendingToolCalls should be empty because tool_call_resolved
    // routes directly to resolvedToolCalls (Phase 1 structural fix). If we still find
    // pending tools in sdk_owned mode, that's a bug — log error and skip execution
    // (defensive, prevents double-execution).
    //
    // In executor_owned mode, the dedup filter runs as before for safety.
    // The sdkHandledToolIds set remains as a soak-period safety net.
    let unresolvedToolCalls: typeof ctx.pendingToolCalls;
    if (ctx.executionMode === "sdk_owned") {
      if (ctx.pendingToolCalls.length > 0) {
        // Tools remain in pendingToolCalls when the provider doesn't emit tool_call_resolved
        // (e.g. OpenAI Responses API vs CLI SDK adapter which handles Claude).
        // These tools were NOT executed by the SDK — fall through to executor.
        log.verbose(() => `[ToolExec] mode=sdk_owned fallthrough: ${ctx.pendingToolCalls.length} tool(s) unresolved — executing via toolExecutor. runId=${ctx.runId} tools=${ctx.pendingToolCalls.map(tc => tc.name).join(",")}`);
        unresolvedToolCalls = ctx.pendingToolCalls;
      } else {
        unresolvedToolCalls = []; // SDK already handled everything
      }
    } else {
      // executor_owned: apply legacy dedup filter (safety net during soak)
      const resolvedToolIds = new Set([
        ...ctx.resolvedToolCalls.map(tc => tc.id),
        ...ctx.sdkHandledToolIds,
      ]);
      unresolvedToolCalls = ctx.pendingToolCalls.filter(tc => !resolvedToolIds.has(tc.id));

      if (unresolvedToolCalls.length < ctx.pendingToolCalls.length) {
        log.debug(`Skipped ${ctx.pendingToolCalls.length - unresolvedToolCalls.length} already-resolved tool call(s) (dedup filter) runId=${ctx.runId}`);
      }
    }

    if (unresolvedToolCalls.length > 0 && options.toolExecutor) {
      const { toolResults, continuation } = await this.executeToolCalls(unresolvedToolCalls, ctx, options, messages, cleanText);
      messages.push({ role: "tool_result", content: toolResults });
      if (continuation === "persona_switch") {
        ctx.publish("tool_use_pause", { content: "" });
        return {
          finalContent: cleanText,
          shouldContinue: true,
          hasRunMidTurnHistoryHardTrim,
          continuationType: "tool_call",
          personaSwitchRequested: true,
        };
      }
      if (continuation === "tool_schema_refresh") {
        const schemaCall = unresolvedToolCalls.find((call) =>
          call.name === "tools" &&
          call.input.action === "get" &&
          typeof call.input.tool === "string" &&
          call.input.tool.trim().length > 0
        );
        if (schemaCall) {
          ctx.publish("tool_use_pause", { content: "" });
          return {
            finalContent: cleanText,
            shouldContinue: true,
            hasRunMidTurnHistoryHardTrim,
            continuationType: "tool_call",
            toolSchemaRefreshRequested: {
              toolCallId: schemaCall.id,
              toolName: String(schemaCall.input.tool).trim(),
            },
          };
        }
      }
      if (continuation === "await_user" || continuation === "provider_system_tool") {
        ctx.intentionallyAwaitingUser = true;
        ctx.publish("tool_use_pause", { content: "" });
        return {
          finalContent: cleanText,
          shouldContinue: false,
          hasRunMidTurnHistoryHardTrim,
          exitCause: "natural_stop",
          awaitUserRequested: true,
        };
      }
      if (continuation === "session_complete") {
        ctx.intentionallyCompletedSession = true;
        ctx.publish("tool_use_pause", { content: "" });
        log.log(`session-complete boundary after tools runId=${ctx.runId} sessionId=${options.sessionId || "none"}`);
        return {
          finalContent: cleanText,
          shouldContinue: false,
          hasRunMidTurnHistoryHardTrim,
          exitCause: "natural_stop",
        };
      }
      // Derive convergence evidence for this completed tool batch before deciding
      // whether another ordinary model iteration would make progress.
      const batchResolvedCalls = ctx.resolvedToolCalls.slice(-unresolvedToolCalls.length);
      const failedCalls = batchResolvedCalls.filter(tc => tc.error);
      const convergenceConfig = getRunConvergenceConfig();
      const progressEvidence: string[] = [];
      let maxRepeatedSignature = 0;
      for (const outcome of batchResolvedCalls) {
        const signature = normalizedInvocationSignature(outcome.name, outcome.args);
        const signatureCount = (ctx.convergence.signatureCounts.get(signature) || 0) + 1;
        ctx.convergence.signatureCounts.set(signature, signatureCount);
        maxRepeatedSignature = Math.max(maxRepeatedSignature, signatureCount);
        const failed = outcome.result.startsWith("Error:");
        if (isDurableMutation(outcome.name, outcome.args, failed)) {
          progressEvidence.push(`durable_state:${outcome.name}:${signature}`);
          continue;
        }
        if (!failed) {
          const hash = evidenceHash(outcome.result);
          if (!ctx.convergence.evidenceHashes.has(hash)) {
            ctx.convergence.evidenceHashes.add(hash);
            progressEvidence.push(`new_evidence:${outcome.name}:${hash}`);
          }
        }
      }
      if (progressEvidence.length > 0) {
        ctx.convergence.noProgressCycles = 0;
        ctx.convergence.lastProgressEvidence = progressEvidence.slice(-8);
      } else {
        ctx.convergence.noProgressCycles++;
      }
      const convergenceReason = maxRepeatedSignature >= convergenceConfig.maxRepeatedSignature
        ? `repeated_invocation_signature:${maxRepeatedSignature}`
        : ctx.convergence.noProgressCycles >= convergenceConfig.maxNoProgressCycles
          ? `no_progress_cycles:${ctx.convergence.noProgressCycles}`
          : undefined;
      if (convergenceReason && !ctx.convergence.terminalRequired) {
        ctx.convergence.terminalRequired = true;
        ctx.convergence.terminalReason = convergenceReason;
        messages.push({ role: "user", content: terminalDirective(convergenceReason) });
      }
      eventBus.publish({
        category: "agent",
        event: convergenceReason ? "agent.run_convergence_terminal_required" : "agent.run_convergence_observed",
        payload: {
          runId: ctx.runId,
          sessionId: options.sessionId || null,
          iteration: ctx.iteration,
          noProgressCycles: ctx.convergence.noProgressCycles,
          maxRepeatedSignature,
          progressEvidence: progressEvidence.slice(-8),
          terminalReason: convergenceReason || null,
          thresholds: convergenceConfig,
        },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });

      ctx.diagnosticLastStep = "tool_batch";
      pushExecTrace(ctx, "tool_batch", `iter=${ctx.iteration} calls=${unresolvedToolCalls.length} failed=${failedCalls.length}`);
      ctx.diagnosticLastToolCallId = batchResolvedCalls[batchResolvedCalls.length - 1]?.id;
      ctx.diagnosticLastToolBatchCompletedAt = Date.now();
      ctx.diagnosticFailedToolCount += failedCalls.length;
      ctx.diagnosticHadToolErrors = ctx.diagnosticHadToolErrors || failedCalls.length > 0;
      log.debug(`agent.loop.tool_batch_complete runId=${ctx.runId} sessionId=${options.sessionId || "none"} iteration=${ctx.iteration} toolCount=${unresolvedToolCalls.length} failedToolCount=${failedCalls.length} lastToolCallId=${ctx.diagnosticLastToolCallId || "none"}`);
      eventBus.publish({
        category: "agent",
        event: "agent.loop.tool_batch_complete",
        payload: {
          runId: ctx.runId,
          sessionId: options.sessionId || null,
          iteration: ctx.iteration,
          toolCount: unresolvedToolCalls.length,
          failedToolCount: failedCalls.length,
          lastToolCallId: ctx.diagnosticLastToolCallId || null,
          source: options.activity || "agent",
        },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });

      if (failedCalls.length > 0 && failedCalls.length === unresolvedToolCalls.length) {
        const iterationFailKey = failedCalls.map(normalizeToolFailureSignature).sort().join("|");
        if (iterationFailKey === ctx.lastIterationFailureKey) {
          ctx.consecutiveFailureIterations++;
        } else {
          ctx.lastIterationFailureKey = iterationFailKey;
          ctx.consecutiveFailureIterations = 1;
        }
        const circuitBreakerThreshold = circuitBreakerThresholdForFailures(failedCalls);
        if (ctx.consecutiveFailureIterations >= circuitBreakerThreshold) {
          const toolNames = [...new Set(failedCalls.map(fc => fc.name))];
          const details: RepeatedToolFailureDetails = {
            type: "repeated_tool_failure",
            toolNames,
            consecutiveFailures: ctx.consecutiveFailureIterations,
            failedCalls: failedCalls.map(fc => ({ name: fc.name, args: fc.args, error: fc.result })),
          };
          const summary = formatAbortDetails(details) || `Repeated tool failure: ${toolNames.join(", ")}`;
          log.error(
            "executor.repeated_tool_failure",
            attributableExecutorError(
              `Repeated tool failure: tool(s) "${toolNames.join(", ")}" failed identically across ${ctx.consecutiveFailureIterations} consecutive iterations`,
              "EXECUTOR_REPEATED_TOOL_FAILURE",
            ),
            {
              operation: "repeated_tool_failure",
              runId: ctx.runId,
              toolNames,
              consecutiveFailures: ctx.consecutiveFailureIterations,
              circuitBreakerThreshold,
              pureTransientBatch: failedCalls.every((fc) => fc.failureKind === "transient"),
              details: safeStringify(details, {
                maxBytes: 8 * 1024,
                label: "agent-executor.repeatedToolFailure.log",
              }),
            },
          );
          eventBus.publish({
            category: "agent",
            event: "agent.repeated_tool_failure",
            payload: {
              runId: ctx.runId,
              toolNames,
              consecutiveFailures: ctx.consecutiveFailureIterations,
              failedCalls: details.failedCalls,
            },
            runId: ctx.runId,
            sessionKey: options.sessionKey,
          });
          ctx.abortReason = "circuit_breaker";
          ctx.abortDetails = details;
          ctx.aborted = true;
          ctx.publish("error", { error: summary });
          return { finalContent: cleanText, shouldContinue: false, hasRunMidTurnHistoryHardTrim, exitCause: "circuit_breaker" };
        }
      } else {
        ctx.lastIterationFailureKey = undefined;
        ctx.consecutiveFailureIterations = 0;
      }

      // Always continue after tools unless an explicit handler continuation
      // (await_user / provider_system_tool) or circuit breaker already returned.
      // sideEffectOnly is telemetry/classification only — never a loop stop signal.
      // AGENTS.md: do not emulate continuation boundaries with side-effect-only classification.
      ctx.publish("tool_use_pause", { content: "" });
      return { finalContent: cleanText, shouldContinue: true, hasRunMidTurnHistoryHardTrim, continuationType: "tool_call" };
    }

    if (ctx.iterationStopReason === "max_tokens" && cleanText.length > 0) {
      log.debug(`max_tokens hit — continuing runId=${ctx.runId} partialLength=${cleanText.length}`);
      messages.push({ role: "assistant", content: ctx.iterationText });
      messages.push({ role: "user", content: "[System: Your previous response reached the provider output boundary. Continue exactly where you left off. Do not repeat what you already said.]" });
      return { finalContent: cleanText, shouldContinue: true, hasRunMidTurnHistoryHardTrim, continuationType: "max_tokens" };
    }

    // Defensive: session.end / set_status=saved may have already marked the
    // session complete even if the continuation discriminant was dropped by a
    // transport path. Prefer intentional silent completion over empty_response
    // degradation when durable terminal status is already requested as saved.
    if (
      cleanText.trim().length === 0 &&
      ctx.pendingToolCalls.length === 0 &&
      !ctx.aborted &&
      !ctx.intentionallyCompletedSession &&
      options.sessionId
    ) {
      const pendingEnd = this.peekPendingSessionEnd(options.sessionId);
      if (pendingEnd?.status === "saved") {
        ctx.intentionallyCompletedSession = true;
        log.log(
          `session-complete inferred from pending saved end runId=${ctx.runId} sessionId=${options.sessionId}`,
        );
        return {
          finalContent: cleanText,
          shouldContinue: false,
          hasRunMidTurnHistoryHardTrim,
          exitCause: "natural_stop",
        };
      }
    }

    // Empty final turn: the model completed with no tool calls, no await-user
    // pause, no intentional session.end completion, and no visible text. This is
    // never a clean success — it is a known provider failure mode (Grok/xAI
    // end_turn with 0 output tokens after a long tool-use sequence; cline #6269,
    // litellm #17136; same class on DeepSeek #1453 and GPT-4o). Attempt 1 is a
    // pure re-sample on the UNCHANGED context (executeIteration resets
    // iterationText/pendingToolCalls). Later attempts inject a continuation
    // nudge — same pattern as max_tokens recovery — because pure re-samples
    // often stay empty on Grok after long tool sequences. We deliberately do
    // NOT push the empty assistant turn back into `messages` — xAI 400s on
    // empty-content history ("Each message must have at least one content
    // element", n8n #14797) — and empty finalContent is never appended to
    // iterationResults, so the merge is untouched. If retries are exhausted,
    // publishRunResult classifies only fully blank runs as empty_response.
    if (
      cleanText.trim().length === 0 &&
      ctx.pendingToolCalls.length === 0 &&
      !ctx.aborted &&
      !ctx.intentionallyCompletedSession &&
      ctx.emptyFinalTurnRetries < MAX_EMPTY_FINAL_TURN_RETRIES
    ) {
      ctx.emptyFinalTurnRetries++;
      const injectNudge = ctx.emptyFinalTurnRetries >= 2;
      if (injectNudge) {
        messages.push({ role: "user", content: EMPTY_FINAL_TURN_NUDGE });
      }
      log.warn(
        `agent.loop.empty_final_turn_retry runId=${ctx.runId} sessionId=${options.sessionId || "none"} ` +
        `attempt=${ctx.emptyFinalTurnRetries}/${MAX_EMPTY_FINAL_TURN_RETRIES} ` +
        `nudge=${injectNudge} lastStopReason=${ctx.diagnosticLastModelStopReason} ` +
        `lastStep=${ctx.diagnosticLastStep ?? "none"} model=${ctx.resolvedModel}`,
      );
      eventBus.publish({
        category: "agent",
        event: "agent.loop.empty_final_turn_retry",
        payload: {
          runId: ctx.runId,
          sessionId: options.sessionId || null,
          attempt: ctx.emptyFinalTurnRetries,
          maxAttempts: MAX_EMPTY_FINAL_TURN_RETRIES,
          nudge: injectNudge,
          lastStopReason: ctx.diagnosticLastModelStopReason,
          lastStep: ctx.diagnosticLastStep ?? null,
          model: ctx.resolvedModel,
          source: options.activity || "agent",
        },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });
      return { finalContent: "", shouldContinue: true, hasRunMidTurnHistoryHardTrim };
    }

    if (ctx.convergence.terminalRequired) {
      eventBus.publish({
        category: "agent",
        event: "agent.run_convergence_terminal_outcome",
        payload: {
          runId: ctx.runId,
          sessionId: options.sessionId || null,
          iteration: ctx.iteration,
          noProgressCycles: ctx.convergence.noProgressCycles,
          repeatedSignatures: Math.max(0, ...ctx.convergence.signatureCounts.values()),
          progressEvidence: ctx.convergence.lastProgressEvidence,
          terminalReason: ctx.convergence.terminalReason || "unknown",
          terminalOutcome: /\b(blocked|need|clarif|dependency)\b/i.test(cleanText)
            ? "blocked"
            : /\b(fail|unable|cannot)\b/i.test(cleanText)
              ? "fail"
              : "synthesize",
        },
        runId: ctx.runId,
        sessionKey: options.sessionKey,
      });
    }
    return { finalContent: cleanText, shouldContinue: false, hasRunMidTurnHistoryHardTrim, exitCause: "natural_stop" };
  }

  async run(options: ExecutorRunOptions): Promise<ExecutorRunResult> {
    const initialized = await this.initializeRun(options);
    const { runId, abortController, startTime, ctx } = initialized;
    let {
      modelString,
      maxTokens,
      outputReserveTokens,
      outputReserveIsExplicit,
      thinkingBudget,
      thinking,
      routingTier,
      routingDecision,
    } = initialized;

    const messages = [...options.messages];
    let hasRunMidTurnHistoryHardTrim = false;
    const iterationResults: Array<{ content: string; continuationType?: "tool_call" | "max_tokens" }> = [];

    const tier = options.tier ?? (options.querySubsystem === "autonomous" ? "background" as const : "communication" as const);
    const capacityOwner = options.capacityOwner ?? { kind: "legacy_admission" as const };
    const { admissionController } = await import("./run-admission");
    const { withAdmissionTier } = await import("./db");
    let admissionGranted = false;

    const admissionQueuedAt = Date.now();
    log.debug(
      `autonomous.lifecycle phase=admission-requested runId=${runId} sessionId=${options.sessionId ?? "none"} ` +
      `tier=${tier} activity=${options.activity ?? "none"}`,
    );

    const runBody = async (): Promise<ExecutorRunResult> => {
    try {
      if (capacityOwner.kind === "legacy_admission") {
        await admissionController.requestSlot(tier, runId, {
          sessionId: options.sessionId,
          activity: options.activity,
          lineageId: options.lineageId ?? options.sessionId,
          signal: abortController.signal,
        });
        admissionGranted = true;
      } else {
        log.debug(
          `autonomous.lifecycle phase=runtime-capacity-owned runId=${runId} runtimeRunId=${capacityOwner.runId} ` +
          `runtimeAttemptId=${capacityOwner.attemptId}`,
        );
      }
      const admittedAt = Date.now();
      const activeRun = this.activeRuns.get(runId);
      if (activeRun) {
        activeRun.admitted = true;
        activeRun.startedAt = admittedAt;
        activeRun.lastActivityAt = admittedAt;
      }
      const admissionWaitMs = admittedAt - admissionQueuedAt;
      if (admissionWaitMs > 1000) {
        log.log(`Admission granted for ${tier} run ${runId} after ${admissionWaitMs}ms wait`);
      } else {
        log.debug(`Admission granted for ${tier} run ${runId} (${admissionWaitMs}ms)`);
      }
      eventBus.publish({
        category: "agent",
        event: "agent.stage_timing",
        payload: {
          runId,
          sessionId: options.sessionId || null,
          stage: "admission",
          outcome: "succeeded",
          durationMs: admissionWaitMs,
          capacityOwner: capacityOwner.kind,
          tier,
          source: options.activity || "agent",
        },
        runId,
        sessionKey: options.sessionKey,
      });
      // Notify upstream (skill runner) that admission is granted so it can
      // start its inactivity timer at the right moment.
      options.onEvent?.({ type: "admitted" } as any);

      const { chatCompletionStream } = await import("./model-client");
      let contextBudget = getContextRequestBudget(
        getContextWindow(modelString),
        outputReserveTokens,
        outputReserveIsExplicit,
      );
      let lastExitCause: "natural_stop" | "aborted" | "circuit_breaker" | "yield_to_interactive" | undefined;

      while (true) {
        if (ctx.iteration >= ctx.budgets.maxIterations) {
          ctx.budgetExhaustion ??= {
            kind: "iterations",
            limit: ctx.budgets.maxIterations,
            used: ctx.iteration,
          };
          lastExitCause = "natural_stop";
          log.warn(
            `agent.loop.budget_exhausted runId=${runId} sessionId=${options.sessionId || "none"} ` +
            `kind=iterations limit=${ctx.budgets.maxIterations} used=${ctx.iteration}`,
          );
          break;
        }
        if (ctx.budgetExhaustion) {
          lastExitCause = "natural_stop";
          break;
        }
        if (abortController.signal.aborted) {
          ctx.aborted = true;
          ctx.abortReason ??= getAbortReason(abortController.signal);
          lastExitCause = "aborted";
          break;
        }

        if (capacityOwner.kind === "legacy_admission" && admissionController.isYieldRequested(runId)) {
          lastExitCause = "yield_to_interactive";
          log.debug(`run YIELD runId=${runId} tier=${tier} — yielding to higher-priority run at iteration ${ctx.iteration}`);
          break;
        }

        const hydratedProviderTools = ctx.convergence.terminalRequired ? [] : options.tools;
      const hydratedProviderToolNames = new Set(hydratedProviderTools.map((tool) => tool.name));
      const providerToolDefinitions = [
        ...hydratedProviderTools,
        ...(options.authorityStubTools || []).filter(
          (tool) => !hydratedProviderToolNames.has(tool.name),
        ),
      ];
      const toolDefinitionTokens = estimateToolDefinitionTokens(providerToolDefinitions);
        const result = await this.executeIteration(
          messages,
          ctx,
          options,
          abortController,
          modelString,
          maxTokens,
          thinkingBudget,
          thinking,
          routingTier,
          routingDecision,
          chatCompletionStream,
          contextBudget,
          toolDefinitionTokens,
          hasRunMidTurnHistoryHardTrim,
        );
        if (result.finalContent) {
          iterationResults.push({
            content: result.finalContent,
            continuationType: result.shouldContinue ? result.continuationType : undefined,
          });
        }
        hasRunMidTurnHistoryHardTrim = result.hasRunMidTurnHistoryHardTrim;

        if (result.toolSchemaRefreshRequested) {
          if (!options.refreshToolSchema) {
            throw new Error("Tool schema hydration requested, but no refresh handler is configured");
          }
          const requestedTool = result.toolSchemaRefreshRequested.toolName;
          const schema = await options.refreshToolSchema(requestedTool);
          if (!schema) {
            throw new Error(`Tool schema unavailable after successful documentation lookup: ${requestedTool}`);
          }
          const existingTools = options.tools ?? [];
          const existingIndex = existingTools.findIndex((tool) => tool.name === schema.name);
          if (existingIndex >= 0) {
            existingTools[existingIndex] = schema;
          } else {
            existingTools.push(schema);
          }
          ctx.publish("system_step", {
            step: "tool_schema_refresh",
            status: "done",
            detail: schema.name,
            metadata: {
              tool: schema.name,
              toolCount: existingTools.length,
            },
          });
          log.log(`tool schema hydrated runId=${runId} sessionId=${options.sessionId || "none"} tool=${schema.name} toolCount=${existingTools.length}`);
        }

        // Auto-hydrate: load the real schema for any authority-allowed tool the
        // model called directly via a stub this iteration, so subsequent calls in
        // the turn are fully typed. Best-effort — a miss here never breaks the run.
        if (ctx.autohydratePending.size > 0) {
          const existingTools = options.tools ?? [];
          for (const toolName of ctx.autohydratePending) {
            if (ctx.autohydratedToolNames.has(toolName)) continue;
            ctx.autohydratedToolNames.add(toolName);
            if (!options.refreshToolSchema) continue;
            try {
              const schema = await options.refreshToolSchema(toolName);
              if (!schema) {
                log.warn(`autohydrate: no authority schema for "${toolName}" runId=${runId} — leaving stub in place`);
                continue;
              }
              const existingIndex = existingTools.findIndex((tool) => tool.name === schema.name);
              if (existingIndex >= 0) existingTools[existingIndex] = schema;
              else existingTools.push(schema);
              log.log(`autohydrate: real schema loaded runId=${runId} sessionId=${options.sessionId || "none"} tool=${schema.name} toolCount=${existingTools.length}`);
            } catch (err) {
              log.warn(`autohydrate: schema load failed tool="${toolName}" runId=${runId} err=${err instanceof Error ? err.message : String(err)}`);
            }
          }
          ctx.autohydratePending.clear();
        }

        if (result.personaSwitchRequested) {
          const sessionIdForRefresh = options.sessionId?.trim();
          if (!sessionIdForRefresh) {
            throw new Error(
              "Persona changed mid-turn, but this run has no sessionId — cannot re-resolve routing, prompt, or tools",
            );
          }
          const previousModel = modelString;
          const previousPersonaId = routingDecision.personaId;
          const { refreshRunAfterPersonaSwitch } = await import("./persona-switch");
          const refreshExtras = options.personaSwitchRefresh ?? {};
          const refreshed = await refreshRunAfterPersonaSwitch({
            sessionId: sessionIdForRefresh,
            activity: options.activity || "agent",
            contextBuildId: `${runId}:persona-refresh`,
            sessionKey: options.sessionKey,
            origin: refreshExtras.origin,
            trustedDelegation: refreshExtras.trustedDelegation,
            skillId: refreshExtras.skillId,
            skillName: refreshExtras.skillName,
            mayInitiateConversation: refreshExtras.mayInitiateConversation,
            runtimeRunId: refreshExtras.runtimeRunId
              ?? (options.capacityOwner?.kind === "runtime" ? options.capacityOwner.runId : undefined),
            runtimeAttemptId: refreshExtras.runtimeAttemptId
              ?? (options.capacityOwner?.kind === "runtime" ? options.capacityOwner.attemptId : undefined),
            callType: refreshExtras.callType,
            includeSections: refreshExtras.includeSections,
            excludeSections: refreshExtras.excludeSections,
            profile: refreshExtras.profile,
            conversationHistory: refreshExtras.conversationHistory,
            currentMessage: refreshExtras.currentMessage,
            meetingContext: refreshExtras.meetingContext,
          });
          routingDecision = refreshed.routingDecision;
          modelString = routingDecision.modelString;
          routingTier = routingDecision.tier;
          const tierThinking: ThinkingTierConfig = options.thinking
            ? options.thinking
            : options.thinkingBudget !== undefined
              ? thinkingBudgetToTier(options.thinkingBudget)
              : { type: "disabled" };
          const parsedModel = modelString.includes("/") ? modelString.split("/").slice(1).join("/") : modelString;
          thinking = resolveThinkingConfig(parsedModel, tierThinking);
          thinkingBudget = thinking.thinking.type === "enabled" ? (thinking.thinking.budgetTokens ?? 0) : 0;
          const { getMaxOutputTokens } = await import("./model-registry");
          maxTokens = getMaxOutputTokens(parsedModel);
          // Re-apply the per-tier Claude CLI output cap after a persona/model switch
          // so the recomputed budget keeps honoring the configured output ceiling.
          const cliCapAfterSwitch = routingDecision.provider === "claude-cli"
            ? (routingDecision.modelConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens
            : undefined;
          if (cliCapAfterSwitch) maxTokens = Math.min(maxTokens, cliCapAfterSwitch);
          // Re-derive the explicit output-reserve signal for the switched model/tier.
          const configuredMaxOutputAfterSwitch = (routingDecision.modelConfig as { maxOutputTokens?: number } | undefined)?.maxOutputTokens;
          outputReserveIsExplicit = typeof configuredMaxOutputAfterSwitch === "number" && configuredMaxOutputAfterSwitch > 0;
          outputReserveTokens = outputReserveIsExplicit ? (configuredMaxOutputAfterSwitch as number) : maxTokens;
          ctx.responseGenerationLimit.configuredOutputTokens = maxTokens;
          contextBudget = getContextRequestBudget(
            getContextWindow(modelString),
            outputReserveTokens,
            outputReserveIsExplicit,
          );
          const systemIndex = messages.findIndex((message) => message.role === "system");
          const systemMessage: ExecutorMessage = { role: "system", content: refreshed.systemPrompt };
          if (systemIndex >= 0) messages[systemIndex] = systemMessage;
          else messages.unshift(systemMessage);
          // A persona switch enhances persona gating; it must never lobotomize
          // the run. If the refreshed set is empty or drops a core tool that was
          // callable before the switch (e.g. a degraded authority resolution at
          // refresh time), keep the last known-good set so orient/tools/session
          // survive and the run can still recover. Fail loudly, degrade gracefully.
          const { reconcilePersonaSwitchToolSet } = await import("./tool-registry");
          const previousToolSet = options.tools ?? [];
          const reconciled = reconcilePersonaSwitchToolSet(previousToolSet, refreshed.tools);
          options.tools = [...reconciled.tools];
          if (reconciled.degraded) {
            log.warn(
              `persona switch tool refresh degraded — retained prior set runId=${runId} sessionId=${options.sessionId || "none"} refreshedCount=${refreshed.tools.length} retainedCount=${options.tools.length} missingCore=${reconciled.missingCore.join(",") || "none"}`,
            );
            ctx.publish("system_step", {
              step: "persona_switch",
              status: "done",
              detail: `Tool refresh degraded — retained ${options.tools.length} prior tools (missing core: ${reconciled.missingCore.join(", ") || "none"})`,
              metadata: {
                degraded: true,
                refreshedCount: refreshed.tools.length,
                retainedCount: options.tools.length,
                missingCore: reconciled.missingCore,
              },
            });
          }
          ctx.modelString = modelString;
          ctx.resolvedModel = modelString;
          ctx.resolvedProvider = routingDecision.provider;
          ctx.routingDecision = routingDecision;
          ctx.routingTier = String(routingTier);
          const activeRun = this.activeRuns.get(runId);
          if (activeRun) activeRun.model = modelString;
          ctx.publish("model_info", {
            model: modelString,
            autoTier: String(routingTier),
            persona: refreshed.persona,
          });
          ctx.publish("system_step", {
            step: "persona_switch",
            status: "done",
            detail: `${refreshed.persona?.name || "Persona"} · ${previousModel} → ${modelString}`,
            metadata: {
              previousModel,
              model: modelString,
              previousPersonaId,
              personaId: refreshed.persona?.id,
              tier: routingTier,
            },
          });
          log.log(`persona switch applied runId=${runId} sessionId=${options.sessionId || "none"} persona=${refreshed.persona?.name || "unknown"} model=${previousModel}->${modelString} tier=${routingTier} toolCount=${options.tools.length}`);
        }

        if (ctx.terminalToolFailure) {
          lastExitCause = "natural_stop";
          break;
        }
        if (!result.shouldContinue) {
          const shouldRequestMissionCompletionAssertion =
            options.requireExplicitMissionCompletion === true &&
            result.exitCause === "natural_stop" &&
            !ctx.intentionallyCompletedSession &&
            !ctx.intentionallyAwaitingUser &&
            !ctx.aborted &&
            !ctx.budgetExhaustion &&
            !ctx.terminalToolFailure &&
            ctx.missionCompletionAssertionRetries < 1;
          if (shouldRequestMissionCompletionAssertion) {
            ctx.missionCompletionAssertionRetries++;
            if (result.finalContent) {
              messages.push({ role: "assistant", content: result.finalContent });
            }
            messages.push({
              role: "user",
              content: "[System: This Plan mission has not emitted an explicit terminal outcome. If the assigned work is complete, call session(action: \"end\") now with a concise completion summary. If it cannot complete, call plan(action: \"update_step\") for this exact step with status \"blocked\" or \"needs_review\" and a specific outcome. Do not merely describe completion or repeat prior work.]",
            });
            log.warn(
              `plan mission completion assertion requested runId=${runId} sessionId=${options.sessionId || "none"} retry=${ctx.missionCompletionAssertionRetries}`,
            );
            continue;
          }
          lastExitCause = result.exitCause;
          break;
        }
      }

      let terminationReason: TerminationReason;
      if (lastExitCause === "yield_to_interactive") {
        terminationReason = "yield_to_interactive";
      } else if (lastExitCause === "aborted") {
        terminationReason = "aborted";
      } else if (lastExitCause === "circuit_breaker") {
        terminationReason = "circuit_breaker";
      } else if (lastExitCause === "natural_stop") {
        terminationReason = "complete";
      } else {
        terminationReason = "complete";
      }

      // Merge every visible per-iteration response using the same separator
      // encoded into segment chronology at each later iteration boundary.
      const finalContent = mergeIterationResults(iterationResults);

      log.debug(`pre-publishRunResult runId=${runId} terminationReason=${terminationReason} elapsedMs=${Date.now() - startTime}`);
      // Persist terminal state BEFORE we drain — if the drain blows the grace
      // budget we still want users to see a final status, not a phantom
      // "in progress" run pinned to a leaked subprocess.
      const result = await this.publishRunResult(ctx, options, startTime, finalContent, terminationReason);
      log.debug(`post-publishRunResult runId=${runId} elapsedMs=${Date.now() - startTime}`);
      if (ctx.aborted || terminationReason === "aborted") {
        abortTrace("agent_executor.inflight_completed", {
          runId,
          sessionId: options.sessionId,
          sessionKey: options.sessionKey,
          reason: ctx.abortReason || terminationReason,
          ms: Date.now() - startTime,
        }, "warn");
      }
      return result;
    } catch (err: unknown) {
      const errorMsg = (err instanceof Error ? err.message : String(err)) || "Executor error";
      // Preserve the FULL stack, not just the message. For a runtime circular-
      // import TDZ ("Cannot access 'X' before initialization") the stack frame is
      // the only artifact that names the offending module — even minified, the
      // bundled symbol maps to one source module. errorMsg alone discards it.
      const errorStack = err instanceof Error && err.stack ? err.stack : undefined;

      // An AbortSignal can make the model adapter throw before the stream loop
      // observes the signal. Preserve the controller's canonical reason here
      // instead of misclassifying an intentional watchdog/cancellation stop as
      // an internal executor error.
      if (abortController.signal.aborted) {
        ctx.aborted = true;
        if (!ctx.abortReason) {
          ctx.abortReason = getAbortReason(abortController.signal);
        }
        const terminationReason: TerminationReason =
          ctx.abortReason === "circuit_breaker" ? "circuit_breaker" : "aborted";
        const finalContent = mergeIterationResults(iterationResults);
        log.warn(
          `run stopped runId=${runId} model=${modelString} abortReason=${ctx.abortReason} durationMs=${Date.now() - startTime}: ${errorMsg}`,
        );
        return await this.publishRunResult(
          ctx,
          options,
          startTime,
          finalContent,
          terminationReason,
        );
      }

      // The provider boundary owns ModelProviderError telemetry. Re-logging the
      // same Error here creates a second product fingerprint; stack/trace and
      // terminal decision are diagnostic fields on the canonical event, not
      // independent failures.
      if (err instanceof ModelProviderError) {
        log.warn("executor.run_provider_failure", {
          operation: "run_provider_failure",
          runId,
          model: modelString,
          providerCode: err.code,
          providerKind: err.kind,
          providerPhase: err.phase,
          retryable: err.retryable,
          attempts: err.attempts,
          lastStep: ctx.diagnosticLastStep ?? "none",
          execTrace: safeStringify(ctx.execTrace ? ctx.execTrace.slice(-40) : [], {
            maxBytes: 8192,
            label: "agent-executor.execTrace",
          }),
        });
      } else {
        const runError = attributableExecutorError(err instanceof Error ? err : errorMsg, "EXECUTOR_RUN_ERROR");
        log.error(
          "executor.run_error",
          runError,
          {
            operation: "run_error",
            runId,
            model: modelString,
            abortReason: ctx.abortReason ?? "none",
            errorStack: errorStack ? errorStack.slice(0, 4000) : undefined,
            lastStep: ctx.diagnosticLastStep ?? "none",
            execTrace: safeStringify(ctx.execTrace ? ctx.execTrace.slice(-40) : [], {
              maxBytes: 8192,
              label: "agent-executor.execTrace",
            }),
          },
        );
      }
      if (!ctx.providerFailure) {
        ctx.publish("error", { error: errorMsg });
      }

      const terminalDecision = {
        runId,
        sessionId: options.sessionId || null,
        status: "error",
        reason: "error",
        iterations: ctx.iteration,
        durationMs: Date.now() - startTime,
        lastStep: ctx.diagnosticLastStep || "terminal",
        lastStopReason: ctx.diagnosticLastModelStopReason || null,
        lastToolCallId: ctx.diagnosticLastToolCallId || null,
        hadToolErrors: ctx.diagnosticHadToolErrors,
        failedToolCount: ctx.diagnosticFailedToolCount,
        assistantTextLength: mergeIterationResults(iterationResults).length,
        lastAssistantTextLength: ctx.diagnosticLastAssistantTextLength,
        error: errorMsg,
        errorStack: errorStack ? errorStack.slice(0, 4000) : undefined,
        execTrace: ctx.execTrace ? ctx.execTrace.slice(-40) : undefined,
        providerFailure: ctx.providerFailure,
        source: options.activity || "agent",
      };
      log.log(
        `agent.run.terminal_decision ${safeStringify(terminalDecision, {
          maxBytes: 4096,
          label: "agent-executor.terminalDecision.error",
        })}`,
      );
      eventBus.publish({
        category: "agent",
        event: "agent.run.terminal_decision",
        payload: terminalDecision,
        runId,
        sessionKey: options.sessionKey,
      });
      eventBus.publish({
        category: "agent",
        event: "agent.run.error",
        payload: { ...terminalDecision, error: errorMsg },
        runId,
        sessionKey: options.sessionKey,
      });

      // A replay-unsafe provider failure may arrive after visible text. The
      // provider cascade correctly refuses to replay at that point; preserve
      // the exact accumulated text as terminal content instead of allowing an
      // empty terminal result to erase the streamed chronology.
      const interruptedProviderContent = this.preserveInterruptedProviderOutput(ctx);
      const terminalContent = interruptedProviderContent || mergeIterationResults(iterationResults) || "";

      return {
        status: "failed" as const,
        lastStopReason: ctx.diagnosticLastModelStopReason,
        content: terminalContent,
        thinking: ctx.allThinking.join("\n\n"),
        toolCalls: ctx.resolvedToolCalls,
        model: ctx.resolvedModel,
        provider: ctx.resolvedProvider,
        usage: ctx.totalUsage,
        iterations: ctx.iteration,
        terminationReason: "error",
        durationMs: Date.now() - startTime,
        aborted: abortController.signal.aborted,
        abortReason: ctx.abortReason || "error",
        abortDetails: ctx.abortDetails,
        error: errorMsg,
        providerFailure: ctx.providerFailure,
        streamDiagnostics: ctx.lastStreamDiagnostics,
        segmentChronology: ctx.segmentChronology.length > 0 ? ctx.segmentChronology : undefined,
        systemSteps: ctx.systemStepsData.length > 0 ? ctx.systemStepsData : undefined,
      };
    } finally {
      // CRITICAL ORDERING: drain owned background work FIRST, then release the
      // admission slot, then forget the run. This is the whole fix: an idle-
      // timeout abort that kills the iteration must NOT report its slot as free
      // while the CLI subprocess + cost-log inserts the iteration spawned are
      // still consuming resources, because that's what lets the next admitted
      // run pile on top and wedge the pool. The drain is bounded by
      // POST_ABORT_DRAIN_GRACE_MS so a permanently hung CLI cannot pin the
      // slot forever — at grace expiry we log loudly and release anyway.
      try {
        await this.drainBackgroundWork(ctx, runId, startTime);
      } catch (drainErr: unknown) {
        const msg = drainErr instanceof Error ? drainErr.message : String(drainErr);
        log.error(
          "executor.drain_background_threw",
          attributableExecutorError(drainErr instanceof Error ? drainErr : msg, "EXECUTOR_DRAIN_BACKGROUND_THREW"),
          { operation: "drain_background_work", runId },
        );
      }
      if (admissionGranted) {
        await admissionController.releaseSlot(runId);
      }
      log.debug(
        `autonomous.lifecycle phase=executor-released runId=${runId} sessionId=${options.sessionId ?? "none"} ` +
        `tier=${tier} activity=${options.activity ?? "none"} elapsedMs=${Date.now() - startTime} ` +
        `admissionGranted=${admissionGranted}`,
      );
      // Mark settling BEFORE dropping activeRuns so monitors never observe a
      // gap where status can already be "saved" (session.end) but tools are
      // not yet durable in chat messages.
      this.beginSessionSettling(options.sessionId);
      this.activeRuns.delete(runId);
    }
    };

    return capacityOwner.kind === "runtime"
      ? withAdmissionTier(tier, runBody)
      : admissionController.withRunContext(runId, () => withAdmissionTier(tier, runBody));
  }
}

export const agentExecutor = new AgentExecutor();
