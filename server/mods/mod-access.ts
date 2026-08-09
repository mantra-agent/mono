import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { modEntitlements, modInstallations, type ModKey } from "@shared/schema";
import type { Principal } from "../principal";
import type { ToolSchema } from "../tool-registry";
import { db } from "../db";
import { combineWithVisibleScope, type ScopeColumns } from "../scoped-storage";
import { isModPlatformEnabled } from "./mod-platform-config";
import { getModRegistry } from "./registry";
import { CORE_VERSION } from "./registry/core-definition";
import { semverLte } from "./composition/contribution-resolver";
import { listContributions } from "@shared/models/mod-registry";

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

type ExecutableKind = "tool" | "skill" | "workflow" | "server-route-group";

const executableOwners = new Map<ExecutableKind, Map<string, ModKey>>();
for (const kind of ["tool", "skill", "workflow", "server-route-group"] as const) {
  executableOwners.set(kind, new Map());
}
for (const mod of getModRegistry().mods) {
  for (const contribution of listContributions(mod.contributions)) {
    const key = contribution.kind === "tool" ? contribution.toolName
      : contribution.kind === "skill" ? contribution.skillKey
      : contribution.kind === "workflow" ? contribution.workflowKey
      : contribution.kind === "server-route-group" ? contribution.routeGroupKey
      : null;
    if (key) executableOwners.get(contribution.kind as ExecutableKind)!.set(key, mod.key);
  }
}

function requireUserAccount(principal: Principal): void {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Mod composition requires an explicit user+account principal");
  }
}

/** Registry-compatible + entitled + active installation. Never grants authority. */
export async function hasActiveModAccess(principal: Principal, modKey: ModKey): Promise<boolean> {
  requireUserAccount(principal);
  if (!isModPlatformEnabled()) return false;
  const definition = getModRegistry().mods.find((mod) => mod.key === modKey);
  if (!definition || !semverLte(definition.compatibility.minimumCoreVersion, CORE_VERSION)) return false;
  const now = new Date();
  const [entitlements, installations] = await Promise.all([
    db.select({ status: modEntitlements.status, validFrom: modEntitlements.validFrom, validUntil: modEntitlements.validUntil })
      .from(modEntitlements)
      .where(combineWithVisibleScope(principal, entitlementScope, eq(modEntitlements.modKey, modKey)))
      .limit(1),
    db.select({ status: modInstallations.status })
      .from(modInstallations)
      .where(combineWithVisibleScope(principal, installationScope, eq(modInstallations.modKey, modKey)))
      .limit(1),
  ]);
  const entitlement = entitlements[0];
  return Boolean(
    entitlement?.status === "granted"
      && (!entitlement.validFrom || entitlement.validFrom.getTime() <= now.getTime())
      && (!entitlement.validUntil || entitlement.validUntil.getTime() >= now.getTime())
      && installations[0]?.status === "active",
  );
}

export function ownerOfExecutableContribution(kind: ExecutableKind, key: string): ModKey | undefined {
  return executableOwners.get(kind)?.get(key);
}

export async function filterModToolSchemas(principal: Principal, tools: ToolSchema[]): Promise<ToolSchema[]> {
  const owners = new Set([...executableOwners.get("tool")!.values()]);
  const active = new Map<ModKey, boolean>();
  await Promise.all([...owners].map(async (owner) => active.set(owner, await hasActiveModAccess(principal, owner))));
  return tools.filter((tool) => {
    const owner = ownerOfExecutableContribution("tool", tool.name);
    return !owner || active.get(owner) === true;
  });
}

export async function requireModToolAccess(principal: Principal, toolName: string): Promise<ModKey | null> {
  const owner = ownerOfExecutableContribution("tool", toolName);
  if (!owner) return null;
  if (!(await hasActiveModAccess(principal, owner))) throw new Error(`${owner}_mod_inactive`);
  return owner;
}

export async function requireModSkillAccess(principal: Principal, skillName: string): Promise<void> {
  const owner = ownerOfExecutableContribution("skill", skillName);
  if (owner && !(await hasActiveModAccess(principal, owner))) throw new Error(`${owner}_mod_inactive`);
}

export async function requireModWorkflowAccess(principal: Principal, workflowKey: string): Promise<void> {
  const owner = ownerOfExecutableContribution("workflow", workflowKey);
  if (owner && !(await hasActiveModAccess(principal, owner))) throw new Error(`${owner}_mod_inactive`);
}

export function requireModRouteGroup(
  routeGroupKey: string,
  options: { failOpenWhenPlatformDisabled?: boolean } = {},
) {
  const owner = ownerOfExecutableContribution("server-route-group", routeGroupKey);
  if (!owner) throw new Error(`Undeclared Mod route group: ${routeGroupKey}`);
  return requireActiveMod(owner, options);
}

/** Composition middleware; permissions and domain scope remain separate route gates. */
export function requireActiveMod(modKey: ModKey, options: { failOpenWhenPlatformDisabled?: boolean } = {}) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isModPlatformEnabled() && options.failOpenWhenPlatformDisabled) return next();
    const principal = req.principal;
    if (!principal || principal.actorType !== "user") {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    try {
      if (await hasActiveModAccess(principal, modKey)) return next();
    } catch {
      // Fail closed without exposing storage detail.
    }
    res.status(403).json({ error: `${modKey} Mod is inactive`, code: `${modKey}_mod_inactive` });
  };
}
