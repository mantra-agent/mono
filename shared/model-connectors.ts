import { z } from "zod";

export const semanticTierSchema = z.enum(["max", "high", "balanced", "fast"]);
export type SemanticTier = z.infer<typeof semanticTierSchema>;
export const SEMANTIC_TIERS: readonly SemanticTier[] = semanticTierSchema.options;

export const modelConnectorProviderSchema = z.enum(["anthropic", "openai", "openai-subscription", "claude-cli"]);
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
export const openAIServiceTierSchema = z.enum(["auto", "default", "flex", "priority", "fast"]);
export type OpenAIServiceTier = z.infer<typeof openAIServiceTierSchema>;

export const openAITierModelConfigSchema = z.object({
  model: z.string().trim().min(1),
  reasoningEffort: openAIReasoningEffortSchema.optional(),
  reasoningMode: openAIReasoningModeSchema.optional(),
  reasoningSummary: openAIReasoningSummarySchema.optional(),
  verbosity: openAIVerbositySchema.optional(),
  serviceTier: openAIServiceTierSchema.optional(),
  maxOutputTokens: z.number().int().positive().optional(),
}).strict();
export type OpenAITierModelConfig = z.infer<typeof openAITierModelConfigSchema>;

export const openAITierMappingsSchema = z.object({
  max: openAITierModelConfigSchema,
  high: openAITierModelConfigSchema,
  balanced: openAITierModelConfigSchema,
  fast: openAITierModelConfigSchema,
}).strict();
export type OpenAITierMappings = z.infer<typeof openAITierMappingsSchema>;

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

export const modelConnectorConfigSchema = z.union([legacyModelConnectorConfigSchema, openAIConnectorConfigSchema]);
export type ModelConnectorConfig = z.infer<typeof modelConnectorConfigSchema>;

export function getConnectorTierModelConfig(config: ModelConnectorConfig, tier: SemanticTier): OpenAITierModelConfig {
  const tierConfig = config.tierMappings[tier];
  return typeof tierConfig === "string" ? { model: tierConfig } : tierConfig;
}

export function getConnectorTierModelString(config: ModelConnectorConfig, tier: SemanticTier): string {
  return getConnectorTierModelConfig(config, tier).model;
}

export function isModelConnectorConfig(value: unknown): value is ModelConnectorConfig {
  return modelConnectorConfigSchema.safeParse(value).success;
}
