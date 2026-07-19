import type { Express } from "express";
import { storage } from "./storage";
import { insertSkillSchema } from "@shared/schema";
import type { Skill, SkillReference } from "@shared/models/skills";
import { resetSkillToDefault } from "./skill-seed";
import { createLogger } from "./log";
import { db } from "./db";
import { libraryPages } from "@shared/models/info";
import { inArray } from "drizzle-orm";
import { listSkillPersonaConfiguration, setSkillPersonaPreference } from "./skill-persona-service";

const log = createLogger("SkillRoutes");

interface ImportResult { name: string; action: string; error?: string }

const updateSkillSchema = insertSkillSchema.omit({ references: true }).partial().extend({
  references: insertSkillSchema.shape.references.optional(),
});

function stripSkillForExport(skill: Skill & { references?: SkillReference[]; trustScore?: number }) {
  const { id, createdAt, updatedAt, successCount, failureCount, trustScore, ...rest } = skill;
  const stripped: Record<string, unknown> = { ...rest };
  if (rest.references) {
    stripped.references = rest.references.map((r) => ({ name: r.name, content: r.content }));
  }
  return stripped;
}

function safeItemName(item: unknown): string {
  if (item && typeof item === "object" && "name" in item && typeof (item as Record<string, unknown>).name === "string") {
    return (item as Record<string, unknown>).name as string;
  }
  return "unknown";
}

export function registerSkillRoutes(app: Express): void {

  app.get("/api/skills", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const skills = await storage.getSkills(status ? { status } : undefined);
      res.json(skills);
    } catch (err: any) {
      log.error("GET /api/skills error:", err.message);
      res.status(500).json({ error: "Failed to fetch skills" });
    }
  });

  app.get("/api/skills/last-runs", async (_req, res) => {
    try {
      const lastRuns = await storage.getSkillRunLastRuns();
      log.debug(`GET /api/skills/last-runs count=${Object.keys(lastRuns).length}`);
      res.json(lastRuns);
    } catch (err: any) {
      log.error("GET /api/skills/last-runs error:", err.message);
      res.status(500).json({ error: "Failed to fetch skill last runs" });
    }
  });

  app.get("/api/skills/failed-names", async (_req, res) => {
    try {
      const failed = await storage.getSkillFailedNames();
      res.json(failed);
    } catch (err: any) {
      log.error("GET /api/skills/failed-names error:", err.message);
      res.status(500).json({ error: "Failed to fetch failed skill names" });
    }
  });

  // Per-user persona overrides for skills. These routes delegate all reads,
  // visibility validation, ownership stamping, and upserts to the canonical
  // skill persona service.
  app.get("/api/skills/persona-config", async (_req, res) => {
    try {
      res.json(await listSkillPersonaConfiguration());
    } catch (err: any) {
      log.error("GET /api/skills/persona-config error:", err.message);
      res.status(500).json({ error: "Failed to fetch persona preferences" });
    }
  });

  app.put("/api/skills/:id/persona-preference", async (req, res) => {
    try {
      const skill = await storage.getSkill(req.params.id);
      if (!skill) return res.status(404).json({ error: "Skill not found" });

      const personaId = req.body?.personaId;
      if (personaId !== null && (!Number.isInteger(personaId) || typeof personaId !== "number")) {
        return res.status(400).json({ error: "personaId must be an integer or null" });
      }

      const result = await setSkillPersonaPreference(skill.id, personaId);
      log.log(
        `${personaId === null ? "Cleared" : "Set"} persona preference skill=${skill.name} persona=${personaId ?? "recommended"}`,
      );
      res.json(result);
    } catch (err: any) {
      const status = err.message?.includes("not found or not visible") ? 400 :
        err.message?.includes("user principal") ? 403 : 500;
      log.error("PUT /api/skills/:id/persona-preference error:", err.message);
      res.status(status).json({ error: err.message || "Failed to set persona preference" });
    }
  });

  app.post("/api/skills/:name/dismiss-failure", async (req, res) => {
    try {
      await storage.dismissSkillFailure(req.params.name);
      res.json({ success: true });
    } catch (err: any) {
      log.error(`POST /api/skills/${req.params.name}/dismiss-failure error:`, err.message);
      res.status(500).json({ error: "Failed to dismiss skill failure" });
    }
  });


  app.get("/api/skills/:name/scores", async (req, res) => {
    try {
      const limitParam = parseInt(req.query.limit as string) || 20;
      const limit = Math.min(Math.max(1, limitParam), 50);
      const runs = await storage.getSkillRuns(req.params.name, limit);
      const result = runs.map(r => ({
        id: r.id,
        skillName: r.skillName,
        sessionId: r.sessionId,
        checklistTotal: r.checklistTotal ?? 0,
        checklistPassed: r.checklistPassed ?? 0,
        checklistResults: r.checklistResults ?? [],
        comparativeVsId: r.comparativeVsId ?? null,
        comparativeWinner: r.comparativeWinner ?? null,
        comparativeReason: r.comparativeReason ?? null,
        passRate: r.passRate ?? null,
        durationMs: r.durationMs ?? null,
        scoredAt: r.completedAt ?? r.startedAt,
        status: r.status,
      }));
      log.debug(`GET /api/skills/${req.params.name}/scores count=${result.length} limit=${limit}`);
      res.json(result);
    } catch (err: any) {
      log.error(`GET /api/skills/${req.params.name}/scores error:`, err.message);
      res.status(500).json({ error: "Failed to fetch skill scores" });
    }
  });

  app.get("/api/skills/:name/runs", async (req, res) => {
    try {
      const limitParam = parseInt(req.query.limit as string) || 20;
      const limit = Math.min(Math.max(1, limitParam), 50);
      const runs = await storage.getSkillRuns(req.params.name, limit);
      log.debug(`GET /api/skills/${req.params.name}/runs count=${runs.length} limit=${limit}`);
      res.json(runs);
    } catch (err: any) {
      log.error(`GET /api/skills/${req.params.name}/runs error:`, err.message);
      res.status(500).json({ error: "Failed to fetch skill runs" });
    }
  });

  app.get("/api/skills/export", async (_req, res) => {
    try {
      const allSkills = await storage.getSkills();
      const exported = allSkills.map(stripSkillForExport as any);
      res.setHeader("Content-Disposition", `attachment; filename="skills-export-${new Date().toISOString().slice(0, 10)}.json"`);
      res.setHeader("Content-Type", "application/json");
      log.log(`Export all skills count=${exported.length}`);
      res.json(exported);
    } catch (err: any) {
      log.error("GET /api/skills/export error:", err.message);
      res.status(500).json({ error: "Failed to export skills" });
    }
  });

  app.post("/api/skills/import", async (req, res) => {
    try {
      const payload = req.body;
      const items: unknown[] = Array.isArray(payload) ? payload : [payload];
      const results: ImportResult[] = [];

      for (const item of items) {
        const itemName = safeItemName(item);
        try {
          const parsed = insertSkillSchema.safeParse(item);
          if (!parsed.success) {
            results.push({ name: itemName, action: "error", error: `Validation: ${parsed.error.errors.map(e => e.message).join(", ")}` });
            continue;
          }
          const existing = await storage.getSkillByName(parsed.data.name);
          if (existing) {
            await storage.updateSkill(existing.id, parsed.data);
            results.push({ name: parsed.data.name, action: "updated" });
            log.log(`Import skill updated name=${parsed.data.name}`);
          } else {
            await storage.createSkill(parsed.data);
            results.push({ name: parsed.data.name, action: "created" });
            log.log(`Import skill created name=${parsed.data.name}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name: itemName, action: "error", error: msg });
          log.error(`Import skill error name=${itemName}:`, msg);
        }
      }

      log.log(`Import skills complete total=${items.length} created=${results.filter(r => r.action === "created").length} updated=${results.filter(r => r.action === "updated").length} errors=${results.filter(r => r.action === "error").length}`);
      res.json({ results });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("POST /api/skills/import error:", msg);
      res.status(500).json({ error: "Failed to import skills" });
    }
  });

  app.get("/api/skills/:id/export", async (req, res) => {
    try {
      const skill = await storage.getSkill(req.params.id);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      const exported = stripSkillForExport(skill as any);
      res.setHeader("Content-Disposition", `attachment; filename="skill-${skill.name}.json"`);
      res.setHeader("Content-Type", "application/json");
      log.log(`Export skill name=${skill.name} id=${skill.id}`);
      res.json(exported);
    } catch (err: any) {
      log.error("GET /api/skills/:id/export error:", err.message);
      res.status(500).json({ error: "Failed to export skill" });
    }
  });

  app.get("/api/skills/:id", async (req, res) => {
    try {
      const skill = await storage.getSkill(req.params.id);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      res.json(skill);
    } catch (err: any) {
      log.error("GET /api/skills/:id error:", err.message);
      res.status(500).json({ error: "Failed to fetch skill" });
    }
  });

  app.post("/api/skills", async (req, res) => {
    try {
      const parsed = insertSkillSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      }
      const skill = await storage.createSkill(parsed.data);
      res.status(201).json(skill);
    } catch (err: any) {
      if (err.message?.includes("unique") || err.code === "23505") {
        return res.status(409).json({ error: "A skill with this name already exists" });
      }
      log.error("POST /api/skills error:", err.message);
      res.status(500).json({ error: "Failed to create skill" });
    }
  });

  app.patch("/api/skills/:id", async (req, res) => {
    try {
      const parsed = updateSkillSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
      }
      const skill = await storage.updateSkill(req.params.id, parsed.data);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      res.json(skill);
    } catch (err: any) {
      if (err.message?.includes("unique") || err.code === "23505") {
        return res.status(409).json({ error: "A skill with this name already exists" });
      }
      log.error("PATCH /api/skills/:id error:", err.message);
      res.status(500).json({ error: "Failed to update skill" });
    }
  });

  app.delete("/api/skills/:id", async (req, res) => {
    try {
      const deleted = await storage.deleteSkill(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Skill not found" });
      res.json({ success: true });
    } catch (err: any) {
      log.error("DELETE /api/skills/:id error:", err.message);
      res.status(500).json({ error: "Failed to delete skill" });
    }
  });

  app.post("/api/skills/:name/reset", async (req, res) => {
    try {
      const reset = await resetSkillToDefault(req.params.name);
      if (!reset) return res.status(404).json({ error: "No built-in default found for this skill" });
      const skill = await storage.getSkillByName(req.params.name);
      res.json(skill);
    } catch (err: any) {
      log.error("POST /api/skills/:name/reset error:", err.message);
      res.status(500).json({ error: "Failed to reset skill" });
    }
  });

  app.post("/api/skills/library-pages-by-sessions", async (req, res) => {
    try {
      const sessionIds: string[] = req.body.sessionIds;
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return res.json({});
      }
      const bounded = sessionIds.slice(0, 100);
      const pages = await db.select({
        id: libraryPages.id,
        title: libraryPages.title,
        slug: libraryPages.slug,
        createdBySessionId: libraryPages.createdBySessionId,
      }).from(libraryPages).where(inArray(libraryPages.createdBySessionId, bounded));
      const result: Record<string, { id: string; title: string; slug: string }[]> = {};
      for (const page of pages) {
        const sid = page.createdBySessionId!;
        if (!result[sid]) result[sid] = [];
        result[sid].push({ id: page.id, title: page.title, slug: page.slug });
      }
      res.json(result);
    } catch (err: any) {
      log.error("POST /api/skills/library-pages-by-sessions error:", err.message);
      res.status(500).json({ error: "Failed to fetch library pages by sessions" });
    }
  });

}
