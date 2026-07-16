import { normalizeQuestionPrompt } from "@shared/question-prompt";

export async function handleQuestion(args: Record<string, unknown>) {
  const normalized = normalizeQuestionPrompt(args);
  if (!normalized.ok) {
    return { result: normalized.error, error: true };
  }

  return {
    result: JSON.stringify({
      kind: "question_prompt",
      status: "awaiting_response",
      ...normalized.value,
    }),
    continuation: "await_user" as const,
  };
}
