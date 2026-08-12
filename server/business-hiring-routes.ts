import type { Express, Response } from "express";
import { ZodError } from "zod";
import { hiringSlotCreateSchema, hiringSlotUpdateSchema } from "@shared/models/business-hiring";
import { businessHiringStorage } from "./business-hiring-storage";
import { requirePermission } from "./permissions";
import { createLogger } from "./log";

const log = createLogger("BusinessHiringRoutes");
function handle(res: Response, operation: string, error: unknown): void {
  const explicit = (error as { status?: unknown })?.status;
  const status = error instanceof ZodError ? 400 : typeof explicit === "number" ? explicit : 500;
  const detail = { status, code: (error as { code?: unknown })?.code };
  if (status >= 500) log.error(`${operation} failed`, detail); else log.warn(`${operation} rejected`, detail);
  res.status(status).json({ error: error instanceof Error ? error.message : "Hiring operation failed" });
}
export function registerBusinessHiringRoutes(app: Express): void {
  app.get("/api/business/hiring", requirePermission("system:read"), async (req, res) => {
    try { const businessId = String(req.query.businessId ?? "").trim(); if (!businessId) return res.status(400).json({ error: "businessId is required" }); res.json(await businessHiringStorage.plan(businessId)); } catch (error) { handle(res, "read hiring plan", error); }
  });
  app.post("/api/business/hiring/adopt", requirePermission("system:write"), async (req, res) => {
    try { const businessId = String(req.body?.businessId ?? "").trim(); if (!businessId) return res.status(400).json({ error: "businessId is required" }); await businessHiringStorage.adoptLegacy(businessId); res.json(await businessHiringStorage.projection(businessId)); } catch (error) { handle(res, "adopt legacy hiring plan", error); }
  });
  app.post("/api/business/hiring/slots", requirePermission("system:write"), async (req, res) => {
    try { res.status(201).json(await businessHiringStorage.create(hiringSlotCreateSchema.parse(req.body ?? {}))); } catch (error) { handle(res, "create hiring slot", error); }
  });
  app.patch("/api/business/hiring/slots/:id", requirePermission("system:write"), async (req, res) => {
    try { res.json(await businessHiringStorage.update(req.params.id, hiringSlotUpdateSchema.parse(req.body ?? {}))); } catch (error) { handle(res, "update hiring slot", error); }
  });
  app.delete("/api/business/hiring/slots/:id", requirePermission("system:write"), async (req, res) => {
    try { const businessId = String(req.query.businessId ?? "").trim(); if (!businessId) return res.status(400).json({ error: "businessId is required" }); res.json(await businessHiringStorage.cancel(businessId, req.params.id)); } catch (error) { handle(res, "cancel hiring slot", error); }
  });
}
