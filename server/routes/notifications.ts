import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth";
import { createLogger } from "../log";
import { getSecretSync } from "../secrets-store";
import { sendNotification, type NotificationSendInput } from "../notifications";

const log = createLogger("NotificationRoutes");
const MAX_BODY_LENGTH = 20_000;
const MAX_SUBJECT_LENGTH = 500;

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, metadataValue]) => key.length <= 80 && ["string", "number", "boolean"].includes(typeof metadataValue))
      .slice(0, 20)
  );
}

function parseSendRequest(body: Record<string, unknown>): NotificationSendInput | { error: string } {
  const channel = asTrimmedString(body.channel);
  const to = asTrimmedString(body.to);
  const subject = asTrimmedString(body.subject);
  const textBody = asTrimmedString(body.body);
  const html = asTrimmedString(body.html);
  const from = asTrimmedString(body.from);

  if (channel !== "email") return { error: "Only email notifications are supported" };
  if (!to) return { error: "Recipient email is required" };
  if (!textBody && !html) return { error: "Email body or html is required" };
  if (subject && subject.length > MAX_SUBJECT_LENGTH) return { error: "Subject is too long" };
  if ((textBody?.length || 0) > MAX_BODY_LENGTH || (html?.length || 0) > MAX_BODY_LENGTH) {
    return { error: "Email body is too long" };
  }

  return {
    channel: "email",
    to,
    subject,
    body: textBody || "",
    html,
    from,
    metadata: normalizeMetadata(body.metadata),
  };
}

export function registerNotificationRoutes(app: Express): void {
  app.use("/api/notifications", requireAuth);

  app.get("/api/notifications/sendgrid/status", (_req: Request, res: Response) => {
    const hasApiKey = Boolean(getSecretSync("SENDGRID_API_KEY")?.trim());
    const hasFromEmail = Boolean(getSecretSync("SENDGRID_FROM_EMAIL")?.trim());
    const hasFromName = Boolean(getSecretSync("SENDGRID_FROM_NAME")?.trim());
    return res.json({
      configured: hasApiKey && hasFromEmail,
      hasApiKey,
      hasFromEmail,
      hasFromName,
    });
  });

  app.post("/api/notifications/send", async (req: Request, res: Response) => {
    try {
      const parsed = parseSendRequest(req.body || {});
      if ("error" in parsed) {
        return res.status(400).json({
          ok: false,
          provider: "sendgrid",
          channel: "email",
          status: "invalid_request",
          error: parsed.error,
        });
      }

      const result = await sendNotification(parsed);
      const httpStatus = result.ok ? 202 : result.status === "invalid_request" ? 400 : result.status === "not_configured" ? 503 : 502;
      return res.status(httpStatus).json(result);
    } catch (error) {
      log.error("Notification send route failed", error);
      return res.status(500).json({
        ok: false,
        provider: "sendgrid",
        channel: "email",
        status: "provider_error",
        error: "Notification send failed",
      });
    }
  });
}
