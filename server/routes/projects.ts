// Use createLogger for logging ONLY
import type { Express } from "express";
import { WORKSPACE_DIR } from "../paths";
import { writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";
import { fileProjectStorage } from "../file-storage/projects";
import { fileTaskStorage } from "../file-storage/tasks";
import { insertTaskSchema, insertProjectSchema } from "@shared/models/work";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { parsePlanFromContent } from "../lib/plan-utils";
import { db } from "../db";
import { libraryPages } from "@shared/models/info";
import { planExecutions, planStepAttempts, planSteps } from "@shared/schema";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { logPatchClearAudit, sanitizePatch } from "../lib/patch-guard";
import { combineWithVisibleScope, combineWithWritableScope, ownedInsertValues } from "../scoped-storage";
import { eq, desc, ilike, type SQL } from "drizzle-orm";

const log = createLogger("WorkRoutes");
const planScopeColumns = { ownerUserId: planExecutions.ownerUserId, accountId: planExecutions.accountId };
const planStepScopeColumns = { ownerUserId: planSteps.ownerUserId, accountId: planSteps.accountId };
const planAttemptScopeColumns = { ownerUserId: planStepAttempts.ownerUserId, accountId: planStepAttempts.accountId };
const libraryScopeColumns = { scope: libraryPages.scope, ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, vaultId: libraryPages.vaultId };
function visiblePlan(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planScopeColumns, predicate); }
function writablePlan(predicate?: SQL): SQL { return combineWithWritableScope(getCurrentPrincipalOrSystem(), planScopeColumns, predicate); }
function visiblePlanStep(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planStepScopeColumns, predicate); }
function visiblePlanAttempt(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), planAttemptScopeColumns, predicate); }
function visibleLibrary(predicate?: SQL): SQL { return combineWithVisibleScope(getCurrentPrincipalOrSystem(), libraryScopeColumns, predicate); }

function routeError(error: unknown, operation: string): { message: string; operation: string } {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${operation} failed: ${message}`);
  return { message, operation };
}

export async function registerProjectsRoutes(app: Express) {
  app.use("/api/projects", requireAuth);

  app.get("/api/projects/todo", async (_req, res) => {
    try {
      const rawTasks = await fileTaskStorage.getTodoTasks();
      const tasks = await Promise.all(rawTasks.map(async t => {
        let projectTitle: string | null = null;
        let milestoneTitle: string | null = null;
        let milestoneDueDate: string | null = null;
        if (t.projectId) {
          const proj = await fileProjectStorage.getProject(t.projectId);
          if (proj) {
            projectTitle = proj.title;
            if (t.milestoneId && proj.milestones) {
              const ms = proj.milestones.find(m => m.id === t.milestoneId);
              if (ms) {
                milestoneTitle = ms.name;
                milestoneDueDate = ms.dueDate || null;
              }
            }
          }
        }
        return { ...t, projectTitle, milestoneTitle, milestoneDueDate };
      }));
      res.json(tasks);
    } catch (error: unknown) {
      const err = routeError(error, "list_todo_tasks");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/projects/tasks", async (req, res) => {
    try {
      const { status, projectId } = req.query;
      const options: any = {};
      if (status) options.status = String(status);
      if (projectId) options.projectId = parseInt(String(projectId), 10);
      const tasks = await fileTaskStorage.getTasks(options);
      res.json(tasks);
    } catch (error: unknown) {
      const err = routeError(error, "list_tasks");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/projects/tasks/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const task = await fileTaskStorage.getTask(id);
      if (!task) return res.status(404).json({ error: `Task ${id} not found`, operation: "get_task" });
      res.json(task);
    } catch (error: unknown) {
      const err = routeError(error, "get_task");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/projects/tasks", async (req, res) => {
    try {
      const parsed = insertTaskSchema.parse(req.body);
      const task = await fileTaskStorage.createTask(parsed);
      res.status(201).json(task);
    } catch (error: unknown) {
      const err = routeError(error, "create_task");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.patch("/api/projects/tasks/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { patch: updates, clearFields, destructiveUpdateReason } = sanitizePatch(req.body, {
        protectedFields: ['title', 'description', 'context', 'output', 'deadline', 'projectId', 'milestoneId'] as Array<keyof any>,
        clearableFields: ['description', 'context', 'output', 'deadline', 'projectId', 'milestoneId'] as Array<keyof any>,
        destructiveFields: ['description'] as Array<keyof any>,
      });
      for (const field of clearFields) {
        (updates as Record<string, unknown>)[field as string] = null;
      }
      logPatchClearAudit(log, {
        operation: "route.update_task",
        entityType: "task",
        entityId: id,
        clearFields,
        destructiveUpdateReason,
      });
      const task = await fileTaskStorage.updateTask(id, updates);
      if (!task) return res.status(404).json({ error: `Task ${id} not found`, operation: "update_task" });
      res.json(task);
    } catch (error: unknown) {
      const err = routeError(error, "update_task");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/projects/tasks/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const deleted = await fileTaskStorage.deleteTask(id);
      if (!deleted) return res.status(404).json({ error: `Task ${id} not found`, operation: "delete_task" });
      res.json({ success: true });
    } catch (error: unknown) {
      const err = routeError(error, "delete_task");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/projects/projects", async (req, res) => {
    try {
      const { status } = req.query;
      const options: any = {};
      if (status) options.status = String(status);
      const projects = await fileProjectStorage.getProjects(options);
      res.json(projects);
    } catch (error: unknown) {
      const err = routeError(error, "list_projects");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/projects/projects/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const project = await fileProjectStorage.getProject(id);
      if (!project) return res.status(404).json({ error: `Project ${id} not found`, operation: "get_project" });
      res.json(project);
    } catch (error: unknown) {
      const err = routeError(error, "get_project");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/projects/projects", async (req, res) => {
    try {
      const parsed = insertProjectSchema.parse(req.body);
      const project = await fileProjectStorage.createProject(parsed);
      res.status(201).json(project);
    } catch (error: unknown) {
      const err = routeError(error, "create_project");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.patch("/api/projects/projects/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { patch: updates, clearFields, destructiveUpdateReason } = sanitizePatch(req.body, {
        protectedFields: ['title', 'description', 'spec'] as Array<keyof any>,
        clearableFields: ['description', 'spec'] as Array<keyof any>,
        destructiveFields: ['description'] as Array<keyof any>,
      });
      for (const field of clearFields) {
        (updates as Record<string, unknown>)[field as string] = null;
      }
      logPatchClearAudit(log, {
        operation: "route.update_project",
        entityType: "project",
        entityId: id,
        clearFields,
        destructiveUpdateReason,
      });
      const project = await fileProjectStorage.updateProject(id, updates);
      if (!project) return res.status(404).json({ error: `Project ${id} not found`, operation: "update_project" });
      res.json(project);
    } catch (error: unknown) {
      const err = routeError(error, "update_project");
      res.status(400).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/projects/projects/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const deleted = await fileProjectStorage.deleteProject(id);
      if (!deleted) return res.status(404).json({ error: `Project ${id} not found`, operation: "delete_project" });
      res.json({ success: true });
    } catch (error: unknown) {
      const err = routeError(error, "delete_project");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });


  app.post("/api/projects/projects/:id/milestones", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { name, status, startDate, dueDate } = req.body;
      if (!name) return res.status(400).json({ error: "Milestone name is required", operation: "add_milestone" });
      const project = await fileProjectStorage.addMilestone(id, { name, status, startDate, dueDate });
      if (!project) return res.status(404).json({ error: `Project ${id} not found`, operation: "add_milestone" });
      res.json(project);
    } catch (error: unknown) {
      const err = routeError(error, "add_milestone");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.patch("/api/projects/projects/:id/milestones/:milestoneId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const milestoneId = parseInt(req.params.milestoneId, 10);
      const project = await fileProjectStorage.updateMilestone(id, milestoneId, req.body);
      if (!project) return res.status(404).json({ error: `Project ${id} or milestone ${milestoneId} not found`, operation: "update_milestone" });
      res.json(project);
    } catch (error: unknown) {
      const err = routeError(error, "update_milestone");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/projects/projects/:id/milestones/:milestoneId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const milestoneId = parseInt(req.params.milestoneId, 10);
      const project = await fileProjectStorage.removeMilestone(id, milestoneId);
      if (!project) return res.status(404).json({ error: `Project ${id} or milestone ${milestoneId} not found`, operation: "remove_milestone" });
      res.json(project);
    } catch (error: unknown) {
      const err = routeError(error, "remove_milestone");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });


  app.post("/api/projects/projects/:id/pages", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { pageId, title, slug } = req.body;
      if (!pageId || typeof pageId !== "string") return res.status(400).json({ error: "Page id is required", operation: "add_page" });
      if (!title || typeof title !== "string") return res.status(400).json({ error: "Page title is required", operation: "add_page" });
      const project = await fileProjectStorage.addPage(id, {
        id: pageId,
        title,
        slug: typeof slug === "string" ? slug : undefined,
        addedAt: new Date().toISOString(),
      });
      if (!project) return res.status(404).json({ error: `Project ${id} not found`, operation: "add_page" });
      res.json(project);
    } catch (error: unknown) {
      const err = routeError(error, "add_page");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });


  const MAX_TEXT_SYNC_SIZE = 2 * 1024 * 1024;

  function sanitizeFilename(name: string): string {
    const basename = name.split("/").pop()?.split("\\").pop() || "unnamed";
    return basename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  }

  function projectFileDir(projectId: number): string {
    return join(WORKSPACE_DIR, "project-files", `project-${projectId}`);
  }

  async function syncProjectFileToWorkspace(
    projectId: number,
    _projectTitle: string,
    file: { name: string; mimeType: string; objectKey: string; size: number }
  ): Promise<void> {
    const { promises: fs } = await import("fs");
    const { join } = await import("path");
    const dir = projectFileDir(projectId);
    await fs.mkdir(dir, { recursive: true });
    const safeName = sanitizeFilename(file.name);

    const isTextMime = /^(text\/|application\/(json|xml|yaml|javascript|typescript|markdown|x-yaml))/.test(file.mimeType)
      || /\.(md|txt|json|yaml|yml|csv|xml|js|ts|py|sh|html|css|toml|ini|cfg|log|rst|tex)$/i.test(file.name);

    if (isTextMime && file.size <= MAX_TEXT_SYNC_SIZE) {
      try {
        const { ObjectStorageService } = await import("../object_storage");
        const storageService = new ObjectStorageService();
        const objectFile = await storageService.getObjectEntityFile(file.objectKey);
        const [buf] = await objectFile.download();
        const content = buf.toString("utf-8");
        await fs.writeFile(join(dir, safeName), content, "utf-8");
        log.log(`Synced ${file.name} to workspace (${content.length} chars)`);
      } catch (err: unknown) {
        const stub = `# ${file.name}\n\nType: ${file.mimeType}\nSize: ${file.size} bytes\nStored in: object storage (${file.objectKey})\n\nThis file could not be read as text. Access it through the project files UI.`;
        await fs.writeFile(join(dir, safeName + ".ref.md"), stub, "utf-8");
        log.warn(`Wrote stub for ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      const stub = `# ${file.name}\n\nType: ${file.mimeType}\nSize: ${file.size} bytes\nStored in: object storage (${file.objectKey})\nUploaded: ${new Date().toISOString()}\n\nThis is a binary file. Access it through the project files UI or the /api/projects/projects/${projectId}/files endpoint.`;
      await fs.writeFile(join(dir, safeName + ".ref.md"), stub, "utf-8");
      log.log(`Wrote reference stub for binary ${file.name}`);
    }
  }

  app.post("/api/projects/projects/:id/files/upload-url", async (req, res) => {
    try {
      const { ObjectStorageService } = await import("../object_storage");
      const { extname } = await import("path");
      const storageService = new ObjectStorageService();
      const fileName = req.body?.name;
      const extension = fileName ? extname(fileName) : undefined;
      const uploadURL = await storageService.getObjectEntityUploadURL(
        extension || undefined,
        { owner: req.session.userId },
      );
      const objectPath = storageService.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath });
    } catch (error: unknown) {
      const err = routeError(error, "get_upload_url");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/projects/projects/:id/files", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { name, mimeType, objectKey, size } = req.body;
      if (!name || !objectKey) return res.status(400).json({ error: "File name and objectKey are required", operation: "add_file" });
      const fileId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const file = {
        id: fileId,
        name,
        mimeType: mimeType || "application/octet-stream",
        objectKey,
        size: size || 0,
        uploadedAt: new Date().toISOString(),
      };
      const project = await fileProjectStorage.addFile(id, file);
      if (!project) return res.status(404).json({ error: `Project ${id} not found`, operation: "add_file" });

      syncProjectFileToWorkspace(id, project.title, file).catch(err =>
        log.warn(`Workspace file sync degraded projectId=${id} fileId=${fileId} name=${name}: ${err instanceof Error ? err.message : String(err)}`)
      );

      res.json(project);
    } catch (error: unknown) {
      const err = routeError(error, "add_file");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.delete("/api/projects/projects/:id/files/:fileId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { fileId } = req.params;
      const project = await fileProjectStorage.getProject(id);
      const fileToRemove = project?.files.find(f => f.id === fileId);
      const removedFile = await fileProjectStorage.removeFile(id, fileId);
      if (!removedFile) return res.status(404).json({ error: `Project ${id} or file ${fileId} not found`, operation: "remove_file" });

      if (fileToRemove) {
        const { promises: fs } = await import("fs");
        const { join } = await import("path");
        const dir = projectFileDir(id);
        const safeName = sanitizeFilename(fileToRemove.name);
        const candidates = [
          join(dir, safeName),
          join(dir, safeName + ".ref.md"),
        ];
        for (const p of candidates) {
          try { await fs.unlink(p); } catch (err) { log.debug(`file cleanup skipped: ${p}`); }
        }
      }

      res.json({ success: true });
    } catch (error: unknown) {
      const err = routeError(error, "remove_file");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });


  app.get("/api/projects/tags", async (_req, res) => {
    try {
      const tasks = await fileTaskStorage.getTasks({});
      const tagSet: Record<string, boolean> = {};
      tasks.forEach(t => t.tags?.forEach((tag: string) => { tagSet[tag] = true; }));
      res.json(Object.keys(tagSet).sort());
    } catch (error: unknown) {
      const err = routeError(error, "list_tags");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/projects/context", async (_req, res) => {
    try {
      const rawTodo = await fileTaskStorage.getTodoTasks();
      const todoTasks = await Promise.all(rawTodo.map(async t => {
        let projectTitle: string | null = null;
        if (t.projectId) {
          const proj = await fileProjectStorage.getProject(t.projectId);
          if (proj) projectTitle = proj.title;
        }
        return { ...t, projectTitle };
      }));
      const upcomingProjects = await fileProjectStorage.getUpcomingDeadlines(14);
      res.json({ todoTasks, upcomingProjects });
    } catch (error: unknown) {
      const err = routeError(error, "get_work_context");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // ── Plan routes ──────────────────────────────────────────────────


  async function planSummaryFromPage(page: { id: string; title: string | null; slug: string | null; plainTextContent: string | null }) {
    const content = page.plainTextContent || "";
    const parsed = parsePlanFromContent(content);
    if (!parsed) return null;

    const dbPlan = await getPlanDbState(page.id);
    let effectiveSteps = parsed.meta.steps;
    let effectiveMeta = parsed.meta;
    if (dbPlan) {
      const dbSteps = await db.select().from(planSteps)
        .where(visiblePlanStep(eq(planSteps.planId, dbPlan.id)))
        .orderBy(planSteps.position);
      if (dbSteps.length > 0) {
        const attempts = await db.select().from(planStepAttempts)
          .where(visiblePlanAttempt(eq(planStepAttempts.planId, dbPlan.id)))
          .orderBy(planStepAttempts.stepId, planStepAttempts.attemptNumber);
        const attemptsByStep = new Map<string, typeof attempts[number][]>();
        for (const attempt of attempts) {
          const list = attemptsByStep.get(attempt.stepId) ?? [];
          list.push(attempt);
          attemptsByStep.set(attempt.stepId, list);
        }
        effectiveSteps = dbSteps.map(s => ({
          id: s.id,
          title: s.title,
          status: s.status as typeof parsed.meta.steps[number]["status"],
          duration: s.durationSeconds ?? undefined,
          outcome: s.outcome ?? undefined,
          error: s.error ?? undefined,
          sessionId: s.sessionId ?? undefined,
          attempts: (attemptsByStep.get(s.id) ?? []).map(attempt => ({
            id: attempt.id,
            attemptNumber: attempt.attemptNumber,
            childSessionId: attempt.childSessionId,
            status: attempt.status,
            startedAt: attempt.startedAt?.toISOString() ?? null,
            updatedAt: attempt.updatedAt?.toISOString() ?? null,
            completedAt: attempt.completedAt?.toISOString() ?? null,
            durationSeconds: attempt.durationSeconds,
            outcome: attempt.outcome,
            error: attempt.error,
          })),
          startedAt: s.startedAt?.toISOString(),
          completedAt: s.completedAt?.toISOString(),
        }));
      }
      effectiveMeta = {
        ...parsed.meta,
        id: dbPlan.id,
        status: dbPlan.status as typeof parsed.meta.status,
        updatedAt: dbPlan.updatedAt.toISOString(),
        originSessionId: dbPlan.originSessionId,
        goalId: dbPlan.goalId ?? undefined,
        projectId: dbPlan.projectId ?? undefined,
        workspace: dbPlan.workspace ?? undefined,
        workspaceDir: dbPlan.workspaceDir ?? undefined,
        blocking: dbPlan.blocking,
        steps: effectiveSteps,
      };
    }

    return {
      id: effectiveMeta.id,
      pageId: page.id,
      pageSlug: page.slug || "",
      title: (page.title || "Untitled Plan").replace(/^Plan:\s*/i, ""),
      status: effectiveMeta.status,
      archivedAt: dbPlan?.archivedAt?.toISOString() ?? null,
      steps: effectiveSteps.map(s => ({
        ...s,
        sessions: s.sessionId ? [{ id: s.sessionId, role: "primary" }] : [],
      })),
      blocking: effectiveMeta.blocking,
      originSessionId: effectiveMeta.originSessionId,
      createdAt: effectiveMeta.createdAt,
      updatedAt: effectiveMeta.updatedAt,
    };
  }

  app.get("/api/plans", async (_req, res) => {
    try {
      const pages = await db.select({
        id: libraryPages.id,
        title: libraryPages.title,
        slug: libraryPages.slug,
        plainTextContent: libraryPages.plainTextContent,
        createdAt: libraryPages.createdAt,
        updatedAt: libraryPages.updatedAt,
      }).from(libraryPages).where(
        visibleLibrary(ilike(libraryPages.plainTextContent, "%plan:%")),
      ).orderBy(desc(libraryPages.updatedAt)).limit(100);

      const active: any[] = [];
      const completed: any[] = [];
      const failed: any[] = [];
      const archived: any[] = [];

      for (const page of pages) {
        const summary = await planSummaryFromPage(page);
        if (!summary) continue;

        if (summary.archivedAt) {
          archived.push(summary);
        } else if (summary.status === "created" || summary.status === "executing" || summary.status === "paused" || summary.status === "needs_review") {
          active.push(summary);
        } else if (summary.status === "failed" || summary.status === "aborted") {
          failed.push(summary);
        } else {
          completed.push(summary);
        }
      }

      res.json({ active, completed, failed, archived });
    } catch (error: unknown) {
      const err = routeError(error, "list_plans");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.get("/api/plans/:id", async (req, res) => {
    try {
      const idParam = req.params.id;
      const byId = await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.id, idParam)));
      let page = byId[0] || (await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.slug, idParam))))[0];

      // Fallback: idParam might be an internal plan_executions DB ID
      if (!page) {
        const planRow = await db.select({ pageId: planExecutions.pageId })
          .from(planExecutions).where(visiblePlan(eq(planExecutions.id, idParam))).then(r => r[0]);
        if (planRow?.pageId) {
          page = (await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.id, planRow.pageId))))[0];
        }
      }

      if (!page) return res.status(404).json({ error: "Plan not found" });

      const summary = await planSummaryFromPage(page);
      if (!summary) return res.status(404).json({ error: "Page does not contain plan data" });
      res.json(summary);
    } catch (error: unknown) {
      const err = routeError(error, "get_plan");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  // ─── Plan DB status lookup ──────────────────────────────────────────
  // The Library page YAML is a rendered view; planExecutions is the source of truth.
  async function getPlanDbState(pageId: string) {
    const rows = await db.select().from(planExecutions)
      .where(visiblePlan(eq(planExecutions.pageId, pageId)));
    return rows[0] ?? null;
  }


  app.delete("/api/sessions/:id/plan", async (req, res) => {
    try {
      const sessionId = req.params.id;
      const TERMINAL_PLAN_STATUSES = ["completed", "completed_with_failures", "failed", "aborted"];
      const rows = await db.select().from(planExecutions)
        .where(visiblePlan(eq(planExecutions.originSessionId, sessionId)))
        .orderBy(desc(planExecutions.createdAt));

      const active = rows.find(p => !TERMINAL_PLAN_STATUSES.includes(p.status));
      if (!active) return res.status(404).json({ error: "No active plan is linked with this session." });
      if (active.status === "executing") {
        return res.status(409).json({ error: "Cannot remove a running plan from a session — pause it first." });
      }

      await db.update(planExecutions)
        .set({ originSessionId: `unlinked:${sessionId}:${active.id}`, updatedAt: new Date() })
        .where(writablePlan(eq(planExecutions.id, active.id)));

      res.json({ ok: true, planId: active.id, pageId: active.pageId });
    } catch (error: unknown) {
      const err = routeError(error, "unlink_session_plan");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/plans/:id/execute", async (req, res) => {
    try {
      const pageId = req.params.id;
      const byId = await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.id, pageId)));
      const page = byId[0] || (await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.slug, pageId))))[0];

      if (!page) return res.status(404).json({ error: "Plan not found" });

      // Check DB status (source of truth), fall back to YAML for first-time executions
      const dbPlan = await getPlanDbState(page.id);
      const dbStatus = dbPlan?.status;
      const content = page.plainTextContent || "";
      const parsed = parsePlanFromContent(content);
      if (!parsed) return res.status(404).json({ error: "Page does not contain plan data" });

      const effectiveStatus = dbStatus ?? parsed.meta.status;
      if (effectiveStatus !== "created" && effectiveStatus !== "paused" && effectiveStatus !== "needs_review") {
        return res.status(409).json({ error: `Plan status is "${effectiveStatus}" — can only execute created, paused, or review-pending plans.` });
      }

      const internalId = dbPlan?.id ?? parsed.meta.id;
      const originSession = dbPlan?.originSessionId ?? parsed.meta.originSessionId;
      const planTitle = (page.title || "Untitled Plan").replace(/^Plan:\s*/, "");
      const { executePlan } = await import("../plan-executor");

      // Always non-blocking from REST — the UI handles progress via WebSocket
      executePlan(internalId, originSession, planTitle, false).catch(err => {
        log.error(`Plan ${internalId} execution failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      res.json({ ok: true, status: "executing" });
    } catch (error: unknown) {
      const err = routeError(error, "execute_plan");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/plans/:id/pause", async (req, res) => {
    try {
      const pageId = req.params.id;
      const byId = await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.id, pageId)));
      const page = byId[0] || (await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.slug, pageId))))[0];

      if (!page) return res.status(404).json({ error: "Plan not found" });

      // Use DB for internal plan ID and status
      const dbPlan = await getPlanDbState(page.id);
      if (!dbPlan) {
        const content = page.plainTextContent || "";
        const parsed = parsePlanFromContent(content);
        const fallbackId = parsed?.meta.id;
        if (!fallbackId) return res.status(404).json({ error: "Plan execution record not found" });
        return res.json({ ok: true, status: parsed!.meta.status });
      }

      const { pausePlan, isExecuting } = await import("../plan-executor");
      if (isExecuting(dbPlan.id)) {
        pausePlan(dbPlan.id);
        res.json({ ok: true, status: "pause_requested" });
      } else {
        res.json({ ok: true, status: dbPlan.status });
      }
    } catch (error: unknown) {
      const err = routeError(error, "pause_plan");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/plans/:id/resume", async (req, res) => {
    try {
      const pageId = req.params.id;
      const byId = await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.id, pageId)));
      const page = byId[0] || (await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.slug, pageId))))[0];

      if (!page) return res.status(404).json({ error: "Plan not found" });

      // Check DB status (source of truth) instead of YAML frontmatter
      const dbPlan = await getPlanDbState(page.id);
      if (!dbPlan) {
        return res.status(404).json({ error: "Plan execution record not found in database" });
      }

      const planTitle = (page.title || "Untitled Plan").replace(/^Plan:\s*/, "");
      const { preparePlanForResume, resumePlan } = await import("../plan-executor");
      const readiness = await preparePlanForResume(dbPlan.id);

      if (!readiness.ready) {
        return res.status(409).json({
          error: readiness.error,
          status: readiness.status,
          recovered: readiness.recovered,
        });
      }

      resumePlan(readiness.planId, dbPlan.originSessionId, planTitle, false).catch(err => {
        log.error(`Plan ${readiness.planId} resume failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      res.json({ ok: true, status: "executing", recovered: readiness.recovered });
    } catch (error: unknown) {
      const err = routeError(error, "resume_plan");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

  app.post("/api/plans/:id/archive", async (req, res) => {
    try {
      const pageId = req.params.id;
      const byId = await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.id, pageId)));
      const page = byId[0] || (await db.select().from(libraryPages).where(visibleLibrary(eq(libraryPages.slug, pageId))))[0];

      if (!page) return res.status(404).json({ error: "Plan not found" });

      // Check DB status (source of truth)
      const dbPlan = await getPlanDbState(page.id);
      const content = page.plainTextContent || "";
      const parsed = parsePlanFromContent(content);
      if (!parsed) return res.status(404).json({ error: "Page does not contain plan data" });

      const effectiveStatus = dbPlan?.status ?? parsed.meta.status;

      // Can't archive a plan that's actively executing
      if (effectiveStatus === "executing") {
        return res.status(409).json({ error: "Cannot archive a running plan — pause it first." });
      }

      const archivedAt = new Date();
      const internalId = dbPlan?.id ?? parsed.meta.id;

      if (dbPlan) {
        await db.update(planExecutions)
          .set({ archivedAt, updatedAt: archivedAt })
          .where(writablePlan(eq(planExecutions.id, internalId)));
      } else {
        await db.insert(planExecutions).values({
          id: internalId,
          ...ownedInsertValues(getCurrentPrincipalOrSystem(), planScopeColumns),
          pageId: page.id,
          status: parsed.meta.status,
          originSessionId: parsed.meta.originSessionId || "legacy",
          blocking: parsed.meta.blocking,
          workspace: parsed.meta.workspace,
          workspaceDir: parsed.meta.workspaceDir,
          goalId: parsed.meta.goalId,
          projectId: parsed.meta.projectId,
          archivedAt,
          updatedAt: archivedAt,
        }).onConflictDoUpdate({
          target: planExecutions.id,
          set: { archivedAt, updatedAt: archivedAt },
        });
      }

      res.json({ ok: true, status: effectiveStatus, archivedAt: archivedAt.toISOString() });
    } catch (error: unknown) {
      const err = routeError(error, "archive_plan");
      res.status(500).json({ error: err.message, operation: err.operation });
    }
  });

}
