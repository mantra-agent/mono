import { z } from "zod";

const nameSchema = z.string().trim().min(1).max(120);
const idSchema = z.string().trim().min(1).max(120);
const centsSchema = z.number().int().min(0).max(1_000_000_000_00);

export const budgetLineItemSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const candidate = value as Record<string, unknown>;
  if (candidate.monthlyAmountCents !== undefined) return value;
  const legacyAmounts = candidate.monthlyAmountsCents;
  return {
    ...candidate,
    monthlyAmountCents: Array.isArray(legacyAmounts) && typeof legacyAmounts[0] === "number" ? legacyAmounts[0] : 0,
  };
}, z.object({
  id: idSchema,
  name: nameSchema,
  monthlyAmountCents: centsSchema,
}));

export const budgetCategorySchema = z.object({
  id: idSchema,
  name: nameSchema,
  lineItems: z.array(budgetLineItemSchema).max(500),
});

export const budgetDepartmentSchema = z.object({
  id: idSchema,
  name: nameSchema,
  categories: z.array(budgetCategorySchema).max(100),
});

export const businessBudgetSchema = z.object({
  id: idSchema,
  businessId: idSchema,
  currency: z.literal("USD"),
  departments: z.array(budgetDepartmentSchema).max(100),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type BudgetLineItem = z.infer<typeof budgetLineItemSchema>;
export type BudgetCategory = z.infer<typeof budgetCategorySchema>;
export type BudgetDepartment = z.infer<typeof budgetDepartmentSchema>;
export type BusinessBudget = z.infer<typeof businessBudgetSchema>;

const departmentAction = z.object({ departmentId: idSchema });
const categoryAction = departmentAction.extend({ categoryId: idSchema });
const lineItemAction = categoryAction.extend({ lineItemId: idSchema });

export const businessBudgetMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add_department"), name: nameSchema.optional() }),
  departmentAction.extend({ action: z.literal("rename_department"), name: nameSchema }),
  departmentAction.extend({ action: z.literal("delete_department") }),
  departmentAction.extend({ action: z.literal("add_category"), name: nameSchema.optional() }),
  categoryAction.extend({ action: z.literal("rename_category"), name: nameSchema }),
  categoryAction.extend({ action: z.literal("delete_category") }),
  categoryAction.extend({ action: z.literal("add_line_item"), name: nameSchema.optional() }),
  lineItemAction.extend({ action: z.literal("rename_line_item"), name: nameSchema }),
  lineItemAction.extend({ action: z.literal("delete_line_item") }),
  lineItemAction.extend({ action: z.literal("set_monthly_amount"), amountCents: centsSchema }),
]);

export type BusinessBudgetMutation = z.infer<typeof businessBudgetMutationSchema>;

export function lineItemMonthlyTotal(item: BudgetLineItem): number {
  return item.monthlyAmountCents;
}

export function categoryMonthlyTotal(category: BudgetCategory): number {
  return category.lineItems.reduce((sum, item) => sum + lineItemMonthlyTotal(item), 0);
}

export function departmentMonthlyTotal(department: BudgetDepartment): number {
  return department.categories.reduce((sum, category) => sum + categoryMonthlyTotal(category), 0);
}

export function budgetMonthlyTotal(departments: BudgetDepartment[]): number {
  return departments.reduce((sum, department) => sum + departmentMonthlyTotal(department), 0);
}
