import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RefreshCw, Filter } from "lucide-react";
import { SignalCard, type SignalItem } from "@/components/signal-card";

type StatusFilter = "new" | "surfaced" | "saved" | "dismissed" | "all";

export default function LandscapeFeed({ embedded }: { embedded?: boolean }) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("new");

  const { data, isLoading, refetch } = useQuery<{ items: SignalItem[]; total: number }>({
    queryKey: ["/api/landscape/signals", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("limit", "50");
      const res = await fetch(`/api/landscape/signals?${params}`);
      if (!res.ok) throw new Error("Failed to load signals");
      return res.json();
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      await apiRequest("PATCH", `/api/landscape/signals/${id}/status`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/landscape/signals"] });
    },
  });

  const signals = data?.items || [];
  const total = data?.total || 0;

  const filterButtons: { value: StatusFilter; label: string }[] = [
    { value: "new", label: "New" },
    { value: "surfaced", label: "Surfaced" },
    { value: "saved", label: "Saved" },
    { value: "dismissed", label: "Dismissed" },
    { value: "all", label: "All" },
  ];

  return (
    <div className={`flex flex-col gap-3 ${embedded ? "p-4" : "p-6"} overflow-y-auto`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          {filterButtons.map(fb => (
            <button
              key={fb.value}
              onClick={() => setStatusFilter(fb.value)}
              className={`px-2 py-0.5 text-xs rounded-md transition-colors ${
                statusFilter === fb.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {fb.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{total} signals</span>
          <Button variant="ghost" size="sm" onClick={() => refetch()} className="h-6 w-6 p-0">
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : signals.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">
          {statusFilter === "new" ? "No new signals. Run a scan or add sources." : "No signals with this filter."}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {signals.map(signal => (
            <SignalCard
              key={signal.id}
              signal={signal}
              onDismiss={(id) => statusMutation.mutate({ id, status: "dismissed" })}
              onSave={(id) => statusMutation.mutate({ id, status: "saved" })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
