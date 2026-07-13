import type { Express, Response, Request } from "express";
import { execSkillStorage, execExperienceStorage, execPassionStorage, execMetricsStorage, execEducationStorage, migrateExecSchema } from "../exec-storage";
import { opportunityStorage, migrateOpportunitySchema } from "../opportunity-storage";
import { insertExecSkillSchema, insertExecExperienceSchema, insertExecPassionSchema, insertExecMetricSchema, insertExecEducationSchema, insertOpportunitySchema, createOpportunityInteractionSchema, updateOpportunityInteractionSchema, artifactKinds, type ArtifactKind } from "@shared/schema";
import { z } from "zod";
import { createLogger } from "../log";
import { eventBus } from "../event-bus";
import { getPrincipal } from "../principal";

const log = createLogger("ExecRoutes");

function publishChanged(source: string): void {
  eventBus.publish({ category: "system", event: "data:exec_changed", payload: { source } });
}

function isZodError(err: unknown): err is z.ZodError {
  return err instanceof z.ZodError;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function handleError(prefix: string, err: unknown, res: Response): Response {
  if (isZodError(err)) return res.status(400).json({ error: "Validation failed", details: err.errors });
  log.error(`${prefix} error:`, errMsg(err));
  return res.status(500).json({ error: errMsg(err) });
}

function currentPrincipal(req: Request) {
  const principal = getPrincipal(req);
  if (!principal?.userId) throw Object.assign(new Error("User session required"), { status: 401 });
  return principal;
}

function currentUserId(req: Request): string {
  return currentPrincipal(req).userId!;
}

export function registerExecRoutes(app: Express): void {
  migrateExecSchema().catch(err => log.error("schema migration error:", errMsg(err)));
  migrateOpportunitySchema().catch(err => log.error("opportunity schema migration error:", errMsg(err)));

  // ── Skills CRUD ────────────────────────────────────────────────
  app.get("/api/exec/skills", async (req, res) => {
    try {
      const list = await execSkillStorage.list(currentUserId(req));
      res.json(list);
    } catch (err) {
      handleError("GET /api/exec/skills", err, res);
    }
  });

  app.post("/api/exec/skills", async (req, res) => {
    try {
      const parsed = insertExecSkillSchema.parse(req.body);
      const row = await execSkillStorage.create(currentUserId(req), parsed);
      publishChanged("create_skill");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/exec/skills", err, res);
    }
  });

  app.get("/api/exec/skills/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const skill = await execSkillStorage.get(id);
      if (!skill) return res.status(404).json({ error: "Skill not found" });
      res.json(skill);
    } catch (err) {
      handleError("GET /api/exec/skills/:id", err, res);
    }
  });

  app.patch("/api/exec/skills/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const parsed = insertExecSkillSchema.partial().parse(req.body);
      const row = await execSkillStorage.update(id, parsed);
      if (!row) return res.status(404).json({ error: "Skill not found" });
      publishChanged("update_skill");
      res.json(row);
    } catch (err) {
      handleError("PATCH /api/exec/skills/:id", err, res);
    }
  });

  app.delete("/api/exec/skills/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const deleted = await execSkillStorage.delete(id);
      if (!deleted) return res.status(404).json({ error: "Skill not found" });
      publishChanged("delete_skill");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/skills/:id", err, res);
    }
  });

  // ── Experience CRUD ────────────────────────────────────────────
  app.get("/api/exec/experience", async (req, res) => {
    try {
      const list = await execExperienceStorage.listWithSkills(currentUserId(req));
      res.json(list);
    } catch (err) {
      handleError("GET /api/exec/experience", err, res);
    }
  });

  app.post("/api/exec/experience", async (req, res) => {
    try {
      const parsed = insertExecExperienceSchema.parse(req.body);
      const row = await execExperienceStorage.create(currentUserId(req), parsed);
      publishChanged("create_experience");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/exec/experience", err, res);
    }
  });

  app.get("/api/exec/experience/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const exp = await execExperienceStorage.getWithSkills(id);
      if (!exp) return res.status(404).json({ error: "Experience not found" });
      res.json(exp);
    } catch (err) {
      handleError("GET /api/exec/experience/:id", err, res);
    }
  });

  app.patch("/api/exec/experience/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const parsed = insertExecExperienceSchema.partial().parse(req.body);
      const row = await execExperienceStorage.update(id, parsed);
      if (!row) return res.status(404).json({ error: "Experience not found" });
      publishChanged("update_experience");
      res.json(row);
    } catch (err) {
      handleError("PATCH /api/exec/experience/:id", err, res);
    }
  });

  app.delete("/api/exec/experience/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const deleted = await execExperienceStorage.delete(id);
      if (!deleted) return res.status(404).json({ error: "Experience not found" });
      publishChanged("delete_experience");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/experience/:id", err, res);
    }
  });

  // ── Experience ↔ Skill Linking ──────────────────────────────────
  app.post("/api/exec/experience/:id/skills/:skillId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const skillId = parseInt(req.params.skillId, 10);
      if (isNaN(id) || isNaN(skillId)) return res.status(400).json({ error: "Invalid ID" });
      await execExperienceStorage.linkSkill(id, skillId);
      publishChanged("link_experience_skill");
      res.json({ success: true });
    } catch (err) {
      handleError("POST /api/exec/experience/:id/skills/:skillId", err, res);
    }
  });

  app.delete("/api/exec/experience/:id/skills/:skillId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const skillId = parseInt(req.params.skillId, 10);
      if (isNaN(id) || isNaN(skillId)) return res.status(400).json({ error: "Invalid ID" });
      const removed = await execExperienceStorage.unlinkSkill(id, skillId);
      if (!removed) return res.status(404).json({ error: "Link not found" });
      publishChanged("unlink_experience_skill");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/experience/:id/skills/:skillId", err, res);
    }
  });

  // ── Skill → Experience reverse lookup ─────────────────────────
  app.get("/api/exec/skills/:id/experience", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const exps = await execExperienceStorage.getExperienceForSkill(id);
      res.json(exps);
    } catch (err) {
      handleError("GET /api/exec/skills/:id/experience", err, res);
    }
  });

  // ── Opportunities CRUD ─────────────────────────────────────────
  app.get("/api/exec/opportunities", async (req, res) => {
    try {
      const filters: { status?: string; type?: string } = {};
      if (typeof req.query.status === "string") filters.status = req.query.status;
      if (typeof req.query.type === "string") filters.type = req.query.type;
      const list = await opportunityStorage.listWithSkills(currentPrincipal(req), filters);
      res.json(list);
    } catch (err) {
      handleError("GET /api/exec/opportunities", err, res);
    }
  });

  app.post("/api/exec/opportunities", async (req, res) => {
    try {
      const parsed = insertOpportunitySchema.parse(req.body);
      const row = await opportunityStorage.create(currentPrincipal(req), parsed);
      publishChanged("create_opportunity");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/exec/opportunities", err, res);
    }
  });

  app.get("/api/exec/opportunities/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const principal = currentPrincipal(req);
      const opp = await opportunityStorage.getWithSkills(id, principal);
      if (!opp) return res.status(404).json({ error: "Opportunity not found" });
      const artifacts = await opportunityStorage.getArtifacts(id);
      res.json({ ...opp, artifacts });
    } catch (err) {
      handleError("GET /api/exec/opportunities/:id", err, res);
    }
  });

  app.patch("/api/exec/opportunities/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const parsed = insertOpportunitySchema.partial().parse(req.body);
      const row = await opportunityStorage.update(id, parsed, currentPrincipal(req));
      if (!row) return res.status(404).json({ error: "Opportunity not found" });
      publishChanged("update_opportunity");
      res.json(row);
    } catch (err) {
      handleError("PATCH /api/exec/opportunities/:id", err, res);
    }
  });

  app.delete("/api/exec/opportunities/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const deleted = await opportunityStorage.delete(id, currentPrincipal(req));
      if (!deleted) return res.status(404).json({ error: "Opportunity not found" });
      publishChanged("delete_opportunity");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/opportunities/:id", err, res);
    }
  });

  // ── Opportunity ↔ Person interaction activities ───────────────
  app.get("/api/exec/opportunities/:id/activities", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      res.json(await opportunityStorage.listActivities(id, currentPrincipal(req)));
    } catch (err) {
      handleError("GET /api/exec/opportunities/:id/activities", err, res);
    }
  });

  app.post("/api/exec/opportunities/:id/activities", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const input = createOpportunityInteractionSchema.parse(req.body);
      const activity = await opportunityStorage.createOrLinkActivity(id, input, currentPrincipal(req));
      publishChanged("create_or_link_opportunity_activity");
      res.status(201).json(activity);
    } catch (err) {
      handleError("POST /api/exec/opportunities/:id/activities", err, res);
    }
  });

  app.patch("/api/exec/opportunities/:id/activities/:associationId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const associationId = parseInt(req.params.associationId, 10);
      if (isNaN(id) || isNaN(associationId)) return res.status(400).json({ error: "Invalid ID" });
      const updates = updateOpportunityInteractionSchema.parse(req.body);
      const activity = await opportunityStorage.updateActivity(id, associationId, updates, currentPrincipal(req));
      if (!activity) return res.status(404).json({ error: "Activity association not found" });
      publishChanged("update_opportunity_activity");
      res.json(activity);
    } catch (err) {
      handleError("PATCH /api/exec/opportunities/:id/activities/:associationId", err, res);
    }
  });

  app.delete("/api/exec/opportunities/:id/activities/:associationId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const associationId = parseInt(req.params.associationId, 10);
      if (isNaN(id) || isNaN(associationId)) return res.status(400).json({ error: "Invalid ID" });
      const removed = await opportunityStorage.unlinkActivity(id, associationId, currentPrincipal(req));
      if (!removed) return res.status(404).json({ error: "Activity association not found" });
      publishChanged("unlink_opportunity_activity");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/opportunities/:id/activities/:associationId", err, res);
    }
  });

  // ── Opportunity ↔ Skill Linking ────────────────────────────────
  app.post("/api/exec/opportunities/:id/skills/:skillId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const skillId = parseInt(req.params.skillId, 10);
      if (isNaN(id) || isNaN(skillId)) return res.status(400).json({ error: "Invalid ID" });
      await opportunityStorage.linkSkill(id, skillId);
      publishChanged("link_skill");
      res.json({ success: true });
    } catch (err) {
      handleError("POST /api/exec/opportunities/:id/skills/:skillId", err, res);
    }
  });

  app.delete("/api/exec/opportunities/:id/skills/:skillId", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const skillId = parseInt(req.params.skillId, 10);
      if (isNaN(id) || isNaN(skillId)) return res.status(400).json({ error: "Invalid ID" });
      const removed = await opportunityStorage.unlinkSkill(id, skillId);
      if (!removed) return res.status(404).json({ error: "Link not found" });
      publishChanged("unlink_skill");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/opportunities/:id/skills/:skillId", err, res);
    }
  });

  // ── Passions CRUD ──────────────────────────────────────────────
  app.get("/api/exec/passions", async (req, res) => {
    try {
      const passions = await execPassionStorage.list(currentUserId(req));
      res.json(passions);
    } catch (err) {
      handleError("GET /api/exec/passions", err, res);
    }
  });

  app.post("/api/exec/passions", async (req, res) => {
    try {
      const data = insertExecPassionSchema.parse(req.body);
      const passion = await execPassionStorage.create(currentUserId(req), data);
      publishChanged("create_passion");
      res.status(201).json(passion);
    } catch (err) {
      handleError("POST /api/exec/passions", err, res);
    }
  });

  app.get("/api/exec/passions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const passion = await execPassionStorage.get(id);
      if (!passion) return res.status(404).json({ error: "Passion not found" });
      res.json(passion);
    } catch (err) {
      handleError("GET /api/exec/passions/:id", err, res);
    }
  });

  app.patch("/api/exec/passions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const updates = insertExecPassionSchema.partial().parse(req.body);
      const passion = await execPassionStorage.update(id, updates);
      if (!passion) return res.status(404).json({ error: "Passion not found" });
      publishChanged("update_passion");
      res.json(passion);
    } catch (err) {
      handleError("PATCH /api/exec/passions/:id", err, res);
    }
  });

  // ── Artifact Slots ─────────────────────────────────────────────
  app.get("/api/exec/opportunities/:id/artifacts", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const artifacts = await opportunityStorage.getArtifacts(id);
      res.json(artifacts);
    } catch (err) {
      handleError("GET /api/exec/opportunities/:id/artifacts", err, res);
    }
  });

  app.post("/api/exec/opportunities/:id/artifacts/:kind/generate", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const kind = req.params.kind as ArtifactKind;
      if (!artifactKinds.includes(kind)) {
        return res.status(400).json({ error: `Invalid artifact kind "${req.params.kind}". Valid: ${artifactKinds.join(", ")}` });
      }

      const opportunity = await opportunityStorage.get(id, currentPrincipal(req));
      if (!opportunity) return res.status(404).json({ error: "Opportunity not found" });

      // Cover letters and resumes require a job description to target.
      if ((kind === "cover_letter" || kind === "resume") && !opportunity.jdText?.trim()) {
        return res.status(400).json({ error: "This opportunity has no job description. Paste the JD into the opportunity before generating." });
      }

      // Reject concurrent generation for the same slot.
      const existing = await opportunityStorage.getArtifact(id, kind);
      if (existing?.sessionId) {
        const { chatFileStorage } = await import("../chat-file-storage");
        const session = await chatFileStorage.getSession(existing.sessionId).catch(() => null);
        if (session && session.status === "streaming") {
          return res.status(409).json({ error: "A generation session for this artifact is already running.", sessionId: existing.sessionId });
        }
      }

      const { ensureArtifactSlot, buildPreContext, ARTIFACT_SKILLS } = await import("../opportunity-artifacts");
      const slot = await ensureArtifactSlot(opportunity, kind);
      const options = {
        focus: typeof req.body?.focus === "string" ? req.body.focus : undefined,
        tone: typeof req.body?.tone === "string" ? req.body.tone : undefined,
        length: typeof req.body?.length === "string" ? req.body.length : undefined,
        emphasis: typeof req.body?.emphasis === "string" ? req.body.emphasis : undefined,
      };
      const preContext = buildPreContext(opportunity, kind, slot, options);

      const { executeAutonomousSkillRun } = await import("../autonomous-skill-runner");
      let childSessionId: string | null = null;
      const sessionCreated = new Promise<string>((resolve) => {
        void executeAutonomousSkillRun(ARTIFACT_SKILLS[kind], {
          preContext,
          spawnerTool: "exec.artifact_generate",
          onSessionCreated: (sid: string) => { childSessionId = sid; resolve(sid); },
        }).then((result) => {
          if (result === null) log.warn(`artifact generate: skill ${ARTIFACT_SKILLS[kind]} could not be started`);
        }).catch((err) => log.error("artifact generate run error:", errMsg(err)));
      });

      const raced = await Promise.race([
        sessionCreated,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 8000)),
      ]);
      if (raced === "timeout" && !childSessionId) {
        return res.status(500).json({ error: "Generation skill failed to start a session within 8s." });
      }

      await opportunityStorage.upsertArtifact(id, kind, { libraryPageId: slot.libraryPageId, sessionId: childSessionId });
      publishChanged("artifact_generate");
      res.json({ sessionId: childSessionId, libraryPageId: slot.libraryPageId, kind });
    } catch (err) {
      handleError("POST /api/exec/opportunities/:id/artifacts/:kind/generate", err, res);
    }
  });

  // Serve generated artifact files (DOCX) for download
  app.get("/api/exec/artifacts/download/:filename", async (req, res) => {
    try {
      const { filename } = req.params;
      // Sanitize filename to prevent path traversal
      if (filename.includes("..") || filename.includes("/")) {
        return res.status(400).json({ error: "Invalid filename" });
      }
      const { join } = await import("path");
      const { existsSync } = await import("fs");
      const filepath = join(process.cwd(), "scratch", filename);
      if (!existsSync(filepath)) {
        return res.status(404).json({ error: "File not found" });
      }
      res.download(filepath, filename);
    } catch (err) {
      handleError("GET /api/exec/artifacts/download", err, res);
    }
  });

  // ── Metrics CRUD ───────────────────────────────────────────────
  app.get("/api/exec/metrics", async (req, res) => {
    try {
      const experienceId = req.query.experienceId ? parseInt(String(req.query.experienceId), 10) : undefined;
      const list = await execMetricsStorage.list(currentUserId(req), Number.isNaN(experienceId as number) ? undefined : experienceId);
      res.json(list);
    } catch (err) {
      handleError("GET /api/exec/metrics", err, res);
    }
  });

  app.post("/api/exec/metrics", async (req, res) => {
    try {
      const parsed = insertExecMetricSchema.parse(req.body);
      const row = await execMetricsStorage.create(currentUserId(req), parsed);
      publishChanged("create_metric");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/exec/metrics", err, res);
    }
  });

  app.patch("/api/exec/metrics/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const parsed = insertExecMetricSchema.partial().parse(req.body);
      const row = await execMetricsStorage.update(id, parsed);
      if (!row) return res.status(404).json({ error: "Metric not found" });
      publishChanged("update_metric");
      res.json(row);
    } catch (err) {
      handleError("PATCH /api/exec/metrics/:id", err, res);
    }
  });

  app.delete("/api/exec/metrics/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const deleted = await execMetricsStorage.delete(id);
      if (!deleted) return res.status(404).json({ error: "Metric not found" });
      publishChanged("delete_metric");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/metrics/:id", err, res);
    }
  });

  // ── Education CRUD ─────────────────────────────────────────────
  app.get("/api/exec/education", async (req, res) => {
    try {
      const list = await execEducationStorage.list(currentUserId(req));
      res.json(list);
    } catch (err) {
      handleError("GET /api/exec/education", err, res);
    }
  });

  app.post("/api/exec/education", async (req, res) => {
    try {
      const parsed = insertExecEducationSchema.parse(req.body);
      const row = await execEducationStorage.create(currentUserId(req), parsed);
      publishChanged("create_education");
      res.status(201).json(row);
    } catch (err) {
      handleError("POST /api/exec/education", err, res);
    }
  });

  app.patch("/api/exec/education/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const parsed = insertExecEducationSchema.partial().parse(req.body);
      const row = await execEducationStorage.update(id, parsed);
      if (!row) return res.status(404).json({ error: "Education entry not found" });
      publishChanged("update_education");
      res.json(row);
    } catch (err) {
      handleError("PATCH /api/exec/education/:id", err, res);
    }
  });

  app.delete("/api/exec/education/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const deleted = await execEducationStorage.delete(id);
      if (!deleted) return res.status(404).json({ error: "Education entry not found" });
      publishChanged("delete_education");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/education/:id", err, res);
    }
  });

  app.delete("/api/exec/passions/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const deleted = await execPassionStorage.delete(id);
      if (!deleted) return res.status(404).json({ error: "Passion not found" });
      publishChanged("delete_passion");
      res.json({ success: true });
    } catch (err) {
      handleError("DELETE /api/exec/passions/:id", err, res);
    }
  });
}
