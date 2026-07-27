import { randomBytes } from "crypto";
import { asc, eq, ilike, or } from "drizzle-orm";
import { jobRoles } from "@shared/schema";
import {
  jobRoleCreateSchema,
  jobRoleUpdateSchema,
  normalizeJobRoleTitle,
  type JobRole,
  type JobRoleCreate,
  type JobRoleUpdate,
} from "@shared/models/job-roles";
import { db } from "./db";
import { getCurrentPrincipal } from "./principal-context";
import {
  assertVisible,
  assertWritable,
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "./scoped-storage";

const roleScope = {
  scope: jobRoles.scope,
  ownerUserId: jobRoles.ownerUserId,
  accountId: jobRoles.accountId,
};

function currentPrincipal() {
  const principal = getCurrentPrincipal();
  if (!principal?.userId || !principal.accountId) {
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  }
  return principal;
}

function newRoleId(): string {
  return randomBytes(8).toString("hex");
}

function mapRole(row: typeof jobRoles.$inferSelect): JobRole {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    team: row.team as JobRole["team"],
    annualSalaryMin: row.annualSalaryMin,
    annualSalaryMax: row.annualSalaryMax,
    targetBonusPercent: row.targetBonusPercent,
    equityShareCount: row.equityShareCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateRange(current: JobRole, patch: JobRoleUpdate): void {
  const min = patch.annualSalaryMin ?? current.annualSalaryMin;
  const max = patch.annualSalaryMax ?? current.annualSalaryMax;
  if (max < min) {
    throw Object.assign(new Error("Annual salary maximum must be greater than or equal to the minimum"), { status: 400 });
  }
}

export class JobRoleStorage {
  async list(options: { query?: string; limit?: number } = {}): Promise<JobRole[]> {
    const principal = currentPrincipal();
    const query = options.query?.trim();
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100)));
    const search = query
      ? or(ilike(jobRoles.title, `%${query}%`), ilike(jobRoles.description, `%${query}%`), ilike(jobRoles.team, `%${query}%`))
      : undefined;
    const rows = await db
      .select()
      .from(jobRoles)
      .where(combineWithVisibleScope(principal, roleScope, search))
      .orderBy(asc(jobRoles.team), asc(jobRoles.normalizedTitle))
      .limit(limit);
    return rows.map(mapRole);
  }

  async get(id: string): Promise<JobRole> {
    const principal = currentPrincipal();
    const [row] = await db
      .select()
      .from(jobRoles)
      .where(combineWithVisibleScope(principal, roleScope, eq(jobRoles.id, id)))
      .limit(1);
    return mapRole(assertVisible(principal, row, "Job role"));
  }

  async create(input: JobRoleCreate): Promise<JobRole> {
    const principal = currentPrincipal();
    const parsed = jobRoleCreateSchema.parse(input);
    const now = new Date();
    const [row] = await db
      .insert(jobRoles)
      .values({
        id: newRoleId(),
        ...ownedInsertValues(principal, roleScope),
        createdByUserId: principal.userId,
        title: parsed.title,
        normalizedTitle: normalizeJobRoleTitle(parsed.title),
        description: parsed.description,
        team: parsed.team,
        annualSalaryMin: parsed.annualSalaryMin,
        annualSalaryMax: parsed.annualSalaryMax,
        targetBonusPercent: parsed.targetBonusPercent,
        equityShareCount: parsed.equityShareCount,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return mapRole(assertWritable(principal, row, "Job role"));
  }

  async update(id: string, input: JobRoleUpdate): Promise<JobRole> {
    const principal = currentPrincipal();
    const parsed = jobRoleUpdateSchema.parse(input);
    const { clearFields, ...patch } = parsed;
    if (patch.description === "" && !clearFields?.includes("description")) delete patch.description;
    if (Object.keys(patch).length === 0 && !clearFields?.length) return this.get(id);
    const current = await this.get(id);
    validateRange(current, patch);
    const [row] = await db
      .update(jobRoles)
      .set({
        ...patch,
        ...(clearFields?.includes("description") ? { description: "" } : {}),
        ...(patch.title ? { normalizedTitle: normalizeJobRoleTitle(patch.title) } : {}),
        updatedAt: new Date(),
      })
      .where(combineWithWritableScope(principal, roleScope, eq(jobRoles.id, id)))
      .returning();
    return mapRole(assertWritable(principal, row, "Job role"));
  }

  async delete(id: string): Promise<JobRole> {
    const principal = currentPrincipal();
    const [row] = await db
      .delete(jobRoles)
      .where(combineWithWritableScope(principal, roleScope, eq(jobRoles.id, id)))
      .returning();
    return mapRole(assertWritable(principal, row, "Job role"));
  }
}

export const jobRoleStorage = new JobRoleStorage();
