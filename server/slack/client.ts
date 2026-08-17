import WebSocket from "ws";
import { getProviderCredential } from "../provider-credential-store";
import { providerFetch, readBoundedProviderBody } from "../integrations/provider-http";
import type { SlackInstallationRow } from "./storage";

const SLACK_API_ORIGIN = "https://slack.com/api";
const PROVIDER_DEADLINE_MS = 10_000;

export interface SlackCredentialBundle {
  appToken: string;
  botToken: string;
}

export interface SlackMessageReceipt {
  channel: string;
  ts: string;
}

export async function loadSlackCredentials(installation: SlackInstallationRow): Promise<SlackCredentialBundle> {
  const raw = await getProviderCredential(installation.providerConnectionId);
  if (!raw) throw new Error("slack_credentials_unavailable");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("slack_credentials_invalid"); }
  if (!parsed || typeof parsed !== "object") throw new Error("slack_credentials_invalid");
  const bundle = parsed as Record<string, unknown>;
  if (typeof bundle.appToken !== "string" || !bundle.appToken.startsWith("xapp-") || bundle.appToken.length > 512) {
    throw new Error("slack_app_token_invalid");
  }
  if (typeof bundle.botToken !== "string" || !bundle.botToken.startsWith("xoxb-") || bundle.botToken.length > 512) {
    throw new Error("slack_bot_token_invalid");
  }
  return { appToken: bundle.appToken, botToken: bundle.botToken };
}

export async function verifySlackIdentity(credentials: SlackCredentialBundle, installation: SlackInstallationRow): Promise<void> {
  const result = await slackMethod(credentials.botToken, "auth.test", {});
  // auth.test returns user_id (the bot's U… user ID) and bot_id (a distinct B… bot ID).
  // The installation stores botUserId as the U… user ID, so compare against user_id.
  if (result.team_id !== installation.teamId || result.user_id !== installation.botUserId) {
    throw new Error("slack_identity_mismatch");
  }
}

export async function openSlackSocket(credentials: SlackCredentialBundle): Promise<WebSocket> {
  const result = await slackMethod(credentials.appToken, "apps.connections.open", {});
  if (typeof result.url !== "string" || !result.url.startsWith("wss://wss-primary.slack.com/")) {
    throw new Error("slack_socket_url_invalid");
  }
  return new WebSocket(result.url, { maxPayload: 64 * 1024, perMessageDeflate: false });
}

export async function postSlackMessage(credentials: SlackCredentialBundle, input: {
  channel: string;
  threadTs?: string;
  text: string;
  clientMsgId: string;
}): Promise<SlackMessageReceipt> {
  const result = await slackMethod(credentials.botToken, "chat.postMessage", {
    channel: input.channel,
    text: input.text,
    // mrkdwn is the default for chat.postMessage text; set explicitly so the
    // outbound boundary's Markdown→mrkdwn conversion is never disabled by API drift.
    mrkdwn: true,
    client_msg_id: input.clientMsgId,
    ...(input.threadTs ? { thread_ts: input.threadTs, reply_broadcast: false } : {}),
  });
  if (typeof result.channel !== "string" || typeof result.ts !== "string") throw new Error("slack_delivery_receipt_invalid");
  return { channel: result.channel, ts: result.ts };
}

export async function updateSlackMessage(credentials: SlackCredentialBundle, input: {
  channel: string;
  ts: string;
  text: string;
}): Promise<void> {
  await slackMethod(credentials.botToken, "chat.update", input);
}

export async function getSlackChannelName(credentials: SlackCredentialBundle, channelId: string): Promise<string | null> {
  // One-ID metadata only. Never conversations.list or any workspace catalog.
  // Slack's conversations.info endpoint is more reliable with its documented
  // form-encoded POST shape than the generic JSON path used by chat methods.
  const result = await slackMethod(credentials.botToken, "conversations.info", { channel: channelId }, "form");
  const channel = result.channel;
  if (!channel || typeof channel !== "object") return null;
  const name = (channel as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

async function slackMethod(token: string, method: string, body: Record<string, unknown>, encoding: "json" | "form" = "json"): Promise<Record<string, unknown>> {
  const response = await providerFetch(`${SLACK_API_ORIGIN}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": encoding === "form" ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
    },
    body: encoding === "form" ? new URLSearchParams(
      Object.entries(body).map(([key, value]) => [key, String(value)]),
    ).toString() : JSON.stringify(body),
    timeoutMs: PROVIDER_DEADLINE_MS,
  });
  const raw = await readBoundedProviderBody(response, 16_384);
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error("slack_provider_invalid_json"); }
  if (!response.ok || value.ok !== true) {
    const code = typeof value.error === "string" ? value.error.slice(0, 80) : `http_${response.status}`;
    throw new Error(`slack_provider_${code}`);
  }
  return value;
}
