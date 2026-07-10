// Use createLogger for logging ONLY
import { eq, notInArray, sql } from "drizzle-orm";
import { db } from "./db";
import { getSetting, setSetting } from "./system-settings";
import { connectedAccounts, peopleImportCandidates } from "@shared/schema";
import { peopleStorage } from "./people-storage";
import { createLogger } from "./log";
import { combineWithSensitiveVisible } from "./sensitive-scope";
import { getCurrentPrincipal } from "./principal-context";

const log = createLogger("ImportQueue");
const connectedAccountScopeColumns = { ownerUserId: connectedAccounts.ownerUserId, principalAccountId: connectedAccounts.principalAccountId };

/** Scoped predicate: only candidates belonging to currently connected accounts (used for mutations) */
function connectedAccountPredicate() {
  const principal = getCurrentPrincipal();
  return sql`(${peopleImportCandidates.accountId} = ${`ios:${principal.accountId}`} OR ${peopleImportCandidates.accountId} IN (SELECT account_id FROM connected_accounts WHERE ${combineWithSensitiveVisible(connectedAccountScopeColumns)}))`;
}

/** Visible predicate: candidates belonging to the current principal's connected accounts (used for reads) */
function visibleImportAccountPredicate() {
  const principal = getCurrentPrincipal();
  return sql`(${peopleImportCandidates.accountId} = ${`ios:${principal.accountId}`} OR ${peopleImportCandidates.accountId} IN (SELECT account_id FROM connected_accounts WHERE ${combineWithSensitiveVisible(connectedAccountScopeColumns)}))`;
}

const LEGACY_DB_KEY = "import_queue";
const SCAN_STATE_KEY = "import_queue_scan_state";

export interface ImportContactInfo {
  type: "email" | "phone" | "social" | "other";
  label: string;
  value: string;
}

export interface ImportCandidate {
  email: string;
  name: string;
  sentCount: number;
  receivedCount: number;
  threadCount: number;
  lastInteraction: string;
  firstInteraction: string;
  sampleSubjects: string[];
  interactions: { date: string; subject: string; direction: "sent" | "received"; snippet: string }[];
  scannedAt: string;
  accountId?: string;
  source?: string;
  sourceId?: string;
  displayName?: string;
  givenName?: string;
  middleName?: string;
  familyName?: string;
  nickname?: string;
  maidenName?: string;
  phoneticGivenName?: string;
  phoneticMiddleName?: string;
  phoneticFamilyName?: string;
  company?: string;
  role?: string;
  emails?: string[];
  phones?: string[];
  contactInfo?: ImportContactInfo[];
  department?: string;
  addresses?: Array<Record<string, unknown>>;
  urls?: Array<Record<string, unknown>>;
  dates?: Array<Record<string, unknown>>;
  birthday?: Record<string, unknown>;
  rawContactHash?: string;
}

export interface IosContactImportPayload {
  sourceId: string;
  displayName?: string;
  givenName?: string;
  middleName?: string;
  familyName?: string;
  nickname?: string;
  maidenName?: string;
  phoneticGivenName?: string;
  phoneticMiddleName?: string;
  phoneticFamilyName?: string;
  emails?: string[];
  phones?: string[];
  company?: string;
  jobTitle?: string;
  department?: string;
  addresses?: Array<Record<string, unknown>>;
  urls?: Array<Record<string, unknown>>;
  dates?: Array<Record<string, unknown>>;
  birthday?: Record<string, unknown>;
  rawContactHash?: string;
}

export type CandidateDecision = "pending" | "added" | "merged" | "skipped";
export type StoredImportCandidate = ImportCandidate & { decision: CandidateDecision; decidedAt?: string; mergedPersonId?: string };

export interface ImportQueueState {
  candidates: Record<string, StoredImportCandidate>;
  scan: {
    status: "idle" | "scanning" | "done" | "error";
    mode?: "start" | "continue" | "refresh";
    nextPageToken?: string;
    threadsProcessed: number;
    estimatedTotal: number;
    contactsFound: number;
    batchNumber?: number;
    oldestDate?: string;
    newestDate?: string;
    lastCompletedAt?: string;
    lastScanAccountId?: string;
    error?: string;
    scanAllAccounts?: boolean;
    accountsScanned?: string[];
    currentAccountIndex?: number;
    accountIds?: string[];
    afterDate?: string;
    beforeDate?: string;
  };
  stats: {
    totalAdded: number;
    totalMerged: number;
    totalSkipped: number;
  };
}

function emptyState(): ImportQueueState {
  return {
    candidates: {},
    scan: {
      status: "idle",
      threadsProcessed: 0,
      estimatedTotal: 0,
      contactsFound: 0,
    },
    stats: { totalAdded: 0, totalMerged: 0, totalSkipped: 0 },
  };
}

let scanRunningInProcess = false;
let legacyFileMigrationChecked = false;

export function isScanActuallyRunning(): boolean {
  return scanRunningInProcess;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^+\d]/g, "");
}

export function isSyntheticContactEmail(value: string): boolean {
  return normalizeEmail(value).endsWith("@contacts.local");
}

function normalizeSyntheticKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 80) || "contact";
}

function makeIosContactQueueKey(contact: IosContactImportPayload): string {
  if (contact.sourceId?.trim()) return `ios-contact-${normalizeSyntheticKeyPart(contact.sourceId)}@contacts.local`;
  const firstEmail = contact.emails?.map(normalizeEmail).find(Boolean);
  if (firstEmail) return firstEmail;
  const firstPhone = contact.phones?.map(normalizePhone).find(Boolean);
  if (firstPhone) return `ios-phone-${normalizeSyntheticKeyPart(firstPhone)}@contacts.local`;
  return `ios-contact-${normalizeSyntheticKeyPart(contact.rawContactHash || contact.displayName || "unknown")}@contacts.local`;
}

function candidateMatchesIosIdentity(candidate: StoredImportCandidate, contact: IosContactImportPayload, emails: string[], phones: string[]): boolean {
  if (contact.sourceId && candidate.sourceId === contact.sourceId) return true;
  const candidateEmails = new Set((candidate.emails || []).map(normalizeEmail).filter(Boolean));
  if (emails.some(email => candidateEmails.has(email))) return true;
  const candidatePhones = new Set((candidate.phones || []).map(normalizePhone).filter(Boolean));
  return phones.some(phone => candidatePhones.has(phone));
}

function displayNameForIosContact(contact: IosContactImportPayload): string {
  return contact.displayName?.trim()
    || [contact.givenName, contact.familyName].filter(Boolean).join(" ").trim()
    || contact.emails?.[0]
    || contact.phones?.[0]
    || "iOS Contact";
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function rowToCandidate(row: typeof peopleImportCandidates.$inferSelect): StoredImportCandidate {
  const candidate = row.candidate as Partial<StoredImportCandidate>;
  return {
    ...candidate,
    email: row.email,
    name: candidate.name || candidate.displayName || row.email,
    sentCount: candidate.sentCount || 0,
    receivedCount: candidate.receivedCount || 0,
    threadCount: candidate.threadCount || 0,
    lastInteraction: candidate.lastInteraction || row.lastInteractionAt?.toISOString() || row.updatedAt.toISOString(),
    firstInteraction: candidate.firstInteraction || row.firstInteractionAt?.toISOString() || row.createdAt.toISOString(),
    sampleSubjects: Array.isArray(candidate.sampleSubjects) ? candidate.sampleSubjects : [],
    interactions: Array.isArray(candidate.interactions) ? candidate.interactions as StoredImportCandidate["interactions"] : [],
    scannedAt: candidate.scannedAt || row.createdAt.toISOString(),
    accountId: candidate.accountId || row.accountId || undefined,
    source: candidate.source || row.source || undefined,
    decision: (row.decision as CandidateDecision) || candidate.decision || "pending",
    decidedAt: candidate.decidedAt || row.decidedAt?.toISOString(),
    mergedPersonId: candidate.mergedPersonId || row.mergedPersonId || undefined,
  };
}

function candidateToRow(candidate: StoredImportCandidate) {
  const email = normalizeEmail(candidate.email);
  const normalized: StoredImportCandidate = {
    ...candidate,
    email,
    decision: candidate.decision || "pending",
    sampleSubjects: candidate.sampleSubjects || [],
    interactions: candidate.interactions || [],
  };
  return {
    email,
    candidate: normalized,
    decision: normalized.decision,
    decidedAt: parseDate(normalized.decidedAt),
    mergedPersonId: normalized.mergedPersonId || null,
    source: normalized.source || null,
    accountId: normalized.accountId || null,
    firstInteractionAt: parseDate(normalized.firstInteraction),
    lastInteractionAt: parseDate(normalized.lastInteraction),
    updatedAt: new Date(),
  };
}

async function ensureLegacyFileMigratedIfNeeded(): Promise<void> {
  if (legacyFileMigrationChecked) return;
  legacyFileMigrationChecked = true;

  const existingRows = await db.select({ email: peopleImportCandidates.email }).from(peopleImportCandidates).limit(1);
  if (existingRows.length > 0) return;

  const legacySetting = await getSetting<ImportQueueState>(LEGACY_DB_KEY).catch(() => null);
  if (legacySetting?.candidates && Object.keys(legacySetting.candidates).length > 0) {
    await upsertCandidates(Object.values(legacySetting.candidates));
    const scanOnly = { ...legacySetting, candidates: {} };
    await setSetting(SCAN_STATE_KEY, scanOnly);
    return;
  }

  try {
    const { promises: fs } = await import("fs");
    const { join } = await import("path");
    const raw = await fs.readFile(join(".openclaw", "workspace", "import-queue.json"), "utf-8");
    const legacy = JSON.parse(raw) as ImportQueueState;
    if (legacy?.candidates) {
      await upsertCandidates(Object.values(legacy.candidates));
      await setSetting(SCAN_STATE_KEY, { ...legacy, candidates: {} });
      log.log("Migrated legacy import-queue.json candidates to people_import_candidates");
    }
  } catch (err) {
    log.debug("legacy file migration not needed", err);
  }
}

async function loadScanState(): Promise<ImportQueueState["scan"]> {
  const stored = await getSetting<ImportQueueState>(SCAN_STATE_KEY).catch(() => null);
  let scan = stored?.scan || emptyState().scan;
  if (scan.status === "scanning" && !scanRunningInProcess) {
    scan = { ...scan, status: "idle" };
    await setSetting(SCAN_STATE_KEY, { ...(stored || emptyState()), candidates: {}, scan });
  }
  return scan;
}

async function saveScanState(scan: ImportQueueState["scan"]): Promise<void> {
  const current = await getSetting<ImportQueueState>(SCAN_STATE_KEY).catch(() => null);
  await setSetting(SCAN_STATE_KEY, { ...(current || emptyState()), candidates: {}, scan });
}

async function loadCandidates(): Promise<Record<string, StoredImportCandidate>> {
  await ensureLegacyFileMigratedIfNeeded();
  const rows = await db.select().from(peopleImportCandidates).where(visibleImportAccountPredicate());
  const candidates: Record<string, StoredImportCandidate> = {};
  for (const row of rows) {
    candidates[row.email] = rowToCandidate(row);
  }
  return candidates;
}

async function computeStats(candidates: Record<string, StoredImportCandidate>): Promise<ImportQueueState["stats"]> {
  const all = Object.values(candidates);
  return {
    totalAdded: all.filter(c => c.decision === "added").length,
    totalMerged: all.filter(c => c.decision === "merged").length,
    totalSkipped: all.filter(c => c.decision === "skipped").length,
  };
}

export async function loadQueueState(): Promise<ImportQueueState> {
  const candidates = await loadCandidates();
  const scan = await loadScanState();
  return { candidates, scan, stats: await computeStats(candidates) };
}

export async function upsertCandidates(candidates: Array<Partial<StoredImportCandidate> & { email: string }>): Promise<void> {
  for (const raw of candidates) {
    const email = normalizeEmail(raw.email);
    if (!email) continue;
    const incoming: StoredImportCandidate = {
      ...raw,
      email,
      name: raw.name || raw.displayName || email,
      sentCount: raw.sentCount || 0,
      receivedCount: raw.receivedCount || 0,
      threadCount: raw.threadCount || 0,
      lastInteraction: raw.lastInteraction || new Date().toISOString(),
      firstInteraction: raw.firstInteraction || raw.lastInteraction || new Date().toISOString(),
      sampleSubjects: raw.sampleSubjects || [],
      interactions: raw.interactions || [],
      scannedAt: raw.scannedAt || new Date().toISOString(),
      accountId: raw.accountId,
      source: raw.source,
      decision: raw.decision || "pending",
      decidedAt: raw.decidedAt,
      mergedPersonId: raw.mergedPersonId,
    };

    const existingRows = await db.select().from(peopleImportCandidates).where(sql`${peopleImportCandidates.email} = ${email} AND ${visibleImportAccountPredicate()}`).limit(1);
    if (existingRows[0]) {
      const existing = rowToCandidate(existingRows[0]);
      const subjects = new Set([...(existing.sampleSubjects || []), ...(incoming.sampleSubjects || [])]);
      const interactionKeys = new Set((existing.interactions || []).map(i => `${i.date}_${i.direction}_${i.subject}`));
      const interactions = [...(existing.interactions || [])];
      for (const ix of incoming.interactions || []) {
        const key = `${ix.date}_${ix.direction}_${ix.subject}`;
        if (!interactionKeys.has(key)) {
          interactions.push(ix);
          interactionKeys.add(key);
        }
      }
      interactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const merged: StoredImportCandidate = {
        ...existing,
        ...incoming,
        decision: existing.decision === "pending" ? incoming.decision : existing.decision,
        decidedAt: existing.decidedAt || incoming.decidedAt,
        mergedPersonId: existing.mergedPersonId || incoming.mergedPersonId,
        sentCount: Math.max(existing.sentCount || 0, incoming.sentCount || 0),
        receivedCount: Math.max(existing.receivedCount || 0, incoming.receivedCount || 0),
        threadCount: Math.max(existing.threadCount || 0, incoming.threadCount || 0),
        firstInteraction: [existing.firstInteraction, incoming.firstInteraction].filter(Boolean).sort()[0] || incoming.firstInteraction,
        lastInteraction: [existing.lastInteraction, incoming.lastInteraction].filter(Boolean).sort().at(-1) || incoming.lastInteraction,
        sampleSubjects: Array.from(subjects).slice(0, 10),
        interactions: interactions.slice(0, 50),
        scannedAt: incoming.scannedAt || existing.scannedAt,
      };
      await db.update(peopleImportCandidates)
        .set(candidateToRow(merged))
        .where(sql`${peopleImportCandidates.email} = ${email} AND ${visibleImportAccountPredicate()}`);
    } else {
      await db.insert(peopleImportCandidates).values(candidateToRow(incoming));
    }
  }
}

export interface IosContactStageResult {
  imported: number;
  updated: number;
  repaired: number;
  skipped: number;
}

async function findPeopleByContactIdentity(emails: string[], phones: string[]) {
  const emailSet = new Set(emails);
  const phoneSet = new Set(phones);
  const matches = [];
  for (const entry of await peopleStorage.listPeople()) {
    const person = await peopleStorage.getPerson(entry.id);
    if (!person) continue;
    const matchesIdentity = (person.contactInfo || []).some(contact =>
      contact.type === "email"
        ? emailSet.has(normalizeEmail(contact.value))
        : contact.type === "phone" && phoneSet.has(normalizePhone(contact.value)),
    );
    if (matchesIdentity) matches.push(person);
  }
  return matches;
}

async function repairIosCandidate(candidate: StoredImportCandidate): Promise<{ repaired: boolean; matchedPersonId?: string }> {
  const emails = (candidate.emails || []).map(normalizeEmail).filter(value => value && !isSyntheticContactEmail(value));
  const phones = (candidate.phones || []).map(normalizePhone).filter(Boolean);
  const directPerson = candidate.mergedPersonId ? await peopleStorage.getPerson(candidate.mergedPersonId) : null;
  const matches = directPerson ? [directPerson] : await findPeopleByContactIdentity(emails, phones);
  if (matches.length !== 1) return { repaired: false };

  const person = matches[0]!;
  const existing = new Set((person.contactInfo || []).map(contact => `${contact.type}:${contact.type === "email" ? normalizeEmail(contact.value) : normalizePhone(contact.value)}`));
  const additions: ImportContactInfo[] = [
    ...emails.filter(value => !existing.has(`email:${value}`)).map(value => ({ type: "email" as const, label: "iOS", value })),
    ...phones.filter(value => !existing.has(`phone:${value}`)).map(value => ({ type: "phone" as const, label: "iOS", value })),
  ];
  if (additions.length > 0) {
    await peopleStorage.updatePerson(person.id, { contactInfo: [...(person.contactInfo || []), ...additions] });
  }
  const shouldLink = !candidate.mergedPersonId && candidate.decision !== "skipped";
  return { repaired: additions.length > 0 || shouldLink, matchedPersonId: shouldLink ? person.id : candidate.mergedPersonId };
}

export async function stageIosContacts(rawContacts: IosContactImportPayload[]): Promise<IosContactStageResult> {
  const scannedAt = new Date().toISOString();
  const principal = getCurrentPrincipal();
  const accountId = `ios:${principal.accountId}`;
  const candidates: Array<Partial<StoredImportCandidate> & { email: string }> = [];
  const existingCandidates = Object.values(await loadCandidates());
  let skipped = 0;
  let imported = 0;
  let updated = 0;
  let repaired = 0;

  for (const contact of rawContacts) {
    const emails = Array.from(new Set((contact.emails || []).map(normalizeEmail).filter(value => value && !isSyntheticContactEmail(value))));
    const phones = Array.from(new Set((contact.phones || []).map(normalizePhone).filter(Boolean)));
    if (emails.length === 0 && phones.length === 0) { skipped += 1; continue; }
    const contactInfo: ImportContactInfo[] = [
      ...emails.map(value => ({ type: "email" as const, label: "iOS", value })),
      ...phones.map(value => ({ type: "phone" as const, label: "iOS", value })),
    ];
    const canonicalKey = makeIosContactQueueKey({ ...contact, emails, phones });
    const existing = [...existingCandidates, ...candidates as StoredImportCandidate[]].find(candidate => candidateMatchesIosIdentity(candidate, contact, emails, phones));
    existing ? updated += 1 : imported += 1;
    const candidate: StoredImportCandidate = {
      ...(existing || {}), email: existing?.email || canonicalKey, name: displayNameForIosContact(contact),
      displayName: contact.displayName, givenName: contact.givenName, middleName: contact.middleName, familyName: contact.familyName,
      nickname: contact.nickname, maidenName: contact.maidenName, phoneticGivenName: contact.phoneticGivenName,
      phoneticMiddleName: contact.phoneticMiddleName, phoneticFamilyName: contact.phoneticFamilyName, company: contact.company,
      role: contact.jobTitle, department: contact.department, addresses: contact.addresses, urls: contact.urls, dates: contact.dates,
      emails, phones, contactInfo, birthday: contact.birthday, sourceId: contact.sourceId, rawContactHash: contact.rawContactHash,
      source: "ios_contacts", accountId, sentCount: 0, receivedCount: 0, threadCount: 0, firstInteraction: existing?.firstInteraction || scannedAt,
      lastInteraction: scannedAt, scannedAt, sampleSubjects: ["Imported from iOS Contacts"], interactions: [],
      decision: existing?.decision || "pending", decidedAt: existing?.decidedAt, mergedPersonId: existing?.mergedPersonId,
    };
    const repair = await repairIosCandidate(candidate);
    if (repair.repaired) repaired += 1;
    if (repair.matchedPersonId && candidate.decision !== "skipped") {
      candidate.mergedPersonId = repair.matchedPersonId;
      if (candidate.decision === "pending") { candidate.decision = "merged"; candidate.decidedAt = scannedAt; }
    }
    candidates.push(candidate);
  }
  await upsertCandidates(candidates);
  return { imported, updated, repaired, skipped };
}

export async function saveQueueState(state: ImportQueueState): Promise<void> {
  const emails = Object.keys(state.candidates);
  if (emails.length === 0) {
    await db.delete(peopleImportCandidates).where(connectedAccountPredicate());
  } else {
    await upsertCandidates(Object.values(state.candidates));
    await db.delete(peopleImportCandidates).where(sql`${notInArray(peopleImportCandidates.email, emails)} AND ${connectedAccountPredicate()}`);
  }
  await saveScanState(state.scan);
}

export async function getCandidateByEmail(email: string): Promise<StoredImportCandidate | null> {
  await ensureLegacyFileMigratedIfNeeded();
  const normalized = normalizeEmail(email);
  const rows = await db.select().from(peopleImportCandidates).where(sql`${peopleImportCandidates.email} = ${normalized} AND ${visibleImportAccountPredicate()}`).limit(1);
  return rows[0] ? rowToCandidate(rows[0]) : null;
}

export async function updateCandidateDecision(email: string, updates: Partial<StoredImportCandidate>): Promise<void> {
  const normalized = normalizeEmail(email);
  const existing = await getCandidateByEmail(normalized);
  if (!existing) throw new Error(`Import candidate not found: ${normalized}`);
  const candidate = { ...existing, ...updates, email: normalized };
  await db.update(peopleImportCandidates)
    .set(candidateToRow(candidate))
    .where(sql`${peopleImportCandidates.email} = ${normalized} AND ${visibleImportAccountPredicate()}`);
}

export function getPendingCandidates(state: ImportQueueState): StoredImportCandidate[] {
  return Object.values(state.candidates)
    .filter(c => c.decision === "pending")
    .sort((a, b) => (b.sentCount + b.receivedCount) - (a.sentCount + a.receivedCount));
}

export function getQueueSummary(state: ImportQueueState) {
  const all = Object.values(state.candidates);
  return {
    total: all.length,
    pending: all.filter(c => c.decision === "pending").length,
    added: all.filter(c => c.decision === "added").length,
    merged: all.filter(c => c.decision === "merged").length,
    skipped: all.filter(c => c.decision === "skipped").length,
    scan: state.scan,
    stats: state.stats,
  };
}

export async function getPendingCandidatesFromDb(): Promise<StoredImportCandidate[]> {
  await ensureLegacyFileMigratedIfNeeded();
  const rows = await db.select()
    .from(peopleImportCandidates)
    .where(sql`${peopleImportCandidates.decision} = ${"pending"} AND ${visibleImportAccountPredicate()}`);
  return rows
    .map(rowToCandidate)
    .sort((a, b) => (b.sentCount + b.receivedCount) - (a.sentCount + a.receivedCount));
}

export async function getQueueSummaryFromDb() {
  await ensureLegacyFileMigratedIfNeeded();
  const [scan, rows] = await Promise.all([
    loadScanState(),
    db.select({
      decision: peopleImportCandidates.decision,
      count: sql<number>`count(*)::int`,
    })
      .from(peopleImportCandidates)
      .where(visibleImportAccountPredicate())
      .groupBy(peopleImportCandidates.decision),
  ]);

  const counts = new Map(rows.map(row => [row.decision, Number(row.count) || 0]));
  const pending = counts.get("pending") || 0;
  const added = counts.get("added") || 0;
  const merged = counts.get("merged") || 0;
  const skipped = counts.get("skipped") || 0;

  return {
    total: pending + added + merged + skipped,
    pending,
    added,
    merged,
    skipped,
    scan,
    stats: {
      totalAdded: added,
      totalMerged: merged,
      totalSkipped: skipped,
    },
  };
}

let scanAbortFlag = false;

export function abortScan() {
  scanAbortFlag = true;
}

export async function runAutoScan(opts: {
  mode: "start" | "continue" | "refresh";
  accountId?: string;
  peopleStorage: PeopleStorage;
  getSkipList: () => Promise<{ email: string }[]>;
  getEmailMap: () => Promise<Record<string, { id: string; name: string }>>;
}): Promise<void> {
  const { mode, accountId, peopleStorage, getSkipList, getEmailMap } = opts;
  const state = await loadQueueState();

  if (state.scan.status === "scanning") {
    throw new Error("A scan is already in progress");
  }

  scanAbortFlag = false;

  const skipList = await getSkipList();
  const skipEmails = new Set(skipList.map(e => e.email.toLowerCase()));
  const emailMap = await getEmailMap();
  const existingEmails = new Set(Object.keys(emailMap).map(e => e.toLowerCase()));

  if (mode === "start") {
    await db.delete(peopleImportCandidates).where(sql`${peopleImportCandidates.decision} = ${"pending"} AND ${connectedAccountPredicate()}`);
    state.candidates = Object.fromEntries(Object.entries(state.candidates).filter(([, c]) => c.decision !== "pending"));
    state.stats = { totalAdded: 0, totalMerged: 0, totalSkipped: 0 };
    state.scan = {
      status: "scanning",
      mode: "start",
      threadsProcessed: 0,
      estimatedTotal: 0,
      contactsFound: 0,
      batchNumber: 0,
      lastScanAccountId: accountId,
    };
  } else if (mode === "continue") {
    if (!state.scan.nextPageToken) {
      throw new Error("No scan to continue — start a new one");
    }
    state.scan.status = "scanning";
    state.scan.mode = "continue";
  } else if (mode === "refresh") {
    const lastDone = state.scan.lastCompletedAt;
    let afterDate: string | undefined;
    if (lastDone) {
      const d = new Date(lastDone);
      d.setDate(d.getDate() - 7);
      afterDate = d.toISOString().split("T")[0];
    }
    state.scan = {
      status: "scanning",
      mode: "refresh",
      threadsProcessed: 0,
      estimatedTotal: 0,
      contactsFound: 0,
      batchNumber: 0,
      lastScanAccountId: accountId || state.scan.lastScanAccountId,
      lastCompletedAt: state.scan.lastCompletedAt,
      afterDate,
    };
  }

  await saveScanState(state.scan);

  scanRunningInProcess = true;
  scanInBackground(state, skipEmails, existingEmails, emailMap, peopleStorage)
    .catch(async (err) => {
      state.scan.status = "error";
      state.scan.error = err.message;
      await saveScanState(state.scan);
    })
    .finally(() => {
      scanRunningInProcess = false;
    });
}

async function scanInBackground(
  state: ImportQueueState,
  skipEmails: Set<string>,
  existingEmails: Set<string>,
  emailMap: Record<string, { id: string; name: string }>,
  peopleStorage: PeopleStorage,
): Promise<void> {
  const { extractContactCandidatesBatch, resetScanProgress } = await import("./gmail");
  resetScanProgress("import-queue");

  const acctId = state.scan.lastScanAccountId;
  let pageToken = state.scan.mode === "continue" ? state.scan.nextPageToken : undefined;
  const afterDate = state.scan.afterDate;
  const beforeDate = state.scan.beforeDate;

  const alreadyQueued = new Set(Object.keys(state.candidates).map(e => e.toLowerCase()));

  let keepGoing = true;
  let batchNum = state.scan.batchNumber || 0;

  while (keepGoing) {
    if (scanAbortFlag) {
      state.scan.status = "idle";
      state.scan.nextPageToken = pageToken;
      await saveScanState(state.scan);
      return;
    }

    batchNum++;
    state.scan.batchNumber = batchNum;

    try {
      const batchResult = await extractContactCandidatesBatch({
        batchSize: 500,
        minThreadCount: 2,
        afterDate,
        beforeDate,
        userId: "import-queue",
        accountId: acctId,
        gmailPageToken: pageToken,
        excludeEmails: [...skipEmails, ...alreadyQueued],
        onProgress: (processed, estimated) => {
          state.scan.threadsProcessed = processed;
          if (estimated > state.scan.estimatedTotal) state.scan.estimatedTotal = estimated;
          saveScanState(state.scan).catch(err => log.warn("save scan state failed", err));
        },
      });

      state.scan.threadsProcessed = batchResult.threadsProcessed;
      if (batchResult.estimatedTotal > state.scan.estimatedTotal) state.scan.estimatedTotal = batchResult.estimatedTotal;
      if (batchResult.oldestDate && (!state.scan.oldestDate || batchResult.oldestDate < state.scan.oldestDate)) state.scan.oldestDate = batchResult.oldestDate;
      if (batchResult.newestDate && (!state.scan.newestDate || batchResult.newestDate > state.scan.newestDate)) state.scan.newestDate = batchResult.newestDate;

      const upserts: StoredImportCandidate[] = [];
      for (const c of batchResult.candidates) {
        const emailLower = c.email.toLowerCase();
        if (skipEmails.has(emailLower)) continue;

        const existingMatch = emailMap[emailLower];
        if (existingMatch) {
          if (!alreadyQueued.has(emailLower)) {
            upserts.push({
              ...(c as ImportCandidate),
              email: emailLower,
              decision: "merged",
              decidedAt: new Date().toISOString(),
              mergedPersonId: existingMatch.id,
              scannedAt: new Date().toISOString(),
              accountId: acctId,
            });
            alreadyQueued.add(emailLower);
          }
          try {
            await autoMergeInteractions(c as ImportCandidate, existingMatch.id, peopleStorage);
          } catch (err: any) {
            log.error("Auto-merge error for", c.email, err?.message || err);
          }
          continue;
        }

        if (alreadyQueued.has(emailLower)) continue;

        upserts.push({
          ...(c as ImportCandidate),
          email: emailLower,
          decision: "pending",
          scannedAt: new Date().toISOString(),
          accountId: acctId,
        });
        alreadyQueued.add(emailLower);
      }

      if (upserts.length > 0) {
        await upsertCandidates(upserts);
        for (const c of upserts) state.candidates[c.email] = c;
      }

      state.scan.contactsFound = Object.values((await loadCandidates())).filter(c => c.decision === "pending").length;

      if (batchResult.hasMore && batchResult.nextPageToken) {
        pageToken = batchResult.nextPageToken;
        state.scan.nextPageToken = pageToken;
      } else {
        keepGoing = false;
        state.scan.nextPageToken = undefined;
      }

      await saveScanState(state.scan);
    } catch (err: any) {
      if (err.message === "A scan is already in progress") {
        resetScanProgress("import-queue");
        continue;
      }
      state.scan.status = "error";
      state.scan.error = err.message;
      state.scan.nextPageToken = pageToken;
      await saveScanState(state.scan);
      return;
    }
  }

  state.scan.status = "done";
  state.scan.lastCompletedAt = new Date().toISOString();
  await saveScanState(state.scan);
}

export async function autoMergeInteractions(
  contact: ImportCandidate,
  personId: string,
  peopleStorage: PeopleStorage,
): Promise<void> {
  const person = await peopleStorage.getPerson(personId);
  if (!person) return;

  const existingKeys = new Set(
    (person.interactions || []).map((ei: any) => `${ei.date}_${ei.type}_${ei.summary}`)
  );
  const existingContexts = new Set((person.interactions || []).map((ei: any) => ei.context).filter(Boolean));

  const interactions = (contact.interactions || [])
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const seen = new Set<string>();
  for (const ix of interactions) {
    const dateStr = ix.date.split("T")[0];
    const summary = `${ix.direction === "sent" ? "Sent" : "Received"}: ${ix.subject}`;
    const key = `${dateStr}_email_${summary}`;
    if (existingKeys.has(key) || seen.has(key) || existingContexts.has(ix.snippet)) continue;
    seen.add(key);
    await peopleStorage.addInteraction(personId, {
      date: dateStr,
      type: "email",
      summary,
      context: ix.snippet || undefined,
    });
  }
}
