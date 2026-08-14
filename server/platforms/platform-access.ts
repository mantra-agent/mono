import { and, eq, type SQL } from "drizzle-orm";
import { db } from "../db";
import {
  platformProductEnvironments,
  productPlatformAssociations,
  products,
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
    .select({ product: products, platform: platforms })
    .from(products)
    .innerJoin(productPlatformAssociations, eq(productPlatformAssociations.productId, products.id))
    .innerJoin(platforms, eq(productPlatformAssociations.platformId, platforms.id))
    .where(and(eq(products.id, productId), visiblePlatform()))
    .limit(1);
  return row || null;
}

export async function getWritableProduct(productId: number) {
  const [row] = await db
    .select({ product: products, platform: platforms })
    .from(products)
    .innerJoin(productPlatformAssociations, eq(productPlatformAssociations.productId, products.id))
    .innerJoin(platforms, eq(productPlatformAssociations.platformId, platforms.id))
    .where(and(eq(products.id, productId), writablePlatform()))
    .limit(1);
  return row || null;
}

export async function getVisibleEnvironment(environmentId: number) {
  const [row] = await db
    .select({
      environment: platformProductEnvironments,
      product: products,
      platform: platforms,
    })
    .from(platformProductEnvironments)
    .innerJoin(products, eq(platformProductEnvironments.productId, products.id))
    .innerJoin(platforms, eq(platformProductEnvironments.platformId, platforms.id))
    .where(and(eq(platformProductEnvironments.id, environmentId), visiblePlatform()))
    .limit(1);
  return row || null;
}

export async function getWritableEnvironment(environmentId: number) {
  const [row] = await db
    .select({
      environment: platformProductEnvironments,
      product: products,
      platform: platforms,
    })
    .from(platformProductEnvironments)
    .innerJoin(products, eq(platformProductEnvironments.productId, products.id))
    .innerJoin(platforms, eq(platformProductEnvironments.platformId, platforms.id))
    .where(and(eq(platformProductEnvironments.id, environmentId), writablePlatform()))
    .limit(1);
  return row || null;
}
