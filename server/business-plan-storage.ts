import { randomBytes } from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { businessPlans, projects, vaults, type BusinessPlan, type BusinessPlanCreate, type BusinessPlanPatch, type InitiativeMeasurementBinding } from "@shared/schema";
import { db } from "./db";
import { goalStorage } from "./goal-storage";
import { kpiStorage, metricsStorage } from "./metrics/core-engine";
import { requireCurrentUserPrincipal } from "./principal-context";
import { assertWritable, combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const DEFAULT_PLAN_NAME = "Business Plan";

const planScope = {
  scope: businessPlans.scope,
  ownerUserId: businessPlans.ownerUserId,
  accountId: businessPlans.accountId,
  vaultId: businessPlans.vaultId,
};

function newId(): string {
  return randomBytes(12).toString("hex");
}

export async function ensureBusinessPlansSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS business_plans (
      id text PRIMARY KEY,
      business_id text REFERENCES businesses(id) ON DELETE RESTRICT,
      name text NOT NULL,
      thematic_goal_id text,
      initiative_project_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      initiative_measurement_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
      kpi_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      vault_id text NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
      scope text NOT NULL DEFAULT 'user',
      owner_user_id text NOT NULL,
      account_id text NOT NULL,
      created_by_user_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Existing installs created thematic_goal_id as NOT NULL during bootstrap.
  // Drop that constraint so plans can exist with no assigned goal until the user picks one.
  await db.execute(sql`ALTER TABLE business_plans ALTER COLUMN thematic_goal_id DROP NOT NULL`);
  await db.execute(sql`ALTER TABLE business_plans ADD COLUMN IF NOT EXISTS initiative_measurement_bindings jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await db.execute(sql`ALTER TABLE business_plans ADD COLUMN IF NOT EXISTS business_id text REFERENCES businesses(id) ON DELETE RESTRICT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_business_plans_business ON business_plans(business_id)`);
  await db.execute(sql`
    UPDATE business_plans bp SET business_id = b.id
    FROM businesses b
    WHERE bp.business_id IS NULL
      AND bp.account_id = b.account_id
      AND b.is_platform_instrument = true
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_business_plans_owner ON business_plans(owner_user_id, account_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_business_plans_vault ON business_plans(vault_id)`);
}

async function assertVault(vaultId: string): Promise<void> {
  const principal = requireCurrentUserPrincipal();
  const [vault] = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(
      eq(vaults.id, vaultId),
      eq(vaults.accountId, principal.accountId),
      eq(vaults.isArchived, false),
    ))
    .limit(1);
  if (!vault || !principal.visibleVaultIds.includes(vault.id)) {
    throw Object.assign(new Error("Vault not found or not visible"), { status: 404 });
  }
}

async function assertGoal(goalId: string): Promise<void> {
  if (!(await goalStorage.getGoal(goalId))) {
    throw Object.assign(new Error("Goal not found or not visible"), { status: 404 });
  }
}

async function assertProjects(projectIds: number[]): Promise<void> {
  if (projectIds.length === 0) return;
  const principal = requireCurrentUserPrincipal();
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(combineWithVisibleScope(principal, {
      scope: projects.scope,
      ownerUserId: projects.ownerUserId,
      accountId: projects.accountId,
      vaultId: projects.vaultId,
    }, inArray(projects.id, projectIds)));
  if (new Set(rows.map((row) => row.id)).size !== new Set(projectIds).size) {
    throw Object.assign(new Error("One or more projects were not found or visible"), { status: 404 });
  }
}

async function assertKpis(kpiIds: string[]): Promise<void> {
  for (const id of kpiIds) await kpiStorage.get(id);
}

async function assertMetrics(metricIds: string[]): Promise<void> {
  for (const id of metricIds) await metricsStorage.get(id);
}

async function assertMeasurementBindings(bindings: InitiativeMeasurementBinding[], initiativeProjectIds: number[]): Promise<void> {
  const initiativeIds = new Set(initiativeProjectIds);
  if (bindings.some((binding) => !initiativeIds.has(binding.initiativeProjectId))) {
    throw Object.assign(new Error("Measurement bindings must belong to an initiative in this plan"), { status: 400 });
  }
  if (new Set(bindings.map((binding) => binding.initiativeProjectId)).size !== bindings.length) {
    throw Object.assign(new Error("Each initiative may have only one measurement binding"), { status: 400 });
  }
  await assertMetrics(bindings.flatMap((binding) => binding.leadingMetricId ? [binding.leadingMetricId] : []));
  await assertKpis(bindings.flatMap((binding) => binding.laggingKpiId ? [binding.laggingKpiId] : []));
}

async function insertPlan(input: {
  businessId?: string;
  name: string;
  vaultId: string;
  thematicGoalId: string | null;
  initiativeProjectIds: number[];
  initiativeMeasurementBindings: InitiativeMeasurementBinding[];
  kpiIds: string[];
}): Promise<BusinessPlan> {
  const principal = requireCurrentUserPrincipal();
  const now = new Date();
  const [created] = await db.insert(businessPlans).values({
    id: newId(),
    ...ownedInsertValues(principal, planScope),
    businessId: input.businessId ?? null,
    name: input.name,
    thematicGoalId: input.thematicGoalId,
    initiativeProjectIds: input.initiativeProjectIds,
    initiativeMeasurementBindings: input.initiativeMeasurementBindings,
    kpiIds: input.kpiIds,
    vaultId: input.vaultId,
    createdByUserId: principal.userId,
    createdAt: now,
    updatedAt: now,
  }).returning();
  return created;
}

export const businessPlanStorage = {
  async list(): Promise<BusinessPlan[]> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db.select().from(businessPlans)
      .where(combineWithVisibleScope(principal, planScope))
      .orderBy(asc(businessPlans.createdAt));
    if (rows.length > 0) return rows;

    // First-open bootstrap: empty named shell only. Never auto-assign goals/initiatives/KPIs.
    const vaultId = principal.activeVaultId ?? principal.visibleVaultIds[0];
    if (!vaultId) throw Object.assign(new Error("A visible Vault is required"), { status: 409 });
    await assertVault(vaultId);
    return [await insertPlan({
      name: DEFAULT_PLAN_NAME,
      vaultId,
      thematicGoalId: null,
      initiativeProjectIds: [],
      initiativeMeasurementBindings: [],
      kpiIds: [],
    })];
  },

  async get(id: string): Promise<BusinessPlan | null> {
    const principal = requireCurrentUserPrincipal();
    const [row] = await db.select().from(businessPlans)
      .where(combineWithVisibleScope(principal, planScope, eq(businessPlans.id, id)))
      .limit(1);
    return row ?? null;
  },

  async create(input: BusinessPlanCreate): Promise<BusinessPlan> {
    const principal = requireCurrentUserPrincipal();
    const vaultId = input.vaultId ?? principal.activeVaultId ?? principal.visibleVaultIds[0];
    if (!vaultId) throw Object.assign(new Error("A visible Vault is required"), { status: 409 });
    await assertVault(vaultId);

    // Explicit null/omitted thematic goal stays empty. Never clone prior plan assignments.
    const thematicGoalId = input.thematicGoalId ?? null;
    if (thematicGoalId) await assertGoal(thematicGoalId);

    return insertPlan({
      businessId: input.businessId,
      name: input.name,
      vaultId,
      thematicGoalId,
      initiativeProjectIds: [],
      initiativeMeasurementBindings: [],
      kpiIds: [],
    });
  },

  async update(id: string, patch: BusinessPlanPatch): Promise<BusinessPlan> {
    const principal = requireCurrentUserPrincipal();
    const [current] = await db.select().from(businessPlans)
      .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)))
      .limit(1);
    assertWritable(principal, current as unknown as Record<string, unknown> | undefined, "Business Plan");

    if (patch.vaultId) await assertVault(patch.vaultId);
    if (typeof patch.thematicGoalId === "string") await assertGoal(patch.thematicGoalId);
    if (patch.initiativeProjectIds) await assertProjects(patch.initiativeProjectIds);
    const nextInitiativeIds = patch.initiativeProjectIds ?? current.initiativeProjectIds;
    const nextBindings = patch.initiativeMeasurementBindings ?? current.initiativeMeasurementBindings;
    await assertMeasurementBindings(nextBindings, nextInitiativeIds);
    if (patch.kpiIds) await assertKpis(patch.kpiIds);

    const [updated] = await db.update(businessPlans).set({ ...patch, updatedAt: new Date() })
      .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)))
      .returning();
    return updated;
  },

  async remove(id: string): Promise<void> {
    const principal = requireCurrentUserPrincipal();
    const [current] = await db.select().from(businessPlans)
      .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)))
      .limit(1);
    assertWritable(principal, current as unknown as Record<string, unknown> | undefined, "Business Plan");
    await db.delete(businessPlans)
      .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)));
  },

  async mutateInitiative(id: string, projectId: number, operation: "add" | "remove"): Promise<BusinessPlan> {
    const principal = requireCurrentUserPrincipal();
    if (operation === "add") await assertProjects([projectId]);
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(businessPlans)
        .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)))
        .limit(1).for("update");
      assertWritable(principal, current as unknown as Record<string, unknown> | undefined, "Business Plan");
      const ids = current.initiativeProjectIds;
      const next = operation === "add" ? (ids.includes(projectId) ? ids : [...ids, projectId]) : ids.filter((candidate) => candidate !== projectId);
      if (next.length === ids.length && next.every((candidate, index) => candidate === ids[index])) return current;
      const initiativeMeasurementBindings = current.initiativeMeasurementBindings.filter((binding) => next.includes(binding.initiativeProjectId));
      const [updated] = await tx.update(businessPlans).set({ initiativeProjectIds: next, initiativeMeasurementBindings, updatedAt: new Date() })
        .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id))).returning();
      return updated;
    });
  },

  async setInitiativeMeasurement(id: string, projectId: number, kind: "leading" | "lagging", measurementId: string | null): Promise<BusinessPlan> {
    const principal = requireCurrentUserPrincipal();
    if (measurementId) {
      if (kind === "leading") await assertMetrics([measurementId]);
      else await assertKpis([measurementId]);
    }
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(businessPlans)
        .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)))
        .limit(1).for("update");
      assertWritable(principal, current as unknown as Record<string, unknown> | undefined, "Business Plan");
      if (!current.initiativeProjectIds.includes(projectId)) {
        throw Object.assign(new Error("Initiative not found in this Business Plan"), { status: 404 });
      }
      const existing = current.initiativeMeasurementBindings.find((binding) => binding.initiativeProjectId === projectId) ?? {
        initiativeProjectId: projectId,
        leadingMetricId: null,
        laggingKpiId: null,
      };
      const replacement = kind === "leading" ? { ...existing, leadingMetricId: measurementId } : { ...existing, laggingKpiId: measurementId };
      const next = current.initiativeMeasurementBindings.filter((binding) => binding.initiativeProjectId !== projectId);
      if (replacement.leadingMetricId || replacement.laggingKpiId) next.push(replacement);
      if (JSON.stringify(next) === JSON.stringify(current.initiativeMeasurementBindings)) return current;
      const [updated] = await tx.update(businessPlans).set({ initiativeMeasurementBindings: next, updatedAt: new Date() })
        .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id))).returning();
      return updated;
    });
  },

  async mutateKpi(id: string, kpiId: string, operation: "add" | "remove"): Promise<BusinessPlan> {
    const principal = requireCurrentUserPrincipal();
    if (operation === "add") await assertKpis([kpiId]);
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(businessPlans)
        .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)))
        .limit(1).for("update");
      assertWritable(principal, current as unknown as Record<string, unknown> | undefined, "Business Plan");
      const ids = current.kpiIds;
      const next = operation === "add" ? (ids.includes(kpiId) ? ids : [...ids, kpiId]) : ids.filter((candidate) => candidate !== kpiId);
      if (next.length === ids.length && next.every((candidate, index) => candidate === ids[index])) return current;
      const [updated] = await tx.update(businessPlans).set({ kpiIds: next, updatedAt: new Date() })
        .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id))).returning();
      return updated;
    });
  },
};
