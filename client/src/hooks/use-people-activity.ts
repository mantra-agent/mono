import { useQuery } from "@tanstack/react-query";
import type { NavDotLevel } from "@/components/nav-dot";

interface AgendaData {
  commitments: unknown[];
  invest: unknown[];
  nurture: unknown[];
}

interface ImportQueueStatus {
  pending: number;
}

/** Returns the highest-priority NavDotLevel for the People page tabs. */
export function usePeopleActivity(): NavDotLevel | null {
  const { data: agenda } = useQuery<AgendaData>({
    queryKey: ["/api/people/agenda"],
    refetchInterval: 60_000,
  });
  const { data: importStatus } = useQuery<ImportQueueStatus>({
    queryKey: ["/api/import-queue/status"],
    refetchInterval: 60_000,
  });

  const hasCommitments = (agenda?.commitments?.length ?? 0) > 0;
  const hasDrifting = (agenda?.invest?.length ?? 0) + (agenda?.nurture?.length ?? 0) > 0;
  const hasImports = (importStatus?.pending ?? 0) > 0;

  // People relationship attention uses the same CTA tone as agenda-highlighted names in People.
  // Red/error is reserved for actual system failures.
  if (hasCommitments) return "cta";
  if (hasDrifting) return "cta";
  if (hasImports) return "unread";
  return null;
}
