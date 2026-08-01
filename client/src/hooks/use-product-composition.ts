import { useQuery } from "@tanstack/react-query";
import type { ResolvedProductComposition } from "@shared/models/product-composition";

const PRODUCT_COMPOSITION_QUERY_KEY = "/api/product-composition?modality=web";

export function useProductComposition() {
  return useQuery<ResolvedProductComposition>({
    queryKey: [PRODUCT_COMPOSITION_QUERY_KEY],
    staleTime: 60_000,
  });
}
