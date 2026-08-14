export const SLACK_INPUT_CHAR_LIMIT = 4_000;
export const SLACK_OUTPUT_CHAR_LIMIT = 8_000;
export const SLACK_EVENT_DEADLINE_MS = 120_000;
export const SLACK_ACK_TARGET_MS = 2_000;
export const SLACK_QUEUE_LIMIT = 100;

export const SLACK_PROGRESS_TEXT = "Thinking…";
export const SLACK_FAILURE_TEXT = "I couldn't complete that request. Please try mentioning me again.";
export const SLACK_SETUP_TEXT = "This Slack user is not mapped to a Mantra account yet. Ask your Mantra administrator to complete the mapping.";

export type SlackIngressType = "message.im" | "app_mention";
export type SlackEventStatus = "received" | "ignored" | "queued" | "processing" | "completed" | "failed" | "delivery_failed" | "blocked";

export interface SlackSocketEnvelope {
  envelope_id: string;
  type: "events_api";
  payload: {
    api_app_id: string;
    team_id: string;
    event_id: string;
    event: {
      type: "message" | "app_mention";
      channel_type?: string;
      channel?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
      subtype?: string;
    };
  };
}

export interface AdmittedSlackEvent {
  installationId: string;
  eventId: string;
  envelopeId: string;
  eventType: SlackIngressType;
  channelId: string;
  rootTs: string;
  slackUserId: string;
  body: string;
}

export function normalizeSlackText(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${escapeRegex(botUserId)}>`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSlackSocketEnvelope(value: unknown): value is SlackSocketEnvelope {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.type !== "events_api" || typeof row.envelope_id !== "string") return false;
  const payload = row.payload;
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  if (typeof p.api_app_id !== "string" || typeof p.team_id !== "string" || typeof p.event_id !== "string") return false;
  const event = p.event;
  if (!event || typeof event !== "object") return false;
  const e = event as Record<string, unknown>;
  return (e.type === "message" || e.type === "app_mention")
    && typeof e.channel === "string"
    && typeof e.user === "string"
    && typeof e.ts === "string"
    && typeof e.text === "string";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
