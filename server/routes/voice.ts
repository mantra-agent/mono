import { randomUUID } from "crypto";
import type { Express } from "express";
import { executorManager } from "../executor-manager";
import { eventBus } from "../event-bus";
import { createLogger } from "../log";
import { registerVoiceSessionRoutes } from "./voice-session";
import { registerVoiceConfigRoutes } from "./voice-config";
import { registerVoiceEngineRoutes } from "./voice-engine";
import { ACTIVITY_CHAT } from "../job-profiles";
import { requireAuth } from "../auth";

const voiceLog = createLogger("Voice");

export async function registerVoiceRoutes(app: Express) {
  await registerVoiceSessionRoutes(app);
  await registerVoiceConfigRoutes(app);
  registerVoiceEngineRoutes(app);

  app.post("/api/agent/query", requireAuth, async (req, res) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "message (string) is required" });
      }

      if (!executorManager.isRunning) {
        return res.status(503).json({ error: "Agent is not running" });
      }

      voiceLog.log(`agent-bridge query: ${message.slice(0, 100)}...`);
      const { agentExecutor } = await import("../agent-executor");
      const { getToolSchemas: getToolDefinitions } = await import("../tool-registry");
      const { executeTool } = await import("../bridge-tools");
      const { contextBuilder } = await import("../context-builder");

      const { filterToolSchemasForAuthority } = await import("../agent-authority");
      const toolDefs = filterToolSchemasForAuthority(getToolDefinitions(), { origin: "voice" });
      const queryId = `voice-query:${randomUUID()}`;
      const resolvedSpine = await contextBuilder.resolve({
        callType: "full",
        llmMode: "voice",
        contextBuildId: queryId,
        toolDefinitions: toolDefs.map(t => ({ name: t.name, description: t.description })),
      });
      const systemPrompt = contextBuilder.renderToPrompt(resolvedSpine);
      const tools = toolDefs.map(t => ({
        name: t.name,
        description: t.description,
        parameters: { type: "object" as const, properties: t.parameters.properties || {}, required: t.parameters.required },
      }));
      const toolExecutor = async (name: string, args: Record<string, any>) => {
        const r = await executeTool(name, `query-${Date.now()}`, args, { sessionKey: "voice-query", sessionId: "", authority: { origin: "voice" } });
        return { result: r.result, error: r.error, sideEffectOnly: r.sideEffectOnly, continuation: r.continuation };
      };

      const result = await agentExecutor.run({
        sessionKey: `agent-query-${Date.now()}`,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message },
        ],
        tools,
        toolExecutor,
        activity: ACTIVITY_CHAT,
      });
      const response = result.content || "Done.";

      voiceLog.log(`agent-bridge response: ${response.slice(0, 100)}...`);

      const lowerMsg = message.toLowerCase();
      const peopleMutationKeywords = ["log_interaction", "add_note", "add note", "log interaction", "record interaction", "contact", "person"];
      const touchesPeople = peopleMutationKeywords.some(kw => lowerMsg.includes(kw));
      if (touchesPeople) {
        eventBus.publish({
          category: "agent",
          event: "data:people_changed",
          payload: { source: "voice_agent", query: message.slice(0, 100) },
        });
      }

      res.json({ response, dataHints: touchesPeople ? ["people"] : [] });
    } catch (error: any) {
      voiceLog.error("agent-bridge error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

}
