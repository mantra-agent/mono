// Use createLogger for logging ONLY
import { contextBuilder } from "./context-builder";
import type { ContextCallType, LlmMode, ContextRequest } from "../shared/context-spine";
import { getLocalTimeString } from "./timezone";
import { getModelForActivity, ACTIVITY_CHAT, ACTIVITY_FRAMING, ACTIVITY_VOICE, type ActivityId, type TierId } from "./job-profiles";
import { getContextWindow } from "./model-registry";
import { withTimeout, isTimeoutError, CONTEXT_ASSEMBLY_TIMEOUT_MS } from "./timeout";
import { createLogger } from "./log";

const log = createLogger("AgentContext");

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

const BETWEEN_TURN_COMPACTION_THRESHOLD = 0.6;
const BETWEEN_TURN_COMPACTION_TIMEOUT_MS = 30_000;

type CompactableHistoryMessage = {
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: Array<{ toolName?: string; result?: unknown; error?: boolean }>;
  publicRole?: "user" | "assistant";
  archiveRefId?: string;
  archiveDownloadable?: boolean;
};

function serializeForCompaction(msg: CompactableHistoryMessage): string {
  const parts = [`[${msg.role}]: ${msg.content}`];
  if (msg.thinking) {
    const thinking = msg.thinking.length > 1000 ? `${msg.thinking.slice(0, 1000)}...` : msg.thinking;
    parts.push(`[thinking]: ${thinking}`);
  }
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const rawResult = typeof tc.result === "string" ? tc.result : tc.result == null ? "" : JSON.stringify(tc.result);
      const result = rawResult.length > 1500 ? `${rawResult.slice(0, 1500)}...` : rawResult;
      parts.push(`[tool:${tc.toolName || "unknown"}${tc.error ? ":error" : ""}]: ${result}`);
    }
  }
  return parts.join("\n");
}

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

export async function runBetweenTurnCompaction(
  sessionId: string,
  conversationHistory: CompactableHistoryMessage[],
  conversationBudget: number,
): Promise<boolean> {
  let totalTokens = 0;
  for (const msg of conversationHistory) {
    totalTokens += estimateHistoryTokens(msg);
  }

  const threshold = Math.floor(conversationBudget * BETWEEN_TURN_COMPACTION_THRESHOLD);
  if (totalTokens <= threshold) {
    return false;
  }

  log.log(`betweenTurnCompaction: triggered sessionId=${sessionId} totalTokens=${totalTokens} threshold=${threshold} messages=${conversationHistory.length}`);

  const keepRecent = 2;
  const olderMessages = conversationHistory.slice(0, -keepRecent);
  if (olderMessages.length < 1) return false;

  const { encodeCompactionArchive, COMPACTION_ARCHIVE_FORMAT } = await import("./compaction-archive");
  const serialized = encodeCompactionArchive(sessionId, olderMessages);
  const archiveDownloadable = olderMessages.every(
    (message) => !message.archiveRefId || message.archiveDownloadable === true,
  );
  if (serialized.length < 200) return false;

  try {
    let archiveRef: any = null;
    try {
      const { indexAndArchive } = await import("./content-indexer");
      archiveRef = await indexAndArchive({
        content: serialized,
        sourceType: "compaction",
        sourceLabel: `session:${sessionId} (${olderMessages.length} messages)`,
      });
    } catch {
    }

    const { chatCompletion } = await import("./model-client");
    const { getPromptModulePrompt } = await import("./prompt-modules");
    const { ACTIVITY_FRAMING: activity } = await import("./job-profiles");

    const sessionContinuationPrompt = `Write a continuation-grade summary of this session history. This is not always a user-requested conversation: sessions may be user-directed, Agent-directed, skill-directed, plan-step-directed, system/autonomous work, or mixed.

Your job is to preserve enough context for a future continuation of the same session, not to extract an encyclopedic list of facts.

Output format:

Session spine:
2-4 sentences explaining what kind of session this was, who or what initiated it if knowable, the objective or driving question, what changed during the compacted span, and where continuation should resume.

Key continuity points:
- Initiator / trigger: who or what appears to have started or directed the session, if knowable.
- Objective: the session's purpose, question, task, or operating goal.
- Actions taken: important user, assistant, Agent, skill, plan, tool, or system actions.
- Systems touched: tools, artifacts, code, files, library pages, tasks, projects, memories, people, or external systems affected.
- Decisions / conclusions: durable outcomes and why they matter.
- State changes: created/updated/deleted records, status changes, IDs, branches, PRs, commits, timers, hooks, or other exact references needed later.
- Open loops / blockers: unresolved questions, failures, promised follow-ups, or pending review.
- Resume point: the next useful thing a future Agent should do or know when the session continues.

Rules:
- Preserve causal sequence and narrative continuity over isolated facts.
- Include exact identifiers, names, dates, numeric values, and artifact references when they affect continuation.
- Do not assume the session is about what Ray wanted unless the messages show that.
- Do not output a mere fact list.
- Do not invent missing context. Say "unknown" or omit a field if it is not knowable from the compacted messages.
- Be concise but complete enough that the original session can be resumed without rereading the archive.`;

    let systemMsg = sessionContinuationPrompt;
    let maxTokens = 2200;
    try {
      const prompt = await getPromptModulePrompt("chat-compactrunhistory");
      if (prompt) {
        systemMsg = `${sessionContinuationPrompt}

Additional legacy compaction guidance from the live prompt module follows. Apply it only when compatible with the session-continuation contract above:

${prompt}`;
      }
    } catch { /* use local continuation contract */ }
    systemMsg += "\n\nMessages are prefixed with `[YYYY-MM-DD HH:MM TZ]` timestamps — preserve notable time gaps in your summary (e.g. \"user was away ~14h before resuming\", \"thread spans 3 days\").";

    const compactInput = olderMessages.map(m => {
      const serializedMsg = serializeForCompaction(m);
      return serializedMsg.length > 4000 ? `${serializedMsg.slice(0, 4000)}...` : serializedMsg;
    }).join("\n\n");

    const result = await Promise.race([
      chatCompletion({
        activity,
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: compactInput },
        ],
        maxTokens,
        metadata: { source: "between-turn-compaction", sessionId, activity },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Between-turn compaction timeout")), BETWEEN_TURN_COMPACTION_TIMEOUT_MS)),
    ]);

    const archiveNote = archiveRef
      ? `\n\n[Full original messages archived — ref:${archiveRef.id} — use indexed_content tool to retrieve]`
      : "";
    const summaryContent = `[Session Compaction] Summary of ${olderMessages.length} earlier messages:\n\n${result.content}${archiveNote}`;
    const replaceBeforeIndex = olderMessages.length;

    const { chatFileStorage } = await import("./chat-file-storage");
    let tokensAfter = estimateTokens(summaryContent);
    const recentMessages = conversationHistory.slice(-keepRecent);
    for (const m of recentMessages) tokensAfter += estimateHistoryTokens(m);
    const tokensSaved = totalTokens - tokensAfter;

    const compactResult = await chatFileStorage.compactSession(sessionId, summaryContent, replaceBeforeIndex, {
      type: "between_turn",
      summary: result.content,
      replacedMessageCount: olderMessages.length,
      keptMessageCount: recentMessages.length,
      archiveRefId: archiveRef?.id,
      archiveFormat: archiveRef ? COMPACTION_ARCHIVE_FORMAT : undefined,
      archiveDownloadable: !!archiveRef && archiveDownloadable,
      tokensBefore: totalTokens,
      tokensAfter,
      tokensSaved,
      summaryLength: result.content.length,
      createdAt: new Date().toISOString(),
    });

    if (compactResult.compacted) {
      const { eventBus } = await import("./event-bus");
      log.log(`betweenTurnCompaction: persisted sessionId=${sessionId} trigger=between-turn messagesBefore=${compactResult.messagesBefore} messagesAfter=${compactResult.messagesAfter} tokensBefore=${totalTokens} tokensAfter=${tokensAfter} tokensSaved=${tokensSaved} summaryLen=${summaryContent.length}`);
      eventBus.publish({ category: "system", event: "compaction.persisted", payload: { sessionId, trigger: "between-turn", messagesBefore: compactResult.messagesBefore, messagesAfter: compactResult.messagesAfter, tokensBefore: totalTokens, tokensAfter, tokensSaved, summaryLength: summaryContent.length } });
    }

    return compactResult.compacted;
  } catch (err: unknown) {
    log.error(`betweenTurnCompaction: failed sessionId=${sessionId} error=${err instanceof Error ? err.message : String(err)}`);
    return false;
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

  // --- Context flag scoping ---
  // If caller already provides excludeSections (e.g. skill runs), use those directly.
  // Otherwise, derive excludeSections from session-level context flags.
  let resolvedExcludeSections = excludeSections && excludeSections.length > 0 ? excludeSections : undefined;
  let resolvedIncludeSections = includeSections && includeSections.length > 0 ? includeSections : undefined;

  if (!resolvedExcludeSections && sessionId) {
    try {
      const { chatFileStorage } = await import("./chat-file-storage");
      const { SPINE_SECTIONS, getBootstrapSectionIds, getDefaultIncludedSectionIds } = await import("./context-spine-config");
      const { expandSemanticContextFlags, expandDisabledSemanticContextFlags, isSemanticContextFlag } = await import("./context-instruction-groups");
      const contextFlags = await chatFileStorage.readSessionContextFlags(sessionId);
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
        const semanticIncludes = new Set(expandSemanticContextFlags(contextFlags));
        const semanticExcludes = new Set(expandDisabledSemanticContextFlags(contextFlags));
        const defaultIds = getDefaultIncludedSectionIds();
        const concreteIncludes = new Set(Object.entries(contextFlags)
          .filter(([id, enabled]) => enabled && !isSemanticContextFlag(id))
          .map(([id]) => id));
        const explicitExcludes = new Set(Object.entries(contextFlags)
          .filter(([id, enabled]) => enabled === false && !isSemanticContextFlag(id))
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
    spinePrompt = `You are Agent.\n\nCurrent time: ${getLocalTimeString()}`;
  }

  let systemPrompt = buildSystemPromptFromSpine(spinePrompt);

  // FTUE context injection — structural invariant, bypasses section exclusion.
  // INTRO.md (welcome script) and PRODUCT.md (product definition) MUST load for
  // FTUE sessions regardless of which sections are included/excluded.
  if (sessionId) {
    try {
      const { chatFileStorage } = await import("./chat-file-storage");
      const conv = await chatFileStorage.getSession(sessionId);
      if (conv?.ftueWelcome) {
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
        if (introContent) {
          systemPrompt += `\n\n<ftue_welcome_script>\n${introContent}\n</ftue_welcome_script>`;
        } else {
          log.warn("FTUE welcome script page not found (slug: intro-md)");
        }
        const productContent = pageMap.get("product-md");
        if (productContent) {
          systemPrompt += `\n\n<ftue_product_definition>\n${productContent}\n</ftue_product_definition>`;
        } else {
          log.warn("FTUE product definition page not found (slug: product-md)");
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
