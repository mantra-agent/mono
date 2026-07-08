import { sendSendGridEmail } from "./sendgrid";
import type { NotificationSendInput, NotificationSendResult } from "./types";

export type { NotificationSendInput, NotificationSendResult } from "./types";

export async function sendNotification(input: NotificationSendInput): Promise<NotificationSendResult> {
  switch (input.channel) {
    case "email":
      return sendSendGridEmail(input);
    default:
      return {
        ok: false,
        provider: "sendgrid",
        channel: input.channel,
        status: "invalid_request",
        error: "Unsupported notification channel",
      };
  }
}
