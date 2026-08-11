import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { vaults } from "./vaults";
import { businesses } from "./businesses";

export const initiativeMeasurementBindingSchema = z.object({
  initiativeProjectId: z.number().int().positive(),
  leadingMetricId: z.string().trim().min(1).nullable(),
  laggingKpiId: z.string().trim().min(1).nullable(),
});

export type InitiativeMeasurementBinding = z.infer<typeof initiativeMeasurementBindingSchema>;

export const businessPlans = pgTable(
  "business_plans",
  {
    id: text("id").primaryKey(),
    businessId: text("business_id").references(() => businesses.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    // Null until the user assigns a thematic goal through the Business Plan UI.
    thematicGoalId: text("thematic_goal_id"),
    initiativeProjectIds: jsonb("initiative_project_ids").$type<number[]>().notNull().default([]),
    initiativeMeasurementBindings: jsonb("initiative_measurement_bindings")
      .$type<InitiativeMeasurementBinding[]>()
      .notNull()
      .default([]),
    /** @deprecated Compatibility projection for pre-measurement-binding clients. */
    kpiIds: jsonb("kpi_ids").$type<string[]>().notNull().default([]),
    vaultId: text("vault_id").notNull().references(() => vaults.id, { onDelete: "restrict" }),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_business_plans_owner").on(table.ownerUserId, table.accountId),
    index("idx_business_plans_vault").on(table.vaultId),
    index("idx_business_plans_business").on(table.businessId),
  ],
);

export const businessPlanCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  vaultId: z.string().min(1).optional(),
  // Optional; omitted/null means an empty plan with no assignments.
  thematicGoalId: z.string().min(1).nullable().optional(),
});

export const businessPlanPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  vaultId: z.string().min(1).optional(),
  // null clears the thematic goal; omit leaves it unchanged.
  thematicGoalId: z.string().min(1).nullable().optional(),
  initiativeProjectIds: z.array(z.number().int().positive()).max(24).optional(),
  initiativeMeasurementBindings: z.array(initiativeMeasurementBindingSchema).max(24).optional(),
  kpiIds: z.array(z.string().min(1)).max(24).optional(),
}).refine((patch) => Object.keys(patch).length > 0, "At least one change is required")
  .superRefine((patch, ctx) => {
    const bindings = patch.initiativeMeasurementBindings;
    if (!bindings) return;
    const projectIds = bindings.map((binding) => binding.initiativeProjectId);
    if (new Set(projectIds).size !== projectIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["initiativeMeasurementBindings"], message: "Each initiative may have only one measurement binding" });
    }
    if (patch.initiativeProjectIds) {
      const initiatives = new Set(patch.initiativeProjectIds);
      if (projectIds.some((projectId) => !initiatives.has(projectId))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["initiativeMeasurementBindings"], message: "Measurement bindings must belong to an initiative in this plan" });
      }
    }
  });

export type BusinessPlan = typeof businessPlans.$inferSelect;
export type BusinessPlanCreate = z.infer<typeof businessPlanCreateSchema>;
export type BusinessPlanPatch = z.infer<typeof businessPlanPatchSchema>;
