import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const thoughts = pgTable("thoughts", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  context: text("context"),
  type: text("type"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
}, (table) => [
  index("idx_thoughts_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_thoughts_account").on(table.accountId),
]);

export const insertThoughtSchema = createInsertSchema(thoughts).omit({ occurredAt: true });
export type InsertThought = z.infer<typeof insertThoughtSchema>;
export type Thought = typeof thoughts.$inferSelect;
