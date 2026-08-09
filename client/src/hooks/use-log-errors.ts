import { useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface UnseenErrorsState {
  hasUnseen: boolean;
  latestErrorAt: string | null;
}

export function useLogErrors() {
  const { data: unseenData } = useQuery<UnseenErrorsState>({
    queryKey: ["/api/logs/unseen-errors"],
    refetchInterval: 30_000,
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/logs/dismiss-errors");
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ["/api/logs/unseen-errors"] });
      const previous = queryClient.getQueryData<UnseenErrorsState>(["/api/logs/unseen-errors"]);
      queryClient.setQueryData(["/api/logs/unseen-errors"], {
        hasUnseen: false,
        latestErrorAt: previous?.latestErrorAt ?? null,
      });
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/logs/unseen-errors"], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/logs/unseen-errors"] });
    },
  });

  const markSeen = useCallback(() => {
    dismissMutation.mutate();
  }, [dismissMutation]);

  return { hasUnseenErrors: Boolean(unseenData?.hasUnseen), markSeen };
}
