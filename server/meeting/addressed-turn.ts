import { chatStorage } from "../integrations/chat/storage";

export type MeetingAddressDecision =
  | { decision: "addressed"; prompt: string }
  | { decision: "not_prefix" }
  | { decision: "empty_prompt" };

/**
 * Conservative wake-word boundary. Only an utterance-leading invocation is
 * accepted. Montra is the single tolerated STT variant; broader fuzzy matching
 * would create unsolicited interjections.
 */
export function classifyMeetingAddress(text: string): MeetingAddressDecision {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = /^(?:hey[\s,.:;!?-]+)?m[ao]ntra\b[\s,.:;!?-]*(.*)$/i.exec(normalized);
  if (!match) return { decision: "not_prefix" };
  const prompt = match[1]?.trim() ?? "";
  if (!prompt) return { decision: "empty_prompt" };
  return { decision: "addressed", prompt };
}

export type AddressedTurnClaim = "claimed" | "duplicate" | "disabled" | "not_meeting";

/** Persist the claim before execution so webhook replay and restart are safe. */
export async function claimAddressedMeetingTurn(
  sessionId: string,
  messageId: string,
): Promise<AddressedTurnClaim> {
  const session = await chatStorage.getSession(sessionId);
  if (!session?.meeting || session.type !== "meeting") return "not_meeting";
  if (session.meeting.addressedResponsesEnabled === false) return "disabled";
  if (session.meeting.lastAddressedMessageId === messageId) return "duplicate";
  await chatStorage.updateMeetingMeta(sessionId, { lastAddressedMessageId: messageId });
  return "claimed";
}
