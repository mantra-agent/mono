import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { phoneCallRecords, twilioNumberBindings } from "@shared/schema";
import type { Principal } from "../principal";

export type PhoneCallDirection = "inbound" | "outbound";

export async function bindConfiguredTwilioNumber(principal: Principal, phoneNumber: string): Promise<void> {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId || !principal.activeVaultId) {
    throw new Error("Authenticated user with an active Vault required to bind a Twilio number");
  }
  await db.insert(twilioNumberBindings).values({
    id: randomUUID(), phoneNumber, ownerUserId: principal.userId, accountId: principal.accountId,
    vaultId: principal.activeVaultId, createdByUserId: principal.userId,
  }).onConflictDoUpdate({
    target: twilioNumberBindings.phoneNumber,
    set: { ownerUserId: principal.userId, accountId: principal.accountId, vaultId: principal.activeVaultId, updatedAt: sql`CURRENT_TIMESTAMP` },
  });
}

export async function resolveTwilioNumberBinding(phoneNumber: string) {
  const [row] = await db.select().from(twilioNumberBindings).where(and(eq(twilioNumberBindings.phoneNumber, phoneNumber), eq(twilioNumberBindings.status, "active"))).limit(1);
  return row ?? null;
}

export async function createPhoneCallRecord(input: {
  callSid: string; sessionId: string; voiceSessionId: string; direction: PhoneCallDirection;
  fromNumber: string; toNumber: string; personId?: string; personName?: string; principal: Principal;
}): Promise<void> {
  if (!input.principal.userId || !input.principal.accountId || !input.principal.activeVaultId) throw new Error("Phone call owner is incomplete");
  await db.insert(phoneCallRecords).values({
    id: randomUUID(), callSid: input.callSid, sessionId: input.sessionId, voiceSessionId: input.voiceSessionId,
    direction: input.direction, fromNumber: input.fromNumber, toNumber: input.toNumber,
    personId: input.personId, personName: input.personName, ownerUserId: input.principal.userId,
    accountId: input.principal.accountId, vaultId: input.principal.activeVaultId, status: "queued",
  }).onConflictDoNothing({ target: phoneCallRecords.callSid });
}

export async function getPhoneCallRecord(callSid: string) {
  const [row] = await db.select().from(phoneCallRecords).where(eq(phoneCallRecords.callSid, callSid)).limit(1);
  return row ?? null;
}

export async function updatePhoneCallStatus(callSid: string, status: string, interactionLogged?: boolean): Promise<void> {
  const terminal = ["completed", "busy", "no-answer", "failed", "canceled"].includes(status);
  await db.update(phoneCallRecords).set({ status, updatedAt: new Date(), ...(terminal ? { endedAt: new Date() } : {}), ...(interactionLogged === undefined ? {} : { interactionLogged }) }).where(eq(phoneCallRecords.callSid, callSid));
}
