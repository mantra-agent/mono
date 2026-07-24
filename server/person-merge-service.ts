import { and, eq, inArray, sql } from "drizzle-orm";
import {
  calendarEventPeople,
  communicationAudiences,
  memoryEntityLinks,
  memoryVnextEntityLinks,
  opportunities,
  opportunityInteractions,
  peopleImportCandidates,
  peopleImportDecisions,
  personEmails,
  personMergeAliases,
  personVaultMemberships,
  persons,
  simplePeopleSurfaceState,
  strategies,
  strategyActors,
} from "@shared/schema";
import { ADVISORY_LOCK_NS, db, fnv1a32 } from "./db";
import type { Principal } from "./principal";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";
import { combineWithSensitiveWritable } from "./sensitive-scope";
import type { Person } from "./people-storage";
import { repointNetworkProfilePersonId } from "./person-merge-values";
import { loadPersonVaultIds, visiblePersonPredicate, writablePersonPredicate } from "./person-vault-access";

const personScope = {
  scope: persons.scope,
  ownerUserId: persons.ownerUserId,
  accountId: persons.accountId,
};
const personVaultMembershipScope = {
  scope: personVaultMemberships.scope,
  ownerUserId: personVaultMemberships.ownerUserId,
  accountId: personVaultMemberships.accountId,
};
const aliasScope = {
  scope: personMergeAliases.scope,
  ownerUserId: personMergeAliases.ownerUserId,
  accountId: personMergeAliases.accountId,
};
const surfaceScope = {
  scope: simplePeopleSurfaceState.scope,
  ownerUserId: simplePeopleSurfaceState.ownerUserId,
  accountId: simplePeopleSurfaceState.accountId,
  vaultId: simplePeopleSurfaceState.vaultId,
};
const opportunityScope = {
  scope: opportunities.scope,
  ownerUserId: opportunities.ownerUserId,
  accountId: opportunities.accountId,
};
const opportunityInteractionScope = {
  scope: opportunityInteractions.scope,
  ownerUserId: opportunityInteractions.ownerUserId,
  accountId: opportunityInteractions.accountId,
};
const memoryEntityScope = {
  scope: memoryEntityLinks.scope,
  ownerUserId: memoryEntityLinks.ownerUserId,
  accountId: memoryEntityLinks.accountId,
};
const memoryVnextEntityScope = {
  scope: memoryVnextEntityLinks.scope,
  ownerUserId: memoryVnextEntityLinks.ownerUserId,
  accountId: memoryVnextEntityLinks.accountId,
};
const decisionScope = {
  ownerUserId: peopleImportDecisions.ownerUserId,
  accountId: peopleImportDecisions.accountId,
};
const candidateScope = {
  ownerUserId: peopleImportCandidates.ownerUserId,
  accountId: peopleImportCandidates.principalAccountId,
};
const audienceScope = {
  scope: communicationAudiences.scope,
  ownerUserId: communicationAudiences.ownerUserId,
  accountId: communicationAudiences.accountId,
};
const strategyScope = {
  scope: strategies.scope,
  ownerUserId: strategies.ownerUserId,
  accountId: strategies.accountId,
};
export const calendarPeopleOwnerColumns = {
  ownerUserId: calendarEventPeople.ownerUserId,
  principalAccountId: calendarEventPeople.principalAccountId,
  vaultId: calendarEventPeople.vaultId,
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface MergePeopleInput {
  sourcePersonId: string;
  targetPersonId: string;
  expectedSourceName: string;
  expectedTargetName: string;
  reason: string;
  idempotencyKey: string;
}

export interface MergePeopleResult {
  sourcePersonId: string;
  targetPersonId: string;
  sourceName: string;
  targetName: string;
  person: Person;
  alreadyMerged: boolean;
}

interface MergeRecordsResult {
  person: Person;
  interactionIdMap: Map<string, string>;
}

interface EmbeddedReferenceSnapshot {
  people: Array<{ id: string; networkProfile: unknown }>;
  audiences: Array<{ id: string; definition: unknown }>;
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function requireUserOwner(principal: Principal): { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Person merge requires an authenticated user principal with an account");
  }
  return { userId: principal.userId, accountId: principal.accountId };
}

async function acquireAccountLock(tx: Tx, accountId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NS.PERSON_MERGE}::int4, ${fnv1a32(accountId)}::int4)`,
  );
}

async function resolveAlias(tx: Tx, principal: Principal, id: string): Promise<string> {
  let current = id;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(current)) throw new Error(`Person merge alias cycle detected at ${current}`);
    seen.add(current);
    const rows = await tx
      .select({ targetId: personMergeAliases.targetId })
      .from(personMergeAliases)
      .where(
        combineWithVisibleScope(
          principal,
          aliasScope,
          eq(personMergeAliases.sourceId, current),
        ),
      )
      .limit(1);
    if (!rows[0]) return current;
    current = rows[0].targetId;
  }
  throw new Error(`Person merge alias depth exceeded for ${id}`);
}

function personValues(person: Person): Record<string, unknown> {
  return {
    name: person.name,
    nicknames: person.nicknames,
    cabinetLevel: person.cabinetLevel,
    photo: person.photo || null,
    birthday: person.birthday || null,
    company: person.company || null,
    companyId: person.companyId || null,
    role: person.role || null,
    professionalRelations: person.professionalRelations || [],
    relation: person.relation || null,
    introducedBy: person.introducedBy || null,
    familiarity: person.familiarity || null,
    trust: person.trust || null,
    met: person.met || null,
    socialProfiles: person.socialProfiles || {},
    contactInfo: person.contactInfo || [],
    importantDates: person.importantDates || [],
    notes: person.notes || [],
    interactions: person.interactions || [],
    tags: person.tags || [],
    aiSummary: person.aiSummary || null,
    quickSummary: person.quickSummary || null,
    identityContent: person.identityContent || null,
    relationshipProfile: person.relationshipProfile || null,
    networkProfile: person.networkProfile || null,
    dailyContact: Boolean(person.dailyContact),
    private: person.private,
    lastViewedAt: person.lastViewedAt ? new Date(person.lastViewedAt) : null,
    updatedAt: new Date(person.updatedAt),
  };
}

async function captureReferenceSnapshot(
  tx: Tx,
  principal: Principal,
  sourceId: string,
): Promise<Record<string, unknown>> {
  const [
    calendarPeople,
    memoryLinks,
    memoryVnextLinks,
    opportunityRows,
    opportunityInteractionRows,
    importCandidates,
    importDecisions,
    surfaceRows,
    aliasesToSource,
    personRows,
    audienceRows,
    actorRows,
  ] = await Promise.all([
    tx.select().from(calendarEventPeople).where(
      combineWithSensitiveWritable(
        calendarPeopleOwnerColumns,
        eq(calendarEventPeople.personId, sourceId),
        principal,
      ),
    ),
    tx.select().from(memoryEntityLinks).where(
      combineWithWritableScope(
        principal,
        memoryEntityScope,
        and(eq(memoryEntityLinks.entityType, "person"), eq(memoryEntityLinks.entityId, sourceId)),
      ),
    ),
    tx.select().from(memoryVnextEntityLinks).where(
      combineWithWritableScope(
        principal,
        memoryVnextEntityScope,
        and(eq(memoryVnextEntityLinks.entityType, "person"), eq(memoryVnextEntityLinks.entityId, sourceId)),
      ),
    ),
    tx.select({
      id: opportunities.id,
      contactPersonId: opportunities.contactPersonId,
      championPersonId: opportunities.championPersonId,
    }).from(opportunities).where(
      combineWithWritableScope(
        principal,
        opportunityScope,
        sql`${opportunities.contactPersonId} = ${sourceId} OR ${opportunities.championPersonId} = ${sourceId}`,
      ),
    ),
    tx.select().from(opportunityInteractions).where(
      combineWithWritableScope(
        principal,
        opportunityInteractionScope,
        eq(opportunityInteractions.personId, sourceId),
      ),
    ),
    tx.select().from(peopleImportCandidates).where(
      combineWithWritableScope(
        principal,
        candidateScope,
        eq(peopleImportCandidates.mergedPersonId, sourceId),
      ),
    ),
    tx.select().from(peopleImportDecisions).where(
      combineWithWritableScope(
        principal,
        decisionScope,
        eq(peopleImportDecisions.personId, sourceId),
      ),
    ),
    tx.select().from(simplePeopleSurfaceState).where(
      combineWithWritableScope(
        principal,
        surfaceScope,
        eq(simplePeopleSurfaceState.personId, sourceId),
      ),
    ),
    tx.select().from(personMergeAliases).where(
      combineWithWritableScope(
        principal,
        aliasScope,
        eq(personMergeAliases.targetId, sourceId),
      ),
    ),
    tx.select({ id: persons.id, networkProfile: persons.networkProfile }).from(persons).where(
      combineWithWritableScope(
        principal,
        personScope,
        sql`${persons.networkProfile} @> ${JSON.stringify({ connections: [{ personId: sourceId }] })}::jsonb`,
      ),
    ),
    tx.select({ id: communicationAudiences.id, definition: communicationAudiences.definition })
      .from(communicationAudiences)
      .where(
        combineWithWritableScope(
          principal,
          audienceScope,
          sql`${communicationAudiences.definition} @> ${JSON.stringify({ personIds: [sourceId] })}::jsonb`,
        ),
      ),
    tx.select({ actor: strategyActors })
      .from(strategyActors)
      .innerJoin(strategies, eq(strategyActors.goalId, strategies.id))
      .where(
        combineWithWritableScope(
          principal,
          strategyScope,
          eq(strategyActors.personId, sourceId),
        ),
      ),
  ]);

  const embedded: EmbeddedReferenceSnapshot = {
    people: personRows.filter(row =>
      (row.networkProfile as Person["networkProfile"] | undefined)?.connections?.some(
        connection => connection.personId === sourceId,
      ),
    ),
    audiences: audienceRows.filter(row => {
      const definition = row.definition as { personIds?: string[] };
      return Array.isArray(definition.personIds) && definition.personIds.includes(sourceId);
    }),
  };

  return {
    calendarPeople,
    memoryLinks,
    memoryVnextLinks,
    opportunities: opportunityRows,
    opportunityInteractions: opportunityInteractionRows,
    importCandidates,
    importDecisions,
    surfaceRows,
    aliasesToSource,
    embeddedPeople: embedded.people,
    communicationAudiences: embedded.audiences,
    strategyActors: actorRows.map(row => row.actor),
  };
}

async function repointCalendarPeople(
  tx: Tx,
  principal: Principal,
  sourceId: string,
  target: Person,
): Promise<void> {
  await tx.delete(calendarEventPeople).where(
    combineWithSensitiveWritable(
      calendarPeopleOwnerColumns,
      and(
        eq(calendarEventPeople.personId, sourceId),
        sql`EXISTS (
          SELECT 1 FROM calendar_event_people target_link
          WHERE target_link.metadata_id = ${calendarEventPeople.metadataId}
            AND target_link.person_id = ${target.id}
        )`,
      ),
      principal,
    ),
  );
  await tx.update(calendarEventPeople)
    .set({ personId: target.id, personName: target.name })
    .where(
      combineWithSensitiveWritable(
        calendarPeopleOwnerColumns,
        eq(calendarEventPeople.personId, sourceId),
        principal,
      ),
    );
  await tx.update(calendarEventPeople)
    .set({ personName: target.name })
    .where(
      combineWithSensitiveWritable(
        calendarPeopleOwnerColumns,
        eq(calendarEventPeople.personId, target.id),
        principal,
      ),
    );
}

async function repointMemoryLinks(
  tx: Tx,
  principal: Principal,
  sourceId: string,
  targetId: string,
): Promise<void> {
  await tx.delete(memoryVnextEntityLinks).where(
    combineWithWritableScope(
      principal,
      memoryVnextEntityScope,
      and(
        eq(memoryVnextEntityLinks.entityType, "person"),
        eq(memoryVnextEntityLinks.entityId, sourceId),
        sql`EXISTS (
          SELECT 1 FROM memory_vnext_entity_links target_link
          WHERE target_link.claim_id = ${memoryVnextEntityLinks.claimId}
            AND target_link.entity_type = 'person'
            AND target_link.entity_id = ${targetId}
        )`,
      ),
    ),
  );
  await tx.update(memoryVnextEntityLinks)
    .set({ entityId: targetId })
    .where(
      combineWithWritableScope(
        principal,
        memoryVnextEntityScope,
        and(
          eq(memoryVnextEntityLinks.entityType, "person"),
          eq(memoryVnextEntityLinks.entityId, sourceId),
        ),
      ),
    );

  await tx.delete(memoryEntityLinks).where(
    combineWithWritableScope(
      principal,
      memoryEntityScope,
      and(
        eq(memoryEntityLinks.entityType, "person"),
        eq(memoryEntityLinks.entityId, sourceId),
        sql`EXISTS (
          SELECT 1 FROM memory_entity_links target_link
          WHERE target_link.memory_id = ${memoryEntityLinks.memoryId}
            AND target_link.entity_type = 'person'
            AND target_link.entity_id = ${targetId}
        )`,
      ),
    ),
  );
  await tx.update(memoryEntityLinks)
    .set({ entityId: targetId })
    .where(
      combineWithWritableScope(
        principal,
        memoryEntityScope,
        and(eq(memoryEntityLinks.entityType, "person"), eq(memoryEntityLinks.entityId, sourceId)),
      ),
    );
}

async function repointOpportunityInteractions(
  tx: Tx,
  principal: Principal,
  sourceId: string,
  targetId: string,
  interactionIdMap: Map<string, string>,
): Promise<void> {
  const rows = await tx.select().from(opportunityInteractions).where(
    combineWithWritableScope(
      principal,
      opportunityInteractionScope,
      eq(opportunityInteractions.personId, sourceId),
    ),
  );
  for (const row of rows) {
    const interactionId = interactionIdMap.get(row.interactionId) || row.interactionId;
    const duplicate = await tx
      .select({ id: opportunityInteractions.id })
      .from(opportunityInteractions)
      .where(
        combineWithVisibleScope(
          principal,
          opportunityInteractionScope,
          and(
            eq(opportunityInteractions.opportunityId, row.opportunityId),
            eq(opportunityInteractions.personId, targetId),
            eq(opportunityInteractions.interactionId, interactionId),
          ),
        ),
      )
      .limit(1);
    if (duplicate[0]) {
      await tx.delete(opportunityInteractions).where(
        combineWithWritableScope(
          principal,
          opportunityInteractionScope,
          eq(opportunityInteractions.id, row.id),
        ),
      );
      continue;
    }
    await tx.update(opportunityInteractions)
      .set({ personId: targetId, interactionId })
      .where(
        combineWithWritableScope(
          principal,
          opportunityInteractionScope,
          eq(opportunityInteractions.id, row.id),
        ),
      );
  }
}

async function repointSurfaceState(
  tx: Tx,
  principal: Principal,
  sourceId: string,
  targetId: string,
): Promise<void> {
  await tx.delete(simplePeopleSurfaceState).where(
    combineWithWritableScope(
      principal,
      surfaceScope,
      and(
        eq(simplePeopleSurfaceState.personId, sourceId),
        sql`EXISTS (
          SELECT 1 FROM simple_people_surface_state target_state
          WHERE target_state.person_id = ${targetId}
            AND target_state.account_id = ${simplePeopleSurfaceState.accountId}
            AND target_state.reason_key = ${simplePeopleSurfaceState.reasonKey}
        )`,
      ),
    ),
  );
  await tx.update(simplePeopleSurfaceState)
    .set({ personId: targetId, updatedAt: new Date() })
    .where(
      combineWithWritableScope(
        principal,
        surfaceScope,
        eq(simplePeopleSurfaceState.personId, sourceId),
      ),
    );
}

async function repointEmbeddedPeople(
  tx: Tx,
  principal: Principal,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const peopleRows = await tx
    .select({ id: persons.id, networkProfile: persons.networkProfile })
    .from(persons)
    .where(
      combineWithWritableScope(
        principal,
        personScope,
        sql`${persons.networkProfile} @> ${JSON.stringify({ connections: [{ personId: sourceId }] })}::jsonb`,
      ),
    );
  for (const row of peopleRows) {
    const updated = repointNetworkProfilePersonId(
      row.networkProfile as Person["networkProfile"],
      sourceId,
      targetId,
    );
    if (updated === row.networkProfile) continue;
    await tx.update(persons)
      .set({ networkProfile: updated, updatedAt: new Date() })
      .where(combineWithWritableScope(principal, personScope, eq(persons.id, row.id)));
  }

  const audiences = await tx
    .select({ id: communicationAudiences.id, definition: communicationAudiences.definition })
    .from(communicationAudiences)
    .where(
      combineWithWritableScope(
        principal,
        audienceScope,
        sql`${communicationAudiences.definition} @> ${JSON.stringify({ personIds: [sourceId] })}::jsonb`,
      ),
    );
  for (const audience of audiences) {
    const definition = audience.definition as { personIds?: string[] };
    if (!Array.isArray(definition.personIds) || !definition.personIds.includes(sourceId)) continue;
    const personIds = [...new Set(definition.personIds.map(id => (id === sourceId ? targetId : id)))];
    await tx.update(communicationAudiences)
      .set({ definition: { ...definition, personIds }, updatedAt: new Date() })
      .where(
        combineWithWritableScope(
          principal,
          audienceScope,
          eq(communicationAudiences.id, audience.id),
        ),
      );
  }
}

async function repointReferences(
  tx: Tx,
  principal: Principal,
  sourceId: string,
  target: Person,
  interactionIdMap: Map<string, string>,
): Promise<void> {
  await repointCalendarPeople(tx, principal, sourceId, target);
  await repointMemoryLinks(tx, principal, sourceId, target.id);
  await repointOpportunityInteractions(
    tx,
    principal,
    sourceId,
    target.id,
    interactionIdMap,
  );
  await repointSurfaceState(tx, principal, sourceId, target.id);
  await repointEmbeddedPeople(tx, principal, sourceId, target.id);

  await tx.update(opportunities)
    .set({ contactPersonId: target.id, updatedAt: new Date() })
    .where(
      combineWithWritableScope(
        principal,
        opportunityScope,
        eq(opportunities.contactPersonId, sourceId),
      ),
    );
  await tx.update(opportunities)
    .set({ championPersonId: target.id, updatedAt: new Date() })
    .where(
      combineWithWritableScope(
        principal,
        opportunityScope,
        eq(opportunities.championPersonId, sourceId),
      ),
    );
  await tx.update(peopleImportCandidates)
    .set({
      mergedPersonId: target.id,
      candidate: sql`${peopleImportCandidates.candidate} - 'mergedPersonId'`,
      updatedAt: new Date(),
    })
    .where(
      combineWithWritableScope(
        principal,
        candidateScope,
        eq(peopleImportCandidates.mergedPersonId, sourceId),
      ),
    );

  const actors = await tx
    .select({ id: strategyActors.id })
    .from(strategyActors)
    .innerJoin(strategies, eq(strategyActors.goalId, strategies.id))
    .where(
      combineWithWritableScope(
        principal,
        strategyScope,
        eq(strategyActors.personId, sourceId),
      ),
    );
  for (const actor of actors) {
    await tx.update(strategyActors)
      .set({ personId: target.id, name: target.name })
      .where(eq(strategyActors.id, actor.id));
  }
}

async function syncEmailIndex(tx: Tx, sourceId: string, target: Person): Promise<void> {
  const emails = [...new Set(
    target.contactInfo
      .filter(contact => contact.type === "email" && contact.value.includes("@"))
      .map(contact => contact.value.trim().toLowerCase()),
  )];
  if (emails.length > 0) {
    const conflicts = await tx
      .select({ email: personEmails.email, personId: personEmails.personId })
      .from(personEmails)
      .where(inArray(personEmails.email, emails));
    const foreign = conflicts.find(
      row => row.personId !== sourceId && row.personId !== target.id,
    );
    if (foreign) {
      throw new Error(
        "Cannot merge because one of the merged emails is indexed to a different Person",
      );
    }
  }

  await tx.delete(personEmails).where(inArray(personEmails.personId, [sourceId, target.id]));
  const now = new Date();
  for (const email of emails) {
    await tx.insert(personEmails).values({
      email,
      personId: target.id,
      personName: target.name,
      source: "contact_info",
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function personFromExistingTarget(
  tx: Tx,
  principal: Principal,
  targetId: string,
  mergeRecords: (
    targetRow: Record<string, unknown>,
    sourceRow: Record<string, unknown>,
  ) => MergeRecordsResult,
): Promise<Person> {
  const rows = await tx
    .select()
    .from(persons)
    .where(visiblePersonPredicate(principal, eq(persons.id, targetId)))
    .limit(1);
  if (!rows[0]) throw new Error(`Merged Person target ${targetId} not found`);
  const vaultIds = (await loadPersonVaultIds(principal, [targetId])).get(targetId) ?? [];
  return mergeRecords(
    { ...rows[0], vaultIds } as unknown as Record<string, unknown>,
    { ...rows[0], vaultIds } as unknown as Record<string, unknown>,
  ).person;
}

export async function performPersonMerge(
  principal: Principal,
  input: MergePeopleInput,
  mergeRecords: (
    targetRow: Record<string, unknown>,
    sourceRow: Record<string, unknown>,
  ) => MergeRecordsResult,
): Promise<MergePeopleResult> {
  const owner = requireUserOwner(principal);
  return db.transaction(async tx => {
    await acquireAccountLock(tx, owner.accountId);

    const priorKey = await tx
      .select()
      .from(personMergeAliases)
      .where(
        combineWithVisibleScope(
          principal,
          aliasScope,
          eq(personMergeAliases.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (priorKey[0]) {
      const requestedTarget = await resolveAlias(tx, principal, input.targetPersonId);
      if (
        priorKey[0].sourceId !== input.sourcePersonId ||
        priorKey[0].targetId !== requestedTarget
      ) {
        throw new Error(
          `Idempotency key already used for Person merge ${priorKey[0].sourceId} -> ${priorKey[0].targetId}`,
        );
      }
      const person = await personFromExistingTarget(
        tx,
        principal,
        priorKey[0].targetId,
        mergeRecords,
      );
      return {
        sourcePersonId: priorKey[0].sourceId,
        targetPersonId: priorKey[0].targetId,
        sourceName: priorKey[0].sourceName,
        targetName: priorKey[0].targetName,
        person,
        alreadyMerged: true,
      };
    }

    const sourceId = await resolveAlias(tx, principal, input.sourcePersonId);
    const targetId = await resolveAlias(tx, principal, input.targetPersonId);
    if (sourceId === targetId) {
      const person = await personFromExistingTarget(tx, principal, targetId, mergeRecords);
      return {
        sourcePersonId: input.sourcePersonId,
        targetPersonId: targetId,
        sourceName: input.expectedSourceName,
        targetName: person.name,
        person,
        alreadyMerged: true,
      };
    }

    const rows = await tx
      .select()
      .from(persons)
      .where(
        writablePersonPredicate(principal, inArray(persons.id, [sourceId, targetId])),
      )
      .for("update");
    const sourceRow = rows.find(row => row.id === sourceId);
    const targetRow = rows.find(row => row.id === targetId);
    if (!sourceRow || !targetRow) {
      throw new Error("Source and target Person must both exist and be writable");
    }
    if (
      sourceRow.ownerUserId !== targetRow.ownerUserId ||
      sourceRow.accountId !== targetRow.accountId ||
      sourceRow.scope !== targetRow.scope
    ) {
      throw new Error("Source and target Person ownership does not match");
    }
    if (
      sourceRow.ownerUserId !== owner.userId ||
      sourceRow.accountId !== owner.accountId ||
      sourceRow.scope !== "user"
    ) {
      throw new Error("Person merge only supports user-owned records in the active account");
    }
    if (normalizedName(sourceRow.name) !== normalizedName(input.expectedSourceName)) {
      throw new Error(`Source name confirmation mismatch: expected ${sourceRow.name}`);
    }
    if (normalizedName(targetRow.name) !== normalizedName(input.expectedTargetName)) {
      throw new Error(`Target name confirmation mismatch: expected ${targetRow.name}`);
    }

    const referenceSnapshot = await captureReferenceSnapshot(tx, principal, sourceId);
    const merged = mergeRecords(
      targetRow as unknown as Record<string, unknown>,
      sourceRow as unknown as Record<string, unknown>,
    );

    await syncEmailIndex(tx, sourceId, merged.person);
    await tx.update(persons)
      .set(personValues(merged.person))
      .where(
        writablePersonPredicate(principal, eq(persons.id, targetId)),
      );

    const insertOwnership = ownedInsertValues(principal, aliasScope);
    await tx.insert(personMergeAliases).values({
      sourceId,
      targetId,
      sourceName: sourceRow.name,
      targetName: merged.person.name,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      sourceSnapshot: sourceRow as unknown as Record<string, unknown>,
      targetSnapshot: targetRow as unknown as Record<string, unknown>,
      mergedSnapshot: merged.person as unknown as Record<string, unknown>,
      referenceSnapshot,
      ...insertOwnership,
      ownerUserId: owner.userId,
      accountId: owner.accountId,
      mergedAt: new Date(),
    });

    const sourceMemberships = await tx
      .select({ vaultId: personVaultMemberships.vaultId })
      .from(personVaultMemberships)
      .where(
        combineWithWritableScope(
          principal,
          personVaultMembershipScope,
          eq(personVaultMemberships.personId, sourceId),
        ),
      );
    if (sourceMemberships.length > 0) {
      await tx.insert(personVaultMemberships)
        .values(sourceMemberships.map(({ vaultId }) => ({
          personId: targetId,
          vaultId,
          scope: "user",
          ownerUserId: owner.userId,
          accountId: owner.accountId,
          createdByUserId: owner.userId,
        })))
        .onConflictDoNothing();
    }

    await repointReferences(
      tx,
      principal,
      sourceId,
      merged.person,
      merged.interactionIdMap,
    );
    await tx.update(personMergeAliases)
      .set({ targetId, targetName: merged.person.name })
      .where(
        combineWithWritableScope(
          principal,
          aliasScope,
          eq(personMergeAliases.targetId, sourceId),
        ),
      );
    await tx.delete(persons).where(
      writablePersonPredicate(principal, eq(persons.id, sourceId)),
    );
    merged.person.vaultIds = [...new Set([
      ...(merged.person.vaultIds || []),
      ...sourceMemberships.map(({ vaultId }) => vaultId),
    ])].sort();

    return {
      sourcePersonId: sourceId,
      targetPersonId: targetId,
      sourceName: sourceRow.name,
      targetName: merged.person.name,
      person: merged.person,
      alreadyMerged: false,
    };
  });
}
