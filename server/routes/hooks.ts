import type { Express } from "express";
import * as hookStorage from "../hook-storage";
import { hookExecutor } from "../hook-executor";
import { eventBus } from "../event-bus";
import { requireAuth } from "../auth";

export function registerHooksRoutes(app: Express) {
  app.use("/api/hooks", requireAuth);

  app.get("/api/hooks", async (_req, res) => {
    try {
      const hooks = await hookStorage.listHooks();
      res.json({ hooks });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/hooks/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid hook ID" });

      const hook = await hookStorage.getHook(id);
      if (!hook) return res.status(404).json({ error: "Hook not found" });

      const executions = await hookStorage.getExecutions(id, 20);
      res.json({ hook, executions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/hooks", async (req, res) => {
    try {
      const { name, description, eventPattern, condition, actionType, actionConfig, cooldownSeconds, enabled, createdBy } = req.body;

      if (!name || !eventPattern || !actionType || !actionConfig) {
        return res.status(400).json({ error: "Missing required fields: name, eventPattern, actionType, actionConfig" });
      }

      if (!["run_skill", "initiate_conversation", "tool_call"].includes(actionType)) {
        return res.status(400).json({ error: "actionType must be one of: run_skill, initiate_conversation, tool_call" });
      }

      const hook = await hookStorage.createHook({
        name,
        description,
        eventPattern,
        condition,
        actionType,
        actionConfig,
        cooldownSeconds,
        enabled,
        createdBy,
      });

      hookExecutor.invalidateCache();
      res.status(201).json({ hook });
    } catch (error: any) {
      if (error.message?.includes("unique") || error.message?.includes("duplicate")) {
        return res.status(409).json({ error: "A hook with that name already exists" });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/hooks/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid hook ID" });

      const existing = await hookStorage.getHook(id);
      if (!existing) return res.status(404).json({ error: "Hook not found" });

      const { name, description, eventPattern, condition, actionType, actionConfig, cooldownSeconds, enabled } = req.body;

      if (actionType && !["run_skill", "initiate_conversation", "tool_call"].includes(actionType)) {
        return res.status(400).json({ error: "actionType must be one of: run_skill, initiate_conversation, tool_call" });
      }

      const updateData: any = {};
      if (name !== undefined) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (eventPattern !== undefined) updateData.eventPattern = eventPattern;
      if (condition !== undefined) updateData.condition = condition;
      if (actionType !== undefined) updateData.actionType = actionType;
      if (actionConfig !== undefined) updateData.actionConfig = actionConfig;
      if (cooldownSeconds !== undefined) updateData.cooldownSeconds = cooldownSeconds;
      if (enabled !== undefined) updateData.enabled = enabled;

      const hook = await hookStorage.updateHook(id, updateData);
      hookExecutor.invalidateCache();
      res.json({ hook });
    } catch (error: any) {
      if (error.message?.includes("unique") || error.message?.includes("duplicate")) {
        return res.status(409).json({ error: "A hook with that name already exists" });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/hooks/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid hook ID" });

      const existing = await hookStorage.getHook(id);
      if (!existing) return res.status(404).json({ error: "Hook not found" });

      await hookStorage.deleteHook(id);
      hookExecutor.invalidateCache();
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/hooks/:id/executions", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid hook ID" });

      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const executions = await hookStorage.getExecutions(id, limit);
      res.json({ executions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/hooks/:id/test", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid hook ID" });

      const hook = await hookStorage.getHook(id);
      if (!hook) return res.status(404).json({ error: "Hook not found" });

      const { eventId } = req.body;
      let testEvent: any;

      if (eventId) {
        const recentEvents = eventBus.getRecentEvents(500, undefined, req.principal);
        testEvent = recentEvents.find(e => e.id === eventId);
        if (!testEvent) {
          return res.status(404).json({ error: "Event not found in current process buffer" });
        }
      } else {
        testEvent = {
          id: "test-event",
          timestamp: Date.now(),
          category: "test",
          event: req.body.testEvent || "test.event",
          payload: req.body.testPayload || {},
          bootId: eventBus.bootId,
        };
      }

      const result = hookExecutor.testHook(
        {
          eventPattern: hook.eventPattern,
          condition: hook.condition,
          actionConfig: hook.actionConfig,
        },
        testEvent
      );

      res.json({
        hook: { id: hook.id, name: hook.name },
        event: { id: testEvent.id, event: testEvent.event, category: testEvent.category },
        ...result,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
