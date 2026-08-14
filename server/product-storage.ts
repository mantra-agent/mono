import { and, eq, inArray, sql } from "drizzle-orm";
import { db, runWithDatabaseTransaction } from "./db";
import { requireCurrentPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { featureRequests, insertFeatureRequestSchema, insertProductContextSchema, insertProductSchema, platformProductEnvironments, platforms, productBacklogs, productContextArtifacts, productPlatformAssociations, products } from "@shared/models/platforms";
import { libraryPages } from "@shared/models/info";
import { vaults } from "@shared/models/vaults";
import { visiblePlatform, writablePlatform } from "./platforms/platform-access";
import { storage } from "./storage";

const scopeColumns = { scope: products.scope, ownerUserId: products.ownerUserId, accountId: products.accountId };
const libraryScopeColumns = { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId };

async function assertAssignableVault(vaultId: string | null | undefined) {
  if (vaultId === undefined || vaultId === null) return;
  const principal = requireCurrentPrincipal();
  if (!principal.accountId) throw new Error("User account required");
  const [vault] = await db.select({ id: vaults.id }).from(vaults).where(and(
    eq(vaults.id, vaultId),
    eq(vaults.accountId, principal.accountId),
    eq(vaults.isArchived, false),
  )).limit(1);
  if (!vault) throw new Error("Product Vault must be live and belong to the active account");
}

export class ProductDependencyError extends Error {
  constructor(readonly dependencies: Record<string, number>) { super("Product has dependencies and cannot be deleted"); this.name = "ProductDependencyError"; }
}

export const productStorage = {
  async list() {
    const principal = requireCurrentPrincipal();
    const rows = await db.select().from(products).where(combineWithVisibleScope(principal, scopeColumns)).orderBy(products.name);
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const [backlogs, associations, contextRows] = await Promise.all([
      db.select().from(productBacklogs).where(inArray(productBacklogs.productId, ids)),
      db.select({ productId: productPlatformAssociations.productId, platformId: platforms.id, platformName: platforms.name }).from(productPlatformAssociations).innerJoin(platforms, eq(productPlatformAssociations.platformId, platforms.id)).where(and(inArray(productPlatformAssociations.productId, ids), visiblePlatform())),
      db.select({
        id: productContextArtifacts.id,
        productId: productContextArtifacts.productId,
        kind: productContextArtifacts.kind,
        libraryPageId: productContextArtifacts.libraryPageId,
        pageTitle: libraryPages.title,
      }).from(productContextArtifacts).innerJoin(libraryPages, eq(productContextArtifacts.libraryPageId, libraryPages.id)).where(and(inArray(productContextArtifacts.productId, ids), combineWithVisibleScope(principal, libraryScopeColumns))).orderBy(productContextArtifacts.kind, libraryPages.title),
    ]);
    const requestCounts = await db.select({ productId: productBacklogs.productId, count: sql<number>`count(${featureRequests.id})::int` }).from(productBacklogs).leftJoin(featureRequests, eq(featureRequests.backlogId, productBacklogs.id)).where(inArray(productBacklogs.productId, ids)).groupBy(productBacklogs.productId);
    return rows.map((product) => ({
      ...product,
      backlogId: backlogs.find((row) => row.productId === product.id)?.id,
      featureRequestCount: requestCounts.find((row) => row.productId === product.id)?.count ?? 0,
      platforms: associations.filter((row) => row.productId === product.id),
      context: contextRows.filter((row) => row.productId === product.id).map((row) => ({
        id: row.id,
        kind: row.kind,
        libraryPageId: row.libraryPageId,
        pageTitle: row.pageTitle || "Untitled",
      })),
    }));
  },

  async create(input: unknown) {
    const principal = requireCurrentPrincipal();
    const parsed = insertProductSchema.parse(input);
    const vaultId = parsed.vaultId === undefined ? principal.activeVaultId : parsed.vaultId;
    await assertAssignableVault(vaultId);
    if (parsed.platformIds.length) {
      const visible = await db.select({ id: platforms.id }).from(platforms).where(and(inArray(platforms.id, parsed.platformIds), writablePlatform()));
      if (visible.length !== new Set(parsed.platformIds).size) throw new Error("One or more Platforms are not writable");
    }
    return db.transaction((tx) => runWithDatabaseTransaction(tx, async () => {
      const [product] = await tx.insert(products).values({ name: parsed.name, description: parsed.description, status: parsed.status, vaultId: vaultId ?? null, ...ownedInsertValues(principal, scopeColumns) }).returning();
      const [backlog] = await tx.insert(productBacklogs).values({ productId: product.id }).returning();
      if (parsed.platformIds.length) await tx.insert(productPlatformAssociations).values(parsed.platformIds.map((platformId) => ({ productId: product.id, platformId }))).onConflictDoNothing();
      return { ...product, backlogId: backlog.id };
    }));
  },

  async update(id: number, input: unknown) {
    const parsed = insertProductSchema.partial().parse(input);
    await assertAssignableVault(parsed.vaultId);
    const patch = {
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(parsed.vaultId !== undefined ? { vaultId: parsed.vaultId } : {}),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    };
    const principal = requireCurrentPrincipal();
    const [updated] = await db.update(products).set(patch).where(combineWithWritableScope(principal, scopeColumns, eq(products.id, id))).returning();
    return updated;
  },

  async archive(id: number) { return this.update(id, { status: "archived" }); },

  async remove(id: number) {
    const principal = requireCurrentPrincipal();
    const [product] = await db.select().from(products).where(combineWithWritableScope(principal, scopeColumns, eq(products.id, id))).limit(1);
    if (!product) return false;
    const [counts] = await db.select({ platforms: sql<number>`count(distinct ${productPlatformAssociations.id})::int`, features: sql<number>`count(distinct ${featureRequests.id})::int` }).from(productBacklogs).leftJoin(productPlatformAssociations, eq(productPlatformAssociations.productId, product.id)).leftJoin(featureRequests, eq(featureRequests.backlogId, productBacklogs.id)).where(eq(productBacklogs.productId, id));
    const [environmentCount] = await db.select({ environments: sql<number>`count(${platformProductEnvironments.id})::int` }).from(platformProductEnvironments).where(eq(platformProductEnvironments.productId, id));
    const dependencies = { platforms: counts?.platforms ?? 0, featureRequests: counts?.features ?? 0, environments: environmentCount?.environments ?? 0 };
    if (Object.values(dependencies).some(Boolean)) throw new ProductDependencyError(dependencies);
    const [deleted] = await db.delete(products).where(combineWithWritableScope(principal, scopeColumns, eq(products.id, id))).returning({ id: products.id });
    return !!deleted;
  },

  async backlog(productId: number) {
    const principal = requireCurrentPrincipal();
    const [product] = await db.select().from(products).where(combineWithVisibleScope(principal, scopeColumns, eq(products.id, productId))).limit(1);
    if (!product) return undefined;
    const [backlog] = await db.select().from(productBacklogs).where(eq(productBacklogs.productId, productId)).limit(1);
    if (!backlog) return undefined;
    const requests = await db.select().from(featureRequests).where(eq(featureRequests.backlogId, backlog.id)).orderBy(featureRequests.createdAt);
    return { product, backlog, requests };
  },

  async createFeature(productId: number, input: unknown) {
    const principal = requireCurrentPrincipal();
    const [product] = await db.select().from(products).where(combineWithWritableScope(principal, scopeColumns, eq(products.id, productId))).limit(1);
    if (!product) return undefined;
    const parsed = insertFeatureRequestSchema.parse(input);
    const [backlog] = await db.select().from(productBacklogs).where(eq(productBacklogs.productId, productId)).limit(1);
    if (!backlog) throw new Error("Product backlog is missing");
    const [created] = await db.insert(featureRequests).values({ ...parsed, backlogId: backlog.id }).returning();
    return created;
  },

  async updateFeature(productId: number, requestId: number, input: unknown) {
    requireCurrentPrincipal();
    const parsed = insertFeatureRequestSchema.partial().parse(input);
    const [updated] = await db.update(featureRequests).set({ ...parsed, updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(featureRequests.id, requestId), eq(featureRequests.backlogId, sql`(select id from product_backlogs where product_id = ${productId})`))).returning();
    return updated;
  },

  async removeFeature(productId: number, requestId: number) {
    requireCurrentPrincipal();
    const [deleted] = await db.delete(featureRequests).where(and(eq(featureRequests.id, requestId), eq(featureRequests.backlogId, sql`(select id from product_backlogs where product_id = ${productId})`))).returning({ id: featureRequests.id });
    return !!deleted;
  },

  async bridgeFeatureToIssue(productId: number, requestId: number) {
    requireCurrentPrincipal();
    const backlog = await this.backlog(productId);
    const request = backlog?.requests.find((item) => item.id === requestId);
    if (!request) return undefined;
    return storage.createIssue({ title: request.title, description: request.description, reproSteps: `Feature Request ${request.id}: ${request.title}`, productId, status: "open", kind: "tracked" });
  },

  async addContext(productId: number, input: unknown) {
    const principal = requireCurrentPrincipal();
    const parsed = insertProductContextSchema.parse(input);
    const [product] = await db.select().from(products).where(combineWithWritableScope(principal, scopeColumns, eq(products.id, productId))).limit(1);
    if (!product) return undefined;
    const [page] = await db.select({ id: libraryPages.id, title: libraryPages.title }).from(libraryPages).where(combineWithVisibleScope(principal, libraryScopeColumns, eq(libraryPages.id, parsed.libraryPageId))).limit(1);
    if (!page) throw new Error("Library page not found");
    const [saved] = await db.insert(productContextArtifacts).values({ productId, kind: parsed.kind, libraryPageId: parsed.libraryPageId }).onConflictDoNothing().returning();
    if (saved) return { ...saved, pageTitle: page.title || "Untitled" };
    const [existing] = await db.select().from(productContextArtifacts).where(and(eq(productContextArtifacts.productId, productId), eq(productContextArtifacts.kind, parsed.kind), eq(productContextArtifacts.libraryPageId, parsed.libraryPageId))).limit(1);
    return existing ? { ...existing, pageTitle: page.title || "Untitled" } : undefined;
  },

  async removeContext(productId: number, contextId: number) {
    const principal = requireCurrentPrincipal();
    const [product] = await db.select().from(products).where(combineWithWritableScope(principal, scopeColumns, eq(products.id, productId))).limit(1);
    if (!product) return undefined;
    const [deleted] = await db.delete(productContextArtifacts).where(and(eq(productContextArtifacts.id, contextId), eq(productContextArtifacts.productId, productId))).returning({ id: productContextArtifacts.id });
    return deleted ? true : false;
  },
};
