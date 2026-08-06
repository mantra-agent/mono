import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { vaults } from "./vaults";

export const businessPlans = pgTable(
  "business_plans",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    thematicGoalId: text("thematic_goal_id").notNull(),
    initiativeProjectIds: jsonb("initiative_project_ids").$type<number[]>().notNull().default([]),
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
  ],
);

export const businessPlanCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  vaultId: z.string().min(1).optional(),
  thematicGoalId: z.string().min(1).optional(),
});

export const businessPlanPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  vaultId: z.string().min(1).optional(),
  thematicGoalId: z.string().min(1).optional(),
  initiativeProjectIds: z.array(z.number().int().positive()).max(24).optional(),
  kpiIds: z.array(z.string().min(1)).max(24).optional(),
}).refine((patch) => Object.keys(patch).length > 0, "At least one change is required");

export type BusinessPlan = typeof businessPlans.$inferSelect;
export type BusinessPlanCreate = z.infer<typeof businessPlanCreateSchema>;
export type BusinessPlanPatch = z.infer<typeof businessPlanPatchSchema>;
