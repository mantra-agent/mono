import { useEffect, useCallback, useSyncExternalStore } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { createLogger } from "@/lib/logger";

const log = createLogger("LogErrors");
const LOG_ERRORS_OWNER = "logErrors";
const LOG_ERRORS_HANDLER = "logErrors";

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

function isLogErrorMessage(message: unknown): message is { type: "log"; log: { level?: string; timestamp?: string } } {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { type?: unknown; log?: { level?: unknown; timestamp?: unknown } };
  return candidate.type === "log" && Boolean(candidate.log) && candidate.log?.level === "error";
}

export function useLogErrors() {
  const version = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    const sharedWS = acquireSharedWS(LOG_ERRORS_OWNER);

    sharedWS.addMessageHandler(LOG_ERRORS_HANDLER, (message) => {
      if (!isLogErrorMessage(message)) return;
      const ts = message.log.timestamp ? new Date(message.log.timestamp).getTime() : Date.now();
      if (Number.isNaN(ts)) {
        log.warn("Ignoring log error event with invalid timestamp");
        return;
      }
      recordError(ts);
    });

    if (sharedWS.getReadyState() !== WebSocket.OPEN) {
      sharedWS.connect();
    }

    return () => {
      sharedWS.removeMessageHandler(LOG_ERRORS_HANDLER);
      releaseSharedWS(LOG_ERRORS_OWNER);
    };
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
