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
 * The family uses light, chromatic tints so Vault identity stays legible on
 * the product's black canvas without competing with content or CTA color.
 */
export const VAULT_COLOR_PALETTE = [
  { value: "#FFFFFF", label: "White" },
  { value: "#BFEAFF", label: "Sky" },
  { value: "#BFFFFA", label: "Aqua" },
  { value: "#BFFFD4", label: "Mint" },
  { value: "#EAFFBF", label: "Lime" },
  { value: "#FFEABF", label: "Gold" },
  { value: "#FFC7BF", label: "Coral" },
  { value: "#FFBFDA", label: "Rose" },
  { value: "#D5BFFF", label: "Violet" },
] as const;

/** Persisted Vault colors use one browser-compatible six-digit hex contract. */
export const VAULT_COLOR_PATTERN = /^#[0-9A-F]{6}$/i;

export function normalizeVaultColor(color: string): string {
  return color.toUpperCase();
}

/** Generic user-created vaults start on the light Sky tint. */
export const DEFAULT_VAULT_COLOR = VAULT_COLOR_PALETTE[1].value;

/** Personal is the neutral identity partition, represented by full white. */
export const PERSONAL_VAULT_COLOR = VAULT_COLOR_PALETTE[0].value;

/** Known retired product presets. Arbitrary custom colors are untouched. */
export const LEGACY_VAULT_COLOR_MIGRATIONS = [
  // The Personal migration reads this first entry as its retired neutral color.
  { from: "#828A96", to: VAULT_COLOR_PALETTE[0].value },
  { from: "#D9F2FF", to: VAULT_COLOR_PALETTE[1].value },
  { from: "#D9FFFC", to: VAULT_COLOR_PALETTE[2].value },
  { from: "#D9FFE6", to: VAULT_COLOR_PALETTE[3].value },
  { from: "#F2FFD9", to: VAULT_COLOR_PALETTE[4].value },
  { from: "#FFF2D9", to: VAULT_COLOR_PALETTE[5].value },
  { from: "#FFDED9", to: VAULT_COLOR_PALETTE[6].value },
  { from: "#FFD9E9", to: VAULT_COLOR_PALETTE[7].value },
  { from: "#E4D9FF", to: VAULT_COLOR_PALETTE[8].value },
  { from: "#6BA3B5", to: VAULT_COLOR_PALETTE[1].value },
  { from: "#6E8B74", to: VAULT_COLOR_PALETTE[2].value },
  { from: "#9B9B6F", to: VAULT_COLOR_PALETTE[3].value },
  { from: "#C4956A", to: VAULT_COLOR_PALETTE[4].value },
  { from: "#C27878", to: VAULT_COLOR_PALETTE[5].value },
  { from: "#B07BAC", to: VAULT_COLOR_PALETTE[6].value },
  { from: "#7B8CDE", to: VAULT_COLOR_PALETTE[7].value },
  { from: "#21A6E8", to: VAULT_COLOR_PALETTE[1].value },
  { from: "#35C9BD", to: VAULT_COLOR_PALETTE[2].value },
  { from: "#4FD17B", to: VAULT_COLOR_PALETTE[3].value },
  { from: "#A8D957", to: VAULT_COLOR_PALETTE[4].value },
  { from: "#F2B84B", to: VAULT_COLOR_PALETTE[5].value },
  { from: "#F07A68", to: VAULT_COLOR_PALETTE[6].value },
  { from: "#E46C9F", to: VAULT_COLOR_PALETTE[7].value },
  { from: "#9A78EB", to: VAULT_COLOR_PALETTE[8].value },
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
