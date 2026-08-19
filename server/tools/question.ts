import { normalizeQuestionPrompt } from "@shared/question-prompt";
import { contractReject } from "./shared/failures";

export async function handleQuestion(args: Record<string, unknown>) {
  const normalized = normalizeQuestionPrompt(args);
  if (!normalized.ok) {
    return contractReject(
      [
        `Question prompt rejected: ${normalized.error}`,
        "Reissue the question tool now with options as an array of { id, label, description? } objects.",
        "Do not answer the question yourself and do not end the turn without a valid question tool call.",
      ].join(" "),
      "question_input_invalid",
      normalized.error,
    );
  }

  return {
    result: JSON.stringify({
      kind: "question_prompt",
      status: "awaiting_response",
      ...normalized.value,
    }),
    normalizedArguments: normalized.value,
    continuation: "await_user" as const,
  };
}
