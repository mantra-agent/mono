import { eq } from "drizzle-orm";
import { modEntitlements, modInstallations } from "@shared/schema";
import type { Principal } from "../principal";
import { db } from "../db";
import { combineWithVisibleScope, type ScopeColumns } from "../scoped-storage";
import { isModPlatformEnabled } from "./mod-platform-config";
import { semverLte } from "./composition/contribution-resolver";
import { getModRegistry } from "./registry";
import { CORE_VERSION } from "./registry/core-definition";

const entitlementScope: ScopeColumns = {
  scope: modEntitlements.scope,
  ownerUserId: modEntitlements.ownerUserId,
  accountId: modEntitlements.accountId,
};

const installationScope: ScopeColumns = {
  scope: modInstallations.scope,
  ownerUserId: modInstallations.ownerUserId,
  accountId: modInstallations.accountId,
};

const PLANNING_MOD_KEY = "planning" as const;

function requireAccount(principal: Principal): void {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Planning access requires an explicit user+account principal");
  }
}

/**
 * Canonical Planning composition-access predicate for server execution
 * boundaries. Mirrors hasActiveWellnessAccess / hasActiveBusinessAccess /
 * hasActiveNetworkAccess: a granted, in-window entitlement plus an active
 * installation of the Planning Mod for the principal's visible scope.
 *
 * Per the locked owner-map, the Planning full-vertical surface that dies with
 * this predicate is Scenarios (pages + routes + the renamed `scenarios` tool).
 * Goals/Schedule/Projects remain core execution surfaces and are not gated by
 * this predicate.
 */
export async function hasActivePlanningAccess(principal: Principal): Promise<boolean> {
  requireAccount(principal);
  if (!isModPlatformEnabled()) return false;

  const definition = getModRegistry().mods.find((mod) => mod.key === PLANNING_MOD_KEY);
  if (!definition || !semverLte(definition.compatibility.minimumCoreVersion, CORE_VERSION)) return false;

  const now = new Date();
  const [entitlementRows, installationRows] = await Promise.all([
    db
      .select({
        status: modEntitlements.status,
        validFrom: modEntitlements.validFrom,
        validUntil: modEntitlements.validUntil,
      })
      .from(modEntitlements)
      .where(combineWithVisibleScope(principal, entitlementScope, eq(modEntitlements.modKey, PLANNING_MOD_KEY)))
      .limit(1),
    db
      .select({ status: modInstallations.status })
      .from(modInstallations)
      .where(combineWithVisibleScope(principal, installationScope, eq(modInstallations.modKey, PLANNING_MOD_KEY)))
      .limit(1),
  ]);

  const entitlement = entitlementRows[0];
  if (!entitlement || entitlement.status !== "granted") return false;
  if (entitlement.validFrom && entitlement.validFrom.getTime() > now.getTime()) return false;
  if (entitlement.validUntil && entitlement.validUntil.getTime() < now.getTime()) return false;
  return installationRows[0]?.status === "active";
}

export { PLANNING_MOD_KEY };
