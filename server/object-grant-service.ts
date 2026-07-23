import { and, eq, isNull } from "drizzle-orm";
import { milestones, objectGrants, privilegedAccessAudit, projects, tasks } from "@shared/schema";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, type DrizzleTx } from "./db";
import { createLogger } from "./log";
import { combineWithWorkObjectAccess, workObjectKey, type ObjectGrantCapability, type WorkObjectType } from "./object-grant-access";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { resolveInvitedSubjectReferenceInTransaction, type ResolvedSecuritySubject } from "./invited-subject-service";
import type { Principal } from "./principal";

const log = createLogger("ObjectGrantService");
const MAX_MEETING_DEFAULT_GRANT_SUBJECTS = 500;

export type ObjectGrantSubjectType = "user" | "invited_subject";
export type ObjectGrantOriginType = "meeting" | "manual";

export interface ObjectGrantTarget {
  objectType: WorkObjectType;
  objectId: number;
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

function lockKey(objectType: WorkObjectType, objectId: string): string {
  return `${objectType}:${objectId}`;
}

const projectGrantColumns = {
  objectId: projects.id,
  scope: projects.scope,
  ownerUserId: projects.ownerUserId,
  accountId: projects.accountId,
};
const taskGrantColumns = {
  objectId: tasks.id,
  scope: tasks.scope,
  ownerUserId: tasks.ownerUserId,
  accountId: tasks.accountId,
};
const milestoneGrantColumns = {
  objectId: milestones.id,
  projectId: milestones.projectId,
  scope: milestones.scope,
  ownerUserId: milestones.ownerUserId,
  accountId: milestones.accountId,
};

async function assertTargetAdmin(
  tx: DrizzleTx,
  principal: Principal & { userId: string },
  target: ObjectGrantTarget,
): Promise<void> {
  let found = false;
  if (target.objectType === "project") {
    found = (await tx.select({ id: projects.id }).from(projects).where(
      combineWithWorkObjectAccess(principal, projectGrantColumns, "project", "admin", eq(projects.id, target.objectId)),
    ).limit(1)).length > 0;
  } else if (target.objectType === "task") {
    found = (await tx.select({ id: tasks.id }).from(tasks).where(
      combineWithWorkObjectAccess(principal, taskGrantColumns, "task", "admin", eq(tasks.id, target.objectId)),
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

async function grantInTransaction(
  tx: DrizzleTx,
  principal: Principal & { userId: string },
  input: GrantObjectAccessInput,
  preResolvedSubject?: ResolvedSecuritySubject,
): Promise<typeof objectGrants.$inferSelect> {
  const resolvedSubject = preResolvedSubject ?? (input.subjectType === "invited_subject"
    ? await resolveInvitedSubjectReferenceInTransaction(tx, input.subjectId, { create: true })
    : { subjectType: input.subjectType, subjectId: normalizeSubjectId(input.subjectId) });
  const subjectType = resolvedSubject.subjectType;
  const subjectId = resolvedSubject.subjectId;
  const objectId = workObjectKey(input.objectType, input.objectId, input.projectId);
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
  return grant;
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
  const objectId = workObjectKey(input.objectType, input.objectId, input.projectId);
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
    const principal = getCurrentPrincipalOrSystem();
    requireGrantActor(principal);
    const result = await db.transaction(async tx => {
      const resolvedSubject = input.subjectType === "invited_subject"
        ? await resolveInvitedSubjectReferenceInTransaction(tx, input.subjectId, { create: true })
        : undefined;
      return grantInTransaction(tx, principal, input, resolvedSubject);
    });
    log.info("object grant granted", {
      grantId: result.id,
      objectType: result.objectType,
      objectId: result.objectId,
      subjectType: result.subjectType,
      capability: result.capability,
    });
    return result;
  }

  async revoke(input: RevokeObjectAccessInput): Promise<boolean> {
    const principal = getCurrentPrincipalOrSystem();
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

  async setTaskAssignmentInTransaction(
    tx: DrizzleTx,
    taskId: number,
    previous: TaskAssignmentSubject | null,
    next: TaskAssignmentSubject | null,
    origin: { originType: ObjectGrantOriginType; originId?: string | null },
  ): Promise<void> {
    const principal = getCurrentPrincipalOrSystem();
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
      });
    }
  }

  async grantMeetingDefaultsInTransaction(
    tx: DrizzleTx,
    target: ObjectGrantTarget,
    meetingId: string,
  ): Promise<number> {
    const principal = getCurrentPrincipalOrSystem();
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
      });
    }
    return subjects.length;
  }

  async revokeObjectGrantsInTransaction(tx: DrizzleTx, target: ObjectGrantTarget): Promise<number> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "user" && principal.actorType !== "system") {
      throw Object.assign(new Error("Object grant cleanup requires user or system authority"), { status: 403 });
    }
    const objectId = workObjectKey(target.objectType, target.objectId, target.projectId);
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
