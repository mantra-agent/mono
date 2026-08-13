import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { requireCurrentPrincipal } from "../principal-context";
import { requireModRouteGroup } from "../mods/mod-access";
import { createInstallation, listOwnedInstallations, listOwnedMappings, setInstallationEnabled, upsertPrincipalMapping } from "./storage";

const idPattern = /^[A-Z0-9]{2,32}$/;
const createSchema = z.object({
  platformEnvironmentId: z.number().int().positive(),
  providerConnectionId: z.number().int().positive(),
  teamId: z.string().regex(idPattern),
  apiAppId: z.string().regex(idPattern),
  botUserId: z.string().regex(idPattern),
  vaultId: z.string().min(1).max(128),
  allowedChannelId: z.string().regex(idPattern).optional(),
}).strict();
const mappingSchema = z.object({
  slackUserId: z.string().regex(idPattern),
  mantraUserId: z.string().min(1).max(128),
}).strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();

export function registerSlackRoutes(app: Express): void {
  const gates = [requireAuth, requireModRouteGroup("slack.api"), requirePermission("mods:manage")];

  app.get("/api/slack/installations", ...gates, async (_req, res) => {
    const principal = requireCurrentPrincipal();
    const [rows, mappings] = await Promise.all([listOwnedInstallations(principal), listOwnedMappings(principal)]);
    res.json(rows.map((row) => ({
      ...row,
      mappings: mappings
        .filter((mapping) => mapping.installationId === row.id)
        .map(({ slackUserId, mantraUserId, active }) => ({ slackUserId, mantraUserId, active })),
    })));
  });

  app.post("/api/slack/installations", ...gates, async (req, res) => {
    try {
      const installation = await createInstallation(requireCurrentPrincipal(), createSchema.parse(req.body));
      res.status(201).json(installation);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Slack installation could not be created" });
    }
  });

  app.put("/api/slack/installations/:id/enabled", ...gates, async (req, res) => {
    try {
      const { enabled } = enabledSchema.parse(req.body);
      res.json(await setInstallationEnabled(requireCurrentPrincipal(), req.params.id, enabled));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Slack installation could not be updated" });
    }
  });

  app.put("/api/slack/installations/:id/mappings", ...gates, async (req, res) => {
    try {
      const mapping = mappingSchema.parse(req.body);
      await upsertPrincipalMapping(requireCurrentPrincipal(), { installationId: req.params.id, ...mapping });
      res.status(204).end();
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Slack mapping could not be updated" });
    }
  });
}
