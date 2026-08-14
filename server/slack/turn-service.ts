import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { chatFileStorage } from "../chat-file-storage";
import { stripExpressionTags } from "@shared/expression-tags";
import { SLACK_OUTPUT_CHAR_LIMIT } from "./contracts";

const SLACK_HISTORY_STAMP = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]]+\]\s*/;

export const SLACK_CHANNEL_PENDING_TEXT =
  "Channel conversations need a team Mantra. Until then, DM me.";

export interface SlackChatTurnInput {
  sessionId: string;
  eventId: string;
  eventType: string;
  content: string;
  signal: AbortSignal;
}

export type SlackChatTurnRunner = (input: {
  sessionId: string;
  eventId: string;
  content: string;
  signal: AbortSignal;
}) => Promise<string>;

let chatTurnRunner: SlackChatTurnRunner | null = null;

export function registerSlackChatTurnRunner(runner: SlackChatTurnRunner): void {
  chatTurnRunner = runner;
}

export async function executeSlackTurn(
  principal: Principal,
  input: SlackChatTurnInput,
): Promise<string> {
  return runWithPrincipal(principal, async () => {
    if (input.eventType === "app_mention") return SLACK_CHANNEL_PENDING_TEXT;
    if (!chatTurnRunner) throw new Error("slack_chat_turn_unregistered");
    const content = await resolveTurnContent(input);
    const response = await chatTurnRunner({
      sessionId: input.sessionId,
      eventId: input.eventId,
      content,
      signal: input.signal,
    });
    const trimmed = sanitizeSlackOutbound(response).slice(0, SLACK_OUTPUT_CHAR_LIMIT);
    if (!trimmed) throw new Error("slack_empty_response");
    return trimmed;
  });
}

function sanitizeSlackOutbound(text: string): string {
  return stripExpressionTags(text.replace(SLACK_HISTORY_STAMP, "")).replace(/\s+$/g, "").trim();
}

async function resolveTurnContent(input: SlackChatTurnInput): Promise<string> {
  const live = input.content.trim();
  if (live) return live;
  const messages = await chatFileStorage.getMessagesBySession(input.sessionId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && messages[index].content?.trim()) {
      return messages[index].content.trim();
    }
  }
  throw new Error("slack_turn_input_unavailable");
}
