import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { requireModRouteGroup } from "../mods/mod-access";
import { featureStorage } from "../feature-storage";
import { getSessionsByArtifact } from "../session-artifacts";
import { listReferenceOccurrences } from "../life-addressing-storage";
import { getPrincipal } from "../principal";
import { chatFileStorage } from "../chat-file-storage";

const id = z.string().uuid();
const requireBuildFeatures = requireModRouteGroup("build.features");
const confirm = z.object({ confirm: z.literal(true) });

export function registerFeatureRoutes(app: Express): void {
  app.use("/api/features", requireAuth, requireBuildFeatures);
  app.get("/api/features", requirePermission("build:read"), async (req, res) => res.json(await featureStorage.list({ productId: req.query.productId ? Number(req.query.productId) : undefined, search: typeof req.query.search === "string" ? req.query.search : undefined, includeArchived: req.query.includeArchived === "true" })));
  app.post("/api/features", requirePermission("build:write"), async (req, res) => { try { res.status(201).json(await featureStorage.create(req.body)); } catch (e) { res.status((e as any)?.status ?? 400).json({ error: e instanceof Error ? e.message : "Feature creation failed" }); } });
  app.get("/api/features/:id", requirePermission("build:read"), async (req, res) => { const row = await featureStorage.get(id.parse(req.params.id)); row ? res.json(row) : res.status(404).json({ error: "Feature not found" }); });
  app.get("/api/features/:id/sessions", requirePermission("build:read"), async (req, res) => {
    try {
      const principal = getPrincipal(req);
      if (!principal) return res.status(401).json({ error: "User session required" });
      const featureId = id.parse(req.params.id);
      const feature = await featureStorage.get(featureId);
      if (!feature) return res.status(404).json({ error: "Feature not found" });
      const explicitRows = await getSessionsByArtifact("feature", featureId);
      const discoveredPage = await listReferenceOccurrences(principal, { targetAddress: `@feature:${featureId}`, limit: 100 });
      const explicit = await Promise.all(explicitRows.map(async row => {
        const session = await chatFileStorage.getSession(row.sessionId);
        return session ? { sessionId: row.sessionId, title: session.title || "Untitled", evidenceType: "explicit", createdAt: row.createdAt } : null;
      }));
      const discovered = await Promise.all([...new Set(discoveredPage.items.map(item => item.sourceAddress))].map(async sourceAddress => {
        const sessionId = sourceAddress.replace(/^@session:/, "");
        const session = await chatFileStorage.getSession(sessionId);
        return session ? { sessionId, title: session.title || "Untitled", evidenceType: "discovered", createdAt: session.updatedAt } : null;
      }));
      res.json([...explicit, ...discovered].filter(Boolean));
    } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : "Feature session history failed" }); }
  });
  app.patch("/api/features/:id", requirePermission("build:write"), async (req, res) => { try { const row = await featureStorage.update(id.parse(req.params.id), req.body); row ? res.json(row) : res.status(404).json({ error: "Feature not found" }); } catch (e) { res.status((e as any)?.status ?? 400).json({ error: e instanceof Error ? e.message : "Feature update failed" }); } });
  app.post("/api/features/:id/archive", requirePermission("build:write"), async (req, res) => { try { confirm.parse(req.body); const row = await featureStorage.archive(id.parse(req.params.id)); row ? res.json(row) : res.status(404).json({ error: "Feature not found" }); } catch (e) { res.status((e as any)?.status ?? 400).json({ error: e instanceof Error ? e.message : "Feature archive failed" }); } });
  app.delete("/api/features/:id", requirePermission("build:write"), async (req, res) => { try { confirm.parse(req.body); res.json({ success: await featureStorage.permanentlyDelete(id.parse(req.params.id), true) }); } catch (e) { res.status((e as any)?.status ?? 400).json({ error: e instanceof Error ? e.message : "Feature deletion failed" }); } });
  app.put("/api/features/:id/kpi", requirePermission("build:write"), async (req, res) => { try { res.json(await featureStorage.linkKpi(id.parse(req.params.id), String(req.body.kpiAddress), String(req.body.idempotencyKey))); } catch (e) { res.status((e as any)?.status ?? 400).json({ error: e instanceof Error ? e.message : "KPI link failed" }); } });
  app.delete("/api/features/:id/kpi/:linkId", requirePermission("build:write"), async (req, res) => { try { res.json(await featureStorage.unlinkKpi(id.parse(req.params.id), req.params.linkId)); } catch (e) { res.status((e as any)?.status ?? 400).json({ error: e instanceof Error ? e.message : "KPI unlink failed" }); } });
}
