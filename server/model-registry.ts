export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelThinking {
  level: "extended" | "basic" | "none";
  description: string;
  /** Model only supports adaptive thinking — no extended-thinking budget toggle (e.g. Fable/Mythos class). */
  adaptiveOnly?: boolean;
  /** Model exposes a selectable OpenAI reasoning-effort control mapped from the tier thinking config. */
  selectableEffort?: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "openai-subscription" | "claude-cli";
  cost: ModelCost;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  thinking: ModelThinking;
  requiresSubscription?: boolean;
  codexModelId?: string;
  claudeModelId?: string;
}

const REGISTRY: Record<string, ModelInfo> = {
  "claude-fable-5": {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    provider: "anthropic",
    cost: { input: 0.00001, output: 0.00005, cacheRead: 0.000001, cacheWrite: 0.0000125 },
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "extended", description: "Mythos-class adaptive thinking (always on)", adaptiveOnly: true },
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    cost: { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "extended", description: "Most capable Claude model with deep extended thinking" },
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    cost: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
    contextWindow: 1000000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "extended", description: "Extended thinking with excellent quality-to-cost ratio" },
  },
  "claude-opus-4-5-20251101": {
    id: "claude-opus-4-5-20251101",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    cost: { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "extended", description: "Deep extended thinking with the most capable reasoning" },
  },
  "claude-sonnet-4-20250514": {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    cost: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "extended", description: "Extended thinking with visible chain-of-thought reasoning" },
  },
  "claude-opus-4-20250514": {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    provider: "anthropic",
    cost: { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "extended", description: "Deep extended thinking with detailed internal reasoning" },
  },
  "claude-opus-4-1-20250805": {
    id: "claude-opus-4-1-20250805",
    name: "Claude Opus 4.1",
    provider: "anthropic",
    cost: { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "extended", description: "Extended thinking with deep internal reasoning" },
  },
  "claude-sonnet-4-5-20250929": {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    cost: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "extended", description: "Extended thinking with visible chain-of-thought reasoning" },
  },
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    cost: { input: 0.000001, output: 0.000005, cacheRead: 0.0000001, cacheWrite: 0.00000125 },
    contextWindow: 200000,
    maxOutputTokens: 8192,
    reasoning: false,
    thinking: { level: "none", description: "Fast responses without visible thinking" },
  },
  "claude-3-haiku-20240307": {
    id: "claude-3-haiku-20240307",
    name: "Claude 3 Haiku",
    provider: "anthropic",
    cost: { input: 0.00000025, output: 0.00000125, cacheRead: 0.000000025, cacheWrite: 0.0000003125 },
    contextWindow: 200000,
    maxOutputTokens: 4096,
    reasoning: false,
    thinking: { level: "none", description: "Fast responses without visible thinking" },
  },
  "gpt-4o": {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    cost: { input: 0.0000025, output: 0.00001, cacheRead: 0.00000125, cacheWrite: 0 },
    contextWindow: 128000,
    maxOutputTokens: 16384,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    cost: { input: 0.00000015, output: 0.0000006, cacheRead: 0.000000075, cacheWrite: 0 },
    contextWindow: 128000,
    maxOutputTokens: 16384,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "o3-mini": {
    id: "o3-mini",
    name: "o3-mini",
    provider: "openai",
    cost: { input: 0.00000055, output: 0.0000022, cacheRead: 0.000000275, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 100000,
    reasoning: true,
    thinking: { level: "basic", description: "Built-in chain-of-thought reasoning (not streamed)" },
  },
  "o3": {
    id: "o3",
    name: "o3",
    provider: "openai",
    cost: { input: 0.000002, output: 0.000008, cacheRead: 0.0000005, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 100000,
    reasoning: true,
    thinking: { level: "basic", description: "Advanced chain-of-thought reasoning (not streamed)" },
  },
  "o4-mini": {
    id: "o4-mini",
    name: "o4-mini",
    provider: "openai",
    cost: { input: 0.00000055, output: 0.0000022, cacheRead: 0.000000138, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 100000,
    reasoning: true,
    thinking: { level: "basic", description: "Efficient chain-of-thought reasoning (not streamed)" },
  },
  "gpt-4.1": {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    cost: { input: 0.000002, output: 0.000008, cacheRead: 0.0000005, cacheWrite: 0 },
    contextWindow: 1047576,
    maxOutputTokens: 32768,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "gpt-4.1-mini": {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    provider: "openai",
    cost: { input: 0.0000004, output: 0.0000016, cacheRead: 0.0000001, cacheWrite: 0 },
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "gemini-2.5-pro": {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "openai",
    cost: { input: 0.0000025, output: 0.000015, cacheRead: 0.000000625, cacheWrite: 0 },
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    reasoning: true,
    thinking: { level: "basic", description: "Built-in reasoning with thinking budget" },
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "openai",
    cost: { input: 0.00000015, output: 0.0000006, cacheRead: 0.0000000375, cacheWrite: 0 },
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    reasoning: true,
    thinking: { level: "basic", description: "Fast reasoning with thinking budget" },
  },
  "deepseek-r1": {
    id: "deepseek-r1",
    name: "DeepSeek R1",
    provider: "openai",
    cost: { input: 0.00000055, output: 0.00000219, cacheRead: 0.000000138, cacheWrite: 0 },
    contextWindow: 128000,
    maxOutputTokens: 8192,
    reasoning: true,
    thinking: { level: "extended", description: "Extended chain-of-thought with visible reasoning" },
  },
  "deepseek-v3": {
    id: "deepseek-v3",
    name: "DeepSeek V3",
    provider: "openai",
    cost: { input: 0.00000027, output: 0.0000011, cacheRead: 0.00000007, cacheWrite: 0 },
    contextWindow: 128000,
    maxOutputTokens: 8192,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "text-embedding-3-small": {
    id: "text-embedding-3-small",
    name: "Text Embedding 3 Small",
    provider: "openai",
    cost: { input: 0.00000002, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8191,
    maxOutputTokens: 0,
    reasoning: false,
    thinking: { level: "none", description: "Embedding model" },
  },
  "gpt-4o-mini-transcribe": {
    id: "gpt-4o-mini-transcribe",
    name: "GPT-4o Mini Transcribe",
    provider: "openai",
    cost: { input: 0.00000015, output: 0.0000006, cacheRead: 0.000000075, cacheWrite: 0 },
    contextWindow: 128000,
    maxOutputTokens: 16384,
    reasoning: false,
    thinking: { level: "none", description: "Speech-to-text transcription model" },
  },
  "gpt-5.2": {
    id: "gpt-5.2",
    name: "GPT-5.2",
    provider: "openai",
    cost: { input: 0.00000175, output: 0.000014, cacheRead: 0.000000175, cacheWrite: 0 },
    contextWindow: 400000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "gpt-5.2-pro": {
    id: "gpt-5.2-pro",
    name: "GPT-5.2 Pro",
    provider: "openai",
    cost: { input: 0.000021, output: 0.000168, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "gpt-5.6": {
    id: "gpt-5.6",
    name: "GPT-5.6 Sol",
    provider: "openai",
    cost: { input: 0.000005, output: 0.00003, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.6 Sol flagship reasoning; alias for gpt-5.6-sol", selectableEffort: true },
  },
  "gpt-5.6-sol": {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai",
    cost: { input: 0.000005, output: 0.00003, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.6 flagship reasoning for complex work", selectableEffort: true },
  },
  "gpt-5.6-terra": {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    cost: { input: 0.000003, output: 0.000018, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "Balanced GPT-5.6 reasoning for everyday work", selectableEffort: true },
  },
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    cost: { input: 0.000001, output: 0.000006, cacheRead: 0.0000001, cacheWrite: 0.00000125 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "Fast, cost-efficient GPT-5.6 reasoning for high-volume workloads", selectableEffort: true },
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai",
    cost: { input: 0.000003, output: 0.000018, cacheRead: 0.0000015, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.4 reasoning model", selectableEffort: true },
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    provider: "openai",
    cost: { input: 0.0000008, output: 0.0000048, cacheRead: 0.0000004, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.4 mini reasoning model", selectableEffort: true },
  },
  "gpt-5.5": {
    id: "gpt-5.5",
    name: "GPT-5.5",
    provider: "openai",
    cost: { input: 0.000005, output: 0.00003, cacheRead: 0.0000025, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.5 reasoning model", selectableEffort: true },
  },
  "gpt-5.5-pro": {
    id: "gpt-5.5-pro",
    name: "GPT-5.5 Pro",
    provider: "openai",
    cost: { input: 0.00003, output: 0.00018, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "gpt-5-mini": {
    id: "gpt-5-mini",
    name: "GPT-5 Mini",
    provider: "openai",
    cost: { input: 0.00000025, output: 0.000002, cacheRead: 0.000000025, cacheWrite: 0 },
    contextWindow: 400000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "none", description: "No visible thinking output" },
  },
  "gpt-5.6-sol-sub": {
    id: "gpt-5.6-sol-sub",
    name: "GPT-5.6 Sol (Subscription)",
    provider: "openai-subscription",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.6 Sol subscription reasoning via Codex/Work access", selectableEffort: true },
    requiresSubscription: true,
    codexModelId: "gpt-5.6-sol",
  },
  "gpt-5.6-terra-sub": {
    id: "gpt-5.6-terra-sub",
    name: "GPT-5.6 Terra (Subscription)",
    provider: "openai-subscription",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "Balanced GPT-5.6 subscription reasoning via Codex/Work access", selectableEffort: true },
    requiresSubscription: true,
    codexModelId: "gpt-5.6-terra",
  },
  "gpt-5.6-luna-sub": {
    id: "gpt-5.6-luna-sub",
    name: "GPT-5.6 Luna (Subscription)",
    provider: "openai-subscription",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "Fast GPT-5.6 subscription reasoning via Codex/Work access", selectableEffort: true },
    requiresSubscription: true,
    codexModelId: "gpt-5.6-luna",
  },
  "gpt-5.5-sub": {
    id: "gpt-5.5-sub",
    name: "GPT-5.5 (Subscription)",
    provider: "openai-subscription",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.5 subscription reasoning via Codex/Work access", selectableEffort: true },
    requiresSubscription: true,
    codexModelId: "gpt-5.5",
  },
  "gpt-5.4-sub": {
    id: "gpt-5.4-sub",
    name: "GPT-5.4 (Subscription)",
    provider: "openai-subscription",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.4 subscription reasoning via Codex/Work access", selectableEffort: true },
    requiresSubscription: true,
    codexModelId: "gpt-5.4",
  },
  "gpt-5.4-mini-sub": {
    id: "gpt-5.4-mini-sub",
    name: "GPT-5.4 Mini (Subscription)",
    provider: "openai-subscription",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "GPT-5.4 mini subscription reasoning via Codex/Work access", selectableEffort: true },
    requiresSubscription: true,
    codexModelId: "gpt-5.4-mini",
  },
  "gpt-5.3-codex-spark-sub": {
    id: "gpt-5.3-codex-spark-sub",
    name: "GPT-5.3 Codex Spark (Subscription)",
    provider: "openai-subscription",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxOutputTokens: 128000,
    reasoning: true,
    thinking: { level: "basic", description: "Codex Spark research preview for fast coding work", selectableEffort: true },
    requiresSubscription: true,
    codexModelId: "gpt-5.3-codex-spark",
  },
  "claude-sub": {
    id: "claude-sub",
    name: "Claude (Subscription)",
    provider: "claude-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "extended", description: "Extended thinking via Claude subscription (auto-selects model based on tier)" },
    requiresSubscription: true,
  },
  "claude-sonnet-sub": {
    id: "claude-sonnet-sub",
    name: "Claude Sonnet (Subscription)",
    provider: "claude-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "extended", description: "Extended thinking via Claude subscription" },
    requiresSubscription: true,
    claudeModelId: "sonnet",
  },
  "claude-opus-sub": {
    id: "claude-opus-sub",
    name: "Claude Opus (Subscription)",
    provider: "claude-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "extended", description: "Deep extended thinking via Claude subscription" },
    requiresSubscription: true,
    claudeModelId: "opus",
  },
  "claude-opus-4-7-sub": {
    id: "claude-opus-4-7-sub",
    name: "Claude Opus Latest (Subscription)",
    provider: "claude-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "extended", description: "Deep extended thinking via Claude subscription using Claude Code's documented Opus alias" },
    requiresSubscription: true,
    claudeModelId: "opus",
  },
  "claude-fable-sub": {
    id: "claude-fable-sub",
    name: "Claude Fable (Subscription)",
    provider: "claude-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "extended", description: "Mythos-class adaptive thinking via Claude subscription", adaptiveOnly: true },
    requiresSubscription: true,
    claudeModelId: "claude-fable-5",
  },
  "claude-opus-4-6-sub": {
    id: "claude-opus-4-6-sub",
    name: "Claude Opus 4.6 (Subscription)",
    provider: "claude-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "extended", description: "Deep extended thinking via Claude subscription" },
    requiresSubscription: true,
    claudeModelId: "claude-opus-4-6",
  },
  "claude-opus-4-5-sub": {
    id: "claude-opus-4-5-sub",
    name: "Claude Opus 4.5 (Subscription)",
    provider: "claude-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 128000,
    reasoning: false,
    thinking: { level: "extended", description: "Deep extended thinking via Claude subscription" },
    requiresSubscription: true,
    claudeModelId: "claude-opus-4-5",
  },
  "claude-haiku-sub": {
    id: "claude-haiku-sub",
    name: "Claude Haiku (Subscription)",
    provider: "claude-cli",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxOutputTokens: 64000,
    reasoning: false,
    thinking: { level: "none", description: "Fast responses via Claude subscription" },
    requiresSubscription: true,
    claudeModelId: "claude-haiku-4-5",
  },
};

const DEFAULT_COST: ModelCost = { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 };
const DEFAULT_THINKING: ModelThinking = { level: "none", description: "No visible thinking output" };
const DEFAULT_CONTEXT_WINDOW = 200000;

import { createLogger } from "./log";
const log = createLogger("ModelRegistry");

export function getModel(modelId: string): ModelInfo | undefined {
  const entry = REGISTRY[modelId];
  if (!entry) {
    log.debug(`getModel id=${modelId} found=false`);
  }
  return entry;
}

export function getModelCost(modelId: string): ModelCost {
  return REGISTRY[modelId]?.cost ?? DEFAULT_COST;
}

export function getModelCostPerMillion(modelId: string): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const c = getModelCost(modelId);
  return {
    input: c.input * 1_000_000,
    output: c.output * 1_000_000,
    cacheRead: c.cacheRead * 1_000_000,
    cacheWrite: c.cacheWrite * 1_000_000,
  };
}

export function getContextWindow(modelId: string): number {
  if (REGISTRY[modelId]) return REGISTRY[modelId].contextWindow;
  const fallback = modelId.includes("claude-fable") ? 1000000 : modelId.includes("claude") ? 200000 : modelId.includes("gpt-5") ? 1000000 : modelId.includes("gpt-4") ? 128000 : DEFAULT_CONTEXT_WINDOW;
  log.warn(`getContextWindow fallback for unregistered model id="${modelId}" window=${fallback}`);
  return fallback;
}

export function getMaxOutputTokens(modelId: string): number {
  return REGISTRY[modelId]?.maxOutputTokens ?? 8192;
}

export function isThinkingModel(modelId: string): boolean {
  const entry = REGISTRY[modelId];
  if (entry) return entry.thinking.level === "extended";
  const inferred = modelId.includes("claude-sonnet-4") || modelId.includes("claude-opus-4") || modelId.includes("claude-fable");
  if (inferred) {
    log.debug(`isThinkingModel id=${modelId} inferred=true (not in registry)`);
  }
  return inferred;
}

export function getThinkingInfo(modelId: string): ModelThinking {
  if (REGISTRY[modelId]) return REGISTRY[modelId].thinking;
  if (modelId.includes("o3") || modelId.includes("o4")) return { level: "basic", description: "Built-in chain-of-thought reasoning" };
  if (modelId.includes("fable")) return { level: "extended", description: "Mythos-class adaptive thinking", adaptiveOnly: true };
  if (modelId.includes("opus") || modelId.includes("sonnet")) return { level: "extended", description: "Extended thinking with visible reasoning" };
  if (modelId.includes("deepseek-r1")) return { level: "extended", description: "Extended chain-of-thought reasoning" };
  return DEFAULT_THINKING;
}

/** Whether the model exposes a selectable OpenAI reasoning-effort control. */
export function supportsSelectableEffort(modelId: string): boolean {
  return getThinkingInfo(modelId).selectableEffort === true;
}

export function getModelName(modelId: string): string {
  return REGISTRY[modelId]?.name ?? modelId;
}

export function getAllModelsForProvider(providerId: string): ModelInfo[] {
  const models = Object.values(REGISTRY).filter(m => m.provider === providerId && !m.id.includes("transcribe") && !m.id.includes("embedding"));
  log.debug(`getAllModelsForProvider provider=${providerId} count=${models.length}`);
  return models;
}

export function getSubscriptionModels(): Array<{ registryKey: string; info: ModelInfo }> {
  return Object.entries(REGISTRY)
    .filter(([, m]) => m.provider === "openai-subscription" || m.provider === "claude-cli")
    .map(([key, info]) => ({ registryKey: key, info }));
}

export function getDefaultProviderModels(): Array<{
  id: string;
  name: string;
  models: Array<{
    id: string;
    name: string;
    cost: ModelCost;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    thinkingLevel: "extended" | "basic" | "none";
    thinkingDescription: string;
    supportsReasoningEffort: boolean;
  }>;
}> {
  const providers: Record<string, typeof REGISTRY[string][]> = {};
  for (const model of Object.values(REGISTRY)) {
    if (model.id === "text-embedding-3-small" || model.id === "gpt-4o-mini-transcribe") continue;
    if (!providers[model.provider]) providers[model.provider] = [];
    providers[model.provider].push(model);
  }

  return Object.entries(providers).map(([providerId, models]) => ({
    id: providerId,
    name: providerId.charAt(0).toUpperCase() + providerId.slice(1),
    models: models.map(m => ({
      id: m.id,
      name: m.name,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxOutputTokens,
      reasoning: m.reasoning,
      thinkingLevel: m.thinking.level,
      thinkingDescription: m.thinking.description,
      supportsReasoningEffort: m.thinking.selectableEffort === true,
    })),
  }));
}
