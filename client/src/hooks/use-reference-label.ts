import { useQuery } from "@tanstack/react-query";

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
  // Heuristic: if the static label looks like a real name, skip the fetch.
  // Raw IDs look like UUIDs, numbers, or "Task 42" / "Project 7" patterns.
  const looksUnresolved =
    staticLabel === id ||
    /^\d+$/.test(staticLabel) ||
    /^(Task|Project|Milestone|Intention|Event) \S+$/.test(staticLabel);

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
