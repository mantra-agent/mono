// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useEffect } from "react";
import { createReferenceRef, isKnownReferenceType, serializeReference } from "@shared/references";
import { queryClient } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import type { ChatSession } from "@shared/models/chat";
import type { Vault } from "@/hooks/use-vaults";

const log = createLogger("DataSync");

const DEFERRED_SESSION_QUERY_KEYS = [
  "/api/sessions?view=past",
  "/api/sessions?view=snooze",
  "/api/sessions?view=archive",
] as const;

function invalidateDeferredSessionViews(): void {
  for (const key of DEFERRED_SESSION_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

const INVALIDATION_MAP: Record<string, string[][]> = {
  // Intentions doneToday + Home + Daily Goals door derive from today-goal mutations.
  "data:goals_changed": [["/api/goals/today"], ["/api/home/feed"], ["/api/wellness/status"], ["/api/wellness/pulse-buckets"]],
  "data:calendar_changed": [["/api/calendar/events"], ["/api/calendar/metadata"]],
  "data:people_changed": [["/api/people"]],
  "data:sessions_changed": [["/api/sessions"]],
  "data:tasks_changed": [["/api/projects/tasks"], ["/api/projects/todo"], ["/api/home/feed"]],
  "data:projects_changed": [["/api/projects/projects"], ["/api/home/feed"]],
  "data:metrics_changed": [["/api/metrics"], ["/api/kpis"], ["/api/kpis/standing-scores"]],
  "data:library_changed": [["/api/info/library"], ["/api/info/library/tree"], ["/api/info/library/unread"], ["/api/library/index"]],
  "data:product_composition_changed": [["/api/mods"], ["/api/product-composition?modality=web"], ["/api/home/feed"]],
  "data:home_changed": [["/api/home/feed"]],
  // Feature stage/status mutations (HTTP + Agent tools) so the Features tree
  // flips unread/review chrome without a manual reload.
  "data:features_changed": [["/api/features"]],
  "chat.autonomous.started": [["/api/sessions"]],
  "chat.autonomous.completed": [["/api/sessions"]],
  "chat.autonomous.failed": [["/api/sessions"]],
  "chat.session.status_changed": [["/api/sessions"]],
  "chat.xyz.initiated": [["/api/sessions"]],
};

const suppressedEvents = new Map<string, number>();

// Dedup guard for build-completion toasts: a single build can emit repeated
// data:home_changed events, including after a hard refresh, so persist the
// bounded set of observations already announced in this browser.
const recentNotifications = new Set<string>();
const NOTIFICATION_DEDUP_WINDOW_MS = 60_000;
const BUILD_COMPLETION_STORAGE_KEY = "mantra:build-completion-notifications";
const MAX_STORED_BUILD_COMPLETIONS = 50;

function readStoredBuildCompletions(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(BUILD_COMPLETION_STORAGE_KEY) ?? "[]");
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function markBuildCompletionNotified(observationId: string): boolean {
  const stored = readStoredBuildCompletions();
  if (stored.includes(observationId)) return false;

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        BUILD_COMPLETION_STORAGE_KEY,
        JSON.stringify([observationId, ...stored].slice(0, MAX_STORED_BUILD_COMPLETIONS)),
      );
    } catch {
      // In-memory deduplication still protects the active page session.
    }
  }
  return true;
}

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
interface VaultVisibilitySnapshot {
  vaults: Vault[];
  visibleVaultIds: string[];
  activeVaultId: string | null;
}

function sessionIsVisibleInCurrentVaults(session: ChatSession): boolean {
  const vaultState = queryClient.getQueryData<VaultVisibilitySnapshot>(["/api/vaults"]);
  if (!vaultState) return true;
  return Boolean(session.vaultId && vaultState.visibleVaultIds.includes(session.vaultId));
}

function applySessionDelta(delta: { action: string; sessionId: string; session?: ChatSession }): boolean {
  const { action, sessionId, session } = delta;

  if (action === "created" && session) {
    if (!sessionIsVisibleInCurrentVaults(session)) return true;
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
    const isVisible = sessionIsVisibleInCurrentVaults(session);
    queryClient.setQueryData<ChatSession>(["/api/sessions", sessionId], (old) =>
      old ? { ...old, ...session } : old,
    );
    queryClient.setQueryData<ChatSession[]>(["/api/sessions"], (old) => {
      if (!old) return old;
      if (!isVisible) return recomputeActiveDescendants(old.filter((item) => item.id !== sessionId));
      const existingIndex = old.findIndex((item) => item.id === sessionId);
      const updated = existingIndex >= 0
        ? old.map((item) => item.id === sessionId ? { ...item, ...session } : item)
        : [session, ...old];
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

type AutonomousStartedCallback = (payload: {
  sessionId: string;
  sessionKey?: string;
  skillId?: string;
  /** Catalog label from the skill runner (config.label). */
  skillName?: string;
}) => void;
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

function maybeToastLibrarySurface(payload: Record<string, unknown> | undefined): void {
  if (payload?.action !== "surfaced") return;

  const title = typeof payload.title === "string" ? payload.title : undefined;
  if (!title) return;

  const pageId = typeof payload.pageId === "string" ? payload.pageId : undefined;
  toast({ title: pageId ? `Page surfaced: @page:${pageId}` : `Page surfaced: ${title}` });
}

interface BuildCompletionPayload {
  observationId: string;
  label: string;
  reference: {
    type: string;
    id: string;
    metadata?: Record<string, unknown>;
  };
}

function maybeToastBuildCompletion(payload: Record<string, unknown> | undefined): void {
  if (payload?.source !== "build_deployment_observer" || !Array.isArray(payload.buildCompletions)) return;

  for (const value of payload.buildCompletions) {
    if (!value || typeof value !== "object") continue;
    const completion = value as Partial<BuildCompletionPayload>;
    const rawReference = completion.reference;
    if (!rawReference || !isKnownReferenceType(rawReference.type) || typeof rawReference.id !== "string") continue;
    const observationId = typeof completion.observationId === "string" ? completion.observationId : rawReference.id;
    if (
      !observationId
      || recentNotifications.has(`build:${observationId}`)
      || !markBuildCompletionNotified(observationId)
    ) continue;
    recentNotifications.add(`build:${observationId}`);
    window.setTimeout(() => recentNotifications.delete(`build:${observationId}`), NOTIFICATION_DEDUP_WINDOW_MS);

    const reference = createReferenceRef({
      type: rawReference.type,
      id: rawReference.id,
      metadata: rawReference.metadata,
    });
    // Toast titles are string-only, but AppToastDisplay parses canonical references and
    // renders them through ReferenceRenderer. Keep the build identity canonical here so
    // the completion link is always a reference chip rather than stranded plain text.
    toast({
      title: `Build completed — ${serializeReference(reference)}`,
    });
  }
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
            // Historical projections have different membership predicates. Mark
            // them stale immediately so an open section refetches after any
            // session-list mutation.
            invalidateDeferredSessionViews();
            log.verbose(() => `applied session delta: ${delta.action} ${delta.sessionId}`);
            return;  // Skip primary-list invalidation — delta was applied directly
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

      if (eventName === "data:home_changed") {
        maybeToastBuildCompletion(event.payload as Record<string, unknown> | undefined);
      }

      if (eventName === "data:library_changed") {
        maybeToastLibrarySurface(event.payload as Record<string, unknown> | undefined);
      }

      if (eventName === "data:goals_changed") {
        maybeToastGoalChange(event.payload as Record<string, unknown> | undefined);
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
