import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { libraryPages } from "./info";
import { vaults } from "./vaults";

/**
 * Library2 is an organizational lens over existing Library page rows.
 * A placement never owns or rewrites page content. Deleting one only removes
 * the page from the Library2 lens.
 */
export const libraryPagePlacements = pgTable(
  "library_page_placements",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    pageId: text("page_id")
      .notNull()
      .references(() => libraryPages.id, { onDelete: "cascade" }),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    sectionPageId: text("section_page_id")
      .notNull()
      .references(() => libraryPages.id, { onDelete: "cascade" }),
    importKey: text("import_key").notNull(),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("uk_library_page_placement_identity").on(
      table.accountId,
      table.pageId,
      table.vaultId,
      table.sectionPageId,
    ),
    uniqueIndex("uk_library_page_placement_import_page").on(
      table.accountId,
      table.importKey,
      table.pageId,
    ),
    index("idx_library_page_placements_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_library_page_placements_vault_section").on(table.vaultId, table.sectionPageId),
    index("idx_library_page_placements_page").on(table.pageId),
  ],
);

export type LibraryPagePlacement = typeof libraryPagePlacements.$inferSelect;
export type InsertLibraryPagePlacement = typeof libraryPagePlacements.$inferInsert;
