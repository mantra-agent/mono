// Orientation Bootstrap — pre-routing session orientation stage.
//
// Problem: unoriented sessions run on whatever persona is currently active
// (often a fast-tier persona). The fast tier reliably fails to make the
// required first-turn `orient` call inside a full assembled context, leaving
// sessions untitled and pinned to the wrong tier for the whole conversation.
//
// Fix: orientation is a routing decision, not a conversation. Before model
// routing resolves for a chat turn, an unoriented session gets a single
// fixed-template fast-tier classification call (no context assembly) that
// picks title, topics, and persona from the persona definitions. The result
// is applied through the canonical `orient` mutation path, so persona
// activation, session events, and context flags all flow through the same
// enforcement boundary as a model-issued orient call. Model routing then
// resolves from the newly activated persona, and the main turn runs with
// full context on the correct tier. The handoff is invisible to the user.
//
// Fail-closed: if the classification call or parse fails, the Default
// persona is activated (never left on a stale fast-tier persona) and the
// session stays untitled so the next turn retries.
import { createLogger } from "./log";
import { chatCompletion } from "./model-client";
import { ACTIVITY_CHAT } from "./job-profiles";
import { personaStorage, type PersonaEntry } from "./file-storage/persona-storage";

const log = createLogger("orientation-bootstrap");

const BOOTSTRAP_MAX_TOKENS = 300;
const PLACEHOLDER_TITLES = new Set(["New Session", "New Chat"]);

/** True when the session carries a real (non-placeholder) title, meaning orientation already happened. */
export function hasRealSessionTitle(title: string | null | undefined): boolean {
  return !!title && !PLACEHOLDER_TITLES.has(title);
}

export interface OrientationBootstrapResult {
  applied: boolean;
  skipped: "already-oriented" | "no-session" | null;
  title?: string;
  topics?: string[];
  personaName?: string;
  fallback?: boolean;
  elapsedMs: number;
  llm?: {
    model: string;
    provider: string;
    tier?: string;
    connectorLabel?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      visibleOutputTokens?: number;
    };
  };
}

interface BootstrapClassification {
  title: string;
  topics: string[];
  persona: string;
}

function buildBootstrapPrompt(personas: PersonaEntry[]): string {
  const table = personas
    .filter((p) => !p.isSystem)
    .map((p) => {
      const examples = p.routingExamples.length
        ? ` Examples: ${p.routingExamples.map((e) => `"${e}"`).join(" · ")}`
        : "";
      return `- ${p.name}: ${p.description}${examples}`;
    })
    .join("\n");
  return [
    "You are the session router for Agent, Ray's personal AI. A new conversation is starting.",
    "Your only job is to classify the opening message and return JSON. Do not answer the message.",
    "",
    "Available personas:",
    table,
    "",
    "Return a JSON object with exactly these fields:",
    '- "title": 1-3 word session title',
    '- "topics": array of up to 8 short topic keywords',
    '- "persona": the persona name that best fits the opening (use "Default" when ambiguous)',
  ].join("\n");
}

function parseClassification(raw: string, personas: PersonaEntry[]): BootstrapClassification | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim().split(/\s+/).slice(0, 3).join(" ") : "";
  if (!title) return null;
  const topics = Array.isArray(obj.topics)
    ? obj.topics.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()).slice(0, 8)
    : [];
  const requested = typeof obj.persona === "string" ? obj.persona.trim() : "";
  const match = personas.find((p) => p.name.toLowerCase() === requested.toLowerCase());
  const fallback = personas.find((p) => p.isDefault) ?? personas.find((p) => p.name === "Default");
  const persona = match ?? fallback;
  if (!persona) return null;
  return { title, topics, persona: persona.name };
}

/** Apply orientation through the canonical orient mutation path (same boundary as model-issued orient calls). */
async function applyOrient(
  sessionId: string,
  sessionKey: string | undefined,
  args: Record<string, unknown>,
): Promise<{ error?: boolean; result: string }> {
  const { executeTool } = await import("./bridge-tools");
  const toolCallId = `orientation-bootstrap-${Date.now()}`;
  return executeTool("orient", toolCallId, { ...args, reasoning: "Orientation bootstrap routed this session before model selection." }, { sessionId, sessionKey });
}

/**
 * Ensure the session is oriented before model routing resolves.
 * Runs a single fixed-template fast-tier classification for unoriented
 * sessions and applies it via the canonical orient path. Never throws.
 */
export async function ensureSessionOriented(options: {
  sessionId: string;
  sessionKey?: string;
  userMessage: string;
  onLlmStart?: () => void | Promise<void>;
}): Promise<OrientationBootstrapResult> {
  const startedAt = Date.now();
  const { sessionId, sessionKey, userMessage, onLlmStart } = options;
  try {
    const { chatFileStorage } = await import("./chat-file-storage");
    const session = await chatFileStorage.getSession(sessionId);
    if (!session) {
      return { applied: false, skipped: "no-session", elapsedMs: Date.now() - startedAt };
    }
    if (hasRealSessionTitle(session.title)) {
      return { applied: false, skipped: "already-oriented", elapsedMs: Date.now() - startedAt };
    }

    const personas = await personaStorage.list();

    await onLlmStart?.();

    const completion = await chatCompletion({
      activity: ACTIVITY_CHAT,
      semanticTierOverride: "fast",
      overrideReason: "orientation-bootstrap: fixed-template classification runs on the fast tier by design",
      jsonMode: true,
      maxTokens: BOOTSTRAP_MAX_TOKENS,
      temperature: 0,
      messages: [
        { role: "system", content: buildBootstrapPrompt(personas) },
        { role: "user", content: `Opening message:\n${userMessage.slice(0, 4000)}` },
      ],
      metadata: { source: "orientation-bootstrap", sessionId, sessionKey },
    });

    const routing = (completion.metadata?.routing || {}) as Record<string, unknown>;
    const llm = {
      model: typeof routing.resolvedModel === "string" ? routing.resolvedModel : completion.model,
      provider: typeof routing.connectorProvider === "string" ? routing.connectorProvider : completion.provider,
      tier: typeof routing.requestedTier === "string" ? routing.requestedTier : undefined,
      connectorLabel: typeof routing.connectorLabel === "string" ? routing.connectorLabel : undefined,
      usage: completion.usage,
    };

    const classification = parseClassification(completion.content || "", personas);
    if (!classification) {
      log.warn(`bootstrap classification unparseable sessionId=${sessionId} raw=${(completion.content || "").slice(0, 200)}`);
      return await failClosed(sessionId, sessionKey, startedAt);
    }

    const applied = await applyOrient(sessionId, sessionKey, {
      title: classification.title,
      topics: classification.topics,
      persona: classification.persona,
      // The orient handler derives semantic recommendations from title/topics/persona.
      // An explicit empty map means the bootstrap also establishes context scope in
      // this one mutation, even when no optional sections are recommended.
      contextFlags: {},
    });
    if (applied.error) {
      log.warn(`bootstrap orient apply failed sessionId=${sessionId}: ${applied.result}`);
      return await failClosed(sessionId, sessionKey, startedAt);
    }

    log.info(`bootstrap oriented sessionId=${sessionId} title="${classification.title}" persona=${classification.persona} topics=${classification.topics.length} elapsedMs=${Date.now() - startedAt}`);
    return {
      applied: true,
      skipped: null,
      title: classification.title,
      topics: classification.topics,
      personaName: classification.persona,
      elapsedMs: Date.now() - startedAt,
      llm,
    };
  } catch (err) {
    log.warn(`bootstrap failed sessionId=${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return await failClosed(sessionId, sessionKey, startedAt);
  }
}

/** Fail closed: activate the Default persona so the turn never runs on a stale fast-tier persona. Session stays untitled and retries next turn. */
async function failClosed(
  sessionId: string,
  sessionKey: string | undefined,
  startedAt: number,
): Promise<OrientationBootstrapResult> {
  try {
    const personas = await personaStorage.list();
    const fallback = personas.find((p) => p.isDefault) ?? personas.find((p) => p.name === "Default");
    if (fallback) {
      const active = await personaStorage.getActiveOrNull();
      if (!active || active.id !== fallback.id) {
        const applied = await applyOrient(sessionId, sessionKey, { persona: fallback.name });
        if (applied.error) log.warn(`bootstrap fail-closed orient failed sessionId=${sessionId}: ${applied.result}`);
      }
      return { applied: false, skipped: null, personaName: fallback.name, fallback: true, elapsedMs: Date.now() - startedAt };
    }
  } catch (fallbackErr) {
    log.error(`bootstrap fail-closed fallback errored sessionId=${sessionId}: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
  }
  return { applied: false, skipped: null, fallback: true, elapsedMs: Date.now() - startedAt };
}
