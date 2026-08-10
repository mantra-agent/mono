import { randomBytes } from "crypto";
import { and, eq } from "drizzle-orm";
import { businesses, financialModels } from "@shared/schema";
import {
  assertWritable,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";
import {
  defaultAssumptions,
  mergeAssumptions,
  normalizeAssumptions,
  type AssumptionsPatch,
  type FinancialModel,
} from "@shared/models/business-model";
import { db } from "./db";
import { requireCurrentUserPrincipal } from "./principal-context";
import { createLogger } from "./log";
import { visibleBusinessPredicate, writableBusinessPredicate } from "./business-vault-access";

const log = createLogger("BusinessModelStorage");

const modelScope = {
  scope: financialModels.scope,
  ownerUserId: financialModels.ownerUserId,
  accountId: financialModels.accountId,
};

function newModelId(): string {
  return randomBytes(8).toString("hex");
}

function mapModel(row: typeof financialModels.$inferSelect, assumptions = normalizeAssumptions(row.assumptions)): FinancialModel {
  if (!row.businessId) throw new Error("Financial model is missing its owning Business");
  return {
    id: row.id,
    businessId: row.businessId,
    name: row.name,
    assumptions,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function needsNormalization(row: typeof financialModels.$inferSelect, normalized: ReturnType<typeof normalizeAssumptions>): boolean {
  return JSON.stringify(row.assumptions) !== JSON.stringify(normalized);
}

export class BusinessModelStorage {
  private async assertVisibleBusiness(businessId: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(visibleBusinessPredicate(principal, eq(businesses.id, businessId)))
      .limit(1);
    if (!business) throw Object.assign(new Error("Business not found or not visible"), { status: 404 });
  }

  private async findByBusiness(businessId: string) {
    const principal = requireCurrentUserPrincipal();
    const [row] = await db
      .select({ model: financialModels })
      .from(financialModels)
      .innerJoin(businesses, eq(businesses.id, financialModels.businessId))
      .where(and(
        visibleBusinessPredicate(principal, eq(businesses.id, businessId)),
        eq(financialModels.businessId, businessId),
      ))
      .limit(1);
    return row?.model ?? null;
  }

  async getOrCreate(businessId: string): Promise<FinancialModel> {
    await this.assertVisibleBusiness(businessId);
    const existing = await this.findByBusiness(businessId);
    if (existing) {
      const principal = requireCurrentUserPrincipal();
      const normalized = normalizeAssumptions(existing.assumptions);
      if (needsNormalization(existing, normalized)) {
        const [updated] = await db
          .update(financialModels)
          .set({ assumptions: normalized, updatedAt: new Date() })
          .where(combineWithWritableScope(principal, modelScope, eq(financialModels.id, existing.id)))
          .returning();
        if (updated) {
          log.info("normalized financial model assumptions", { modelId: updated.id, modelVersion: normalized.modelVersion });
          return mapModel(updated, normalized);
        }
      }
      return mapModel(existing, normalized);
    }

    const principal = requireCurrentUserPrincipal();
    const [writableBusiness] = await db
      .select({ id: businesses.id, publicName: businesses.publicName })
      .from(businesses)
      .where(writableBusinessPredicate(principal, eq(businesses.id, businessId)))
      .limit(1);
    if (!writableBusiness) throw Object.assign(new Error("Business not found or not writable"), { status: 403 });

    const now = new Date();
    await db.insert(financialModels).values({
      id: newModelId(),
      businessId,
      ...ownedInsertValues(principal, modelScope),
      createdByUserId: principal.userId ?? null,
      name: `${writableBusiness.publicName} Model`,
      assumptions: defaultAssumptions(),
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();

    const settled = await this.findByBusiness(businessId);
    if (!settled) throw new Error("Failed to create financial model");
    return mapModel(settled);
  }

  async updateAssumptions(businessId: string, patch: AssumptionsPatch): Promise<FinancialModel> {
    const principal = requireCurrentUserPrincipal();
    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(writableBusinessPredicate(principal, eq(businesses.id, businessId)))
      .limit(1);
    if (!business) throw Object.assign(new Error("Business not found or not writable"), { status: 403 });

    const current = await this.getOrCreate(businessId);
    const nextAssumptions = mergeAssumptions(current.assumptions, patch);
    const [row] = await db
      .update(financialModels)
      .set({ assumptions: nextAssumptions, updatedAt: new Date() })
      .where(combineWithWritableScope(principal, modelScope, and(
        eq(financialModels.id, current.id),
        eq(financialModels.businessId, businessId),
      )))
      .returning();
    return mapModel(assertWritable(principal, row, "Financial model"));
  }
}

export const businessModelStorage = new BusinessModelStorage();
