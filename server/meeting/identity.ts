import type { MeetingResolutionSource } from "@shared/models/chat";
import { getMetadata } from "../calendar-metadata";
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
}

export interface ResolvedMeetingIdentity {
  meetingUrl: string;
  title: string;
  agenda?: string;
  calendarAccountId?: string;
  calendarId?: string;
  providerEventId?: string;
  eventStart?: string;
  eventEnd?: string;
  resolutionSource: MeetingResolutionSource;
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

async function fromEvent(
  event: CalendarEvent,
  meetingUrl: string,
  fallbackTitle: string,
  fallbackAgenda: string | undefined,
  resolutionSource: Exclude<MeetingResolutionSource, "unresolved_url">,
): Promise<ResolvedMeetingIdentity> {
  const metadata = fallbackAgenda
    ? null
    : await getMetadata(event.id, event.accountId, event.calendarId);
  return {
    meetingUrl,
    title: event.summary?.trim() || fallbackTitle,
    agenda: fallbackAgenda || metadata?.agenda?.trim() || undefined,
    calendarAccountId: event.accountId,
    calendarId: event.calendarId,
    providerEventId: event.id,
    eventStart: eventDateTime(event.start),
    eventEnd: eventDateTime(event.end),
    resolutionSource,
  };
}

export async function resolveMeetingIdentity(input: ResolveMeetingIdentityInput): Promise<ResolvedMeetingIdentity> {
  const meetingUrl = input.meetingUrl.trim();
  const title = input.title?.trim() || "Meeting";
  const agenda = input.agenda?.trim() || undefined;

  if (input.explicitEvent) {
    return {
      meetingUrl,
      title: input.explicitEvent.title?.trim() || title,
      agenda: input.explicitEvent.agenda?.trim() || agenda,
      calendarAccountId: input.explicitEvent.accountId,
      calendarId: input.explicitEvent.calendarId,
      providerEventId: input.explicitEvent.providerEventId,
      eventStart: input.explicitEvent.eventStart,
      eventEnd: input.explicitEvent.eventEnd,
      resolutionSource: "calendar_auto_join",
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

  return { meetingUrl, title, agenda, resolutionSource: "unresolved_url" };
}
