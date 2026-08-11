import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { createLogger } from "./log";
import { requireCurrentPrincipal } from "./principal-context";
import type { Principal } from "./principal";
import { peopleStorage, type Person } from "./people-storage";
import { getTwilioConfig, createTwilioMessage } from "./integrations/twilio/client";
import { smsConsentEvents, smsMessages, twilioNumberBindings, SMS_DISCLOSURE_VERSION } from "@shared/models/sms";

const log = createLogger("SmsService");
const CONFIRMATION_TTL_MS = 15 * 60_000;
const pending = new Map<string, { token: string; principal: Principal; personId: string; personName: string; phoneNumber: string; body: string; expiresAt: number }>();

function normalizePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;
  throw new Error("Phone number must be valid E.164 or a 10-digit US number");
}

function userPrincipal(): Principal {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId || !principal.activeVaultId) throw new Error("SMS requires an authenticated user with an active Vault");
  return principal;
}

async function resolvePerson(query: string): Promise<Person> {
  const direct = await peopleStorage.getPerson(query);
  if (direct) return direct;
  const matches = await peopleStorage.searchPeople(query);
  const exact = matches.find((person) => person.name.toLowerCase() === query.toLowerCase());
  if (exact) return (await peopleStorage.getPerson(exact.id))!;
  if (matches.length !== 1) throw new Error(matches.length ? `Multiple people match "${query}"` : `No person found for "${query}"`);
  return (await peopleStorage.getPerson(matches[0].id))!;
}

export async function ensureCurrentTwilioBinding(): Promise<void> {
  const principal = userPrincipal();
  const configured = getTwilioConfig().phoneNumber;
  if (!configured) throw new Error("Twilio phone number is not configured");
  const phoneNumber = normalizePhone(configured);
  const existing = await db.select().from(twilioNumberBindings).where(and(eq(twilioNumberBindings.phoneNumber, phoneNumber), eq(twilioNumberBindings.active, true))).limit(1);
  if (existing[0]) {
    if (existing[0].ownerUserId !== principal.userId || existing[0].accountId !== principal.accountId) throw new Error("Configured Twilio number belongs to another account");
    return;
  }
  await db.insert(twilioNumberBindings).values({ phoneNumber, ownerUserId: principal.userId!, accountId: principal.accountId!, vaultId: principal.activeVaultId! });
}

export async function resolveTwilioBinding(phone: string) {
  const rows = await db.select().from(twilioNumberBindings).where(and(eq(twilioNumberBindings.phoneNumber, normalizePhone(phone)), eq(twilioNumberBindings.active, true))).limit(1);
  return rows[0] ?? null;
}

export async function recordSignupConsent(input: { principal: Principal; phoneNumber: string; source: "public_registration" | "invite_registration" }): Promise<void> {
  if (!input.principal.userId || !input.principal.accountId || !input.principal.activeVaultId) throw new Error("Registration consent requires completed identity foundation");
  await db.insert(smsConsentEvents).values({ ownerUserId: input.principal.userId, accountId: input.principal.accountId, vaultId: input.principal.activeVaultId, phoneNumber: normalizePhone(input.phoneNumber), state: "opted_in", disclosureVersion: SMS_DISCLOSURE_VERSION, source: input.source });
}

export async function recordConsentChange(input: { binding: NonNullable<Awaited<ReturnType<typeof resolveTwilioBinding>>>; phoneNumber: string; state: "opted_in" | "opted_out" | "help_requested"; source: string; providerMessageSid?: string }): Promise<void> {
  await db.insert(smsConsentEvents).values({ ownerUserId: input.binding.ownerUserId, accountId: input.binding.accountId, vaultId: input.binding.vaultId, phoneNumber: normalizePhone(input.phoneNumber), state: input.state, disclosureVersion: SMS_DISCLOSURE_VERSION, source: input.source, providerMessageSid: input.providerMessageSid }).onConflictDoNothing();
}

export async function currentConsentState(ownerUserId: string, accountId: string, phoneNumber: string): Promise<string | null> {
  const rows = await db.select({ state: smsConsentEvents.state }).from(smsConsentEvents).where(and(eq(smsConsentEvents.ownerUserId, ownerUserId), eq(smsConsentEvents.accountId, accountId), eq(smsConsentEvents.phoneNumber, normalizePhone(phoneNumber)))).orderBy(desc(smsConsentEvents.occurredAt)).limit(1);
  return rows[0]?.state ?? null;
}

export async function persistInboundSms(input: { binding: NonNullable<Awaited<ReturnType<typeof resolveTwilioBinding>>>; from: string; body: string; messageSid: string }): Promise<void> {
  await db.insert(smsMessages).values({ ownerUserId: input.binding.ownerUserId, accountId: input.binding.accountId, vaultId: input.binding.vaultId, phoneNumber: normalizePhone(input.from), direction: "inbound", body: input.body.slice(0, 1600), providerMessageSid: input.messageSid, status: "received" }).onConflictDoNothing();
}

export async function prepareOutboundSms(query: string, body: string) {
  const principal = userPrincipal();
  await ensureCurrentTwilioBinding();
  const person = await resolvePerson(query.trim());
  const phones = person.contactInfo.filter((item) => item.type === "phone" && item.value.trim()).map((item) => normalizePhone(item.value));
  if (phones.length !== 1) throw new Error(phones.length ? `${person.name} has multiple phone numbers` : `${person.name} has no phone number in People`);
  const trimmedBody = body.trim();
  if (!trimmedBody || trimmedBody.length > 1600) throw new Error("SMS body must be 1-1600 characters");
  const token = randomUUID();
  const confirmation = { token, principal, personId: person.id, personName: person.name, phoneNumber: phones[0], body: trimmedBody, expiresAt: Date.now() + CONFIRMATION_TTL_MS };
  pending.set(token, confirmation);
  return confirmation;
}

export async function confirmOutboundSms(token: string) {
  const principal = userPrincipal();
  const confirmation = pending.get(token);
  if (!confirmation || confirmation.expiresAt < Date.now()) { pending.delete(token); throw new Error("SMS confirmation is missing or expired"); }
  if (confirmation.principal.userId !== principal.userId) throw new Error("SMS confirmation belongs to another user");
  pending.delete(token);
  const state = await currentConsentState(principal.userId!, principal.accountId!, confirmation.phoneNumber);
  if (state !== "opted_in") throw new Error(state === "opted_out" ? "Recipient opted out of SMS" : "Recipient has no recorded SMS consent");
  const message = await createTwilioMessage({ to: confirmation.phoneNumber, body: confirmation.body });
  await db.insert(smsMessages).values({ ownerUserId: principal.userId!, accountId: principal.accountId!, vaultId: principal.activeVaultId!, personId: confirmation.personId, phoneNumber: confirmation.phoneNumber, direction: "outbound", body: confirmation.body, providerMessageSid: message.sid, status: message.status });
  log.info("outbound SMS sent", { messageSid: message.sid, personId: confirmation.personId });
  return { messageSid: message.sid, status: message.status, personName: confirmation.personName };
}
