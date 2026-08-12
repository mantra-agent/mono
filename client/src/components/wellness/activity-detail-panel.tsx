import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getWellnessWindowAdherence } from "@shared/wellness-window";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ActivityTrends } from "@shared/models/health";

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
  windowStart: number | null;
  windowEnd: number | null;
  metricInfo?: ActivityMetricInfo;
}

const MIN_HISTORY_INTERVALS = 5;

function formatMetricValue(value: number, metricType?: string | null): string {
  const num = value >= 1000 ? value.toLocaleString() : `${Math.round(value * 10) / 10}`;
  if (metricType === "mindful_minutes") return `${num} min`;
  if (metricType === "steps") return `${num} steps`;
  return num;
}

function HeartbeatHistory({ logs, category, pulseWindowSize, windowStart, windowEnd }: Omit<ActivityDetailPanelProps, "activityId" | "metricInfo"> & { logs: WellnessLogEntry[] }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const events = useMemo(() => {
    const historyIntervalCount = Math.max(MIN_HISTORY_INTERVALS, pulseWindowSize);
    const entries = logs.slice(0, historyIntervalCount).reverse();
    const timestamps = entries.map((entry) => new Date(entry.completedAt).getTime());
    const firstTimestamp = timestamps[0] ?? 0;
    const lastTimestamp = timestamps[timestamps.length - 1] ?? firstTimestamp;
    const elapsed = Math.max(1, lastTimestamp - firstTimestamp);

    return entries.map((entry, index) => ({
      entry,
      x: entries.length === 1 ? 500 : 24 + ((timestamps[index] - firstTimestamp) / elapsed) * 952,
      adherence: getWellnessWindowAdherence(category, windowStart, windowEnd, new Date(entry.completedAt), timezone),
    }));
  }, [logs, category, pulseWindowSize, windowStart, windowEnd, timezone]);

  if (events.length === 0) {
    return <p className="px-2 py-1.5 text-sm text-muted-foreground">No completions yet.</p>;
  }

  return (
    <div className="space-y-2">
      <svg viewBox="0 0 1000 240" preserveAspectRatio="none" className="h-56 w-full" role="img" aria-label="Activity completion timeline; each heartbeat blip marks when the activity was completed">
        <line x1="16" y1="128" x2="984" y2="128" className="stroke-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {events.map(({ entry, x, adherence }) => (
          <path
            key={entry.id}
            d={`M ${Math.max(16, x - 20)} 128 L ${x - 11} 128 L ${x - 7} 110 L ${x - 3} 150 L ${x + 2} 62 L ${x + 6} 142 L ${x + 11} 118 L ${Math.min(984, x + 20)} 128`}
            fill="none"
            className="stroke-foreground"
            strokeWidth="0.75"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: Math.max(0.12, adherence / 100) }}
          >
            <title>{`${new Date(entry.completedAt).toLocaleString()} · ${adherence}% on track`}</title>
          </path>
        ))}
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{new Date(events[0].entry.completedAt).toLocaleDateString()}</span>
        <span>Each blip is one completion</span>
        <span>{new Date(events[events.length - 1].entry.completedAt).toLocaleDateString()}</span>
      </div>
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

export function ActivityDetailPanel({ activityId, category, pulseWindowSize, windowStart, windowEnd, metricInfo }: ActivityDetailPanelProps) {
  const { toast } = useToast();
  const [showAll, setShowAll] = useState(false);
  const { data: trends, isLoading: trendsLoading } = useQuery<ActivityTrends>({ queryKey: ["/api/wellness/activities", activityId, "trends"] });
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

  if (trendsLoading || logsLoading) return <div className="space-y-3 py-3"><Skeleton className="h-40 w-full" /><Skeleton className="h-20 w-full" /></div>;
  const displayLogs = logs ?? [];
  const visibleLogs = showAll ? displayLogs : displayLogs.slice(0, 20);

  return (
    <div className="space-y-4" data-testid={`detail-panel-${activityId}`}>
      <HeartbeatHistory logs={displayLogs} category={category} pulseWindowSize={pulseWindowSize} windowStart={windowStart} windowEnd={windowEnd} />
      {trends && trends.totalCompletions > 0 && <div className="flex gap-6 text-xs text-muted-foreground"><span>Current streak · {trends.currentStreak}</span><span>30d · {trends.rate30d ?? "—"}%</span><span>90d · {trends.rate90d ?? "—"}%</span></div>}
      {metricInfo?.linkedMetricType && <div className="text-xs text-muted-foreground">Linked to {metricInfo.linkedMetricType}</div>}
      <div className="divide-y divide-border/20">
        {visibleLogs.map((entry) => <LogHistoryItem key={entry.id} entry={entry} linkedMetricType={metricInfo?.linkedMetricType} onDelete={(id) => deleteMutation.mutate(id)} />)}
      </div>
      {!showAll && displayLogs.length > 20 && <Button variant="ghost" size="sm" className="text-cta" onClick={() => setShowAll(true)}>Show {displayLogs.length - 20} more</Button>}
    </div>
  );
}
