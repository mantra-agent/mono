import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { HeartbeatHistory, type WellnessLogEntry } from "./heartbeat-timeline";
import { wellnessCompletionSource } from "@shared/wellness-activity-launch";

interface ActivityMetricInfo {
  linkedMetricType?: string | null;
  goodThreshold?: number | null;
  greatThreshold?: number | null;
}

interface ActivityDetailPanelProps {
  activityId: number;
  intervalDays: number;
  metricInfo?: ActivityMetricInfo;
  /** Non-log completion evidence (Intentions today-goal mutations). */
  completionSource?: string | null;
  completionMarkers?: string[];
}

export function ActivityDetailPanel({
  activityId,
  intervalDays,
  metricInfo,
  completionSource,
  completionMarkers,
}: ActivityDetailPanelProps) {
  const usesGoalMarkers = wellnessCompletionSource(completionSource) === "today_goal_mutated";
  const { data: logs, isLoading: logsLoading } = useQuery<WellnessLogEntry[]>({
    queryKey: ["/api/wellness/logs", activityId],
    queryFn: async () => {
      const response = await fetch(`/api/wellness/logs?activityId=${activityId}&limit=500`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load logs");
      return response.json();
    },
    enabled: !usesGoalMarkers,
  });

  const displayLogs = useMemo(() => {
    if (usesGoalMarkers) {
      return (completionMarkers ?? []).map((completedAt, index) => ({
        id: -(activityId * 1000 + index + 1),
        activityId,
        notes: null,
        tier: null,
        metricValue: null,
        completedAt,
      }));
    }
    return logs ?? [];
  }, [usesGoalMarkers, completionMarkers, activityId, logs]);

  if (!usesGoalMarkers && logsLoading) {
    return <div className="space-y-3 py-3"><Skeleton className="h-40 w-full" /></div>;
  }

  return (
    <div className="space-y-2" data-testid={`detail-panel-${activityId}`}>
      <HeartbeatHistory logs={displayLogs} intervalDays={intervalDays} />
      {metricInfo?.linkedMetricType && (
        <div className="text-xs text-muted-foreground">Linked to {metricInfo.linkedMetricType}</div>
      )}
    </div>
  );
}
