import { randomBytes } from "crypto";
import { createLogger } from "./log";
import { db } from "./db";
import { getSetting, setSetting } from "./system-settings";
import { calendarEventPeople, personEmails as personEmailsTable, personMergeAliases, personVaultMemberships, persons, vaults } from "@shared/schema";
import { and, eq, inArray } from "drizzle-orm";
import { TTLCache } from "./utils/ttl-cache";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { mergePersonValues } from "./person-merge-values";
import { calendarPeopleOwnerColumns, performPersonMerge, type MergePeopleInput, type MergePeopleResult } from "./person-merge-service";
import { combineWithSensitiveWritable } from "./sensitive-scope";
import { isCivilDate } from "@shared/civil-date";
import { toCivilDate } from "./civil-date";
import { getTimezone } from "./timezone";
import {
  loadPersonVaultIds,
  personVaultMembershipScopeColumns,
  visiblePersonPredicate,
  writablePersonPredicate,
} from "./person-vault-access";

const personScopeColumns = { scope: persons.scope, ownerUserId: persons.ownerUserId, accountId: persons.accountId };
const personMergeAliasScopeColumns = { scope: personMergeAliases.scope, ownerUserId: personMergeAliases.ownerUserId, accountId: personMergeAliases.accountId };

export interface ContactInfo {
  type: "email" | "phone" | "social" | "other";
  label: string;
  value: string;
}

export interface ImportantDate {
  id: string;
  label: string;
  date: string;
  recurrence: "annual" | "one-time";
}

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface Interaction {
  id: string;
  date: string;
  type: "message" | "call" | "meeting" | "email" | "note" | "text" | "in_person" | "video" | "social" | "gift" | "introduction" | "favor" | "support";
  summary: string;
  context?: string;
  direction?: "inbound" | "outbound" | "mutual";
  meaningfulness?: "high" | "medium" | "low";
  responseOwed?: boolean;
  responseDueBy?: string;
  capitalImpact?: "deposit" | "withdrawal" | "neutral";
  tags?: string[];
}

export interface RelationshipCadence {
  targetDays: number;
  flexDays: number;
  cadenceClass: "weekly" | "biweekly" | "monthly" | "quarterly" | "episodic";
}

export interface RelationshipState {
  temperature: "hot" | "warm" | "cool" | "cold";
  momentum: "strengthening" | "steady" | "fading" | "re-engaging";
  status: "active" | "paused" | "strained" | "dormant";
}

export interface RelationshipRollup {
  lastInteractionAt?: string;
  lastMeaningfulAt?: string;
  lastOutboundAt?: string;
  lastInboundAt?: string;
  interactionCount30d: number;
  meaningfulCount90d: number;
}

export interface RelationshipOutreach {
  nextSuggestedAt?: string;
  reason?: string;
  recommendedChannel?: string;
  dueStatus: "on_track" | "due" | "drifting" | "urgent";
}

export interface RelationshipProfile {
  cadence?: RelationshipCadence;
  state?: RelationshipState;
  rollup?: RelationshipRollup;
  outreach?: RelationshipOutreach;
}

export interface NetworkConnection {
  personId?: string;
  name: string;
  relationship: string;
  domain?: string;
}

export interface SocialCapital {
  balance: "invested" | "balanced" | "drawing" | "overdrawn";
  depositsFromRay: string[];
  depositsToRay: string[];
  lastDeposit?: string;
  lastWithdrawal?: string;
}

export interface Commitment {
  id: string;
  direction: "from_ray" | "to_ray";
  description: string;
  status: "open" | "fulfilled" | "expired";
  createdAt: string;
  resolvedAt?: string;
}

export interface Mobilization {
  ready: boolean;
  blockers: string[];
  warmingPath?: string;
  estimated?: boolean;
}

export interface NetworkProfile {
  expertise?: string[];
  domains?: string[];
  resources?: string[];
  canHelpWith?: string[];
  connections?: NetworkConnection[];
  capital?: SocialCapital;
  commitments?: Commitment[];
  mobilization?: Mobilization;
}

export interface SocialProfiles {
  instagram?: string;
  x?: string;
  linkedin?: string;
}

export interface Person {
  id: string;
  name: string;
  nicknames: string[];
  cabinetLevel: string;
  photo?: string;
  birthday?: string;
  company?: string;
  companyId?: string;
  role?: string;
  professionalRelations?: string[];
  relation?: string;
  introducedBy?: string;
  familiarity?: "none" | "surface" | "deep";
  trust?: "ally" | "positive" | "none" | "negative" | "enemy";
  met?: string;
  socialProfiles: SocialProfiles;
  contactInfo: ContactInfo[];
  importantDates: ImportantDate[];
  notes: Note[];
  interactions: Interaction[];
  tags: string[];
  aiSummary?: string;
  quickSummary?: string;
  identityContent?: string;
  relationshipProfile?: RelationshipProfile;
  networkProfile?: NetworkProfile;
  dailyContact?: boolean;
  private: boolean;
  vaultIds?: string[];
  lastViewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonIndexEntry {
  id: string;
  name: string;
  nicknames: string[];
  cabinetLevel: string;
  company?: string;
  companyId?: string;
  role?: string;
  tags: string[];
  lastInteractionDate?: string;
  createdAt?: string;
  updatedAt?: string;
  lastViewedAt?: string;
  private: boolean;
}

export interface PersonVaultMembershipView {
  id: string;
  name: string;
}

export interface PersonVaultMutationResult {
  person: Person;
  changed: boolean;
}

export interface CabinetLevel {
  id: string;
  name: string;
  color?: string;
  order: number;
}

export interface CabinetConfig {
  levels: CabinetLevel[];
}

export interface TimeBudgets {
  weeklyGoals: Record<string, number>;
}

export interface TrustConfig {
  levels: Record<string, "suggest" | "auto-draft" | "full-autonomy">;
}

const DEFAULT_CADENCE_BY_TIER: Record<string, RelationshipCadence> = {
  agent: { targetDays: 1, flexDays: 1, cadenceClass: "weekly" },
  user: { targetDays: 1, flexDays: 1, cadenceClass: "weekly" },
  self: { targetDays: 1, flexDays: 1, cadenceClass: "weekly" }, // legacy — use agent/user
  family: { targetDays: 14, flexDays: 7, cadenceClass: "biweekly" },
  cabinet: { targetDays: 14, flexDays: 7, cadenceClass: "biweekly" },
  community: { targetDays: 60, flexDays: 30, cadenceClass: "monthly" },
  network: { targetDays: 180, flexDays: 90, cadenceClass: "episodic" },
};

export function getDefaultCadence(cabinetLevel: string): RelationshipCadence {
  return DEFAULT_CADENCE_BY_TIER[cabinetLevel] || DEFAULT_CADENCE_BY_TIER.network;
}

export function computeRollup(interactions: Interaction[]): RelationshipRollup {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 86400000;
  const ninetyDaysAgo = now - 90 * 86400000;

  let lastInteractionAt: string | undefined;
  let lastMeaningfulAt: string | undefined;
  let lastOutboundAt: string | undefined;
  let lastInboundAt: string | undefined;
  let interactionCount30d = 0;
  let meaningfulCount90d = 0;

  for (const ix of interactions) {
    const t = new Date(ix.date).getTime();
    if (!lastInteractionAt || ix.date > lastInteractionAt) lastInteractionAt = ix.date;

    const isMeaningful = ix.meaningfulness !== "low";
    if (isMeaningful && (!lastMeaningfulAt || ix.date > lastMeaningfulAt)) {
      lastMeaningfulAt = ix.date;
    }

    const dir = ix.direction || "mutual";
    if ((dir === "outbound" || dir === "mutual") && (!lastOutboundAt || ix.date > lastOutboundAt)) {
      lastOutboundAt = ix.date;
    }
    if ((dir === "inbound" || dir === "mutual") && (!lastInboundAt || ix.date > lastInboundAt)) {
      lastInboundAt = ix.date;
    }

    if (t >= thirtyDaysAgo) interactionCount30d++;
    if (t >= ninetyDaysAgo && isMeaningful) meaningfulCount90d++;
  }

  return {
    lastInteractionAt,
    lastMeaningfulAt,
    lastOutboundAt,
    lastInboundAt,
    interactionCount30d,
    meaningfulCount90d,
  };
}

export function computeDueStatus(
  rollup: RelationshipRollup,
  cadence: RelationshipCadence,
  person?: { networkProfile?: NetworkProfile; interactions?: Interaction[]; cabinetLevel?: string; dailyContact?: boolean }
): "on_track" | "due" | "drifting" | "urgent" {
  if (cadence.cadenceClass === "episodic") return "on_track";
  if (person?.dailyContact) return "on_track";
  const anchor = rollup.lastMeaningfulAt || rollup.lastInteractionAt;
  if (!anchor) return "due";
  const daysSince = Math.floor((Date.now() - new Date(anchor).getTime()) / 86400000);
  if (daysSince < cadence.targetDays) return "on_track";
  if (daysSince < cadence.targetDays + cadence.flexDays) return "due";

  const hasResponseOwed = person?.interactions?.some(ix => ix.responseOwed) ?? false;
  const hasOpenCommitment = person?.networkProfile?.commitments?.some(c => c.status === "open") ?? false;
  const isHighImportance = ["family", "cabinet"].includes(person?.cabinetLevel || "");
  if (hasResponseOwed || hasOpenCommitment) return "urgent";
  if (isHighImportance && daysSince > cadence.targetDays + cadence.flexDays * 2) return "urgent";

  return "drifting";
}

export function computeOutreach(
  rollup: RelationshipRollup,
  cadence: RelationshipCadence,
  dueStatus: "on_track" | "due" | "drifting" | "urgent",
  dailyContact?: boolean
): RelationshipOutreach {
  const anchor = rollup.lastMeaningfulAt || rollup.lastInteractionAt;
  let nextSuggestedAt: string | undefined;
  if (anchor) {
    const nextDate = new Date(new Date(anchor).getTime() + cadence.targetDays * 86400000);
    nextSuggestedAt = nextDate.toISOString().split("T")[0];
  }

  let reason = dailyContact ? "Daily contact — log meaningful interactions when noteworthy" : "Regular check-in";
  let recommendedChannel = "message";
  if (dueStatus === "urgent") {
    reason = "Relationship needs immediate attention";
    recommendedChannel = "call";
  } else if (dueStatus === "drifting") {
    reason = "Relationship drifting — meaningful touch needed";
    recommendedChannel = "call";
  } else if (dueStatus === "due") {
    reason = "Due for outreach based on cadence";
    recommendedChannel = "message";
  }

  return { nextSuggestedAt, reason, recommendedChannel, dueStatus };
}

export function recomputeRelationshipProfile(person: Person): RelationshipProfile {
  const cadence = person.relationshipProfile?.cadence || getDefaultCadence(person.cabinetLevel);
  const rollup = computeRollup(person.interactions);
  const dueStatus = computeDueStatus(rollup, cadence, person);
  const outreach = computeOutreach(rollup, cadence, dueStatus, person.dailyContact);

  return {
    cadence,
    state: person.relationshipProfile?.state,
    rollup,
    outreach,
  };
}

export function computeMobilization(person: Person): Mobilization {
  const blockers: string[] = [];
  const temp = person.relationshipProfile?.state?.temperature;
  const capitalBalance = person.networkProfile?.capital?.balance;
  const dueStatus = person.relationshipProfile?.outreach?.dueStatus;
  const rollup = person.relationshipProfile?.rollup;

  if (temp === "cold" || temp === "cool") {
    const daysSince = rollup?.lastMeaningfulAt
      ? Math.floor((Date.now() - new Date(rollup.lastMeaningfulAt).getTime()) / 86400000)
      : null;
    blockers.push(`Needs warming${daysSince ? ` — last meaningful contact ${daysSince} days ago` : ""}`);
  }
  if (capitalBalance === "overdrawn") {
    blockers.push("Social capital overdrawn — deposit needed before asking");
  }
  if (dueStatus === "drifting" || dueStatus === "urgent") {
    blockers.push("Relationship maintenance overdue");
  }

  const ready = blockers.length === 0 && temp !== undefined;
  let warmingPath: string | undefined;
  if (!ready && blockers.length > 0) {
    if (temp === "cold") {
      warmingPath = "Reconnect with a personal, low-ask outreach. Follow up in 1-2 weeks before making any request.";
    } else if (temp === "cool") {
      warmingPath = "Send a casual check-in this week, then make the ask in 1-2 weeks.";
    } else if (dueStatus === "drifting") {
      warmingPath = "Quick meaningful touch first, then proceed with ask.";
    }
  }

  return { ready, blockers, warmingPath, estimated: !temp };
}

export interface AgendaSignals {
  cadence_urgency: number;
  response_owed: number;
  commitment_open: number;
  capital_health: number;
  strategic_timing: number;
  importance: number;
  warming_need: number;
}

export interface ScoredAgendaItem {
  personId: string;
  name: string;
  cabinetLevel: string;
  daysSinceLastContact: number;
  daysSinceMeaningful: number;
  reason: string;
  suggestedAction: string;
  dueStatus: string;
  score: number;
  bucket: "commitment" | "nurture" | "invest";
  surfaceTier: "follow_up" | "maintenance";
  surfaceRank: number;
  contextBadge?: { label: string; color: string };
  signals: AgendaSignals;
  responseOwedDetails?: string;
  responseDueBy?: string;
  commitmentDetails?: string;
  surfacedAt?: string;
  photo?: string;
}

function responseDueSortValue(interaction: Interaction): number {
  if (!interaction.responseDueBy) return Number.POSITIVE_INFINITY;
  const value = new Date(interaction.responseDueBy).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function isResponseOwedDue(interaction: Interaction, today: string): boolean {
  if (!interaction.responseOwed || !interaction.responseDueBy) return Boolean(interaction.responseOwed);
  if (!isCivilDate(interaction.responseDueBy)) return true;
  return interaction.responseDueBy <= today;
}

function selectResponseOwedInteraction(interactions: Interaction[], now: number): Interaction | undefined {
  const today = toCivilDate(new Date(now), getTimezone());
  return interactions
    .filter(ix => isResponseOwedDue(ix, today))
    .sort((a, b) => {
      const aDue = responseDueSortValue(a);
      const bDue = responseDueSortValue(b);
      if (aDue !== bDue) return aDue - bDue;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    })[0];
}

export function computeAgendaSignals(
  person: Person,
  cabinetWeights: Record<string, number>,
  now: number,
  calendarAttendees?: Set<string>
): ScoredAgendaItem | null {
  const cadence = person.relationshipProfile?.cadence || getDefaultCadence(person.cabinetLevel);
  const rollup = computeRollup(person.interactions);
  const dueStatus = computeDueStatus(rollup, cadence, person);
  const outreach = computeOutreach(rollup, cadence, dueStatus, person.dailyContact);

  const daysSinceLastContact = rollup.lastInteractionAt
    ? Math.floor((now - new Date(rollup.lastInteractionAt).getTime()) / 86400000)
    : 365;
  const daysSinceMeaningful = rollup.lastMeaningfulAt
    ? Math.floor((now - new Date(rollup.lastMeaningfulAt).getTime()) / 86400000)
    : 365;

  const weight = cabinetWeights[person.cabinetLevel] || 1;
  const responseOwedIx = selectResponseOwedInteraction(person.interactions, now);
  const openCommitments = person.networkProfile?.commitments?.filter(c => c.status === "open") || [];
  const temperature = person.relationshipProfile?.state?.temperature;
  const capitalBalance = person.networkProfile?.capital?.balance;
  const isCooling = temperature === "cool" || temperature === "cold";
  const isHighValue = ["family", "cabinet"].includes(person.cabinetLevel);

  const personNameLower = person.name.toLowerCase();
  const personEmailsList = person.contactInfo
    .filter(c => c.type === "email")
    .map(c => c.value.toLowerCase());
  const hasUpcomingCalendarMeeting = calendarAttendees
    ? (calendarAttendees.has(personNameLower) || personEmailsList.some(e => calendarAttendees.has(e)))
    : false;

  let upcomingDateBonus = 0;
  for (const d of person.importantDates) {
    const dateObj = new Date(d.date);
    const thisYear = new Date(now);
    if (d.recurrence === "annual") {
      dateObj.setFullYear(thisYear.getFullYear());
      if (dateObj.getTime() < now) dateObj.setFullYear(thisYear.getFullYear() + 1);
    }
    const daysUntil = Math.floor((dateObj.getTime() - now) / 86400000);
    if (daysUntil >= 0 && daysUntil <= 14) upcomingDateBonus += Math.max(0, 15 - daysUntil) * 2;
  }

  const calendarBonus = hasUpcomingCalendarMeeting ? 40 : 0;

  const signals: AgendaSignals = {
    cadence_urgency: dueStatus === "drifting" ? 80 : dueStatus === "urgent" ? 60 : dueStatus === "due" ? 30 : 0,
    response_owed: responseOwedIx ? 100 : 0,
    commitment_open: openCommitments.length > 0 ? 70 + openCommitments.length * 10 : 0,
    capital_health: capitalBalance === "overdrawn" ? 40 : capitalBalance === "drawing" ? 20 : 0,
    strategic_timing: upcomingDateBonus + calendarBonus,
    importance: weight * 10,
    warming_need: isCooling && isHighValue ? 60 : isCooling ? 20 : 0,
  };

  if (person.dailyContact) {
    signals.cadence_urgency = 0;
    signals.warming_need = 0;
  }

  const totalScore = signals.cadence_urgency + signals.response_owed + signals.commitment_open
    + signals.capital_health + signals.strategic_timing + signals.importance + signals.warming_need;

  if (totalScore === 0 && dueStatus === "on_track" && upcomingDateBonus === 0) return null;

  const item: ScoredAgendaItem = {
    personId: person.id,
    name: person.name,
    cabinetLevel: person.cabinetLevel,
    daysSinceLastContact,
    daysSinceMeaningful,
    reason: outreach.reason || "",
    suggestedAction: outreach.recommendedChannel === "call" ? "Schedule a call" : "Send a message",
    dueStatus,
    score: totalScore,
    bucket: "nurture",
    surfaceTier: "maintenance",
    surfaceRank: totalScore,
    signals,
    photo: person.photo,
  };

  if (responseOwedIx) {
    item.responseOwedDetails = responseOwedIx.summary;
    item.responseDueBy = responseOwedIx.responseDueBy;
    item.surfacedAt = responseOwedIx.date
      ? (responseOwedIx.date.length === 10 ? `${responseOwedIx.date}T12:00:00.000Z` : new Date(responseOwedIx.date).toISOString())
      : undefined;
    item.reason = `Response owed — ${responseOwedIx.summary.slice(0, 80)}`;
    item.suggestedAction = "Respond";
    item.bucket = "commitment";
  } else if (openCommitments.length > 0) {
    const oldest = openCommitments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0];
    const age = Math.floor((now - new Date(oldest.createdAt).getTime()) / 86400000);
    item.commitmentDetails = oldest.description;
    item.surfacedAt = oldest.createdAt;
    item.reason = `Open commitment (${age}d): ${oldest.description.slice(0, 80)}`;
    item.suggestedAction = oldest.direction === "from_ray" ? "Follow through on commitment" : "Follow up";
    item.bucket = "commitment";
  } else if (hasUpcomingCalendarMeeting && (isCooling || dueStatus !== "on_track")) {
    item.reason = isCooling
      ? `Upcoming meeting — relationship is ${temperature}, warm before meeting`
      : `Upcoming meeting — prepare and reconnect`;
    item.suggestedAction = "Warm before upcoming meeting";
    item.bucket = "invest";
  } else if ((dueStatus === "drifting" || dueStatus === "urgent") && isHighValue) {
    item.reason = isCooling
      ? `Relationship cooling — ${temperature}, ${dueStatus}`
      : `High-value contact ${dueStatus} — needs strategic re-engagement`;
    item.suggestedAction = "Plan a meaningful reconnection";
    item.bucket = "invest";
  } else if (isCooling && isHighValue && dueStatus !== "on_track") {
    item.reason = `Temperature ${temperature} — proactive warming recommended`;
    item.suggestedAction = "Initiate warm outreach";
    item.bucket = "invest";
  } else if (dueStatus !== "on_track") {
    if (upcomingDateBonus > 0) {
      item.reason += `, upcoming important date`;
      item.suggestedAction = "Reach out about upcoming date";
    }
    item.bucket = "nurture";
  } else if (upcomingDateBonus > 0) {
    item.reason = "Upcoming important date";
    item.suggestedAction = "Reach out about upcoming date";
    item.bucket = "nurture";
  }

  item.surfaceTier = item.bucket === "commitment" ? "follow_up" : "maintenance";
  item.surfaceRank = item.score;
  item.surfacedAt ??= rollup.lastMeaningfulAt || rollup.lastInteractionAt || new Date(now).toISOString();

  return item;
}

export function computeContextBadge(item: ScoredAgendaItem): { label: string; color: string } {
  if (item.bucket === "commitment") {
    if (item.responseOwedDetails) return { label: "Response owed", color: "text-error-foreground" };
    return { label: "Open commitment", color: "text-warning-foreground" };
  }
  if (item.bucket === "invest") {
    const temp = item.reason.toLowerCase();
    if (temp.includes("upcoming meeting")) return { label: "Meeting soon", color: "text-info-foreground" };
    if (item.daysSinceMeaningful >= 45) return { label: `${item.daysSinceMeaningful}d gap`, color: "text-info-foreground" };
    return { label: "Cooling", color: "text-info-foreground" };
  }
  // nurture
  if (item.dueStatus === "drifting" || item.dueStatus === "urgent" || item.dueStatus === "due") return { label: "", color: "text-muted-foreground" };
  if (item.reason.toLowerCase().includes("upcoming")) return { label: "Upcoming date", color: "text-warning-foreground" };
  return { label: item.dueStatus.replace(/_/g, " "), color: "text-muted-foreground" };
}

// ── Constants ────────────────────────────────────────────────────

const DEFAULT_CABINET_CONFIG: CabinetConfig = {
  levels: [
    { id: "agent", name: "Agent", color: "#9b59b6", order: 0 },
    { id: "user", name: "User", color: "#e67e22", order: 1 },
    { id: "family", name: "Family", color: "#e74c3c", order: 2 },
    { id: "cabinet", name: "Cabinet", color: "#3498db", order: 3 },
    { id: "community", name: "Community", color: "#f39c12", order: 4 },
    { id: "network", name: "Network", color: "#95a5a6", order: 5 },
  ],
};

const DEFAULT_TRUST_CONFIG: TrustConfig = {
  levels: {
    people: "auto-draft",
    chat: "suggest",
    work: "suggest",
  },
};

function generateId(): string {
  return randomBytes(4).toString("hex");
}

// ── Row <-> Person mapping ───────────────────────────────────────

function rowToPerson(row: Record<string, any>): Person {
  return {
    id: row.id,
    name: row.name,
    nicknames: Array.isArray(row.nicknames) ? row.nicknames : [],
    cabinetLevel: row.cabinetLevel || row.cabinet_level || "network",
    photo: row.photo || undefined,
    birthday: row.birthday || undefined,
    company: row.company || undefined,
    companyId: row.companyId || row.company_id || undefined,
    role: row.role || undefined,
    professionalRelations: Array.isArray(row.professionalRelations || row.professional_relations) ? (row.professionalRelations || row.professional_relations) : [],
    relation: row.relation || undefined,
    introducedBy: row.introducedBy || row.introduced_by || undefined,
    familiarity: row.familiarity || undefined,
    trust: row.trust || undefined,
    met: row.met || undefined,
    socialProfiles: row.socialProfiles || row.social_profiles || {},
    contactInfo: Array.isArray(row.contactInfo || row.contact_info) ? (row.contactInfo || row.contact_info) : [],
    importantDates: Array.isArray(row.importantDates || row.important_dates) ? (row.importantDates || row.important_dates) : [],
    notes: Array.isArray(row.notes) ? row.notes : [],
    interactions: Array.isArray(row.interactions) ? row.interactions : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    aiSummary: row.aiSummary || row.ai_summary || undefined,
    quickSummary: row.quickSummary || row.quick_summary || undefined,
    identityContent: row.identityContent || row.identity_content || undefined,
    relationshipProfile: row.relationshipProfile || row.relationship_profile || undefined,
    networkProfile: row.networkProfile || row.network_profile || undefined,
    dailyContact: !!(row.dailyContact ?? row.daily_contact),
    private: row.private ?? false,
    vaultIds: Array.isArray(row.vaultIds || row.vault_ids) ? (row.vaultIds || row.vault_ids) : [],
    lastViewedAt: row.lastViewedAt || row.last_viewed_at ? (typeof (row.lastViewedAt || row.last_viewed_at) === "string" ? (row.lastViewedAt || row.last_viewed_at) : new Date(row.lastViewedAt || row.last_viewed_at).toISOString()) : undefined,
    createdAt: row.createdAt ? (typeof row.createdAt === "string" ? row.createdAt : new Date(row.createdAt).toISOString()) : new Date().toISOString(),
    updatedAt: row.updatedAt ? (typeof row.updatedAt === "string" ? row.updatedAt : new Date(row.updatedAt).toISOString()) : new Date().toISOString(),
  };
}

const log = createLogger("PeopleStorage");

function principalCacheKey(): string {
  const principal = getCurrentPrincipalOrSystem();
  const visibleVaultKey = [...principal.visibleVaultIds].sort().join(",") || "no-visible-vaults";
  return `${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}:${visibleVaultKey}`;
}

// ── PeopleStorage (Drizzle-backed) ──────────────────────────────

export class PeopleStorage {
  private readonly _listCache = new TTLCache<PersonIndexEntry[]>("PeopleList", 30_000);
  private readonly _aliasGraphCache = new TTLCache<Map<string, string>>("PersonAliasGraph", 30_000);

  private invalidateListCache(): void {
    this._listCache.invalidateAll();
  }

  private invalidateAliasGraphCache(): void {
    this._aliasGraphCache.invalidateAll();
  }

  private async getAliasGraph(): Promise<Map<string, string>> {
    const principal = getCurrentPrincipalOrSystem();
    return this._aliasGraphCache.getOrFetch(principalCacheKey(), async () => {
      const aliases = await db
        .select({ sourceId: personMergeAliases.sourceId, targetId: personMergeAliases.targetId })
        .from(personMergeAliases)
        .innerJoin(persons, eq(persons.id, personMergeAliases.targetId))
        .where(and(
          combineWithVisibleScope(principal, personMergeAliasScopeColumns),
          visiblePersonPredicate(principal),
        ));
      return new Map(aliases.map(alias => [alias.sourceId, alias.targetId]));
    });
  }

  private resolvePersonAliasFromGraph(id: string, aliasBySource: ReadonlyMap<string, string>): string {
    let current = id;
    const seen = new Set<string>();
    for (let depth = 0; depth < 16; depth++) {
      if (seen.has(current)) throw new Error(`Person merge alias cycle detected at ${current}`);
      seen.add(current);
      const target = aliasBySource.get(current);
      if (!target) return current;
      current = target;
    }
    throw new Error(`Person merge alias depth exceeded for ${id}`);
  }

  private async syncPersonEmails(person: Person): Promise<void> {
    const emails = new Set<string>();
    for (const ci of person.contactInfo || []) {
      if (ci.type === "email" && ci.value) {
        const normalized = ci.value.toLowerCase().trim();
        if (normalized.includes("@")) emails.add(normalized);
      }
    }

    await db.delete(personEmailsTable).where(eq(personEmailsTable.personId, person.id));

    const now = new Date();
    for (const email of emails) {
      await db.insert(personEmailsTable)
        .values({
          email,
          personId: person.id,
          personName: person.name,
          source: "contact_info",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: personEmailsTable.email,
          set: {
            personId: person.id,
            personName: person.name,
            updatedAt: now,
          },
        });
    }
  }

  static async rebuildEmailIndex(): Promise<number> {
    const storage = peopleStorage;
    const people = await storage.listPeople();
    let count = 0;
    for (const entry of people) {
      const person = await storage.getPerson(entry.id);
      if (!person) continue;
      await storage.syncPersonEmails(person);
      const emailCount = (person.contactInfo || []).filter(ci => ci.type === "email" && ci.value).length;
      count += emailCount;
    }
    return count;
  }

  static async lookupPersonByEmail(email: string): Promise<{ id: string; name: string } | null> {
    const normalized = email.toLowerCase().trim();
    const rows = await db.select().from(personEmailsTable).where(eq(personEmailsTable.email, normalized));
    if (rows.length === 0) return null;
    return { id: rows[0].personId, name: rows[0].personName };
  }

  private async hydratePersonRows(rows: Array<typeof persons.$inferSelect>): Promise<Person[]> {
    const principal = getCurrentPrincipalOrSystem();
    const vaultIdsByPerson = await loadPersonVaultIds(principal, rows.map(row => row.id));
    return rows.map(row => rowToPerson({ ...row, vaultIds: vaultIdsByPerson.get(row.id) ?? [] }));
  }

  private async assignInitialVaultMembership(personId: string): Promise<void> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType === "system") return;
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId || !principal.activeVaultId) {
      throw new Error("Creating a Person requires an authenticated user with an active Vault");
    }
    const ownedVault = await db
      .select({ id: vaults.id })
      .from(vaults)
      .where(and(
        eq(vaults.id, principal.activeVaultId),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      ))
      .limit(1);
    if (!ownedVault[0]) throw new Error("Active Vault is not available in this account");
    await db.insert(personVaultMemberships)
      .values({
        personId,
        vaultId: principal.activeVaultId,
        scope: "user",
        ownerUserId: principal.userId,
        accountId: principal.accountId,
        createdByUserId: principal.userId,
      })
      .onConflictDoNothing();
  }

  async listVaultMemberships(personId: string): Promise<PersonVaultMembershipView[]> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Person Vault membership requires an authenticated user account");
    }

    const [person] = await db
      .select({ id: persons.id })
      .from(persons)
      .where(visiblePersonPredicate(principal, eq(persons.id, personId)))
      .limit(1);
    if (!person) throw new Error(`Person ${personId} not found or not visible`);

    return db
      .select({ id: vaults.id, name: vaults.name })
      .from(personVaultMemberships)
      .innerJoin(vaults, eq(vaults.id, personVaultMemberships.vaultId))
      .where(and(
        eq(personVaultMemberships.personId, personId),
        eq(personVaultMemberships.scope, "user"),
        eq(personVaultMemberships.ownerUserId, principal.userId),
        eq(personVaultMemberships.accountId, principal.accountId),
        inArray(personVaultMemberships.vaultId, principal.visibleVaultIds),
        eq(vaults.accountId, principal.accountId),
        eq(vaults.isArchived, false),
      ))
      .orderBy(vaults.position, vaults.createdAt);
  }

  async addVaultMembership(personId: string, vaultId: string): Promise<PersonVaultMutationResult> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Person Vault membership requires an authenticated user account");
    }
    const normalizedVaultId = vaultId.trim();
    if (!normalizedVaultId) throw new Error("vaultId is required");

    const changed = await db.transaction(async tx => {
      const [person] = await tx
        .select({ id: persons.id })
        .from(persons)
        .where(writablePersonPredicate(principal, eq(persons.id, personId)))
        .for("update");
      if (!person) throw new Error(`Person ${personId} not found or not writable`);

      const [ownedVault] = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(
          eq(vaults.id, normalizedVaultId),
          eq(vaults.accountId, principal.accountId),
          inArray(vaults.id, principal.visibleVaultIds),
          eq(vaults.isArchived, false),
        ))
        .limit(1);
      if (!ownedVault) throw new Error("Person Vault must be live and belong to the active account");

      const inserted = await tx
        .insert(personVaultMemberships)
        .values({
          personId,
          vaultId: normalizedVaultId,
          scope: "user",
          ownerUserId: principal.userId,
          accountId: principal.accountId,
          createdByUserId: principal.userId,
        })
        .onConflictDoNothing()
        .returning({ vaultId: personVaultMemberships.vaultId });
      return inserted.length > 0;
    });

    if (changed) this.invalidateListCache();
    return { person: await this.loadWritablePersonAfterVaultMutation(principal, personId), changed };
  }

  async removeVaultMembership(personId: string, vaultId: string): Promise<PersonVaultMutationResult> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Person Vault membership requires an authenticated user account");
    }
    const normalizedVaultId = vaultId.trim();
    if (!normalizedVaultId) throw new Error("vaultId is required");

    const changed = await db.transaction(async tx => {
      const [person] = await tx
        .select({ id: persons.id })
        .from(persons)
        .where(writablePersonPredicate(principal, eq(persons.id, personId)))
        .for("update");
      if (!person) throw new Error(`Person ${personId} not found or not writable`);

      const [ownedVault] = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(
          eq(vaults.id, normalizedVaultId),
          eq(vaults.accountId, principal.accountId),
          inArray(vaults.id, principal.visibleVaultIds),
          eq(vaults.isArchived, false),
        ))
        .limit(1);
      if (!ownedVault) throw new Error("Person Vault must be live and belong to the active account");

      const memberships = await tx
        .select({ vaultId: personVaultMemberships.vaultId })
        .from(personVaultMemberships)
        .innerJoin(vaults, eq(vaults.id, personVaultMemberships.vaultId))
        .where(combineWithWritableScope(
          principal,
          personVaultMembershipScopeColumns,
          and(
            eq(personVaultMemberships.personId, personId),
            eq(vaults.accountId, principal.accountId),
            eq(vaults.isArchived, false),
          ),
        ))
        .for("update");
      if (!memberships.some(membership => membership.vaultId === normalizedVaultId)) return false;
      if (memberships.length === 1) throw new Error("A Person must belong to at least one Vault");

      const removed = await tx
        .delete(personVaultMemberships)
        .where(combineWithWritableScope(
          principal,
          personVaultMembershipScopeColumns,
          and(
            eq(personVaultMemberships.personId, personId),
            eq(personVaultMemberships.vaultId, normalizedVaultId),
          ),
        ))
        .returning({ vaultId: personVaultMemberships.vaultId });
      return removed.length > 0;
    });

    if (changed) this.invalidateListCache();
    return { person: await this.loadWritablePersonAfterVaultMutation(principal, personId), changed };
  }

  async replaceVaultMemberships(
    personId: string,
    vaultIds: string[],
    options: { requireVisibleTargets?: boolean } = {},
  ): Promise<Person> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Person Vault membership requires an authenticated user account");
    }
    const normalizedVaultIds = [...new Set(vaultIds.map(id => id.trim()).filter(Boolean))];
    if (normalizedVaultIds.length === 0) throw new Error("A Person must belong to at least one Vault");

    await db.transaction(async tx => {
      const [person] = await tx
        .select({ id: persons.id })
        .from(persons)
        .where(writablePersonPredicate(principal, eq(persons.id, personId)))
        .for("update");
      if (!person) throw new Error(`Person ${personId} not found or not writable`);

      const ownedVaults = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(
          inArray(vaults.id, normalizedVaultIds),
          eq(vaults.accountId, principal.accountId),
          ...(options.requireVisibleTargets
            ? [inArray(vaults.id, principal.visibleVaultIds)]
            : []),
          eq(vaults.isArchived, false),
        ));
      if (ownedVaults.length !== normalizedVaultIds.length) {
        throw new Error(options.requireVisibleTargets
          ? "Every Person Vault must be visible, live, and belong to the active account"
          : "Every Person Vault must be live and belong to the active account");
      }

      await tx.delete(personVaultMemberships).where(
        combineWithWritableScope(
          principal,
          personVaultMembershipScopeColumns,
          eq(personVaultMemberships.personId, personId),
        ),
      );
      await tx.insert(personVaultMemberships).values(
        normalizedVaultIds.map(vaultId => ({
          personId,
          vaultId,
          scope: "user",
          ownerUserId: principal.userId!,
          accountId: principal.accountId!,
          createdByUserId: principal.userId!,
        })),
      );
    });

    this.invalidateListCache();
    return this.loadWritablePersonAfterVaultMutation(principal, personId);
  }

  private async loadWritablePersonAfterVaultMutation(
    principal: ReturnType<typeof getCurrentPrincipalOrSystem>,
    personId: string,
  ): Promise<Person> {
    const rows = await db.select().from(persons).where(
      combineWithWritableScope(principal, personScopeColumns, eq(persons.id, personId)),
    );
    const [person] = await this.hydratePersonRows(rows);
    if (!person) throw new Error(`Person ${personId} not found after updating Vaults`);
    return person;
  }

  private async savePerson(person: Person): Promise<void> {
    const now = new Date();
    await db.insert(persons)
      .values({
        id: person.id,
        ...ownedInsertValues(getCurrentPrincipalOrSystem(), personScopeColumns),
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
        dailyContact: !!person.dailyContact,
        private: person.private ?? false,
        createdAt: person.createdAt ? new Date(person.createdAt) : now,
        updatedAt: person.updatedAt ? new Date(person.updatedAt) : now,
      })
      .onConflictDoUpdate({
        target: persons.id,
        set: {
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
          dailyContact: !!person.dailyContact,
          private: person.private ?? false,
          updatedAt: person.updatedAt ? new Date(person.updatedAt) : now,
        },
      });
    this.invalidateListCache();
    await this.syncPersonEmails(person).catch((err) => {
      log.warn(`syncPersonEmails failed for personId=${person.id}: ${err?.message || err}`);
    });
  }

  async getCabinetConfig(): Promise<CabinetConfig> {
    log.debug(`getCabinetConfig`);
    const config = await getSetting<CabinetConfig>("system.people.cabinet-config");
    if (!config || !config.levels) {
      log.debug(`getCabinetConfig — no config found, creating defaults`);
      await setSetting("system.people.cabinet-config", DEFAULT_CABINET_CONFIG);
      return DEFAULT_CABINET_CONFIG;
    }

    const tribeLevel = config.levels.find(l => l.id === "tribe");
    if (tribeLevel) {
      tribeLevel.id = "community";
      tribeLevel.name = "Community";
    }
    const validIds = new Set(DEFAULT_CABINET_CONFIG.levels.map(l => l.id));
    config.levels = config.levels.filter(l => validIds.has(l.id));
    const defaultOrderMap = new Map(DEFAULT_CABINET_CONFIG.levels.map(l => [l.id, l.order]));
    const existingIds = new Set(config.levels.map(l => l.id));
    let needsWrite = false;
    const newLevels = DEFAULT_CABINET_CONFIG.levels.filter(l => !existingIds.has(l.id));
    if (newLevels.length > 0) {
      config.levels.push(...newLevels);
      needsWrite = true;
    }
    for (const level of config.levels) {
      const canonical = defaultOrderMap.get(level.id);
      if (canonical !== undefined && level.order !== canonical) {
        level.order = canonical;
        needsWrite = true;
      }
    }
    if (needsWrite) {
      config.levels.sort((a, b) => a.order - b.order);
      await this.saveCabinetConfig(config);
    }
    return config;
  }

  async saveCabinetConfig(config: CabinetConfig): Promise<void> {
    log.debug(`saveCabinetConfig levels=${config.levels.length}`);
    await setSetting("system.people.cabinet-config", config);
  }

  async listPeople(): Promise<PersonIndexEntry[]> {
    return this._listCache.getOrFetch(`all:${principalCacheKey()}`, async () => {
      const principal = getCurrentPrincipalOrSystem();
      const rows = await db.select().from(persons).where(visiblePersonPredicate(principal));
      const people = await this.hydratePersonRows(rows);
      const entries = people.map(person => this.toIndexEntry(person));
      log.debug(`listPeople count=${entries.length}`);
      return entries;
    });
  }

  private async resolvePersonAlias(id: string): Promise<string> {
    return this.resolvePersonAliasFromGraph(id, await this.getAliasGraph());
  }

  async getPerson(id: string): Promise<Person | null> {
    const resolvedId = await this.resolvePersonAlias(id);
    const principal = getCurrentPrincipalOrSystem();
    const rows = await db.select().from(persons).where(
      visiblePersonPredicate(principal, eq(persons.id, resolvedId)),
    );
    if (rows.length === 0) {
      log.debug(`getPerson id=${id} resolvedId=${resolvedId} — not found`);
      return null;
    }
    const [person] = await this.hydratePersonRows(rows);
    log.debug(`getPerson id=${id} resolvedId=${resolvedId} name=${person.name}`);
    return person;
  }

  async getPeopleByIds(ids: string[]): Promise<Person[]> {
    if (ids.length === 0) return [];
    const principal = getCurrentPrincipalOrSystem();
    const aliasBySource = await this.getAliasGraph();
    const resolvedIds = ids.map(id => this.resolvePersonAliasFromGraph(id, aliasBySource));
    const uniqueIds = [...new Set(resolvedIds)];
    log.debug(`getPeopleByIds count=${ids.length} unique=${uniqueIds.length} aliases=${aliasBySource.size}`);
    const rows = await db.select().from(persons).where(
      visiblePersonPredicate(principal, inArray(persons.id, uniqueIds)),
    );
    const people = await this.hydratePersonRows(rows);
    const byId = new Map(people.map(person => [person.id, person]));
    return resolvedIds
      .map(id => byId.get(id) ?? null)
      .filter((person): person is Person => person !== null);
  }

  async createPerson(data: Omit<Person, "id" | "createdAt" | "updatedAt">): Promise<Person> {
    log.debug(`createPerson name=${data.name} cabinet=${data.cabinetLevel}`);
    const now = new Date().toISOString();
    const person: Person = {
      id: generateId(),
      name: data.name,
      nicknames: data.nicknames || [],
      cabinetLevel: data.cabinetLevel,
      photo: data.photo,
      birthday: data.birthday,
      company: data.company,
      companyId: data.companyId,
      role: data.role,
      professionalRelations: data.professionalRelations || [],
      relation: data.relation,
      introducedBy: data.introducedBy,
      familiarity: data.familiarity,
      trust: data.trust,
      met: data.met,
      socialProfiles: data.socialProfiles || {},
      contactInfo: data.contactInfo || [],
      importantDates: data.importantDates || [],
      notes: data.notes || [],
      interactions: data.interactions || [],
      tags: data.tags || [],
      quickSummary: data.quickSummary,
      private: data.private ?? false,
      vaultIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.savePerson(person);
    try {
      await this.assignInitialVaultMembership(person.id);
    } catch (error) {
      await db.delete(persons).where(
        combineWithWritableScope(getCurrentPrincipalOrSystem(), personScopeColumns, eq(persons.id, person.id)),
      );
      throw error;
    }
    const created = await this.getPerson(person.id);
    if (!created) throw new Error(`Person ${person.id} was created without visible Vault membership`);
    log.debug(`createPerson created id=${person.id} name=${person.name}`);
    return created;
  }

  async updatePerson(id: string, updates: Partial<Person>): Promise<Person> {
    log.debug(`updatePerson id=${id} fields=${Object.keys(updates).join(",")}`);
    if (updates.vaultIds !== undefined) {
      throw new Error("Update Person Vaults through replaceVaultMemberships");
    }
    const person = await this.getPerson(id);
    if (!person) throw new Error(`Person ${id} not found`);
    const updated: Person = {
      ...person,
      ...updates,
      id: person.id,
      createdAt: person.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (updates.networkProfile || updates.relationshipProfile) {
      if (!updated.networkProfile) updated.networkProfile = {};
      updated.networkProfile.mobilization = computeMobilization(updated);
    }
    await this.savePerson(updated);
    return updated;
  }

  async renamePerson(input: { personId: string; newName: string; expectedCurrentName: string }): Promise<Person> {
    const personId = input.personId.trim();
    const newName = input.newName.trim();
    const expectedCurrentName = input.expectedCurrentName.trim();
    if (!personId) throw new Error("Person ID is required for rename");
    if (!newName) throw new Error("New name is required for rename");
    if (!expectedCurrentName) throw new Error("expectedCurrentName confirmation is required for rename");

    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    if (person.name !== expectedCurrentName) {
      throw new Error(
        `Rename confirmation mismatch: expected current name "${expectedCurrentName}" but person is named "${person.name}". Re-read the person and retry with the exact current name.`,
      );
    }
    if (person.name === newName) {
      throw new Error(`Person ${person.id} is already named "${newName}"`);
    }

    const previousName = person.name;
    const nicknames = [...(person.nicknames || [])];
    const newNameLower = newName.toLowerCase();
    const preservedNicknames = nicknames.filter(nick => nick.toLowerCase() !== newNameLower);
    if (previousName.toLowerCase() !== newNameLower && !preservedNicknames.some(nick => nick.toLowerCase() === previousName.toLowerCase())) {
      preservedNicknames.push(previousName);
    }

    const updated = await this.updatePerson(person.id, { name: newName, nicknames: preservedNicknames });

    await db.update(calendarEventPeople)
      .set({ personName: newName })
      .where(
        combineWithSensitiveWritable(
          calendarPeopleOwnerColumns,
          eq(calendarEventPeople.personId, person.id),
          getCurrentPrincipalOrSystem(),
        ),
      );

    this.invalidateListCache();
    log.info(`renamePerson id=${person.id} from="${previousName}" to="${newName}"`);
    return updated;
  }

  async mergePeople(input: MergePeopleInput): Promise<MergePeopleResult> {
    const normalizedInput = {
      sourcePersonId: input.sourcePersonId.trim(),
      targetPersonId: input.targetPersonId.trim(),
      expectedSourceName: input.expectedSourceName.trim(),
      expectedTargetName: input.expectedTargetName.trim(),
      reason: input.reason.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
    };
    if (!normalizedInput.sourcePersonId || !normalizedInput.targetPersonId) {
      throw new Error("Source and target Person IDs are required");
    }
    if (normalizedInput.sourcePersonId === normalizedInput.targetPersonId) {
      throw new Error("Source and target Person IDs must differ");
    }
    if (!normalizedInput.expectedSourceName || !normalizedInput.expectedTargetName) {
      throw new Error("Expected source and target names are required");
    }
    if (normalizedInput.reason.length < 8) {
      throw new Error("Merge reason must be at least 8 characters");
    }
    if (normalizedInput.idempotencyKey.length < 8) {
      throw new Error("Idempotency key must be at least 8 characters");
    }

    const result = await performPersonMerge(
      getCurrentPrincipalOrSystem(),
      normalizedInput,
      (targetRow, sourceRow) => {
        const merged = mergePersonValues(rowToPerson(targetRow), rowToPerson(sourceRow));
        merged.person.relationshipProfile = recomputeRelationshipProfile(merged.person);
        if (!merged.person.networkProfile) merged.person.networkProfile = {};
        merged.person.networkProfile.mobilization = computeMobilization(merged.person);
        return merged;
      },
    );
    this.invalidateListCache();
    this.invalidateAliasGraphCache();
    log.info(
      `mergePeople sourceId=${result.sourcePersonId} targetId=${result.targetPersonId} alreadyMerged=${result.alreadyMerged}`,
    );
    return result;
  }

  async deletePerson(id: string): Promise<void> {
    log.debug(`deletePerson id=${id}`);
    await db.delete(persons).where(
      writablePersonPredicate(getCurrentPrincipalOrSystem(), eq(persons.id, id)),
    );
    await db.delete(personEmailsTable).where(eq(personEmailsTable.personId, id));
    this.invalidateListCache();
  }

  async markViewed(id: string): Promise<void> {
    log.debug(`markViewed id=${id}`);
    const now = new Date();
    await db.update(persons)
      .set({ lastViewedAt: now })
      .where(writablePersonPredicate(getCurrentPrincipalOrSystem(), eq(persons.id, id)));
    this.invalidateListCache();
  }

  async searchPeople(query: string): Promise<PersonIndexEntry[]> {
    log.debug(`searchPeople query="${query}"`);
    const people = await this.listPeople();
    const q = query.toLowerCase().trim();

    if (q === "new") {
      return people.filter(p => {
        if (!p.createdAt || !p.updatedAt) return false;
        return Math.abs(new Date(p.createdAt).getTime() - new Date(p.updatedAt).getTime()) < 5000;
      });
    }

    // Tokenize query: each token must match at least one searchable field
    const tokens = q.split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) return [];

    return people.filter((p) => {
      const nameLower = p.name.toLowerCase();
      const companyLower = (p.company || "").toLowerCase();
      const roleLower = (p.role || "").toLowerCase();
      const nickLowers = (p.nicknames || []).map(n => n.toLowerCase());
      const tagLowers = (p.tags || []).map(t => t.toLowerCase());

      return tokens.every(token =>
        nameLower.includes(token) ||
        companyLower.includes(token) ||
        roleLower.includes(token) ||
        nickLowers.some(n => n.includes(token)) ||
        tagLowers.some(t => t.includes(token))
      );
    });
  }

  async addNote(personId: string, content: string, title?: string): Promise<Person> {
    log.debug(`addNote personId=${personId} title="${title || ""}"`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    const now = new Date().toISOString();
    person.notes.push({
      id: generateId(),
      title: title || "",
      content,
      createdAt: now,
      updatedAt: now,
    });
    person.updatedAt = now;
    await this.savePerson(person);
    return person;
  }

  async updateNote(personId: string, noteId: string, content: string, title?: string): Promise<Person> {
    log.debug(`updateNote personId=${personId} noteId=${noteId}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    const note = person.notes.find((n) => n.id === noteId);
    if (!note) throw new Error(`Note ${noteId} not found`);
    const now = new Date().toISOString();
    note.content = content;
    if (title !== undefined) note.title = title;
    note.updatedAt = now;
    person.updatedAt = now;
    await this.savePerson(person);
    return person;
  }

  async deleteNote(personId: string, noteId: string): Promise<Person> {
    log.debug(`deleteNote personId=${personId} noteId=${noteId}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    person.notes = person.notes.filter((n) => n.id !== noteId);
    person.updatedAt = new Date().toISOString();
    await this.savePerson(person);
    return person;
  }

  async addInteraction(personId: string, interaction: Omit<Interaction, "id">): Promise<Person> {
    log.debug(`addInteraction personId=${personId} type=${interaction.type} date=${interaction.date}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    // Direction, not channel, determines whether this contact satisfies an obligation.
    // Inbound email/text/call interactions can legitimately create responseOwed work.
    if (interaction.direction === "outbound") {
      for (const ix of person.interactions) {
        if (ix.responseOwed) {
          log.debug(`clearing responseOwed on interaction ${ix.id} for person ${personId} — new outbound ${interaction.type} contact logged`);
          ix.responseOwed = false;
          ix.responseDueBy = undefined;
        }
      }
    }

    // An outbound interaction cannot itself create a response obligation.
    if (interaction.direction === "outbound" && interaction.responseOwed) {
      log.warn(`addInteraction: stripping responseOwed=true from outbound ${interaction.type} for person ${personId}`);
      interaction = { ...interaction, responseOwed: false, responseDueBy: undefined };
    }

    const createdInteraction: Interaction = {
      id: generateId(),
      ...interaction,
    };
    person.interactions.push(createdInteraction);
    person.relationshipProfile = recomputeRelationshipProfile(person);
    if (!person.networkProfile) person.networkProfile = {};
    person.networkProfile.mobilization = computeMobilization(person);
    person.updatedAt = new Date().toISOString();
    await this.savePerson(person);
    return person;
  }

  async getInteraction(personId: string, interactionId: string): Promise<Interaction | null> {
    const person = await this.getPerson(personId);
    if (!person) return null;
    return person.interactions.find((interaction) => interaction.id === interactionId) ?? null;
  }

  async updateInteraction(personId: string, interactionId: string, updates: Partial<Interaction>): Promise<Person> {
    log.debug(`updateInteraction personId=${personId} interactionId=${interactionId}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    const interaction = person.interactions.find((i) => i.id === interactionId);
    if (!interaction) throw new Error(`Interaction ${interactionId} not found on person ${personId}`);
    if (updates.date !== undefined) interaction.date = updates.date;
    if (updates.summary !== undefined) interaction.summary = updates.summary;
    if (updates.context !== undefined) interaction.context = updates.context;
    if (updates.type !== undefined) interaction.type = updates.type;
    if (updates.direction !== undefined) interaction.direction = updates.direction;
    if (updates.meaningfulness !== undefined) interaction.meaningfulness = updates.meaningfulness;
    if (updates.responseOwed !== undefined) interaction.responseOwed = updates.responseOwed;
    if (updates.responseDueBy !== undefined) interaction.responseDueBy = updates.responseDueBy;
    if (updates.capitalImpact !== undefined) interaction.capitalImpact = updates.capitalImpact;
    if (updates.tags !== undefined) interaction.tags = updates.tags;
    person.relationshipProfile = recomputeRelationshipProfile(person);
    if (!person.networkProfile) person.networkProfile = {};
    person.networkProfile.mobilization = computeMobilization(person);
    person.updatedAt = new Date().toISOString();
    await this.savePerson(person);
    return person;
  }

  async deleteInteraction(personId: string, interactionId: string): Promise<Person> {
    log.debug(`deleteInteraction personId=${personId} interactionId=${interactionId}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    person.interactions = person.interactions.filter((i) => i.id !== interactionId);
    person.relationshipProfile = recomputeRelationshipProfile(person);
    if (!person.networkProfile) person.networkProfile = {};
    person.networkProfile.mobilization = computeMobilization(person);
    person.updatedAt = new Date().toISOString();
    await this.savePerson(person);
    return person;
  }

  async clearInteractions(personId: string): Promise<Person> {
    log.debug(`clearInteractions personId=${personId}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    person.interactions = [];
    person.relationshipProfile = recomputeRelationshipProfile(person);
    if (!person.networkProfile) person.networkProfile = {};
    person.networkProfile.mobilization = computeMobilization(person);
    person.updatedAt = new Date().toISOString();
    await this.savePerson(person);
    return person;
  }

  async addDate(personId: string, date: Omit<ImportantDate, "id">): Promise<Person> {
    log.debug(`addDate personId=${personId} label="${date.label}" recurrence=${date.recurrence}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    person.importantDates.push({
      id: generateId(),
      ...date,
    });
    person.updatedAt = new Date().toISOString();
    await this.savePerson(person);
    return person;
  }

  async updateDate(personId: string, dateId: string, updates: Partial<ImportantDate>): Promise<Person> {
    log.debug(`updateDate personId=${personId} dateId=${dateId}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    const dateEntry = person.importantDates.find((d) => d.id === dateId);
    if (!dateEntry) throw new Error(`Date ${dateId} not found`);
    Object.assign(dateEntry, updates, { id: dateEntry.id });
    person.updatedAt = new Date().toISOString();
    await this.savePerson(person);
    return person;
  }

  async deleteDate(personId: string, dateId: string): Promise<Person> {
    log.debug(`deleteDate personId=${personId} dateId=${dateId}`);
    const person = await this.getPerson(personId);
    if (!person) throw new Error(`Person ${personId} not found`);
    person.importantDates = person.importantDates.filter((d) => d.id !== dateId);
    person.updatedAt = new Date().toISOString();
    await this.savePerson(person);
    return person;
  }

  async getTimeBudgets(): Promise<TimeBudgets> {
    log.debug(`getTimeBudgets`);
    const data = await getSetting<TimeBudgets>("system.people.time-budgets");
    if (!data) {
      const defaults: TimeBudgets = { weeklyGoals: {} };
      await setSetting("system.people.time-budgets", defaults);
      return defaults;
    }
    return data;
  }

  async saveTimeBudgets(budgets: TimeBudgets): Promise<void> {
    log.debug(`saveTimeBudgets`);
    await setSetting("system.people.time-budgets", budgets);
  }

  async getTrustConfig(): Promise<TrustConfig> {
    log.debug(`getTrustConfig`);
    const data = await getSetting<TrustConfig>("system.people.trust-config");
    if (!data) {
      await setSetting("system.people.trust-config", DEFAULT_TRUST_CONFIG);
      return DEFAULT_TRUST_CONFIG;
    }
    return data;
  }

  async saveTrustConfig(config: TrustConfig): Promise<void> {
    log.debug(`saveTrustConfig`);
    await setSetting("system.people.trust-config", config);
  }

  async getGmailSkipList(): Promise<{ email: string; name?: string; skippedAt: string }[]> {
    log.debug(`getGmailSkipList`);
    const data = await getSetting<{ list: { email: string; name?: string; skippedAt: string }[] }>("system.people.gmail-skip-list");
    if (!data) return [];
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data)) return data as any;
    return [];
  }

  async addToGmailSkipList(entries: { email: string; name?: string }[]): Promise<void> {
    log.debug(`addToGmailSkipList count=${entries.length}`);
    const list = await this.getGmailSkipList();
    const existing = new Set(list.map(e => e.email.toLowerCase()));
    const now = new Date().toISOString();
    for (const entry of entries) {
      if (!existing.has(entry.email.toLowerCase())) {
        list.push({ email: entry.email.toLowerCase(), name: entry.name, skippedAt: now });
        existing.add(entry.email.toLowerCase());
      }
    }
    await setSetting("system.people.gmail-skip-list", { list });
  }

  async removeFromGmailSkipList(emails: string[]): Promise<void> {
    log.debug(`removeFromGmailSkipList count=${emails.length}`);
    const list = await this.getGmailSkipList();
    const toRemove = new Set(emails.map(e => e.toLowerCase()));
    const filtered = list.filter(e => !toRemove.has(e.email.toLowerCase()));
    await setSetting("system.people.gmail-skip-list", { list: filtered });
  }

  async getIdentityContent(id: string): Promise<string | undefined> {
    log.debug(`getIdentityContent id=${id}`);
    const person = await this.getPerson(id);
    return person?.identityContent;
  }

  async updateIdentityContent(id: string, content: string): Promise<Person> {
    log.debug(`updateIdentityContent id=${id} length=${content.length}`);
    return this.updatePerson(id, { identityContent: content });
  }

  async migrateIdentityFromDocuments(): Promise<{ xyzMigrated: boolean; partnerMigrated: boolean }> {
    // Stub — identity data now lives on person records directly
    return { xyzMigrated: false, partnerMigrated: false };
  }

  async rebuildIndex(): Promise<void> {
  }

  async migrateAllPeople(): Promise<{ migrated: number; total: number }> {
    return { migrated: 0, total: 0 };
  }

  private toIndexEntry(person: Person): PersonIndexEntry {
    const sorted = [...person.interactions].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    return {
      id: person.id,
      name: person.name,
      nicknames: person.nicknames || [],
      cabinetLevel: person.cabinetLevel,
      company: person.company,
      companyId: person.companyId,
      role: person.role,
      tags: person.tags || [],
      lastInteractionDate: sorted[0]?.date,
      private: person.private,
      lastViewedAt: person.lastViewedAt,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
  }
}

export const peopleStorage = new PeopleStorage();
