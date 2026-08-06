import { randomBytes } from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { businessPlans, projects, vaults, type BusinessPlan, type BusinessPlanCreate, type BusinessPlanPatch } from "@shared/schema";
import { db } from "./db";
import { goalStorage } from "./goal-storage";
import { kpiStorage } from "./metrics-storage";
import { requireCurrentUserPrincipal } from "./principal-context";
import { assertWritable, combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "./scoped-storage";

const DEFAULT_THEMATIC_GOAL_ID = "80215d57";
const DEFAULT_INITIATIVE_PROJECT_IDS = [33, 50, 32, 42, 41];
const DEFAULT_PLAN_NAME = "Mantra Q3 2026";

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
      name text NOT NULL,
      thematic_goal_id text NOT NULL,
      initiative_project_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
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

async function defaultKpiIds(): Promise<string[]> {
  return (await kpiStorage.list())
    .filter((kpi) => kpi.status === "active" && kpi.standingObjectiveKey)
    .map((kpi) => kpi.id);
}

async function insertPlan(input: {
  name: string;
  vaultId: string;
  thematicGoalId: string;
  initiativeProjectIds: number[];
  kpiIds: string[];
}): Promise<BusinessPlan> {
  const principal = requireCurrentUserPrincipal();
  const now = new Date();
  const [created] = await db.insert(businessPlans).values({
    id: newId(),
    ...ownedInsertValues(principal, planScope),
    name: input.name,
    thematicGoalId: input.thematicGoalId,
    initiativeProjectIds: input.initiativeProjectIds,
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

    const vaultId = principal.activeVaultId ?? principal.visibleVaultIds[0];
    if (!vaultId) throw Object.assign(new Error("A visible Vault is required"), { status: 409 });
    await assertVault(vaultId);
    const visibleGoals = await goalStorage.listGoals({ includeDormant: true });
    const thematicGoalId = visibleGoals.some((goal) => goal.id === DEFAULT_THEMATIC_GOAL_ID)
      ? DEFAULT_THEMATIC_GOAL_ID
      : visibleGoals[0]?.id;
    if (!thematicGoalId) {
      throw Object.assign(new Error("Create a Goal before creating a Business Plan"), { status: 409 });
    }
    const visibleProjectIds = await db
      .select({ id: projects.id })
      .from(projects)
      .where(combineWithVisibleScope(principal, {
        scope: projects.scope,
        ownerUserId: projects.ownerUserId,
        accountId: projects.accountId,
        vaultId: projects.vaultId,
      }));
    const visibleProjectSet = new Set(visibleProjectIds.map((project) => project.id));
    const initiativeProjectIds = DEFAULT_INITIATIVE_PROJECT_IDS.filter((id) => visibleProjectSet.has(id));
    return [await insertPlan({
      name: DEFAULT_PLAN_NAME,
      vaultId,
      thematicGoalId,
      initiativeProjectIds,
      kpiIds: await defaultKpiIds(),
    })];
  },

  async create(input: BusinessPlanCreate): Promise<BusinessPlan> {
    const principal = requireCurrentUserPrincipal();
    const source = (await this.list())[0];
    const vaultId = input.vaultId ?? principal.activeVaultId ?? source.vaultId;
    const thematicGoalId = input.thematicGoalId ?? source.thematicGoalId;
    await assertVault(vaultId);
    await assertGoal(thematicGoalId);
    return insertPlan({
      name: input.name,
      vaultId,
      thematicGoalId,
      initiativeProjectIds: [...source.initiativeProjectIds],
      kpiIds: [...source.kpiIds],
    });
  },

  async update(id: string, patch: BusinessPlanPatch): Promise<BusinessPlan> {
    const principal = requireCurrentUserPrincipal();
    const [current] = await db.select().from(businessPlans)
      .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)))
      .limit(1);
    assertWritable(principal, current as unknown as Record<string, unknown> | undefined, "Business Plan");

    if (patch.vaultId) await assertVault(patch.vaultId);
    if (patch.thematicGoalId) await assertGoal(patch.thematicGoalId);
    if (patch.initiativeProjectIds) await assertProjects(patch.initiativeProjectIds);
    if (patch.kpiIds) await assertKpis(patch.kpiIds);

    const [updated] = await db.update(businessPlans).set({ ...patch, updatedAt: new Date() })
      .where(combineWithWritableScope(principal, planScope, eq(businessPlans.id, id)))
      .returning();
    return updated;
  },
};
