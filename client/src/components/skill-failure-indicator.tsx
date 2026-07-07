import { useQuery, useMutation } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";


type FailedSkill = { name: string; scoredAt: string };

export function useSkillFailures() {
  const { data: failedSkills = [] } = useQuery<FailedSkill[]>({
    queryKey: ["/api/skills/failed-names"],
    refetchInterval: 30000,
  });

  const dismissMutation = useMutation({
    mutationFn: async (skillName: string) => {
      await apiRequest("POST", `/api/skills/${skillName}/dismiss-failure`);
    },
    onMutate: async (skillName: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/skills/failed-names"] });
      const previous = queryClient.getQueryData<FailedSkill[]>(["/api/skills/failed-names"]);
      queryClient.setQueryData<FailedSkill[]>(
        ["/api/skills/failed-names"],
        (old) => (old ?? []).filter(f => f.name !== skillName),
      );
      return { previous };
    },
    onError: (_err, _skillName, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["/api/skills/failed-names"], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/skills/failed-names"] });
    },
  });

  const unseenNames = useMemo(() => new Set(failedSkills.map(f => f.name)), [failedSkills]);

  const markSeen = useCallback((skillName: string) => {
    dismissMutation.mutate(skillName);
  }, [dismissMutation]);

  return {
    hasUnseenFailures: unseenNames.size > 0,
    unseenNames,
    markSeen,
  };
}

