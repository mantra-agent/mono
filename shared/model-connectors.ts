import { z } from "zod";

export const semanticTierSchema = z.enum(["max", "high", "balanced", "fast"]);
export type SemanticTier = z.infer<typeof semanticTierSchema>;
export const SEMANTIC_TIERS: readonly SemanticTier[] = semanticTierSchema.options;

export const modelConnectorProviderSchema = z.enum(["anthropic", "openai", "openai-subscription", "claude-cli", "grok-subscription"]);
export type ModelConnectorProvider = z.infer<typeof modelConnectorProviderSchema>;

export const modelTierMappingsSchema = z.object({
  max: z.string().trim().min(1),
  high: z.string().trim().min(1),
  balanced: z.string().trim().min(1),
  fast: z.string().trim().min(1),
}).strict();
export type ModelTierMappings = z.infer<typeof modelTierMappingsSchema>;

export const openAIConnectorSurfaceSchema = z.enum(["api", "subscription"]);
export type OpenAIConnectorSurface = z.infer<typeof openAIConnectorSurfaceSchema>;

export const openAIReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export type OpenAIReasoningEffort = z.infer<typeof openAIReasoningEffortSchema>;
export const openAIReasoningModeSchema = z.enum(["standard", "pro"]);
export type OpenAIReasoningMode = z.infer<typeof openAIReasoningModeSchema>;
export const openAIReasoningSummarySchema = z.enum(["auto", "concise", "detailed", "none"]);
export type OpenAIReasoningSummary = z.infer<typeof openAIReasoningSummarySchema>;
export const openAIVerbositySchema = z.enum(["low", "medium", "high"]);
export type OpenAIVerbosity = z.infer<typeof openAIVerbositySchema>;
export const openAIServiceTierSchema = z.enum(["auto", "default", "flex", "priority"]);
export type OpenAIServiceTier = z.infer<typeof openAIServiceTierSchema>;

function normalizeLegacyOpenAITierConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { fastMode: _legacyFastMode, ...rest } = value as Record<string, unknown>;
  return rest.serviceTier === "fast" ? { ...rest, serviceTier: "auto" } : rest;
}

export const openAITierModelConfigSchema = z.preprocess(normalizeLegacyOpenAITierConfig, z.object({
  model: z.string().trim().min(1),
  reasoningEffort: openAIReasoningEffortSchema.optional(),
  reasoningMode: openAIReasoningModeSchema.optional(),
  reasoningSummary: openAIReasoningSummarySchema.optional(),
  verbosity: openAIVerbositySchema.optional(),
  serviceTier: openAIServiceTierSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict());
export type OpenAITierModelConfig = z.infer<typeof openAITierModelConfigSchema>;

export const openAITierMappingsSchema = z.object({
  max: openAITierModelConfigSchema,
  high: openAITierModelConfigSchema,
  balanced: openAITierModelConfigSchema,
  fast: openAITierModelConfigSchema,
}).strict();
export type OpenAITierMappings = z.infer<typeof openAITierMappingsSchema>;

export const claudeCliEffortSchema = z.enum(["low", "medium", "high", "max"]);
export type ClaudeCliEffort = z.infer<typeof claudeCliEffortSchema>;
export const claudeCliThinkingModeSchema = z.enum(["adaptive", "disabled"]);
export type ClaudeCliThinkingMode = z.infer<typeof claudeCliThinkingModeSchema>;

export const claudeCliTierModelConfigSchema = z.object({
  model: z.string().trim().min(1),
  effort: claudeCliEffortSchema.optional(),
  thinkingMode: claudeCliThinkingModeSchema.optional(),
  maxTurns: z.number().int().min(1).max(1000).optional(),
  // Claude Code caps output at 32k (env CLAUDE_CODE_MAX_OUTPUT_TOKENS accepts 1-32000).
  // Lowering this shrinks the output reserve and raises the hard input limit, mirroring
  // the OpenAI connector's maxOutputTokens knob. Omit to use Claude Code's default cap.
  maxOutputTokens: z.number().int().min(1).max(32000).optional(),
}).strict();
export type ClaudeCliTierModelConfig = z.infer<typeof claudeCliTierModelConfigSchema>;

export const claudeCliTierMappingsSchema = z.object({
  max: claudeCliTierModelConfigSchema,
  high: claudeCliTierModelConfigSchema,
  balanced: claudeCliTierModelConfigSchema,
  fast: claudeCliTierModelConfigSchema,
}).strict();
export type ClaudeCliTierMappings = z.infer<typeof claudeCliTierMappingsSchema>;

// Grok subscription reasoning effort. xAI documents:
//   grok-4.3: none | low | medium | high  (none is the Haiku/mini-like off switch)
//   grok-4.5: low | medium | high         (cannot disable)
//   grok-4.6: low | medium | high | xhigh (cannot disable)
export const grokReasoningEffortSchema = z.enum(["none", "low", "medium", "high", "xhigh"]);
export type GrokReasoningEffort = z.infer<typeof grokReasoningEffortSchema>;

const GROK_REASONING_EFFORTS = {
  "grok-4.3": ["none", "low", "medium", "high"],
  "grok-4.5": ["low", "medium", "high"],
  "grok-4.6": ["low", "medium", "high", "xhigh"],
} as const satisfies Record<string, readonly GrokReasoningEffort[]>;

function bareGrokModelId(modelId: string): string {
  return modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
}

/** Closed, code-owned capability table for Grok reasoning_effort. Empty = model rejects the param. */
export function allowedGrokReasoningEfforts(modelId: string): readonly GrokReasoningEffort[] {
  const id = bareGrokModelId(modelId);
  return GROK_REASONING_EFFORTS[id as keyof typeof GROK_REASONING_EFFORTS] ?? [];
}

export function supportsGrokReasoningEffort(modelId: string): boolean {
  return allowedGrokReasoningEfforts(modelId).length > 0;
}

function normalizeGrokTierConfig(value: unknown): unknown {
  if (typeof value === "string") return { model: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { model, reasoningEffort } = value as Record<string, unknown>;
  return reasoningEffort === undefined ? { model } : { model, reasoningEffort };
}

export const grokSubscriptionTierModelConfigSchema = z.preprocess(
  normalizeGrokTierConfig,
  z.object({
    model: z.string().trim().min(1),
    reasoningEffort: grokReasoningEffortSchema.optional(),
  }).strict(),
);
export type GrokSubscriptionTierModelConfig = z.infer<typeof grokSubscriptionTierModelConfigSchema>;

export const grokSubscriptionTierMappingsSchema = z.object({
  max: grokSubscriptionTierModelConfigSchema,
  high: grokSubscriptionTierModelConfigSchema,
  balanced: grokSubscriptionTierModelConfigSchema,
  fast: grokSubscriptionTierModelConfigSchema,
}).strict();
export type GrokSubscriptionTierMappings = z.infer<typeof grokSubscriptionTierMappingsSchema>;

export type ConnectorTierModelConfig = OpenAITierModelConfig | ClaudeCliTierModelConfig | GrokSubscriptionTierModelConfig;

export const legacyModelConnectorConfigSchema = z.object({
  kind: z.literal("model"),
  tierMappings: modelTierMappingsSchema,
  migratedFrom: z.enum(["model_profiles", "manual"]).optional(),
}).strict();
export type LegacyModelConnectorConfig = z.infer<typeof legacyModelConnectorConfigSchema>;

export const openAIConnectorConfigSchema = z.object({
  kind: z.literal("openai-models"),
  version: z.literal(2),
  surface: openAIConnectorSurfaceSchema,
  tierMappings: openAITierMappingsSchema,
  migratedFrom: z.enum(["model_profiles", "manual", "model_connector_v1"]).optional(),
}).strict();
export type OpenAIConnectorConfig = z.infer<typeof openAIConnectorConfigSchema>;

export const claudeCliConnectorConfigSchema = z.object({
  kind: z.literal("claude-cli-models"),
  version: z.literal(1),
  tierMappings: claudeCliTierMappingsSchema,
  migratedFrom: z.enum(["model_profiles", "manual", "model_connector_v1"]).optional(),
}).strict();
export type ClaudeCliConnectorConfig = z.infer<typeof claudeCliConnectorConfigSchema>;

// Grok subscription connector. Grok models are OpenAI-compatible chat models
// addressed by plain name. Per-tier reasoningEffort is optional and gated by
// allowedGrokReasoningEfforts (4.3 includes none; 4.5/4.6 cannot disable).
// Legacy plain-string mappings are still accepted and normalized to { model }.
// Decorative keys such as maxOutputTokens are stripped at parse time because
// Grok never persisted or applied them.
export const grokSubscriptionConnectorConfigSchema = z.object({
  kind: z.literal("grok-models"),
  version: z.literal(1),
  tierMappings: grokSubscriptionTierMappingsSchema,
  migratedFrom: z.enum(["model_profiles", "manual", "model_connector_v1"]).optional(),
}).strict();
export type GrokSubscriptionConnectorConfig = z.infer<typeof grokSubscriptionConnectorConfigSchema>;

export const modelConnectorConfigSchema = z.union([
  legacyModelConnectorConfigSchema,
  openAIConnectorConfigSchema,
  claudeCliConnectorConfigSchema,
  grokSubscriptionConnectorConfigSchema,
]);
export type ModelConnectorConfig = z.infer<typeof modelConnectorConfigSchema>;

export function getConnectorTierModelConfig(config: ModelConnectorConfig, tier: SemanticTier): ConnectorTierModelConfig {
  const tierConfig = config.tierMappings[tier];
  return typeof tierConfig === "string" ? { model: tierConfig } : tierConfig;
}

export function getConnectorTierModelString(config: ModelConnectorConfig, tier: SemanticTier): string {
  return getConnectorTierModelConfig(config, tier).model;
}

export function isModelConnectorConfig(value: unknown): value is ModelConnectorConfig {
  return modelConnectorConfigSchema.safeParse(value).success;
}
