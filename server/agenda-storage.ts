import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  agendaDefinitions,
  instantiateAgendaDefinition,
  type AgendaDefinition,
  type AgendaDefinitionCreate,
  type AgendaDefinitionItem,
  type AgendaDefinitionUpdate,
} from "@shared/models/agendas";
import type { SessionAgenda } from "@shared/models/chat";
import type { Principal } from "./principal";
import { db, acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS } from "./db";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { RECAP_FTUE_AGENDA_ITEMS } from "./ftue-session";
import { generateId } from "./file-storage/utils";

const AGENDA_SEARCH_MAX_CHARS = 120;
export const FTUE_AGENDA_RESERVED_KEY = "ftue";
const RECAP_ONLY_FTUE_ITEM_IDS = new Set([
  "review-meeting-notes",
  "capture-meeting-detail-preference",
]);

const agendaScopeColumns = {
  scope: agendaDefinitions.scope,
  ownerUserId: agendaDefinitions.ownerUserId,
  accountId: agendaDefinitions.accountId,
};

function userPrincipal(principal?: Principal): Principal & { actorType: "user"; userId: string; accountId: string } {
  if (principal?.actorType === "user" && principal.userId && principal.accountId) {
    return principal as Principal & { actorType: "user"; userId: string; accountId: string };
  }
  return requireCurrentUserPrincipal();
}

function normalizeName(value: unknown): { name: string; normalizedName: string } {
  if (typeof value !== "string") throw new Error("Agenda name must be a string");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Agenda name is required");
  return { name, normalizedName: name.toLowerCase() };
}

function normalizeDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Agenda description must be a string");
  const description = value.trim();
  if (!description) return undefined;
  return description;
}

function normalizeSearch(value: string | undefined): string | undefined {
  const query = value?.trim();
  if (!query) return undefined;
  if (query.length > AGENDA_SEARCH_MAX_CHARS) {
    throw new Error(`Agenda search must be ${AGENDA_SEARCH_MAX_CHARS} characters or fewer`);
  }
  return query;
}

function literalSubstringPattern(value: string): string {
  return `%${value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
}

function normalizeDefinitionItems(value: unknown): AgendaDefinitionItem[] {
  if (!Array.isArray(value)) throw new Error("Agenda items must be an array");
  const existingIds = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Agenda items must be objects");
    const candidate = item as { id?: unknown; title?: unknown; description?: unknown };
    const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : generateId();
    if (existingIds.has(id)) throw new Error(`Duplicate agenda item id: ${id}`);
    existingIds.add(id);
    if (typeof candidate.title !== "string" || !candidate.title.trim()) throw new Error("Agenda item title is required");
    if (typeof candidate.description !== "string" || !candidate.description.trim()) throw new Error("Agenda item description is required");
    return {
      id,
      title: candidate.title.trim().replace(/\s+/g, " "),
      description: candidate.description.trim().replace(/\s+/g, " "),
    };
  });
}

/**
 * Boot-validated canonical FTUE fixture. Normalizing at module load makes an
 * over-limit or malformed fixture fail deploy loudly at server boot instead of
 * failing a user's first onboarding at runtime.
 */
const FTUE_DEFINITION_ITEMS: AgendaDefinitionItem[] = normalizeDefinitionItems(RECAP_FTUE_AGENDA_ITEMS);

function mapDefinition(row: typeof agendaDefinitions.$inferSelect): AgendaDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    items: row.items,
    reservedKey: row.reservedKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function uniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505");
}

export class AgendaDefinitionStorage {
  private mutationLockKey(principal: Principal & { userId: string; accountId: string }): string {
    return `${principal.userId}:${principal.accountId}`;
  }

  async list(query?: string, limit = 100, principal?: Principal): Promise<AgendaDefinition[]> {
    const current = userPrincipal(principal);
    const boundedLimit = Math.min(Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 100), 100);
    const needle = normalizeSearch(query);
    const pattern = needle ? literalSubstringPattern(needle) : undefined;
    const search = pattern
      ? sql`(
          ${agendaDefinitions.name} ILIKE ${pattern} ESCAPE '!'
          OR coalesce(${agendaDefinitions.description}, '') ILIKE ${pattern} ESCAPE '!'
          OR ${agendaDefinitions.items}::text ILIKE ${pattern} ESCAPE '!'
        )`
      : undefined;
    const rows = await db
      .select()
      .from(agendaDefinitions)
      .where(combineWithVisibleScope(current, agendaScopeColumns, search))
      .orderBy(desc(agendaDefinitions.updatedAt), asc(agendaDefinitions.name))
      .limit(boundedLimit);
    return rows.map(mapDefinition);
  }

  async get(id: string, principal?: Principal): Promise<AgendaDefinition | null> {
    const current = userPrincipal(principal);
    const [row] = await db
      .select()
      .from(agendaDefinitions)
      .where(combineWithVisibleScope(current, agendaScopeColumns, eq(agendaDefinitions.id, id)))
      .limit(1);
    return row ? mapDefinition(row) : null;
  }

  async create(input: AgendaDefinitionCreate, principal?: Principal): Promise<AgendaDefinition> {
    const current = userPrincipal(principal);
    const { name, normalizedName } = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const items = normalizeDefinitionItems(input.items);
    try {
      return await db.transaction(async (tx) => {
        await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.AGENDA_DEFINITION, this.mutationLockKey(current));
        const [created] = await tx
          .insert(agendaDefinitions)
          .values({
            name,
            normalizedName,
            description,
            items,
            createdByUserId: current.userId,
            ...ownedInsertValues(current, agendaScopeColumns),
          })
          .returning();
        return mapDefinition(created);
      });
    } catch (error) {
      if (uniqueConflict(error)) throw new Error(`An agenda named "${name}" already exists`);
      throw error;
    }
  }

  async update(id: string, input: AgendaDefinitionUpdate, principal?: Principal): Promise<AgendaDefinition | null> {
    const current = userPrincipal(principal);
    const patch: Partial<typeof agendaDefinitions.$inferInsert> = { updatedAt: new Date() };
    if (typeof input.name === "string" && input.name.trim()) Object.assign(patch, normalizeName(input.name));
    const description = normalizeDescription(input.description);
    if (description !== undefined) patch.description = description;
    if (Array.isArray(input.items) && input.items.length > 0) patch.items = normalizeDefinitionItems(input.items);
    if (input.clearFields?.includes("description")) patch.description = null;
    if (Object.keys(patch).length === 1) throw new Error("Agenda update requires at least one field");

    try {
      return await db.transaction(async (tx) => {
        await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.AGENDA_DEFINITION, this.mutationLockKey(current));
        const [updated] = await tx
          .update(agendaDefinitions)
          .set(patch)
          .where(combineWithWritableScope(current, agendaScopeColumns, eq(agendaDefinitions.id, id)))
          .returning();
        return updated ? mapDefinition(updated) : null;
      });
    } catch (error) {
      if (uniqueConflict(error)) throw new Error("Another agenda already uses that name");
      throw error;
    }
  }

  async delete(id: string, principal?: Principal): Promise<boolean> {
    const current = userPrincipal(principal);
    return db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.AGENDA_DEFINITION, this.mutationLockKey(current));
      const [existing] = await tx
        .select({ reservedKey: agendaDefinitions.reservedKey })
        .from(agendaDefinitions)
        .where(combineWithWritableScope(current, agendaScopeColumns, eq(agendaDefinitions.id, id)))
        .limit(1);
      if (!existing) return false;
      if (existing.reservedKey === FTUE_AGENDA_RESERVED_KEY) {
        throw new Error("The FTUE agenda is required by onboarding and cannot be deleted");
      }
      const deleted = await tx
        .delete(agendaDefinitions)
        .where(combineWithWritableScope(current, agendaScopeColumns, eq(agendaDefinitions.id, id)))
        .returning({ id: agendaDefinitions.id });
      return deleted.length > 0;
    });
  }

  async ensureFtue(principal?: Principal): Promise<AgendaDefinition> {
    const current = userPrincipal(principal);
    return db.transaction(async (tx) => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.AGENDA_DEFINITION, this.mutationLockKey(current));
      const ownerPredicate = and(
        eq(agendaDefinitions.scope, "user"),
        eq(agendaDefinitions.ownerUserId, current.userId),
        eq(agendaDefinitions.accountId, current.accountId),
      );
      const [reserved] = await tx
        .select()
        .from(agendaDefinitions)
        .where(and(ownerPredicate, eq(agendaDefinitions.reservedKey, FTUE_AGENDA_RESERVED_KEY)))
        .limit(1);
      if (reserved) return mapDefinition(reserved);

      const { name, normalizedName } = normalizeName("FTUE");
      const [adoptable] = await tx
        .select()
        .from(agendaDefinitions)
        .where(and(ownerPredicate, eq(agendaDefinitions.normalizedName, normalizedName)))
        .limit(1);
      if (adoptable) {
        const [adopted] = await tx
          .update(agendaDefinitions)
          .set({ reservedKey: FTUE_AGENDA_RESERVED_KEY, updatedAt: sql`CURRENT_TIMESTAMP` })
          .where(and(ownerPredicate, eq(agendaDefinitions.id, adoptable.id)))
          .returning();
        return mapDefinition(adopted);
      }

      const items = FTUE_DEFINITION_ITEMS;
      const [created] = await tx
        .insert(agendaDefinitions)
        .values({
          name,
          normalizedName,
          description: "The canonical first collaboration agenda for recap onboarding.",
          items,
          reservedKey: FTUE_AGENDA_RESERVED_KEY,
          scope: "user",
          ownerUserId: current.userId,
          accountId: current.accountId,
          createdByUserId: current.userId,
        })
        .returning();
      return mapDefinition(created);
    });
  }

  async instantiateFtue(
    principal?: Principal,
    options?: { recapAware?: boolean },
  ): Promise<SessionAgenda> {
    const definition = await this.ensureFtue(principal);
    if (options?.recapAware) return instantiateAgendaDefinition(definition);
    return instantiateAgendaDefinition({
      items: definition.items.filter((item) => !RECAP_ONLY_FTUE_ITEM_IDS.has(item.id)),
    });
  }
}

export const agendaDefinitionStorage = new AgendaDefinitionStorage();
