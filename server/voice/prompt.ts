/**
 * Voice system prompt building — context assembly, caching, conversation
 * message construction, and tool schema retrieval.
 */
import type { Response } from "express";
import type { VoiceSession, VoiceMessage, TurnContext } from "./types";
import { writeVoiceJournal, publishVoiceDiagnostic } from "./session";
import { buildSSEChunk, isResponseAlive, sendSSEComment } from "./sse";
import { logPipelineStage } from "./pipeline-log";
import { persistUserMessage } from "./persistence";
import { getToolSchemas as getToolDefinitions } from "../tool-registry";
import { formatMessageTimestamp, nowMessageTimestamp } from "../timezone";
import { createLogger } from "../log";

const log = createLogger("VoiceLlm");

const CONTEXT_REFRESH_MS = 15 * 60 * 1000;
const SINGLE_MESSAGE_HARD_CAP = 16000;

type ContextConversationMessage = { role: "user" | "assistant" | "tool" | "system"; content: string };

function toContextConversationHistory(
  conversationMessages?: Array<{ role: string; content: string }>,
): ContextConversationMessage[] {
  if (!conversationMessages || conversationMessages.length === 0) return [];
  return conversationMessages
    .filter((m): m is ContextConversationMessage => {
      return (m.role === "user" || m.role === "assistant" || m.role === "tool" || m.role === "system")
        && Boolean(m.content && m.content.trim());
    })
    .map((m) => ({ role: m.role, content: m.content }));
}

function conversationFocusKey(conversationHistory: ContextConversationMessage[]): string {
  if (conversationHistory.length === 0) return "empty";
  return conversationHistory
    .slice(-6)
    .map((m) => `${m.role}:${m.content.trim().slice(0, 240)}`)
    .join("|");
}

// ── Chat Continuation Section ────────────────────────────────────────────

export async function buildChatContinuationSection(chatSessionId: string | null): Promise<string> {
  if (!chatSessionId) return "";
  try {
    const { chatFileStorage } = await import("../chat-file-storage");
    const messages = await chatFileStorage.getMessagesBySession(chatSessionId);
    if (messages && messages.length > 0) {
      const { getInstanceName } = await import("@shared/instance-config");
      const chatHistory = messages.map(m => {
        const role = m.role === "assistant" ? getInstanceName() : "User";
        const raw = m.content || "";
        const content = raw.length > SINGLE_MESSAGE_HARD_CAP
          ? raw.slice(0, SINGLE_MESSAGE_HARD_CAP) + "…[truncated]"
          : raw;
        const ts = m.createdAt ? new Date(m.createdAt) : new Date();
        const safeTs = isNaN(ts.getTime()) ? new Date() : ts;
        return `${formatMessageTimestamp(safeTs)} [${role}]: ${content}`;
      }).join("\n");
      if (chatHistory.length > 0) {
        log.debug(`TRANSCRIPT_LOADED path=handoff priorMsgs=${messages.length} totalChars=${chatHistory.length} chatSessionId=${chatSessionId}`);
        return `\n\n## Prior Chat (text chat)\nThe user switched from text chat to voice within the same conversation. Here is the full prior transcript — continue naturally from this context. Do NOT re-introduce yourself or give a standard greeting. Just pick up where the conversation left off.\n${chatHistory}`;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`failed to load chat history: ${msg}`);
  }
  return "";
}

// ── System Prompt Building ───────────────────────────────────────────────

export async function buildSystemPrompt(
  session: VoiceSession,
  ctx?: TurnContext,
  conversationMessages?: Array<{ role: string; content: string }>,
): Promise<string> {
  log.debug(`system prompt cache miss — assembling context via unified spine for session ${session.id}`);
  const contextStart = Date.now();
  const { assembleContext } = await import("../agent-context");
  const { getToolSchemas } = await import("../tool-registry");
  const toolDefs = getToolSchemas().map(t => ({ name: t.name, description: t.description }));
  const contextHistory = toContextConversationHistory(conversationMessages);

  const onProgress = ctx ? (step: string, status: "started" | "done", elapsedMs?: number) => {
    const journalStatus = status === "done" ? "done" : "started";
    if (status === "done") {
      const persistStep = { name: step, status: "done" as const, elapsedMs, detail: `${step} resolved` };
      ctx.systemSteps.push(persistStep);
      ctx.segmentChronology.push({ s: "system" as const, i: ctx.systemSteps.length - 1 });
    }
    writeVoiceJournal(session, "system_step", {
      step,
      status: journalStatus,
      elapsedMs,
      detail: status === "done" ? `${step} resolved` : undefined,
      ...(ctx.turnId ? { turnId: ctx.turnId } as Record<string, unknown> : {}),
    });
  } : undefined;

  const assembled = await assembleContext({
    profile: "voice",
    toolDefinitions: toolDefs,
    sessionId: session.chatSessionId || undefined,
    conversationHistory: contextHistory.length > 0 ? contextHistory : undefined,
    onProgress,
  });
  const spineElapsed = Date.now() - contextStart;
  const keptAfterBudget = assembled.messages.length;
  const droppedReason = contextHistory.length > keptAfterBudget ? "token_budget" : "none";
  log.debug(`context spine resolved in ${spineElapsed}ms promptLen=${assembled.systemPrompt.length} TRANSCRIPT_LOADED path=spine_assembled focusMsgs=${contextHistory.length} keptAfterBudget=${keptAfterBudget} droppedReason=${droppedReason} sysPromptTokens=${assembled.tokenUsage.systemPrompt} convTokens=${assembled.tokenUsage.conversation} budgetRemaining=${assembled.tokenUsage.remaining} session=${session.id}`);

  const chatContinuation = await buildChatContinuationSection(session.chatSessionId);
  const fullPrompt = assembled.systemPrompt + chatContinuation;

  session.cachedSystemPrompt = fullPrompt;
  session.cachedSystemPromptFocusKey = conversationFocusKey(contextHistory);
  session.cachedAt = Date.now();
  session.inflightContextPromise = null;
  session.inflightContextFocusKey = null;

  log.debug(`system prompt ready len=${fullPrompt.length} bytes=${Buffer.byteLength(fullPrompt, "utf-8")} hasChatContinuation=${chatContinuation.length > 0}`);
  return fullPrompt;
}

// ── Cached System Prompt Accessor ────────────────────────────────────────

export async function getSystemPrompt(
  session: VoiceSession,
  ctx?: TurnContext,
  conversationMessages?: Array<{ role: string; content: string }>,
): Promise<string> {
  const now = Date.now();
  const focusHistory = toContextConversationHistory(conversationMessages);
  const nextFocusKey = conversationFocusKey(focusHistory);
  const cachedFocusKey = session.cachedSystemPromptFocusKey || "empty";
  const cacheMatchesFocus = cachedFocusKey === nextFocusKey;

  if (session.cachedSystemPrompt && cacheMatchesFocus && (now - session.cachedAt) < CONTEXT_REFRESH_MS) {
    const cacheAge = now - session.cachedAt;
    log.debug(`system prompt cache hit session=${session.id} cacheAge=${cacheAge}ms focusMsgs=${focusHistory.length} len=${session.cachedSystemPrompt.length}`);
    return session.cachedSystemPrompt;
  }

  if (session.inflightContextPromise && session.inflightContextFocusKey === nextFocusKey) {
    log.debug(`system prompt in-flight — awaiting existing build for session=${session.id} focusMsgs=${focusHistory.length}`);
    return session.inflightContextPromise;
  }

  const cacheAge = session.cachedSystemPrompt ? now - session.cachedAt : -1;
  log.debug(`system prompt cache refresh triggered session=${session.id} cacheAge=${cacheAge}ms ttl=${CONTEXT_REFRESH_MS}ms focusMsgs=${focusHistory.length} cacheMatchesFocus=${cacheMatchesFocus}`);
  const promise = buildSystemPrompt(session, ctx, conversationMessages);
  session.inflightContextPromise = promise;
  session.inflightContextFocusKey = nextFocusKey;
  return promise;
}

// ── Voice Tools ──────────────────────────────────────────────────────────

export function getVoiceTools() {
  return getToolDefinitions();
}

// ── Conversation Message Building ────────────────────────────────────────

function transcriptKey(role: string, content: string): string {
  const norm = (content || "").trim().slice(0, 240).replace(/\s+/g, " ");
  return `${role}::${norm}`;
}

export async function buildConversationMessages(
  messages: VoiceMessage[],
  session: VoiceSession,
  currentTurn: number,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const elNow = nowMessageTimestamp();
  const elMessages = messages
    .filter((m: VoiceMessage) => m.role !== "system")
    .map((m: VoiceMessage) => ({
      role: m.role as "user" | "assistant",
      content: `${elNow} ${m.content}`,
    }));

  let conversationMessages: Array<{ role: "user" | "assistant"; content: string }> = elMessages;
  let path: "fresh" | "reconnect" | "continuation" | "el_only" = "el_only";
  let priorMsgsLoaded = 0;
  let prepended = 0;

  if (session.chatSessionId) {
    try {
      const { chatFileStorage } = await import("../chat-file-storage");
      const priorMessages = await chatFileStorage.getMessagesBySession(session.chatSessionId);
      const persisted = priorMessages
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content && m.content.trim())
        .map((m) => {
          const ts = m.createdAt ? new Date(m.createdAt) : new Date();
          const safeTs = isNaN(ts.getTime()) ? new Date() : ts;
          return {
            role: m.role as "user" | "assistant",
            content: m.content,
            stamped: `${formatMessageTimestamp(safeTs)} ${m.content}`,
          };
        });
      priorMsgsLoaded = persisted.length;

      if (persisted.length > 0) {
        const elKeys = new Set(messages
          .filter((m: VoiceMessage) => m.role !== "system")
          .map((m: VoiceMessage) => transcriptKey(m.role, m.content)));
        const missing = persisted.filter((m) => !elKeys.has(transcriptKey(m.role, m.content)));
        prepended = missing.length;

        if (missing.length > 0) {
          conversationMessages = [
            ...missing.map((m) => ({ role: m.role, content: m.stamped })),
            ...elMessages,
          ];
          path = session.isReconnect ? "reconnect" : "continuation";
        } else {
          path = elMessages.length > 0 ? "el_only" : "fresh";
        }

        if (session.isReconnect && !session.historyInjected && missing.length > 0) {
          session.historyInjected = true;
        }
      } else {
        path = elMessages.length > 0 ? "el_only" : "fresh";
      }
    } catch (err: unknown) {
      log.warn(`turn ${currentTurn} TRANSCRIPT_DIFF failed: ${err instanceof Error ? err.message : String(err)} session=${session.id}`);
    }
  }

  while (conversationMessages.length > 0 && conversationMessages[conversationMessages.length - 1].role === "assistant") {
    conversationMessages.pop();
  }

  log.debug(`turn ${currentTurn} TRANSCRIPT_LOADED path=${path} priorMsgs=${priorMsgsLoaded} elMsgs=${elMessages.length} prepended=${prepended} finalMsgs=${conversationMessages.length} isReconnect=${session.isReconnect} session=${session.id}`);
  return conversationMessages;
}

// ── Pre-context keepalive interval ───────────────────────────────────────
const PRE_CONTEXT_KEEPALIVE_INTERVAL_MS = 5_000;

// ── Prompt + Message Resolution ──────────────────────────────────────────

export async function resolvePromptAndMessages(
  session: VoiceSession,
  conversationMessages: Array<{ role: string; content: string }>,
  currentTurn: number,
  pipelineStart: number,
  ctx: TurnContext,
  res?: Response,
  turnAbort?: AbortController,
): Promise<{ systemPrompt: string; systemPromptBytes: number; finalMessages: Array<{ role: string; content: string }> }> {
  let preContextKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  if (res && !res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    if (res.socket) res.socket.setNoDelay(true);
    log.debug(`turn ${currentTurn} EARLY_SSE_HEADERS sent before context assembly session=${session.id}`);
  }
  let preemptiveCascadeTimer: ReturnType<typeof setTimeout> | null = null;
  if (res) {
    sendSSEComment(res, "keepalive", session.id);
    preContextKeepaliveTimer = setInterval(() => {
      if (!isResponseAlive(res) || turnAbort?.signal.aborted) {
        if (preContextKeepaliveTimer) { clearInterval(preContextKeepaliveTimer); preContextKeepaliveTimer = null; }
        return;
      }
      sendSSEComment(res, "keepalive", session.id);
    }, PRE_CONTEXT_KEEPALIVE_INTERVAL_MS);
    preemptiveCascadeTimer = setTimeout(() => {
      preemptiveCascadeTimer = null;
      if (!isResponseAlive(res) || turnAbort?.signal.aborted) return;
      try {
        const chunk = buildSSEChunk(ctx.chatId, ctx.created, "... ");
        res.write(chunk);
        if (!ctx.firstChunk.sentAt) ctx.firstChunk.sentAt = Date.now();
        log.debug(`turn ${currentTurn} PRE_CONTEXT_CASCADE_KEEPALIVE sent session=${session.id}`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`turn ${currentTurn} PRE_CONTEXT_CASCADE_KEEPALIVE failed: ${msg} session=${session.id}`);
      }
    }, 1500);
  }
  const systemPrompt = await getSystemPrompt(session, ctx, conversationMessages);
  if (preemptiveCascadeTimer) { clearTimeout(preemptiveCascadeTimer); preemptiveCascadeTimer = null; }
  if (preContextKeepaliveTimer) { clearInterval(preContextKeepaliveTimer); preContextKeepaliveTimer = null; }
  if (res) log.debug(`turn ${currentTurn} PRE_CONTEXT_KEEPALIVE stopped — context assembly complete session=${session.id}`);
  const systemPromptBytes = Buffer.byteLength(systemPrompt, "utf-8");
  const contextElapsed = Date.now() - pipelineStart;
  publishVoiceDiagnostic(session, "context_assembly", `Prompt ready (${systemPromptBytes} bytes)`, { turn: currentTurn, elapsedMs: contextElapsed }, ctx);
  logPipelineStage(ctx, session, "context_prompt_done", pipelineStart, `promptBytes=${systemPromptBytes}`);
  let finalMessages = conversationMessages;
  if (session.pendingTranscriptUpdate) {
    const updatedMsgs = session.pendingTranscriptUpdate;
    session.pendingTranscriptUpdate = null;
    const rebuilt = await buildConversationMessages(updatedMsgs, session, currentTurn);
    if (rebuilt.length > 0) {
      log.debug(`turn ${currentTurn} COALESCE_TRANSCRIPT_APPLIED oldMsgCount=${conversationMessages.length} newMsgCount=${rebuilt.length} session=${session.id}`);
      publishVoiceDiagnostic(session, "coalesce_applied", `Extended transcript applied to LLM (${rebuilt.length} messages)`, { turn: currentTurn, status: "done" }, ctx);
      finalMessages = rebuilt;

      if (session.chatSessionId) {
        try {
          await persistUserMessage(session, rebuilt, currentTurn, new Date().toISOString());
          log.debug(`turn ${currentTurn} COALESCE_RESOLVE_PERSIST — upserted DB transcript session=${session.id}`);
        } catch (persistErr: unknown) {
          const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
          log.warn(`turn ${currentTurn} COALESCE_RESOLVE_PERSIST failed: ${msg} session=${session.id}`);
        }
      }
    } else {
      log.warn(`turn ${currentTurn} COALESCE_TRANSCRIPT_EMPTY — keeping original messages session=${session.id}`);
    }
  }

  return { systemPrompt, systemPromptBytes, finalMessages };
}

// ── Executor Message Builder ─────────────────────────────────────────────

export function buildExecutorMessages(
  systemPrompt: string,
  conversationMessages: Array<{ role: string; content: string }>,
): import("../agent-executor").ExecutorMessage[] {
  const validRoles = new Set(["system", "user", "assistant", "tool_result"]);
  return [
    { role: "system" as const, content: systemPrompt },
    ...conversationMessages
      .filter(m => validRoles.has(m.role))
      .map(m => ({ role: m.role as "system" | "user" | "assistant" | "tool_result", content: m.content })),
  ];
}
