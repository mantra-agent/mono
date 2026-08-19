import { useQuery } from "@tanstack/react-query";
import type { SimpleFeed } from "@shared/models/simple";
import { apiRequest } from "@/lib/queryClient";

/**
 * Home feed query.
 *
 * Default is the server non-refresh path (same-day process cache when warm).
 * Forced rebuild is explicit: pull-to-refresh, event invalidation, or
 * `refresh: true` at the call site. Query key stays stable so React Query can
 * reuse cache across mounts instead of forking `?refresh=true` vs bare URLs.
 */
export function useHomeFeed(options: { refresh?: boolean; model?: boolean } = {}) {
  const forceRefresh = options.refresh === true;
  const useModel = options.model === true;
  const params = new URLSearchParams();
  if (forceRefresh) params.set("refresh", "true");
  if (useModel) params.set("model", "true");
  const suffix = params.toString() ? `?${params.toString()}` : "";

  return useQuery<SimpleFeed>({
    // Stable identity: do not put refresh suffix in the key (avoids dual caches).
    queryKey: useModel ? ["/api/home/feed", "model"] : ["/api/home/feed"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/home/feed${suffix}`);
      return res.json();
    },
  });
}
