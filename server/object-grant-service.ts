import { and, eq, isNull } from "drizzle-orm";
import { milestones, objectGrants, privilegedAccessAudit, projects, tasks } from "@shared/schema";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, type DrizzleTx } from "./db";
import { createLogger } from "./log";
import { combineWithWorkObjectAccess, workObjectKey, type ObjectGrantCapability, type WorkObjectType } from "./object-grant-access";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import type { Principal } from "./principal";

const log = createLogger("ObjectGrantService");

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

export class ObjectGrantService {
  async grant(input: GrantObjectAccessInput): Promise<typeof objectGrants.$inferSelect> {
    const principal = getCurrentPrincipalOrSystem();
    requireGrantActor(principal);
    const subjectId = normalizeSubjectId(input.subjectId);
    const objectId = workObjectKey(input.objectType, input.objectId, input.projectId);

    const result = await db.transaction(async tx => {
      await acquireAdvisoryTransactionLock(
        tx,
        ADVISORY_LOCK_NS.OBJECT_GRANT,
        lockKey(input.objectType, objectId),
      );
      await assertTargetAdmin(tx, principal, input);

      const [active] = await tx.select().from(objectGrants).where(and(
        eq(objectGrants.subjectType, input.subjectType),
        eq(objectGrants.subjectId, subjectId),
        eq(objectGrants.objectType, input.objectType),
        eq(objectGrants.objectId, objectId),
        isNull(objectGrants.revokedAt),
      )).limit(1);

      const originId = input.originId?.trim() || null;
      let grant = active;
      const unchanged = active &&
        active.capability === input.capability &&
        active.originType === input.originType &&
        active.originId === originId;
      if (!unchanged) {
        if (active) {
          await tx.update(objectGrants).set({ revokedAt: new Date() }).where(eq(objectGrants.id, active.id));
        }
        [grant] = await tx.insert(objectGrants).values({
          subjectType: input.subjectType,
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
        subjectType: input.subjectType,
        subjectId,
        objectType: input.objectType,
        objectId,
        capability: input.capability,
        originType: input.originType,
        originId,
      });
      return grant;
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
    const subjectId = normalizeSubjectId(input.subjectId);
    const objectId = workObjectKey(input.objectType, input.objectId, input.projectId);

    const revoked = await db.transaction(async tx => {
      await acquireAdvisoryTransactionLock(
        tx,
        ADVISORY_LOCK_NS.OBJECT_GRANT,
        lockKey(input.objectType, objectId),
      );
      await assertTargetAdmin(tx, principal, input);
      const rows = await tx.update(objectGrants).set({ revokedAt: new Date() }).where(and(
        eq(objectGrants.subjectType, input.subjectType),
        eq(objectGrants.subjectId, subjectId),
        eq(objectGrants.objectType, input.objectType),
        eq(objectGrants.objectId, objectId),
        isNull(objectGrants.revokedAt),
      )).returning({ id: objectGrants.id });
      if (rows.length === 0) return false;
      await writeGrantAudit(tx, principal, "object_grant.revoked", {
        grantIds: rows.map(row => row.id),
        subjectType: input.subjectType,
        subjectId,
        objectType: input.objectType,
        objectId,
      });
      return true;
    });

    if (revoked) log.info("object grant revoked", { subjectType: input.subjectType, objectType: input.objectType, objectId });
    return revoked;
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
