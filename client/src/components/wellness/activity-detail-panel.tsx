import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { HeartbeatHistory, type WellnessLogEntry } from "./heartbeat-timeline";

interface ActivityMetricInfo {
  linkedMetricType?: string | null;
  goodThreshold?: number | null;
  greatThreshold?: number | null;
}

interface ActivityDetailPanelProps {
  activityId: number;
  intervalDays: number;
  metricInfo?: ActivityMetricInfo;
}

export function ActivityDetailPanel({ activityId, intervalDays, metricInfo }: ActivityDetailPanelProps) {
  const { data: logs, isLoading: logsLoading } = useQuery<WellnessLogEntry[]>({ queryKey: ["/api/wellness/logs", activityId], queryFn: async () => {
    const response = await fetch(`/api/wellness/logs?activityId=${activityId}&limit=500`, { credentials: "include" });
    if (!response.ok) throw new Error("Failed to load logs");
    return response.json();
  }});

  if (logsLoading) return <div className="space-y-3 py-3"><Skeleton className="h-40 w-full" /></div>;
  const displayLogs = logs ?? [];

  return (
    <div className="space-y-2" data-testid={`detail-panel-${activityId}`}>
      <HeartbeatHistory logs={displayLogs} intervalDays={intervalDays} />
      {metricInfo?.linkedMetricType && <div className="text-xs text-muted-foreground">Linked to {metricInfo.linkedMetricType}</div>}
    </div>
  );
}
