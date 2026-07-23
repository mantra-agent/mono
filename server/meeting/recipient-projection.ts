import { createHash } from "crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { invitedSubjects, meetingRecapDistributions, objectGrants, tasks, users } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import type {
  RecipientRecapProjection,
  RecipientRecapTaskProjection,
} from "@shared/meeting-recipient-recap";
import type { MeetingSessionMeta } from "@shared/models/chat";
import type { PriorityLevel, TaskStatus } from "@shared/models/work";
import { db } from "../db";
import { normalizeEmailAddress } from "../email-normalization";
import { chatStorage } from "../integrations/chat/storage";
import { combineWithVisibleScope } from "../scoped-storage";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { resolveMeetingTransportSession, runWithMeetingOwnerPrincipal } from "./owner-principal";

const MAX_RECIPIENT_TASKS = 100;

const recapPageScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

interface DistributionCapability {
  sessionId: string;
  ownerUserId: string | null;
  accountId: string | null;
  attendeeEmail: string;
  accessExpiresAt: Date;
}

type SecuritySubject =
  | { subjectType: "user"; subjectId: string }
  | { subjectType: "invited_subject"; subjectId: string };

function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function resolveCapability(token: string): Promise<DistributionCapability | null> {
  const normalizedToken = token.trim();
  if (!normalizedToken || normalizedToken.length > 200) return null;
  const [distribution] = await db.select({
    sessionId: meetingRecapDistributions.sessionId,
    ownerUserId: meetingRecapDistributions.ownerUserId,
    accountId: meetingRecapDistributions.accountId,
    attendeeEmail: meetingRecapDistributions.attendeeEmail,
    accessExpiresAt: meetingRecapDistributions.accessExpiresAt,
  }).from(meetingRecapDistributions).where(and(
    eq(meetingRecapDistributions.accessTokenHash, hashCapabilityToken(normalizedToken)),
    sql`${meetingRecapDistributions.status} IN ('draft_created', 'sent')`,
    isNull(meetingRecapDistributions.accessRevokedAt),
    gt(meetingRecapDistributions.accessExpiresAt, new Date()),
  )).limit(1);
  if (!distribution?.accessExpiresAt) return null;
  return distribution as DistributionCapability;
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
      getCurrentPrincipalOrSystem(),
      recapPageScopeColumns,
      eq(libraryPages.id, recap.pageId),
    ))
    .limit(1);
  const markdown = page?.plainTextContent.trim();
  if (!markdown) return null;
  return {
    summary: sectionContent(markdown, "Summary"),
    decisions: sectionItems(markdown, "Key Decisions"),
    openQuestions: sectionItems(markdown, "Open Questions"),
    actionItems: sectionItems(markdown, "Action Items"),
  };
}

export async function getRecipientRecapProjection(
  token: string,
): Promise<RecipientRecapProjection | null> {
  const capability = await resolveCapability(token);
  if (!capability?.ownerUserId || !capability.accountId) return null;
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
    return {
      meetingTitle: meeting.title?.trim() || meeting.recap?.pageTitle || "Meeting recap",
      startedAt: meeting.startedAt ?? meeting.eventStart ?? null,
      recap,
      tasks: grantedTasks,
      expiresAt: capability.accessExpiresAt.toISOString(),
    };
  });
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
