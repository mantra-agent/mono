// Use createLogger for logging ONLY
import { access, readFile } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { getSetting, setSetting } from "./system-settings";
import { createLogger } from "./log";
import { getSecretSync } from "./secrets-store";
import {
  type ThinkingTierConfig,
  thinkingBudgetToTier,
  tierToThinkingBudget,
  isAdaptiveCapable,
} from "./thinking-config";

export type { ThinkingTierConfig };

const jobLog = createLogger("JobProfiles");

const DB_KEY = "model_profiles";

export type TierId = "max" | "high" | "balanced" | "fast" | "advocate" | "advisary";

/** Canonical tier ordering used in defaults loops, schemas, and UI tier ordering. */
export const ALL_TIER_IDS: readonly TierId[] = ["max", "high", "balanced", "fast", "advocate", "advisary"] as const;
export type ActivityId = string;
export type RoutingTier = TierId | "auto";

export const ACTIVITY_CHAT = "c7a1e3b4-5d2f-4a89-b6e0-1f8c9d2e3a4b";
export const ACTIVITY_WORK = "d8b2f4c5-6e3a-4b90-c7f1-2a9d0e3f4b5c";
export const ACTIVITY_FRAMING = "e9c3a5d6-7f4b-4c01-d8a2-3b0e1f4a5c6d";
export const ACTIVITY_RECALL = "f0d4b6e7-8a5c-4d12-e9b3-4c1f2a5b6d7e";
export const ACTIVITY_MEMORY = "a1e5c7f8-9b6d-4e23-f0c4-5d2a3b6c7e8f";
export const ACTIVITY_THINKING = "b2f6d8a9-0c7e-4f34-a1d5-6e3b4c7d8f0a";
export const ACTIVITY_STRATEGY = "c3a7e9b0-1d8f-4a45-b2e6-7f4c5d8e9a1b";
export const ACTIVITY_MEDIA = "d4b8f0c1-2e9a-4b56-c3f7-8a5d6e9f0b2c";
export const ACTIVITY_VOICE = "e5c9a1d2-3f0b-4c67-d4a8-9b6e7f0a1c3d";
export const ACTIVITY_VOICE_GREETING = "f6d0b2e3-4a1c-4d78-e5b9-0c7f8a1b2d4e";

export interface TierConfig {
  model: string;
  /** @deprecated Use `thinking` instead. Kept for one-cycle backward compatibility. */
  thinkingBudget?: number;
  thinking?: ThinkingTierConfig;
}

export interface TierMeta {
  id: TierId;
  label: string;
  description: string;
}

export interface ActivityMeta {
  id: string;
  label: string;
  description: string;
}

export const BUILTIN_ACTIVITY_IDS: readonly string[] = [
  ACTIVITY_CHAT,
  ACTIVITY_WORK,
  ACTIVITY_FRAMING,
  ACTIVITY_RECALL,
  ACTIVITY_MEMORY,
  ACTIVITY_THINKING,
  ACTIVITY_STRATEGY,
  ACTIVITY_MEDIA,
  ACTIVITY_VOICE,
  ACTIVITY_VOICE_GREETING,
] as const;

export const OLD_TO_NEW_ACTIVITY_MAP: Record<string, string> = {
  chat: ACTIVITY_CHAT,
  agent_tasks: ACTIVITY_WORK,
  background: ACTIVITY_FRAMING,
  context_assembly: ACTIVITY_RECALL,
  myelination: ACTIVITY_MEMORY,
  meta_cognition: ACTIVITY_THINKING,
  strategy: ACTIVITY_STRATEGY,
  voice: ACTIVITY_VOICE,
  voice_greeting: ACTIVITY_VOICE_GREETING,
};

export const TIER_META: TierMeta[] = [
  { id: "max", label: "Max", description: "Best available model, full extended thinking" },
  { id: "high", label: "High", description: "Excellent quality-to-cost ratio" },
  { id: "balanced", label: "Balanced", description: "Good middle ground for most tasks" },
  { id: "fast", label: "Fast", description: "Optimized for speed and efficiency" },
  { id: "advocate", label: "Advocate", description: "Council Advocate A — paired against the Advisary tier; configure to a different provider for genuine adversarial deliberation" },
  { id: "advisary", label: "Advisary", description: "Council Advocate B — counterpoint advisor for adversarial deliberation; configure to a different provider than Advocate" },
];

export const ACTIVITY_META: ActivityMeta[] = [
  { id: ACTIVITY_CHAT, label: "Communication", description: "Conversations with Agent" },
  { id: ACTIVITY_WORK, label: "Work", description: "Complex reasoning and code generation" },
  { id: ACTIVITY_RECALL, label: "Recall", description: "Agenda preparation before voice sessions" },
  { id: ACTIVITY_FRAMING, label: "Framing", description: "Titles, summaries, classification" },
  { id: ACTIVITY_MEMORY, label: "Memory", description: "Memory summarization, embedding, and linking" },
  { id: ACTIVITY_THINKING, label: "Thinking", description: "Periodic self-observation and metacognitive reflection" },
  { id: ACTIVITY_STRATEGY, label: "Strategy", description: "Strategic simulation, analysis, and move discovery" },
  { id: ACTIVITY_MEDIA, label: "Media", description: "Image analysis, vision, and media processing" },
  { id: ACTIVITY_VOICE, label: "Voice", description: "Real-time voice session turns" },
  { id: ACTIVITY_VOICE_GREETING, label: "Voice Greeting", description: "Fast greeting generation for voice sessions" },
];

export const DEFAULT_ACTIVITY_ROUTING: Record<ActivityId, RoutingTier> = {
  [ACTIVITY_CHAT]: "high",
  [ACTIVITY_WORK]: "max",
  [ACTIVITY_RECALL]: "balanced",
  [ACTIVITY_FRAMING]: "fast",
  [ACTIVITY_MEMORY]: "fast",
  [ACTIVITY_THINKING]: "max",
  [ACTIVITY_STRATEGY]: "balanced",
  [ACTIVITY_MEDIA]: "high",
  [ACTIVITY_VOICE]: "high",
  [ACTIVITY_VOICE_GREETING]: "fast",
};

export function getActivityDisplayName(activityId: string): string {
  const meta = ACTIVITY_META.find(a => a.id === activityId);
  if (meta) return meta.label;
  return activityId;
}

export function resolveActivityId(idOrLegacy: string): string {
  return OLD_TO_NEW_ACTIVITY_MAP[idOrLegacy] || idOrLegacy;
}

interface StoredConfig {
  tiers: Record<TierId, TierConfig>;
  routing: Record<string, RoutingTier>;
  customActivities?: ActivityMeta[];
  activityLabelOverrides?: Record<string, { label: string; description: string }>;
  configuredFallback?: TierId;
  providerPolicy?: { enabled?: Record<string, boolean> };
  updatedAt?: string;
}

export type RoutingDecisionSource = "stored-profile" | "configured-fallback" | "explicit-override";

export interface ModelRoutingDecision {
  activity: ActivityId;
  tier: string;
  model: string;
  provider: string;
  modelString: string;
  configVersion: string;
  configHash: string;
  explicitOverride: boolean;
  overrideReason?: string;
  providerEnabled: boolean;
  source: RoutingDecisionSource;
}

export class ModelRoutingError extends Error {
  code = "MODEL_ROUTING_ERROR";
  routing?: Partial<ModelRoutingDecision>;
  constructor(message: string, routing?: Partial<ModelRoutingDecision>) { super(message); this.name = "ModelRoutingError"; this.routing = routing; }
}

export class ProviderDisabledError extends Error {
  code = "PROVIDER_DISABLED";
  routing?: Partial<ModelRoutingDecision>;
  constructor(message: string, routing?: Partial<ModelRoutingDecision>) { super(message); this.name = "ProviderDisabledError"; this.routing = routing; }
}

function splitProviderModel(modelString: string): { provider: string; model: string } {
  const parts = modelString.split("/");
  if (parts.length >= 2) return { provider: parts[0], model: parts.slice(1).join("/") };
  return { provider: "openai", model: modelString };
}

function stableConfigHash(config: StoredConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);
}

function touchConfig(config: StoredConfig): void { config.updatedAt = new Date().toISOString(); }

export function getModelProfilesVersion(): { configVersion: string; configHash: string; updatedAt?: string } {
  const config = getConfig();
  const configHash = stableConfigHash(config);
  return { configVersion: config.updatedAt || configHash, configHash, updatedAt: config.updatedAt };
}

export function invalidateModelProfilesCache(reason: string): void {
  cachedConfig = null;
  dbInitialized = false;
  jobLog.log(`model profile cache invalidated reason=${reason}`);
}

function detectDefaultTiers(): Record<TierId, string> {
  const hasAnthropic = !!getSecretSync("ANTHROPIC_API_KEY");
  const hasOpenai = !!getSecretSync("OPENAI_API_KEY");
  const hasClaudeCli = !!getSecretSync("CLAUDE_CODE_OAUTH_TOKEN");

  if (hasClaudeCli && !hasAnthropic && !hasOpenai) {
    return {
      max: "claude-cli/claude-opus-sub",
      high: "claude-cli/claude-sonnet-sub",
      balanced: "claude-cli/claude-sonnet-sub",
      fast: "claude-cli/claude-sonnet-sub",
      advocate: "claude-cli/claude-opus-sub",
      advisary: "claude-cli/claude-opus-sub",
    };
  }

  if (hasAnthropic && hasOpenai) {
    return {
      max: "anthropic/claude-opus-4-6",
      high: "anthropic/claude-sonnet-4-6",
      balanced: "anthropic/claude-3-haiku-20240307",
      fast: "openai/gpt-5-mini",
      advocate: "anthropic/claude-opus-4-6",
      advisary: "openai/gpt-5.2-pro",
    };
  }
  if (hasAnthropic) {
    return {
      max: "anthropic/claude-opus-4-6",
      high: "anthropic/claude-sonnet-4-6",
      balanced: "anthropic/claude-sonnet-4-6",
      fast: "anthropic/claude-3-haiku-20240307",
      advocate: "anthropic/claude-opus-4-6",
      advisary: "anthropic/claude-opus-4-6",
    };
  }
  if (hasOpenai) {
    return {
      max: "openai/gpt-5.2-pro",
      high: "openai/gpt-5.2",
      balanced: "openai/gpt-5-mini",
      fast: "openai/gpt-5-mini",
      advocate: "openai/gpt-5.2-pro",
      advisary: "openai/gpt-5.2-pro",
    };
  }
  return {
    max: "anthropic/claude-opus-4-6",
    high: "anthropic/claude-sonnet-4-6",
    balanced: "anthropic/claude-3-haiku-20240307",
    fast: "openai/gpt-5-mini",
    advocate: "anthropic/claude-opus-4-6",
    advisary: "openai/gpt-5.2-pro",
  };
}

let cachedConfig: StoredConfig | null = null;
let dbInitialized = false;

async function tryReadLegacyFiles(): Promise<StoredConfig | null> {
  try {
    const legacyPaths = [
      join(".openclaw", "workspace", "config", "profiles.json"),
      join(".openclaw", "profiles.json"),
    ];
    for (const filePath of legacyPaths) {
      try {
        await access(filePath);
        const raw = JSON.parse(await readFile(filePath, "utf-8"));
        if (raw.tiers && raw.routing) {
          return raw as StoredConfig;
        }
      } catch { /* file doesn't exist, try next */ }
    }
  } catch (err) { jobLog.warn("loadFromDb failed", err); }
  return null;
}

const KNOWN_INVALID_MODELS: Record<string, string> = {
  "anthropic/claude-haiku-3-5-20241022": "anthropic/claude-3-haiku-20240307",
  "anthropic/claude-3-5-haiku-20241022": "anthropic/claude-3-haiku-20240307",
  "anthropic/claude-haiku-3-20240307": "anthropic/claude-3-haiku-20240307",
  "anthropic/claude-opus-4-6-20260214": "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-6-20260214": "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20250415": "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-sonnet-4-5-20241022": "anthropic/claude-sonnet-4-5-20250929",
  "anthropic/claude-opus-4-1-20250415": "anthropic/claude-opus-4-1-20250805",
};

function validateModelId(model: string): string {
  if (KNOWN_INVALID_MODELS[model]) {
    jobLog.log(`Correcting invalid model "${model}" → "${KNOWN_INVALID_MODELS[model]}"`);
    return KNOWN_INVALID_MODELS[model];
  }
  return model;
}

function buildDefaultConfig(): StoredConfig {
  const defaults = detectDefaultTiers();
  return {
    tiers: {
      max: { model: defaults.max, thinkingBudget: 8192, thinking: { type: "enabled", budgetTokens: 8192 } },
      high: { model: defaults.high, thinkingBudget: 0, thinking: { type: "disabled" } },
      balanced: { model: defaults.balanced, thinkingBudget: 0, thinking: { type: "disabled" } },
      fast: { model: defaults.fast, thinkingBudget: 0, thinking: { type: "disabled" } },
      advocate: { model: defaults.advocate, thinkingBudget: 8192, thinking: { type: "enabled", budgetTokens: 8192 } },
      advisary: { model: defaults.advisary, thinkingBudget: 8192, thinking: { type: "enabled", budgetTokens: 8192 } },
    },
    routing: { ...DEFAULT_ACTIVITY_ROUTING },
  };
}

function migrateRoutingKeys(stored: StoredConfig): boolean {
  let migrated = false;
  for (const [oldKey, newKey] of Object.entries(OLD_TO_NEW_ACTIVITY_MAP)) {
    if (stored.routing[oldKey] && !stored.routing[newKey]) {
      stored.routing[newKey] = stored.routing[oldKey];
      delete stored.routing[oldKey];
      migrated = true;
    } else if (stored.routing[oldKey]) {
      delete stored.routing[oldKey];
      migrated = true;
    }
  }
  if (stored.activityLabelOverrides) {
    for (const [oldKey, newKey] of Object.entries(OLD_TO_NEW_ACTIVITY_MAP)) {
      if (stored.activityLabelOverrides[oldKey]) {
        if (!stored.activityLabelOverrides[newKey]) {
          stored.activityLabelOverrides[newKey] = stored.activityLabelOverrides[oldKey];
        }
        delete stored.activityLabelOverrides[oldKey];
        migrated = true;
      }
    }
  }
  return migrated;
}

function fillDefaults(stored: StoredConfig): { config: StoredConfig; corrected: boolean } {
  const defaults = buildDefaultConfig();
  let corrected = migrateRoutingKeys(stored);
  for (const tid of ALL_TIER_IDS) {
    if (!stored.tiers[tid]) {
      stored.tiers[tid] = defaults.tiers[tid];
      corrected = true;
    } else {
      const fixed = validateModelId(stored.tiers[tid].model);
      if (fixed !== stored.tiers[tid].model) {
        stored.tiers[tid].model = fixed;
        corrected = true;
      }
    }
  }
  const DEFAULT_THINKING_BUDGETS: Partial<Record<TierId, number>> = { max: 8192, advocate: 8192, advisary: 8192 };
  for (const tid of ALL_TIER_IDS) {
    const tier = stored.tiers[tid];
    if (!tier) continue;

    if (tier.thinking === undefined) {
      if (tier.thinkingBudget !== undefined) {
        // Migrate legacy: number → discriminated shape
        tier.thinking = thinkingBudgetToTier(tier.thinkingBudget);
      } else {
        // No prior config at all: use the registry's signal (extended-capable) and
        // the per-tier default budget to pick a reasonable starting shape.
        const adaptiveCapable = isAdaptiveCapable(tier.model);
        const defaultBudget = DEFAULT_THINKING_BUDGETS[tid] || 0;
        tier.thinking = adaptiveCapable && defaultBudget > 0
          ? { type: "enabled", budgetTokens: defaultBudget }
          : { type: "disabled" };
      }
      corrected = true;
    }

    // Validate adaptive against the model's capability at config-load time.
    // If a stored config selects adaptive on a non-adaptive-capable model,
    // fall back to a fixed budget (or disabled) and warn once.
    if (tier.thinking?.type === "adaptive" && !isAdaptiveCapable(tier.model)) {
      // Prefer an existing legacy budget if present (>0), otherwise the per-tier
      // default budget, otherwise disabled.
      const legacyBudget = typeof tier.thinkingBudget === "number" && tier.thinkingBudget > 0
        ? tier.thinkingBudget
        : 0;
      const fallbackBudget = legacyBudget > 0 ? legacyBudget : (DEFAULT_THINKING_BUDGETS[tid] ?? 0);
      const fallback: ThinkingTierConfig = fallbackBudget > 0
        ? { type: "enabled", budgetTokens: fallbackBudget }
        : { type: "disabled" };
      jobLog.warn(`tier=${tid} model=${tier.model} not adaptive-capable — falling back from adaptive(${tier.thinking.effort}) to ${fallback.type === "enabled" ? `enabled(${fallback.budgetTokens})` : "disabled"}`);
      tier.thinking = fallback;
      corrected = true;
    }

    // Keep legacy field in sync (readable for one cycle)
    const legacyEquivalent = tierToThinkingBudget(tier.thinking);
    if (tier.thinkingBudget !== legacyEquivalent) {
      tier.thinkingBudget = legacyEquivalent;
      corrected = true;
    }
  }
  // Do not silently repair missing activity routing from defaults. A stored model
  // profile is routing policy; missing activity mappings must fail loudly in
  // resolveModelForActivity unless an explicit configuredFallback is present.
  if (stored.routing["voice"]) {
    delete stored.routing["voice"];
    corrected = true;
  }
  if (stored.activityLabelOverrides) {
    const builtinDefaults: Record<string, string> = {};
    for (const a of ACTIVITY_META) builtinDefaults[a.id] = a.label;
    for (const [id, ov] of Object.entries(stored.activityLabelOverrides)) {
      if (id === "voice" || (builtinDefaults[id] && ov.label === builtinDefaults[id])) {
        delete stored.activityLabelOverrides[id];
        corrected = true;
      }
    }
    if (Object.keys(stored.activityLabelOverrides).length === 0) {
      delete stored.activityLabelOverrides;
    }
  }
  return { config: stored, corrected };
}

export async function initProfiles(): Promise<void> {
  if (dbInitialized) return;
  try {
    const fromDb = await getSetting<StoredConfig>(DB_KEY);
    if (fromDb) {
      const { config, corrected } = fillDefaults(fromDb);
      cachedConfig = config;
      if (corrected) {
        await setSetting(DB_KEY, cachedConfig);
        jobLog.log("Saved corrected config to DB");
      }
      dbInitialized = true;
      return;
    }

    const fromFile = tryReadLegacyFiles();
    if (fromFile) {
      const { config } = fillDefaults(fromFile as any);
      cachedConfig = config;
      await setSetting(DB_KEY, cachedConfig);
      jobLog.log("Migrated profiles from file to DB");
      dbInitialized = true;
      return;
    }

    cachedConfig = buildDefaultConfig();
    await setSetting(DB_KEY, cachedConfig);
    dbInitialized = true;
  } catch (err: any) {
    jobLog.error("DB init failed, using defaults:", err.message);
    if (!cachedConfig) cachedConfig = buildDefaultConfig();
  }
}

export function getConfig(): StoredConfig {
  if (cachedConfig) return cachedConfig;
  jobLog.warn("getConfig() called before initProfiles() — returning defaults (will not persist)");
  cachedConfig = buildDefaultConfig();
  return cachedConfig;
}

export async function setTierModel(
  tierId: TierId,
  model: string,
  thinking?: ThinkingTierConfig | number,
): Promise<void> {
  await initProfiles();
  const config = getConfig();
  const existing = config.tiers[tierId];
  let nextThinking: ThinkingTierConfig | undefined = existing?.thinking;
  if (thinking !== undefined) {
    nextThinking = typeof thinking === "number" ? thinkingBudgetToTier(thinking) : thinking;
  }
  config.tiers[tierId] = {
    model: validateModelId(model),
    thinking: nextThinking,
    thinkingBudget: tierToThinkingBudget(nextThinking),
  };
  touchConfig(config);
  cachedConfig = config;
  await setSetting(DB_KEY, config);
}

export async function setTierThinking(tierId: TierId, thinking: ThinkingTierConfig): Promise<void> {
  await initProfiles();
  const config = getConfig();
  const existing = config.tiers[tierId];
  if (!existing) throw new Error(`Tier ${tierId} has no model assigned`);
  config.tiers[tierId] = {
    ...existing,
    thinking,
    thinkingBudget: tierToThinkingBudget(thinking),
  };
  touchConfig(config);
  cachedConfig = config;
  await setSetting(DB_KEY, config);
}

export async function setTierThinkingBudget(tierId: TierId, thinkingBudget: number): Promise<void> {
  await setTierThinking(tierId, thinkingBudgetToTier(thinkingBudget));
}

export async function setActivityRouting(activityId: ActivityId, tier: RoutingTier): Promise<void> {
  await initProfiles();
  const config = getConfig();
  config.routing[activityId] = tier;
  touchConfig(config);
  cachedConfig = config;
  await setSetting(DB_KEY, config);
}

export function resolveModelForActivity(activityId: ActivityId, options: { model?: string; overrideReason?: string; allowDisabledProvider?: boolean } = {}): ModelRoutingDecision {
  const activity = resolveActivityId(activityId || ACTIVITY_FRAMING);
  const config = getConfig();
  const configHash = stableConfigHash(config);
  const configVersion = config.updatedAt || configHash;
  const configuredProviders = new Set<string>();
  for (const tierConfig of Object.values(config.tiers || {})) if (tierConfig?.model) configuredProviders.add(splitProviderModel(tierConfig.model).provider);
  const providerEnabled = (provider: string) => {
    const enabled = config.providerPolicy?.enabled;
    if (enabled && Object.prototype.hasOwnProperty.call(enabled, provider)) return enabled[provider] !== false;
    return configuredProviders.size === 0 || configuredProviders.has(provider);
  };

  if (options.model) {
    if (!options.overrideReason) throw new ModelRoutingError("Explicit model override requires overrideReason", { activity, modelString: options.model, explicitOverride: true });
    const modelString = validateModelId(options.model);
    const parsed = splitProviderModel(modelString);
    const decision: ModelRoutingDecision = { activity, tier: "explicit-override", model: parsed.model, provider: parsed.provider, modelString, configVersion, configHash, explicitOverride: true, overrideReason: options.overrideReason, providerEnabled: providerEnabled(parsed.provider), source: "explicit-override" };
    if (!decision.providerEnabled && !options.allowDisabledProvider) throw new ProviderDisabledError(`Provider ${parsed.provider} is disabled by model profile policy`, decision);
    return decision;
  }

  let tier = config.routing[activity];
  let source: RoutingDecisionSource = "stored-profile";
  if (!tier) {
    if (!config.configuredFallback) throw new ModelRoutingError(`Model profile invalid: activity ${activity} has no routing tier and no configured fallback`, { activity, configHash, configVersion, explicitOverride: false });
    tier = config.configuredFallback; source = "configured-fallback";
  }
  const resolvedTier = (tier === "auto" ? "balanced" : tier) as TierId;
  const modelString = config.tiers[resolvedTier]?.model;
  if (!modelString) throw new ModelRoutingError(`Model profile invalid: tier ${resolvedTier} has no configured model`, { activity, tier: resolvedTier, configHash, configVersion, explicitOverride: false });
  const validModelString = validateModelId(modelString);
  const parsed = splitProviderModel(validModelString);
  const decision: ModelRoutingDecision = { activity, tier: resolvedTier, model: parsed.model, provider: parsed.provider, modelString: validModelString, configVersion, configHash, explicitOverride: false, providerEnabled: providerEnabled(parsed.provider), source };
  if (!decision.providerEnabled) throw new ProviderDisabledError(`Provider ${parsed.provider} is disabled by model profile policy`, decision);
  jobLog.debug(`resolveModel activity=${activity} tier=${resolvedTier} provider=${parsed.provider} model=${parsed.model} source=${source} configHash=${configHash}`);
  return decision;
}

export function getModelForActivity(activityId: ActivityId): string {
  return resolveModelForActivity(activityId).modelString;
}

export function getThinkingBudgetForActivity(activityId: ActivityId): number {
  return tierToThinkingBudget(getThinkingForActivity(activityId));
}

export function getThinkingForActivity(activityId: ActivityId): ThinkingTierConfig {
  const config = getConfig();
  const tier = config.routing[activityId];
  if (!tier || tier === "auto") {
    const balanced = config.tiers["balanced"];
    return balanced?.thinking ?? thinkingBudgetToTier(balanced?.thinkingBudget);
  }
  const t = config.tiers[tier];
  return t?.thinking ?? thinkingBudgetToTier(t?.thinkingBudget);
}

export function getTierForActivity(activityId: ActivityId): TierId | "auto" | null {
  const config = getConfig();
  const tier = config.routing[activityId];
  return tier ?? null;
}

export function getModelForAutoTier(escalationLevel: "fast" | "balanced" | "high" | "max"): string {
  const config = getConfig();
  return config.tiers[escalationLevel]?.model || detectDefaultTiers()[escalationLevel];
}

/** Resolve a tier id to its currently-configured model, falling back to provider defaults. */
export function getModelForTier(tierId: TierId): string {
  const config = getConfig();
  return config.tiers[tierId]?.model || detectDefaultTiers()[tierId];
}


export function isAutoRouting(activityId: ActivityId): boolean {
  const config = getConfig();
  return config.routing[activityId] === "auto";
}

const COMPLEXITY_LEVELS = ["fast", "balanced", "high", "max"] as const;
type ComplexityLevel = typeof COMPLEXITY_LEVELS[number];

export function getAllActivities(): ActivityMeta[] {
  const config = getConfig();
  const overrides = config.activityLabelOverrides || {};
  const customs = config.customActivities || [];

  const builtins = ACTIVITY_META.map(a => {
    const ov = overrides[a.id];
    return ov ? { ...a, label: ov.label, description: ov.description } : a;
  });

  const customWithOverrides = customs.map(a => {
    const ov = overrides[a.id];
    return ov ? { ...a, label: ov.label, description: ov.description } : a;
  });

  return [...builtins, ...customWithOverrides];
}

export async function addCustomActivity(id: string, label: string, description: string): Promise<void> {
  if (BUILTIN_ACTIVITY_IDS.includes(id)) {
    throw new Error(`Cannot add "${id}" — it is a built-in activity type`);
  }
  await initProfiles();
  const config = getConfig();
  const customs = config.customActivities || [];
  if (customs.some(a => a.id === id)) {
    throw new Error(`Activity "${id}" already exists`);
  }
  customs.push({ id, label, description });
  config.customActivities = customs;
  if (!config.routing[id]) {
    config.routing[id] = "balanced";
  }
  touchConfig(config);
  cachedConfig = config;
  await setSetting(DB_KEY, config);
}

export async function updateActivityMeta(id: string, label: string, description: string): Promise<void> {
  await initProfiles();
  const config = getConfig();
  if (!config.activityLabelOverrides) config.activityLabelOverrides = {};
  config.activityLabelOverrides[id] = { label, description };

  const customs = config.customActivities || [];
  const idx = customs.findIndex(a => a.id === id);
  if (idx >= 0) {
    customs[idx] = { ...customs[idx], label, description };
    config.customActivities = customs;
  }

  touchConfig(config);
  cachedConfig = config;
  await setSetting(DB_KEY, config);
}

export async function removeCustomActivity(id: string): Promise<void> {
  if (BUILTIN_ACTIVITY_IDS.includes(id)) {
    throw new Error(`Cannot remove built-in activity "${id}"`);
  }
  await initProfiles();
  const config = getConfig();
  const customs = config.customActivities || [];
  config.customActivities = customs.filter(a => a.id !== id);
  delete config.routing[id];
  if (config.activityLabelOverrides) {
    delete config.activityLabelOverrides[id];
  }
  touchConfig(config);
  cachedConfig = config;
  await setSetting(DB_KEY, config);
}

export async function classifyComplexity(userMessage: string): Promise<{ tier: TierId; model: string }> {
  const { chatCompletion } = await import("./model-client");
  const config = getConfig();

  try {
    const classifyMessages = [
      {
        role: "system" as const,
        content: await (await import("./prompt-modules")).getPromptModulePrompt("agent-classifycomplexity"),
      },
      { role: "user" as const, content: userMessage.length > 10000 ? userMessage.slice(0, 10000) : userMessage },
    ];
    const result = await chatCompletion({
      activity: ACTIVITY_FRAMING,
      maxTokens: 50,
      messages: classifyMessages,
      temperature: 0,
      metadata: { source: "classify-complexity", activity: ACTIVITY_FRAMING },
    });

    const raw = result.content.trim().toLowerCase();
    const level = COMPLEXITY_LEVELS.find(l => raw.includes(l)) || "balanced";
    const selectedModel = config.tiers[level]?.model || detectDefaultTiers()[level];

    jobLog.log(`[AUTO-TIER] Classified "${userMessage.slice(0, 60)}..." as ${level} → ${selectedModel} (via ${result.provider}/${result.model})`);
    return { tier: level, model: selectedModel };
  } catch (err: any) {
    jobLog.warn("[AUTO-TIER] Classification failed, defaulting to balanced:", err?.message);
    const fallback = config.tiers["balanced"]?.model || detectDefaultTiers().balanced;
    return { tier: "balanced", model: fallback };
  }
}
