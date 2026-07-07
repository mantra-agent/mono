import { listAllEvents, type CalendarEvent } from "./google-calendar";
import { classifyEventByTitle, listMetadataByEvents, CAPACITY_TYPES, type CapacityType } from "./calendar-metadata";

export type BandwidthCapacityType = CapacityType | "untyped";

export interface BandwidthBlock {
  eventId: string;
  calendarId: string;
  accountId: string;
  accountEmail: string;
  summary: string;
  start: CalendarEvent["start"];
  end: CalendarEvent["end"];
  minutes: number;
  capacityType: BandwidthCapacityType;
}

export interface BandwidthSummary {
  totalFocusMinutes: number;
  byCapacityType: Record<BandwidthCapacityType, number>;
  blocks: BandwidthBlock[];
  errors: Array<{ accountId: string; message: string }>;
}

function getTimedDurationMinutes(event: CalendarEvent): number {
  if (!event.start.dateTime || !event.end.dateTime) return 0;
  const start = new Date(event.start.dateTime).getTime();
  const end = new Date(event.end.dateTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 60000);
}

function emptyCapacityMap(): Record<BandwidthCapacityType, number> {
  return {
    deep_work: 0,
    responsive: 0,
    admin: 0,
    wellness: 0,
    personal: 0,
    creative: 0,
    flexible: 0,
    untyped: 0,
  };
}

function isCapacityType(value: string | null | undefined): value is CapacityType {
  return !!value && (CAPACITY_TYPES as readonly string[]).includes(value);
}

export async function getBandwidthSummary(options: {
  timeMin: string;
  timeMax: string;
  maxResults?: number;
}): Promise<BandwidthSummary> {
  const result = await listAllEvents({
    timeMin: options.timeMin,
    timeMax: options.timeMax,
    maxResults: options.maxResults ?? 500,
  });

  const timedEvents = result.events.filter(event => event.start.dateTime && event.end.dateTime);
  const metadata = await listMetadataByEvents(timedEvents.map(event => ({
    googleEventId: event.id,
    accountId: event.accountId,
    calendarId: event.calendarId,
  })));
  const metadataByKey = new Map(metadata.map(meta => [`${meta.googleEventId}::${meta.accountId}::${meta.calendarId}`, meta]));

  const byCapacityType = emptyCapacityMap();
  const blocks: BandwidthBlock[] = [];

  for (const event of timedEvents) {
    const meta = metadataByKey.get(`${event.id}::${event.accountId}::${event.calendarId}`);
    const eventType = meta?.eventType ?? classifyEventByTitle(event.summary || "");
    if (eventType !== "focus_block") continue;

    const minutes = getTimedDurationMinutes(event);
    if (minutes <= 0) continue;

    const capacityType: BandwidthCapacityType = isCapacityType(meta?.capacityType) ? meta.capacityType : "untyped";
    byCapacityType[capacityType] += minutes;
    blocks.push({
      eventId: event.id,
      calendarId: event.calendarId,
      accountId: event.accountId,
      accountEmail: event.accountEmail,
      summary: event.summary,
      start: event.start,
      end: event.end,
      minutes,
      capacityType,
    });
  }

  blocks.sort((a, b) => (a.start.dateTime || "").localeCompare(b.start.dateTime || ""));

  return {
    totalFocusMinutes: blocks.reduce((sum, block) => sum + block.minutes, 0),
    byCapacityType,
    blocks,
    errors: result.errors,
  };
}
