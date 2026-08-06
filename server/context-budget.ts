const CONVERSATION_RETENTION_FRACTION = 0.3;
const CONVERSATION_RETENTION_TOKEN_CEILING = 100_000;
/**
 * Baseline chars→tokens for prose / mixed message content.
 * 4.0 is closer to real BPE density than the prior 3.5 (which ran ~50% hot
 * on tool-heavy requests). Self-calibration further corrects per model from
 * provider-reported actuals — see applyTokenEstimateCalibration.
 */
const TOKEN_ESTIMATE_CHARS_PER_TOKEN_PROSE = 4.0;
/**
 * Baseline chars→tokens for JSON tool-definition schemas. Schemas are far more
 * BPE-compressible (repeated keys, enums, punctuation) than prose; 5.5 cuts the
 * bulk of the historical overcount on tool-rich contexts.
 */
const TOKEN_ESTIMATE_CHARS_PER_TOKEN_JSON = 5.5;
/** EMA weight for new actual/estimate observations (higher = faster adapt). */
const TOKEN_ESTIMATE_CALIBRATION_EMA_ALPHA = 0.25;
/** Clamp learned ratio so a single bad sample can't collapse or explode estimates. */
const TOKEN_ESTIMATE_CALIBRATION_RATIO_MIN = 0.4;
const TOKEN_ESTIMATE_CALIBRATION_RATIO_MAX = 1.5;
const TOKEN_ESTIMATE_CALIBRATION_SETTING_PREFIX = "token-estimate-calibration:";

export function estimateTokensFromChars(chars: number, kind: "prose" | "json" = "prose"): number {
  if (!chars || chars <= 0) return 0;
  const divisor = kind === "json"
    ? TOKEN_ESTIMATE_CHARS_PER_TOKEN_JSON
    : TOKEN_ESTIMATE_CHARS_PER_TOKEN_PROSE;
  return Math.ceil(chars / divisor);
}

interface TokenEstimateCalibration {
  /** actual ÷ raw_baseline — multiply a fresh baseline estimate by this. */
  ratio: number;
  samples: number;
  updatedAt: string;
}

const calibrationCache = new Map<string, TokenEstimateCalibration>();

function calibrationSettingKey(modelKey: string): string {
  return `${TOKEN_ESTIMATE_CALIBRATION_SETTING_PREFIX}${modelKey}`;
}

function clampCalibrationRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(
    TOKEN_ESTIMATE_CALIBRATION_RATIO_MAX,
    Math.max(TOKEN_ESTIMATE_CALIBRATION_RATIO_MIN, ratio),
  );
}

/**
 * Apply the learned per-model ratio to a raw baseline estimate.
 * Falls back to the raw estimate when no samples exist yet.
 */
export async function applyTokenEstimateCalibration(
  modelKey: string | null | undefined,
  rawEstimateTokens: number,
): Promise<number> {
  const raw = Math.max(0, Math.ceil(rawEstimateTokens || 0));
  if (raw <= 0 || !modelKey) return raw;
  const cached = calibrationCache.get(modelKey);
  if (cached && cached.samples > 0) {
    return Math.max(1, Math.ceil(raw * cached.ratio));
  }
  try {
    const { getSetting } = await import("./system-settings");
    const stored = await getSetting<TokenEstimateCalibration>(calibrationSettingKey(modelKey));
    if (stored && typeof stored.ratio === "number" && stored.samples > 0) {
      const entry: TokenEstimateCalibration = {
        ratio: clampCalibrationRatio(stored.ratio),
        samples: stored.samples,
        updatedAt: stored.updatedAt || new Date().toISOString(),
      };
      calibrationCache.set(modelKey, entry);
      return Math.max(1, Math.ceil(raw * entry.ratio));
    }
  } catch {
    // Calibration is best-effort — never block the request path.
  }
  return raw;
}

/**
 * Learn from one clean (raw_baseline, provider_actual) pair.
 * Only call with real provider-reported per-call input tokens — never with
 * self-measured estimates or cumulative session totals.
 */
export async function recordTokenEstimateCalibration(
  modelKey: string | null | undefined,
  rawEstimateTokens: number,
  providerActualInputTokens: number,
): Promise<void> {
  if (!modelKey) return;
  const raw = Math.max(0, Math.floor(rawEstimateTokens || 0));
  const actual = Math.max(0, Math.floor(providerActualInputTokens || 0));
  // Ignore tiny samples (noise) and impossible pairs.
  if (raw < 500 || actual < 500) return;
  const observed = clampCalibrationRatio(actual / raw);
  const previous = calibrationCache.get(modelKey);
  const nextRatio = previous && previous.samples > 0
    ? clampCalibrationRatio(
        (1 - TOKEN_ESTIMATE_CALIBRATION_EMA_ALPHA) * previous.ratio
          + TOKEN_ESTIMATE_CALIBRATION_EMA_ALPHA * observed,
      )
    : observed;
  const entry: TokenEstimateCalibration = {
    ratio: nextRatio,
    samples: (previous?.samples ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  calibrationCache.set(modelKey, entry);
  try {
    const { setSetting } = await import("./system-settings");
    await setSetting(calibrationSettingKey(modelKey), entry);
  } catch {
    // Persist is best-effort; in-memory ratio still applies for this process.
  }
}
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
  /** Soft target for mid-run compaction stages (0.92 × operating = hard input). */
  compactionTarget: number;
}

function boundedTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Single spine for request budget:
 *   hardInputLimit = contextWindow − outputReserve
 *   operatingInputLimit = hardInputLimit  (no secondary fraction/ceiling clamp)
 *   compactionTarget = 0.92 × operatingInputLimit
 *
 * Mid-run stages hang off compactionTarget. Between-turn retention is a separate
 * rest floor via getConversationRetentionBudget — not another operating clamp.
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
  // Operating ceiling is the hard input cliff. Prior 0.6×window + 128k absolute
  // clamps double-buffered usable space and forced mid-run compaction far below
  // real capacity; stages already provide graduated pressure response.
  const operatingInputLimit = hardInputLimit;
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
  // JSON schemas tokenize denser than prose — use the JSON baseline divisor.
  return estimateTokensFromChars(JSON.stringify(tools).length, "json");
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
