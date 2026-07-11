import type { Express, Request, Response } from "express";
import { createLogger } from "../log";
import { verifyRecallWebhook } from "../integrations/recall/client";
import type {
  MeetingBotStatus,
  MessageSpeakerMeta,
} from "@shared/models/chat";

const log = createLogger("RecallWebhooks");

import { recordRecallDelivery } from "../integrations/recall/delivery-diagnostics";

function webhookId(req: Request): string | null {
  const value = req.get("webhook-id") ?? req.get("svix-id");
  return value?.trim() || null;
}

export type MeetingIngestFn = (event: {
  sessionId?: string;
  create?: {
    title?: string;
    platform?: string;
    botId?: string;
    meetingUrl?: string;
  };
  speakerLabel?: string;
  text?: string;
  botStatus?: MeetingBotStatus;
  statusDetail?: string;
}) => Promise<
  | {
      ok: true;
      sessionId: string;
      sessionKey: string;
      speaker?: MessageSpeakerMeta;
      queued: boolean;
    }
  | { ok: false; status: number; error: string }
>;

/** Map Recall bot status-change event names to the meeting session discriminant. */
const BOT_STATUS_MAP: Record<string, MeetingBotStatus> = {
  "bot.joining_call": "dialing",
  "bot.in_waiting_room": "in_lobby",
  "bot.in_call_not_recording": "live",
  "bot.recording_permission_allowed": "live",
  "bot.in_call_recording": "live",
  "bot.recording_permission_denied": "denied",
  "bot.call_ended": "ended",
  "bot.done": "ended",
  "bot.fatal": "failed",
};

function rawBodyString(req: Request): string {
  const raw = (req as unknown as { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (typeof raw === "string") return raw;
  return JSON.stringify(req.body ?? {});
}

function sessionIdFromBotMetadata(payload: unknown): string | null {
  const bot = (payload as { data?: { bot?: { metadata?: Record<string, unknown> } } })
    ?.data?.bot;
  const sessionId = bot?.metadata?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

/**
 * Recall.ai webhook receiver. Two endpoints, both Svix-signed with the
 * workspace webhook secret and verified before any processing:
 *
 * - POST /api/webhooks/recall — bot status-change events (dashboard-configured
 *   webhook endpoint; one-time setup in the Recall dashboard).
 * - POST /api/webhooks/recall/transcript — real-time transcript.data events
 *   (configured per-bot via recording_config.realtime_endpoints).
 *
 * Both return 2xx immediately after verification and process async. Bot →
 * session mapping travels in bot.metadata.sessionId (set at bot creation), so
 * no separate mapping store exists.
 */
export function registerRecallRoutes(
  app: Express,
  deps: { ingestMeetingEvent: MeetingIngestFn },
): void {
  const { ingestMeetingEvent } = deps;

  app.post("/api/webhooks/recall", async (req: Request, res: Response) => {
    log.info(`Status webhook received event=${typeof req.body?.event === "string" ? req.body.event : "unknown"}`);
    const verified = await verifyRecallWebhook(
      req.headers as Record<string, string | string[] | undefined>,
      rawBodyString(req),
    );
    if (!verified) {
      await recordRecallDelivery({
        receivedAt: new Date().toISOString(),
        path: "status",
        event: typeof req.body?.event === "string" ? req.body.event : "unknown",
        webhookId: webhookId(req),
        accepted: false,
        responseStatus: 401,
        reason: "Invalid webhook signature",
      });
      return res.status(401).json({ error: "Invalid webhook signature" });
    }
    await recordRecallDelivery({
      receivedAt: new Date().toISOString(),
      path: "status",
      event: typeof req.body?.event === "string" ? req.body.event : "unknown",
      webhookId: webhookId(req),
      accepted: true,
      responseStatus: 200,
    });
    res.status(200).json({ received: true });

    const body = req.body as { event?: string; data?: { data?: { sub_code?: string | null } } };
    const eventName = typeof body?.event === "string" ? body.event : "";
    const botStatus = BOT_STATUS_MAP[eventName];
    if (!botStatus) {
      log.debug(`Ignoring unmapped Recall event: ${eventName || "(none)"}`);
      return;
    }
    const sessionId = sessionIdFromBotMetadata(body);
    if (!sessionId) {
      log.warn(`Recall status event ${eventName} without bot.metadata.sessionId — cannot route`);
      return;
    }
    const subCode = body?.data?.data?.sub_code || undefined;
    try {
      const result = await ingestMeetingEvent({
        sessionId,
        botStatus,
        statusDetail: subCode,
      });
      if (!result.ok) {
        log.error(
          `Recall status ingest failed sessionId=${sessionId} event=${eventName}: ${result.error}`,
        );
      } else {
        log.info(
          `Recall bot status sessionId=${sessionId} event=${eventName} → ${botStatus}${subCode ? ` (${subCode})` : ""}`,
        );
      }
    } catch (err) {
      log.error(`Recall status webhook processing error (${eventName})`, err);
    }
  });

  app.post(
    "/api/webhooks/recall/transcript",
    async (req: Request, res: Response) => {
      log.info(`Transcript webhook received event=${typeof req.body?.event === "string" ? req.body.event : "unknown"}`);
      const verified = await verifyRecallWebhook(
        req.headers as Record<string, string | string[] | undefined>,
        rawBodyString(req),
      );
      if (!verified) {
        await recordRecallDelivery({
          receivedAt: new Date().toISOString(),
          path: "transcript",
          event: typeof req.body?.event === "string" ? req.body.event : "unknown",
          webhookId: webhookId(req),
          accepted: false,
          responseStatus: 401,
          reason: "Invalid webhook signature",
        });
        return res.status(401).json({ error: "Invalid webhook signature" });
      }
      await recordRecallDelivery({
        receivedAt: new Date().toISOString(),
        path: "transcript",
        event: typeof req.body?.event === "string" ? req.body.event : "unknown",
        webhookId: webhookId(req),
        accepted: true,
        responseStatus: 200,
      });
      res.status(200).json({ received: true });

      const body = req.body as {
        event?: string;
        data?: {
          data?: {
            words?: Array<{ text?: string }>;
            participant?: { name?: string | null };
          };
          bot?: { metadata?: Record<string, unknown> };
        };
      };
      if (body?.event !== "transcript.data") {
        log.debug(`Ignoring realtime event: ${body?.event || "(none)"}`);
        return;
      }
      const sessionId = sessionIdFromBotMetadata(body);
      if (!sessionId) {
        log.warn("transcript.data without bot.metadata.sessionId — cannot route");
        return;
      }
      const words = body?.data?.data?.words || [];
      const text = words
        .map((w) => (typeof w?.text === "string" ? w.text : ""))
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!text) return;
      const speakerLabel = body?.data?.data?.participant?.name || undefined;
      try {
        const result = await ingestMeetingEvent({
          sessionId,
          speakerLabel,
          text,
        });
        if (!result.ok) {
          log.error(
            `Recall transcript ingest failed sessionId=${sessionId}: ${result.error}`,
          );
        }
      } catch (err) {
        log.error("Recall transcript webhook processing error", err);
      }
    },
  );
}
