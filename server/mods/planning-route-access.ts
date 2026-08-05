import type { Request, Response, NextFunction } from "express";
import { hasActivePlanningAccess } from "./planning-access";
import { isModPlatformEnabled } from "./mod-platform-config";

/**
 * Route-group middleware for the Planning-owned Scenarios data surface
 * (`/api/strategy/*` — the API prefix retained its `strategy` path through the
 * Scenarios rename; only the tool name and client routes moved to `scenarios`).
 * Client hiding never substitutes for server authority.
 *
 * Deliberate divergence from `requireActiveBuild`, matching `requireActiveWellness`
 * / `requireActiveBusiness` / `requireActiveNetwork`: when the Mod platform is
 * disabled via the `MOD_PLATFORM_ENABLED` rollback switch, this fails OPEN to
 * the pre-Mod contract (the route's existing `requireAuth` still applies).
 * Scenarios was a default authenticated surface before Mods; the rollback
 * switch must restore that behavior, not delete it for every user. When the
 * platform is enabled, a disabled/uninstalled Planning Mod is enforced —
 * direct API invocation cannot bypass disabled state.
 */
export async function requireActivePlanning(
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
    if (!(await hasActivePlanningAccess(principal))) {
      res.status(403).json({ error: "Planning Mod is inactive", code: "planning_mod_inactive" });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "Planning Mod is inactive", code: "planning_mod_inactive" });
  }
}
