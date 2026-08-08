import { and, eq } from "drizzle-orm";
import { meetingDrafts, type MeetingDraft } from "@shared/schema";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, runWithDatabaseTransaction } from "./db";
import type { Principal } from "./principal";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { createLogger } from "./log";
import { createEvent, type CalendarEventInput } from "./google-calendar";

const log = createLogger("MeetingDraftStorage");
const scopeColumns = { scope: meetingDrafts.scope, ownerUserId: meetingDrafts.ownerUserId, accountId: meetingDrafts.accountId };

export interface CreateMeetingDraftInput {
  sessionId?: string;
  googleAccountId?: string;
  calendarId?: string;
  summary: string;
  start: string;
  end?: string;
  timeZone: string;
  attendees?: string[];
  location?: string;
  description?: string;
  visibility?: "default" | "public" | "private" | "confidential";
}

export type UpdateMeetingDraftInput = Partial<Omit<CreateMeetingDraftInput, "sessionId">>;

function eventInput(draft: MeetingDraft): CalendarEventInput & { visibility?: string } {
  return {
    summary: draft.summary,
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.location ? { location: draft.location } : {}),
    start: { dateTime: draft.startAt, timeZone: draft.timeZone },
    end: { dateTime: draft.endAt!, timeZone: draft.timeZone },
    ...(draft.attendees.length ? { attendees: draft.attendees.map(email => ({ email })) } : {}),
    ...(draft.visibility && draft.visibility !== "default" ? { visibility: draft.visibility } : {}),
  };
}

export class MeetingDraftStorage {
  async create(principal: Principal, input: CreateMeetingDraftInput): Promise<MeetingDraft> {
    const [draft] = await db.insert(meetingDrafts).values({
      ...ownedInsertValues(principal, scopeColumns),
      createdByUserId: principal.userId ?? null,
      sessionId: input.sessionId ?? null,
      googleAccountId: input.googleAccountId ?? null,
      calendarId: input.calendarId ?? "primary",
      summary: input.summary,
      startAt: input.start,
      endAt: input.end ?? null,
      timeZone: input.timeZone,
      attendees: input.attendees ?? [],
      location: input.location ?? null,
      description: input.description ?? null,
      visibility: input.visibility ?? "default",
      status: "draft",
    }).returning();
    log.info("meeting draft created", { draftId: draft.id, sessionId: draft.sessionId, attendeeCount: draft.attendees.length });
    return draft;
  }

  async getById(principal: Principal, id: string): Promise<MeetingDraft | null> {
    const [draft] = await db.select().from(meetingDrafts)
      .where(combineWithVisibleScope(principal, scopeColumns, eq(meetingDrafts.id, id))).limit(1);
    return draft ?? null;
  }

  async update(principal: Principal, id: string, patch: UpdateMeetingDraftInput): Promise<MeetingDraft | null> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.googleAccountId !== undefined) values.googleAccountId = patch.googleAccountId;
    if (patch.calendarId !== undefined) values.calendarId = patch.calendarId;
    if (patch.summary !== undefined) values.summary = patch.summary;
    if (patch.start !== undefined) values.startAt = patch.start;
    if (patch.end !== undefined) values.endAt = patch.end;
    if (patch.timeZone !== undefined) values.timeZone = patch.timeZone;
    if (patch.attendees !== undefined) values.attendees = patch.attendees;
    if (patch.location !== undefined) values.location = patch.location;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.visibility !== undefined) values.visibility = patch.visibility;
    const [draft] = await db.update(meetingDrafts).set(values)
      .where(combineWithWritableScope(principal, scopeColumns, and(eq(meetingDrafts.id, id), eq(meetingDrafts.status, "draft")))).returning();
    return draft ?? null;
  }

  async discard(principal: Principal, id: string): Promise<MeetingDraft | null> {
    const [draft] = await db.update(meetingDrafts).set({ status: "discarded", updatedAt: new Date() })
      .where(combineWithWritableScope(principal, scopeColumns, and(eq(meetingDrafts.id, id), eq(meetingDrafts.status, "draft")))).returning();
    return draft ?? this.getById(principal, id);
  }

  async schedule(principal: Principal, id: string): Promise<MeetingDraft> {
    if (principal.actorType !== "user") throw Object.assign(new Error("Only an authenticated human can schedule a meeting draft"), { status: 403 });
    const claimed = await db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.EMAIL_DRAFT, `meeting:${id}`);
      const current = await this.getById(principal, id);
      if (!current) throw Object.assign(new Error("Meeting draft not found"), { status: 404 });
      if (current.status === "scheduled") return current;
      if (current.status !== "draft") throw Object.assign(new Error(`Cannot schedule a ${current.status} meeting draft`), { status: 409 });
      if (!current.googleAccountId) throw Object.assign(new Error("Choose a calendar account"), { status: 400 });
      if (!current.summary.trim() || !current.startAt || !current.endAt) throw Object.assign(new Error("Title, start, and end are required"), { status: 400 });
      if (Date.parse(current.endAt) <= Date.parse(current.startAt)) throw Object.assign(new Error("End must be after start"), { status: 400 });
      const [next] = await tx.update(meetingDrafts).set({ status: "scheduling", updatedAt: new Date() })
        .where(combineWithWritableScope(principal, scopeColumns, and(eq(meetingDrafts.id, id), eq(meetingDrafts.status, "draft")))).returning();
      if (!next) throw Object.assign(new Error("Meeting draft changed before approval"), { status: 409 });
      return next;
    }));
    if (claimed.status === "scheduled") return claimed;

    try {
      const event = await createEvent(claimed.googleAccountId!, claimed.calendarId, eventInput(claimed), { sendUpdates: claimed.attendees.length ? "all" : "none" });
      const [scheduled] = await db.update(meetingDrafts).set({ status: "scheduled", googleEventId: event.id, scheduledAt: new Date(), updatedAt: new Date() })
        .where(combineWithWritableScope(principal, scopeColumns, and(eq(meetingDrafts.id, id), eq(meetingDrafts.status, "scheduling")))).returning();
      if (!scheduled) throw new Error("Meeting was created but its draft could not be finalized");
      log.info("meeting draft scheduled", { draftId: id, eventId: event.id, attendeeCount: claimed.attendees.length });
      return scheduled;
    } catch (error) {
      await db.update(meetingDrafts).set({ status: "draft", updatedAt: new Date() })
        .where(combineWithWritableScope(principal, scopeColumns, and(eq(meetingDrafts.id, id), eq(meetingDrafts.status, "scheduling"))));
      throw error;
    }
  }
}

export const meetingDraftStorage = new MeetingDraftStorage();
