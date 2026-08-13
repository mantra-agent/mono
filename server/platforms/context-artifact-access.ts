import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { requireCurrentPrincipal } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import { libraryPages } from "@shared/models/info";
import {
  environmentContextArtifacts,
  platformProductEnvironments,
  platformProducts,
  platforms,
  productContextArtifacts,
  productPlatformAssociations,
  products,
} from "@shared/models/platforms";
import { visiblePlatform } from "./platform-access";

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

const productScopeColumns = {
  scope: products.scope,
  ownerUserId: products.ownerUserId,
  accountId: products.accountId,
};

export async function resolveProductIdForEnvironment(environmentId: number): Promise<number | undefined> {
  const principal = requireCurrentPrincipal();
  const [row] = await db
    .select({ productId: products.id })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(productPlatformAssociations, eq(productPlatformAssociations.platformId, platformProducts.platformId))
    .innerJoin(products, and(
      eq(products.id, productPlatformAssociations.productId),
      sql`lower(${products.name}) = lower(${platformProducts.name})`,
    ))
    .where(and(
      eq(platformProductEnvironments.id, environmentId),
      visiblePlatform(),
      combineWithVisibleScope(principal, productScopeColumns),
    ))
    .limit(1);
  return row?.productId;
}

export async function listVisibleEnvironmentContextPages(kinds: string[], environmentId?: number) {
  if (kinds.length === 0) return [];
  const principal = requireCurrentPrincipal();
  const productId = environmentId === undefined ? undefined : await resolveProductIdForEnvironment(environmentId);
  const productRows = await db
    .select({
      environmentId: sql<number>`${environmentId ?? 0}`.as("environment_id"),
      kind: productContextArtifacts.kind,
      libraryPageId: libraryPages.id,
      title: libraryPages.title,
      slug: libraryPages.slug,
      content: libraryPages.plainTextContent,
    })
    .from(productContextArtifacts)
    .innerJoin(products, eq(productContextArtifacts.productId, products.id))
    .innerJoin(libraryPages, eq(productContextArtifacts.libraryPageId, libraryPages.id))
    .where(and(
      inArray(productContextArtifacts.kind, kinds),
      productId === undefined ? undefined : eq(productContextArtifacts.productId, productId),
      combineWithVisibleScope(principal, productScopeColumns),
      combineWithVisibleScope(principal, libraryScopeColumns),
    ))
    .orderBy(productContextArtifacts.kind, libraryPages.title);
  if (productRows.length > 0) return productRows;

  return db
    .select({
      environmentId: environmentContextArtifacts.environmentId,
      kind: environmentContextArtifacts.kind,
      libraryPageId: libraryPages.id,
      title: libraryPages.title,
      slug: libraryPages.slug,
      content: libraryPages.plainTextContent,
    })
    .from(environmentContextArtifacts)
    .innerJoin(platformProductEnvironments, eq(environmentContextArtifacts.environmentId, platformProductEnvironments.id))
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .innerJoin(libraryPages, eq(environmentContextArtifacts.libraryPageId, libraryPages.id))
    .where(and(
      inArray(environmentContextArtifacts.kind, kinds),
      environmentId === undefined ? undefined : eq(environmentContextArtifacts.environmentId, environmentId),
      visiblePlatform(),
      combineWithVisibleScope(principal, libraryScopeColumns),
    ))
    .orderBy(environmentContextArtifacts.environmentId, environmentContextArtifacts.kind, libraryPages.title);
}
