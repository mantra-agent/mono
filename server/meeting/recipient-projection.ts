import { createHash } from "crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { invitedSubjects, meetingRecapDistributions, objectGrants, tasks, users } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import type {
  RecipientRecapProjection,
  RecipientRecapTaskProjection,
} from "@shared/meeting-recipient-recap";
import type { MeetingSessionMeta } from "@shared/models/chat";
import type { PriorityLevel, TaskStatus } from "@shared/models/work";
import { db, hasAmbientDatabaseTransaction } from "../db";
import { normalizeEmailAddress } from "../email-normalization";
import { chatStorage } from "../integrations/chat/storage";
import { peopleStorage } from "../people-storage";
import { createNamedSystemPrincipal } from "../principal";
import { combineWithVisibleScope } from "../scoped-storage";
import { requireCurrentPrincipal, runWithPrincipal } from "../principal-context";
import { resolveMeetingTransportSession, runWithMeetingOwnerPrincipal } from "./owner-principal";
import { stripPrivateAgendaFromRecap } from "./recap-content";

const MAX_RECIPIENT_TASKS = 100;

const recapPageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export interface DistributionCapability {
  distributionId: string;
  sessionId: string;
  ownerUserId: string | null;
  accountId: string | null;
  attendeeEmail: string;
  accessExpiresAt: Date;
}

export interface RecipientSharedParticipant {
  name: string;
  email: string;
}

export interface RecipientRecapMaterializationSource {
  capability: DistributionCapability;
  projection: RecipientRecapProjection;
  participants: RecipientSharedParticipant[];
}

type SecuritySubject =
  | { subjectType: "user"; subjectId: string }
  | { subjectType: "invited_subject"; subjectId: string };

function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function resolveSecuritySubject(email: string): Promise<SecuritySubject | null> {
  const normalizedEmail = normalizeEmailAddress(email);
  const [invited] = await db.select({
    id: invitedSubjects.id,
    claimedByUserId: invitedSubjects.claimedByUserId,
  }).from(invitedSubjects).where(eq(invitedSubjects.normalizedEmail, normalizedEmail)).limit(1);
  if (invited) {
    return invited.claimedByUserId
      ? { subjectType: "user", subjectId: invited.claimedByUserId }
      : { subjectType: "invited_subject", subjectId: invited.id };
  }
  const [user] = await db.select({ id: users.id }).from(users)
    .where(sql`LOWER(BTRIM(${users.email})) = ${normalizedEmail}`)
    .limit(1);
  return user ? { subjectType: "user", subjectId: user.id } : null;
}

async function loadGrantedTasks(
  subject: SecuritySubject,
  meetingId: string,
): Promise<RecipientRecapTaskProjection[]> {
  const rows = await db.select({
    title: tasks.title,
    description: tasks.description,
    status: tasks.status,
    priority: tasks.priority,
    deadline: tasks.deadline,
    completedAt: tasks.completedAt,
  }).from(objectGrants).innerJoin(
    tasks,
    eq(objectGrants.objectId, sql`${tasks.id}::text`),
  ).where(and(
    eq(objectGrants.subjectType, subject.subjectType),
    eq(objectGrants.subjectId, subject.subjectId),
    eq(objectGrants.objectType, "task"),
    eq(objectGrants.originType, "meeting"),
    eq(objectGrants.originId, meetingId),
    isNull(objectGrants.revokedAt),
  )).orderBy(tasks.createdAt).limit(MAX_RECIPIENT_TASKS);

  return rows.map((row) => ({
    title: row.title,
    description: row.description,
    status: (row.status === "push" ? "on_hold" : row.status) as TaskStatus,
    priority: row.priority as PriorityLevel,
    deadline: row.deadline,
    completedAt: row.completedAt?.toISOString() ?? null,
  }));
}

async function loadRecapContent(meeting: MeetingSessionMeta): Promise<RecipientRecapProjection["recap"] | null> {
  const recap = meeting.recap;
  if (!recap || recap.status !== "ready" || !recap.pageId) return null;
  const [page] = await db.select({ plainTextContent: libraryPages.plainTextContent })
    .from(libraryPages)
    .where(combineWithVisibleScope(
      requireCurrentPrincipal(),
      recapPageScopeColumns,
      eq(libraryPages.id, recap.pageId),
    ))
    .limit(1);
  const markdown = stripPrivateAgendaFromRecap(page?.plainTextContent.trim() ?? "");
  if (!markdown) return null;
  return {
    summary: sectionContent(markdown, "Summary"),
    decisions: sectionItems(markdown, "Key Decisions"),
    openQuestions: sectionItems(markdown, "Open Questions"),
    actionItems: sectionItems(markdown, "Action Items"),
  };
}

async function projectRecipientRecap(
  capability: DistributionCapability,
): Promise<RecipientRecapMaterializationSource | null> {
  if (!capability.ownerUserId || !capability.accountId) return null;
  return runWithPrincipal(
    createNamedSystemPrincipal("recipient-recap-source", ["system:read"]),
    async () => {
      const session = await resolveMeetingTransportSession(capability.sessionId);
      const meeting = session?.meeting;
      if (!meeting
        || meeting.ownerUserId !== capability.ownerUserId
        || meeting.principalAccountId !== capability.accountId) return null;

      return runWithMeetingOwnerPrincipal(meeting, async () => {
        const recap = await loadRecapContent(meeting);
        if (!recap) return null;
        const subject = await resolveSecuritySubject(capability.attendeeEmail);
        const grantedTasks = subject
          ? await loadGrantedTasks(subject, capability.sessionId)
          : [];
        const sharedByEmail = new Map<string, RecipientSharedParticipant>();
        const addParticipant = (name: string | undefined, email: string | undefined) => {
          if (!email) return;
          const normalizedEmail = normalizeEmailAddress(email);
          if (!normalizedEmail || !normalizedEmail.includes("@")) return;
          sharedByEmail.set(normalizedEmail, {
            name: name?.trim() || normalizedEmail,
            email: normalizedEmail,
          });
        };
        addParticipant(undefined, capability.attendeeEmail);
        for (const participant of meeting.participants) {
          if (participant.calendarEmail) {
            addParticipant(participant.label, participant.calendarEmail);
            continue;
          }
          if (!participant.personId) continue;
          const person = await peopleStorage.getPerson(participant.personId);
          const email = person?.contactInfo
            .filter(contact => contact.type === "email")
            .map(contact => contact.value.trim())
            .find(value => value.includes("@"));
          addParticipant(person?.name || participant.label, email);
        }
        return {
          capability,
          projection: {
            meetingTitle: meeting.title?.trim() || meeting.recap?.pageTitle || "Meeting recap",
            startedAt: meeting.startedAt ?? meeting.eventStart ?? null,
            recap,
            tasks: grantedTasks,
            expiresAt: capability.accessExpiresAt.toISOString(),
          },
          participants: [...sharedByEmail.values()].slice(0, 100),
        };
      });
    },
  );
}

export async function getCurrentRecipientOnboardingRecapProjectionByMeeting(
  meetingSessionId: string,
): Promise<RecipientRecapProjection | null> {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId) return null;
  const [user] = await db.select({ email: users.email })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);
  if (!user?.email) return null;
  return getAuthenticatedOnboardingRecapProjectionByMeeting(meetingSessionId, user.email);
}

export async function getAuthenticatedOnboardingRecapProjectionByMeeting(
  meetingSessionId: string,
  authenticatedEmail: string,
): Promise<RecipientRecapProjection | null> {
  const normalizedMeetingSessionId = meetingSessionId.trim();
  if (!normalizedMeetingSessionId || normalizedMeetingSessionId.length > 128) return null;
  const normalizedEmail = normalizeEmailAddress(authenticatedEmail);
  const [distribution] = await db.select({
    distributionId: meetingRecapDistributions.id,
    sessionId: meetingRecapDistributions.sessionId,
    ownerUserId: meetingRecapDistributions.ownerUserId,
    accountId: meetingRecapDistributions.accountId,
    attendeeEmail: meetingRecapDistributions.attendeeEmail,
    accessExpiresAt: meetingRecapDistributions.accessExpiresAt,
  }).from(meetingRecapDistributions).where(and(
    eq(meetingRecapDistributions.sessionId, normalizedMeetingSessionId),
    sql`LOWER(BTRIM(${meetingRecapDistributions.attendeeEmail})) = ${normalizedEmail}`,
    sql`${meetingRecapDistributions.status} IN ('draft_created', 'sent')`,
    isNull(meetingRecapDistributions.accessRevokedAt),
    gt(meetingRecapDistributions.accessExpiresAt, new Date()),
  )).limit(1);
  if (!distribution?.accessExpiresAt) return null;
  const source = await projectRecipientRecap(distribution as DistributionCapability);
  return source?.projection ?? null;
}

export async function getLockedAuthenticatedRecapMaterializationSource(
  token: string,
  authenticatedEmail: string,
  recipientUserId: string,
): Promise<RecipientRecapMaterializationSource | null> {
  if (!hasAmbientDatabaseTransaction()) {
    throw new Error("Recipient recap materialization source requires an ambient transaction");
  }
  const normalizedToken = token.trim();
  if (!normalizedToken || normalizedToken.length > 200) return null;
  const normalizedEmail = normalizeEmailAddress(authenticatedEmail);
  const [distribution] = await db.select({
    distributionId: meetingRecapDistributions.id,
    sessionId: meetingRecapDistributions.sessionId,
    ownerUserId: meetingRecapDistributions.ownerUserId,
    accountId: meetingRecapDistributions.accountId,
    attendeeEmail: meetingRecapDistributions.attendeeEmail,
    accessExpiresAt: meetingRecapDistributions.accessExpiresAt,
  }).from(meetingRecapDistributions).innerJoin(users, and(
    eq(users.id, recipientUserId),
    sql`LOWER(BTRIM(${users.email})) = ${normalizedEmail}`,
  )).where(and(
    or(
      eq(meetingRecapDistributions.onboardingTokenHash, hashCapabilityToken(normalizedToken)),
      eq(meetingRecapDistributions.accessTokenHash, hashCapabilityToken(normalizedToken)),
    ),
    sql`LOWER(BTRIM(${meetingRecapDistributions.attendeeEmail})) = ${normalizedEmail}`,
    sql`${meetingRecapDistributions.status} IN ('draft_created', 'sent')`,
    isNull(meetingRecapDistributions.accessRevokedAt),
    gt(meetingRecapDistributions.accessExpiresAt, new Date()),
  )).limit(1).for("update");
  if (!distribution?.accessExpiresAt) return null;
  return projectRecipientRecap(distribution as DistributionCapability);
}

export async function getAuthenticatedOnboardingRecapMaterializationSource(
  token: string,
  authenticatedEmail: string,
): Promise<RecipientRecapMaterializationSource | null> {
  const normalizedToken = token.trim();
  if (!normalizedToken || normalizedToken.length > 200) return null;
  const normalizedEmail = normalizeEmailAddress(authenticatedEmail);
  const [distribution] = await db.select({
    distributionId: meetingRecapDistributions.id,
    sessionId: meetingRecapDistributions.sessionId,
    ownerUserId: meetingRecapDistributions.ownerUserId,
    accountId: meetingRecapDistributions.accountId,
    attendeeEmail: meetingRecapDistributions.attendeeEmail,
    accessExpiresAt: meetingRecapDistributions.accessExpiresAt,
  }).from(meetingRecapDistributions).where(and(
    or(
      eq(meetingRecapDistributions.onboardingTokenHash, hashCapabilityToken(normalizedToken)),
      eq(meetingRecapDistributions.accessTokenHash, hashCapabilityToken(normalizedToken)),
    ),
    sql`LOWER(BTRIM(${meetingRecapDistributions.attendeeEmail})) = ${normalizedEmail}`,
    sql`${meetingRecapDistributions.status} IN ('draft_created', 'sent')`,
    isNull(meetingRecapDistributions.accessRevokedAt),
    gt(meetingRecapDistributions.accessExpiresAt, new Date()),
  )).limit(1);
  if (!distribution?.accessExpiresAt) return null;
  return projectRecipientRecap(distribution as DistributionCapability);
}

export async function getAuthenticatedOnboardingRecapProjection(
  token: string,
  authenticatedEmail: string,
): Promise<RecipientRecapProjection | null> {
  const source = await getAuthenticatedOnboardingRecapMaterializationSource(token, authenticatedEmail);
  return source?.projection ?? null;
}

function sectionContent(markdown: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(`^##\\s+${escapedHeading}\\s*\\n+([\\s\\S]*?)(?=\\n##\\s+|$)`, "im"),
  );
  return match?.[1]
    ?.trim()
    .replace(/@(?:person|page|project|milestone|task):[^\s\])]+/g, "")
    .replace(/\n{3,}/g, "\n\n") ?? "";
}

function sectionItems(markdown: string, heading: string): string[] {
  const content = sectionContent(markdown, heading);
  if (!content || /^(?:[-*]\s*)?none\.?$/i.test(content.trim())) return [];
  const bullets = content
    .split("\n")
    .map((line) => line.match(/^[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((item): item is string => !!item && !/^none\.?$/i.test(item));
  return bullets.length > 0 ? bullets : [content.replace(/\s+/g, " ").trim()];
}
