import { useEffect, useCallback, useSyncExternalStore } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

let realtimeErrorTimestamp = 0;
let snapshotVersion = 0;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return snapshotVersion;
}

function bump() {
  snapshotVersion++;
  listeners.forEach(cb => cb());
}

function recordError(ts: number) {
  if (ts > realtimeErrorTimestamp) {
    realtimeErrorTimestamp = ts;
    bump();
  }
}

let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "log" && data.log && data.log.level === "error") {
        const ts = data.log.timestamp ? new Date(data.log.timestamp).getTime() : Date.now();
        recordError(ts);
      }
    } catch {}
  };

  ws.onclose = () => {
    initialized = false;
    setTimeout(init, 5000);
  };
}

export function useLogErrors() {
  const version = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    init();
  }, []);

  const { data: unseenData } = useQuery<{ hasUnseen: boolean; latestErrorAt: string | null }>({
    queryKey: ["/api/logs/unseen-errors"],
    refetchInterval: 30000,
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/logs/dismiss-errors");
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/logs/unseen-errors"] });
      const previous = queryClient.getQueryData<{ hasUnseen: boolean; latestErrorAt: string | null }>(["/api/logs/unseen-errors"]);
      queryClient.setQueryData(["/api/logs/unseen-errors"], { hasUnseen: false, latestErrorAt: previous?.latestErrorAt ?? null });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/logs/unseen-errors"], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/logs/unseen-errors"] });
    },
  });

  const hasUnseenErrors = (() => {
    void version;
    if (unseenData?.hasUnseen) return true;
    if (realtimeErrorTimestamp > 0) {
      const serverLatest = unseenData?.latestErrorAt ? new Date(unseenData.latestErrorAt).getTime() : 0;
      if (realtimeErrorTimestamp > serverLatest) {
        // If the server confirms no unseen errors and the WS error is older than 60s, it's a phantom
        if (unseenData && !unseenData.hasUnseen && (Date.now() - realtimeErrorTimestamp > 60000)) {
          realtimeErrorTimestamp = 0;
          bump();
          return false;
        }
        return true;
      }
    }
    return false;
  })();

  const markSeen = useCallback(() => {
    dismissMutation.mutate();
    realtimeErrorTimestamp = 0;
    bump();
  }, [dismissMutation.mutate]);

  return { hasUnseenErrors, markSeen };
}
