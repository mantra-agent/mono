import { pgTable, text, real, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Enums ──────────────────────────────────────────────────────────
export const signalSourceTypes = [
  "x_account", "subreddit", "rss_feed", "pinned_topic",
] as const;
export type SignalSourceType = typeof signalSourceTypes[number];

export const signalItemStatuses = ["new", "surfaced", "dismissed", "saved", "archived"] as const;
export type SignalItemStatus = typeof signalItemStatuses[number];

// ── Tables ─────────────────────────────────────────────────────────

/** Source configuration — what the radar watches */
export const signalSources = pgTable("signal_sources", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceType: text("source_type").notNull(),
  value: text("value").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
  signalCount: integer("signal_count").notNull().default(0),
  lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  cachedUserId: text("cached_user_id"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_signal_sources_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_signal_sources_account").on(table.accountId),
]);

/** Collected signals — individual items found by scans */
export const signalItems = pgTable("signal_items", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").references(() => signalSources.id),
  url: text("url").notNull(),
  title: text("title").notNull(),
  snippet: text("snippet").notNull().default(""),
  agentSummary: text("agent_summary"),
  curatedTitle: text("curated_title"),
  curatedReason: text("curated_reason"),
  curationStatus: text("curation_status").notNull().default("unread"),
  curationScore: real("curation_score"),
  matchedTopics: text("matched_topics").array().notNull().default(sql`'{}'::text[]`),
  curatedAt: timestamp("curated_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  relevanceScore: real("relevance_score").notNull().default(0),
  relevanceTags: text("relevance_tags").array().notNull().default(sql`'{}'::text[]`),
  matchingSkills: text("matching_skills").array().notNull().default(sql`'{}'::text[]`),
  matchingTheses: text("matching_theses").array().notNull().default(sql`'{}'::text[]`),
  fingerprint: text("fingerprint").notNull().unique(),
  status: text("status").notNull().default("new"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
  index("idx_signal_items_status").on(table.status),
  index("idx_signal_items_relevance").on(table.relevanceScore),
  index("idx_signal_items_scanned").on(table.scannedAt),
  index("idx_signal_items_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_signal_items_account").on(table.accountId),
]);

/** Scan run history — audit trail for each scan execution */
export const scanRuns = pgTable("scan_runs", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  startedAt: timestamp("started_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  sourcesScanned: integer("sources_scanned").notNull().default(0),
  itemsFound: integer("items_found").notNull().default(0),
  itemsSurfaced: integer("items_surfaced").notNull().default(0),
  itemsDeduped: integer("items_deduped").notNull().default(0),
  error: text("error"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
}, (table) => [
  index("idx_scan_runs_scope_owner").on(table.scope, table.ownerUserId),
  index("idx_scan_runs_account").on(table.accountId),
]);

// ── Zod Schemas ────────────────────────────────────────────────────

export const insertSignalSourceSchema = createInsertSchema(signalSources).omit({
  id: true,
  createdAt: true,
}).extend({
  sourceType: z.enum(signalSourceTypes),
  value: z.string().min(1),
  enabled: z.boolean().optional(),
});

export const insertSignalItemSchema = createInsertSchema(signalItems).omit({
  id: true,
  createdAt: true,
}).extend({
  url: z.string().min(1),
  title: z.string().min(1),
  fingerprint: z.string().min(1),
  status: z.enum(signalItemStatuses).optional(),
  relevanceTags: z.array(z.string()).optional(),
  matchingSkills: z.array(z.string()).optional(),
  matchingTheses: z.array(z.string()).optional(),
  matchedTopics: z.array(z.string()).optional(),
});

export const insertScanRunSchema = createInsertSchema(scanRuns).omit({
  id: true,
});

// ── Types ──────────────────────────────────────────────────────────
export type SignalSource = typeof signalSources.$inferSelect;
export type InsertSignalSource = z.infer<typeof insertSignalSourceSchema>;
export type SignalItem = typeof signalItems.$inferSelect;
export type InsertSignalItem = z.infer<typeof insertSignalItemSchema>;
export type ScanRun = typeof scanRuns.$inferSelect;
export type InsertScanRun = z.infer<typeof insertScanRunSchema>;
