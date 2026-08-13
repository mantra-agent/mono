/**
 * Phase 2 spend authority: Account pays, Instance consumes.
 *
 * Canonical fail-closed gate for inference, Timer execution, and Runtime capacity.
 * Spend is authorized by Account entitlement + pinned Agent Instance status —
 * never by owner_user_id alone. System principals (platform jobs) are exempt.
 */
import { and, eq } from "drizzle-orm";
import { accounts, agentInstanceMemberships, agentInstances } from "@shared/schema";
import { db } from "./db";
import { createLogger } from "./log";
import type { Principal } from "./principal";
import { getCurrentPrincipal } from "./principal-context";

const log = createLogger("SpendAuthority");

export const ACCOUNT_ENTITLEMENTS = ["entitled", "unentitled"] as const;
export type AccountEntitlement = (typeof ACCOUNT_ENTITLEMENTS)[number];

export const SPEND_PURPOSES = ["inference", "timer", "runtime"] as const;
export type SpendPurpose = (typeof SPEND_PURPOSES)[number];

export type SpendDenialReason =
  | "missing_principal"
  | "account_missing"
  | "account_unentitled"
  | "instance_missing"
  | "instance_quarantined";

export type SpendAuthorityDecision =
  | {
      allowed: true;
      kind: "system";
    }
  | {
      allowed: true;
      kind: "account";
      accountId: string;
      instanceId: string;
      entitlement: "entitled";
    }
  | {
      allowed: false;
      reason: SpendDenialReason;
      accountId?: string | null;
      instanceId?: string | null;
      detail?: string;
    };

export class SpendAuthorityError extends Error {
  readonly code = "SPEND_DENIED" as const;
  readonly status = 403;
  readonly reason: SpendDenialReason;
  readonly accountId: string | null;
  readonly instanceId: string | null;
  readonly purpose: SpendPurpose;

  constructor(args: {
    reason: SpendDenialReason;
    purpose: SpendPurpose;
    accountId?: string | null;
    instanceId?: string | null;
    detail?: string;
  }) {
    super(args.detail ?? spendDenialMessage(args.reason, args.purpose));
    this.name = "SpendAuthorityError";
    this.reason = args.reason;
    this.accountId = args.accountId ?? null;
    this.instanceId = args.instanceId ?? null;
    this.purpose = args.purpose;
  }
}

export function isSpendAuthorityError(error: unknown): error is SpendAuthorityError {
  return error instanceof SpendAuthorityError;
}

function spendDenialMessage(reason: SpendDenialReason, purpose: SpendPurpose): string {
  switch (reason) {
    case "missing_principal":
      return `Spend denied for ${purpose}: principal context required`;
    case "account_missing":
      return `Spend denied for ${purpose}: Account is required`;
    case "account_unentitled":
      return `Spend denied for ${purpose}: Account is not entitled`;
    case "instance_missing":
      return `Spend denied for ${purpose}: pinned Agent Instance is required`;
    case "instance_quarantined":
      return `Spend denied for ${purpose}: Agent Instance is quarantined`;
    default: {
      const _exhaustive: never = reason;
      return `Spend denied for ${purpose}: ${_exhaustive}`;
    }
  }
}

export interface ResolveSpendAuthorityArgs {
  purpose: SpendPurpose;
  /** Explicit principal; defaults to ambient ALS principal. */
  principal?: Principal | null;
  /** Prefer when known (Runtime run account, Timer account). */
  accountId?: string | null;
  /** Prefer when known (explicit Instance pin). */
  instanceId?: string | null;
  /** User whose Instance pin should be resolved inside the Account. */
  userId?: string | null;
}

/**
 * Resolve whether the current spend subject may consume model/timer/runtime capacity.
 * System principals are platform infrastructure and are not Account-billed.
 * User spend requires entitled Account + non-quarantined pinned Instance.
 */
export async function resolveSpendAuthority(
  args: ResolveSpendAuthorityArgs,
): Promise<SpendAuthorityDecision> {
  const principal = args.principal === undefined ? getCurrentPrincipal() : args.principal;
  if (!principal) {
    return { allowed: false, reason: "missing_principal" };
  }

  if (principal.actorType === "system") {
    return { allowed: true, kind: "system" };
  }

  // Service principals never own an Account mind; fail closed for spend.
  if (principal.actorType !== "user") {
    return {
      allowed: false,
      reason: "missing_principal",
      detail: `Spend denied for ${args.purpose}: user or system principal required`,
    };
  }

  const accountId = trimId(args.accountId) ?? trimId(principal.accountId);
  if (!accountId) {
    return { allowed: false, reason: "account_missing" };
  }

  const userId = trimId(args.userId) ?? trimId(principal.userId);
  const explicitInstanceId = trimId(args.instanceId);

  const [account] = await db
    .select({
      id: accounts.id,
      entitlement: accounts.entitlement,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) {
    return { allowed: false, reason: "account_missing", accountId };
  }

  const entitlement = normalizeEntitlement(account.entitlement);
  if (entitlement !== "entitled") {
    return {
      allowed: false,
      reason: "account_unentitled",
      accountId,
    };
  }

  let instanceId = explicitInstanceId;
  if (!instanceId && userId) {
    const [pin] = await db
      .select({ instanceId: agentInstanceMemberships.instanceId })
      .from(agentInstanceMemberships)
      .where(
        and(
          eq(agentInstanceMemberships.accountId, accountId),
          eq(agentInstanceMemberships.userId, userId),
        ),
      )
      .limit(1);
    instanceId = pin?.instanceId ?? null;
  }

  // Compatibility: if the Account has exactly one Instance and no pin yet, use it.
  // Still fail closed when zero or many Instances without a pin.
  if (!instanceId) {
    const accountInstances = await db
      .select({ id: agentInstances.id, status: agentInstances.status })
      .from(agentInstances)
      .where(eq(agentInstances.accountId, accountId))
      .limit(2);
    if (accountInstances.length === 1) {
      instanceId = accountInstances[0].id;
      if (accountInstances[0].status === "quarantined") {
        return {
          allowed: false,
          reason: "instance_quarantined",
          accountId,
          instanceId,
        };
      }
      return {
        allowed: true,
        kind: "account",
        accountId,
        instanceId,
        entitlement: "entitled",
      };
    }
    return { allowed: false, reason: "instance_missing", accountId };
  }

  const [instance] = await db
    .select({
      id: agentInstances.id,
      status: agentInstances.status,
      accountId: agentInstances.accountId,
    })
    .from(agentInstances)
    .where(eq(agentInstances.id, instanceId))
    .limit(1);

  if (!instance || instance.accountId !== accountId) {
    return {
      allowed: false,
      reason: "instance_missing",
      accountId,
      instanceId,
    };
  }

  if (instance.status === "quarantined") {
    return {
      allowed: false,
      reason: "instance_quarantined",
      accountId,
      instanceId,
    };
  }

  return {
    allowed: true,
    kind: "account",
    accountId,
    instanceId: instance.id,
    entitlement: "entitled",
  };
}

/** Fail closed. Throws SpendAuthorityError when spend is not allowed. */
export async function assertSpendAllowed(
  args: ResolveSpendAuthorityArgs,
): Promise<Extract<SpendAuthorityDecision, { allowed: true }>> {
  const decision = await resolveSpendAuthority(args);
  if (!decision.allowed) {
    log.warn("spend denied", {
      purpose: args.purpose,
      reason: decision.reason,
      accountId: decision.accountId ?? args.accountId ?? null,
      instanceId: decision.instanceId ?? args.instanceId ?? null,
    });
    throw new SpendAuthorityError({
      reason: decision.reason,
      purpose: args.purpose,
      accountId: decision.accountId ?? args.accountId,
      instanceId: decision.instanceId ?? args.instanceId,
      detail: decision.detail,
    });
  }
  return decision;
}

function trimId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEntitlement(value: unknown): AccountEntitlement {
  return value === "entitled" ? "entitled" : "unentitled";
}
