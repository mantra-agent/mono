import crypto from "crypto";
import { desc, eq } from "drizzle-orm";
import { peopleImportDecisions } from "@shared/schema";
import { db } from "./db";
import { createLogger } from "./log";
import {
  getCandidateByEmail,
  getPendingCandidatesFromDb,
  isSyntheticContactEmail,
  updateCandidateDecision,
  type ImportContactInfo,
  type StoredImportCandidate,
} from "./import-queue";
import { peopleStorage, type Interaction, type Person } from "./people-storage";
import { getCurrentPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { storage } from "./storage";

const log = createLogger("PeopleImportDecisionService");
const decisionScope = {
  ownerUserId: peopleImportDecisions.ownerUserId,
  accountId: peopleImportDecisions.accountId,
};
const MAX_LIST_LIMIT = 100;
const MAX_MATCHES = 10;

export type PeopleImportOutcome = "added" | "merged" | "skipped" | "unchanged" | "conflict" | "undone";
export type PeopleImportAction = "add" | "merge" | "skip" | "undo";
export interface FieldChange { field: string; before: unknown; after: unknown; }
export interface PeopleImportDecisionResult {
  outcome: PeopleImportOutcome;
  candidateId: string;
  personId?: string;
  decisionId?: string;
  changes: FieldChange[];
  warnings: string[];
}
export interface ImportCandidateRecord { candidateId: string; candidate: StoredImportCandidate; }
export interface ImportMatch {
  personId: string;
  name: string;
  confidence: "high" | "moderate" | "low";
  reasons: string[];
}
export interface ImportDecisionInput {
  candidateId: string;
  idempotencyKey: string;
  cabinetLevel?: string;
  tags?: string[];
  mergePersonId?: string;
  name?: string;
  company?: string;
  role?: string;
  relation?: string;
  professionalRelations?: string[];
  familiarity?: Person["familiarity"];
  trust?: Person["trust"];
  met?: string;
  notes?: string;
  introducedBy?: string;
}

function candidateIdFor(candidate: Pick<StoredImportCandidate, "email">): string {
  return candidate.email.trim().toLowerCase();
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

function hashRequest(action: PeopleImportAction, input: ImportDecisionInput): string {
  return crypto.createHash("sha256").update(JSON.stringify(stable({ action, input }))).digest("hex");
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") return stable(value);
  return typeof value === "string" ? value.trim() : value;
}

function change(field: string, before: unknown, after: unknown): FieldChange | null {
  const normalizedBefore = normalizeValue(before);
  const normalizedAfter = normalizeValue(after);
  return JSON.stringify(normalizedBefore) === JSON.stringify(normalizedAfter) ? null : { field, before: normalizedBefore, after: normalizedAfter };
}

function contactsFor(candidate: StoredImportCandidate): ImportContactInfo[] {
  if (candidate.contactInfo?.length) return candidate.contactInfo.filter(contact => contact.type !== "email" || !isSyntheticContactEmail(contact.value));
  if (isSyntheticContactEmail(candidate.email)) return [];
  return [{ type: "email", label: candidate.source === "ios_contacts" ? "iOS" : "Gmail", value: candidate.email }];
}

function importedInteractions(candidate: StoredImportCandidate): Array<Omit<Interaction, "id">> {
  const seen = new Set<string>();
  return [...(candidate.interactions || [])]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .flatMap(ix => {
      const date = ix.date.split("T")[0];
      const summary = `${ix.direction === "sent" ? "Sent" : "Received"}: ${ix.subject}`;
      const key = `${date}_email_${summary}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ date, type: "email" as const, summary, context: ix.snippet || undefined }];
    });
}

function snapshotPerson(person: Person): Record<string, unknown> {
  return stable(person) as Record<string, unknown>;
}

async function findAuditByIdempotency(key: string) {
  const principal = getCurrentPrincipal();
  return (await db.select().from(peopleImportDecisions).where(
    combineWithVisibleScope(principal, decisionScope, eq(peopleImportDecisions.idempotencyKey, key)),
  ).limit(1))[0] || null;
}

async function recordAudit(args: {
  action: PeopleImportAction;
  input: ImportDecisionInput;
  result: PeopleImportDecisionResult;
  undoData?: Record<string, unknown>;
}): Promise<PeopleImportDecisionResult> {
  const principal = getCurrentPrincipal();
  const decisionId = crypto.randomUUID();
  const recorded = { ...args.result, decisionId };
  await db.insert(peopleImportDecisions).values({
    id: decisionId,
    candidateId: normalizeId(args.input.candidateId),
    action: args.action,
    outcome: recorded.outcome,
    personId: recorded.personId || null,
    idempotencyKey: args.input.idempotencyKey,
    requestHash: hashRequest(args.action, args.input),
    result: recorded,
    undoData: args.undoData || null,
    ...ownedInsertValues(principal, decisionScope),
  });
  log.info(`decision recorded action=${args.action} outcome=${recorded.outcome} candidateId=${recorded.candidateId} decisionId=${decisionId}`);
  return recorded;
}

async function idempotent(action: PeopleImportAction, input: ImportDecisionInput): Promise<PeopleImportDecisionResult | null> {
  if (!input.idempotencyKey?.trim()) throw new Error("idempotencyKey required");
  input = { ...input, idempotencyKey: input.idempotencyKey.trim() };
  const existing = await findAuditByIdempotency(input.idempotencyKey);
  if (!existing) return null;
  if (existing.requestHash !== hashRequest(action, { ...input, idempotencyKey: input.idempotencyKey.trim() })) {
    throw new Error("Idempotency key already used for a different People import request");
  }
  return existing.result as unknown as PeopleImportDecisionResult;
}

export async function listImportCandidates(options: { limit?: number; offset?: number } = {}): Promise<ImportCandidateRecord[]> {
  const limit = Math.max(1, Math.min(options.limit || 50, MAX_LIST_LIMIT));
  const offset = Math.max(0, options.offset || 0);
  return (await getPendingCandidatesFromDb()).slice(offset, offset + limit).map(candidate => ({ candidateId: candidateIdFor(candidate), candidate }));
}

export async function getImportCandidate(candidateId: string): Promise<ImportCandidateRecord | null> {
  const candidate = await getCandidateByEmail(normalizeId(candidateId));
  return candidate ? { candidateId: candidateIdFor(candidate), candidate } : null;
}

function normalizePhone(value: string): string { return value.replace(/[^+\d]/g, ""); }
function normalizeEmail(value: string): string { return value.trim().toLowerCase(); }

export async function findImportMatches(candidateId: string, limit = MAX_MATCHES): Promise<ImportMatch[]> {
  const record = await getImportCandidate(candidateId);
  if (!record) return [];
  const candidate = record.candidate;
  const emails = new Set(contactsFor(candidate).filter(c => c.type === "email").map(c => normalizeEmail(c.value)));
  const phones = new Set(contactsFor(candidate).filter(c => c.type === "phone").map(c => normalizePhone(c.value)));
  const candidateName = (candidate.displayName || candidate.name || "").trim().toLowerCase();
  const candidateCompany = (candidate.company || "").trim().toLowerCase();
  const matches: ImportMatch[] = [];
  for (const entry of await peopleStorage.listPeople()) {
    const person = await peopleStorage.getPerson(entry.id);
    if (!person) continue;
    const reasons: string[] = [];
    if (person.contactInfo.some(c => c.type === "email" && emails.has(normalizeEmail(c.value)))) reasons.push("exact_email");
    if (person.contactInfo.some(c => c.type === "phone" && phones.has(normalizePhone(c.value)))) reasons.push("exact_phone");
    if (candidate.mergedPersonId === person.id) reasons.push("linked_person");
    if (candidateName && person.name.trim().toLowerCase() === candidateName) reasons.push("exact_name");
    if (candidateCompany && person.company?.trim().toLowerCase() === candidateCompany) reasons.push("exact_company");
    if (!reasons.length) continue;
    const high = reasons.some(reason => ["exact_email", "exact_phone", "linked_person"].includes(reason));
    matches.push({ personId: person.id, name: person.name, confidence: high ? "high" : reasons.length > 1 ? "moderate" : "low", reasons });
  }
  const rank = { high: 3, moderate: 2, low: 1 };
  return matches.sort((a, b) => rank[b.confidence] - rank[a.confidence] || b.reasons.length - a.reasons.length).slice(0, Math.max(1, Math.min(limit, MAX_MATCHES)));
}

async function requirePending(input: ImportDecisionInput): Promise<StoredImportCandidate | PeopleImportDecisionResult> {
  const record = await getImportCandidate(input.candidateId);
  if (!record) return { outcome: "conflict", candidateId: normalizeId(input.candidateId), changes: [], warnings: ["Candidate not found"] };
  if (record.candidate.decision !== "pending") return { outcome: "unchanged", candidateId: record.candidateId, personId: record.candidate.mergedPersonId, changes: [], warnings: [`Candidate already ${record.candidate.decision}`] };
  return record.candidate;
}

export async function addImportCandidate(input: ImportDecisionInput): Promise<PeopleImportDecisionResult> {
  input = { ...input, candidateId: normalizeId(input.candidateId), idempotencyKey: input.idempotencyKey.trim() };
  const replay = await idempotent("add", input); if (replay) return replay;
  const pending = await requirePending(input); if (!("email" in pending)) return recordAudit({ action: "add", input, result: pending });
  const candidate = pending;
  const person = await peopleStorage.createPerson({
    name: input.name || candidate.name || candidate.email.split("@")[0], cabinetLevel: input.cabinetLevel || "network",
    contactInfo: contactsFor(candidate), tags: input.tags || [], nicknames: [], socialProfiles: {}, importantDates: [], notes: [], interactions: [], private: false,
    ...(input.company ? { company: input.company } : candidate.company ? { company: candidate.company } : {}),
    ...(input.role ? { role: input.role } : candidate.role ? { role: candidate.role } : {}), ...(input.relation ? { relation: input.relation } : {}),
    ...(input.professionalRelations?.length ? { professionalRelations: input.professionalRelations } : {}), ...(input.familiarity ? { familiarity: input.familiarity } : {}),
    ...(input.trust ? { trust: input.trust } : {}), ...(input.met ? { met: input.met } : {}), ...(input.introducedBy ? { introducedBy: input.introducedBy } : {}),
  });
  if (input.notes) await peopleStorage.addNote(person.id, input.notes);
  for (const interaction of importedInteractions(candidate)) await peopleStorage.addInteraction(person.id, interaction);
  const finalPerson = await peopleStorage.getPerson(person.id);
  await updateCandidateDecision(input.candidateId, { decision: "added", decidedAt: new Date().toISOString(), mergedPersonId: person.id });
  const changes = [change("candidate.decision", "pending", "added"), change("person", null, finalPerson)].filter(Boolean) as FieldChange[];
  return recordAudit({ action: "add", input, result: { outcome: "added", candidateId: input.candidateId, personId: person.id, changes, warnings: [] }, undoData: { personAfter: finalPerson ? snapshotPerson(finalPerson) : null, previousCandidate: candidate } });
}

export async function mergeImportCandidate(input: ImportDecisionInput): Promise<PeopleImportDecisionResult> {
  input = { ...input, candidateId: normalizeId(input.candidateId), idempotencyKey: input.idempotencyKey.trim() };
  const replay = await idempotent("merge", input); if (replay) return replay;
  if (!input.mergePersonId) throw new Error("mergePersonId required for merge");
  const pending = await requirePending(input); if (!("email" in pending)) return recordAudit({ action: "merge", input, result: pending });
  const before = await peopleStorage.getPerson(input.mergePersonId);
  if (!before) return recordAudit({ action: "merge", input, result: { outcome: "conflict", candidateId: input.candidateId, changes: [], warnings: ["Target person not found"] } });
  const existingContacts = new Set(before.contactInfo.map(c => `${c.type}:${c.type === "email" ? normalizeEmail(c.value) : c.type === "phone" ? normalizePhone(c.value) : c.value.trim().toLowerCase()}`));
  const additions = contactsFor(pending).filter(c => !existingContacts.has(`${c.type}:${c.type === "email" ? normalizeEmail(c.value) : c.type === "phone" ? normalizePhone(c.value) : c.value.trim().toLowerCase()}`));
  const updates: Partial<Person> = {};
  if (additions.length) updates.contactInfo = [...before.contactInfo, ...additions];
  if (input.tags?.length) updates.tags = [...new Set([...(before.tags || []), ...input.tags])];
  if (input.introducedBy && !before.introducedBy) updates.introducedBy = input.introducedBy;
  if (pending.company && !before.company) updates.company = pending.company;
  if (pending.role && !before.role) updates.role = pending.role;
  if (Object.keys(updates).length) await peopleStorage.updatePerson(before.id, updates);
  if (input.notes) await peopleStorage.addNote(before.id, input.notes);
  const existingKeys = new Set(before.interactions.map(ix => `${ix.date}_${ix.type}_${ix.summary}`));
  for (const interaction of importedInteractions(pending)) if (!existingKeys.has(`${interaction.date}_${interaction.type}_${interaction.summary}`)) await peopleStorage.addInteraction(before.id, interaction);
  const after = await peopleStorage.getPerson(before.id);
  await updateCandidateDecision(input.candidateId, { decision: "merged", decidedAt: new Date().toISOString(), mergedPersonId: before.id });
  const fields: Array<keyof Person> = ["contactInfo", "tags", "introducedBy", "company", "role", "notes", "interactions"];
  const changes = [change("candidate.decision", "pending", "merged"), ...fields.map(field => change(`person.${field}`, before[field], after?.[field]))].filter(Boolean) as FieldChange[];
  return recordAudit({ action: "merge", input, result: { outcome: "merged", candidateId: input.candidateId, personId: before.id, changes, warnings: [] }, undoData: { personBefore: snapshotPerson(before), personAfter: after ? snapshotPerson(after) : null, previousCandidate: pending } });
}

export async function skipImportCandidate(input: ImportDecisionInput): Promise<PeopleImportDecisionResult> {
  input = { ...input, candidateId: normalizeId(input.candidateId), idempotencyKey: input.idempotencyKey.trim() };
  const replay = await idempotent("skip", input); if (replay) return replay;
  const pending = await requirePending(input); if (!("email" in pending)) return recordAudit({ action: "skip", input, result: pending });
  await storage.addToGmailSkipList([{ email: input.candidateId, name: pending.name || undefined }]);
  await updateCandidateDecision(input.candidateId, { decision: "skipped", decidedAt: new Date().toISOString(), mergedPersonId: undefined });
  return recordAudit({ action: "skip", input, result: { outcome: "skipped", candidateId: input.candidateId, changes: [{ field: "candidate.decision", before: "pending", after: "skipped" }], warnings: [] }, undoData: { previousCandidate: pending } });
}

function personMatchesSnapshot(person: Person, snapshot: Record<string, unknown>): boolean {
  return JSON.stringify(snapshotPerson(person)) === JSON.stringify(snapshot);
}

export async function undoImportDecision(decisionId: string, idempotencyKey: string): Promise<PeopleImportDecisionResult> {
  const principal = getCurrentPrincipal();
  const rows = await db.select().from(peopleImportDecisions).where(combineWithVisibleScope(principal, decisionScope, eq(peopleImportDecisions.id, decisionId))).limit(1);
  const decision = rows[0];
  if (!decision) return { outcome: "conflict", candidateId: "unknown", changes: [], warnings: ["Decision not found"] };
  const input: ImportDecisionInput = { candidateId: decision.candidateId, idempotencyKey: idempotencyKey.trim(), mergePersonId: decision.personId || undefined };
  const replay = await idempotent("undo", input); if (replay) return replay;
  if (decision.undoneAt) return recordAudit({ action: "undo", input, result: { outcome: "unchanged", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Decision already undone"] } });
  const undo = (decision.undoData || {}) as Record<string, any>;
  const previous = undo.previousCandidate as StoredImportCandidate | undefined;
  if (!previous) return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Decision has no reversible snapshot"] } });
  const currentCandidate = await getImportCandidate(decision.candidateId);
  if (!currentCandidate || currentCandidate.candidate.decision !== decision.outcome || currentCandidate.candidate.mergedPersonId !== (decision.personId || undefined)) {
    return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Candidate changed after this decision; refusing stale undo"] } });
  }
  if (decision.action === "add") {
    const person = decision.personId ? await peopleStorage.getPerson(decision.personId) : null;
    if (!person || !undo.personAfter || !personMatchesSnapshot(person, undo.personAfter)) return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Created person changed after import; refusing destructive undo"] } });
    await peopleStorage.deletePerson(person.id);
  } else if (decision.action === "merge") {
    const person = decision.personId ? await peopleStorage.getPerson(decision.personId) : null;
    if (!person || !undo.personAfter || !undo.personBefore || !personMatchesSnapshot(person, undo.personAfter)) return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Merged person changed after import; refusing overwrite"] } });
    await peopleStorage.updatePerson(person.id, undo.personBefore as Partial<Person>);
  } else if (decision.action === "skip") {
    await storage.removeFromGmailSkipList([decision.candidateId]);
  } else return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, changes: [], warnings: ["Decision action is not reversible"] } });
  await updateCandidateDecision(decision.candidateId, { decision: previous.decision, decidedAt: previous.decidedAt, mergedPersonId: previous.mergedPersonId });
  await db.update(peopleImportDecisions).set({ undoneAt: new Date() }).where(combineWithWritableScope(principal, decisionScope, eq(peopleImportDecisions.id, decisionId)));
  return recordAudit({ action: "undo", input, result: { outcome: "undone", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [{ field: "candidate.decision", before: decision.outcome, after: previous.decision }], warnings: [] } });
}

export async function listImportDecisionAudit(candidateId: string, limit = 20) {
  const principal = getCurrentPrincipal();
  return db.select().from(peopleImportDecisions).where(combineWithVisibleScope(principal, decisionScope, eq(peopleImportDecisions.candidateId, normalizeId(candidateId)))).orderBy(desc(peopleImportDecisions.createdAt)).limit(Math.max(1, Math.min(limit, 100)));
}
