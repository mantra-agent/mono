import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Hash, Clock, Pause, Play, RotateCcw, AlertTriangle, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

export interface ProcessInfo {
  id: string;
  name: string;
  description: string;
  status: string;
  pid: number;
  uptime: number;
  actions: string[];
  details: Record<string, unknown> | null;
}

function formatUptime(seconds?: number): string {
  if (!seconds) return "N/A";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ProcessStatusBadge({ status }: { status: string }) {
  const variant = status === "running" ? "default" :
    status === "paused" ? "secondary" :
    status === "circuit-breaker" ? "destructive" :
    status === "stopped" ? "secondary" : "outline";

  const label = status === "circuit-breaker" ? "Circuit Breaker" :
    status.charAt(0).toUpperCase() + status.slice(1);

  return (
    <Badge variant={variant} className="text-xs px-1.5 py-0" data-testid={`badge-process-status-${status}`}>
      {label}
    </Badge>
  );
}

function ProcessDetailChip({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground font-mono bg-muted/60 rounded px-1.5 py-0.5">
      {label}: {value}
    </span>
  );
}

export function ProcessesCard() {
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<{ processes: ProcessInfo[]; failures?: string[] }>({
    queryKey: ["/api/gateway/processes"],
    refetchInterval: 10_000,
  });

  const actionMutation = useMutation({
    mutationFn: async ({ processId, action }: { processId: string; action: string }) => {
      const res = await apiRequest("POST", `/api/gateway/processes/${processId}/${action}`);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Process Updated", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/gateway/processes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/gateway/status"] });
    },
    onError: (error: Error) => {
      toast({ title: "Action Failed", description: error.message, variant: "destructive" });
    },
  });

  const processes = data?.processes ?? [];
  const failures = data?.failures ?? [];
  const errorMessage = error instanceof Error ? error.message : error ? String(error) : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">Background Processes</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div
            className="flex items-start gap-3 p-3 rounded-md border border-destructive/40 bg-destructive/5"
            data-testid="processes-error-state"
          >
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-destructive">Couldn't load process status</p>
              <p
                className="text-xs text-muted-foreground mt-0.5 break-words"
                data-testid="text-processes-error-message"
              >
                {errorMessage || "Request failed."}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7"
                onClick={() => refetch()}
                disabled={isFetching}
                data-testid="button-retry-processes"
              >
                <RefreshCw className={`h-3 w-3 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
                Retry
              </Button>
            </div>
          </div>
        ) : processes.length === 0 ? (
          <div
            className="flex items-start gap-3 p-3 rounded-md border border-destructive/40 bg-destructive/5"
            data-testid="processes-empty-state"
          >
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-destructive">No processes returned</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                The server responded but didn't include any process entries. This usually means the build is missing wiring for the process panel.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2 h-7"
                onClick={() => refetch()}
                disabled={isFetching}
                data-testid="button-retry-processes"
              >
                <RefreshCw className={`h-3 w-3 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {failures.length > 0 && (
              <div
                className="flex items-start gap-2 p-2 rounded-md border border-warning/40 bg-warning/5"
                data-testid="processes-partial-failure-banner"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-warning-foreground dark:text-warning">
                    {failures.length === 1 ? "1 process reported an error" : `${failures.length} processes reported errors`}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5 break-words">
                    {failures.join("; ")}
                  </p>
                </div>
              </div>
            )}
            {processes.map((proc) => {
              const isPaused = proc.status === "paused" || proc.status === "stopped";
              const canPause = proc.actions.includes("pause") && !isPaused;
              const canRestart = proc.actions.includes("restart");
              return (
                <div
                  key={proc.id}
                  className="flex items-start justify-between gap-3 p-3 rounded-md border bg-card"
                  data-testid={`process-row-${proc.id}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium" data-testid={`process-name-${proc.id}`}>{proc.name}</span>
                      <ProcessStatusBadge status={proc.status} />
                    </div>
                    <p className="text-xs text-muted-foreground leading-snug">{proc.description}</p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      <span className="text-xs font-mono text-muted-foreground flex items-center gap-0.5">
                        <Hash className="h-3 w-3" />
                        PID {proc.pid}
                      </span>
                      <span className="text-xs font-mono text-muted-foreground flex items-center gap-0.5">
                        <Clock className="h-3 w-3" />
                        {formatUptime(proc.uptime)}
                      </span>
                      {proc.details && Object.entries(proc.details).map(([key, val]) => {
                        if (val === null || val === undefined) return null;
                        let display: string;
                        if (key === "eventLoopLag" && typeof val === "number") {
                          display = `${val}ms`;
                        } else if (key === "circuitBreakerResetAt" && typeof val === "number") {
                          const remaining = Math.max(0, Math.round(((val as number) - Date.now()) / 1000));
                          display = `${remaining}s`;
                          return <ProcessDetailChip key={key} label="resets in" value={display} />;
                        } else if (typeof val === "boolean") {
                          if (!val) return null;
                          display = "yes";
                        } else {
                          display = String(val);
                        }
                        const friendlyKey = key.replace(/([A-Z])/g, " $1").toLowerCase().trim();
                        return <ProcessDetailChip key={key} label={friendlyKey} value={display} />;
                      })}
                    </div>
                  </div>
                  {(canPause || canRestart) && (
                    <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                      {canPause && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Pause"
                          disabled={actionMutation.isPending}
                          onClick={() => actionMutation.mutate({ processId: proc.id, action: "pause" })}
                          data-testid={`button-pause-${proc.id}`}
                        >
                          <Pause className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {canRestart && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title={isPaused ? "Resume" : "Restart"}
                          disabled={actionMutation.isPending}
                          onClick={() => actionMutation.mutate({ processId: proc.id, action: "restart" })}
                          data-testid={`button-restart-${proc.id}`}
                        >
                          {isPaused ? <Play className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ProcessesCard;
