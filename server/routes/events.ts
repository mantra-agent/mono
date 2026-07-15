import type { Express } from "express";
import type { IncomingMessage } from "http";
import { eventBus, isEventVisibleToPrincipal, type BusEvent } from "../event-bus";
import { getCached } from "./shared";
import { setWsConnectionCount } from "../performance-monitor";
import { WebSocketServer, WebSocket } from "ws";
import { createLogger } from "../log";
import { isClientPresenceKind } from "@shared/client-presence";
import { registerClientPresence, subscribeClientPresence, unregisterSocketPresence } from "../client-presence";
import { registerEventSocket, setEventSocketSessionSubscription, unregisterEventSocket } from "../realtime-transport-metrics";
import { sessionManager } from "../session-manager";
import type { Principal } from "../principal";
import { runWithPrincipal } from "../principal-context";
import { chatFileStorage } from "../chat-file-storage";
import { requirePermission } from "../permissions";

const eventsLog = createLogger("EventsWS");
let eventsConnectionCounter = 0;

export async function registerEventsRoutes(app: Express, wss: WebSocketServer, eventsWss: WebSocketServer) {
  const PING_INTERVAL_MS = 30_000;

  eventsWss.on("connection", (ws, request) => {
    const principal = (request as IncomingMessage & { eventPrincipal?: Principal }).eventPrincipal;
    if (!principal || principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      eventsLog.error("WS:CONNECTION_WITHOUT_PRINCIPAL");
      ws.close(1008, "Authentication required");
      return;
    }
    const totalClients = eventsWss.clients.size;
    const connectTime = Date.now();
    const connectionId = `events-ws-${++eventsConnectionCounter}`;
    registerEventSocket(connectionId);
    setWsConnectionCount(wss.clients.size + totalClients);
    eventsLog.log("WS:CONNECT", { connectionId, eventBusSubscribers: eventBus.listenerCount("event"), eventsWssClients: totalClients });

    // Server-authoritative session subscriptions (by sessionId).
    const subscribedSessionIds = new Set<string>();
    const accountId = principal.accountId;

    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
        } catch (err) {
          eventsLog.warn(`ping send failed: ${(err as Error).message}`);
        }
      }
    }, PING_INTERVAL_MS);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "pong") return;
        if (msg.type === "beacon") {
          eventsLog.log(`client beacon event=${msg.event} details=${JSON.stringify(msg)}`);
          return;
        }
        if (msg.type === "client_presence.subscribe") {
          subscribeClientPresence(ws, accountId);
          return;
        }
        if (msg.type === "client_presence.register" && isClientPresenceKind(msg.kind)) {
          registerClientPresence(ws, accountId, msg.kind, typeof msg.clientId === "string" ? msg.clientId : undefined);
          return;
        }
        // Server-authoritative session subscription (by sessionId)
        if (msg.type === "session.subscribe" && typeof msg.sessionId === "string") {
          const subSessionId = msg.sessionId;
          const identity = {
            connectionId,
            tabId: typeof msg.tabId === "string" ? msg.tabId : undefined,
            handlerId: typeof msg.handlerId === "string" ? msg.handlerId : undefined,
            owner: typeof msg.owner === "string" ? msg.owner : undefined,
            activeSession: typeof msg.activeSession === "string" ? msg.activeSession : null,
          };
          void runWithPrincipal(principal, async () => {
            const visibleSession = await chatFileStorage.getSession(subSessionId);
            if (!visibleSession || ws.readyState !== WebSocket.OPEN) {
              eventsLog.warn("WS:SESSION:SUBSCRIBE_DENIED", { connectionId, sessionId: subSessionId, accountId });
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "session.subscription_denied", sessionId: subSessionId }));
              }
              return;
            }
            const alreadySubscribed = subscribedSessionIds.has(subSessionId);
            if (!alreadySubscribed) {
              subscribedSessionIds.add(subSessionId);
              setEventSocketSessionSubscription(connectionId, subSessionId, true);
            }
            eventsLog.debug(alreadySubscribed ? "WS:SESSION:RESUBSCRIBE" : "WS:SESSION:SUBSCRIBE", { sessionId: subSessionId, subscriptions: subscribedSessionIds.size, ...identity });
            const snapshot = sessionManager.subscribe(subSessionId, ws, identity);
            const payload = snapshot ?? {
              sessionId: subSessionId,
              status: "idle" as const,
              streamingContent: null,
              subscriberCount: 0,
            };
            ws.send(JSON.stringify({ type: "session.snapshot", ...payload }));
          }).catch((error) => {
            eventsLog.error("WS:SESSION:SUBSCRIBE_FAILED", {
              connectionId,
              sessionId: subSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        if (msg.type === "session.unsubscribe" && typeof msg.sessionId === "string") {
          const unsubSessionId = msg.sessionId;
          const identity = {
            connectionId,
            tabId: typeof msg.tabId === "string" ? msg.tabId : undefined,
            handlerId: typeof msg.handlerId === "string" ? msg.handlerId : undefined,
            owner: typeof msg.owner === "string" ? msg.owner : undefined,
            activeSession: typeof msg.activeSession === "string" ? msg.activeSession : null,
          };
          const hadSubscription = subscribedSessionIds.has(unsubSessionId);
          eventsLog.debug("WS:SESSION:UNSUBSCRIBE", { sessionId: unsubSessionId, subscriptions: subscribedSessionIds.size, hadSubscription, ...identity });
          const remainsSubscribed = sessionManager.unsubscribe(unsubSessionId, ws, identity);
          if (!remainsSubscribed) {
            subscribedSessionIds.delete(unsubSessionId);
            setEventSocketSessionSubscription(connectionId, unsubSessionId, false);
          }
          return;
        }
      } catch { /* ignore non-JSON client messages */ }
    });

    ws.on("close", (code, reason) => {
      clearInterval(pingTimer);
      const duration = Date.now() - connectTime;
      const remaining = eventsWss.clients.size;
      setWsConnectionCount(wss.clients.size + remaining);
      unregisterEventSocket(connectionId, code);
      eventsLog.log("WS:DISCONNECT", { connectionId, code, reason: reason?.toString() || "none", durationMs: duration, remainingSessionSubscriptions: subscribedSessionIds.size, eventBusSubscribers: eventBus.listenerCount("event"), eventsWssClients: remaining });
      eventBus.removeListener("event", handler);
      unregisterSocketPresence(ws);

      // Unsubscribe from all server-authoritative sessions on disconnect
      if (subscribedSessionIds.size > 0) {
        sessionManager.unsubscribeAll(ws);
        subscribedSessionIds.clear();
      }
    });

    ws.send(JSON.stringify({ type: "connected", message: "Event stream connected" }));

    const recent = eventBus.getRecentEvents(50);
    if (recent.length > 0) {
      // Strip chat.stream events from generic history — those should only flow
      // to subscribed sessions (via the subscribe replay path).
      const filtered = recent.filter(e => e.event !== "chat.stream" && isEventVisibleToPrincipal(e, principal));
      if (filtered.length > 0) {
        ws.send(JSON.stringify({ type: "history", events: filtered }));
        eventsLog.debug(`sent ${filtered.length} history events to new client (filtered from ${recent.length})`);
      }
    }

    const handler = (event: BusEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // chat.stream events are now handled by server-authoritative session
      // subscriptions (session.subscribe/session.unsubscribe). Skip them
      // from the generic broadcast path to avoid duplicate delivery.
      if (event.event === "chat.stream" || !isEventVisibleToPrincipal(event, principal)) return;
      try {
        ws.send(JSON.stringify({ type: "event", event }));
      } catch (err) {
        eventsLog.warn(`event send failed: ${(err as Error).message}`);
      }
    };

    eventBus.on("event", handler);
  });


  app.use("/api/events", requirePermission("system:read"));

  app.get("/api/events", (_req, res) => {
    try {
      const limit = Math.min(parseInt(_req.query.limit as string) || 100, 500);
      const category = _req.query.category as string | undefined;
      const runId = _req.query.runId as string | undefined;
      const eventFilter = _req.query.event as string | undefined;

      const events = eventBus.getRecentEvents(limit, {
        category: category || undefined,
        runId: runId || undefined,
        event: eventFilter || undefined,
      }, _req.principal);
      res.json({ events, total: eventBus.getBufferSize() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/events/history", async (req, res) => {
    try {
      const { queryEvents } = await import("../event-persistence");
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
      const offset = parseInt(req.query.offset as string) || 0;
      const category = req.query.category as string | undefined;
      const event = req.query.event as string | undefined;
      const startDate = req.query.startDate as string | undefined;
      const endDate = req.query.endDate as string | undefined;
      const runId = req.query.runId as string | undefined;
      const sessionKey = req.query.sessionKey as string | undefined;

      let payloadQuery: Record<string, any> | undefined;
      if (req.query.payloadQuery) {
        try {
          payloadQuery = JSON.parse(req.query.payloadQuery as string);
        } catch {
          return res.status(400).json({ error: "payloadQuery must be valid JSON" });
        }
      }

      const result = await queryEvents({
        category: category || undefined,
        event: event || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        runId: runId || undefined,
        sessionKey: sessionKey || undefined,
        payloadQuery,
        limit,
        offset,
        principal: req.principal,
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/events/runs", (_req, res) => {
    try {
      const runs = eventBus.getActiveRuns(_req.principal);
      res.json({ runs });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/events/runs/:runId", (req, res) => {
    try {
      const events = eventBus.getRunEvents(req.params.runId, req.principal);
      res.json({ events });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/events/runs/:runId/clear", (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "manual_cleanup";
      const result = eventBus.clearActiveRun(req.params.runId, reason, req.principal);
      if (!result.cleared) {
        res.status(404).json(result);
        return;
      }
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/tools", async (_req, res) => {
    try {
      const { getAllTools } = await import("../tool-registry");
      const { formatToolDetailForLLM } = await import("../tool-details");
      const result = await getCached("tools:list", 15000, async () => {
        const tools = await getAllTools();

        let totalUsageCount = 0;
        let uniqueToolsUsed = 0;
        for (const t of tools) {
          totalUsageCount += t.usageCount;
          if (t.usageCount > 0) uniqueToolsUsed++;
        }

        const mapped = tools.map(t => ({
          name: t.name,
          description: t.description,
          detailedDescription: formatToolDetailForLLM(t.name),
          category: t.category,
          usageCount: t.usageCount,
          lastUsed: t.lastUsed,
          discovered: t.usageCount > 0,
          source: t.source,

          errors: t.errors,
          avgDuration: t.avgDuration,
        }));

        mapped.sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));

        return { tools: mapped, totalUsageCount, uniqueToolsUsed };
      });
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/tool-icons", async (_req, res) => {
    try {
      const { getSetting } = await import("../system-settings");
      const overrides = await getSetting<Record<string, string>>("tool_icon_overrides");
      res.json(overrides || {});
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/tool-icons", async (req, res) => {
    try {
      const { getSetting, setSetting } = await import("../system-settings");
      const incoming = req.body;
      if (typeof incoming !== "object" || Array.isArray(incoming)) {
        return res.status(400).json({ error: "Body must be a JSON object mapping tool names to icon names" });
      }
      const existing = (await getSetting<Record<string, string>>("tool_icon_overrides")) || {};
      const merged = { ...existing, ...incoming };
      await setSetting("tool_icon_overrides", merged);
      res.json(merged);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/agent/tools/:toolName", async (req, res) => {
    try {
      const { isBridgeTool, executeBridgeTool } = await import("../bridge-tools");
      const toolName = req.params.toolName;
      if (!isBridgeTool(toolName)) {
        return res.status(404).json({ error: `Unknown bridge tool: ${toolName}` });
      }
      const toolCallId = req.body.toolCallId || `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await executeBridgeTool(toolName, toolCallId, req.body.arguments || req.body);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/session-runs", async (_req, res) => {
    try {
      const limit = Math.min(parseInt(_req.query.limit as string) || 30, 100);

      const { readdir } = await import("fs/promises");
      const { join } = await import("path");
      const { readJournalFile } = await import("../chat-journal");
      const journalDir = join(process.cwd(), "logs", "journals");
      let journalFiles: string[] = [];
      try { journalFiles = (await readdir(journalDir)).filter(f => f.endsWith(".jsonl")); } catch {}
      
      const allEntries: Array<{ sessionId: string; entry: any }> = [];
      for (const file of journalFiles) {
        const sessionId = file.replace(".jsonl", "");
        const entries = await readJournalFile(sessionId);
        for (const entry of entries) {
          allEntries.push({ sessionId, entry });
        }
      }

      if (allEntries.length === 0) {
        return res.json({ runs: [] });
      }

      const narrateToolCall = (toolName: string, args: any): string => {
        switch (toolName) {
          case "memory":
          case "memory_search": return args?.action === "search" || toolName === "memory_search" ? `Searched memory for "${args?.query || "..."}"` : `Memory ${args?.action || "operation"}`;
          case "memory_store": return `Stored information in memory`;
          case "web_search":
          case "brave_search": return `Searched the web for "${args?.query || args?.q || "..."}"`;
          case "web_fetch": return `Fetched web page: ${args?.url || "..."}`;
          case "read":
          case "read_scratch": return `Read file: ${args?.path || args?.file_path || "..."}`;
          case "write":
          case "write_scratch": return `Wrote to file: ${args?.path || args?.file_path || "..."}`;
          case "edit":
          case "edit_scratch": return `Edited file: ${args?.path || args?.file_path || "..."}`;
          case "search_scratch": return `Searched files: ${args?.pattern || "..."}`;
          case "shell":
          case "bash": return `Ran command: ${args?.command || "..."}`;
          case "list_scratch":
          case "list_directory": return `Listed directory: ${args?.path || "."}`;
          case "write_file": return `Saved file: ${args?.fileName || args?.file_name || "..."}`;
          case "read_file": return `Read persistent file: ${args?.filePath || args?.file_path || "..."}`;
          case "list_files": return `Listed persistent files`;
          case "send_message": return `Sent message to ${args?.channel || args?.to || "..."}`;
          default: {
            const argStr = args ? JSON.stringify(args) : "";
            return `Called ${toolName}${argStr.length < 100 ? `: ${argStr}` : ""}`;
          }
        }
      };

      interface RunStep {
        type: "thinking" | "tool_call" | "tool_result" | "response";
        ts: number;
        content: string;
        toolName?: string;
        toolCallId?: string;
        arguments?: any;
        result?: any;
        isError?: boolean;
        narrative?: string;
      }

      interface SessionRun {
        id: string;
        runId: string;
        sessionId: string;
        timestamp: number;
        userMessage: string;
        assistantResponse: string;
        model: string;
        steps: RunStep[];
        status: "complete" | "error" | "running";
      }

      const convEntries = new Map<string, any[]>();
      for (const { sessionId, entry } of allEntries) {
        let arr = convEntries.get(sessionId);
        if (!arr) {
          arr = [];
          convEntries.set(sessionId, arr);
        }
        arr.push(entry);
      }

      for (const [, arr] of Array.from(convEntries)) {
        arr.sort((a: any, b: any) => (a.ts || 0) - (b.ts || 0));
      }

      const runs: SessionRun[] = [];

      for (const [convId, convLines] of Array.from(convEntries)) {
        if (runs.length >= limit) break;

        const runMap = new Map<string, { entries: Array<any>; startTs: number; model: string }>();
        let lastRunId: string | null = null;
        let currentModel = "";

        for (const entry of convLines) {
          if (entry.type === "model_info") {
            currentModel = entry.model || "";
            if (lastRunId && runMap.has(lastRunId)) {
              runMap.get(lastRunId)!.model = currentModel;
            }
            continue;
          }
          const runId = entry.runId;
          if (entry.type === "run_start" && runId) {
            runMap.set(runId, { entries: [entry], startTs: entry.ts, model: currentModel });
            lastRunId = runId;
          } else if (lastRunId && runMap.has(lastRunId)) {
            runMap.get(lastRunId)!.entries.push(entry);
          }
        }

        const runEntries = Array.from(runMap.entries());
        for (const [runId, { entries: runEntriesList, startTs, model: runModel }] of runEntries) {
          const steps: RunStep[] = [];
          let assistantResponse = "";
          let model = runModel;
          let hasError = false;
          let hasComplete = false;
          let messageId = "";

          for (const e of runEntriesList) {
            switch (e.type) {
              case "thinking":
                if (e.content) {
                  steps.push({ type: "thinking", ts: e.ts, content: e.content });
                }
                break;
              case "thinking_complete":
                if (e.content && steps.filter((s: RunStep) => s.type === "thinking").length === 0) {
                  steps.push({ type: "thinking", ts: e.ts, content: e.content });
                }
                break;
              case "tool_call":
                steps.push({
                  type: "tool_call",
                  ts: e.ts,
                  content: narrateToolCall(e.toolName, e.arguments),
                  toolName: e.toolName,
                  toolCallId: e.toolCallId,
                  arguments: e.arguments,
                  narrative: narrateToolCall(e.toolName, e.arguments),
                });
                break;
              case "tool_result":
                steps.push({
                  type: "tool_result",
                  ts: e.ts,
                  content: typeof e.result === "string" ? e.result : JSON.stringify(e.result || ""),
                  toolCallId: e.toolCallId,
                  result: e.result,
                  isError: !!e.error,
                } as any);
                break;
              case "model_info":
                model = e.model || "";
                break;
              case "saved":
                if (e.fullResponse) assistantResponse = e.fullResponse;
                if (e.messageId) messageId = e.messageId;
                break;
              case "error":
                hasError = true;
                steps.push({ type: "response", ts: e.ts, content: e.error || "Unknown error", isError: true });
                break;
              case "complete":
                hasComplete = true;
                break;
            }
          }

          runs.push({
            id: `${convId}-${runId}`,
            runId,
            sessionId: convId,
            timestamp: startTs,
            userMessage: "",
            assistantResponse,
            model,
            steps,
            status: hasError ? "error" : hasComplete ? "complete" : "running",
          });
        }
      }

      runs.sort((a, b) => b.timestamp - a.timestamp);
      res.json({ runs: runs.slice(0, limit) });
    } catch (error: any) {
      eventsLog.error(`session-runs error: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  // === Gmail Routes ===

}
