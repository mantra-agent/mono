import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { requireCurrentPrincipal } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import { libraryPages } from "@shared/models/info";
import {
  platformProductEnvironments,
  productContextArtifacts,
  products,
} from "@shared/models/platforms";

const productScopeColumns = {
  scope: products.scope,
  ownerUserId: products.ownerUserId,
  accountId: products.accountId,
};

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

/**
 * Product-owned context pages visible to the current principal.
 * When environmentId is set, returns only artifacts for that Environment's parent Product.
 * Environment Context is retired; this is the sole coding/workflow context reader.
 */
export async function listVisibleProductContextPages(kinds: string[], environmentId?: number) {
  if (kinds.length === 0) return [];
  const principal = requireCurrentPrincipal();
  const environmentFilter = environmentId === undefined
    ? undefined
    : inArray(
      productContextArtifacts.productId,
      db
        .select({ productId: platformProductEnvironments.productId })
        .from(platformProductEnvironments)
        .where(eq(platformProductEnvironments.id, environmentId)),
    );

  return db
    .select({
      productId: productContextArtifacts.productId,
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
      environmentFilter,
      combineWithVisibleScope(principal, productScopeColumns),
      combineWithVisibleScope(principal, libraryScopeColumns),
    ))
    .orderBy(productContextArtifacts.productId, productContextArtifacts.kind, libraryPages.title);
}
