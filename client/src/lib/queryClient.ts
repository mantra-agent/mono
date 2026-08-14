import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { createLogger } from "./logger";

const log = createLogger("QueryClient");

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  signal?: AbortSignal,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
    signal,
  });

  await throwIfResNotOk(res);
  return res;
}

interface DurableSessionSnapshot {
  id: string;
  durableRevision: number;
  messages: unknown[];
}

function isDurableSessionSnapshot(value: unknown): value is DurableSessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DurableSessionSnapshot>;
  return typeof candidate.id === "string" &&
    typeof candidate.durableRevision === "number" &&
    Number.isSafeInteger(candidate.durableRevision) &&
    Array.isArray(candidate.messages);
}

function sessionDetailId(queryKey: readonly unknown[]): string | null {
  return queryKey.length === 2 &&
    queryKey[0] === "/api/sessions" &&
    typeof queryKey[1] === "string" &&
    queryKey[1].length > 0
    ? queryKey[1]
    : null;
}

function snapshotMeta(value: unknown): { messageCount: number | null; durableRevision: number | null } {
  if (!isDurableSessionSnapshot(value)) {
    return { messageCount: null, durableRevision: null };
  }
  return {
    messageCount: value.messages.length,
    durableRevision: value.durableRevision,
  };
}

function preserveCoherentDurableSessionSnapshot(oldData: unknown, newData: unknown): unknown {
  if (
    !isDurableSessionSnapshot(oldData) ||
    !isDurableSessionSnapshot(newData) ||
    oldData.id !== newData.id
  ) {
    return newData;
  }

  let decision: "keep" | "replace" | "reject" = "replace";
  let next: unknown = newData;
  if (newData.durableRevision < oldData.durableRevision) {
    decision = "reject";
    next = oldData;
  } else if (
    newData.durableRevision > oldData.durableRevision &&
    newData.messages === oldData.messages
  ) {
    decision = "keep";
    next = {
      ...newData,
      durableRevision: oldData.durableRevision,
    };
  }

  log.debug("SESSION:HANDOFF_CACHE_APPLY", {
    sessionId: oldData.id,
    oldRevision: oldData.durableRevision,
    newRevision: newData.durableRevision,
    oldMessageCount: oldData.messages.length,
    newMessageCount: newData.messages.length,
    decision,
  });
  return next;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const sessionId = sessionDetailId(queryKey);
    const startedAt = Date.now();
    if (sessionId) {
      log.debug("SESSION:HANDOFF_FETCH_START", { sessionId });
    }

    try {
      const res = await fetch(queryKey.join("/") as string, {
        credentials: "include",
      });

      if (unauthorizedBehavior === "returnNull" && res.status === 401) {
        if (sessionId) {
          log.debug("SESSION:HANDOFF_FETCH_SETTLE", {
            sessionId,
            status: 401,
            durationMs: Date.now() - startedAt,
            messageCount: null,
            durableRevision: null,
          });
        }
        return null;
      }

      if (!res.ok) {
        if (sessionId) {
          log.debug("SESSION:HANDOFF_FETCH_SETTLE", {
            sessionId,
            status: res.status,
            durationMs: Date.now() - startedAt,
            messageCount: null,
            durableRevision: null,
          });
        }
        await throwIfResNotOk(res);
      }

      const json = await res.json();
      if (sessionId) {
        log.debug("SESSION:HANDOFF_FETCH_SETTLE", {
          sessionId,
          status: res.status,
          durationMs: Date.now() - startedAt,
          ...snapshotMeta(json),
        });
      }
      return json;
    } catch (error) {
      if (sessionId && !(error instanceof Error && /^\d{3}:/.test(error.message))) {
        log.debug("SESSION:HANDOFF_FETCH_SETTLE", {
          sessionId,
          status: 0,
          durationMs: Date.now() - startedAt,
          messageCount: null,
          durableRevision: null,
          error: error instanceof Error ? error.name : "fetch_failed",
        });
      }
      throw error;
    }
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      // Default freshness window: avoid mount/focus fan-out storms on every SPA nav.
      // Routes that need live data should opt into shorter staleTime or explicit invalidation.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: false,
      structuralSharing: preserveCoherentDurableSessionSnapshot,
    },
    mutations: {
      retry: false,
    },
  },
});
