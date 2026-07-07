import { useState, useEffect, useRef } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useExecutorStatus } from "@/hooks/use-executor-status";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  Clock,
  Play,
  Pause,
  RotateCcw,
  Hash,
  AlertTriangle,
} from "lucide-react";

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function useRealtimeUptime(serverUptime?: number, isRunning?: boolean): string {
  const baseRef = useRef<{ serverUptime: number; capturedAt: number } | null>(null);
  const [display, setDisplay] = useState("0s");

  useEffect(() => {
    if (serverUptime != null && isRunning) {
      baseRef.current = { serverUptime, capturedAt: Date.now() / 1000 };
    } else {
      baseRef.current = null;
      setDisplay("0s");
    }
  }, [serverUptime, isRunning]);

  useEffect(() => {
    if (!isRunning) return;
    const tick = () => {
      if (baseRef.current) {
        const elapsed = Date.now() / 1000 - baseRef.current.capturedAt;
        setDisplay(formatUptime(baseRef.current.serverUptime + elapsed));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  return display;
}

export default function Dashboard({ embedded }: { embedded?: boolean }) {
  usePageHeader({ title: "Dashboard" });
  const { data: status, isLoading: statusLoading } = useExecutorStatus();
  const { toast } = useToast();

  const actionMutation = useMutation({
    mutationFn: async (action: string) => {
      const res = await apiRequest("POST", `/api/gateway/${action}`);
      return res.json();
    },
    onSuccess: (data, action) => {
      toast({
        title: `Agent ${action}`,
        description: data.message || `Successfully ${action}ed the agent.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/gateway/status"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Action Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const isRunning = status?.status === "running";
  const isStopped = status?.status === "stopped";
  const uptimeDisplay = useRealtimeUptime(status?.uptime, isRunning);

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="p-4 @sm:p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          {statusLoading ? (
            <Skeleton className="h-5 w-20" />
          ) : (
            <Badge
              variant={isRunning ? "default" : isStopped ? "secondary" : "outline"}
              data-testid="badge-agent-status"
            >
              {status?.status || "Unknown"}
            </Badge>
          )}
          {isRunning && (
            <span className="text-xs text-muted-foreground font-mono flex items-center gap-1" data-testid="text-agent-uptime">
              <Clock className="h-3 w-3" />
              {uptimeDisplay}
            </span>
          )}
          {isRunning && status?.pid != null && (
            <span className="text-xs text-muted-foreground font-mono flex items-center gap-1" data-testid="text-agent-pid">
              <Hash className="h-3 w-3" />
              {status.pid}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => actionMutation.mutate("restart")}
                disabled={actionMutation.isPending}
                data-testid="button-restart-agent"
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                Restart
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => actionMutation.mutate("stop")}
                disabled={actionMutation.isPending}
                data-testid="button-stop-agent"
              >
                <Pause className="h-3.5 w-3.5 mr-1.5" />
                Pause
              </Button>
            </>
          ) : (
            <Button
              onClick={() => actionMutation.mutate("start")}
              disabled={actionMutation.isPending}
              data-testid="button-start-agent"
            >
              <Play className="h-4 w-4 mr-2" />
              {actionMutation.isPending ? "Starting..." : "Resume"}
            </Button>
          )}
        </div>
      </div>

      {status?.error && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span className="font-mono text-xs">{status.error}</span>
        </div>
      )}

        </div>
      </div>
    </div>
  );
}
