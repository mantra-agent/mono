import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Repository-wide durable post-commit delivery substrate. Domain systems write
 * here inside their own transaction; dispatch/projection consumers arrive in
 * later migrations. This table never owns domain state.
 */
export const transactionalOutbox = pgTable("transactional_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventType: text("event_type").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id").notNull(),
  accountId: text("account_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("transactional_outbox_owner_idempotency").on(table.ownerUserId, table.accountId, table.idempotencyKey),
  index("transactional_outbox_ready").on(table.publishedAt, table.availableAt, table.createdAt),
  index("transactional_outbox_aggregate").on(table.accountId, table.aggregateType, table.aggregateId),
  check("transactional_outbox_user_scope_check", sql`${table.scope} = 'user'`),
  check("transactional_outbox_event_type_check", sql`${table.eventType} ~ '^[a-z][a-z0-9_.]{0,119}$'`),
  check("transactional_outbox_idempotency_check", sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`),
  check("transactional_outbox_payload_check", sql`jsonb_typeof(${table.payload}) = 'object'`),
]);

export type TransactionalOutboxRow = typeof transactionalOutbox.$inferSelect;
