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
  reasoning?: string;
}

export interface QuestionResponseMeta {
  questionToolCallId: string;
  selectedOptionIds: string[];
  otherText?: string;
}

export type QuestionValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface QuestionLifecycleMessage {
  toolCalls?: unknown;
  questionResponse?: QuestionResponseMeta;
}

export function getLatestQuestionToolCallId(
  messages: readonly QuestionLifecycleMessage[],
): string | null {
  let latestToolCallId: string | null = null;
  for (const message of messages) {
    if (!Array.isArray(message.toolCalls)) continue;
    for (const rawCall of message.toolCalls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const call = rawCall as Record<string, unknown>;
      if (call.toolName !== "question" || typeof call.toolCallId !== "string") continue;
      if (call.status === "error") continue;
      if (!normalizeQuestionPrompt(call.arguments).ok) continue;
      latestToolCallId = call.toolCallId;
    }
  }
  return latestToolCallId;
}

export function getActiveQuestionToolCallId(
  messages: readonly QuestionLifecycleMessage[],
): string | null {
  const latestToolCallId = getLatestQuestionToolCallId(messages);
  if (!latestToolCallId) return null;
  const answered = messages.some(
    (message) => message.questionResponse?.questionToolCallId === latestToolCallId,
  );
  return answered ? null : latestToolCallId;
}

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

function optionIdFromLabel(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_OPTION_ID_LENGTH - 4);
  return slug || `option-${index + 1}`;
}

function parseQuestionOptions(value: unknown): QuestionValidationResult<unknown[]> {
  if (Array.isArray(value)) return { ok: true, value };
  if (typeof value !== "string") {
    return { ok: false, error: `options must contain between 2 and ${MAX_OPTIONS} choices.` };
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]") || trimmed.length > 16_000) {
    return { ok: false, error: "options may be a JSON-encoded array, but prose or ambiguous strings are not accepted." };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, error: "JSON-encoded options must decode to an array." };
  } catch {
    return { ok: false, error: "options contains invalid JSON. Reissue the question with a valid options array." };
  }
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

  const parsedOptions = parseQuestionOptions(raw.options);
  if (!parsedOptions.ok) return parsedOptions;
  if (parsedOptions.value.length < 2 || parsedOptions.value.length > MAX_OPTIONS) {
    return { ok: false, error: `options must contain between 2 and ${MAX_OPTIONS} choices.` };
  }

  const options: QuestionOption[] = [];
  const optionIds = new Set<string>();
  for (const [index, rawOption] of parsedOptions.value.entries()) {
    const option = typeof rawOption === "string"
      ? { id: optionIdFromLabel(rawOption.trim(), index), label: rawOption }
      : rawOption;
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return { ok: false, error: "Every option must be a string or an object with id and label." };
    }
    const rawOptionRecord = option as Record<string, unknown>;
    let id = nonEmptyString(rawOptionRecord.id, MAX_OPTION_ID_LENGTH);
    const label = nonEmptyString(rawOptionRecord.label, MAX_OPTION_LABEL_LENGTH);
    if (!id || !label) {
      return { ok: false, error: "Every option needs a non-empty id and label." };
    }
    if (optionIds.has(id)) {
      return { ok: false, error: `Duplicate option id: ${id}` };
    }
    optionIds.add(id);

    const description = rawOptionRecord.description === undefined
      ? undefined
      : nonEmptyString(rawOptionRecord.description, MAX_OPTION_DESCRIPTION_LENGTH);
    if (rawOptionRecord.description !== undefined && !description) {
      return { ok: false, error: `Option ${id} has an invalid description.` };
    }
    options.push({ id, label, ...(description ? { description } : {}) });
  }

  const reasoning = raw.reasoning === undefined
    ? undefined
    : nonEmptyString(raw.reasoning, MAX_OPTION_DESCRIPTION_LENGTH);
  if (raw.reasoning !== undefined && !reasoning) {
    return { ok: false, error: `reasoning must be non-empty and at most ${MAX_OPTION_DESCRIPTION_LENGTH} characters.` };
  }

  const selectionMode: QuestionSelectionMode = raw.selectionMode === "multiple" ? "multiple" : "single";
  return {
    ok: true,
    value: {
      question,
      options,
      selectionMode,
      allowOther: raw.allowOther === true,
      ...(reasoning ? { reasoning } : {}),
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
