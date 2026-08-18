import type { Express, Response } from "express";
import { businessPricingMutationSchema } from "@shared/models/business-pricing";
import { businessPricingStorage } from "./business-pricing-storage";
import { createLogger } from "./log";
import { requirePermission } from "./permissions";

const log = createLogger("BusinessPricingRoutes");

function parseBusinessId(query: Record<string, unknown>): string {
  const businessId = typeof query.businessId === "string" ? query.businessId.trim() : "";
  if (!businessId) throw Object.assign(new Error("businessId is required"), { status: 400 });
  return businessId;
}

function sendFailure(res: Response, error: unknown): void {
  const status = typeof (error as { status?: number })?.status === "number" ? (error as { status: number }).status : 400;
  if (status >= 500) log.error("Business pricing request failed", { status, error: error instanceof Error ? error.message : String(error) });
  else log.warn("Business pricing request rejected", { status, error: error instanceof Error ? error.message : String(error) });
  res.status(status).json({ error: error instanceof Error ? error.message : "Business pricing request failed" });
}

export function registerBusinessPricingRoutes(app: Express): void {
  app.get("/api/business/pricing", requirePermission("system:read"), async (req, res) => {
    try {
      res.json(await businessPricingStorage.getOrCreate(parseBusinessId(req.query)));
    } catch (error) {
      sendFailure(res, error);
    }
  });

  app.patch("/api/business/pricing", requirePermission("system:write"), async (req, res) => {
    try {
      const mutation = businessPricingMutationSchema.parse(req.body ?? {});
      res.json(await businessPricingStorage.mutate(parseBusinessId(req.query), mutation));
    } catch (error) {
      sendFailure(res, error);
    }
  });
}
