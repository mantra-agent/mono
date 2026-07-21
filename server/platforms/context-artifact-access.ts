import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import { libraryPages } from "@shared/models/info";
import {
  environmentContextArtifacts,
  platformProductEnvironments,
  platformProducts,
  platforms,
} from "@shared/models/platforms";
import { visiblePlatform } from "./platform-access";

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
};

export async function listVisibleEnvironmentContextPages(kinds: string[], environmentId?: number) {
  if (kinds.length === 0) return [];
  const principal = getCurrentPrincipalOrSystem();
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
