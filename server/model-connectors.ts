import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope } from "./scoped-storage";
import { getSetting } from "./system-settings";
import { providerConnections } from "@shared/models/platforms";
import {
  modelConnectorConfigSchema,
  modelConnectorProviderSchema,
  modelTierMappingsSchema,
  type ModelConnectorConfig,
  type ModelConnectorProvider,
  type ModelTierMappings,
  type OpenAIConnectorConfig,
  type OpenAIConnectorSurface,
  type OpenAITierModelConfig,
  type OpenAITierMappings,
} from "@shared/model-connectors";
import { getModel, type ModelInfo } from "./model-registry";

const log = createLogger("ModelConnectors");
const LEGACY_PROFILE_KEY = "model_profiles";
const scopeColumns = {
  scope: providerConnections.scope,
  ownerUserId: providerConnections.ownerUserId,
  accountId: providerConnections.accountId,
};

interface LegacyTierConfig { model?: string }
interface LegacyProfiles { tiers?: Record<string, LegacyTierConfig> }

export interface ModelConnector {
  id: number;
  provider: ModelConnectorProvider;
  label: string;
  status: string;
  sortOrder: number;
  credentialRef: string | null;
  lastVerifiedAt: string | null;
  config: ModelConnectorConfig;
}

function normalizeModelId(provider: ModelConnectorProvider, modelString: string): string {
  const parsed = splitModel(modelString);
  if (parsed) {
    if (parsed.provider !== provider) throw new Error(`Model '${modelString}' does not belong to provider '${provider}'`);
    return parsed.modelId.slice(parsed.modelId.indexOf("/") + 1);
  }
  return modelString;
}

function validateModelBelongsToProvider(provider: ModelConnectorProvider, modelString: string): ModelInfo {
  const modelId = normalizeModelId(provider, modelString);
  const model = getModel(modelId);
  if (!model) throw new Error(`Unknown model '${modelString}'`);
  if (model.provider !== provider) throw new Error(`Model '${modelString}' does not belong to provider '${provider}'`);
  return model;
}

function validateMapping(provider: ModelConnectorProvider, mapping: ModelTierMappings): ModelTierMappings {
  for (const modelString of Object.values(mapping)) validateModelBelongsToProvider(provider, modelString);
  return mapping;
}

function supportsReasoningMode(model: ModelInfo): boolean {
  return model.provider === "openai" && model.id.startsWith("gpt-5.6");
}

function allowedEfforts(model: ModelInfo): Set<OpenAITierModelConfig["reasoningEffort"]> {
  if (model.thinking.selectableEffort !== true) return new Set();
  if (model.id.includes("gpt-5.6") || model.codexModelId?.includes("gpt-5.6")) return new Set(["none", "low", "medium", "high", "xhigh"]);
  return new Set(["none", "minimal", "low", "medium", "high"]);
}

function defaultOpenAITierConfig(provider: ModelConnectorProvider, tier: keyof OpenAITierMappings, modelString: string): OpenAITierModelConfig {
  const model = validateModelBelongsToProvider(provider, modelString);
  const config: OpenAITierModelConfig = { model: model.id };
  if (model.thinking.selectableEffort === true) {
    config.reasoningEffort = tier === "max" ? (allowedEfforts(model).has("xhigh") ? "xhigh" : "high") : tier === "fast" ? "low" : "medium";
    config.reasoningSummary = tier === "fast" ? "none" : "auto";
    config.verbosity = tier === "fast" ? "low" : "medium";
  }
  if (provider === "openai") {
    if (supportsReasoningMode(model)) config.reasoningMode = "standard";
    config.serviceTier = "auto";
  } else if (provider === "openai-subscription") {
    config.serviceTier = "auto";
  }
  config.maxOutputTokens = Math.min(model.maxOutputTokens, tier === "fast" ? 16000 : tier === "balanced" ? 32000 : 64000);
  return config;
}

function migrateOpenAIConnectorConfig(provider: ModelConnectorProvider, legacy: { tierMappings: ModelTierMappings; migratedFrom?: "model_profiles" | "manual" }): OpenAIConnectorConfig {
  const surface: OpenAIConnectorSurface = provider === "openai-subscription" ? "subscription" : "api";
  return {
    kind: "openai-models",
    version: 2,
    surface,
    tierMappings: {
      max: defaultOpenAITierConfig(provider, "max", legacy.tierMappings.max),
      high: defaultOpenAITierConfig(provider, "high", legacy.tierMappings.high),
      balanced: defaultOpenAITierConfig(provider, "balanced", legacy.tierMappings.balanced),
      fast: defaultOpenAITierConfig(provider, "fast", legacy.tierMappings.fast),
    },
    migratedFrom: legacy.migratedFrom ?? "model_connector_v1",
  };
}

function validateOpenAITierConfig(provider: ModelConnectorProvider, surface: OpenAIConnectorSurface, tier: keyof OpenAITierMappings, config: OpenAITierModelConfig): OpenAITierModelConfig {
  const model = validateModelBelongsToProvider(provider, config.model);
  const normalized: OpenAITierModelConfig = { model: model.id };
  if (config.reasoningEffort !== undefined) {
    const efforts = allowedEfforts(model);
    if (!efforts.has(config.reasoningEffort)) throw new Error(`Model '${config.model}' does not support reasoning effort '${config.reasoningEffort}'`);
    normalized.reasoningEffort = config.reasoningEffort;
  }
  if (config.reasoningMode !== undefined) {
    if (surface !== "api" || !supportsReasoningMode(model)) throw new Error(`Model '${config.model}' does not support reasoning mode`);
    normalized.reasoningMode = config.reasoningMode;
  }
  if (config.reasoningSummary !== undefined) {
    if (model.thinking.selectableEffort !== true) throw new Error(`Model '${config.model}' does not support reasoning summary`);
    normalized.reasoningSummary = config.reasoningSummary;
  }
  if (config.verbosity !== undefined) {
    if (model.thinking.selectableEffort !== true) throw new Error(`Model '${config.model}' does not support verbosity`);
    normalized.verbosity = config.verbosity;
  }
  if (config.serviceTier !== undefined) {
    if (surface === "subscription" && config.serviceTier !== "auto") throw new Error("OpenAI Subscription service tier must be auto");
    normalized.serviceTier = config.serviceTier;
  }
  if (config.maxOutputTokens !== undefined) {
    if (config.maxOutputTokens > model.maxOutputTokens) throw new Error(`maxOutputTokens for '${config.model}' cannot exceed ${model.maxOutputTokens}`);
    normalized.maxOutputTokens = config.maxOutputTokens;
  }
  if (surface === "subscription" && config.reasoningMode === "pro") throw new Error("Reasoning mode pro is API-only");
  return { ...defaultOpenAITierConfig(provider, tier, model.id), ...normalized };
}

function validateOpenAIConnectorConfig(provider: ModelConnectorProvider, config: OpenAIConnectorConfig): OpenAIConnectorConfig {
  if (provider !== "openai" && provider !== "openai-subscription") throw new Error(`Provider '${provider}' does not support OpenAI connector config`);
  const expectedSurface: OpenAIConnectorSurface = provider === "openai-subscription" ? "subscription" : "api";
  if (config.surface !== expectedSurface) throw new Error(`Provider '${provider}' requires surface '${expectedSurface}'`);
  return {
    ...config,
    tierMappings: {
      max: validateOpenAITierConfig(provider, config.surface, "max", config.tierMappings.max),
      high: validateOpenAITierConfig(provider, config.surface, "high", config.tierMappings.high),
      balanced: validateOpenAITierConfig(provider, config.surface, "balanced", config.tierMappings.balanced),
      fast: validateOpenAITierConfig(provider, config.surface, "fast", config.tierMappings.fast),
    },
  };
}

export function parseModelConnectorConfig(provider: string, value: unknown): ModelConnectorConfig {
  const parsedProvider = modelConnectorProviderSchema.parse(provider);
  const parsed = modelConnectorConfigSchema.parse(value);
  if (parsed.kind === "model") {
    const legacy = { ...parsed, tierMappings: validateMapping(parsedProvider, parsed.tierMappings) };
    if (parsedProvider === "openai" || parsedProvider === "openai-subscription") return validateOpenAIConnectorConfig(parsedProvider, migrateOpenAIConnectorConfig(parsedProvider, legacy));
    return legacy;
  }
  return validateOpenAIConnectorConfig(parsedProvider, parsed);
}

export async function listModelConnectors(): Promise<ModelConnector[]> {
  const principal = getCurrentPrincipalOrSystem();
  const rows = await db.select().from(providerConnections).where(
    combineWithVisibleScope(principal, scopeColumns, eq(providerConnections.connectorKind, "model")),
  ).orderBy(asc(providerConnections.sortOrder), asc(providerConnections.id));
  return rows.map((row) => ({
    id: row.id,
    provider: modelConnectorProviderSchema.parse(row.provider),
    label: row.label,
    status: row.status,
    sortOrder: row.sortOrder,
    credentialRef: row.credentialRef,
    lastVerifiedAt: row.lastVerifiedAt instanceof Date ? row.lastVerifiedAt.toISOString() : row.lastVerifiedAt ? String(row.lastVerifiedAt) : null,
    config: parseModelConnectorConfig(row.provider, row.connectorConfig),
  }));
}

export async function updateModelConnector(
  id: number,
  input: { status?: "active" | "inactive"; tierMappings?: ModelTierMappings | OpenAITierMappings },
): Promise<ModelConnector | null> {
  const principal = getCurrentPrincipalOrSystem();
  const [existing] = await db.select().from(providerConnections).where(
    combineWithVisibleScope(principal, scopeColumns, and(
      eq(providerConnections.id, id),
      eq(providerConnections.connectorKind, "model"),
    )),
  ).limit(1);
  if (!existing) return null;

  // Verify the principal can write to this connector
  // The route already enforces system:write permission, but we still need to
  // check that this is not a user-owned connector belonging to someone else
  if (existing.scope === "user" && existing.ownerUserId !== principal.userId) {
    return null; // Not writable by this principal
  }

  const updates: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
  if (input.status !== undefined) updates.status = input.status;
  if (input.tierMappings !== undefined) {
    const provider = modelConnectorProviderSchema.parse(existing.provider);
    const current = parseModelConnectorConfig(existing.provider, existing.connectorConfig);
    if (current.kind === "openai-models") {
      updates.connectorConfig = validateOpenAIConnectorConfig(provider, { ...current, tierMappings: input.tierMappings as OpenAITierMappings });
    } else {
      const tierMappings = validateMapping(provider, input.tierMappings as ModelTierMappings);
      updates.connectorConfig = { ...current, tierMappings };
    }
  }
  await db.update(providerConnections).set(updates).where(
    eq(providerConnections.id, id),
  );
  return (await listModelConnectors()).find((connector) => connector.id === id) ?? null;
}

export async function reorderModelConnectors(ids: number[]): Promise<ModelConnector[]> {
  const principal = getCurrentPrincipalOrSystem();
  const connectors = await listModelConnectors();
  const visibleIds = new Set(connectors.map((connector) => connector.id));
  if (ids.length !== visibleIds.size || new Set(ids).size !== ids.length || ids.some((id) => !visibleIds.has(id))) {
    throw new Error("Connector order must include every visible model connector exactly once");
  }
  await db.transaction(async (tx) => {
    for (const [sortOrder, id] of ids.entries()) {
      await tx.update(providerConnections).set({ sortOrder, updatedAt: sql`CURRENT_TIMESTAMP` }).where(
        and(
          eq(providerConnections.id, id),
          eq(providerConnections.connectorKind, "model"),
        ),
      );
    }
  });
  return listModelConnectors();
}

function splitModel(value: string): { provider: ModelConnectorProvider; modelId: string } | null {
  const slash = value.indexOf("/");
  if (slash < 1) return null;
  const provider = modelConnectorProviderSchema.safeParse(value.slice(0, slash));
  if (!provider.success) return null;
  return { provider: provider.data, modelId: value };
}

export async function migrateLegacyModelProfiles(): Promise<void> {
  const legacy = await getSetting<LegacyProfiles>(LEGACY_PROFILE_KEY);
  if (!legacy?.tiers) return;
  const grouped = new Map<ModelConnectorProvider, Partial<ModelTierMappings>>();
  for (const tier of ["max", "high", "balanced", "fast"] as const) {
    const parsed = splitModel(legacy.tiers[tier]?.model ?? "");
    if (!parsed) continue;
    const current = grouped.get(parsed.provider) ?? {};
    current[tier] = parsed.modelId;
    grouped.set(parsed.provider, current);
  }

  const insertedProviders = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('model-connectors:legacy-migration'))`);
    const existingRows = await tx.select().from(providerConnections)
      .where(eq(providerConnections.connectorKind, "model"));
    const migratedRows: string[] = [];
    for (const row of existingRows) {
      const provider = modelConnectorProviderSchema.safeParse(row.provider);
      if (!provider.success || (provider.data !== "openai" && provider.data !== "openai-subscription")) continue;
      const parsed = modelConnectorConfigSchema.safeParse(row.connectorConfig);
      if (!parsed.success || parsed.data.kind !== "model") continue;
      const tierMappings = validateMapping(provider.data, parsed.data.tierMappings);
      const connectorConfig = migrateOpenAIConnectorConfig(provider.data, { tierMappings, migratedFrom: parsed.data.migratedFrom ?? "model_connector_v1" });
      await tx.update(providerConnections).set({ connectorConfig, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(providerConnections.id, row.id));
      migratedRows.push(provider.data);
    }
    const existingProviders = new Set(existingRows.map((row) => row.provider));
    const nextSortOrder = existingRows.length;
    const connectorValues = Array.from(grouped).flatMap(([provider, partial], offset) => {
      if (existingProviders.has(provider)) return [];
      const fallback = partial.balanced ?? partial.high ?? partial.max ?? partial.fast;
      if (!fallback) return [];
      const tierMappings = validateMapping(provider, modelTierMappingsSchema.parse({
        max: partial.max ?? fallback,
        high: partial.high ?? fallback,
        balanced: partial.balanced ?? fallback,
        fast: partial.fast ?? fallback,
      }));
      return [{
        provider,
        label: provider === "openai-subscription" ? "OpenAI Subscription" : `${provider} Models`,
        accountType: "legacy",
        status: "active",
        connectorKind: "model",
        connectorConfig: provider === "openai" || provider === "openai-subscription"
          ? migrateOpenAIConnectorConfig(provider, { tierMappings, migratedFrom: "model_profiles" as const })
          : { kind: "model" as const, tierMappings, migratedFrom: "model_profiles" as const },
        sortOrder: nextSortOrder + offset,
        scope: "global",
      }];
    });
    if (connectorValues.length > 0) await tx.insert(providerConnections).values(connectorValues);
    return [...migratedRows, ...connectorValues.map((value) => value.provider)];
  });
  if (insertedProviders.length > 0) log.info(`migrated legacy model connectors providers=${insertedProviders.join(",")}`);
}
