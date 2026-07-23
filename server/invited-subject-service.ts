import { and, eq, isNull, sql } from "drizzle-orm";
import { invitedSubjects, objectGrants, privilegedAccessAudit, tasks, type User } from "@shared/schema";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, type DrizzleTx } from "./db";
import { normalizeEmailAddress } from "./email-normalization";
import { getCurrentPrincipalOrSystem } from "./principal-context";

export type ResolvedSecuritySubject =
  | { subjectType: "user"; subjectId: string }
  | { subjectType: "invited_subject"; subjectId: string };

const CAPABILITY_RANK = { read: 1, write: 2, admin: 3 } as const;

function requireCreatorUserId(): string {
  const principal = getCurrentPrincipalOrSystem();
  if (principal.actorType !== "user" || !principal.userId) {
    throw Object.assign(new Error("Invited subject creation requires an authenticated user"), { status: 403 });
  }
  return principal.userId;
}

function labelForInvite(displayLabel: string | null | undefined, normalizedEmail: string): string {
  return displayLabel?.trim() || normalizedEmail;
}

export async function resolveOrCreateInvitedSubjectInTransaction(
  tx: DrizzleTx,
  email: string,
  displayLabel?: string | null,
): Promise<ResolvedSecuritySubject> {
  const normalizedEmail = normalizeEmailAddress(email);
  await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.INVITED_SUBJECT, normalizedEmail);

  const [existing] = await tx.select().from(invitedSubjects)
    .where(eq(invitedSubjects.normalizedEmail, normalizedEmail))
    .limit(1);
  if (existing?.claimedByUserId) {
    return { subjectType: "user", subjectId: existing.claimedByUserId };
  }
  if (existing) {
    return { subjectType: "invited_subject", subjectId: existing.id };
  }

  const [created] = await tx.insert(invitedSubjects).values({
    normalizedEmail,
    displayLabel: labelForInvite(displayLabel, normalizedEmail),
    createdByUserId: requireCreatorUserId(),
  }).returning();
  if (!created) throw new Error("Invited subject creation produced no row");
  return { subjectType: "invited_subject", subjectId: created.id };
}

export async function resolveInvitedSubjectReferenceInTransaction(
  tx: DrizzleTx,
  subjectIdOrEmail: string,
  options: { create: boolean; displayLabel?: string | null },
): Promise<ResolvedSecuritySubject> {
  const reference = subjectIdOrEmail.trim();
  if (!reference) throw new Error("Invited subject reference is required");
  if (reference.includes("@")) {
    if (options.create) {
      return resolveOrCreateInvitedSubjectInTransaction(tx, reference, options.displayLabel);
    }
    const normalizedEmail = normalizeEmailAddress(reference);
    const [subject] = await tx.select().from(invitedSubjects)
      .where(eq(invitedSubjects.normalizedEmail, normalizedEmail))
      .limit(1);
    if (!subject) throw new Error("Invited subject not found");
    return subject.claimedByUserId
      ? { subjectType: "user", subjectId: subject.claimedByUserId }
      : { subjectType: "invited_subject", subjectId: subject.id };
  }

  const [subject] = await tx.select().from(invitedSubjects)
    .where(eq(invitedSubjects.id, reference))
    .limit(1);
  if (!subject) throw new Error("Invited subject not found");
  return subject.claimedByUserId
    ? { subjectType: "user", subjectId: subject.claimedByUserId }
    : { subjectType: "invited_subject", subjectId: subject.id };
}

function strongerCapability(
  left: keyof typeof CAPABILITY_RANK,
  right: keyof typeof CAPABILITY_RANK,
): keyof typeof CAPABILITY_RANK {
  return CAPABILITY_RANK[left] >= CAPABILITY_RANK[right] ? left : right;
}

export async function claimInvitedSubjectInTransaction(
  tx: DrizzleTx,
  user: Pick<User, "id" | "email">,
): Promise<{ subjectId: string | null; reboundGrantCount: number; reboundAssignmentCount: number }> {
  const normalizedEmail = normalizeEmailAddress(user.email);
  await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.INVITED_SUBJECT, normalizedEmail);

  const [subject] = await tx.select().from(invitedSubjects)
    .where(eq(invitedSubjects.normalizedEmail, normalizedEmail))
    .limit(1);
  if (!subject) return { subjectId: null, reboundGrantCount: 0, reboundAssignmentCount: 0 };
  if (subject.claimedByUserId && subject.claimedByUserId !== user.id) {
    throw new Error("Invited subject email is already claimed by another user");
  }
  if (subject.claimedByUserId === user.id) {
    return { subjectId: subject.id, reboundGrantCount: 0, reboundAssignmentCount: 0 };
  }

  const liveInvitedGrants = await tx.select().from(objectGrants).where(and(
    eq(objectGrants.subjectType, "invited_subject"),
    eq(objectGrants.subjectId, subject.id),
    isNull(objectGrants.revokedAt),
  ));

  for (const invitedGrant of liveInvitedGrants) {
    await acquireAdvisoryTransactionLock(
      tx,
      ADVISORY_LOCK_NS.OBJECT_GRANT,
      `${invitedGrant.objectType}:${invitedGrant.objectId}`,
    );
    const [existingUserGrant] = await tx.select().from(objectGrants).where(and(
      eq(objectGrants.subjectType, "user"),
      eq(objectGrants.subjectId, user.id),
      eq(objectGrants.objectType, invitedGrant.objectType),
      eq(objectGrants.objectId, invitedGrant.objectId),
      isNull(objectGrants.revokedAt),
    )).limit(1);
    const capability = existingUserGrant
      ? strongerCapability(invitedGrant.capability, existingUserGrant.capability)
      : invitedGrant.capability;
    if (existingUserGrant) {
      await tx.update(objectGrants)
        .set({ revokedAt: sql`CURRENT_TIMESTAMP` })
        .where(eq(objectGrants.id, existingUserGrant.id));
    }
    await tx.update(objectGrants).set({
      subjectType: "user",
      subjectId: user.id,
      capability,
    }).where(eq(objectGrants.id, invitedGrant.id));
  }

  const reboundAssignments = await tx.update(tasks).set({
    assigneeSubjectType: "user",
    assigneeSubjectId: user.id,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }).where(and(
    eq(tasks.assigneeSubjectType, "invited_subject"),
    eq(tasks.assigneeSubjectId, subject.id),
  )).returning({ id: tasks.id });

  const claimedAt = subject.claimedAt ?? new Date();
  await tx.update(invitedSubjects).set({
    claimedByUserId: user.id,
    claimedAt,
  }).where(eq(invitedSubjects.id, subject.id));

  await tx.insert(privilegedAccessAudit).values({
    actorType: "user",
    actorUserId: user.id,
    actorAccountId: null,
    impersonatedUserId: null,
    impersonatedAccountId: null,
    action: "invited_subject.claimed",
    reason: "verified_registration_email_match",
    scopes: [],
    metadata: {
      invitedSubjectId: subject.id,
      reboundGrantCount: liveInvitedGrants.length,
      reboundAssignmentCount: reboundAssignments.length,
    },
  });

  return {
    subjectId: subject.id,
    reboundGrantCount: liveInvitedGrants.length,
    reboundAssignmentCount: reboundAssignments.length,
  };
}
