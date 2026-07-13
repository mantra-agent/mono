import { createLogger } from "../log";
import type { ExplicitMeetingEventIdentity } from "./identity";

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
  const { chatStorage } = await import("../integrations/chat/storage");
  const session = await chatStorage.createMeetingSession(title, {
    title,
    platform,
    participants: [],
    botStatus: "dialing",
    meetingUrl: identity.meetingUrl,
    agenda: identity.agenda,
    calendarAccountId: identity.calendarAccountId,
    calendarId: identity.calendarId,
    providerEventId: identity.providerEventId,
    eventStart: identity.eventStart,
    eventEnd: identity.eventEnd,
    resolutionSource: identity.resolutionSource,
  });

  const failSession = async (message: string): Promise<never> => {
    await chatStorage.updateMeetingMeta(session.id, {
      botStatus: "failed",
      statusDetail: message,
      endedAt: new Date().toISOString(),
    });
    throw new MeetingJoinError(message, session.id);
  };

  const recall = await import("../integrations/recall/client");
  const cfg = await recall.getRecallConfig();
  if (!recall.isRecallConfigured(cfg)) {
    return failSession(
      "Recall.ai is not configured. Enter the RECALL_API_KEY and RECALL_REGION in Settings → Integrations → Recall.ai, then retry.",
    );
  }
  const { getRuntimePublicBaseUrl, getRuntimeIdentity } = await import("../runtime-identity");
  const publicUrl = await getRuntimePublicBaseUrl();
  if (!publicUrl) {
    return failSession(
      "No public base URL available. Bind this deployment to a Platform Environment with a hosting binding publicUrl, or deploy behind a Railway public domain, then retry.",
    );
  }
  const runtime = await getRuntimeIdentity();

  const { outputMediaPageUrl } = await import("./output-media");
  const outputMediaUrl = outputMediaPageUrl(publicUrl, session.id);
  const { canonicalMeetingSTTEnabled, issueMeetingSTTAudioToken } = await import("./stt");
  const participantAudioUrl = canonicalMeetingSTTEnabled()
    ? `${publicUrl.replace(/^http/, "ws")}/ws/recall-participant-audio/?sessionId=${encodeURIComponent(session.id)}&token=${encodeURIComponent(issueMeetingSTTAudioToken(session.id))}`
    : undefined;
  let botId: string;
  try {
    const bot = await recall.createRecallBot({
      meetingUrl,
      botName: "Mantra Agent",
      webhookUrl: `${publicUrl}/api/webhooks/recall/transcript`,
      participantAudioUrl,
      metadata: { sessionId: session.id },
      outputMediaUrl,
    });
    botId = bot.id;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Recall bot creation failed: ${detail}`;
    log.error(`Recall bot creation failed for session ${session.id}: ${detail}`);
    return failSession(message);
  }

  await chatStorage.updateMeetingMeta(session.id, {
    botId,
    outputMediaUrl,
    sttProvider: participantAudioUrl ? "scribe_realtime" : "recallai_streaming",
    sttModel: participantAudioUrl ? "scribe_v2_realtime" : "prioritize_low_latency",
    sttSource: participantAudioUrl ? "recall_participant_audio" : "recall_transcript_webhook",
    sttFallback: !participantAudioUrl,
    sttStatus: participantAudioUrl ? "inactive" : "fallback",
    sttStatusDetail: participantAudioUrl
      ? "Waiting for Recall participant audio"
      : "ElevenLabs integration unavailable; Recall transcript webhook fallback active",
  });
  log.log(`Bot ${botId} dispatched to ${platform} meeting "${title}" (session ${session.id})`);

  return { sessionId: session.id, botId, platform, title };
}
