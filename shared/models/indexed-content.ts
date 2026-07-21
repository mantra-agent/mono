import { pgTable, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const indexedContent = pgTable("indexed_content", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  sourceType: text("source_type").notNull(),
  operationKey: text("operation_key"),
  sourceLabel: text("source_label").notNull(),
  objectStoragePath: text("object_storage_path").notNull(),
  byteCount: integer("byte_count").notNull(),
  index: jsonb("index").$type<IndexData>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_indexed_content_source_type").on(table.sourceType),
  index("idx_indexed_content_created_at").on(table.createdAt),
  index("idx_indexed_content_owner").on(table.ownerUserId),
  index("idx_indexed_content_principal_account").on(table.principalAccountId),
  index("idx_indexed_content_vault").on(table.vaultId),
  uniqueIndex("uk_indexed_content_operation")
    .on(
      table.ownerUserId,
      table.principalAccountId,
      table.sourceType,
      table.operationKey,
    )
    .where(sql`${table.operationKey} IS NOT NULL`),
]);

export interface IndexSection {
  title: string;
  byteOffset: number;
  byteLength: number;
  keyFacts: string[];
}

export interface IndexData {
  sections: IndexSection[];
  keyFacts: string[];
  identifiers: string[];
  totalChars: number;
}

export const insertIndexedContentSchema = createInsertSchema(indexedContent).omit({
  id: true,
  createdAt: true,
});

export type IndexedContent = typeof indexedContent.$inferSelect;
export type InsertIndexedContent = z.infer<typeof insertIndexedContentSchema>;
