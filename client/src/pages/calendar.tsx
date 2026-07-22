import { useRoute } from "wouter";
import { EventDetailView } from "@/components/calendar/event-detail-view";
import { useEventMetadata } from "@/components/calendar/use-event-metadata";
import { useState, useMemo } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useTimezone } from "@/hooks/use-timezone";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Calendar as CalendarIcon,
  ChevronRight,
  Plus,
  MapPin,
  Users,
  Star,
  Clock,
  Search,
  Brain,
  Heart,
  SlidersHorizontal,
  Plane,
  Video,
  Phone,
  Dumbbell,
  ClipboardList,
  UserRound,
  BriefcaseBusiness,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";
import { fromCivilDate } from "@shared/civil-date";
import { createMeetingArtifactChild, createMeetingPersonChild, dedupeMeetingInvitees, formatMeetingInviteeName } from "@shared/meeting-feed-items";
import type { SimpleSourceRef } from "@shared/models/simple";
import { SimpleTreeRow } from "@/components/home/home-tree-row";
import { sourceRefToReferenceRef } from "@shared/simple-references";
import { ReferenceRenderer } from "@/components/references/reference-renderer";

interface CalendarInfo {
  id: string;
  accountId: string;
  accountEmail: string;
  summary: string;
  description?: string;
  backgroundColor: string;
  primary: boolean;
  accessRole: string;
}

interface CalendarEvent {
  id: string;
  calendarId: string;
  accountId: string;
  accountEmail: string;
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string; self?: boolean; optional?: boolean }>;
  status: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  organizer?: { email: string; displayName?: string; self?: boolean };
  recurringEventId?: string;
  colorId?: string;
}

interface EmailPersonContext {
  id: string;
  name: string;
  summary: string | null;
  lastInteractionContext: string | null;
}

interface AccountInfo {
  id: string;
  email: string;
  label: string;
  hasCalendarAccess: boolean;
}

type BandwidthCapacityType = "deep_work" | "responsive" | "admin" | "wellness" | "personal" | "creative" | "flexible" | "untyped";

interface BandwidthBlock {
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

interface BandwidthSummary {
  totalFocusMinutes: number;
  byCapacityType: Record<BandwidthCapacityType, number>;
  blocks: BandwidthBlock[];
}

const CAPACITY_LABELS: Record<BandwidthCapacityType, string> = {
  deep_work: "Deep Work",
  responsive: "Responsive",
  admin: "Admin",
  wellness: "Wellness",
  personal: "Personal",
  creative: "Creative",
  flexible: "Flexible",
  untyped: "Untyped",
};

const CAPACITY_ORDER: BandwidthCapacityType[] = ["deep_work", "responsive", "admin", "wellness", "personal", "creative", "flexible", "untyped"];

function getWeekRange(date: Date): { start: Date; end: Date } {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(d);
  start.setDate(d.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getMonthRange(date: Date): { start: Date; end: Date } {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

function getDayRange(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getPartsInTimezone(dateTime: string, timezone: string): { hour: number; minute: number; year: number; month: number; day: number } {
  const d = new Date(dateTime);
  const str = d.toLocaleString("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const m = str.match(/(\d+)\/(\d+)\/(\d+),?\s*(\d+):(\d+)/);
  if (!m) {
    return { hour: d.getHours(), minute: d.getMinutes(), year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  return { month: parseInt(m[1]), day: parseInt(m[2]), year: parseInt(m[3]), hour: parseInt(m[4]), minute: parseInt(m[5]) };
}

function formatMinutesAsHours(minutes: number): string {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

function formatEventTime(start: CalendarEvent["start"], end: CalendarEvent["end"], timezone: string): string {
  if (start.date && !start.dateTime) return "All day";
  if (!start.dateTime) return "";
  const s = new Date(start.dateTime);
  const e = end.dateTime ? new Date(end.dateTime) : null;
  const fmt = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: timezone });
  if (e) return `${fmt(s)} – ${fmt(e)}`;
  return fmt(s);
}

function isToday(date: Date, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): boolean {
  return calendarDateKey(date) === getDateKeyInTimezone(new Date().toISOString(), timezone);
}

function getDateKeyInTimezone(dateTime: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(dateTime));
}

function calendarDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function eventMatchesCalendarDay(event: CalendarEvent, day: Date, timezone: string): boolean {
  const dayKey = calendarDateKey(day);
  if (event.start.dateTime) return getDateKeyInTimezone(event.start.dateTime, timezone) === dayKey;
  if (event.start.date) return event.start.date === dayKey;
  return false;
}

function isAllDay(event: CalendarEvent): boolean {
  return !!(event.start.date && !event.start.dateTime);
}

function getEventHour(event: CalendarEvent, timezone: string): number {
  if (!event.start.dateTime) return 0;
  return getPartsInTimezone(event.start.dateTime, timezone).hour;
}

interface DayHourRow {
  hour: number;
}

interface DayEventBlock {
  event: CalendarEvent;
  rowStart: number;
  rowSpan: number;
}

function getEventEndHour(event: CalendarEvent, timezone: string): number {
  if (!event.end.dateTime) return getEventHour(event, timezone);
  const end = getPartsInTimezone(event.end.dateTime, timezone);
  const lastTouchedHour = end.minute === 0 ? end.hour - 1 : end.hour;
  return Math.max(getEventHour(event, timezone), lastTouchedHour);
}

function getDayHourRows(section: ScheduleSection, events: CalendarEvent[], timezone: string, now = new Date()): DayHourRow[] {
  const today = isToday(section.start, timezone);
  const startHour = today ? getPartsInTimezone(now.toISOString(), timezone).hour : 5;
  const timedEvents = events.filter(event => !isAllDay(event) && event.start.dateTime);
  const latestEventHour = timedEvents.reduce<number | null>((latest, event) => {
    const endHour = getEventEndHour(event, timezone);
    return latest === null ? endHour : Math.max(latest, endHour);
  }, null);
  if (latestEventHour === null || latestEventHour < startHour) return [];

  return Array.from({ length: latestEventHour - startHour + 1 }, (_, index) => ({
    hour: startHour + index,
  }));
}

function getDayEventBlocks(rows: DayHourRow[], events: CalendarEvent[], timezone: string): DayEventBlock[] {
  if (rows.length === 0) return [];
  const firstHour = rows[0].hour;
  const lastHour = rows[rows.length - 1].hour;

  return events
    .filter(event => !isAllDay(event) && event.start.dateTime)
    .map(event => ({
      event,
      startHour: Math.max(firstHour, getEventHour(event, timezone)),
      endHour: Math.min(lastHour, getEventEndHour(event, timezone)),
    }))
    .filter(({ startHour, endHour }) => startHour <= endHour)
    .sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour)
    .map(({ event, startHour, endHour }) => ({
      event,
      rowStart: startHour - firstHour + 1,
      rowSpan: endHour - startHour + 1,
    }));
}

function formatHourLabel(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" });
}

const EVENT_TYPE_ICONS: Record<string, typeof CalendarIcon> = {
  focus_block: Brain,
  travel: Plane,
  video_meeting: Video,
  call: Phone,
  exercise: Dumbbell,
  planning: ClipboardList,
  personal: UserRound,
  admin: BriefcaseBusiness,
  meeting: Users,
};

function inferEventType(event: CalendarEvent, explicitType?: string | null): string {
  if (explicitType) return explicitType;
  const text = `${event.summary} ${event.description ?? ""} ${event.location ?? ""}`.toLowerCase();
  if (/\b(focus|deep work)\b/.test(text)) return "focus_block";
  if (/\b(travel|flight|airport|train|transit|drive)\b/.test(text)) return "travel";
  if (/\b(zoom|google meet|meet\.google|teams meeting|video)\b/.test(text)) return "video_meeting";
  if (/\b(call|phone)\b/.test(text)) return "call";
  if (/\b(workout|exercise|wellness|gym|run|yoga)\b/.test(text)) return "exercise";
  if (/\b(plan|planning|review)\b/.test(text)) return "planning";
  if (/\b(admin|chores|errand)\b/.test(text)) return "admin";
  if (event.attendees?.some(attendee => !attendee.self)) return "meeting";
  return "personal";
}

function EventTypeIcon({ event, eventType, className }: {
  event: CalendarEvent;
  eventType?: string | null;
  className?: string;
}) {
  const Icon = EVENT_TYPE_ICONS[inferEventType(event, eventType)] ?? CalendarIcon;
  return <Icon className={className} aria-hidden="true" />;
}

function isHighPrep(event: CalendarEvent): boolean {
  const desc = event.description || "";
  if (desc.includes("[no-prep]")) return false;
  if (desc.includes("[prep-required]")) return true;
  if (isPersonalAccount(event.accountEmail)) return true;
  if (event.accountEmail && event.attendees && event.attendees.length > 0) {
    const orgDomain = event.accountEmail.split("@")[1]?.toLowerCase();
    if (orgDomain) {
      const hasExternal = event.attendees.some(a => {
        if (a.self) return false;
        const domain = a.email.split("@")[1]?.toLowerCase();
        return domain && domain !== orgDomain;
      });
      if (hasExternal) return true;
    }
  }
  return false;
}

function isHighPrepWithoutTags(event: CalendarEvent): boolean {
  if (isPersonalAccount(event.accountEmail)) return true;
  if (event.accountEmail && event.attendees && event.attendees.length > 0) {
    const orgDomain = event.accountEmail.split("@")[1]?.toLowerCase();
    if (orgDomain) {
      const hasExternal = event.attendees.some(a => {
        if (a.self) return false;
        const domain = a.email.split("@")[1]?.toLowerCase();
        return domain && domain !== orgDomain;
      });
      if (hasExternal) return true;
    }
  }
  return false;
}

function hasExternalAttendees(event: CalendarEvent, accountEmails: string[]): boolean {
  if (!event.attendees || event.attendees.length === 0 || accountEmails.length === 0) return false;
  const orgDomains = accountEmails.map(e => e.split("@")[1]?.toLowerCase()).filter(Boolean);
  return event.attendees.some(a => {
    if (a.self) return false;
    const domain = a.email.split("@")[1]?.toLowerCase();
    if (!domain) return false;
    return !orgDomains.includes(domain);
  });
}

const PERSONAL_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me", "live.com", "msn.com"]);

function isPersonalAccount(accountEmail: string): boolean {
  const domain = accountEmail.split("@")[1]?.toLowerCase();
  return PERSONAL_DOMAINS.has(domain || "");
}

function isOptionalForMe(event: CalendarEvent): boolean {
  if (!event.attendees) return false;
  const self = event.attendees.find(a => a.self);
  return self?.optional === true;
}

function formatDateLabel(date: Date, view: string): string {
  if (view === "day") return date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (view === "week") {
    const { start, end } = getWeekRange(date);
    const sMonth = start.toLocaleDateString([], { month: "short", day: "numeric" });
    const eMonth = end.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    return `${sMonth} – ${eMonth}`;
  }
  return date.toLocaleDateString([], { month: "long", year: "numeric" });
}

function navigateDate(date: Date, view: string, direction: number): Date {
  const d = new Date(date);
  if (view === "day") d.setDate(d.getDate() + direction);
  else if (view === "week") d.setDate(d.getDate() + 7 * direction);
  else d.setMonth(d.getMonth() + direction);
  return d;
}

function toISOLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}:00`;
}

type ScheduleMode = "day" | "week" | "month";

interface ScheduleSection {
  id: string;
  title: string;
  subtitle?: string;
  start: Date;
  end: Date;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function startOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function formatShortDate(date: Date): string {
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatScheduleSectionTitle(section: ScheduleSection, mode: ScheduleMode): string {
  if (mode === "day") return section.start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  if (mode === "week") return `${formatShortDate(section.start)} – ${formatShortDate(section.end)}`;
  return section.start.toLocaleDateString([], { month: "long", year: "numeric" });
}

function makeScheduleSections(mode: ScheduleMode, now = new Date()): ScheduleSection[] {
  const today = startOfLocalDay(now);
  if (mode === "day") {
    return Array.from({ length: 14 }, (_, index) => {
      const start = addDays(today, index);
      const end = getDayRange(start).end;
      return {
        id: calendarDateKey(start),
        title: formatScheduleSectionTitle({ id: "", start, end, title: "" }, mode),
        subtitle: index === 0 ? "Today" : undefined,
        start,
        end,
      };
    });
  }

  if (mode === "week") {
    const horizonEnd = addMonths(today, 2);
    const firstWeek = getWeekRange(today).start;
    const sections: ScheduleSection[] = [];
    for (let cursor = new Date(firstWeek); cursor <= horizonEnd; cursor = addDays(cursor, 7)) {
      const { start, end } = getWeekRange(cursor);
      sections.push({
        id: `week-${calendarDateKey(start)}`,
        title: formatScheduleSectionTitle({ id: "", start, end, title: "" }, mode),
        subtitle: start <= today && today <= end ? "This week" : undefined,
        start,
        end,
      });
    }
    return sections;
  }

  return Array.from({ length: 6 }, (_, index) => {
    const start = new Date(today.getFullYear(), today.getMonth() + index, 1);
    const end = getMonthRange(start).end;
    return {
      id: `month-${start.getFullYear()}-${start.getMonth() + 1}`,
      title: formatScheduleSectionTitle({ id: "", start, end, title: "" }, mode),
      subtitle: index === 0 ? "This month" : undefined,
      start,
      end,
    };
  });
}

function getEventStartDate(event: CalendarEvent): Date | null {
  if (event.start.dateTime) return new Date(event.start.dateTime);
  if (event.start.date) return fromCivilDate(event.start.date);
  return null;
}

function eventFallsInSection(event: CalendarEvent, section: ScheduleSection): boolean {
  const start = getEventStartDate(event);
  if (!start) return false;
  return start >= section.start && start <= section.end;
}

function eventSearchText(event: CalendarEvent): string {
  return [
    event.summary,
    event.location,
    event.description,
    event.accountEmail,
    ...(event.attendees ?? []).map(attendee => `${attendee.displayName ?? ""} ${attendee.email}`),
  ].filter(Boolean).join(" ").toLowerCase();
}

function sortEventsForSchedule(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((a, b) => {
    const aTime = getEventStartDate(a)?.getTime() ?? 0;
    const bTime = getEventStartDate(b)?.getTime() ?? 0;
    return aTime - bTime || a.summary.localeCompare(b.summary);
  });
}

export default function CalendarPage() {
  // Route-based event detail view
  const [, detailParams] = useRoute("/schedule/:eventId");
  const detailEventId = detailParams?.eventId || null;

  // Parse query params for detail view
  const searchParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const qCalendarId = searchParams.get("calendarId") || undefined;
  const qAccountId = searchParams.get("accountId") || undefined;
  const qStart = searchParams.get("start") || undefined;
  const qEnd = searchParams.get("end") || undefined;

  const [view, setView] = useState<ScheduleMode>("day");
  const [searchQuery, setSearchQuery] = useState("");
  const [, navigate] = useLocation();
  const { timezone } = useTimezone();

  usePageHeader({ title: "Schedule", skip: Boolean(detailEventId) });

  const sections = useMemo(() => makeScheduleSections(view), [view]);
  const range = useMemo(() => ({
    start: sections[0]?.start ?? startOfLocalDay(new Date()),
    end: sections[sections.length - 1]?.end ?? getDayRange(new Date()).end,
  }), [sections]);

  // Pad range by ±25h to capture events near day boundaries when the configured
  // timezone differs from the browser timezone (max UTC offset difference ~26h).
  const paddedStart = new Date(range.start.getTime() - 25 * 60 * 60 * 1000);
  const paddedEnd = new Date(range.end.getTime() + 25 * 60 * 60 * 1000);
  const timeMin = paddedStart.toISOString();
  const timeMax = paddedEnd.toISOString();

  const { data: accountsData, isLoading: accountsLoading } = useQuery<{ accounts: AccountInfo[] }>({
    queryKey: ["/api/calendar/accounts"],
  });

  const { data: calendarsData, isLoading: calendarsLoading } = useQuery<{ calendars: CalendarInfo[] }>({
    queryKey: ["/api/calendar/calendars"],
  });

  const { data: eventsData, isLoading: eventsLoading } = useQuery<{ events: CalendarEvent[] }>({
    queryKey: ["/api/calendar/events", timeMin, timeMax],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
  });

  const accounts = accountsData?.accounts || [];
  const hasConnected = accounts.some(a => a.hasCalendarAccess);


  const { data: bandwidthData, isLoading: bandwidthLoading } = useQuery<BandwidthSummary>({
    queryKey: ["/api/calendar/bandwidth", timeMin, timeMax],
    queryFn: async () => {
      const res = await fetch(`/api/calendar/bandwidth?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`, { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: hasConnected,
  });

  const calendars = calendarsData?.calendars || [];
  const events = eventsData?.events || [];
  const isLoading = accountsLoading || calendarsLoading;
  const accountEmails = useMemo(() => accounts.map(a => a.email), [accounts]);

  const calendarMap = useMemo(() => {
    const m = new Map<string, CalendarInfo>();
    calendars.forEach(c => m.set(c.id, c));
    return m;
  }, [calendars]);

  const visibleEvents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query ? events.filter(event => eventSearchText(event).includes(query)) : events;
    return sortEventsForSchedule(filtered);
  }, [events, searchQuery]);

  // Route-based event detail view — must be after all hooks
  if (detailEventId) {
    return (
      <EventDetailView
        eventId={detailEventId}
        calendarId={qCalendarId}
        accountId={qAccountId}
        startTime={qStart}
        endTime={qEnd}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col overflow-hidden" data-testid="schedule-loading">
        <div className="border-b border-border p-2">
          <Skeleton className="h-7 w-full rounded-md" />
        </div>
        <div className="space-y-2 p-3">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-11 w-full rounded-md" />)}
        </div>
      </div>
    );
  }

  if (!hasConnected) {
    const hasGmailAccounts = accounts.length > 0;

    if (hasGmailAccounts) {
      return (
        <div className="flex flex-col items-center justify-center py-12 gap-6" data-testid="calendar-authorize-state">
          <div className="rounded-full bg-muted p-4">
            <CalendarIcon className="h-8 w-8 text-muted-foreground" />
          </div>
          <div className="text-center space-y-1">
            <h2 className="text-lg font-semibold" data-testid="text-authorize-calendar-title">
              Authorize Calendar Access
            </h2>
            <p className="text-sm text-muted-foreground max-w-sm" data-testid="text-authorize-calendar-desc">
              Your Google accounts are connected — just grant calendar access to see your schedule here.
            </p>
          </div>
          <div className="flex flex-col gap-3 w-full max-w-xs">
            {accounts.map(account => (
              <Button
                key={account.id}
                variant="outline"
                className="w-full justify-start gap-2"
                data-testid={`button-authorize-calendar-${account.id}`}
                onClick={async () => {
                  try {
                    const res = await fetch("/api/gmail/accounts/add", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ label: account.label || "Personal" }),
                    });
                    const data = await res.json();
                    if (data.url) window.location.href = data.url;
                  } catch {}
                }}
              >
                <CalendarIcon className="h-4 w-4" />
                <span className="truncate">{account.email}</span>
              </Button>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4" data-testid="calendar-empty-state">
        <div className="rounded-full bg-muted p-4">
          <CalendarIcon className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="text-lg font-semibold" data-testid="text-empty-calendar-title">
            Connect your Google Calendar
          </h2>
          <p className="text-sm text-muted-foreground max-w-sm" data-testid="text-empty-calendar-desc">
            Connect your Google Calendar to see your schedule here
          </p>
        </div>
        <Button asChild data-testid="button-connect-calendar">
          <a href="/integrations/google">Connect Calendar</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="schedule-page">
      <div className="border-b border-border p-2">
        <div className="flex items-center gap-1">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search schedule..."
              className="h-7 pl-7 pr-2 text-xs"
              data-testid="input-search-schedule"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Schedule range" data-testid="button-schedule-range">
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-28">
              {(["day", "week", "month"] as ScheduleMode[]).map(mode => (
                <DropdownMenuItem
                  key={mode}
                  onClick={() => setView(mode)}
                  className={cn("text-xs", view === mode && "font-semibold text-foreground")}
                  data-testid={`menu-schedule-${mode}`}
                >
                  {mode.toUpperCase()}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => navigate("/schedule/new")} title="New event" data-testid="button-new-event">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-1 p-1.5">
          <BandwidthSummaryCard summary={bandwidthData} loading={bandwidthLoading} timezone={timezone} />
          {sections.map(section => {
            const sectionEvents = visibleEvents.filter(event => eventFallsInSection(event, section));
            return (
              <ScheduleTreeSection
                key={section.id}
                section={section}
                mode={view}
                events={sectionEvents}
                loading={eventsLoading}
                calendarMap={calendarMap}
                accountEmails={accountEmails}
                timezone={timezone}
                onEventClick={(event) => navigate(`/schedule/${event.id}?calendarId=${encodeURIComponent(event.calendarId)}&accountId=${encodeURIComponent(event.accountId)}`)}
              />
            );
          })}
        </div>
      </ScrollArea>

    </div>
  );
}

function ScheduleTreeSection({ section, mode, events, loading, calendarMap, accountEmails, timezone, onEventClick }: {
  section: ScheduleSection;
  mode: ScheduleMode;
  events: CalendarEvent[];
  loading: boolean;
  calendarMap: Map<string, CalendarInfo>;
  accountEmails: string[];
  timezone: string;
  onEventClick: (event: CalendarEvent) => void;
}) {
  const [open, setOpen] = useState(true);
  const dayHourRows = useMemo(
    () => mode === "day" ? getDayHourRows(section, events, timezone) : [],
    [events, mode, section, timezone],
  );
  const allDayEvents = mode === "day" ? events.filter(isAllDay) : [];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground transition-colors hover-elevate" data-testid={`section-schedule-${section.id}`}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="truncate">{section.title}</span>
        {section.subtitle ? <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">{section.subtitle}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-0 space-y-0.5 pb-1">
          {loading ? (
            <Skeleton className="h-10 w-full rounded-md" />
          ) : mode === "day" ? (
            <>
              {allDayEvents.length > 0 && (
                <DayAllDayRow events={allDayEvents} onEventClick={onEventClick} />
              )}
              <DayTimeline
                rows={dayHourRows}
                events={events}
                accountEmails={accountEmails}
                timezone={timezone}
                onEventClick={onEventClick}
              />
            </>
          ) : events.length === 0 ? (
            <div className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs text-muted-foreground/55">
              <span className="w-14 shrink-0 text-right pr-1.5 text-[11px] leading-tight tabular-nums" />
              <span className="w-4 shrink-0" />
              <span className="truncate">No events</span>
            </div>
          ) : (
            events.map(event => (
              <ScheduleEventRow
                key={`${event.calendarId}:${event.id}`}
                event={event}
                calendarMap={calendarMap}
                mode={mode}
                timezone={timezone}
                isExternal={hasExternalAttendees(event, accountEmails)}
                isPersonal={isPersonalAccount(event.accountEmail)}
                onClick={() => onEventClick(event)}
              />
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DayAllDayRow({ events, onEventClick }: {
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
}) {
  return (
    <div className="grid min-h-7 w-full grid-cols-[3.5rem_1rem_minmax(0,1fr)] items-center gap-2 pr-2">
      <span className="text-right pr-1.5 text-[11px] leading-none tabular-nums text-muted-foreground">All day</span>
      <span />
      <div className="flex min-w-0 items-center gap-2 overflow-hidden border-b border-border/30 py-1">
        {events.map(event => (
          <button
            key={`${event.calendarId}:${event.id}`}
            type="button"
            onClick={() => onEventClick(event)}
            className="flex min-w-0 items-center gap-1.5 rounded px-1 text-left text-sm font-medium text-foreground hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid={`event-row-${event.id}`}
          >
            <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{event.summary}</span>
            {isHighPrep(event) && <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function DayTimeline({ rows, events, accountEmails, timezone, onEventClick }: {
  rows: DayHourRow[];
  events: CalendarEvent[];
  accountEmails: string[];
  timezone: string;
  onEventClick: (event: CalendarEvent) => void;
}) {
  const blocks = useMemo(() => getDayEventBlocks(rows, events, timezone), [rows, events, timezone]);
  if (rows.length === 0) return null;

  return (
    <div
      className="grid w-full grid-cols-[3.5rem_minmax(0,1fr)] pr-2"
      style={{ gridTemplateRows: `repeat(${rows.length}, 1.75rem)` }}
    >
      {rows.map((row, index) => (
        <div key={row.hour} className="contents" data-testid={`schedule-hour-${formatHourLabel(row.hour)}`}>
          <span
            className="self-center pr-2 text-right text-[11px] leading-none tabular-nums text-muted-foreground"
            style={{ gridColumn: 1, gridRow: index + 1 }}
          >
            {formatHourLabel(row.hour)}
          </span>
          <span className="border-b border-l border-border/30" style={{ gridColumn: 2, gridRow: index + 1 }} />
        </div>
      ))}
      {blocks.map(block => (
        <DayEventBlockView
          key={`${block.event.calendarId}:${block.event.id}`}
          block={block}
          accountEmails={accountEmails}
          onEventClick={onEventClick}
        />
      ))}
    </div>
  );
}

function DayEventBlockView({ block, accountEmails, onEventClick }: {
  block: DayEventBlock;
  accountEmails: string[];
  onEventClick: (event: CalendarEvent) => void;
}) {
  const { event, rowStart, rowSpan } = block;
  const [expanded, setExpanded] = useState(false);
  const { data } = useEventMetadata(event.id, event.accountId, event.calendarId);
  const { data: emailMapData } = useQuery<{ emailMap: Record<string, EmailPersonContext> }>({
    queryKey: ["/api/people/email-map"],
  });
  const isFocusBlock = data?.metadata?.eventType === "focus_block";
  const optional = isOptionalForMe(event);
  const external = hasExternalAttendees(event, accountEmails);
  const artifacts = data?.artifacts ?? [];
  const emailMap = emailMapData?.emailMap ?? {};
  const parentSourceRef: SimpleSourceRef = {
    type: "calendar",
    id: `${event.accountId}:${event.id}`,
    label: event.summary,
    href: `/schedule/${encodeURIComponent(event.id)}?calendarId=${encodeURIComponent(event.calendarId)}&accountId=${encodeURIComponent(event.accountId)}`,
  };
  const meetingReference = sourceRefToReferenceRef(parentSourceRef);
  const displayedAttendees = dedupeMeetingInvitees(
    (event.attendees ?? []).filter(attendee => !attendee.self && attendee.email),
    attendee => {
      const email = attendee.email.trim().toLowerCase();
      return { personId: emailMap[email]?.id, email };
    },
  );
  const contextChildren = [
    ...displayedAttendees.map(attendee => {
      const email = attendee.email.trim().toLowerCase();
      const matched = emailMap[email];
      return createMeetingPersonChild({
        key: `schedule-${event.accountId}-${event.id}-attendee-${email}`,
        section: "now",
        parentSourceRef,
        name: matched?.name ?? formatMeetingInviteeName(attendee.displayName, attendee.email),
        email: attendee.email,
        responseStatus: attendee.responseStatus,
        personId: matched?.id,
        profileSummary: matched?.summary,
        lastInteractionContext: matched?.lastInteractionContext,
        promotion: matched ? null : {
          eventId: event.id,
          accountId: event.accountId,
          calendarId: event.calendarId,
        },
      });
    }),
    ...artifacts.map(artifact => createMeetingArtifactChild({
      key: `schedule-${event.accountId}-${event.id}-artifact-${artifact.id}`,
      section: "now",
      title: artifact.title,
      libraryPageId: artifact.libraryPageId,
      slug: artifact.slug,
      artifactKind: artifact.artifactKind,
      source: artifact.source,
      summary: artifact.summary,
      oneLiner: artifact.oneLiner,
    })),
  ];
  const hasDetails = Boolean(event.location || contextChildren.length);
  const focusLabel = event.summary.replace(/^Focus:\s*/i, "");
  const isWellnessBlock = isFocusBlock && /^Wellness\b/i.test(focusLabel);

  if (isFocusBlock) {
    return (
      <button
        type="button"
        onClick={() => onEventClick(event)}
        className={cn(
          "z-20 my-0.5 flex min-h-0 min-w-0 items-start gap-1.5 overflow-hidden rounded-lg border border-l-4 border-primary/20 border-l-foreground/50 bg-card/70 py-1.5 pl-2.5 pr-1.5 text-left text-sm font-normal text-muted-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          optional && "opacity-60",
        )}
        style={{ gridColumn: 2, gridRow: `${rowStart} / span ${rowSpan}`, position: "relative" }}
        data-testid={`event-row-${event.id}`}
      >
        {isWellnessBlock ? (
          <Heart className="mt-px h-3.5 w-3.5 shrink-0 text-foreground/75" aria-hidden="true" />
        ) : (
          <EventTypeIcon event={event} eventType="focus_block" className="mt-px h-3.5 w-3.5 shrink-0 text-foreground/75" />
        )}
        <span className="truncate">{focusLabel}</span>
      </button>
    );
  }

  return (
    <div
      className={cn(
        "z-10 m-0.5 min-h-0 min-w-0 rounded-md bg-background/95",
        expanded ? "z-30 overflow-visible shadow-lg" : "overflow-hidden",
        optional && "opacity-60",
      )}
      style={{ gridColumn: 2, gridRow: `${rowStart} / span ${rowSpan}`, position: "relative" }}
      data-testid={`event-row-${event.id}`}
    >
      <div
        className={cn("group flex h-7 min-w-0 items-center gap-1.5 px-1.5 text-sm font-medium hover:bg-accent/50", hasDetails && "cursor-pointer")}
        onClick={() => hasDetails ? setExpanded(value => !value) : onEventClick(event)}
        role="button"
        tabIndex={0}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
          keyEvent.preventDefault();
          hasDetails ? setExpanded(value => !value) : onEventClick(event);
        }}
      >
        <span className="min-w-0" onClick={clickEvent => clickEvent.stopPropagation()}>
          {meetingReference ? (
            <ReferenceRenderer refValue={meetingReference} surface="simple-row" />
          ) : (
            <span className="truncate">{event.summary}</span>
          )}
        </span>
        {isHighPrep(event) && <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />}
        {external && <span className="shrink-0 text-[10px] text-muted-foreground">EXT</span>}
        {hasDetails && <ChevronRight className={cn("ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />}
      </div>
      {expanded && hasDetails && (
        <div className="space-y-1 border-t border-border/60 bg-background px-2 py-1.5 text-[11px] text-muted-foreground">
          {event.location && (
            <div className="flex min-w-0 items-center gap-1.5">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{event.location}</span>
            </div>
          )}
          {contextChildren.length > 0 && (
            <div className="pl-3">
              {contextChildren.map(child => (
                <SimpleTreeRow key={child.id} item={child} depth={1} layout="embedded" />
              ))}
            </div>
          )}
          {/* The meeting title reference is the event navigation affordance. */}
        </div>
      )}
    </div>
  );
}

function ScheduleEventRow({ event, mode, timezone, isExternal, isPersonal, onClick }: {
  event: CalendarEvent;
  calendarMap: Map<string, CalendarInfo>;
  mode: ScheduleMode;
  timezone: string;
  isExternal?: boolean;
  isPersonal?: boolean;
  onClick: () => void;
}) {
  const highPrep = isHighPrep(event);
  const optional = isOptionalForMe(event);
  const timeLabel = mode === "day"
    ? formatEventTime(event.start, event.end, timezone)
    : event.start.dateTime
      ? new Date(event.start.dateTime).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: timezone })
      : event.start.date
        ? fromCivilDate(event.start.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
        : "";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex min-h-11 w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left transition-colors",
        "hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        optional && "opacity-60"
      )}
      data-testid={`event-row-${event.id}`}
    >
      <span className="w-14 shrink-0 text-right pr-1.5 text-[11px] leading-tight tabular-nums text-muted-foreground">
        {timeLabel}
      </span>
      <span className="w-4 shrink-0" />
      <span className="relative min-w-0 flex-1 pl-0.5">
        <span className="pointer-events-none absolute inset-y-0 -left-3 w-4" aria-hidden="true">
          <span className="absolute bottom-1/2 left-0 top-0 border-l border-border/70" />
          <span className="absolute left-0 top-1/2 w-4 border-t border-border/70" />
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate text-sm font-medium", optional ? "text-muted-foreground" : "text-foreground")}>{event.summary}</span>
          {highPrep && <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />}
          {isPersonal && <span className="shrink-0 text-[10px] font-medium text-info-foreground">PERSONAL</span>}
          {isExternal && !isPersonal && <span className="shrink-0 text-[10px] font-medium text-cat-ai-foreground">EXT</span>}
          {optional && <span className="shrink-0 text-[10px] font-medium text-muted-foreground">OPT</span>}
        </span>
        {(event.location || (event.attendees?.length || 0) > 0) && (
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] leading-3 text-muted-foreground">
            {event.location ? (
              <span className="flex min-w-0 items-center gap-1">
                <MapPin className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{event.location}</span>
              </span>
            ) : null}
            {(event.attendees?.length || 0) > 0 ? (
              <span className="flex shrink-0 items-center gap-1">
                <Users className="h-2.5 w-2.5" />
                {event.attendees!.length}
              </span>
            ) : null}
          </span>
        )}
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
    </button>
  );
}

function EventCard({ event, calendarMap, onClick, isExternal, isPersonal, timezone }: { event: CalendarEvent; calendarMap: Map<string, CalendarInfo>; onClick: () => void; isExternal?: boolean; isPersonal?: boolean; timezone?: string }) {
  const highPrep = isHighPrep(event);
  const optional = isOptionalForMe(event);

  const borderClass = isPersonal
    ? "border-l-2 border-l-info dark:border-l-info"
    : isExternal
      ? "border-l-2 border-l-cat-ai"
      : "";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left p-2 rounded-md hover-elevate transition-colors group",
        borderClass,
        optional && "border border-dashed border-border opacity-60"
      )}
      data-testid={`event-card-${event.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-muted-foreground">{formatEventTime(event.start, event.end, timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}</span>
          {highPrep && <Star className="h-3 w-3 text-warning fill-warning" />}
          {isPersonal && <span className="text-xs font-medium text-info-foreground">PERSONAL</span>}
          {isExternal && !isPersonal && <span className="text-xs font-medium text-cat-ai-foreground">EXT</span>}
          {optional && <span className="text-xs font-medium text-muted-foreground">OPT</span>}
        </div>
        <p className={cn("text-sm font-medium truncate", optional && "font-normal")}>{event.summary}</p>
        {event.location && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span className="truncate">{event.location}</span>
          </span>
        )}
        {(event.attendees?.length || 0) > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Users className="h-3 w-3" />
            {event.attendees!.length}
          </span>
        )}
      </div>
    </button>
  );
}

function DayView({ date, events, calendarMap, loading, onEventClick, accountEmails, timezone }: {
  date: Date; events: CalendarEvent[]; calendarMap: Map<string, CalendarInfo>; loading: boolean; onEventClick: (e: CalendarEvent) => void; accountEmails: string[]; timezone: string;
}) {
  const dayEvents = useMemo(() => events.filter(e => eventMatchesCalendarDay(e, date, timezone)), [events, date, timezone]);
  const allDayEvents = dayEvents.filter(isAllDay);
  const timedEvents = dayEvents.filter(e => !isAllDay(e));
  const hours = Array.from({ length: 16 }, (_, i) => i + 7);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div data-testid="day-view">
      {allDayEvents.length > 0 && (
        <div className="mb-3 space-y-1" data-testid="all-day-events">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">All Day</span>
          {allDayEvents.map(e => <EventCard key={e.id} event={e} calendarMap={calendarMap} onClick={() => onEventClick(e)} isExternal={hasExternalAttendees(e, accountEmails)} isPersonal={isPersonalAccount(e.accountEmail)} timezone={timezone} />)}
        </div>
      )}
      <div className="space-y-0">
        {hours.map(hour => {
          const label = hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`;
          const hourEvents = timedEvents.filter(e => getEventHour(e, timezone) === hour);
          return (
            <div key={hour} className="flex gap-3 min-h-[48px] border-t border-border/30" data-testid={`time-slot-${hour}`}>
              <span className="text-xs text-muted-foreground w-16 shrink-0 pt-1 text-right">{label}</span>
              <div className="flex-1 py-0.5">
                {hourEvents.map(e => <EventCard key={e.id} event={e} calendarMap={calendarMap} onClick={() => onEventClick(e)} isExternal={hasExternalAttendees(e, accountEmails)} isPersonal={isPersonalAccount(e.accountEmail)} timezone={timezone} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getEventDurationMinutes(event: CalendarEvent): number {
  if (!event.start.dateTime || !event.end.dateTime) return 60;
  const s = new Date(event.start.dateTime).getTime();
  const e = new Date(event.end.dateTime).getTime();
  return Math.max(15, (e - s) / 60000);
}

function getEventStartMinutes(event: CalendarEvent, timezone: string): number {
  if (!event.start.dateTime) return 0;
  const p = getPartsInTimezone(event.start.dateTime, timezone);
  return p.hour * 60 + p.minute;
}

function computeOverlapColumns(events: CalendarEvent[], timezone: string): Map<string, { col: number; totalCols: number }> {
  const result = new Map<string, { col: number; totalCols: number }>();
  if (events.length === 0) return result;

  const sorted = [...events].sort((a, b) => getEventStartMinutes(a, timezone) - getEventStartMinutes(b, timezone));

  const groups: CalendarEvent[][] = [];
  for (const ev of sorted) {
    const evStart = getEventStartMinutes(ev, timezone);
    const evEnd = evStart + getEventDurationMinutes(ev);
    let placed = false;
    for (const group of groups) {
      const groupStart = Math.min(...group.map(e => getEventStartMinutes(e, timezone)));
      const groupEnd = Math.max(...group.map(e => getEventStartMinutes(e, timezone) + getEventDurationMinutes(e)));
      if (evStart < groupEnd && evEnd > groupStart) {
        group.push(ev);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([ev]);
  }

  for (const group of groups) {
    const columns: CalendarEvent[][] = [];
    const groupSorted = [...group].sort((a, b) => getEventStartMinutes(a, timezone) - getEventStartMinutes(b, timezone));
    for (const ev of groupSorted) {
      const evStart = getEventStartMinutes(ev, timezone);
      let placedInCol = false;
      for (let c = 0; c < columns.length; c++) {
        const lastInCol = columns[c][columns[c].length - 1];
        const lastEnd = getEventStartMinutes(lastInCol, timezone) + getEventDurationMinutes(lastInCol);
        if (evStart >= lastEnd) {
          columns[c].push(ev);
          placedInCol = true;
          break;
        }
      }
      if (!placedInCol) {
        columns.push([ev]);
      }
    }
    const totalCols = columns.length;
    columns.forEach((col, colIndex) => {
      col.forEach(ev => {
        result.set(ev.id, { col: colIndex, totalCols });
      });
    });
  }

  return result;
}

function WeekView({ date, events, calendarMap, loading, onEventClick, accountEmails, timezone }: {
  date: Date; events: CalendarEvent[]; calendarMap: Map<string, CalendarInfo>; loading: boolean; onEventClick: (e: CalendarEvent) => void; accountEmails: string[]; timezone: string;
}) {
  const { start } = getWeekRange(date);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  }), [start]);

  const hours = Array.from({ length: 16 }, (_, i) => i + 7);
  const HOUR_HEIGHT = 48;
  const START_HOUR = 7;
  const TOTAL_HOURS = 16;

  const dayData = useMemo(() => days.map(day => {
    const dayEvents = events.filter(e => eventMatchesCalendarDay(e, day, timezone));
    const allDay = dayEvents.filter(isAllDay);
    const timed = dayEvents.filter(e => !isAllDay(e));
    const overlapMap = computeOverlapColumns(timed, timezone);
    return { day, allDay, timed, overlapMap };
  }), [days, events, timezone]);

  const hasAnyAllDay = dayData.some(d => d.allDay.length > 0);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div data-testid="week-view">
      <div className="flex">
        <div className="w-14 shrink-0" />
        <div className="flex-1 grid grid-cols-7 gap-px">
          {dayData.map(({ day }) => {
            const dayLabel = day.toLocaleDateString([], { weekday: "short" });
            const dayNum = day.getDate();
            const today = isToday(day);
            return (
              <div key={day.toISOString()} className="text-center py-1.5" data-testid={`week-day-${dayNum}`}>
                <span className="text-xs text-muted-foreground">{dayLabel}</span>
                <span className={cn(
                  "ml-1 text-sm font-medium",
                  today && "text-primary font-semibold"
                )}>
                  {dayNum}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {hasAnyAllDay && (
        <div className="flex border-b border-border/40 mb-1">
          <div className="w-14 shrink-0 text-right pr-2 pt-1">
            <span className="text-xs text-muted-foreground uppercase">All Day</span>
          </div>
          <div className="flex-1 grid grid-cols-7 gap-px">
            {dayData.map(({ day, allDay }) => (
              <div key={day.toISOString()} className="px-0.5 py-1 space-y-0.5 min-h-[28px]">
                {allDay.map(e => {
                  const highPrep = isHighPrep(e);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onEventClick(e)}
                      className="w-full flex items-center gap-0.5 text-left text-xs leading-tight font-medium truncate px-1 py-0.5 rounded bg-primary/10 hover-elevate"
                      data-testid={`event-card-${e.id}`}
                    >
                      {highPrep && <Star className="h-2.5 w-2.5 text-warning fill-warning shrink-0" />}
                      <span className="truncate">{e.summary}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex">
        <div className="w-14 shrink-0">
          {hours.map(hour => {
            const label = hour === 0 ? "12 AM" : hour < 12 ? `${hour} AM` : hour === 12 ? "12 PM" : `${hour - 12} PM`;
            return (
              <div key={hour} style={{ height: HOUR_HEIGHT }} className="relative">
                <span className="absolute -top-2 right-2 text-xs text-muted-foreground">{label}</span>
              </div>
            );
          })}
        </div>
          <div className="flex-1 grid grid-cols-7 gap-px">
            {dayData.map(({ day, timed, overlapMap }) => {
              const today = isToday(day);
              return (
                <div
                  key={day.toISOString()}
                  className={cn("relative border-l border-border/20", today && "bg-primary/[0.02]")}
                  style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}
                >
                  {hours.map(hour => (
                    <div
                      key={hour}
                      className="absolute w-full border-t border-border/20"
                      style={{ top: (hour - START_HOUR) * HOUR_HEIGHT }}
                    />
                  ))}
                  {timed.map(e => {
                    const startMin = getEventStartMinutes(e, timezone);
                    const duration = getEventDurationMinutes(e);
                    const endMin = startMin + duration;
                    const visibleStart = START_HOUR * 60;
                    const visibleEnd = (START_HOUR + TOTAL_HOURS) * 60;
                    const renderStart = Math.max(startMin, visibleStart);
                    const renderEnd = Math.min(endMin, visibleEnd);
                    if (renderEnd <= renderStart) return null;
                    const topPx = ((renderStart / 60) - START_HOUR) * HOUR_HEIGHT;
                    const heightPx = Math.max(16, ((renderEnd - renderStart) / 60) * HOUR_HEIGHT);
                    const overlap = overlapMap.get(e.id) || { col: 0, totalCols: 1 };
                    const widthPercent = 100 / overlap.totalCols;
                    const leftPercent = overlap.col * widthPercent;
                    const highPrep = isHighPrep(e);
                    const external = hasExternalAttendees(e, accountEmails);
                    const optional = isOptionalForMe(e);

                    let accentColor: string;
                    let bgColor: string;
                    if (highPrep) {
                      accentColor = "#d97706";
                      bgColor = "rgba(217, 119, 6, 0.12)";
                    } else if (external) {
                      accentColor = "#8b5cf6";
                      bgColor = "rgba(139, 92, 246, 0.12)";
                    } else {
                      const cal = calendarMap.get(e.calendarId);
                      accentColor = cal?.backgroundColor || "#4285f4";
                      bgColor = (cal?.backgroundColor || "#4285f4") + "22";
                    }

                    return (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => onEventClick(e)}
                        className={cn(
                          "absolute rounded px-1 py-0.5 text-xs leading-tight overflow-hidden hover-elevate cursor-pointer",
                          optional
                            ? "border border-dashed opacity-50"
                            : "border border-white/20 dark:border-black/20"
                        )}
                        style={{
                          position: 'absolute' as const,
                          top: topPx,
                          height: heightPx,
                          left: `${leftPercent}%`,
                          width: `calc(${widthPercent}% - 2px)`,
                          backgroundColor: bgColor,
                          borderLeftColor: accentColor,
                          borderLeftWidth: 2,
                          ...(optional ? { borderColor: accentColor } : {}),
                        }}
                        data-testid={`event-card-${e.id}`}
                      >
                        <div className="flex items-center gap-0.5">
                          <span className="font-medium truncate">{e.summary}</span>
                          {highPrep && <Star className="h-2.5 w-2.5 text-warning fill-warning shrink-0" />}
                        </div>
                        {heightPx > 28 && (
                          <span className="text-xs text-muted-foreground block truncate">
                            {formatEventTime(e.start, e.end, timezone)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
      </div>
    </div>
  );
}

function MonthView({ date, events, calendarMap, loading, onDayClick, onEventClick, memoryByDay, timezone }: {
  date: Date; events: CalendarEvent[]; calendarMap: Map<string, CalendarInfo>; loading: boolean; onDayClick: (d: Date) => void; onEventClick: (e: CalendarEvent) => void; memoryByDay?: Map<string, Array<{ entryId: number; title: string | null }>>; timezone: string;
}) {
  const [, navigate] = useLocation();
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  const startDay = monthStart.getDay() === 0 ? 6 : monthStart.getDay() - 1;
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

  const cells = useMemo(() => {
    const arr: (Date | null)[] = [];
    for (let i = 0; i < startDay; i++) arr.push(null);
    for (let i = 1; i <= daysInMonth; i++) arr.push(new Date(date.getFullYear(), date.getMonth(), i));
    while (arr.length < 42) arr.push(null);
    return arr;
  }, [date, startDay, daysInMonth]);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  return (
    <div data-testid="month-view">
      <div className="grid grid-cols-7 gap-1 mb-1">
        {weekdays.map(w => (
          <span key={w} className="text-xs text-muted-foreground text-center font-medium py-1">{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} className="min-h-[60px] @md:min-h-[80px]" />;
          const today = isToday(cell);
          const dayEvents = events.filter(e => eventMatchesCalendarDay(e, cell, timezone));
          return (
            <div
              key={i}
              onClick={() => onDayClick(cell)}
              className={cn(
                "min-h-[60px] @md:min-h-[80px] p-1 rounded-md text-left hover-elevate border border-transparent cursor-pointer",
                today && "border-primary/40 bg-primary/5 dark:bg-primary/10"
              )}
              data-testid={`month-day-${cell.getDate()}`}
            >
              <span className={cn(
                "text-xs font-medium",
                today ? "text-primary" : "text-foreground"
              )}>
                {cell.getDate()}
              </span>
              {(() => {
                const flagged = dayEvents.filter(e => isHighPrep(e));
                const unflagged = dayEvents.filter(e => !isHighPrep(e));
                return (
                  <div className="flex flex-col gap-0.5 mt-0.5 w-full overflow-hidden">
                    {flagged.map(e => {
                      const cal = calendarMap.get(e.calendarId);
                      return (
                        <div
                          key={e.id}
                          role="button"
                          tabIndex={0}
                          onClick={(ev) => { ev.stopPropagation(); onEventClick(e); }}
                          onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.stopPropagation(); ev.preventDefault(); onEventClick(e); } }}
                          className="flex items-center gap-1 rounded px-1 py-0.5 text-xs leading-tight font-medium truncate bg-warning/10 dark:bg-warning/10 text-warning-foreground hover-elevate w-full text-left"
                          aria-label={`Prep required: ${e.summary}`}
                          data-testid={`month-flagged-event-${e.id}`}
                        >
                          <Star className="h-2.5 w-2.5 text-warning fill-warning shrink-0" />
                          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: cal?.backgroundColor || "#4285f4" }} />
                          <span className="truncate">{e.summary}</span>
                        </div>
                      );
                    })}
                    {unflagged.length > 0 && (
                      <div className="flex flex-wrap gap-0.5">
                        {unflagged.map(e => {
                          const cal = calendarMap.get(e.calendarId);
                          return (
                            <span
                              key={e.id}
                              className="h-1.5 w-1.5 rounded-full shrink-0"
                              style={{ backgroundColor: cal?.backgroundColor || "#4285f4" }}
                              title={e.summary}
                            />
                          );
                        })}
                      </div>
                    )}
                    {(() => {
                      const dayKey = `${cell.getFullYear()}-${String(cell.getMonth() + 1).padStart(2, "0")}-${String(cell.getDate()).padStart(2, "0")}`;
                      const dayMemories = memoryByDay?.get(dayKey);
                      if (!dayMemories?.length) return null;
                      return (
                        <div className="flex flex-wrap gap-0.5 mt-0.5" data-testid={`memory-indicator-${cell.getDate()}`}>
                          {dayMemories.slice(0, 5).map((mem) => (
                            <Brain
                              key={mem.entryId}
                              className="h-2.5 w-2.5 text-cat-ai/60 hover:text-cat-ai cursor-pointer transition-colors"
                              aria-label={mem.title || `Entry #${mem.entryId}`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                navigate(`/memory?tab=log&entryId=${mem.entryId}`);
                              }}
                              data-testid={`memory-icon-${mem.entryId}`}
                            />
                          ))}
                          {dayMemories.length > 5 && (
                            <span className="text-xs text-cat-ai/60" title={`${dayMemories.length - 5} more memories`}>+{dayMemories.length - 5}</span>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}



function BandwidthSummaryCard({ summary, loading, timezone }: { summary?: BandwidthSummary; loading: boolean; timezone: string }) {
  const [open, setOpen] = useState(false);
  const totalMinutes = summary?.totalFocusMinutes ?? 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="mb-1 flex w-full items-center justify-between rounded-md border border-border/40 bg-card px-3 py-2 text-left transition-colors hover:bg-muted/35" data-testid="bandwidth-summary-trigger">
        <span className="flex items-center gap-2">
          <Brain className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm font-semibold">{loading ? "Calculating focus hours" : `${formatMinutesAsHours(totalMinutes)} Focus Hours`}</span>
        </span>
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-2 rounded-md border border-border/40 bg-card p-3" data-testid="bandwidth-summary-breakdown">
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-48" />
            </div>
          ) : !summary || totalMinutes === 0 ? (
            <p className="text-xs text-muted-foreground">No tagged focus blocks in this range. Empty calendar space does not count as bandwidth.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4">
                {CAPACITY_ORDER.map(type => {
                  const minutes = summary.byCapacityType[type] ?? 0;
                  return (
                    <div key={type} className="rounded-md bg-muted/45 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{CAPACITY_LABELS[type]}</div>
                      <div className="font-semibold text-foreground">{formatMinutesAsHours(minutes)}</div>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-1">
                {summary.blocks.slice(0, 8).map(block => (
                  <div key={`${block.accountId}:${block.calendarId}:${block.eventId}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-muted-foreground">
                      {formatEventTime(block.start, block.end, timezone)} · {block.summary}
                    </span>
                    <span className="shrink-0 font-medium text-foreground">{CAPACITY_LABELS[block.capacityType]} · {formatMinutesAsHours(block.minutes)}</span>
                  </div>
                ))}
                {summary.blocks.length > 8 ? <div className="text-xs text-muted-foreground">+{summary.blocks.length - 8} more focus blocks</div> : null}
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
