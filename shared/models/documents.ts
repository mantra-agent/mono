import { index, jsonb, pgTable, text, timestamp, bigint, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const documentArtifacts = pgTable("document_artifacts", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  vaultId: text("vault_id").notNull(),
  sourceKind: text("source_kind").notNull(),
  sourceRef: text("source_ref").notNull(),
  mimeType: text("mime_type").notNull(),
  title: text("title").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }),
  checksum: text("checksum"),
  objectPath: text("object_path"),
  pageCount: integer("page_count"),
  textExtractStatus: text("text_extract_status").notNull().default("none"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  provenance: jsonb("provenance").notNull().default(sql`'{}'::jsonb`),
}, table => ({
  ownerIdx: index("idx_document_artifacts_owner").on(table.accountId, table.ownerUserId),
  vaultIdx: index("idx_document_artifacts_vault").on(table.vaultId),
}));

export type DocumentArtifact = typeof documentArtifacts.$inferSelect;
export type InsertDocumentArtifact = typeof documentArtifacts.$inferInsert;
