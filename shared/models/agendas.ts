import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import type { SessionAgenda } from "./chat";

export interface AgendaDefinitionItem {
  id: string;
  title: string;
  description: string;
}

export interface AgendaDefinitionItemInput {
  id?: string;
  title: string;
  description: string;
}

export const agendaDefinitions = pgTable("agenda_definitions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  description: text("description"),
  items: jsonb("items").$type<AgendaDefinitionItem[]>().notNull().default(sql`'[]'::jsonb`),
  reservedKey: varchar("reserved_key", { length: 64 }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("agenda_definitions_owner_name_key").on(table.ownerUserId, table.accountId, table.normalizedName),
  uniqueIndex("agenda_definitions_owner_reserved_key")
    .on(table.ownerUserId, table.accountId, table.reservedKey)
    .where(sql`${table.reservedKey} IS NOT NULL`),
  index("idx_agenda_definitions_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_agenda_definitions_account_updated").on(table.accountId, table.updatedAt),
]);

export interface AgendaDefinition {
  id: string;
  name: string;
  description: string | null;
  items: AgendaDefinitionItem[];
  reservedKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgendaDefinitionCreate {
  name: string;
  description?: string;
  items: AgendaDefinitionItemInput[];
}

export interface AgendaDefinitionUpdate {
  name?: string;
  description?: string;
  items?: AgendaDefinitionItemInput[];
  clearFields?: Array<"description">;
}

export function instantiateAgendaDefinition(definition: Pick<AgendaDefinition, "items">): SessionAgenda {
  return {
    items: definition.items.map((item) => ({ ...item, status: "open" as const })),
  };
}
