import { db } from "./db";
import {
  calendarEventMetadata,
  calendarEventPeople,
  calendarEventArtifacts,
  type CalendarEventMetadata,
  type CalendarEventPerson,
  type CalendarEventArtifact,
  type MeetingJoinMode,
} from "@shared/schema";
import { eq, inArray, and, sql, or, ne } from "drizzle-orm";
import { libraryPages } from "@shared/models/info";
import { createLogger } from "./log";
import { TTLCache } from "./utils/ttl-cache";
import { eventBus } from "./event-bus";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope } from "./scoped-storage";
import { combineWithSensitiveVisible, combineWithSensitiveWritable, sensitiveOwnershipValues } from "./sensitive-scope";
import { normalizeMeetingSpeakerPolicy, type MeetingSpeakerPolicy } from "@shared/models/chat";

const log = createLogger("CalendarMetadata");

const _calendarCache = new TTLCache<any>("CalendarMetadata", Infinity);
const calendarMetadataOwnerColumns = { ownerUserId: calendarEventMetadata.ownerUserId, principalAccountId: calendarEventMetadata.principalAccountId, vaultId: calendarEventMetadata.vaultId };
const calendarPeopleOwnerColumns = { ownerUserId: calendarEventPeople.ownerUserId, principalAccountId: calendarEventPeople.principalAccountId, vaultId: calendarEventPeople.vaultId };
const calendarArtifactOwnerColumns = { ownerUserId: calendarEventArtifacts.ownerUserId, principalAccountId: calendarEventArtifacts.principalAccountId, vaultId: calendarEventArtifacts.vaultId };
function principalCacheKey(): string {
  const principal = getCurrentPrincipalOrSystem();
  return `${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
}

function invalidateCalendarCache(): void {
  _calendarCache.invalidateAll();
  eventBus.publish({ category: "system", event: "data:calendar_changed", payload: { source: "calendar_metadata" } });
}

export const EVENT_TYPES = ["focus_block", "meeting", "travel"] as const;
export type EventType = typeof EVENT_TYPES[number];

export const CAPACITY_TYPES = ["deep_work", "responsive", "admin", "wellness", "personal", "creative", "flexible"] as const;
export type CapacityType = typeof CAPACITY_TYPES[number];

export interface EventIdentity {
  googleEventId: string;
  accountId: string;
  calendarId: string;
}

export function makeMetaKey(googleEventId: string, accountId: string, calendarId: string): string {
  return `${googleEventId}::${accountId}::${calendarId}`;
}

/**
 * Recurring-event instances carry per-occurrence Google IDs of the form
 * `${seriesMasterId}_${basetime}` (e.g. `abc123_20260714T110000Z`, all-day
 * `abc123_20260714`, or modified-series `abc123_R20260714T110000`).
 * Metadata is series-level: writes normalize to the master ID and reads fall
 * back to the master when no instance-specific row exists.
 * Returns null when the ID is not a recurring instance.
 */
export function resolveSeriesMasterId(googleEventId: string): string | null {
  const match = googleEventId.match(/^(.+)_(?:R\d{8}T\d{6}Z?|\d{8}(?:T\d{6}Z?)?)$/);
  return match ? match[1] : null;
}

async function fetchMetadataRow(
  googleEventId: string,
  accountId: string,
  calendarId: string
): Promise<CalendarEventMetadata | null> {
  const rows = await db
    .select()
    .from(calendarEventMetadata)
    .where(
      combineWithSensitiveVisible(calendarMetadataOwnerColumns, and(
        eq(calendarEventMetadata.googleEventId, googleEventId),
        eq(calendarEventMetadata.accountId, accountId),
        eq(calendarEventMetadata.calendarId, calendarId)
      ))
    )
    .limit(1);
  return rows[0] ?? null;
}

// ─── classifyEventByTitle ───

export function classifyEventByTitle(title: string): EventType | null {
  if (/focus\s*block|deep\s*work|focus\s*time|^focus\s*:/i.test(title)) return "focus_block";
  if (/flight|airport|travel|commute|drive|train|uber|lyft|taxi|transit/i.test(title)) return "travel";
  if (/1:1|one.on.one|sync|eos|standup|stand.up|check.in|all.hands|team\s+meeting|catch.up|review meeting/i.test(title)) return "meeting";
  return null;
}

// ─── getMetadata ───

export async function getMetadata(
  googleEventId: string,
  accountId: string,
  calendarId: string
): Promise<CalendarEventMetadata | null> {
  return _calendarCache.getOrFetch(`meta:${principalCacheKey()}:${googleEventId}:${accountId}:${calendarId}`, async () => {
    const exact = await fetchMetadataRow(googleEventId, accountId, calendarId);
    if (exact) return exact;
    const masterId = resolveSeriesMasterId(googleEventId);
    if (!masterId) return null;
    return fetchMetadataRow(masterId, accountId, calendarId);
  });
}

// ─── getMetadataByIds ───

export async function getMetadataByIds(ids: number[]): Promise<CalendarEventMetadata[]> {
  if (ids.length === 0) return [];
  const key = `byIds:${principalCacheKey()}:${ids.sort().join(",")}`;
  return _calendarCache.getOrFetch(key, async () => {
    return db.select().from(calendarEventMetadata).where(combineWithSensitiveVisible(calendarMetadataOwnerColumns, inArray(calendarEventMetadata.id, ids)));
  });
}

// ─── listMetadataByEvents — scoped by (googleEventId, accountId, calendarId) to prevent cross-account leakage ───

export async function listMetadataByEvents(
  events: EventIdentity[]
): Promise<CalendarEventMetadata[]> {
  if (events.length === 0) return [];

  const key = `byEvents:${principalCacheKey()}:${events.map(e => `${e.googleEventId}:${e.accountId}:${e.calendarId}`).sort().join("|")}`;
  return _calendarCache.getOrFetch(key, async () => {
    // Query both instance IDs and their recurring-series master IDs so
    // series-level metadata resolves for every occurrence.
    const identityConditions = new Map<string, ReturnType<typeof and>>();
    for (const e of events) {
      const ids = [e.googleEventId];
      const masterId = resolveSeriesMasterId(e.googleEventId);
      if (masterId) ids.push(masterId);
      for (const id of ids) {
        identityConditions.set(makeMetaKey(id, e.accountId, e.calendarId), and(
          eq(calendarEventMetadata.googleEventId, id),
          eq(calendarEventMetadata.accountId, e.accountId),
          eq(calendarEventMetadata.calendarId, e.calendarId)
        ));
      }
    }

    const conditions = Array.from(identityConditions.values());
    const combined = conditions.length === 1 ? conditions[0]! : or(...conditions.map(c => c!));
    const rows = await db.select().from(calendarEventMetadata).where(combineWithSensitiveVisible(calendarMetadataOwnerColumns, combined));
    const rowsByKey = new Map(rows.map(r => [makeMetaKey(r.googleEventId, r.accountId, r.calendarId), r]));

    // Resolve per requested event (instance row wins over master row) and
    // rekey master rows to the requested instance ID so callers can join by
    // the event identity they asked about.
    const resolved: CalendarEventMetadata[] = [];
    for (const e of events) {
      const exact = rowsByKey.get(makeMetaKey(e.googleEventId, e.accountId, e.calendarId));
      if (exact) {
        resolved.push(exact);
        continue;
      }
      const masterId = resolveSeriesMasterId(e.googleEventId);
      const master = masterId ? rowsByKey.get(makeMetaKey(masterId, e.accountId, e.calendarId)) : undefined;
      if (master) resolved.push({ ...master, googleEventId: e.googleEventId });
    }
    return resolved;
  });
}

// ─── setMetadata (upsert) ───

export async function setMetadata(
  googleEventId: string,
  accountId: string,
  calendarId: string,
  eventType: EventType,
  notes?: string,
  attendeeEmails?: string[],
  capacityType?: CapacityType | null,
  agenda?: string,
  speakerPolicy?: MeetingSpeakerPolicy,
): Promise<CalendarEventMetadata> {
  // Event type/notes/agenda are series-level: normalize recurring instance
  // IDs to the series master so metadata applies to every occurrence.
  googleEventId = resolveSeriesMasterId(googleEventId) ?? googleEventId;
  log.log(`setMetadata event=${googleEventId} type=${eventType}`);
  const existing = await getMetadata(googleEventId, accountId, calendarId);
  const hasNotesPatch = notes !== undefined;
  const hasCapacityPatch = capacityType !== undefined;
  const hasAgendaPatch = agenda !== undefined;
  const hasSpeakerPolicyPatch = speakerPolicy !== undefined;
  const storedCapacityType = eventType === "focus_block"
    ? (hasCapacityPatch ? capacityType ?? null : existing?.capacityType ?? null)
    : null;
  const storedNotes = hasNotesPatch ? notes ?? null : existing?.notes ?? null;
  const storedAgenda = hasAgendaPatch ? agenda ?? null : existing?.agenda ?? null;
  const storedSpeakerPolicy = hasSpeakerPolicyPatch
    ? normalizeMeetingSpeakerPolicy(speakerPolicy)
    : existing?.speakerPolicy ?? null;

  const rows = await db
    .insert(calendarEventMetadata)
    .values({
      googleEventId,
      accountId,
      calendarId,
      eventType,
      capacityType: storedCapacityType,
      notes: storedNotes,
      agenda: storedAgenda,
      speakerPolicy: storedSpeakerPolicy,
      createdAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
      ...sensitiveOwnershipValues(),
    })
    .onConflictDoUpdate({
      target: [calendarEventMetadata.googleEventId, calendarEventMetadata.accountId, calendarEventMetadata.calendarId],
      set: {
        eventType,
        capacityType: storedCapacityType,
        ...(hasNotesPatch ? { notes: storedNotes } : {}),
        ...(hasAgendaPatch ? { agenda: storedAgenda } : {}),
        ...(hasSpeakerPolicyPatch ? { speakerPolicy: storedSpeakerPolicy } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
        ...sensitiveOwnershipValues(),
      },
    })
    .returning();

  const meta = rows[0];

  // Propagate series-level fields to any existing instance-keyed rows for
  // this series (e.g. rows created before write normalization, or by
  // setAgentJoin) so they cannot shadow the master with stale values.
  // Google event IDs never contain underscores, so an escaped-underscore
  // prefix match addresses exactly this series' occurrence rows.
  await db
    .update(calendarEventMetadata)
    .set({
      eventType,
      capacityType: storedCapacityType,
      ...(hasNotesPatch ? { notes: storedNotes } : {}),
      ...(hasAgendaPatch ? { agenda: storedAgenda } : {}),
      ...(hasSpeakerPolicyPatch ? { speakerPolicy: storedSpeakerPolicy } : {}),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      combineWithSensitiveWritable(calendarMetadataOwnerColumns, and(
        sql`${calendarEventMetadata.googleEventId} LIKE ${`${googleEventId}\\_%`} ESCAPE '\\'`,
        eq(calendarEventMetadata.accountId, accountId),
        eq(calendarEventMetadata.calendarId, calendarId)
      ))
    );

  if (attendeeEmails && attendeeEmails.length > 0) {
    await autoLinkPeople(meta.id, attendeeEmails);
  }

  invalidateCalendarCache();
  return meta;
}

// ─── Agent join mode materialization ───

export type AgentJoinStatus = "scheduled" | "no_link" | "joined" | "failed";

export interface AgentJoinPatch {
  /** False only when the scheduler materializes an inherited user-wide policy. */
  explicit?: boolean;
  status?: AgentJoinStatus | null;
  detail?: string | null;
  sessionId?: string | null;
  startAt?: Date | null;
  attemptedAt?: Date | null;
}

/**
 * Materialize the explicit per-event join mode and its scheduler projection.
 * Rearms only when the start changes or the caller explicitly clears attemptedAt.
 */
export async function setAgentJoin(
  googleEventId: string,
  accountId: string,
  calendarId: string,
  mode: MeetingJoinMode,
  patch: AgentJoinPatch = {}
): Promise<CalendarEventMetadata> {
  const enabled = mode !== "dont_join";
  const legacyOverride = patch.explicit === false ? null : enabled;
  log.log(`setAgentJoin event=${googleEventId} mode=${mode} status=${patch.status ?? "-"}`);
  const existing = await getMetadata(googleEventId, accountId, calendarId);
  const nextStartAt = patch.startAt !== undefined ? patch.startAt : existing?.agentJoinStartAt ?? null;
  const startChanged = existing?.agentJoinStartAt?.getTime() !== nextStartAt?.getTime();
  const joinFields = {
    agentJoinMode: mode,
    agentJoinEnabled: enabled,
    agentJoinOverride: legacyOverride,
    agentJoinStatus: enabled ? patch.status ?? null : null,
    agentJoinDetail: enabled ? patch.detail ?? null : null,
    agentJoinSessionId: patch.sessionId !== undefined
      ? patch.sessionId
      : enabled && startChanged ? null : existing?.agentJoinSessionId ?? null,
    agentJoinStartAt: enabled ? nextStartAt : null,
    agentJoinAttemptedAt: enabled
      ? patch.attemptedAt !== undefined
        ? patch.attemptedAt
        : startChanged ? null : existing?.agentJoinAttemptedAt ?? null
      : null,
  };

  const rows = await db
    .insert(calendarEventMetadata)
    .values({
      googleEventId,
      accountId,
      calendarId,
      eventType: existing?.eventType ?? "meeting",
      capacityType: existing?.capacityType ?? null,
      notes: existing?.notes ?? null,
      agenda: existing?.agenda ?? null,
      speakerPolicy: existing?.speakerPolicy ?? null,
      ...joinFields,
      createdAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
      ...sensitiveOwnershipValues(),
    })
    .onConflictDoUpdate({
      target: [calendarEventMetadata.googleEventId, calendarEventMetadata.accountId, calendarEventMetadata.calendarId],
      set: {
        ...joinFields,
        updatedAt: sql`CURRENT_TIMESTAMP`,
        ...sensitiveOwnershipValues(),
      },
    })
    .returning();

  invalidateCalendarCache();
  return rows[0];
}

/** List enabled, unattempted auto-joins visible to the current owner principal. */
export async function listDueAgentJoins(now: Date, graceMs: number, leadMs: number): Promise<CalendarEventMetadata[]> {
  return db
    .select()
    .from(calendarEventMetadata)
    .where(combineWithSensitiveVisible(calendarMetadataOwnerColumns, and(
      eq(calendarEventMetadata.agentJoinEnabled, true),
      sql`${calendarEventMetadata.agentJoinAttemptedAt} IS NULL`,
      sql`${calendarEventMetadata.agentJoinStartAt} IS NOT NULL`,
      sql`${calendarEventMetadata.agentJoinStartAt} <= ${new Date(now.getTime() + leadMs)}`,
      sql`${calendarEventMetadata.agentJoinStartAt} >= ${new Date(now.getTime() - graceMs)}`,
    )));
}

/**
 * Atomically claim a due auto-join so overlapping scheduler ticks can't
 * double-dispatch a bot. Returns false if another tick already claimed it.
 */
export async function claimAgentJoin(metadataId: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(calendarEventMetadata)
    .set({ agentJoinAttemptedAt: now, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(combineWithSensitiveWritable(calendarMetadataOwnerColumns, and(
      eq(calendarEventMetadata.id, metadataId),
      eq(calendarEventMetadata.agentJoinEnabled, true),
      sql`${calendarEventMetadata.agentJoinAttemptedAt} IS NULL`,
    )))
    .returning({ id: calendarEventMetadata.id });
  return rows.length > 0;
}

/** Record the outcome of an auto-join attempt (or reschedule by clearing the claim). */
export async function updateAgentJoinOutcome(metadataId: number, patch: AgentJoinPatch): Promise<void> {
  await db
    .update(calendarEventMetadata)
    .set({
      ...(patch.status !== undefined ? { agentJoinStatus: patch.status } : {}),
      ...(patch.detail !== undefined ? { agentJoinDetail: patch.detail } : {}),
      ...(patch.sessionId !== undefined ? { agentJoinSessionId: patch.sessionId } : {}),
      ...(patch.startAt !== undefined ? { agentJoinStartAt: patch.startAt } : {}),
      ...(patch.attemptedAt !== undefined ? { agentJoinAttemptedAt: patch.attemptedAt } : {}),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(combineWithSensitiveWritable(
      calendarMetadataOwnerColumns,
      eq(calendarEventMetadata.id, metadataId),
    ));
  invalidateCalendarCache();
}

// ─── linkArtifact ───

export async function linkArtifact(
  metadataId: number,
  libraryPageId: string,
  artifactKind = "brief",
  title?: string,
  source?: string
): Promise<CalendarEventArtifact> {
  log.log(`linkArtifact metadataId=${metadataId} libraryPageId=${libraryPageId} kind=${artifactKind}`);
  const rows = await db
    .insert(calendarEventArtifacts)
    .values({
      metadataId,
      libraryPageId,
      artifactType: "library_page",
      artifactKind,
      title: title ?? null,
      source: source ?? null,
      createdAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
      ...sensitiveOwnershipValues(),
    })
    .onConflictDoUpdate({
      target: [calendarEventArtifacts.metadataId, calendarEventArtifacts.libraryPageId],
      set: {
        artifactKind,
        title: title ?? null,
        source: source ?? null,
        ...sensitiveOwnershipValues(),
      },
    })
    .returning();
  invalidateCalendarCache();
  return rows[0];
}

// ─── getLinkedArtifactById ───

export async function getLinkedArtifactById(linkId: number): Promise<CalendarEventArtifact | null> {
  const rows = await db.select().from(calendarEventArtifacts).where(combineWithSensitiveVisible(calendarArtifactOwnerColumns, eq(calendarEventArtifacts.id, linkId))).limit(1);
  return rows[0] ?? null;
}

// ─── unlinkArtifact ───

export async function unlinkArtifact(linkId: number): Promise<void> {
  log.log(`unlinkArtifact linkId=${linkId}`);
  await db.delete(calendarEventArtifacts).where(combineWithSensitiveWritable(calendarArtifactOwnerColumns, eq(calendarEventArtifacts.id, linkId)));
  invalidateCalendarCache();
}

// ─── getLinkedArtifacts ───

export async function getLinkedArtifacts(metadataId: number): Promise<CalendarEventArtifact[]> {
  return _calendarCache.getOrFetch(`linkedArtifacts:${principalCacheKey()}:${metadataId}`, async () => {
    return db.select().from(calendarEventArtifacts).where(combineWithSensitiveVisible(calendarArtifactOwnerColumns, eq(calendarEventArtifacts.metadataId, metadataId)));
  });
}

export interface MeetingAgendaPage {
  id: string;
  title: string;
  slug: string;
  plainTextContent: string;
}

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
};

export async function getVisibleLibraryPage(idOrSlug: string): Promise<MeetingAgendaPage | null> {
  const principal = getCurrentPrincipalOrSystem();
  const baseSelect = {
    id: libraryPages.id,
    title: libraryPages.title,
    slug: libraryPages.slug,
    plainTextContent: libraryPages.plainTextContent,
  };
  const [byId] = await db
    .select(baseSelect)
    .from(libraryPages)
    .where(combineWithVisibleScope(principal, libraryScopeColumns, eq(libraryPages.id, idOrSlug)))
    .limit(1);
  if (byId) return byId;
  const [bySlug] = await db
    .select(baseSelect)
    .from(libraryPages)
    .where(combineWithVisibleScope(principal, libraryScopeColumns, eq(libraryPages.slug, idOrSlug)))
    .limit(1);
  return bySlug ?? null;
}

export async function resolveMeetingAgendaPage(metadata: CalendarEventMetadata): Promise<MeetingAgendaPage | null> {
  const linkedAgenda = (await getLinkedArtifacts(metadata.id)).find(
    artifact => artifact.artifactKind === "agenda" && artifact.artifactType === "library_page",
  );
  if (!linkedAgenda) return null;
  return getVisibleLibraryPage(linkedAgenda.libraryPageId);
}

export async function setMeetingAgendaPage(
  metadata: CalendarEventMetadata,
  libraryPageIdOrSlug?: string,
  legacyAgenda?: string,
  meetingTitle = "Meeting",
): Promise<MeetingAgendaPage> {
  const existingAgendaPage = await resolveMeetingAgendaPage(metadata);
  if (libraryPageIdOrSlug) {
    const selectedPage = await getVisibleLibraryPage(libraryPageIdOrSlug);
    if (!selectedPage) throw new Error(`Library page not found: ${libraryPageIdOrSlug}`);
    await linkArtifact(metadata.id, selectedPage.id, "agenda", selectedPage.title, "meeting_agenda");
    await db.delete(calendarEventArtifacts).where(combineWithSensitiveWritable(calendarArtifactOwnerColumns, and(
      eq(calendarEventArtifacts.metadataId, metadata.id),
      eq(calendarEventArtifacts.artifactKind, "agenda"),
      ne(calendarEventArtifacts.libraryPageId, selectedPage.id),
    )));
    invalidateCalendarCache();
    return selectedPage;
  }
  if (existingAgendaPage) return existingAgendaPage;

  const { createFiledLibraryPage } = await import("./library-save");
  const created = await createFiledLibraryPage({
    title: `${meetingTitle.trim() || "Meeting"} Agenda`,
    markdown: legacyAgenda?.trim() || "",
    purpose: "meeting-notes",
    pageContext: "/calendar",
    contentSummary: `Private agenda for ${meetingTitle.trim() || "meeting"}`,
    tags: ["meeting-agenda"],
  });
  await linkArtifact(metadata.id, created.id, "agenda", created.title, "meeting_agenda");
  await db.delete(calendarEventArtifacts).where(combineWithSensitiveWritable(calendarArtifactOwnerColumns, and(
    eq(calendarEventArtifacts.metadataId, metadata.id),
    eq(calendarEventArtifacts.artifactKind, "agenda"),
    ne(calendarEventArtifacts.libraryPageId, created.id),
  )));
  invalidateCalendarCache();
  return {
    id: created.id,
    title: created.title,
    slug: created.slug,
    plainTextContent: created.plainTextContent,
  };
}

/** Resolve agenda text for model context and legacy consumers. The linked
 * Library page is authoritative; legacy metadata text is migration fallback. */
export async function resolveMeetingAgenda(metadata: CalendarEventMetadata): Promise<string | undefined> {
  const page = await resolveMeetingAgendaPage(metadata);
  if (page) return page.plainTextContent.trim() || undefined;

  const legacyAgenda = metadata.agenda?.trim();
  if (legacyAgenda) return legacyAgenda;

  const linkedBrief = (await getLinkedArtifacts(metadata.id)).find(
    artifact => artifact.artifactKind === "brief" && artifact.artifactType === "library_page",
  );
  if (!linkedBrief) return undefined;
  const brief = await getVisibleLibraryPage(linkedBrief.libraryPageId);
  return brief?.plainTextContent?.trim() || undefined;
}

// ─── getLinkedArtifactsByMetadataIds (bulk) ───

export async function getLinkedArtifactsByMetadataIds(metadataIds: number[]): Promise<CalendarEventArtifact[]> {
  if (metadataIds.length === 0) return [];
  return db.select().from(calendarEventArtifacts).where(combineWithSensitiveVisible(calendarArtifactOwnerColumns, inArray(calendarEventArtifacts.metadataId, metadataIds)));
}

// ─── autoLinkPeople ───
// Fetches full Person records (with contactInfo) to cross-reference attendee emails

export async function autoLinkPeople(metadataId: number, attendeeEmails: string[]): Promise<CalendarEventPerson[]> {
  log.log(`autoLinkPeople metadataId=${metadataId} emails=${attendeeEmails.length}`);
  const { PeopleStorage } = await import("./people-storage");
  const peopleStorage = new PeopleStorage();

  const indexEntries = await peopleStorage.listPeople();
  const personIds = indexEntries.map(p => p.id);
  const fullPeople = await peopleStorage.getPeopleByIds(personIds);

  const emailNorm = attendeeEmails.map(e => e.toLowerCase());
  const linked: CalendarEventPerson[] = [];

  for (const person of fullPeople) {
    const personEmails: string[] = person.contactInfo
      .filter(ci => ci.type === "email" && ci.value)
      .map(ci => ci.value.toLowerCase());

    const matchedEmail = personEmails.find(e => emailNorm.includes(e));
    if (!matchedEmail) continue;

    try {
      const rows = await db
        .insert(calendarEventPeople)
        .values({ metadataId, personId: person.id, personName: person.name, attendeeEmail: matchedEmail, createdAt: sql`CURRENT_TIMESTAMP`, updatedAt: sql`CURRENT_TIMESTAMP`, ...sensitiveOwnershipValues() })
        .onConflictDoNothing()
        .returning();
      if (rows[0]) linked.push(rows[0]);
    } catch (err: any) {
      log.warn(`autoLinkPeople skip person=${person.id}: ${err.message}`);
    }
  }

  if (linked.length > 0) invalidateCalendarCache();
  return linked;
}

// ─── autoLogMeetingInteractions ───
// After people are linked to a meeting, auto-log interactions with responseOwed: true.
// Cross-references opportunities to enrich the summary with opportunity context.

export async function autoLogMeetingInteractions(
  linkedPeople: CalendarEventPerson[],
  eventTitle: string,
  eventDate: string,
): Promise<{ personId: string; personName: string; logged: boolean; reason?: string }[]> {
  if (linkedPeople.length === 0) return [];
  log.info(`autoLogMeetingInteractions people=${linkedPeople.length} event="${eventTitle}" date=${eventDate}`);

  const { PeopleStorage } = await import("./people-storage");
  const peopleStorage = new PeopleStorage();
  const { opportunities } = await import("@shared/schema");
  const { or: drizzleOr, eq: drizzleEq, and: drizzleAnd } = await import("drizzle-orm");

  // Compute responseDueBy = eventDate + 3 days
  const dueDate = new Date(eventDate);
  dueDate.setDate(dueDate.getDate() + 3);
  const responseDueBy = dueDate.toISOString().slice(0, 10);

  const results: { personId: string; personName: string; logged: boolean; reason?: string }[] = [];

  for (const lp of linkedPeople) {
    try {
      // Dedup: check if this person already has a meeting interaction on this date
      const person = await peopleStorage.getPerson(lp.personId);
      if (!person) {
        results.push({ personId: lp.personId, personName: lp.personName, logged: false, reason: "person_not_found" });
        continue;
      }

      const alreadyLogged = person.interactions.some(
        (i) => i.type === "meeting" && i.date === eventDate && i.summary?.includes(eventTitle)
      );
      if (alreadyLogged) {
        results.push({ personId: lp.personId, personName: lp.personName, logged: false, reason: "already_logged" });
        continue;
      }

      // Cross-reference opportunities where this person is champion or contact
      let opportunityContext = "";
      try {
        const principal = getCurrentPrincipalOrSystem();
        if (!principal.userId) {
          log.warn(`autoLogMeetingInteractions: no userId on principal (actorType=${principal.actorType}), skipping opportunity cross-reference for person=${lp.personId}`);
        }
        const oppRows = principal.userId ? await db
          .select()
          .from(opportunities)
          .where(
            drizzleAnd(
              drizzleEq(opportunities.userId, principal.userId),
              drizzleOr(
                drizzleEq(opportunities.contactPersonId, lp.personId),
                drizzleEq(opportunities.championPersonId, lp.personId),
              ),
            )
          ) : [];
        const activeOpps = oppRows.filter((o) => !["passed", "lost"].includes(o.status));
        if (activeOpps.length > 0) {
          const oppNames = activeOpps.map((o) => o.title).join(", ");
          opportunityContext = ` [Active opportunity: ${oppNames}]`;
        }
      } catch (oppErr: any) {
        log.warn(`autoLogMeetingInteractions opp lookup failed for person=${lp.personId}: ${oppErr.message}`);
      }

      const summary = `Meeting: ${eventTitle}${opportunityContext}`;

      await peopleStorage.addInteraction(lp.personId, {
        date: eventDate,
        type: "meeting",
        summary,
        direction: "mutual",
        responseOwed: true,
        responseDueBy,
      });

      log.debug(`autoLogMeetingInteractions logged interaction for person=${lp.personName} (${lp.personId})`);
      results.push({ personId: lp.personId, personName: lp.personName, logged: true });
    } catch (err: any) {
      log.warn(`autoLogMeetingInteractions failed for person=${lp.personId}: ${err.message}`);
      results.push({ personId: lp.personId, personName: lp.personName, logged: false, reason: err.message });
    }
  }

  return results;
}

export async function linkMeetingPerson(
  metadataId: number,
  person: { id: string; name: string },
  attendeeEmail: string,
): Promise<CalendarEventPerson> {
  const rows = await db
    .insert(calendarEventPeople)
    .values({
      metadataId,
      personId: person.id,
      personName: person.name,
      attendeeEmail: attendeeEmail.toLowerCase(),
      createdAt: sql`CURRENT_TIMESTAMP`,
      ...sensitiveOwnershipValues(),
    })
    .onConflictDoUpdate({
      target: [calendarEventPeople.metadataId, calendarEventPeople.personId],
      set: {
        personName: person.name,
        attendeeEmail: attendeeEmail.toLowerCase(),
      },
    })
    .returning();
  invalidateCalendarCache();
  return rows[0];
}

// ─── getLinkedPeople ───

export async function getLinkedPeople(metadataId: number): Promise<CalendarEventPerson[]> {
  return _calendarCache.getOrFetch(`linkedPeople:${principalCacheKey()}:${metadataId}`, async () => {
    return db.select().from(calendarEventPeople).where(combineWithSensitiveVisible(calendarPeopleOwnerColumns, eq(calendarEventPeople.metadataId, metadataId)));
  });
}

// ─── getLinkedPeopleByMetadataIds (bulk) ───

export async function getLinkedPeopleByMetadataIds(metadataIds: number[]): Promise<CalendarEventPerson[]> {
  if (metadataIds.length === 0) return [];
  return db.select().from(calendarEventPeople).where(combineWithSensitiveVisible(calendarPeopleOwnerColumns, inArray(calendarEventPeople.metadataId, metadataIds)));
}
