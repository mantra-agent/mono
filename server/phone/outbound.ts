import { randomUUID } from "crypto";
import { createLogger } from "../log";
import { peopleStorage, type Person } from "../people-storage";
import { chatStorage } from "../integrations/chat";
import { requireCurrentPrincipal, runWithPrincipal } from "../principal-context";
import type { Principal } from "../principal";
import { getRuntimePublicBaseUrl } from "../runtime-identity";
import { createTwilioCall, getTwilioConfig, type TwilioCallStatus } from "../integrations/twilio/client";
import { getDateInTimezone } from "../timezone";
import { eventBus } from "../event-bus";
import { createPhoneCallRecord, getPhoneCallRecord, updatePhoneCallStatus } from "./storage";
import { preparePhoneVoiceSession } from "./voice-session";

const log = createLogger("OutboundPhone");
const CONFIRMATION_TTL_MS = 15 * 60_000;

type PendingConfirmation = { token: string; personId: string; personName: string; phoneNumber: string; principal: Principal; expiresAt: number };
const pendingConfirmations = new Map<string, PendingConfirmation>();

function phoneContacts(person: Person): string[] { return person.contactInfo.filter((item) => item.type === "phone" && item.value.trim()).map((item) => item.value.trim()); }
async function resolvePerson(query: string): Promise<Person> {
  const direct = await peopleStorage.getPerson(query);
  if (direct) return direct;
  const matches = await peopleStorage.searchPeople(query);
  if (matches.length === 0) throw new Error(`No person found for "${query}"`);
  const exact = matches.find((person) => person.name.toLowerCase() === query.toLowerCase());
  if (exact) return (await peopleStorage.getPerson(exact.id))!;
  if (matches.length !== 1) throw new Error(`Multiple people match "${query}". Use a more specific name.`);
  return (await peopleStorage.getPerson(matches[0].id))!;
}
function requireUserPrincipal(): Principal {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) throw new Error("Outbound calls require an authenticated user");
  return principal;
}

export async function prepareOutboundCall(query: string): Promise<PendingConfirmation> {
  const principal = requireUserPrincipal();
  const person = await resolvePerson(query.trim());
  const phones = phoneContacts(person);
  if (phones.length === 0) throw new Error(`${person.name} has no phone number in People`);
  if (phones.length > 1) throw new Error(`${person.name} has multiple phone numbers. Select one in People before calling.`);
  const confirmation = { token: randomUUID(), personId: person.id, personName: person.name, phoneNumber: phones[0], principal, expiresAt: Date.now() + CONFIRMATION_TTL_MS };
  pendingConfirmations.set(confirmation.token, confirmation);
  log.info(`outbound call prepared personId=${person.id}`);
  return confirmation;
}

export async function confirmOutboundCall(token: string): Promise<{ callSid: string; sessionId: string; status: TwilioCallStatus }> {
  const principal = requireUserPrincipal();
  const pending = pendingConfirmations.get(token);
  if (!pending) throw new Error("Call confirmation is missing or was already used. Start the call again.");
  if (pending.expiresAt < Date.now()) { pendingConfirmations.delete(token); throw new Error("Call confirmation expired. Start the call again."); }
  if (pending.principal.userId !== principal.userId) throw new Error("Call confirmation belongs to another user");
  pendingConfirmations.delete(token);
  const title = `Call with ${pending.personName}`;
  const session = await chatStorage.createMeetingSession(title, { title, platform: "phone", participants: [{ label: pending.personName, personId: pending.personId }], botStatus: "dialing", statusDetail: `Calling ${pending.phoneNumber}` });
  const voiceSessionId = await preparePhoneVoiceSession(principal, session.id, `phone:${randomUUID()}`);
  const base = await getRuntimePublicBaseUrl();
  const configuredNumber = getTwilioConfig().phoneNumber;
  if (!configuredNumber) throw new Error("TWILIO_PHONE_NUMBER is required");
  try {
    const call = await createTwilioCall({ to: pending.phoneNumber, twimlUrl: `${base}/api/webhooks/twilio/outbound-voice`, statusCallbackUrl: `${base}/api/webhooks/twilio/call-status` });
    await createPhoneCallRecord({ callSid: call.sid, sessionId: session.id, voiceSessionId, direction: "outbound", fromNumber: configuredNumber, toNumber: pending.phoneNumber, personId: pending.personId, personName: pending.personName, principal });
    await chatStorage.updateMeetingMeta(session.id, { botId: call.sid, statusDetail: `Calling ${pending.personName} (${call.status})` });
    log.info(`outbound call created callSid=${call.sid} sessionId=${session.id} personId=${pending.personId}`);
    return { callSid: call.sid, sessionId: session.id, status: call.status };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await chatStorage.updateMeetingMeta(session.id, { botStatus: "failed", endedAt: new Date().toISOString(), statusDetail: detail.slice(0, 500) });
    throw error;
  }
}

export async function applyOutboundCallStatus(callSid: string, status: TwilioCallStatus, detail?: string): Promise<void> {
  const call = await getPhoneCallRecord(callSid);
  if (!call || call.direction !== "outbound") { log.warn(`outbound status ignored unknown callSid=${callSid} status=${status}`); return; }
  const { storage } = await import("../storage");
  const user = await storage.getUser(call.ownerUserId);
  if (!user) throw new Error("Phone call owner no longer exists");
  const { createUserSessionPrincipal } = await import("../principal");
  const principal = await createUserSessionPrincipal(user);
  await runWithPrincipal(principal, async () => {
    const terminalFailure = ["busy", "no-answer", "failed", "canceled"].includes(status);
    const patch = status === "in-progress" ? { botStatus: "live" as const, statusDetail: `Call with ${call.personName || "contact"} live` }
      : status === "completed" ? { botStatus: "ended" as const, endedAt: new Date().toISOString(), statusDetail: "Phone call ended" }
      : terminalFailure ? { botStatus: "failed" as const, endedAt: new Date().toISOString(), statusDetail: detail || `Call ${status}` }
      : { botStatus: "dialing" as const, statusDetail: `Calling ${call.personName || "contact"} (${status})` };
    await chatStorage.updateMeetingMeta(call.sessionId, patch);
    if ((status === "completed" || terminalFailure) && !call.interactionLogged && call.personId) {
      const session = await chatStorage.getSession(call.sessionId);
      const transcript = (session?.messages || []).filter((message) => message.role === "user" || message.role === "assistant").map((message) => `${message.role === "user" ? call.personName : "Mantra"}: ${message.content}`).join(" ").slice(0, 800);
      const outcome = status === "completed" ? "Completed outbound phone call" : `Outbound phone call ${status}`;
      await peopleStorage.addInteraction(call.personId, { date: getDateInTimezone(), type: "call", direction: "outbound", summary: transcript ? `${outcome}. ${transcript}`.slice(0, 1000) : outcome, context: `Session ${call.sessionId}; Twilio call ${callSid}` });
      eventBus.publish({ category: "agent", event: "data:people_changed", payload: { source: "phone_call", action: "log_interaction", personId: call.personId, personName: call.personName } });
      await updatePhoneCallStatus(callSid, status, true);
      return;
    }
    await updatePhoneCallStatus(callSid, status);
  });
}
