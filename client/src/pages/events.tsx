import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  Brain,
  Wrench,
  Zap,
  Radio,
  MessageSquare,
  Server,
  Search,
  Trash2,
  Clock,
  Pause,
  Play,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Download,
  History,
  CalendarIcon,
  Loader2,
} from "lucide-react";
import { useEventStream, type BusEvent } from "@/hooks/use-event-stream";
import { useTimezone } from "@/hooks/use-timezone";
import { usePageHeader } from "@/hooks/use-page-header";

const CATEGORY_COLORS: Record<string, string> = {
  agent: "text-cat-ai",
  system: "text-info",
  session: "text-warning",
  channel: "text-active",
  chat: "text-success",
  gateway: "text-cat-event",
};

const CATEGORY_ICONS: Record<string, typeof Brain> = {
  agent: Brain,
  system: Server,
  session: MessageSquare,
  channel: Radio,
  chat: MessageSquare,
  gateway: Zap,
};

function formatEventTime(ts: number, timezone: string): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
    timeZone: timezone,
  });
}

function getInlineSummary(event: BusEvent): string | null {
  const p = event.payload;
  if (!p) return null;

  if (event.event === "agent.tool_call") {
    const name = p.toolName || p.name || "";
    const args = p.arguments || {};
    if (name === "memory_search") return `memory_search("${args.query || "..."}")`;
    if (name === "web_search" || name === "brave_search") return `web_search("${args.query || args.q || "..."}")`;
    if (name === "web_fetch") return `web_fetch(${(args.url || "").slice(0, 50)})`;
    if (name === "read") return `read(${args.path || args.file || "..."})`;
    if (name === "write") return `write(${args.path || args.file || "..."})`;
    if (name === "edit") return `edit(${args.path || args.file || "..."})`;
    if (name === "shell" || name === "bash") return `bash("${(args.command || "").slice(0, 60)}")`;
    if (name === "list_directory") return `ls(${args.path || "."})`;
    return `${name}(${JSON.stringify(args).slice(0, 60)})`;
  }

  if (event.event === "agent.tool_result") {
    const isErr = p.error || p.isError;
    if (isErr) return "error";
    const result = p.result;
    if (typeof result === "string") return result.slice(0, 80);
    if (result) return JSON.stringify(result).slice(0, 80);
    return "ok";
  }

  if (event.event === "agent.thinking") {
    const content = p.content || p.thinking || "";
    return content.slice(0, 80);
  }

  if (event.event === "agent.run.error") {
    return p.error || p.message || "";
  }

  return null;
}

function EventRow({ event }: { event: BusEvent }) {
  const { timezone } = useTimezone();
  const [expanded, setExpanded] = useState(false);
  const Icon = CATEGORY_ICONS[event.category] || Zap;
  const colorClass = CATEGORY_COLORS[event.category] || "text-muted-foreground";
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;
  const inlineSummary = getInlineSummary(event);

  return (
    <div
      className={`border-b border-border/50 last:border-b-0 ${hasPayload ? "cursor-pointer hover:bg-muted/30 transition-colors" : ""}`}
      onClick={() => hasPayload && setExpanded(!expanded)}
      data-testid={`event-row-${event.id}`}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover-elevate">
        <span className="text-muted-foreground w-20 shrink-0 text-right tabular-nums">
          {formatEventTime(event.timestamp, timezone)}
        </span>
        <Icon className={`h-3 w-3 shrink-0 ${colorClass}`} />
        <Badge variant="outline" className="text-xs px-1.5 py-0 shrink-0">
          {event.category}
        </Badge>
        <span className="font-medium shrink-0">{event.event}</span>
        {inlineSummary && (
          <span className="text-muted-foreground/60 truncate">
            {inlineSummary}
          </span>
        )}
        {event.runId && (
          <span className="text-muted-foreground/40 shrink-0 ml-auto">
            {event.runId.slice(0, 8)}
          </span>
        )}
        {hasPayload && (
          expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
      </div>
      {expanded && hasPayload && (
        <div className="px-3 pb-2 ml-24">
          <pre className="text-xs text-muted-foreground/80 bg-muted/50 rounded-md p-2 overflow-x-auto max-h-48 overflow-y-auto">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

interface HistoryEvent {
  id: number;
  eventId: string;
  bootId: string | null;
  category: string;
  event: string;
  payload: any;
  runId: string | null;
  sessionKey: string | null;
  createdAt: string;
}

function HistoryEventRow({ event }: { event: HistoryEvent }) {
  const { timezone } = useTimezone();
  const [expanded, setExpanded] = useState(false);
  const Icon = CATEGORY_ICONS[event.category] || Zap;
  const colorClass = CATEGORY_COLORS[event.category] || "text-muted-foreground";
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;
  const payloadPreview = hasPayload
    ? JSON.stringify(event.payload).slice(0, 80)
    : "";

  return (
    <div
      className={`border-b border-border/50 last:border-b-0 ${hasPayload ? "cursor-pointer hover:bg-muted/30 transition-colors" : ""}`}
      onClick={() => hasPayload && setExpanded(!expanded)}
      data-testid={`history-event-row-${event.id}`}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-muted/20">
        <span className="text-muted-foreground w-36 shrink-0 tabular-nums">
          {new Date(event.createdAt).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
            timeZone: timezone,
          })}
        </span>
        <Icon className={`h-3 w-3 shrink-0 ${colorClass}`} />
        <Badge variant="outline" className="text-xs px-1.5 py-0 shrink-0">
          {event.category}
        </Badge>
        <span className="font-medium shrink-0">{event.event}</span>
        {event.runId && (
          <span className="text-muted-foreground/40 shrink-0">
            {event.runId.slice(0, 8)}
          </span>
        )}
        {payloadPreview && (
          <span className="text-muted-foreground/50 truncate">
            {payloadPreview}
          </span>
        )}
        {hasPayload && (
          expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground ml-auto" /> : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground ml-auto" />
        )}
      </div>
      {expanded && hasPayload && (
        <div className="px-3 pb-2 ml-40">
          <pre className="text-xs text-muted-foreground/80 bg-muted/50 rounded-md p-2 overflow-x-auto max-h-48 overflow-y-auto">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function DatePickerButton({ date, onChange, label }: { date: Date | undefined; onChange: (d: Date | undefined) => void; label: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1 min-w-[120px]" data-testid={`button-date-${label.toLowerCase().replace(/\s/g, "-")}`}>
          <CalendarIcon className="h-3 w-3" />
          {date ? date.toLocaleDateString() : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={onChange}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}

function HistoryMode() {
  const [startDate, setStartDate] = useState<Date | undefined>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  });
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [category, setCategory] = useState("all");
  const [eventName, setEventName] = useState("");
  const [runIdFilter, setRunIdFilter] = useState("");
  const [payloadSearch, setPayloadSearch] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;

  const queryParams = new URLSearchParams();
  if (startDate) queryParams.set("startDate", startDate.toISOString());
  if (endDate) queryParams.set("endDate", endDate.toISOString());
  if (category !== "all") queryParams.set("category", category);
  if (eventName) queryParams.set("event", eventName);
  if (runIdFilter) queryParams.set("runId", runIdFilter);
  if (payloadSearch) queryParams.set("payloadSearch", payloadSearch);
  queryParams.set("limit", String(limit));
  queryParams.set("offset", String(page * limit));

  const { data, isLoading } = useQuery<{ events: HistoryEvent[]; total: number }>({
    queryKey: ["/api/events/history?" + queryParams.toString()],
    refetchInterval: false,
  });

  const events = data?.events || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  const handleExport = () => {
    if (!events.length) return;
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `events-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b flex-wrap">
        <DatePickerButton date={startDate} onChange={(d) => { setStartDate(d); setPage(0); }} label="Start Date" />
        <DatePickerButton date={endDate} onChange={(d) => { setEndDate(d); setPage(0); }} label="End Date" />
        <Select value={category} onValueChange={(v) => { setCategory(v); setPage(0); }}>
          <SelectTrigger className="w-[120px] h-7 text-xs" data-testid="select-history-category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="chat">Chat</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="gateway">Gateway</SelectItem>
            <SelectItem value="session">Session</SelectItem>
            <SelectItem value="channel">Channel</SelectItem>
            <SelectItem value="tool">Tool</SelectItem>
            <SelectItem value="timer">Timer</SelectItem>
            <SelectItem value="memory">Memory</SelectItem>
            <SelectItem value="voice">Voice</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Event name (wildcard: *)"
          value={eventName}
          onChange={(e) => { setEventName(e.target.value); setPage(0); }}
          className="h-7 text-xs w-[160px]"
          data-testid="input-history-event-name"
        />
        <Input
          placeholder="Run ID"
          value={runIdFilter}
          onChange={(e) => { setRunIdFilter(e.target.value); setPage(0); }}
          className="h-7 text-xs w-[100px]"
          data-testid="input-history-run-id"
        />
        <div className="flex items-center gap-1 flex-1 min-w-[140px]">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            placeholder="Search payload..."
            value={payloadSearch}
            onChange={(e) => { setPayloadSearch(e.target.value); setPage(0); }}
            className="h-7 text-xs"
            data-testid="input-history-payload-search"
          />
        </div>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={handleExport} disabled={!events.length} data-testid="button-export-events">
          <Download className="h-3 w-3" />
          Export
        </Button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <History className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground" data-testid="text-history-zero-state">
              No events match your filters.
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Try broadening the date range or removing filters.
            </p>
          </div>
        ) : (
          <div>
            {events.map((event) => (
              <HistoryEventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t text-xs">
          <span className="text-muted-foreground" data-testid="text-history-pagination-info">
            Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
              data-testid="button-history-prev-page"
            >
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <span className="px-2 tabular-nums">
              {page + 1} / {totalPages}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              disabled={page >= totalPages - 1}
              onClick={() => setPage(page + 1)}
              data-testid="button-history-next-page"
            >
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function LiveStreamMode() {
  const { events, connected, clearEvents } = useEventStream(1000);
  const [filter, setFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pausedEvents, setPausedEvents] = useState<BusEvent[]>([]);

  useEffect(() => {
    if (!paused) {
      setPausedEvents(events);
    }
  }, [events, paused]);

  const displayEvents = paused ? pausedEvents : events;

  const filteredEvents = displayEvents.filter((e) => {
    if (categoryFilter !== "all" && e.category !== categoryFilter) return false;
    if (filter) {
      const searchStr = `${e.event} ${e.category} ${e.runId || ""} ${JSON.stringify(e.payload || {})}`.toLowerCase();
      if (!searchStr.includes(filter.toLowerCase())) return false;
    }
    return true;
  });

  useEffect(() => {
    if (autoScroll && !paused && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [filteredEvents.length, autoScroll, paused]);

  const categoryCounts = displayEvents.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b flex-wrap">
        <div className="flex items-center gap-1 flex-1 min-w-[200px]">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            placeholder="Filter events..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 text-xs"
            data-testid="input-event-filter"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[130px] h-7 text-xs" data-testid="select-event-category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="chat">Chat</SelectItem>
            <SelectItem value="system">System</SelectItem>
            <SelectItem value="gateway">Gateway</SelectItem>
            <SelectItem value="session">Session</SelectItem>
            <SelectItem value="channel">Channel</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant={paused ? "default" : "ghost"}
            onClick={() => setPaused(!paused)}
            className="h-7 w-7"
            data-testid="button-pause-events"
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={clearEvents}
            className="h-7 w-7"
            data-testid="button-clear-events"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {Object.keys(categoryCounts).length > 0 && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b overflow-x-auto">
          {Object.entries(categoryCounts).map(([cat, count]) => (
            <Badge
              key={cat}
              variant={categoryFilter === cat ? "default" : "secondary"}
              className="text-xs cursor-pointer gap-1"
              onClick={() => setCategoryFilter(categoryFilter === cat ? "all" : cat)}
              data-testid={`badge-category-${cat}`}
            >
              <span className={CATEGORY_COLORS[cat] || ""}>{cat}</span>
              <span>{count}</span>
            </Badge>
          ))}
          <span className="text-xs text-muted-foreground ml-auto">
            {filteredEvents.length} / {displayEvents.length} events
          </span>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Zap className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No events captured</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              All agent events will appear here as they occur
            </p>
          </div>
        ) : (
          <div>
            {filteredEvents.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function EventsPage({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Events", skip: !!embedded });
  const [mode, setMode] = useState<"live" | "history">("live");

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <div className="flex items-center gap-1">
          <span className={`text-xs ${mode === "live" ? "text-success" : "text-muted-foreground"}`}>
            {mode === "live" ? "● Live" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-md p-0.5" data-testid="toggle-event-mode">
          <Button
            size="sm"
            variant={mode === "live" ? "default" : "ghost"}
            className="h-6 text-xs px-3"
            onClick={() => setMode("live")}
            data-testid="button-mode-live"
          >
            <Zap className="h-3 w-3 mr-1" />
            Live
          </Button>
          <Button
            size="sm"
            variant={mode === "history" ? "default" : "ghost"}
            className="h-6 text-xs px-3"
            onClick={() => setMode("history")}
            data-testid="button-mode-history"
          >
            <History className="h-3 w-3 mr-1" />
            History
          </Button>
        </div>
      </div>

      {mode === "live" ? <LiveStreamMode /> : <HistoryMode />}
    </div>
  );
}
