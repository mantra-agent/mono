import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface IdentityGraphRouter {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface IdentityGraphBilling {
  packageKey: "max" | "max_plus" | "factory_plus" | "custom";
  collectionStatus: "pending_setup" | "active" | "past_due" | "canceled" | "unpaid";
  paymentMethodKind: "card" | "us_bank_account" | "none";
  includeTokens: number;
  cancelAt: string | null;
}

export interface IdentityGraphAccount {
  id: string;
  name: string;
  kind: string;
  status: string;
  ownerUserId: string | null;
  routerId?: string | null;
  router?: IdentityGraphRouter | null;
  billing?: IdentityGraphBilling | null;
  includedTokens?: number | null;
  grantedTokens?: number;
  usagePeriod?: string | null;
  periodTokens?: number;
  emittedOverageTokens?: number;
  usageStatus?: "ok" | "bar" | "warn" | "pause" | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
}

export type AccountLifecycleStatus = "active" | "suspended" | "archived";
export type AccountTreeSection = "registered" | "activated" | "suspended" | "archived";
export type AgentLifecycleStatus = "active" | "paused" | "archived";

export function accountSection(status: string | null | undefined): AccountLifecycleStatus {
  if (status === "suspended" || status === "archived") return status;
  return "active";
}

export function accountTreeSection(
  status: string | null | undefined,
  ownerOnboardingStatus: string | null | undefined,
): AccountTreeSection {
  if (status === "suspended" || status === "archived") return status;
  return ownerOnboardingStatus === "completed" ? "activated" : "registered";
}

export function agentSection(status: string | null | undefined): AgentLifecycleStatus {
  if (status === "paused" || status === "archived") return status;
  return "active";
}

export function accountDeleteConfirmation(email: string): string {
  return `DELETE ${email}'s account`;
}

export interface IdentityGraphMembership {
  accountId: string;
  userId: string;
  role: string;
}

export interface IdentityGraphInstance {
  id: string;
  accountId: string;
  name: string;
  status: string;
  createdByUserId: string | null;
  quarantineReason: string | null;
  createdAt: string;
  updatedAt: string;
  managedTimerCount: number;
  claimCount: number;
  inputTokens7d: number;
}

export interface IdentityGraphInstanceMembership {
  instanceId: string;
  accountId: string;
  userId: string;
  role: string;
}

export interface IdentityGraphUser {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  onboardingStatus: string;
}

export interface IdentityGraphResponse {
  accounts: IdentityGraphAccount[];
  memberships: IdentityGraphMembership[];
  instances: IdentityGraphInstance[];
  instanceMemberships: IdentityGraphInstanceMembership[];
  users: IdentityGraphUser[];
}

export const IDENTITY_GRAPH_QUERY_KEY = ["/api/auth/identity-graph"] as const;

export function useIdentityGraph(enabled: boolean) {
  return useQuery<IdentityGraphResponse>({
    queryKey: IDENTITY_GRAPH_QUERY_KEY,
    enabled,
    queryFn: async () => (await apiRequest("GET", "/api/auth/identity-graph")).json(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function matchesIdentityQuery(query: string, ...parts: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.some((part) => (part ?? "").toLowerCase().includes(needle));
}
