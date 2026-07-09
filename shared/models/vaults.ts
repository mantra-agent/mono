import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Vaults — data partitions within a user's account.
 *
 * Every user-owned row carries a vault_id. The scoped-storage boundary
 * filters reads by the principal's visibleVaultIds and stamps writes
 * with the activeVaultId (or session's pinned vault).
 *
 * See: Vault Implementation Spec v2 — Mono (B.2)
 */
export const vaults = pgTable(
  "vaults",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    icon: text("icon"),
    color: text("color"),
    purpose: text("purpose"),
    position: integer("position").notNull().default(0),
    policy: jsonb("policy").notNull().default(sql`'{}'::jsonb`),
    isDefault: boolean("is_default").notNull().default(false),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_vaults_account").on(table.accountId),
    uniqueIndex("idx_vaults_account_name_unique").on(
      table.accountId,
      table.name,
    ),
  ],
);

export type Vault = typeof vaults.$inferSelect;
export type InsertVault = typeof vaults.$inferInsert;
