import type { FileMessage } from "./chat-file-storage";
import {
  formatQuestionResponseContent,
  normalizeQuestionPrompt,
  normalizeQuestionResponse,
  validateQuestionResponse,
  type QuestionResponseMeta,
} from "@shared/question-prompt";

export type ResolveQuestionResponseResult =
  | { ok: true; response: QuestionResponseMeta; content: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

export function resolveQuestionResponse(
  messages: FileMessage[],
  rawResponse: unknown,
): ResolveQuestionResponseResult {
  const normalizedResponse = normalizeQuestionResponse(rawResponse);
  if (!normalizedResponse.ok) {
    return { ok: false, status: 400, error: normalizedResponse.error };
  }
  const response = normalizedResponse.value;

  const alreadyAnswered = messages.some(
    (message) => message.questionResponse?.questionToolCallId === response.questionToolCallId,
  );
  if (alreadyAnswered) {
    return { ok: false, status: 409, error: "This question has already been answered." };
  }

  let promptInput: Record<string, unknown> | null = null;
  for (let messageIndex = messages.length - 1; messageIndex >= 0 && !promptInput; messageIndex--) {
    const toolCalls = messages[messageIndex].toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    const matchingCall = toolCalls.find((call) => {
      if (!call || typeof call !== "object") return false;
      const value = call as Record<string, unknown>;
      return value.toolName === "question" && value.toolCallId === response.questionToolCallId;
    }) as Record<string, unknown> | undefined;
    if (matchingCall?.arguments && typeof matchingCall.arguments === "object") {
      promptInput = matchingCall.arguments as Record<string, unknown>;
    }
  }

  if (!promptInput) {
    return { ok: false, status: 404, error: "Question prompt not found in this session." };
  }

  const normalizedPrompt = normalizeQuestionPrompt(promptInput);
  if (!normalizedPrompt.ok) {
    return { ok: false, status: 409, error: "The stored question prompt is no longer valid." };
  }

  const validated = validateQuestionResponse(normalizedPrompt.value, response);
  if (!validated.ok) {
    return { ok: false, status: 400, error: validated.error };
  }

  return {
    ok: true,
    response: validated.value,
    content: formatQuestionResponseContent(normalizedPrompt.value, validated.value),
  };
}
