import type { Request, Response } from "express";
import twilio from "twilio";
import { createLogger } from "./log";
import { getSecretSync } from "./secrets-store";

const log = createLogger("TwilioWebhookSecurity");

function requestUrl(req: Request): string {
  const protocol = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "";
  return `${protocol}://${host}${req.originalUrl}`;
}

export function verifyTwilioRequest(req: Request): boolean {
  const signature = req.get("x-twilio-signature")?.trim();
  const authToken = getSecretSync("TWILIO_AUTH_TOKEN")?.trim();
  if (!signature || !authToken || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) return false;
  return twilio.validateRequest(authToken, signature, requestUrl(req), req.body as Record<string, string>);
}

export function requireTwilioSignature(req: Request, res: Response): boolean {
  if (verifyTwilioRequest(req)) return true;
  log.warn("Twilio webhook rejected", { path: req.path });
  res.status(401).json({ error: "Invalid webhook signature" });
  return false;
}
