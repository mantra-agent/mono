import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { getWellnessWindowAdherence, isConsecutiveCadenceCompletion } from "@shared/wellness-window";
import { useMemo } from "react";

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
  left: number;
  right: number;
  adherence: number;
  isStreakDay: boolean;
  scale: number;
}

/** Fixed 7 cadence segments across the Trends window. */
const HISTORY_INTERVALS = 7;
const GRAPH_LEFT = 16;
const GRAPH_RIGHT = 984;
const BASELINE_Y = 128;
const SPIKE_STROKE_WIDTH = 0.75;
/** Unscaled half-width of a heartbeat path from center to each baseline foot. */
const SPIKE_HALF_WIDTH = 40;
/** Base spike size relative to the original path amplitude. */
const SPIKE_BASE_SCALE = 0.7;
/** Per-spike variance around SPIKE_BASE_SCALE (±10%). */
const SPIKE_SCALE_VARIANCE = 0.1;

/** Stable 0–1 hash from a numeric id so spike sizes don't reshuffle on re-render. */
function unitHash(id: number): number {
  const mixed = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  return (mixed % 10_000) / 10_000;
}

function spikeScaleForId(id: number): number {
  const variance = (unitHash(id) * 2 - 1) * SPIKE_SCALE_VARIANCE;
  return SPIKE_BASE_SCALE * (1 + variance);
}

function spikeEdges(x: number, scale: number): { left: number; right: number } {
  return {
    left: Math.max(GRAPH_LEFT, x - SPIKE_HALF_WIDTH * scale),
    right: Math.min(GRAPH_RIGHT, x + SPIKE_HALF_WIDTH * scale),
  };
}

/** Heartbeat path scaled around the baseline at x. Feet land on left/right edges. */
function heartbeatPath(x: number, scale: number, left: number, right: number): string {
  const y = BASELINE_Y;
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

function HeartbeatHistory({ logs, category, intervalDays, windowStart, windowEnd }: Omit<ActivityDetailPanelProps, "activityId" | "metricInfo" | "pulseWindowSize"> & { logs: WellnessLogEntry[] }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeline = useMemo(() => {
    const intervalMs = Math.max(1, intervalDays) * 86_400_000;
    const now = Date.now();
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    const domainEnd = todayEnd.getTime();
    const domainStart = domainEnd - HISTORY_INTERVALS * intervalMs;
    const domainDuration = Math.max(1, domainEnd - domainStart);
    const toX = (timestamp: number) =>
      GRAPH_LEFT + ((timestamp - domainStart) / domainDuration) * (GRAPH_RIGHT - GRAPH_LEFT);
    const ticks = Array.from({ length: HISTORY_INTERVALS + 1 }, (_, index) => ({
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
        const x = toX(completedAt.getTime());
        const scale = spikeScaleForId(entry.id);
        const { left, right } = spikeEdges(x, scale);
        return {
          entry,
          x,
          left,
          right,
          adherence,
          isStreakDay,
          scale,
        };
      });

    // Stop the living baseline at the current moment inside today's band, not end-of-day.
    const nowX = Math.max(GRAPH_LEFT, Math.min(GRAPH_RIGHT, toX(Math.min(now, domainEnd))));

    // Connectors stop at spike feet so the path + segments read as one contiguous EKG line.
    const connectors: Array<{ key: string; x1: number; x2: number; className: string; opacity: number }> = [];
    if (events.length === 0) {
      const style = segmentStyle(null, null);
      connectors.push({ key: "empty", x1: GRAPH_LEFT, x2: nowX, ...style });
    } else {
      const first = events[0];
      const last = events[events.length - 1];
      if (first.left > GRAPH_LEFT) {
        const lead = segmentStyle(null, first);
        connectors.push({ key: "lead", x1: GRAPH_LEFT, x2: first.left, ...lead });
      }
      for (let i = 0; i < events.length - 1; i += 1) {
        const a = events[i];
        const b = events[i + 1];
        if (b.left > a.right) {
          const style = segmentStyle(a, b);
          connectors.push({ key: `seg-${a.entry.id}-${b.entry.id}`, x1: a.right, x2: b.left, ...style });
        }
      }
      if (nowX > last.right) {
        const trail = segmentStyle(last, null);
        connectors.push({ key: "trail", x1: last.right, x2: nowX, ...trail });
      }
    }

    return { events, ticks, connectors, domainEnd };
  }, [logs, category, intervalDays, windowStart, windowEnd, timezone]);

  return (
    <div className="min-w-0 overflow-hidden">
      <svg
        viewBox="0 0 1000 240"
        preserveAspectRatio="none"
        className="h-56 w-full"
        role="img"
        aria-label="Activity timeline with ideal cadence ticks and completion heartbeats through now"
      >
        {timeline.ticks.map(({ timestamp, x }) => {
          const date = new Date(timestamp);
          const label = `${date.getMonth() + 1}/${date.getDate()}`;
          const isEnd = timestamp === timeline.domainEnd;
          return (
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
              <text x={x} y="214" textAnchor={isEnd ? "end" : "middle"} className="fill-muted-foreground text-[12px]">
                {label}
              </text>
              <title>{`Ideal completion · ${date.toLocaleDateString()}`}</title>
            </g>
          );
        })}
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
        {timeline.events.map(({ entry, x, left, right, adherence, isStreakDay, scale }) => (
          <path
            key={entry.id}
            d={heartbeatPath(x, scale, left, right)}
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

export function ActivityDetailPanel({ activityId, category, intervalDays, windowStart, windowEnd, metricInfo }: ActivityDetailPanelProps) {
  const { data: logs, isLoading: logsLoading } = useQuery<WellnessLogEntry[]>({ queryKey: ["/api/wellness/logs", activityId], queryFn: async () => {
    const response = await fetch(`/api/wellness/logs?activityId=${activityId}&limit=500`, { credentials: "include" });
    if (!response.ok) throw new Error("Failed to load logs");
    return response.json();
  }});

  if (logsLoading) return <div className="space-y-3 py-3"><Skeleton className="h-40 w-full" /></div>;
  const displayLogs = logs ?? [];

  return (
    <div className="space-y-2" data-testid={`detail-panel-${activityId}`}>
      <HeartbeatHistory logs={displayLogs} category={category} intervalDays={intervalDays} windowStart={windowStart} windowEnd={windowEnd} />
      {metricInfo?.linkedMetricType && <div className="text-xs text-muted-foreground">Linked to {metricInfo.linkedMetricType}</div>}
    </div>
  );
}
