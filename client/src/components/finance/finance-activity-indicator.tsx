import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";


export type FinanceAreaKey =
  | "home"
  | "goals"
  | "budget"
  | "recurring"
  | "liabilities"
  | "transactions"
  | "accounts"
  | "investments"
  | "assets"
  | "income"
  | "forecast"
  | "categories";

interface FinanceActivity {
  lastActivityAt: string | null;
  areas?: Partial<Record<FinanceAreaKey, string | null>>;
}

export const FINANCE_LAST_VISITED_KEY = "finance:lastVisitedAt";
export const FINANCE_HOME_LAST_VISITED_KEY = "finance:home:lastVisitedAt";

export function financeTabVisitedKey(tab: FinanceAreaKey): string {
  if (tab === "home") return FINANCE_HOME_LAST_VISITED_KEY;
  return `finance:${tab}:lastVisitedAt`;
}

function readVisited(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return 0;
    const n = Date.parse(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function markFinanceVisited(key: string): void {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
    window.dispatchEvent(new CustomEvent("finance-visited", { detail: { key } }));
  } catch {
    /* ignore */
  }
}

function useFinanceActivityData() {
  return useQuery<FinanceActivity>({
    queryKey: ["/api/finance/activity"],
    refetchInterval: 30000,
  });
}

function useVisitedAt(visitedKey: string): number {
  const [visitedAt, setVisitedAt] = useState<number>(() => readVisited(visitedKey));
  useEffect(() => {
    setVisitedAt(readVisited(visitedKey));
    const onVisit = (e: Event) => {
      const detail = (e as CustomEvent).detail as { key?: string } | undefined;
      if (!detail || detail.key === visitedKey) {
        setVisitedAt(readVisited(visitedKey));
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === visitedKey) setVisitedAt(readVisited(visitedKey));
    };
    window.addEventListener("finance-visited", onVisit);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("finance-visited", onVisit);
      window.removeEventListener("storage", onStorage);
    };
  }, [visitedKey]);
  return visitedAt;
}

export function useFinanceActivity(visitedKey: string): boolean {
  const { data } = useFinanceActivityData();
  const visitedAt = useVisitedAt(visitedKey);
  if (!data?.lastActivityAt) return false;
  const activityTs = Date.parse(data.lastActivityAt);
  if (!Number.isFinite(activityTs)) return false;
  return activityTs > visitedAt;
}

export function useFinanceAreaActivity(area: FinanceAreaKey): boolean {
  const { data } = useFinanceActivityData();
  const visitedAt = useVisitedAt(financeTabVisitedKey(area));
  const areaTs = data?.areas?.[area] ?? null;
  if (!areaTs) return false;
  const t = Date.parse(areaTs);
  if (!Number.isFinite(t)) return false;
  return t > visitedAt;
}

