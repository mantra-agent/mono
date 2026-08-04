import { AsyncLocalStorage } from "async_hooks";
import { createServicePrincipal, type Principal } from "./principal";

const principalALS = new AsyncLocalStorage<Principal>();

export function runWithPrincipal<T>(principal: Principal, fn: () => T): T {
  return principalALS.run(principal, fn);
}

export function getCurrentPrincipal(): Principal | null {
  return principalALS.getStore() ?? null;
}

/** Fail closed when ALS has no principal. Prefer requireCurrentUserPrincipal for user-owned data. */
export function requireCurrentPrincipal(): Principal {
  const principal = getCurrentPrincipal();
  if (!principal) {
    throw new Error("Principal context required");
  }
  return principal;
}

/**
 * @deprecated Compatibility alias — do not add new call sites. Prefer
 * requireCurrentUserPrincipal, requireCurrentPrincipal, or explicit
 * runWithPrincipal(createNamedSystemPrincipal(...)) at job entry.
 * Missing context fails closed via a permissionless service principal.
 */
export function getCurrentPrincipalOrSystem(): Principal {
  return getCurrentPrincipal() ?? createServicePrincipal([], []);
}

export function requireCurrentUserPrincipal(): Principal & { actorType: "user"; userId: string; accountId: string } {
  const principal = getCurrentPrincipal();
  if (principal?.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Authenticated user principal with account ownership required");
  }
  return principal as Principal & { actorType: "user"; userId: string; accountId: string };
}
