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
 * Operator-local Home INBOX dismissal for reported Issues.
 * Absence means still surfaced; one row means this operator dismissed that Issue.
 * Does not change Issue status or reporter-owned documents.
 */
export const reportedIssueHomeDismissals = pgTable(
  "reported_issue_home_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: text("issue_id").notNull(),
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
    uniqueIndex("uk_reported_issue_home_dismissal_owner_issue").on(
      table.accountId,
      table.ownerUserId,
      table.issueId,
    ),
    uniqueIndex("uk_reported_issue_home_dismissal_reason").on(
      table.accountId,
      table.ownerUserId,
      table.reasonKey,
    ),
    index("idx_reported_issue_home_dismissal_owner").on(
      table.ownerUserId,
      table.accountId,
      table.dismissedAt,
    ),
    check(
      "reported_issue_home_dismissal_issue_check",
      sql`char_length(${table.issueId}) BETWEEN 1 AND 40`,
    ),
    check(
      "reported_issue_home_dismissal_reason_check",
      sql`char_length(${table.reasonKey}) BETWEEN 1 AND 500`,
    ),
  ],
);

export type ReportedIssueHomeDismissal = typeof reportedIssueHomeDismissals.$inferSelect;
