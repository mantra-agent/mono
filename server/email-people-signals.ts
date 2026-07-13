import { createLogger } from "./log";
import { peopleStorage, PeopleStorage, type Person } from "./people-storage";
import { upsertCandidates, type StoredImportCandidate } from "./import-queue";
import type { EmailMessage } from "@shared/schema";
import { db } from "./db";
import { emailMessages } from "@shared/schema";
import { and, eq, gt } from "drizzle-orm";

const log = createLogger("EmailPeopleSignals");

const SYSTEM_LOCAL_PARTS = new Set(["no-reply", "noreply", "donotreply", "do-not-reply", "notification", "notifications", "mailer-daemon"]);
const SYSTEM_DOMAINS = ["accounts.google.com", "google.com", "apple.com"];

type EmailDirection = "inbound" | "outbound" | "unknown";
type ParticipantRole = "from" | "to" | "cc";

export interface EmailSignalMessage {
  id?: number;
  provider: string;
  accountId: string;
  providerMessageId: string;
  providerThreadId?: string | null;
  subject?: string | null;
  snippet?: string | null;
  fromAddress?: string | null;
  toAddresses?: string | null;
  ccAddresses?: string | null;
  direction?: EmailDirection | string | null;
  date?: Date | string | null;
}

interface ExternalParticipant {
  email: string;
  displayName: string;
  role: ParticipantRole;
}

export function extractEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = value.match(/<([^>]+)>/);
  const raw = (angle?.[1] || value).trim().replace(/^mailto:/i, "");
  const match = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function extractEmailAddresses(value: string | null | undefined): string[] {
  if (!value) return [];
  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map((email) => email.toLowerCase()))];
}

function extractDisplayName(value: string | null | undefined, email: string): string {
  if (!value) return email.split("@")[0];
  const stripped = value.replace(/<[^>]+>/g, "").replace(/^"|"$/g, "").trim();
  return stripped || email.split("@")[0];
}

function splitAddressList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(part => part.trim()).filter(Boolean);
}

function isSelfEmail(email: string, accountId: string): boolean {
  const normalizedAccount = accountId.toLowerCase();
  const localAccount = normalizedAccount.includes("@") ? normalizedAccount : `${normalizedAccount.replace(/_/g, ".")}@gmail.com`;
  return email === normalizedAccount || email === localAccount;
}

function isNoiseSender(email: string): boolean {
  const [local, domain] = email.split("@");
  if (SYSTEM_LOCAL_PARTS.has(local)) return true;
  if (local.includes("noreply") || local.includes("no-reply")) return true;
  return SYSTEM_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`));
}

function getMessageDirection(message: EmailSignalMessage): EmailDirection {
  if (message.direction === "outbound" || message.direction === "inbound") return message.direction;
  return "inbound";
}

function getExternalParticipants(message: EmailSignalMessage): ExternalParticipant[] {
  const direction = getMessageDirection(message);
  const sources: Array<{ value: string | null | undefined; role: ParticipantRole }> = direction === "outbound"
    ? [
        { value: message.toAddresses, role: "to" },
        { value: message.ccAddresses, role: "cc" },
      ]
    : [{ value: message.fromAddress, role: "from" }];

  const seen = new Set<string>();
  const participants: ExternalParticipant[] = [];
  for (const source of sources) {
    for (const raw of splitAddressList(source.value)) {
      const email = extractEmailAddress(raw);
      if (!email || seen.has(email) || isSelfEmail(email, message.accountId) || isNoiseSender(email)) continue;
      seen.add(email);
      participants.push({ email, displayName: extractDisplayName(raw, email), role: source.role });
    }
  }
  return participants;
}

async function lookupPersonByEmail(email: string): Promise<{ id: string; name: string; person: Person } | null> {
  const match = await PeopleStorage.lookupPersonByEmail(email);
  if (!match) return null;
  const person = await peopleStorage.getPerson(match.id);
  if (!person) return null;
  return { id: match.id, name: match.name, person };
}

function baseSignalKey(message: EmailSignalMessage): string {
  return `email:${message.provider}:${message.accountId}:${message.providerMessageId}`;
}

function signalKey(message: EmailSignalMessage, email?: string): string {
  const suffix = email ? `:${email}` : "";
  return `${baseSignalKey(message)}${suffix}`;
}

async function clearResponseOwed(person: Person): Promise<number> {
  const owedInteractions = (person.interactions || []).filter((interaction) => interaction.responseOwed);
  for (const interaction of owedInteractions) {
    await peopleStorage.updateInteraction(person.id, interaction.id, {
      responseOwed: false,
      responseDueBy: "",
    });
  }
  return owedInteractions.length;
}

function hasRecentOutbound(person: Person, sinceDate: Date): boolean {
  return (person.interactions || []).some((i) => {
    if (i.direction !== "outbound") return false;
    const iDate = i.date ? new Date(i.date) : null;
    return iDate && !Number.isNaN(iDate.getTime()) && iDate.getTime() >= sinceDate.getTime();
  });
}

async function hasOutboundReplyInThread(providerThreadId: string | null | undefined, afterDate: Date, accountId: string): Promise<boolean> {
  if (!providerThreadId) return false;
  const rows = await db.select({ id: emailMessages.id })
    .from(emailMessages)
    .where(and(
      eq(emailMessages.providerThreadId, providerThreadId),
      eq(emailMessages.accountId, accountId),
      eq(emailMessages.direction, "outbound"),
      gt(emailMessages.date, afterDate),
    ))
    .limit(1);
  return rows.length > 0;
}

function computeResponseDueBy(emailDate: Date): string {
  const due = new Date(emailDate);
  due.setDate(due.getDate() + 3);
  return due.toISOString().slice(0, 10);
}

async function logKnownContactInteraction(personId: string, message: EmailSignalMessage, participant: ExternalParticipant, key: string, tier?: string, reason?: string): Promise<boolean> {
  const person = await peopleStorage.getPerson(personId);
  if (!person) return false;
  const baseKey = baseSignalKey(message);
  const existing = (person.interactions || []).find((i) => i.context === key || i.context?.startsWith(baseKey));

  const date = message.date ? new Date(message.date) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const direction = getMessageDirection(message) === "outbound" ? "outbound" : "inbound";

  if (direction === "outbound") {
    const cleared = await clearResponseOwed(person);
    if (cleared > 0) {
      log.info(`cleared ${cleared} response-owed interaction(s) for personId=${personId} from outbound email providerMessageId=${message.providerMessageId}`);
    }
  }

  if (existing) return false;

  const subject = message.subject || "(no subject)";
  const verb = direction === "outbound" ? "Sent" : "Received";
  const triageSuffix = direction === "inbound" && tier ? ` — triaged as ${tier}${reason ? `: ${reason}` : ""}` : "";

  // Set responseOwed on inbound direct emails from known contacts
  // Skip if: CC-only, already have a more recent outbound, triaged as spam/newsletter (🗑️),
  // or an outbound reply already exists in the same thread (source-of-truth check
  // against email_messages to eliminate sync/triage race condition)
  const isDirectInbound = direction === "inbound" && participant.role === "from";
  const isDismissed = tier === "🗑️";
  const hasOutboundReply = isDirectInbound && !isDismissed
    ? await hasOutboundReplyInThread(message.providerThreadId, safeDate, message.accountId)
    : false;
  const shouldSetResponseOwed = isDirectInbound && !isDismissed && !hasOutboundReply && !hasRecentOutbound(person, safeDate);

  await peopleStorage.addInteraction(personId, {
    date: safeDate.toISOString().split("T")[0],
    type: "email",
    summary: `${verb}: ${subject}${triageSuffix}`,
    context: `${key} participant=${participant.email} role=${participant.role}`,
    direction,
    ...(shouldSetResponseOwed ? {
      responseOwed: true,
      responseDueBy: computeResponseDueBy(safeDate),
    } : {}),
  });

  if (shouldSetResponseOwed) {
    log.info(`set responseOwed for personId=${personId} from inbound email providerMessageId=${message.providerMessageId} dueBy=${computeResponseDueBy(safeDate)}`);
  }

  return true;
}

async function queueUnknownParticipant(message: EmailSignalMessage, participant: ExternalParticipant, key: string, source: string): Promise<boolean> {
  const date = message.date ? new Date(message.date) : new Date();
  const iso = Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  const direction = getMessageDirection(message) === "outbound" ? "sent" : "received";
  const candidate: StoredImportCandidate = {
    email: participant.email,
    name: participant.displayName,
    sentCount: direction === "sent" ? 1 : 0,
    receivedCount: direction === "received" ? 1 : 0,
    threadCount: 1,
    firstInteraction: iso,
    lastInteraction: iso,
    sampleSubjects: message.subject ? [message.subject] : [],
    interactions: [{
      date: iso,
      subject: message.subject || "(no subject)",
      direction,
      snippet: key,
    }],
    scannedAt: new Date().toISOString(),
    accountId: message.accountId,
    source,
    decision: "pending",
  };
  await upsertCandidates([candidate]);
  return true;
}

export async function processEmailPeopleSignals(messages: EmailSignalMessage[], opts: { source?: string; tierByMessageId?: Map<number, { tier: string; reason?: string }> } = {}): Promise<{ processed: number; importQueued: number; interactionsLogged: number }> {
  if (messages.length === 0) return { processed: 0, importQueued: 0, interactionsLogged: 0 };
  let processed = 0;
  let importQueued = 0;
  let interactionsLogged = 0;

  for (const message of messages) {
    if (!message.providerMessageId || !message.accountId) continue;
    const participants = getExternalParticipants(message);
    if (participants.length === 0) continue;
    const triage = message.id ? opts.tierByMessageId?.get(message.id) : undefined;
    for (const participant of participants) {
      processed++;
      const key = signalKey(message, participant.email);
      const match = await lookupPersonByEmail(participant.email);
      if (match) {
        if (await logKnownContactInteraction(match.id, message, participant, key, triage?.tier, triage?.reason)) interactionsLogged++;
      } else {
        if (await queueUnknownParticipant(message, participant, key, opts.source || "email_sync")) importQueued++;
      }
    }
  }

  if (processed > 0) {
    log.debug(`processed=${processed} importQueued=${importQueued} interactionsLogged=${interactionsLogged}`);
  }
  return { processed, importQueued, interactionsLogged };
}

export async function processEmailPeopleSignal(message: EmailSignalMessage, opts: { source?: string } = {}) {
  return processEmailPeopleSignals([message], opts);
}

export function fromCachedEmail(row: EmailMessage): EmailSignalMessage {
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.accountId,
    providerMessageId: row.providerMessageId,
    providerThreadId: row.providerThreadId,
    subject: row.subject,
    snippet: row.snippet,
    fromAddress: row.fromAddress,
    toAddresses: row.toAddresses,
    ccAddresses: row.ccAddresses,
    direction: row.direction,
    date: row.date,
  };
}
