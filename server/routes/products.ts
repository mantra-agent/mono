import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { requireModRouteGroup } from "../mods/mod-access";
import { ProductDependencyError, productStorage } from "../product-storage";

const requireBuildProducts = requireModRouteGroup("build.products");
const idSchema = z.coerce.number().int().positive();
const confirmationSchema = z.object({ confirm: z.literal(true) });

export function registerProductRoutes(app: Express): void {
  app.use("/api/products", requireAuth, requireBuildProducts);
  app.get("/api/products", requirePermission("build:read"), async (_req, res) => res.json(await productStorage.list()));
  app.post("/api/products", requirePermission("build:write"), async (req, res) => {
    try { res.status(201).json(await productStorage.create(req.body)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Product creation failed" }); }
  });
  app.patch("/api/products/:id", requirePermission("build:write"), async (req, res) => {
    try { const product = await productStorage.update(idSchema.parse(req.params.id), req.body); product ? res.json(product) : res.status(404).json({ error: "Product not found" }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Product update failed" }); }
  });
  app.post("/api/products/:id/archive", requirePermission("build:write"), async (req, res) => {
    try { confirmationSchema.parse(req.body); const product = await productStorage.archive(idSchema.parse(req.params.id)); product ? res.json(product) : res.status(404).json({ error: "Product not found" }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Product archive failed" }); }
  });
  app.delete("/api/products/:id", requirePermission("build:write"), async (req, res) => {
    try { confirmationSchema.parse(req.body); const deleted = await productStorage.remove(idSchema.parse(req.params.id)); deleted ? res.json({ success: true }) : res.status(404).json({ error: "Product not found" }); }
    catch (error) { res.status(error instanceof ProductDependencyError ? 409 : 400).json({ error: error instanceof Error ? error.message : "Product deletion failed", dependencies: error instanceof ProductDependencyError ? error.dependencies : undefined }); }
  });
  app.put("/api/products/:id/context-artifacts", requirePermission("build:write"), async (req, res) => {
    try {
      const saved = await productStorage.addContext(idSchema.parse(req.params.id), req.body);
      saved ? res.json(saved) : res.status(404).json({ error: "Product not found" });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Context save failed" }); }
  });
  app.delete("/api/products/:id/context-artifacts/:contextId", requirePermission("build:write"), async (req, res) => {
    const deleted = await productStorage.removeContext(idSchema.parse(req.params.id), idSchema.parse(req.params.contextId));
    deleted === undefined ? res.status(404).json({ error: "Product not found" }) : deleted ? res.json({ success: true }) : res.status(404).json({ error: "Context not found" });
  });
}
