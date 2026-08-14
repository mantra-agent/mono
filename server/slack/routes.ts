import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { requireCurrentPrincipal } from "../principal-context";
import { requireModRouteGroup } from "../mods/mod-access";
import { createInstallation, listOwnedInstallations, listOwnedMappings, setAllowedChannelName, setInstallationEnabled, upsertPrincipalMapping } from "./storage";

const slackId = (prefix: "T" | "A" | "U" | "C") =>
  z.string().regex(new RegExp(`^${prefix}[A-Z0-9]{1,31}$`));
const createSchema = z.object({
  platformEnvironmentId: z.number().int().positive(),
  providerConnectionId: z.number().int().positive(),
  teamId: slackId("T"),
  apiAppId: slackId("A"),
  botUserId: slackId("U"),
  vaultId: z.string().min(1).max(128),
  allowedChannelId: slackId("C").optional(),
  allowedChannelName: z.string().trim().min(1).max(80).regex(/^#?[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/).optional(),
}).strict();
const channelNameSchema = z.object({
  allowedChannelName: z.string().trim().min(1).max(80).regex(/^#?[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
}).strict();
const mappingSchema = z.object({
  slackUserId: slackId("U"),
  mantraUserId: z.string().min(1).max(128),
}).strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();

const PUBLIC_SLACK_ERRORS = new Set([
  "Slack installation authority prerequisites are not satisfied",
  "Slack installation not found",
  "Slack mapping authority prerequisites are not satisfied",
]);

function publicSlackError(error: unknown, fallback: string): string {
  if (error instanceof z.ZodError) {
    if (error.issues.some((issue) => issue.path.includes("allowedChannelName"))) {
      return "Channel name looks like eng or #eng";
    }
    return "Team, App, Bot, Channel, and User IDs must look like T… / A… / U… / C…";
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505") {
    return "A Slack installation for this team and app already exists on that environment";
  }
  if (error instanceof Error && PUBLIC_SLACK_ERRORS.has(error.message)) return error.message;
  return fallback;
}

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
      res.status(400).json({ error: publicSlackError(error, "Slack installation could not be created") });
    }
  });

  app.put("/api/slack/installations/:id/channel-name", ...gates, async (req, res) => {
    try {
      const { allowedChannelName } = channelNameSchema.parse(req.body);
      res.json(await setAllowedChannelName(requireCurrentPrincipal(), req.params.id, allowedChannelName));
    } catch (error) {
      res.status(400).json({ error: publicSlackError(error, "Slack channel name could not be updated") });
    }
  });

  app.put("/api/slack/installations/:id/enabled", ...gates, async (req, res) => {
    try {
      const { enabled } = enabledSchema.parse(req.body);
      res.json(await setInstallationEnabled(requireCurrentPrincipal(), req.params.id, enabled));
    } catch (error) {
      res.status(400).json({ error: publicSlackError(error, "Slack installation could not be updated") });
    }
  });

  app.put("/api/slack/installations/:id/mappings", ...gates, async (req, res) => {
    try {
      const mapping = mappingSchema.parse(req.body);
      await upsertPrincipalMapping(requireCurrentPrincipal(), { installationId: req.params.id, ...mapping });
      res.status(204).end();
    } catch (error) {
      res.status(400).json({ error: publicSlackError(error, "Slack mapping could not be updated") });
    }
  });
}
