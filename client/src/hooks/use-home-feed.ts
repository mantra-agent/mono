import { useQuery } from "@tanstack/react-query";
import type { SimpleFeed } from "@shared/models/simple";
import { apiRequest } from "@/lib/queryClient";

export function useHomeFeed(options: { refresh?: boolean; model?: boolean } = {}) {
  const params = new URLSearchParams();
  const refresh = options.refresh ?? true;
  if (refresh) params.set("refresh", "true");
  if (options.model) params.set("model", "true");
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return useQuery<SimpleFeed>({
    queryKey: ["/api/home/feed", suffix],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/home/feed${suffix}`);
      return res.json();
    },
    staleTime: 0,
    refetchOnMount: "always",
  });
}
