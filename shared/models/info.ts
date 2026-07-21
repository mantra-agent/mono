import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  integer,
  real,
  boolean,
  index,
  unique,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { memoryEntries } from "./memory";

export const infoNotes = pgTable(
  "info_notes",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    noteId: serial("note_id").notNull(),
    title: text("title").notNull().default(""),
    content: jsonb("content").default({}),
    plainTextContent: text("plain_text_content").notNull().default(""),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_info_notes_note_id").on(table.noteId),
    index("idx_info_notes_updated").on(table.updatedAt),
    index("idx_info_notes_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_info_notes_account").on(table.accountId),
  ],
);

export const insertInfoNoteSchema = createInsertSchema(infoNotes)
  .omit({
    noteId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    title: z.string().default(""),
    content: z.any().optional(),
    plainTextContent: z.string().default(""),
  });

export type InfoNote = typeof infoNotes.$inferSelect;
export type InsertInfoNote = z.infer<typeof insertInfoNoteSchema>;

export const libraryPages = pgTable(
  "library_pages",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    pageId: serial("page_id").notNull(),
    title: text("title").notNull().default(""),
    slug: text("slug").notNull().default(""),
    content: jsonb("content").default({}),
    plainTextContent: text("plain_text_content").notNull().default(""),
    parentId: text("parent_id").references((): AnyPgColumn => libraryPages.id, {
      onDelete: "set null",
    }),
    memoryEntryId: integer("memory_entry_id").references(
      () => memoryEntries.id,
      { onDelete: "set null" },
    ),
    oneLiner: text("one_liner"),
    summary: text("summary"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text("status"),
    emoji: text("emoji"),
    surface: boolean("surface").notNull().default(false),
    surfaceUntil: timestamp("surface_until", { withTimezone: true }),
    surfaceReason: text("surface_reason"),
    surfaceSection: text("surface_section"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBySessionId: text("created_by_session_id"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    vaultId: text("vault_id"),
    structuralRole: text("structural_role").notNull().default("artifact"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_library_pages_page_id").on(table.pageId),
    index("idx_library_pages_parent").on(table.parentId),
    index("idx_library_pages_slug").on(table.slug),
    index("idx_library_pages_session").on(table.createdBySessionId),
    index("idx_library_pages_surface_until").on(table.surfaceUntil),
    index("idx_library_pages_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_library_pages_account").on(table.accountId),
    index("idx_library_pages_vault").on(table.vaultId),
    index("idx_library_pages_structural_role").on(table.structuralRole),
  ],
);

export const insertLibraryPageSchema = createInsertSchema(libraryPages)
  .omit({
    pageId: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    title: z.string().default(""),
    content: z.any().optional(),
    plainTextContent: z.string().default(""),
    oneLiner: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    parentId: z.string().nullable().optional(),
    memoryEntryId: z.number().nullable().optional(),
    tags: z.array(z.string()).default([]),
    status: z.string().nullable().optional(),
    emoji: z.string().nullable().optional(),
    surface: z.boolean().optional(),
    surfaceUntil: z.date().nullable().optional(),
    surfaceReason: z.string().nullable().optional(),
    surfaceSection: z.string().nullable().optional(),
    structuralRole: z.enum(["source", "artifact", "wiki", "meta"]).optional(),
  });

export type LibraryPage = typeof libraryPages.$inferSelect;
export type InsertLibraryPage = z.infer<typeof insertLibraryPageSchema>;

export const libraryPageLinks = pgTable(
  "library_page_links",
  {
    id: serial("id").primaryKey(),
    sourcePageId: text("source_page_id")
      .notNull()
      .references(() => libraryPages.id, { onDelete: "cascade" }),
    targetPageId: text("target_page_id")
      .notNull()
      .references(() => libraryPages.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uk_library_page_links").on(table.sourcePageId, table.targetPageId),
    index("idx_library_page_links_source").on(table.sourcePageId),
    index("idx_library_page_links_target").on(table.targetPageId),
    index("idx_library_page_links_scope_owner").on(
      table.scope,
      table.ownerUserId,
    ),
  ],
);

export type LibraryPageLink = typeof libraryPageLinks.$inferSelect;

export const LIBRARY_PLACEMENT_INDEX_SECTIONS = [
  "Entities",
  "Concepts",
  "Synthesis",
] as const;
export type LibraryPlacementIndexSection =
  (typeof LIBRARY_PLACEMENT_INDEX_SECTIONS)[number];

export const LIBRARY_PLACEMENT_SOURCES = [
  "semantic",
  "explicit",
  "manual",
  "import",
] as const;
export type LibraryPlacementSource =
  (typeof LIBRARY_PLACEMENT_SOURCES)[number];

/**
 * Library placements — the load-bearing join between a Library page and a
 * vault's Index/Wiki structure (the Library2 "second-brain" lens).
 *
 * A placement is a lightweight join (page -> vault -> index section/parent),
 * never a copy of the page. A page is "in" the second-brain lens when it has
 * a placement row; deleting the row removes it from the lens and leaves the
 * flat Library page completely untouched. One page, one source of truth,
 * two views.
 *
 * vault_id references a user-owned vault (shared/models/vaults) but, matching
 * library_pages.vault_id, carries no hard FK: vaults are runtime-loaded,
 * user-owned objects. page_id and parent_page_id are hard FKs to library_pages
 * so a placement can never reference a nonexistent page, and cascade delete
 * keeps the lens consistent when a page is removed.
 */
export const libraryPlacements = pgTable(
  "library_placements",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    pageId: text("page_id")
      .notNull()
      .references(() => libraryPages.id, { onDelete: "cascade" }),
    vaultId: text("vault_id").notNull(),
    indexSection: text("index_section").notNull().default("Concepts"),
    parentPageId: text("parent_page_id").references(
      (): AnyPgColumn => libraryPages.id,
      { onDelete: "set null" },
    ),
    placedBy: text("placed_by").notNull().default("manual"),
    confidence: real("confidence"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique("uk_library_placements_page_vault").on(
      table.pageId,
      table.vaultId,
    ),
    index("idx_library_placements_page").on(table.pageId),
    index("idx_library_placements_vault").on(table.vaultId),
    index("idx_library_placements_parent").on(table.parentPageId),
    index("idx_library_placements_vault_section").on(
      table.vaultId,
      table.indexSection,
    ),
    index("idx_library_placements_scope_owner").on(
      table.scope,
      table.ownerUserId,
    ),
    index("idx_library_placements_account").on(table.accountId),
  ],
);

export const insertLibraryPlacementSchema = createInsertSchema(libraryPlacements)
  .omit({
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    indexSection: z.enum(LIBRARY_PLACEMENT_INDEX_SECTIONS).default("Concepts"),
    parentPageId: z.string().nullable().optional(),
    placedBy: z.enum(LIBRARY_PLACEMENT_SOURCES).default("manual"),
    confidence: z.number().nullable().optional(),
  });

export type LibraryPlacement = typeof libraryPlacements.$inferSelect;
export type InsertLibraryPlacement = z.infer<
  typeof insertLibraryPlacementSchema
>;

export const libraryAnnotationTypes = [
  "observation",
  "connection",
  "confidence",
] as const;
export type LibraryAnnotationType = (typeof libraryAnnotationTypes)[number];

export const libraryAnnotations = pgTable(
  "library_annotations",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    pageId: text("page_id")
      .notNull()
      .references(() => libraryPages.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    annotationType: text("annotation_type").notNull().default("observation"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_library_annotations_page").on(table.pageId),
    index("idx_library_annotations_scope_owner").on(
      table.scope,
      table.ownerUserId,
    ),
  ],
);

export const insertLibraryAnnotationSchema = createInsertSchema(
  libraryAnnotations,
)
  .omit({
    createdAt: true,
  })
  .extend({
    annotationType: z.enum(libraryAnnotationTypes).default("observation"),
  });

export type LibraryAnnotation = typeof libraryAnnotations.$inferSelect;
export type InsertLibraryAnnotation = z.infer<
  typeof insertLibraryAnnotationSchema
>;

export const libraryPageViews = pgTable(
  "library_page_views",
  {
    pageId: text("page_id")
      .primaryKey()
      .references(() => libraryPages.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [index("idx_library_page_views_page").on(table.pageId)],
);
