import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const exportStatusEnum = z.enum(["pending", "running", "complete", "failed"]);
export type ExportStatus = z.infer<typeof exportStatusEnum>;

export const exportJobs = pgTable("export_jobs", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  status: text("status").notNull().default("pending"),
  progress: integer("progress").notNull().default(0),
  currentDomain: text("current_domain"),
  downloadUrl: text("download_url"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_export_jobs_status").on(table.status),
  index("idx_export_jobs_owner").on(table.ownerUserId),
  index("idx_export_jobs_principal_account").on(table.principalAccountId),
]);

export const insertExportJobSchema = createInsertSchema(exportJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ExportJob = typeof exportJobs.$inferSelect;
export type InsertExportJob = z.infer<typeof insertExportJobSchema>;
