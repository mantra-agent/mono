import { createLogger } from "../log";
import type { ExplicitMeetingEventIdentity } from "./identity";
import type { MeetingRecognitionLaunchPlan } from "./stt";
import type { MeetingJoinMode } from "@shared/schema";

const log = createLogger("MeetingJoin");

/** Canonical Zoom / Google Meet link matcher — the single definition used by
 * the meeting_bot tool, the calendar auto-join scheduler, and the toggle route. */
export const MEETING_URL_RE =
  /https?:\/\/[^\s<>"']*(?:zoom\.us\/j\/|zoom\.us\/wc\/|meet\.google\.com\/)[^\s<>"')]+/i;

const LOCALLY_ACTIVE_BOT_STATUSES = new Set(["dialing", "in_lobby", "live", "leaving"]);
const RECALL_TERMINAL_STATUS_CODES = new Set(["call_ended", "done", "fatal"]);

/** Extract the first Zoom/Meet link from any of the provided text fragments. */
export function extractMeetingUrl(...texts: Array<string | null | undefined>): string | null {
  const haystack = texts.filter(Boolean).join("\n");
  const match = haystack.match(MEETING_URL_RE);
  return match ? match[0] : null;
}

export function meetingPlatform(meetingUrl: string): "zoom" | "meet" | "unknown" {
  if (/zoom\.us/i.test(meetingUrl)) return "zoom";
  if (/meet\.google\.com/i.test(meetingUrl)) return "meet";
  return "unknown";
}

export class MeetingJoinError extends Error {
  constructor(message: string, readonly sessionId?: string) {
    super(message);
    this.name = "MeetingJoinError";
  }
}

export interface MeetingJoinResult {
  sessionId: string;
  botId: string;
  platform: "zoom" | "meet" | "unknown";
  title: string;
}

/**
 * Canonical join path: create a meeting session and dispatch the Recall.ai bot.
 * Used by both the meeting_bot tool (chat-native join) and the calendar
 * auto-join scheduler. Throws MeetingJoinError with a human-readable reason on
 * any failure; on bot-creation failure the meeting session is marked failed
 * before the error propagates.
 */
export async function joinMeetingByUrl(opts: {
  meetingUrl: string;
  title?: string;
  agenda?: string;
  explicitEvent?: ExplicitMeetingEventIdentity;
  joinMode?: Exclude<MeetingJoinMode, "dont_join">;
}): Promise<MeetingJoinResult> {
  const meetingUrl = opts.meetingUrl.trim();
  if (!MEETING_URL_RE.test(meetingUrl)) {
    throw new MeetingJoinError(`That doesn't look like a Zoom or Google Meet link: ${meetingUrl}`);
  }

  const platform = meetingPlatform(meetingUrl);
  const { resolveMeetingIdentity } = await import("./identity");
  const identity = await resolveMeetingIdentity({
    meetingUrl,
    title: opts.title,
    agenda: opts.agenda,
    explicitEvent: opts.explicitEvent,
  });
  const title = identity.title;
  const { createMeetingRecognitionLaunchPlan, meetingRecognitionLaunchMeta } = await import("./stt");
  const recognitionLaunch = createMeetingRecognitionLaunchPlan(identity.speakerPolicy);
  const { chatStorage } = await import("../integrations/chat/storage");

  const joinOccurrence = async (): Promise<MeetingJoinResult> => {
    const existing = identity.occurrenceKey
      ? await chatStorage.findMeetingSessionForOccurrence({
          occurrenceKey: identity.occurrenceKey,
          calendarAccountId: identity.calendarAccountId,
          calendarId: identity.calendarId,
          providerEventId: identity.providerEventId,
        })
      : null;
    if (existing?.meeting?.botId && LOCALLY_ACTIVE_BOT_STATUSES.has(existing.meeting.botStatus)) {
      const recall = await import("../integrations/recall/client");
      let providerBot: Awaited<ReturnType<typeof recall.getRecallBot>> | null = null;
      let providerBotMissing = false;
      try {
        providerBot = await recall.getRecallBot(existing.meeting.botId);
      } catch (error) {
        if (error instanceof recall.RecallApiError && error.status === 404) {
          providerBotMissing = true;
        } else {
          const detail = error instanceof Error ? error.message : String(error);
          log.error("meeting occurrence provider liveness check failed", {
            sessionId: existing.id,
            botId: existing.meeting.botId,
            detail,
          });
          throw new MeetingJoinError(
            `Could not confirm whether the existing meeting bot is still active: ${detail}`,
            existing.id,
          );
        }
      }

      const latestProviderStatus = providerBot?.status_changes?.at(-1)?.code ?? null;
      if (providerBot && !latestProviderStatus) {
        log.error("meeting occurrence provider liveness response was ambiguous", {
          sessionId: existing.id,
          botId: existing.meeting.botId,
        });
        throw new MeetingJoinError(
          "Recall returned the existing meeting bot without lifecycle status; retry once its status is available.",
          existing.id,
        );
      }

      if (latestProviderStatus && !RECALL_TERMINAL_STATUS_CODES.has(latestProviderStatus)) {
        log.info("meeting occurrence join replay reused provider-active session", {
          sessionId: existing.id,
          botStatus: existing.meeting.botStatus,
          providerStatus: latestProviderStatus,
        });
        return { sessionId: existing.id, botId: existing.meeting.botId, platform, title: existing.meeting.title || existing.title };
      }

      await chatStorage.updateMeetingMeta(existing.id, {
        botStatus: latestProviderStatus === "fatal" ? "failed" : "ended",
        statusDetail: latestProviderStatus
          ? `Prior meeting bot is no longer active (${latestProviderStatus}). Starting a fresh join…`
          : "Prior meeting bot no longer exists at Recall. Starting a fresh join…",
        endedAt: new Date().toISOString(),
      });
      log.warn("meeting occurrence stale local session terminalized", {
        sessionId: existing.id,
        botId: existing.meeting.botId,
        localStatus: existing.meeting.botStatus,
        providerStatus: latestProviderStatus ?? (providerBotMissing ? "not_found" : "unknown"),
      });
    }

    const meetingPatch = {
      title,
      platform,
      participants: existing?.meeting?.participants.length ? existing.meeting.participants : identity.participants,
      botStatus: "dialing" as const,
      meetingUrl: identity.meetingUrl,
      agenda: identity.agenda,
      agendaPage: identity.agendaPage,
      occurrenceKey: identity.occurrenceKey,
      calendarAccountId: identity.calendarAccountId,
      calendarId: identity.calendarId,
      providerEventId: identity.providerEventId,
      eventStart: identity.eventStart,
      eventEnd: identity.eventEnd,
      resolutionSource: identity.resolutionSource,
      vaultId: identity.vaultId,
      libraryNodePageId: identity.libraryNodePageId,
      speakerPolicy: recognitionLaunch.mode === "shared_room"
        ? identity.speakerPolicy
        : { mode: "participant_streams" as const },
      ...meetingRecognitionLaunchMeta(recognitionLaunch),
      participationPolicy: opts.joinMode === "note_taking" ? "listen_only" as const : "auto" as const,
    };
    const session = existing
      ? await chatStorage.updateMeetingMeta(existing.id, {
          ...meetingPatch,
          statusDetail: "Reconnecting Mantra to the meeting…",
          endedAt: undefined,
        }) ?? existing
      : await chatStorage.createMeetingSession(title, meetingPatch);

    const failSession = async (message: string): Promise<never> => {
      await chatStorage.updateMeetingMeta(session.id, {
        botStatus: "failed",
        statusDetail: message,
        endedAt: new Date().toISOString(),
      });
      throw new MeetingJoinError(message, session.id);
    };

    let dispatch: { botId: string; outputMediaUrl: string };
    try {
      dispatch = await createMeetingRecallBot({
        sessionId: session.id,
        meetingUrl,
        recognitionLaunch,
      });
    } catch (err) {
      return failSession(err instanceof Error ? err.message : String(err));
    }

    await chatStorage.updateMeetingMeta(session.id, {
      botId: dispatch.botId,
      outputMediaUrl: dispatch.outputMediaUrl,
    });
    const { syncMeetingVisualizerBotStatus } = await import("./output-media");
    syncMeetingVisualizerBotStatus(session.id, "dialing");
    log.info("meeting occurrence bot dispatched", {
      sessionId: session.id,
      botId: dispatch.botId,
      platform,
      reusedSession: Boolean(existing),
    });

    return { sessionId: session.id, botId: dispatch.botId, platform, title };
  };

  if (!identity.occurrenceKey) return joinOccurrence();
  const { withMeetingOccurrenceLock } = await import("./locks");
  return withMeetingOccurrenceLock(identity.occurrenceKey, joinOccurrence);
}

/**
 * Dispatch a Recall bot for an already-created meeting session and return the
 * bot id plus the signed output-media URL. Canonical bot-creation path shared
 * by the initial join and the reset/rejoin recovery, so both build the webhook,
 * participant-audio, and output-media wiring identically. Throws
 * MeetingJoinError on any configuration or Recall failure; the caller owns the
 * session state transition (fail on join, mark failed on reset).
 */
export async function createMeetingRecallBot(opts: {
  sessionId: string;
  meetingUrl: string;
  recognitionLaunch: MeetingRecognitionLaunchPlan;
}): Promise<{ botId: string; outputMediaUrl: string }> {
  const recall = await import("../integrations/recall/client");
  const cfg = await recall.getRecallConfig();
  if (!recall.isRecallConfigured(cfg)) {
    throw new MeetingJoinError(
      "Recall.ai is not configured. Enter the RECALL_API_KEY and RECALL_REGION in Settings → Integrations → Recall.ai, then retry.",
      opts.sessionId,
    );
  }
  const { getRuntimePublicBaseUrl } = await import("../runtime-identity");
  const publicUrl = await getRuntimePublicBaseUrl();
  if (!publicUrl) {
    throw new MeetingJoinError(
      "No public base URL available. Bind this deployment to a Platform Environment with a hosting binding publicUrl, or deploy behind a Railway public domain, then retry.",
      opts.sessionId,
    );
  }
  const { outputMediaPageUrl } = await import("./output-media");
  const { issueMeetingSTTAudioToken } = await import("./stt");
  const outputMediaUrl = outputMediaPageUrl(publicUrl, opts.sessionId);
  const participantAudioUrl = opts.recognitionLaunch.outcome === "participant_audio"
    ? `${publicUrl.replace(/^http/, "ws")}/ws/recall-participant-audio/?sessionId=${encodeURIComponent(opts.sessionId)}&token=${encodeURIComponent(issueMeetingSTTAudioToken(opts.sessionId))}`
    : undefined;
  const launchDiagnostic = {
    sessionId: opts.sessionId,
    requestedMode: opts.recognitionLaunch.mode,
    outcome: opts.recognitionLaunch.outcome,
    provider: opts.recognitionLaunch.provider,
    model: opts.recognitionLaunch.model,
    reasonCode: opts.recognitionLaunch.reasonCode,
    transcriptFallback: opts.recognitionLaunch.fallback,
  };
  if (opts.recognitionLaunch.outcome === "transcript_fallback") {
    log.warn("meeting recognition launch degraded", launchDiagnostic);
  } else {
    log.info("meeting recognition launch ready", launchDiagnostic);
  }
  try {
    const bot = await recall.createRecallBot({
      meetingUrl: opts.meetingUrl,
      botName: "Mantra Agent",
      webhookUrl: `${publicUrl}/api/webhooks/recall/transcript`,
      participantAudioUrl,
      // webhookBaseUrl stamps the origin environment so the shared,
      // dashboard-configured status webhook can distinguish a foreign
      // environment's bot from a genuine local session-not-found.
      metadata: { sessionId: opts.sessionId, webhookBaseUrl: publicUrl },
      outputMediaUrl,
    });
    return { botId: bot.id, outputMediaUrl };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`Recall bot creation failed for session ${opts.sessionId}: ${detail}`);
    throw new MeetingJoinError(`Recall bot creation failed: ${detail}`, opts.sessionId);
  }
}
