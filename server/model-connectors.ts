import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope } from "./scoped-storage";
import { getSetting } from "./system-settings";
import { providerConnections } from "@shared/models/platforms";
import {
  modelConnectorConfigSchema,
  modelConnectorProviderSchema,
  modelTierMappingsSchema,
  type ModelConnectorConfig,
  type ModelConnectorProvider,
  type ModelTierMappings,
} from "@shared/model-connectors";
import { getModel } from "./model-registry";

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

function validateMapping(provider: ModelConnectorProvider, mapping: ModelTierMappings): ModelTierMappings {
  for (const modelId of Object.values(mapping)) {
    const model = getModel(modelId);
    if (!model) throw new Error(`Unknown model '${modelId}'`);
    if (model.provider !== provider) throw new Error(`Model '${modelId}' does not belong to provider '${provider}'`);
  }
  return mapping;
}

export function parseModelConnectorConfig(provider: string, value: unknown): ModelConnectorConfig {
  const parsedProvider = modelConnectorProviderSchema.parse(provider);
  const config = modelConnectorConfigSchema.parse(value);
  return { ...config, tierMappings: validateMapping(parsedProvider, config.tierMappings) };
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
  input: { status?: "active" | "inactive"; tierMappings?: ModelTierMappings },
): Promise<ModelConnector | null> {
  const principal = getCurrentPrincipalOrSystem();
  const [existing] = await db.select().from(providerConnections).where(
    combineWithWritableScope(principal, scopeColumns, and(
      eq(providerConnections.id, id),
      eq(providerConnections.connectorKind, "model"),
    )),
  ).limit(1);
  if (!existing) return null;

  const updates: Record<string, unknown> = { updatedAt: sql`CURRENT_TIMESTAMP` };
  if (input.status !== undefined) updates.status = input.status;
  if (input.tierMappings !== undefined) {
    const tierMappings = validateMapping(modelConnectorProviderSchema.parse(existing.provider), input.tierMappings);
    updates.connectorConfig = { ...parseModelConnectorConfig(existing.provider, existing.connectorConfig), tierMappings };
  }
  await db.update(providerConnections).set(updates).where(
    combineWithWritableScope(principal, scopeColumns, eq(providerConnections.id, id)),
  );
  return (await listModelConnectors()).find((connector) => connector.id === id) ?? null;
}

export async function reorderModelConnectors(ids: number[]): Promise<ModelConnector[]> {
  const principal = getCurrentPrincipalOrSystem();
  const connectors = await listModelConnectors();
  const visibleIds = new Set(connectors.map((connector) => connector.id));
  if (ids.length !== visibleIds.size || ids.some((id) => !visibleIds.has(id))) {
    throw new Error("Connector order must include every visible model connector exactly once");
  }
  await db.transaction(async (tx) => {
    for (const [sortOrder, id] of ids.entries()) {
      await tx.update(providerConnections).set({ sortOrder, updatedAt: sql`CURRENT_TIMESTAMP` }).where(
        combineWithWritableScope(principal, scopeColumns, and(
          eq(providerConnections.id, id),
          eq(providerConnections.connectorKind, "model"),
        )),
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
  const existing = await db.select({ id: providerConnections.id }).from(providerConnections)
    .where(eq(providerConnections.connectorKind, "model")).limit(1);
  if (existing.length > 0) return;

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

  let sortOrder = 0;
  for (const [provider, partial] of grouped) {
    const fallback = partial.balanced ?? partial.high ?? partial.max ?? partial.fast;
    if (!fallback) continue;
    const mappings = modelTierMappingsSchema.parse({
      max: partial.max ?? fallback,
      high: partial.high ?? fallback,
      balanced: partial.balanced ?? fallback,
      fast: partial.fast ?? fallback,
    });
    validateMapping(provider, mappings);
    await db.insert(providerConnections).values({
      provider,
      label: `${provider} Models`,
      accountType: "legacy",
      status: "active",
      connectorKind: "model",
      connectorConfig: { kind: "model", tierMappings: mappings, migratedFrom: "model_profiles" },
      sortOrder: sortOrder++,
      scope: "global",
    });
  }
  if (grouped.size > 0) log.log(`migrated legacy model profiles connectors=${grouped.size}`);
}
