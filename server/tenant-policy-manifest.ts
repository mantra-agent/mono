export type TenantPolicyTemplate = "ACCOUNT_DIRECT" | "USER_DIRECT" | "VAULT_DIRECT";
export type TenantPolicyState = "represented_dormant" | "inventory_only";

export interface TenantPolicyEntry {
  table: string;
  ownerColumns: readonly string[];
  template: TenantPolicyTemplate;
  state: TenantPolicyState;
  migration?: string;
  notes: string;
}

/**
 * Reviewable source of truth for rollout coverage. This manifest does not enable
 * RLS and must not be treated as proof that a hosted database has been migrated.
 */
export const TENANT_POLICY_MANIFEST: readonly TenantPolicyEntry[] = [
  {
    table: "users",
    ownerColumns: ["id", "account_id"],
    template: "USER_DIRECT",
    state: "inventory_only",
    notes: "Identity ownership foundation; quarantine columns are migration-only until onboarding activation.",
  },
  {
    table: "accounts",
    ownerColumns: ["id", "owner_user_id"],
    template: "USER_DIRECT",
    state: "inventory_only",
    notes: "Account root ownership remains protected by existing application authorization.",
  },
  {
    table: "vaults",
    ownerColumns: ["account_id", "owner_user_id"],
    template: "VAULT_DIRECT",
    state: "inventory_only",
    notes: "Vault membership and application predicates remain authoritative.",
  },
  {
    table: "email_messages",
    ownerColumns: ["account_id"],
    template: "ACCOUNT_DIRECT",
    state: "represented_dormant",
    migration: "0133_tenant_isolation_foundation.sql",
    notes: "First policy family is represented with RLS explicitly disabled.",
  },
] as const;
