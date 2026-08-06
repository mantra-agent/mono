/**
 * Context-pressure policy has one denominator: the hard input limit
 * (provider context window minus reserved output). Tuning changes the values,
 * never the shape of the ladder.
 */
export const BETWEEN_TURN_HISTORY_RESET_FRACTION = 0.3;
export const MID_TURN_TOOL_SOFT_TRIM_FRACTION = 0.5;
export const MID_TURN_HISTORY_HARD_TRIM_FRACTION = 0.7;
export const MID_TURN_HISTORY_RESET_FRACTION = 1;
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
/** Persist only when the learned ratio moves enough to matter. */
const TOKEN_ESTIMATE_CALIBRATION_PERSIST_RATIO_DELTA = 0.02;
/** Or after this many in-memory samples since the last durable checkpoint. */
const TOKEN_ESTIMATE_CALIBRATION_PERSIST_SAMPLE_INTERVAL = 20;
/** Or after this much wall time since the last durable checkpoint. */
const TOKEN_ESTIMATE_CALIBRATION_PERSIST_INTERVAL_MS = 5 * 60 * 1000;
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
/** Last durable checkpoint per model — memory stays live; DB is sparse. */
const lastPersistedCalibration = new Map<string, TokenEstimateCalibration>();

function normalizedCalibrationModelKey(modelKey: string): string {
  return modelKey.includes("/") ? modelKey.split("/").slice(1).join("/") : modelKey;
}

function shouldPersistCalibration(
  previousPersisted: TokenEstimateCalibration | undefined,
  next: TokenEstimateCalibration,
): boolean {
  if (!previousPersisted) return true;
  if (
    Math.abs(next.ratio - previousPersisted.ratio)
    >= TOKEN_ESTIMATE_CALIBRATION_PERSIST_RATIO_DELTA
  ) {
    return true;
  }
  if (
    next.samples - previousPersisted.samples
    >= TOKEN_ESTIMATE_CALIBRATION_PERSIST_SAMPLE_INTERVAL
  ) {
    return true;
  }
  const previousAt = Date.parse(previousPersisted.updatedAt);
  const nextAt = Date.parse(next.updatedAt);
  if (!Number.isFinite(previousAt) || !Number.isFinite(nextAt)) return true;
  return nextAt - previousAt >= TOKEN_ESTIMATE_CALIBRATION_PERSIST_INTERVAL_MS;
}

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
  const normalizedModelKey = normalizedCalibrationModelKey(modelKey);
  const cached = calibrationCache.get(normalizedModelKey);
  if (cached && cached.samples > 0) {
    return Math.max(1, Math.ceil(raw * cached.ratio));
  }
  try {
    const { getSetting } = await import("./system-settings");
    const stored = await getSetting<TokenEstimateCalibration>(calibrationSettingKey(normalizedModelKey));
    if (stored && typeof stored.ratio === "number" && stored.samples > 0) {
      const entry: TokenEstimateCalibration = {
        ratio: clampCalibrationRatio(stored.ratio),
        samples: stored.samples,
        updatedAt: stored.updatedAt || new Date().toISOString(),
      };
      calibrationCache.set(normalizedModelKey, entry);
      lastPersistedCalibration.set(normalizedModelKey, entry);
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
  const normalizedModelKey = normalizedCalibrationModelKey(modelKey);
  const observed = clampCalibrationRatio(actual / raw);
  const previous = calibrationCache.get(normalizedModelKey);
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
  calibrationCache.set(normalizedModelKey, entry);

  // Memory is the live store. Checkpoint only on material change, sample
  // budget, or elapsed time — every-sample writes thrash system_settings.
  const previousPersisted = lastPersistedCalibration.get(normalizedModelKey);
  if (!shouldPersistCalibration(previousPersisted, entry)) return;

  try {
    const { setSetting } = await import("./system-settings");
    await setSetting(calibrationSettingKey(normalizedModelKey), entry);
    lastPersistedCalibration.set(normalizedModelKey, entry);
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
export interface ContextPressureThresholds {
  /** Durable history reset between requests. */
  betweenTurnHistoryReset: number;
  /** Reconstructible tool-output trimming during execution. */
  midTurnToolSoftTrim: number;
  /** Deterministic compression of older working history during execution. */
  midTurnHistoryHardTrim: number;
  /** Final working-history reset at the hard input limit. */
  midTurnHistoryReset: number;
}

export interface ContextRequestBudget {
  contextWindow: number;
  outputReserve: number;
  /** Provider admission cliff: contextWindow − outputReserve. */
  hardInputLimit: number;
  /** Absolute hard-input-derived policy altitudes used by every server and client consumer. */
  thresholds: ContextPressureThresholds;
}

function boundedTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Single spine for request pressure:
 *   hardInputLimit = contextWindow − outputReserve
 *   every compaction altitude = named fraction × hardInputLimit
 *
 * Reserve first defines the usable input envelope; every pressure threshold and
 * gauge marker then uses that one envelope as its denominator.
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
  const thresholds = getContextPressureThresholds(hardInputLimit);

  return {
    contextWindow: boundedContextWindow,
    outputReserve: boundedOutputReserve,
    hardInputLimit,
    thresholds,
  };
}

export function getContextPressureThresholds(
  hardInputLimit: number,
): ContextPressureThresholds {
  const inputLimit = boundedTokenCount(hardInputLimit);
  return {
    betweenTurnHistoryReset: Math.floor(inputLimit * BETWEEN_TURN_HISTORY_RESET_FRACTION),
    midTurnToolSoftTrim: Math.floor(inputLimit * MID_TURN_TOOL_SOFT_TRIM_FRACTION),
    midTurnHistoryHardTrim: Math.floor(inputLimit * MID_TURN_HISTORY_HARD_TRIM_FRACTION),
    midTurnHistoryReset: Math.floor(inputLimit * MID_TURN_HISTORY_RESET_FRACTION),
  };
}

export function estimateMessageInputTokens(message: {
  content: unknown;
}): number {
  if (typeof message.content === "string") {
    return estimateTokensFromChars(message.content.length, "prose");
  }
  if (!Array.isArray(message.content)) return 0;
  return message.content.reduce((sum: number, block: any) => {
    if (
      block &&
      typeof block === "object" &&
      (block.type === "tool_use" || block.type === "tool_result" || block.input != null)
    ) {
      const payload = block.input != null ? block.input : block;
      return sum + estimateTokensFromChars(JSON.stringify(payload).length, "json");
    }
    const text = block?.text || block?.thinking || block?.content || "";
    if (typeof text === "string" && text.length > 0) {
      return sum + estimateTokensFromChars(text.length, "prose");
    }
    return sum + estimateTokensFromChars(JSON.stringify(block || {}).length, "json");
  }, 0);
}

export function estimateMessagesInputTokens(
  messages: readonly { content: unknown }[],
): number {
  return messages.reduce((sum, message) => sum + estimateMessageInputTokens(message), 0);
}

export function estimateToolDefinitionTokens(
  tools: readonly unknown[] | undefined,
): number {
  if (!tools?.length) return 0;
  // JSON schemas tokenize denser than prose — use the JSON baseline divisor.
  return estimateTokensFromChars(JSON.stringify(tools).length, "json");
}

export class ContextHardLimitExceededError extends Error {
  readonly code = "CONTEXT_HARD_LIMIT_EXCEEDED";
  readonly estimatedInputTokens: number;
  readonly budget: ContextRequestBudget;

  constructor(estimatedInputTokens: number, budget: ContextRequestBudget) {
    super(
      `The assembled request remains too large after context compression ` +
      `(estimated ${estimatedInputTokens.toLocaleString()} tokens; hard input limit ` +
      `${budget.hardInputLimit.toLocaleString()} tokens; mid-turn history reset ` +
      `${budget.thresholds.midTurnHistoryReset.toLocaleString()} tokens).`,
    );
    this.name = "ContextHardLimitExceededError";
    this.estimatedInputTokens = estimatedInputTokens;
    this.budget = budget;
  }
}
