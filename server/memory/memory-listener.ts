import { eventBus, type BusEvent } from "../event-bus";
import { getTimezone } from "../timezone";
import { getUserName } from "../context-assembly";
import { memoryEntries, type MemorySource } from "@shared/schema";
import { createLogger } from "../log";
import { storage } from "../storage";
import { db, withQueryAttributionAsync } from "../db";
import { memoryStorage } from "./memory-storage";
import { eq, and } from "drizzle-orm";

const log = createLogger("MemoryListener");

const memorySuppressedConversations = new Set<string>();

function emitEntriesChanged(action: string, layer?: string): void {
  eventBus.publish({
    category: "memory",
    event: "entries_changed",
    payload: { action, layer, level: "info" },
  });
}

const RICH_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

interface ThoughtEntry {
  type: string;
  content: string;
}

interface ExchangeTurn {
  userMessage: string;
  thinking: string | null;
  thoughts: ThoughtEntry[];
  tools: Array<{ name: string; query: string }>;
  xyzResponse: string;
}

interface ExchangeBuffer {
  sessionId: string;
  sessionKey: string;
  turns: ExchangeTurn[];
  currentUserMessage: string | null;
  currentThinking: string[];
  currentChunks: string[];
  currentThoughts: ThoughtEntry[];
  currentTools: Array<{ name: string; query: string }>;
  conversationTitle: string | null;
  startedAt: string;
}

const exchangeBuffers = new Map<string, ExchangeBuffer>();

/**
 * Parse existing exchange content (from DB) back into ExchangeTurn[] objects.
 * This allows buffer recovery after a server restart.
 */
function parseTurnsFromContent(content: string): { turns: ExchangeTurn[]; startedAt: string | null } {
  let startedAt: string | null = null;

  // Extract startedAt from header line: [Exchange] "Title" | Started MM/DD/YYYY HH:MM
  const headerMatch = content.match(/^\[Exchange\][^\n]*\| Started (.+)$/m);
  if (headerMatch) {
    startedAt = headerMatch[1].trim();
  }

  const turns: ExchangeTurn[] = [];
  // Match all turn blocks
  const turnRegex = /<turn role="([^"]+)"[^>]*>([\s\S]*?)<\/turn>/g;

  let currentTurn: Partial<ExchangeTurn> = {};
  let match: RegExpExecArray | null;

  while ((match = turnRegex.exec(content)) !== null) {
    const role = match[1];
    const body = match[2].trim();

    if (role === "user") {
      // A new user message means push any previous complete turn and start fresh
      if (currentTurn.userMessage !== undefined || currentTurn.xyzResponse !== undefined) {
        turns.push({
          userMessage: currentTurn.userMessage || "",
          thinking: currentTurn.thinking || null,
          thoughts: currentTurn.thoughts || [],
          tools: currentTurn.tools || [],
          xyzResponse: currentTurn.xyzResponse || "",
        });
        currentTurn = {};
      }
      currentTurn.userMessage = body;
    } else if (role === "thinking") {
      currentTurn.thinking = body;
    } else if (role === "thought") {
      if (!currentTurn.thoughts) currentTurn.thoughts = [];
      const typeMatch = match[0].match(/type="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : "self";
      // Strip "Think (Label): " prefix
      const cleaned = body.replace(/^Think \([^)]+\):\s*/, "");
      currentTurn.thoughts.push({ type, content: cleaned });
    } else if (role === "tools") {
      if (!currentTurn.tools) currentTurn.tools = [];
      // Parse tool list: "toolName("query"), toolName2("query2")"
      const toolParts = body.split(/,\s*/);
      for (const part of toolParts) {
        const toolMatch = part.match(/^([^(]+)\("([^"]*)"\)$/);
        if (toolMatch) {
          currentTurn.tools.push({ name: toolMatch[1].trim(), query: toolMatch[2] });
        } else {
          currentTurn.tools.push({ name: part.trim(), query: "" });
        }
      }
    } else if (role === "assistant") {
      currentTurn.xyzResponse = body;
    }
  }

  // Push the last turn if it has content
  if (currentTurn.userMessage !== undefined || currentTurn.xyzResponse !== undefined) {
    turns.push({
      userMessage: currentTurn.userMessage || "",
      thinking: currentTurn.thinking || null,
      thoughts: currentTurn.thoughts || [],
      tools: currentTurn.tools || [],
      xyzResponse: currentTurn.xyzResponse || "",
    });
  }

  return { turns, startedAt };
}

function formatTimestamp(): string {
  const tz = getTimezone();
  return new Date().toLocaleString("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(",", "");
}

function getBufferKeyFromPayload(payload: Record<string, unknown>, sessionKey?: string): string {
  return (payload?.sessionId as string) || sessionKey || "default";
}

async function getOrCreateBuffer(sessionId: string, sessionKey: string, title?: string): Promise<ExchangeBuffer> {
  if (exchangeBuffers.has(sessionId)) {
    const buf = exchangeBuffers.get(sessionId)!;
    if (title && !buf.conversationTitle) {
      buf.conversationTitle = title;
    }
    return buf;
  }

  const buf: ExchangeBuffer = {
    sessionId,
    sessionKey,
    turns: [],
    currentUserMessage: null,
    currentThinking: [],
    currentChunks: [],
    currentThoughts: [],
    currentTools: [],
    conversationTitle: title || null,
    startedAt: formatTimestamp(),
  };
  exchangeBuffers.set(sessionId, buf);

  // Recover prior turns from DB if this buffer was lost due to a server restart
  try {
    const sourceId = `exchange-${sessionId}`;
    const [existing] = await db
      .select({ content: memoryEntries.content, title: memoryEntries.title })
      .from(memoryEntries)
      .where(and(
        eq(memoryEntries.layer, "short"),
        eq(memoryEntries.source, "conversation"),
        eq(memoryEntries.sourceId, sourceId),
      ))
      .limit(1);

    if (existing && existing.content) {
      const { turns, startedAt } = parseTurnsFromContent(existing.content);
      if (turns.length > 0) {
        buf.turns = turns;
        if (startedAt) buf.startedAt = startedAt;
        if (existing.title && !buf.conversationTitle) {
          buf.conversationTitle = existing.title;
        }
        log.debug(`Recovered ${turns.length} turns from DB for session ${sessionId}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to recover exchange buffer from DB for ${sessionId}: ${msg}`);
  }

  return buf;
}

function extractToolQuery(args: Record<string, unknown> | undefined): string {
  if (!args || typeof args !== "object") return "";
  return (args.query || args.search || args.url || args.prompt || "") as string;
}

async function finalizeTurn(buf: ExchangeBuffer): Promise<void> {
  const userMsg = buf.currentUserMessage || "";
  const xyzResp = buf.currentChunks.join("");
  const thinking = buf.currentThinking.length > 0 ? buf.currentThinking.join("") : null;
  const thoughts = [...buf.currentThoughts];
  const tools = [...buf.currentTools];

  buf.currentUserMessage = null;
  buf.currentThinking = [];
  buf.currentChunks = [];
  buf.currentThoughts = [];
  buf.currentTools = [];

  if (!userMsg && !xyzResp) return;
  if (xyzResp.length < 5 && !userMsg) return;

  if (memorySuppressedConversations.has(buf.sessionId)) {
    log.debug(`Skipping memory write for session ${buf.sessionId} (addToMemory=false)`);
    return;
  }

  buf.turns.push({ userMessage: userMsg, thinking, thoughts, tools, xyzResponse: xyzResp });

  log.debug(
    `Raw exchange memory disabled: buffered turn for session ${buf.sessionId} (${buf.turns.length} turns)`,
  );
}

async function handleVoiceXyzResponse(sessionId: string, content: string, sessionKey: string): Promise<void> {
  const buf = await getOrCreateBuffer(sessionId, sessionKey);

  buf.turns.push({
    userMessage: buf.currentUserMessage || "",
    thinking: null,
    thoughts: [],
    tools: [],
    xyzResponse: content,
  });
  buf.currentUserMessage = null;
  buf.currentThinking = [];
  buf.currentChunks = [];
  buf.currentThoughts = [];
  buf.currentTools = [];

  log.debug(
    `Raw voice exchange memory disabled: buffered turn for session ${sessionId} (${buf.turns.length} turns)`,
  );
}

async function handleVoiceInsight(sessionId: string, content: string): Promise<void> {
  if (!content || content.length < 5) return;

  const sourceId = `insight-${sessionId}-${Date.now()}`;
  await withQueryAttributionAsync("memory-write", () => memoryStorage.ingest(
    `[Insight] ${formatTimestamp()}\n${content}`,
    "event" as MemorySource,
    sourceId,
    { sessionId, type: "voice_insight" },
    ["insight", "voice"],
  ), "voice-insight-ingest");

  log.debug(`Voice insight stored: ${sourceId}`);
  emitEntriesChanged("created", "short");
}

async function handleChatStreamUserMessage(payload: Record<string, unknown>, sessionKey?: string): Promise<void> {
  const content = payload.content;
  if (!content || typeof content !== "string" || content.length < 5) return;
  const sessionId = payload.sessionId as string;
  if (!sessionId) return;

  const buf = await getOrCreateBuffer(sessionId, sessionKey || "default", payload.title as string | undefined);
  buf.currentUserMessage = content;
}

function handleChatStreamThinking(payload: Record<string, unknown>, sessionKey?: string): void {
  const content = payload.content;
  if (!content || typeof content !== "string") return;

  const sessionId = payload.sessionId as string | undefined;
  const key = sessionId || getBufferKeyFromPayload(payload, sessionKey);
  const buf = exchangeBuffers.get(key);
  if (buf) {
    buf.currentThinking.push(content);
  }
}

async function handleChatStreamDelta(payload: Record<string, unknown>, sessionKey?: string): Promise<void> {
  const content = payload.content;
  if (typeof content !== "string" || content.length === 0) return;

  const sessionId = payload.sessionId as string | undefined;
  const key = sessionId || getBufferKeyFromPayload(payload, sessionKey);
  if (!exchangeBuffers.has(key) && sessionId) {
    await getOrCreateBuffer(sessionId, sessionKey || "default");
  }
  const buf = exchangeBuffers.get(key);
  if (buf) {
    buf.currentChunks.push(content);
  }
}

function handleChatStreamToolCall(payload: Record<string, unknown>, sessionKey?: string): void {
  const toolName = payload.toolName as string | undefined;
  if (!toolName) return;

  const sessionId = payload.sessionId as string | undefined;
  const key = sessionId || getBufferKeyFromPayload(payload, sessionKey);
  const buf = exchangeBuffers.get(key);
  if (buf) {
    if (toolName === "observe" || toolName === "think") {
      const args = payload.arguments as Record<string, unknown> | undefined;
      const thoughtType = (args?.type as string) || "self";
      const thoughtContent = (args?.content as string) || "";
      if (thoughtContent) {
        buf.currentThoughts.push({ type: thoughtType, content: thoughtContent });
      }
    } else {
      const query = extractToolQuery(payload.arguments as Record<string, unknown> | undefined);
      buf.currentTools.push({ name: toolName, query });
    }
  }
}

async function handleSessionMetadataUpdated(payload: Record<string, unknown>): Promise<void> {
  const sessionId = payload.sessionId as string | undefined;
  if (!sessionId || !payload.title) return;
  const buf = exchangeBuffers.get(sessionId);
  if (!buf) return;

  buf.conversationTitle = payload.title as string;
  if (buf.turns.length > 0) {
    log.debug(
      `Raw exchange title memory update disabled for session ${buf.sessionId} -> "${payload.title}"`,
    );
  }
}

async function handleChatStreamDone(payload: Record<string, unknown>, sessionKey?: string): Promise<void> {
  const sessionId = payload.sessionId as string | undefined;
  const key = sessionId || getBufferKeyFromPayload(payload, sessionKey);
  const buf = exchangeBuffers.get(key);
  if (buf) {
    await finalizeTurn(buf);
  }
}

async function handleChatStreamError(payload: Record<string, unknown>, sessionKey?: string): Promise<void> {
  const sessionId = payload.sessionId as string | undefined;
  const key = sessionId || getBufferKeyFromPayload(payload, sessionKey);
  const buf = exchangeBuffers.get(key);
  if (buf && (buf.currentChunks.length > 0 || buf.currentUserMessage)) {
    await finalizeTurn(buf);
  }
}

async function handleAgentToolResult(busEvent: BusEvent): Promise<void> {
  const { payload } = busEvent;
  const toolName = payload?.toolName as string | undefined;
  if (!toolName || !RICH_TOOL_NAMES.has(toolName)) return;

  if (payload.error) return;

  const result = typeof payload.result === "string" ? payload.result : "";
  if (!result || result.length < 10) return;

  const sourceId = `tool-${payload.toolCallId || busEvent.id}`;
  const status = payload.error ? "ERROR" : "ok";
  const query = extractToolQuery(payload.arguments as Record<string, unknown> | undefined);
  const displayTitle = query
    ? `${toolName}("${query.length > 60 ? query.slice(0, 60) + "..." : query}")`
    : toolName;
  await withQueryAttributionAsync("memory-write", () => memoryStorage.ingest(
    `[Tool: ${toolName}] (${status}) ${formatTimestamp()}\n${result}`,
    "tool" as MemorySource,
    sourceId,
    { toolName, error: payload.error, runId: busEvent.runId },
    undefined,
    displayTitle,
  ), "tool-result-ingest");
  emitEntriesChanged("created", "short");
}

async function handleEvent(busEvent: BusEvent): Promise<void> {
  try {
    const { event, payload, sessionKey } = busEvent;

    if (event === "chat.stream") {
      const type = payload?.type;
      const sessionId = payload?.sessionId as string | undefined;

      if (type === "user_message" || type === "system_prompt_message") { await handleChatStreamUserMessage(payload, sessionKey); return; }
      if (type === "thinking" || type === "thinking_complete") { handleChatStreamThinking(payload, sessionKey); return; }
      if (type === "delta") { await handleChatStreamDelta(payload, sessionKey); return; }
      if (type === "tool_call") { handleChatStreamToolCall(payload, sessionKey); return; }
      if (type === "title_updated" || type === "session_updated") { await handleSessionMetadataUpdated(payload); return; }
      if (type === "done") { await handleChatStreamDone(payload, sessionKey); return; }
      if (type === "error") { await handleChatStreamError(payload, sessionKey); return; }

      if (type === "voice_xyz_response") {
        if (!sessionId || !payload.content) return;
        await handleVoiceXyzResponse(sessionId, payload.content as string, sessionKey || "default");
        return;
      }

      if (type === "voice_insight") {
        if (!sessionId || !payload.content) return;
        await handleVoiceInsight(sessionId, payload.content as string);
        return;
      }

      return;
    }

    if (event === "agent.tool_result") {
      await handleAgentToolResult(busEvent);
      return;
    }

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    log.error(`Error handling event ${busEvent.event}: ${message}${stack ? `\n${stack}` : ""}`);
  }
}

let registered = false;
export function registerMemoryListener(): void {
  if (registered) return;
  registered = true;

  eventBus.on("event", (busEvent: BusEvent) => {
    const { event, payload } = busEvent;

    if (event === "chat.autonomous.started") {
      const p = payload as Record<string, unknown> | undefined;
      const sessionId = p?.sessionId as string | undefined;
      const addToMemory = p?.addToMemory;
      if (sessionId && addToMemory === false) {
        memorySuppressedConversations.add(sessionId);
        log.debug(`Suppressing memory writes for session ${sessionId} (addToMemory=false)`);
      }
      return;
    }

    if (event === "chat.autonomous.completed" || event === "chat.autonomous.failed") {
      const p = payload as Record<string, unknown> | undefined;
      const sessionId = p?.sessionId as string | undefined;
      if (sessionId) {
        memorySuppressedConversations.delete(sessionId);
      }
      return;
    }

    if (
      event === "chat.stream" ||
      event === "agent.tool_result"
    ) {
      handleEvent(busEvent).catch((err) => {
        log.error(`Unhandled error: ${err.message}`);
      });
    }
  });


  log.info("Registered memory event listener with legacy propagation disabled");
}
