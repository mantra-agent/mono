import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const COMPACTION_OPERATION_STATUSES = [
  "claimed",
  "archiving",
  "summarizing",
  "ready",
  "committed",
  "superseded",
  "failed",
] as const;

export type CompactionOperationStatus =
  (typeof COMPACTION_OPERATION_STATUSES)[number];

export const compactionOperations = pgTable(
  "compaction_operations",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    vaultId: text("vault_id"),
    sessionId: text("session_id").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    boundaryHash: text("boundary_hash").notNull(),
    lastRemovedMessageId: text("last_removed_message_id").notNull(),
    removedMessageIds: jsonb("removed_message_ids").$type<string[]>().notNull(),
    keptMessageIds: jsonb("kept_message_ids").$type<string[]>().notNull(),
    status: text("status").$type<CompactionOperationStatus>().notNull().default("claimed"),
    ownerBootId: text("owner_boot_id").notNull(),
    callerGeneration: integer("caller_generation"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, precision: 6 }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true, precision: 6 }).notNull(),
    archiveRefId: text("archive_ref_id"),
    archiveObjectPath: text("archive_object_path"),
    markerId: text("marker_id"),
    summaryKind: text("summary_kind"),
    summaryMetadata: jsonb("summary_metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    segmentCount: integer("segment_count"),
    modelCallCount: integer("model_call_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    archiveBytes: integer("archive_bytes"),
    outcome: text("outcome"),
    failureReason: text("failure_reason"),
    attemptCount: integer("attempt_count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 6 }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true, precision: 6 }),
  },
  (table) => [
    uniqueIndex("uk_compaction_operation_snapshot").on(
      table.ownerUserId,
      table.accountId,
      table.sessionId,
      table.snapshotHash,
    ),
    uniqueIndex("uk_compaction_active_session")
      .on(table.ownerUserId, table.accountId, table.sessionId)
      .where(sql`${table.status} IN ('claimed', 'archiving', 'summarizing', 'ready')`),
    index("idx_compaction_operation_session").on(
      table.ownerUserId,
      table.accountId,
      table.sessionId,
      table.createdAt,
    ),
    index("idx_compaction_operation_lease").on(table.status, table.leaseExpiresAt),
    check(
      "compaction_operation_status_check",
      sql`${table.status} IN ('claimed', 'archiving', 'summarizing', 'ready', 'committed', 'superseded', 'failed')`,
    ),
  ],
);

export type CompactionOperation = typeof compactionOperations.$inferSelect;
export type InsertCompactionOperation = typeof compactionOperations.$inferInsert;
