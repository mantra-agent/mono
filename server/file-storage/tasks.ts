import { db } from "../db";
import { tasks } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import type { Task, InsertTask, TaskStatus } from "@shared/models/work";
import { createLogger } from "../log";
import { TTLCache } from "../utils/ttl-cache";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { eventBus } from "../event-bus";

const log = createLogger("StoreTasks");

const taskScopeColumns = { scope: tasks.scope, ownerUserId: tasks.ownerUserId, accountId: tasks.accountId };

function principalCacheKey(): string {
  const principal = getCurrentPrincipalOrSystem();
  return `${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
}

/** Convert a DB row to the Task model shape */
function rowToTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: (row.status === "push" ? "on_hold" : row.status) as TaskStatus,
    priority: row.priority as Task["priority"],
    impact: row.impact as Task["impact"],
    effort: row.effort as Task["effort"],
    owner: row.owner as Task["owner"],
    requiresReview: row.requiresReview,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    tags: (row.tags as string[]) || [],
    context: row.context,
    output: row.output,
    deadline: row.deadline,
    tokenEstimate: row.tokenEstimate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class FileTaskStorage {
  private readonly _todoCache = new TTLCache<Task[]>("TodoTasks", Infinity);
  private readonly _singleTaskCache = new TTLCache<Task | undefined>("SingleTask", Infinity);

  private invalidateCache(): void {
    this._todoCache.invalidateAll();
    this._singleTaskCache.invalidateAll();
    eventBus.publish({ category: "system", event: "data:tasks_changed", payload: { source: "task_storage" } });
  }

  async getTasks(options?: { status?: string; projectId?: number; owner?: string; priority?: string }): Promise<Task[]> {
    const cacheKey = `tasks:${principalCacheKey()}:${options?.status || "all"}:${options?.projectId ?? "any"}:${options?.owner || "any"}:${options?.priority || "any"}`;
    return this._todoCache.getOrFetch(cacheKey, async () => {
      const conditions = [];
      if (options?.status) {
        // Legacy "push" status maps to "on_hold"
        const statusVal = options.status === "push" ? "on_hold" : options.status;
        conditions.push(eq(tasks.status, statusVal));
      }
      if (options?.projectId !== undefined) conditions.push(eq(tasks.projectId, options.projectId));
      if (options?.owner) conditions.push(eq(tasks.owner, options.owner));
      if (options?.priority) conditions.push(eq(tasks.priority, options.priority));

      const predicate = conditions.length > 0 ? and(...conditions) : undefined;
      const rows = await db.select().from(tasks).where(
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), taskScopeColumns, predicate),
      );

      const result = rows.map(rowToTask);

      result.sort((a, b) => {
        const priorityOrder: Record<string, number> = { high: 0, mid: 1, low: 2 };
        const pa = priorityOrder[a.priority] ?? 1;
        const pb = priorityOrder[b.priority] ?? 1;
        if (pa !== pb) return pa - pb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      log.log(`getTasks count=${result.length} status=${options?.status || "all"}`);
      return result;
    });
  }

  async getTodoTasks(): Promise<Task[]> {
    return this._todoCache.getOrFetch(`todo:${principalCacheKey()}`, async () => {
      const predicate = and(
        eq(tasks.owner, "me"),
        sql`${tasks.status} IN ('ready', 'active')`,
      );
      const rows = await db.select().from(tasks).where(
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), taskScopeColumns, predicate),
      );
      const todos = rows.map(rowToTask);
      log.log(`getTodoTasks count=${todos.length}`);
      return todos;
    });
  }

  async getTask(id: number): Promise<Task | undefined> {
    return this._singleTaskCache.getOrFetch(`task:${principalCacheKey()}:${id}`, async () => {
      const rows = await db.select().from(tasks).where(
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), taskScopeColumns, eq(tasks.id, id)),
      ).limit(1);
      if (rows.length === 0) {
        log.log(`getTask id=${id} not-found`);
        return undefined;
      }
      log.log(`getTask id=${id} found`);
      return rowToTask(rows[0]);
    });
  }

  async createTask(input: InsertTask): Promise<Task> {
    const now = new Date();
    const effort = input.effort || "mid";

    const [row] = await db.insert(tasks).values({
      title: input.title,
      description: input.description || "",
      status: input.status || "ready",
      priority: input.priority || "mid",
      impact: input.impact || "mid",
      effort,
      owner: input.owner || "me",
      requiresReview: input.requiresReview ?? false,
      projectId: input.projectId ?? null,
      milestoneId: input.milestoneId ?? null,
      tags: input.tags || [],
      context: input.context || "",
      output: input.output || "",
      deadline: input.deadline ?? null,
      tokenEstimate: input.tokenEstimate ?? null,
      createdAt: now,
      updatedAt: now,
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), taskScopeColumns),
    }).returning();

    this.invalidateCache();
    const task = rowToTask(row);
    log.log(`createTask id=${task.id} title="${task.title}" status=${task.status} priority=${task.priority}`);
    return task;
  }

  async updateTask(id: number, updates: Partial<InsertTask>): Promise<Task | undefined> {
    const existing = await this.getTask(id);
    if (!existing) {
      log.log(`updateTask id=${id} not-found`);
      return undefined;
    }

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.title !== undefined) setValues.title = updates.title;
    if (updates.description !== undefined) setValues.description = updates.description;
    if (updates.status !== undefined) setValues.status = updates.status;
    if (updates.priority !== undefined) setValues.priority = updates.priority;
    if (updates.impact !== undefined) setValues.impact = updates.impact;
    if (updates.effort !== undefined) setValues.effort = updates.effort;
    if (updates.owner !== undefined) setValues.owner = updates.owner;
    if (updates.requiresReview !== undefined) setValues.requiresReview = updates.requiresReview;
    if (updates.projectId !== undefined) setValues.projectId = updates.projectId;
    if (updates.milestoneId !== undefined) setValues.milestoneId = updates.milestoneId;
    if (updates.tags !== undefined) setValues.tags = updates.tags;
    if (updates.context !== undefined) setValues.context = updates.context;
    if (updates.output !== undefined) setValues.output = updates.output;
    if (updates.deadline !== undefined) setValues.deadline = updates.deadline;
    if (updates.tokenEstimate !== undefined) setValues.tokenEstimate = updates.tokenEstimate;

    const [row] = await db.update(tasks).set(setValues).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), taskScopeColumns, eq(tasks.id, id)),
    ).returning();
    if (!row) {
      log.log(`updateTask id=${id} not-writable`);
      return undefined;
    }
    if (updates.status && updates.status !== existing.status) {
      log.log(`statusChange from=${existing.status} to=${updates.status} taskId=${id} title="${row.title}"`);
    }
    log.log(`updateTask id=${id} fields=${Object.keys(updates).join(",")}`);
    this.invalidateCache();
    return rowToTask(row);
  }

  async deleteTask(id: number): Promise<boolean> {
    const result = await db.delete(tasks).where(
      combineWithWritableScope(getCurrentPrincipalOrSystem(), taskScopeColumns, eq(tasks.id, id)),
    );
    const deleted = (result.rowCount ?? 0) > 0;
    log.log(`deleteTask id=${id} success=${deleted}`);
    this.invalidateCache();
    return deleted;
  }
}

export const fileTaskStorage = new FileTaskStorage();
