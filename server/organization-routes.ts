import type { Express, Response } from "express";
import { requireAuth } from "./auth";
import { createLogger } from "./log";
import { organizationService } from "./organization-service";

const log = createLogger("OrganizationRoutes");

function handleError(res: Response, error: unknown, fallback: string) {
  const status = (error as { status?: number })?.status ?? 500;
  const message = error instanceof Error ? error.message : fallback;
  if (status >= 500) log.error(fallback, { error: message });
  res.status(status).json({ error: message });
}

/**
 * Organization management routes. Organizations are cross-account billing collections and grant
 * subjects; every handler resolves the caller's principal via organizationService, which roots all
 * mutations in ownership (billing authority) and enforces the 0..1-org-per-user constraint.
 */
export function registerOrganizationRoutes(app: Express) {
  app.use("/api/organizations", requireAuth);

  app.get("/api/organizations", async (_req, res) => {
    try {
      res.json({ organizations: await organizationService.list() });
    } catch (error) {
      handleError(res, error, "Failed to list organizations");
    }
  });

  app.post("/api/organizations", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const billingEmail = typeof req.body?.billingEmail === "string" ? req.body.billingEmail : undefined;
      res.status(201).json({ organization: await organizationService.create(name, billingEmail) });
    } catch (error) {
      handleError(res, error, "Failed to create organization");
    }
  });

  app.patch("/api/organizations/:organizationId", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : undefined;
      const billingEmail =
        req.body?.billingEmail === null
          ? null
          : typeof req.body?.billingEmail === "string"
            ? req.body.billingEmail
            : undefined;
      res.json({ organization: await organizationService.update(req.params.organizationId, { name, billingEmail }) });
    } catch (error) {
      handleError(res, error, "Failed to update organization");
    }
  });

  app.delete("/api/organizations/:organizationId", async (req, res) => {
    try {
      await organizationService.remove(req.params.organizationId);
      res.json({ removed: true });
    } catch (error) {
      handleError(res, error, "Failed to remove organization");
    }
  });

  app.get("/api/organizations/:organizationId/members", async (req, res) => {
    try {
      res.json({ members: await organizationService.members(req.params.organizationId) });
    } catch (error) {
      handleError(res, error, "Failed to list organization members");
    }
  });

  app.post("/api/organizations/:organizationId/members", async (req, res) => {
    try {
      const email = typeof req.body?.email === "string" ? req.body.email : undefined;
      const userId = typeof req.body?.userId === "string" ? req.body.userId : undefined;
      const role = req.body?.role === "admin" ? "admin" : "member";
      await organizationService.addMember(req.params.organizationId, { email, userId, role });
      res.status(201).json({ added: true });
    } catch (error) {
      handleError(res, error, "Failed to add organization member");
    }
  });

  app.delete("/api/organizations/:organizationId/members/:userId", async (req, res) => {
    try {
      await organizationService.removeMember(req.params.organizationId, req.params.userId);
      res.json({ removed: true });
    } catch (error) {
      handleError(res, error, "Failed to remove organization member");
    }
  });
}
