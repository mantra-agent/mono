import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { pgTable, text, varchar, serial, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const promptModuleStatuses = ["active", "draft", "deprecated"] as const;
export type PromptModuleStatus = typeof promptModuleStatuses[number];

export const promptModules = pgTable("prompt_modules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: varchar("key", { length: 96 }).notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  domain: text("domain").notNull().default("other"),
  prompt: text("prompt").notNull(),
  outputSpec: text("output_spec").notNull().default(""),
  outputSchema: jsonb("output_schema").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("active"),
  version: text("version").notNull().default("1.0"),
  sourceSkillName: varchar("source_skill_name", { length: 64 }),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  scope: text("scope").notNull().default("global"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_prompt_modules_domain_status").on(table.domain, table.status),
  index("idx_prompt_modules_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_prompt_modules_account").on(table.accountId),
]);

export const promptModuleVersions = pgTable("prompt_module_versions", {
  id: serial("id").primaryKey(),
  moduleId: varchar("module_id").notNull().references(() => promptModules.id, { onDelete: "cascade" }),
  key: varchar("key", { length: 96 }).notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  domain: text("domain").notNull().default("other"),
  prompt: text("prompt").notNull(),
  outputSpec: text("output_spec").notNull().default(""),
  outputSchema: jsonb("output_schema").notNull().default(sql`'{}'::jsonb`),
  status: text("status").notNull().default("active"),
  version: text("version").notNull().default("1.0"),
  sourceSkillName: varchar("source_skill_name", { length: 64 }),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  changeNote: text("change_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_prompt_module_versions_module_created").on(table.moduleId, table.createdAt),
]);

export const insertPromptModuleSchema = createInsertSchema(promptModules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  key: z.string().min(1).max(96).regex(/^[a-z][a-z0-9-]*$/, "Lowercase letters, numbers, and hyphens only"),
  name: z.string().min(1).max(160),
  description: z.string().max(2048).default(""),
  domain: z.string().min(1).max(64).default("other"),
  prompt: z.string().min(1),
  outputSpec: z.string().default(""),
  outputSchema: z.record(z.unknown()).default({}),
  status: z.enum(promptModuleStatuses).default("active"),
  version: z.string().min(1).max(40).default("1.0"),
  sourceSkillName: z.string().max(64).nullable().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const updatePromptModuleSchema = insertPromptModuleSchema.partial().omit({ key: true });

export type PromptModule = typeof promptModules.$inferSelect;
export type PromptModuleVersion = typeof promptModuleVersions.$inferSelect;
export type InsertPromptModule = z.infer<typeof insertPromptModuleSchema>;
export type UpdatePromptModule = z.infer<typeof updatePromptModuleSchema>;
