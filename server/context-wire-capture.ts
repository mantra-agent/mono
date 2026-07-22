// Bounded, ownership-scoped capture of the real outbound model-boundary payload,
// consumed by the Context viewer's wire-payload breakdown.
//
// Design constraints (see plan + AGENTS.md):
//  - Single latest value PER USER (not unbounded history), so the viewer shows a
//    truthful "last real call" without growing memory. The user map is capped.
//  - Ownership-scoped: a capture is keyed by the owning user principal and only
//    returned to that same user. One user never sees another user's prompt.
//  - Non-blocking + fail-quiet at the hot path: a capture failure never affects
//    the model call.
import { createLogger } from "./log";
import { getCurrentPrincipal } from "./principal-context";

const log = createLogger("context-wire-capture");

/** Raw captured payload sizes. Token estimates are derived by the viewer route. */
export interface WireBoundaryCaptureRaw {
  capturedAt: string;
  provider: string;
  model: string;
  activity: string | null;
  systemPromptChars: number;
  toolSchemaChars: number;
  conversationChars: number;
  providerInputTokens: number | null;
  providerCacheReadTokens: number | null;
  providerTokensMayBeCumulative: boolean;
  systemPromptExcerpt: string;
  systemPromptExcerptTruncated: boolean;
}

const EXCERPT_CAP = 4000;
const MAX_USERS = 100;

const capturesByUser = new Map<string, WireBoundaryCaptureRaw>();

export interface WireBoundaryCaptureInput {
  provider: string;
  model: string;
  activity?: string | null;
  systemPrompt: string | undefined;
  /** The tool schema objects actually handed to the model boundary. */
  tools: unknown[];
  /** The rendered conversation/user-turn text sent alongside the system prompt. */
  conversation: string;
  providerInputTokens?: number | null;
  providerCacheReadTokens?: number | null;
  providerTokensMayBeCumulative?: boolean;
}

/**
 * Record the latest wire payload for the current user principal. Safe to call in
 * the model streaming hot path: it resolves the owning user, bounds memory, and
 * swallows any error.
 */
export function recordWireBoundaryCapture(input: WireBoundaryCaptureInput): void {
  try {
    const principal = getCurrentPrincipal();
    if (!principal || principal.actorType !== "user" || !principal.userId) return;
    const userId = principal.userId;

    const sys = input.systemPrompt ?? "";
    const truncated = sys.length > EXCERPT_CAP;
    const capture: WireBoundaryCaptureRaw = {
      capturedAt: new Date().toISOString(),
      provider: input.provider,
      model: input.model,
      activity: input.activity ?? null,
      systemPromptChars: sys.length,
      toolSchemaChars: JSON.stringify(input.tools ?? []).length,
      conversationChars: input.conversation.length,
      providerInputTokens: input.providerInputTokens ?? null,
      providerCacheReadTokens: input.providerCacheReadTokens ?? null,
      providerTokensMayBeCumulative: input.providerTokensMayBeCumulative ?? false,
      systemPromptExcerpt: truncated ? sys.slice(0, EXCERPT_CAP) : sys,
      systemPromptExcerptTruncated: truncated,
    };

    // Move-to-end so recently-updated users survive eviction, then bound the map.
    capturesByUser.delete(userId);
    while (capturesByUser.size >= MAX_USERS) {
      const oldest = capturesByUser.keys().next().value;
      if (oldest === undefined) break;
      capturesByUser.delete(oldest);
    }
    capturesByUser.set(userId, capture);
    log.debug(
      `recorded wire capture user=${userId} provider=${input.provider} model=${input.model} ` +
      `inputTokens=${capture.providerInputTokens ?? "?"} sysChars=${capture.systemPromptChars} toolChars=${capture.toolSchemaChars}`,
    );
  } catch (err) {
    log.debug(`recordWireBoundaryCapture skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Return the latest capture owned by `userId`, or null. */
export function getWireBoundaryCapture(userId: string | null | undefined): WireBoundaryCaptureRaw | null {
  if (!userId) return null;
  return capturesByUser.get(userId) ?? null;
}
