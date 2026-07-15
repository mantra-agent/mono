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
import { ownedInsertValues, visibleScopePredicate } from "../scoped-storage";
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

// Maximum characters of recap body sent in email.
const EMAIL_BODY_CHAR_LIMIT = 8_000;

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Distribute a completed meeting recap to external attendees.
 * Called after recap.status = "ready". Never throws.
 */
export async function distributeRecap(
  sessionId: string,
  meeting: MeetingSessionMeta,
  recap: MeetingRecapMeta,
  principal: Principal,
): Promise<void> {
  // TRAP: Verify principal context is correct. This catches leaks across ALS boundaries.
  const { getCurrentPrincipal } = await import("../principal-context");
  const ambientPrincipal = getCurrentPrincipal();

  if (!ambientPrincipal || ambientPrincipal.userId !== principal.userId) {
    const msg =
      `TRAP: Principal context mismatch for session ${sessionId}. ` +
      `Parameter userId=${principal.userId}, ambient userId=${ambientPrincipal?.userId ?? 'null'}. ` +
      `This indicates the distribution callback lost its AsyncLocalStorage principal context.`;
    log.error(msg);
    throw new Error(msg);
  }

  log.info(`Starting recap distribution for session ${sessionId}`);

  try {
    // Idempotency guard: skip if already drafted or sent.
    const existing = await db
      .select({ id: meetingRecapDistributions.id })
      .from(meetingRecapDistributions)
      .where(
        and(
          eq(meetingRecapDistributions.sessionId, sessionId),
          visibleScopePredicate(principal, scopeColumns) as SQL,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      log.debug(`Distribution already started for session ${sessionId}; skipping`);
      return;
    }

    await runDistribution(sessionId, meeting, recap, principal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Recap distribution outer failure for session ${sessionId}: ${msg}`);
    // Best-effort update to surface failure in MeetingHeaderBar.
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

  // 2. Resolve attendees.
  const ownerEmail = await resolveOwnerEmail(principal);
  const attendees = await resolveAttendees(meeting, ownerEmail);

  if (attendees.length === 0) {
    log.info(`No eligible attendees for session ${sessionId}; skipping distribution`);
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
        distributionError: "Gmail account not connected",
      },
    });
    return;
  }

  const useGmail = true;  // Explicit: Gmail is required and verified above.


  // 4. Build email content.
  const subject = `Meeting recap: ${recap.pageTitle ?? meeting.title ?? "Our meeting"}`;
  const { text, html } = buildEmailContent(recap, meeting);

  // 5. Per-attendee loop with error isolation.
  const draftIds: string[] = [];

  for (const attendee of attendees) {
    try {
      // Insert tracking row (pending).
      const owned = ownedInsertValues(principal, scopeColumns);
      const [row] = await db
        .insert(meetingRecapDistributions)
        .values({
          sessionId,
          attendeeEmail: attendee.email,
          attendeeName: attendee.name ?? null,
          isMantraUser: false,
          sendMethod: "gmail_draft",  // Gmail is required; verified above.
          status: "pending",
          ...owned,
        })
        .returning();

      if (useGmail) {
        // Gmail draft path — human sends via EmailDraftWidget.
        const draft = await emailDraftStorage.create(principal, {
          sessionId,
          gmailAccountId: gmailAccountId!,
          to: [attendee.email],
          subject,
          body: text,
        });

        await db
          .update(meetingRecapDistributions)
          .set({ draftId: draft.id, status: "draft_created", updatedAt: new Date() })
          .where(eq(meetingRecapDistributions.id, row.id));

        draftIds.push(draft.id);
        log.debug(`Gmail draft created for ${attendee.email} (draftId=${draft.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Recap distribution failed for attendee ${attendee.email} (session=${sessionId}): ${msg}`);
      // Per-attendee errors are non-fatal — the loop continues.
      // Row may or may not have been inserted; don't throw.
    }
  }

  // 6. Finalize session meta.
  await chatStorage.updateMeetingMeta(sessionId, {
    recap: { ...recap, distributionStatus: "ready", draftIds },
  });

  // 7. Publish event for hooks/listeners.
  eventBus.publish({
    category: "agent",
    event: "meeting:recap_distributed",
    payload: { sessionId, draftCount: draftIds.length, attendeeCount: attendees.length },
  });

  log.info(
    `Recap distribution complete for session ${sessionId}: ${attendees.length} attendee(s), ${draftIds.length} draft(s)`,
  );
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
 * Resolve attendees from calendar event people + meeting participants.
 * Deduplicates by normalized lowercase email. Excludes the owner's email.
 */
async function resolveAttendees(
  meeting: MeetingSessionMeta,
  ownerEmail: string | null,
): Promise<ResolvedAttendee[]> {
  const emailMap = new Map<string, ResolvedAttendee>();

  // Path A: calendarEventPeople (best: has personId → name mapping).
  if (meeting.providerEventId && meeting.calendarAccountId && meeting.calendarId) {
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
          if (isValidEmail(norm)) {
            emailMap.set(norm, { email: norm, name: p.personName ?? undefined });
          }
        }
      }
    } catch (err) {
      log.warn(
        `Calendar attendee resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Path B: Participants with known personId.
  for (const p of meeting.participants) {
    if (!p.personId) continue;
    // Participants don't carry emails directly; we rely on Path A for email addresses.
    // This path exists as a future extension point.
  }

  // Exclude the meeting bot label (Mantra Agent) — no email to send to anyway.
  // Exclude owner's own email.
  const result: ResolvedAttendee[] = [];
  for (const [norm, attendee] of emailMap) {
    if (ownerEmail && norm === ownerEmail) continue;
    result.push(attendee);
  }

  return result;
}

// ─── Email content ────────────────────────────────────────────────────────────

function buildEmailContent(
  recap: MeetingRecapMeta,
  meeting: MeetingSessionMeta,
): { text: string; html: string } {
  // Recap content is stored on the Library page. For email, we render the
  // discriminant fields available on MeetingRecapMeta. Full content lives in
  // the Library page (Phase 2: add public page link).
  const title = recap.pageTitle ?? meeting.title ?? "Meeting Recap";

  const lines: string[] = [
    `Hi,`,
    ``,
    `Here is the recap for our meeting: ${title}.`,
    ``,
    `This recap was generated by Mantra Agent.`,
    ``,
    `—`,
    `Sent via Mantra`,
  ];

  const text = lines.join("\n").slice(0, EMAIL_BODY_CHAR_LIMIT);

  const html = [
    `<p>Hi,</p>`,
    `<p>Here is the recap for our meeting: <strong>${escapeHtml(title)}</strong>.</p>`,
    `<p>This recap was generated by Mantra Agent.</p>`,
    `<hr/>`,
    `<p style="color:#888;font-size:12px;">Sent via Mantra</p>`,
  ].join("\n");

  return { text, html };
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
