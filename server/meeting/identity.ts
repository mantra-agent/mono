import {
  normalizeMeetingSpeakerPolicy,
  type MeetingParticipant,
  type MeetingResolutionSource,
  type MeetingSpeakerPolicy,
} from "@shared/models/chat";
import { getLinkedPeople, getMetadata, resolveMeetingAgenda, resolveMeetingAgendaPage, setMeetingAgendaPage, type MeetingAgendaPage } from "../calendar-metadata";
import { listAllEvents, type CalendarEvent } from "../google-calendar";
import { createLogger } from "../log";
import { peopleStorage, type Person } from "../people-storage";

const log = createLogger("MeetingIdentityResolver");
const LOOKBACK_MS = 12 * 60 * 60_000;
const LOOKAHEAD_MS = 8 * 60 * 60_000;
const MAX_EVENTS = 100;
import { extractMeetingUrl } from "./join";

export interface ExplicitMeetingEventIdentity {
  accountId: string;
  calendarId: string;
  providerEventId: string;
  eventStart?: string;
  eventEnd?: string;
  title?: string;
  agenda?: string;
  attendees?: CalendarEvent["attendees"];
  organizer?: CalendarEvent["organizer"];
  accountEmail?: string;
}

export interface ResolvedMeetingIdentity {
  meetingUrl: string;
  title: string;
  agenda?: string;
  agendaPage?: Pick<MeetingAgendaPage, "id" | "title" | "slug">;
  calendarAccountId?: string;
  calendarId?: string;
  providerEventId?: string;
  eventStart?: string;
  eventEnd?: string;
  resolutionSource: MeetingResolutionSource;
  participants: MeetingParticipant[];
  speakerPolicy: MeetingSpeakerPolicy;
}

export interface ResolveMeetingIdentityInput {
  meetingUrl: string;
  title?: string;
  agenda?: string;
  explicitEvent?: ExplicitMeetingEventIdentity;
  now?: Date;
}

export function normalizeMeetingUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let pathname = url.pathname.replace(/\/+$/, "");
    if (hostname === "meet.google.com") pathname = pathname.toLowerCase();
    return `${hostname}${pathname}${url.search}`;
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, "");
  }
}

export function meetingUrlForEvent(event: CalendarEvent): string | null {
  return extractMeetingUrl(
    event.location,
    event.description,
    event.summary,
    event.hangoutLink,
    event.conferenceEntryPoints?.join("\n"),
  );
}

function eventDateTime(value: CalendarEvent["start"] | CalendarEvent["end"]): string | undefined {
  return value.dateTime || value.date || undefined;
}

function normalizeEmail(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.includes("@") ? normalized : undefined;
}

function personByEmail(people: Person[]): Map<string, Person> {
  const result = new Map<string, Person>();
  for (const person of people) {
    for (const contact of person.contactInfo) {
      if (contact.type !== "email") continue;
      const email = normalizeEmail(contact.value);
      if (email && !result.has(email)) result.set(email, person);
    }
  }
  return result;
}

async function resolveEventParticipants(
  attendees: CalendarEvent["attendees"],
  organizer: CalendarEvent["organizer"] | undefined,
  accountEmail: string | undefined,
  metadataId?: number,
): Promise<MeetingParticipant[]> {
  const linkedPeople = metadataId ? await getLinkedPeople(metadataId) : [];
  const linksByEmail = new Map(
    linkedPeople
      .filter((link) => normalizeEmail(link.attendeeEmail))
      .map((link) => [normalizeEmail(link.attendeeEmail)!, link]),
  );
  let people: Person[] = [];
  try {
    const peopleIndex = await peopleStorage.listPeople();
    people = await peopleStorage.getPeopleByIds(peopleIndex.map((person) => person.id));
  } catch (error) {
    log.warn("People lookup failed during meeting roster resolution", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const peopleByEmail = personByEmail(people);
  const participants: MeetingParticipant[] = [];
  const seenPeople = new Set<string>();
  const seenEmails = new Set<string>();

  const appendCalendarParticipant = (
    value: { email?: string; displayName?: string; self?: boolean },
    calendarRole: "organizer" | "attendee",
  ) => {
    const email = normalizeEmail(value.email);
    if (!email || seenEmails.has(email)) return;
    const link = linksByEmail.get(email);
    const person = peopleByEmail.get(email)
      || (link ? people.find((candidate) => candidate.id === link.personId) : undefined);
    if (person?.id && seenPeople.has(person.id)) {
      seenEmails.add(email);
      return;
    }
    const label = person?.name || link?.personName?.trim() || value.displayName?.trim() || email;
    participants.push({
      label,
      ...(person?.id ? { personId: person.id } : link?.personId ? { personId: link.personId } : {}),
      identitySource: "calendar",
      calendarEmail: email,
      calendarRole,
    });
    seenEmails.add(email);
    if (person?.id || link?.personId) seenPeople.add(person?.id || link!.personId);
  };

  const organizerEmail = normalizeEmail(organizer?.email) || normalizeEmail(accountEmail);
  if (organizerEmail) {
    appendCalendarParticipant({
      email: organizerEmail,
      displayName: organizer?.displayName,
      self: organizer?.self,
    }, "organizer");
  }
  for (const attendee of attendees) appendCalendarParticipant(attendee, "attendee");

  for (const link of linkedPeople) {
    if (seenPeople.has(link.personId)) continue;
    const label = link.personName.trim();
    if (!label) continue;
    const email = normalizeEmail(link.attendeeEmail);
    participants.push({
      label,
      personId: link.personId,
      identitySource: "calendar",
      ...(email ? { calendarEmail: email } : {}),
      calendarRole: "attendee",
    });
    seenPeople.add(link.personId);
    if (email) seenEmails.add(email);
  }

  return participants;
}

async function fromEvent(
  event: CalendarEvent,
  meetingUrl: string,
  fallbackTitle: string,
  fallbackAgenda: string | undefined,
  resolutionSource: Exclude<MeetingResolutionSource, "unresolved_url">,
): Promise<ResolvedMeetingIdentity> {
  const metadata = await getMetadata(event.id, event.accountId, event.calendarId);
  const existingAgendaPage = metadata ? await resolveMeetingAgendaPage(metadata) : null;
  const agendaPage = metadata && !existingAgendaPage && metadata.agenda?.trim()
    ? await setMeetingAgendaPage(metadata, undefined, metadata.agenda, event.summary || fallbackTitle)
    : existingAgendaPage;
  const resolvedAgenda = metadata ? await resolveMeetingAgenda(metadata) : fallbackAgenda;
  const participants = await resolveEventParticipants(
    event.attendees,
    event.organizer,
    event.accountEmail,
    metadata?.id,
  );
  const speakerPolicy = normalizeMeetingSpeakerPolicy(metadata?.speakerPolicy as MeetingSpeakerPolicy | null);
  return {
    meetingUrl,
    title: event.summary?.trim() || fallbackTitle,
    agenda: fallbackAgenda || resolvedAgenda,
    ...(agendaPage ? { agendaPage: { id: agendaPage.id, title: agendaPage.title, slug: agendaPage.slug } } : {}),
    calendarAccountId: event.accountId,
    calendarId: event.calendarId,
    providerEventId: event.id,
    eventStart: eventDateTime(event.start),
    eventEnd: eventDateTime(event.end),
    resolutionSource,
    participants,
    speakerPolicy,
  };
}

export async function resolveMeetingIdentity(input: ResolveMeetingIdentityInput): Promise<ResolvedMeetingIdentity> {
  const meetingUrl = input.meetingUrl.trim();
  const title = input.title?.trim() || "Meeting";
  const agenda = input.agenda?.trim() || undefined;

  if (input.explicitEvent) {
    const explicitAgenda = input.explicitEvent.agenda?.trim() || agenda;
    const metadata = await getMetadata(
      input.explicitEvent.providerEventId,
      input.explicitEvent.accountId,
      input.explicitEvent.calendarId,
    );
    const participants = await resolveEventParticipants(
      input.explicitEvent.attendees || [],
      input.explicitEvent.organizer,
      input.explicitEvent.accountEmail,
      metadata?.id,
    );
    const existingAgendaPage = metadata ? await resolveMeetingAgendaPage(metadata) : null;
    const agendaPage = metadata && !existingAgendaPage && metadata.agenda?.trim()
      ? await setMeetingAgendaPage(metadata, undefined, metadata.agenda, input.explicitEvent.title || title)
      : existingAgendaPage;
    const metadataAgenda = metadata ? await resolveMeetingAgenda(metadata) : undefined;
    const speakerPolicy = normalizeMeetingSpeakerPolicy(metadata?.speakerPolicy as MeetingSpeakerPolicy | null);
    return {
      meetingUrl,
      title: input.explicitEvent.title?.trim() || title,
      agenda: explicitAgenda || metadataAgenda,
      ...(agendaPage ? { agendaPage: { id: agendaPage.id, title: agendaPage.title, slug: agendaPage.slug } } : {}),
      calendarAccountId: input.explicitEvent.accountId,
      calendarId: input.explicitEvent.calendarId,
      providerEventId: input.explicitEvent.providerEventId,
      eventStart: input.explicitEvent.eventStart,
      eventEnd: input.explicitEvent.eventEnd,
      resolutionSource: "calendar_auto_join",
      participants,
      speakerPolicy,
    };
  }

  const now = input.now ?? new Date();
  const { events, errors } = await listAllEvents({
    timeMin: new Date(now.getTime() - LOOKBACK_MS).toISOString(),
    timeMax: new Date(now.getTime() + LOOKAHEAD_MS).toISOString(),
    maxResults: MAX_EVENTS,
  });
  for (const error of errors) {
    log.warn("Calendar account failed during meeting identity resolution", {
      accountId: error.accountId,
      error: error.message,
    });
  }

  const normalizedTarget = normalizeMeetingUrl(meetingUrl);
  const matchingEvents = events.filter((event) => {
    if (event.status === "cancelled") return false;
    const eventUrl = meetingUrlForEvent(event);
    return !!eventUrl && normalizeMeetingUrl(eventUrl) === normalizedTarget;
  });
  const nearestMatch = matchingEvents.sort((left, right) => {
    const leftTime = new Date(eventDateTime(left.start) ?? 0).getTime();
    const rightTime = new Date(eventDateTime(right.start) ?? 0).getTime();
    return Math.abs(leftTime - now.getTime()) - Math.abs(rightTime - now.getTime());
  })[0];
  if (nearestMatch) {
    return fromEvent(nearestMatch, meetingUrl, title, agenda, "manual_url_match");
  }

  return { meetingUrl, title, agenda, resolutionSource: "unresolved_url", participants: [], speakerPolicy: { mode: "participant_streams" } };
}
