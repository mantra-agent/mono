import { sql } from "drizzle-orm";
import { pgTable, serial, text, real, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const browserPerformanceTelemetry = pgTable("browser_performance_telemetry", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  createdByUserId: text("created_by_user_id"),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  value: real("value").notNull(),
  unit: text("unit").notNull(),
  routeKey: text("route_key"),
  sessionId: text("session_id"),
  clientTurnId: text("client_turn_id"),
  bucket: text("bucket"),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  // Visibility state at the time the sample was captured. NULL for rows written before
  // visibility tagging was introduced (migration 0079). Application code treats NULL per-metric.
  visibility: text("visibility"),
}, (table) => ({
  scopeOwnerIdx: index("idx_browser_perf_scope_owner").on(table.scope, table.ownerUserId),
  accountReceivedIdx: index("idx_browser_perf_account_received").on(table.accountId, table.receivedAt),
  kindReceivedIdx: index("idx_browser_perf_kind_received").on(table.kind, table.receivedAt),
  sessionIdx: index("idx_browser_perf_session").on(table.sessionId, table.receivedAt),
}));

export type BrowserPerformanceTelemetry = typeof browserPerformanceTelemetry.$inferSelect;
export type InsertBrowserPerformanceTelemetry = typeof browserPerformanceTelemetry.$inferInsert;
