import { db, pool } from "./db";
import { eq, desc, asc, and, inArray } from "drizzle-orm";
import {
  execSkills,
  execExperience,
  execPassions,
  execMetrics,
  execEducation,
  experienceSkills,
  type ExecSkill,
  type InsertExecSkill,
  type ExecExperience,
  type InsertExecExperience,
  type ExecPassion,
  type InsertExecPassion,
  type ExecMetric,
  type InsertExecMetric,
  type ExecEducationRow,
  type InsertExecEducation,
  type ExperienceWithSkills,
} from "@shared/schema";
import { createLogger } from "./log";

const log = createLogger("ExecStorage");

let schemaMigrated = false;

async function autoHeal<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    if ((code === "42703" || code === "42P01") && !schemaMigrated) {
      log.debug(`auto-heal: migrating schema after column/relation error (${message})`);
      await migrateExecSchema();
      schemaMigrated = true;
      try {
        return await operation();
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log.warn(`auto-heal: retry failed after migration (${retryMsg})`);
        throw retryErr;
      }
    }
    throw err;
  }
}

export async function migrateExecSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS exec_skills (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT,
        skill_type TEXT DEFAULT 'applied',
        proficiency TEXT,
        energy_level TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- Auto-heal: add columns if table already exists without them
      ALTER TABLE exec_skills ADD COLUMN IF NOT EXISTS skill_type TEXT DEFAULT 'applied';
      ALTER TABLE exec_skills ALTER COLUMN skill_type SET DEFAULT 'applied';

      -- Migrate old skill_type values to new taxonomy
      UPDATE exec_skills SET skill_type = 'applied' WHERE skill_type = 'marketable';
      UPDATE exec_skills SET skill_type = 'foundational' WHERE skill_type = 'cognitive_asset';
      UPDATE exec_skills SET skill_type = 'tool' WHERE skill_type = 'tool_proficiency';

      -- Migrate old proficiency values
      UPDATE exec_skills SET proficiency = 'expert' WHERE proficiency = 'master';

      -- Default null skill_type to 'applied' so UI matches DB
      UPDATE exec_skills SET skill_type = 'applied' WHERE skill_type IS NULL;

      CREATE TABLE IF NOT EXISTS exec_experience (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        narrative TEXT,
        years INTEGER,
        key_outcomes TEXT[] NOT NULL DEFAULT '{}'::text[],
        transferable_assets TEXT[] NOT NULL DEFAULT '{}'::text[],
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- Experience date range and company fields
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS start_date TEXT;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS end_date TEXT;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS company TEXT;

      -- Experience scope fields (Opportunity Artifact System)
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS title TEXT;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS location TEXT;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS team_size_peak INTEGER;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS direct_reports INTEGER;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS pnl_owned TEXT;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS budget_managed TEXT;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS funding_raised TEXT;
      ALTER TABLE exec_experience ADD COLUMN IF NOT EXISTS company_context TEXT;

      -- Backfill: legacy rows used domain as the role title
      UPDATE exec_experience SET title = domain WHERE title IS NULL;

      CREATE TABLE IF NOT EXISTS exec_metrics (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'default',
        experience_id INTEGER,
        metric TEXT NOT NULL,
        value TEXT NOT NULL,
        context TEXT,
        verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS exec_education (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'default',
        institution TEXT NOT NULL,
        degree TEXT,
        field TEXT,
        year TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS experience_skills (
        id SERIAL PRIMARY KEY,
        experience_id INTEGER NOT NULL REFERENCES exec_experience(id) ON DELETE CASCADE,
        skill_id INTEGER NOT NULL REFERENCES exec_skills(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_experience_skill UNIQUE(experience_id, skill_id)
      );

      CREATE TABLE IF NOT EXISTS exec_passions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'default',
        tier TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_ref TEXT,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    log.debug("schema migration complete");
  } finally {
    client.release();
  }
}

// ── Skills CRUD ────────────────────────────────────────────────────
class ExecSkillStorage {
  async list(userId: string): Promise<ExecSkill[]> {
    return autoHeal(async () => {
      const rows = await db.select().from(execSkills)
        .where(eq(execSkills.userId, userId))
        .orderBy(desc(execSkills.updatedAt));
      return rows;
    });
  }

  async get(id: number): Promise<ExecSkill | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(execSkills).where(eq(execSkills.id, id));
      return row;
    });
  }

  async create(userId: string, data: InsertExecSkill): Promise<ExecSkill> {
    return autoHeal(async () => {
      const [row] = await db.insert(execSkills).values({ ...data, userId }).returning();
      log.debug(`create skill id=${row.id} name="${row.name}"`);
      return row;
    });
  }

  async update(id: number, updates: Partial<InsertExecSkill>): Promise<ExecSkill | undefined> {
    return autoHeal(async () => {
      const patch: Record<string, unknown> = { ...updates, updatedAt: new Date() };
      const [row] = await db.update(execSkills).set(patch).where(eq(execSkills.id, id)).returning();
      log.debug(`update skill id=${id} found=${!!row}`);
      return row;
    });
  }

  async delete(id: number): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(execSkills).where(eq(execSkills.id, id)).returning();
      log.debug(`delete skill id=${id} found=${!!row}`);
      return !!row;
    });
  }
}

// ── Experience CRUD ────────────────────────────────────────────────
class ExecExperienceStorage {
  async list(userId: string): Promise<ExecExperience[]> {
    return autoHeal(async () => {
      const rows = await db.select().from(execExperience)
        .where(eq(execExperience.userId, userId))
        .orderBy(desc(execExperience.startDate));
      return rows;
    });
  }

  async get(id: number): Promise<ExecExperience | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(execExperience).where(eq(execExperience.id, id));
      return row;
    });
  }

  async create(userId: string, data: InsertExecExperience): Promise<ExecExperience> {
    return autoHeal(async () => {
      const [row] = await db.insert(execExperience).values({ ...data, userId }).returning();
      log.debug(`create experience id=${row.id} domain="${row.domain}"`);
      return row;
    });
  }

  async update(id: number, updates: Partial<InsertExecExperience>): Promise<ExecExperience | undefined> {
    return autoHeal(async () => {
      const patch: Record<string, unknown> = { ...updates, updatedAt: new Date() };
      const [row] = await db.update(execExperience).set(patch).where(eq(execExperience.id, id)).returning();
      log.debug(`update experience id=${id} found=${!!row}`);
      return row;
    });
  }

  async delete(id: number): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(execExperience).where(eq(execExperience.id, id)).returning();
      log.debug(`delete experience id=${id} found=${!!row}`);
      return !!row;
    });
  }

  // ── Skill Linking ──────────────────────────────────────────────

  async linkSkill(experienceId: number, skillId: number): Promise<void> {
    return autoHeal(async () => {
      await db.insert(experienceSkills).values({ experienceId, skillId })
        .onConflictDoNothing();
      log.debug(`linked skill ${skillId} to experience ${experienceId}`);
    });
  }

  async unlinkSkill(experienceId: number, skillId: number): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(experienceSkills).where(
        and(
          eq(experienceSkills.experienceId, experienceId),
          eq(experienceSkills.skillId, skillId),
        ),
      ).returning();
      log.debug(`unlinked skill ${skillId} from experience ${experienceId} found=${!!row}`);
      return !!row;
    });
  }

  async getSkillsForExperience(experienceId: number): Promise<Array<{
    id: number; name: string; category: string | null;
    skillType: string | null; proficiency: string | null; energyLevel: string | null;
  }>> {
    return autoHeal(async () => {
      const rows = await db.select({
        id: execSkills.id,
        name: execSkills.name,
        category: execSkills.category,
        skillType: execSkills.skillType,
        proficiency: execSkills.proficiency,
        energyLevel: execSkills.energyLevel,
      })
        .from(experienceSkills)
        .innerJoin(execSkills, eq(experienceSkills.skillId, execSkills.id))
        .where(eq(experienceSkills.experienceId, experienceId));
      return rows;
    });
  }

  async getExperienceForSkill(skillId: number): Promise<ExecExperience[]> {
    return autoHeal(async () => {
      const rows = await db.select({ experience: execExperience })
        .from(experienceSkills)
        .innerJoin(execExperience, eq(experienceSkills.experienceId, execExperience.id))
        .where(eq(experienceSkills.skillId, skillId));
      return rows.map(r => r.experience);
    });
  }

  /** List with linked skills eagerly loaded */
  async listWithSkills(userId: string): Promise<ExperienceWithSkills[]> {
    return autoHeal(async () => {
      const exps = await this.list(userId);
      if (exps.length === 0) return [];

      const expIds = exps.map(e => e.id);
      const allLinks = await db.select({
        experienceId: experienceSkills.experienceId,
        id: execSkills.id,
        name: execSkills.name,
        category: execSkills.category,
        skillType: execSkills.skillType,
        proficiency: execSkills.proficiency,
        energyLevel: execSkills.energyLevel,
      })
        .from(experienceSkills)
        .innerJoin(execSkills, eq(experienceSkills.skillId, execSkills.id))
        .where(inArray(experienceSkills.experienceId, expIds));

      const byExp = new Map<number, ExperienceWithSkills["linkedSkills"]>();
      for (const link of allLinks) {
        const arr = byExp.get(link.experienceId) || [];
        arr.push({
          id: link.id,
          name: link.name,
          category: link.category,
          skillType: link.skillType,
          proficiency: link.proficiency,
          energyLevel: link.energyLevel,
        });
        byExp.set(link.experienceId, arr);
      }

      return exps.map(e => ({
        ...e,
        linkedSkills: byExp.get(e.id) || [],
      }));
    });
  }

  /** Get single with linked skills */
  async getWithSkills(id: number): Promise<ExperienceWithSkills | undefined> {
    return autoHeal(async () => {
      const exp = await this.get(id);
      if (!exp) return undefined;
      const linkedSkills = await this.getSkillsForExperience(id);
      return { ...exp, linkedSkills };
    });
  }
}

// ── Passions CRUD ──────────────────────────────────────────────────
class ExecPassionStorage {
  async list(userId: string): Promise<ExecPassion[]> {
    return autoHeal(async () => {
      const rows = await db.select().from(execPassions)
        .where(eq(execPassions.userId, userId))
        .orderBy(asc(execPassions.tier), asc(execPassions.position));
      return rows;
    });
  }

  async get(id: number): Promise<ExecPassion | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(execPassions).where(eq(execPassions.id, id));
      return row;
    });
  }

  async create(userId: string, data: InsertExecPassion): Promise<ExecPassion> {
    return autoHeal(async () => {
      const [row] = await db.insert(execPassions).values({ ...data, userId }).returning();
      log.debug(`create passion id=${row.id} title="${row.title}" tier=${row.tier}`);
      return row;
    });
  }

  async update(id: number, updates: Partial<InsertExecPassion>): Promise<ExecPassion | undefined> {
    return autoHeal(async () => {
      const patch: Record<string, unknown> = { ...updates, updatedAt: new Date() };
      const [row] = await db.update(execPassions).set(patch).where(eq(execPassions.id, id)).returning();
      log.debug(`update passion id=${id} found=${!!row}`);
      return row;
    });
  }

  async delete(id: number): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(execPassions).where(eq(execPassions.id, id)).returning();
      log.debug(`delete passion id=${id} found=${!!row}`);
      return !!row;
    });
  }
}

// ── Metrics CRUD ───────────────────────────────────────────────────
class ExecMetricsStorage {
  async list(userId: string, experienceId?: number): Promise<ExecMetric[]> {
    return autoHeal(async () => {
      const conditions = [eq(execMetrics.userId, userId)];
      if (experienceId !== undefined) conditions.push(eq(execMetrics.experienceId, experienceId));
      const rows = await db.select().from(execMetrics)
        .where(and(...conditions))
        .orderBy(desc(execMetrics.updatedAt));
      return rows;
    });
  }

  async get(id: number): Promise<ExecMetric | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(execMetrics).where(eq(execMetrics.id, id));
      return row;
    });
  }

  async create(userId: string, data: InsertExecMetric): Promise<ExecMetric> {
    return autoHeal(async () => {
      const [row] = await db.insert(execMetrics).values({ ...data, userId }).returning();
      log.debug(`create metric id=${row.id} metric="${row.metric}"`);
      return row;
    });
  }

  async update(id: number, updates: Partial<InsertExecMetric>): Promise<ExecMetric | undefined> {
    return autoHeal(async () => {
      const patch: Record<string, unknown> = { ...updates, updatedAt: new Date() };
      const [row] = await db.update(execMetrics).set(patch).where(eq(execMetrics.id, id)).returning();
      log.debug(`update metric id=${id} found=${!!row}`);
      return row;
    });
  }

  async delete(id: number): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(execMetrics).where(eq(execMetrics.id, id)).returning();
      log.debug(`delete metric id=${id} found=${!!row}`);
      return !!row;
    });
  }
}

// ── Education CRUD ─────────────────────────────────────────────────
class ExecEducationStorage {
  async list(userId: string): Promise<ExecEducationRow[]> {
    return autoHeal(async () => {
      const rows = await db.select().from(execEducation)
        .where(eq(execEducation.userId, userId))
        .orderBy(desc(execEducation.year));
      return rows;
    });
  }

  async get(id: number): Promise<ExecEducationRow | undefined> {
    return autoHeal(async () => {
      const [row] = await db.select().from(execEducation).where(eq(execEducation.id, id));
      return row;
    });
  }

  async create(userId: string, data: InsertExecEducation): Promise<ExecEducationRow> {
    return autoHeal(async () => {
      const [row] = await db.insert(execEducation).values({ ...data, userId }).returning();
      log.debug(`create education id=${row.id} institution="${row.institution}"`);
      return row;
    });
  }

  async update(id: number, updates: Partial<InsertExecEducation>): Promise<ExecEducationRow | undefined> {
    return autoHeal(async () => {
      const patch: Record<string, unknown> = { ...updates, updatedAt: new Date() };
      const [row] = await db.update(execEducation).set(patch).where(eq(execEducation.id, id)).returning();
      log.debug(`update education id=${id} found=${!!row}`);
      return row;
    });
  }

  async delete(id: number): Promise<boolean> {
    return autoHeal(async () => {
      const [row] = await db.delete(execEducation).where(eq(execEducation.id, id)).returning();
      log.debug(`delete education id=${id} found=${!!row}`);
      return !!row;
    });
  }
}

export const execSkillStorage = new ExecSkillStorage();
export const execExperienceStorage = new ExecExperienceStorage();
export const execPassionStorage = new ExecPassionStorage();
export const execMetricsStorage = new ExecMetricsStorage();
export const execEducationStorage = new ExecEducationStorage();
