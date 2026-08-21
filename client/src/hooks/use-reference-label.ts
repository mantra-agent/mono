import { useQuery } from "@tanstack/react-query";

/**
 * Client registry fallbacks are either the raw id or `${Type} ${id}`.
 * Those are unresolved identifiers, not display names — fetch the server label.
 */
export function isUnresolvedFallbackLabel(type: string, id: string, staticLabel: string): boolean {
  if (!staticLabel || staticLabel === id) return true;
  if (/^\d+$/.test(staticLabel)) return true;
  if (staticLabel.endsWith(` ${id}`)) return true;
  const typeLabel = type.replaceAll("_", " ").trim().toLocaleLowerCase();
  if (staticLabel.trim().toLocaleLowerCase() === typeLabel) return true;
  return false;
}

/**
 * Async-resolves a reference label when the client-side registry only has
 * a raw ID as the fallback. Uses a batch-capable server endpoint with
 * aggressive React Query caching so repeated refs are cheap.
 */
export function useReferenceLabel(
  type: string,
  id: string,
  staticLabel: string,
): string {
  const looksUnresolved = isUnresolvedFallbackLabel(type, id, staticLabel);

  const { data } = useQuery<string>({
    queryKey: ["reference-label", type, id],
    queryFn: async () => {
      const res = await fetch(
        `/api/references/resolve?refs=${encodeURIComponent(`${type}:${id}`)}`,
      );
      if (!res.ok) return staticLabel;
      const json = (await res.json()) as Record<string, string>;
      return json[`${type}:${id}`] || staticLabel;
    },
    enabled: looksUnresolved,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  return looksUnresolved ? data || staticLabel : staticLabel;
}
