import { eq } from "drizzle-orm";
import { providerConnections } from "@shared/models/platforms";
import { db } from "../db";
import { getProviderCredential } from "../provider-credential-store";
import { requireCurrentPrincipal } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";

const providerConnectionScope = {
  scope: providerConnections.scope,
  ownerUserId: providerConnections.ownerUserId,
  accountId: providerConnections.accountId,
};

export function lifecycleHostingBinding(snapshot: unknown): Record<string, unknown> {
  if (!snapshot || typeof snapshot !== "object") return {};
  const hosting = (snapshot as Record<string, unknown>).hosting;
  return hosting && typeof hosting === "object" ? hosting as Record<string, unknown> : {};
}

export async function resolvePlatformBindingSessionSecret(snapshot: unknown): Promise<string> {
  const hosting = lifecycleHostingBinding(snapshot);
  const provider = typeof hosting.provider === "string" ? hosting.provider : "unknown";
  const connectionId = Number(hosting.connectionId);
  const projectId = typeof hosting.projectId === "string" ? hosting.projectId : null;
  const environmentId = typeof hosting.providerEnvironmentId === "string" ? hosting.providerEnvironmentId : null;
  const serviceId = typeof hosting.serviceId === "string" ? hosting.serviceId : null;
  if (provider !== "railway" || !Number.isInteger(connectionId) || !projectId || !environmentId || !serviceId) {
    throw new Error("Platform-binding auth invariant failed: lifecycle snapshot lacks a complete Railway hosting binding");
  }

  const [connection] = await db.select().from(providerConnections).where(
    combineWithVisibleScope(
      requireCurrentPrincipal(),
      providerConnectionScope,
      eq(providerConnections.id, connectionId),
    ),
  ).limit(1);
  const token = connection?.credentialRef ? await getProviderCredential(connection.credentialRef) : null;
  if (!token) throw new Error(`Platform-binding auth invariant failed: Railway connection ${connectionId} has no decryptable credential`);

  const { fetchServiceVariables } = await import("../integrations/railway/client");
  const variables = await fetchServiceVariables(projectId, environmentId, serviceId, token);
  const sessionSecret = variables.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error(`Platform-binding auth invariant failed: bound Railway environment ${environmentId}/${serviceId} does not expose SESSION_SECRET`);
  }
  return sessionSecret;
}
