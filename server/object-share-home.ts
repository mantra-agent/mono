import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { createReferenceRef, type ReferenceRef } from "@shared/references";
import {
  driveResources,
  libraryPages,
  milestones,
  objectGrants,
  objectShareHomeDismissals,
  projects,
  tasks,
  userProfiles,
  users,
  vaults,
} from "@shared/schema";
import { deriveUserFirstName } from "@shared/identity-name";
import type { Principal } from "./principal";
import { db } from "./db";
import {
  combineWithVisibleScope,
  ownedInsertValues,
  type ScopeColumns,
} from "./scoped-storage";
import type { GrantableObjectType } from "./object-grant-service";

const dismissalScope: ScopeColumns = {
  scope: objectShareHomeDismissals.scope,
  ownerUserId: objectShareHomeDismissals.ownerUserId,
  accountId: objectShareHomeDismissals.accountId,
};

const MAX_HOME_OBJECT_SHARES = 25;
const MAX_AUTO_CLEARS_PER_COLLECT = 50;
const SURFACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const AUTO_CLEAR_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface ObjectShareHomeItemRecord {
  grantId: number;
  objectType: GrantableObjectType;
  objectId: string;
  objectTitle: string;
  sharerUserId: string;
  sharerLabel: string;
  href: string | null;
  createdAt: Date;
  sentence: string;
  sharerReference: ReferenceRef | null;
  objectReference: ReferenceRef | null;
  reasonKey: string;
}

function requireOwner(principal: Principal): { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Object-share Home requires an authenticated user");
  }
  return { userId: principal.userId, accountId: principal.accountId };
}

function boundedText(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function sharerLabel(input: {
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
  }, "Someone");
}

export function objectShareReasonKey(grantId: number): string {
  return `object-share:${grantId}`;
}

export function objectShareSentence(sharerLabelText: string, objectTitle: string): string {
  return `${sharerLabelText} shared ${objectTitle} with you`;
}

export function objectShareHref(objectType: GrantableObjectType, objectId: string): string | null {
  switch (objectType) {
    case "library_page":
      return `/info#library?page=${encodeURIComponent(objectId)}`;
    case "project":
      return `/projects?project=${encodeURIComponent(objectId)}`;
    case "task":
      return `/projects?task=${encodeURIComponent(objectId)}`;
    case "milestone": {
      const [projectId, milestoneId] = objectId.split(":");
      if (!projectId || !milestoneId) return `/projects?project=${encodeURIComponent(projectId || objectId)}`;
      return `/projects?project=${encodeURIComponent(projectId)}&milestone=${encodeURIComponent(milestoneId)}`;
    }
    case "vault":
      return `/vaults`;
    case "drive_resource":
      return `/files?driveResource=${encodeURIComponent(objectId)}`;
    default:
      return null;
  }
}

export async function resolveObjectShareTitle(
  objectType: GrantableObjectType,
  objectId: string,
): Promise<string> {
  try {
    if (objectType === "library_page") {
      const [row] = await db
        .select({ title: libraryPages.title })
        .from(libraryPages)
        .where(eq(libraryPages.id, objectId))
        .limit(1);
      if (row?.title?.trim()) return row.title.trim();
      return "a page";
    }
    if (objectType === "project") {
      const id = Number(objectId);
      if (!Number.isInteger(id) || id <= 0) return "a project";
      const [row] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, id)).limit(1);
      if (row?.title?.trim()) return row.title.trim();
      return "a project";
    }
    if (objectType === "task") {
      const id = Number(objectId);
      if (!Number.isInteger(id) || id <= 0) return "a task";
      const [row] = await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, id)).limit(1);
      if (row?.title?.trim()) return row.title.trim();
      return "a task";
    }
    if (objectType === "milestone") {
      const [projectPart, milestonePart] = objectId.split(":");
      const projectId = Number(projectPart);
      const milestoneId = Number(milestonePart);
      if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(milestoneId) || milestoneId <= 0) {
        return "a milestone";
      }
      const [row] = await db
        .select({ name: milestones.name })
        .from(milestones)
        .where(and(eq(milestones.projectId, projectId), eq(milestones.id, milestoneId)))
        .limit(1);
      if (row?.name?.trim()) return row.name.trim();
      return "a milestone";
    }
    if (objectType === "vault") {
      const [row] = await db.select({ name: vaults.name }).from(vaults).where(eq(vaults.id, objectId)).limit(1);
      if (row?.name?.trim()) return row.name.trim();
      return "a vault";
    }
    if (objectType === "drive_resource") {
      const [row] = await db
        .select({ name: driveResources.name })
        .from(driveResources)
        .where(eq(driveResources.id, objectId))
        .limit(1);
      if (row?.name?.trim()) return row.name.trim();
      return "a file";
    }
  } catch {
    // Title resolution is best-effort for notices; never fail the grant path.
  }
  return "an item";
}

export async function resolveSharerLabel(userId: string): Promise<string> {
  try {
    const [row] = await db
      .select({
        preferredName: userProfiles.preferredName,
        displayName: userProfiles.displayName,
        email: users.email,
      })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return "Someone";
    return sharerLabel(row);
  } catch {
    return "Someone";
  }
}

async function expireAgedObjectShareHomeItems(
  principal: Principal,
  dismissedIds: Set<string>,
): Promise<void> {
  const owner = requireOwner(principal);
  const cutoff = new Date(Date.now() - AUTO_CLEAR_AFTER_MS);
  const aged = await db
    .select({ id: objectGrants.id })
    .from(objectGrants)
    .leftJoin(
      objectShareHomeDismissals,
      and(
        eq(objectShareHomeDismissals.grantId, sql`${objectGrants.id}::text`),
        combineWithVisibleScope(principal, dismissalScope),
      ),
    )
    .where(and(
      eq(objectGrants.subjectType, "user"),
      eq(objectGrants.subjectId, owner.userId),
      eq(objectGrants.originType, "manual"),
      isNull(objectGrants.revokedAt),
      lt(objectGrants.createdAt, cutoff),
      isNull(objectShareHomeDismissals.id),
    ))
    .orderBy(objectGrants.createdAt)
    .limit(MAX_AUTO_CLEARS_PER_COLLECT);

  for (const row of aged) {
    const grantId = String(row.id);
    if (dismissedIds.has(grantId)) continue;
    await db
      .insert(objectShareHomeDismissals)
      .values({
        grantId,
        reasonKey: objectShareReasonKey(row.id),
        dismissedAt: new Date(),
        dismissedByUserId: owner.userId,
        createdByUserId: owner.userId,
        ...ownedInsertValues(principal, dismissalScope),
      })
      .onConflictDoNothing();
    dismissedIds.add(grantId);
  }
}

export async function listObjectShareHomeItems(
  principal: Principal,
): Promise<ObjectShareHomeItemRecord[]> {
  const owner = requireOwner(principal);

  const dismissed = await db
    .select({ grantId: objectShareHomeDismissals.grantId })
    .from(objectShareHomeDismissals)
    .where(combineWithVisibleScope(principal, dismissalScope));
  const dismissedIds = new Set(dismissed.map((row) => row.grantId));
  await expireAgedObjectShareHomeItems(principal, dismissedIds);

  const surfacedAfter = new Date(Date.now() - SURFACE_WINDOW_MS);
  const rows = await db
    .select({
      id: objectGrants.id,
      objectType: objectGrants.objectType,
      objectId: objectGrants.objectId,
      grantedByUserId: objectGrants.grantedByUserId,
      createdAt: objectGrants.createdAt,
      preferredName: userProfiles.preferredName,
      displayName: userProfiles.displayName,
      email: users.email,
    })
    .from(objectGrants)
    .leftJoin(users, eq(users.id, objectGrants.grantedByUserId))
    .leftJoin(userProfiles, eq(userProfiles.userId, objectGrants.grantedByUserId))
    .where(and(
      eq(objectGrants.subjectType, "user"),
      eq(objectGrants.subjectId, owner.userId),
      eq(objectGrants.originType, "manual"),
      isNull(objectGrants.revokedAt),
      gte(objectGrants.createdAt, surfacedAfter),
    ))
    .orderBy(desc(objectGrants.createdAt))
    .limit(200);

  const items: ObjectShareHomeItemRecord[] = [];
  for (const row of rows) {
    const grantId = String(row.id);
    if (dismissedIds.has(grantId)) continue;
    const objectType = row.objectType as GrantableObjectType;
    const objectTitle = await resolveObjectShareTitle(objectType, row.objectId);
    const label = sharerLabel({
      preferredName: row.preferredName,
      displayName: row.displayName,
      email: row.email,
    });
    const href = objectShareHref(objectType, row.objectId);
    const sentence = objectShareSentence(label, objectTitle);
    const objectReference = objectReferenceFor(objectType, row.objectId, objectTitle, href);
    items.push({
      grantId: row.id,
      objectType,
      objectId: row.objectId,
      objectTitle,
      sharerUserId: row.grantedByUserId,
      sharerLabel: label,
      href,
      createdAt: row.createdAt,
      sentence,
      sharerReference: createReferenceRef({
        type: "user",
        id: row.grantedByUserId,
        metadata: { label },
      }),
      objectReference,
      reasonKey: objectShareReasonKey(row.id),
    });
    if (items.length >= MAX_HOME_OBJECT_SHARES) break;
  }
  return items;
}

function objectReferenceFor(
  objectType: GrantableObjectType,
  objectId: string,
  title: string,
  href: string | null,
): ReferenceRef | null {
  const metadata = { label: title, ...(href ? { href } : {}) };
  try {
    if (objectType === "library_page") {
      return createReferenceRef({ type: "page", id: objectId, metadata });
    }
    if (objectType === "project") {
      return createReferenceRef({ type: "project", id: objectId, metadata });
    }
    if (objectType === "task") {
      return createReferenceRef({ type: "task", id: objectId, metadata });
    }
    if (objectType === "milestone") {
      const [projectId, milestoneId] = objectId.split(":");
      if (projectId && milestoneId) {
        return createReferenceRef({ type: "milestone", id: `${projectId}~${milestoneId}`, metadata });
      }
    }
    if (objectType === "drive_resource") {
      return createReferenceRef({ type: "file", id: objectId, metadata });
    }
  } catch {
    return null;
  }
  return null;
}

export async function dismissObjectShareHomeItem(
  principal: Principal,
  grantId: number,
  reasonKey: string,
): Promise<boolean> {
  const owner = requireOwner(principal);
  const canonicalReasonKey = boundedText(reasonKey, 500);
  if (!Number.isInteger(grantId) || grantId <= 0 || !canonicalReasonKey) {
    throw new Error("grantId and reasonKey are required");
  }
  if (canonicalReasonKey !== objectShareReasonKey(grantId)) {
    throw new Error("Home item identity does not match object share");
  }

  const [grant] = await db
    .select({ id: objectGrants.id, subjectId: objectGrants.subjectId, subjectType: objectGrants.subjectType })
    .from(objectGrants)
    .where(eq(objectGrants.id, grantId))
    .limit(1);
  if (!grant || grant.subjectType !== "user" || grant.subjectId !== owner.userId) {
    return false;
  }

  const [existing] = await db
    .select({ id: objectShareHomeDismissals.id })
    .from(objectShareHomeDismissals)
    .where(combineWithVisibleScope(
      principal,
      dismissalScope,
      eq(objectShareHomeDismissals.grantId, String(grantId)),
    ))
    .limit(1);
  if (existing) return true;

  await db
    .insert(objectShareHomeDismissals)
    .values({
      grantId: String(grantId),
      reasonKey: canonicalReasonKey,
      dismissedAt: new Date(),
      dismissedByUserId: owner.userId,
      createdByUserId: owner.userId,
      ...ownedInsertValues(principal, dismissalScope),
    })
    .onConflictDoNothing();
  return true;
}
