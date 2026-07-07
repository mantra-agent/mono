import { useQuery } from "@tanstack/react-query";
import type { NavDotLevel } from "@/components/nav-dot";

interface EmailPipelineStatus {
  triage: {
    status: string;
    error?: string | null;
    lastTriageError: { message: string; timestamp: number } | null;
  };
  counts: { untriaged: number; awaitingEnrichment: number; reviewReady: number };
}

interface SyncStatus {
  accounts: Array<{
    healthy: boolean;
    orphaned?: boolean;
    error?: string | null;
  }>;
}

/** Returns the highest-priority NavDotLevel for the Comms page tabs. */
export function useCommsActivity(): NavDotLevel | null {
  const { data: reviewData, isError: reviewError } = useQuery<{ total: number }>({
    queryKey: ["/api/email/messages", "review-count"],
    queryFn: async () => {
      const res = await fetch("/api/email/messages?triageStatus=triaged&enriched=true&excludeDismissed=true&isRead=false&limit=1");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 30_000,
  });
  const { data: pipelineStatus, isError: pipelineStatusError } = useQuery<EmailPipelineStatus>({
    queryKey: ["/api/email/pipeline-status"],
    refetchInterval: 60_000,
  });
  const { data: syncStatus, isError: syncStatusError } = useQuery<SyncStatus>({
    queryKey: ["/api/email/sync-status"],
    refetchInterval: 60_000,
  });

  const reviewCount = reviewData?.total ?? 0;

  // Check for recent triage errors (within last hour)
  const hasTriageError = (() => {
    const err = pipelineStatus?.triage.lastTriageError;
    if (!err) return false;
    const ageMs = Date.now() - err.timestamp;
    return ageMs < 60 * 60 * 1000; // 1 hour
  })();

  const accounts = syncStatus?.accounts ?? [];
  const hasOrphanedAccount = accounts.some(account => account.orphaned);
  const hasSyncError = accounts.some(account => !account.healthy && !account.orphaned);
  const hasQueryError = reviewError || pipelineStatusError || syncStatusError;

  // Priority cascade: red for failed data/status paths, yellow for review-ready emails or degraded sync.
  // Only user-actionable states trigger the badge — pipeline-internal states (awaiting enrichment) do not.
  if (hasQueryError || hasTriageError || pipelineStatus?.triage.status === "error" || hasOrphanedAccount) return "error";
  if (hasSyncError || reviewCount > 0) return "attention";
  return null;
}
