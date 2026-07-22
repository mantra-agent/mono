// Use createLogger for logging ONLY
import { type Express } from "express";
import { z } from "zod";
import { listGmailAccounts } from "./gmail";
import {
  hasCalendarAccess,
  listCalendars, listEvents, listAllEvents, getEvent, createEvent, updateEvent, deleteEvent,
  isHighPrepEvent, type CalendarEvent
} from "./google-calendar";
import { getTimezone, getDateInTimezone } from "./timezone";
import { PeopleStorage, peopleStorage } from "./people-storage";
import { createLogger } from "./log";
import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, runWithDatabaseTransaction } from "./db";
import { libraryPages } from "@shared/models/info";
import { eq } from "drizzle-orm";
import {
  getMetadata, setMetadata, getLinkedPeople, linkArtifact, unlinkArtifact, getLinkedArtifacts,
  autoLogMeetingInteractions, EVENT_TYPES, CAPACITY_TYPES, type EventType, type CapacityType,
  setAgentJoin, setMeetingAgendaPage, linkMeetingPerson,
} from "./calendar-metadata";
import { extractMeetingUrl } from "./meeting/join";
import { getMeetingJoinPolicy, shouldJoinMeeting } from "./meeting/join-policy";
import { getBandwidthSummary } from "./calendar-bandwidth";
import { buildEmailPersonContextMap, resolveMeetingArtifactContext, resolveMeetingPeopleContext } from "./meeting-context";
import { MEETING_JOIN_MODES, type MeetingJoinMode } from "@shared/schema";
import { formatMeetingInviteeName } from "@shared/meeting-feed-items";
import { getCurrentPrincipalOrSystem } from "./principal-context";

const log = createLogger("CalendarRoutes");

const createEventSchema = z.object({
  calendarId: z.string().min(1),
  accountId: z.string().min(1),
  event: z.object({
    summary: z.string().min(1),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.object({
      dateTime: z.string().optional(),
      date: z.string().optional(),
      timeZone: z.string().optional(),
    }),
    end: z.object({
      dateTime: z.string().optional(),
      date: z.string().optional(),
      timeZone: z.string().optional(),
    }),
    attendees: z.array(z.object({
      email: z.string(),
      displayName: z.string().optional(),
    })).optional(),
    reminders: z.object({
      useDefault: z.boolean(),
      overrides: z.array(z.object({
        method: z.string(),
        minutes: z.number(),
      })).optional(),
    }).optional(),
    recurrence: z.array(z.string()).optional(),
  }),
});

const updateEventSchema = z.object({
  calendarId: z.string().min(1),
  accountId: z.string().min(1),
  event: z.object({
    summary: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    start: z.object({
      dateTime: z.string().optional(),
      date: z.string().optional(),
      timeZone: z.string().optional(),
    }).optional(),
    end: z.object({
      dateTime: z.string().optional(),
      date: z.string().optional(),
      timeZone: z.string().optional(),
    }).optional(),
    attendees: z.array(z.object({
      email: z.string(),
      displayName: z.string().optional(),
    })).optional(),
    reminders: z.object({
      useDefault: z.boolean(),
      overrides: z.array(z.object({
        method: z.string(),
        minutes: z.number(),
      })).optional(),
    }).optional(),
    recurrence: z.array(z.string()).optional(),
  }),
});

export function registerCalendarRoutes(app: Express): void {

  app.get("/api/calendar/accounts", async (_req, res) => {
    try {
      const gmailAccounts = await listGmailAccounts();
      const accounts = await Promise.all(
        gmailAccounts.map(async (account) => ({
          id: account.id,
          email: account.email,
          label: account.label,
          hasCalendarAccess: await hasCalendarAccess(account.id),
        }))
      );
      res.json({ accounts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/calendars", async (_req, res) => {
    try {
      const gmailAccounts = await listGmailAccounts();
      const allCalendars: any[] = [];
      for (const account of gmailAccounts) {
        const hasAccess = await hasCalendarAccess(account.id);
        if (!hasAccess) continue;
        try {
          const calendars = await listCalendars(account.id);
          for (const cal of calendars) {
            allCalendars.push({
              id: cal.id,
              accountId: account.id,
              accountEmail: account.email,
              summary: cal.summary,
              description: cal.description,
              backgroundColor: cal.backgroundColor,
              primary: cal.primary || false,
              accessRole: cal.accessRole,
            });
          }
        } catch (err) { log.warn("list calendars for account failed", err); }
      }
      res.json({ calendars: allCalendars });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/events", async (req, res) => {
    try {
      const tz = getTimezone();
      const today = getDateInTimezone(tz);
      const timeMin = (req.query.timeMin as string) || `${today}T00:00:00`;
      const timeMax = (req.query.timeMax as string) || `${today}T23:59:59`;
      const calendarId = req.query.calendarId as string | undefined;
      const accountId = req.query.accountId as string | undefined;
      const maxResults = req.query.maxResults ? parseInt(req.query.maxResults as string, 10) : 100;

      let events: CalendarEvent[];

      if (accountId) {
        events = await listEvents(accountId, { calendarId, timeMin, timeMax, maxResults });
      } else if (calendarId) {
        const gmailAccounts = await listGmailAccounts();
        events = [];
        for (const account of gmailAccounts) {
          const hasAccess = await hasCalendarAccess(account.id);
          if (!hasAccess) continue;
          try {
            const acctEvents = await listEvents(account.id, { calendarId, timeMin, timeMax, maxResults });
            events.push(...acctEvents);
          } catch (err) { log.warn("list events for account failed", err); }
        }
      } else {
        const result = await listAllEvents({ timeMin, timeMax, maxResults });
        events = result.events;
        if (result.errors.length > 0) {
          return res.json({ events, errors: result.errors });
        }
      }

      res.json({ events });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/bandwidth", async (req, res) => {
    try {
      const timeMin = req.query.timeMin as string | undefined;
      const timeMax = req.query.timeMax as string | undefined;
      if (!timeMin || !timeMax) {
        return res.status(400).json({ error: "timeMin and timeMax query params are required" });
      }
      const maxResults = req.query.maxResults ? parseInt(req.query.maxResults as string, 10) : undefined;
      const summary = await getBandwidthSummary({ timeMin, timeMax, maxResults });
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/events/:eventId", async (req, res) => {
    try {
      const calendarId = req.query.calendarId as string;
      const accountId = req.query.accountId as string;
      if (!calendarId || !accountId) {
        return res.status(400).json({ error: "calendarId and accountId query params are required" });
      }
      const event = await getEvent(accountId, calendarId, req.params.eventId);
      res.json(event);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const promoteAttendeeSchema = z.object({
    accountId: z.string().min(1),
    calendarId: z.string().min(1),
    email: z.string().email(),
  });

  app.post("/api/calendar/events/:eventId/attendees/promote", async (req, res) => {
    try {
      const parsed = promoteAttendeeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid attendee promotion" });
      }
      const { accountId, calendarId } = parsed.data;
      const email = parsed.data.email.trim().toLowerCase();
      const event = await getEvent(accountId, calendarId, req.params.eventId);
      const attendee = event.attendees.find(candidate => !candidate.self && candidate.email.trim().toLowerCase() === email);
      if (!attendee) {
        return res.status(404).json({ error: "That email is not an external attendee on this event" });
      }
      const inviteeName = formatMeetingInviteeName(attendee.displayName, attendee.email);
      const principal = getCurrentPrincipalOrSystem();
      if (!principal.accountId) {
        return res.status(401).json({ error: "Authenticated account is required" });
      }

      const person = await db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.CALENDAR_ATTENDEE_PROMOTION,
          `${principal.accountId}:${email}`,
        );
        const existing = (await buildEmailPersonContextMap()).get(email);
        const resolved = existing
          ? await peopleStorage.getPerson(existing.id)
          : await peopleStorage.createPerson({
              name: inviteeName,
              cabinetLevel: "community",
              nicknames: [],
              professionalRelations: [],
              socialProfiles: {},
              contactInfo: [{ type: "email", label: "Email", value: email }],
              importantDates: [],
              notes: [],
              interactions: [],
              tags: ["calendar-invitee"],
              private: false,
            });
        if (!resolved) throw new Error("Unable to resolve attendee profile");
        await acquireAdvisoryTransactionLock(
          tx,
          ADVISORY_LOCK_NS.CALENDAR_ATTENDEE_PROMOTION,
          `${principal.accountId}:person:${resolved.id}`,
        );

        const metadata = await getMetadata(event.id, accountId, calendarId)
          ?? await setMetadata(event.id, accountId, calendarId, "meeting", undefined, [email]);
        await linkMeetingPerson(metadata.id, { id: resolved.id, name: resolved.name }, email);
        return resolved;
      }));

      const context = (await buildEmailPersonContextMap()).get(email);
      log.info(`promoted calendar attendee event=${event.id} person=${person.id}`);
      return res.json({
        person: {
          id: person.id,
          name: person.name,
          profileSummary: context?.summary ?? null,
          lastInteractionContext: context?.lastInteractionContext ?? null,
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`POST /api/calendar/events/${req.params.eventId}/attendees/promote failed: ${message}`);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/calendar/events", async (req, res) => {
    try {
      const parsed = createEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const { calendarId, accountId, event: eventInput } = parsed.data;
      const created = await createEvent(accountId, calendarId, eventInput);
      res.json(created);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/calendar/events/:eventId", async (req, res) => {
    try {
      const parsed = updateEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const { calendarId, accountId, event: eventInput } = parsed.data;
      const updated = await updateEvent(accountId, calendarId, req.params.eventId, eventInput);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/calendar/events/:eventId", async (req, res) => {
    try {
      const calendarId = req.query.calendarId as string;
      const accountId = req.query.accountId as string;
      if (!calendarId || !accountId) {
        return res.status(400).json({ error: "calendarId and accountId query params are required" });
      }
      await deleteEvent(accountId, calendarId, req.params.eventId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/upcoming", async (_req, res) => {
    try {
      const tz = getTimezone();
      const now = new Date();
      const timeMin = now.toISOString();

      const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const fourWeeksLater = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);

      const upcomingResult = await listAllEvents({
        timeMin,
        timeMax: sevenDaysLater.toISOString(),
        maxResults: 250,
      });

      const fourWeekResult = await listAllEvents({
        timeMin: sevenDaysLater.toISOString(),
        timeMax: fourWeeksLater.toISOString(),
        maxResults: 250,
      });

      const highPrep = fourWeekResult.events.filter(isHighPrepEvent);
      const errors = [...upcomingResult.errors, ...fourWeekResult.errors];

      res.json({ upcoming: upcomingResult.events, highPrep, ...(errors.length > 0 ? { errors } : {}) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/calendar/sync", async (_req, res) => {
    try {
      const gmailAccounts = await listGmailAccounts();
      let accountCount = 0;
      for (const account of gmailAccounts) {
        const hasAccess = await hasCalendarAccess(account.id);
        if (hasAccess) accountCount++;
      }

      syncMeetingInteractions().catch(err =>
        log.error("People sync error:", err.message)
      );

      res.json({ synced: true, accountCount });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/prep-briefs", async (_req, res) => {
    try {
      const tz = getTimezone();
      const now = new Date();
      const twoWeeksOut = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const { events } = await listAllEvents({ timeMin: now.toISOString(), timeMax: twoWeeksOut.toISOString() });
      const prepEvents = events.filter(e => isHighPrepEvent(e));

      if (prepEvents.length === 0) {
        return res.json({ briefs: [] });
      }

      const peopleStorage = new PeopleStorage();
      const allPeople = await peopleStorage.listPeople();
      const emailToPerson = new Map<string, any>();
      for (const p of allPeople) {
        const person = p as any;
        if (person.email) emailToPerson.set(person.email.toLowerCase(), person);
        if (person.emails) {
          for (const e of person.emails) emailToPerson.set(e.toLowerCase(), person);
        }
      }

      const briefs = prepEvents.slice(0, 10).map(event => {
        const attendeeDetails = (event.attendees || [])
          .filter(a => !a.self)
          .map(a => {
            const person = emailToPerson.get(a.email?.toLowerCase() || "");
            if (person) {
              const lastInteraction = person.interactions?.length > 0
                ? person.interactions[person.interactions.length - 1]
                : null;
              return {
                email: a.email,
                name: a.displayName || person.name,
                personId: person.id,
                relationship: person.relation || person.cabinetLevel || null,
                summary: person.summary || null,
                lastInteraction: lastInteraction ? { date: lastInteraction.date, type: lastInteraction.type, summary: lastInteraction.summary } : null,
              };
            }
            return {
              email: a.email,
              name: a.displayName || null,
              personId: null,
              relationship: null,
              summary: null,
              lastInteraction: null,
            };
          });

        return {
          eventId: event.id,
          calendarId: event.calendarId,
          accountId: event.accountId,
          summary: event.summary,
          start: event.start,
          end: event.end,
          location: event.location,
          description: event.description,
          attendeeCount: (event.attendees || []).length,
          attendees: attendeeDetails,
          isHighPrep: true,
          daysUntil: Math.ceil((new Date(event.start?.dateTime || event.start?.date || "").getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
        };
      });

      res.json({ briefs });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/related", async (req, res) => {
    try {
      const query = (req.query.q as string || "").toLowerCase().trim();
      if (!query) return res.json({ events: [] });

      const now = new Date();
      const fourWeeksOut = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
      const fourWeeksBack = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);

      const [upcomingResult, pastResult] = await Promise.all([
        listAllEvents({ timeMin: now.toISOString(), timeMax: fourWeeksOut.toISOString() }),
        listAllEvents({ timeMin: fourWeeksBack.toISOString(), timeMax: now.toISOString() }),
      ]);

      const allEvents = [...pastResult.events, ...upcomingResult.events];
      const keywords = query.split(/\s+/).filter(k => k.length > 2);

      const matches = allEvents.filter(e => {
        const text = `${e.summary || ""} ${e.description || ""}`.toLowerCase();
        return keywords.some(k => text.includes(k));
      }).slice(0, 10);

      res.json({ events: matches });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/event-people/:eventId", async (req, res) => {
    try {
      const { calendarId, accountId } = req.query as Record<string, string>;
      if (!calendarId || !accountId) {
        return res.status(400).json({ error: "calendarId and accountId required" });
      }
      const event = await getEvent(accountId, calendarId, req.params.eventId);
      if (!event) return res.status(404).json({ error: "Event not found" });

      const peopleStorage = new PeopleStorage();
      const allPeople = await peopleStorage.listPeople();
      const matches: Array<{ attendeeEmail: string; attendeeName?: string; personId: string; personName: string }> = [];

      for (const attendee of event.attendees || []) {
        const match = allPeople.find((p: any) =>
          p.email?.toLowerCase() === attendee.email?.toLowerCase() ||
          p.emails?.some((e: string) => e.toLowerCase() === attendee.email?.toLowerCase())
        );
        if (match) {
          matches.push({
            attendeeEmail: attendee.email,
            attendeeName: attendee.displayName,
            personId: match.id,
            personName: match.name,
          });
        }
      }

      res.json({ matches });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/calendar/metadata/:eventId", async (req, res) => {
    try {
      const { accountId, calendarId } = req.query as Record<string, string>;
      if (!accountId || !calendarId) {
        return res.status(400).json({ error: "accountId and calendarId query params are required" });
      }
      const meta = await getMetadata(req.params.eventId, accountId, calendarId);
      if (!meta) return res.json({ metadata: null });
      const [linkedPeople, linkedArtifacts] = await Promise.all([
        getLinkedPeople(meta.id),
        getLinkedArtifacts(meta.id),
      ]);
      const [people, artifacts] = await Promise.all([
        resolveMeetingPeopleContext(linkedPeople),
        resolveMeetingArtifactContext(linkedArtifacts),
      ]);
      res.json({ metadata: meta, people, artifacts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const setMetadataSchema = z.object({
    googleEventId: z.string().min(1),
    accountId: z.string().min(1),
    calendarId: z.string().min(1),
    eventType: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
    capacityType: z.enum(CAPACITY_TYPES as [CapacityType, ...CapacityType[]]).nullable().optional(),
    notes: z.string().optional(),
    /** Legacy migration input. New agendas are Library pages. */
    agenda: z.string().max(20000).optional(),
    agendaLibraryPageId: z.string().min(1).optional(),
    attendeeEmails: z.array(z.string()).optional(),
    speakerPolicy: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("participant_streams") }),
      z.object({ mode: z.literal("shared_room") }),
      z.object({
        mode: z.literal("selected_shared_streams"),
        sharedStreams: z.array(z.object({
          selector: z.object({
            attendeeEmail: z.string().email().optional(),
            participantLabel: z.string().min(1).optional(),
          }).refine(selector => Boolean(selector.attendeeEmail || selector.participantLabel), "A shared stream selector is required"),
          expectedPersonIds: z.array(z.string().min(1)).optional(),
        })).min(1),
      }),
    ]).optional(),
  });

  app.post("/api/calendar/metadata", async (req, res) => {
    try {
      const parsed = setMetadataSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const { googleEventId, accountId, calendarId, eventType, notes, capacityType, agenda, agendaLibraryPageId, speakerPolicy } = parsed.data;
      let attendeeEmails = parsed.data.attendeeEmails;
      let eventEndTime: string | undefined;
      let eventDate: string | undefined;
      let eventSummary: string | undefined;

      if (!attendeeEmails || attendeeEmails.length === 0) {
        try {
          const calEvent = await getEvent(accountId, calendarId, googleEventId);
          eventEndTime = calEvent.end?.dateTime || calEvent.end?.date;
          eventDate = (calEvent.start?.dateTime || calEvent.start?.date || "").slice(0, 10);
          eventSummary = calEvent.summary || undefined;
          attendeeEmails = (calEvent.attendees || [])
            .filter((a: any) => a.email && !a.self)
            .map((a: any) => a.email as string);
        } catch (_) {
          attendeeEmails = [];
        }
      }

      const meta = await setMetadata(googleEventId, accountId, calendarId, eventType, notes, attendeeEmails, capacityType, undefined, speakerPolicy);
      if (agendaLibraryPageId || agenda !== undefined) {
        await setMeetingAgendaPage(meta, agendaLibraryPageId, agenda, eventSummary || "Meeting");
      }
      const [people, artifacts] = await Promise.all([getLinkedPeople(meta.id), getLinkedArtifacts(meta.id)]);

      // Auto-log meeting interactions for linked people when the event has ended
      let autoLoggedCount = 0;
      if (people.length > 0 && eventEndTime) {
        const hasEnded = new Date(eventEndTime) <= new Date();
        if (hasEnded) {
          const logDate = eventDate || new Date().toISOString().slice(0, 10);
          const logResults = await autoLogMeetingInteractions(people, eventSummary || "Meeting", logDate);
          autoLoggedCount = logResults.filter(r => r.logged).length;
        } else {
          log.debug(`set_metadata REST: skipping auto-log — event "${eventSummary}" has not ended yet (ends ${eventEndTime})`);
        }
      }

      res.json({ metadata: meta, people, artifacts, autoLoggedInteractions: autoLoggedCount });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const agentJoinSchema = z.object({
    googleEventId: z.string().min(1),
    accountId: z.string().min(1),
    calendarId: z.string().min(1),
    mode: z.enum(MEETING_JOIN_MODES).optional(),
    /** @deprecated Rolling-deploy compatibility for stale clients. */
    override: z.boolean().nullable().optional(),
  }).refine(input => input.mode !== undefined || input.override !== undefined, {
    message: "mode is required",
  });

  // Explicit per-event meeting participation mode. The scheduler materializes
  // the decision and the join path snapshots the speaking policy on session creation.
  app.post("/api/calendar/agent-join", async (req, res) => {
    try {
      const parsed = agentJoinSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const { googleEventId, accountId, calendarId, override } = parsed.data;
      const principal = req.principal;
      if (!principal?.userId) {
        return res.status(401).json({ error: "User session required" });
      }

      const event = await getEvent(accountId, calendarId, googleEventId);
      const policy = await getMeetingJoinPolicy(principal.userId);
      const mode: MeetingJoinMode = parsed.data.mode
        ?? (shouldJoinMeeting(event, policy, override) ? "join_and_talk" : "dont_join");
      const enabled = mode !== "dont_join";
      const startDateTime = event.start?.dateTime;
      if (enabled && !startDateTime) {
        return res.status(400).json({ error: "This event has no start time (all-day events can't be auto-joined)." });
      }
      const startAt = startDateTime ? new Date(startDateTime) : null;
      if (enabled && (!startAt || Number.isNaN(startAt.getTime()))) {
        return res.status(400).json({ error: "Could not parse the event start time." });
      }
      if (enabled && startAt && startAt.getTime() < Date.now() - 10 * 60_000) {
        return res.status(400).json({ error: "This event already started more than 10 minutes ago." });
      }

      const meetingUrl = extractMeetingUrl(
        event.location,
        event.description,
        event.summary,
        event.hangoutLink,
        event.conferenceEntryPoints?.join("\n"),
      );
      const meta = await setAgentJoin(googleEventId, accountId, calendarId, mode, {
        explicit: parsed.data.mode !== undefined || override !== null,
        status: enabled ? meetingUrl ? "scheduled" : "no_link" : null,
        detail: enabled && !meetingUrl ? "No Zoom or Google Meet link found on this event" : null,
        sessionId: enabled ? undefined : null,
        startAt: enabled ? startAt! : null,
        attemptedAt: enabled ? null : undefined,
      });
      res.json({ metadata: meta, policy });
    } catch (error: any) {
      log.error(`agent-join toggle failed: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  const linkArtifactSchema = z.object({
    libraryPageId: z.string().min(1),
    artifactKind: z.string().optional(),
    title: z.string().optional(),
    source: z.string().optional(),
  });

  app.post("/api/calendar/metadata/:metadataId/artifacts", async (req, res) => {
    try {
      const metadataId = parseInt(req.params.metadataId, 10);
      if (isNaN(metadataId)) return res.status(400).json({ error: "Invalid metadataId" });
      const parsed = linkArtifactSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const { libraryPageId, artifactKind, title, source } = parsed.data;
      const page = (await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(eq(libraryPages.id, libraryPageId)).limit(1))[0]
        || (await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(eq(libraryPages.slug, libraryPageId)).limit(1))[0];
      if (!page) return res.status(404).json({ error: `Library page not found: ${libraryPageId}` });
      const link = await linkArtifact(metadataId, page.id, artifactKind || "brief", title || page.title, source || "calendar_rest");
      res.json({ link });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/calendar/metadata/artifacts/:linkId", async (req, res) => {
    try {
      const linkId = parseInt(req.params.linkId, 10);
      if (isNaN(linkId)) return res.status(400).json({ error: "Invalid linkId" });
      await unlinkArtifact(linkId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

}

async function syncMeetingInteractions() {
  try {
    const peopleStorage = new PeopleStorage();
    const allPeople = await peopleStorage.listPeople();
    if (allPeople.length === 0) return;

    const emailToPerson = new Map<string, { id: string; name: string }>();
    for (const p of allPeople) {
      const person = p as any;
      if (person.email) emailToPerson.set(person.email.toLowerCase(), { id: p.id, name: p.name });
      if (person.emails) {
        for (const e of person.emails) emailToPerson.set(e.toLowerCase(), { id: p.id, name: p.name });
      }
    }

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const { events: recentEvents } = await listAllEvents({ timeMin: yesterday.toISOString(), timeMax: now.toISOString() });

    const pastEvents = recentEvents.filter(e => {
      const endTime = e.end?.dateTime || e.end?.date;
      return endTime && new Date(endTime).getTime() <= now.getTime();
    });

    for (const event of pastEvents.slice(0, 20)) {
      for (const attendee of event.attendees || []) {
        if (attendee.self) continue;
        const person = emailToPerson.get(attendee.email?.toLowerCase() || "");
        if (!person) continue;

        const existingPerson = await peopleStorage.getPerson(person.id);
        if (!existingPerson) continue;

        const eventDate = (event.start?.dateTime || event.start?.date || "").slice(0, 10);
        const alreadyLogged = existingPerson.interactions.some(
          i => i.type === "meeting" && i.date === eventDate && i.summary.includes(event.summary || "")
        );
        if (alreadyLogged) continue;

        await peopleStorage.addInteraction(person.id, {
          date: eventDate,
          type: "meeting",
          summary: event.summary || "(untitled meeting)",
          context: `Calendar event with ${(event.attendees || []).length} attendees`,
        });
      }
    }
  } catch (err: any) {
    log.error("Meeting interaction sync error:", err.message);
  }
}
