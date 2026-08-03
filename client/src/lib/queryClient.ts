import { QueryClient, QueryFunction } from "@tanstack/react-query";

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

function preserveCoherentDurableSessionSnapshot(oldData: unknown, newData: unknown): unknown {
  if (
    !isDurableSessionSnapshot(oldData) ||
    !isDurableSessionSnapshot(newData) ||
    oldData.id !== newData.id
  ) {
    return newData;
  }

  if (newData.durableRevision < oldData.durableRevision) {
    return oldData;
  }

  if (
    newData.durableRevision > oldData.durableRevision &&
    newData.messages === oldData.messages
  ) {
    return {
      ...newData,
      durableRevision: oldData.durableRevision,
    };
  }

  return newData;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
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
