import { acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS, db, type DrizzleTx } from "../db";
import { milestones, projects, tasks } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import type { Task, InsertTask, TaskStatus, AssigneeSubjectType } from "@shared/models/work";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { ownedInsertValues } from "../scoped-storage";
import {
  hasAdminOnlyTaskChanges,
  type ObjectGrantCapability,
} from "../object-grant-access";
import {
  combineWithProjectAccess,
  combineWithProjectDerivedWorkAccess,
  combineWithTaskAccess,
} from "../project-vault-access";
import { objectGrantService } from "../object-grant-service";
import { resolveInvitedSubjectReferenceInTransaction } from "../invited-subject-service";
import { eventBus } from "../event-bus";

const log = createLogger("StoreTasks");

// D4: vault_id is deliberately absent from work scope columns. It anchors
// placement and inheritance only; vault co-membership never grants work access.
const taskScopeColumns = {
  objectId: tasks.id,
  projectId: tasks.projectId,
  scope: tasks.scope,
  ownerUserId: tasks.ownerUserId,
  accountId: tasks.accountId,
};
const milestoneScopeColumns = {
  objectId: milestones.id,
  projectId: milestones.projectId,
  scope: milestones.scope,
  ownerUserId: milestones.ownerUserId,
  accountId: milestones.accountId,
};

export interface TaskMutationProvenance {
  originType: "meeting" | "manual";
  originId?: string | null;
}

type AssignmentSubject = { subjectType: AssigneeSubjectType; subjectId: string };

function assignmentFromValues(
  subjectType: AssigneeSubjectType | null | undefined,
  subjectId: string | null | undefined,
): AssignmentSubject | null {
  const hasType = subjectType !== undefined && subjectType !== null;
  const hasId = subjectId !== undefined && subjectId !== null;
  if (!hasType && !hasId) return null;
  if (!hasType || !hasId) throw new Error("Task assignment requires both assigneeSubjectType and assigneeSubjectId");
  const normalizedId = subjectId!.trim();
  if (!normalizedId) throw new Error("Task assigneeSubjectId cannot be blank");
  if (normalizedId === "__omit__") throw new Error("Task assigneeSubjectId must identify a real subject");
  return { subjectType: subjectType!, subjectId: normalizedId };
}

function assignmentPatch(
  existing: AssignmentSubject | null,
  updates: Partial<InsertTask>,
): { changed: boolean; next: AssignmentSubject | null } {
  const typeProvided = updates.assigneeSubjectType !== undefined;
  const idProvided = updates.assigneeSubjectId !== undefined;
  if (!typeProvided && !idProvided) return { changed: false, next: existing };
  if (typeProvided !== idProvided) {
    throw new Error("Task assignment updates must provide or clear assigneeSubjectType and assigneeSubjectId together");
  }
  return {
    changed: true,
    next: assignmentFromValues(updates.assigneeSubjectType, updates.assigneeSubjectId),
  };
}

async function resolveAssignmentSubjectInTransaction(
  tx: DrizzleTx,
  assignment: AssignmentSubject | null,
): Promise<AssignmentSubject | null> {
  if (!assignment || assignment.subjectType === "user") return assignment;
  const resolved = await resolveInvitedSubjectReferenceInTransaction(tx, assignment.subjectId, { create: true });
  return resolved;
}

function resolveMutationOrigin(provenance?: TaskMutationProvenance): TaskMutationProvenance {
  if (!provenance || provenance.originType === "manual") return { originType: "manual", originId: null };
  const originId = provenance.originId?.trim();
  if (!originId) throw new Error("Meeting task assignment requires an origin id");
  return { originType: "meeting", originId };
}

function resolveCreationVaultId(explicitVaultId?: string): string {
  const principal = getCurrentPrincipalOrSystem();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Task creation requires an explicit user principal");
  }
  const vaultId = explicitVaultId?.trim() || principal.activeVaultId;
  if (!vaultId) throw new Error("Task creation requires an active or explicit vault");
  if (!principal.visibleVaultIds.includes(vaultId)) {
    throw new Error(`Task vault ${vaultId} is not visible to the current principal`);
  }
  return vaultId;
}

/** Convert a DB row to the Task model shape */
function rowToTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    title: row.title,
    vaultId: row.vaultId,
    description: row.description,
    status: (row.status === "push" ? "on_hold" : row.status) as TaskStatus,
    priority: row.priority as Task["priority"],
    impact: row.impact as Task["impact"],
    effort: row.effort as Task["effort"],
    owner: row.owner as Task["owner"],
    assigneeSubjectType: row.assigneeSubjectType as Task["assigneeSubjectType"],
    assigneeSubjectId: row.assigneeSubjectId,
    requiresReview: row.requiresReview,
    projectId: row.projectId,
    milestoneId: row.milestoneId,
    tags: (row.tags as string[]) || [],
    context: row.context,
    output: row.output,
    deadline: row.deadline,
    tokenEstimate: row.tokenEstimate,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class FileTaskStorage {
  invalidateCache(): void {
    eventBus.publish({ category: "system", event: "data:tasks_changed", payload: { source: "task_storage" } });
  }

  async getTasks(options?: { status?: string; projectId?: number; owner?: string; priority?: string }): Promise<Task[]> {
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
        combineWithTaskAccess(getCurrentPrincipalOrSystem(), taskScopeColumns, "read", predicate),
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
  }

  async getTodoTasks(): Promise<Task[]> {
    const predicate = and(
      eq(tasks.owner, "me"),
      sql`${tasks.status} IN ('ready', 'active')`,
    );
    const rows = await db.select().from(tasks).where(
      combineWithTaskAccess(getCurrentPrincipalOrSystem(), taskScopeColumns, "read", predicate),
    );
    const todos = rows.map(rowToTask);
    log.log(`getTodoTasks count=${todos.length}`);
    return todos;
  }

  async getTask(id: number): Promise<Task | undefined> {
    const rows = await db.select().from(tasks).where(
      combineWithTaskAccess(getCurrentPrincipalOrSystem(), taskScopeColumns, "read", eq(tasks.id, id)),
    ).limit(1);
    if (rows.length === 0) {
      log.log(`getTask id=${id} not-found`);
      return undefined;
    }
    log.log(`getTask id=${id} found`);
    return rowToTask(rows[0]);
  }

  private async assertWorkPlacement(projectId: number | null | undefined, milestoneId: number | null | undefined): Promise<string | null> {
    const principal = getCurrentPrincipalOrSystem();
    if (projectId != null && (!Number.isInteger(projectId) || projectId <= 0)) {
      throw new Error("projectId must be a positive integer");
    }
    if (milestoneId != null && (!Number.isInteger(milestoneId) || milestoneId <= 0)) {
      throw new Error("milestoneId must be a positive integer");
    }
    if (milestoneId != null && projectId == null) {
      throw new Error("milestoneId requires projectId");
    }
    if (projectId == null) return null;
    const projectRows = await db.select({ id: projects.id, vaultId: projects.vaultId }).from(projects).where(
      combineWithProjectAccess(principal, "read", eq(projects.id, projectId)),
    ).limit(1);
    if (projectRows.length === 0) throw new Error(`Project ${projectId} not found`);
    if (milestoneId == null) return projectRows[0].vaultId;
    const milestoneRows = await db.select({ id: milestones.id }).from(milestones).where(
      combineWithProjectDerivedWorkAccess(
        principal,
        milestoneScopeColumns,
        "milestone",
        "read",
        and(eq(milestones.projectId, projectId), eq(milestones.id, milestoneId)),
      ),
    ).limit(1);
    if (milestoneRows.length === 0) {
      throw new Error(`Milestone ${milestoneId} not found in project ${projectId}`);
    }
    return projectRows[0].vaultId;
  }

  async createTask(input: InsertTask, provenance?: TaskMutationProvenance): Promise<Task> {
    const parentVaultId = await this.assertWorkPlacement(input.projectId, input.milestoneId);
    const now = new Date();
    const effort = input.effort || "mid";
    const vaultId = parentVaultId ?? resolveCreationVaultId(input.vaultId);
    const assigneeInput = assignmentFromValues(input.assigneeSubjectType, input.assigneeSubjectId);
    const origin = resolveMutationOrigin(provenance);

    const row = await db.transaction(async tx => {
      const assignee = await resolveAssignmentSubjectInTransaction(tx, assigneeInput);
      const [created] = await tx.insert(tasks).values({
        title: input.title,
        description: input.description || "",
        status: input.status || "ready",
        priority: input.priority || "mid",
        impact: input.impact || "mid",
        effort,
        owner: input.owner || "me",
        assigneeSubjectType: assignee?.subjectType ?? null,
        assigneeSubjectId: assignee?.subjectId ?? null,
        requiresReview: input.requiresReview ?? false,
        projectId: input.projectId ?? null,
        milestoneId: input.milestoneId ?? null,
        vaultId,
        tags: input.tags || [],
        context: input.context || "",
        output: input.output || "",
        deadline: input.deadline ?? null,
        tokenEstimate: input.tokenEstimate ?? null,
        completedAt: (input.status || "ready") === "done" ? now : null,
        createdAt: now,
        updatedAt: now,
        ...ownedInsertValues(getCurrentPrincipalOrSystem(), taskScopeColumns),
      }).returning();
      if (assignee) {
        await objectGrantService.setTaskAssignmentInTransaction(tx, created.id, null, assignee, origin);
      }
      return created;
    });

    this.invalidateCache();
    const task = rowToTask(row);
    log.log(`createTask id=${task.id} title="${task.title}" status=${task.status} priority=${task.priority}`);
    return task;
  }

  async updateTask(id: number, updates: Partial<InsertTask>, provenance?: TaskMutationProvenance): Promise<Task | undefined> {
    const principal = getCurrentPrincipalOrSystem();
    const required: ObjectGrantCapability = hasAdminOnlyTaskChanges(updates as Record<string, unknown>) ? "admin" : "write";
    const origin = resolveMutationOrigin(provenance);
    const row = await db.transaction(async tx => {
      const invitedAssignment = updates.assigneeSubjectType === "invited_subject" && updates.assigneeSubjectId
        ? await resolveAssignmentSubjectInTransaction(tx, {
            subjectType: "invited_subject",
            subjectId: updates.assigneeSubjectId,
          })
        : null;
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `task:${id}`);
      const [existingRow] = await tx.select().from(tasks).where(
        combineWithTaskAccess(principal, taskScopeColumns, required, eq(tasks.id, id)),
      ).limit(1);
      const existing = existingRow ? rowToTask(existingRow) : undefined;
      if (!existing) return undefined;

      let placementVaultId: string | null | undefined;
      if (updates.projectId !== undefined || updates.milestoneId !== undefined) {
        const projectId = updates.projectId !== undefined ? updates.projectId : existing.projectId;
        const milestoneId = updates.milestoneId !== undefined ? updates.milestoneId : existing.milestoneId;
        placementVaultId = await this.assertWorkPlacement(projectId, milestoneId);
      }

      const previousAssignee = assignmentFromValues(existing.assigneeSubjectType, existing.assigneeSubjectId);
      const assigneePatchInput = assignmentPatch(previousAssignee, updates);
      const assignee = assigneePatchInput.changed
        ? {
            changed: true,
            next: invitedAssignment ?? await resolveAssignmentSubjectInTransaction(tx, assigneePatchInput.next),
          }
        : assigneePatchInput;
      const setValues: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.title !== undefined) setValues.title = updates.title;
      if (updates.description !== undefined) setValues.description = updates.description;
      if (updates.status !== undefined) setValues.status = updates.status;
      if (updates.priority !== undefined) setValues.priority = updates.priority;
      if (updates.impact !== undefined) setValues.impact = updates.impact;
      if (updates.effort !== undefined) setValues.effort = updates.effort;
      if (updates.owner !== undefined) setValues.owner = updates.owner;
      if (assignee.changed) {
        setValues.assigneeSubjectType = assignee.next?.subjectType ?? null;
        setValues.assigneeSubjectId = assignee.next?.subjectId ?? null;
      }
      if (updates.requiresReview !== undefined) setValues.requiresReview = updates.requiresReview;
      if (updates.projectId !== undefined) setValues.projectId = updates.projectId;
      if (updates.milestoneId !== undefined) setValues.milestoneId = updates.milestoneId;
      if (placementVaultId) setValues.vaultId = placementVaultId;
      if (updates.tags !== undefined) setValues.tags = updates.tags;
      if (updates.context !== undefined) setValues.context = updates.context;
      if (updates.output !== undefined) setValues.output = updates.output;
      if (updates.deadline !== undefined) setValues.deadline = updates.deadline;
      if (updates.tokenEstimate !== undefined) setValues.tokenEstimate = updates.tokenEstimate;
      if (updates.status !== undefined && updates.status !== existing.status) {
        if (updates.status === "done") setValues.completedAt = new Date();
        else if (existing.status === "done") setValues.completedAt = null;
      }

      const [updated] = await tx.update(tasks).set(setValues).where(
        combineWithTaskAccess(principal, taskScopeColumns, required, eq(tasks.id, id)),
      ).returning();
      if (!updated) return undefined;
      if (assignee.changed) {
        await objectGrantService.setTaskAssignmentInTransaction(tx, id, previousAssignee, assignee.next, origin);
      }
      return updated;
    });
    if (!row) {
      log.log(`updateTask id=${id} not-found`);
      return undefined;
    }
    if (updates.status) log.log(`statusChange to=${updates.status} taskId=${id} title="${row.title}"`);
    log.log(`updateTask id=${id} fields=${Object.keys(updates).join(",")}`);
    this.invalidateCache();
    return rowToTask(row);
  }

  async deleteTask(id: number): Promise<boolean> {
    const principal = getCurrentPrincipalOrSystem();
    const deleted = await db.transaction(async tx => {
      const [task] = await tx.select({ id: tasks.id }).from(tasks).where(
        combineWithTaskAccess(principal, taskScopeColumns, "admin", eq(tasks.id, id)),
      ).limit(1);
      if (!task) return false;
      await objectGrantService.revokeObjectGrantsInTransaction(tx, { objectType: "task", objectId: id });
      const rows = await tx.delete(tasks).where(
        combineWithTaskAccess(principal, taskScopeColumns, "admin", eq(tasks.id, id)),
      ).returning({ id: tasks.id });
      return rows.length > 0;
    });
    log.log(`deleteTask id=${id} success=${deleted}`);
    this.invalidateCache();
    return deleted;
  }
}

export const fileTaskStorage = new FileTaskStorage();
