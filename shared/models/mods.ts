import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ─── Mod platform persistence foundation (Phase 1 shadow) ──────────────────
// Three account-owned structures back the first-party Mod composition plane:
//   mod_entitlements          — what an account MAY install (commercial/product eligibility)
//   mod_installations         — what an account HAS activated (desired + reconciled state)
//   mod_installation_resources — reconciliation ledger proving which canonical
//                                rows an installation materialized (hooks/timers/etc.)
// Resolved composition is computed and cached elsewhere; it is never a table.
// Every structure carries full ownership columns and is mutated only through
// the canonical ModLifecycleService using scoped-storage helpers.

export const MOD_KEYS = [
  "planning",
  "build",
  "business",
  "wellness",
  "network",
  "finance",
] as const;
export type ModKey = (typeof MOD_KEYS)[number];

export const MOD_ENTITLEMENT_STATUSES = ["granted", "suspended", "expired"] as const;
export type ModEntitlementStatus = (typeof MOD_ENTITLEMENT_STATUSES)[number];

export const MOD_INSTALLATION_STATUSES = [
  "installing",
  "active",
  "disabling",
  "disabled",
  "error",
] as const;
export type ModInstallationStatus = (typeof MOD_INSTALLATION_STATUSES)[number];

export const MOD_RESOURCE_STATUSES = ["active", "disabled", "detached", "error"] as const;
export type ModResourceStatus = (typeof MOD_RESOURCE_STATUSES)[number];

/** Account-level commercial/product eligibility. Not a user ACL. */
export const modEntitlements = pgTable(
  "mod_entitlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modKey: text("mod_key").notNull(),
    status: text("status").$type<ModEntitlementStatus>().notNull().default("granted"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uk_mod_entitlements_account_mod").on(table.accountId, table.modKey),
    index("idx_mod_entitlements_scope_owner").on(table.scope, table.ownerUserId, table.accountId),
    check(
      "mod_entitlements_status_check",
      sql`${table.status} IN ('granted', 'suspended', 'expired')`,
    ),
    check(
      "mod_entitlements_mod_key_check",
      sql`${table.modKey} ~ '^[a-z][a-z0-9_-]{0,62}$'`,
    ),
    check(
      "mod_entitlements_validity_check",
      sql`${table.validFrom} IS NULL OR ${table.validUntil} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
  ],
);

/** Account-level desired and reconciled product activation state. */
export const modInstallations = pgTable(
  "mod_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    modKey: text("mod_key").notNull(),
    status: text("status").$type<ModInstallationStatus>().notNull().default("installing"),
    resolvedVersion: text("resolved_version"),
    installedByUserId: text("installed_by_user_id"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uk_mod_installations_account_mod").on(table.accountId, table.modKey),
    index("idx_mod_installations_scope_owner").on(table.scope, table.ownerUserId, table.accountId),
    index("idx_mod_installations_status").on(table.accountId, table.status),
    check(
      "mod_installations_status_check",
      sql`${table.status} IN ('installing', 'active', 'disabling', 'disabled', 'error')`,
    ),
    check(
      "mod_installations_mod_key_check",
      sql`${table.modKey} ~ '^[a-z][a-z0-9_-]{0,62}$'`,
    ),
    check(
      "mod_installations_failure_detail_check",
      sql`${table.failureDetail} IS NULL OR char_length(${table.failureDetail}) <= 2000`,
    ),
    check(
      "mod_installations_failure_code_check",
      sql`${table.failureCode} IS NULL OR char_length(${table.failureCode}) BETWEEN 1 AND 80`,
    ),
  ],
);

/**
 * Narrow reconciliation ledger for contributions that materialize rows in an
 * existing canonical store (managed hooks/timers/setup artifacts). It never
 * holds the hook/timer/workflow/connector definition — only proof of which
 * canonical row an installation materialized so updates and uninstall act safely.
 */
export const modInstallationResources = pgTable(
  "mod_installation_resources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => modInstallations.id, { onDelete: "cascade" }),
    contributionId: text("contribution_id").notNull(),
    subjectUserId: text("subject_user_id"),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    definitionHash: text("definition_hash").notNull(),
    status: text("status").$type<ModResourceStatus>().notNull().default("active"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    updatedByUserId: text("updated_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Spec §5.3 unique (installation_id, contribution_id, subject_user_id).
    // subject_user_id is nullable (account-level materialization), so collapse
    // NULL to '' to keep the uniqueness deterministic across NULL rows.
    uniqueIndex("uk_mod_installation_resources_contribution").on(
      table.installationId,
      table.contributionId,
      sql`coalesce(${table.subjectUserId}, '')`,
    ),
    index("idx_mod_installation_resources_installation").on(table.installationId, table.status),
    index("idx_mod_installation_resources_scope_owner").on(
      table.scope,
      table.ownerUserId,
      table.accountId,
    ),
    check(
      "mod_installation_resources_status_check",
      sql`${table.status} IN ('active', 'disabled', 'detached', 'error')`,
    ),
    check(
      "mod_installation_resources_kind_check",
      sql`char_length(${table.resourceKind}) BETWEEN 1 AND 80`,
    ),
    check(
      "mod_installation_resources_hash_check",
      sql`char_length(${table.definitionHash}) BETWEEN 1 AND 200`,
    ),
  ],
);

export type ModEntitlementRow = typeof modEntitlements.$inferSelect;
export type InsertModEntitlement = typeof modEntitlements.$inferInsert;
export type ModInstallationRow = typeof modInstallations.$inferSelect;
export type InsertModInstallation = typeof modInstallations.$inferInsert;
export type ModInstallationResourceRow = typeof modInstallationResources.$inferSelect;
export type InsertModInstallationResource = typeof modInstallationResources.$inferInsert;
