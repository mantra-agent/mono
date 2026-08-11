import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getWellnessWindowAdherence, getWellnessWindowBounds, getWellnessWindowValue } from "@shared/wellness-window";
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
  windowStart: number | null;
  windowEnd: number | null;
  metricInfo?: ActivityMetricInfo;
}

function formatMetricValue(value: number, metricType?: string | null): string {
  const num = value >= 1000 ? value.toLocaleString() : `${Math.round(value * 10) / 10}`;
  if (metricType === "mindful_minutes") return `${num} min`;
  if (metricType === "steps") return `${num} steps`;
  return num;
}

function HeartbeatHistory({ logs, category, windowStart, windowEnd }: Omit<ActivityDetailPanelProps, "activityId" | "metricInfo"> & { logs: WellnessLogEntry[] }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const bounds = getWellnessWindowBounds(category);
  const points = useMemo(() => logs.slice(0, 30).reverse().map((entry, index, entries) => {
    const completedAt = new Date(entry.completedAt);
    const value = getWellnessWindowValue(category, completedAt, timezone) ?? bounds?.min ?? 0;
    const adherence = getWellnessWindowAdherence(category, windowStart, windowEnd, completedAt, timezone);
    const range = Math.max(1, (bounds?.max ?? 1) - (bounds?.min ?? 0));
    return {
      entry,
      x: entries.length === 1 ? 50 : 4 + (index / (entries.length - 1)) * 92,
      y: 88 - ((value - (bounds?.min ?? 0)) / range) * 72,
      adherence,
    };
  }), [logs, category, timezone, bounds?.min, bounds?.max, windowStart, windowEnd]);

  if (!bounds || points.length === 0) {
    return <p className="px-2 py-1.5 text-sm text-muted-foreground">No completions yet.</p>;
  }

  const windowY = (value: number) => 88 - ((value - bounds.min) / Math.max(1, bounds.max - bounds.min)) * 72;
  const startY = windowStart == null ? 16 : windowY(windowStart);
  const endY = windowEnd == null ? 88 : windowY(windowEnd);
  const bandTop = Math.min(startY, endY);
  const bandHeight = Math.max(2, Math.abs(endY - startY));
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} 52 L ${point.x - 1.2} 52 L ${point.x} ${point.y} L ${point.x + 1.2} 52`).join(" ");

  return (
    <div className="space-y-2">
      <svg viewBox="0 0 100 100" className="h-40 w-full" role="img" aria-label="Activity completion heartbeat plotted against the ideal window">
        <rect x="3" y={bandTop} width="94" height={bandHeight} rx="1" className="fill-muted/40" />
        <line x1="3" y1="52" x2="97" y2="52" className="stroke-border" strokeWidth="0.5" />
        <path d={path} fill="none" className="stroke-muted-foreground/30" strokeWidth="0.7" />
        {points.map(({ entry, x, y, adherence }) => (
          <line
            key={entry.id}
            x1={x}
            y1="52"
            x2={x}
            y2={y}
            className="stroke-white"
            strokeWidth="1.5"
            style={{ opacity: adherence / 100 }}
          >
            <title>{`${new Date(entry.completedAt).toLocaleString()} · ${adherence}% on track`}</title>
          </line>
        ))}
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{points.length} recent completion{points.length === 1 ? "" : "s"}</span>
        <span>White = inside ideal window</span>
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

export function ActivityDetailPanel({ activityId, category, windowStart, windowEnd, metricInfo }: ActivityDetailPanelProps) {
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
      <HeartbeatHistory logs={displayLogs} category={category} windowStart={windowStart} windowEnd={windowEnd} />
      {trends && trends.totalCompletions > 0 && <div className="flex gap-6 text-xs text-muted-foreground"><span>Current streak · {trends.currentStreak}</span><span>30d · {trends.rate30d ?? "—"}%</span><span>90d · {trends.rate90d ?? "—"}%</span></div>}
      {metricInfo?.linkedMetricType && <div className="text-xs text-muted-foreground">Linked to {metricInfo.linkedMetricType}</div>}
      <div className="divide-y divide-border/20">
        {visibleLogs.map((entry) => <LogHistoryItem key={entry.id} entry={entry} linkedMetricType={metricInfo?.linkedMetricType} onDelete={(id) => deleteMutation.mutate(id)} />)}
      </div>
      {!showAll && displayLogs.length > 20 && <Button variant="ghost" size="sm" className="text-cta" onClick={() => setShowAll(true)}>Show {displayLogs.length - 20} more</Button>}
    </div>
  );
}
