import { index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const tagsTable = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    ownerUserId: varchar("owner_user_id").notNull(),
    createdByUserId: varchar("created_by_user_id").notNull(),
    scope: text("scope").notNull().default("user"),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull().default(""),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tags_account_slug_key").on(table.accountId, table.slug),
    uniqueIndex("tags_id_account_id_key").on(table.id, table.accountId),
    index("idx_tags_account_updated").on(table.accountId, table.updatedAt),
  ],
);

export const tagAliasesTable = pgTable(
  "tag_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tagId: uuid("tag_id").notNull(),
    accountId: text("account_id").notNull(),
    ownerUserId: varchar("owner_user_id").notNull(),
    createdByUserId: varchar("created_by_user_id").notNull(),
    scope: text("scope").notNull().default("user"),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tag_aliases_account_id_normalized_alias_key").on(table.accountId, table.normalizedAlias),
    index("idx_tag_aliases_tag").on(table.accountId, table.tagId),
  ],
);

export const tagAssignmentsTable = pgTable(
  "tag_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tagId: uuid("tag_id").notNull(),
    accountId: text("account_id").notNull(),
    ownerUserId: varchar("owner_user_id").notNull(),
    createdByUserId: varchar("created_by_user_id").notNull(),
    scope: text("scope").notNull().default("user"),
    objectType: text("object_type").notNull(),
    objectId: text("object_id").notNull(),
    objectTitle: text("object_title").notNull().default(""),
    source: text("source").notNull().default("explicit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("tag_assignments_account_id_tag_id_object_type_object_id_key").on(
      table.accountId,
      table.tagId,
      table.objectType,
      table.objectId,
    ),
    index("idx_tag_assignments_object").on(table.accountId, table.objectType, table.objectId),
    index("idx_tag_assignments_tag").on(table.accountId, table.tagId),
    index("idx_tag_assignments_owner").on(table.ownerUserId),
  ],
);

export const tagMigrationsTable = pgTable(
  "tag_migrations",
  {
    accountId: text("account_id").notNull(),
    migrationKey: text("migration_key").notNull(),
    status: text("status").notNull(),
    detail: jsonb("detail").notNull().default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.migrationKey] })],
);
