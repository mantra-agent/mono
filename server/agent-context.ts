// Use createLogger for logging ONLY
import { contextBuilder } from "./context-builder";
import type { ContextCallType, LlmMode, ContextRequest } from "../shared/context-spine";
import { getLocalTimeString } from "./timezone";
import { getModelForActivity, ACTIVITY_CHAT, ACTIVITY_FRAMING, ACTIVITY_VOICE, type ActivityId, type TierId } from "./job-profiles";
import { getContextWindow } from "./model-registry";
import { withTimeout, isTimeoutError, CONTEXT_ASSEMBLY_TIMEOUT_MS } from "./timeout";
import { createLogger } from "./log";
import { resolveCurrentProfileIdentity } from "./profile-identity";
import { isRecapFtueSession } from "./ftue-session";
import { getContextPressureThresholds } from "./context-budget";
import { CONTEXT_GROUPS, sectionIdsForEnabledGroups, sectionIdsForDisabledGroups, unionRootContextSections } from "../shared/persona-context";

const CONTEXT_GROUP_IDS = new Set<string>(CONTEXT_GROUPS);

const log = createLogger("AgentContext");

type AgentContextErrorCode =
  | "CONTEXT_COMPACTION_ARCHIVE_FAILED"
  | "CONTEXT_COMPACTION_FAILED"
  | "CONTEXT_COMPACTION_STATE_PERSIST_FAILED";

function attributableContextError(error: unknown, code: AgentContextErrorCode): Error & { code: string } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const coded = normalized as Error & { code: string };
  if (!/^[A-Z][A-Z0-9_]{1,48}$/.test(coded.code ?? "")) coded.code = code;
  return coded;
}

export type ContextProfile = "chat" | "voice" | "background";

export interface TokenBudget {
  maxContextTokens: number;
  systemPromptBudget: number;
  conversationBudget: number;
  reserveForResponse: number;
}

export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tokenEstimate: number;
  toolCallId?: string;
  toolCalls?: any[];
  thinking?: string;
}

export interface AssembledContext {
  systemPrompt: string;
  messages: ContextMessage[];
  tokenUsage: {
    systemPrompt: number;
    conversation: number;
    total: number;
    budget: number;
    remaining: number;
  };
  profile: ContextProfile;
  model: string;
  assembledAt: string;
}

function getContextLimit(model: string): number {
  const bareModel = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  return getContextWindow(bareModel);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

function getTokenBudget(model: string, profile: ContextProfile): TokenBudget {
  const maxContext = getContextLimit(model);
  const reserveForResponse = profile === "background" ? 2000 : 8000;

  const available = maxContext - reserveForResponse;

  const systemPromptBudget = Math.min(Math.floor(available * 0.35), 40000);
  const conversationBudget = available - systemPromptBudget;

  return {
    maxContextTokens: maxContext,
    systemPromptBudget,
    conversationBudget,
    reserveForResponse,
  };
}

function buildSystemPromptFromSpine(spinePrompt: string): string {
  return spinePrompt;
}

function truncateConversationHistory(
  messages: ContextMessage[],
  budget: number,
): ContextMessage[] {
  if (messages.length === 0) return [];

  let totalTokens = 0;
  for (const msg of messages) {
    totalTokens += msg.tokenEstimate;
  }

  if (totalTokens <= budget) return messages;

  log.log(`truncateConversationHistory: safety-net triggered totalTokens=${totalTokens} budget=${budget} messages=${messages.length}`);

  for (let keep = Math.min(messages.length, 10); keep >= 1; keep--) {
    const recent = messages.slice(-keep);
    let recentTokens = 0;
    for (const msg of recent) recentTokens += msg.tokenEstimate;
    if (recentTokens <= budget) {
      log.log(`truncateConversationHistory: keeping ${keep} most recent messages (${recentTokens} tokens)`);
      return recent;
    }
  }

  return [messages[messages.length - 1]];
}

/** Between-turn threshold on the usable hard-input scale. */
export function getBetweenTurnCompactionThreshold(hardInputLimit: number): number {
  return getContextPressureThresholds(hardInputLimit).betweenTurnHistoryReset;
}

type CompactableHistoryMessage = {
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    toolName?: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    output?: string;
    error?: boolean | string | Record<string, unknown>;
    toolCallId?: string;
  }>;
  publicRole?: "user" | "assistant";
  capsule?: import("@shared/models/chat").ContinuationCapsule;
  archiveRefId?: string;
  archiveDownloadable?: boolean;
};

function estimateHistoryTokens(msg: CompactableHistoryMessage): number {
  let tokens = estimateTokens(msg.content);
  if (msg.thinking) tokens += estimateTokens(msg.thinking);
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (typeof tc.result === "string") tokens += estimateTokens(tc.result);
      else if (tc.result != null) tokens += estimateTokens(JSON.stringify(tc.result));
    }
  }
  return tokens;
}

export type CompactionActivityStatus = "active" | "done" | "error";

export interface CompactionActivityUpdate {
  operationId: string;
  status: CompactionActivityStatus;
}

export type CompactionOutcome =
  | { outcome: "below_threshold" }
  | { outcome: "joined"; operationId: string; terminalOutcome: string }
  | {
      outcome: "compacted";
      operationId: string;
      markerId: string;
      archiveRefId: string;
    }
  | { outcome: "snapshot_changed"; operationId: string }
  | { outcome: "archive_failed"; operationId: string; reason: string }
  | { outcome: "failed"; operationId?: string; reason: string };

const COMPACTION_WALL_TIME_MS = 3 * 60_000;
const COMPACTION_JOIN_WAIT_MS = 3 * 60_000;

export async function runBetweenTurnCompaction(
  sessionId: string,
  conversationHistory: CompactableHistoryMessage[],
  hardInputLimit: number,
  callerGeneration?: number,
  onActivity?: (update: CompactionActivityUpdate) => void,
  /**
   * Full next-input estimate when the caller already measured it (preferred).
   * When omitted, falls back to history-only for join/retry paths that cannot
   * assemble the envelope — production chat should always pass fullInputTokens.
   */
  fullInputTokens?: number,
): Promise<CompactionOutcome> {
  const threshold = getBetweenTurnCompactionThreshold(hardInputLimit);
  let measuredTokens = 0;
  if (typeof fullInputTokens === "number" && Number.isFinite(fullInputTokens)) {
    measuredTokens = Math.max(0, Math.floor(fullInputTokens));
  } else {
    for (const msg of conversationHistory) {
      measuredTokens += estimateHistoryTokens(msg);
    }
  }

  if (measuredTokens <= threshold) {
    return { outcome: "below_threshold" };
  }

  log.log(
    `betweenTurnCompaction: triggered sessionId=${sessionId} measuredTokens=${measuredTokens} threshold=${threshold} measurand=${typeof fullInputTokens === "number" ? "raw_input" : "history_fallback"} messages=${conversationHistory.length}`,
  );

  const emitActivity = (update: CompactionActivityUpdate) => {
    try {
      onActivity?.(update);
    } catch (error) {
      log.warn(`betweenTurnCompaction: activity projection failed sessionId=${sessionId} operationId=${update.operationId} status=${update.status} error=${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // The persisted doc is the coordinate space for the whole operation.
  // Threshold is full-request model-space; split/archive/write-back key
  // off durable message IDs. Landing keeps the two newest committed context
  // messages; there is no history keep-budget path.
  const { chatFileStorage } = await import("./chat-file-storage");
  const docMessages = await chatFileStorage.getMessagesBySession(sessionId);

  const { buildCompactionSnapshot, isCommittedContextMessage } = await import(
    "./compaction-snapshot"
  );
  const snapshot = buildCompactionSnapshot(sessionId, docMessages);
  if (!snapshot) return { outcome: "below_threshold" };
  const removed = [...snapshot.removedMessages];
  const boundaryIndex = removed.length;
  const removedMessageIds = [...snapshot.removedMessageIds];

  const {
    claimCompactionOperation,
    transitionCompactionOperation,
    waitForCompactionOperation,
  } = await import("./compaction-operation-storage");
  const claim = await claimCompactionOperation({ snapshot, callerGeneration });
  emitActivity({ operationId: claim.operation.id, status: "active" });
  if (claim.outcome === "joined") {
    try {
      const terminal = await waitForCompactionOperation(
        claim.operation.id,
        COMPACTION_JOIN_WAIT_MS,
      );
      const terminalOutcome = terminal.outcome ?? terminal.status;
      if (
        terminalOutcome === "snapshot_changed" ||
        terminal.status === "superseded"
      ) {
        emitActivity({ operationId: terminal.id, status: "done" });
        return { outcome: "snapshot_changed", operationId: terminal.id };
      }
      if (terminalOutcome === "archive_failed") {
        emitActivity({ operationId: terminal.id, status: "error" });
        return {
          outcome: "archive_failed",
          operationId: terminal.id,
          reason: terminal.failureReason ?? "archive_failed",
        };
      }
      if (terminal.status === "failed") {
        emitActivity({ operationId: terminal.id, status: "error" });
        return {
          outcome: "failed",
          operationId: terminal.id,
          reason: terminal.failureReason ?? "compaction_failed",
        };
      }
      emitActivity({ operationId: terminal.id, status: "done" });
      return {
        outcome: "joined",
        operationId: terminal.id,
        terminalOutcome,
      };
    } catch (error) {
      emitActivity({ operationId: claim.operation.id, status: "error" });
      return {
        outcome: "failed",
        operationId: claim.operation.id,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const operationId = claim.operation.id;
  const operationAttempt = claim.operation.attemptCount;
  const operationStartedAt = Date.now();
  const deadlineAt = operationStartedAt + COMPACTION_WALL_TIME_MS;

  const { encodeCompactionArchive, COMPACTION_ARCHIVE_FORMAT } = await import("./compaction-archive");
  const serialized = encodeCompactionArchive(
    sessionId,
    removed.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking ?? undefined,
      toolCalls: Array.isArray(m.toolCalls) ? m.toolCalls : undefined,
      publicRole:
        m.role === "user" || m.role === "assistant" ? m.role : undefined,
      archiveRefId: m.compaction?.archiveRefId,
      record: m,
    })),
    claim.operation.createdAt.toISOString(),
  );
  const archiveDownloadable = removed.every(
    (m) => !m.compaction?.archiveRefId || m.compaction?.archiveDownloadable === true,
  );
  if (serialized.length < 200) {
    await transitionCompactionOperation(operationId, operationAttempt, "superseded", {
      outcome: "snapshot_changed",
      failureReason: "archive_payload_too_small",
    });
    emitActivity({ operationId, status: "done" });
    return { outcome: "snapshot_changed", operationId };
  }

  const estimateDocTokens = (m: (typeof docMessages)[number]): number => {
    let tokens = estimateTokens(m.content);
    if (m.thinking) tokens += estimateTokens(m.thinking);
    if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls as Array<Record<string, unknown>>) {
        const result = tc?.result ?? tc?.output;
        if (typeof result === "string") tokens += estimateTokens(result);
        else if (result != null) tokens += estimateTokens(JSON.stringify(result));
      }
    }
    return tokens;
  };
  const totalTokens = docMessages.reduce(
    (sum, message) =>
      isCommittedContextMessage(message) ? sum + estimateDocTokens(message) : sum,
    0,
  );

  try {
    await transitionCompactionOperation(operationId, operationAttempt, "archiving");
    const { indexAndArchiveHeuristic } = await import("./content-indexer");
    const archiveRef = await indexAndArchiveHeuristic({
      content: serialized,
      sourceType: "compaction",
      sourceLabel: `session:${sessionId} (${removed.length} messages)`,
      operationKey: operationId,
      objectFileName: `${operationId}.txt`,
    });
    if (!archiveRef) {
      const reason = "exact_archive_unavailable";
      await transitionCompactionOperation(operationId, operationAttempt, "failed", {
        outcome: "archive_failed",
        failureReason: reason,
      });
      emitActivity({ operationId, status: "error" });
      log.error(
        "betweenTurnCompaction.exact_archive_unavailable",
        attributableContextError(reason, "CONTEXT_COMPACTION_ARCHIVE_FAILED"),
        { operation: "between_turn_compaction.archive", sessionId, operationId },
      );
      return { outcome: "archive_failed", operationId, reason };
    }
    await transitionCompactionOperation(operationId, operationAttempt, "summarizing", {
      archiveRefId: archiveRef.id,
      archiveObjectPath: archiveRef.objectStoragePath,
      archiveBytes: archiveRef.byteCount,
    });

    const { buildContinuationCapsule, renderContinuationCapsule } = await import("./continuation-capsule");
    const capsuleEntries = removed.flatMap((m) => {
      const isMarker = m.role === "system" && m.model === "compaction-marker";
      const entries: import("./continuation-capsule").ContinuationCapsuleEntry[] =
        isMarker && m.compaction?.capsule
          ? []
          : [{
              role:
                m.role === "user" || m.role === "assistant" || m.role === "system"
                  ? m.role
                  : "system",
              content: m.content,
            }];
      if (Array.isArray(m.toolCalls)) {
        for (const toolCall of m.toolCalls as Array<Record<string, unknown>>) {
          entries.push({
            role: "tool",
            toolName: toolCall?.toolName as string | undefined,
            toolArguments: toolCall?.arguments as Record<string, unknown> | undefined,
            toolResult: toolCall?.result ?? toolCall?.output,
            toolCallId: toolCall?.toolCallId as string | undefined,
            isError: Boolean(toolCall?.error),
          });
        }
      }
      return entries;
    });
    const previousCapsule = removed.find((m) => m.compaction?.capsule)?.compaction?.capsule;
    // The newest user message stays live in the kept tail (never archived), so
    // it is absent from the compacted batch above. Surface it explicitly as the
    // capsule's authoritative latest instruction so the summary reinforces the
    // user's freshest steering instead of a stale resume point.
    const keptTailForInstruction = docMessages.slice(boundaryIndex);
    let liveLatestUserInstruction: string | undefined;
    for (let i = keptTailForInstruction.length - 1; i >= 0; i -= 1) {
      const candidate = keptTailForInstruction[i]?.content;
      if (keptTailForInstruction[i]?.role === "user" && candidate && candidate.trim()) {
        liveLatestUserInstruction = candidate;
        break;
      }
    }
    const capsule = buildContinuationCapsule(capsuleEntries, previousCapsule, {
      latestUserInstruction: liveLatestUserInstruction,
    });
    const capsuleContent = renderContinuationCapsule(capsule);

    // Narrative summary is the primary artifact for both agent context and UI.
    // The deterministic capsule is grounding input and the degraded fallback;
    // summarizer failure never blocks compaction.
    let summaryBody = capsuleContent;
    let summaryKind: "narrative" | "capsule" | "turn_summaries" = "capsule";
    let degradedSegments: number | undefined;
    let segmentCount = 0;
    let modelCallCount = 0;
    let summarizationInputTokens = 0;
    try {
      const removedAssistantIds = removed
        .filter((message) => message.role === "assistant")
        .map((message) => message.id);
      const { getTurnSummariesForCompaction } = await import("./historical-continuity");
      const accumulatedTurnSummaries = await getTurnSummariesForCompaction(
        sessionId,
        removedAssistantIds,
      );
      if (removedAssistantIds.length > 0 && accumulatedTurnSummaries) {
        summaryBody = accumulatedTurnSummaries;
        summaryKind = "turn_summaries";
        segmentCount = removedAssistantIds.length;
      } else {
      const { summarizeCompactedMessages } = await import("./compaction-summarizer");
      const narrative = await summarizeCompactedMessages({
        sessionId,
        messages: removed.map((m) => ({
          role: m.role,
          content: `[${m.createdAt}] ${m.content}`,
          thinking: m.thinking ?? undefined,
          toolCalls: Array.isArray(m.toolCalls)
            ? (m.toolCalls as Array<{
                toolName?: string;
                arguments?: Record<string, unknown>;
                result?: unknown;
                output?: string;
                error?: boolean | string | Record<string, unknown>;
              }>)
            : undefined,
        })),
        capsuleFacts: capsuleContent,
        deadlineAt,
      });
      if (narrative) {
        summaryBody = narrative.narrative;
        summaryKind = "narrative";
        degradedSegments = narrative.degradedSegments > 0 ? narrative.degradedSegments : undefined;
        segmentCount = narrative.segmentCount;
        modelCallCount = narrative.modelCallCount;
        summarizationInputTokens = narrative.inputTokens;
      } else {
        log.warn(`betweenTurnCompaction: narrative summary unavailable, using capsule fallback sessionId=${sessionId}`);
      }
      }
    } catch (summaryError: unknown) {
      log.warn(`betweenTurnCompaction: narrative summarizer error, using capsule fallback sessionId=${sessionId} error=${summaryError instanceof Error ? summaryError.message : String(summaryError)}`);
    }

    await transitionCompactionOperation(operationId, operationAttempt, "ready", {
      summaryKind,
      summaryMetadata: {
        degradedSegments: degradedSegments ?? 0,
        summaryLength: summaryBody.length,
      },
      segmentCount,
      modelCallCount,
      inputTokens: summarizationInputTokens,
    });

    const archiveNote = `

[Full original messages archived — ref:${archiveRef.id} — use indexed_content tool to retrieve]`;
    // Deterministically surface the user's freshest instruction at the top of
    // the compaction marker so it is provably part of the summary and visible
    // in the UI, independent of whether the narrative summarizer echoed it. The
    // instruction also remains live in the kept tail; this banner guarantees the
    // summary reinforces it rather than contradicting it with a stale resume point.
    const activeInstruction = capsule.latestUserInstruction;
    const instructionBanner = activeInstruction
      ? `**Still active — latest user instruction (authoritative):** ${activeInstruction}\n\n`
      : "";
    const summaryContent = `[Session Compaction] ${instructionBanner}${summaryBody}${archiveNote}`;

    let tokensAfter = estimateTokens(summaryContent);
    for (const m of docMessages.slice(boundaryIndex)) {
      if (isCommittedContextMessage(m)) tokensAfter += estimateDocTokens(m);
    }
    const tokensSaved = totalTokens - tokensAfter;

    if (Date.now() > deadlineAt) {
      throw new Error(`compaction wall-time budget exhausted (${COMPACTION_WALL_TIME_MS}ms)`);
    }
    const compactResult = await chatFileStorage.compactSession(sessionId, summaryContent, removedMessageIds, {
      type: "between_turn",
      operationId,
      operationAttempt,
      snapshotHash: snapshot.snapshotHash,
      summary: summaryBody,
      summaryKind,
      degradedSegments,
      capsuleVersion: capsule.version,
      capsule,
      archiveRefId: archiveRef.id,
      archiveFormat: COMPACTION_ARCHIVE_FORMAT,
      archiveDownloadable,
      tokensBefore: totalTokens,
      tokensAfter,
      tokensSaved,
      summaryLength: summaryBody.length,
      createdAt: new Date().toISOString(),
    });

    if (compactResult.compacted && compactResult.markerId) {
      const { eventBus } = await import("./event-bus");
      log.info("compaction.lifecycle", {
        transition: "committed",
        operationId,
        sessionId,
        snapshotHash: snapshot.snapshotHash,
        callerGeneration,
        durationMs: Date.now() - operationStartedAt,
        messagesBefore: compactResult.messagesBefore,
        messagesAfter: compactResult.messagesAfter,
        tokensBefore: totalTokens,
        tokensAfter,
        tokensSaved,
        summaryKind,
        summaryLength: summaryBody.length,
        degradedSegments: degradedSegments ?? 0,
        segmentCount,
        modelCallCount,
        inputTokens: summarizationInputTokens,
        archiveBytes: archiveRef.byteCount,
      });
      eventBus.publish({ category: "system", event: "compaction.persisted", payload: { operationId, sessionId, snapshotHash: snapshot.snapshotHash, trigger: "between-turn", messagesBefore: compactResult.messagesBefore, messagesAfter: compactResult.messagesAfter, tokensBefore: totalTokens, tokensAfter, tokensSaved, summaryLength: summaryBody.length, summaryKind, capsuleVersion: capsule.version } });
      emitActivity({ operationId, status: "done" });
      return {
        outcome: "compacted",
        operationId,
        markerId: compactResult.markerId,
        archiveRefId: archiveRef.id,
      };
    }

    await transitionCompactionOperation(operationId, operationAttempt, "superseded", {
      outcome: "snapshot_changed",
      failureReason: "snapshot_changed_before_commit",
    });
    emitActivity({ operationId, status: "done" });
    log.warn(`betweenTurnCompaction: snapshot changed before commit sessionId=${sessionId} operationId=${operationId} removed=${removedMessageIds.length}; active history preserved`);
    return { outcome: "snapshot_changed", operationId };
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    if (operationId) {
      try {
        await transitionCompactionOperation(operationId, operationAttempt, "failed", {
          outcome: "failed",
          failureReason: reason.slice(0, 1000),
        });
      } catch (transitionError) {
        log.error(
          "betweenTurnCompaction.terminal_state_persistence_failed",
          attributableContextError(transitionError, "CONTEXT_COMPACTION_STATE_PERSIST_FAILED"),
          { operation: "between_turn_compaction.persist_terminal_state", operationId },
        );
      }
    }
    if (operationId) emitActivity({ operationId, status: "error" });
    log.error(
      "betweenTurnCompaction.failed",
      attributableContextError(err, "CONTEXT_COMPACTION_FAILED"),
      { operation: "between_turn_compaction", sessionId, operationId: operationId ?? null },
    );
    return { outcome: "failed", operationId, reason };
  }
}

export function buildContextMessages(
  conversationHistory: Array<{
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    toolCallId?: string;
    toolCalls?: any[];
    thinking?: string;
  }>,
  budget: TokenBudget,
): ContextMessage[] {
  const messages: ContextMessage[] = conversationHistory.map(msg => {
    return {
      role: msg.role,
      content: msg.content,
      tokenEstimate: estimateTokens(msg.content) + (msg.thinking ? estimateTokens(msg.thinking) : 0),
      toolCallId: msg.toolCallId,
      toolCalls: msg.toolCalls,
      thinking: msg.thinking,
    };
  });

  return truncateConversationHistory(messages, budget.conversationBudget);
}

export async function assembleContext(options: {
  profile: ContextProfile;
  conversationHistory?: Array<{
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    toolCallId?: string;
    toolCalls?: any[];
    thinking?: string;
  }>;
  toolDefinitions?: Array<{ name: string; description: string }>;
  model?: string;
  activity?: ActivityId;
  sessionId?: string;
  /** Stable identity for one context build. Retry paths must reuse it. */
  contextBuildId?: string;
  /**
   * Optional spine section ids (or id-prefixes) to OMIT from the assembled
   * prompt. Wired through the existing context-builder exclusion path so
   * callers can drop e.g. "capabilities.tools" without ad-hoc post-render
   * stripping.
   */
  excludeSections?: string[];
  /** Optional spine section ids to FORCE-INCLUDE for this assembly. */
  includeSections?: string[];
  /** Current user message text — threaded to graph resolver to avoid storage race on first turn. */
  currentMessage?: string;
  /** Prebuilt, principal-scoped meeting packet for meeting-session assemblies. */
  meetingContext?: string;
  onProgress?: (step: string, status: "started" | "done", elapsedMs?: number) => void;
}): Promise<AssembledContext> {
  const {
    profile,
    conversationHistory = [],
    activity,
    sessionId,
    contextBuildId,
    excludeSections,
    includeSections,
    currentMessage,
    meetingContext,
  } = options;

  const activityId: ActivityId = activity || (profile === "chat" ? ACTIVITY_CHAT : profile === "voice" ? ACTIVITY_VOICE : ACTIVITY_FRAMING);
  const model = options.model || getModelForActivity(activityId);

  const modelName = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  const budget = getTokenBudget(modelName, profile);

  const callType: ContextCallType = "full";
  const llmMode: LlmMode = profile === "voice" ? "voice" : "text";

  // --- Context section scoping ---
  // If caller already provides excludeSections (e.g. skill runs), use those directly.
  // Otherwise, derive include/exclude sections from the active persona's context bundle.
  let resolvedExcludeSections = excludeSections && excludeSections.length > 0 ? excludeSections : undefined;
  let resolvedIncludeSections = includeSections && includeSections.length > 0 ? includeSections : undefined;

  if (!resolvedExcludeSections && sessionId) {
    try {
      const { SPINE_SECTIONS, getBootstrapSectionIds, getDefaultIncludedSectionIds } = await import("./context-spine-config");
      const { expandSemanticContextFlags, expandDisabledSemanticContextFlags, isSemanticContextFlag } = await import("./context-instruction-groups");
      const { resolveSessionPersonaComposition } = await import("./session-persona");
      const { chatFileStorage } = await import("./chat-file-storage");
      // Root ∪ selected persona is the source of truth for which optional context
      // sections load. Root-on flags cannot be turned off. Programmatic sessions
      // may still set explicit session flags that overlay the persona bundle.
      const { contextSections: personaBundle } = await resolveSessionPersonaComposition(sessionId, { persistFallback: false });
      const sessionFlags = await chatFileStorage.readSessionContextFlags(sessionId);
      const contextFlags: Record<string, boolean> | null =
        Object.keys(personaBundle).length > 0 || sessionFlags
          ? { ...personaBundle, ...(sessionFlags ?? {}) }
          : null;
      const bootstrapIds = getBootstrapSectionIds();

      if (contextFlags === null) {
        // No flags set yet — use default included sections (bootstrap + defaultIncluded).
        // Exclude everything NOT in the default set.
        const defaultIds = getDefaultIncludedSectionIds();
        resolvedExcludeSections = SPINE_SECTIONS
          .filter(s => !defaultIds.has(s.id))
          .map(s => s.id);
      } else {
        // Flags are set — compute excludeSections from all non-bootstrap sections
        // where the flag is false or absent. Semantic flags such as
        // instructions.coding expand to concrete section IDs, so orientation can
        // express intent without exposing raw section plumbing.
        const semanticIncludes = new Set([
          ...expandSemanticContextFlags(contextFlags),
          ...sectionIdsForEnabledGroups(contextFlags),
        ]);
        const semanticExcludes = new Set([
          ...expandDisabledSemanticContextFlags(contextFlags),
          ...sectionIdsForDisabledGroups(contextFlags),
        ]);
        const defaultIds = getDefaultIncludedSectionIds();
        const concreteIncludes = new Set(Object.entries(contextFlags)
          .filter(([id, enabled]) => enabled && !isSemanticContextFlag(id) && !CONTEXT_GROUP_IDS.has(id))
          .map(([id]) => id));
        const explicitExcludes = new Set(Object.entries(contextFlags)
          .filter(([id, enabled]) => enabled === false && !isSemanticContextFlag(id) && !CONTEXT_GROUP_IDS.has(id))
          .map(([id]) => id));
        const includedByFlags = (sectionId: string) => {
          if (concreteIncludes.has(sectionId)) return true;
          for (const id of semanticIncludes) {
            if (sectionId === id || sectionId.startsWith(id + ".")) return true;
          }
          return defaultIds.has(sectionId);
        };
        const explicitlyExcluded = (sectionId: string) => {
          for (const id of [...explicitExcludes, ...semanticExcludes]) {
            if (sectionId === id || sectionId.startsWith(id + ".")) return true;
          }
          return false;
        };
        resolvedIncludeSections = [
          ...(resolvedIncludeSections ?? []),
          ...semanticIncludes,
        ];
        resolvedExcludeSections = SPINE_SECTIONS
          .filter(s => !bootstrapIds.has(s.id) && (explicitlyExcluded(s.id) || !includedByFlags(s.id)))
          .map(s => s.id);
      }
    } catch (err) {
      // Fallback: if reading flags fails, proceed without scoping (full context).
      log.warn("[assembleContext] Failed to read context flags, using full context:", err);
    }
  }

  const contextRequest: ContextRequest = {
    callType,
    llmMode,
    activity: activityId,
    conversationHistory: conversationHistory.length > 0
      ? conversationHistory.map(m => ({ role: m.role, content: m.content || "" }))
      : null,
    sessionId: sessionId || undefined,
    contextBuildId,
    includeSections: resolvedIncludeSections,
    excludeSections: resolvedExcludeSections,
    currentMessage: currentMessage || undefined,
    meetingContext: meetingContext || undefined,
  };

  let spinePrompt: string;
  let renderStartTime = 0;
  const wrappedOnProgress = options.onProgress
    ? (step: string, status: "started" | "done", elapsedMs?: number) => {
        if (step === "ctx_render" && status === "started") {
          renderStartTime = Date.now();
        }
        options.onProgress!(step, status, elapsedMs);
      }
    : undefined;
  try {
    const resolvedSpine = await withTimeout(contextBuilder.resolve(contextRequest, wrappedOnProgress), CONTEXT_ASSEMBLY_TIMEOUT_MS, "contextBuilder.resolve");
    spinePrompt = contextBuilder.renderToPrompt(resolvedSpine);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`ContextBuilder degraded to minimal fallback reason=${isTimeoutError(err) ? "timeout" : "failure"} timeoutMs=${CONTEXT_ASSEMBLY_TIMEOUT_MS}: ${msg}`);
    const { agentName } = await resolveCurrentProfileIdentity();
    spinePrompt = `Your name is ${agentName}. Your type is Agent.\n\nCurrent time: ${getLocalTimeString()}`;
  }

  let systemPrompt = buildSystemPromptFromSpine(spinePrompt);

  // FTUE context injection — structural invariant, bypasses section exclusion.
  // PRODUCT.md always loads for FTUE. INTRO.md loads only for ordinary entry;
  // recap-origin FTUE continues directly from its persisted agenda and safe recap.
  if (sessionId) {
    try {
      const { chatFileStorage } = await import("./chat-file-storage");
      const conv = await chatFileStorage.getSession(sessionId);
      if (conv?.ftueWelcome) {
        const recapFtue = isRecapFtueSession(conv);
        const { db } = await import("./db");
        const { eq, inArray } = await import("drizzle-orm");
        const { libraryPages } = await import("@shared/models/info");
        const ftueSlugs = ["intro-md", "product-md"] as const;
        const ftuePages = await db
          .select({ slug: libraryPages.slug, plainTextContent: libraryPages.plainTextContent })
          .from(libraryPages)
          .where(inArray(libraryPages.slug, [...ftueSlugs]));
        const pageMap = new Map(ftuePages.map((p) => [p.slug, p.plainTextContent]));
        const introContent = pageMap.get("intro-md");
        if (!recapFtue && introContent) {
          systemPrompt += `\n\n<ftue_welcome_script>\n${introContent}\n</ftue_welcome_script>`;
        } else if (!recapFtue) {
          log.warn("FTUE welcome script page not found (slug: intro-md)");
        }
        const productContent = pageMap.get("product-md");
        if (productContent) {
          systemPrompt += `\n\n<ftue_product_definition>\n${productContent}\n</ftue_product_definition>`;
        } else {
          log.warn("FTUE product definition page not found (slug: product-md)");
        }
        if (recapFtue) {
          const { getCurrentRecipientOnboardingRecapProjectionByMeeting } = await import("./meeting/recipient-projection");
          const recap = await getCurrentRecipientOnboardingRecapProjectionByMeeting(conv.triggerId);
          if (!recap) throw new Error("Recipient-safe recap projection is unavailable");
          const meetingResource = conv.ftueRecapMeetingSessionId
            ? `@meeting:${conv.ftueRecapMeetingSessionId}`
            : undefined;
          systemPrompt += `\n\n<ftue_recap_context>\n${JSON.stringify({ ...recap, meetingResource })}\n</ftue_recap_context>`;
        }
      }
    } catch (ftueErr: unknown) {
      log.warn(`FTUE context injection failed: ${ftueErr instanceof Error ? ftueErr.message : String(ftueErr)}`);
    }
  }

  const finalSystemTokens = estimateTokens(systemPrompt);
  const adjustedConversationBudget = budget.conversationBudget + (budget.systemPromptBudget - finalSystemTokens);

  const adjustedBudget = { ...budget, conversationBudget: adjustedConversationBudget };
  const messages = buildContextMessages(conversationHistory, adjustedBudget);

  if (options.onProgress && renderStartTime > 0) {
    options.onProgress("ctx_render", "done", Date.now() - renderStartTime);
  }

  let conversationTokens = 0;
  for (const msg of messages) {
    conversationTokens += msg.tokenEstimate;
  }

  const totalTokens = finalSystemTokens + conversationTokens;
  const totalBudget = budget.maxContextTokens - budget.reserveForResponse;

  return {
    systemPrompt,
    messages,
    tokenUsage: {
      systemPrompt: finalSystemTokens,
      conversation: conversationTokens,
      total: totalTokens,
      budget: totalBudget,
      remaining: totalBudget - totalTokens,
    },
    profile,
    model,
    assembledAt: new Date().toISOString(),
  };
}

export async function assembleContextForChat(options: {
  conversationHistory?: Array<{
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    toolCallId?: string;
    toolCalls?: any[];
    thinking?: string;
  }>;
  toolDefinitions?: Array<{ name: string; description: string }>;
  model?: string;
  sessionId?: string;
}): Promise<AssembledContext> {
  return assembleContext({
    profile: "chat",
    ...options,
  });
}


export async function assembleContextForBackground(options?: {
  conversationHistory?: Array<{
    role: "user" | "assistant" | "tool" | "system";
    content: string;
    toolCallId?: string;
    toolCalls?: any[];
    thinking?: string;
  }>;
  model?: string;
}): Promise<AssembledContext> {
  return assembleContext({
    profile: "background",
    ...options,
  });
}

export function getTokenBudgetForModel(model: string, profile: ContextProfile = "chat"): TokenBudget {
  const modelName = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  return getTokenBudget(modelName, profile);
}
