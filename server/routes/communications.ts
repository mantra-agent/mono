import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { createLogger } from "../log";
import {
  createAudience,
  createCampaign,
  deleteAudience,
  deleteCampaign,
  listAudiences,
  listCampaigns,
  updateAudience,
  updateCampaign,
} from "../communications-storage";

const log = createLogger("CommunicationsRoutes");

const createAudienceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  personIds: z.array(z.string().min(1)).max(500).optional(),
});
const updateAudienceSchema = createAudienceSchema.partial().extend({
  status: z.enum(["active", "archived"]).optional(),
});
const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  audienceId: z.string().min(1).nullable().optional(),
});
const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  audienceId: z.string().min(1).nullable().optional(),
  senderName: z.string().trim().min(1).max(120).optional(),
  senderEmail: z.string().trim().email().optional(),
  replyToEmail: z.string().trim().email().optional(),
  subject: z.string().max(300).optional(),
  body: z.string().max(100_000).optional(),
  status: z.literal("draft").optional(),
});

function fail(res: import("express").Response, error: unknown, operation: string) {
  const message = error instanceof Error ? error.message : String(error);
  log.error(`${operation} failed`, { message });
  res.status(400).json({ error: message, operation });
}

export function registerCommunicationRoutes(app: Express) {
  app.use("/api/communications", requireAuth, requirePermission("system:read"));

  app.get("/api/communications/audiences", async (_req, res) => {
    try { res.json({ audiences: await listAudiences() }); }
    catch (error) { fail(res, error, "list_audiences"); }
  });
  app.post("/api/communications/audiences", requirePermission("system:write"), async (req, res) => {
    try { res.status(201).json(await createAudience(createAudienceSchema.parse(req.body))); }
    catch (error) { fail(res, error, "create_audience"); }
  });
  app.patch("/api/communications/audiences/:id", requirePermission("system:write"), async (req, res) => {
    try {
      const updated = await updateAudience(req.params.id, updateAudienceSchema.parse(req.body));
      if (!updated) return res.status(404).json({ error: "Audience not found" });
      res.json(updated);
    } catch (error) { fail(res, error, "update_audience"); }
  });
  app.delete("/api/communications/audiences/:id", requirePermission("system:write"), async (req, res) => {
    try {
      const deleted = await deleteAudience(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Audience not found" });
      res.json(deleted);
    } catch (error) { fail(res, error, "delete_audience"); }
  });

  app.get("/api/communications/campaigns", async (_req, res) => {
    try { res.json({ campaigns: await listCampaigns() }); }
    catch (error) { fail(res, error, "list_campaigns"); }
  });
  app.post("/api/communications/campaigns", requirePermission("system:write"), async (req, res) => {
    try { res.status(201).json(await createCampaign(createCampaignSchema.parse(req.body))); }
    catch (error) { fail(res, error, "create_campaign"); }
  });
  app.patch("/api/communications/campaigns/:id", requirePermission("system:write"), async (req, res) => {
    try {
      const updated = await updateCampaign(req.params.id, updateCampaignSchema.parse(req.body));
      if (!updated) return res.status(404).json({ error: "Campaign not found" });
      res.json(updated);
    } catch (error) { fail(res, error, "update_campaign"); }
  });
  app.delete("/api/communications/campaigns/:id", requirePermission("system:write"), async (req, res) => {
    try {
      const deleted = await deleteCampaign(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Campaign not found" });
      res.json(deleted);
    } catch (error) { fail(res, error, "delete_campaign"); }
  });
}
