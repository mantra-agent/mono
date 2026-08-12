import { randomBytes } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { businessBudgets, businesses } from "@shared/schema";
import {
  businessBudgetSchema,
  budgetDepartmentSchema,
  type BusinessBudget,
  type BusinessBudgetMutation,
  type BudgetDepartment,
} from "@shared/models/business-budgets";
import { db, runWithDatabaseTransaction } from "./db";
import { requireCurrentUserPrincipal } from "./principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";
import { visibleBusinessPredicate, writableBusinessPredicate } from "./business-vault-access";

// Rolling compatibility only. Product/API identity is one hypothetical month per Business.
const SINGLE_MONTH_BUDGET_KEY = 2000;

const budgetScope = {
  scope: businessBudgets.scope,
  ownerUserId: businessBudgets.ownerUserId,
  accountId: businessBudgets.accountId,
};

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function notFound(label: string): never {
  throw Object.assign(new Error(`${label} not found`), { status: 404 });
}

function mapBudget(row: typeof businessBudgets.$inferSelect): BusinessBudget {
  return businessBudgetSchema.parse({
    id: row.id,
    businessId: row.businessId,
    currency: row.currency,
    departments: row.departments,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function mutateDepartments(departments: BudgetDepartment[], mutation: BusinessBudgetMutation): BudgetDepartment[] {
  const next = structuredClone(departments);
  if (mutation.action === "add_department") {
    next.push({ id: newId("dept"), name: mutation.name ?? "New Department", categories: [] });
    return next;
  }
  const department = next.find((item) => item.id === mutation.departmentId) ?? notFound("Department");
  if (mutation.action === "rename_department") department.name = mutation.name;
  if (mutation.action === "delete_department") return next.filter((item) => item.id !== mutation.departmentId);
  if (mutation.action === "add_category") {
    department.categories.push({ id: newId("category"), name: mutation.name ?? "New Category", lineItems: [] });
  }
  if (!("categoryId" in mutation)) return next;
  const category = department.categories.find((item) => item.id === mutation.categoryId) ?? notFound("Category");
  if (mutation.action === "rename_category") category.name = mutation.name;
  if (mutation.action === "delete_category") {
    department.categories = department.categories.filter((item) => item.id !== mutation.categoryId);
    return next;
  }
  if (mutation.action === "add_line_item") {
    category.lineItems.push({ id: newId("item"), name: mutation.name ?? "New Line Item", monthlyAmountCents: 0 });
  }
  if (!("lineItemId" in mutation)) return next;
  const lineItem = category.lineItems.find((item) => item.id === mutation.lineItemId) ?? notFound("Line item");
  if (mutation.action === "rename_line_item") lineItem.name = mutation.name;
  if (mutation.action === "delete_line_item") {
    category.lineItems = category.lineItems.filter((item) => item.id !== mutation.lineItemId);
  }
  if (mutation.action === "set_monthly_amount") lineItem.monthlyAmountCents = mutation.amountCents;
  return next.map((item) => budgetDepartmentSchema.parse(item));
}

async function findVisible(businessId: string) {
  const principal = requireCurrentUserPrincipal();
  const [row] = await db
    .select({ budget: businessBudgets })
    .from(businessBudgets)
    .innerJoin(businesses, eq(businesses.id, businessBudgets.businessId))
    .where(and(
      visibleBusinessPredicate(principal, eq(businesses.id, businessId)),
      combineWithVisibleScope(principal, budgetScope),
      eq(businessBudgets.businessId, businessId),
    ))
    .orderBy(desc(businessBudgets.updatedAt))
    .limit(1);
  return row?.budget ?? null;
}

export const businessBudgetStorage = {
  async getOrCreate(businessId: string): Promise<BusinessBudget> {
    const principal = requireCurrentUserPrincipal();
    const existing = await findVisible(businessId);
    if (existing) return mapBudget(existing);

    const [business] = await db.select({ id: businesses.id }).from(businesses)
      .where(writableBusinessPredicate(principal, eq(businesses.id, businessId))).limit(1);
    if (!business) throw Object.assign(new Error("Business not found or not writable"), { status: 403 });

    await db.insert(businessBudgets).values({
      id: newId("budget"),
      businessId,
      year: SINGLE_MONTH_BUDGET_KEY,
      currency: "USD",
      departments: [],
      ...ownedInsertValues(principal, budgetScope),
      createdByUserId: principal.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();

    const settled = await findVisible(businessId);
    if (!settled) throw new Error("Failed to create Business budget");
    return mapBudget(settled);
  },

  async mutate(businessId: string, mutation: BusinessBudgetMutation): Promise<BusinessBudget> {
    const principal = requireCurrentUserPrincipal();
    return db.transaction(async (tx) => runWithDatabaseTransaction(tx, async () => {
      const [business] = await tx.select({ id: businesses.id }).from(businesses)
        .where(writableBusinessPredicate(principal, eq(businesses.id, businessId))).limit(1);
      if (!business) throw Object.assign(new Error("Business not found or not writable"), { status: 403 });

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`business-budget:${businessId}`}))`);
      const current = await this.getOrCreate(businessId);
      const departments = mutateDepartments(current.departments, mutation);
      const [updated] = await tx.update(businessBudgets)
        .set({ departments, updatedAt: new Date() })
        .where(combineWithWritableScope(principal, budgetScope, and(
          eq(businessBudgets.id, current.id),
          eq(businessBudgets.businessId, businessId),
        )))
        .returning();
      if (!updated) notFound("Business budget");
      return mapBudget(updated);
    }));
  },
};
