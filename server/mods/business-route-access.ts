import type { Request, Response, NextFunction } from "express";
import { hasActiveBusinessAccess } from "./business-access";
import { isModPlatformEnabled } from "./mod-platform-config";

/**
 * Route-group middleware for the Business data surface (`/api/business/*`:
 * model, roles, metrics, kpis). Client hiding never substitutes for server
 * authority.
 *
 * Deliberate divergence from `requireActiveBuild`, mirroring
 * `requireActiveWellness`: when the Mod platform is disabled via the
 * `MOD_PLATFORM_ENABLED` rollback switch, this fails OPEN to the pre-Mod
 * contract (the route's existing `requireAuth` + `requirePermission` still
 * apply). Business model/roles/metrics/kpis were authenticated, permission-
 * gated surfaces before Mods; the rollback switch must restore that behavior,
 * not delete them for every user. When the platform is enabled, a
 * disabled/uninstalled Business Mod is enforced — direct API invocation cannot
 * bypass disabled state.
 */
export async function requireActiveBusiness(
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
    if (!(await hasActiveBusinessAccess(principal))) {
      res.status(403).json({ error: "Business Mod is inactive", code: "business_mod_inactive" });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "Business Mod is inactive", code: "business_mod_inactive" });
  }
}
