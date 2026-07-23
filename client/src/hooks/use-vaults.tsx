import { createContext, useContext, useCallback, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { createLogger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";

const log = createLogger("Vaults");

// ── Types ──────────────────────────────────────────────────────────────────

export interface Vault {
  id: string;
  accountId: string;
  name: string;
  icon: string | null;
  color: string | null;
  purpose: string | null;
  position: number;
  isDefault: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface VaultsResponse {
  vaults: Vault[];
  visibleVaultIds: string[];
  activeVaultId: string | null;
}

interface VaultContextValue {
  vaults: Vault[];
  visibleVaultIds: string[];
  activeVaultId: string | null;
  toggleVault: (id: string) => void;
  setActiveVault: (id: string) => void;
  isVisible: (id: string) => boolean;
  isLoading: boolean;
}

const VaultContext = createContext<VaultContextValue | null>(null);

// ── Query Key ──────────────────────────────────────────────────────────────

const VAULTS_KEY = ["/api/vaults"] as const;

// ── Provider ───────────────────────────────────────────────────────────────

export function VaultProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();

  const { data, isLoading } = useQuery<VaultsResponse>({
    queryKey: VAULTS_KEY,
    staleTime: 30_000,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ vaultId, visible }: { vaultId: string; visible: boolean }) => {
      const res = await apiRequest("PATCH", "/api/vaults/toggle", { vaultId, visible });
      return res.json() as Promise<{ visibleVaultIds: string[] }>;
    },
    onMutate: async ({ vaultId, visible }) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: VAULTS_KEY });
      const prev = queryClient.getQueryData<VaultsResponse>(VAULTS_KEY);
      if (prev) {
        const next = { ...prev };
        if (visible) {
          next.visibleVaultIds = [...new Set([...prev.visibleVaultIds, vaultId])];
        } else {
          next.visibleVaultIds = prev.visibleVaultIds.filter((id) => id !== vaultId);
        }
        queryClient.setQueryData(VAULTS_KEY, next);
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(VAULTS_KEY, ctx.prev);
      const msg = err instanceof Error ? err.message : "Toggle failed";
      log.warn("vault toggle failed", { error: msg });
      toast({ title: "Vault toggle failed", description: msg, variant: "destructive" });
    },
    onSettled: () => {
      // Refetch vault-scoped data
      queryClient.invalidateQueries({ queryKey: VAULTS_KEY });
      invalidateVaultScopedQueries();
    },
  });

  const activeMutation = useMutation({
    mutationFn: async ({ vaultId }: { vaultId: string }) => {
      const res = await apiRequest("PATCH", "/api/vaults/active", { vaultId });
      return res.json() as Promise<{ activeVaultId: string; visibleVaultIds: string[] }>;
    },
    onMutate: async ({ vaultId }) => {
      await queryClient.cancelQueries({ queryKey: VAULTS_KEY });
      const prev = queryClient.getQueryData<VaultsResponse>(VAULTS_KEY);
      if (prev) {
        const next = {
          ...prev,
          activeVaultId: vaultId,
          visibleVaultIds: [...new Set([...prev.visibleVaultIds, vaultId])],
        };
        queryClient.setQueryData(VAULTS_KEY, next);
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(VAULTS_KEY, ctx.prev);
      const msg = err instanceof Error ? err.message : "Failed to set active vault";
      log.warn("set active vault failed", { error: msg });
      toast({ title: "Failed to set active vault", description: msg, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: VAULTS_KEY });
      invalidateVaultScopedQueries();
    },
  });

  const toggleVault = useCallback(
    (id: string) => {
      const currentlyVisible = data?.visibleVaultIds.includes(id) ?? false;

      // Invariant 1: cannot toggle off the active vault
      if (currentlyVisible && data?.activeVaultId === id) {
        toast({
          title: "This is your active vault",
          description: "Switch active vault first.",
        });
        return;
      }

      toggleMutation.mutate({ vaultId: id, visible: !currentlyVisible });
    },
    [data, toggleMutation, toast],
  );

  const setActiveVault = useCallback(
    (id: string) => {
      if (data?.activeVaultId === id) return;
      activeMutation.mutate({ vaultId: id });
    },
    [data, activeMutation],
  );

  const isVisible = useCallback(
    (id: string) => data?.visibleVaultIds.includes(id) ?? false,
    [data],
  );

  const value: VaultContextValue = {
    vaults: data?.vaults ?? [],
    visibleVaultIds: data?.visibleVaultIds ?? [],
    activeVaultId: data?.activeVaultId ?? null,
    toggleVault,
    setActiveVault,
    isVisible,
    isLoading,
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useVaults(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVaults must be used within VaultProvider");
  return ctx;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Invalidate vault-scoped query caches so surfaces refresh after toggle. */
function invalidateVaultScopedQueries() {
  // Broad invalidation of major data surfaces
  const scopedPrefixes = [
    "/api/sessions",
    "/api/library",
    "/api/library2",
    "/api/memory",
    "/api/goals",
    "/api/projects",
    "/api/tasks",
    "/api/people",
    "/api/exec/opportunities",
    "/api/rules",
    "/api/skills",
    "/api/theses",
    "/api/signals",
  ];

  for (const prefix of scopedPrefixes) {
    queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey[0];
        return typeof key === "string" && key.startsWith(prefix);
      },
    });
  }

  log.debug("invalidated vault-scoped query caches");
}
