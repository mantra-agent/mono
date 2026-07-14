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

export const modelConnectorConfigSchema = z.object({
  kind: z.literal("model"),
  tierMappings: modelTierMappingsSchema,
  migratedFrom: z.enum(["model_profiles", "manual"]).optional(),
}).strict();
export type ModelConnectorConfig = z.infer<typeof modelConnectorConfigSchema>;

export function isModelConnectorConfig(value: unknown): value is ModelConnectorConfig {
  return modelConnectorConfigSchema.safeParse(value).success;
}
