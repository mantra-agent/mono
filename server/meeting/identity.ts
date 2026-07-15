import type { MeetingParticipant, MeetingResolutionSource } from "@shared/models/chat";
import { getLinkedPeople, getMetadata, resolveMeetingAgenda, resolveMeetingAgendaPage, setMeetingAgendaPage, type MeetingAgendaPage } from "../calendar-metadata";
import { listAllEvents, type CalendarEvent } from "../google-calendar";
import { createLogger } from "../log";

const log = createLogger("MeetingIdentityResolver");
const LOOKBACK_MS = 15 * 60_000;
const LOOKAHEAD_MS = 8 * 60 * 60_000;
const MAX_EVENTS = 25;
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

async function resolveEventParticipants(
  attendees: CalendarEvent["attendees"],
  metadataId?: number,
): Promise<MeetingParticipant[]> {
  const linkedPeople = metadataId ? await getLinkedPeople(metadataId) : [];
  const linksByEmail = new Map(
    linkedPeople
      .filter((link) => link.attendeeEmail)
      .map((link) => [link.attendeeEmail!.trim().toLowerCase(), link]),
  );
  const participants: MeetingParticipant[] = [];
  const seenPeople = new Set<string>();
  const seenLabels = new Set<string>();

  for (const attendee of attendees) {
    const email = attendee.email.trim().toLowerCase();
    const link = linksByEmail.get(email);
    if (attendee.self && !link) continue;

    const label = attendee.displayName?.trim() || link?.personName?.trim() || attendee.email.trim();
    if (!label) continue;
    const labelKey = label.toLowerCase();
    if ((link && seenPeople.has(link.personId)) || seenLabels.has(labelKey)) continue;

    participants.push(link ? { label, personId: link.personId } : { label });
    seenLabels.add(labelKey);
    if (link) seenPeople.add(link.personId);
  }

  for (const link of linkedPeople) {
    if (seenPeople.has(link.personId)) continue;
    const label = link.personName.trim();
    if (!label || seenLabels.has(label.toLowerCase())) continue;
    participants.push({ label, personId: link.personId });
    seenPeople.add(link.personId);
    seenLabels.add(label.toLowerCase());
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
  const participants = await resolveEventParticipants(event.attendees, metadata?.id);
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
      metadata?.id,
    );
    const existingAgendaPage = metadata ? await resolveMeetingAgendaPage(metadata) : null;
    const agendaPage = metadata && !existingAgendaPage && metadata.agenda?.trim()
      ? await setMeetingAgendaPage(metadata, undefined, metadata.agenda, input.explicitEvent.title || title)
      : existingAgendaPage;
    const metadataAgenda = metadata ? await resolveMeetingAgenda(metadata) : undefined;
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
  for (const event of events) {
    if (event.status === "cancelled") continue;
    const eventUrl = meetingUrlForEvent(event);
    if (!eventUrl || normalizeMeetingUrl(eventUrl) !== normalizedTarget) continue;
    return fromEvent(event, meetingUrl, title, agenda, "manual_url_match");
  }

  return { meetingUrl, title, agenda, resolutionSource: "unresolved_url", participants: [] };
}
