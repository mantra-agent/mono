import { randomUUID } from "crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "./db";
import { getCurrentPrincipal } from "./principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";
import { communicationAudiences, emailCampaigns, type ManualAudienceDefinition } from "@shared/schema";

const audienceScope = {
  scope: communicationAudiences.scope,
  ownerUserId: communicationAudiences.ownerUserId,
  accountId: communicationAudiences.accountId,
};
const campaignScope = {
  scope: emailCampaigns.scope,
  ownerUserId: emailCampaigns.ownerUserId,
  accountId: emailCampaigns.accountId,
};

function principal() {
  const current = getCurrentPrincipal();
  if (!current) throw new Error("Authentication required");
  return current;
}

export async function listAudiences() {
  const current = principal();
  return db.select().from(communicationAudiences)
    .where(combineWithVisibleScope(current, audienceScope))
    .orderBy(desc(communicationAudiences.updatedAt));
}

export async function createAudience(input: { name: string; description?: string; personIds?: string[] }) {
  const current = principal();
  const definition: ManualAudienceDefinition = { kind: "manual", personIds: input.personIds ?? [] };
  const [created] = await db.insert(communicationAudiences).values({
    id: randomUUID(),
    name: input.name,
    description: input.description ?? "",
    definition,
    ...ownedInsertValues(current, audienceScope),
  }).returning();
  return created;
}

export async function updateAudience(id: string, patch: { name?: string; description?: string; personIds?: string[]; status?: string }) {
  const current = principal();
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.personIds !== undefined) values.definition = { kind: "manual", personIds: patch.personIds } satisfies ManualAudienceDefinition;
  if (patch.status !== undefined) values.status = patch.status;
  const [updated] = await db.update(communicationAudiences).set(values)
    .where(combineWithWritableScope(current, audienceScope, eq(communicationAudiences.id, id)))
    .returning();
  return updated ?? null;
}

export async function deleteAudience(id: string) {
  const current = principal();
  const [deleted] = await db.delete(communicationAudiences)
    .where(combineWithWritableScope(current, audienceScope, eq(communicationAudiences.id, id)))
    .returning({ id: communicationAudiences.id });
  return deleted ?? null;
}

export async function listCampaigns() {
  const current = principal();
  return db.select().from(emailCampaigns)
    .where(combineWithVisibleScope(current, campaignScope))
    .orderBy(desc(emailCampaigns.updatedAt));
}

export async function createCampaign(input: { name: string; audienceId?: string | null }) {
  const current = principal();
  if (input.audienceId) {
    const [audience] = await db.select({ id: communicationAudiences.id }).from(communicationAudiences)
      .where(combineWithVisibleScope(current, audienceScope, eq(communicationAudiences.id, input.audienceId)))
      .limit(1);
    if (!audience) throw new Error("Audience not found");
  }
  const [created] = await db.insert(emailCampaigns).values({
    id: randomUUID(),
    name: input.name,
    audienceId: input.audienceId ?? null,
    ...ownedInsertValues(current, campaignScope),
  }).returning();
  return created;
}

export async function updateCampaign(id: string, patch: {
  name?: string;
  audienceId?: string | null;
  senderName?: string;
  senderEmail?: string;
  replyToEmail?: string;
  subject?: string;
  body?: string;
  status?: string;
}) {
  const current = principal();
  if (patch.audienceId) {
    const [audience] = await db.select({ id: communicationAudiences.id }).from(communicationAudiences)
      .where(combineWithVisibleScope(current, audienceScope, eq(communicationAudiences.id, patch.audienceId)))
      .limit(1);
    if (!audience) throw new Error("Audience not found");
  }
  const values: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) values[key] = value;
  }
  const [updated] = await db.update(emailCampaigns).set(values)
    .where(combineWithWritableScope(current, campaignScope, eq(emailCampaigns.id, id)))
    .returning();
  return updated ?? null;
}

export async function deleteCampaign(id: string) {
  const current = principal();
  const [deleted] = await db.delete(emailCampaigns)
    .where(combineWithWritableScope(current, campaignScope, eq(emailCampaigns.id, id)))
    .returning({ id: emailCampaigns.id });
  return deleted ?? null;
}
