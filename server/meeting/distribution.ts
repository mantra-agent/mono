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
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, pool } from "../db";
import { meetingRecapDistributions, users } from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import {
  combineWithVisibleScope,
  ownedInsertValues,
  visibleScopePredicate,
  writableScopePredicate,
} from "../scoped-storage";
import { emailDraftStorage } from "../email-draft-storage";
import { sendNotification } from "../notifications";
import { listAvailableGmailSenderAccounts, type GmailAccount } from "../gmail";
import type { CalendarEvent } from "../google-calendar";
import { formatInTimezone } from "../timezone";
import { chatStorage } from "../integrations/chat/storage";
import { createLogger } from "../log";
import { eventBus } from "../event-bus";
import { eq, and, gt, isNull, or, sql, SQL } from "drizzle-orm";
import type { Principal } from "../principal";
import type { MeetingSessionMeta, MeetingRecapMeta } from "@shared/models/chat";
import { normalizeEmailAddress } from "../email-normalization";
import { resolveOrCreateInvitedSubjectInTransaction } from "../invited-subject-service";
import { peopleStorage } from "../people-storage";
import { runWithPrincipal } from "../principal-context";
import { resolveMeetingTransportSession } from "./owner-principal";

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
const APP_BASE_URL = "https://app.trymantra.ai";

interface RecipientEntryCapability {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Single minting primitive for the per-recipient recap entry capability. */
function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createRecipientEntryCapability(): RecipientEntryCapability {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashCapabilityToken(token),
    expiresAt: new Date(Date.now() + RECIPIENT_ACCESS_TTL_MS),
  };
}

/**
 * Universal recap-onboarding entry. The app resolves current account state
 * before deciding whether this recipient belongs in login, recap, or FTUE.
 * The token identifies the intended recipient but never authenticates them or
 * grants recap content by itself.
 */
function onboardingEntryUrl(token: string): string {
  return `${APP_BASE_URL}/r/${encodeURIComponent(token)}`;
}

export type OnboardingTokenResolution =
  | { status: "not_found" }
  | {
      status: "resolved";
      accountState: "real" | "provisional";
      email: string;
      displayName: string;
      meetingSessionId: string;
      meetingTitle: string;
    };

async function resolveOnboardingTokenHash(
  tokenHash: string,
): Promise<OnboardingTokenResolution> {
  if (!/^[a-f0-9]{64}$/i.test(tokenHash)) return { status: "not_found" };

  const [resolved] = await db
    .select({
      email: meetingRecapDistributions.attendeeEmail,
      displayName: meetingRecapDistributions.attendeeName,
      meetingSessionId: meetingRecapDistributions.sessionId,
      ownerUserId: meetingRecapDistributions.ownerUserId,
      accountId: meetingRecapDistributions.accountId,
      userId: users.id,
    })
    .from(meetingRecapDistributions)
    .leftJoin(
      users,
      sql`LOWER(BTRIM(${users.email})) = LOWER(BTRIM(${meetingRecapDistributions.attendeeEmail}))`,
    )
    .where(and(
      or(
        eq(meetingRecapDistributions.onboardingTokenHash, tokenHash),
        eq(meetingRecapDistributions.accessTokenHash, tokenHash),
      ),
      sql`${meetingRecapDistributions.status} IN ('draft_created', 'sent')`,
      isNull(meetingRecapDistributions.accessRevokedAt),
      gt(meetingRecapDistributions.accessExpiresAt, new Date()),
    ))
    .limit(1);

  if (!resolved || !resolved.ownerUserId || !resolved.accountId) {
    return { status: "not_found" };
  }
  const meetingSession = await resolveMeetingTransportSession(resolved.meetingSessionId);
  const meeting = meetingSession?.meeting;
  if (!meeting
    || meeting.ownerUserId !== resolved.ownerUserId
    || meeting.principalAccountId !== resolved.accountId) {
    return { status: "not_found" };
  }
  return {
    status: "resolved",
    accountState: resolved.userId ? "real" : "provisional",
    email: normalizeEmailAddress(resolved.email),
    displayName: resolved.displayName?.trim() || normalizeEmailAddress(resolved.email),
    meetingSessionId: resolved.meetingSessionId,
    meetingTitle: meeting.title?.trim()
      || meeting.recap?.pageTitle?.replace(/^Meeting:\s*/i, "").trim()
      || "meeting",
  };
}

/** Pure read: resolve the onboarding capability without creating or claiming identity. */
export async function resolveOnboardingToken(
  rawToken: string,
): Promise<OnboardingTokenResolution> {
  const token = rawToken.trim();
  if (!token || token.length > 200) return { status: "not_found" };
  return resolveOnboardingTokenHash(hashCapabilityToken(token));
}

/** Internal pure-read recovery from an already hashed onboarding capability. */
export async function resolveOnboardingTokenByHash(
  tokenHash: string,
): Promise<OnboardingTokenResolution> {
  return resolveOnboardingTokenHash(tokenHash.trim());
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
  | "promotion_attempted"
  | "retried";

/**
 * Retry a failed distribution or promote a recipient-free draft after
 * owner-authenticated speaker correction. Wait for every stable speaker to
 * have canonical identity so the first recipient-specific draft cannot freeze
 * partially corrected participant attribution.
 */
export async function recoverRecapDistributionAfterSpeakerResolution(
  sessionId: string,
  meeting: MeetingSessionMeta,
  principal: Principal,
): Promise<RecapDistributionRecoveryOutcome> {
  const recap = meeting.recap;
  if (!recap || recap.status !== "ready") return "not_ready";
  const canRetryFailure = recap.distributionStatus === "blocked" || recap.distributionStatus === "failed";
  const canPromoteRecipientFreeDraft = recap.distributionStatus === "ready" && !!recap.draftIds?.length;
  if (!canRetryFailure && !canPromoteRecipientFreeDraft) return "not_failed";

  const hasUnresolvedStableSpeaker = meeting.participants.some(
    (participant) => !!participant.key && !participant.personId,
  );
  if (hasUnresolvedStableSpeaker) return "waiting_for_speaker_identity";

  await distributeRecap(sessionId, meeting, recap, principal, {
    retryFailed: canRetryFailure,
    promoteRecipientFreeDraft: canPromoteRecipientFreeDraft,
  });
  return canPromoteRecipientFreeDraft ? "promotion_attempted" : "retried";
}

export async function distributeRecap(
  sessionId: string,
  meeting: MeetingSessionMeta,
  recap: MeetingRecapMeta,
  principal: Principal,
  options: { retryFailed?: boolean; promoteRecipientFreeDraft?: boolean } = {},
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
    // Recipient-free drafts have no distribution row or capability. Their
    // persisted recap draft IDs remain the replay-safe generation authority
    // until owner-authenticated identity resolution explicitly promotes them.
    if (recap.distributionStatus === "ready" && recap.draftIds?.length && !options.promoteRecipientFreeDraft) {
      await surfaceRecapDraftsInline(sessionId, recap.draftIds);
      log.debug(`Distribution already ready for session ${sessionId}; ensured inline draft surface`);
      return;
    }

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

    await runDistribution(
      sessionId,
      meeting,
      recap,
      principal,
      options.promoteRecipientFreeDraft ? recap.draftIds ?? [] : [],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Recap distribution outer failure for session ${sessionId}: ${msg}`);
    const retainedDraftIds = options.promoteRecipientFreeDraft ? recap.draftIds ?? [] : [];
    await chatStorage
      .updateMeetingMeta(sessionId, {
        recap: retainedDraftIds.length > 0
          ? { ...recap, distributionStatus: "ready", draftIds: retainedDraftIds }
          : { ...recap, distributionStatus: "failed", distributionError: msg.slice(0, 500) },
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
  recipientFreeDraftIds: string[],
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

  // 2. Resolve sender authority independently from optional Calendar evidence.
  // Calendar may choose the default From account, but every available account
  // remains selectable on the persisted draft.
  const emailContext = await resolveMeetingEmailContext(meeting);

  if (!emailContext) {
    if (recipientFreeDraftIds.length > 0) {
      await chatStorage.updateMeetingMeta(sessionId, {
        recap: { ...attemptRecap, distributionStatus: "ready", draftIds: recipientFreeDraftIds },
      });
      log.warn(`No available Gmail sender for recap promotion session ${sessionId}; retained recipient-free draft`);
      return;
    }
    log.warn(`No available Gmail sender account for recap session ${sessionId}; blocking distribution`);
    await markDistributionBlocked(
      sessionId,
      attemptRecap,
      principal,
      [],
      "No connected Gmail account is currently available for sending",
      "gmail_sender_not_available",
    );
    return;
  }

  const attendees = await resolveRecipients(
    meeting,
    emailContext.event,
    emailContext.defaultSenderAccount.email,
    principal,
  );

  log.info(
    `Preparing recap for session ${sessionId} from defaultAccount=${emailContext.defaultSenderAccount.id} for ${attendees.length} resolved recipient(s)`,
  );

  if (recipientFreeDraftIds.length > 0 && attendees.length === 0) {
    await chatStorage.updateMeetingMeta(sessionId, {
      recap: { ...attemptRecap, distributionStatus: "ready", draftIds: recipientFreeDraftIds },
    });
    await surfaceRecapDraftsInline(sessionId, recipientFreeDraftIds);
    log.debug(`Recipient-free recap draft remains current for session ${sessionId}`);
    return;
  }

  const recipientFreeDraft = recipientFreeDraftIds.length === 1
    ? await emailDraftStorage.getById(principal, recipientFreeDraftIds[0])
    : null;
  const gmailAccountId = recipientFreeDraft?.gmailAccountId || emailContext.defaultSenderAccount.id;

  // 4. Every resolved recipient receives a distinct entry capability. When no
  // recipient is known yet, create one ordinary unaddressed recap draft so the
  // owner can choose recipients and sender rather than losing the draft.
  const subjectMeetingName = meeting.title?.trim() || recap.pageTitle?.replace(/^Meeting:\s*/i, "").trim() || "Our meeting";
  const subject = `Meeting recap: ${subjectMeetingName}`;
  const draftIds: string[] = [];
  const draftErrors: string[] = [];

  if (attendees.length === 0) {
    try {
      const body = await buildEmailContent(
        attemptRecap,
        meeting,
        undefined,
        emailContext.event,
        principal,
        null,
      );
      const draft = await emailDraftStorage.create(principal, {
        sessionId,
        gmailAccountId,
        to: [],
        subject,
        body,
        bodyFormat: "markdown",
      });
      await chatStorage.updateMeetingMeta(sessionId, {
        recap: { ...attemptRecap, distributionStatus: "ready", draftIds: [draft.id] },
      });
      await surfaceRecapDraftsInline(sessionId, [draft.id]);
      eventBus.publish({
        category: "agent",
        event: "meeting:recap_distributed",
        payload: { sessionId, draftCount: 1, attendeeCount: 0 },
      });
      log.info(`Recap draft prepared without recipients for session ${sessionId}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await chatStorage.updateMeetingMeta(sessionId, {
        recap: {
          ...attemptRecap,
          distributionStatus: "failed",
          distributionError: detail.slice(0, 500),
          draftIds: [],
        },
      });
      eventBus.publish({
        category: "agent",
        event: "meeting:recap_distribution_failed",
        payload: { sessionId, reason: "draft_not_created", attendeeCount: 0 },
      });
    }
    return;
  }

  for (const attendee of attendees) {
    const entryCapability = createRecipientEntryCapability();
    let distributionId: string | null = null;
    try {
      const owned = ownedInsertValues(principal, scopeColumns);
      const normalizedEmail = normalizeEmailAddress(attendee.email);
      const row = await db.transaction(async (tx) => {
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.INVITED_SUBJECT,
          normalizedEmail,
        );
        const [existingUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`LOWER(BTRIM(${users.email})) = ${normalizedEmail}`)
          .limit(1);
        const isMantraUser = !!existingUser;
        if (!isMantraUser) {
          await resolveOrCreateInvitedSubjectInTransaction(
            tx,
            normalizedEmail,
            attendee.name,
          );
        }
        const [createdDistribution] = await tx
          .insert(meetingRecapDistributions)
          .values({
            sessionId,
            attendeeEmail: normalizedEmail,
            attendeeName: attendee.name ?? null,
            isMantraUser,
            accessExpiresAt: entryCapability.expiresAt,
            onboardingTokenHash: entryCapability.tokenHash,
            sendMethod: "gmail_draft",
            status: "pending",
            ...owned,
          })
          .returning({ id: meetingRecapDistributions.id });
        return createdDistribution;
      });
      distributionId = row?.id ?? null;
      if (!distributionId) throw new Error("Recap recipient record was not created");

      const body = await buildEmailContent(
        attemptRecap,
        meeting,
        attendee,
        emailContext.event,
        principal,
        onboardingEntryUrl(entryCapability.token),
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
      recap: recipientFreeDraftIds.length > 0
        ? { ...attemptRecap, distributionStatus: "ready", draftIds: recipientFreeDraftIds }
        : {
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

  for (const draftId of recipientFreeDraftIds) {
    await emailDraftStorage.discard(principal, draftId).catch((error) => {
      log.warn(`Failed to discard promoted recipient-free recap draft ${draftId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

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
  event: CalendarEvent | null;
  defaultSenderAccount: GmailAccount;
}

async function resolveCalendarEvent(meeting: MeetingSessionMeta): Promise<CalendarEvent | null> {
  if (!meeting.providerEventId || !meeting.calendarAccountId || !meeting.calendarId) return null;
  try {
    const { getEvent } = await import("../google-calendar");
    return await getEvent(
      meeting.calendarAccountId,
      meeting.calendarId,
      meeting.providerEventId,
    );
  } catch (error) {
    log.warn(
      `Meeting calendar context unavailable; continuing with editable recap draft: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function resolveMeetingEmailContext(
  meeting: MeetingSessionMeta,
): Promise<MeetingEmailContext | null> {
  const accounts = await listAvailableGmailSenderAccounts();
  if (accounts.length === 0) return null;

  const event = await resolveCalendarEvent(meeting);
  const eventAccountEmail = event?.accountEmail.trim().toLowerCase();
  const calendarDefault = event
    ? accounts.find((account) => account.id === event.accountId)
      || (eventAccountEmail
        ? accounts.find((account) => account.email.trim().toLowerCase() === eventAccountEmail)
        : undefined)
    : undefined;
  return {
    event,
    defaultSenderAccount: calendarDefault || accounts[0],
  };
}

/**
 * Resolve recap recipients from every owner-authorized identity source.
 * Calendar invitees remain authoritative for their own addresses. Any
 * canonical Person-linked participant contributes that Person's first valid
 * stored email, which covers native/shared-room attendees after assignment.
 */
async function resolveRecipients(
  meeting: MeetingSessionMeta,
  event: CalendarEvent | null,
  senderEmail: string,
  principal: Principal,
): Promise<ResolvedAttendee[]> {
  const emailMap = new Map<string, ResolvedAttendee>();
  for (const invitee of event?.attendees ?? []) {
    const normalized = invitee.email?.trim().toLowerCase();
    if (!normalized || !isValidEmail(normalized)) continue;
    emailMap.set(normalized, {
      email: normalized,
      name: invitee.displayName?.trim() || undefined,
    });
  }

  if (event && meeting.providerEventId && meeting.calendarAccountId && meeting.calendarId) {
    try {
      const { getMetadata, getLinkedPeople } = await import("../calendar-metadata");
      const meta = await getMetadata(
        meeting.providerEventId,
        meeting.calendarAccountId,
        meeting.calendarId,
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
  }

  const normalizedOrganizer = event?.organizer?.email?.trim().toLowerCase();
  if (normalizedOrganizer && isValidEmail(normalizedOrganizer) && !emailMap.has(normalizedOrganizer)) {
    emailMap.set(normalizedOrganizer, {
      email: normalizedOrganizer,
      name: event?.organizer?.displayName?.trim() || undefined,
    });
  }

  const assignedPersonIds = [...new Set(
    meeting.participants
      .filter((participant) => participant.personId)
      .map((participant) => participant.personId!),
  )];
  await runWithPrincipal(principal, async () => {
    for (const personId of assignedPersonIds) {
      const person = await peopleStorage.getPerson(personId);
      if (!person) {
        log.warn(`Assigned meeting Person is no longer visible personId=${personId}`);
        continue;
      }
      const normalized = person.contactInfo
        .filter((contact) => contact.type === "email")
        .map((contact) => contact.value.trim().toLowerCase())
        .find(isValidEmail);
      if (!normalized) {
        log.warn(`Assigned meeting Person has no valid email personId=${personId}`);
        continue;
      }
      const existing = emailMap.get(normalized);
      if (existing) {
        existing.name = person.name.trim() || existing.name;
      } else {
        emailMap.set(normalized, {
          email: normalized,
          name: person.name.trim() || undefined,
        });
      }
    }
  });

  emailMap.delete(senderEmail.trim().toLowerCase());
  return [...emailMap.values()];
}

// ─── Email content ────────────────────────────────────────────────────────────

async function buildEmailContent(
  recap: MeetingRecapMeta,
  meeting: MeetingSessionMeta,
  attendee: ResolvedAttendee | undefined,
  event: CalendarEvent | null,
  principal: Principal,
  recapEntryUrl: string | null,
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
  const startedAt = new Date(meeting.startedAt ?? meeting.eventStart ?? event?.start.dateTime ?? event?.start.date ?? "");
  const timeLabel = Number.isNaN(startedAt.getTime())
    ? "Time unavailable"
    : `${formatInTimezone(startedAt, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })} ${formatInTimezone(startedAt, { month: "short", day: "numeric", year: "numeric" })}`;
  const participantLine = meeting.participants
    .map((participant) => participant.label.trim())
    .filter((label): label is string => !!label)
    .filter((label, index, labels) => labels.indexOf(label) === index)
    .join(", ");
  const meetingDetails = [
    `- Time: ${timeLabel}`,
    ...(participantLine ? [`- Participants: ${participantLine}`] : []),
  ].join("\n");
  const greetingName = firstName(attendee?.name);
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
    `**${meetingName}**\n${meetingDetails}`,
    summary,
    ...sections.map((section) =>
      `**${section.title}**\n${section.items.map((item) => `- ${item}`).join("\n")}`,
    ),
    ...(recapEntryUrl
      ? [
          `[Open your recap and assigned work](${recapEntryUrl})`,
          `Sent with [Mantra](${recapEntryUrl})`,
        ]
      : []),
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
