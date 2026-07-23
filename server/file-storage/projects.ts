import { db, acquireAdvisoryTransactionLock, ADVISORY_LOCK_NS } from "../db";
import { milestones as milestoneRows, projects, projectVaultMemberships, tasks, vaults } from "@shared/schema";
import { eq, and, inArray, asc } from "drizzle-orm";
import type {
  Project, InsertProject, ActivityEntry, Milestone, ProjectNote, ProjectFile, ProjectPage,
  ProjectStatus, PriorityLevel,
} from "@shared/models/work";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import {
  hasAdminOnlyMilestoneChanges,
  hasAdminOnlyProjectChanges,
  type ObjectGrantCapability,
} from "../object-grant-access";
import {
  combineWithProjectAccess,
  combineWithProjectDerivedWorkAccess,
  combineWithTaskAccess,
  loadProjectVaultIds,
  projectOwnerAccessPredicate,
  projectOwnerScopeColumns,
  projectVaultMembershipScopeColumns,
} from "../project-vault-access";
import { objectGrantService } from "../object-grant-service";
import { eventBus } from "../event-bus";

const log = createLogger("StoreProjects");

export interface WorkCreationProvenance {
  originType: "meeting";
  originId: string;
}

function normalizeCreationProvenance(provenance?: WorkCreationProvenance): WorkCreationProvenance | null {
  if (!provenance) return null;
  const originId = provenance.originId.trim();
  if (!originId) throw new Error("Meeting work creation requires an origin id");
  return { originType: "meeting", originId };
}

const milestoneScopeColumns = {
  objectId: milestoneRows.id,
  projectId: milestoneRows.projectId,
  scope: milestoneRows.scope,
  ownerUserId: milestoneRows.ownerUserId,
  accountId: milestoneRows.accountId,
};
const taskScopeColumns = {
  objectId: tasks.id,
  projectId: tasks.projectId,
  scope: tasks.scope,
  ownerUserId: tasks.ownerUserId,
  accountId: tasks.accountId,
};

function resolveCreationVaultId(explicitVaultId?: string): string {
  const principal = getCurrentPrincipalOrSystem();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Project creation requires an explicit user principal");
  }
  const vaultId = explicitVaultId?.trim() || principal.activeVaultId;
  if (!vaultId) throw new Error("Project creation requires an active or explicit vault");
  if (!principal.visibleVaultIds.includes(vaultId)) {
    throw new Error(`Project vault ${vaultId} is not visible to the current principal`);
  }
  return vaultId;
}

function rowToMilestone(row: typeof milestoneRows.$inferSelect): Milestone {
  return {
    id: row.id,
    name: row.name,
    status: row.status as Milestone["status"],
    order: row.displayOrder,
    startDate: row.startDate ?? null,
    dueDate: row.dueDate ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** Convert a DB row to the stable Project model shape. Milestones are hydrated separately. */
function rowToProject(
  row: typeof projects.$inferSelect,
  milestones: Milestone[] = [],
  vaultIds: string[] = [],
  canManageVaults = false,
): Project {
  // Normalize legacy "planned" status to "planning"
  let status = row.status as ProjectStatus;
  if (status === ("planned" as ProjectStatus)) status = "planning";

  return {
    id: row.id,
    title: row.title,
    vaultId: row.vaultId!,
    vaultIds,
    canManageVaults,
    description: row.description,
    status,
    priority: row.priority as PriorityLevel,
    owner: row.owner as Project["owner"],
    requiresReview: row.requiresReview,
    dueDate: row.dueDate || null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    spec: row.spec,
    goalId: row.goalId || null,
    milestones,
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
  private invalidateCache(): void {
    eventBus.publish({ category: "system", event: "data:projects_changed", payload: { source: "project_storage" } });
  }

  private async getMilestonesForProjects(projectIds: number[]): Promise<Map<number, Milestone[]>> {
    const byProject = new Map<number, Milestone[]>();
    if (projectIds.length === 0) return byProject;

    const principal = getCurrentPrincipalOrSystem();
    const rows = await db.select().from(milestoneRows).where(
      principal.actorType === "system"
        ? combineWithProjectDerivedWorkAccess(
            principal,
            milestoneScopeColumns,
            "milestone",
            "read",
            inArray(milestoneRows.projectId, projectIds),
          )
        : and(
            inArray(milestoneRows.projectId, projectIds),
            eq(milestoneRows.scope, "user"),
            eq(milestoneRows.ownerUserId, principal.userId!),
            eq(milestoneRows.accountId, principal.accountId!),
          )!,
    ).orderBy(asc(milestoneRows.projectId), asc(milestoneRows.displayOrder), asc(milestoneRows.id));

    for (const row of rows) {
      const list = byProject.get(row.projectId) ?? [];
      list.push(rowToMilestone(row));
      byProject.set(row.projectId, list);
    }
    return byProject;
  }

  async getMilestone(projectId: number, milestoneId: number): Promise<Milestone | undefined> {
    const rows = await db.select().from(milestoneRows).where(
      combineWithProjectDerivedWorkAccess(
        getCurrentPrincipalOrSystem(),
        milestoneScopeColumns,
        "milestone",
        "read",
        and(eq(milestoneRows.projectId, projectId), eq(milestoneRows.id, milestoneId)),
      ),
    ).limit(1);
    return rows[0] ? rowToMilestone(rows[0]) : undefined;
  }

  async getProjects(options?: { status?: string }): Promise<Project[]> {
      const principal = getCurrentPrincipalOrSystem();
      const conditions = [];
      if (options?.status) {
        const statusVal = options.status === "planned" ? "planning" : options.status;
        conditions.push(eq(projects.status, statusVal));
      }

      const scopedWhere = combineWithProjectAccess(
        principal,
        "read",
        conditions.length > 0 ? and(...conditions) : undefined,
      );

      const rows = await db.select().from(projects).where(scopedWhere);
      const projectIds = rows.map(row => row.id);
      const [milestonesByProject, vaultIdsByProject] = await Promise.all([
        this.getMilestonesForProjects(projectIds),
        loadProjectVaultIds(principal, projectIds),
      ]);

      const result = rows.map(row => rowToProject(
        row,
        milestonesByProject.get(row.id) ?? [],
        vaultIdsByProject.get(row.id) ?? [],
        principal.actorType === "user"
          && row.ownerUserId === principal.userId
          && row.accountId === principal.accountId
          && (vaultIdsByProject.get(row.id)?.some(vaultId => principal.visibleVaultIds.includes(vaultId)) ?? false),
      ));

      result.sort((a, b) => {
        const priorityOrder: Record<string, number> = { high: 0, mid: 1, low: 2 };
        const pa = priorityOrder[a.priority] ?? 1;
        const pb = priorityOrder[b.priority] ?? 1;
        if (pa !== pb) return pa - pb;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });

      log.debug(`getProjects count=${result.length} status=${options?.status || "all"}`);
      return result;
  }

  async getProject(id: number): Promise<Project | undefined> {
    const principal = getCurrentPrincipalOrSystem();
    const rows = await db.select().from(projects).where(
      combineWithProjectAccess(principal, "read", eq(projects.id, id)),
    ).limit(1);
    if (rows.length === 0) {
      log.debug(`getProject id=${id} not-found`);
      return undefined;
    }
    const [milestonesByProject, vaultIdsByProject] = await Promise.all([
      this.getMilestonesForProjects([id]),
      loadProjectVaultIds(principal, [id]),
    ]);
    log.debug(`getProject id=${id} found`);
    const row = rows[0];
    const vaultIds = vaultIdsByProject.get(id) ?? [];
    return rowToProject(
      row,
      milestonesByProject.get(id) ?? [],
      vaultIds,
      principal.actorType === "user"
        && row.ownerUserId === principal.userId
        && row.accountId === principal.accountId
        && vaultIds.some(vaultId => principal.visibleVaultIds.includes(vaultId)),
    );
  }

  async createProject(input: InsertProject, provenance?: WorkCreationProvenance): Promise<Project> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Project creation requires an explicit user principal");
    }
    const now = new Date();
    const vaultId = resolveCreationVaultId(input.vaultId);
    const creationProvenance = normalizeCreationProvenance(provenance);

    const created = await db.transaction(async tx => {
      const [row] = await tx.insert(projects).values({
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
        vaultId,
        // Deprecated milestone JSON intentionally remains at its database default.
        tags: (input.tags || []) as unknown as Record<string, unknown>,
        people: (input.people || []) as unknown as Record<string, unknown>,
        notes: [] as unknown as Record<string, unknown>,
        files: [] as unknown as Record<string, unknown>,
        pages: [] as unknown as Record<string, unknown>,
        activity: [] as unknown as Record<string, unknown>,
        createdAt: now,
        updatedAt: now,
        ...ownedInsertValues(principal, projectOwnerScopeColumns),
      }).returning();

      await tx.insert(projectVaultMemberships).values({
        projectId: row.id,
        vaultId,
        scope: "user",
        ownerUserId: principal.userId,
        accountId: principal.accountId,
        createdByUserId: principal.userId,
      });

      const normalized = (input.milestones || []).map((milestone: Milestone, index: number) => ({
        id: milestone.id ?? index + 1,
        projectId: row.id,
        vaultId,
        ownerUserId: row.ownerUserId,
        accountId: row.accountId,
        scope: row.scope,
        createdByUserId: principal.userId ?? row.ownerUserId,
        name: milestone.name || "Unnamed",
        status: milestone.status || "planned",
        startDate: milestone.startDate || null,
        dueDate: milestone.dueDate || null,
        displayOrder: milestone.order ?? index,
        completedAt: (milestone.status || "planned") === "completed"
          ? milestone.completedAt ? new Date(milestone.completedAt) : now
          : null,
        createdAt: now,
        updatedAt: now,
      }));
      if (normalized.length > 0) await tx.insert(milestoneRows).values(normalized);
      if (creationProvenance) {
        await objectGrantService.grantMeetingDefaultsInTransaction(
          tx,
          { objectType: "project", objectId: row.id },
          creationProvenance.originId,
        );
        for (const milestone of normalized) {
          await objectGrantService.grantMeetingDefaultsInTransaction(
            tx,
            { objectType: "milestone", objectId: milestone.id, projectId: row.id },
            creationProvenance.originId,
          );
        }
      }
      return { row, milestones: normalized.map(item => rowToMilestone(item)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id) };
    });

    this.invalidateCache();
    const project = rowToProject(created.row, created.milestones, [vaultId], true);
    log.debug(`createProject id=${project.id} title="${project.title}" status=${project.status}`);
    return project;
  }

  async replaceVaultMemberships(projectId: number, vaultIds: string[]): Promise<Project> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Project Vault membership requires an authenticated user account");
    }
    const normalizedVaultIds = [...new Set(vaultIds.map(vaultId => vaultId.trim()).filter(Boolean))];
    if (normalizedVaultIds.length === 0) throw new Error("A Project must belong to at least one Vault");
    if (normalizedVaultIds.some(vaultId => !principal.visibleVaultIds.includes(vaultId))) {
      throw new Error("Every Project Vault must be currently visible");
    }

    await db.transaction(async tx => {
      const existingMemberships = await tx
        .select({ vaultId: projectVaultMemberships.vaultId })
        .from(projectVaultMemberships)
        .where(combineWithWritableScope(
          principal,
          projectVaultMembershipScopeColumns,
          eq(projectVaultMemberships.projectId, projectId),
        ));
      const lockedVaultIds = [...new Set([
        ...existingMemberships.map(membership => membership.vaultId),
        ...normalizedVaultIds,
      ])].sort();
      for (const vaultId of lockedVaultIds) {
        await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `vault:${vaultId}`);
      }
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.OBJECT_GRANT, `project:${projectId}`);
      const [project] = await tx
        .select({ id: projects.id, vaultId: projects.vaultId })
        .from(projects)
        .where(and(
          eq(projects.id, projectId),
          projectOwnerAccessPredicate(principal, "admin"),
        ))
        .for("update");
      if (!project) throw new Error(`Project ${projectId} not found or not administrable`);

      const availableVaults = await tx
        .select({ id: vaults.id })
        .from(vaults)
        .where(and(
          inArray(vaults.id, normalizedVaultIds),
          eq(vaults.accountId, principal.accountId),
          eq(vaults.isArchived, false),
        ));
      if (availableVaults.length !== normalizedVaultIds.length) {
        throw new Error("Every Project Vault must be live and writable in the active account");
      }

      await tx.delete(projectVaultMemberships).where(
        combineWithWritableScope(
          principal,
          projectVaultMembershipScopeColumns,
          eq(projectVaultMemberships.projectId, projectId),
        ),
      );
      await tx.insert(projectVaultMemberships).values(
        normalizedVaultIds.map(vaultId => ({
          projectId,
          vaultId,
          scope: "user",
          ownerUserId: principal.userId!,
          accountId: principal.accountId!,
          createdByUserId: principal.userId!,
        })),
      );

      const primaryVaultId = normalizedVaultIds.includes(project.vaultId!)
        ? project.vaultId!
        : normalizedVaultIds[0];
      await tx.update(projects)
        .set({ vaultId: primaryVaultId, updatedAt: new Date() })
        .where(and(
          eq(projects.id, projectId),
          projectOwnerAccessPredicate(principal, "admin"),
        ));
    });

    this.invalidateCache();
    const { fileTaskStorage } = await import("./tasks");
    fileTaskStorage.invalidateCache();
    const project = await this.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found after updating Vaults`);
    return project;
  }

  async updateProject(id: number, updates: Partial<InsertProject>): Promise<Project | undefined> {
    if ((updates as Partial<InsertProject> & { vaultIds?: string[] }).vaultIds !== undefined) {
      throw new Error("Update Project Vaults through replaceVaultMemberships");
    }
    const principal = getCurrentPrincipalOrSystem();
    const updated = await db.transaction(async tx => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.PROJECT_MILESTONES, String(id));
      const required: ObjectGrantCapability = hasAdminOnlyProjectChanges(updates as Record<string, unknown>) ? "admin" : "write";
      const [existing] = await tx.select().from(projects).where(
        combineWithProjectAccess(principal, required, eq(projects.id, id)),
      ).limit(1);
      if (!existing) return false;

      const now = new Date();
      const setValues: Record<string, unknown> = { updatedAt: now };
      if (updates.title !== undefined) setValues.title = updates.title;
      if (updates.description !== undefined) setValues.description = updates.description;
      if (updates.status !== undefined) {
        setValues.status = updates.status;
        if (updates.status === "completed" && existing.status !== "completed") setValues.completedAt = now;
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
      await tx.update(projects).set(setValues).where(
        combineWithProjectAccess(principal, required, eq(projects.id, id)),
      );

      if (updates.milestones !== undefined) {
        const priorRows = await tx.select().from(milestoneRows).where(eq(milestoneRows.projectId, id));
        const priorById = new Map(priorRows.map(row => [row.id, row]));
        let nextId = Math.max(0, ...priorRows.map(row => row.id)) + 1;
        const seen = new Set<number>();
        const replacement = (updates.milestones as Milestone[]).map((milestone, index) => {
          const milestoneId = milestone.id ?? nextId++;
          if (seen.has(milestoneId)) throw new Error(`Duplicate milestone id ${milestoneId} in project ${id}`);
          seen.add(milestoneId);
          const prior = priorById.get(milestoneId);
          const status = milestone.status || "planned";
          return {
            id: milestoneId,
            projectId: id,
            vaultId: prior?.vaultId ?? existing.vaultId,
            ownerUserId: existing.ownerUserId,
            accountId: existing.accountId,
            scope: existing.scope,
            createdByUserId: prior?.createdByUserId ?? principal.userId ?? existing.ownerUserId,
            name: milestone.name || "Unnamed",
            status,
            startDate: milestone.startDate || null,
            dueDate: milestone.dueDate || null,
            displayOrder: milestone.order ?? index,
            completedAt: status === "completed"
              ? milestone.completedAt ? new Date(milestone.completedAt) : prior?.completedAt ?? now
              : null,
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
          };
        });
        const removedIds = priorRows.filter(row => !seen.has(row.id)).map(row => row.id);
        for (const removedId of removedIds) {
          await objectGrantService.revokeObjectGrantsInTransaction(tx, {
            objectType: "milestone",
            objectId: removedId,
            projectId: id,
          });
        }
        if (removedIds.length > 0) {
          await tx.update(tasks).set({ milestoneId: null, updatedAt: now }).where(
            combineWithTaskAccess(
              principal,
              taskScopeColumns,
              "admin",
              and(eq(tasks.projectId, id), inArray(tasks.milestoneId, removedIds)),
            ),
          );
        }
        await tx.delete(milestoneRows).where(eq(milestoneRows.projectId, id));
        if (replacement.length > 0) await tx.insert(milestoneRows).values(replacement);
      }
      return true;
    });

    if (!updated) {
      log.debug(`updateProject id=${id} not-found`);
      return undefined;
    }
    this.invalidateCache();
    if (updates.milestones !== undefined) {
      const { fileTaskStorage } = await import("./tasks");
      fileTaskStorage.invalidateCache();
    }
    log.debug(`updateProject id=${id} fields=${Object.keys(updates).join(",")}`);
    return this.getProject(id);
  }

  async addMilestone(
    projectId: number,
    input: { name: string; status?: string; startDate?: string | null; dueDate?: string | null },
    provenance?: WorkCreationProvenance,
  ): Promise<Project | undefined> {
    if (input.status && !["planned", "active", "completed"].includes(input.status)) {
      throw new Error(`Invalid milestone status: ${input.status}`);
    }
    const principal = getCurrentPrincipalOrSystem();
    const creationProvenance = normalizeCreationProvenance(provenance);
    const newId = await db.transaction(async tx => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.PROJECT_MILESTONES, String(projectId));
      const [project] = await tx.select().from(projects).where(
        combineWithProjectAccess(principal, "admin", eq(projects.id, projectId)),
      ).limit(1);
      if (!project) return null;
      const existing = await tx.select({ id: milestoneRows.id, displayOrder: milestoneRows.displayOrder })
        .from(milestoneRows)
        .where(combineWithProjectDerivedWorkAccess(principal, milestoneScopeColumns, "milestone", "read", eq(milestoneRows.projectId, projectId)));
      const id = Math.max(0, ...existing.map(row => row.id)) + 1;
      const displayOrder = Math.max(-1, ...existing.map(row => row.displayOrder)) + 1;
      const status = (input.status as Milestone["status"]) || "planned";
      const now = new Date();
      await tx.insert(milestoneRows).values({
        id,
        projectId,
        vaultId: project.vaultId,
        ownerUserId: project.ownerUserId,
        accountId: project.accountId,
        scope: project.scope,
        createdByUserId: principal.userId ?? project.ownerUserId,
        name: input.name,
        status,
        startDate: input.startDate || null,
        dueDate: input.dueDate || null,
        displayOrder,
        completedAt: status === "completed" ? now : null,
        createdAt: now,
        updatedAt: now,
      });
      if (creationProvenance) {
        await objectGrantService.grantMeetingDefaultsInTransaction(
          tx,
          { objectType: "milestone", objectId: id, projectId },
          creationProvenance.originId,
        );
      }
      await tx.update(projects).set({ updatedAt: now }).where(
        combineWithProjectAccess(principal, "admin", eq(projects.id, projectId)),
      );
      return id;
    });

    if (newId === null) {
      log.debug(`addMilestone projectId=${projectId} not-found`);
      return undefined;
    }
    this.invalidateCache();
    log.debug(`addMilestone projectId=${projectId} milestoneId=${newId} name="${input.name}"`);
    return this.getProject(projectId);
  }

  async updateMilestone(projectId: number, milestoneId: number, updates: Partial<Milestone>): Promise<Project | undefined> {
    if (updates.status && !["planned", "active", "completed"].includes(updates.status)) {
      throw new Error(`Invalid milestone status: ${updates.status}`);
    }
    const principal = getCurrentPrincipalOrSystem();
    const changed = await db.transaction(async tx => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.PROJECT_MILESTONES, String(projectId));
      const required: ObjectGrantCapability = hasAdminOnlyMilestoneChanges(updates as Record<string, unknown>) ? "admin" : "write";
      const [existing] = await tx.select().from(milestoneRows).where(
        combineWithProjectDerivedWorkAccess(
          principal,
          milestoneScopeColumns,
          "milestone",
          required,
          and(eq(milestoneRows.projectId, projectId), eq(milestoneRows.id, milestoneId)),
        ),
      ).limit(1);
      if (!existing) return false;
      const nextStatus = updates.status ?? existing.status;
      const setValues: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.name !== undefined) setValues.name = updates.name;
      if (updates.status !== undefined) setValues.status = updates.status;
      if (updates.order !== undefined) setValues.displayOrder = updates.order;
      if (updates.startDate !== undefined) setValues.startDate = updates.startDate;
      if (updates.dueDate !== undefined) setValues.dueDate = updates.dueDate;
      if (nextStatus === "completed" && existing.status !== "completed") {
        setValues.completedAt = updates.completedAt ? new Date(updates.completedAt) : new Date();
      } else if (nextStatus !== "completed") {
        setValues.completedAt = null;
      } else if (updates.completedAt !== undefined) {
        setValues.completedAt = updates.completedAt ? new Date(updates.completedAt) : null;
      }
      await tx.update(milestoneRows).set(setValues).where(
        combineWithProjectDerivedWorkAccess(
          principal,
          milestoneScopeColumns,
          "milestone",
          required,
          and(eq(milestoneRows.projectId, projectId), eq(milestoneRows.id, milestoneId)),
        ),
      );
      return true;
    });

    if (!changed) return undefined;
    this.invalidateCache();
    log.debug(`updateMilestone projectId=${projectId} milestoneId=${milestoneId}`);
    return this.getProject(projectId);
  }

  async removeMilestone(projectId: number, milestoneId: number): Promise<Project | undefined> {
    const principal = getCurrentPrincipalOrSystem();
    const removed = await db.transaction(async tx => {
      await acquireAdvisoryTransactionLock(tx, ADVISORY_LOCK_NS.PROJECT_MILESTONES, String(projectId));
      await objectGrantService.revokeObjectGrantsInTransaction(tx, {
        objectType: "milestone",
        objectId: milestoneId,
        projectId,
      });
      const deleted = await tx.delete(milestoneRows).where(
        combineWithProjectDerivedWorkAccess(
          principal,
          milestoneScopeColumns,
          "milestone",
          "admin",
          and(eq(milestoneRows.projectId, projectId), eq(milestoneRows.id, milestoneId)),
        ),
      ).returning({ id: milestoneRows.id });
      if (deleted.length === 0) return false;
      return true;
    });

    if (!removed) return undefined;
    this.invalidateCache();
    const { fileTaskStorage } = await import("./tasks");
    fileTaskStorage.invalidateCache();
    log.debug(`removeMilestone projectId=${projectId} milestoneId=${milestoneId}`);
    return this.getProject(projectId) ?? undefined;
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
    await db.update(projects).set({
      pages: pages as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(
      combineWithProjectAccess(getCurrentPrincipalOrSystem(), "write", eq(projects.id, projectId))
    );

    this.invalidateCache();
    log.debug(`addPage projectId=${projectId} pageId=${page.id} title="${page.title}"`);
    return this.getProject(projectId);
  }

  async addFile(projectId: number, file: ProjectFile): Promise<Project | undefined> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      log.debug(`addFile projectId=${projectId} not-found`);
      return undefined;
    }

    const files = [...existing.files, file];
    await db.update(projects).set({
      files: files as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    }).where(
      combineWithProjectAccess(getCurrentPrincipalOrSystem(), "write", eq(projects.id, projectId))
    );

    this.invalidateCache();
    log.debug(`addFile projectId=${projectId} fileId=${file.id} name="${file.name}"`);
    return this.getProject(projectId);
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
      combineWithProjectAccess(getCurrentPrincipalOrSystem(), "write", eq(projects.id, projectId))
    );

    this.invalidateCache();
    log.debug(`removeFile projectId=${projectId} fileId=${fileId}`);
    return file;
  }

  async deleteProject(id: number): Promise<boolean> {
    const principal = getCurrentPrincipalOrSystem();
    const deleted = await db.transaction(async tx => {
      const [project] = await tx.select({ id: projects.id }).from(projects).where(
        combineWithProjectAccess(principal, "admin", eq(projects.id, id)),
      ).limit(1);
      if (!project) return false;
      await objectGrantService.revokeObjectGrantsInTransaction(tx, { objectType: "project", objectId: id });
      const milestonesToDelete = await tx.select({ id: milestoneRows.id }).from(milestoneRows).where(
        eq(milestoneRows.projectId, id),
      );
      for (const milestone of milestonesToDelete) {
        await objectGrantService.revokeObjectGrantsInTransaction(tx, {
          objectType: "milestone",
          objectId: milestone.id,
          projectId: id,
        });
      }
      const rows = await tx.delete(projects).where(
        combineWithProjectAccess(principal, "admin", eq(projects.id, id)),
      ).returning({ id: projects.id });
      return rows.length > 0;
    });
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
