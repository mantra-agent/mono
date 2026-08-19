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

export type ListVisibleProductContextPagesScope = {
  environmentId?: number;
  productId?: number;
};

/**
 * Product-owned context pages visible to the current principal.
 * Scope by Environment (parent Product) or by Feature productId.
 * Environment Context is retired; this is the sole coding/workflow context reader.
 */
export async function listVisibleProductContextPages(
  kinds: string[],
  environmentIdOrScope?: number | ListVisibleProductContextPagesScope,
) {
  if (kinds.length === 0) return [];
  const principal = requireCurrentPrincipal();
  const scope = typeof environmentIdOrScope === "number"
    ? { environmentId: environmentIdOrScope }
    : environmentIdOrScope ?? {};
  const productFilter = scope.productId !== undefined
    ? eq(productContextArtifacts.productId, scope.productId)
    : scope.environmentId === undefined
      ? undefined
      : inArray(
        productContextArtifacts.productId,
        db
          .select({ productId: platformProductEnvironments.productId })
          .from(platformProductEnvironments)
          .where(eq(platformProductEnvironments.id, scope.environmentId)),
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
      productFilter,
      combineWithVisibleScope(principal, productScopeColumns),
      combineWithVisibleScope(principal, libraryScopeColumns),
    ))
    .orderBy(productContextArtifacts.productId, productContextArtifacts.kind, libraryPages.title);
}
