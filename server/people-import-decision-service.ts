import crypto from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { peopleImportBatches, peopleImportDecisions } from "@shared/schema";
import { db } from "./db";
import { createLogger } from "./log";
import {
  getCandidateByEmail,
  getPendingCandidatesFromDb,
  isSyntheticContactEmail,
  searchCandidatesFromDb,
  updateCandidateDecision,
  type CandidateDecision,
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
const batchScope = {
  ownerUserId: peopleImportBatches.ownerUserId,
  accountId: peopleImportBatches.accountId,
};
const MAX_LIST_LIMIT = 100;
const MAX_MATCHES = 10;
const MAX_BATCH_SIZE = 50;
const BATCH_PREVIEW_TTL_MS = 10 * 60 * 1000;

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
  idempotencyKey?: string;
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
  undoDecisionId?: string;
}

export type PeopleImportBatchAction = "add" | "merge" | "skip";
export interface ImportBatchDecision {
  action: PeopleImportBatchAction;
  input: Omit<ImportDecisionInput, "idempotencyKey" | "undoDecisionId">;
}
export interface ImportBatchPreviewItem {
  action: PeopleImportBatchAction;
  candidateId: string;
  outcome: "ready" | "unchanged" | "conflict";
  personId?: string;
  changes: FieldChange[];
  warnings: string[];
}
export interface ImportBatchPreview {
  batchId: string;
  token: string;
  proposalHash: string;
  expiresAt: string;
  items: ImportBatchPreviewItem[];
}
export interface ImportBatchResult {
  batchId: string;
  status: "applied" | "partially_applied";
  proposalHash: string;
  outcomes: PeopleImportDecisionResult[];
  appliedAt: string;
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
  const { idempotencyKey: _idempotencyKey, ...request } = input;
  return crypto.createHash("sha256").update(JSON.stringify(stable({ action, request }))).digest("hex");
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

function requireIdempotencyKey(input: ImportDecisionInput): string {
  const key = input.idempotencyKey?.trim();
  if (!key) throw new Error("idempotencyKey required");
  return key;
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
    idempotencyKey: requireIdempotencyKey(args.input),
    requestHash: hashRequest(args.action, args.input),
    result: recorded,
    undoData: args.undoData || null,
    ...ownedInsertValues(principal, decisionScope),
  });
  log.info(`decision recorded action=${args.action} outcome=${recorded.outcome} candidateId=${recorded.candidateId} decisionId=${decisionId}`);
  return recorded;
}

async function idempotent(action: PeopleImportAction, input: ImportDecisionInput): Promise<PeopleImportDecisionResult | null> {
  const key = requireIdempotencyKey(input);
  const existing = await findAuditByIdempotency(key);
  if (!existing) return null;
  if (existing.requestHash !== hashRequest(action, input)) {
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
  input = { ...input, candidateId: normalizeId(input.candidateId), idempotencyKey: requireIdempotencyKey(input) };
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
  input = { ...input, candidateId: normalizeId(input.candidateId), idempotencyKey: requireIdempotencyKey(input) };
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
  for (const interaction of importedInteractions(pending)) {
    const key = `${interaction.date}_${interaction.type}_${interaction.summary}`;
    if (existingKeys.has(key)) continue;
    await peopleStorage.addInteraction(before.id, interaction);
    existingKeys.add(key);
  }
  const after = await peopleStorage.getPerson(before.id);
  await updateCandidateDecision(input.candidateId, { decision: "merged", decidedAt: new Date().toISOString(), mergedPersonId: before.id });
  const fields: Array<keyof Person> = ["contactInfo", "tags", "introducedBy", "company", "role", "notes", "interactions"];
  const changes = [change("candidate.decision", "pending", "merged"), ...fields.map(field => change(`person.${field}`, before[field], after?.[field]))].filter(Boolean) as FieldChange[];
  return recordAudit({ action: "merge", input, result: { outcome: "merged", candidateId: input.candidateId, personId: before.id, changes, warnings: [] }, undoData: { personBefore: snapshotPerson(before), personAfter: after ? snapshotPerson(after) : null, previousCandidate: pending } });
}

export async function skipImportCandidate(input: ImportDecisionInput): Promise<PeopleImportDecisionResult> {
  input = { ...input, candidateId: normalizeId(input.candidateId), idempotencyKey: requireIdempotencyKey(input) };
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
  const input: ImportDecisionInput = { candidateId: decision.candidateId, idempotencyKey: idempotencyKey.trim(), mergePersonId: decision.personId || undefined, undoDecisionId: decisionId };
  const replay = await idempotent("undo", input); if (replay) return replay;
  if (decision.undoneAt) return recordAudit({ action: "undo", input, result: { outcome: "unchanged", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Decision already undone"] } });
  const undo = (decision.undoData || {}) as Record<string, unknown>;
  const previous = undo.previousCandidate as StoredImportCandidate | undefined;
  if (!previous) return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Decision has no reversible snapshot"] } });
  const currentCandidate = await getImportCandidate(decision.candidateId);
  if (!currentCandidate || currentCandidate.candidate.decision !== decision.outcome || currentCandidate.candidate.mergedPersonId !== (decision.personId || undefined)) {
    return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Candidate changed after this decision; refusing stale undo"] } });
  }
  if (decision.action === "add") {
    const person = decision.personId ? await peopleStorage.getPerson(decision.personId) : null;
    if (!person || !undo.personAfter || !personMatchesSnapshot(person, undo.personAfter as Record<string, unknown>)) return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Created person changed after import; refusing destructive undo"] } });
    await peopleStorage.deletePerson(person.id);
  } else if (decision.action === "merge") {
    const person = decision.personId ? await peopleStorage.getPerson(decision.personId) : null;
    if (!person || !undo.personAfter || !undo.personBefore || !personMatchesSnapshot(person, undo.personAfter as Record<string, unknown>)) return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Merged person changed after import; refusing overwrite"] } });
    const restored = undo.personBefore as Person;
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...restorable } = restored;
    await peopleStorage.updatePerson(person.id, restorable);
  } else if (decision.action === "skip") {
    await storage.removeFromGmailSkipList([decision.candidateId]);
  } else return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, changes: [], warnings: ["Decision action is not reversible"] } });
  await updateCandidateDecision(decision.candidateId, { decision: previous.decision, decidedAt: previous.decidedAt, mergedPersonId: previous.mergedPersonId });
  const updated = await db.update(peopleImportDecisions).set({ undoneAt: new Date() }).where(
    combineWithWritableScope(principal, decisionScope, and(eq(peopleImportDecisions.id, decisionId), isNull(peopleImportDecisions.undoneAt))),
  ).returning({ id: peopleImportDecisions.id });
  if (!updated.length) return recordAudit({ action: "undo", input, result: { outcome: "conflict", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [], warnings: ["Decision was concurrently undone"] } });
  return recordAudit({ action: "undo", input, result: { outcome: "undone", candidateId: decision.candidateId, personId: decision.personId || undefined, changes: [{ field: "candidate.decision", before: decision.outcome, after: previous.decision }], warnings: [] } });
}

export async function listImportDecisionAudit(candidateId: string, limit = 20) {
  const principal = getCurrentPrincipal();
  return db.select().from(peopleImportDecisions).where(combineWithVisibleScope(principal, decisionScope, eq(peopleImportDecisions.candidateId, normalizeId(candidateId)))).orderBy(desc(peopleImportDecisions.createdAt)).limit(Math.max(1, Math.min(limit, 100)));
}


function proposalHashFor(decisions: ImportBatchDecision[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(stable(decisions))).digest("hex");
}

function batchToken(batchId: string, proposalHash: string, expiresAt: Date): string {
  return Buffer.from(`${batchId}:${proposalHash}:${expiresAt.toISOString()}`).toString("base64url");
}

async function previewDecision(decision: ImportBatchDecision): Promise<ImportBatchPreviewItem> {
  const candidateId = normalizeId(decision.input.candidateId);
  const record = await getImportCandidate(candidateId);
  if (!record) return { action: decision.action, candidateId, outcome: "conflict", changes: [], warnings: ["Candidate not found"] };
  if (record.candidate.decision !== "pending") return { action: decision.action, candidateId, outcome: "unchanged", personId: record.candidate.mergedPersonId, changes: [], warnings: [`Candidate already ${record.candidate.decision}`] };
  if (decision.action === "merge") {
    if (!decision.input.mergePersonId) return { action: decision.action, candidateId, outcome: "conflict", changes: [], warnings: ["mergePersonId required"] };
    const person = await peopleStorage.getPerson(decision.input.mergePersonId);
    if (!person) return { action: decision.action, candidateId, outcome: "conflict", changes: [], warnings: ["Target person not found"] };
    const existing = new Set(person.contactInfo.map(c => `${c.type}:${c.type === "email" ? normalizeEmail(c.value) : c.type === "phone" ? normalizePhone(c.value) : c.value.trim().toLowerCase()}`));
    const additions = contactsFor(record.candidate).filter(c => !existing.has(`${c.type}:${c.type === "email" ? normalizeEmail(c.value) : c.type === "phone" ? normalizePhone(c.value) : c.value.trim().toLowerCase()}`));
    return { action: decision.action, candidateId, outcome: "ready", personId: person.id, changes: [change("candidate.decision", "pending", "merged"), change("person.contactInfo", person.contactInfo, [...person.contactInfo, ...additions])].filter(Boolean) as FieldChange[], warnings: [] };
  }
  return { action: decision.action, candidateId, outcome: "ready", changes: [change("candidate.decision", "pending", decision.action === "add" ? "added" : "skipped")].filter(Boolean) as FieldChange[], warnings: [] };
}

export async function previewImportBatch(decisions: ImportBatchDecision[]): Promise<ImportBatchPreview> {
  if (!Array.isArray(decisions) || !decisions.length) throw new Error("decisions required");
  if (decisions.length > MAX_BATCH_SIZE) throw new Error(`Batch exceeds maximum of ${MAX_BATCH_SIZE}`);
  const normalized = decisions.map(d => ({ ...d, input: { ...d.input, candidateId: normalizeId(d.input.candidateId) } }));
  const duplicate = normalized.find((d, i) => normalized.findIndex(other => other.input.candidateId === d.input.candidateId) !== i);
  if (duplicate) throw new Error(`Duplicate candidate in batch: ${duplicate.input.candidateId}`);
  const principal = getCurrentPrincipal();
  const batchId = crypto.randomUUID();
  const proposalHash = proposalHashFor(normalized);
  const expiresAt = new Date(Date.now() + BATCH_PREVIEW_TTL_MS);
  const items = await Promise.all(normalized.map(previewDecision));
  const preview: ImportBatchPreview = { batchId, token: batchToken(batchId, proposalHash, expiresAt), proposalHash, expiresAt: expiresAt.toISOString(), items };
  await db.insert(peopleImportBatches).values({ id: batchId, proposalHash, proposal: { decisions: normalized }, preview, status: "previewed", expiresAt, ...ownedInsertValues(principal, batchScope) });
  return preview;
}

export async function applyImportBatch(batchId: string, token: string, idempotencyKey: string): Promise<ImportBatchResult> {
  const principal = getCurrentPrincipal();
  const key = idempotencyKey.trim();
  if (!key) throw new Error("idempotencyKey required");
  const row = (await db.select().from(peopleImportBatches).where(combineWithVisibleScope(principal, batchScope, eq(peopleImportBatches.id, batchId))).limit(1))[0];
  if (!row) throw new Error("Import batch not found");
  if (row.result) {
    if (row.idempotencyKey !== key) throw new Error("Batch already applied with a different idempotency key");
    return row.result as unknown as ImportBatchResult;
  }
  if (row.expiresAt.getTime() <= Date.now()) throw new Error("Import batch preview expired");
  if (token !== batchToken(row.id, row.proposalHash, row.expiresAt)) throw new Error("Invalid import batch token");
  const decisions = ((row.proposal as { decisions?: ImportBatchDecision[] }).decisions || []);
  if (proposalHashFor(decisions) !== row.proposalHash) throw new Error("Import batch proposal changed");
  const fresh = await Promise.all(decisions.map(previewDecision));
  if (fresh.some(item => item.outcome !== "ready")) throw new Error("Import batch is stale; preview again");
  const outcomes: PeopleImportDecisionResult[] = [];
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    const input = { ...decision.input, idempotencyKey: `${key}:${index}:${decision.input.candidateId}` };
    outcomes.push(decision.action === "add" ? await addImportCandidate(input) : decision.action === "merge" ? await mergeImportCandidate(input) : await skipImportCandidate(input));
  }
  const result: ImportBatchResult = { batchId, status: outcomes.every(o => !["conflict"].includes(o.outcome)) ? "applied" : "partially_applied", proposalHash: row.proposalHash, outcomes, appliedAt: new Date().toISOString() };
  const updated = await db.update(peopleImportBatches).set({ status: result.status, idempotencyKey: key, result, appliedAt: new Date() }).where(combineWithWritableScope(principal, batchScope, and(eq(peopleImportBatches.id, batchId), isNull(peopleImportBatches.appliedAt)))).returning({ id: peopleImportBatches.id });
  if (!updated.length) {
    const replay = (await db.select().from(peopleImportBatches).where(combineWithVisibleScope(principal, batchScope, eq(peopleImportBatches.id, batchId))).limit(1))[0];
    if (replay?.result && replay.idempotencyKey === key) return replay.result as unknown as ImportBatchResult;
    throw new Error("Import batch was concurrently applied");
  }
  return result;
}

export async function getImportBatch(batchId: string) {
  const principal = getCurrentPrincipal();
  return (await db.select().from(peopleImportBatches).where(combineWithVisibleScope(principal, batchScope, eq(peopleImportBatches.id, batchId))).limit(1))[0] || null;
}

export interface SearchImportCandidatesOptions {
  query?: string;
  candidateId?: string;
  decision?: CandidateDecision;
  limit?: number;
  offset?: number;
}

/**
 * Search import candidates by name or email without loading the full queue.
 * Read-only. Preserves user scoping via visibleCandidatePredicate.
 */
export async function searchImportCandidates(options: SearchImportCandidatesOptions = {}): Promise<ImportCandidateRecord[]> {
  const candidates = await searchCandidatesFromDb({
    query: options.query,
    candidateId: options.candidateId,
    decision: options.decision,
    limit: options.limit,
    offset: options.offset,
  });
  return candidates.map(candidate => ({ candidateId: candidateIdFor(candidate), candidate }));
}
