import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { createReferenceRef, type ReferenceRef } from "@shared/references";
import {
  documentStoreDocuments,
  platformProductEnvironments,
  platformProducts,
  platforms,
  reportedIssueHomeDismissals,
  userProfiles,
  users,
} from "@shared/schema";
import { deriveUserFirstName } from "@shared/identity-name";
import type { Principal } from "../principal";
import { db } from "../db";
import {
  combineWithVisibleScope,
  ownedInsertValues,
  type ScopeColumns,
} from "../scoped-storage";
import { visiblePlatform } from "../platforms/platform-access";
import { hasActiveModAccess } from "./mod-access";
import { principalHasPermission } from "../permissions";

const hasActiveBuildAccess = (principal: Principal) => hasActiveModAccess(principal, "build");

const dismissalScope: ScopeColumns = {
  scope: reportedIssueHomeDismissals.scope,
  ownerUserId: reportedIssueHomeDismissals.ownerUserId,
  accountId: reportedIssueHomeDismissals.accountId,
};

const MAX_HOME_REPORTED_ISSUES = 25;
const MAX_AUTO_CLEARS_PER_COLLECT = 50;
const SURFACE_WINDOW_MS = 48 * 60 * 60 * 1000;
const AUTO_CLEAR_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN_STATUSES = ["open", "in_progress", "in_review"] as const;

export interface ReportedIssueHomeItemRecord {
  issueId: number;
  title: string;
  status: string;
  reporterUserId: string;
  reporterLabel: string;
  platformEnvironmentId: number;
  createdAt: Date;
  userReference: ReferenceRef;
  issueReference: ReferenceRef;
  reasonKey: string;
}

function requireOwner(principal: Principal): { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Reported-issue Home requires an authenticated user");
  }
  return { userId: principal.userId, accountId: principal.accountId };
}

function boundedText(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function reporterLabel(input: {
  preferredName: string | null;
  displayName: string | null;
  email: string | null;
}): string {
  const preferred = input.preferredName?.replace(/\s+/g, " ").trim();
  const display = input.displayName?.replace(/\s+/g, " ").trim();
  if (preferred) return preferred;
  if (display) return display;
  return deriveUserFirstName({
    preferredName: input.preferredName,
    displayName: input.displayName,
    email: input.email,
  }, "User");
}

function parseIssueId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function reportedIssueReasonKey(issueId: number): string {
  return `reported-issue:${issueId}`;
}

function reportedIssueVisibilityPredicate(environmentIds: number[]) {
  return and(
    eq(documentStoreDocuments.documentType, "issue"),
    sql`${documentStoreDocuments.metadata}->>'kind' = 'reported'`,
    inArray(sql`(${documentStoreDocuments.metadata}->>'status')`, [...OPEN_STATUSES]),
    inArray(
      sql`((${documentStoreDocuments.metadata}->>'platformEnvironmentId')::int)`,
      environmentIds,
    ),
    sql`${documentStoreDocuments.ownerUserId} IS NOT NULL`,
  );
}

async function listVisibleReportedIssueEnvironmentIds(): Promise<number[]> {
  const visibleEnvironments = await db
    .select({ id: platformProductEnvironments.id })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(visiblePlatform());
  return visibleEnvironments.map((row) => row.id);
}

async function expireAgedReportedIssueHomeItems(
  principal: Principal,
  environmentIds: number[],
  dismissedIds: Set<string>,
): Promise<void> {
  const owner = requireOwner(principal);
  const cutoff = new Date(Date.now() - AUTO_CLEAR_AFTER_MS);
  const aged = await db
    .select({ documentId: documentStoreDocuments.documentId })
    .from(documentStoreDocuments)
    .leftJoin(
      reportedIssueHomeDismissals,
      and(
        eq(reportedIssueHomeDismissals.issueId, documentStoreDocuments.documentId),
        combineWithVisibleScope(principal, dismissalScope),
      ),
    )
    .where(and(
      reportedIssueVisibilityPredicate(environmentIds),
      lt(documentStoreDocuments.createdAt, cutoff),
      isNull(reportedIssueHomeDismissals.id),
    ))
    .orderBy(documentStoreDocuments.createdAt)
    .limit(MAX_AUTO_CLEARS_PER_COLLECT);

  for (const row of aged) {
    const issueId = parseIssueId(row.documentId);
    if (!issueId || dismissedIds.has(String(issueId))) continue;
    await db
      .insert(reportedIssueHomeDismissals)
      .values({
        issueId: String(issueId),
        reasonKey: reportedIssueReasonKey(issueId),
        dismissedAt: new Date(),
        dismissedByUserId: owner.userId,
        createdByUserId: owner.userId,
        ...ownedInsertValues(principal, dismissalScope),
      })
      .onConflictDoNothing();
    dismissedIds.add(String(issueId));
  }
}

export async function listReportedIssueHomeItems(
  principal: Principal,
): Promise<ReportedIssueHomeItemRecord[]> {
  requireOwner(principal);
  if (!(await hasActiveBuildAccess(principal))) return [];
  if (!principalHasPermission(principal, "system:read")) return [];

  const environmentIds = await listVisibleReportedIssueEnvironmentIds();
  if (environmentIds.length === 0) return [];

  const dismissed = await db
    .select({ issueId: reportedIssueHomeDismissals.issueId })
    .from(reportedIssueHomeDismissals)
    .where(combineWithVisibleScope(principal, dismissalScope));
  const dismissedIds = new Set(dismissed.map((row) => row.issueId));
  await expireAgedReportedIssueHomeItems(principal, environmentIds, dismissedIds);

  const surfacedAfter = new Date(Date.now() - SURFACE_WINDOW_MS);
  const rows = await db
    .select({
      documentId: documentStoreDocuments.documentId,
      metadata: documentStoreDocuments.metadata,
      createdAt: documentStoreDocuments.createdAt,
      reporterUserId: documentStoreDocuments.ownerUserId,
      preferredName: userProfiles.preferredName,
      displayName: userProfiles.displayName,
      email: users.email,
    })
    .from(documentStoreDocuments)
    .innerJoin(users, eq(documentStoreDocuments.ownerUserId, users.id))
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .where(and(
      reportedIssueVisibilityPredicate(environmentIds),
      gte(documentStoreDocuments.createdAt, surfacedAfter),
    ))
    .orderBy(desc(documentStoreDocuments.createdAt))
    .limit(200);

  const items: ReportedIssueHomeItemRecord[] = [];
  for (const row of rows) {
    const issueId = parseIssueId(row.documentId);
    if (!issueId || dismissedIds.has(String(issueId))) continue;
    const metadata = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<string, unknown>;
    const title = typeof metadata.title === "string" && metadata.title.trim()
      ? metadata.title.trim()
      : `Issue ${issueId}`;
    const status = typeof metadata.status === "string" && metadata.status.trim()
      ? metadata.status.trim()
      : "open";
    const platformEnvironmentId = parseIssueId(metadata.platformEnvironmentId);
    if (!platformEnvironmentId || !environmentIds.includes(platformEnvironmentId)) continue;
    if (!row.reporterUserId) continue;

    const label = reporterLabel({
      preferredName: row.preferredName,
      displayName: row.displayName,
      email: row.email,
    });
    items.push({
      issueId,
      title,
      status,
      reporterUserId: row.reporterUserId,
      reporterLabel: label,
      platformEnvironmentId,
      createdAt: row.createdAt,
      userReference: createReferenceRef({
        type: "user",
        id: row.reporterUserId,
        metadata: { label, href: `/system?tab=users&user=${encodeURIComponent(row.reporterUserId)}` },
      }),
      issueReference: createReferenceRef({
        type: "issue",
        id: String(issueId),
        metadata: { label: title, href: `/issues/${encodeURIComponent(String(issueId))}` },
      }),
      reasonKey: reportedIssueReasonKey(issueId),
    });
    if (items.length >= MAX_HOME_REPORTED_ISSUES) break;
  }

  return items;
}

export async function dismissReportedIssueHomeItem(
  principal: Principal,
  issueId: number,
  reasonKey: string,
): Promise<boolean> {
  const owner = requireOwner(principal);
  const canonicalReasonKey = boundedText(reasonKey, 500);
  if (!Number.isInteger(issueId) || issueId <= 0 || !canonicalReasonKey) {
    throw new Error("issueId and reasonKey are required");
  }
  if (canonicalReasonKey !== reportedIssueReasonKey(issueId)) {
    throw new Error("Home item identity does not match reported Issue");
  }
  if (!(await hasActiveBuildAccess(principal))) return false;
  if (!principalHasPermission(principal, "system:read")) return false;

  const [existing] = await db
    .select({ id: reportedIssueHomeDismissals.id })
    .from(reportedIssueHomeDismissals)
    .where(combineWithVisibleScope(
      principal,
      dismissalScope,
      eq(reportedIssueHomeDismissals.issueId, String(issueId)),
    ))
    .limit(1);
  if (existing) return true;

  const [inserted] = await db
    .insert(reportedIssueHomeDismissals)
    .values({
      issueId: String(issueId),
      reasonKey: canonicalReasonKey,
      dismissedAt: new Date(),
      dismissedByUserId: owner.userId,
      createdByUserId: owner.userId,
      ...ownedInsertValues(principal, dismissalScope),
    })
    .onConflictDoNothing()
    .returning({ id: reportedIssueHomeDismissals.id });
  return Boolean(inserted) || true;
}
