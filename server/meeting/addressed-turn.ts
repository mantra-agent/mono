import { chatStorage, type Message } from "../integrations/chat/storage";
import { chatCompletion } from "../model-client";
import { ACTIVITY_FRAMING } from "../job-profiles";
import { createLogger } from "../log";
import type { MeetingParticipant } from "@shared/models/chat";

const log = createLogger("MeetingAddressedInference");
const ACTIVE_EXCHANGE_MS = 45_000;
const MAX_CONTEXT_TURNS = 8;
const INFERENCE_TIMEOUT_MS = 1_500;

export type AddressDecision =
  | { decision: "addressed"; reason: string; confidence: number; prompt: string }
  | { decision: "not_addressed"; reason: string; confidence: number }
  | { decision: "uncertain"; reason: string; confidence: number };

export interface AddressedInferenceInput {
  sessionId: string;
  sessionKey: string;
  turnId: string;
  text: string;
  speakerLabel: string;
  participants: MeetingParticipant[];
}

function explicitInvocation(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = /(?:^|[.!?]\s+)(?:hey[\s,.:;!?-]+)?m[ao]ntra\b[\s,.:;!?-]*(.*)$/i.exec(normalized);
  return match ? (match[1]?.trim() || normalized) : null;
}

function clearlyAddressesOther(text: string, speaker: string, participants: MeetingParticipant[]): string | null {
  const start = text.trim().match(/^(?:hey\s+)?([A-Z][\p{L}'-]+)/u)?.[1];
  if (!start) return null;
  return participants.find((p) => p.label !== speaker && p.label.split(/\s+/)[0]?.toLowerCase() === start.toLowerCase())?.label ?? null;
}

function recentContext(messages: Message[], currentMessageId?: string): Message[] {
  return messages.filter((m) => m.id !== currentMessageId && (m.role === "user" || m.role === "assistant")).slice(-MAX_CONTEXT_TURNS);
}

export async function inferAddressedMeetingTurn(input: AddressedInferenceInput): Promise<AddressDecision> {
  const explicit = explicitInvocation(input.text);
  if (explicit) return { decision: "addressed", reason: "explicit_mantra_alias", confidence: 1, prompt: explicit };

  const other = clearlyAddressesOther(input.text, input.speakerLabel, input.participants);
  if (other) return { decision: "not_addressed", reason: `addressed_other:${other}`, confidence: 0.98 };

  const messages = recentContext(await chatStorage.getMessagesBySession(input.sessionId));
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const elapsed = lastAssistant ? Date.now() - Date.parse(lastAssistant.createdAt) : Number.POSITIVE_INFINITY;
  const agentAskedSpeaker = !!lastAssistant && elapsed <= ACTIVE_EXCHANGE_MS && /\?\s*$/.test(lastAssistant.content.trim());
  if (agentAskedSpeaker) return { decision: "addressed", reason: "reply_to_agent_question", confidence: 0.96, prompt: input.text.trim() };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const context = messages.map((m) => ({ role: m.role, speaker: m.speaker?.label, text: m.content.slice(0, 1200) }));
    const result = await chatCompletion({
      activity: ACTIVITY_FRAMING,
      messages: [
        { role: "system", content: "Classify whether the final meeting turn is directed to the AI agent Mantra. Return JSON only: {decision:'addressed'|'not_addressed'|'uncertain',reason:string,confidence:number}. Prefer not_addressed for ordinary participant conversation. Never infer addressed merely because the statement is a question." },
        { role: "user", content: JSON.stringify({ turn: input.text.slice(0, 2000), speaker: input.speakerLabel, recentTurns: context, agentAskedSpeaker, msSinceAgentSpoke: Number.isFinite(elapsed) ? elapsed : null, participants: input.participants.map((p) => p.label) }) },
      ],
      jsonMode: true,
      maxTokens: 96,
      temperature: 0,
      signal: controller.signal,
      metadata: { source: "meeting_addressed_inference", activity: ACTIVITY_FRAMING, sessionId: input.sessionId, sessionKey: input.sessionKey, requestId: input.turnId },
    });
    const parsed = JSON.parse(result.content) as { decision?: string; reason?: string; confidence?: number };
    if (!(["addressed", "not_addressed", "uncertain"] as string[]).includes(parsed.decision || "")) throw new Error("invalid decision");
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    if (parsed.decision === "addressed") return { decision: "addressed", reason: parsed.reason || "contextual_inference", confidence, prompt: input.text.trim() };
    return { decision: parsed.decision as "not_addressed" | "uncertain", reason: parsed.reason || "contextual_inference", confidence };
  } catch (error) {
    log.warn(`address inference degraded sessionId=${input.sessionId} turnId=${input.turnId}`, error);
    return { decision: "uncertain", reason: controller.signal.aborted ? "timeout" : "invalid_inference", confidence: 0 };
  } finally { clearTimeout(timeout); }
}

export type AddressedTurnClaim = "claimed" | "duplicate" | "disabled" | "not_meeting";
export async function claimAddressedMeetingTurn(sessionId: string, turnId: string): Promise<AddressedTurnClaim> {
  const session = await chatStorage.getSession(sessionId);
  if (!session?.meeting || session.type !== "meeting") return "not_meeting";
  if (session.meeting.addressedResponsesEnabled === false) return "disabled";
  if (session.meeting.lastAddressedTurnId === turnId) return "duplicate";
  await chatStorage.updateMeetingMeta(sessionId, { lastAddressedTurnId: turnId });
  return "claimed";
}
