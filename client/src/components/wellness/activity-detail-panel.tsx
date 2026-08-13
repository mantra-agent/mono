import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getWellnessWindowAdherence, isConsecutiveCadenceCompletion } from "@shared/wellness-window";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

interface WellnessLogEntry {
  id: number;
  activityId: number;
  notes: string | null;
  tier: string | null;
  metricValue: number | null;
  completedAt: string;
}

interface ActivityMetricInfo {
  linkedMetricType?: string | null;
  goodThreshold?: number | null;
  greatThreshold?: number | null;
}

interface ActivityDetailPanelProps {
  activityId: number;
  category: string;
  pulseWindowSize: number;
  intervalDays: number;
  windowStart: number | null;
  windowEnd: number | null;
  metricInfo?: ActivityMetricInfo;
}

interface TimelineEvent {
  entry: WellnessLogEntry;
  x: number;
  adherence: number;
  isStreakDay: boolean;
  scale: number;
}

const MIN_HISTORY_INTERVALS = 5;
const GRAPH_LEFT = 16;
const GRAPH_RIGHT = 984;
const BASELINE_Y = 128;
const SPIKE_STROKE_WIDTH = 0.75;
/** Base spike size relative to the original path amplitude. */
const SPIKE_BASE_SCALE = 0.7;
/** Per-spike variance around SPIKE_BASE_SCALE (±10%). */
const SPIKE_SCALE_VARIANCE = 0.1;

function formatMetricValue(value: number, metricType?: string | null): string {
  const num = value >= 1000 ? value.toLocaleString() : `${Math.round(value * 10) / 10}`;
  if (metricType === "mindful_minutes") return `${num} min`;
  if (metricType === "steps") return `${num} steps`;
  return num;
}

/** Stable 0–1 hash from a numeric id so spike sizes don't reshuffle on re-render. */
function unitHash(id: number): number {
  const mixed = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return (mixed % 10_000) / 10_000;
}

function spikeScaleForId(id: number): number {
  const variance = (unitHash(id) * 2 - 1) * SPIKE_SCALE_VARIANCE;
  return SPIKE_BASE_SCALE * (1 + variance);
}

/** Heartbeat path scaled around the baseline at x. Original peak offsets preserved proportionally. */
function heartbeatPath(x: number, scale: number): string {
  const y = BASELINE_Y;
  const left = Math.max(GRAPH_LEFT, x - 40 * scale);
  const right = Math.min(GRAPH_RIGHT, x + 40 * scale);
  return [
    `M ${left} ${y}`,
    `L ${x - 22 * scale} ${y}`,
    `L ${x - 14 * scale} ${y - 36 * scale}`,
    `L ${x - 6 * scale} ${y + 44 * scale}`,
    `L ${x + 4 * scale} ${y - 124 * scale}`,
    `L ${x + 12 * scale} ${y + 28 * scale}`,
    `L ${x + 22 * scale} ${y - 20 * scale}`,
    `L ${right} ${y}`,
  ].join(" ");
}

function eventStrokeClass(isStreakDay: boolean): string {
  return isStreakDay ? "stroke-success" : "stroke-foreground";
}

function eventOpacity(adherence: number): number {
  return Math.max(0.12, adherence / 100);
}

/** Connector inherits green only when both ends are streak days; opacity is the weaker end. */
function segmentStyle(
  left: Pick<TimelineEvent, "adherence" | "isStreakDay"> | null,
  right: Pick<TimelineEvent, "adherence" | "isStreakDay"> | null,
): { className: string; opacity: number } {
  if (!left && !right) {
    return { className: "stroke-muted-foreground/40", opacity: 0.35 };
  }
  if (!left && right) {
    return { className: eventStrokeClass(right.isStreakDay), opacity: eventOpacity(right.adherence) };
  }
  if (left && !right) {
    return { className: eventStrokeClass(left.isStreakDay), opacity: eventOpacity(left.adherence) };
  }
  const bothStreak = Boolean(left?.isStreakDay && right?.isStreakDay);
  return {
    className: eventStrokeClass(bothStreak),
    opacity: Math.min(eventOpacity(left!.adherence), eventOpacity(right!.adherence)),
  };
}

function HeartbeatHistory({ logs, category, pulseWindowSize, intervalDays, windowStart, windowEnd }: Omit<ActivityDetailPanelProps, "activityId" | "metricInfo"> & { logs: WellnessLogEntry[] }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeline = useMemo(() => {
    const intervalCount = Math.max(MIN_HISTORY_INTERVALS, pulseWindowSize);
    const intervalMs = Math.max(1, intervalDays) * 86_400_000;
    const now = Date.now();
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const domainEnd = todayEnd.getTime();
    const domainStart = domainEnd - intervalCount * intervalMs;
    const domainDuration = Math.max(1, domainEnd - domainStart);
    const toX = (timestamp: number) =>
      GRAPH_LEFT + ((timestamp - domainStart) / domainDuration) * (GRAPH_RIGHT - GRAPH_LEFT);
    const ticks = Array.from({ length: intervalCount + 1 }, (_, index) => ({
      timestamp: domainStart + index * intervalMs,
      x: toX(domainStart + index * intervalMs),
    }));
    const events: TimelineEvent[] = logs
      .filter((entry) => {
        const timestamp = new Date(entry.completedAt).getTime();
        return timestamp >= domainStart && timestamp <= domainEnd;
      })
      .reverse()
      .map((entry, index, orderedLogs) => {
        const completedAt = new Date(entry.completedAt);
        const adherence = getWellnessWindowAdherence(category, windowStart, windowEnd, completedAt, timezone);
        const previousEntry = orderedLogs[index - 1];
        const previousCompletedAt = previousEntry ? new Date(previousEntry.completedAt) : null;
        const isStreakDay = adherence === 100 && previousCompletedAt
          && getWellnessWindowAdherence(category, windowStart, windowEnd, previousCompletedAt, timezone) === 100
          && isConsecutiveCadenceCompletion(previousCompletedAt, completedAt, intervalDays, timezone);
        return {
          entry,
          x: toX(completedAt.getTime()),
          adherence,
          isStreakDay,
          scale: spikeScaleForId(entry.id),
        };
      });

    // Stop the living baseline at the current moment inside today's band, not end-of-day.
    const nowX = Math.max(GRAPH_LEFT, Math.min(GRAPH_RIGHT, toX(Math.min(now, domainEnd))));

    const connectors: Array<{ key: string; x1: number; x2: number; className: string; opacity: number }> = [];
    if (events.length === 0) {
      const style = segmentStyle(null, null);
      connectors.push({ key: "empty", x1: GRAPH_LEFT, x2: nowX, ...style });
    } else {
      const first = events[0];
      const last = events[events.length - 1];
      const lead = segmentStyle(null, first);
      connectors.push({ key: "lead", x1: GRAPH_LEFT, x2: first.x, ...lead });
      for (let i = 0; i < events.length - 1; i += 1) {
        const a = events[i];
        const b = events[i + 1];
        const style = segmentStyle(a, b);
        connectors.push({ key: `seg-${a.entry.id}-${b.entry.id}`, x1: a.x, x2: b.x, ...style });
      }
      if (nowX > last.x) {
        const trail = segmentStyle(last, null);
        connectors.push({ key: "trail", x1: last.x, x2: nowX, ...trail });
      }
    }

    return { events, ticks, connectors, nowX };
  }, [logs, category, pulseWindowSize, intervalDays, windowStart, windowEnd, timezone]);

  return (
    <div className="min-w-0 overflow-hidden">
      <svg
        viewBox="0 0 1000 240"
        preserveAspectRatio="none"
        className="h-56 w-full"
        role="img"
        aria-label="Activity timeline with ideal cadence ticks and completion heartbeats through now"
      >
        {timeline.ticks.map(({ timestamp, x }) => (
          <g key={timestamp}>
            <line
              x1={x}
              y1={BASELINE_Y}
              x2={x}
              y2="194"
              className="stroke-muted-foreground/60"
              strokeWidth="0.75"
              vectorEffect="non-scaling-stroke"
            />
            <title>{`Ideal completion · ${new Date(timestamp).toLocaleDateString()}`}</title>
          </g>
        ))}
        {timeline.connectors.map(({ key, x1, x2, className, opacity }) => (
          x2 > x1 ? (
            <line
              key={key}
              x1={x1}
              y1={BASELINE_Y}
              x2={x2}
              y2={BASELINE_Y}
              className={className}
              strokeWidth={SPIKE_STROKE_WIDTH}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              style={{ opacity }}
            />
          ) : null
        ))}
        {timeline.events.map(({ entry, x, adherence, isStreakDay, scale }) => (
          <path
            key={entry.id}
            d={heartbeatPath(x, scale)}
            fill="none"
            className={eventStrokeClass(isStreakDay)}
            strokeWidth={SPIKE_STROKE_WIDTH}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: eventOpacity(adherence) }}
          >
            <title>{`${new Date(entry.completedAt).toLocaleString()} · ${adherence}% on track`}</title>
          </path>
        ))}
      </svg>
    </div>
  );
}

function LogHistoryItem({ entry, onDelete, linkedMetricType }: { entry: WellnessLogEntry; onDelete: (id: number) => void; linkedMetricType?: string | null }) {
  const formatted = new Date(entry.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className="group flex min-h-11 items-center justify-between px-2" data-testid={`log-entry-${entry.id}`}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-sm text-foreground">{formatted}</span>
        {entry.tier && <span className="text-xs text-muted-foreground">{entry.tier === "great" ? "Great" : "Good"}{entry.metricValue != null && ` · ${formatMetricValue(entry.metricValue, linkedMetricType)}`}</span>}
        {!entry.tier && entry.notes && <span className="truncate text-xs text-muted-foreground">{entry.notes}</span>}
      </div>
      <Button variant="ghost" size="icon" className="h-11 w-11 text-destructive opacity-100 @md:opacity-0 @md:group-hover:opacity-100" onClick={() => onDelete(entry.id)} aria-label="Delete completion">
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function ActivityDetailPanel({ activityId, category, pulseWindowSize, intervalDays, windowStart, windowEnd, metricInfo }: ActivityDetailPanelProps) {
  const { toast } = useToast();
  const [showAll, setShowAll] = useState(false);
  const { data: logs, isLoading: logsLoading } = useQuery<WellnessLogEntry[]>({ queryKey: ["/api/wellness/logs", activityId], queryFn: async () => {
    const response = await fetch(`/api/wellness/logs?activityId=${activityId}&limit=500`, { credentials: "include" });
    if (!response.ok) throw new Error("Failed to load logs");
    return response.json();
  }});
  const deleteMutation = useMutation({ mutationFn: (logId: number) => apiRequest("DELETE", `/api/wellness/logs/${logId}`), onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", activityId] });
    queryClient.invalidateQueries({ queryKey: ["/api/wellness/activities", activityId, "trends"] });
    queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
    toast({ title: "Log deleted" });
  }, onError: (error: Error) => toast({ title: "Delete failed", description: error.message, variant: "destructive" }) });

  if (logsLoading) return <div className="space-y-3 py-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-20 w-full" /></div>;
  const displayLogs = logs ?? [];
  const visibleLogs = showAll ? displayLogs : displayLogs.slice(0, 20);

  return (
    <div className="space-y-4" data-testid={`detail-panel-${activityId}`}>
      <HeartbeatHistory logs={displayLogs} category={category} pulseWindowSize={pulseWindowSize} intervalDays={intervalDays} windowStart={windowStart} windowEnd={windowEnd} />
      {metricInfo?.linkedMetricType && <div className="text-xs text-muted-foreground">Linked to {metricInfo.linkedMetricType}</div>}
      <div className="divide-y divide-border/20">
        {visibleLogs.map((entry) => <LogHistoryItem key={entry.id} entry={entry} linkedMetricType={metricInfo?.linkedMetricType} onDelete={(id) => deleteMutation.mutate(id)} />)}
      </div>
      {!showAll && displayLogs.length > 20 && <Button variant="ghost" size="sm" className="text-cta" onClick={() => setShowAll(true)}>Show {displayLogs.length - 20} more</Button>}
    </div>
  );
}
