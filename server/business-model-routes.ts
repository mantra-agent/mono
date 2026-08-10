import type { Express } from "express";
import { requireAuth } from "./auth";
import { businessModelStorage } from "./business-model-storage";
import { assumptionsPatchSchema } from "@shared/models/business-model";
import { createLogger } from "./log";
import { requirePermission } from "./permissions";
import { requireModRouteGroup } from "./mods/mod-access";
const requireActiveBusiness = requireModRouteGroup("business.api", { failOpenWhenPlatformDisabled: true });

const log = createLogger("BusinessModelRoutes");

export function registerBusinessModelRoutes(app: Express): void {
  // Group gate for the entire /api/business/* surface (model, roles, metrics,
  // kpis). registerBusinessModelRoutes runs before the job-role and metrics
  // registrars, so this app.use covers those route files too. Mirrors the
  // Wellness `app.use("/api/wellness", requireAuth, requireActiveWellness)` seam.
  app.use("/api/business", requireAuth, requireActiveBusiness);

  // GET → get-or-create the selected Business's model with default assumptions.
  app.get("/api/business/model", requirePermission("system:read"), async (req, res) => {
    try {
      const businessId = typeof req.query.businessId === "string" ? req.query.businessId.trim() : "";
      if (!businessId) return res.status(400).json({ error: "businessId is required" });
      res.json(await businessModelStorage.getOrCreate(businessId));
    } catch (error) {
      const status = typeof (error as { status?: number })?.status === "number" ? (error as { status: number }).status : 500;
      log.error("get business model failed", { status, error: error instanceof Error ? error.message : String(error) });
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // PATCH → zod-validated partial assumptions update (omitted fields unchanged).
  app.patch("/api/business/model", requirePermission("system:write"), async (req, res) => {
    try {
      const businessId = typeof req.query.businessId === "string" ? req.query.businessId.trim() : "";
      if (!businessId) return res.status(400).json({ error: "businessId is required" });
      const patch = assumptionsPatchSchema.parse(req.body ?? {});
      res.json(await businessModelStorage.updateAssumptions(businessId, patch));
    } catch (error) {
      const status = typeof (error as { status?: number })?.status === "number" ? (error as { status: number }).status : 400;
      log.error("update business model failed", { status, error: error instanceof Error ? error.message : String(error) });
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
