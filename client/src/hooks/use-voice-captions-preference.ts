import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface UiPreferences {
  scale: number;
  voiceCaptions: boolean;
}

export function useVoiceCaptionsPreference() {
  const { data, isLoading } = useQuery<UiPreferences>({
    queryKey: ["/api/auth/ui-prefs"],
    staleTime: Infinity,
  });

  const mutation = useMutation({
    mutationFn: async (voiceCaptions: boolean) => {
      const response = await apiRequest("PATCH", "/api/auth/ui-prefs", { voiceCaptions });
      return await response.json() as UiPreferences;
    },
    onSuccess: (preferences) => {
      queryClient.setQueryData(["/api/auth/ui-prefs"], preferences);
    },
  });

  return {
    voiceCaptions: data?.voiceCaptions ?? false,
    isLoading,
    isSaving: mutation.isPending,
    setVoiceCaptions: mutation.mutate,
  };
}
