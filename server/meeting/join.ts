import { createLogger } from "../log";

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
  constructor(message: string) {
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
export async function joinMeetingByUrl(opts: { meetingUrl: string; title?: string }): Promise<MeetingJoinResult> {
  const recall = await import("../integrations/recall/client");
  const cfg = await recall.getRecallConfig();
  if (!recall.isRecallConfigured(cfg)) {
    throw new MeetingJoinError(
      "Recall.ai is not configured. Enter the RECALL_API_KEY and RECALL_REGION in Settings → Integrations → Recall.ai, then retry.",
    );
  }
  const { getRuntimePublicBaseUrl, getRuntimeIdentity } = await import("../runtime-identity");
  const publicUrl = getRuntimePublicBaseUrl();
  if (!publicUrl) {
    throw new MeetingJoinError(
      "No public base URL available — the Recall transcript webhook needs a stable public URL. Configure PUBLIC_URL (or deploy behind a Railway public domain) and retry.",
    );
  }
  const runtime = getRuntimeIdentity();
  if (runtime.publicUrlMismatch) {
    log.warn(
      `PUBLIC_URL mismatch detected; registering Recall transcript webhook against serving host ${publicUrl} for env ${runtime.environmentName}`,
    );
  }

  const meetingUrl = opts.meetingUrl.trim();
  if (!MEETING_URL_RE.test(meetingUrl)) {
    throw new MeetingJoinError(`That doesn't look like a Zoom or Google Meet link: ${meetingUrl}`);
  }

  const platform = meetingPlatform(meetingUrl);
  const title = opts.title?.trim() || "Meeting";

  const { chatStorage } = await import("../integrations/chat/storage");

  // Create the meeting session first so the bot carries the session id in its
  // metadata — the webhook receiver routes events by bot.metadata.sessionId.
  const session = await chatStorage.createMeetingSession(title, {
    title,
    platform,
    participants: [],
    botStatus: "dialing",
    meetingUrl,
  });

  let botId: string;
  try {
    const bot = await recall.createRecallBot({
      meetingUrl,
      botName: "Mantra Agent",
      webhookUrl: `${publicUrl}/api/webhooks/recall/transcript`,
      metadata: { sessionId: session.id },
    });
    botId = bot.id;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await chatStorage.updateMeetingMeta(session.id, {
      botStatus: "failed",
      statusDetail: detail,
      endedAt: new Date().toISOString(),
    });
    log.error(`Recall bot creation failed for session ${session.id}: ${detail}`);
    throw new MeetingJoinError(`Recall bot creation failed: ${detail}`);
  }

  await chatStorage.updateMeetingMeta(session.id, { botId });
  log.log(`Bot ${botId} dispatched to ${platform} meeting "${title}" (session ${session.id})`);

  return { sessionId: session.id, botId, platform, title };
}
