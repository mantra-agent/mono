import type { Request, Response, NextFunction } from "express";
import { hasActiveNetworkAccess } from "./network-access";
import { isModPlatformEnabled } from "./mod-platform-config";

/**
 * Route-group middleware for the Network-owned Companies/Pipelines data surface
 * (`/api/companies/*`). Client hiding never substitutes for server authority.
 *
 * Deliberate divergence from `requireActiveBuild`, matching `requireActiveWellness`
 * / `requireActiveBusiness`: when the Mod platform is disabled via the
 * `MOD_PLATFORM_ENABLED` rollback switch, this fails OPEN to the pre-Mod
 * contract (the route's existing `requireAuth` still applies). Companies were a
 * default authenticated surface before Mods; the rollback switch must restore
 * that behavior, not delete companies for every user. When the platform is
 * enabled, a disabled/uninstalled Network Mod is enforced — direct API
 * invocation cannot bypass disabled state.
 */
export async function requireActiveNetwork(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isModPlatformEnabled()) {
    next();
    return;
  }
  const principal = req.principal;
  if (!principal || principal.actorType !== "user") {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    if (!(await hasActiveNetworkAccess(principal))) {
      res.status(403).json({ error: "Network Mod is inactive", code: "network_mod_inactive" });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "Network Mod is inactive", code: "network_mod_inactive" });
  }
}
