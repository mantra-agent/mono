import type { Express, Response } from "express";
import { businessBudgetMutationSchema } from "@shared/models/business-budgets";
import { businessBudgetStorage } from "./business-budget-storage";
import { createLogger } from "./log";
import { requirePermission } from "./permissions";

const log = createLogger("BusinessBudgetRoutes");

function parseBusinessId(query: Record<string, unknown>): string {
  const businessId = typeof query.businessId === "string" ? query.businessId.trim() : "";
  if (!businessId) throw Object.assign(new Error("businessId is required"), { status: 400 });
  return businessId;
}

function sendFailure(res: Response, error: unknown): void {
  const status = typeof (error as { status?: number })?.status === "number" ? (error as { status: number }).status : 400;
  log.error("Business budget request failed", { status, error: error instanceof Error ? error.message : String(error) });
  res.status(status).json({ error: error instanceof Error ? error.message : "Business budget request failed" });
}

export function registerBusinessBudgetRoutes(app: Express): void {
  app.get("/api/business/budgets", requirePermission("system:read"), async (req, res) => {
    try {
      res.json(await businessBudgetStorage.getOrCreate(parseBusinessId(req.query)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.patch("/api/business/budgets", requirePermission("system:write"), async (req, res) => {
    try {
      const mutation = businessBudgetMutationSchema.parse(req.body ?? {});
      res.json(await businessBudgetStorage.mutate(parseBusinessId(req.query), mutation));
    } catch (error) {
      sendFailure(res, error);
    }
  });
}
