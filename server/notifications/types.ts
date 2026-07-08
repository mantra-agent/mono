export type NotificationChannel = "email";
export type NotificationProvider = "sendgrid";

export interface NotificationSendInput {
  channel: NotificationChannel;
  to: string;
  subject?: string;
  body: string;
  html?: string;
  from?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationSendResult {
  ok: boolean;
  provider: NotificationProvider;
  channel: NotificationChannel;
  status: "accepted" | "not_configured" | "invalid_request" | "provider_error";
  providerMessageId?: string;
  error?: string;
}
