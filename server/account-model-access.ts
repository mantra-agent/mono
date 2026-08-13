/**
 * Account model entitlement — commercial gate over platform model connectors.
 *
 * Platform `provider_connections` (connector_kind=model) remain infrastructure.
 * Account.model_access decides which of that stack a tenant may consume.
 * Until Stripe exists, entitled Accounts default to the full platform stack.
 * Stripe customer id is reserved on Account for @task:2359; no billing engine here.
 */
import { eq } from "drizzle-orm";
import {
  SEMANTIC_TIERS,
  modelConnectorProviderSchema,
  semanticTierSchema,
  type ModelConnectorProvider,
  type SemanticTier,
} from "@shared/model-connectors";
import { accounts } from "@shared/schema";
import { db } from "./db";
import { createLogger } from "./log";
import type { ModelConnector } from "./model-connectors";
import type { Principal } from "./principal";
import { getCurrentPrincipal } from "./principal-context";
import { normalizeEntitlement, type AccountEntitlement } from "./spend-authority";

const log = createLogger("AccountModelAccess");

export const ACCOUNT_MODEL_ACCESS_MODES = ["platform_stack", "allowlist", "none"] as const;
export type AccountModelAccessMode = (typeof ACCOUNT_MODEL_ACCESS_MODES)[number];

export interface AccountModelAccess {
  mode: AccountModelAccessMode;
  /** Optional provider allowlist when mode=allowlist. Empty means any provider (still subject to connectorIds). */
  providers: ModelConnectorProvider[];
  /** Optional platform connector id allowlist when mode=allowlist. Empty means any connector id. */
  connectorIds: number[];
  /** Optional semantic tier allowlist. Empty means all tiers. */
  tiers: SemanticTier[];
}

export type AccountModelAccessDecision =
  | {
      allowed: true;
      kind: "system";
      access: AccountModelAccess;
    }
  | {
      allowed: true;
      kind: "account";
      accountId: string;
      entitlement: "entitled";
      access: AccountModelAccess;
      /** Reserved attach point for Stripe; never invents a billing engine. */
      stripeCustomerId: string | null;
    }
  | {
      allowed: false;
      reason: "missing_principal" | "account_missing" | "account_unentitled" | "model_access_none";
      accountId?: string | null;
      access?: AccountModelAccess;
      detail?: string;
    };

export const PLATFORM_STACK_ACCESS: AccountModelAccess = {
  mode: "platform_stack",
  providers: [],
  connectorIds: [],
  tiers: [],
};

export const NONE_ACCESS: AccountModelAccess = {
  mode: "none",
  providers: [],
  connectorIds: [],
  tiers: [],
};

export function parseAccountModelAccess(value: unknown): AccountModelAccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...PLATFORM_STACK_ACCESS };
  }
  const raw = value as Record<string, unknown>;
  const mode = ACCOUNT_MODEL_ACCESS_MODES.includes(raw.mode as AccountModelAccessMode)
    ? (raw.mode as AccountModelAccessMode)
    : "platform_stack";

  const providers = normalizeProviders(raw.providers);
  const connectorIds = normalizeConnectorIds(raw.connectorIds ?? raw.connector_ids);
  const tiers = normalizeTiers(raw.tiers);

  if (mode === "none") return { ...NONE_ACCESS };
  if (mode === "platform_stack") {
    return {
      mode: "platform_stack",
      providers: [],
      connectorIds: [],
      // Tier caps may still apply on the full stack.
      tiers,
    };
  }
  return {
    mode: "allowlist",
    providers,
    connectorIds,
    tiers,
  };
}

/**
 * Resolve the commercial model gate for the ambient or explicit principal.
 * System principals use the platform stack (infrastructure, not Account-billed).
 * Unentitled Accounts fail closed. Entitled Accounts default to platform_stack.
 */
export async function resolveAccountModelAccess(args?: {
  principal?: Principal | null;
  accountId?: string | null;
}): Promise<AccountModelAccessDecision> {
  const principal = args?.principal === undefined ? getCurrentPrincipal() : args.principal;
  if (!principal) {
    return { allowed: false, reason: "missing_principal" };
  }

  if (principal.actorType === "system") {
    return { allowed: true, kind: "system", access: { ...PLATFORM_STACK_ACCESS } };
  }

  if (principal.actorType !== "user") {
    return {
      allowed: false,
      reason: "missing_principal",
      detail: "Account model access requires a user or system principal",
    };
  }

  const accountId = trimId(args?.accountId) ?? trimId(principal.accountId);
  if (!accountId) {
    return { allowed: false, reason: "account_missing" };
  }

  const [account] = await db
    .select({
      id: accounts.id,
      entitlement: accounts.entitlement,
      modelAccess: accounts.modelAccess,
      stripeCustomerId: accounts.stripeCustomerId,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) {
    return { allowed: false, reason: "account_missing", accountId };
  }

  const entitlement = normalizeEntitlement(account.entitlement);
  const access = parseAccountModelAccess(account.modelAccess);

  if (entitlement !== "entitled") {
    return {
      allowed: false,
      reason: "account_unentitled",
      accountId,
      access: { ...NONE_ACCESS },
    };
  }

  if (access.mode === "none") {
    return {
      allowed: false,
      reason: "model_access_none",
      accountId,
      access,
    };
  }

  return {
    allowed: true,
    kind: "account",
    accountId,
    entitlement: "entitled",
    access,
    stripeCustomerId: trimId(account.stripeCustomerId),
  };
}

/** Whether a semantic tier is permitted by Account model access. */
export function isTierAllowed(access: AccountModelAccess, tier: SemanticTier | "explicit-override"): boolean {
  if (access.mode === "none") return false;
  if (tier === "explicit-override") {
    // Explicit overrides still require some commercial model access; tier list does not apply.
    return access.mode === "platform_stack" || access.mode === "allowlist";
  }
  if (!access.tiers.length) return true;
  return access.tiers.includes(tier);
}

/** Whether a platform model connector is permitted by Account model access. */
export function isConnectorAllowed(access: AccountModelAccess, connector: Pick<ModelConnector, "id" | "provider">): boolean {
  if (access.mode === "none") return false;
  if (access.mode === "platform_stack") return true;

  if (access.providers.length > 0 && !access.providers.includes(connector.provider)) {
    return false;
  }
  if (access.connectorIds.length > 0 && !access.connectorIds.includes(connector.id)) {
    return false;
  }
  // allowlist with empty providers and connectorIds means "any platform connector"
  // (tier filter still applies separately).
  return true;
}

export function filterConnectorsForAccountAccess<T extends Pick<ModelConnector, "id" | "provider">>(
  access: AccountModelAccess,
  connectors: T[],
): { allowed: T[]; skipped: Array<{ connector: T; reason: string }> } {
  const allowed: T[] = [];
  const skipped: Array<{ connector: T; reason: string }> = [];
  for (const connector of connectors) {
    if (isConnectorAllowed(access, connector)) {
      allowed.push(connector);
    } else {
      skipped.push({ connector, reason: "account-model-access" });
    }
  }
  return { allowed, skipped };
}

export function logModelAccessDecision(
  decision: AccountModelAccessDecision,
  context: { activity?: string; tier?: string },
): void {
  if (!decision.allowed) {
    log.warn("account model access denied", {
      reason: decision.reason,
      accountId: decision.accountId ?? null,
      activity: context.activity ?? null,
      tier: context.tier ?? null,
    });
    return;
  }
  log.debug("account model access resolved", {
    kind: decision.kind,
    accountId: decision.kind === "account" ? decision.accountId : null,
    mode: decision.access.mode,
    providers: decision.access.providers,
    connectorIds: decision.access.connectorIds,
    tiers: decision.access.tiers,
    stripeCustomerAttached: decision.kind === "account" ? Boolean(decision.stripeCustomerId) : false,
    activity: context.activity ?? null,
    tier: context.tier ?? null,
  });
}

function normalizeProviders(value: unknown): ModelConnectorProvider[] {
  if (!Array.isArray(value)) return [];
  const out: ModelConnectorProvider[] = [];
  for (const entry of value) {
    const parsed = modelConnectorProviderSchema.safeParse(entry);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  return out;
}

function normalizeConnectorIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    const n = typeof entry === "number" ? entry : typeof entry === "string" ? Number(entry) : NaN;
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

function normalizeTiers(value: unknown): SemanticTier[] {
  if (!Array.isArray(value)) return [];
  const out: SemanticTier[] = [];
  for (const entry of value) {
    const parsed = semanticTierSchema.safeParse(entry);
    if (parsed.success && !out.includes(parsed.data)) out.push(parsed.data);
  }
  // Ignore a full set — equivalent to unrestricted.
  if (out.length === SEMANTIC_TIERS.length) return [];
  return out;
}

function trimId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Re-export for callers that only need entitlement normalization shape.
export type { AccountEntitlement };
