import { randomBytes } from "crypto";
import { asc, eq } from "drizzle-orm";
import { financialModels } from "@shared/schema";
import {
  assertWritable,
  combineWithVisibleScope,
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
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { createLogger } from "./log";

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
  return {
    id: row.id,
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
  private async firstVisible() {
    const principal = getCurrentPrincipalOrSystem();
    const rows = await db
      .select()
      .from(financialModels)
      .where(combineWithVisibleScope(principal, modelScope))
      .orderBy(asc(financialModels.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * One model per account in v1. Returns the principal's model, creating it
   * with default assumptions if none exists. The insert is replay-safe: the
   * partial unique index on account_id plus onConflictDoNothing means a
   * concurrent create resolves to a single row on re-read.
   */
  async getOrCreate(): Promise<FinancialModel> {
    const existing = await this.firstVisible();
    if (existing) {
      const principal = getCurrentPrincipalOrSystem();
      const normalized = normalizeAssumptions(existing.assumptions);
      if (needsNormalization(existing, normalized)) {
        const rows = await db
          .update(financialModels)
          .set({ assumptions: normalized, updatedAt: new Date() })
          .where(combineWithWritableScope(principal, modelScope, eq(financialModels.id, existing.id)))
          .returning();
        const updated = rows[0];
        if (updated) {
          log.info("normalized financial model assumptions", { modelId: updated.id, modelVersion: normalized.modelVersion });
          return mapModel(updated, normalized);
        }
      }
      return mapModel(existing, normalized);
    }

    const principal = getCurrentPrincipalOrSystem();
    const now = new Date();
    const row = {
      id: newModelId(),
      ...ownedInsertValues(principal, modelScope),
      createdByUserId: principal.userId ?? null,
      name: "Mantra Model",
      assumptions: defaultAssumptions(),
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(financialModels).values(row).onConflictDoNothing();

    const settled = await this.firstVisible();
    if (!settled) {
      log.error("financial model missing after get-or-create insert");
      throw new Error("Failed to create financial model");
    }
    return mapModel(settled);
  }

  /** Apply a partial assumptions patch (omitted fields unchanged) and persist the normalized result. */
  async updateAssumptions(patch: AssumptionsPatch): Promise<FinancialModel> {
    const principal = getCurrentPrincipalOrSystem();
    const current = await this.getOrCreate();
    const nextAssumptions = mergeAssumptions(current.assumptions, patch);
    const rows = await db
      .update(financialModels)
      .set({ assumptions: nextAssumptions, updatedAt: new Date() })
      .where(combineWithWritableScope(principal, modelScope, eq(financialModels.id, current.id)))
      .returning();
    const updated = assertWritable(principal, rows[0], "Financial model");
    return mapModel(updated);
  }
}

export const businessModelStorage = new BusinessModelStorage();
