import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Sparkles } from "lucide-react";
import { SignalCard, type SignalItem } from "@/components/signal-card";

export default function LandscapeSurface({ embedded }: { embedded?: boolean }) {
  const { data, isLoading } = useQuery<{ items: SignalItem[]; total: number }>({
    queryKey: ["/api/landscape/signals", "surfaced"],
    queryFn: async () => {
      const res = await fetch("/api/landscape/signals?status=surfaced&limit=50");
      if (!res.ok) throw new Error("Failed to load surfaced signals");
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

  return (
    <div className={`flex flex-col gap-3 ${embedded ? "p-4" : "p-6"} overflow-y-auto`}>
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : signals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 gap-2">
          <Sparkles className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Nothing surfaced yet</p>
          <p className="text-xs text-muted-foreground">Agent will surface signals during the next scan cycle</p>
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
