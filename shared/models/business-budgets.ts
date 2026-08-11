import { z } from "zod";

export const BUDGET_MONTH_COUNT = 12;
export const BUDGET_MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const nameSchema = z.string().trim().min(1).max(120);
const idSchema = z.string().trim().min(1).max(120);
const centsSchema = z.number().int().min(0).max(1_000_000_000_00);
const monthlyAmountsSchema = z.array(centsSchema).length(BUDGET_MONTH_COUNT);

export const budgetLineItemSchema = z.object({
  id: idSchema,
  name: nameSchema,
  monthlyAmountsCents: monthlyAmountsSchema,
});

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
  year: z.number().int().min(2000).max(2200),
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
  lineItemAction.extend({
    action: z.literal("set_month_amount"),
    monthIndex: z.number().int().min(0).max(BUDGET_MONTH_COUNT - 1),
    amountCents: centsSchema,
  }),
]);

export type BusinessBudgetMutation = z.infer<typeof businessBudgetMutationSchema>;

export function emptyMonthlyAmounts(): number[] {
  return Array.from({ length: BUDGET_MONTH_COUNT }, () => 0);
}

export function lineItemAnnualTotal(item: BudgetLineItem): number {
  return item.monthlyAmountsCents.reduce((sum, amount) => sum + amount, 0);
}

export function categoryAnnualTotal(category: BudgetCategory): number {
  return category.lineItems.reduce((sum, item) => sum + lineItemAnnualTotal(item), 0);
}

export function departmentAnnualTotal(department: BudgetDepartment): number {
  return department.categories.reduce((sum, category) => sum + categoryAnnualTotal(category), 0);
}

export function budgetMonthlyTotals(departments: BudgetDepartment[]): number[] {
  const totals = emptyMonthlyAmounts();
  for (const department of departments) {
    for (const category of department.categories) {
      for (const item of category.lineItems) {
        item.monthlyAmountsCents.forEach((amount, index) => { totals[index] += amount; });
      }
    }
  }
  return totals;
}
