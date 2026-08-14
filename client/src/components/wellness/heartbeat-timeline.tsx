import { isConsecutiveCadenceCompletion } from "@shared/wellness-window";
import { useMemo } from "react";

export interface WellnessLogEntry {
  id: number;
  activityId: number;
  notes: string | null;
  tier: string | null;
  metricValue: number | null;
  completedAt: string;
}

interface TimelineEvent {
  entry: WellnessLogEntry;
  x: number;
  left: number;
  right: number;
  isStreakDay: boolean;
  scale: number;
}

type ConnectorSegment =
  | {
      key: string;
      x1: number;
      x2: number;
      kind: "solid";
      className: string;
      opacity: number;
    }
  | {
      key: string;
      x1: number;
      x2: number;
      kind: "blend";
      fromIsStreakDay: boolean;
      toIsStreakDay: boolean;
    };

export interface HeartbeatTimelineModel {
  events: TimelineEvent[];
  ticks: Array<{ timestamp: number; x: number }>;
  connectors: ConnectorSegment[];
  domainEnd: number;
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
/** Completions always paint full strength — Window is label/cue only. */
const COMPLETION_OPACITY = 1;

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

/** Token stroke for gradient stops — matches stroke-success / stroke-foreground. */
function paintStopColor(isStreakDay: boolean, opacity: number): string {
  const token = isStreakDay ? "var(--success)" : "var(--foreground)";
  return `hsl(${token} / ${opacity.toFixed(3)})`;
}

/** Open-ended connectors keep a single solid stroke from the adjacent spike (or muted empty). */
function openEndedSegment(
  key: string,
  x1: number,
  x2: number,
  neighbor: Pick<TimelineEvent, "isStreakDay"> | null,
): ConnectorSegment {
  if (!neighbor) {
    return { key, x1, x2, kind: "solid", className: "stroke-muted-foreground/40", opacity: 0.35 };
  }
  return {
    key,
    x1,
    x2,
    kind: "solid",
    className: eventStrokeClass(neighbor.isStreakDay),
    opacity: COMPLETION_OPACITY,
  };
}

/**
 * Mid connectors blend naturally when the two spike colors differ.
 * Same-color pairs stay a single solid stroke at full completion opacity.
 */
function midSegment(
  key: string,
  x1: number,
  x2: number,
  left: Pick<TimelineEvent, "isStreakDay">,
  right: Pick<TimelineEvent, "isStreakDay">,
): ConnectorSegment {
  if (left.isStreakDay === right.isStreakDay) {
    return {
      key,
      x1,
      x2,
      kind: "solid",
      className: eventStrokeClass(left.isStreakDay),
      opacity: COMPLETION_OPACITY,
    };
  }
  return {
    key,
    x1,
    x2,
    kind: "blend",
    fromIsStreakDay: left.isStreakDay,
    toIsStreakDay: right.isStreakDay,
  };
}

export function buildHeartbeatTimeline(
  logs: WellnessLogEntry[],
  intervalDays: number,
  timezone: string,
): HeartbeatTimelineModel {
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
    .slice()
    .sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime())
    .map((entry, index, orderedLogs) => {
      const completedAt = new Date(entry.completedAt);
      // Window is a UI recommendation only — never dims paint.
      const previousEntry = orderedLogs[index - 1];
      const previousCompletedAt = previousEntry ? new Date(previousEntry.completedAt) : null;
      const isStreakDay = Boolean(
        previousCompletedAt
        && isConsecutiveCadenceCompletion(previousCompletedAt, completedAt, intervalDays, timezone),
      );
      const x = toX(completedAt.getTime());
      const scale = spikeScaleForId(entry.id);
      const { left, right } = spikeEdges(x, scale);
      return {
        entry,
        x,
        left,
        right,
        isStreakDay,
        scale,
      };
    });

  // Stop the living baseline at the current moment inside today's band, not end-of-day.
  const nowX = Math.max(GRAPH_LEFT, Math.min(GRAPH_RIGHT, toX(Math.min(now, domainEnd))));

  // Connectors stop at spike feet so the path + segments read as one contiguous EKG line.
  const connectors: ConnectorSegment[] = [];
  if (events.length === 0) {
    connectors.push(openEndedSegment("empty", GRAPH_LEFT, nowX, null));
  } else {
    const first = events[0];
    const last = events[events.length - 1];
    if (first.left > GRAPH_LEFT) {
      connectors.push(openEndedSegment("lead", GRAPH_LEFT, first.left, first));
    }
    for (let i = 0; i < events.length - 1; i += 1) {
      const a = events[i];
      const b = events[i + 1];
      if (b.left > a.right) {
        connectors.push(midSegment(`seg-${a.entry.id}-${b.entry.id}`, a.right, b.left, a, b));
      }
    }
    if (nowX > last.right) {
      connectors.push(openEndedSegment("trail", last.right, nowX, last));
    }
  }

  return { events, ticks, connectors, domainEnd };
}

function useHeartbeatTimeline(
  logs: WellnessLogEntry[],
  intervalDays: number,
): HeartbeatTimelineModel {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return useMemo(
    () => buildHeartbeatTimeline(logs, intervalDays, timezone),
    [logs, intervalDays, timezone],
  );
}

function HeartbeatPaint({
  timeline,
  gradientIdPrefix,
  showAxis,
  showTicks,
}: {
  timeline: HeartbeatTimelineModel;
  gradientIdPrefix: string;
  showAxis: boolean;
  showTicks: boolean;
}) {
  const blendGradients = timeline.connectors.filter(
    (segment): segment is Extract<ConnectorSegment, { kind: "blend" }> => segment.kind === "blend",
  );

  return (
    <>
      {blendGradients.length > 0 ? (
        <defs>
          {blendGradients.map(({ key, x1, x2, fromIsStreakDay, toIsStreakDay }) => (
            <linearGradient
              key={`grad-${key}`}
              id={`${gradientIdPrefix}-${key}`}
              gradientUnits="userSpaceOnUse"
              x1={x1}
              y1={BASELINE_Y}
              x2={x2}
              y2={BASELINE_Y}
            >
              <stop offset="0%" stopColor={paintStopColor(fromIsStreakDay, COMPLETION_OPACITY)} />
              <stop offset="100%" stopColor={paintStopColor(toIsStreakDay, COMPLETION_OPACITY)} />
            </linearGradient>
          ))}
        </defs>
      ) : null}
      {showTicks
        ? timeline.ticks.map(({ timestamp, x }) => {
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
          })
        : null}
      {showAxis ? (
        <line
          x1={GRAPH_LEFT}
          y1={BASELINE_Y}
          x2={GRAPH_RIGHT}
          y2={BASELINE_Y}
          className="stroke-muted-foreground/25"
          strokeWidth={SPIKE_STROKE_WIDTH}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {timeline.connectors.map((segment) => {
        if (segment.x2 <= segment.x1) return null;
        if (segment.kind === "blend") {
          return (
            <line
              key={segment.key}
              x1={segment.x1}
              y1={BASELINE_Y}
              x2={segment.x2}
              y2={BASELINE_Y}
              stroke={`url(#${gradientIdPrefix}-${segment.key})`}
              strokeWidth={SPIKE_STROKE_WIDTH}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
            />
          );
        }
        return (
          <line
            key={segment.key}
            x1={segment.x1}
            y1={BASELINE_Y}
            x2={segment.x2}
            y2={BASELINE_Y}
            className={segment.className}
            strokeWidth={SPIKE_STROKE_WIDTH}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            style={{ opacity: segment.opacity }}
          />
        );
      })}
      {timeline.events.map(({ entry, x, left, right, isStreakDay, scale }) => (
        <path
          key={entry.id}
          d={heartbeatPath(x, scale, left, right)}
          fill="none"
          className={eventStrokeClass(isStreakDay)}
          strokeWidth={SPIKE_STROKE_WIDTH}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ opacity: COMPLETION_OPACITY }}
        >
          <title>{new Date(entry.completedAt).toLocaleString()}</title>
        </path>
      ))}
    </>
  );
}

/** Full Trends graph for the activity details screen (axis + date ticks + heartbeat). */
export function HeartbeatHistory({
  logs,
  intervalDays,
}: {
  logs: WellnessLogEntry[];
  intervalDays: number;
}) {
  const timeline = useHeartbeatTimeline(logs, intervalDays);

  return (
    <div className="min-w-0 overflow-hidden">
      <svg
        viewBox="0 0 1000 240"
        preserveAspectRatio="none"
        className="h-56 w-full"
        role="img"
        aria-label="Activity timeline with ideal cadence ticks and completion heartbeats through now"
      >
        <HeartbeatPaint timeline={timeline} gradientIdPrefix="trends-seg" showAxis showTicks />
      </svg>
    </div>
  );
}

/**
 * Compact list-row sparkline: segments + spikes only (no axis or date labels).
 * Cropped vertically around the EKG so it reads at row height.
 */
export function ActivityHeartbeatSparkline({
  logs,
  intervalDays,
  activityId,
}: {
  logs: WellnessLogEntry[];
  intervalDays: number;
  activityId: number;
}) {
  const timeline = useHeartbeatTimeline(logs, intervalDays);

  return (
    <div className="min-w-0 flex-1 overflow-hidden" aria-hidden="true">
      <svg
        viewBox="0 20 1000 180"
        preserveAspectRatio="none"
        className="h-5 w-full"
        role="img"
        aria-label="Activity completion heartbeat"
        data-testid={`row-heartbeat-${activityId}`}
      >
        <HeartbeatPaint
          timeline={timeline}
          gradientIdPrefix={`row-seg-${activityId}`}
          showAxis={false}
          showTicks={false}
        />
      </svg>
    </div>
  );
}
