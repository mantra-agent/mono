// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useEffect } from "react";
import { queryClient } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import type { ChatSession } from "@shared/models/chat";

const log = createLogger("DataSync");

const INVALIDATION_MAP: Record<string, string[][]> = {
  "data:goals_changed": [["/api/goals/today"], ["/api/home/feed"]],
  "data:calendar_changed": [["/api/calendar/events"], ["/api/calendar/metadata"]],
  "data:people_changed": [["/api/people"]],
  "data:preference_created": [["/api/preferences"]],
  "data:preference_updated": [["/api/preferences"]],
  "data:sessions_changed": [["/api/sessions"]],
  "data:tasks_changed": [["/api/projects/tasks"], ["/api/projects/todo"]],
  "data:library_changed": [["/api/info/library"], ["/api/info/library/tree"], ["/api/info/library/unread"], ["/api/library/index"]],
  "chat.autonomous.started": [["/api/sessions"]],
  "chat.autonomous.completed": [["/api/sessions"]],
  "chat.autonomous.failed": [["/api/sessions"]],
  "chat.session.status_changed": [["/api/sessions"]],
  "chat.xyz.initiated": [["/api/sessions"]],
};

const suppressedEvents = new Map<string, number>();

export function suppressDataSyncEvent(eventName: string, durationMs = 3000) {
  suppressedEvents.set(eventName, Date.now() + durationMs);
}

/**
 * Recompute hasActiveDescendant for all sessions in-place.
 * A session has an active descendant if any descendant session is streaming.
 */
function recomputeActiveDescendants(sessions: ChatSession[]): ChatSession[] {
  const streamingIds = new Set(sessions.filter(s => s.status === "streaming").map(s => s.id));
  const parentMap = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentMap.set(s.id, s.parentSessionId);
  }
  const activeAncestors = new Set<string>();
  for (const streamId of streamingIds) {
    let cursor = parentMap.get(streamId);
    while (cursor) {
      if (activeAncestors.has(cursor)) break;
      activeAncestors.add(cursor);
      cursor = parentMap.get(cursor);
    }
  }
  return sessions.map(s => {
    const shouldHave = activeAncestors.has(s.id);
    return s.hasActiveDescendant === shouldHave ? s : { ...s, hasActiveDescendant: shouldHave };
  });
}

/**
 * Apply a session status transition to every client cache projection that owns
 * it. Local send admission and server realtime events share this boundary so
 * SessionMenu and the focused session cannot observe different statuses.
 */
export function applySessionStatusToCache(sessionId: string, status: string): void {
  queryClient.setQueryData<ChatSession>(["/api/sessions", sessionId], (old) =>
    old ? { ...old, status } : old,
  );
  queryClient.setQueryData<ChatSession[]>(["/api/sessions"], (old) => {
    if (!old) return old;
    const updated = old.map(s => s.id === sessionId ? { ...s, status } : s);
    return recomputeActiveDescendants(updated);
  });
}

/**
 * Apply a session delta directly to the cache.  Returns true if the delta was
 * handled, false if the caller should fall back to full invalidation.
 */
function applySessionDelta(delta: { action: string; sessionId: string; session?: ChatSession }): boolean {
  const { action, sessionId, session } = delta;

  if (action === "created" && session) {
    queryClient.setQueryData<ChatSession[]>(["/api/sessions"], (old) => {
      if (!old) return [session];
      if (old.some(s => s.id === sessionId)) return old;  // already present (optimistic)
      return [session, ...old];
    });
    return true;
  }

  if (action === "deleted") {
    queryClient.setQueryData<ChatSession[]>(["/api/sessions"], (old) => {
      if (!old) return old;
      return old.filter(s => s.id !== sessionId);
    });
    return true;
  }

  if (action === "updated" && session) {
    queryClient.setQueryData<ChatSession[]>(["/api/sessions"], (old) => {
      if (!old) return old;
      const updated = old.map(s => s.id === sessionId ? { ...s, ...session } : s);
      return recomputeActiveDescendants(updated);
    });
    return true;
  }

  return false;  // Unknown action or missing data — fall back to invalidation
}

function isEventSuppressed(eventName: string): boolean {
  const until = suppressedEvents.get(eventName);
  if (!until) return false;
  if (Date.now() < until) return true;
  suppressedEvents.delete(eventName);
  return false;
}

type AutonomousStartedCallback = (payload: { sessionId: string; sessionKey?: string; skillId?: string }) => void;
let autonomousStartedCallback: AutonomousStartedCallback | null = null;



function maybeToastGoalChange(payload: Record<string, unknown> | undefined): void {
  const change = payload?.change as Record<string, unknown> | undefined;
  if (!change) return;

  const domain = typeof change.domain === "string" ? change.domain : "";
  if (domain !== "priority" && domain !== "goal") return;

  const action = typeof change.action === "string" ? change.action : "";
  const title = typeof change.title === "string" ? change.title.trim() : "";
  const source = typeof change.source === "string" ? change.source : "";

  const goalId = typeof change.goalId === "string" ? change.goalId : undefined;

  if (action === "mark_status") {
    toast({
      title: goalId ? `Goal completed: @goal:${goalId}` : "Goal completed",
      description: !goalId && title ? title : undefined,
    });
    return;
  }

  if (action === "add" && source === "ftue") {
    toast({
      title: goalId ? `Goal added: @goal:${goalId}` : "Goal added",
      description: !goalId && title ? title : undefined,
    });
  }
}

function maybeToastPreferenceChange(eventName: string, payload: Record<string, unknown> | undefined): void {
  const preference = typeof payload?.preference === "string" ? payload.preference.trim() : "";
  const domain = typeof payload?.domain === "string" ? payload.domain.trim() : "";

  if (eventName === "data:preference_created") {
    toast({
      title: "Preference saved",
      description: preference || domain || undefined,
    });
    return;
  }

  if (eventName === "data:preference_updated") {
    toast({ title: "Preference updated" });
  }
}

function maybeToastLibrarySurface(payload: Record<string, unknown> | undefined): void {
  if (payload?.action !== "surfaced") return;

  const title = typeof payload.title === "string" ? payload.title : undefined;
  if (!title) return;

  const pageId = typeof payload.pageId === "string" ? payload.pageId : undefined;
  toast({ title: pageId ? `Page surfaced: @page:${pageId}` : `Page surfaced: ${title}` });
}

export function onAutonomousStarted(cb: AutonomousStartedCallback | null) {
  autonomousStartedCallback = cb;
}

interface DataSyncEvent {
  type: "session_list_changed" | "session_changed";
  reason: string;
  sessionId?: string;
}

function handleDataSyncEvent(event: DataSyncEvent) {
  log.verbose(() => `event type=${event.type} reason=${event.reason} sessionId=${event.sessionId || "none"}`);
  switch (event.type) {
    case "session_list_changed":
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      break;
    case "session_changed":
      if (event.sessionId) {
        queryClient.invalidateQueries({ queryKey: ["/api/sessions", event.sessionId] });
      }
      break;
  }
}

export function emitSessionListChanged(reason: string): Promise<void> {
  handleDataSyncEvent({ type: "session_list_changed", reason });
  return (queryClient.getQueryCache().find({ queryKey: ["/api/sessions"] })?.promise ?? Promise.resolve()) as Promise<void>;
}

export function emitSessionChanged(id: string, reason: string): Promise<void> {
  handleDataSyncEvent({ type: "session_changed", reason, sessionId: id });
  return (queryClient.getQueryCache().find({ queryKey: ["/api/sessions", id] })?.promise ?? Promise.resolve()) as Promise<void>;
}

export function useDataSync() {
  useEffect(() => {
    const sharedWS = acquireSharedWS("dataSync");

    sharedWS.addReconnectHandler("dataSync", () => {
      log.debug("reconnected — invalidating active queries");
      for (const keys of Object.values(INVALIDATION_MAP)) {
        for (const queryKey of keys) {
          queryClient.invalidateQueries({ queryKey });
        }
      }
    });

    sharedWS.addCloseHandler("dataSync", (code, reason) => {
      log.debug(`close code=${code} reason=${reason || "none"}`);
    });

    sharedWS.addErrorHandler("dataSync", () => {
      log.warn("error on WebSocket connection");
    });

    sharedWS.addMessageHandler("dataSync", (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (m.type !== "event" || !m.event) return;

      const event = m.event as Record<string, unknown>;
      const eventName = event.event as string;
      if (!eventName) return;

      if (isEventSuppressed(eventName)) {
        log.verbose(() => `suppressed event: ${eventName}`);
        return;
      }

      // Event-carried state: when data:sessions_changed carries a delta payload,
      // apply it directly to the cache instead of triggering a full refetch.
      // This eliminates the race between optimistic inserts and server refetches.
      if (eventName === "data:sessions_changed" && event.payload) {
        const { delta } = event.payload as { delta?: { action: string; sessionId: string; session?: ChatSession } };
        if (delta) {
          const handled = applySessionDelta(delta);
          if (handled) {
            log.verbose(() => `applied session delta: ${delta.action} ${delta.sessionId}`);
            return;  // Skip full invalidation — delta was applied directly
          }
        }
      }

      // Session status events are event-carried realtime state. Apply them directly
      // and do not immediately refetch the session list, because an older HTTP
      // response can overwrite the just-applied server event and make the menu blink.
      if (eventName === "chat.session.status_changed" && event.payload) {
        const { sessionId, status } = event.payload as { sessionId?: string; status?: string };
        if (sessionId && status) applySessionStatusToCache(sessionId, status);
        return;
      }
      if (eventName === "chat.autonomous.completed" && event.payload) {
        const { sessionId } = event.payload as { sessionId?: string };
        if (sessionId) applySessionStatusToCache(sessionId, "saved");
        return;
      }
      if (eventName === "chat.autonomous.failed" && event.payload) {
        const { sessionId } = event.payload as { sessionId?: string };
        if (sessionId) applySessionStatusToCache(sessionId, "failed");
        return;
      }
      if (eventName === "chat.autonomous.started" && event.payload) {
        autonomousStartedCallback?.(event.payload as { sessionId: string; sessionKey?: string; skillId?: string });
        return;
      }

      const keys = INVALIDATION_MAP[eventName];
      if (keys) {
        for (const queryKey of keys) {
          queryClient.invalidateQueries({ queryKey });
        }
      }

      // Plan progress: refetch the specific session's messages
      if (eventName === "data:session_messages_changed" && event.payload) {
        const { sessionId } = event.payload as { sessionId?: string };
        if (sessionId) {
          queryClient.invalidateQueries({ queryKey: ["/api/sessions", sessionId] });
        }
      }

      if (eventName === "data:library_changed") {
        maybeToastLibrarySurface(event.payload as Record<string, unknown> | undefined);
      }

      if (eventName === "data:goals_changed") {
        maybeToastGoalChange(event.payload as Record<string, unknown> | undefined);
      }

      if (eventName === "data:preference_created" || eventName === "data:preference_updated") {
        maybeToastPreferenceChange(eventName, event.payload as Record<string, unknown> | undefined);
      }


      if (eventName === "data:people_changed") {
        const payload = event.payload as Record<string, unknown> | undefined;
        const personId = payload?.personId;
        if (personId) {
          queryClient.invalidateQueries({ queryKey: ["/api/people", personId] });
        }
        queryClient.invalidateQueries({
          predicate: (query) => {
            const key = query.queryKey;
            return Array.isArray(key) && typeof key[0] === "string" && key[0].startsWith("/api/people/");
          },
        });
      }
    });

    return () => {
      sharedWS.removeMessageHandler("dataSync");
      sharedWS.removeReconnectHandler("dataSync");
      sharedWS.removeCloseHandler("dataSync");
      sharedWS.removeErrorHandler("dataSync");
      releaseSharedWS("dataSync");
    };
  }, []);
}
