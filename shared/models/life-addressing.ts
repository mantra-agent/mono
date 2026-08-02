import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const referenceOccurrenceOrigins = ["embedded"] as const;
export type ReferenceOccurrenceOrigin = typeof referenceOccurrenceOrigins[number];

export const addressLinkLifecycles = ["active", "retired"] as const;
export type AddressLinkLifecycle = typeof addressLinkLifecycles[number];

/**
 * Current replay fence for one authored source. Occurrences are a disposable
 * projection owned by this row, never the authority for source content.
 */
export const referenceOccurrenceSources = pgTable("reference_occurrence_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceAddress: text("source_address").notNull(),
  sourceRevision: text("source_revision").notNull(),
  sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }).notNull(),
  projectionHash: text("projection_hash").notNull(),
  occurrenceCount: integer("occurrence_count").notNull().default(0),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
}, (table) => [
  uniqueIndex("uk_reference_occurrence_source_owner")
    .on(table.ownerUserId, table.accountId, table.sourceAddress),
  index("idx_reference_occurrence_sources_scope_owner")
    .on(table.scope, table.ownerUserId, table.accountId, table.sourceAddress),
  index("idx_reference_occurrence_sources_replay")
    .on(table.ownerUserId, table.accountId, table.sourceObservedAt, table.sourceAddress),
  check("reference_occurrence_sources_user_scope_check", sql`${table.scope} = 'user'`),
  check("reference_occurrence_sources_address_length_check", sql`char_length(${table.sourceAddress}) BETWEEN 3 AND 2048`),
  check("reference_occurrence_sources_revision_length_check", sql`char_length(${table.sourceRevision}) BETWEEN 1 AND 200`),
  check("reference_occurrence_sources_hash_check", sql`${table.projectionHash} ~ '^[0-9a-f]{64}$'`),
  check("reference_occurrence_sources_count_check", sql`${table.occurrenceCount} BETWEEN 0 AND 5000`),
]);

/** Rebuildable, repeated authored mentions for the current source revision. */
export const referenceOccurrences = pgTable("reference_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceProjectionId: uuid("source_projection_id").notNull()
    .references(() => referenceOccurrenceSources.id, { onDelete: "cascade" }),
  sourceAddress: text("source_address").notNull(),
  sourceRevision: text("source_revision").notNull(),
  occurrenceOrdinal: integer("occurrence_ordinal").notNull(),
  targetAddress: text("target_address").notNull(),
  locationBlockId: text("location_block_id"),
  locationStart: integer("location_start"),
  locationEnd: integer("location_end"),
  origin: text("origin", { enum: referenceOccurrenceOrigins }).notNull().default("embedded"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
}, (table) => [
  uniqueIndex("uk_reference_occurrence_projection_ordinal")
    .on(table.sourceProjectionId, table.occurrenceOrdinal),
  index("idx_reference_occurrences_source")
    .on(table.ownerUserId, table.accountId, table.sourceAddress, table.occurrenceOrdinal),
  index("idx_reference_occurrences_target")
    .on(table.ownerUserId, table.accountId, table.targetAddress, table.observedAt),
  index("idx_reference_occurrences_scope_owner")
    .on(table.scope, table.ownerUserId, table.accountId),
  check("reference_occurrences_user_scope_check", sql`${table.scope} = 'user'`),
  check("reference_occurrences_source_length_check", sql`char_length(${table.sourceAddress}) BETWEEN 3 AND 2048`),
  check("reference_occurrences_target_length_check", sql`char_length(${table.targetAddress}) BETWEEN 3 AND 2048`),
  check("reference_occurrences_revision_length_check", sql`char_length(${table.sourceRevision}) BETWEEN 1 AND 200`),
  check("reference_occurrences_ordinal_check", sql`${table.occurrenceOrdinal} BETWEEN 0 AND 4999`),
  check("reference_occurrences_origin_check", sql`${table.origin} = 'embedded'`),
  check("reference_occurrences_block_length_check", sql`${table.locationBlockId} IS NULL OR char_length(${table.locationBlockId}) BETWEEN 1 AND 200`),
  check("reference_occurrences_location_check", sql`
    (${table.locationStart} IS NULL OR ${table.locationStart} >= 0)
    AND (${table.locationEnd} IS NULL OR ${table.locationEnd} >= 0)
    AND (${table.locationStart} IS NULL OR ${table.locationEnd} IS NULL OR ${table.locationEnd} >= ${table.locationStart})
  `),
]);

/**
 * Deliberate cross-object assertions. Domain-owned facts and semantic claims
 * remain in their owning stores and project through separate graph adapters.
 */
export const addressLinks = pgTable("address_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceAddress: text("source_address").notNull(),
  predicate: text("predicate").notNull(),
  targetAddress: text("target_address").notNull(),
  provenanceAddress: text("provenance_address"),
  createdBy: text("created_by").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  lifecycle: text("lifecycle", { enum: addressLinkLifecycles }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  updatedByUserId: text("updated_by_user_id").notNull(),
}, (table) => [
  uniqueIndex("uk_address_links_owner_idempotency")
    .on(table.ownerUserId, table.accountId, table.idempotencyKey),
  index("idx_address_links_source_active")
    .on(table.ownerUserId, table.accountId, table.sourceAddress, table.predicate)
    .where(sql`${table.lifecycle} = 'active'`),
  index("idx_address_links_target_active")
    .on(table.ownerUserId, table.accountId, table.targetAddress, table.predicate)
    .where(sql`${table.lifecycle} = 'active'`),
  index("idx_address_links_scope_owner")
    .on(table.scope, table.ownerUserId, table.accountId, table.lifecycle),
  check("address_links_user_scope_check", sql`${table.scope} = 'user'`),
  check("address_links_source_length_check", sql`char_length(${table.sourceAddress}) BETWEEN 3 AND 2048`),
  check("address_links_target_length_check", sql`char_length(${table.targetAddress}) BETWEEN 3 AND 2048`),
  check("address_links_provenance_length_check", sql`${table.provenanceAddress} IS NULL OR char_length(${table.provenanceAddress}) BETWEEN 3 AND 2048`),
  check("address_links_distinct_endpoints_check", sql`${table.sourceAddress} <> ${table.targetAddress}`),
  check("address_links_predicate_check", sql`${table.predicate} ~ '^[a-z]' AND ${table.predicate} !~ '[^a-z0-9_]' AND char_length(${table.predicate}) <= 80`),
  check("address_links_created_by_length_check", sql`char_length(${table.createdBy}) BETWEEN 1 AND 200`),
  check("address_links_idempotency_length_check", sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`),
  check("address_links_lifecycle_check", sql`${table.lifecycle} IN ('active', 'retired')`),
  check("address_links_retirement_check", sql`
    (${table.lifecycle} = 'active' AND ${table.retiredAt} IS NULL)
    OR (${table.lifecycle} = 'retired' AND ${table.retiredAt} IS NOT NULL)
  `),
]);

export type ReferenceOccurrenceSourceRow = typeof referenceOccurrenceSources.$inferSelect;
export type ReferenceOccurrenceRow = typeof referenceOccurrences.$inferSelect;
export type AddressLinkRow = typeof addressLinks.$inferSelect;
