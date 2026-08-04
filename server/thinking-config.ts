import type { ThinkingConfig as SdkThinkingConfig, EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { getThinkingInfo } from "./model-registry";
import { createLogger } from "./log";

const log = createLogger("ThinkingConfig");

export type ThinkingTierConfig =
  | { type: "disabled" }
  | { type: "enabled"; budgetTokens: number }
  | { type: "adaptive"; effort?: EffortLevel };

export interface ResolvedThinking {
  thinking: SdkThinkingConfig;
  effort?: EffortLevel;
}

export function thinkingBudgetToTier(budget: number | undefined): ThinkingTierConfig {
  if (budget === undefined || budget <= 0) return { type: "disabled" };
  return { type: "enabled", budgetTokens: budget };
}

export function tierToThinkingBudget(tier: ThinkingTierConfig | undefined): number {
  if (!tier) return 0;
  if (tier.type === "enabled") return tier.budgetTokens;
  return 0;
}

export function isAdaptiveCapable(modelId: string): boolean {
  const info = getThinkingInfo(modelId);
  return info.level === "extended";
}

/** Model supports ONLY adaptive thinking — no extended-thinking budget toggle (Fable/Mythos class). */
export function isAdaptiveOnly(modelId: string): boolean {
  return getThinkingInfo(modelId).adaptiveOnly === true;
}

export function resolveThinkingConfig(
  modelId: string,
  tierThinking?: ThinkingTierConfig,
): ResolvedThinking {
  if (!tierThinking || tierThinking.type === "disabled") {
    return { thinking: { type: "disabled" } };
  }
  if (tierThinking.type === "enabled") {
    // Adaptive-only models (e.g. Fable) reject the budget-token shape — silently
    // producing NO thinking blocks. Translate enabled(budget) → adaptive for them.
    if (isAdaptiveOnly(modelId)) {
      log.log(`model "${modelId}" is adaptive-only — translating enabled(${tierThinking.budgetTokens}) to adaptive`);
      return { thinking: { type: "adaptive" } };
    }
    const budget = Math.max(1, Math.floor(tierThinking.budgetTokens || 0));
    return { thinking: { type: "enabled", budgetTokens: budget } };
  }
  // adaptive
  if (!isAdaptiveCapable(modelId)) {
    log.warn(
      `adaptive thinking requested for model "${modelId}" but registry says it is not adaptive-capable; falling back to disabled`,
    );
    return { thinking: { type: "disabled" } };
  }
  const out: ResolvedThinking = { thinking: { type: "adaptive" } };
  if (tierThinking.effort) out.effort = tierThinking.effort;
  return out;
}

export function describeResolvedThinking(r: ResolvedThinking | undefined): string {
  if (!r) return "none";
  if (r.thinking.type === "disabled") return "disabled";
  if (r.thinking.type === "enabled") return `enabled(${r.thinking.budgetTokens ?? "?"})`;
  return r.effort ? `adaptive(${r.effort})` : "adaptive";
}

export function thinkingConfigKey(r: ResolvedThinking | undefined): string {
  if (!r) return "none";
  if (r.thinking.type === "disabled") return "d";
  if (r.thinking.type === "enabled") return `e:${r.thinking.budgetTokens ?? 0}`;
  return `a:${r.effort ?? "default"}`;
}

/** Reasoning effort values accepted by OpenAI reasoning-capable Responses requests. */
export type OpenAIReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

/**
 * Map the canonical tier thinking config (resolved) to an OpenAI reasoning effort.
 * The Responses/Codex endpoint for GPT-5.6 accepts "none" as its no-thinking
 * floor; sending legacy "minimal" is rejected by gpt-5.6-sol.
 * Budget boundaries mirror the tier selector levels: 4096 → low, 8192 → medium,
 * 16384 → high, 32768 → xhigh.
 */
export function resolveOpenAIReasoningEffort(
  resolved: ResolvedThinking | undefined,
  _target: "responses" | "codex",
): OpenAIReasoningEffort | undefined {
  if (!resolved) return undefined;
  const t = resolved.thinking;
  if (t.type === "disabled") return "none";
  if (t.type === "enabled") {
    const b = t.budgetTokens ?? 0;
    if (b <= 0) return "none";
    if (b <= 4096) return "low";
    if (b <= 8192) return "medium";
    if (b <= 16384) return "high";
    return "xhigh";
  }
  // adaptive
  switch (resolved.effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "xhigh";
    default:
      return undefined;
  }
}

/**
 * Canonical reasoning-level audit for TTFT joins.
 * - Claude/OpenAI: level comes from the request that was actually sent
 *   (budget→bucket or adaptive effort / OpenAI reasoning.effort).
 * - Grok: no native effort control today; impute from the tier thinking
 *   config so model×tier×reasoning slices still work.
 */
export type ReasoningSourceKind =
  | "request_effort"
  | "request_budget"
  | "imputed_from_tier"
  | "none"
  | "unknown";

export interface ReasoningAudit {
  /** Normalized level: none | low | medium | high | xhigh | unknown */
  effort: string;
  /** Human-readable request descriptor (e.g. adaptive(high), enabled(16000)). */
  thinkingSent: string;
  sourceKind: ReasoningSourceKind;
  /** Provider-native effort string when available (OpenAI/Claude adaptive). */
  nativeEffort?: string;
  /** Extended-thinking budget when that path was used. */
  budgetTokens?: number;
}

export function buildReasoningAudit(
  thinking: ResolvedThinking | undefined,
  provider: string,
): ReasoningAudit {
  if (!thinking) {
    return {
      effort: "unknown",
      thinkingSent: "unspecified",
      sourceKind: "unknown",
    };
  }

  const thinkingSent = describeResolvedThinking(thinking);
  const openaiEffort = resolveOpenAIReasoningEffort(thinking, "responses");
  const effort = openaiEffort ?? "unknown";

  if (thinking.thinking.type === "disabled") {
    return {
      effort: "none",
      thinkingSent,
      sourceKind: "none",
    };
  }

  if (thinking.thinking.type === "enabled") {
    const budgetTokens = thinking.thinking.budgetTokens;
    return {
      effort,
      thinkingSent,
      sourceKind: "request_budget",
      budgetTokens: typeof budgetTokens === "number" ? budgetTokens : undefined,
    };
  }

  // adaptive
  const nativeEffort = thinking.effort;
  const isGrok = provider === "grok-subscription" || provider.startsWith("grok");
  return {
    effort,
    thinkingSent,
    sourceKind: isGrok ? "imputed_from_tier" : "request_effort",
    nativeEffort: typeof nativeEffort === "string" ? nativeEffort : undefined,
  };
}
