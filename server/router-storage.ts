/**
 * Router catalog — named exclusive pools of model connectors.
 * System-scoped infrastructure. Mutation requires system:write at the route boundary.
 * Encode exclusivity via provider_connections.router_id FK; exactly one Default via partial unique index.
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { accounts, providerConnections, routers, type Router } from "@shared/schema";
import {
  modelConnectorProviderSchema,
  type ModelConnectorProvider,
} from "@shared/model-connectors";
import { parseModelConnectorConfig, type ModelConnector } from "./model-connectors";

const log = createLogger("RouterStorage");

export interface RouterSummary {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RouterDetail extends RouterSummary {
  connectors: ModelConnector[];
}

function toSummary(row: Router): RouterSummary {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault === true,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

function mapConnector(row: typeof providerConnections.$inferSelect): ModelConnector {
  return {
    id: row.id,
    provider: modelConnectorProviderSchema.parse(row.provider),
    label: row.label,
    status: row.status,
    sortOrder: row.sortOrder,
    priorityPinned: row.priorityPinned === true,
    credentialRef: row.credentialRef,
    lastVerifiedAt: row.lastVerifiedAt instanceof Date
      ? row.lastVerifiedAt.toISOString()
      : row.lastVerifiedAt
        ? String(row.lastVerifiedAt)
        : null,
    config: parseModelConnectorConfig(row.provider, row.connectorConfig),
    routerId: row.routerId ?? null,
  };
}

/** Boot-safe: ensure exactly one Default router named Default. */
export async function ensureDefaultRouter(): Promise<RouterSummary> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('routers:ensure-default'))`);
    const [existing] = await tx
      .select()
      .from(routers)
      .where(eq(routers.isDefault, true))
      .limit(1);
    if (existing) return toSummary(existing);

    const [created] = await tx
      .insert(routers)
      .values({ name: "Default", isDefault: true })
      .onConflictDoNothing()
      .returning();
    if (created) {
      log.info("seeded Default router", { routerId: created.id });
      return toSummary(created);
    }

    const [retry] = await tx
      .select()
      .from(routers)
      .where(eq(routers.isDefault, true))
      .limit(1);
    if (!retry) throw new Error("Failed to ensure Default router");
    return toSummary(retry);
  });
}

export async function listRouters(): Promise<RouterSummary[]> {
  const rows = await db
    .select()
    .from(routers)
    .orderBy(desc(routers.isDefault), asc(routers.name), asc(routers.id));
  return rows.map(toSummary);
}

export async function getRouter(id: string): Promise<RouterDetail | null> {
  const [row] = await db.select().from(routers).where(eq(routers.id, id)).limit(1);
  if (!row) return null;
  const connectorRows = await db
    .select()
    .from(providerConnections)
    .where(and(
      eq(providerConnections.connectorKind, "model"),
      eq(providerConnections.routerId, id),
    ))
    .orderBy(
      desc(providerConnections.priorityPinned),
      asc(providerConnections.sortOrder),
      asc(providerConnections.id),
    );
  return {
    ...toSummary(row),
    connectors: connectorRows.map(mapConnector),
  };
}

export async function getRouterById(id: string): Promise<RouterSummary | null> {
  const [row] = await db.select().from(routers).where(eq(routers.id, id)).limit(1);
  return row ? toSummary(row) : null;
}

export async function getDefaultRouter(): Promise<RouterSummary | null> {
  const [row] = await db.select().from(routers).where(eq(routers.isDefault, true)).limit(1);
  return row ? toSummary(row) : null;
}

export async function createRouter(name: string): Promise<RouterSummary> {
  const trimmed = name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!trimmed) throw new Error("Router name is required");
  try {
    const [created] = await db
      .insert(routers)
      .values({ name: trimmed, isDefault: false })
      .returning();
    if (!created) throw new Error("Failed to create router");
    log.info("created router", { routerId: created.id, name: created.name });
    return toSummary(created);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("idx_routers_name_unique") || message.includes("unique")) {
      throw new Error(`Router name '${trimmed}' is already taken`);
    }
    throw err;
  }
}

export async function renameRouter(id: string, name: string): Promise<RouterSummary> {
  const trimmed = name.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!trimmed) throw new Error("Router name is required");
  try {
    const [updated] = await db
      .update(routers)
      .set({ name: trimmed, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(routers.id, id))
      .returning();
    if (!updated) throw new Error("Router not found");
    return toSummary(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("idx_routers_name_unique") || message.includes("unique")) {
      throw new Error(`Router name '${trimmed}' is already taken`);
    }
    throw err;
  }
}

export async function setDefaultRouter(id: string): Promise<RouterSummary> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('routers:set-default'))`);
    const [target] = await tx.select().from(routers).where(eq(routers.id, id)).limit(1);
    if (!target) throw new Error("Router not found");
    await tx
      .update(routers)
      .set({ isDefault: false, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(routers.isDefault, true));
    const [updated] = await tx
      .update(routers)
      .set({ isDefault: true, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(routers.id, id))
      .returning();
    if (!updated) throw new Error("Router not found");
    log.info("set default router", { routerId: updated.id, name: updated.name });
    return toSummary(updated);
  });
}

export async function deleteRouter(id: string): Promise<void> {
  const [row] = await db.select().from(routers).where(eq(routers.id, id)).limit(1);
  if (!row) throw new Error("Router not found");
  if (row.isDefault) throw new Error("Cannot delete the Default router");

  const [accountRef] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.routerId, id))
    .limit(1);
  if (accountRef) {
    throw new Error("Reassign Accounts pointing at this Router before deleting it");
  }

  const [connectorRef] = await db
    .select({ id: providerConnections.id })
    .from(providerConnections)
    .where(and(
      eq(providerConnections.connectorKind, "model"),
      eq(providerConnections.routerId, id),
    ))
    .limit(1);
  if (connectorRef) {
    throw new Error("Move or retire connectors on this Router before deleting it");
  }

  await db.delete(routers).where(eq(routers.id, id));
  log.info("deleted router", { routerId: id, name: row.name });
}

/** List model connectors for one Router (exclusive pool). */
export async function listRouterConnectors(routerId: string): Promise<ModelConnector[]> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(and(
      eq(providerConnections.connectorKind, "model"),
      eq(providerConnections.routerId, routerId),
    ))
    .orderBy(
      desc(providerConnections.priorityPinned),
      asc(providerConnections.sortOrder),
      asc(providerConnections.id),
    );
  return rows.map(mapConnector);
}

/** Legacy global chain: model connectors with NULL router_id. */
export async function listLegacyModelConnectors(): Promise<ModelConnector[]> {
  const rows = await db
    .select()
    .from(providerConnections)
    .where(and(
      eq(providerConnections.connectorKind, "model"),
      isNull(providerConnections.routerId),
    ))
    .orderBy(
      desc(providerConnections.priorityPinned),
      asc(providerConnections.sortOrder),
      asc(providerConnections.id),
    );
  return rows.map(mapConnector);
}

// Model IDs must belong to the connector's provider in model-registry.
// API providers use bare API ids; subscription/cli providers use their *-sub registry ids.
const DEFAULT_TIER_MODELS: Record<ModelConnectorProvider, { max: string; high: string; balanced: string; fast: string }> = {
  anthropic: {
    max: "claude-opus-4-6",
    high: "claude-sonnet-4-6",
    balanced: "claude-sonnet-4-6",
    fast: "claude-haiku-4-5-20251001",
  },
  openai: {
    max: "gpt-5.4",
    high: "gpt-5.4",
    balanced: "gpt-5.4-mini",
    fast: "gpt-5.4-mini",
  },
  "openai-subscription": {
    max: "gpt-5.4-sub",
    high: "gpt-5.4-sub",
    balanced: "gpt-5.4-mini-sub",
    fast: "gpt-5.4-mini-sub",
  },
  "claude-cli": {
    max: "claude-opus-4-6-sub",
    high: "claude-sonnet-sub",
    balanced: "claude-sonnet-sub",
    fast: "claude-haiku-sub",
  },
  "grok-subscription": {
    max: "grok-4.6",
    high: "grok-4.6",
    balanced: "grok-4.3",
    fast: "grok-4.3",
  },
};

const CONNECTOR_KIND_LABELS: Record<string, { provider: ModelConnectorProvider; label: string }> = {
  "claude-cli": { provider: "claude-cli", label: "Claude CLI" },
  "openai-subscription": { provider: "openai-subscription", label: "ChatGPT Subscription" },
  openai: { provider: "openai", label: "OpenAI API" },
  anthropic: { provider: "anthropic", label: "Claude API" },
  "grok-subscription": { provider: "grok-subscription", label: "Grok Subscription" },
  "grok-api": { provider: "grok-subscription", label: "Grok API" },
};

function defaultConnectorConfig(provider: ModelConnectorProvider): unknown {
  const tiers = DEFAULT_TIER_MODELS[provider];
  if (provider === "openai" || provider === "openai-subscription") {
    return {
      kind: "openai-models",
      version: 2,
      surface: provider === "openai-subscription" ? "subscription" : "api",
      tierMappings: {
        max: { model: tiers.max },
        high: { model: tiers.high },
        balanced: { model: tiers.balanced },
        fast: { model: tiers.fast },
      },
      migratedFrom: "manual",
    };
  }
  if (provider === "claude-cli") {
    return {
      kind: "claude-cli-models",
      version: 1,
      tierMappings: {
        max: { model: tiers.max },
        high: { model: tiers.high },
        balanced: { model: tiers.balanced },
        fast: { model: tiers.fast },
      },
      migratedFrom: "manual",
    };
  }
  if (provider === "grok-subscription") {
    return {
      kind: "grok-models",
      version: 1,
      tierMappings: {
        max: `grok-subscription/${tiers.max}`,
        high: `grok-subscription/${tiers.high}`,
        balanced: `grok-subscription/${tiers.balanced}`,
        fast: `grok-subscription/${tiers.fast}`,
      },
      migratedFrom: "manual",
    };
  }
  return {
    kind: "model",
    tierMappings: tiers,
    migratedFrom: "manual",
  };
}

export async function addConnectorToRouter(
  routerId: string,
  kind: string,
): Promise<ModelConnector> {
  const meta = CONNECTOR_KIND_LABELS[kind];
  if (!meta) throw new Error(`Unknown connector kind '${kind}'`);

  const [router] = await db.select({ id: routers.id }).from(routers).where(eq(routers.id, routerId)).limit(1);
  if (!router) throw new Error("Router not found");

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`router-members:${routerId}`}))`);
    const existing = await tx
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(and(
        eq(providerConnections.connectorKind, "model"),
        eq(providerConnections.routerId, routerId),
      ));
    const [created] = await tx
      .insert(providerConnections)
      .values({
        provider: meta.provider,
        label: meta.label,
        accountType: meta.provider.includes("subscription") || meta.provider === "claude-cli" ? "subscription" : "api",
        status: "active",
        connectorKind: "model",
        connectorConfig: defaultConnectorConfig(meta.provider),
        sortOrder: existing.length,
        priorityPinned: false,
        routerId,
        scope: "global",
      })
      .returning();
    if (!created) throw new Error("Failed to create connector");
    log.info("added connector to router", { routerId, connectorId: created.id, provider: meta.provider });
    return mapConnector(created);
  });
}

export async function removeConnectorFromRouter(
  routerId: string,
  connectorId: number,
): Promise<void> {
  const [row] = await db
    .select()
    .from(providerConnections)
    .where(and(
      eq(providerConnections.id, connectorId),
      eq(providerConnections.connectorKind, "model"),
      eq(providerConnections.routerId, routerId),
    ))
    .limit(1);
  if (!row) throw new Error("Connector not found on this Router");
  await db.delete(providerConnections).where(eq(providerConnections.id, connectorId));
  log.info("removed connector from router", { routerId, connectorId });
}

/**
 * Reparent an existing model connector onto a Router (or back to legacy NULL).
 * Preserves credentials, config, and status. Destination membership is exclusive.
 * Appends unpinned at the end of the destination pool. Idempotent when already there.
 */
export async function moveConnectorToRouter(
  connectorId: number,
  routerId: string | null,
): Promise<ModelConnector> {
  if (!Number.isFinite(connectorId) || connectorId <= 0) {
    throw new Error("Invalid connector id");
  }

  if (routerId) {
    const router = await getRouterById(routerId);
    if (!router) throw new Error("Router not found");
  }

  return db.transaction(async (tx) => {
    // Peek source membership so both pool locks can be taken in sorted order first.
    const [peek] = await tx
      .select({
        id: providerConnections.id,
        connectorKind: providerConnections.connectorKind,
        routerId: providerConnections.routerId,
      })
      .from(providerConnections)
      .where(eq(providerConnections.id, connectorId))
      .limit(1);
    if (!peek) throw new Error("Connector not found");
    if (peek.connectorKind !== "model") {
      throw new Error("Only model connectors can join a Router");
    }

    const fromRouterId = peek.routerId ?? null;
    if (fromRouterId === routerId) {
      const [same] = await tx
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, connectorId))
        .limit(1);
      if (!same) throw new Error("Connector not found");
      return mapConnector(same);
    }

    const lockKeys = [
      fromRouterId ? `router-members:${fromRouterId}` : "router-members:legacy",
      routerId ? `router-members:${routerId}` : "router-members:legacy",
    ].sort();
    for (const key of new Set(lockKeys)) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    }

    const [existing] = await tx
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, connectorId))
      .limit(1);
    if (!existing) throw new Error("Connector not found");
    if (existing.connectorKind !== "model") {
      throw new Error("Only model connectors can join a Router");
    }
    const currentRouterId = existing.routerId ?? null;
    if (currentRouterId !== fromRouterId) {
      throw new Error("Connector membership changed during move; retry");
    }
    if (currentRouterId === routerId) {
      return mapConnector(existing);
    }

    const destinationFilter = routerId
      ? and(
          eq(providerConnections.connectorKind, "model"),
          eq(providerConnections.routerId, routerId),
        )
      : and(
          eq(providerConnections.connectorKind, "model"),
          isNull(providerConnections.routerId),
        );

    const peers = await tx
      .select({
        id: providerConnections.id,
        sortOrder: providerConnections.sortOrder,
      })
      .from(providerConnections)
      .where(destinationFilter);

    const nextSortOrder = peers.reduce(
      (max, row) => Math.max(max, row.sortOrder ?? 0),
      -1,
    ) + 1;

    const [updated] = await tx
      .update(providerConnections)
      .set({
        routerId,
        priorityPinned: false,
        sortOrder: nextSortOrder,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(and(
        eq(providerConnections.id, connectorId),
        eq(providerConnections.connectorKind, "model"),
      ))
      .returning();
    if (!updated) throw new Error("Connector not found");

    log.info("moved connector to router", {
      connectorId,
      fromRouterId: currentRouterId,
      toRouterId: routerId,
      sortOrder: nextSortOrder,
    });
    return mapConnector(updated);
  });
}

/**
 * Reorder connectors inside one Router. Pin cohort boundary preserved.
 * ids must be the complete ordered set of that Router's model connectors.
 */
export async function reorderRouterConnectors(
  routerId: string,
  ids: number[],
): Promise<ModelConnector[]> {
  const connectors = await listRouterConnectors(routerId);
  const byId = new Map(connectors.map((c) => [c.id, c]));
  const visibleIds = new Set(connectors.map((c) => c.id));
  if (ids.length !== visibleIds.size || new Set(ids).size !== ids.length || ids.some((id) => !visibleIds.has(id))) {
    throw new Error("Connector order must include every connector on this Router exactly once");
  }
  const requestedPinned = ids.map((id) => byId.get(id)!.priorityPinned === true);
  const currentPinned = connectors.map((c) => c.priorityPinned === true);
  if (requestedPinned.some((pinned, index) => pinned !== currentPinned[index])) {
    throw new Error("Connector reorder cannot move connectors across the pin boundary");
  }
  await db.transaction(async (tx) => {
    for (const [sortOrder, id] of ids.entries()) {
      await tx
        .update(providerConnections)
        .set({ sortOrder, updatedAt: sql`CURRENT_TIMESTAMP` })
        .where(and(
          eq(providerConnections.id, id),
          eq(providerConnections.connectorKind, "model"),
          eq(providerConnections.routerId, routerId),
        ));
    }
  });
  return listRouterConnectors(routerId);
}

export async function setAccountRouter(
  accountId: string,
  routerId: string | null,
): Promise<{ accountId: string; routerId: string | null; router: RouterSummary | null }> {
  if (routerId) {
    const router = await getRouterById(routerId);
    if (!router) throw new Error("Router not found");
  }
  const [updated] = await db
    .update(accounts)
    .set({ routerId, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(accounts.id, accountId))
    .returning({ id: accounts.id, routerId: accounts.routerId });
  if (!updated) throw new Error("Account not found");
  const router = updated.routerId ? await getRouterById(updated.routerId) : null;
  log.info("set account router", { accountId, routerId: updated.routerId });
  return { accountId: updated.id, routerId: updated.routerId ?? null, router };
}

export async function getAccountRouterId(accountId: string | null | undefined): Promise<string | null> {
  if (!accountId) return null;
  const [row] = await db
    .select({ routerId: accounts.routerId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.routerId ?? null;
}
