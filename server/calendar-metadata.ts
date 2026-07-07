import { db } from "./db";
import {
  calendarEventMetadata,
  calendarEventTasks,
  calendarEventPeople,
  calendarEventArtifacts,
  type CalendarEventMetadata,
  type CalendarEventTask,
  type CalendarEventPerson,
  type CalendarEventArtifact,
} from "@shared/schema";
import { eq, inArray, and, sql, or } from "drizzle-orm";
import { createLogger } from "./log";
import { TTLCache } from "./utils/ttl-cache";
import { eventBus } from "./event-bus";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithSensitiveVisible, combineWithSensitiveWritable, sensitiveOwnershipValues } from "./sensitive-scope";

const log = createLogger("CalendarMetadata");

const _calendarCache = new TTLCache<any>("CalendarMetadata", Infinity);
const calendarMetadataOwnerColumns = { ownerUserId: calendarEventMetadata.ownerUserId, principalAccountId: calendarEventMetadata.principalAccountId };
const calendarTaskOwnerColumns = { ownerUserId: calendarEventTasks.ownerUserId, principalAccountId: calendarEventTasks.principalAccountId };
const calendarPeopleOwnerColumns = { ownerUserId: calendarEventPeople.ownerUserId, principalAccountId: calendarEventPeople.principalAccountId };
const calendarArtifactOwnerColumns = { ownerUserId: calendarEventArtifacts.ownerUserId, principalAccountId: calendarEventArtifacts.principalAccountId };
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
    const conditions = events.map(e =>
      and(
        eq(calendarEventMetadata.googleEventId, e.googleEventId),
        eq(calendarEventMetadata.accountId, e.accountId),
        eq(calendarEventMetadata.calendarId, e.calendarId)
      )
    );

    const combined = conditions.length === 1 ? conditions[0]! : or(...conditions.map(c => c!));
    return db.select().from(calendarEventMetadata).where(combineWithSensitiveVisible(calendarMetadataOwnerColumns, combined));
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
  capacityType?: CapacityType | null
): Promise<CalendarEventMetadata> {
  log.log(`setMetadata event=${googleEventId} type=${eventType}`);
  const existing = await getMetadata(googleEventId, accountId, calendarId);
  const hasNotesPatch = notes !== undefined;
  const hasCapacityPatch = capacityType !== undefined;
  const storedCapacityType = eventType === "focus_block"
    ? (hasCapacityPatch ? capacityType ?? null : existing?.capacityType ?? null)
    : null;
  const storedNotes = hasNotesPatch ? notes ?? null : existing?.notes ?? null;

  const rows = await db
    .insert(calendarEventMetadata)
    .values({ googleEventId, accountId, calendarId, eventType, capacityType: storedCapacityType, notes: storedNotes, ...sensitiveOwnershipValues() })
    .onConflictDoUpdate({
      target: [calendarEventMetadata.googleEventId, calendarEventMetadata.accountId, calendarEventMetadata.calendarId],
      set: {
        eventType,
        capacityType: storedCapacityType,
        ...(hasNotesPatch ? { notes: storedNotes } : {}),
        updatedAt: sql`CURRENT_TIMESTAMP`,
        ...sensitiveOwnershipValues(),
      },
    })
    .returning();

  const meta = rows[0];

  if (attendeeEmails && attendeeEmails.length > 0) {
    await autoLinkPeople(meta.id, attendeeEmails);
  }

  invalidateCalendarCache();
  return meta;
}

// ─── linkTask ───

export async function linkTask(
  metadataId: number,
  taskId?: number,
  priorityTitle?: string,
  taskTitle?: string,
  estimateHours?: number
): Promise<CalendarEventTask> {
  log.log(`linkTask metadataId=${metadataId} taskId=${taskId} priorityTitle=${priorityTitle}`);
  const rows = await db
    .insert(calendarEventTasks)
    .values({
      metadataId,
      taskId: taskId ?? null,
      priorityTitle: priorityTitle ?? null,
      taskTitle: taskTitle ?? null,
      estimateHours: estimateHours ?? null,
      ...sensitiveOwnershipValues(),
    })
    .onConflictDoUpdate({
      target: taskId != null
        ? [calendarEventTasks.metadataId, calendarEventTasks.taskId]
        : [calendarEventTasks.metadataId, calendarEventTasks.priorityTitle],
      set: {
        taskTitle: taskTitle ?? null,
        estimateHours: estimateHours ?? null,
        ...sensitiveOwnershipValues(),
      },
    })
    .returning();
  invalidateCalendarCache();
  return rows[0];
}

// ─── getLinkedTaskById ───

export async function getLinkedTaskById(linkId: number): Promise<CalendarEventTask | null> {
  const rows = await db.select().from(calendarEventTasks).where(combineWithSensitiveVisible(calendarTaskOwnerColumns, eq(calendarEventTasks.id, linkId))).limit(1);
  return rows[0] ?? null;
}

// ─── unlinkTask ───

export async function unlinkTask(linkId: number): Promise<void> {
  log.log(`unlinkTask linkId=${linkId}`);
  await db.delete(calendarEventTasks).where(combineWithSensitiveWritable(calendarTaskOwnerColumns, eq(calendarEventTasks.id, linkId)));
  invalidateCalendarCache();
}

// ─── getLinkedTasks ───

export async function getLinkedTasks(metadataId: number): Promise<CalendarEventTask[]> {
  return _calendarCache.getOrFetch(`linkedTasks:${principalCacheKey()}:${metadataId}`, async () => {
    return db.select().from(calendarEventTasks).where(combineWithSensitiveVisible(calendarTaskOwnerColumns, eq(calendarEventTasks.metadataId, metadataId)));
  });
}

// ─── getLinkedTasksByMetadataIds (bulk) ───

export async function getLinkedTasksByMetadataIds(metadataIds: number[]): Promise<CalendarEventTask[]> {
  if (metadataIds.length === 0) return [];
  return db.select().from(calendarEventTasks).where(combineWithSensitiveVisible(calendarTaskOwnerColumns, inArray(calendarEventTasks.metadataId, metadataIds)));
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
        .values({ metadataId, personId: person.id, personName: person.name, attendeeEmail: matchedEmail, ...sensitiveOwnershipValues() })
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
