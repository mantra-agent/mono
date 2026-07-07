import { useQuery } from "@tanstack/react-query";
import type { NavDotLevel } from "@/components/nav-dot";

interface SignalListResponse {
  signals: unknown[];
  total: number;
}

/** Returns NavDotLevel for the World page — unread when surfaced signals exist. */
export function useOrientationActivity(): NavDotLevel | null {
  const { data } = useQuery<SignalListResponse>({
    queryKey: ["/api/landscape/signals", "surfaced-count"],
    queryFn: async () => {
      const res = await fetch("/api/landscape/signals?status=surfaced&limit=1", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch signals");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  if ((data?.total ?? 0) > 0) return "unread";
  return null;
}
