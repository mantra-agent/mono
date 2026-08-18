import { resolvePersonId } from "../shared/person";
import { withPeopleSummaryStatus } from "../shared/people";
import type { ToolHandlerResult } from "../contracts";

/**
 * People core mutation handlers extracted from bridge-tools.ts: merge, update,
 * create, and set_daily_contact. Behavior, validation, result shapes, and error
 * handling are preserved verbatim; person resolution stays on the shared
 * resolvePersonId boundary and the empty-summary quality warning stays on the
 * shared withPeopleSummaryStatus helper. Public identity (tool-registry),
 * ownership/composition (domain-adapters), and the executeTool
 * invocation/authority boundary remain owned by their canonical modules.
 */

async function handlePeopleMerge(args: Record<string, any>): Promise<ToolHandlerResult> {
  const sourcePersonId = typeof args.sourcePersonId === "string" ? args.sourcePersonId.trim() : "";
  const targetPersonId = typeof args.targetPersonId === "string" ? args.targetPersonId.trim() : "";
  const expectedSourceName = typeof args.expectedSourceName === "string" ? args.expectedSourceName.trim() : "";
  const expectedTargetName = typeof args.expectedTargetName === "string" ? args.expectedTargetName.trim() : "";
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey.trim() : "";
  if (
    !sourcePersonId ||
    !targetPersonId ||
    !expectedSourceName ||
    !expectedTargetName ||
    !reason ||
    !idempotencyKey
  ) {
    return {
      result:
        "merge requires sourcePersonId, targetPersonId, expectedSourceName, expectedTargetName, reason, and idempotencyKey",
      error: true,
    };
  }

  const { peopleStorage } = await import("../../people-storage");
  const result = await peopleStorage.mergePeople({
    sourcePersonId,
    targetPersonId,
    expectedSourceName,
    expectedTargetName,
    reason,
    idempotencyKey,
  });
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: {
      source: "people_tool",
      action: "merge",
      sourcePersonId: result.sourcePersonId,
      targetPersonId: result.targetPersonId,
      personName: result.targetName,
      alreadyMerged: result.alreadyMerged,
    },
  });
  return {
    result: result.alreadyMerged
      ? `Person already merged: @person:${result.sourcePersonId} resolves to @person:${result.targetPersonId} (${result.targetName}).`
      : `Merged ${result.sourceName} (@person:${result.sourcePersonId}) into ${result.targetName} (@person:${result.targetPersonId}). Profile/history data and structured references were preserved, and the source ID remains a durable alias.`,
  };
}

async function handlePeopleUpdate(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { normalizePersonEmail, peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: `Person not found: ${args.id || args.name}`, error: true };

  const requestedNewName = typeof args.newName === "string" ? args.newName.trim() : "";
  const expectedCurrentName = typeof args.expectedCurrentName === "string" ? args.expectedCurrentName.trim() : "";
  if (expectedCurrentName && !requestedNewName) {
    return { result: "expectedCurrentName was provided without newName. Provide both to rename.", error: true };
  }

  const peopleMetadata = await import("@shared/people-metadata");
  const updates: Record<string, any> = {};
  if (typeof args.quickSummary === "string") updates.quickSummary = args.quickSummary || undefined;
  if (typeof args.cabinetLevel === "string") updates.cabinetLevel = args.cabinetLevel;
  if (typeof args.company === "string") updates.company = args.company || undefined;
  if (typeof args.role === "string") updates.role = args.role || undefined;
  if (typeof args.relation === "string") {
    if (args.relation.trim()) {
      const check = peopleMetadata.validateRelation(args.relation, "agent");
      if (!check.ok) return { result: check.error!, error: true };
      updates.relation = args.relation.trim();
    } else {
      updates.relation = undefined;
    }
  }
  if (Array.isArray(args.professionalRelations)) {
    const list = args.professionalRelations.filter((r: unknown): r is string => typeof r === "string" && r.trim().length > 0).map((r: string) => r.trim());
    const check = peopleMetadata.validateProfessionalRelations(list, "agent");
    if (!check.ok) return { result: check.error!, error: true };
    updates.professionalRelations = list;
  }
  if (typeof args.familiarity === "string") updates.familiarity = args.familiarity;
  if (typeof args.trust === "string") updates.trust = args.trust;
  if (typeof args.email === "string" && args.email.trim()) {
    const email = normalizePersonEmail(args.email);
    const existing = await peopleStorage.getPerson(resolved.id);
    if (!existing) return { result: `Person not found: ${resolved.id}`, error: true };
    updates.contactInfo = [
      ...existing.contactInfo.filter(contact =>
        contact.type !== "email" ||
        (contact.label !== "primary" && contact.value.trim().toLowerCase() !== email)
      ),
      { type: "email", label: "primary", value: email },
    ];
  }
  if (typeof args.slackUserId === "string" && args.slackUserId.trim()) {
    const { normalizePersonSlackUserId } = await import("../../people-storage");
    let slack: string;
    try {
      slack = normalizePersonSlackUserId(args.slackUserId);
    } catch {
      return { result: "slackUserId must look like U…", error: true };
    }
    const existing = await peopleStorage.getPerson(resolved.id);
    if (!existing) return { result: `Person not found: ${resolved.id}`, error: true };
    updates.socialProfiles = {
      ...(existing.socialProfiles || {}),
      slack,
    };
  }

  const companyIdValue = typeof args.companyId === "string" ? args.companyId.trim() : "";

  let ignoredTags: { tag: string; reason: string }[] = [];
  if (Array.isArray(args.tags)) {
    const existing = await peopleStorage.getPerson(resolved.id);
    const { gateProposedTags } = await import("../../tag-proposal");
    const gated = gateProposedTags(
      args.tags.filter((t: unknown): t is string => typeof t === "string"),
      {
        companyName: updates.company ?? existing?.company,
        role: updates.role ?? existing?.role,
      },
    );
    updates.tags = gated.tags;
    ignoredTags = gated.ignored;
  }

  if (!requestedNewName && Object.keys(updates).length === 0 && !companyIdValue) {
    return { result: "No updatable fields provided. Supported: newName (with expectedCurrentName), email, slackUserId, quickSummary, cabinetLevel, companyId, company, role, relation, professionalRelations, familiarity, trust, tags.", error: true };
  }

  let renamed = false;
  if (requestedNewName) {
    if (!expectedCurrentName) {
      return { result: `Rename requires expectedCurrentName confirmation. Current name is "${resolved.name}" — pass it back exactly as expectedCurrentName along with newName.`, error: true };
    }
    await peopleStorage.renamePerson({
      personId: resolved.id,
      newName: requestedNewName,
      expectedCurrentName,
    });
    renamed = true;
  }

  if (companyIdValue) {
    const { companyStorage } = await import("../../company-storage");
    await companyStorage.addPerson(companyIdValue, resolved.id);
  }

  const person = Object.keys(updates).length > 0
    ? await peopleStorage.updatePerson(resolved.id, updates)
    : await peopleStorage.getPerson(resolved.id);
  if (!person) return { result: `Person not found after update: ${resolved.id}`, error: true };
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "update", personId: person.id, personName: person.name },
  });

  const changed = [
    ...(renamed ? [`name (was "${expectedCurrentName}", preserved as nickname)`] : []),
    ...(companyIdValue ? ["companyId"] : []),
    ...Object.keys(updates).map(field => field === "contactInfo" ? "email" : field === "socialProfiles" ? "slackUserId" : field),
  ].join(", ");
  const ignoredNote = ignoredTags.length
    ? `\n\nIgnored redundant tags: ${ignoredTags.map(t => `${t.tag} (${t.reason})`).join(", ")}`
    : "";
  return { result: `Updated ${person.name} [person:${person.id}]: ${changed}${ignoredNote}`, data: ignoredTags.length ? { ignoredTags } : undefined };
}

async function handlePeopleCreate(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { normalizePersonEmail, peopleStorage } = await import("../../people-storage");
  const name = args.name;
  if (!name) return { result: "Missing person name", error: true };
  const contactInfo: Array<{ type: "email"; label: string; value: string }> = [];
  if (typeof args.email === "string" && args.email.trim()) {
    contactInfo.push({ type: "email", label: "primary", value: normalizePersonEmail(args.email) });
  }
  const peopleMetadata = await import("@shared/people-metadata");
  if (typeof args.relation === "string" && args.relation.trim()) {
    const check = peopleMetadata.validateRelation(args.relation, "agent");
    if (!check.ok) return { result: check.error!, error: true };
  }
  const professionalRelations = Array.isArray(args.professionalRelations)
    ? args.professionalRelations.filter((r: unknown): r is string => typeof r === "string" && r.trim().length > 0).map((r: string) => r.trim())
    : [];
  if (professionalRelations.length) {
    const check = peopleMetadata.validateProfessionalRelations(professionalRelations, "agent");
    if (!check.ok) return { result: check.error!, error: true };
  }
  const { gateProposedTags } = await import("../../tag-proposal");
  const tagFilter = gateProposedTags(
    Array.isArray(args.tags) ? args.tags.filter((t: unknown): t is string => typeof t === "string") : [],
    { companyName: args.company, role: args.role },
  );
  let slackUserId: string | undefined;
  if (typeof args.slackUserId === "string" && args.slackUserId.trim()) {
    const { normalizePersonSlackUserId } = await import("../../people-storage");
    try {
      slackUserId = normalizePersonSlackUserId(args.slackUserId);
    } catch {
      return { result: "slackUserId must look like U…", error: true };
    }
  }
  const person = await peopleStorage.createPerson({
    name,
    nicknames: [],
    cabinetLevel: args.cabinetLevel || "network",
    company: args.company || undefined,
    companyId: typeof args.companyId === "string" && args.companyId.trim() ? args.companyId.trim() : undefined,
    role: args.role || undefined,
    relation: (typeof args.relation === "string" ? args.relation.trim() : "") || undefined,
    professionalRelations,
    introducedBy: args.introducedBy || undefined,
    familiarity: args.familiarity || undefined,
    trust: args.trust || undefined,
    dailyContact: args.dailyContact || undefined,
    socialProfiles: slackUserId
      ? { slack: slackUserId }
      : {},
    contactInfo,
    importantDates: [],
    notes: [],
    interactions: [],
    tags: tagFilter.tags,
    quickSummary: typeof args.quickSummary === "string" ? args.quickSummary.trim() || undefined : undefined,
    private: false,
  });
  if (typeof args.companyId === "string" && args.companyId.trim()) {
    const { companyStorage } = await import("../../company-storage");
    await companyStorage.addPerson(args.companyId.trim(), person.id).catch(() => {});
  }
  if (args.notes) {
    await peopleStorage.addNote(person.id, args.notes);
  }
  const { eventBus: createBus } = await import("../../event-bus");
  createBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "create", personId: person.id, personName: person.name },
  });
  const ignoredNote = tagFilter.ignored.length
    ? `\n\nIgnored redundant tags: ${tagFilter.ignored.map(t => `${t.tag} (${t.reason})`).join(", ")}`
    : "";
  const result = `Person created: "${person.name}" [person:${person.id}] (cabinet: ${person.cabinetLevel})${args.email ? `, email: ${args.email}` : ""}${ignoredNote}`;
  return withPeopleSummaryStatus(result, person.quickSummary, Boolean(args.notes));
}

async function handlePeopleSetDailyContact(args: Record<string, any>): Promise<ToolHandlerResult> {
  const { peopleStorage } = await import("../../people-storage");
  const resolved = await resolvePersonId(args);
  if (!resolved) return { result: `Person not found: ${args.id || args.name}`, error: true };
  const value = args.dailyContact !== false;
  await peopleStorage.updatePerson(resolved.id, { dailyContact: value });
  const { eventBus } = await import("../../event-bus");
  eventBus.publish({
    category: "agent",
    event: "data:people_changed",
    payload: { source: "people_tool", action: "set_daily_contact", personId: resolved.id, personName: resolved.name },
  });
  return { result: `${resolved.name} [person:${resolved.id}] dailyContact set to ${value}` };
}

/** action → handler map for the people core-mutation surface. */
export const peopleMutationHandlers: Record<string, (args: Record<string, any>) => Promise<ToolHandlerResult>> = {
  update: handlePeopleUpdate,
  merge: handlePeopleMerge,
  create: handlePeopleCreate,
  set_daily_contact: handlePeopleSetDailyContact,
};
