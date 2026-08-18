export type QuestionSelectionMode = "single" | "multiple";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionPrincipleOption {
  principleId: string;
  revisionId: string;
  title: string;
  layer1: string;
}

/** Agent preliminary judgment shown in the widget before the human confirms. */
export interface QuestionAgentRecommendation {
  /** Option IDs the agent would choose. Must match prompt option ids. */
  optionIds: string[];
  /** Confidence 1–100 for the recommended choice. */
  confidence: number;
  /** Short reasoning prefilled into the Reasoning box. */
  reasoning?: string;
  /** Principle revision IDs checked as most important to the call. */
  principleRevisionIds?: string[];
}

export interface QuestionPrompt {
  question: string;
  options: QuestionOption[];
  selectionMode: QuestionSelectionMode;
  reasoning?: string;
  principles: QuestionPrincipleOption[];
  allowResponseReasoning: boolean;
  /**
   * Optional agent preliminary judgment: highlighted answer, confidence %,
   * prefilled reasoning, and checked principles. Human can still change any of it.
   */
  recommendation?: QuestionAgentRecommendation;
}

export interface QuestionResponseMeta {
  questionToolCallId: string;
  selectedOptionIds: string[];
  otherText?: string;
  selectedPrincipleRevisionIds?: string[];
  reasoning?: string;
  /** Closed Decision created by the canonical judgment recorder for this answer. */
  decisionId?: string;
}

export type QuestionValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type QuestionCancelReason = "user_cancelled" | "superseded_by_message";

export interface QuestionCancellationMeta {
  questionToolCallId: string;
  reason: QuestionCancelReason;
}

export interface QuestionLifecycleMessage {
  toolCalls?: unknown;
  questionResponse?: QuestionResponseMeta;
  questionCancellation?: QuestionCancellationMeta;
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
  const resolved = messages.some(
    (message) =>
      message.questionResponse?.questionToolCallId === latestToolCallId ||
      message.questionCancellation?.questionToolCallId === latestToolCallId,
  );
  return resolved ? null : latestToolCallId;
}

const MAX_QUESTION_LENGTH = 500;
const MAX_OPTIONS = 8;
const MAX_OPTION_ID_LENGTH = 80;
const MAX_OPTION_LABEL_LENGTH = 200;
const MAX_OPTION_DESCRIPTION_LENGTH = 400;
const MAX_OTHER_LENGTH = 1_000;
const MAX_REASONING_LENGTH = 4_000;
const MAX_PRINCIPLES = 12;
const MAX_PRINCIPLE_TEXT_LENGTH = 500;

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
    if (id === "other") {
      return {
        ok: false,
        error: 'Authored option id "other" is reserved for the free-text escape hatch.',
      };
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

  const rawPrinciples = raw.principles ?? [];
  if (!Array.isArray(rawPrinciples) || rawPrinciples.length > MAX_PRINCIPLES) {
    return { ok: false, error: `principles must be an array with at most ${MAX_PRINCIPLES} items.` };
  }
  const principles: QuestionPrincipleOption[] = [];
  const revisionIds = new Set<string>();
  for (const rawPrinciple of rawPrinciples) {
    if (!rawPrinciple || typeof rawPrinciple !== "object" || Array.isArray(rawPrinciple)) {
      return { ok: false, error: "Every principle must include principleId, revisionId, title, and layer1." };
    }
    const record = rawPrinciple as Record<string, unknown>;
    const principleId = nonEmptyString(record.principleId, 200);
    const revisionId = nonEmptyString(record.revisionId, 200);
    const title = nonEmptyString(record.title, MAX_PRINCIPLE_TEXT_LENGTH);
    const layer1 = nonEmptyString(record.layer1, MAX_PRINCIPLE_TEXT_LENGTH);
    if (!principleId || !revisionId || !title || !layer1) {
      return { ok: false, error: "Every principle must include principleId, revisionId, title, and layer1." };
    }
    if (revisionIds.has(revisionId)) {
      return { ok: false, error: `Duplicate principle revision id: ${revisionId}` };
    }
    revisionIds.add(revisionId);
    principles.push({ principleId, revisionId, title, layer1 });
  }

  const selectionMode: QuestionSelectionMode = raw.selectionMode === "multiple" ? "multiple" : "single";

  let recommendation: QuestionAgentRecommendation | undefined;
  if (raw.recommendation !== undefined && raw.recommendation !== null) {
    if (!raw.recommendation || typeof raw.recommendation !== "object" || Array.isArray(raw.recommendation)) {
      return { ok: false, error: "recommendation must be an object when provided." };
    }
    const rec = raw.recommendation as Record<string, unknown>;
    if (!Array.isArray(rec.optionIds) || rec.optionIds.length === 0) {
      return { ok: false, error: "recommendation.optionIds must be a non-empty array." };
    }
    const optionIdSet = new Set(options.map((option) => option.id));
    const recommendedOptionIds: string[] = [];
    const seenRecommended = new Set<string>();
    for (const [index, rawId] of rec.optionIds.entries()) {
      const id = nonEmptyString(rawId, MAX_OPTION_ID_LENGTH);
      if (!id) {
        return { ok: false, error: `recommendation.optionIds[${index}] must be a non-empty string.` };
      }
      if (!optionIdSet.has(id)) {
        return { ok: false, error: `recommendation.optionIds[${index}] must match a prompt option id.` };
      }
      if (seenRecommended.has(id)) continue;
      seenRecommended.add(id);
      recommendedOptionIds.push(id);
    }
    if (selectionMode === "single" && recommendedOptionIds.length !== 1) {
      return {
        ok: false,
        error: "recommendation.optionIds must contain exactly one id in single mode.",
      };
    }
    if (typeof rec.confidence !== "number" || !Number.isFinite(rec.confidence)) {
      return { ok: false, error: "recommendation.confidence must be a finite number." };
    }
    const confidence = Math.round(rec.confidence);
    if (confidence < 1 || confidence > 100) {
      return { ok: false, error: "recommendation.confidence must be an integer from 1 to 100." };
    }
    const recReasoning =
      rec.reasoning === undefined || rec.reasoning === null
        ? undefined
        : nonEmptyString(rec.reasoning, MAX_OPTION_DESCRIPTION_LENGTH);
    if (rec.reasoning !== undefined && rec.reasoning !== null && !recReasoning) {
      return {
        ok: false,
        error: `recommendation.reasoning must be non-empty and at most ${MAX_OPTION_DESCRIPTION_LENGTH} characters.`,
      };
    }
    let principleRevisionIds: string[] | undefined;
    if (rec.principleRevisionIds !== undefined && rec.principleRevisionIds !== null) {
      if (!Array.isArray(rec.principleRevisionIds)) {
        return {
          ok: false,
          error: "recommendation.principleRevisionIds must be an array when provided.",
        };
      }
      const principleIdSet = new Set(principles.map((item) => item.revisionId));
      const ids: string[] = [];
      const seenPrincipleRec = new Set<string>();
      for (const [index, rawId] of rec.principleRevisionIds.entries()) {
        const id = nonEmptyString(rawId, 200);
        if (!id) {
          return {
            ok: false,
            error: `recommendation.principleRevisionIds[${index}] must be a non-empty string.`,
          };
        }
        if (principleIdSet.size > 0 && !principleIdSet.has(id)) {
          return {
            ok: false,
            error: `recommendation.principleRevisionIds[${index}] must match a principles[].revisionId.`,
          };
        }
        if (seenPrincipleRec.has(id)) continue;
        seenPrincipleRec.add(id);
        ids.push(id);
      }
      if (ids.length > 0) principleRevisionIds = ids;
    }
    recommendation = {
      optionIds: recommendedOptionIds,
      confidence,
      ...(recReasoning ? { reasoning: recReasoning } : {}),
      ...(principleRevisionIds ? { principleRevisionIds } : {}),
    };
  }

  return {
    ok: true,
    value: {
      question,
      options,
      selectionMode,
      // allowOther is ignored when present on historical args — Other is structural.
      ...(reasoning ? { reasoning } : {}),
      principles,
      allowResponseReasoning: raw.allowResponseReasoning === true,
      ...(recommendation ? { recommendation } : {}),
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

  const rawRevisionIds = raw.selectedPrincipleRevisionIds ?? [];
  if (!Array.isArray(rawRevisionIds) || rawRevisionIds.length > MAX_PRINCIPLES) {
    return { ok: false, error: `selectedPrincipleRevisionIds must contain at most ${MAX_PRINCIPLES} ids.` };
  }
  const selectedPrincipleRevisionIds: string[] = [];
  const seenRevisions = new Set<string>();
  for (const rawRevisionId of rawRevisionIds) {
    const revisionId = nonEmptyString(rawRevisionId, 200);
    if (!revisionId) return { ok: false, error: "selectedPrincipleRevisionIds contains an invalid revision id." };
    if (!seenRevisions.has(revisionId)) {
      seenRevisions.add(revisionId);
      selectedPrincipleRevisionIds.push(revisionId);
    }
  }

  const reasoning = raw.reasoning === undefined ? undefined : nonEmptyString(raw.reasoning, MAX_REASONING_LENGTH);
  if (raw.reasoning !== undefined && !reasoning) {
    return { ok: false, error: `reasoning must be non-empty and at most ${MAX_REASONING_LENGTH} characters.` };
  }

  const decisionId = raw.decisionId === undefined
    ? undefined
    : nonEmptyString(raw.decisionId, 200);
  if (raw.decisionId !== undefined && !decisionId) {
    return { ok: false, error: "decisionId must be a non-empty string when provided." };
  }

  return {
    ok: true,
    value: {
      questionToolCallId,
      selectedOptionIds,
      ...(otherText ? { otherText } : {}),
      ...(selectedPrincipleRevisionIds.length > 0 ? { selectedPrincipleRevisionIds } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(decisionId ? { decisionId } : {}),
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
  // Other is always admitted; otherText validity is enforced by normalizeQuestionResponse.
  // Principle revisions may come from the prompt shortlist. The widget no longer
  // exposes a picker; recommended or already-persisted ids still pass through.
  // Existence is enforced by recordJudgment when the answer is accepted.
  // Reasoning is optional on the selected answer; do not strip a typed note
  // because the agent omitted allowResponseReasoning.
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
  const principleByRevisionId = new Map(prompt.principles.map((principle) => [principle.revisionId, principle]));
  const principleLines = (response.selectedPrincipleRevisionIds ?? [])
    .map((revisionId) => principleByRevisionId.get(revisionId))
    .filter((principle): principle is QuestionPrincipleOption => Boolean(principle))
    .map((principle) => `- ${principle.title} (@principle:${principle.revisionId})`);

  return [
    "Question response",
    `Question tool call: ${response.questionToolCallId}`,
    `Question: ${prompt.question}`,
    "Selected answer:",
    ...selections,
    ...(principleLines.length > 0 ? ["Governing principles:", ...principleLines] : []),
    ...(response.reasoning ? ["Reasoning:", response.reasoning] : []),
  ].join("\n");
}
