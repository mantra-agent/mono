// Use createLogger for logging ONLY
import type { Express } from "express";
import { resolve } from "path";
import { z } from "zod";
import { createLogger } from "../log";

const log = createLogger("IdentityRoutes");

export async function registerOrientationRoutes(app: Express) {
  // === Principles (Workspace Files) Routes ===
  const { filePrincipleStorage } = await import("../file-storage/principles");

  app.get("/api/principles", async (_req, res) => {
    try {
      const principles = await filePrincipleStorage.getPrinciples();
      res.json(principles);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/principles/index", async (_req, res) => {
    try {
      const index = await filePrincipleStorage.getIndex();
      res.json(index);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/principles/layer1", async (_req, res) => {
    try {
      const layer1 = await filePrincipleStorage.getAllLayer1();
      res.json(layer1);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/principles/deep-dive", async (req, res) => {
    try {
      const tags = typeof req.query.tags === "string" ? req.query.tags.split(",").filter(Boolean) : [];
      const principles = await filePrincipleStorage.getDeepDive(tags);
      res.json(principles);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/principles/:id", async (req, res) => {
    try {
      const principle = await filePrincipleStorage.getPrinciple(req.params.id);
      if (!principle) return res.status(404).json({ error: "Principle not found" });
      res.json(principle);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/principles", async (req, res) => {
    try {
      const { title, layer1, layer2, autoTags, manualTags, relatedIds } = req.body;
      if (!title || !layer1) {
        return res.status(400).json({ error: "title and layer1 are required" });
      }
      const principle = await filePrincipleStorage.createPrinciple({
        title, layer1, layer2: layer2 || "", autoTags, manualTags, relatedIds,
      });
      res.json(principle);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/principles/:id", async (req, res) => {
    try {
      const updated = await filePrincipleStorage.updatePrinciple(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: "Principle not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/principles/:id", async (req, res) => {
    try {
      const deleted = await filePrincipleStorage.deletePrinciple(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Principle not found" });
      res.json({ message: "Principle deleted" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/principles/forge", async (req, res) => {
    try {
      const { rawInput } = req.body;
      if (!rawInput || typeof rawInput !== "string") {
        return res.status(400).json({ error: "rawInput is required" });
      }
      const forged = await filePrincipleStorage.forge(rawInput);
      res.json(forged);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const { fileRuleStorage } = await import("../file-storage/rules");

  app.get("/api/rules", async (_req, res) => {
    log.debug("GET /api/rules");
    try {
      const rules = await fileRuleStorage.getAll();
      res.json(rules);
    } catch (error: any) {
      log.error("GET /api/rules error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rules/:id", async (req, res) => {
    log.debug("GET /api/rules/:id id=", req.params.id);
    try {
      const rule = await fileRuleStorage.getById(req.params.id);
      if (!rule) return res.status(404).json({ error: "Rule not found" });
      res.json(rule);
    } catch (error: any) {
      log.error("GET /api/rules/:id error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/rules", async (req, res) => {
    log.debug("POST /api/rules");
    try {
      const { rule, source, scope, context, confidence, principleRef, tags } = req.body;
      if (!rule) {
        return res.status(400).json({ error: "rule is required" });
      }
      const created = await fileRuleStorage.create({ rule, source, scope, context, confidence, principleRef, tags });
      res.json(created);
    } catch (error: any) {
      log.error("POST /api/rules error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/rules/:id", async (req, res) => {
    log.debug("PUT /api/rules/:id id=", req.params.id);
    try {
      const updated = await fileRuleStorage.update(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: "Rule not found" });
      res.json(updated);
    } catch (error: any) {
      log.error("PUT /api/rules/:id error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/rules/:id", async (req, res) => {
    log.debug("DELETE /api/rules/:id id=", req.params.id);
    try {
      const deleted = await fileRuleStorage.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Rule not found" });
      res.json({ message: "Rule deleted" });
    } catch (error: any) {
      log.error("DELETE /api/rules/:id error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/rules/:id/reinforce", async (req, res) => {
    log.debug("POST /api/rules/:id/reinforce id=", req.params.id);
    try {
      const updated = await fileRuleStorage.reinforce(req.params.id);
      if (!updated) return res.status(404).json({ error: "Rule not found" });
      res.json(updated);
    } catch (error: any) {
      log.error("POST /api/rules/:id/reinforce error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/rules/:id/violation", async (req, res) => {
    log.debug("POST /api/rules/:id/violation id=", req.params.id);
    try {
      const updated = await fileRuleStorage.recordViolation(req.params.id);
      if (!updated) return res.status(404).json({ error: "Rule not found" });
      res.json(updated);
    } catch (error: any) {
      log.error("POST /api/rules/:id/violation error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  const { filePreferenceStorage } = await import("../file-storage/preferences");

  app.get("/api/preferences", async (_req, res) => {
    log.debug("GET /api/preferences");
    try {
      const preferences = await filePreferenceStorage.getAll();
      res.json(preferences);
    } catch (error: any) {
      log.error("GET /api/preferences error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/preferences/:id", async (req, res) => {
    log.debug("GET /api/preferences/:id id=", req.params.id);
    try {
      const preference = await filePreferenceStorage.getById(req.params.id);
      if (!preference) return res.status(404).json({ error: "Preference not found" });
      res.json(preference);
    } catch (error: any) {
      log.error("GET /api/preferences/:id error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/preferences", async (req, res) => {
    log.debug("POST /api/preferences");
    try {
      const { domain, preference, evidence, confidence, tags } = req.body;
      if (!domain || !preference) {
        return res.status(400).json({ error: "domain and preference are required" });
      }
      const created = await filePreferenceStorage.create({
        domain, preference, evidence, confidence, tags,
      });
      res.json(created);
    } catch (error: any) {
      log.error("POST /api/preferences error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/preferences/:id", async (req, res) => {
    log.debug("PUT /api/preferences/:id id=", req.params.id);
    try {
      const updated = await filePreferenceStorage.update(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: "Preference not found" });
      res.json(updated);
    } catch (error: any) {
      log.error("PUT /api/preferences/:id error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/preferences/:id", async (req, res) => {
    log.debug("DELETE /api/preferences/:id id=", req.params.id);
    try {
      const deleted = await filePreferenceStorage.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Preference not found" });
      res.json({ message: "Preference deleted" });
    } catch (error: any) {
      log.error("DELETE /api/preferences/:id error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  // === Beliefs Routes ===
  const { memoryBeliefStorage } = await import("../memory/belief-storage");
  const beliefsLog = createLogger("Beliefs");

  app.get("/api/beliefs", async (_req, res) => {
    beliefsLog.debug("GET /api/beliefs");
    try {
      const beliefs = await memoryBeliefStorage.getAll();
      res.json(beliefs);
    } catch (error: any) {
      beliefsLog.error("GET /api/beliefs error:", { error: error?.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/beliefs/:id", async (req, res) => {
    beliefsLog.debug(`GET /api/beliefs/${req.params.id}`);
    try {
      const belief = await memoryBeliefStorage.getById(req.params.id);
      if (!belief) return res.status(404).json({ error: "Belief not found" });
      res.json(belief);
    } catch (error: any) {
      beliefsLog.error("GET /api/beliefs/:id error:", { error: error?.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/beliefs", async (req, res) => {
    beliefsLog.log("POST /api/beliefs");
    try {
      const { claim, domain, confidence, evidence, status, principleRef, tags } = req.body;
      if (!claim || !domain) {
        return res.status(400).json({ error: "claim and domain are required" });
      }
      const belief = await memoryBeliefStorage.create({
        claim, domain, confidence, evidence, status, principleRef, tags,
      });
      res.json(belief);
    } catch (error: any) {
      beliefsLog.error("POST /api/beliefs error:", { error: error?.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/beliefs/:id", async (req, res) => {
    beliefsLog.log(`PUT /api/beliefs/${req.params.id}`);
    try {
      const updated = await memoryBeliefStorage.update(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: "Belief not found" });
      res.json(updated);
    } catch (error: any) {
      beliefsLog.error("PUT /api/beliefs/:id error:", { error: error?.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/beliefs/:id", async (req, res) => {
    beliefsLog.log(`DELETE /api/beliefs/${req.params.id}`);
    try {
      const deleted = await memoryBeliefStorage.delete(req.params.id);
      if (!deleted) return res.status(404).json({ error: "Belief not found" });
      res.json({ message: "Belief deleted" });
    } catch (error: any) {
      beliefsLog.error("DELETE /api/beliefs/:id error:", { error: error?.message });
      res.status(500).json({ error: error.message });
    }
  });

  const { fileEmotionalStateStorage } = await import("../file-storage/emotional-state");

  app.get("/api/emotional-state", async (_req, res) => {
    log.debug("GET /api/emotional-state");
    try {
      const current = await fileEmotionalStateStorage.getCurrent();
      res.json(current);
    } catch (error: any) {
      log.error("GET /api/emotional-state error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/emotional-state/history", async (req, res) => {
    log.debug("GET /api/emotional-state/history");
    try {
      const since = req.query.since as string;
      if (since) {
        const entries = await fileEmotionalStateStorage.getHistory(since);
        res.json(entries);
      } else {
        const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
        const entries = await fileEmotionalStateStorage.getRecent(limit);
        res.json(entries);
      }
    } catch (error: any) {
      log.error("GET /api/emotional-state/history error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/emotional-state/:id", async (req, res) => {
    log.debug("PUT /api/emotional-state/" + req.params.id);
    try {
      if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: "Invalid emotional state ID" });
      }
      const clearableField = z.enum(["triggers", "context", "narrative"]);
      const expectedSchema = z.object({
        stateName: z.string().min(1),
        valence: z.number().min(-1).max(1),
        arousal: z.number().min(0).max(1),
        triggers: z.array(z.string()),
        context: z.string(),
        narrative: z.string(),
      }).strict();
      const schema = z.object({
        stateName: z.string().trim().min(1).optional(),
        valence: z.number().min(-1).max(1).optional(),
        arousal: z.number().min(0).max(1).optional(),
        triggers: z.array(z.string().trim().min(1)).min(1).optional(),
        context: z.string().trim().min(1).optional(),
        narrative: z.string().trim().min(1).optional(),
        clearFields: z.array(clearableField).max(3).optional(),
        expected: expectedSchema,
      }).strict().superRefine((data, ctx) => {
        const mutationFields = ["stateName", "valence", "arousal", "triggers", "context", "narrative"] as const;
        if (!mutationFields.some((field) => data[field] !== undefined) && !data.clearFields?.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one update is required" });
        }
        const clearFields = new Set(data.clearFields || []);
        if (clearFields.size !== (data.clearFields?.length || 0)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "clearFields cannot contain duplicates" });
        }
        for (const field of ["triggers", "context", "narrative"] as const) {
          if (data[field] !== undefined && clearFields.has(field)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} cannot be set and cleared together` });
          }
        }
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const entry = await fileEmotionalStateStorage.update(req.params.id, parsed.data);
      if (!entry) return res.status(409).json({ error: "Emotional state changed elsewhere. Refresh before saving." });
      const { eventBus } = await import("../event-bus");
      eventBus.publish({
        category: "agent",
        event: "cognition.emotion.changed",
        payload: { stateId: entry.id, stateName: entry.stateName, valence: entry.valence, arousal: entry.arousal },
      });
      res.json(entry);
    } catch (error: any) {
      log.error("PUT /api/emotional-state/:id error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/emotional-state", async (req, res) => {
    log.debug("POST /api/emotional-state mood=", req.body?.mood || req.body?.stateName);
    try {
      const schema = z.object({
        mood: z.string().min(1).optional(),
        stateName: z.string().min(1).optional(),
        valence: z.number().min(-1).max(1).optional(),
        arousal: z.number().min(0).max(1).optional(),
        intensity: z.number().min(1).max(10).optional(),
        triggers: z.array(z.string()).optional(),
        context: z.string().optional(),
        narrative: z.string().optional(),
        source: z.enum(["explicit", "inferred", "behavioral"]).optional(),
      }).refine(data => data.mood || data.stateName, {
        message: "Either mood or stateName is required",
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      }
      const entry = await fileEmotionalStateStorage.record(parsed.data);
      const { eventBus } = await import("../event-bus");
      eventBus.publish({
        category: "agent",
        event: "cognition.emotion.changed",
        payload: { stateId: entry.id, stateName: entry.stateName, valence: entry.valence, arousal: entry.arousal },
      });
      res.json(entry);
    } catch (error: any) {
      log.error("POST /api/emotional-state error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });


    // === Thesis Calibration Route ===
  app.get("/api/theses/calibration", async (req, res) => {
    log.debug("GET /api/theses/calibration");
    try {
      const { thesisStorage } = await import("../thesis-storage");
      const thesisId = typeof req.query.thesisId === "string" ? req.query.thesisId : undefined;
      const result = await thesisStorage.computeBrierScore(thesisId);
      res.json(result);
    } catch (error: any) {
      log.error("GET /api/theses/calibration error:", error?.message);
      res.status(500).json({ error: error.message });
    }
  });

  // === Acceptance Tests Routes ===
  const ACCEPTANCE_TESTS_PATH = resolve("ACCEPTANCE_TESTS.md");

  interface TestNode {
    id: string;
    title: string;
    level: number;
    children: TestNode[];
    tests: Array<{ id: string; label: string; checked: boolean }>;
  }

  interface FlatTest {
    id: string;
    label: string;
    checked: boolean;
    path: string[];
  }

  function parseAcceptanceTests(content: string): TestNode[] {
    const root: TestNode[] = [];
    const stack: TestNode[] = [];

    for (const line of content.split("\n")) {
      const headingMatch = line.match(/^(#{2,6})\s+(\d+(?:\.\d+)*)\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length - 1;
        const id = headingMatch[2];
        const title = headingMatch[3].trim();
        const node: TestNode = { id, title, level, children: [], tests: [] };

        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(node);
        } else {
          root.push(node);
        }
        stack.push(node);
        continue;
      }

      const testMatch = line.match(/^- \[([ xX])\]\s+(\d+(?:\.\d+)*)\s+(.+)$/);
      if (testMatch && stack.length > 0) {
        const checked = testMatch[1].toLowerCase() === "x";
        const id = testMatch[2];
        const label = testMatch[3].trim();
        stack[stack.length - 1].tests.push({ id, label, checked });
      }
    }
    return root;
  }

  function flattenTests(nodes: TestNode[], path: string[] = []): FlatTest[] {
    const result: FlatTest[] = [];
    for (const node of nodes) {
      const currentPath = [...path, node.title];
      for (const test of node.tests) {
        result.push({ id: test.id, label: test.label, checked: test.checked, path: currentPath });
      }
      result.push(...flattenTests(node.children, currentPath));
    }
    return result;
  }
}
