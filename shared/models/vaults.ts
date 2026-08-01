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
 * Canonical vault identity palette.
 *
 * Vault colors are persisted values because they identify user-defined data
 * partitions across surfaces. Keep every picker and default sourced here.
 * The family shares the Mantra brand's luminous saturation and is tuned for
 * the product's black canvas without becoming neon.
 */
export const VAULT_COLOR_PALETTE = [
  { value: "#FFFFFF", label: "White" },
  { value: "#21A6E8", label: "Sky" },
  { value: "#35C9BD", label: "Aqua" },
  { value: "#4FD17B", label: "Mint" },
  { value: "#A8D957", label: "Lime" },
  { value: "#F2B84B", label: "Gold" },
  { value: "#F07A68", label: "Coral" },
  { value: "#E46C9F", label: "Rose" },
  { value: "#9A78EB", label: "Violet" },
] as const;

/** Persisted Vault colors use one browser-compatible six-digit hex contract. */
export const VAULT_COLOR_PATTERN = /^#[0-9A-F]{6}$/i;

export function normalizeVaultColor(color: string): string {
  return color.toUpperCase();
}

/** Generic user-created vaults start on the brand blue. */
export const DEFAULT_VAULT_COLOR = VAULT_COLOR_PALETTE[1].value;

/** Personal is the neutral identity partition, represented by full white. */
export const PERSONAL_VAULT_COLOR = VAULT_COLOR_PALETTE[0].value;

/** Known product defaults from the retired muted palette. Custom colors are untouched. */
export const LEGACY_VAULT_COLOR_MIGRATIONS = [
  { from: "#828A96", to: VAULT_COLOR_PALETTE[0].value },
  { from: "#6BA3B5", to: VAULT_COLOR_PALETTE[1].value },
  { from: "#6E8B74", to: VAULT_COLOR_PALETTE[2].value },
  { from: "#9B9B6F", to: VAULT_COLOR_PALETTE[3].value },
  { from: "#C4956A", to: VAULT_COLOR_PALETTE[4].value },
  { from: "#C27878", to: VAULT_COLOR_PALETTE[5].value },
  { from: "#B07BAC", to: VAULT_COLOR_PALETTE[6].value },
  { from: "#7B8CDE", to: VAULT_COLOR_PALETTE[7].value },
] as const;

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

export const vaultR2MigrationStates = pgTable("vault_r2_migration_states", {
  id: text("id").primaryKey().default("legacy-private-to-personal"),
  status: text("status").notNull().default("idle"),
  adminUserId: text("admin_user_id"),
  accountId: text("account_id"),
  destinationVaultId: text("destination_vault_id"),
  analysisFingerprint: text("analysis_fingerprint"),
  scannedCount: integer("scanned_count").notNull().default(0),
  eligibleCount: integer("eligible_count").notNull().default(0),
  excludedCount: integer("excluded_count").notNull().default(0),
  oversizedCount: integer("oversized_count").notNull().default(0),
  verifiedCount: integer("verified_count").notNull().default(0),
  copiedCount: integer("copied_count").notNull().default(0),
  existingCount: integer("existing_count").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  unresolvedCount: integer("unresolved_count").notNull().default(0),
  lastProcessedKey: text("last_processed_key"),
  lastError: text("last_error"),
  analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export type VaultR2MigrationStatus =
  | "idle"
  | "analyzing"
  | "ready"
  | "running"
  | "completed"
  | "failed";
export type VaultR2MigrationState = typeof vaultR2MigrationStates.$inferSelect;

export type Vault = typeof vaults.$inferSelect;
export type InsertVault = typeof vaults.$inferInsert;
