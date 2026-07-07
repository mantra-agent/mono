import { createContext, useContext, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GatewayStatus } from "@shared/schema";
import type { ReactNode } from "react";

export const GATEWAY_STATUS_KEY = ["/api/gateway/status"];

interface ExecutorStatusContextValue {
  status: string;
  activeRuns: number;
  chatActiveRuns: number;
  raw: GatewayStatus | undefined;
  isLoading: boolean;
}

const ExecutorStatusContext = createContext<ExecutorStatusContextValue>({
  status: "not_installed",
  activeRuns: 0,
  chatActiveRuns: 0,
  raw: undefined,
  isLoading: true,
});

export function ExecutorStatusProvider({ children }: { children: ReactNode }) {
  const query = useQuery<GatewayStatus>({
    queryKey: GATEWAY_STATUS_KEY,
    refetchInterval: 4000,
    staleTime: 2000,
  });

  const value = useMemo<ExecutorStatusContextValue>(() => ({
    status: query.data?.status || "not_installed",
    activeRuns: query.data?.activeRuns ?? 0,
    chatActiveRuns: query.data?.chatActiveRuns ?? 0,
    raw: query.data,
    isLoading: query.isLoading,
  }), [query.data?.status, query.data?.activeRuns, query.data?.chatActiveRuns, query.isLoading]);

  return <ExecutorStatusContext.Provider value={value}>{children}</ExecutorStatusContext.Provider>;
}

export function useExecutorStatus() {
  const ctx = useContext(ExecutorStatusContext);
  return {
    data: ctx.raw,
    isLoading: ctx.isLoading,
  };
}
