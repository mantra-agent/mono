import { createLogger } from "../log";
import type { ExplicitMeetingEventIdentity } from "./identity";
import type { MeetingRecognitionLaunchPlan } from "./stt";
import type { MeetingJoinMode } from "@shared/schema";

const log = createLogger("MeetingJoin");

/** Canonical Zoom / Google Meet link matcher — the single definition used by
 * the meeting_bot tool, the calendar auto-join scheduler, and the toggle route. */
export const MEETING_URL_RE =
  /https?:\/\/[^\s<>"']*(?:zoom\.us\/j\/|zoom\.us\/wc\/|meet\.google\.com\/)[^\s<>"')]+/i;

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
  const session = await chatStorage.createMeetingSession(title, {
    title,
    platform,
    participants: identity.participants,
    botStatus: "dialing",
    meetingUrl: identity.meetingUrl,
    agenda: identity.agenda,
    agendaPage: identity.agendaPage,
    calendarAccountId: identity.calendarAccountId,
    calendarId: identity.calendarId,
    providerEventId: identity.providerEventId,
    eventStart: identity.eventStart,
    eventEnd: identity.eventEnd,
    resolutionSource: identity.resolutionSource,
    speakerPolicy: recognitionLaunch.mode === "shared_room"
      ? identity.speakerPolicy
      : { mode: "participant_streams" },
    ...meetingRecognitionLaunchMeta(recognitionLaunch),
    participationPolicy: opts.joinMode === "note_taking" ? "listen_only" : "auto",
  });

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
  log.log(`Bot ${dispatch.botId} dispatched to ${platform} meeting "${title}" (session ${session.id})`);

  return { sessionId: session.id, botId: dispatch.botId, platform, title };
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
      metadata: { sessionId: opts.sessionId },
      outputMediaUrl,
    });
    return { botId: bot.id, outputMediaUrl };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`Recall bot creation failed for session ${opts.sessionId}: ${detail}`);
    throw new MeetingJoinError(`Recall bot creation failed: ${detail}`, opts.sessionId);
  }
}
