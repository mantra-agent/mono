const CONTEXT_OPERATING_INPUT_FRACTION = 0.6;
const CONTEXT_OPERATING_INPUT_TOKEN_CEILING = 128_000;
const CONVERSATION_RETENTION_FRACTION = 0.3;
const CONVERSATION_RETENTION_TOKEN_CEILING = 100_000;
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 3.5;
/** Cap reserved output so large maxOutputTokens (e.g. 128k Opus) cannot collapse the input envelope. */
const OPERATING_OUTPUT_RESERVE_CEILING = 32_000;
/** Share of the context window treated as a soft upper bound on output reserve. */
const OPERATING_OUTPUT_RESERVE_WINDOW_FRACTION = 0.2;
/**
 * When the caller explicitly configured an output ceiling (a per-tier
 * maxOutputTokens set in the UI), honor it verbatim up to this share of the
 * window. The only guard is that input can never collapse below the remaining
 * half — the fixed 32k default ceiling does not apply to a deliberate choice.
 */
const OPERATING_OUTPUT_RESERVE_EXPLICIT_WINDOW_FRACTION = 0.5;
/** Compaction aims under this fraction of operatingInputLimit so the hard gate has margin. */
const CONTEXT_COMPACTION_TARGET_FRACTION = 0.92;

export interface ContextRequestBudget {
  contextWindow: number;
  outputReserve: number;
  hardInputLimit: number;
  operatingInputLimit: number;
  /** Soft target for mid-run compaction stages; always ≤ operatingInputLimit. */
  compactionTarget: number;
}

function boundedTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Provider context capacity is a hard safety boundary, not the ordinary
 * operating target. Keep routine requests inside a smaller, model-relative
 * budget with a stable ceiling so larger advertised windows cannot silently
 * inflate latency, cost, or compaction thresholds.
 *
 * `outputReserve` is the caller's max output tokens. When it is an *inherited
 * registry default* (`outputReserveIsExplicit` false), it is clamped by a fixed
 * ceiling and a window fraction so models that advertise huge maxOutputTokens
 * (claude-opus-sub: 128k on a 200k window) do not zero out the usable input
 * envelope. When it is an *explicit user configuration* (`outputReserveIsExplicit`
 * true — a per-tier maxOutputTokens set in the UI), it is honored verbatim up to
 * half the window, so the derived hard input limit and the gauge's reserved-output
 * wedge reflect the real setting instead of a fixed 32k clamp.
 */
export function getContextRequestBudget(
  contextWindow: number,
  outputReserve = 0,
  outputReserveIsExplicit = false,
): ContextRequestBudget {
  const boundedContextWindow = boundedTokenCount(contextWindow);
  const requestedReserve = boundedTokenCount(outputReserve);
  let boundedOutputReserve: number;
  if (outputReserveIsExplicit && requestedReserve > 0) {
    const explicitReserveCap = Math.floor(
      boundedContextWindow * OPERATING_OUTPUT_RESERVE_EXPLICIT_WINDOW_FRACTION,
    );
    boundedOutputReserve = Math.min(
      requestedReserve,
      explicitReserveCap > 0 ? explicitReserveCap : boundedContextWindow,
      boundedContextWindow,
    );
  } else {
    const windowReserveCap = Math.floor(
      boundedContextWindow * OPERATING_OUTPUT_RESERVE_WINDOW_FRACTION,
    );
    boundedOutputReserve = Math.min(
      requestedReserve,
      OPERATING_OUTPUT_RESERVE_CEILING,
      windowReserveCap > 0 ? windowReserveCap : OPERATING_OUTPUT_RESERVE_CEILING,
      boundedContextWindow,
    );
  }
  const hardInputLimit = Math.max(
    0,
    boundedContextWindow - boundedOutputReserve,
  );
  const operatingInputLimit = Math.min(
    Math.floor(boundedContextWindow * CONTEXT_OPERATING_INPUT_FRACTION),
    CONTEXT_OPERATING_INPUT_TOKEN_CEILING,
    hardInputLimit,
  );
  const compactionTarget = Math.min(
    operatingInputLimit,
    Math.floor(operatingInputLimit * CONTEXT_COMPACTION_TARGET_FRACTION),
  );

  return {
    contextWindow: boundedContextWindow,
    outputReserve: boundedOutputReserve,
    hardInputLimit,
    operatingInputLimit,
    compactionTarget,
  };
}

export function getConversationRetentionBudget(contextWindow: number): number {
  const budget = getContextRequestBudget(contextWindow);
  return Math.min(
    Math.floor(budget.contextWindow * CONVERSATION_RETENTION_FRACTION),
    CONVERSATION_RETENTION_TOKEN_CEILING,
    budget.operatingInputLimit,
  );
}

export function estimateToolDefinitionTokens(
  tools: readonly unknown[] | undefined,
): number {
  if (!tools?.length) return 0;
  return Math.ceil(JSON.stringify(tools).length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

export class ContextOperatingBudgetExceededError extends Error {
  readonly code = "CONTEXT_OPERATING_BUDGET_EXCEEDED";
  readonly estimatedInputTokens: number;
  readonly budget: ContextRequestBudget;

  constructor(estimatedInputTokens: number, budget: ContextRequestBudget) {
    super(
      `The assembled request remains too large after context compression ` +
      `(estimated ${estimatedInputTokens.toLocaleString()} tokens; operating budget ` +
      `${budget.operatingInputLimit.toLocaleString()} tokens; compaction target ` +
      `${budget.compactionTarget.toLocaleString()} tokens).`,
    );
    this.name = "ContextOperatingBudgetExceededError";
    this.estimatedInputTokens = estimatedInputTokens;
    this.budget = budget;
  }
}
