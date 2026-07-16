export type QuestionSelectionMode = "single" | "multiple";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionPrompt {
  question: string;
  options: QuestionOption[];
  selectionMode: QuestionSelectionMode;
  allowOther: boolean;
}

export interface QuestionResponseMeta {
  questionToolCallId: string;
  selectedOptionIds: string[];
  otherText?: string;
}

export type QuestionValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const MAX_QUESTION_LENGTH = 500;
const MAX_OPTIONS = 8;
const MAX_OPTION_ID_LENGTH = 80;
const MAX_OPTION_LABEL_LENGTH = 200;
const MAX_OPTION_DESCRIPTION_LENGTH = 400;
const MAX_OTHER_LENGTH = 1_000;

function nonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

export function normalizeQuestionPrompt(input: unknown): QuestionValidationResult<QuestionPrompt> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Question arguments must be an object." };
  }

  const raw = input as Record<string, unknown>;
  const question = nonEmptyString(raw.question, MAX_QUESTION_LENGTH);
  if (!question) {
    return { ok: false, error: `question is required and must be at most ${MAX_QUESTION_LENGTH} characters.` };
  }

  if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > MAX_OPTIONS) {
    return { ok: false, error: `options must contain between 2 and ${MAX_OPTIONS} choices.` };
  }

  const options: QuestionOption[] = [];
  const optionIds = new Set<string>();
  for (const rawOption of raw.options) {
    if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
      return { ok: false, error: "Every option must be an object with id and label." };
    }
    const option = rawOption as Record<string, unknown>;
    const id = nonEmptyString(option.id, MAX_OPTION_ID_LENGTH);
    const label = nonEmptyString(option.label, MAX_OPTION_LABEL_LENGTH);
    if (!id || !label) {
      return { ok: false, error: "Every option needs a non-empty id and label." };
    }
    if (optionIds.has(id)) {
      return { ok: false, error: `Duplicate option id: ${id}` };
    }
    optionIds.add(id);

    const description = option.description === undefined
      ? undefined
      : nonEmptyString(option.description, MAX_OPTION_DESCRIPTION_LENGTH);
    if (option.description !== undefined && !description) {
      return { ok: false, error: `Option ${id} has an invalid description.` };
    }
    options.push({ id, label, ...(description ? { description } : {}) });
  }

  const selectionMode: QuestionSelectionMode = raw.selectionMode === "multiple" ? "multiple" : "single";
  return {
    ok: true,
    value: {
      question,
      options,
      selectionMode,
      allowOther: raw.allowOther === true,
    },
  };
}

export function normalizeQuestionResponse(input: unknown): QuestionValidationResult<QuestionResponseMeta> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "questionResponse must be an object." };
  }

  const raw = input as Record<string, unknown>;
  const questionToolCallId = nonEmptyString(raw.questionToolCallId, 200);
  if (!questionToolCallId) {
    return { ok: false, error: "questionToolCallId is required." };
  }

  if (!Array.isArray(raw.selectedOptionIds)) {
    return { ok: false, error: "selectedOptionIds must be an array." };
  }
  const selectedOptionIds: string[] = [];
  const seen = new Set<string>();
  for (const rawId of raw.selectedOptionIds) {
    const id = nonEmptyString(rawId, MAX_OPTION_ID_LENGTH);
    if (!id) return { ok: false, error: "selectedOptionIds contains an invalid option id." };
    if (!seen.has(id)) {
      seen.add(id);
      selectedOptionIds.push(id);
    }
  }

  const otherText = raw.otherText === undefined ? undefined : nonEmptyString(raw.otherText, MAX_OTHER_LENGTH);
  if (raw.otherText !== undefined && !otherText) {
    return { ok: false, error: `otherText must be non-empty and at most ${MAX_OTHER_LENGTH} characters.` };
  }

  return {
    ok: true,
    value: {
      questionToolCallId,
      selectedOptionIds,
      ...(otherText ? { otherText } : {}),
    },
  };
}

export function validateQuestionResponse(
  prompt: QuestionPrompt,
  response: QuestionResponseMeta,
): QuestionValidationResult<QuestionResponseMeta> {
  const validIds = new Set(prompt.options.map((option) => option.id));
  const invalidId = response.selectedOptionIds.find((id) => !validIds.has(id));
  if (invalidId) return { ok: false, error: `Unknown option id: ${invalidId}` };
  if (response.otherText && !prompt.allowOther) {
    return { ok: false, error: "This question does not allow an Other response." };
  }

  const selectionCount = response.selectedOptionIds.length + (response.otherText ? 1 : 0);
  if (selectionCount === 0) return { ok: false, error: "Choose at least one answer." };
  if (prompt.selectionMode === "single" && selectionCount !== 1) {
    return { ok: false, error: "Choose exactly one answer." };
  }

  return { ok: true, value: response };
}

export function formatQuestionResponseContent(prompt: QuestionPrompt, response: QuestionResponseMeta): string {
  const optionById = new Map(prompt.options.map((option) => [option.id, option]));
  const selections = response.selectedOptionIds
    .map((id) => optionById.get(id))
    .filter((option): option is QuestionOption => Boolean(option))
    .map((option) => `- ${option.label} (${option.id})`);
  if (response.otherText) selections.push(`- Other: ${response.otherText}`);

  return [
    "Question response",
    `Question tool call: ${response.questionToolCallId}`,
    `Question: ${prompt.question}`,
    "Selected answer:",
    ...selections,
  ].join("\n");
}
