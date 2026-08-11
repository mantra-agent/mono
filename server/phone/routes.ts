import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { getSecretSync } from "../secrets-store";
import { createLogger } from "../log";
import { chatStorage } from "../integrations/chat";
import { peopleStorage } from "../people-storage";
import { runWithPrincipal } from "../principal-context";
import { createUserSessionPrincipal } from "../principal";
import { storage } from "../storage";
import { applyOutboundCallStatus } from "./outbound";
import type { TwilioCallStatus } from "../integrations/twilio/client";
import { createPhoneCallRecord, getPhoneCallRecord, resolveTwilioNumberBinding, updatePhoneCallStatus } from "./storage";
import { preparePhoneVoiceSession } from "./voice-session";
import { registerTwilioCall } from "../elevenlabs";

const log = createLogger("PhoneTransport");
function normalizedPhone(value: string): string { return value.replace(/\D/g, "").slice(-10); }
async function callerIdentity(phone: string): Promise<{ name: string; personId?: string }> {
  const target = normalizedPhone(phone);
  for (const entry of await peopleStorage.listPeople()) {
    const person = await peopleStorage.getPerson(entry.id);
    if (person?.contactInfo.some((item) => item.type === "phone" && normalizedPhone(item.value) === target)) return { name: person.name, personId: person.id };
  }
  return { name: "Caller" };
}
function twilioRequestUrl(req: Request): string {
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}${req.originalUrl}`;
}
function verifyTwilioRequest(req: Request): boolean {
  const signature = req.get("x-twilio-signature")?.trim();
  const authToken = getSecretSync("TWILIO_AUTH_TOKEN")?.trim();
  if (!signature || !authToken) return false;
  const parameters = Object.entries((req.body || {}) as Record<string, unknown>).filter(([, value]) => typeof value === "string").sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}${value as string}`).join("");
  const expected = crypto.createHmac("sha1", authToken).update(`${twilioRequestUrl(req)}${parameters}`).digest("base64");
  const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}
function requireTwilioSignature(req: Request, res: Response): boolean {
  if (verifyTwilioRequest(req)) return true;
  log.warn(`Twilio webhook rejected path=${req.path}`); res.status(401).json({ error: "Invalid webhook signature" }); return false;
}
async function ownerPrincipal(ownerUserId: string) {
  const user = await storage.getUser(ownerUserId);
  if (!user) throw new Error("Phone owner no longer exists");
  return createUserSessionPrincipal(user);
}
async function registerCall(callSid: string, fromNumber: string, toNumber: string, direction: "inbound" | "outbound", sessionId: string): Promise<string> {
  const voiceSessionId = direction === "outbound" ? (await getPhoneCallRecord(callSid))?.voiceSessionId : undefined;
  if (!voiceSessionId) throw new Error("Durable phone voice session is missing");
  const agentId = getSecretSync("ELEVENLABS_AGENT_ID")?.trim();
  if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is required");
  return registerTwilioCall({ agentId, fromNumber, toNumber, direction, sessionId: voiceSessionId });
}

export function registerPhoneRoutes(app: Express): void {
  app.post("/api/webhooks/twilio/outbound-voice", async (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const fromNumber = typeof req.body?.From === "string" ? req.body.From : "";
    const toNumber = typeof req.body?.To === "string" ? req.body.To : "";
    const call = await getPhoneCallRecord(callSid);
    if (!call || call.direction !== "outbound") return res.status(404).type("text/xml").send("<Response><Hangup/></Response>");
    try { res.type("text/xml").send(await registerCall(callSid, fromNumber, toNumber, "outbound", call.sessionId)); }
    catch (error) { log.error(`outbound register-call failed callSid=${callSid}: ${error instanceof Error ? error.message : String(error)}`); res.status(502).type("text/xml").send("<Response><Hangup/></Response>"); }
  });

  app.post("/api/webhooks/twilio/voice", async (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const caller = typeof req.body?.From === "string" ? req.body.From : "";
    const called = typeof req.body?.To === "string" ? req.body.To : "";
    if (!callSid || !caller || !called) return res.status(400).type("text/xml").send("<Response><Reject/></Response>");
    const binding = await resolveTwilioNumberBinding(called);
    if (!binding) return res.status(404).type("text/xml").send("<Response><Reject/></Response>");
    try {
      const principal = await ownerPrincipal(binding.ownerUserId);
      const twiml = await runWithPrincipal(principal, async () => {
        const identity = await callerIdentity(caller);
        const title = identity.personId ? `Call with ${identity.name}` : `Call from ${caller}`;
        const session = await chatStorage.createMeetingSession(title, { title, platform: "phone", participants: [{ label: identity.name, personId: identity.personId }], botStatus: "dialing", botId: callSid, statusDetail: `Inbound call from ${caller}` }, `phone:${callSid}`);
        const voiceSessionId = await preparePhoneVoiceSession(principal, session.id, `phone:${callSid}`);
        await createPhoneCallRecord({ callSid, sessionId: session.id, voiceSessionId, direction: "inbound", fromNumber: caller, toNumber: called, personId: identity.personId, personName: identity.name, principal });
        const agentId = getSecretSync("ELEVENLABS_AGENT_ID")?.trim();
        if (!agentId) throw new Error("ELEVENLABS_AGENT_ID is required");
        return registerTwilioCall({ agentId, fromNumber: caller, toNumber: called, direction: "inbound", sessionId: voiceSessionId });
      });
      res.type("text/xml").send(twiml);
    } catch (error) { log.error(`inbound call setup failed callSid=${callSid}: ${error instanceof Error ? error.message : String(error)}`); res.status(500).type("text/xml").send("<Response><Say>Mantra is unavailable.</Say><Hangup/></Response>"); }
  });

  app.post("/api/webhooks/twilio/call-status", async (req, res) => {
    if (!requireTwilioSignature(req, res)) return;
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const status = typeof req.body?.CallStatus === "string" ? req.body.CallStatus as TwilioCallStatus : null;
    if (!callSid || !status) return res.status(400).json({ error: "CallSid and CallStatus are required" });
    try {
      const call = await getPhoneCallRecord(callSid);
      if (call?.direction === "outbound") await applyOutboundCallStatus(callSid, status, typeof req.body?.ErrorMessage === "string" ? req.body.ErrorMessage : undefined);
      else if (call) {
        const principal = await ownerPrincipal(call.ownerUserId);
        await runWithPrincipal(principal, async () => {
          const terminal = ["completed", "busy", "no-answer", "failed", "canceled"].includes(status);
          await chatStorage.updateMeetingMeta(call.sessionId, terminal ? { botStatus: status === "completed" ? "ended" : "failed", endedAt: new Date().toISOString(), statusDetail: status === "completed" ? "Phone call ended" : `Call ${status}` } : { botStatus: status === "in-progress" ? "live" : "dialing", statusDetail: `Inbound call ${status}` });
          await updatePhoneCallStatus(callSid, status);
        });
      }
      res.sendStatus(204);
    } catch (error) { log.error(`call status failed callSid=${callSid}: ${error instanceof Error ? error.message : String(error)}`); res.status(500).json({ error: "Unable to update call status" }); }
  });
}
