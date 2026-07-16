/**
 * End-of-meeting lifecycle (M2).
 *
 * When a meeting session transitions to botStatus "ended", `finalizeMeetingSession`
 * claims the recap atomically (idempotent against duplicate end events), generates
 * a Library recap page through the tracked LLM boundary, links it as a session
 * artifact, logs an interaction on each identified participant, and records the
 * recap state on the meeting session meta (single source of truth).
 *
 * Ownership: webhook-driven finalization has no user principal, so the owning
 * user is captured structurally on MeetingSessionMeta at session creation and
 * reconstructed here via runWithPrincipal (same pattern as auto-join).
 */
import { and, eq, sql } from "drizzle-orm";
import { createLogger } from "../log";
import { db } from "../db";
import { libraryPages } from "@shared/models/info";
import { chatStorage } from "../integrations/chat/storage";
import { chatCompletion } from "../model-client";
import { ACTIVITY_RECALL } from "../job-profiles";
import {
  buildLibrarySurfaceSet,
  createFiledLibraryPage,
  publishLibraryChanged,
} from "../library-save";
import { syncContentFields } from "@shared/markdown-tiptap";
import { recordSessionArtifact } from "../session-artifacts";
import { peopleStorage } from "../people-storage";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { runWithMeetingOwnerPrincipal } from "./owner-principal";
import { combineWithVisibleScope, combineWithWritableScope } from "../scoped-storage";
import { formatInTimezone, getDateInTimezone } from "../timezone";
import { eventBus } from "../event-bus";
import type { MeetingParticipant, MeetingSessionMeta } from "@shared/models/chat";

const log = createLogger("MeetingRecap");

/** Cap transcript size fed to the model. Head+tail split keeps openings and closings. */
const TRANSCRIPT_CHAR_BUDGET = 150_000;

interface RecapContent {
  title: string;
  summary: string;
  details: string;
  decisions: string[];
  openQuestions: string[];
  followUps: string[];
}

export type MeetingRecapFinalizationResult =
  | { outcome: "ready"; recap: NonNullable<MeetingSessionMeta["recap"]> }
  | { outcome: "failed"; recap: NonNullable<MeetingSessionMeta["recap"]> }
  | { outcome: "already_generating"; recap: NonNullable<MeetingSessionMeta["recap"]> }
  | { outcome: "already_ready"; recap: NonNullable<MeetingSessionMeta["recap"]> }
  | { outcome: "not_meeting" };

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

/**
 * Finalize an ended meeting session. Safe to call multiple times. The atomic
 * claim prevents duplicate generation, while explicit outcomes let webhook
 * and authenticated retry callers report the truth.
 */
export async function finalizeMeetingSession(sessionId: string): Promise<MeetingRecapFinalizationResult> {
  let claim;
  try {
    claim = await chatStorage.claimMeetingRecap(sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Recap claim failed for session ${sessionId}: ${message}`);
    return { outcome: "failed", recap: { status: "failed", error: message.slice(0, 500) } };
  }
  if (claim.outcome !== "claimed") {
    if (claim.outcome === "not_meeting") {
      log.debug(`Recap claim rejected for non-meeting session ${sessionId}`);
      return { outcome: "not_meeting" };
    }
    const recap = claim.session.meeting?.recap;
    if (!recap) {
      return { outcome: "failed", recap: { status: "failed", error: "Recap state unavailable" } };
    }
    log.debug(`Recap claim not won for session ${sessionId}: ${claim.outcome}`);
    return { outcome: claim.outcome, recap };
  }
  const claimed = claim.session;
  const meeting = claimed.meeting!;

  // CHANGE 1: Validate that principal can be reconstructed before proceeding
  if (!meeting.ownerUserId || !meeting.principalAccountId) {
    log.error(
      `Cannot finalize recap for session ${sessionId}: ` +
      `missing ownerUserId=${meeting.ownerUserId ?? "none"} or ` +
      `principalAccountId=${meeting.principalAccountId ?? "none"}`
    );
    const recap = {
      status: "failed" as const,
      error: "Missing owner or account context; cannot generate recap",
    };
    await chatStorage.updateMeetingMeta(sessionId, { recap }).catch((e) =>
      log.error(`Failed to record failure for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`)
    );
    return { outcome: "failed", recap };
  }

  try {
    const recap = await runWithMeetingOwnerPrincipal(
      meeting,
      () => generateRecap(sessionId, claimed.title, meeting),
    );
    return { outcome: recap.status === "ready" ? "ready" : "failed", recap };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Meeting recap failed for session ${sessionId}: ${message}`);
    const recap = { status: "failed" as const, error: message.slice(0, 500) };
    await chatStorage.updateMeetingMeta(sessionId, { recap }).catch((e) =>
      log.error(`Failed to record failure for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`)
    );
    return { outcome: "failed", recap };
  }
}

async function generateRecap(
  sessionId: string,
  sessionTitle: string,
  meeting: MeetingSessionMeta,
): Promise<NonNullable<MeetingSessionMeta["recap"]>> {
  const transcript = await buildTranscript(sessionId);
  if (!transcript) {
    log.warn(`Meeting ${sessionId} ended with no transcript; marking recap failed`);
    const recap = { status: "failed" as const, error: "No transcript captured" };
    await chatStorage.updateMeetingMeta(sessionId, { recap });
    return recap;
  }

  const recap = await generateRecapContent(sessionId, sessionTitle, meeting, transcript);
  const markdown = buildRecapMarkdown(recap, meeting);

  const existingPage = await findExistingRecapPage(sessionId);
  const page = existingPage
    ? await refreshRecapPage(existingPage.id, recap.title, markdown)
    : await createFiledLibraryPage({
        title: recap.title,
        markdown,
        purpose: "meeting-notes",
        contentSummary: recap.summary.slice(0, 500),
        tags: ["meeting", "recap"],
        createdBySessionId: sessionId,
        surface: true,
        surfaceDurationHours: 48,
        surfaceReason: `Meeting recap: ${recap.title}`,
      });

  await recordSessionArtifact(sessionId, "library_page", page.slug, {
    title: page.title,
    pageId: page.id,
  });

  const interactionsLogged = await logParticipantInteractions(
    meeting.participants,
    recap,
    page.slug,
  );

  const recapMeta = {
    status: "ready" as const,
    pageId: page.id,
    pageSlug: page.slug,
    pageTitle: page.title,
    interactionsLogged,
  };

  await chatStorage.updateMeetingMeta(sessionId, { recap: recapMeta });
  log.info(
    `Meeting recap ready for session ${sessionId}: page=${page.slug}, interactions=${interactionsLogged}`,
  );

  // CHANGE 2: Capture current principal and wrap distribution with context.
  // Protect the AsyncLocalStorage boundary as setImmediate exits the context.
  const currentPrincipal = (await import("../principal-context")).getCurrentPrincipal();
  if (!currentPrincipal) {
    log.error(
      `TRAP: No principal in context when starting distribution for session ${sessionId}. ` +
      `This indicates the recap was generated without a user principal.`
    );
    return recapMeta;
  }

  // Kick off distribution with principal context preserved
  setImmediate(() => {
    import("../principal-context")
      .then(async ({ runWithPrincipal: rwp }) => {
        const { distributeRecap } = await import("./distribution");
        return rwp(currentPrincipal, () =>
          distributeRecap(sessionId, meeting, recapMeta, currentPrincipal),
        );
      })
      .catch((err) =>
        log.error(
          `Recap distribution kickoff failed for session ${sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        ),
      );
  });

  return recapMeta;
}

async function findExistingRecapPage(sessionId: string) {
  const [page] = await db
    .select()
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        libraryScopeColumns,
        and(
          eq(libraryPages.createdBySessionId, sessionId),
          sql`${libraryPages.tags} @> ARRAY['meeting', 'recap']::text[]`,
        ),
      ),
    )
    .limit(1);
  return page;
}

async function refreshRecapPage(pageId: string, title: string, markdown: string) {
  const principal = getCurrentPrincipalOrSystem();
  const synced = syncContentFields({ markdown });
  const [page] = await db
    .update(libraryPages)
    .set({
      title,
      content: synced.content,
      plainTextContent: synced.plainTextContent,
      ...buildLibrarySurfaceSet({
        surface: true,
        surfaceDurationHours: 48,
        surfaceReason: `Meeting recap: ${title}`,
      }),
      updatedByUserId: principal.userId ?? undefined,
      updatedAt: new Date(),
    })
    .where(
      combineWithWritableScope(
        principal,
        libraryScopeColumns,
        eq(libraryPages.id, pageId),
      ),
    )
    .returning();
  if (!page) throw new Error(`Meeting recap page ${pageId} is no longer writable`);

  try {
    const { upsertLibraryPageMemory } = await import("../routes/library");
    await upsertLibraryPageMemory(page);
  } catch (error) {
    log.warn(
      `Recap Library memory refresh failed for page ${page.id}: ` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  publishLibraryChanged("updated", page);
  return page;
}

async function buildTranscript(sessionId: string): Promise<string | null> {
  const messages = await chatStorage.getMessagesBySession(sessionId);
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.visibility === "diagnostic") continue;
    const text = (msg.content || "").trim();
    if (!text) continue;
    if (msg.role === "user") {
      lines.push(`[${msg.speaker?.label || "Unknown speaker"}] ${text}`);
    } else if (msg.role === "assistant") {
      lines.push(`[Mantra Agent] ${text}`);
    }
  }
  if (lines.length === 0) return null;
  let transcript = lines.join("\n");
  if (transcript.length > TRANSCRIPT_CHAR_BUDGET) {
    log.warn(
      `Meeting ${sessionId} transcript ${transcript.length} chars exceeds budget ${TRANSCRIPT_CHAR_BUDGET}; using head/tail`,
    );
    const half = Math.floor(TRANSCRIPT_CHAR_BUDGET / 2);
    transcript = `${transcript.slice(0, half)}\n\n[... transcript truncated ...]\n\n${transcript.slice(-half)}`;
  }
  return transcript;
}

async function generateRecapContent(
  sessionId: string,
  sessionTitle: string,
  meeting: MeetingSessionMeta,
  transcript: string,
): Promise<RecapContent> {
  const participantList = meeting.participants.map((p) => p.label).join(", ") || "unknown";
  const result = await chatCompletion({
    activity: ACTIVITY_RECALL,
    jsonMode: true,
    maxTokens: 2500,
    temperature: 0.2,
    metadata: { source: "meeting-recap", sessionId, activity: ACTIVITY_RECALL },
    messages: [
      {
        role: "system",
        content: [
          "You write structured meeting recaps. Given a meeting transcript, return JSON with:",
          '{"summary": string, "details": string, "decisions": string[], "openQuestions": string[], "followUps": string[]}',
          "- summary: one or two short factual sentences only",
          "- details: the complete useful meeting narrative, preserving important context without repeating the summary",
          "- decisions: key decisions made (empty array if none)",
          "- openQuestions: unresolved questions or ambiguities (empty array if none)",
          "- followUps: concrete next actions with owner when stated (empty array if none)",
          "Only report what the transcript supports. Never invent decisions, questions, or follow-ups.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Meeting: ${meeting.title || sessionTitle}`,
          `Participants: ${participantList}`,
          ...(meeting.agenda ? [`Private agenda:\n${meeting.agenda}`] : []),
          `Transcript:\n${transcript}`,
        ].join("\n\n"),
      },
    ],
  });

  let parsed: Partial<RecapContent>;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    throw new Error("Recap model returned unparseable JSON");
  }
  const toStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  const meetingName = (meeting.title || sessionTitle || "Untitled").trim();
  const title = `Meeting: ${meetingName.replace(/^Meeting:\s*/i, "")}`;
  const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "";
  const details = typeof parsed.details === "string" && parsed.details.trim() ? parsed.details.trim() : "";
  if (!summary) throw new Error("Recap model returned no summary");
  if (!details) throw new Error("Recap model returned no details");
  return {
    title,
    summary,
    details,
    decisions: toStrings(parsed.decisions),
    openQuestions: toStrings(parsed.openQuestions),
    followUps: toStrings(parsed.followUps),
  };
}

function participantRef(p: MeetingParticipant): string {
  return p.personId ? `@person:${p.personId}` : p.label;
}

function buildRecapMarkdown(recap: RecapContent, meeting: MeetingSessionMeta): string {
  const parts: string[] = [];
  const participants = meeting.participants.map(participantRef).join(", ");
  if (participants) parts.push(`**Participants:** ${participants}`);
  if (meeting.startedAt) {
    const started = new Date(meeting.startedAt);
    if (!Number.isNaN(started.getTime())) {
      parts.push(`**Date:** ${formatInTimezone(started, { year: "numeric", month: "short", day: "numeric" })}`);
      parts.push(`**Time:** ${formatInTimezone(started, { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`);
    }
  }
  const listOrNone = (items: string[]) => items.length > 0
    ? items.map((item) => `- ${item}`).join("\n")
    : "- None.";
  if (meeting.agenda) parts.push(`## Agenda\n\n${meeting.agenda}`);
  parts.push(`## Summary\n\n${recap.summary}`);
  parts.push(`## Details\n\n${recap.details}`);
  parts.push(`## Key Decisions\n\n${listOrNone(recap.decisions)}`);
  parts.push(`## Open Questions\n\n${listOrNone(recap.openQuestions)}`);
  parts.push(`## Action Items\n\n${listOrNone(recap.followUps)}`);
  return parts.join("\n\n");
}

/**
 * Log a "meeting" interaction on each identified participant. Unknown speakers
 * (no personId) are skipped, never fabricated. Per-person failures degrade to
 * warnings so one bad record cannot block the recap.
 */
async function logParticipantInteractions(
  participants: MeetingParticipant[],
  recap: RecapContent,
  pageSlug: string,
): Promise<number> {
  const seen = new Set<string>();
  let logged = 0;
  const date = getDateInTimezone();
  for (const p of participants) {
    if (!p.personId || seen.has(p.personId)) continue;
    seen.add(p.personId);
    try {
      const person = await peopleStorage.getPerson(p.personId);
      const context = `@page:${pageSlug}`;
      const alreadyLogged = person?.interactions.some(
        (interaction) => interaction.type === "meeting" && interaction.context === context,
      );
      if (alreadyLogged) {
        logged += 1;
        continue;
      }
      await peopleStorage.addInteraction(p.personId, {
        date,
        type: "meeting",
        direction: "mutual",
        summary: `${recap.title}: ${recap.summary}`.slice(0, 1000),
        context,
      });
      logged += 1;
    } catch (err) {
      log.warn(
        `Failed to log meeting interaction for person ${p.personId} (${p.label}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (logged > 0) {
    eventBus.publish({
      category: "agent",
      event: "data:people_changed",
      payload: { source: "meeting_recap", action: "log_interaction", count: logged },
    });
  }
  return logged;
}
