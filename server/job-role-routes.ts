import type { Express, Request, Response } from "express";
import { ZodError } from "zod";
import { requireAuth } from "./auth";
import { requirePermission } from "./permissions";
import { jobRoleStorage } from "./job-role-storage";
import { jobRoleCreateSchema, jobRoleUpdateSchema } from "@shared/models/job-roles";
import { createLogger } from "./log";

const log = createLogger("JobRoleRoutes");

function statusOf(error: unknown): number {
  if (error instanceof ZodError) return 400;
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function messageOf(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "23505") return "A role with this title already exists";
  if (code === "JOB_ROLE_IN_USE" || code === "23503") {
    return error instanceof Error && error.message
      ? error.message
      : "Cannot delete job role while hiring slots still reference it";
  }
  return error instanceof Error ? error.message : "Job role operation failed";
}

function handleError(res: Response, operation: string, error: unknown): void {
  const status = statusOf(error);
  const context = { status, code: (error as { code?: unknown })?.code };
  if (status >= 500) {
    log.error(`${operation} failed`, context);
  } else {
    log.warn(`${operation} rejected`, context);
  }
  res.status(status).json({ error: messageOf(error) });
}

export function registerJobRoleRoutes(app: Express): void {
  app.get("/api/business/roles", requireAuth, requirePermission("system:read"), async (req: Request, res: Response) => {
    try {
      const query = typeof req.query.query === "string" ? req.query.query : undefined;
      res.json({ roles: await jobRoleStorage.list({ query, limit: 200 }) });
    } catch (error) {
      handleError(res, "list job roles", error);
    }
  });

  app.get("/api/business/roles/:id", requireAuth, requirePermission("system:read"), async (req: Request, res: Response) => {
    try {
      res.json(await jobRoleStorage.get(req.params.id));
    } catch (error) {
      handleError(res, "get job role", error);
    }
  });

  app.post("/api/business/roles", requireAuth, requirePermission("system:write"), async (req: Request, res: Response) => {
    try {
      const role = await jobRoleStorage.create(jobRoleCreateSchema.parse(req.body ?? {}));
      log.info("job role created", { roleId: role.id });
      res.status(201).json(role);
    } catch (error) {
      handleError(res, "create job role", error);
    }
  });

  app.patch("/api/business/roles/:id", requireAuth, requirePermission("system:write"), async (req: Request, res: Response) => {
    try {
      const role = await jobRoleStorage.update(req.params.id, jobRoleUpdateSchema.parse(req.body ?? {}));
      log.info("job role updated", { roleId: role.id });
      res.json(role);
    } catch (error) {
      handleError(res, "update job role", error);
    }
  });

  app.delete("/api/business/roles/:id", requireAuth, requirePermission("system:write"), async (req: Request, res: Response) => {
    try {
      const role = await jobRoleStorage.delete(req.params.id);
      log.info("job role deleted", { roleId: role.id });
      res.json({ deleted: true, role });
    } catch (error) {
      handleError(res, "delete job role", error);
    }
  });
}
