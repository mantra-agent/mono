import { and, eq, type SQL } from "drizzle-orm";
import {
  environmentHostingBindings,
  platformProductEnvironments,
  platformProducts,
  platforms,
  providerConnections,
} from "@shared/models/platforms";
import { db } from "./db";
import { getProviderCredential } from "./provider-credential-store";
import { createLogger } from "./log";

const log = createLogger("PlatformEnvironmentResolver");

export interface RailwayProviderConfiguration {
  projectId: string;
  environmentId: string;
  serviceId: string;
  publicUrl: string | null;
}

export interface ResolvedPlatformEnvironment {
  platformEnvironmentId: number;
  platformEnvironmentName: string;
  productId: number;
  productName: string;
  platformId: number;
  platformName: string;
  provider: string;
  connectionId: number;
  connectionLabel: string;
  credential: string;
  providerConfiguration: RailwayProviderConfiguration;
}

interface RailwayRuntimeCoordinates {
  projectId: string;
  environmentId: string;
  serviceId: string;
}

function normalizeOptional(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

async function resolveEnvironment(where: SQL): Promise<ResolvedPlatformEnvironment | null> {
  const rows = await db
    .select({
      platformEnvironmentId: platformProductEnvironments.id,
      platformEnvironmentName: platformProductEnvironments.name,
      productId: platformProducts.id,
      productName: platformProducts.name,
      platformId: platforms.id,
      platformName: platforms.name,
      provider: environmentHostingBindings.provider,
      connectionProvider: providerConnections.provider,
      connectionId: providerConnections.id,
      connectionLabel: providerConnections.label,
      projectId: environmentHostingBindings.projectId,
      providerEnvironmentId: environmentHostingBindings.providerEnvironmentId,
      serviceId: environmentHostingBindings.serviceId,
      publicUrl: environmentHostingBindings.publicUrl,
    })
    .from(platformProductEnvironments)
    .innerJoin(environmentHostingBindings, eq(environmentHostingBindings.environmentId, platformProductEnvironments.id))
    .innerJoin(providerConnections, eq(providerConnections.id, environmentHostingBindings.connectionId))
    .innerJoin(platformProducts, eq(platformProducts.id, platformProductEnvironments.productId))
    .innerJoin(platforms, eq(platforms.id, platformProducts.platformId))
    .where(where)
    .limit(2);

  if (rows.length === 0) return null;
  if (rows.length > 1) {
    throw new Error("Platform Environment resolution is ambiguous; multiple hosting bindings match");
  }

  const row = rows[0];
  if (row.provider !== "railway" || row.connectionProvider !== "railway") {
    throw new Error(`Platform Environment ${row.platformEnvironmentId} is not bound to a Railway connection`);
  }
  if (!row.projectId || !row.providerEnvironmentId || !row.serviceId) {
    throw new Error(`Platform Environment ${row.platformEnvironmentId} has an incomplete Railway hosting binding`);
  }

  const credential = await getProviderCredential(row.connectionId);
  if (!credential) {
    throw new Error(`Provider connection ${row.connectionId} has no usable credential`);
  }

  return {
    platformEnvironmentId: row.platformEnvironmentId,
    platformEnvironmentName: row.platformEnvironmentName,
    productId: row.productId,
    productName: row.productName,
    platformId: row.platformId,
    platformName: row.platformName,
    provider: row.provider,
    connectionId: row.connectionId,
    connectionLabel: row.connectionLabel,
    credential,
    providerConfiguration: {
      projectId: row.projectId,
      environmentId: row.providerEnvironmentId,
      serviceId: row.serviceId,
      publicUrl: normalizeOptional(row.publicUrl),
    },
  };
}

export async function resolvePlatformEnvironment(
  platformEnvironmentId: number,
): Promise<ResolvedPlatformEnvironment | null> {
  if (!Number.isInteger(platformEnvironmentId) || platformEnvironmentId <= 0) {
    throw new Error("platformEnvironmentId must be a positive integer");
  }
  return resolveEnvironment(eq(platformProductEnvironments.id, platformEnvironmentId));
}

export async function resolveRunningPlatformEnvironment(): Promise<ResolvedPlatformEnvironment | null> {
  const coordinates: RailwayRuntimeCoordinates = {
    projectId: process.env.RAILWAY_PROJECT_ID?.trim() || "",
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID?.trim() || "",
    serviceId: process.env.RAILWAY_SERVICE_ID?.trim() || "",
  };

  if (!coordinates.projectId && !coordinates.environmentId && !coordinates.serviceId) {
    return null;
  }
  if (!coordinates.projectId || !coordinates.environmentId || !coordinates.serviceId) {
    log.warn(
      `Railway runtime coordinates are incomplete; Platform Environment identity is unavailable ` +
        `(project=${Boolean(coordinates.projectId)} environment=${Boolean(coordinates.environmentId)} service=${Boolean(coordinates.serviceId)})`,
    );
    return null;
  }

  return resolveEnvironment(and(
    eq(environmentHostingBindings.projectId, coordinates.projectId),
    eq(environmentHostingBindings.providerEnvironmentId, coordinates.environmentId),
    eq(environmentHostingBindings.serviceId, coordinates.serviceId),
    eq(environmentHostingBindings.provider, "railway"),
  ));
}
