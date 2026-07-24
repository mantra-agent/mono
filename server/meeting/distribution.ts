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
import { createHash, randomBytes } from "crypto";
import { db, pool } from "../db";
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
import { getRuntimePublicBaseUrl } from "../runtime-identity";

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
const RECIPIENT_ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const LANDING_BASE_URL = "https://www.trymantra.ai";
const ONBOARDING_TOKEN_PARAM = "i";

interface MintedCapabilityToken {
  token: string;
  tokenHash: string;
}

interface RecipientAccessCapability extends MintedCapabilityToken {
  expiresAt: Date;
}

/** Single minting primitive for every per-recipient bearer token in recap flows. */
function mintCapabilityToken(): MintedCapabilityToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: createHash("sha256").update(token).digest("hex") };
}

function createRecipientAccessCapability(): RecipientAccessCapability {
  return {
    ...mintCapabilityToken(),
    expiresAt: new Date(Date.now() + RECIPIENT_ACCESS_TTL_MS),
  };
}

/**
 * Tokenized landing link for the recap email footer. The landing page routes
 * token holders into the voice-visualizer FTUE; a future onboarding resolver
 * binds the stored hash to a provisional account. Deliberately a separate
 * capability from the recap access token so the marketing URL never carries
 * meeting-content authority.
 */
function invitedLandingUrl(token: string): string {
  return `${LANDING_BASE_URL}/?${ONBOARDING_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

function recipientRecapUrl(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/recap/${encodeURIComponent(token)}`;
}

function distributionLockKey(sessionId: string): bigint {
  const hash = createHash("sha256").update(`meeting-recap-distribution:${sessionId}`).digest();
  let key = 0n;
  for (let index = 0; index < 8; index += 1) {
    key = (key << 8n) | BigInt(hash[index]);
  }
  return key & 0x7fffffffffffffffn;
}

async function withDistributionLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const key = distributionLockKey(sessionId);
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key.toString()]);
    return await operation();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
    } catch {
      log.warn(`Failed to release recap distribution lock session=${sessionId}`);
    }
    client.release();
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Distribute a completed meeting recap to external attendees.
 * Called after recap.status = "ready". Never throws.
 * 
 * CHANGE 3: Trap principal mismatch early to detect ALS leaks.
 */
export type RecapDistributionRecoveryOutcome =
  | "not_ready"
  | "not_failed"
  | "waiting_for_speaker_identity"
  | "retried";

/**
 * Recover a failed distribution after owner-authenticated speaker correction.
 * Wait for every stable speaker to have canonical identity so the first
 * successful draft cannot freeze partially corrected participant attribution.
 */
export async function recoverRecapDistributionAfterSpeakerResolution(
  sessionId: string,
  meeting: MeetingSessionMeta,
  principal: Principal,
): Promise<RecapDistributionRecoveryOutcome> {
  const recap = meeting.recap;
  if (!recap || recap.status !== "ready") return "not_ready";
  if (recap.distributionStatus !== "blocked" && recap.distributionStatus !== "failed") {
    return "not_failed";
  }
  const hasUnresolvedStableSpeaker = meeting.participants.some(
    (participant) => !!participant.key && !participant.personId,
  );
  if (hasUnresolvedStableSpeaker) return "waiting_for_speaker_identity";

  await distributeRecap(sessionId, meeting, recap, principal, { retryFailed: true });
  return "retried";
}

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

  return withDistributionLock(sessionId, async () => {
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
  });
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
  const {
    distributionError: _previousDistributionError,
    distributionSkipped: _previousDistributionSkipped,
    ...attemptRecap
  } = recap;

  // 1. Mark in-progress and clear stale terminal state from the prior attempt.
  await chatStorage.updateMeetingMeta(sessionId, {
    recap: { ...attemptRecap, distributionStatus: "drafting", draftIds: [] },
  });

  // 2. Resolve the exact calendar event and its connected source account.
  // Gmail sends as the authenticated account; array order is never sender authority.
  const emailContext = await resolveMeetingEmailContext(meeting);
  const attendees = emailContext
    ? await resolveRecipients(meeting, emailContext.event, emailContext.senderAccount.email)
    : [];

  if (!emailContext) {
    log.warn(`Meeting calendar source account could not be resolved for session ${sessionId}; blocking distribution`);
    await markDistributionBlocked(
      sessionId,
      attemptRecap,
      principal,
      [],
      "Meeting calendar account is not connected to Gmail",
      "calendar_account_not_connected",
    );
    return;
  }

  if (attendees.length === 0) {
    log.warn(`No calendar invitees resolved for session ${sessionId}; blocking distribution`);
    await markDistributionBlocked(
      sessionId,
      attemptRecap,
      principal,
      [],
      "Meeting invitees could not be resolved from the calendar event",
      "calendar_invitees_not_resolved",
    );
    return;
  }

  log.info(
    `Distributing recap for session ${sessionId} from calendarAccount=${emailContext.senderAccount.id} to ${attendees.length} attendee(s)`,
  );

  // 3. The authenticated account that fetched this exact event is the sender.
  // Google event organizer describes event authorship, not Mantra authorship.
  const gmailAccountId = emailContext.senderAccount.id;

  // 4. Every recipient receives a distinct capability because the granted work
  // projection is subject-specific. A shared draft would collapse authority.
  const publicBaseUrl = await getRuntimePublicBaseUrl();
  if (!publicBaseUrl) {
    await markDistributionBlocked(
      sessionId,
      attemptRecap,
      principal,
      attendees,
      "Recipient recap links are unavailable for this deployment",
      "public_url_unavailable",
    );
    return;
  }
  const subjectMeetingName = meeting.title?.trim() || recap.pageTitle?.replace(/^Meeting:\s*/i, "").trim() || "Our meeting";
  const subject = `Meeting recap: ${subjectMeetingName}`;
  const draftIds: string[] = [];
  const draftErrors: string[] = [];

  for (const attendee of attendees) {
    const capability = createRecipientAccessCapability();
    const onboarding = mintCapabilityToken();
    let distributionId: string | null = null;
    try {
      const owned = ownedInsertValues(principal, scopeColumns);
      const [row] = await db
        .insert(meetingRecapDistributions)
        .values({
          sessionId,
          attendeeEmail: attendee.email,
          attendeeName: attendee.name ?? null,
          isMantraUser: false,
          accessTokenHash: capability.tokenHash,
          accessExpiresAt: capability.expiresAt,
          onboardingTokenHash: onboarding.tokenHash,
          sendMethod: "gmail_draft",
          status: "pending",
          ...owned,
        })
        .returning({ id: meetingRecapDistributions.id });
      distributionId = row?.id ?? null;
      if (!distributionId) throw new Error("Recap recipient record was not created");

      const body = await buildEmailContent(
        attemptRecap,
        meeting,
        attendee,
        emailContext.event,
        principal,
        recipientRecapUrl(publicBaseUrl, capability.token),
        invitedLandingUrl(onboarding.token),
      );
      const draft = await emailDraftStorage.create(principal, {
        sessionId,
        gmailAccountId,
        to: [attendee.email],
        subject,
        body,
        bodyFormat: "markdown",
      });
      await db
        .update(meetingRecapDistributions)
        .set({ draftId: draft.id, status: "draft_created", updatedAt: new Date() })
        .where(and(
          eq(meetingRecapDistributions.id, distributionId),
          writableScopePredicate(principal, scopeColumns) as SQL,
        ));
      draftIds.push(draft.id);
      log.debug(`Gmail recap draft created for recipient (draftId=${draft.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      draftErrors.push(msg.slice(0, 500));
      log.warn(`Recap draft creation failed for one recipient (session=${sessionId}): ${msg}`);
      if (distributionId) {
        await db
          .update(meetingRecapDistributions)
          .set({ status: "failed", error: msg.slice(0, 500), accessRevokedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(meetingRecapDistributions.id, distributionId),
            writableScopePredicate(principal, scopeColumns) as SQL,
          ));
      }
    }
  }

  // 5. Finalize with one truthful terminal discriminant.
  if (draftErrors.length > 0 || draftIds.length !== attendees.length) {
    const detail = draftErrors[0] || "One or more recap drafts were not created";
    for (const draftId of draftIds) {
      await emailDraftStorage.discard(principal, draftId).catch((error) => {
        log.warn(`Failed to discard partial recap draft ${draftId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await db.update(meetingRecapDistributions).set({
      status: "failed",
      error: detail,
      accessRevokedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(meetingRecapDistributions.sessionId, sessionId),
      writableScopePredicate(principal, scopeColumns) as SQL,
    ));
    await chatStorage.updateMeetingMeta(sessionId, {
      recap: {
        ...attemptRecap,
        distributionStatus: "failed",
        distributionError: detail,
        draftIds: [],
      },
    });
    eventBus.publish({
      category: "agent",
      event: "meeting:recap_distribution_failed",
      payload: { sessionId, reason: "draft_not_created", attendeeCount: attendees.length },
    });
    return;
  }
  await chatStorage.updateMeetingMeta(sessionId, {
    recap: { ...attemptRecap, distributionStatus: "ready", draftIds },
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
  senderAccount: GmailAccount;
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
    const accountEmail = event.accountEmail.trim().toLowerCase();
    const senderAccount = accounts.find((account) => account.id === event.accountId)
      || (accountEmail
        ? accounts.find((account) => account.email.trim().toLowerCase() === accountEmail)
        : undefined);
    if (!senderAccount) {
      log.warn(
        `Calendar source account has no connected Gmail identity event=${event.id} calendarAccount=${event.accountId}`,
      );
      return null;
    }
    return { event, senderAccount };
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
  senderEmail: string,
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

  const normalizedOrganizer = event.organizer?.email?.trim().toLowerCase();
  if (normalizedOrganizer && isValidEmail(normalizedOrganizer) && !emailMap.has(normalizedOrganizer)) {
    emailMap.set(normalizedOrganizer, {
      email: normalizedOrganizer,
      name: event.organizer?.displayName?.trim() || undefined,
    });
  }

  emailMap.delete(senderEmail.trim().toLowerCase());
  return [...emailMap.values()];
}

// ─── Email content ────────────────────────────────────────────────────────────

async function buildEmailContent(
  recap: MeetingRecapMeta,
  meeting: MeetingSessionMeta,
  attendee: ResolvedAttendee,
  event: CalendarEvent,
  principal: Principal,
  recipientUrl: string,
  landingUrl: string,
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
  const participantLine = meeting.participants
    .map((participant) => participant.displayName?.trim() || participant.email?.trim())
    .filter((label): label is string => !!label)
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .join(", ") || "Participants unavailable";
  const greetingName = firstName(attendee.name);
  const greeting = greetingName ? `Hi ${greetingName},` : "Hi,";

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
    `[Open your recap and assigned work](${recipientUrl})`,
    `Sent with [Mantra](${landingUrl})`,
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
