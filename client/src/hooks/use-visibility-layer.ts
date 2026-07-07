import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

export type VisibilityLayer = 1 | 2 | 3 | 4;

export const LAYER_LABELS: Record<VisibilityLayer, string> = {
  1: "Words Only",
  2: "Detail",
  3: "Developer",
  4: "Diagnostic",
};

export function useVisibilityLayer() {
  const { data } = useQuery<{ layer: VisibilityLayer }>({
    queryKey: ["/api/session/visibility-layer"],
    staleTime: 60_000,
  });

  const layer: VisibilityLayer = (data?.layer as VisibilityLayer) ?? 2;

  const setLayer = useCallback(async (newLayer: VisibilityLayer) => {
    const prev = queryClient.getQueryData<{ layer: VisibilityLayer }>(["/api/session/visibility-layer"]);
    queryClient.setQueryData(["/api/session/visibility-layer"], { layer: newLayer });
    try {
      await apiRequest("POST", "/api/session/visibility-layer", { layer: newLayer });
    } catch {
      queryClient.setQueryData(["/api/session/visibility-layer"], prev ?? { layer: 2 });
    }
  }, []);

  return { layer, setLayer };
}
