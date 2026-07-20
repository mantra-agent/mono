import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Calendar as CalendarIcon,
  Clock,
  Brain,
  MapPin,
  Users,
  Star,
  Trash2,
  Loader2,
  UserPlus,
  Link as LinkIcon,
  X,
  Plus,
  MoreHorizontal,
  Shapes,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useTimezone } from "@/hooks/use-timezone";
import { usePageHeader } from "@/hooks/use-page-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  eventMetadataQueryKey,
  useEventMetadata,
  type LinkedPersonRef,
} from "@/components/calendar/use-event-metadata";
import { ExpandableLibraryPage } from "@/components/library/inline-library-page";
import { ProfileTreeRow } from "@/components/profile-tree-row";

// --- Shared types (duplicated from calendar.tsx for now, will extract later) ---

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

const EVENT_TYPES = [
  { value: "focus_block", label: "Focus" },
  { value: "meeting", label: "Meeting" },
  { value: "travel", label: "Travel" },
] as const;

type EventTypeValue = (typeof EVENT_TYPES)[number]["value"];

const CAPACITY_TYPES = [
  { value: "deep_work", label: "Deep Work" },
  { value: "responsive", label: "Responsive" },
  { value: "admin", label: "Admin" },
  { value: "wellness", label: "Wellness" },
  { value: "personal", label: "Personal" },
  { value: "creative", label: "Creative" },
  { value: "flexible", label: "Flexible" },
] as const;

type CapacityTypeValue = (typeof CAPACITY_TYPES)[number]["value"];
type CapacitySelectValue = CapacityTypeValue | "untyped";

function isEventTypeValue(value: string | null | undefined): value is EventTypeValue {
  return !!value && EVENT_TYPES.some(type => type.value === value);
}

interface CalendarMetadata {
  id: number;
  googleEventId: string;
  accountId: string;
  calendarId: string;
  eventType: EventTypeValue | null;
  capacityType: CapacityTypeValue | null;
  notes: string | null;
  agenda: string | null;
  speakerPolicy: { mode: "participant_streams" } | { mode: "shared_room" } | {
    /** @deprecated Read-only compatibility for existing metadata. */
    mode: "selected_shared_streams";
    sharedStreams: Array<{ selector: { attendeeEmail?: string; participantLabel?: string } }>;
  } | null;
  linkedPeople: LinkedPersonRef[];
}

const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me", "live.com", "msn.com",
]);

function isPersonalAccount(email: string): boolean {
  return PERSONAL_DOMAINS.has(email.split("@")[1]?.toLowerCase() || "");
}

function isHighPrep(event: CalendarEvent): boolean {
  const desc = event.description || "";
  if (desc.includes("[no-prep]")) return false;
  if (desc.includes("[prep-required]")) return true;
  if (isPersonalAccount(event.accountEmail)) return true;
  if (event.accountEmail && event.attendees && event.attendees.length > 0) {
    const orgDomain = event.accountEmail.split("@")[1]?.toLowerCase();
    if (orgDomain) {
      return event.attendees.some(a => {
        if (a.self) return false;
        const domain = a.email.split("@")[1]?.toLowerCase();
        return !!domain && domain !== orgDomain;
      });
    }
  }
  return false;
}

function isHighPrepWithoutTags(event: CalendarEvent): boolean {
  if (isPersonalAccount(event.accountEmail)) return true;
  if (event.accountEmail && event.attendees && event.attendees.length > 0) {
    const orgDomain = event.accountEmail.split("@")[1]?.toLowerCase();
    if (orgDomain) {
      return event.attendees.some(a => {
        if (a.self) return false;
        const domain = a.email.split("@")[1]?.toLowerCase();
        return !!domain && domain !== orgDomain;
      });
    }
  }
  return false;
}

function toISOLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}:00`;
}

function cleanDescription(desc: string): string {
  return desc.replace(/\n?\[prep-required\]/g, "").replace(/\n?\[no-prep\]/g, "").trim();
}

function resolveEventCalendar(
  calendars: CalendarInfo[],
  selectedCalendarId: string,
  selectedAccountId?: string,
): CalendarInfo | undefined {
  return calendars.find(calendar =>
    calendar.id === selectedCalendarId &&
    (!selectedAccountId || calendar.accountId === selectedAccountId),
  ) ?? (
    selectedCalendarId === "primary"
      ? calendars.find(calendar => calendar.primary && (!selectedAccountId || calendar.accountId === selectedAccountId))
      : undefined
  );
}

// --- Component ---

interface EventDetailViewProps {
  eventId: string; // "new" for create mode
  calendarId?: string; // from query param
  accountId?: string; // from query param
  startTime?: string; // pre-populated start for create mode
  endTime?: string; // pre-populated end for create mode
}

export function EventDetailView({ eventId, calendarId, accountId, startTime: initStart, endTime: initEnd }: EventDetailViewProps) {
  const [, navigate] = useLocation();
  const { timezone } = useTimezone();
  const { toast } = useToast();
  const isCreate = eventId === "new";

  // --- Calendar list (needed for calendar picker) ---
  const { data: calendarsData } = useQuery<{ calendars: CalendarInfo[] }>({
    queryKey: ["/api/calendar/calendars"],
  });
  const calendars = calendarsData?.calendars || [];

  // --- Fetch event data (edit mode only) ---
  const { data: eventData, isLoading: eventLoading } = useQuery<CalendarEvent>({
    queryKey: ["/api/calendar/events", eventId, calendarId, accountId],
    queryFn: async () => {
      const res = await fetch(
        `/api/calendar/events/${encodeURIComponent(eventId)}?calendarId=${encodeURIComponent(calendarId || "")}&accountId=${encodeURIComponent(accountId || "")}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json();
    },
    enabled: !isCreate && !!calendarId && !!accountId,
  });

  // --- Metadata (edit mode only) ---
  const metadataQueryKey = eventMetadataQueryKey(eventId, accountId, calendarId);
  const { data: metadataData, isLoading: metaLoading } = useEventMetadata(eventId, accountId, calendarId, !isCreate);
  const metadata: CalendarMetadata | null = metadataData?.metadata
    ? {
        ...(metadataData.metadata as Omit<CalendarMetadata, "linkedPeople">),
        eventType: isEventTypeValue(metadataData.metadata.eventType) ? metadataData.metadata.eventType : null,
        capacityType: (metadataData.metadata.capacityType as CapacityTypeValue | null) ?? null,
        linkedPeople: metadataData.people,
      }
    : null;
  const sharedRoomEnabled = metadata?.speakerPolicy?.mode === "shared_room"
    || metadata?.speakerPolicy?.mode === "selected_shared_streams";

  // --- Email map for people linking ---
  const { data: emailMapData } = useQuery<{ emailMap: Record<string, { id: string; name: string }> }>({
    queryKey: ["/api/people/email-map"],
    enabled: !isCreate && (eventData?.attendees?.length ?? 0) > 0,
  });
  const emailMap = emailMapData?.emailMap || {};

  // --- Form state ---
  function getDefaultStart() {
    if (initStart) return initStart.slice(0, 16);
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    return toISOLocal(now).slice(0, 16);
  }
  function getDefaultEnd() {
    if (initEnd) return initEnd.slice(0, 16);
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 2);
    return toISOLocal(now).slice(0, 16);
  }

  const [title, setTitle] = useState("");
  const [start, setStart] = useState(getDefaultStart);
  const [end, setEnd] = useState(getDefaultEnd);
  const [location, setLocation] = useState("");
  const [description, setDescription] = useState("");
  const [selectedCalendarId, setSelectedCalendarId] = useState(calendarId || calendars[0]?.id || "");
  const [attendeesInput, setAttendeesInput] = useState("");
  const [prepRequired, setPrepRequired] = useState(false);
  const [recurrenceType, setRecurrenceType] = useState<string>("none");
  const [recurrenceInterval, setRecurrenceInterval] = useState(1);
  const [recurrenceEndType, setRecurrenceEndType] = useState<"never" | "count" | "until">("never");
  const [recurrenceCount, setRecurrenceCount] = useState(10);
  const [recurrenceUntil, setRecurrenceUntil] = useState("");
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState<string[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showRecurringScopeDialog, setShowRecurringScopeDialog] = useState(false);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const agendaPage = metadataData?.artifacts.find(artifact => artifact.artifactKind === "agenda") ?? null;
  const [initialized, setInitialized] = useState(isCreate);

  // Populate form from fetched event data
  useEffect(() => {
    if (!isCreate && eventData && !initialized) {
      setTitle(eventData.summary || "");
      setStart(eventData.start.dateTime ? toISOLocal(new Date(eventData.start.dateTime)).slice(0, 16) : getDefaultStart());
      setEnd(eventData.end.dateTime ? toISOLocal(new Date(eventData.end.dateTime)).slice(0, 16) : getDefaultEnd());
      setLocation(eventData.location || "");
      setDescription(cleanDescription(eventData.description || ""));
      setSelectedCalendarId(eventData.calendarId || calendarId || calendars[0]?.id || "");
      setAttendeesInput((eventData.attendees ?? []).map(a => a.email).join(", "));
      setPrepRequired(isHighPrep(eventData));
      setInitialized(true);
    }
  }, [eventData, isCreate, initialized]);

  // Agenda content is hydrated directly from the linked Library page.

  useEffect(() => {
    const nextTarget = document.getElementById("schedule-event-header-slot");
    if (nextTarget !== headerTarget) setHeaderTarget(nextTarget);
  });

  // Set default calendar when calendars load for create mode
  useEffect(() => {
    if (isCreate && calendars.length > 0 && !selectedCalendarId) {
      setSelectedCalendarId(calendars[0]?.id || "");
    }
  }, [isCreate, calendars, selectedCalendarId]);

  const selectedCal = resolveEventCalendar(calendars, selectedCalendarId, accountId || eventData?.accountId);
  const selectedAccountId = selectedCal?.accountId || accountId || eventData?.accountId || "";
  const isReadOnly = !isCreate && Boolean(selectedCal && !["owner", "writer"].includes(selectedCal.accessRole));
  const calendarLabel = selectedCal?.summary || eventData?.accountEmail || selectedCalendarId;
  const calendarAccountLabel = selectedCal?.accountEmail || eventData?.accountEmail;

  const detailHeaderContent = useMemo(() => {
    if (isCreate) {
      return (
        <div className="flex min-w-0 items-center gap-1 text-sm font-medium text-foreground">
          <button
            type="button"
            className="shrink-0 text-muted-foreground transition-colors hover:text-cta focus-visible:outline-none focus-visible:text-cta"
            onClick={() => navigate("/schedule")}
            aria-label="Back to Schedule"
            data-testid="button-schedule-breadcrumb"
          >
            Schedule
          </button>
          <span className="shrink-0 text-muted-foreground/60">/</span>
          <span className="truncate">New Event</span>
        </div>
      );
    }

    return (
      <div className="flex min-w-0 items-center gap-1 text-sm font-medium text-foreground">
        <button
          type="button"
          className="shrink-0 text-muted-foreground transition-colors hover:text-cta focus-visible:outline-none focus-visible:text-cta"
          onClick={() => navigate("/schedule")}
          aria-label="Back to Schedule"
          data-testid="button-schedule-breadcrumb"
        >
          Schedule
        </button>
        <span className="shrink-0 text-muted-foreground/60">/</span>
        <div id="schedule-event-header-slot" className="flex min-w-0 flex-1 items-center" />
      </div>
    );
  }, [isCreate, navigate]);

  usePageHeader({
    title: `Schedule / ${isCreate ? "New Event" : title || "Event"}`,
    customContent: detailHeaderContent,
  });

  // --- Save mutation (create or update) ---
  const saveMutation = useMutation({
    mutationFn: async (scope?: "this" | "all") => {
      const attendees = attendeesInput
        .split(",")
        .map(e => e.trim())
        .filter(Boolean)
        .map(email => ({ email }));
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

      const descBase = description.trim();
      let descFinal: string | undefined;
      if (prepRequired) {
        descFinal = descBase ? descBase + "\n[prep-required]" : "[prep-required]";
      } else if (!isCreate && eventData && isHighPrepWithoutTags(eventData)) {
        descFinal = descBase ? descBase + "\n[no-prep]" : "[no-prep]";
      } else {
        descFinal = descBase || undefined;
      }

      // Build recurrence RRULE for create only
      let recurrence: string[] | undefined;
      if (isCreate && recurrenceType !== "none") {
        const freqMap: Record<string, string> = {
          daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY", weekdays: "WEEKLY",
        };
        const parts: string[] = [`FREQ=${freqMap[recurrenceType] || "DAILY"}`];
        if (recurrenceType === "weekdays") {
          parts.push("BYDAY=MO,TU,WE,TH,FR");
        } else if (recurrenceType === "weekly" && recurrenceWeekdays.length > 0) {
          parts.push(`BYDAY=${recurrenceWeekdays.join(",")}`);
        }
        if (recurrenceInterval > 1 && recurrenceType !== "weekdays") {
          parts.push(`INTERVAL=${recurrenceInterval}`);
        }
        if (recurrenceEndType === "count") {
          parts.push(`COUNT=${recurrenceCount}`);
        } else if (recurrenceEndType === "until" && recurrenceUntil) {
          parts.push(`UNTIL=${recurrenceUntil.replace(/-/g, "")}T235959Z`);
        }
        recurrence = [`RRULE:${parts.join(";")}`];
      }

      const eventPayload = {
        summary: title,
        description: descFinal,
        location: location || undefined,
        start: { dateTime: new Date(start).toISOString(), timeZone: tz },
        end: { dateTime: new Date(end).toISOString(), timeZone: tz },
        attendees: attendees.length > 0 ? attendees : undefined,
        ...(recurrence ? { recurrence } : {}),
      };

      if (isCreate) {
        const res = await apiRequest("POST", "/api/calendar/events", {
          calendarId: selectedCalendarId,
          accountId: selectedAccountId,
          event: eventPayload,
        });
        return res;
      }

      // For recurring events, "all" scope patches the base event. Private
      // metadata remains attached to this concrete meeting occurrence.
      const targetEventId = scope === "all" && eventData?.recurringEventId
        ? eventData.recurringEventId
        : eventId;

      await apiRequest("PATCH", `/api/calendar/events/${targetEventId}`, {
        calendarId: calendarId || selectedCalendarId,
        accountId: accountId || selectedAccountId,
        event: eventPayload,
      });

      // Agenda edits autosave through the linked Library page editor.
      return null;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/metadata"] });
      toast({ title: isCreate ? "Event created" : "Event updated" });
      if (isCreate) {
        navigate("/schedule");
      }
    },
    onError: (err: any) => {
      toast({
        title: isCreate ? "Failed to create event" : "Failed to update event",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // --- Delete mutation ---
  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest(
        "DELETE",
        `/api/calendar/events/${eventId}?calendarId=${encodeURIComponent(calendarId || selectedCalendarId)}&accountId=${encodeURIComponent(accountId || selectedAccountId)}`,
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/events"] });
      toast({ title: "Event deleted" });
      navigate("/schedule");
    },
    onError: (err: any) => {
      toast({ title: "Failed to delete event", description: err.message, variant: "destructive" });
    },
  });

  // --- Metadata mutations ---
  const setSpeakerPolicyMutation = useMutation({
    mutationFn: async (sharedRoom: boolean) => {
      await apiRequest("POST", "/api/calendar/metadata", {
        googleEventId: eventId,
        accountId: accountId || selectedAccountId,
        calendarId: calendarId || selectedCalendarId,
        eventType: metadata?.eventType || "meeting",
        speakerPolicy: { mode: sharedRoom ? "shared_room" : "participant_streams" },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: metadataQueryKey }),
    onError: (err: any) => toast({ title: "Failed to update shared room audio", description: err.message, variant: "destructive" }),
  });

  const setTypeMutation = useMutation({
    mutationFn: async ({ eventType, capacityType }: { eventType: EventTypeValue; capacityType?: CapacityTypeValue | null }) => {
      await apiRequest("POST", "/api/calendar/metadata", {
        googleEventId: eventId,
        accountId: accountId || selectedAccountId,
        calendarId: calendarId || selectedCalendarId,
        eventType,
        capacityType: eventType === "focus_block" ? capacityType ?? metadata?.capacityType ?? null : null,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/calendar/metadata"] }),
    onError: (err: any) => toast({ title: "Failed to update event type", description: err.message, variant: "destructive" }),
  });

  const canSubmit = title.trim().length > 0 && selectedCalendarId && start && end;

  // --- Loading state ---
  if (!isCreate && (eventLoading || !initialized)) {
    return (
      <div className="flex h-full flex-col overflow-hidden" data-testid="event-detail-loading">
        <div className="p-4 space-y-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="event-detail-view">
      {!isCreate && headerTarget && createPortal(
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {eventData?.htmlLink ? (
            <a
              href={eventData.htmlLink}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground transition-colors hover:text-cta"
              title={`Open ${title || "Event"} in Google Calendar`}
              data-testid="link-event-title"
            >
              {title || "Event"}
            </a>
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" data-testid="event-title">
              {title || "Event"}
            </span>
          )}
          {!isReadOnly && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-muted-foreground"
                  disabled={deleteMutation.isPending}
                  aria-label="Event actions"
                  data-testid="button-event-actions-menu"
                >
                  {deleteMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <MoreHorizontal className="h-3.5 w-3.5" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[140px]" onCloseAutoFocus={event => event.preventDefault()}>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                  data-testid="menu-delete-event"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>,
        headerTarget,
      )}

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4 max-w-lg">
          {!isCreate && eventData && isPersonalAccount(eventData.accountEmail) && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="no-default-hover-elevate no-default-active-elevate text-info-foreground border-info/30 dark:text-info dark:border-info/50" data-testid="badge-personal">
                Personal
              </Badge>
            </div>
          )}

          {isCreate && (
            <Input
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="Event title"
              className="text-lg font-semibold h-auto py-1.5 px-2 border-transparent hover:border-border focus:border-border transition-colors"
              data-testid="input-event-title"
            />
          )}

          <div className="overflow-hidden rounded-md border border-border/20" data-testid="event-core-fields">
            {!isCreate && (
              <ProfileTreeRow
                label="Event Type"
                icon={<Shapes className="h-3.5 w-3.5" />}
                hasValue
                showEmpty
                mobileLayout="inline"
                testId="row-event-type"
              >
                <Select
                  value={isEventTypeValue(metadata?.eventType) ? metadata.eventType : undefined}
                  onValueChange={value => setTypeMutation.mutate({ eventType: value as EventTypeValue })}
                  disabled={setTypeMutation.isPending || isReadOnly}
                >
                  <SelectTrigger data-testid="select-event-type">
                    <SelectValue placeholder="Classify" />
                  </SelectTrigger>
                  <SelectContent>
                    {EVENT_TYPES.map(type => (
                      <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </ProfileTreeRow>
            )}

            <ProfileTreeRow label="Start" icon={<Clock className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-event-start">
              {isReadOnly ? (
                <span data-testid="event-start-readonly">
                  {eventData?.start.date && !eventData.start.dateTime
                    ? eventData.start.date
                    : new Date(start).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: timezone })}
                </span>
              ) : (
                <Input type="datetime-local" value={start} onChange={event => setStart(event.target.value)} data-testid="input-event-start" />
              )}
            </ProfileTreeRow>

            <ProfileTreeRow label="End" icon={<Clock className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-event-end">
              {isReadOnly ? (
                <span data-testid="event-end-readonly">
                  {eventData?.end.date && !eventData.end.dateTime
                    ? eventData.end.date
                    : new Date(end).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: timezone })}
                </span>
              ) : (
                <Input type="datetime-local" value={end} onChange={event => setEnd(event.target.value)} data-testid="input-event-end" />
              )}
            </ProfileTreeRow>

            <ProfileTreeRow label="Location" icon={<MapPin className="h-3.5 w-3.5" />} hasValue={Boolean(location)} showEmpty={!isReadOnly} mobileLayout="inline" testId="row-event-location">
              {isReadOnly ? (
                <span data-testid="event-location-readonly">{location}</span>
              ) : (
                <Input value={location} onChange={event => setLocation(event.target.value)} placeholder="Add location" data-testid="input-event-location" />
              )}
            </ProfileTreeRow>

            <ProfileTreeRow label="Calendar" icon={<CalendarIcon className="h-3.5 w-3.5" />} hasValue={Boolean(calendarLabel)} showEmpty mobileLayout="inline" testId="row-event-calendar">
              {isCreate ? (
                <Select value={selectedCalendarId} onValueChange={setSelectedCalendarId}>
                  <SelectTrigger data-testid="select-calendar">
                    <SelectValue placeholder="Select calendar" />
                  </SelectTrigger>
                  <SelectContent>
                    {calendars.map(calendar => (
                      <SelectItem key={`${calendar.accountId}:${calendar.id}`} value={calendar.id} data-testid={`calendar-option-${calendar.id}`}>
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: calendar.backgroundColor }} />
                          {calendar.summary}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="flex min-w-0 items-center justify-end gap-1.5" data-testid="event-calendar-value">
                  {selectedCal && <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: selectedCal.backgroundColor }} />}
                  <span className="truncate">{calendarLabel}</span>
                  {calendarAccountLabel && calendarAccountLabel !== calendarLabel && (
                    <span className="truncate text-muted-foreground">({calendarAccountLabel})</span>
                  )}
                </span>
              )}
            </ProfileTreeRow>
          </div>

          <div className="space-y-1">
            {isReadOnly ? (
              description ? (
                <div className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid="event-description-readonly">
                  {description}
                </div>
              ) : null
            ) : (
              <Textarea
                value={description}
                onChange={event => setDescription(event.target.value)}
                placeholder="Add description"
                rows={3}
                className="resize-none border-transparent hover:border-border focus:border-border transition-colors text-sm"
                data-testid="input-event-description"
              />
            )}
          </div>

          {/* Attendees */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4 shrink-0" />
              <span className="text-xs font-medium uppercase tracking-wider">
                Attendees{!isCreate && eventData?.attendees ? ` (${eventData.attendees.length})` : ""}
              </span>
            </div>

            {/* Show linked attendees in edit mode */}
            {!isCreate && eventData?.attendees && eventData.attendees.length > 0 && (
              <div className="pl-6 space-y-1.5">
                {eventData.attendees.map((a, i) => {
                  const matched = emailMap[a.email.toLowerCase()];
                  return (
                    <div key={i} className={cn("flex items-center gap-2 text-sm", a.optional && "opacity-60")} data-testid={`attendee-${i}`}>
                      {a.self ? (
                        <>
                          <span className="truncate">{a.displayName || a.email}</span>
                          <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate">You</Badge>
                          {a.optional && <span className="text-xs text-muted-foreground">opt</span>}
                        </>
                      ) : matched ? (
                        <button
                          onClick={() => navigate(`/people/${matched.id}`)}
                          className="truncate text-primary hover:underline flex items-center gap-1"
                          data-testid={`attendee-link-${i}`}
                        >
                          <LinkIcon className="h-3 w-3 shrink-0" />
                          {matched.name}
                        </button>
                      ) : (
                        <>
                          <span className="truncate">{a.displayName || a.email}</span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => {
                                  const name = a.displayName || a.email.split("@")[0];
                                  navigate(`/people?add=${encodeURIComponent(name)}&email=${encodeURIComponent(a.email)}`);
                                }}
                                className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                                data-testid={`attendee-add-${i}`}
                              >
                                <UserPlus className="h-3.5 w-3.5" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Add to People</TooltipContent>
                          </Tooltip>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Editable attendees input for create/edit */}
            {!isReadOnly && (
              <Input
                value={attendeesInput}
                onChange={e => setAttendeesInput(e.target.value)}
                placeholder="Add attendees (comma-separated emails)"
                className="ml-6 text-xs border-transparent hover:border-border focus:border-border transition-colors"
                data-testid="input-event-attendees"
              />
            )}
          </div>

          {/* Recurrence (create only) */}
          {isCreate && (
            <div className="space-y-2">
              <label className="text-xs text-muted-foreground block">Repeat</label>
              <Select value={recurrenceType} onValueChange={v => setRecurrenceType(v)}>
                <SelectTrigger className="h-8 text-xs" data-testid="select-recurrence">
                  <SelectValue placeholder="Does not repeat" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Does not repeat</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="weekdays">Every weekday (Mon–Fri)</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>

              {recurrenceType !== "none" && recurrenceType !== "weekdays" && (
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground shrink-0">Every</label>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={recurrenceInterval}
                    onChange={e => setRecurrenceInterval(Math.max(1, parseInt(e.target.value) || 1))}
                    className="h-7 w-16 text-xs"
                    data-testid="input-recurrence-interval"
                  />
                  <span className="text-xs text-muted-foreground">
                    {recurrenceType === "daily" ? "day(s)" : recurrenceType === "weekly" ? "week(s)" : recurrenceType === "monthly" ? "month(s)" : "year(s)"}
                  </span>
                </div>
              )}

              {recurrenceType === "weekly" && (
                <div className="flex flex-wrap gap-1">
                  {(["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const).map(day => (
                    <button
                      key={day}
                      type="button"
                      onClick={() => setRecurrenceWeekdays(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day])}
                      className={cn(
                        "h-7 w-7 rounded-full text-[10px] font-medium border transition-colors",
                        recurrenceWeekdays.includes(day)
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted text-muted-foreground border-border hover:bg-muted/80",
                      )}
                      data-testid={`weekday-${day}`}
                    >
                      {day.charAt(0) + day.charAt(1).toLowerCase()}
                    </button>
                  ))}
                </div>
              )}

              {recurrenceType !== "none" && (
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground block">Ends</label>
                  <Select value={recurrenceEndType} onValueChange={v => setRecurrenceEndType(v as "never" | "count" | "until")}>
                    <SelectTrigger className="h-8 text-xs" data-testid="select-recurrence-end">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="never">Never</SelectItem>
                      <SelectItem value="count">After</SelectItem>
                      <SelectItem value="until">On date</SelectItem>
                    </SelectContent>
                  </Select>
                  {recurrenceEndType === "count" && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        max={999}
                        value={recurrenceCount}
                        onChange={e => setRecurrenceCount(Math.max(1, parseInt(e.target.value) || 1))}
                        className="h-7 w-20 text-xs"
                        data-testid="input-recurrence-count"
                      />
                      <span className="text-xs text-muted-foreground">occurrences</span>
                    </div>
                  )}
                  {recurrenceEndType === "until" && (
                    <Input
                      type="date"
                      value={recurrenceUntil}
                      onChange={e => setRecurrenceUntil(e.target.value)}
                      className="h-7 text-xs"
                      data-testid="input-recurrence-until"
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Recurring event indicator (edit mode) */}
          {!isCreate && eventData?.recurringEventId && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              <span>🔄</span>
              <span>Part of a recurring series</span>
            </div>
          )}

          {/* Prep Required toggle */}
          {!isReadOnly && (
            <div className="flex items-center justify-between py-1">
              <label className="text-sm flex items-center gap-2">
                <Star className="h-3.5 w-3.5 text-warning fill-warning" />
                Prep Required
              </label>
              <Switch
                checked={prepRequired}
                onCheckedChange={setPrepRequired}
                data-testid="switch-prep-required"
              />
            </div>
          )}

          {/* Divider before metadata */}
          {!isCreate && <div className="border-t" />}

          {!isCreate && (
            <div className="space-y-2" data-testid="private-agenda-section">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="text-xs">Private Agenda</span>
              </div>
              {agendaPage ? (
                <ExpandableLibraryPage
                  page={{ id: agendaPage.libraryPageId, title: agendaPage.title, slug: agendaPage.slug }}
                  readOnly={Boolean(isReadOnly)}
                  defaultOpen
                />
              ) : (
                <button
                  type="button"
                  disabled={metaLoading || !eventData || Boolean(isReadOnly)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={async () => {
                    try {
                      await apiRequest("POST", "/api/calendar/metadata", {
                        googleEventId: eventId,
                        accountId: accountId || selectedAccountId,
                        calendarId: calendarId || selectedCalendarId,
                        eventType: metadata?.eventType || "meeting",
                        agenda: metadata?.agenda || "",
                      });
                      queryClient.invalidateQueries({ queryKey: metadataQueryKey });
                    } catch (error) {
                      toast({ title: "Failed to create agenda", description: String(error), variant: "destructive" });
                    }
                  }}
                  data-testid="button-add-agenda"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0" />
                  <span>Add Agenda</span>
                </button>
              )}
            </div>
          )}

          {!isCreate && (
            <div className="overflow-hidden rounded-md border border-border/20" data-testid="event-details-metadata">
              {metaLoading ? (
                <div className="space-y-2 p-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <>
                  {metadata?.eventType === "focus_block" && (
                    <ProfileTreeRow label="Capacity" icon={<Brain className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-event-capacity">
                      <Select
                        value={metadata.capacityType ?? "untyped"}
                        onValueChange={(value: CapacitySelectValue) => setTypeMutation.mutate({
                          eventType: "focus_block",
                          capacityType: value === "untyped" ? null : value,
                        })}
                        disabled={setTypeMutation.isPending || isReadOnly}
                      >
                        <SelectTrigger data-testid="select-capacity-type">
                          <SelectValue placeholder="Untyped" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="untyped">Untyped</SelectItem>
                          {CAPACITY_TYPES.map(type => (
                            <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </ProfileTreeRow>
                  )}

                  {(metadata?.eventType || "meeting") === "meeting" && (
                    <ProfileTreeRow label="Shared room" icon={<Users className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-event-shared-room">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-muted-foreground">
                          {sharedRoomEnabled ? "Diarize room speakers" : "One speaker per connection"}
                        </span>
                        <Switch
                          checked={sharedRoomEnabled}
                          onCheckedChange={checked => setSpeakerPolicyMutation.mutate(checked)}
                          disabled={setSpeakerPolicyMutation.isPending || isReadOnly}
                          aria-label="Shared room"
                          data-testid="switch-shared-room"
                        />
                      </div>
                    </ProfileTreeRow>
                  )}
                </>
              )}
            </div>
          )}


          {/* Linked People (edit mode only) */}
          {!isCreate && metadata && metadata.linkedPeople.length > 0 && (
            <div data-testid="linked-people-section">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">People</h4>
              <div className="flex flex-wrap gap-1.5">
                {metadata.linkedPeople.map(person => (
                  <button
                    key={person.id}
                    onClick={() => navigate(`/people/${person.id}`)}
                    className="px-2.5 py-0.5 rounded-full text-xs border bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors"
                    data-testid={`person-pill-${person.id}`}
                  >
                    {person.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Save button */}
          {!isReadOnly && (
            <div className="pt-2 pb-4">
              <Button
                onClick={() => {
                  // If editing a recurring event, ask about scope first
                  if (!isCreate && eventData?.recurringEventId) {
                    setShowRecurringScopeDialog(true);
                  } else {
                    saveMutation.mutate();
                  }
                }}
                disabled={!canSubmit || saveMutation.isPending}
                className="w-full"
                data-testid="button-save-event"
              >
                {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                {isCreate ? "Create Event" : "Save Changes"}
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Delete confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent data-testid="delete-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this event?</AlertDialogTitle>
            <AlertDialogDescription>
              "{title}" will be permanently removed from your calendar. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setShowDeleteConfirm(false); deleteMutation.mutate(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Recurring event edit scope dialog */}
      <AlertDialog open={showRecurringScopeDialog} onOpenChange={setShowRecurringScopeDialog}>
        <AlertDialogContent data-testid="recurring-scope-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Edit recurring event</AlertDialogTitle>
            <AlertDialogDescription>
              This event is part of a series. How would you like to apply your changes?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
            <AlertDialogCancel data-testid="button-cancel-recurring-scope">Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => { setShowRecurringScopeDialog(false); saveMutation.mutate("this"); }}
              data-testid="button-scope-this-event"
            >
              This event only
            </Button>
            <Button
              onClick={() => { setShowRecurringScopeDialog(false); saveMutation.mutate("all"); }}
              data-testid="button-scope-all-events"
            >
              All events in series
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
