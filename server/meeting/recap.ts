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
import { createLogger } from "../log";
import { chatStorage } from "../integrations/chat/storage";
import { chatCompletion } from "../model-client";
import { ACTIVITY_RECALL } from "../job-profiles";
import { createFiledLibraryPage } from "../library-save";
import { recordSessionArtifact } from "../session-artifacts";
import { peopleStorage } from "../people-storage";
import { storage } from "../storage";
import { createUserPrincipalFromUser } from "../principal";
import { runWithPrincipal } from "../principal-context";
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

/**
 * Finalize an ended meeting session. Safe to call multiple times — the atomic
 * recap claim makes duplicate calls no-ops. Never throws.
 */
export async function finalizeMeetingSession(sessionId: string): Promise<void> {
  let claimed;
  try {
    claimed = await chatStorage.claimMeetingRecap(sessionId);
  } catch (err) {
    log.error(`Recap claim failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!claimed?.meeting) {
    log.debug(`Recap claim not won for session ${sessionId} (already generating/ready or not a meeting)`);
    return;
  }
  const meeting = claimed.meeting;

  const run = () => generateRecap(sessionId, claimed.title, meeting);

  try {
    // Reconstruct the owning user principal so library page + interactions are
    // user-owned, not system orphans.
    if (meeting.ownerUserId) {
      const user = await storage.getUser(meeting.ownerUserId);
      if (user && meeting.principalAccountId) {
        const principal = createUserPrincipalFromUser(user, meeting.principalAccountId);
        await runWithPrincipal(principal, run);
        return;
      }
      log.warn(
        `Meeting ${sessionId} owner ${meeting.ownerUserId} could not be resolved to a principal (user=${!!user}, accountId=${meeting.principalAccountId ?? "none"}); using ambient principal`,
      );
    } else {
      log.warn(`Meeting ${sessionId} has no captured owner; recap will run under ambient principal`);
    }
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Meeting recap failed for session ${sessionId}: ${message}`);
    await chatStorage
      .updateMeetingMeta(sessionId, { recap: { status: "failed", error: message.slice(0, 500) } })
      .catch((e) =>
        log.error(`Failed to record recap failure for session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`),
      );
  }
}

async function generateRecap(sessionId: string, sessionTitle: string, meeting: MeetingSessionMeta): Promise<void> {
  const transcript = await buildTranscript(sessionId);
  if (!transcript) {
    log.warn(`Meeting ${sessionId} ended with no transcript; marking recap failed`);
    await chatStorage.updateMeetingMeta(sessionId, {
      recap: { status: "failed", error: "No transcript captured" },
    });
    return;
  }

  const recap = await generateRecapContent(sessionId, sessionTitle, meeting, transcript);
  const markdown = buildRecapMarkdown(recap, meeting);

  const page = await createFiledLibraryPage({
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

  const interactionsLogged = await logParticipantInteractions(meeting.participants, recap, page.slug);

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

  // Kick off distribution as a non-blocking side effect.
  // The principal is already in AsyncLocalStorage (runWithPrincipal context).
  // Import is deferred so distribution failures never affect recap finalization.
  const currentPrincipal = (await import("../principal-context")).getCurrentPrincipalOrSystem();
  setImmediate(() => {
    import("./distribution")
      .then(({ distributeRecap }) => distributeRecap(sessionId, meeting, recapMeta, currentPrincipal))
      .catch((err) =>
        log.error(
          `Recap distribution kickoff failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  });
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
  parts.push(`## Follow-ups\n\n${listOrNone(recap.followUps)}`);
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
      await peopleStorage.addInteraction(p.personId, {
        date,
        type: "meeting",
        direction: "mutual",
        summary: `${recap.title}: ${recap.summary}`.slice(0, 1000),
        context: `@page:${pageSlug}`,
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
