import { useQuery } from "@tanstack/react-query";

export function useGoalsActivity(): boolean {
  const { data } = useQuery<{ hasUnviewed: boolean }>({
    queryKey: ["/api/goals/daily-artifacts/attention"],
    refetchInterval: 30000,
  });
  return Boolean(data?.hasUnviewed);
}

