import type { Express } from "express";
import { goalsService } from "./goals-service";
import { createGoalSchema, updateGoalSchema } from "@shared/schema";
import { requireAuth } from "./auth";
import { getPrincipal } from "./principal";
import { completeFtueFirstGoalAndAddGoalPriority } from "./ftue-goals";
import type { GoalHorizon } from "@shared/schema";

export function registerGoalRoutes(app: Express): void {

  app.get("/api/life-goals", async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.horizon) filters.horizon = req.query.horizon as GoalHorizon;
      if (req.query.owner) filters.owner = req.query.owner as string;
      if (req.query.search) filters.search = req.query.search as string;
      if (req.query.tag) filters.tag = req.query.tag as string;
      // Period-scoped by default: completed goals only visible within their completion period.
      // Pass ?periodScoped=false to see all goals including prior-period completions.
      filters.periodScoped = req.query.periodScoped !== "false";
      // The Goals management page must see dormant goals so they can be managed/reactivated.
      // Pass ?includeDormant=false to get the display-default (dormant hidden) behavior.
      filters.includeDormant = req.query.includeDormant !== "false";
      const goals = await goalsService.listAll(filters);
      res.json({ goals });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/life-goals/graph", async (_req, res) => {
    try {
      const data = await goalsService.getGraphData();
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/life-goals/:id", async (req, res) => {
    try {
      const goal = await goalsService.get(req.params.id);
      if (!goal) return res.status(404).json({ error: "Goal not found" });
      res.json(goal);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/life-goals", requireAuth, async (req, res) => {
    try {
      const parsed = createGoalSchema.parse(req.body);
      const { goal } = await goalsService.create(parsed);
      const principal = getPrincipal(req);
      if (principal?.actorType === "user" && principal.userId && principal.accountId) {
        await completeFtueFirstGoalAndAddGoalPriority(principal as typeof principal & { userId: string; accountId: string }, goal);
      }
      res.status(201).json(goal);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/life-goals/:id", async (req, res) => {
    try {
      const parsed = updateGoalSchema.parse(req.body);
      const goal = await goalsService.update(req.params.id, parsed);
      res.json(goal);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Validation failed", details: error.errors });
      }
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/life-goals/:id/set-parent", async (req, res) => {
    try {
      const { parentId } = req.body;
      if (typeof parentId !== "string") {
        return res.status(400).json({ error: "parentId string is required" });
      }
      const existing = await goalsService.get(req.params.id);
      if (!existing) return res.status(404).json({ error: "Goal not found" });
      if (existing.parentId && existing.parentId !== parentId) {
        await goalsService.update(req.params.id, { parentId: null });
      }
      const goal = await goalsService.update(req.params.id, { parentId });
      res.json(goal);
    } catch (error: any) {
      if (error.message.includes("not found")) return res.status(404).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/life-goals/:id/unlink-parent", async (req, res) => {
    try {
      const goal = await goalsService.update(req.params.id, { parentId: null });
      res.json(goal);
    } catch (error: any) {
      if (error.message.includes("not found")) return res.status(404).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/life-goals/:id", async (req, res) => {
    try {
      await goalsService.delete(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/life-goals/:id/notes", async (req, res) => {
    try {
      const { content } = req.body;
      if (!content || typeof content !== "string") {
        return res.status(400).json({ error: "content is required" });
      }
      const note = await goalsService.addNote(req.params.id, content);
      res.status(201).json(note);
    } catch (error: any) {
      if (error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

}
