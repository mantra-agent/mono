import { randomBytes } from "crypto";
import { asc, count, eq, ilike, inArray, or } from "drizzle-orm";
import { businessHiringSlots, jobRoles, libraryPages } from "@shared/schema";
import {
  jobRoleCreateSchema,
  jobRoleUpdateSchema,
  normalizeJobRoleTitle,
  type JobRole,
  type JobRoleCreate,
  type JobRoleScorecardPage,
  type JobRoleUpdate,
} from "@shared/models/job-roles";
import { db } from "./db";
import { getCurrentPrincipal, requireCurrentPrincipal } from "./principal-context";
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

const libraryScopeColumns = {
  scope: libraryPages.scope,
  ownerUserId: libraryPages.ownerUserId,
  accountId: libraryPages.accountId,
  vaultId: libraryPages.vaultId,
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

function mapRole(row: typeof jobRoles.$inferSelect, scorecardPage: JobRoleScorecardPage | null = null): JobRole {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    team: row.team as JobRole["team"],
    annualSalaryMin: row.annualSalaryMin,
    annualSalaryMax: row.annualSalaryMax,
    targetBonusPercent: row.targetBonusPercent,
    equityShareCount: row.equityShareCount,
    scorecardPageId: row.scorecardPageId ?? null,
    scorecardPage,
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

/**
 * Resolve reference-picker page refs (slug or id) to canonical visible page IDs.
 * Soft-refs never grant visibility; missing pages fail closed on write.
 */
async function resolveVisiblePageId(ref: string): Promise<string> {
  const principal = requireCurrentPrincipal();
  const needle = ref.trim();
  if (!needle) {
    throw Object.assign(new Error("Scorecard page is required"), { status: 400 });
  }
  const [row] = await db
    .select({ id: libraryPages.id })
    .from(libraryPages)
    .where(
      combineWithVisibleScope(
        principal,
        libraryScopeColumns,
        or(eq(libraryPages.id, needle), eq(libraryPages.slug, needle)),
      ),
    )
    .limit(1);
  if (!row) {
    throw Object.assign(new Error("Scorecard page not found"), { status: 400 });
  }
  return row.id;
}

async function loadScorecardPages(pageIds: Array<string | null | undefined>): Promise<Map<string, JobRoleScorecardPage>> {
  const ids = [...new Set(pageIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const principal = requireCurrentPrincipal();
  const rows = await db
    .select({ id: libraryPages.id, title: libraryPages.title, slug: libraryPages.slug })
    .from(libraryPages)
    .where(combineWithVisibleScope(principal, libraryScopeColumns, inArray(libraryPages.id, ids)));
  return new Map(rows.map((row) => [row.id, row]));
}

function withScorecard(
  row: typeof jobRoles.$inferSelect,
  pages: Map<string, JobRoleScorecardPage>,
): JobRole {
  const pageId = row.scorecardPageId ?? null;
  return mapRole(row, pageId ? pages.get(pageId) ?? null : null);
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
    const pages = await loadScorecardPages(rows.map((row) => row.scorecardPageId));
    return rows.map((row) => withScorecard(row, pages));
  }

  async get(id: string): Promise<JobRole> {
    const principal = currentPrincipal();
    const [row] = await db
      .select()
      .from(jobRoles)
      .where(combineWithVisibleScope(principal, roleScope, eq(jobRoles.id, id)))
      .limit(1);
    const visible = assertVisible(principal, row, "Job role");
    const pages = await loadScorecardPages([visible.scorecardPageId]);
    return withScorecard(visible, pages);
  }

  async create(input: JobRoleCreate): Promise<JobRole> {
    const principal = currentPrincipal();
    const parsed = jobRoleCreateSchema.parse(input);
    const scorecardPageId =
      parsed.scorecardPageId === undefined || parsed.scorecardPageId === null
        ? null
        : await resolveVisiblePageId(parsed.scorecardPageId);
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
        scorecardPageId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const writable = assertWritable(principal, row, "Job role");
    const pages = await loadScorecardPages([writable.scorecardPageId]);
    return withScorecard(writable, pages);
  }

  async update(id: string, input: JobRoleUpdate): Promise<JobRole> {
    const principal = currentPrincipal();
    const parsed = jobRoleUpdateSchema.parse(input);
    const { clearFields, ...patch } = parsed;
    if (patch.description === "" && !clearFields?.includes("description")) delete patch.description;
    if (patch.scorecardPageId === "" && !clearFields?.includes("scorecardPageId")) delete patch.scorecardPageId;

    const next: Record<string, unknown> = { ...patch };
    if (clearFields?.includes("description")) next.description = "";
    if (clearFields?.includes("scorecardPageId") || patch.scorecardPageId === null) {
      next.scorecardPageId = null;
    } else if (typeof patch.scorecardPageId === "string") {
      next.scorecardPageId = await resolveVisiblePageId(patch.scorecardPageId);
    }

    if (Object.keys(next).length === 0) return this.get(id);
    const current = await this.get(id);
    validateRange(current, patch);
    const [row] = await db
      .update(jobRoles)
      .set({
        ...next,
        ...(patch.title ? { normalizedTitle: normalizeJobRoleTitle(patch.title) } : {}),
        updatedAt: new Date(),
      })
      .where(combineWithWritableScope(principal, roleScope, eq(jobRoles.id, id)))
      .returning();
    const writable = assertWritable(principal, row, "Job role");
    const pages = await loadScorecardPages([writable.scorecardPageId]);
    return withScorecard(writable, pages);
  }

  async delete(id: string): Promise<JobRole> {
    const principal = currentPrincipal();
    // Resolve visibility first so missing/foreign roles stay 404, not dependency 409.
    await this.get(id);

    const [usage] = await db
      .select({ total: count() })
      .from(businessHiringSlots)
      .where(eq(businessHiringSlots.roleId, id));
    const slotCount = Number(usage?.total ?? 0);
    if (slotCount > 0) {
      throw Object.assign(
        new Error(
          slotCount === 1
            ? "Cannot delete job role while 1 hiring slot still references it"
            : `Cannot delete job role while ${slotCount} hiring slots still reference it`,
        ),
        { status: 409, code: "JOB_ROLE_IN_USE", slotCount },
      );
    }

    try {
      const [row] = await db
        .delete(jobRoles)
        .where(combineWithWritableScope(principal, roleScope, eq(jobRoles.id, id)))
        .returning();
      return mapRole(assertWritable(principal, row, "Job role"), null);
    } catch (error) {
      // Race: a hiring slot can land between the count and DELETE (RESTRICT FK).
      const code = (error as { code?: string })?.code;
      if (code === "23503") {
        throw Object.assign(
          new Error("Cannot delete job role while hiring slots still reference it"),
          { status: 409, code: "JOB_ROLE_IN_USE", cause: error },
        );
      }
      throw error;
    }
  }
}

export const jobRoleStorage = new JobRoleStorage();
