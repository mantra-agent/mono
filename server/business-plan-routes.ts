import type { Express, Response } from "express";
import { businessPlanCreateSchema, businessPlanPatchSchema } from "@shared/models/business-plans";
import { businessPlanStorage } from "./business-plan-storage";
import { createLogger } from "./log";
import { requirePermission } from "./permissions";

const log = createLogger("BusinessPlanRoutes");

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : 500;
}

function respondError(res: Response, operation: string, error: unknown): void {
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : "Request failed";
  const details = { status, message };
  if (status >= 500) log.error(`${operation} failed`, details);
  else log.warn(`${operation} rejected`, details);
  res.status(status).json({ error: message });
}

export function registerBusinessPlanRoutes(app: Express): void {
  app.get("/api/business/plans", requirePermission("system:read"), async (_req, res) => {
    try {
      res.json(await businessPlanStorage.list());
    } catch (error) {
      respondError(res, "list Business Plans", error);
    }
  });

  app.post("/api/business/plans", requirePermission("system:write"), async (req, res) => {
    const parsed = businessPlanCreateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid Business Plan" });
    try {
      res.status(201).json(await businessPlanStorage.create(parsed.data));
    } catch (error) {
      respondError(res, "create Business Plan", error);
    }
  });

  app.patch("/api/business/plans/:id", requirePermission("system:write"), async (req, res) => {
    const parsed = businessPlanPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid Business Plan update" });
    try {
      res.json(await businessPlanStorage.update(req.params.id, parsed.data));
    } catch (error) {
      respondError(res, "update Business Plan", error);
    }
  });
}
