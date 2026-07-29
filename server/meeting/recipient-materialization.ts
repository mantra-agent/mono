import { sessionArtifacts } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { syncContentFields } from "@shared/markdown-tiptap";
import type { MeetingParticipant, MeetingSessionMeta } from "@shared/models/chat";
import type { RecipientRecapProjection } from "@shared/meeting-recipient-recap";
import {
  acquireAdvisoryTransactionLock,
  ADVISORY_LOCK_NS,
  db,
  runWithDatabaseTransaction,
} from "../db";
import { normalizeEmailAddress } from "../email-normalization";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import { peopleStorage } from "../people-storage";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { stripPrivateAgendaFromRecap } from "./recap-content";
import {
  getLockedAuthenticatedRecapMaterializationSource,
  type RecipientRecapMaterializationSource,
} from "./recipient-projection";

const log = createLogger("RecipientRecapMaterialization");

export interface RecipientRecapMaterializationResult {
  projection: RecipientRecapProjection;
  meetingSessionId: string;
  outcome: "created" | "existing";
}

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.map(item => `- ${item}`).join("\n") : "- None.";
}

function recipientRecapMarkdown(
  projection: RecipientRecapProjection,
  participants: MeetingParticipant[],
): string {
  const participantLine = participants.length > 0
    ? `**Participants:** ${participants.map(participant => `@person:${participant.personId}`).join(", ")}`
    : "";
  return stripPrivateAgendaFromRecap([
    participantLine,
    projection.startedAt ? `**Started:** ${projection.startedAt}` : "",
    `## Summary\n\n${projection.recap.summary}`,
    `## Key Decisions\n\n${listOrNone(projection.recap.decisions)}`,
    `## Open Questions\n\n${listOrNone(projection.recap.openQuestions)}`,
    `## Action Items\n\n${listOrNone(projection.recap.actionItems)}`,
  ].filter(Boolean).join("\n\n"));
}

async function materializeParticipants(
  source: RecipientRecapMaterializationSource,
): Promise<MeetingParticipant[]> {
  const participants: MeetingParticipant[] = [];
  for (const shared of source.participants) {
    const person = await peopleStorage.resolveOrCreateMeetingParticipant({
      ...shared,
      isSelf: normalizeEmailAddress(shared.email) === normalizeEmailAddress(source.capability.attendeeEmail),
    });
    participants.push({
      label: person.name,
      personId: person.id,
      calendarEmail: shared.email,
      calendarRole: normalizeEmailAddress(shared.email) === normalizeEmailAddress(source.capability.attendeeEmail)
        ? "attendee"
        : undefined,
      identitySource: "calendar",
      source: "participant_metadata",
    });
  }
  return participants;
}

export async function materializeAuthenticatedRecipientRecap(
  rawToken: string,
  authenticatedEmail: string,
): Promise<RecipientRecapMaterializationResult | null> {
  const principal = getCurrentPrincipalOrSystem();
  if (
    principal.actorType !== "user"
    || !principal.userId
    || !principal.accountId
    || !principal.activeVaultId
  ) return null;
  const normalizedAuthenticatedEmail = normalizeEmailAddress(authenticatedEmail);
  if (!normalizedAuthenticatedEmail || !normalizedAuthenticatedEmail.includes("@")) return null;

  return db.transaction(async transaction => runWithDatabaseTransaction(transaction, async () => {
    const source = await getLockedAuthenticatedRecapMaterializationSource(
      rawToken,
      normalizedAuthenticatedEmail,
      principal.userId,
    );
    if (!source) return null;
    await acquireAdvisoryTransactionLock(
      transaction,
      ADVISORY_LOCK_NS.RECIPIENT_RECAP,
      `${principal.accountId}:${principal.userId}:${source.capability.distributionId}`,
    );

    const participants = await materializeParticipants(source);
    const sessionKey = `recipient-recap:${source.capability.distributionId}`;
    const meetingSeed: MeetingSessionMeta = {
      title: source.projection.meetingTitle,
      participants,
      botStatus: "ended",
      startedAt: source.projection.startedAt ?? undefined,
      endedAt: source.projection.startedAt ?? undefined,
      vaultId: principal.activeVaultId,
      participationPolicy: "listen_only",
    };
    const meetingResult = await chatStorage.createMeetingSessionOnce(
      source.projection.meetingTitle,
      meetingSeed,
      sessionKey,
    );
    if (meetingResult.outcome === "existing") {
      return {
        projection: source.projection,
        meetingSessionId: meetingResult.session.id,
        outcome: "existing" as const,
      };
    }

    const meeting = meetingResult.session.meeting;
    if (!meeting?.libraryNodePageId) {
      throw new Error("Recipient Meeting projection has no canonical Library node");
    }
    const title = `Meeting: ${source.projection.meetingTitle.replace(/^Meeting:\s*/i, "")}`;
    const synced = syncContentFields({ markdown: recipientRecapMarkdown(source.projection, participants) });
    const [page] = await db.insert(libraryPages).values({
      title,
      slug: `recipient-recap-${source.capability.distributionId}`,
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      parentId: meeting.libraryNodePageId,
      tags: ["meeting", "recap", "recipient-claimed"],
      structuralRole: "artifact",
      createdBySessionId: meetingResult.session.id,
      scope: "user",
      ownerUserId: principal.userId,
      accountId: principal.accountId,
      vaultId: principal.activeVaultId,
      createdByUserId: principal.userId,
      updatedByUserId: principal.userId,
      surface: true,
      surfaceUntil: new Date(Date.now() + 48 * 60 * 60 * 1000),
      surfaceReason: `Claimed meeting recap: ${title}`,
      surfaceSection: "inbox",
    }).returning();
    if (!page) throw new Error("Recipient recap page creation produced no row");
    await db.insert(sessionArtifacts).values({
      sessionId: meetingResult.session.id,
      ownerUserId: principal.userId,
      accountId: principal.accountId,
      artifactType: "library_page",
      artifactId: page.slug,
      metadata: { title: page.title, pageId: page.id },
    }).onConflictDoNothing();
    await chatStorage.updateMeetingMeta(meetingResult.session.id, {
      recap: {
        status: "ready",
        pageId: page.id,
        pageSlug: page.slug,
        pageTitle: page.title,
        interactionsLogged: 0,
      },
      participants,
    });
    log.info("Recipient recap materialized", {
      distributionId: source.capability.distributionId,
      meetingSessionId: meetingResult.session.id,
      participantCount: participants.length,
    });
    return {
      projection: source.projection,
      meetingSessionId: meetingResult.session.id,
      outcome: "created" as const,
    };
  }));
}
