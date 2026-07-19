import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Plus,
  Loader2,
  Check,
  Heart,
  MoreHorizontal,
  ChevronRight,
  Trash2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useState, useCallback, useRef, useMemo, useContext, createContext, useEffect } from "react";
import { useTimezone } from "@/hooks/use-timezone";
import { ActivityDetailView } from "./activity-detail-view";

interface WellnessLogEntry {
  id: number;
  activityId: number;
  notes: string | null;
  tier: string | null;
  metricValue: number | null;
  completedAt: string;
}

function formatLocalDate(d: Date, timezone?: string): string {
  if (timezone) {
    return d.toLocaleDateString("en-CA", { timeZone: timezone });
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TimezoneContext = createContext<string | undefined>(undefined);

function useCalendarTimezone(): string | undefined {
  return useContext(TimezoneContext);
}

// "Done for current period" is computed server-side in `/api/wellness/status` using
// the same user-local day boundaries as the heatmap dialog (see `userPeriodBounds`
// in `server/utils/user-time.ts`). The client must NOT re-derive this from
// `lastCompletedAt` + a client-side timezone, because the client tz fallback
// (`Intl.DateTimeFormat().resolvedOptions().timeZone`) can drift from the server's
// configured timezone and cause the daily checkbox to disagree with the heatmap.

function GlobalCompletionCalendar({
  logs,
  onSelectDate,
}: {
  logs: WellnessLogEntry[];
  onSelectDate: (date: string) => void;
}) {
  const tz = useCalendarTimezone();
  const today = formatLocalDate(new Date(), tz);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [weeksToShow, setWeeksToShow] = useState(12);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const compute = () => {
      const width = el.clientWidth;
      // Square cells with a shorter recent window: fewer weeks, larger readable cells.
      const available = Math.max(0, width - 34);
      const per = 22;
      // Show a shorter recent window and reserve right-edge breathing room.
      const n = Math.max(6, Math.floor(available / per) - 3);
      setWeeksToShow(n);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { grid, maximum } = useMemo(() => {
    const countMap: Record<string, number> = {};
    for (const l of logs) {
      const dateStr = formatLocalDate(new Date(l.completedAt), tz);
      countMap[dateStr] = (countMap[dateStr] || 0) + 1;
    }

    const now = new Date();
    const todayInTz = tz
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now)
      : undefined;
    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const todayDow = todayInTz ? (dowMap[todayInTz] ?? now.getDay()) : now.getDay();
    // Monday-first: Mon=0..Sun=6
    const todayDowMon = (todayDow + 6) % 7;
    const daysBack = (weeksToShow - 1) * 7 + todayDowMon;
    const days: { date: string; count: number; future: boolean }[] = [];
    for (let i = daysBack; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = formatLocalDate(d, tz);
      days.push({
        date: dateStr,
        count: countMap[dateStr] || 0,
        future: false,
      });
    }
    // Pad the trailing partial week with future placeholders so every week has 7 days.
    let pad = 1;
    while (days.length % 7 !== 0) {
      const d = new Date(now);
      d.setDate(d.getDate() + pad);
      const dateStr = formatLocalDate(d, tz);
      days.push({ date: dateStr, count: 0, future: true });
      pad += 1;
    }
    const weeks: typeof days[] = [];
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(days.slice(i, i + 7));
    }
    const maximum = Math.max(0, ...days.filter((day) => !day.future).map((day) => day.count));
    return { grid: weeks, maximum };
  }, [logs, tz, weeksToShow]);

  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const monthDay = (dateStr: string) => {
    const [, m, d] = dateStr.split("-");
    return `${parseInt(m, 10)}/${d}`;
  };

  const cellInfo = (day: { count: number }): { className: string; style?: React.CSSProperties; pct: number } => {
    const pct = maximum === 0 ? 0 : Math.round((day.count / maximum) * 100);
    if (pct === 0) return { className: "bg-muted/30", pct };
    return { className: "", style: { backgroundColor: pulseFillColor(pct) }, pct };
  };

  const cellClass = "h-5 w-5 shrink-0";

  return (
    <div ref={containerRef} data-testid="global-completion-calendar" className="w-full overflow-hidden pt-3">
      <div className="flex gap-0.5 w-max">
        {grid.map((week, wi) => (
          <div key={`week-${wi}`} className="flex flex-col gap-0.5 w-5 shrink-0">
            <div
              className="relative h-7 overflow-visible"
              data-testid={`cal-week-label-${week[0].date}`}
            >
              <span
                className="absolute bottom-2 left-1/2 text-2xs text-muted-foreground/70 leading-none whitespace-nowrap"
                style={{
                  transform: "translateX(-50%) rotate(-90deg)",
                  transformOrigin: "center center",
                }}
              >
                {monthDay(week[0].date)}
              </span>
            </div>
            {week.map((day, di) => {
              if (day.future) {
                return <div key={`cell-${wi}-${di}`} className={cellClass} />;
              }
              const info = cellInfo(day);
              const showStar = info.pct > 80;
              return (
                <button
                  key={`cell-${wi}-${di}`}
                  type="button"
                  data-testid={`cal-cell-${day.date}`}
                  title={`${day.date}: ${day.count} completed wellness activities${info.pct > 0 ? ` (${info.pct}% of maximum)` : ""}`}
                  onClick={() => onSelectDate(day.date)}
                  style={info.style}
                  className={`relative block ${cellClass} appearance-none rounded-[3px] border-0 p-0 ${info.className} ${day.date === today ? "ring-1 ring-foreground/60" : ""} hover:ring-1 hover:ring-foreground/60 transition-shadow`}
                >
                  {showStar && (
                    <Heart
                      data-testid={`cal-cell-star-${day.date}`}
                      className="absolute inset-0 m-auto h-3.5 w-3.5 text-white drop-shadow-sm"
                      fill="currentColor"
                      strokeWidth={1.5}
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
        <div className="flex flex-col gap-0.5 w-7 shrink-0 pl-1">
          <div className="h-7" />
          {dayLabels.map((label, di) => (
            <div key={`day-${di}`} className="h-5 flex items-center justify-start">
              <span className="text-[10px] text-muted-foreground leading-none">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeatmapDayDialog({
  date,
  activities,
  onClose,
}: {
  date: string | null;
  activities: ActivityWithStatus[];
  onClose: () => void;
}) {
  const tz = useCalendarTimezone();
  const { toast } = useToast();
  const open = date !== null;

  const { data: dayLogs } = useQuery<WellnessLogEntry[]>({
    queryKey: ["/api/wellness/logs", "by-date", date],
    queryFn: async () => {
      if (!date) return [];
      const res = await fetch(`/api/wellness/logs?date=${date}&limit=500`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load day logs");
      return res.json();
    },
    enabled: open && !!date,
  });

  const loggedActivityIds = useMemo(() => {
    if (!dayLogs) return new Set<number>();
    return new Set(dayLogs.map((l) => l.activityId));
  }, [dayLogs]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
    queryClient.invalidateQueries({ queryKey: ["/api/wellness/pulse-buckets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", "all"] });
    queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", "by-date", date] });
  };

  const logMutation = useMutation({
    mutationFn: async ({ activityId, d }: { activityId: number; d: string }) => {
      await apiRequest("POST", "/api/wellness/log", { activityId, date: d });
    },
    onSuccess: (_d, vars) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", vars.activityId] });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const unlogMutation = useMutation({
    mutationFn: async ({ activityId, d }: { activityId: number; d: string }) => {
      await apiRequest("DELETE", "/api/wellness/logs/by-date", { activityId, date: d });
    },
    onSuccess: (_d, vars) => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", vars.activityId] });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const formattedDate = date
    ? new Date(date + "T12:00:00Z").toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : "";

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">{formattedDate}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {activities.length === 0 && (
            <p className="text-sm text-muted-foreground">No activities yet.</p>
          )}
          {CATEGORY_ORDER.map((cat) => {
            const inCat = activities.filter((a) => a.category === cat);
            if (inCat.length === 0) return null;
            return (
              <div key={cat} data-testid={`heatmap-section-${cat}`}>
                <h4 className="text-base font-bold mb-1 px-2">{CATEGORY_LABELS[cat] ?? cat}</h4>
                <div className="space-y-0.5">
                  {inCat.map((a) => {
                    const checked = loggedActivityIds.has(a.id);
                    const pending =
                      (logMutation.isPending && logMutation.variables?.activityId === a.id) ||
                      (unlogMutation.isPending && unlogMutation.variables?.activityId === a.id);
                    return (
                      <label
                        key={a.id}
                        data-testid={`heatmap-row-${a.id}`}
                        className="flex items-center gap-3 px-2 py-2 rounded hover:bg-muted/40 cursor-pointer"
                      >
                        <Checkbox
                          data-testid={`heatmap-check-${a.id}`}
                          checked={checked}
                          disabled={pending || !date}
                          onCheckedChange={(v) => {
                            if (!date) return;
                            if (v) logMutation.mutate({ activityId: a.id, d: date });
                            else unlogMutation.mutate({ activityId: a.id, d: date });
                          }}
                        />
                        <span className="text-sm flex-1">{a.name}</span>
                        {pending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type ActivityPulse = "good" | "okay" | "danger" | "never_done";

interface ActivityWithStatus {
  id: number;
  name: string;
  benefit: string | null;
  risk: string | null;
  estimatedMinutes: number | null;
  estimatedCost: number | null;
  intervalDays: number;
  requirements: string | null;
  category: string;
  isDefault: boolean;
  linkedMetricType: string | null;
  greatThreshold: number | null;
  goodThreshold: number | null;
  lastCompletedAt: string | null;
  tier: string | null;
  metricValue: number | null;
  doneToday: boolean;
  doneForCurrentPeriod: boolean;
  status: "overdue" | "due_soon" | "on_track" | "never_done";
  urgency: number;
  daysSince: number | null;
  daysUntilDue: number | null;
  pulse: ActivityPulse;
  pulsePercent: number | null;
  rollingAvgIntervalDays: number | null;
  windowSize: number;
  windowStart: number | null;
  windowEnd: number | null;
  inWindow: boolean;
}

interface BucketPulseRollup {
  pulse: ActivityPulse | null;
  pulsePercent: number | null;
  goodCount: number;
  okayCount: number;
  dangerCount: number;
  neverDoneCount: number;
  total: number;
}

type BucketsByCategory = Record<string, BucketPulseRollup>;

function computeBucketRollup(activities: ActivityWithStatus[]): BucketsByCategory {
  const cats = ["daily_practice", "weekly_ritual", "monthly_renewal", "quarterly_reset", "annual_checkup"];
  const out: BucketsByCategory = {};
  for (const cat of cats) {
    const inCat = activities.filter((a) => a.category === cat);
    const goodCount = inCat.filter((a) => a.pulse === "good").length;
    const okayCount = inCat.filter((a) => a.pulse === "okay").length;
    const dangerCount = inCat.filter((a) => a.pulse === "danger").length;
    const neverDoneCount = inCat.filter((a) => a.pulse === "never_done").length;
    const total = inCat.length;
    let pulse: ActivityPulse | null = null;
    let pulsePercent: number | null = null;
    if (total > 0) {
      const sum = inCat.reduce((acc, a) => acc + (a.pulsePercent ?? 0), 0);
      pulsePercent = Math.round(sum / total);
      if (pulsePercent >= 80) pulse = "good";
      else if (pulsePercent >= 50) pulse = "okay";
      else pulse = "danger";
    }
    out[cat] = { pulse, pulsePercent, goodCount, okayCount, dangerCount, neverDoneCount, total };
  }
  return out;
}


const PULSE_DOT: Record<string, string> = {
  good: "bg-success",
  okay: "bg-warning",
  danger: "bg-error",
  never_done: "bg-muted-foreground/50",
};

const PULSE_TEXT: Record<string, string> = {
  good: "text-success-foreground",
  okay: "text-warning-foreground",
  danger: "text-error-foreground",
  never_done: "text-muted-foreground",
};

function pulseFillColor(pct: number | null): string {
  if (pct === null || pct <= 0) return "hsl(var(--muted) / 0.3)";
  const opacity = 0.15 + (Math.max(0, Math.min(100, pct)) / 100) * 0.85;
  return `hsl(var(--success) / ${opacity.toFixed(2)})`;
}

function pulseClass(pulse: string | null): string {
  return PULSE_TEXT[pulse ?? "never_done"] ?? "text-muted-foreground";
}

const CATEGORY_ORDER = ["daily_practice", "weekly_ritual", "monthly_renewal", "quarterly_reset", "annual_checkup"] as const;
const CATEGORY_LABELS: Record<string, string> = {
  daily_practice: "Daily",
  weekly_ritual: "Weekly",
  monthly_renewal: "Monthly",
  quarterly_reset: "Quarterly",
  annual_checkup: "Annual",
};

const CATEGORIES = [
  { value: "daily_practice", label: "Daily" },
  { value: "weekly_ritual", label: "Weekly" },
  { value: "monthly_renewal", label: "Monthly" },
  { value: "quarterly_reset", label: "Quarterly" },
  { value: "annual_checkup", label: "Annual" },
];

function categoryFromInterval(days: number): string {
  if (days <= 1) return "daily_practice";
  if (days <= 7) return "weekly_ritual";
  if (days <= 30) return "monthly_renewal";
  if (days <= 90) return "quarterly_reset";
  return "annual_checkup";
}

function formatTimeSince(daysSince: number | null): string {
  if (daysSince === null) return "Never";
  if (daysSince === 0) return "Today";
  if (daysSince === 1) return "1d ago";
  if (daysSince < 7) return `${daysSince}d ago`;
  if (daysSince < 30) return `${Math.floor(daysSince / 7)}w ago`;
  return `${Math.floor(daysSince / 30)}mo ago`;
}

function formatMetricValue(value: number, metricType: string): string {
  if (metricType === "steps") {
    return `${value.toLocaleString()} steps`;
  }
  if (metricType === "mindful_minutes") {
    return `${Math.round(value * 10) / 10} min`;
  }
  return `${Math.round(value * 10) / 10}`;
}

function formatPulseLabel(activity: ActivityWithStatus): string {
  if (activity.pulse === "never_done") return "(0%)";
  const pct = activity.pulsePercent;
  return pct === null ? "(0%)" : `(${pct}%)`;
}

function InlineEditableText({
  value,
  activityId,
  field,
  placeholder,
  className,
  style,
}: {
  value: string;
  activityId: number;
  field: string;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const saveMutation = useMutation({
    mutationFn: async (newValue: string) => {
      await apiRequest("PATCH", `/api/wellness/activities/${activityId}`, { [field]: newValue || null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/pulse-buckets"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
      setLocalValue(value);
    },
  });

  const commitEdit = useCallback(() => {
    setEditing(false);
    if (localValue !== value) {
      saveMutation.mutate(localValue);
    }
  }, [localValue, value]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-testid={`inline-edit-${field}-${activityId}`}
        className={`bg-transparent border-b border-primary/30 outline-none text-sm w-full ${className ?? ""}`}
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") { setLocalValue(value); setEditing(false); } }}
        autoFocus
      />
    );
  }

  return (
    <span
      data-testid={`text-${field}-${activityId}`}
      className={`cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors ${className ?? ""}`}
      style={style}
      onClick={() => { setEditing(true); setLocalValue(value); }}
      title="Click to edit"
    >
      {value || <span className="text-muted-foreground/50 italic">{placeholder ?? "—"}</span>}
    </span>
  );
}

function InlineEditableNumber({
  value,
  activityId,
  field,
  suffix,
  className,
}: {
  value: number | null;
  activityId: number;
  field: string;
  suffix?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState(String(value ?? ""));
  const { toast } = useToast();

  const saveMutation = useMutation({
    mutationFn: async (newValue: number | null) => {
      const payload: Record<string, any> = { [field]: newValue };
      if (field === "intervalDays" && newValue !== null) {
        payload.category = categoryFromInterval(newValue);
      }
      await apiRequest("PATCH", `/api/wellness/activities/${activityId}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/pulse-buckets"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
      setLocalValue(String(value ?? ""));
    },
  });

  const commitEdit = useCallback(() => {
    setEditing(false);
    const parsed = localValue ? (field === "estimatedCost" ? parseFloat(localValue) : parseInt(localValue, 10)) : null;
    if (parsed !== value) {
      saveMutation.mutate(parsed);
    }
  }, [localValue, value, field]);

  if (editing) {
    return (
      <input
        data-testid={`inline-edit-${field}-${activityId}`}
        className={`bg-transparent border-b border-primary/30 outline-none text-xs w-16 ${className ?? ""}`}
        type="number"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={commitEdit}
        onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") { setLocalValue(String(value ?? "")); setEditing(false); } }}
        autoFocus
      />
    );
  }

  const display = value != null ? `${value}${suffix ?? ""}` : "—";
  return (
    <span
      data-testid={`text-${field}-${activityId}`}
      className={`cursor-pointer hover:bg-muted/50 rounded px-0.5 -mx-0.5 transition-colors ${className ?? ""}`}
      onClick={() => { setEditing(true); setLocalValue(String(value ?? "")); }}
      title="Click to edit"
    >
      {display}
    </span>
  );
}

// --- Inline journal expansion for Gratitude / Learning / Reflection ---

interface JournalEntry {
  id: number;
  content: string;
  date: string;
  createdAt: string;
  updatedAt: string;
}

function formatJournalDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
  if (dateStr === todayStr) return "Today";
  if (dateStr === yesterdayStr) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

type JournalType = "gratitude" | "learning" | "reflection";

const JOURNAL_COPY: Record<JournalType, { label: string; placeholder: string }> = {
  gratitude: { label: "Gratitude", placeholder: "What are you grateful for today?" },
  learning: { label: "Learning", placeholder: "What did you learn today?" },
  reflection: { label: "Reflection", placeholder: "What do you want to reflect on today?" },
};

function JournalExpansion({ type }: { type: JournalType }) {
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);
  const [content, setContent] = useState("");
  const [savedSuccess, setSavedSuccess] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();

  const { data: entries, isLoading } = useQuery<JournalEntry[]>({
    queryKey: [`/api/wellness/${type}`, 0],
    queryFn: async () => {
      const res = await fetch(`/api/wellness/${type}?limit=10&offset=0`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load entries");
      return res.json();
    },
  });

  // Load today's content into textarea
  useEffect(() => {
    if (entries && entries.length > 0) {
      const todayEntry = entries.find((e) => e.date === todayStr);
      if (todayEntry) setContent(todayEntry.content);
    }
  }, [entries, todayStr]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/wellness/${type}`, { content, date: todayStr });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/wellness/${type}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs"] });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
      toast({ title: `${JOURNAL_COPY[type].label} entry saved` });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (date: string) => {
      await apiRequest("DELETE", `/api/wellness/${type}/${date}`);
    },
    onSuccess: (_data, date) => {
      queryClient.invalidateQueries({ queryKey: [`/api/wellness/${type}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs"] });
      if (date === todayStr) setContent("");
      toast({ title: "Deleted", description: "Entry removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const todayEntry = entries?.find((e) => e.date === todayStr);
  const pastEntries = entries?.filter((e) => e.date !== todayStr) ?? [];

  return (
    <div className="ml-4 border-l border-border pl-3 py-1 space-y-1">
      {/* Today's input */}
      <div className="py-1">
        <textarea
          ref={textareaRef}
          className="w-full min-h-[60px] p-2 rounded-md border bg-background text-sm resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={JOURNAL_COPY[type].placeholder}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={5000}
        />
        <div className="flex items-center gap-2 mt-1">
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => saveMutation.mutate()}
            disabled={!content.trim() || saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : savedSuccess ? (
              <Check className="h-3 w-3 mr-1 text-success" />
            ) : null}
            {savedSuccess ? "Saved" : todayEntry ? "Update" : "Save"}
          </Button>
          {todayEntry && (
            <span className="text-xs text-muted-foreground">
              Last saved {new Date(todayEntry.updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>

      {/* Past entries as tree child rows */}
      {isLoading && <div className="py-2"><Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /></div>}
      {pastEntries.map((entry) => (
        <div
          key={entry.id}
          className="group/entry flex items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent/50"
        >
          <span className="text-xs font-medium text-muted-foreground shrink-0 pt-0.5 min-w-[60px]">
            {formatJournalDate(entry.date)}
          </span>
          <span className="flex-1 min-w-0 text-sm text-foreground line-clamp-2 whitespace-pre-wrap break-words">
            {entry.content}
          </span>
          <button
            type="button"
            className="h-5 w-5 shrink-0 rounded inline-flex items-center justify-center text-muted-foreground opacity-0 group-hover/entry:opacity-100 hover:text-destructive transition-opacity"
            onClick={() => deleteMutation.mutate(entry.date)}
            disabled={deleteMutation.isPending}
            aria-label="Delete entry"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

const EXPANDABLE_ACTIVITIES = new Set(["gratitude", "learning", "reflection"]);

function ActivityRow({ activity, onOpenDetails }: { activity: ActivityWithStatus; onOpenDetails: (activity: ActivityWithStatus) => void }) {
  const [logCooldown, setLogCooldown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const isExpandable = EXPANDABLE_ACTIVITIES.has(activity.name.toLowerCase());

  const logMutation = useMutation({
    mutationFn: async (date?: string) => {
      const body: Record<string, any> = { activityId: activity.id };
      if (date) body.date = date;
      await apiRequest("POST", "/api/wellness/log", body);
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/wellness/status"] });
      const previous = queryClient.getQueryData<ActivityWithStatus[]>(["/api/wellness/status"]);
      if (previous) {
        queryClient.setQueryData<ActivityWithStatus[]>(["/api/wellness/status"], (old) =>
          old?.map((a) =>
            a.id === activity.id
              ? {
                  ...a,
                  status: "on_track" as const,
                  daysSince: 0,
                  daysUntilDue: a.intervalDays,
                  urgency: 0,
                  lastCompletedAt: new Date().toISOString(),
                  doneToday: true,
                  doneForCurrentPeriod: true,
                  pulse: "good" as const,
                  pulsePercent: 100,
                }
              : a,
          ),
        );
      }
      return { previous };
    },
    onSuccess: (_data, date) => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/pulse-buckets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/activities", activity.id, "trends"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", activity.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", "all"] });
      const desc = date
        ? `${activity.name} logged for ${new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
        : activity.name;
      toast({ title: "Logged!", description: desc });
      setLogCooldown(true);
      setTimeout(() => setLogCooldown(false), 2000);
    },
    onError: (err: Error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/wellness/status"], context.previous);
      }
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div>
      <div
        data-testid={`row-activity-${activity.id}`}
        className="group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full select-none transition-colors overflow-hidden hover:bg-accent/70"
      >
        {/* Check circle — toggles expansion for expandable, logs for others */}
        <span className="shrink-0 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            data-testid={`button-log-${activity.id}`}
            className={activity.doneToday
              ? "h-4 w-4 rounded-full border border-success bg-transparent text-success inline-flex items-center justify-center transition-colors hover:bg-success/10"
              : "h-4 w-4 rounded-full border border-input bg-transparent inline-flex items-center justify-center transition-colors hover:border-success hover:bg-success/10"}
            disabled={!isExpandable && (logCooldown || logMutation.isPending)}
            onClick={() => {
              if (isExpandable) {
                setExpanded((prev) => !prev);
              } else {
                logMutation.mutate(undefined);
              }
            }}
          >
            {logMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : activity.doneToday ? (
              <Check className="h-3 w-3" />
            ) : null}
          </button>
        </span>

        {/* Heart pulse icon */}
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="relative h-4 w-4 shrink-0" aria-label={`${activity.name} pulse ${activity.pulsePercent ?? 0}%`}>
                <Heart className="absolute inset-0 h-4 w-4 text-muted-foreground/25" />
                <Heart
                  className="absolute inset-0 h-4 w-4 text-white fill-white"
                  strokeWidth={0}
                  style={{ opacity: Math.max(0, Math.min(100, activity.pulsePercent ?? 0)) / 100 }}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {activity.pulsePercent ?? 0}%
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        {/* Activity name */}
        <span
          className={`truncate flex-1 min-w-0 leading-5 ${activity.doneToday ? "text-muted-foreground" : "text-foreground"}`}
        >
          {activity.name}
        </span>

        {/* Right-side controls */}
        <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          {/* Expander — only for expandable activities */}
          {isExpandable && (
            <button
              type="button"
              className="p-0.5 shrink-0 rounded hover:bg-accent/60"
              onClick={() => setExpanded((prev) => !prev)}
              aria-label={`Expand ${activity.name}`}
            >
              <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
            </button>
          )}
          {/* Overflow menu */}
          <button
            type="button"
            data-testid={`button-details-${activity.id}`}
            className="h-6 w-6 rounded-md inline-flex items-center justify-center text-muted-foreground opacity-0 transition-colors group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground"
            onClick={() => onOpenDetails(activity)}
            aria-label={`Open ${activity.name} details`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Expanded journal content */}
      {isExpandable && expanded && (
        <JournalExpansion type={activity.name.toLowerCase() as JournalType} />
      )}
    </div>
  );
}
function CategorySection({
  category,
  activities,
  bucket,
  onOpenDetails,
}: {
  category: string;
  activities: ActivityWithStatus[];
  bucket?: BucketPulseRollup;
  onOpenDetails: (activity: ActivityWithStatus) => void;
}) {
  if (activities.length === 0) return null;

  const label = CATEGORY_LABELS[category] ?? category;
  // Default: daily/weekly open, others collapsed
  const defaultOpen = category === "daily_practice" || category === "weekly_ritual";
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`section-${category}`}>
      <CollapsibleTrigger
        className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover:bg-accent/50 rounded-md"
        data-testid={`button-group-${category}`}
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-0 mt-0">
          {activities.map((a) => (
            <ActivityRow key={a.id} activity={a} onOpenDetails={onOpenDetails} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
function AddActivityDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const [formData, setFormData] = useState({
    name: "",
    benefit: "",
    risk: "",
    estimatedMinutes: 15,
    estimatedCost: 0,
    intervalDays: 1,
    requirements: "",
    category: "daily_practice",
  });

  const resetForm = () => setFormData({
    name: "", benefit: "", risk: "", estimatedMinutes: 15,
    estimatedCost: 0, intervalDays: 1, requirements: "", category: "daily_practice",
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/wellness/activities", formData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/pulse-buckets"] });
      toast({ title: "Activity created", description: `${formData.name} added` });
      resetForm();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetForm(); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Activity</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="activity-name">Name</Label>
            <Input
              id="activity-name"
              data-testid="input-activity-name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g. Morning yoga"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="activity-interval">Every N days</Label>
              <Input
                id="activity-interval"
                data-testid="input-activity-interval"
                type="number"
                min={1}
                value={formData.intervalDays}
                onChange={(e) => {
                  const days = parseInt(e.target.value) || 1;
                  setFormData({ ...formData, intervalDays: days, category: categoryFromInterval(days) });
                }}
              />
            </div>
            <div>
              <Label htmlFor="activity-category">Category</Label>
              <Select value={formData.category} onValueChange={(v) => setFormData({ ...formData, category: v })}>
                <SelectTrigger data-testid="select-activity-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="activity-benefit">Benefit</Label>
            <Input
              id="activity-benefit"
              data-testid="input-activity-benefit"
              value={formData.benefit}
              onChange={(e) => setFormData({ ...formData, benefit: e.target.value })}
              placeholder="Why this matters"
            />
          </div>
          <div>
            <Label htmlFor="activity-risk">Risk if skipped</Label>
            <Input
              id="activity-risk"
              data-testid="input-activity-risk"
              value={formData.risk}
              onChange={(e) => setFormData({ ...formData, risk: e.target.value })}
              placeholder="What happens if you skip this"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="activity-time">Est. minutes</Label>
              <Input
                id="activity-time"
                data-testid="input-activity-time"
                type="number"
                min={0}
                value={formData.estimatedMinutes}
                onChange={(e) => setFormData({ ...formData, estimatedMinutes: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div>
              <Label htmlFor="activity-cost">Est. cost ($)</Label>
              <Input
                id="activity-cost"
                data-testid="input-activity-cost"
                type="number"
                min={0}
                step={0.01}
                value={formData.estimatedCost}
                onChange={(e) => setFormData({ ...formData, estimatedCost: parseFloat(e.target.value) || 0 })}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="activity-requirements">Requirements</Label>
            <Input
              id="activity-requirements"
              data-testid="input-activity-requirements"
              value={formData.requirements}
              onChange={(e) => setFormData({ ...formData, requirements: e.target.value })}
              placeholder="e.g. gym membership, equipment"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { resetForm(); onOpenChange(false); }} data-testid="button-cancel-activity">
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !formData.name.trim()}
            data-testid="button-save-activity"
          >
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Add Activity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}



export function CalendarContent() {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedHeatmapDate, setSelectedHeatmapDate] = useState<string | null>(null);
  const [detailActivity, setDetailActivity] = useState<ActivityWithStatus | null>(null);

  const { toast } = useToast();
  const { timezone, isLoaded: tzLoaded } = useTimezone();

  const { data: activities, isLoading } = useQuery<ActivityWithStatus[]>({
    queryKey: ["/api/wellness/status"],
    refetchOnWindowFocus: true,
  });

  const { data: serverBuckets } = useQuery<BucketsByCategory>({
    queryKey: ["/api/wellness/pulse-buckets"],
    refetchOnWindowFocus: true,
    enabled: !!activities && activities.length > 0,
  });

  const buckets = useMemo<BucketsByCategory | undefined>(() => {
    if (serverBuckets) return serverBuckets;
    if (!activities) return undefined;
    return computeBucketRollup(activities);
  }, [serverBuckets, activities]);

  const { data: allLogs } = useQuery<WellnessLogEntry[]>({
    queryKey: ["/api/wellness/logs", "all"],
    queryFn: async () => {
      const res = await fetch("/api/wellness/logs?limit=500", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load logs");
      return res.json();
    },
    enabled: !!activities && activities.length > 0,
  });

  const loadDefaultsMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/wellness/load-defaults");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/pulse-buckets"] });
      toast({ title: "Default activities loaded" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const grouped = useMemo(() => {
    if (!activities) return {};
    const g: Record<string, ActivityWithStatus[]> = {};
    for (const cat of CATEGORY_ORDER) g[cat] = [];
    for (const a of activities) {
      if (!g[a.category]) g[a.category] = [];
      g[a.category].push(a);
    }
    const pulseRank: Record<string, number> = { danger: 0, okay: 1, never_done: 2, good: 3 };
    for (const cat of Object.keys(g)) {
      g[cat].sort((a, b) => {
        const r = (pulseRank[a.pulse] ?? 99) - (pulseRank[b.pulse] ?? 99);
        if (r !== 0) return r;
        return (b.pulsePercent ?? 0) - (a.pulsePercent ?? 0) === 0
          ? a.name.localeCompare(b.name)
          : (a.pulsePercent ?? 0) - (b.pulsePercent ?? 0);
      });
    }
    return g;
  }, [activities]);







  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-48" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-32 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (!activities || activities.length === 0) {
    return (
      <div className="p-6">
        <Card className="border-dashed">
          <CardContent className="pt-6 pb-6">
            <div className="flex flex-col items-center text-center gap-3">
              <Check className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="font-medium">No wellness activities yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Add your first wellness activity or load the defaults to get started.
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => loadDefaultsMutation.mutate()} disabled={loadDefaultsMutation.isPending} data-testid="button-load-defaults">
                  {loadDefaultsMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                  Load Defaults
                </Button>
                <Button onClick={() => setShowCreate(true)} data-testid="button-add-first-activity">
                  <Plus className="h-4 w-4 mr-1" /> Add Activity
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
        <Dialog open={!!detailActivity} onOpenChange={(open) => { if (!open) setDetailActivity(null); }}>
          <DialogContent className="max-w-3xl h-[82vh] p-0 overflow-hidden">
            {detailActivity && (
              <ActivityDetailView
                activity={detailActivity}
                onBack={() => setDetailActivity(null)}
                onDelete={() => setDetailActivity(null)}
              />
            )}
          </DialogContent>
        </Dialog>

        <AddActivityDialog open={showCreate} onOpenChange={setShowCreate} />
      </div>
    );
  }

  return (
    <TimezoneContext.Provider value={timezone}>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Heatmap stays full-width above the list */}
        {tzLoaded && allLogs && allLogs.length > 0 && (
          <div className="px-3 pt-4 @sm:px-4 @sm:pt-5 shrink-0">
            <GlobalCompletionCalendar
              logs={allLogs}
              onSelectDate={setSelectedHeatmapDate}
            />
          </div>
        )}

        <HeatmapDayDialog
          date={selectedHeatmapDate}
          activities={activities ?? []}
          onClose={() => setSelectedHeatmapDate(null)}
        />

        {/* Activity hierarchy list */}
        <div className="flex-1 overflow-y-auto px-3 @sm:px-4 py-3">
          <div className="space-y-1">
            {CATEGORY_ORDER.map((cat) => (
              <CategorySection
                key={cat}
                category={cat}
                activities={grouped[cat] ?? []}
                bucket={buckets?.[cat]}
                onOpenDetails={setDetailActivity}
              />
            ))}
          </div>
          <div className="mt-3 px-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCreate(true)}
              className="w-full"
              data-testid="button-add-activity-bottom"
            >
              <Plus className="h-3 w-3 mr-1.5" />
              New Activity
            </Button>
          </div>
        </div>

        <Dialog open={!!detailActivity} onOpenChange={(open) => { if (!open) setDetailActivity(null); }}>
          <DialogContent className="max-w-3xl h-[82vh] p-0 overflow-hidden">
            {detailActivity && (
              <ActivityDetailView
                activity={detailActivity}
                onBack={() => setDetailActivity(null)}
                onDelete={() => setDetailActivity(null)}
              />
            )}
          </DialogContent>
        </Dialog>

        <AddActivityDialog open={showCreate} onOpenChange={setShowCreate} />
      </div>
    </TimezoneContext.Provider>
  );
}
