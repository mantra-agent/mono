import { and, eq, type SQL } from "drizzle-orm";
import { db } from "../db";
import {
  platformProductEnvironments,
  platformProducts,
  platforms,
} from "@shared/models/platforms";
import {
  visiblePlatform as visiblePlatformByVault,
  writablePlatform as writablePlatformByOwner,
} from "../platform-vault-access";

export {
  canManagePlatformVaults,
  ensurePlatformVaultMembershipSchema,
  loadVaultIdsByPlatformIds,
  resolveCreationVaultId,
  setPlatformVault,
} from "../platform-vault-access";

export function visiblePlatform(predicate?: SQL): SQL {
  return visiblePlatformByVault(predicate);
}

export function writablePlatform(predicate?: SQL): SQL {
  return writablePlatformByOwner(predicate);
}

export async function getVisibleProduct(productId: number) {
  const [row] = await db
    .select({ product: platformProducts, platform: platforms })
    .from(platformProducts)
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(platformProducts.id, productId), visiblePlatform()))
    .limit(1);
  return row || null;
}

export async function getWritableProduct(productId: number) {
  const [row] = await db
    .select({ product: platformProducts, platform: platforms })
    .from(platformProducts)
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(platformProducts.id, productId), writablePlatform()))
    .limit(1);
  return row || null;
}

export async function getVisibleEnvironment(environmentId: number) {
  const [row] = await db
    .select({
      environment: platformProductEnvironments,
      product: platformProducts,
      platform: platforms,
    })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(platformProductEnvironments.id, environmentId), visiblePlatform()))
    .limit(1);
  return row || null;
}

export async function getWritableEnvironment(environmentId: number) {
  const [row] = await db
    .select({
      environment: platformProductEnvironments,
      product: platformProducts,
      platform: platforms,
    })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(eq(platformProductEnvironments.id, environmentId), writablePlatform()))
    .limit(1);
  return row || null;
}
