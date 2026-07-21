import { and, eq, type SQL } from "drizzle-orm";
import { db } from "../db";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope } from "../scoped-storage";
import { platformProductEnvironments, platformProducts, platforms } from "@shared/models/platforms";

const platformScopeColumns = {
  scope: platforms.scope,
  ownerUserId: platforms.ownerUserId,
  accountId: platforms.accountId,
};

export function visiblePlatform(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), platformScopeColumns, predicate);
}

export function writablePlatform(predicate?: SQL): SQL {
  return combineWithWritableScope(getCurrentPrincipalOrSystem(), platformScopeColumns, predicate);
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
