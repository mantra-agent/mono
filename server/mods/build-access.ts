import type { Principal } from "../principal";
import { hasActiveModAccess } from "./mod-access";

/** @deprecated Import hasActiveModAccess from mod-access for new consumers. */
export function hasActiveBuildAccess(principal: Principal): Promise<boolean> {
  return hasActiveModAccess(principal, "build");
}

export const BUILD_MOD_KEY = "build" as const;
