// Use createLogger for logging ONLY
// Google Calendar integration — uses unified Google OAuth from gmail.ts
import {
  type GmailAccount,
  listGmailAccounts,
  loadAccountTokens,
  saveAccountTokens,
  getOAuth2Client,
} from './gmail';

// ─── Interfaces ───

export interface CalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email: string; displayName?: string }>;
  reminders?: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  accountId: string;
  accountEmail: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees: Array<{ email: string; displayName?: string; responseStatus?: string; self?: boolean; optional?: boolean }>;
  status: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  organizer?: { email: string; displayName?: string; self?: boolean };
  recurringEventId?: string;
  colorId?: string;
}

import { createLogger } from "./log";

const log = createLogger("GoogleCalendar");

export { type GmailAccount };

// ─── Calendar scope checks ───

export async function hasCalendarAccess(accountId: string): Promise<boolean> {
  const tokens = await loadAccountTokens(accountId);
  if (!tokens) return false;
  const scope = tokens.scope || '';
  return scope.includes('calendar');
}

// ─── Calendar client ───

export async function getCalendarClient(accountId: string) {
  const tokens = await loadAccountTokens(accountId);
  if (!tokens) {
    throw new Error(`No tokens for account ${accountId}`);
  }

  const scope = tokens.scope || '';
  if (!scope.includes('calendar')) {
    throw new Error(`Account "${accountId}" needs Calendar authorization. Please re-authorize with calendar scopes.`);
  }

  const oauth2Client = await getOAuth2Client();
  oauth2Client.setCredentials(tokens as any);
  oauth2Client.on('tokens', async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveAccountTokens(accountId, merged as any);
  });

  const { google } = await import('googleapis');
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// ─── Calendar operations ───

export async function listCalendars(accountId: string) {
  const calendar = await getCalendarClient(accountId);
  const res = await calendar.calendarList.list();
  return res.data.items || [];
}

export async function listEvents(
  accountId: string,
  options: {
    calendarId?: string;
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
  } = {}
): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(accountId);
  const tokens = await loadAccountTokens(accountId);
  const accountEmail = tokens?.email || '';
  const calendarId = options.calendarId || 'primary';

  const res = await calendar.events.list({
    calendarId,
    timeMin: options.timeMin,
    timeMax: options.timeMax,
    maxResults: options.maxResults || 250,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (res.data.items || []).map(ev => mapEvent(ev, calendarId, accountId, accountEmail));
}

export async function getEvent(
  accountId: string,
  calendarId: string,
  eventId: string
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient(accountId);
  const tokens = await loadAccountTokens(accountId);
  const accountEmail = tokens?.email || '';

  const res = await calendar.events.get({ calendarId, eventId });
  return mapEvent(res.data, calendarId, accountId, accountEmail);
}

export async function createEvent(
  accountId: string,
  calendarId: string,
  event: CalendarEventInput
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient(accountId);
  const tokens = await loadAccountTokens(accountId);
  const accountEmail = tokens?.email || '';

  const res = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });
  return mapEvent(res.data, calendarId, accountId, accountEmail);
}

export async function updateEvent(
  accountId: string,
  calendarId: string,
  eventId: string,
  event: Partial<CalendarEventInput>
): Promise<CalendarEvent> {
  const calendar = await getCalendarClient(accountId);
  const tokens = await loadAccountTokens(accountId);
  const accountEmail = tokens?.email || '';

  const res = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: event,
  });
  return mapEvent(res.data, calendarId, accountId, accountEmail);
}

export async function deleteEvent(
  accountId: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const calendar = await getCalendarClient(accountId);
  await calendar.events.delete({ calendarId, eventId });
}

export interface ListAllEventsError {
  accountId: string;
  message: string;
}

export interface ListAllEventsResult {
  events: CalendarEvent[];
  errors: ListAllEventsError[];
}

export async function listAllEvents(
  options: {
    timeMin?: string;
    timeMax?: string;
    maxResults?: number;
  } = {}
): Promise<ListAllEventsResult> {
  const accounts = await listGmailAccounts();
  const allEvents: CalendarEvent[] = [];
  const errors: ListAllEventsError[] = [];

  for (const account of accounts) {
    const hasAccess = await hasCalendarAccess(account.id);
    if (!hasAccess) continue;

    try {
      const events = await listEvents(account.id, {
        timeMin: options.timeMin,
        timeMax: options.timeMax,
        maxResults: options.maxResults,
      });
      allEvents.push(...events);
    } catch (err: unknown) {
      const { isInvalidGrantError } = await import("./gmail");
      if (isInvalidGrantError(err)) {
        log.warn(`listAllEvents skipping account=${account.id} — token expired or revoked (invalid_grant)`);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`listAllEvents calendar failed account=${account.id}:`, message);
        errors.push({ accountId: account.id, message });
      }
    }
  }

  allEvents.sort((a, b) => {
    const aTime = a.start.dateTime || a.start.date || '';
    const bTime = b.start.dateTime || b.start.date || '';
    return aTime.localeCompare(bTime);
  });

  return { events: allEvents, errors };
}

// ─── Event mapping helper ───

function mapEvent(ev: any, calendarId: string, accountId: string, accountEmail: string): CalendarEvent {
  return {
    id: ev.id || '',
    calendarId,
    accountId,
    accountEmail,
    summary: ev.summary || '',
    description: ev.description || undefined,
    location: ev.location || undefined,
    start: {
      dateTime: ev.start?.dateTime || undefined,
      date: ev.start?.date || undefined,
      timeZone: ev.start?.timeZone || undefined,
    },
    end: {
      dateTime: ev.end?.dateTime || undefined,
      date: ev.end?.date || undefined,
      timeZone: ev.end?.timeZone || undefined,
    },
    attendees: (ev.attendees || []).map((a: any) => ({
      email: a.email || '',
      displayName: a.displayName || undefined,
      responseStatus: a.responseStatus || undefined,
      self: a.self || undefined,
      optional: a.optional || undefined,
    })),
    status: ev.status || 'confirmed',
    htmlLink: ev.htmlLink || undefined,
    created: ev.created || undefined,
    updated: ev.updated || undefined,
    organizer: ev.organizer ? {
      email: ev.organizer.email || '',
      displayName: ev.organizer.displayName || undefined,
      self: ev.organizer.self || undefined,
    } : undefined,
    recurringEventId: ev.recurringEventId || undefined,
    colorId: ev.colorId || undefined,
  };
}

// ─── High-prep event detection ───

const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com',
  'outlook.com', 'icloud.com', 'me.com', 'aol.com',
  'protonmail.com', 'proton.me', 'live.com', 'msn.com',
]);

export function isHighPrepEvent(event: CalendarEvent): boolean {
  const desc = event.description || '';
  if (desc.includes('[no-prep]')) return false;
  if (desc.includes('[prep-required]')) return true;

  if (event.accountEmail) {
    const domain = event.accountEmail.split('@')[1]?.toLowerCase();
    if (domain && PERSONAL_DOMAINS.has(domain)) return true;
    if (domain && (event.attendees?.length ?? 0) > 0) {
      const hasExternal = event.attendees!.some(a => {
        if (a.self) return false;
        const attendeeDomain = a.email.split('@')[1]?.toLowerCase();
        return attendeeDomain && attendeeDomain !== domain;
      });
      if (hasExternal) return true;
    }
  }

  return false;
}
