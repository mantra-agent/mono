/**
 * Meeting recap distribution (M2 post-finalization side effect).
 *
 * Called after `finalizeMeetingSession` marks `recap.status = "ready"`.
 * Resolves eligible attendee emails, creates Gmail drafts (or falls back to
 * SendGrid direct), records per-attendee rows in `meeting_recap_distributions`,
 * and updates the session's `MeetingRecapMeta` with the distribution lifecycle.
 *
 * This module never throws. Every failure is logged and recorded per-attendee
 * so the recap lifecycle is never blocked.
 *
 * Pattern note (new in this feature):
 *   - `meeting_recap_distributions` uses the standard `ownedInsertValues` +
 *     `visibleScopePredicate` pattern from `scoped-storage.ts`.
 *   - Distribution is a background side-effect: it fires via `setImmediate`
 *     from `recap.ts` and runs inside the same `runWithPrincipal` context so
 *     all writes are user-owned, not system orphans.
 */
import { db } from "../db";
import { meetingRecapDistributions } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import {
  combineWithVisibleScope,
  ownedInsertValues,
  visibleScopePredicate,
  writableScopePredicate,
} from "../scoped-storage";
import { emailDraftStorage } from "../email-draft-storage";
import { sendNotification } from "../notifications";
import { listGmailAccounts, type GmailAccount } from "../gmail";
import type { CalendarEvent } from "../google-calendar";
import { formatInTimezone } from "../timezone";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import { eventBus } from "../event-bus";
import { eq, and, SQL } from "drizzle-orm";
import type { Principal } from "../principal";
import type { MeetingSessionMeta, MeetingRecapMeta } from "@shared/models/chat";

const log = createLogger("MeetingDistribution");

const scopeColumns = {
  scope: meetingRecapDistributions.scope,
  ownerUserId: meetingRecapDistributions.ownerUserId,
  accountId: meetingRecapDistributions.accountId,
};

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

// Bound the compact, editable recap email body.
const EMAIL_BODY_CHAR_LIMIT = 30_000;

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Distribute a completed meeting recap to external attendees.
 * Called after recap.status = "ready". Never throws.
 * 
 * CHANGE 3: Trap principal mismatch early to detect ALS leaks.
 */
export async function distributeRecap(
  sessionId: string,
  meeting: MeetingSessionMeta,
  recap: MeetingRecapMeta,
  principal: Principal,
  options: { retryFailed?: boolean } = {},
): Promise<void> {
  // CHANGE 3: Verify principal context is correct (trap ALS leaks)
  try {
    const { getCurrentPrincipal } = await import("../principal-context");
    const ambientPrincipal = getCurrentPrincipal();
    if (!ambientPrincipal) {
      log.warn(
        `TRAP: No principal in ALS for distribution session ${sessionId}. ` +
        `Using parameter principal=${principal.userId}. This indicates a boundary violation.`
      );
      // Continue but flag it for monitoring
    } else if (ambientPrincipal.userId !== principal.userId) {
      throw new Error(
        `Principal mismatch: parameter=${principal.userId}, ambient=${ambientPrincipal.userId}`
      );
    }
  } catch (trapErr) {
    log.error(
      `TRAP failed for session ${sessionId}: ` +
      `${trapErr instanceof Error ? trapErr.message : String(trapErr)}. Proceeding with parameter principal.`
    );
  }

  log.info(`Starting recap distribution for session ${sessionId}`);

  try {
    // Idempotency guard: drafted/sent work is immutable. Explicit retry only
    // clears failed rows so the same canonical path can recreate drafts.
    const existing = await db
      .select({
        id: meetingRecapDistributions.id,
        status: meetingRecapDistributions.status,
        draftId: meetingRecapDistributions.draftId,
      })
      .from(meetingRecapDistributions)
      .where(
        and(
          eq(meetingRecapDistributions.sessionId, sessionId),
          visibleScopePredicate(principal, scopeColumns) as SQL,
        ),
      );

    const hasCompletedOrPending = existing.some((row) => row.status !== "failed");
    if (hasCompletedOrPending) {
      const existingDraftIds = [...new Set(
        existing
          .map((row) => row.draftId)
          .filter((draftId): draftId is string => !!draftId),
      )];
      await surfaceRecapDraftsInline(sessionId, existingDraftIds);
      log.debug(`Distribution already started for session ${sessionId}; ensured inline draft surface`);
      return;
    }
    if (existing.length > 0 && !options.retryFailed) {
      log.debug(`Distribution failed for session ${sessionId}; explicit retry required`);
      return;
    }
    if (existing.length > 0) {
      await db
        .delete(meetingRecapDistributions)
        .where(
          and(
            eq(meetingRecapDistributions.sessionId, sessionId),
            eq(meetingRecapDistributions.status, "failed"),
            writableScopePredicate(principal, scopeColumns) as SQL,
          ),
        );
    }

    await runDistribution(sessionId, meeting, recap, principal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Recap distribution outer failure for session ${sessionId}: ${msg}`);
    await chatStorage
      .updateMeetingMeta(sessionId, {
        recap: { ...recap, distributionStatus: "failed", distributionError: msg.slice(0, 500) },
      })
      .catch((e) =>
        log.error(`Failed to persist distribution failure for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`),
      );
  }
}

async function markDistributionBlocked(
  sessionId: string,
  recap: MeetingRecapMeta,
  principal: Principal,
  attendees: ResolvedAttendee[],
  detail: string,
  reason: string,
): Promise<void> {
  for (const attendee of attendees) {
    const owned = ownedInsertValues(principal, scopeColumns);
    await db
      .insert(meetingRecapDistributions)
      .values({
        sessionId,
        attendeeEmail: attendee.email,
        attendeeName: attendee.name ?? null,
        isMantraUser: false,
        sendMethod: "blocked",
        status: "failed",
        error: detail,
        ...owned,
      })
      .onConflictDoNothing();
  }
  await chatStorage.updateMeetingMeta(sessionId, {
    recap: {
      ...recap,
      distributionStatus: "blocked",
      distributionError: detail,
      draftIds: [],
    },
  });
  eventBus.publish({
    category: "agent",
    event: "meeting:recap_distribution_blocked",
    payload: { sessionId, reason, attendeeCount: attendees.length },
  });
}

// ─── Core distribution logic ─────────────────────────────────────────────────

async function runDistribution(
  sessionId: string,
  meeting: MeetingSessionMeta,
  recap: MeetingRecapMeta,
  principal: Principal,
): Promise<void> {
  // 1. Mark in-progress so MeetingHeaderBar can show spinner.
  await chatStorage.updateMeetingMeta(sessionId, {
    recap: { ...recap, distributionStatus: "drafting" },
  });

  // 2. Resolve the exact calendar event and its organizer-owned Gmail account.
  // Gmail sends as the authenticated account; array order is never sender authority.
  const emailContext = await resolveMeetingEmailContext(meeting);
  const attendees = emailContext
    ? await resolveRecipients(meeting, emailContext.event, emailContext.organizerAccount.email)
    : [];

  if (!emailContext) {
    log.warn(`Meeting organizer Gmail account could not be resolved for session ${sessionId}; blocking distribution`);
    await markDistributionBlocked(
      sessionId,
      recap,
      principal,
      [],
      "Meeting organizer Gmail account is not connected",
      "organizer_gmail_not_connected",
    );
    return;
  }

  if (attendees.length === 0) {
    log.warn(`No calendar invitees resolved for session ${sessionId}; blocking distribution`);
    await markDistributionBlocked(
      sessionId,
      recap,
      principal,
      [],
      "Meeting invitees could not be resolved from the calendar event",
      "calendar_invitees_not_resolved",
    );
    return;
  }

  log.info(
    `Distributing recap for session ${sessionId} from organizerAccount=${emailContext.organizerAccount.id} to ${attendees.length} attendee(s)`,
  );

  // 3. The authenticated organizer Gmail account is the sender. Never fall
  // back to another connected identity because that changes authorship.
  const gmailAccountId = emailContext.organizerAccount.id;

  // 4. Render the user-owned canonical Library recap into the editable draft.
  const subjectMeetingName = meeting.title?.trim() || recap.pageTitle?.replace(/^Meeting:\s*/i, "").trim() || "Our meeting";
  const subject = `Meeting recap: ${subjectMeetingName}`;
  const body = await buildEmailContent(recap, meeting, attendees, emailContext.event, principal);

  // 5. Record one tracking row per invitee, then create one editable draft
  // addressed to the complete invitee set. The draft is the human decision
  // surface; distribution rows preserve per-recipient provenance.
  const distributionRowIds: string[] = [];
  for (const attendee of attendees) {
    try {
      const owned = ownedInsertValues(principal, scopeColumns);
      const [row] = await db
        .insert(meetingRecapDistributions)
        .values({
          sessionId,
          attendeeEmail: attendee.email,
          attendeeName: attendee.name ?? null,
          isMantraUser: false,
          sendMethod: "gmail_draft",
          status: "pending",
          ...owned,
        })
        .returning();
      distributionRowIds.push(row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to record recap recipient ${attendee.email} (session=${sessionId}): ${msg}`);
    }
  }

  const draftIds: string[] = [];
  if (distributionRowIds.length > 0) {
    try {
      const draft = await emailDraftStorage.create(principal, {
        sessionId,
        gmailAccountId: gmailAccountId!,
        to: attendees.map((attendee) => attendee.email),
        subject,
        body,
        bodyFormat: "markdown",
      });
      await db
        .update(meetingRecapDistributions)
        .set({ draftId: draft.id, status: "draft_created", updatedAt: new Date() })
        .where(
          and(
            eq(meetingRecapDistributions.sessionId, sessionId),
            writableScopePredicate(principal, scopeColumns) as SQL,
          ),
        );
      draftIds.push(draft.id);
      log.debug(`Gmail recap draft created for ${attendees.length} invitee(s) (draftId=${draft.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Recap draft creation failed for session ${sessionId}: ${msg}`);
      await db
        .update(meetingRecapDistributions)
        .set({ status: "failed", error: msg.slice(0, 500), updatedAt: new Date() })
        .where(
          and(
            eq(meetingRecapDistributions.sessionId, sessionId),
            writableScopePredicate(principal, scopeColumns) as SQL,
          ),
        );
    }
  }

  // 6. Finalize session meta.
  await chatStorage.updateMeetingMeta(sessionId, {
    recap: { ...recap, distributionStatus: "ready", draftIds },
  });

  // 7. Surface the draft through the same canonical session-message
  // renderer used by Gmail draft and reply tool results.
  await surfaceRecapDraftsInline(sessionId, draftIds);

  // 8. Publish event for hooks/listeners.
  eventBus.publish({
    category: "agent",
    event: "meeting:recap_distributed",
    payload: { sessionId, draftCount: draftIds.length, attendeeCount: attendees.length },
  });

  log.info(
    `Recap distribution complete for session ${sessionId}: ${attendees.length} attendee(s), ${draftIds.length} draft(s)`,
  );
}

async function surfaceRecapDraftsInline(
  sessionId: string,
  draftIds: string[],
): Promise<void> {
  for (const draftId of draftIds) {
    const artifactKey = `meeting-recap-draft:${draftId}`;
    const result = await chatStorage.createAssistantArtifactMessageOnce(
      sessionId,
      `@email_draft:${draftId}`,
      artifactKey,
    );
    if (result.outcome === "session_not_found") {
      throw new Error(`Meeting session ${sessionId} disappeared while surfacing recap draft`);
    }
    log.debug(
      `Recap draft inline surface ${result.outcome} session=${sessionId} draftId=${draftId}`,
    );
  }
}

// ─── Attendee resolution ──────────────────────────────────────────────────────

interface ResolvedAttendee {
  email: string;
  name?: string;
}

interface MeetingEmailContext {
  event: CalendarEvent;
  organizerAccount: GmailAccount;
}

async function resolveMeetingEmailContext(
  meeting: MeetingSessionMeta,
): Promise<MeetingEmailContext | null> {
  if (!meeting.providerEventId || !meeting.calendarAccountId || !meeting.calendarId) {
    return null;
  }
  try {
    const { getEvent } = await import("../google-calendar");
    const event = await getEvent(
      meeting.calendarAccountId,
      meeting.calendarId,
      meeting.providerEventId,
    );
    const accounts = await listGmailAccounts();
    const organizerEmail = event.organizer?.email?.trim().toLowerCase();
    let organizerAccount = organizerEmail
      ? accounts.find((account) => account.email.trim().toLowerCase() === organizerEmail)
      : undefined;
    if (!organizerAccount && event.organizer?.self) {
      organizerAccount = accounts.find((account) => account.id === event.accountId);
    }
    if (!organizerAccount) {
      log.warn(
        `Calendar organizer has no connected Gmail account event=${event.id} calendarAccount=${event.accountId}`,
      );
      return null;
    }
    return { event, organizerAccount };
  } catch (error) {
    log.warn(
      `Meeting email context resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Resolve recap recipients from the exact calendar event invitee list.
 * Linked People enrich display names, while the event remains email authority.
 */
async function resolveRecipients(
  meeting: MeetingSessionMeta,
  event: CalendarEvent,
  organizerEmail: string,
): Promise<ResolvedAttendee[]> {
  const emailMap = new Map<string, ResolvedAttendee>();
  for (const invitee of event.attendees ?? []) {
    const normalized = invitee.email?.trim().toLowerCase();
    if (!normalized || !isValidEmail(normalized)) continue;
    emailMap.set(normalized, {
      email: normalized,
      name: invitee.displayName?.trim() || undefined,
    });
  }

  try {
    const { getMetadata, getLinkedPeople } = await import("../calendar-metadata");
    const meta = await getMetadata(
      meeting.providerEventId!,
      meeting.calendarAccountId!,
      meeting.calendarId!,
    );
    if (meta) {
      const people = await getLinkedPeople(meta.id);
      for (const person of people) {
        const normalized = person.attendeeEmail?.trim().toLowerCase();
        if (!normalized || !isValidEmail(normalized)) continue;
        const existing = emailMap.get(normalized);
        if (existing) {
          existing.name = person.personName?.trim() || existing.name;
        } else {
          emailMap.set(normalized, {
            email: normalized,
            name: person.personName?.trim() || undefined,
          });
        }
      }
    }
  } catch (error) {
    log.warn(
      `Calendar attendee enrichment failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const normalizedOrganizer = organizerEmail.trim().toLowerCase();
  if (isValidEmail(normalizedOrganizer) && !emailMap.has(normalizedOrganizer)) {
    emailMap.set(normalizedOrganizer, {
      email: normalizedOrganizer,
      name: event.organizer?.displayName?.trim() || undefined,
    });
  }

  return [...emailMap.values()];
}

// ─── Email content ────────────────────────────────────────────────────────────

async function buildEmailContent(
  recap: MeetingRecapMeta,
  meeting: MeetingSessionMeta,
  attendees: ResolvedAttendee[],
  event: CalendarEvent,
  principal: Principal,
): Promise<string> {
  if (!recap.pageId) throw new Error("Canonical recap page is missing");

  const [page] = await db
    .select({ plainTextContent: libraryPages.plainTextContent })
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        principal,
        libraryScopeColumns,
        eq(libraryPages.id, recap.pageId),
      ),
    )
    .limit(1);
  const storedRecap = page?.plainTextContent.trim();
  if (!storedRecap) {
    throw new Error(`Canonical recap page ${recap.pageId} has no content`);
  }

  const meetingName = meeting.title?.trim() || recap.pageTitle?.replace(/^Meeting:\s*/i, "").trim() || "Meeting";
  const startedAt = new Date(meeting.startedAt ?? meeting.eventStart ?? event.start.dateTime ?? event.start.date ?? "");
  const timeLabel = Number.isNaN(startedAt.getTime())
    ? "Time unavailable"
    : `${formatInTimezone(startedAt, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })} ${formatInTimezone(startedAt, { month: "short", day: "numeric", year: "numeric" })}`;
  const participantLine = attendees
    .map((attendee) => attendee.name
      ? `${attendee.name} <${attendee.email}>`
      : attendee.email)
    .join(", ");
  const organizerEmail = event.organizer?.email?.trim().toLowerCase();
  const greetingNames = [...new Set(
    attendees
      .filter((attendee) => attendee.email !== organizerEmail)
      .map((attendee) => firstName(attendee.name))
      .filter((name): name is string => !!name),
  )];
  const greeting = greetingNames.length > 0
    ? `Hi ${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(greetingNames)},`
    : "Hi,";

  const summary = sectionContent(storedRecap, "Summary");
  if (!summary) throw new Error("Canonical recap summary is missing");
  const sections = [
    { title: "KEY DECISIONS", items: sectionItems(storedRecap, "Key Decisions") },
    { title: "OPEN QUESTIONS", items: sectionItems(storedRecap, "Open Questions") },
    { title: "ACTION ITEMS", items: sectionItems(storedRecap, "Action Items") },
  ].filter((section) => section.items.length > 0);

  const blocks = [
    greeting,
    `**${meetingName}**\n- Time: ${timeLabel}\n- Participants: ${participantLine}`,
    summary,
    ...sections.map((section) =>
      `**${section.title}**\n${section.items.map((item) => `- ${item}`).join("\n")}`,
    ),
    "Details and Transcript Available at [trymantra.ai](https://www.trymantra.ai).",
  ];
  const body = blocks.join("\n\n");
  if (body.length > EMAIL_BODY_CHAR_LIMIT) {
    throw new Error(`Canonical recap exceeds the ${EMAIL_BODY_CHAR_LIMIT}-character email budget`);
  }
  return body;
}

function sectionContent(markdown: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(
    new RegExp(`^##\\s+${escapedHeading}\\s*\n+([\\s\\S]*?)(?=\n##\\s+|$)`, "im"),
  );
  return match?.[1]
    ?.trim()
    .replace(/@person:[A-Za-z0-9_-]+/g, "")
    .replace(/\n{3,}/g, "\n\n") ?? "";
}

function sectionItems(markdown: string, heading: string): string[] {
  const content = sectionContent(markdown, heading);
  if (!content || /^(?:[-*]\s*)?none\.?$/i.test(content.trim())) return [];
  const bulletItems = content
    .split("\n")
    .map((line) => line.match(/^[-*]\s+(.+)$/)?.[1]?.trim())
    .filter((item): item is string => !!item && !/^none\.?$/i.test(item));
  return bulletItems.length > 0 ? bulletItems : [content.replace(/\s+/g, " ").trim()];
}

function firstName(name: string | undefined): string | null {
  const normalized = name?.trim();
  if (!normalized) return null;
  return normalized.split(/\s+/)[0] || null;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
