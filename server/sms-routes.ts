import type { Express, Request, Response } from "express";
import { createLogger } from "./log";
import { createUserPrincipalFromUser } from "./principal";
import { runWithPrincipal } from "./principal-context";
import { db } from "./db";
import { users } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { requireTwilioSignature } from "./twilio-webhook-security";
import { persistInboundSms, recordConsentChange, resolveTwilioBinding } from "./sms-service";

const log = createLogger("SmsRoutes");
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "END", "QUIT", "STOPALL", "REVOKE", "OPTOUT", "CANCEL"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

function twiml(message?: string): string {
  const escaped = message?.replace(/[<>&"']/g, (value) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[value]!) ?? "";
  return message ? `<Response><Message>${escaped}</Message></Response>` : "<Response/>";
}

export function registerSmsRoutes(app: Express): void {
  app.post("/api/webhooks/twilio/sms", async (req: Request, res: Response) => {
    if (!requireTwilioSignature(req, res)) return;
    const to = typeof req.body?.To === "string" ? req.body.To : "";
    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const body = typeof req.body?.Body === "string" ? req.body.Body.trim() : "";
    const messageSid = typeof req.body?.MessageSid === "string" ? req.body.MessageSid : "";
    if (!to || !from || !messageSid) return res.status(400).type("text/xml").send(twiml());
    const binding = await resolveTwilioBinding(to);
    if (!binding) {
      log.warn("Inbound SMS rejected without number binding", { messageSid });
      return res.status(404).type("text/xml").send(twiml());
    }
    const [owner] = await db.select().from(users).where(and(eq(users.id, binding.ownerUserId))).limit(1);
    if (!owner) return res.status(404).type("text/xml").send(twiml());
    const principal = { ...createUserPrincipalFromUser(owner, binding.accountId), activeVaultId: binding.vaultId, visibleVaultIds: [binding.vaultId] };
    await runWithPrincipal(principal, async () => {
      await persistInboundSms({ binding, from, body, messageSid });
      const keyword = body.toUpperCase();
      if (STOP_WORDS.has(keyword)) await recordConsentChange({ binding, phoneNumber: from, state: "opted_out", source: "inbound_stop", providerMessageSid: messageSid });
      else if (START_WORDS.has(keyword)) await recordConsentChange({ binding, phoneNumber: from, state: "opted_in", source: "inbound_start", providerMessageSid: messageSid });
      else if (HELP_WORDS.has(keyword)) await recordConsentChange({ binding, phoneNumber: from, state: "help_requested", source: "inbound_help", providerMessageSid: messageSid });
    });
    const keyword = body.toUpperCase();
    const response = STOP_WORDS.has(keyword)
      ? "You are unsubscribed from Mantra texts. Reply START to receive messages again."
      : START_WORDS.has(keyword)
        ? "You are subscribed to Mantra service and conversational texts. Reply STOP to opt out."
        : HELP_WORDS.has(keyword)
          ? "Mantra service texts: reply STOP to opt out or START to opt back in. Message and data rates may apply."
          : undefined;
    res.type("text/xml").send(twiml(response));
  });
}
