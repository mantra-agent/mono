import type { Express, Request, Response } from "express";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { getRuntimePublicBaseUrl } from "../runtime-identity";
import { createLogger } from "../log";
import { chatStorage } from "../integrations/chat";
import { peopleStorage } from "../people-storage";
import { getCurrentPrincipalOrSystem, runWithPrincipal } from "../principal-context";
import { DeepgramSTTProvider } from "./stt/provider";
import { PhoneTurnDetector } from "./turn-detector";
import { clearPhoneSpeech, sendPhoneSpeech } from "./audio";
import type { MessageSpeakerMeta } from "@shared/models/chat";
import { applyOutboundCallStatus, getOutboundCall } from "./outbound";
import type { TwilioCallStatus } from "../integrations/twilio/client";
import { getSecretSync } from "../secrets-store";

const log = createLogger("PhoneTransport");
const pendingCalls = new Map<string, { sessionId: string; caller: string; principal: ReturnType<typeof getCurrentPrincipalOrSystem>; callerName: string }>();

export type PhoneIngestFn = (event: { sessionId: string; speakerLabel: string; text: string; onResponse: (text: string) => Promise<void> }) => Promise<
  { ok: true; sessionId: string; sessionKey: string; speaker?: MessageSpeakerMeta; queued: boolean } | { ok: false; status: number; error: string }
>;

function normalizedPhone(value: string): string { return value.replace(/\D/g, "").slice(-10); }
async function callerIdentity(phone: string): Promise<{ name: string; personId?: string }> {
  const target = normalizedPhone(phone);
  for (const entry of await peopleStorage.listPeople()) {
    const person = await peopleStorage.getPerson(entry.id);
    if (person?.contactInfo.some((item) => item.type === "phone" && normalizedPhone(item.value) === target)) return { name: person.name, personId: person.id };
  }
  return { name: "Caller" };
}
function xmlEscape(value: string): string { return value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!); }
function twilioRequestUrl(req: Request): string {
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol;
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() || req.get("host") || "";
  return `${proto}://${host}${req.originalUrl}`;
}

function verifyTwilioRequest(req: Request): boolean {
  const signature = req.get("x-twilio-signature")?.trim();
  const authToken = getSecretSync("TWILIO_AUTH_TOKEN")?.trim();
  if (!signature || !authToken) return false;
  const parameters = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? Object.entries(req.body as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}${value as string}`)
      .join("")
    : "";
  const expected = crypto.createHmac("sha1", authToken)
    .update(`${twilioRequestUrl(req)}${parameters}`)
    .digest("base64");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function requireTwilioSignature(req: Request, res: Response): boolean {
  if (verifyTwilioRequest(req)) return true;
  log.warn(`Twilio webhook rejected path=${req.path}`);
  res.status(401).json({ error: "Invalid webhook signature" });
  return false;
}


export function registerPhoneRoutes(app: Express, deps: {
  ingestPhoneTurn: PhoneIngestFn;
  releasePhoneTurn: (sessionId: string) => Promise<void>;
}): void {
  const wss = new WebSocketServer({ noServer: true });
  const sttProvider = new DeepgramSTTProvider();

  app.post("/api/webhooks/twilio/outbound-voice", async (req: Request, res: Response) => {
    if (!requireTwilioSignature(req, res)) return;
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const sessionId = typeof req.query?.sessionId === "string" ? req.query.sessionId : "";
    const outbound = getOutboundCall(callSid, sessionId);
    if (!callSid || !outbound) return res.status(404).type("text/xml").send("<Response><Hangup/></Response>");
    pendingCalls.set(callSid, { sessionId: outbound.sessionId, caller: outbound.phoneNumber, principal: outbound.principal, callerName: outbound.personName });
    const base = (await getRuntimePublicBaseUrl())!.replace(/^http/, "ws");
    const streamUrl = `${base}/ws/twilio-media?callSid=${encodeURIComponent(callSid)}`;
    log.info(`outbound media accepted callSid=${callSid} sessionId=${outbound.sessionId}`);
    res.type("text/xml").send(`<Response><Connect><Stream url="${xmlEscape(streamUrl)}" /></Connect></Response>`);
  });

  app.post("/api/webhooks/twilio/call-status", async (req: Request, res: Response) => {
    if (!requireTwilioSignature(req, res)) return;
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const status = typeof req.body?.CallStatus === "string" ? req.body.CallStatus as TwilioCallStatus : null;
    if (!callSid || !status) return res.status(400).json({ error: "CallSid and CallStatus are required" });
    try {
      await applyOutboundCallStatus(callSid, status, typeof req.body?.ErrorMessage === "string" ? req.body.ErrorMessage : undefined);
      res.sendStatus(204);
    } catch (error) {
      log.error(`outbound status failed callSid=${callSid} status=${status}: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ error: "Unable to update call status" });
    }
  });

  app.post("/api/webhooks/twilio/voice", async (req: Request, res: Response) => {
    if (!requireTwilioSignature(req, res)) return;
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const caller = typeof req.body?.From === "string" ? req.body.From : "Unknown";
    if (!callSid) return res.status(400).type("text/xml").send("<Response><Reject/></Response>");
    try {
      const principal = getCurrentPrincipalOrSystem();
      if (principal.actorType !== "user") throw new Error("Twilio inbound webhook requires an owning user principal");
      const identity = await callerIdentity(caller);
      const title = identity.personId ? `Call with ${identity.name}` : `Call from ${caller}`;
      const session = await chatStorage.createMeetingSession(title, {
        title, platform: "phone", participants: [{ label: identity.name, personId: identity.personId }], botStatus: "dialing",
        botId: callSid, statusDetail: `Inbound call from ${caller}`,
      }, `phone:${callSid}`);
      pendingCalls.set(callSid, { sessionId: session.id, caller, principal, callerName: identity.name });
      const base = (await getRuntimePublicBaseUrl())!.replace(/^http/, "ws");
      const streamUrl = `${base}/ws/twilio-media?callSid=${encodeURIComponent(callSid)}`;
      log.info(`inbound call accepted callSid=${callSid} sessionId=${session.id} caller=${caller}`);
      res.type("text/xml").send(`<Response><Connect><Stream url="${xmlEscape(streamUrl)}" /></Connect></Response>`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.error(`inbound call setup failed callSid=${callSid}: ${detail}`);
      res.status(500).type("text/xml").send("<Response><Say>Mantra is unavailable.</Say><Hangup/></Response>");
    }
  });

  wss.on("connection", async (socket: WebSocket, request: IncomingMessage) => {
    const callSid = new URL(request.url || "", "http://localhost").searchParams.get("callSid") || "";
    const call = pendingCalls.get(callSid);
    if (!call) { log.error(`media stream rejected unknown callSid=${callSid}`); socket.close(1008, "Unknown call"); return; }
    await runWithPrincipal(call.principal, async () => {
      let streamSid = "";
      let speaking = false;
      let turn = 0;
      const fail = async (error: Error) => {
        log.error(`phone stream failed callSid=${callSid} sessionId=${call.sessionId}: ${error.message}`);
        await chatStorage.updateMeetingMeta(call.sessionId, { botStatus: "failed", endedAt: new Date().toISOString(), statusDetail: error.message.slice(0, 500) });
        socket.close(1011, "Phone transport failed");
      };
      try {
        let turnBusy = false;
        const detector = new PhoneTurnDetector(async (text) => {
          if (turnBusy) { log.warn(`phone turn dropped while busy callSid=${callSid} sessionId=${call.sessionId}`); return; }
          turnBusy = true;
          if (speaking && streamSid) clearPhoneSpeech(socket, streamSid);
          const result = await deps.ingestPhoneTurn({ sessionId: call.sessionId, speakerLabel: call.callerName, text, onResponse: async (response) => {
            speaking = true;
            await sendPhoneSpeech(socket, streamSid, response, `turn-${++turn}`);
          }});
          if (!result.ok) throw new Error(result.error);
          turnBusy = false;
        }, 900, `phone:${callSid}`);
        const stt = await sttProvider.connect((result) => detector.push(result), (error) => void fail(error));
        socket.on("message", async (data) => {
          try {
            const message = JSON.parse(data.toString()) as { event?: string; streamSid?: string; media?: { payload?: string }; mark?: { name?: string }; start?: { streamSid?: string } };
            if (message.event === "start") {
              streamSid = message.start?.streamSid || message.streamSid || "";
              const outbound = getOutboundCall(callSid);
              await chatStorage.updateMeetingMeta(call.sessionId, { botStatus: "live", statusDetail: outbound ? `Call with ${call.callerName} live` : `Inbound call live (${call.caller})` });
              const greeting = outbound ? `Hello ${call.callerName}, this is Mantra, an AI assistant calling for Ray.` : call.callerName === "Caller" ? "Hello, this is Mantra. How can I help?" : `Hello ${call.callerName}, this is Mantra. How can I help?`;
              await sendPhoneSpeech(socket, streamSid, greeting, "greeting");
              speaking = true;
              log.info(`media stream started callSid=${callSid} streamSid=${streamSid} sessionId=${call.sessionId}`);
            } else if (message.event === "media" && message.media?.payload) stt.sendAudio(Buffer.from(message.media.payload, "base64"));
            else if (message.event === "mark") { speaking = false; log.debug(`playback mark callSid=${callSid} name=${message.mark?.name || "-"}`); }
            else if (message.event === "stop") socket.close(1000);
          } catch (error) { await fail(error instanceof Error ? error : new Error(String(error))); }
        });
        socket.on("close", async () => {
          stt.close(); await detector.close(); pendingCalls.delete(callSid); await deps.releasePhoneTurn(call.sessionId);
          const current = await chatStorage.getSession(call.sessionId);
          if (current?.meeting?.botStatus !== "failed") {
            await chatStorage.updateMeetingMeta(call.sessionId, { botStatus: "ended", endedAt: new Date().toISOString(), statusDetail: "Phone call ended" });
          }
          log.info(`media stream ended callSid=${callSid} sessionId=${call.sessionId}`);
        });
      } catch (error) { await fail(error instanceof Error ? error : new Error(String(error))); }
    });
  });

  app.locals.twilioMediaUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  };
}
