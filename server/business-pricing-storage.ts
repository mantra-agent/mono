import { randomBytes } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { businessPricing, businesses } from "@shared/schema";
import {
  applyExtrasPatch,
  applyPackagePatch,
  businessPricingMutationSchema,
  normalizePricingExtras,
  normalizePricingPackages,
  projectPackage,
  seedPricingPackages,
  type BusinessPricing,
  type BusinessPricingMutation,
} from "@shared/models/business-pricing";
import { db, runWithDatabaseTransaction } from "./db";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { visibleBusinessPredicate, writableBusinessPredicate } from "./business-vault-access";
import { createLogger } from "./log";

const log = createLogger("BusinessPricingStorage");

const pricingScope = {
  scope: businessPricing.scope,
  ownerUserId: businessPricing.ownerUserId,
  accountId: businessPricing.accountId,
};

function newId(): string {
  return `pricing_${randomBytes(8).toString("hex")}`;
}

async function snapshotRevision(row: typeof businessPricing.$inferSelect): Promise<string> {
  const id = `pricing_rev_${row.id}_${row.updatedAt.getTime()}`;
  await db.execute(sql`
    INSERT INTO business_pricing_revisions (id, business_id, pricing_id, snapshot, created_at)
    VALUES (${id}, ${row.businessId}, ${row.id}, ${JSON.stringify({ packages: row.packages, extras: row.extras })}::jsonb, ${row.updatedAt})
    ON CONFLICT (id) DO NOTHING
  `);
  return id;
}

function mapCatalog(row: typeof businessPricing.$inferSelect): BusinessPricing {
  const packages = normalizePricingPackages(row.packages).map(projectPackage);
  const extras = normalizePricingExtras(row.extras);
  return {
    id: row.id,
    businessId: row.businessId,
    packages,
    extras,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function findVisible(businessId: string) {
  const principal = requireCurrentUserPrincipal();
  const [row] = await db
    .select({ pricing: businessPricing })
    .from(businessPricing)
    .innerJoin(businesses, eq(businesses.id, businessPricing.businessId))
    .where(and(
      visibleBusinessPredicate(principal, eq(businesses.id, businessId)),
      combineWithVisibleScope(principal, pricingScope),
      eq(businessPricing.businessId, businessId),
    ))
    .limit(1);
  return row?.pricing ?? null;
}

export class BusinessPricingStorage {
  async getOrCreate(businessId: string): Promise<BusinessPricing> {
    const principal = requireCurrentUserPrincipal();
    const existing = await findVisible(businessId);
    if (existing) {
      await snapshotRevision(existing);
      return mapCatalog(existing);
    }

    const [business] = await db.select({ id: businesses.id }).from(businesses)
      .where(writableBusinessPredicate(principal, eq(businesses.id, businessId))).limit(1);
    if (!business) throw Object.assign(new Error("Business not found or not writable"), { status: 403 });

    await db.insert(businessPricing).values({
      id: newId(),
      businessId,
      packages: seedPricingPackages(),
      extras: { extraUsagePerMillion: 3, workhorseInputPerMillion: 2 },
      ...ownedInsertValues(principal, pricingScope),
      createdByUserId: principal.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();

    const settled = await findVisible(businessId);
    if (!settled) throw new Error("Failed to create Business pricing catalog");
    log.info("pricing catalog seeded", { businessId });
    return mapCatalog(settled);
  }

  async mutate(businessId: string, mutation: BusinessPricingMutation): Promise<BusinessPricing> {
    const parsed = businessPricingMutationSchema.parse(mutation);
    const principal = requireCurrentUserPrincipal();
    return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
      const [business] = await tx.select({ id: businesses.id }).from(businesses)
        .where(writableBusinessPredicate(principal, eq(businesses.id, businessId))).limit(1);
      if (!business) throw Object.assign(new Error("Business not found or not writable"), { status: 403 });

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`business-pricing:${businessId}`}))`);
      const current = await this.getOrCreate(businessId);
      const packages = current.packages.map(({ yearOneMonthly: _yearOneMonthly, ...pkg }) => pkg);
      let extras = current.extras;
      if (parsed.action === "update_package") {
        const index = packages.findIndex((pkg) => pkg.key === parsed.key);
        if (index < 0) throw Object.assign(new Error("Unknown pricing package"), { status: 400 });
        packages[index] = applyPackagePatch(packages[index], parsed.patch);
      } else {
        extras = applyExtrasPatch(extras, parsed.patch);
      }

      const [updated] = await tx.update(businessPricing)
        .set({
          packages: normalizePricingPackages(packages),
          extras,
          updatedAt: new Date(),
        })
        .where(combineWithWritableScope(principal, pricingScope, and(
          eq(businessPricing.id, current.id),
          eq(businessPricing.businessId, businessId),
        )))
        .returning();
      if (!updated) throw Object.assign(new Error("Business pricing not found"), { status: 404 });
      await snapshotRevision(updated);
      log.info("pricing catalog updated", { businessId, action: parsed.action });
      return mapCatalog(updated);
    }));
  }
}

export const businessPricingStorage = new BusinessPricingStorage();
