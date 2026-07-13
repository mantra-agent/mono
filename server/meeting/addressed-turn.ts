import { chatStorage, type Message } from "../integrations/chat/storage";
import { chatCompletion } from "../model-client";
import { ACTIVITY_FRAMING } from "../job-profiles";
import { createLogger } from "../log";
import type { MeetingParticipant } from "@shared/models/chat";

const log = createLogger("MeetingAddressedInference");
const ACTIVE_EXCHANGE_MS = 45_000;
const MAX_CONTEXT_TURNS = 8;
const INFERENCE_TIMEOUT_MS = 1_500;

export type MeetingAddressOutcome = "explicit" | "classified" | "fallback" | "ignored";
export type MeetingParticipationBehavior = "on_address";

export interface MeetingAddressDecision {
  outcome: MeetingAddressOutcome;
  shouldRespond: boolean;
  reason: string;
  latencyMs: number;
  confidence: number;
  prompt?: string;
  classifierFailure?: "timeout" | "error" | "invalid_output";
}

export interface AddressedInferenceInput {
  sessionId: string;
  sessionKey: string;
  turnId: string;
  text: string;
  speakerLabel: string;
  participants: MeetingParticipant[];
  meetingBehavior?: MeetingParticipationBehavior;
}

interface ExchangeContext {
  messages: Message[];
  lastAssistant?: Message;
  msSinceAgentSpoke: number;
  agentAskedQuestion: boolean;
  speakerContinuesAgentExchange: boolean;
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

function speakerLabel(message: Message): string | undefined {
  return message.speaker?.label?.trim().toLowerCase();
}

function buildExchangeContext(messages: Message[], speaker: string): ExchangeContext {
  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      lastAssistantIndex = index;
      break;
    }
  }
  const lastAssistant = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : undefined;
  const msSinceAgentSpoke = lastAssistant
    ? Date.now() - Date.parse(lastAssistant.createdAt)
    : Number.POSITIVE_INFINITY;
  const agentAskedQuestion = !!lastAssistant
    && msSinceAgentSpoke <= ACTIVE_EXCHANGE_MS
    && isQuestion(lastAssistant.content);
  const turnsAfterAgent = lastAssistantIndex >= 0 ? messages.slice(lastAssistantIndex + 1) : [];
  const interveningOtherSpeaker = turnsAfterAgent.some((message) =>
    message.role === "user"
    && !!speakerLabel(message)
    && speakerLabel(message) !== speaker.trim().toLowerCase(),
  );

  return {
    messages,
    lastAssistant,
    msSinceAgentSpoke,
    agentAskedQuestion,
    speakerContinuesAgentExchange: !!lastAssistant
      && msSinceAgentSpoke <= ACTIVE_EXCHANGE_MS
      && !interveningOtherSpeaker,
  };
}

function isQuestion(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/\?\s*$/.test(normalized)) return true;
  return /^(?:can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|may|might|what|when|where|which|who|whom|whose|why|how)\b/i.test(normalized);
}

function decision(
  startedAt: number,
  outcome: MeetingAddressOutcome,
  shouldRespond: boolean,
  reason: string,
  confidence: number,
  prompt?: string,
  classifierFailure?: MeetingAddressDecision["classifierFailure"],
): MeetingAddressDecision {
  return {
    outcome,
    shouldRespond,
    reason,
    latencyMs: Date.now() - startedAt,
    confidence,
    ...(prompt ? { prompt } : {}),
    ...(classifierFailure ? { classifierFailure } : {}),
  };
}

function deterministicFallback(
  input: AddressedInferenceInput,
  context: ExchangeContext,
  startedAt: number,
  classifierFailure: MeetingAddressDecision["classifierFailure"],
): MeetingAddressDecision {
  const meetingBehavior = input.meetingBehavior ?? "on_address";
  const questionForm = isQuestion(input.text);
  const conversationContinues = context.agentAskedQuestion || context.speakerContinuesAgentExchange;
  const shouldRespond = meetingBehavior === "on_address" && questionForm && conversationContinues;
  const reason = shouldRespond
    ? context.agentAskedQuestion
      ? "classifier_failure_reply_to_recent_agent_question"
      : "classifier_failure_question_in_active_agent_exchange"
    : !questionForm
      ? "classifier_failure_non_question"
      : !conversationContinues
        ? "classifier_failure_question_without_agent_continuity"
        : "classifier_failure_meeting_behavior_disallows_response";

  return decision(
    startedAt,
    "fallback",
    shouldRespond,
    reason,
    shouldRespond ? 0.82 : 0.9,
    shouldRespond ? input.text.trim() : undefined,
    classifierFailure,
  );
}

export async function inferAddressedMeetingTurn(input: AddressedInferenceInput): Promise<MeetingAddressDecision> {
  const startedAt = Date.now();
  const explicit = explicitInvocation(input.text);
  if (explicit) return decision(startedAt, "explicit", true, "explicit_mantra_alias", 1, explicit);

  const other = clearlyAddressesOther(input.text, input.speakerLabel, input.participants);
  if (other) return decision(startedAt, "ignored", false, `addressed_other:${other}`, 0.98);

  const messages = recentContext(await chatStorage.getMessagesBySession(input.sessionId));
  const exchange = buildExchangeContext(messages, input.speakerLabel);
  if (exchange.agentAskedQuestion) {
    return decision(startedAt, "classified", true, "reply_to_recent_agent_question", 0.96, input.text.trim());
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const context = messages.map((message) => ({
      role: message.role,
      speaker: message.speaker?.label,
      text: message.content.slice(0, 1200),
    }));
    const result = await chatCompletion({
      activity: ACTIVITY_FRAMING,
      messages: [
        { role: "system", content: "Classify whether the final meeting turn is directed to the AI agent Mantra. Return JSON only: {decision:'addressed'|'not_addressed'|'uncertain',reason:string,confidence:number}. Prefer not_addressed for ordinary participant conversation. Never infer addressed merely because the statement is a question." },
        { role: "user", content: JSON.stringify({ turn: input.text.slice(0, 2000), speaker: input.speakerLabel, recentTurns: context, agentAskedSpeaker: exchange.agentAskedQuestion, msSinceAgentSpoke: Number.isFinite(exchange.msSinceAgentSpoke) ? exchange.msSinceAgentSpoke : null, participants: input.participants.map((participant) => participant.label) }) },
      ],
      jsonMode: true,
      maxTokens: 96,
      temperature: 0,
      signal: controller.signal,
      metadata: { source: "meeting_addressed_inference", activity: ACTIVITY_FRAMING, sessionId: input.sessionId, sessionKey: input.sessionKey, requestId: input.turnId },
    });
    const parsed = JSON.parse(result.content) as { decision?: string; reason?: string; confidence?: number };
    if (!(["addressed", "not_addressed", "uncertain"] as string[]).includes(parsed.decision || "")) {
      throw new Error("invalid decision");
    }
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    if (parsed.decision === "addressed") {
      return decision(startedAt, "classified", true, parsed.reason || "contextual_inference", confidence, input.text.trim());
    }
    return decision(startedAt, "ignored", false, parsed.reason || `classifier_${parsed.decision}`, confidence);
  } catch (error) {
    const classifierFailure = controller.signal.aborted
      ? "timeout"
      : error instanceof SyntaxError || (error instanceof Error && error.message === "invalid decision")
        ? "invalid_output"
        : "error";
    const fallback = deterministicFallback(input, exchange, startedAt, classifierFailure);
    log.warn(
      `address inference fallback sessionId=${input.sessionId} turnId=${input.turnId} failure=${classifierFailure} outcome=${fallback.outcome} shouldRespond=${fallback.shouldRespond} reason=${fallback.reason} latencyMs=${fallback.latencyMs}`,
      error,
    );
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

export type AddressedTurnClaim = "claimed" | "duplicate" | "not_meeting";
export async function claimAddressedMeetingTurn(sessionId: string, turnId: string): Promise<AddressedTurnClaim> {
  const session = await chatStorage.getSession(sessionId);
  if (!session?.meeting || session.type !== "meeting") return "not_meeting";
  if (session.meeting.lastAddressedTurnId === turnId) return "duplicate";
  await chatStorage.updateMeetingMeta(sessionId, { lastAddressedTurnId: turnId });
  return "claimed";
}
