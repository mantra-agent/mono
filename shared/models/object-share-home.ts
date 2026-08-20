import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Recipient-local Home INBOX dismissal for object_share rows.
 * Keyed by grant id + owner; absence means still surfaced.
 * Dismissal never revokes the grant.
 */
export const objectShareHomeDismissals = pgTable(
  "object_share_home_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: text("grant_id").notNull(),
    reasonKey: text("reason_key").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull(),
    dismissedByUserId: text("dismissed_by_user_id").notNull(),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("uk_object_share_home_dismissal_owner_grant").on(
      table.accountId,
      table.ownerUserId,
      table.grantId,
    ),
    uniqueIndex("uk_object_share_home_dismissal_reason").on(
      table.accountId,
      table.ownerUserId,
      table.reasonKey,
    ),
    index("idx_object_share_home_dismissal_owner").on(
      table.ownerUserId,
      table.accountId,
      table.dismissedAt,
    ),
    check(
      "object_share_home_dismissal_grant_check",
      sql`char_length(${table.grantId}) BETWEEN 1 AND 80`,
    ),
    check(
      "object_share_home_dismissal_reason_check",
      sql`char_length(${table.reasonKey}) BETWEEN 1 AND 500`,
    ),
  ],
);

export type ObjectShareHomeDismissal = typeof objectShareHomeDismissals.$inferSelect;
