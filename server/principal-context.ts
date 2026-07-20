import { AsyncLocalStorage } from "async_hooks";
import { createServicePrincipal, type Principal } from "./principal";

const principalALS = new AsyncLocalStorage<Principal>();

export function runWithPrincipal<T>(principal: Principal, fn: () => T): T {
  return principalALS.run(principal, fn);
}

export function getCurrentPrincipal(): Principal | null {
  return principalALS.getStore() ?? null;
}

/** Missing context fails closed. Real system jobs must enter with a named system principal. */
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
