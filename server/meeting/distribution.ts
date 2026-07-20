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
import { listGmailAccounts } from "../gmail";
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

// Bound the editable draft body while preserving every recap section.
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

  // 2. Resolve recipients: calendar invitees, host included, host-only fallback.
  const ownerEmail = await resolveOwnerEmail(principal);
  const attendees = await resolveRecipients(meeting, ownerEmail);

  if (attendees.length === 0) {
    log.warn(`No recipients resolved for session ${sessionId} (no calendar invitees and no Gmail account); skipping distribution`);
    await chatStorage.updateMeetingMeta(sessionId, {
      recap: { ...recap, distributionStatus: "ready", distributionSkipped: true, draftIds: [] },
    });
    return;
  }

  log.info(`Distributing recap for session ${sessionId} to ${attendees.length} attendee(s)`);

  // 3. Require Gmail account. Never fall back to automatic send.
  const gmailAccounts = await listGmailAccounts();
  const gmailAccountId = gmailAccounts[0]?.id ?? null;

  if (!gmailAccountId) {
    log.warn(`No Gmail account connected for session ${sessionId}; blocking distribution`);

    // Mark all attendees as blocked with visible error. Idempotent via future UNIQUE constraint.
    for (const attendee of attendees) {
      try {
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
            error: "Gmail account not connected",
            ...owned,
          })
          .onConflictDoNothing();  // Idempotent via UNIQUE constraint (planned)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to record blocked distribution for ${attendee.email}: ${msg}`);
      }
    }

    await chatStorage.updateMeetingMeta(sessionId, {
      recap: {
        ...recap,
        distributionStatus: "blocked",
        distributionError: "Gmail account not connected; please connect an email account to create recap drafts",
      },
    });

    eventBus.publish({
      category: "agent",
      event: "meeting:recap_distribution_blocked",
      payload: { sessionId, reason: "gmail_not_connected", attendeeCount: attendees.length },
    });

    return;
  }

  // 4. Render the user-owned canonical Library recap into the editable draft.
  const subject = `Meeting recap: ${recap.pageTitle ?? meeting.title ?? "Our meeting"}`;
  const body = await buildEmailContent(recap, meeting, principal);

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

/**
 * Resolve the owner's own email so we can exclude them from the attendee list.
 * Falls back to null if unavailable (we then skip the exclusion filter).
 */
async function resolveOwnerEmail(principal: Principal): Promise<string | null> {
  try {
    const accounts = await listGmailAccounts();
    return accounts[0]?.email?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve recap recipients from the calendar event's invitee list.
 *
 * Invitees are the ground truth of who the meeting was with — not who joined
 * the call, and not which emails resolved to linked People. Linked People
 * only enrich names. The host is a legitimate recipient of their own recap;
 * when no invitees resolve (e.g. no calendar event), the list falls back to
 * the host so a recap always reaches at least them. Deduplicates by
 * normalized lowercase email.
 */
async function resolveRecipients(
  meeting: MeetingSessionMeta,
  ownerEmail: string | null,
): Promise<ResolvedAttendee[]> {
  const emailMap = new Map<string, ResolvedAttendee>();

  if (meeting.providerEventId && meeting.calendarAccountId && meeting.calendarId) {
    // Canonical source: raw calendar event invitees.
    try {
      const { getEvent } = await import("../google-calendar");
      const event = await getEvent(
        meeting.calendarAccountId,
        meeting.calendarId,
        meeting.providerEventId,
      );
      for (const invitee of event.attendees ?? []) {
        const norm = invitee.email?.toLowerCase();
        if (!norm || !isValidEmail(norm)) continue;
        emailMap.set(norm, { email: norm, name: invitee.displayName || undefined });
      }
    } catch (err) {
      log.warn(
        `Calendar invitee resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Enrichment: linked People provide canonical person names for invitees.
    try {
      const { getMetadata, getLinkedPeople } = await import("../calendar-metadata");
      const meta = await getMetadata(
        meeting.providerEventId,
        meeting.calendarAccountId,
        meeting.calendarId,
      );
      if (meta) {
        const people = await getLinkedPeople(meta.id);
        for (const p of people) {
          if (!p.attendeeEmail) continue;
          const norm = p.attendeeEmail.toLowerCase();
          if (!isValidEmail(norm)) continue;
          const existing = emailMap.get(norm);
          if (existing) {
            existing.name = p.personName ?? existing.name;
          } else {
            emailMap.set(norm, { email: norm, name: p.personName ?? undefined });
          }
        }
      }
    } catch (err) {
      log.warn(
        `Calendar attendee enrichment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Structural floor: the recap always reaches at least the host.
  if (emailMap.size === 0 && ownerEmail && isValidEmail(ownerEmail)) {
    emailMap.set(ownerEmail, { email: ownerEmail });
  }

  return [...emailMap.values()];
}

// ─── Email content ────────────────────────────────────────────────────────────

async function buildEmailContent(
  recap: MeetingRecapMeta,
  meeting: MeetingSessionMeta,
  principal: Principal,
): Promise<string> {
  if (!recap.pageId) {
    throw new Error("Canonical recap page is missing");
  }

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
  const participantLabels = new Map(
    meeting.participants
      .filter((participant) => participant.personId)
      .map((participant) => [participant.personId!, participant.label]),
  );
  const canonicalRecap = renderRecapEmailText(
    storedRecap.replace(
      /@person:([A-Za-z0-9_-]+)/g,
      (reference, personId: string) => participantLabels.get(personId) ?? reference,
    ),
  );
  if (canonicalRecap.length > EMAIL_BODY_CHAR_LIMIT) {
    throw new Error(
      `Canonical recap exceeds the ${EMAIL_BODY_CHAR_LIMIT}-character email budget`,
    );
  }

  return [
    "Hi,",
    "",
    "Here is the recap from our meeting.",
    "",
    canonicalRecap,
    "",
    "—",
    "Sent via Mantra",
  ].join("\n");
}

function renderRecapEmailText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) => heading.toUpperCase())
    .replace(/^\*\*(.+?)\*\*$/gm, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
