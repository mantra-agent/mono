import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";

export type VisibilityLayer = 0 | 1 | 2 | 3 | 4;

export const VISIBILITY_LAYERS: VisibilityLayer[] = [0, 1, 2, 3, 4];

export const LAYER_LABELS: Record<VisibilityLayer, string> = {
  0: "Zero",
  1: "Words Only",
  2: "Detail",
  3: "Developer",
  4: "Diagnostic",
};

const VISIBILITY_LAYER_QUERY_KEY = ["/api/session/visibility-layer"] as const;

export async function setVisibilityLayer(newLayer: VisibilityLayer): Promise<void> {
  const previous = queryClient.getQueryData<{ layer: VisibilityLayer }>(VISIBILITY_LAYER_QUERY_KEY);
  queryClient.setQueryData(VISIBILITY_LAYER_QUERY_KEY, { layer: newLayer });
  try {
    await apiRequest("POST", "/api/session/visibility-layer", { layer: newLayer });
  } catch {
    queryClient.setQueryData(VISIBILITY_LAYER_QUERY_KEY, previous ?? { layer: 0 });
  }
}

export function useVisibilityLayer() {
  const { data } = useQuery<{ layer: VisibilityLayer }>({
    queryKey: VISIBILITY_LAYER_QUERY_KEY,
    staleTime: 60_000,
  });

  const layer: VisibilityLayer = (data?.layer as VisibilityLayer) ?? 0;
  const setLayer = useCallback(setVisibilityLayer, []);

  return { layer, setLayer };
}
