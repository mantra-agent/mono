import { db } from "../db";
import { projects } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import type {
  Project, InsertProject, ActivityEntry, Milestone, ProjectNote, ProjectFile, ProjectPage,
  ProjectStatus, PriorityLevel,
} from "@shared/models/work";
import { createLogger } from "../log";
import { TTLCache } from "../utils/ttl-cache";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { eventBus } from "../event-bus";

const log = createLogger("StoreProjects");

const projectScopeColumns = { scope: projects.scope, ownerUserId: projects.ownerUserId, accountId: projects.accountId };

function principalCacheKey(): string {
  const principal = getCurrentPrincipalOrSystem();
  return `${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
}

function getNextMilestoneId(existing: Milestone[]): number {
  if (existing.length === 0) return 1;
  return Math.max(...existing.map(m => m.id)) + 1;
}

/** Convert a DB row to the Project model shape */
function rowToProject(row: typeof projects.$inferSelect): Project {
  // Normalize legacy "planned" status to "planning"
  let status = row.status as ProjectStatus;
  if (status === ("planned" as ProjectStatus)) status = "planning";

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status,
    priority: row.priority as PriorityLevel,
    owner: row.owner as Project["owner"],
    requiresReview: row.requiresReview,
    dueDate: row.dueDate || null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    spec: row.spec,
    goalId: row.goalId || null,
    milestones: (row.milestones as Milestone[]) || [],
    tags: (row.tags as string[]) || [],
    people: (row.people as string[]) || [],
    notes: (row.notes as ProjectNote[]) || [],
    files: (row.files as ProjectFile[]) || [],
    pages: (row.pages as ProjectPage[]) || [],
    activity: (row.activity as ActivityEntry[]) || [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class FileProjectStorage {
  private readonly _projectsCache = new TTLCache<Project[]>("Projects", Infinity);
  private readonly _singleProjectCache = new TTLCache<Project | undefined>("SingleProject", Infinity);

  private invalidateCache(): void {
    this._projectsCache.invalidateAll();
    this._singleProjectCache.invalidateAll();
    eventBus.publish({ category: "system", event: "data:projects_changed", payload: { source: "project_storage" } });
  }

  async getProjects(options?: { status?: string }): Promise<Project[]> {
    const cacheKey = `projects:${principalCacheKey()}:${options?.status || "all"}`;
    return this._projectsCache.getOrFetch(cacheKey, async () => {
      const principal = getCurrentPrincipalOrSystem();
      const conditions = [];
      if (options?.status) {
        const statusVal = options.status === "planned" ? "planning" : options.status;
        conditions.push(eq(projects.status, statusVal));
      }

      const scopedWhere = combineWithVisibleScope(
        principal,
        projectScopeColumns,
        conditions.length > 0 ? and(...conditions) : undefined
      );

      const rows = await db.select().from(projects).where(scopedWhere);

      const result = rows.map(rowToProject);

      result.sort((a, b) => {
        const priorityOrder: Record<string, number> = { high: 0, mid: 1, low: 2 };
        const pa = priorityOrder[a.priority] ?? 1;
        const pb = priorityOrder[b.priority] ?? 1;
        if (pa !== pb) return pa - pb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      log.debug(`getProjects count=${result.length} status=${options?.status || "all"}`);
      return result;
    });
  }

  async getProject(id: number): Promise<Project | undefined> {
    return this._singleProjectCache.getOrFetch(`project:${principalCacheKey()}:${id}`, async () => {
      const principal = getCurrentPrincipalOrSystem();
      const rows = await db.select().from(projects).where(
        combineWithVisibleScope(principal, projectScopeColumns, eq(projects.id, id))
      ).limit(1);
      if (rows.length === 0) {
        log.debug(`getProject id=${id} not-found`);
        return undefined;
      }
      log.debug(`getProject id=${id} found`);
      return rowToProject(rows[0]);
    });
  }

  async createProject(input: InsertProject): Promise<Project> {
    const now = new Date();

    const milestones: Milestone[] = (input.milestones || []).map((m: Milestone, idx: number) => ({
      id: m.id ?? idx + 1,
      name: m.name || "Unnamed",
      status: m.status || "planned",
      order: m.order ?? idx,
      startDate: m.startDate || null,
      dueDate: m.dueDate || null,
      completedAt: (m.status || "planned") === "completed" ? m.completedAt ?? now.toISOString() : null,
    }));

    const [row] = await db.insert(projects).values({
      title: input.title,
      description: input.description || "",
      status: input.status || "idea",
      priority: input.priority || "mid",
      owner: input.owner || "me",
      requiresReview: input.requiresReview ?? false,
      dueDate: input.dueDate ?? null,
      completedAt: (input.status || "idea") === "completed" ? now : null,
      spec: input.spec || "",
      goalId: input.goalId || null,
      milestones: milestones as unknown as Record<string, unknown>,
      tags: (input.tags || []) as unknown as Record<string, unknown>,
      people: (input.people || []) as unknown as Record<string, unknown>,
      notes: [] as unknown as Record<string, unknown>,
      files: [] as unknown as Record<string, unknown>,
      pages: [] as unknown as Record<string, unknown>,
      activity: [] as unknown as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), projectScopeColumns),
    }).returning();

    this.invalidateCache();
    const project = rowToProject(row);
    log.debug(`createProject id=${project.id} title="${project.title}" status=${project.status}`);
    return project;
  }

  async updateProject(id: number, updates: Partial<InsertProject>): Promise<Project | undefined> {
    const existing = await this.getProject(id);
    if (!existing) {
      log.debug(`updateProject id=${id} not-found`);
      return undefined;
    }

    let milestones = existing.milestones;
    if (updates.milestones) {
      const nowIso = new Date().toISOString();
      const priorById = new Map(existing.milestones.map(m => [m.id, m]));
      milestones = (updates.milestones as Milestone[]).map((m: Milestone, idx: number) => {
        const id = m.id ?? getNextMilestoneId(existing.milestones) + idx;
        const status = m.status || "planned";
        return {
          id,
          name: m.name || "Unnamed",
          status,
          order: m.order ?? idx,
          startDate: m.startDate || null,
          dueDate: m.dueDate || null,
          completedAt: status === "completed" ? m.completedAt ?? priorById.get(id)?.completedAt ?? nowIso : null,
        };
      });
    }

    const setValues: Record<string, unknown> = {
      updatedAt: new Date(),
      milestones: milestones as unknown as Record<string, unknown>,
    };

    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.description !== undefined) setValues.description = updates.description;
    if (updates.status !== undefined) {
      setValues.status = updates.status;
      if (updates.status === "completed" && existing.status !== "completed") setValues.completedAt = new Date();
      else if (updates.status !== "completed") setValues.completedAt = null;
    }
    if (updates.priority !== undefined) setValues.priority = updates.priority;
    if (updates.owner !== undefined) setValues.owner = updates.owner;
    if (updates.requiresReview !== undefined) setValues.requiresReview = updates.requiresReview;
    if (updates.dueDate !== undefined) setValues.dueDate = updates.dueDate;
    if (updates.spec !== undefined) setValues.spec = updates.spec;
    if (updates.goalId !== undefined) setValues.goalId = updates.goalId;
    if (updates.tags !== undefined) setValues.tags = updates.tags as unknown as Record<string, unknown>;
    if (updates.people !== undefined) setValues.people = updates.people as unknown as Record<string, unknown>;
    if (updates.pages !== undefined) setValues.pages = updates.pages as unknown as Record<string, unknown>;

    const [row] = await db.update(projects).set(setValues).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), projectScopeColumns, eq(projects.id, id))
    ).returning();
    this.invalidateCache();
    log.debug(`updateProject id=${id} fields=${Object.keys(updates).join(",")}`);
    return rowToProject(row);
  }

  async addMilestone(projectId: number, input: { name: string; status?: string; startDate?: string | null; dueDate?: string | null }): Promise<Project | undefined> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      log.debug(`addMilestone projectId=${projectId} not-found`);
      return undefined;
    }

    const newId = getNextMilestoneId(existing.milestones);
    const status = (input.status as Milestone["status"]) || "planned";
    const milestone: Milestone = {
      id: newId,
      name: input.name,
      status,
      order: existing.milestones.length,
      startDate: input.startDate || null,
      dueDate: input.dueDate || null,
      completedAt: status === "completed" ? new Date().toISOString() : null,
    };

    const milestones = [...existing.milestones, milestone];
    const [row] = await db.update(projects).set({
      milestones: milestones as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), projectScopeColumns, eq(projects.id, projectId))
    ).returning();

    this.invalidateCache();
    log.debug(`addMilestone projectId=${projectId} milestoneId=${newId} name="${input.name}"`);
    return rowToProject(row);
  }

  async updateMilestone(projectId: number, milestoneId: number, updates: Partial<Milestone>): Promise<Project | undefined> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      log.debug(`updateMilestone projectId=${projectId} not-found`);
      return undefined;
    }

    const milestones = existing.milestones.map(m => {
      if (m.id !== milestoneId) return m;
      const next = { ...m, ...updates, id: m.id };
      if (next.status === "completed" && m.status !== "completed") next.completedAt = updates.completedAt ?? new Date().toISOString();
      if (next.status !== "completed") next.completedAt = null;
      return next;
    });

    const [row] = await db.update(projects).set({
      milestones: milestones as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), projectScopeColumns, eq(projects.id, projectId))
    ).returning();

    this.invalidateCache();
    log.debug(`updateMilestone projectId=${projectId} milestoneId=${milestoneId}`);
    return rowToProject(row);
  }

  async removeMilestone(projectId: number, milestoneId: number): Promise<Project | undefined> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      log.debug(`removeMilestone projectId=${projectId} not-found`);
      return undefined;
    }

    const milestones = existing.milestones.filter(m => m.id !== milestoneId);
    const [row] = await db.update(projects).set({
      milestones: milestones as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), projectScopeColumns, eq(projects.id, projectId))
    ).returning();

    this.invalidateCache();
    log.debug(`removeMilestone projectId=${projectId} milestoneId=${milestoneId}`);
    return rowToProject(row);
  }


  async addPage(projectId: number, page: ProjectPage): Promise<Project | undefined> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      log.debug(`addPage projectId=${projectId} not-found`);
      return undefined;
    }

    const pages = [
      ...existing.pages.filter(p => p.id !== page.id),
      page,
    ];
    const [row] = await db.update(projects).set({
      pages: pages as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), projectScopeColumns, eq(projects.id, projectId))
    ).returning();

    this.invalidateCache();
    log.debug(`addPage projectId=${projectId} pageId=${page.id} title="${page.title}"`);
    return rowToProject(row);
  }

  async addFile(projectId: number, file: ProjectFile): Promise<Project | undefined> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      log.debug(`addFile projectId=${projectId} not-found`);
      return undefined;
    }

    const files = [...existing.files, file];
    const [row] = await db.update(projects).set({
      files: files as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), projectScopeColumns, eq(projects.id, projectId))
    ).returning();

    this.invalidateCache();
    log.debug(`addFile projectId=${projectId} fileId=${file.id} name="${file.name}"`);
    return rowToProject(row);
  }

  async removeFile(projectId: number, fileId: string): Promise<ProjectFile | undefined> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      log.debug(`removeFile projectId=${projectId} not-found`);
      return undefined;
    }

    const file = existing.files.find(f => f.id === fileId);
    if (!file) {
      log.debug(`removeFile projectId=${projectId} fileId=${fileId} file-not-found`);
      return undefined;
    }

    const files = existing.files.filter(f => f.id !== fileId);
    await db.update(projects).set({
      files: files as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), projectScopeColumns, eq(projects.id, projectId))
    );

    this.invalidateCache();
    log.debug(`removeFile projectId=${projectId} fileId=${fileId}`);
    return file;
  }

  async deleteProject(id: number): Promise<boolean> {
    const result = await db.delete(projects).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), projectScopeColumns, eq(projects.id, id))
    );
    const deleted = (result.rowCount ?? 0) > 0;
    log.debug(`deleteProject id=${id} success=${deleted}`);
    this.invalidateCache();
    return deleted;
  }

  async getUpcomingDeadlines(daysAhead: number = 14): Promise<Project[]> {
    const all = await this.getProjects({ status: "active" });
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    return all.filter(p => {
      if (!p.dueDate) return false;
      const due = new Date(p.dueDate);
      return due <= cutoff;
    }).sort((a, b) => {
      return new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime();
    });
  }
}

export const fileProjectStorage = new FileProjectStorage();
