import type { Express, Request, Response } from "express";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
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

export function registerPhoneRoutes(app: Express, deps: { ingestPhoneTurn: PhoneIngestFn }): void {
  const wss = new WebSocketServer({ noServer: true });
  const sttProvider = new DeepgramSTTProvider();

  app.post("/api/webhooks/twilio/voice", async (req: Request, res: Response) => {
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
      const base = getRuntimePublicBaseUrl().replace(/^http/, "ws");
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
        });
        const stt = await sttProvider.connect((result) => detector.push(result), (error) => void fail(error));
        socket.on("message", async (data) => {
          try {
            const message = JSON.parse(data.toString()) as { event?: string; streamSid?: string; media?: { payload?: string }; mark?: { name?: string }; start?: { streamSid?: string } };
            if (message.event === "start") {
              streamSid = message.start?.streamSid || message.streamSid || "";
              await chatStorage.updateMeetingMeta(call.sessionId, { botStatus: "live", statusDetail: `Inbound call live (${call.caller})` });
              await sendPhoneSpeech(socket, streamSid, call.callerName === "Caller" ? "Hello, this is Mantra. How can I help?" : `Hello ${call.callerName}, this is Mantra. How can I help?`, "greeting");
              speaking = true;
              log.info(`media stream started callSid=${callSid} streamSid=${streamSid} sessionId=${call.sessionId}`);
            } else if (message.event === "media" && message.media?.payload) stt.sendAudio(Buffer.from(message.media.payload, "base64"));
            else if (message.event === "mark") { speaking = false; log.debug(`playback mark callSid=${callSid} name=${message.mark?.name || "-"}`); }
            else if (message.event === "stop") socket.close(1000);
          } catch (error) { await fail(error instanceof Error ? error : new Error(String(error))); }
        });
        socket.on("close", async () => {
          stt.close(); await detector.close(); pendingCalls.delete(callSid);
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
