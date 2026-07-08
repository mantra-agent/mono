import { createLogger } from "../log";
import { getSecretSync } from "../secrets-store";
import type { NotificationSendInput, NotificationSendResult } from "./types";

const log = createLogger("SendGridNotifications");
const SENDGRID_MAIL_SEND_URL = "https://api.sendgrid.com/v3/mail/send";

interface SendGridConfig {
  apiKey: string;
  fromEmail: string;
  fromName?: string;
}

function readConfig(): SendGridConfig | null {
  const apiKey = getSecretSync("SENDGRID_API_KEY")?.trim();
  const fromEmail = getSecretSync("SENDGRID_FROM_EMAIL")?.trim();
  const fromName = getSecretSync("SENDGRID_FROM_NAME")?.trim();

  if (!apiKey || !fromEmail) {
    return null;
  }

  return { apiKey, fromEmail, fromName: fromName || undefined };
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function redactEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!local || !domain) return "invalid-email";
  return `${local.slice(0, 2)}***@${domain}`;
}

function buildSendGridPayload(input: NotificationSendInput, config: SendGridConfig) {
  const fromEmail = input.from?.trim() || config.fromEmail;
  const from = config.fromName && fromEmail === config.fromEmail
    ? { email: fromEmail, name: config.fromName }
    : { email: fromEmail };

  return {
    personalizations: [
      {
        to: [{ email: input.to.trim() }],
        custom_args: input.metadata ? Object.fromEntries(
          Object.entries(input.metadata)
            .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
            .map(([key, value]) => [key, String(value)])
        ) : undefined,
      },
    ],
    from,
    subject: input.subject?.trim() || "Mantra notification",
    content: [
      { type: "text/plain", value: input.body },
      ...(input.html ? [{ type: "text/html", value: input.html }] : []),
    ],
  };
}

export async function sendSendGridEmail(input: NotificationSendInput): Promise<NotificationSendResult> {
  if (input.channel !== "email") {
    return {
      ok: false,
      provider: "sendgrid",
      channel: input.channel,
      status: "invalid_request",
      error: "Unsupported notification channel",
    };
  }

  if (!isLikelyEmail(input.to.trim())) {
    return {
      ok: false,
      provider: "sendgrid",
      channel: "email",
      status: "invalid_request",
      error: "A valid recipient email is required",
    };
  }

  if (!input.body.trim() && !input.html?.trim()) {
    return {
      ok: false,
      provider: "sendgrid",
      channel: "email",
      status: "invalid_request",
      error: "Email body is required",
    };
  }

  const config = readConfig();
  if (!config) {
    log.warn("SendGrid email send skipped because configuration is missing", {
      hasApiKey: Boolean(getSecretSync("SENDGRID_API_KEY")?.trim()),
      hasFromEmail: Boolean(getSecretSync("SENDGRID_FROM_EMAIL")?.trim()),
    });
    return {
      ok: false,
      provider: "sendgrid",
      channel: "email",
      status: "not_configured",
      error: "SendGrid email is not configured",
    };
  }

  const response = await fetch(SENDGRID_MAIL_SEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSendGridPayload(input, config)),
  });

  const providerMessageId = response.headers.get("x-message-id") || undefined;

  if (response.status === 202) {
    log.info("SendGrid email accepted", {
      to: redactEmail(input.to),
      providerMessageId,
    });
    return {
      ok: true,
      provider: "sendgrid",
      channel: "email",
      status: "accepted",
      providerMessageId,
    };
  }

  const errorText = await response.text().catch(() => "");
  log.error("SendGrid email send failed", {
    status: response.status,
    to: redactEmail(input.to),
    providerMessageId,
    errorPreview: errorText.slice(0, 500),
  });

  return {
    ok: false,
    provider: "sendgrid",
    channel: "email",
    status: "provider_error",
    providerMessageId,
    error: "SendGrid rejected the email send request",
  };
}
