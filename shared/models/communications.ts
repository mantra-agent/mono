import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const communicationAudiences = pgTable("communication_audiences", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("active"),
  definition: jsonb("definition").notNull().default({ kind: "manual", personIds: [] }),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_communication_audiences_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_communication_audiences_account_updated").on(table.accountId, table.updatedAt),
]);

export const emailCampaigns = pgTable("email_campaigns", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  audienceId: text("audience_id").references(() => communicationAudiences.id, { onDelete: "set null" }),
  senderName: text("sender_name").notNull().default("Ray"),
  senderEmail: text("sender_email").notNull().default("ray@trymantra.ai"),
  replyToEmail: text("reply_to_email").notNull().default("ray@trymantra.ai"),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_email_campaigns_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_email_campaigns_account_updated").on(table.accountId, table.updatedAt),
  index("idx_email_campaigns_audience").on(table.audienceId),
]);

export interface ManualAudienceDefinition {
  kind: "manual";
  personIds: string[];
}

export type CommunicationAudience = typeof communicationAudiences.$inferSelect;
export type EmailCampaign = typeof emailCampaigns.$inferSelect;
