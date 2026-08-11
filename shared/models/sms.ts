import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { accounts, users, vaults } from "../schema";

export const SMS_DISCLOSURE_VERSION = "signup-service-sms-2026-08-11";

export const twilioNumberBindings = pgTable("twilio_number_bindings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  phoneNumber: text("phone_number").notNull(),
  ownerUserId: varchar("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  vaultId: varchar("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("idx_twilio_number_bindings_active_number").on(table.phoneNumber).where(sql`${table.active} = TRUE`),
  index("idx_twilio_number_bindings_owner").on(table.ownerUserId, table.accountId, table.vaultId),
]);

export const smsConsentEvents = pgTable("sms_consent_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerUserId: varchar("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  vaultId: varchar("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
  phoneNumber: text("phone_number").notNull(),
  state: text("state").notNull(),
  disclosureVersion: text("disclosure_version").notNull(),
  source: text("source").notNull(),
  providerMessageSid: text("provider_message_sid"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_sms_consent_events_owner_phone").on(table.ownerUserId, table.accountId, table.phoneNumber, table.occurredAt),
  uniqueIndex("idx_sms_consent_events_provider_sid_state").on(table.providerMessageSid, table.state).where(sql`${table.providerMessageSid} IS NOT NULL`),
  check("sms_consent_events_state_check", sql`${table.state} IN ('opted_in', 'opted_out', 'help_requested')`),
]);

export const smsMessages = pgTable("sms_messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ownerUserId: varchar("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  vaultId: varchar("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
  personId: varchar("person_id"),
  phoneNumber: text("phone_number").notNull(),
  direction: text("direction").notNull(),
  body: text("body").notNull(),
  providerMessageSid: text("provider_message_sid").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  uniqueIndex("idx_sms_messages_provider_sid").on(table.providerMessageSid),
  index("idx_sms_messages_owner_created").on(table.ownerUserId, table.accountId, table.createdAt),
  check("sms_messages_direction_check", sql`${table.direction} IN ('inbound', 'outbound')`),
]);
