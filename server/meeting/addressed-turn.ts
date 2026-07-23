import { chatStorage, type Message } from "../integrations/chat/storage";
import { chatCompletion } from "../model-client";
import { ACTIVITY_FRAMING } from "../job-profiles";
import { createLogger } from "../log";
import type { MeetingParticipant } from "@shared/models/chat";

const log = createLogger("MeetingParticipationInference");
const ACTIVE_EXCHANGE_MS = 45_000;
const MAX_CONTEXT_TURNS = 8;
const INFERENCE_TIMEOUT_MS = 2_000;
const INFERENCE_EXPECTED_ABORT_REASON = "meeting_participation_deadline";

export type MeetingParticipationOutcome = "explicit" | "classified" | "fallback" | "ignored";

export interface MeetingParticipationEvidence {
  currentTurnIsQuestion: boolean;
  agentAskedQuestion: boolean;
  speakerContinuesAgentExchange: boolean;
  msSinceAgentSpoke: number | null;
  lastAssistantMessageId?: string;
  lastAssistantActivityAt?: string;
}

export interface MeetingParticipationDecision {
  outcome: MeetingParticipationOutcome;
  shouldRespond: boolean;
  reason: string;
  latencyMs: number;
  confidence: number;
  prompt?: string;
  classifierFailure?: "timeout" | "error" | "invalid_output";
  invocationKind?: "leading" | "middle" | "trailing";
  invocationAlias?: "mantra" | "mancha";
  evidence?: MeetingParticipationEvidence;
}

export interface MeetingParticipationInput {
  sessionId: string;
  sessionKey: string;
  turnId: string;
  currentMessageIds: string[];
  text: string;
  speakerLabel: string;
  participants: MeetingParticipant[];
}

interface ExchangeContext {
  messages: Message[];
  lastAssistant?: Message;
  lastAssistantActivityAt?: string;
  msSinceAgentSpoke: number;
  agentAskedQuestion: boolean;
  speakerContinuesAgentExchange: boolean;
}

interface ExplicitInvocation {
  prompt: string;
  kind: "leading" | "middle" | "trailing";
  alias: "mantra" | "mancha";
}

function normalizeInvocationAlias(alias: string | undefined): ExplicitInvocation["alias"] {
  return alias?.toLowerCase() === "mancha" ? "mancha" : "mantra";
}

function explicitInvocation(text: string): ExplicitInvocation | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const leading = /(?:^|[.!?]\s+)(?:(?:hey|hi|hello)[\s,.:;!?-]+)?(mantra|mancha)\b[\s,.:;!?-]*(.*)$/i.exec(normalized);
  if (leading) {
    return {
      prompt: leading[2]?.trim() || normalized,
      kind: "leading",
      alias: normalizeInvocationAlias(leading[1]),
    };
  }

  const middle = /\b(mantra|mancha)\b[\s,.:;!?-]+(.+)$/i.exec(normalized);
  if (middle) {
    const before = normalized.slice(0, middle.index).trim();
    const conversationalLeadIn = /(?:^|[.!?]\s+)(?:critically|also|then|finally|lastly|okay|ok|um|uh|and(?:\s+then)?)\b/i.test(before);
    if (conversationalLeadIn) {
      return {
        prompt: middle[2]?.trim() || normalized,
        kind: "middle",
        alias: normalizeInvocationAlias(middle[1]),
      };
    }
  }

  const punctuatedTrailing = /^(.+?)[,:;-]\s*(mantra|mancha)[\s,.:;!?-]*$/i.exec(normalized);
  if (punctuatedTrailing) {
    return {
      prompt: normalized,
      kind: "trailing",
      alias: normalizeInvocationAlias(punctuatedTrailing[2]),
    };
  }

  const questionTrailing = /^(.+?)\s+(mantra|mancha)[\s.!?]*$/i.exec(normalized);
  if (questionTrailing && isQuestion(questionTrailing[1] || "")) {
    return {
      prompt: normalized,
      kind: "trailing",
      alias: normalizeInvocationAlias(questionTrailing[2]),
    };
  }

  return null;
}

function clearlyAddressesOther(text: string, speaker: string, participants: MeetingParticipant[]): string | null {
  const start = text.trim().match(/^(?:hey\s+)?([A-Z][\p{L}'-]+)/u)?.[1];
  if (!start) return null;
  return participants.find((p) => p.label !== speaker && p.label.split(/\s+/)[0]?.toLowerCase() === start.toLowerCase())?.label ?? null;
}

function recentContext(messages: Message[], currentMessageIds: string[] = []): Message[] {
  const current = new Set(currentMessageIds);
  const boundary = messages.reduce(
    (latest, message, index) => current.has(message.id) ? Math.max(latest, index) : latest,
    -1,
  );
  const chronological = boundary >= 0 ? messages.slice(0, boundary + 1) : messages;
  return chronological
    .filter((message) => !current.has(message.id) && (message.role === "user" || message.role === "assistant"))
    .slice(-MAX_CONTEXT_TURNS);
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
  // Assistant messages are created as empty drafts before inference. Their
  // updatedAt advances when the completed response is persisted, so it is the
  // truthful conversational clock for follow-up detection.
  const lastAssistantActivityAt = lastAssistant
    ? lastAssistant.updatedAt || lastAssistant.createdAt
    : undefined;
  const lastAssistantActivityMs = lastAssistantActivityAt
    ? Date.parse(lastAssistantActivityAt)
    : Number.NaN;
  const msSinceAgentSpoke = Number.isFinite(lastAssistantActivityMs)
    ? Math.max(0, Date.now() - lastAssistantActivityMs)
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
    lastAssistantActivityAt,
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

function buildDecisionEvidence(
  input: MeetingParticipationInput,
  context: ExchangeContext,
): MeetingParticipationEvidence {
  return {
    currentTurnIsQuestion: isQuestion(input.text),
    agentAskedQuestion: context.agentAskedQuestion,
    speakerContinuesAgentExchange: context.speakerContinuesAgentExchange,
    msSinceAgentSpoke: Number.isFinite(context.msSinceAgentSpoke)
      ? context.msSinceAgentSpoke
      : null,
    ...(context.lastAssistant?.id
      ? { lastAssistantMessageId: context.lastAssistant.id }
      : {}),
    ...(context.lastAssistantActivityAt
      ? { lastAssistantActivityAt: context.lastAssistantActivityAt }
      : {}),
  };
}

function decision(
  startedAt: number,
  outcome: MeetingParticipationOutcome,
  shouldRespond: boolean,
  reason: string,
  confidence: number,
  prompt?: string,
  classifierFailure?: MeetingParticipationDecision["classifierFailure"],
  invocation?: Pick<ExplicitInvocation, "kind" | "alias">,
  evidence?: MeetingParticipationEvidence,
): MeetingParticipationDecision {
  return {
    outcome,
    shouldRespond,
    reason,
    latencyMs: Date.now() - startedAt,
    confidence,
    ...(prompt ? { prompt } : {}),
    ...(classifierFailure ? { classifierFailure } : {}),
    ...(invocation ? {
      invocationKind: invocation.kind,
      invocationAlias: invocation.alias,
    } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

function deterministicFallback(
  input: MeetingParticipationInput,
  context: ExchangeContext,
  startedAt: number,
  classifierFailure: MeetingParticipationDecision["classifierFailure"],
): MeetingParticipationDecision {
  const evidence = buildDecisionEvidence(input, context);
  const shouldRespond = context.agentAskedQuestion
    || (evidence.currentTurnIsQuestion && context.speakerContinuesAgentExchange);
  const reason = context.agentAskedQuestion
    ? "classifier_failure_reply_to_recent_agent_question"
    : shouldRespond
      ? "classifier_failure_question_in_active_agent_exchange"
      : !evidence.currentTurnIsQuestion
        ? "classifier_failure_non_question_without_agent_question"
        : "classifier_failure_question_without_agent_continuity";

  return decision(
    startedAt,
    "fallback",
    shouldRespond,
    reason,
    shouldRespond ? 0.82 : 0.9,
    shouldRespond ? input.text.trim() : undefined,
    classifierFailure,
    undefined,
    evidence,
  );
}

export async function inferMeetingParticipation(input: MeetingParticipationInput): Promise<MeetingParticipationDecision> {
  const startedAt = Date.now();
  const explicit = explicitInvocation(input.text);
  if (explicit) {
    return decision(
      startedAt,
      "explicit",
      true,
      `explicit_${explicit.alias}_${explicit.kind}`,
      1,
      explicit.prompt,
      undefined,
      explicit,
    );
  }

  const other = clearlyAddressesOther(input.text, input.speakerLabel, input.participants);
  if (other) return decision(startedAt, "ignored", false, `addressed_other:${other}`, 0.98);

  const messages = recentContext(
    await chatStorage.getMessagesBySession(input.sessionId),
    input.currentMessageIds,
  );
  const exchange = buildExchangeContext(messages, input.speakerLabel);
  const evidence = buildDecisionEvidence(input, exchange);
  if (exchange.agentAskedQuestion) {
    return decision(
      startedAt,
      "classified",
      true,
      "reply_to_recent_agent_question",
      0.96,
      input.text.trim(),
      undefined,
      undefined,
      evidence,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(INFERENCE_EXPECTED_ABORT_REASON)),
    INFERENCE_TIMEOUT_MS,
  );
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
        {
          role: "system",
          content: [
            "Decide whether the AI agent Mantra should speak after the final turn in a live multi-party meeting.",
            "Return JSON only: {decision:'respond'|'stay_silent'|'uncertain',reason:string,confidence:number}.",
            "Respond when Mantra is directly addressed, when someone clearly continues an active exchange with Mantra without repeating its name, or when someone answers a question Mantra asked.",
            "Stay silent during ordinary participant-to-participant conversation, when another participant is being addressed, or when the evidence is uncertain.",
            "A wake word is strong evidence, not a requirement. Never respond merely because the final turn is a question.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            turn: input.text.slice(0, 2000),
            speaker: input.speakerLabel,
            recentTurns: context,
            agentAskedQuestion: exchange.agentAskedQuestion,
            speakerContinuesAgentExchange: exchange.speakerContinuesAgentExchange,
            msSinceAgentSpoke: Number.isFinite(exchange.msSinceAgentSpoke)
              ? exchange.msSinceAgentSpoke
              : null,
            participants: input.participants.map((participant) => participant.label),
          }),
        },
      ],
      jsonMode: true,
      semanticTierOverride: "fast",
      latencyBudgetMs: INFERENCE_TIMEOUT_MS,
      overrideReason: "meeting participation inference has a 2000ms latency budget",
      maxTokens: 96,
      temperature: 0,
      expectedAbortReason: INFERENCE_EXPECTED_ABORT_REASON,
      signal: controller.signal,
      metadata: { source: "meeting_participation_inference", activity: ACTIVITY_FRAMING, sessionId: input.sessionId, sessionKey: input.sessionKey, requestId: input.turnId },
    });
    const parsed = JSON.parse(result.content) as { decision?: string; reason?: string; confidence?: number };
    if (!(["respond", "stay_silent", "uncertain"] as string[]).includes(parsed.decision || "")) {
      throw new Error("invalid decision");
    }
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    if (parsed.decision === "respond") {
      return decision(
        startedAt,
        "classified",
        true,
        parsed.reason || "contextual_participation",
        confidence,
        input.text.trim(),
        undefined,
        undefined,
        evidence,
      );
    }
    return decision(
      startedAt,
      "ignored",
      false,
      parsed.reason || `classifier_${parsed.decision}`,
      confidence,
      undefined,
      undefined,
      undefined,
      evidence,
    );
  } catch (error) {
    const classifierFailure = controller.signal.aborted
      ? "timeout"
      : error instanceof SyntaxError || (error instanceof Error && error.message === "invalid decision")
        ? "invalid_output"
        : "error";
    const fallback = deterministicFallback(input, exchange, startedAt, classifierFailure);
    log.warn(
      `participation inference fallback sessionId=${input.sessionId} turnId=${input.turnId} failure=${classifierFailure} outcome=${fallback.outcome} shouldRespond=${fallback.shouldRespond} reason=${fallback.reason} latencyMs=${fallback.latencyMs} currentTurnIsQuestion=${fallback.evidence?.currentTurnIsQuestion ?? "unknown"} agentAskedQuestion=${fallback.evidence?.agentAskedQuestion ?? "unknown"} speakerContinuesAgentExchange=${fallback.evidence?.speakerContinuesAgentExchange ?? "unknown"} msSinceAgentSpoke=${fallback.evidence?.msSinceAgentSpoke ?? "unknown"} lastAssistantMessageId=${fallback.evidence?.lastAssistantMessageId ?? "none"} lastAssistantActivityAt=${fallback.evidence?.lastAssistantActivityAt ?? "none"}`,
      error,
    );
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

export interface MeetingTurnCompleteness {
  complete: boolean;
  reason: string;
  confidence: number;
}

const TRAILING_INCOMPLETE_WORD = /\b(?:and|or|but|so|because|if|when|while|that|which|who|with|to|for|about|of|the|a|an|your|our|my|their|either|also|then|um|uh)\s*[,.…-]*$/i;
const INCOMPLETE_WAKE_PROMPT = /^(?:hey[\s,.:;!?-]+)?(?:mantra|mancha)\b[\s,.:;!?-]*(?:if|can|could|would|will|why|how|what|when|where|who)?\s*$/i;
const TRAILING_COMPLEMENT_VERB = /\b(?:predict|explain|describe|answer|elaborate|continue|compare|discuss|consider|imagine|suppose|think about|talk about|tell (?:me|us)|give (?:me|us) (?:an?|the) overview|look at|come up with)\s*[,.?!…-]*$/i;
const TRAILING_RELATIVE_SUBJECT = /\b(?:that|which|who|if|when|where|because)\s+(?:i|you|we|they|he|she|it)\s*[,.?!…-]*$/i;

/** Fast local gate between committed STT fragments and conversational turns. */
export function assessMeetingTurnCompleteness(
  text: string,
  priorDeferrals = 0,
): MeetingTurnCompleteness {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return { complete: false, reason: "empty", confidence: 1 };
  if (priorDeferrals >= 2) {
    return { complete: true, reason: "bounded_quiet_window_elapsed", confidence: 0.76 };
  }
  if (INCOMPLETE_WAKE_PROMPT.test(normalized)) {
    return { complete: false, reason: "wake_word_without_request", confidence: 0.99 };
  }
  if (TRAILING_INCOMPLETE_WORD.test(normalized) || TRAILING_RELATIVE_SUBJECT.test(normalized)) {
    return { complete: false, reason: "trailing_syntactic_continuation", confidence: 0.92 };
  }
  if (TRAILING_COMPLEMENT_VERB.test(normalized)) {
    return { complete: false, reason: "request_missing_complement", confidence: 0.9 };
  }
  return { complete: true, reason: "quiet_window_and_complete_clause", confidence: 0.82 };
}
