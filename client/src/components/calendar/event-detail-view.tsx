import { useState, useEffect, useCallback, useRef } from "react";
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
  ArrowLeft,
  Calendar as CalendarIcon,
  Clock,
  Brain,
  MapPin,
  Users,
  Star,
  ExternalLink,
  Trash2,
  Loader2,
  UserPlus,
  Link as LinkIcon,
  X,
  Search,
  Plus,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useTimezone } from "@/hooks/use-timezone";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

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
  linkedTasks: Array<{
    id: number;
    taskId: number | null;
    priorityTitle: string | null;
    taskTitle?: string;
    taskPriority?: string;
    estimateLow?: number | null;
    estimateHigh?: number | null;
  }>;
  linkedPeople: Array<{ id: string; name: string }>;
}

interface ActiveTask {
  id: number;
  title: string;
  priority: string;
  estimateLow: number | null;
  estimateHigh: number | null;
  status: string;
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
  const calendarMap = new Map(calendars.map(c => [c.id, c]));

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
  const metadataQueryKey = ["/api/calendar/metadata", eventId, accountId, calendarId];
  const { data: metadata, isLoading: metaLoading } = useQuery<CalendarMetadata | null>({
    queryKey: metadataQueryKey,
    queryFn: async () => {
      try {
        const res = await fetch(
          `/api/calendar/metadata/${encodeURIComponent(eventId)}?accountId=${encodeURIComponent(accountId || "")}&calendarId=${encodeURIComponent(calendarId || "")}`,
          { credentials: "include" },
        );
        if (res.status === 404) return null;
        if (!res.ok) throw new Error("Failed to fetch metadata");
        const data = await res.json();
        if (!data.metadata) return null;
        return {
          ...data.metadata,
          linkedTasks: data.tasks ?? [],
          linkedPeople: data.people ?? [],
        } as CalendarMetadata;
      } catch {
        return null;
      }
    },
    enabled: !isCreate,
    retry: false,
  });

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
  const [showTaskSearch, setShowTaskSearch] = useState(false);
  const [taskSearchQuery, setTaskSearchQuery] = useState("");
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

  // Set default calendar when calendars load for create mode
  useEffect(() => {
    if (isCreate && calendars.length > 0 && !selectedCalendarId) {
      setSelectedCalendarId(calendars[0]?.id || "");
    }
  }, [isCreate, calendars, selectedCalendarId]);

  const selectedCal = calendars.find(c => c.id === selectedCalendarId);
  const selectedAccountId = selectedCal?.accountId || accountId || "";
  const isReadOnly = !isCreate && selectedCal && !["owner", "writer"].includes(selectedCal.accessRole);

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
      } else {
        // For recurring events, "all" scope patches the base event
        const targetEventId = scope === "all" && eventData?.recurringEventId
          ? eventData.recurringEventId
          : eventId;

        await apiRequest("PATCH", `/api/calendar/events/${targetEventId}`, {
          calendarId: calendarId || selectedCalendarId,
          accountId: accountId || selectedAccountId,
          event: eventPayload,
        });
        return null;
      }
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar/events"] });
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: metadataQueryKey }),
    onError: (err: any) => toast({ title: "Failed to update event type", description: err.message, variant: "destructive" }),
  });

  const unlinkTaskMutation = useMutation({
    mutationFn: async (linkId: number) => {
      await apiRequest("DELETE", `/api/calendar/metadata/tasks/${linkId}`);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: metadataQueryKey }),
    onError: (err: any) => toast({ title: "Failed to unlink task", description: err.message, variant: "destructive" }),
  });

  const linkTaskMutation = useMutation({
    mutationFn: async (taskId: number) => {
      if (!metadata) throw new Error("No metadata record");
      await apiRequest("POST", `/api/calendar/metadata/${metadata.id}/tasks`, { taskId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: metadataQueryKey });
      setShowTaskSearch(false);
      setTaskSearchQuery("");
    },
    onError: (err: any) => toast({ title: "Failed to link task", description: err.message, variant: "destructive" }),
  });

  // --- Task search ---
  const { data: activeTasks } = useQuery<ActiveTask[]>({
    queryKey: ["/api/projects/tasks", { status: "active" }],
    queryFn: async () => {
      const res = await fetch("/api/projects/tasks?status=active", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : (data.tasks ?? []);
    },
    enabled: showTaskSearch,
    retry: false,
  });

  const filteredTasks = (activeTasks ?? []).filter(t =>
    t.title.toLowerCase().includes(taskSearchQuery.toLowerCase()),
  );

  const priorityColors: Record<string, string> = {
    high: "bg-error/10 text-error-foreground",
    mid: "bg-warning/10 text-warning-foreground",
    low: "bg-neutral/10 text-neutral-foreground",
  };

  const canSubmit = title.trim().length > 0 && selectedCalendarId && start && end;

  // --- Loading state ---
  if (!isCreate && (eventLoading || !initialized)) {
    return (
      <div className="flex h-full flex-col overflow-hidden" data-testid="event-detail-loading">
        <div className="border-b border-border p-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => navigate("/schedule")}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Skeleton className="h-5 w-48" />
        </div>
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
      {/* Header */}
      <div className="border-b border-border p-2 flex items-center gap-2">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => navigate("/schedule")} data-testid="button-back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium truncate flex-1">
          {isCreate ? "New Event" : (title || "Event")}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {!isCreate && eventData?.htmlLink && (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" asChild data-testid="button-open-google">
              <a href={eventData.htmlLink} target="_blank" rel="noopener noreferrer" title="Open in Google Calendar">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
          {!isCreate && !isReadOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={deleteMutation.isPending}
              data-testid="button-delete-event"
            >
              {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4 max-w-lg">
          {/* Badges (edit mode) */}
          {!isCreate && eventData && (
            <div className="flex items-center gap-2 flex-wrap">
              {isHighPrep(eventData) && (
                <Badge variant="secondary" className="bg-cat-alert/15 text-cat-alert-foreground border border-cat-alert/30 rounded-sm text-xs font-medium px-2 py-0.5 no-default-hover-elevate no-default-active-elevate" data-testid="badge-prep-required">
                  <Star className="h-3 w-3 mr-1 text-warning fill-warning" />
                  Prep Required
                </Badge>
              )}
              {isPersonalAccount(eventData.accountEmail) && (
                <Badge variant="outline" className="no-default-hover-elevate no-default-active-elevate text-info-foreground border-info/30 dark:text-info dark:border-info/50" data-testid="badge-personal">
                  Personal
                </Badge>
              )}
            </div>
          )}

          {/* Title */}
          <div>
            {isReadOnly ? (
              <h2 className="text-lg font-semibold" data-testid="event-title">{title}</h2>
            ) : (
              <Input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Event title"
                className="text-lg font-semibold h-auto py-1.5 px-2 border-transparent hover:border-border focus:border-border transition-colors"
                data-testid="input-event-title"
              />
            )}
          </div>

          {/* Date/Time */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0" />
              <span className="text-xs font-medium uppercase tracking-wider">Time</span>
            </div>
            {isReadOnly ? (
              <div className="text-sm pl-6" data-testid="event-time-readonly">
                {eventData?.start.date && !eventData?.start.dateTime
                  ? "All day"
                  : `${new Date(start).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: timezone })} – ${new Date(end).toLocaleString([], { timeStyle: "short", timeZone: timezone })}`}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 pl-6">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Start</label>
                  <Input
                    type="datetime-local"
                    value={start}
                    onChange={e => setStart(e.target.value)}
                    className="text-xs"
                    data-testid="input-event-start"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">End</label>
                  <Input
                    type="datetime-local"
                    value={end}
                    onChange={e => setEnd(e.target.value)}
                    className="text-xs"
                    data-testid="input-event-end"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Location */}
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="h-4 w-4 shrink-0" />
              <span className="text-xs font-medium uppercase tracking-wider">Location</span>
            </div>
            {isReadOnly ? (
              location ? <div className="text-sm pl-6" data-testid="event-location-readonly">{location}</div> : null
            ) : (
              <Input
                value={location}
                onChange={e => setLocation(e.target.value)}
                placeholder="Add location"
                className="pl-6 border-transparent hover:border-border focus:border-border transition-colors text-sm"
                data-testid="input-event-location"
              />
            )}
          </div>

          {/* Description */}
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
                onChange={e => setDescription(e.target.value)}
                placeholder="Add description"
                rows={3}
                className="resize-none border-transparent hover:border-border focus:border-border transition-colors text-sm"
                data-testid="input-event-description"
              />
            )}
          </div>

          {/* Divider */}
          <div className="border-t" />

          {/* Calendar picker */}
          {!isReadOnly && calendars.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CalendarIcon className="h-4 w-4 shrink-0" />
                <span className="text-xs font-medium uppercase tracking-wider">Calendar</span>
              </div>
              {isCreate ? (
                <Select value={selectedCalendarId} onValueChange={setSelectedCalendarId}>
                  <SelectTrigger className="ml-6 text-xs" data-testid="select-calendar">
                    <SelectValue placeholder="Select calendar" />
                  </SelectTrigger>
                  <SelectContent>
                    {calendars.map(c => (
                      <SelectItem key={c.id} value={c.id} data-testid={`calendar-option-${c.id}`}>
                        <span className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: c.backgroundColor }} />
                          {c.summary}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="text-sm pl-6 flex items-center gap-1.5">
                  {selectedCal && <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: selectedCal.backgroundColor }} />}
                  <span>{selectedCal?.summary || "Unknown"}</span>
                  <span className="text-xs text-muted-foreground">({eventData?.accountEmail})</span>
                </div>
              )}
            </div>
          )}

          {/* Read-only calendar display */}
          {isReadOnly && selectedCal && (
            <div className="flex items-center gap-2 text-sm">
              <CalendarIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: selectedCal.backgroundColor }} />
              <span>{selectedCal.summary}</span>
            </div>
          )}

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

          {/* Event Details metadata (edit mode only) */}
          {!isCreate && (
            <div className="space-y-2" data-testid="event-details-metadata">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Event Details</h4>
              {metaLoading ? (
                <div className="space-y-2 pl-3 border-l border-border/60">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <div className="space-y-2 pl-3 border-l border-border/60">
                  {!metadata && (
                    <div className="text-xs text-muted-foreground italic" data-testid="classify-prompt">
                      Classify this event
                    </div>
                  )}

                  <div className="grid grid-cols-[92px_1fr] items-center gap-2">
                    <label className="text-xs text-muted-foreground">Event Type</label>
                    <Select
                      value={isEventTypeValue(metadata?.eventType) ? metadata.eventType : undefined}
                      onValueChange={(value) => setTypeMutation.mutate({ eventType: value as EventTypeValue })}
                      disabled={setTypeMutation.isPending || isReadOnly}
                    >
                      <SelectTrigger className="h-8 text-xs" data-testid="select-event-type">
                        <SelectValue placeholder="Classify" />
                      </SelectTrigger>
                      <SelectContent>
                        {EVENT_TYPES.map(type => (
                          <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {metadata?.eventType === "focus_block" && (
                    <div className="grid grid-cols-[92px_1fr] items-center gap-2">
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Brain className="h-3 w-3" />
                        Capacity
                      </label>
                      <Select
                        value={metadata.capacityType ?? "untyped"}
                        onValueChange={(value: CapacitySelectValue) => setTypeMutation.mutate({
                          eventType: "focus_block",
                          capacityType: value === "untyped" ? null : value,
                        })}
                        disabled={setTypeMutation.isPending || isReadOnly}
                      >
                        <SelectTrigger className="h-8 text-xs" data-testid="select-capacity-type">
                          <SelectValue placeholder="Untyped" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="untyped">Untyped</SelectItem>
                          {CAPACITY_TYPES.map(type => (
                            <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {metadata?.eventType === "focus_block" && !metadata.capacityType && (
                    <p className="pl-[100px] text-xs text-muted-foreground">Untagged focus blocks count as ambiguous capacity.</p>
                  )}
                </div>
              )}
            </div>
          )}


          {/* Linked Work (edit mode only) */}
          {!isCreate && (
            <div className="space-y-2" data-testid="linked-tasks-section">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Linked Work</h4>
              {metadata && metadata.linkedTasks.length > 0 ? (
                <div className="space-y-1.5">
                  {metadata.linkedTasks.map(link => {
                    const avgEst =
                      link.estimateLow != null && link.estimateHigh != null
                        ? Math.round((link.estimateLow + link.estimateHigh) / 2)
                        : link.estimateLow ?? link.estimateHigh ?? null;
                    return (
                      <div key={link.id} className="flex items-center gap-2 text-sm group" data-testid={`linked-task-${link.id}`}>
                        {link.taskPriority && (
                          <span className={cn("text-xs font-medium px-1.5 py-0.5 rounded shrink-0", priorityColors[link.taskPriority] ?? priorityColors.low)}>
                            {link.taskPriority.toUpperCase()}
                          </span>
                        )}
                        <span className="truncate flex-1">{link.priorityTitle ?? link.taskTitle ?? `Task #${link.taskId}`}</span>
                        {avgEst != null && <span className="text-xs text-muted-foreground shrink-0">~{avgEst}h</span>}
                        {!isReadOnly && (
                          <button
                            onClick={() => unlinkTaskMutation.mutate(link.id)}
                            disabled={unlinkTaskMutation.isPending}
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
                            data-testid={`unlink-task-${link.id}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="no-tasks-linked">No tasks linked</p>
              )}

              {!isReadOnly && (
                showTaskSearch ? (
                  <div className="border rounded-md p-2 space-y-2 bg-background" data-testid="task-search-overlay">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        autoFocus
                        placeholder="Search tasks..."
                        value={taskSearchQuery}
                        onChange={e => setTaskSearchQuery(e.target.value)}
                        className="pl-7 h-7 text-xs"
                        data-testid="task-search-input"
                      />
                    </div>
                    <ScrollArea className="max-h-40">
                      <div className="space-y-0.5">
                        {filteredTasks.length === 0 && (
                          <p className="text-xs text-muted-foreground text-center py-2">No tasks found</p>
                        )}
                        {filteredTasks.map(task => (
                          <button
                            key={task.id}
                            onClick={() => {
                              if (!metadata) {
                                setTypeMutation.mutate({ eventType: "focus_block" });
                                toast({ title: "Please select an event type first, then link the task." });
                                return;
                              }
                              linkTaskMutation.mutate(task.id);
                            }}
                            disabled={linkTaskMutation.isPending}
                            className="w-full flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-muted transition-colors text-left"
                            data-testid={`task-option-${task.id}`}
                          >
                            <span className={cn("text-xs font-medium px-1.5 py-0.5 rounded shrink-0", priorityColors[task.priority] ?? priorityColors.low)}>
                              {task.priority.toUpperCase()}
                            </span>
                            <span className="truncate flex-1">{task.title}</span>
                          </button>
                        ))}
                      </div>
                    </ScrollArea>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs w-full"
                      onClick={() => { setShowTaskSearch(false); setTaskSearchQuery(""); }}
                      data-testid="button-cancel-task-search"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setShowTaskSearch(true)}
                    data-testid="button-link-task"
                  >
                    <LinkIcon className="h-3 w-3 mr-1" />
                    Link task...
                  </Button>
                )
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
