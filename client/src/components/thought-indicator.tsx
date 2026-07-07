import { useQuery } from "@tanstack/react-query";
import { useHasActivePlans } from "@/pages/plans-view";

export function useWorkActivity(): boolean {
  return useHasActivePlans();
}

export function useSessionActivityState() {
  const { data: sessions } = useQuery<Array<{ isPinned?: boolean; status?: string; hasUnreadResult?: boolean; sessionType?: string }>>({
    queryKey: ["/api/sessions"],
    refetchInterval: 30000,
  });

  const pinnedCount = sessions?.filter(c => c.isPinned).length ?? 0;
  const hasStreaming = sessions?.some(c => c.status === "streaming") ?? false;
  const hasUnread = sessions?.some(c => c.hasUnreadResult && c.sessionType !== "autonomous") ?? false;

  return { pinnedCount, hasStreaming, hasUnread };
}

export function useSessionActivity(): boolean {
  const { pinnedCount, hasStreaming, hasUnread } = useSessionActivityState();
  return pinnedCount > 0 || hasStreaming || hasUnread;
}

