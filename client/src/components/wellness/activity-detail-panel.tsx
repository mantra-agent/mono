import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Flame, Trash2, Loader2 } from "lucide-react";
import { useState, useMemo } from "react";
import type { ActivityTrends } from "@shared/models/health";

interface WellnessLogEntry {
  id: number;
  activityId: number;
  notes: string | null;
  tier: string | null;
  metricValue: number | null;
  completedAt: string;
}

function formatDetailMetricValue(value: number, metricType?: string | null): string {
  const num = value >= 1000 ? value.toLocaleString() : `${Math.round(value * 10) / 10}`;
  if (metricType === "mindful_minutes") return `${num} min`;
  if (metricType === "steps") return `${num} steps`;
  return num;
}

function LogHistoryItem({ entry, onDelete, linkedMetricType }: { entry: WellnessLogEntry; onDelete: (id: number) => void; linkedMetricType?: string | null }) {
  const date = new Date(entry.completedAt);
  const formatted = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      data-testid={`log-entry-${entry.id}`}
      className="flex items-center justify-between py-1.5 px-2 hover:bg-muted/30 rounded group"
    >
      <div className="flex-1 min-w-0 flex items-center gap-1.5">
        <span className="text-xs text-foreground">{formatted}</span>
        {entry.tier && (
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
            entry.tier === "great" ? "bg-success/10 text-success-foreground" :
            "bg-success/5 text-success-foreground"
          }`}>
            {entry.tier === "great" ? "Great" : "Good"}
            {entry.metricValue != null && ` — ${formatDetailMetricValue(entry.metricValue, linkedMetricType)}`}
          </span>
        )}
        {!entry.tier && entry.notes && (
          <span className="text-xs text-muted-foreground">{entry.notes}</span>
        )}
      </div>
      <Button
        data-testid={`button-delete-log-${entry.id}`}
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(entry.id);
        }}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

interface ActivityMetricInfo {
  linkedMetricType?: string | null;
  goodThreshold?: number | null;
  greatThreshold?: number | null;
}

export function ActivityDetailPanel({ activityId, metricInfo }: { activityId: number; metricInfo?: ActivityMetricInfo }) {
  const { toast } = useToast();
  const [showAll, setShowAll] = useState(false);

  const { data: trends, isLoading: trendsLoading } = useQuery<ActivityTrends>({
    queryKey: ["/api/wellness/activities", activityId, "trends"],
    queryFn: async () => {
      const res = await fetch(`/api/wellness/activities/${activityId}/trends`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load trends");
      return res.json();
    },
  });

  const { data: logs, isLoading: logsLoading } = useQuery<WellnessLogEntry[]>({
    queryKey: ["/api/wellness/logs", activityId],
    queryFn: async () => {
      const res = await fetch(`/api/wellness/logs?activityId=${activityId}&limit=500`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load logs");
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (logId: number) => {
      await apiRequest("DELETE", `/api/wellness/logs/${logId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", activityId] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/logs", "all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/activities", activityId, "trends"] });
      queryClient.invalidateQueries({ queryKey: ["/api/wellness/status"] });
      toast({ title: "Log deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleDelete = (logId: number) => {
    toast({
      title: "Delete this log?",
      description: "This action cannot be undone.",
      action: (
        <Button
          data-testid={`button-confirm-delete-${logId}`}
          variant="destructive"
          size="sm"
          onClick={() => deleteMutation.mutate(logId)}
        >
          Delete
        </Button>
      ),
    });
  };

  if (trendsLoading || logsLoading) {
    return (
      <div className="px-3 py-3 space-y-3">
        <div className="flex gap-6">
          <Skeleton className="h-12 w-24" />
          <Skeleton className="h-12 w-32" />
        </div>
        <Skeleton className="h-[110px] w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const isZeroState = !trends || trends.totalCompletions === 0;
  const displayLogs = logs ?? [];
  const visibleLogs = showAll ? displayLogs : displayLogs.slice(0, 20);

  return (
    <div
      data-testid={`detail-panel-${activityId}`}
      className="px-4 py-3 bg-muted/20 border-t space-y-3"
      onClick={(e) => e.stopPropagation()}
    >
      {metricInfo?.linkedMetricType && (
        <div data-testid={`metric-link-info-${activityId}`} className="text-xs text-muted-foreground">
          Linked to: {metricInfo.linkedMetricType}
          {metricInfo.goodThreshold != null && `, Good ≥${metricInfo.goodThreshold}`}
          {metricInfo.greatThreshold != null && `, Great ≥${metricInfo.greatThreshold}`}
        </div>
      )}

      <div className="flex flex-wrap gap-6 items-start">
        <div data-testid={`streak-display-${activityId}`}>
          <div className="flex items-center gap-1.5">
            {!isZeroState && trends!.currentStreak > 0 ? (
              <Flame className="h-4 w-4 text-cat-event" />
            ) : null}
            <span className="text-2xl font-bold tabular-nums">
              {isZeroState ? "—" : trends!.currentStreak}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isZeroState ? "No streak" : `Current streak`}
          </p>
          {!isZeroState && (
            <p className="text-xs text-muted-foreground">
              Longest: {trends!.longestStreak}
            </p>
          )}
        </div>

        <div data-testid={`rates-display-${activityId}`}>
          <div className="flex items-baseline gap-3">
            <div>
              <span className="text-lg font-semibold tabular-nums">
                {isZeroState || trends!.rate30d === null ? "—" : `${trends!.rate30d}%`}
              </span>
              <span className="text-xs text-muted-foreground ml-1">/ 30d</span>
            </div>
            <div>
              <span className="text-lg font-semibold tabular-nums">
                {isZeroState || trends!.rate90d === null ? "—" : `${trends!.rate90d}%`}
              </span>
              <span className="text-xs text-muted-foreground ml-1">/ 90d</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">Completion rate</p>
        </div>
      </div>

      <div>
        <p className="text-xs text-muted-foreground mb-1">
          {isZeroState ? "" : `${displayLogs.length} completion${displayLogs.length !== 1 ? "s" : ""}`}
        </p>
        {displayLogs.length === 0 ? (
          <p data-testid={`text-zero-state-${activityId}`} className="text-xs text-muted-foreground py-2">
            No completions yet. Tap ✓ to log your first one.
          </p>
        ) : (
          <div className="max-h-[200px] overflow-y-auto">
            {visibleLogs.map((entry) => (
              <LogHistoryItem
                key={entry.id}
                entry={entry}
                onDelete={handleDelete}
                linkedMetricType={metricInfo?.linkedMetricType}
              />
            ))}
            {!showAll && displayLogs.length > 20 && (
              <Button
                data-testid="button-show-more-logs"
                variant="link"
                size="sm"
                className="text-xs h-6 px-2"
                onClick={() => setShowAll(true)}
              >
                Show {displayLogs.length - 20} more
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
