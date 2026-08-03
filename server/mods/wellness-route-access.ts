import type { Request, Response, NextFunction } from "express";
import { hasActiveWellnessAccess } from "./wellness-access";
import { isModPlatformEnabled } from "./mod-platform-config";

/**
 * Route-group middleware for the per-user Wellness data surface
 * (`/api/wellness/*`). Client hiding never substitutes for server authority.
 *
 * Deliberate divergence from `requireActiveBuild`: when the Mod platform is
 * disabled via the `MOD_PLATFORM_ENABLED` rollback switch, this fails OPEN to
 * the pre-Mod contract (the route's existing `requireAuth` still applies).
 * Wellness is a default user product that was authenticated-only before Mods;
 * the rollback switch must restore that behavior, not delete wellness for every
 * user. When the platform is enabled, a disabled/uninstalled Wellness Mod is
 * enforced — direct API invocation cannot bypass disabled state.
 */
export async function requireActiveWellness(
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
    if (!(await hasActiveWellnessAccess(principal))) {
      res.status(403).json({ error: "Wellness Mod is inactive", code: "wellness_mod_inactive" });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "Wellness Mod is inactive", code: "wellness_mod_inactive" });
  }
}
