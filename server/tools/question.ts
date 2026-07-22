import { normalizeQuestionPrompt } from "@shared/question-prompt";
import { createLogger } from "../log";

const log = createLogger("QuestionTool");

export async function handleQuestion(args: Record<string, unknown>) {
  const normalized = normalizeQuestionPrompt(args);
  if (!normalized.ok) {
    log.error(`question prompt rejected: ${normalized.error}`);
    return {
      result: [
        `Question prompt rejected: ${normalized.error}`,
        "Reissue the question tool now with options as an array of { id, label, description? } objects.",
        "Do not answer the question yourself and do not end the turn without a valid question tool call.",
      ].join(" "),
      error: true,
    };
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
