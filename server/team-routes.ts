import type { Express, Response } from "express";
import { createLogger } from "./log";
import { teamService } from "./team-service";

const log = createLogger("TeamRoutes");

function handleError(res: Response, error: unknown, fallback: string) {
  const status = (error as { status?: number })?.status ?? 500;
  const message = error instanceof Error ? error.message : fallback;
  if (status >= 500) log.error(fallback, { error: message });
  res.status(status).json({ error: message });
}

/**
 * Team management routes. Teams are account-scoped grant subjects; every handler resolves the
 * caller's principal via teamService, which bounds all reads and writes to the caller's account.
 */
export function registerTeamRoutes(app: Express) {
  app.get("/api/teams", async (_req, res) => {
    try {
      res.json({ teams: await teamService.list() });
    } catch (error) {
      handleError(res, error, "Failed to list teams");
    }
  });

  app.post("/api/teams", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      res.status(201).json({ team: await teamService.create(name) });
    } catch (error) {
      handleError(res, error, "Failed to create team");
    }
  });

  app.patch("/api/teams/:teamId", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      res.json({ team: await teamService.rename(req.params.teamId, name) });
    } catch (error) {
      handleError(res, error, "Failed to rename team");
    }
  });

  app.delete("/api/teams/:teamId", async (req, res) => {
    try {
      await teamService.remove(req.params.teamId);
      res.json({ removed: true });
    } catch (error) {
      handleError(res, error, "Failed to remove team");
    }
  });

  app.get("/api/teams/:teamId/members", async (req, res) => {
    try {
      res.json({ members: await teamService.members(req.params.teamId) });
    } catch (error) {
      handleError(res, error, "Failed to list team members");
    }
  });

  app.post("/api/teams/:teamId/members", async (req, res) => {
    try {
      const email = typeof req.body?.email === "string" ? req.body.email : undefined;
      const userId = typeof req.body?.userId === "string" ? req.body.userId : undefined;
      const role = req.body?.role === "admin" ? "admin" : "member";
      await teamService.addMember(req.params.teamId, { email, userId, role });
      res.status(201).json({ added: true });
    } catch (error) {
      handleError(res, error, "Failed to add team member");
    }
  });

  app.delete("/api/teams/:teamId/members/:userId", async (req, res) => {
    try {
      await teamService.removeMember(req.params.teamId, req.params.userId);
      res.json({ removed: true });
    } catch (error) {
      handleError(res, error, "Failed to remove team member");
    }
  });
}
