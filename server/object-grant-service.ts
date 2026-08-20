import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { invitedSubjects, milestones, objectGrants, privilegedAccessAudit, projects, tasks, users } from "@shared/schema";
import { vaults } from "@shared/models/vaults";
import { driveResources } from "@shared/schema";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, type DrizzleTx } from "./db";
import { createLogger } from "./log";
import { combineWithWorkObjectAccess, workObjectKey, type ObjectGrantCapability, type WorkObjectType } from "./object-grant-access";
import { combineWithAuthorizedScope, ownedScopePredicate } from "./authorize";
import { libraryPages } from "@shared/models/info";
import { requireCurrentUserPrincipal } from "./principal-context";
import { resolveInvitedSubjectReferenceInTransaction, type ResolvedSecuritySubject } from "./invited-subject-service";
import type { Principal } from "./principal";

const log = createLogger("ObjectGrantService");
const MAX_MEETING_DEFAULT_GRANT_SUBJECTS = 500;
const RECENT_PEOPLE_LIMIT = 8;
const RECENT_PEOPLE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export interface RecentGrantPerson {
  subjectType: "user" | "invited_subject";
  subjectId: string;
  label: string;
  email: string | null;
  lastGrantedAt: string;
}

export type ObjectGrantSubjectType = "user" | "invited_subject" | "team" | "organization";
export type ObjectGrantOriginType = "meeting" | "manual";

/** Every object the canonical grant service can share. Library pages, vaults, and drive resources key on their text id. */
export type GrantableObjectType = WorkObjectType | "library_page" | "vault" | "drive_resource";

export interface ObjectGrantTarget {
  objectType: GrantableObjectType;
  objectId: number | string;
  projectId?: number;
}

export interface GrantObjectAccessInput extends ObjectGrantTarget {
  subjectType: ObjectGrantSubjectType;
  subjectId: string;
  capability: ObjectGrantCapability;
  originType: ObjectGrantOriginType;
  originId?: string | null;
}

export interface RevokeObjectAccessInput extends ObjectGrantTarget {
  subjectType: ObjectGrantSubjectType;
  subjectId: string;
}

export interface TaskAssignmentSubject {
  subjectType: ObjectGrantSubjectType;
  subjectId: string;
}

function requireGrantActor(principal: Principal): asserts principal is Principal & { userId: string } {
  if (principal.actorType !== "user" || !principal.userId) {
    throw Object.assign(new Error("Object grant mutation requires an authenticated user"), { status: 403 });
  }
}

function normalizeSubjectId(subjectId: string): string {
  const normalized = subjectId.trim();
  if (!normalized) throw new Error("Object grant subjectId is required");
  return normalized;
}

function normalizeOriginId(originId: string | null | undefined): string | null {
  return originId?.trim() || null;
}

function lockKey(objectType: GrantableObjectType, objectId: string): string {
  return `${objectType}:${objectId}`;
}

/** Resolve the grant `object_id` key for any grantable object. Library pages key on their text id. */
function grantObjectKey(objectType: GrantableObjectType, objectId: number | string, projectId?: number): string {
  if (objectType === "library_page" || objectType === "vault" || objectType === "drive_resource") {
    const id = String(objectId).trim();
    if (!id) throw new Error(`${objectType} grant requires an id`);
    return id;
  }
  return workObjectKey(objectType, Number(objectId), projectId);
}

const projectGrantColumns = {
  objectId: projects.id,
  scope: projects.scope,
  ownerUserId: projects.ownerUserId,
  accountId: projects.accountId,
  vaultId: projects.vaultId,
};
const taskGrantColumns = {
  objectId: tasks.id,
  scope: tasks.scope,
  ownerUserId: tasks.ownerUserId,
  accountId: tasks.accountId,
  vaultId: tasks.vaultId,
};
const milestoneGrantColumns = {
  objectId: milestones.id,
  projectId: milestones.projectId,
  scope: milestones.scope,
  ownerUserId: milestones.ownerUserId,
  accountId: milestones.accountId,
  vaultId: milestones.vaultId,
};
const libraryPageGrantColumns = {
  objectId: libraryPages.id,
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

async function assertTargetAdmin(
  tx: DrizzleTx,
  principal: Principal & { userId: string },
  target: ObjectGrantTarget,
): Promise<void> {
  let found = false;
  if (target.objectType === "library_page") {
    found = (await tx.select({ id: libraryPages.id }).from(libraryPages).where(
      combineWithAuthorizedScope(
        principal,
        ownedScopePredicate(principal, libraryPageGrantColumns, "admin"),
        "library_page",
        libraryPageGrantColumns,
        "admin",
        eq(libraryPages.id, String(target.objectId)),
      ),
    ).limit(1)).length > 0;
  } else if (target.objectType === "project") {
    found = (await tx.select({ id: projects.id }).from(projects).where(
      combineWithWorkObjectAccess(principal, projectGrantColumns, "project", "admin", eq(projects.id, target.objectId)),
    ).limit(1)).length > 0;
  } else if (target.objectType === "task") {
    found = (await tx.select({ id: tasks.id }).from(tasks).where(
      combineWithWorkObjectAccess(principal, taskGrantColumns, "task", "admin", eq(tasks.id, target.objectId)),
    ).limit(1)).length > 0;
  } else if (target.objectType === "vault") {
    // A vault is admin-able only by the account that owns it. Vault membership does not grant
    // sharing rights — ownership does. This is the root of the vault trust boundary.
    found = (await tx.select({ id: vaults.id }).from(vaults).where(
      and(eq(vaults.id, String(target.objectId)), eq(vaults.accountId, principal.accountId!)),
    ).limit(1)).length > 0;
  } else if (target.objectType === "drive_resource") {
    // A bound Drive file is admin-able only by the account that owns the binding. The binding is a
    // pointer; sharing it shares Mantra's row, not Google's ACL — Google access still rides drive.file.
    found = (await tx.select({ id: driveResources.id }).from(driveResources).where(
      and(eq(driveResources.id, String(target.objectId)), eq(driveResources.accountId, principal.accountId!)),
    ).limit(1)).length > 0;
  } else {
    if (!Number.isInteger(target.projectId) || (target.projectId ?? 0) <= 0) throw new Error("Milestone grants require projectId");
    found = (await tx.select({ id: milestones.id }).from(milestones).where(
      combineWithWorkObjectAccess(
        principal,
        milestoneGrantColumns,
        "milestone",
        "admin",
        and(eq(milestones.projectId, target.projectId!), eq(milestones.id, target.objectId)),
      ),
    ).limit(1)).length > 0;
  }
  if (!found) throw Object.assign(new Error("Object not found or admin access required"), { status: 403 });
}

async function writeGrantAudit(
  tx: DrizzleTx,
  principal: Principal,
  action: "object_grant.granted" | "object_grant.revoked" | "object_grant.object_revoked",
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(privilegedAccessAudit).values({
    actorType: principal.actorType,
    actorUserId: principal.userId,
    actorAccountId: principal.accountId,
    impersonatedUserId: null,
    impersonatedAccountId: null,
    action,
    reason: null,
    scopes: principal.scopes,
    metadata,
  });
}

interface GrantMutationResult {
  grant: typeof objectGrants.$inferSelect;
  /** True only when a new live row was inserted (not unchanged capability). */
  inserted: boolean;
}

async function grantInTransaction(
  tx: DrizzleTx,
  principal: Principal & { userId: string },
  input: GrantObjectAccessInput,
  preResolvedSubject?: ResolvedSecuritySubject,
): Promise<GrantMutationResult> {
  const resolvedSubject = preResolvedSubject ?? (input.subjectType === "invited_subject"
    ? await resolveInvitedSubjectReferenceInTransaction(tx, input.subjectId, { create: true })
    : { subjectType: input.subjectType, subjectId: normalizeSubjectId(input.subjectId) });
  const subjectType = resolvedSubject.subjectType;
  const subjectId = resolvedSubject.subjectId;
  const objectId = grantObjectKey(input.objectType, input.objectId, input.projectId);
  await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, lockKey(input.objectType, objectId));
  await assertTargetAdmin(tx, principal, input);

  const [active] = await tx.select().from(objectGrants).where(and(
    eq(objectGrants.subjectType, subjectType),
    eq(objectGrants.subjectId, subjectId),
    eq(objectGrants.objectType, input.objectType),
    eq(objectGrants.objectId, objectId),
    isNull(objectGrants.revokedAt),
  )).limit(1);

  const originId = normalizeOriginId(input.originId);
  let grant = active;
  let inserted = false;
  const unchanged = active &&
    active.capability === input.capability &&
    active.originType === input.originType &&
    active.originId === originId;
  if (!unchanged) {
    if (active) await tx.update(objectGrants).set({ revokedAt: new Date() }).where(eq(objectGrants.id, active.id));
    [grant] = await tx.insert(objectGrants).values({
      subjectType,
      subjectId,
      objectType: input.objectType,
      objectId,
      capability: input.capability,
      grantedByUserId: principal.userId,
      originType: input.originType,
      originId,
    }).returning();
    inserted = true;
  }

  if (!grant) throw new Error("Object grant mutation produced no active grant");
  await writeGrantAudit(tx, principal, "object_grant.granted", {
    grantId: grant.id,
    subjectType,
    subjectId,
    objectType: input.objectType,
    objectId,
    capability: input.capability,
    originType: input.originType,
    originId,
  });
  return { grant, inserted };
}

async function revokeInTransaction(
  tx: DrizzleTx,
  principal: Principal & { userId: string },
  input: RevokeObjectAccessInput,
  preResolvedSubject?: ResolvedSecuritySubject,
): Promise<boolean> {
  const resolvedSubject = preResolvedSubject ?? (input.subjectType === "invited_subject"
    ? await resolveInvitedSubjectReferenceInTransaction(tx, input.subjectId, { create: false })
    : { subjectType: input.subjectType, subjectId: normalizeSubjectId(input.subjectId) });
  const subjectType = resolvedSubject.subjectType;
  const subjectId = resolvedSubject.subjectId;
  const objectId = grantObjectKey(input.objectType, input.objectId, input.projectId);
  await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, lockKey(input.objectType, objectId));
  await assertTargetAdmin(tx, principal, input);
  const rows = await tx.update(objectGrants).set({ revokedAt: new Date() }).where(and(
    eq(objectGrants.subjectType, subjectType),
    eq(objectGrants.subjectId, subjectId),
    eq(objectGrants.objectType, input.objectType),
    eq(objectGrants.objectId, objectId),
    isNull(objectGrants.revokedAt),
  )).returning({ id: objectGrants.id });
  if (rows.length === 0) return false;
  await writeGrantAudit(tx, principal, "object_grant.revoked", {
    grantIds: rows.map(row => row.id),
    subjectType,
    subjectId,
    objectType: input.objectType,
    objectId,
  });
  return true;
}

export class ObjectGrantService {
  async grant(input: GrantObjectAccessInput): Promise<typeof objectGrants.$inferSelect> {
    const principal = requireCurrentUserPrincipal();
    requireGrantActor(principal);
    const result = await db.transaction(async tx => {
      const resolvedSubject = input.subjectType === "invited_subject"
        ? await resolveInvitedSubjectReferenceInTransaction(tx, input.subjectId, { create: true })
        : undefined;
      return grantInTransaction(tx, principal, input, resolvedSubject);
    });
    log.info("object grant granted", {
      grantId: result.grant.id,
      objectType: result.grant.objectType,
      objectId: result.grant.objectId,
      subjectType: result.grant.subjectType,
      capability: result.grant.capability,
      inserted: result.inserted,
    });
    // Notice hangs off new manual person inserts only — never meeting/task paths
    // (those call grantInTransaction directly) and never unchanged re-shares.
    if (
      result.inserted
      && result.grant.originType === "manual"
      && (result.grant.subjectType === "user" || result.grant.subjectType === "invited_subject")
    ) {
      void import("./object-share-notice")
        .then(({ notifyObjectShareRecipients }) => notifyObjectShareRecipients(result.grant))
        .catch((error) => {
          log.warn("object share notice dispatch failed", {
            grantId: result.grant.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    return result.grant;
  }

  async revoke(input: RevokeObjectAccessInput): Promise<boolean> {
    const principal = requireCurrentUserPrincipal();
    requireGrantActor(principal);
    const revoked = await db.transaction(async tx => {
      const resolvedSubject = input.subjectType === "invited_subject"
        ? await resolveInvitedSubjectReferenceInTransaction(tx, input.subjectId, { create: false })
        : undefined;
      return revokeInTransaction(tx, principal, input, resolvedSubject);
    });
    if (revoked) log.info("object grant revoked", { requestedSubjectType: input.subjectType, objectType: input.objectType, objectId: input.objectId });
    return revoked;
  }

  async list(target: ObjectGrantTarget): Promise<Array<typeof objectGrants.$inferSelect>> {
    const principal = requireCurrentUserPrincipal();
    requireGrantActor(principal);
    return db.transaction(async tx => {
      await assertTargetAdmin(tx, principal, target);
      const objectId = grantObjectKey(target.objectType, target.objectId, target.projectId);
      return tx.select().from(objectGrants).where(and(
        eq(objectGrants.objectType, target.objectType),
        eq(objectGrants.objectId, objectId),
        isNull(objectGrants.revokedAt),
      )).orderBy(objectGrants.createdAt);
    });
  }

  /**
   * Caller-scoped recent person subjects this user granted (any object).
   * Distinct subject, newest first, cap 8, window 90 days. Includes subjects
   * whose latest grant was later revoked. Never returns other users' grants.
   */
  async listRecentPeople(): Promise<RecentGrantPerson[]> {
    const principal = requireCurrentUserPrincipal();
    requireGrantActor(principal);
    const since = new Date(Date.now() - RECENT_PEOPLE_WINDOW_MS);
    const rows = await db
      .select({
        subjectType: objectGrants.subjectType,
        subjectId: objectGrants.subjectId,
        createdAt: objectGrants.createdAt,
      })
      .from(objectGrants)
      .where(and(
        eq(objectGrants.grantedByUserId, principal.userId),
        inArray(objectGrants.subjectType, ["user", "invited_subject"]),
        gte(objectGrants.createdAt, since),
      ))
      .orderBy(desc(objectGrants.createdAt))
      .limit(200);

    const seen = new Set<string>();
    const distinct: Array<{ subjectType: "user" | "invited_subject"; subjectId: string; createdAt: Date }> = [];
    for (const row of rows) {
      if (row.subjectType !== "user" && row.subjectType !== "invited_subject") continue;
      const key = `${row.subjectType}:${row.subjectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push({
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        createdAt: row.createdAt,
      });
      if (distinct.length >= RECENT_PEOPLE_LIMIT) break;
    }

    if (distinct.length === 0) return [];

    const userIds = distinct.filter((d) => d.subjectType === "user").map((d) => d.subjectId);
    const invitedIds = distinct.filter((d) => d.subjectType === "invited_subject").map((d) => d.subjectId);
    const userRows = userIds.length
      ? await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, userIds))
      : [];
    const invitedRows = invitedIds.length
      ? await db
          .select({
            id: invitedSubjects.id,
            label: invitedSubjects.displayLabel,
            email: invitedSubjects.normalizedEmail,
          })
          .from(invitedSubjects)
          .where(inArray(invitedSubjects.id, invitedIds))
      : [];
    const userMap = new Map(userRows.map((r) => [r.id, r]));
    const invitedMap = new Map(invitedRows.map((r) => [r.id, r]));

    return distinct.map((d) => {
      if (d.subjectType === "user") {
        const u = userMap.get(d.subjectId);
        return {
          subjectType: d.subjectType,
          subjectId: d.subjectId,
          label: u?.email ?? d.subjectId,
          email: u?.email ?? null,
          lastGrantedAt: d.createdAt.toISOString(),
        };
      }
      const s = invitedMap.get(d.subjectId);
      return {
        subjectType: d.subjectType,
        subjectId: d.subjectId,
        label: s?.label ?? s?.email ?? d.subjectId,
        email: s?.email ?? null,
        lastGrantedAt: d.createdAt.toISOString(),
      };
    });
  }

  async setTaskAssignmentInTransaction(
    tx: DrizzleTx,
    taskId: number,
    previous: TaskAssignmentSubject | null,
    next: TaskAssignmentSubject | null,
    origin: { originType: ObjectGrantOriginType; originId?: string | null },
  ): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    requireGrantActor(principal);
    const sameSubject = previous && next &&
      previous.subjectType === next.subjectType &&
      normalizeSubjectId(previous.subjectId) === normalizeSubjectId(next.subjectId);
    if (previous && !sameSubject) {
      await revokeInTransaction(tx, principal, {
        objectType: "task",
        objectId: taskId,
        subjectType: previous.subjectType,
        subjectId: previous.subjectId,
      });
    }
    if (next) {
      await grantInTransaction(tx, principal, {
        objectType: "task",
        objectId: taskId,
        subjectType: next.subjectType,
        subjectId: next.subjectId,
        capability: "write",
        originType: origin.originType,
        originId: origin.originId,
      }); // internal path — no recipient notice (manual Share only)
    }
  }

  async grantMeetingDefaultsInTransaction(
    tx: DrizzleTx,
    target: ObjectGrantTarget,
    meetingId: string,
  ): Promise<number> {
    const principal = requireCurrentUserPrincipal();
    requireGrantActor(principal);
    const normalizedMeetingId = normalizeOriginId(meetingId);
    if (!normalizedMeetingId) throw new Error("Meeting provenance requires an origin id");

    const subjects = await tx.selectDistinct({
      subjectType: objectGrants.subjectType,
      subjectId: objectGrants.subjectId,
    }).from(objectGrants).where(and(
      eq(objectGrants.objectType, "task"),
      eq(objectGrants.capability, "write"),
      eq(objectGrants.originType, "meeting"),
      eq(objectGrants.originId, normalizedMeetingId),
      isNull(objectGrants.revokedAt),
    )).limit(MAX_MEETING_DEFAULT_GRANT_SUBJECTS + 1);
    if (subjects.length > MAX_MEETING_DEFAULT_GRANT_SUBJECTS) {
      throw new Error(`Meeting ${normalizedMeetingId} exceeds the ${MAX_MEETING_DEFAULT_GRANT_SUBJECTS} subject grant budget`);
    }
    for (const subject of subjects) {
      await grantInTransaction(tx, principal, {
        ...target,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        capability: "read",
        originType: "meeting",
        originId: normalizedMeetingId,
      }); // meeting defaults stay silent
    }
    return subjects.length;
  }

  async revokeObjectGrantsInTransaction(tx: DrizzleTx, target: ObjectGrantTarget): Promise<number> {
    const principal = requireCurrentUserPrincipal();
    if (principal.actorType !== "user" && principal.actorType !== "system") {
      throw Object.assign(new Error("Object grant cleanup requires user or system authority"), { status: 403 });
    }
    const objectId = grantObjectKey(target.objectType, target.objectId, target.projectId);
    await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, lockKey(target.objectType, objectId));
    const rows = await tx.update(objectGrants).set({ revokedAt: new Date() }).where(and(
      eq(objectGrants.objectType, target.objectType),
      eq(objectGrants.objectId, objectId),
      isNull(objectGrants.revokedAt),
    )).returning({ id: objectGrants.id });
    if (rows.length > 0) {
      await writeGrantAudit(tx, principal, "object_grant.object_revoked", {
        grantIds: rows.map(row => row.id),
        objectType: target.objectType,
        objectId,
      });
    }
    return rows.length;
  }
}

export const objectGrantService = new ObjectGrantService();
