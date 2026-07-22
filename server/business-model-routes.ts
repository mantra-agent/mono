import type { Express } from "express";
import { requireAuth } from "./auth";
import { businessModelStorage } from "./business-model-storage";
import { assumptionsPatchSchema } from "@shared/models/business-model";
import { createLogger } from "./log";

const log = createLogger("BusinessModelRoutes");

export function registerBusinessModelRoutes(app: Express): void {
  app.use("/api/business", requireAuth);

  // GET → get-or-create the principal's model with default assumptions.
  app.get("/api/business/model", async (_req, res) => {
    try {
      res.json(await businessModelStorage.getOrCreate());
    } catch (error) {
      log.error("get business model failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // PATCH → zod-validated partial assumptions update (omitted fields unchanged).
  app.patch("/api/business/model", async (req, res) => {
    try {
      const patch = assumptionsPatchSchema.parse(req.body ?? {});
      res.json(await businessModelStorage.updateAssumptions(patch));
    } catch (error) {
      const status = typeof (error as { status?: number })?.status === "number" ? (error as { status: number }).status : 400;
      log.error("update business model failed", error);
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
