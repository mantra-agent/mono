import crypto from "crypto";
import { getSecret } from "../../secrets-store";
import { createLogger } from "../../log";

const log = createLogger("RecallClient");

export const RECALL_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-central-1",
  "ap-northeast-1",
] as const;
export type RecallRegion = (typeof RECALL_REGIONS)[number];

export class RecallApiError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "RecallApiError";
    this.status = status;
    this.details = details;
  }
}

export interface RecallConfig {
  hasKey: boolean;
  region: RecallRegion | null;
  hasWebhookSecret: boolean;
  hasWorkspaceVerificationSecret: boolean;
}

export async function getRecallConfig(): Promise<RecallConfig> {
  const key = await getSecret("RECALL_API_KEY");
  const rawRegion = (await getSecret("RECALL_REGION"))?.trim().toLowerCase() || null;
  const webhookSecret = await getSecret("RECALL_WEBHOOK_SECRET");
  const workspaceVerificationSecret = await getSecret("RECALL_WORKSPACE_VERIFICATION_SECRET");
  const region = RECALL_REGIONS.includes(rawRegion as RecallRegion)
    ? (rawRegion as RecallRegion)
    : null;
  return {
    hasKey: !!(key && key.length > 0),
    region,
    hasWebhookSecret: !!(webhookSecret && webhookSecret.length > 0),
    hasWorkspaceVerificationSecret: !!(workspaceVerificationSecret && workspaceVerificationSecret.length > 0),
  };
}

export function isRecallConfigured(
  cfg: RecallConfig
): cfg is RecallConfig & { hasKey: true; region: RecallRegion } {
  return cfg.hasKey && !!cfg.region;
}

async function recallFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const key = await getSecret("RECALL_API_KEY");
  const cfg = await getRecallConfig();
  if (!key) throw new RecallApiError("RECALL_API_KEY not configured", 401);
  if (!cfg.region)
    throw new RecallApiError(
      "RECALL_REGION not configured (expected one of: " + RECALL_REGIONS.join(", ") + ")",
      400
    );

  const url = `https://${cfg.region}.recall.ai${path}`;
  log.debug(`${options.method ?? "GET"} ${path}`);

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: key,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
  });
  return res;
}

async function parseJsonOrThrow<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = await res.text().catch(() => undefined);
    }
    throw new RecallApiError(`${label} failed (${res.status})`, res.status, details);
  }
  return (await res.json()) as T;
}

/** Cheap authenticated call for the Integrations "test connection" action. */
export async function testRecallConnection(): Promise<{
  connected: boolean;
  region: RecallRegion | null;
  error?: string;
}> {
  const cfg = await getRecallConfig();
  if (!isRecallConfigured(cfg)) {
    return {
      connected: false,
      region: cfg.region,
      error: !cfg.hasKey ? "RECALL_API_KEY not set" : "RECALL_REGION not set or invalid",
    };
  }
  try {
    const res = await recallFetch("/api/v1/bot/?limit=1");
    if (res.status === 401 || res.status === 403) {
      return { connected: false, region: cfg.region, error: "Invalid API key for this region" };
    }
    if (!res.ok) {
      return { connected: false, region: cfg.region, error: `Recall API returned ${res.status}` };
    }
    return { connected: true, region: cfg.region };
  } catch (err) {
    log.error("Recall connection test failed", err);
    return {
      connected: false,
      region: cfg.region,
      error: err instanceof Error ? err.message : "Connection failed",
    };
  }
}

export interface RecallBot {
  id: string;
  metadata?: Record<string, string>;
  status_changes?: Array<{ code: string; created_at: string }>;
}

export interface CreateBotParams {
  meetingUrl: string;
  botName: string;
  webhookUrl: string;
  metadata: Record<string, string>;
}

/**
 * Create an ad-hoc Recall bot with real-time transcript streaming.
 * Per Recall docs: recallai_streaming provider + final and partial realtime
 * webhook events, with separate diarization streams for speaker attribution.
 */
export async function createRecallBot(params: CreateBotParams): Promise<RecallBot> {
  const body = {
    meeting_url: params.meetingUrl,
    bot_name: params.botName,
    metadata: params.metadata,
    recording_config: {
      transcript: {
        provider: {
          recallai_streaming: {
            mode: "prioritize_low_latency",
            language_code: "en",
          },
        },
        diarization: {
          use_separate_streams_when_available: true,
        },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: params.webhookUrl,
          events: ["transcript.data", "transcript.partial_data"],
        },
      ],
    },
  };
  const res = await recallFetch("/api/v1/bot/", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseJsonOrThrow<RecallBot>(res, "Create bot");
}

export async function leaveRecallBot(botId: string): Promise<void> {
  const res = await recallFetch(`/api/v1/bot/${encodeURIComponent(botId)}/leave_call/`, {
    method: "POST",
  });
  if (!res.ok && res.status !== 404) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = undefined;
    }
    throw new RecallApiError(`Leave call failed (${res.status})`, res.status, details);
  }
}

/**
 * Verify a Svix-signed webhook request (Recall status webhooks and realtime
 * endpoints are signed with the workspace webhook secret). Implemented
 * directly per the Svix spec: HMAC-SHA256 over "{id}.{timestamp}.{body}"
 * keyed by the base64-decoded portion of the whsec_ secret.
 */
export async function verifyRecallWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  secretName: "RECALL_WEBHOOK_SECRET" | "RECALL_WORKSPACE_VERIFICATION_SECRET" = "RECALL_WEBHOOK_SECRET",
): Promise<boolean> {
  const secret = await getSecret(secretName);
  if (!secret) {
    log.error(`${secretName} not configured — rejecting webhook`);
    return false;
  }
  const getHeader = (name: string): string | null => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(v)) return v[0] ?? null;
    return v ?? null;
  };
  const msgId = getHeader("svix-id") ?? getHeader("webhook-id");
  const msgTimestamp = getHeader("svix-timestamp") ?? getHeader("webhook-timestamp");
  const msgSignature = getHeader("svix-signature") ?? getHeader("webhook-signature");
  if (!msgId || !msgTimestamp || !msgSignature) {
    log.warn("Webhook missing svix signature headers");
    return false;
  }
  // Reject stale timestamps (>5 min skew) to limit replay.
  const ts = parseInt(msgTimestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    log.warn("Webhook timestamp outside tolerance");
    return false;
  }
  // Recall's published verifier requires workspace and legacy Svix secrets
  // to use the whsec_ format. The suffix is the base64-encoded HMAC key.
  if (!secret.startsWith("whsec_")) {
    log.error(`${secretName} is not a valid whsec_ verification secret`);
    return false;
  }
  const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  const signedContent = `${msgId}.${msgTimestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  // Header format: "v1,<base64sig> v1,<base64sig2> ..."
  for (const part of msgSignature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  log.warn("Webhook signature mismatch");
  return false;
}
