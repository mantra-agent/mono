import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { getPrincipal, recordPrivilegedAccess } from "../principal";
import {
  addConnectorToRouter,
  createRouter,
  deleteRouter,
  getRouter,
  listRouters,
  removeConnectorFromRouter,
  renameRouter,
  reorderRouterConnectors,
  setDefaultRouter,
} from "../router-storage";
import { updateModelConnector } from "../model-connectors";
import { createLogger } from "../log";

const log = createLogger("RoutersRoutes");

const nameSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const connectorKindSchema = z.object({
  kind: z.enum([
    "claude-cli",
    "openai-subscription",
    "openai",
    "anthropic",
    "grok-subscription",
    "grok-api",
  ]),
});

export async function registerRouterRoutes(app: Express): Promise<void> {
  app.use("/api/routers", requireAuth);

  app.get(
    "/api/routers",
    requirePermission("system:read"),
    async (_req: Request, res: Response) => {
      try {
        res.json({ routers: await listRouters() });
      } catch (error: any) {
        log.error("list routers failed", { error: error?.message });
        res.status(500).json({ error: error?.message || "Failed to list routers" });
      }
    },
  );

  app.get(
    "/api/routers/:id",
    requirePermission("system:read"),
    async (req: Request, res: Response) => {
      try {
        const router = await getRouter(req.params.id as string);
        if (!router) return res.status(404).json({ error: "Router not found" });
        res.json({ router });
      } catch (error: any) {
        res.status(500).json({ error: error?.message || "Failed to get router" });
      }
    },
  );

  app.post(
    "/api/routers",
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const parsed = nameSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Name must be 1–120 characters" });
        const router = await createRouter(parsed.data.name);
        await recordPrivilegedAccess({
          principal: getPrincipal(req)!,
          action: "router_create",
          reason: "admin create router",
          metadata: { routerId: router.id, name: router.name },
        });
        res.status(201).json({ router });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || "Failed to create router" });
      }
    },
  );

  app.patch(
    "/api/routers/:id",
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const parsed = nameSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Name must be 1–120 characters" });
        const router = await renameRouter(req.params.id as string, parsed.data.name);
        await recordPrivilegedAccess({
          principal: getPrincipal(req)!,
          action: "router_rename",
          reason: "admin rename router",
          metadata: { routerId: router.id, name: router.name },
        });
        res.json({ router });
      } catch (error: any) {
        const status = error?.message === "Router not found" ? 404 : 400;
        res.status(status).json({ error: error?.message || "Failed to rename router" });
      }
    },
  );

  app.post(
    "/api/routers/:id/default",
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const router = await setDefaultRouter(req.params.id as string);
        await recordPrivilegedAccess({
          principal: getPrincipal(req)!,
          action: "router_set_default",
          reason: "admin set default router",
          metadata: { routerId: router.id },
        });
        res.json({ router });
      } catch (error: any) {
        const status = error?.message === "Router not found" ? 404 : 400;
        res.status(status).json({ error: error?.message || "Failed to set default router" });
      }
    },
  );

  app.delete(
    "/api/routers/:id",
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        await deleteRouter(req.params.id as string);
        await recordPrivilegedAccess({
          principal: getPrincipal(req)!,
          action: "router_delete",
          reason: "admin delete router",
          metadata: { routerId: req.params.id },
        });
        res.json({ ok: true });
      } catch (error: any) {
        const status = error?.message === "Router not found" ? 404 : 400;
        res.status(status).json({ error: error?.message || "Failed to delete router" });
      }
    },
  );

  app.post(
    "/api/routers/:id/connectors",
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const parsed = connectorKindSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "Invalid connector kind" });
        const connector = await addConnectorToRouter(req.params.id as string, parsed.data.kind);
        res.status(201).json({ connector });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || "Failed to add connector" });
      }
    },
  );

  app.delete(
    "/api/routers/:id/connectors/:connectorId",
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = Number.parseInt(req.params.connectorId as string, 10);
        if (!Number.isFinite(connectorId)) return res.status(400).json({ error: "Invalid connector id" });
        await removeConnectorFromRouter(req.params.id as string, connectorId);
        res.json({ ok: true });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || "Failed to remove connector" });
      }
    },
  );

  app.put(
    "/api/routers/:id/connectors/order",
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1) }).parse(req.body);
        const connectors = await reorderRouterConnectors(req.params.id as string, ids);
        res.json({ connectors });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || "Failed to reorder connectors" });
      }
    },
  );

  app.patch(
    "/api/routers/:id/connectors/:connectorId",
    requirePermission("system:write"),
    async (req: Request, res: Response) => {
      try {
        const connectorId = Number.parseInt(req.params.connectorId as string, 10);
        if (!Number.isFinite(connectorId)) return res.status(400).json({ error: "Invalid connector id" });
        const body = z.object({
          status: z.enum(["active", "inactive"]).optional(),
          priorityPinned: z.boolean().optional(),
        }).parse(req.body);
        // Verify membership first
        const router = await getRouter(req.params.id as string);
        if (!router) return res.status(404).json({ error: "Router not found" });
        if (!router.connectors.some((c) => c.id === connectorId)) {
          return res.status(404).json({ error: "Connector not found on this Router" });
        }
        const connector = await updateModelConnector(connectorId, body);
        if (!connector) return res.status(404).json({ error: "Connector not found" });
        res.json({ connector });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || "Failed to update connector" });
      }
    },
  );
}
