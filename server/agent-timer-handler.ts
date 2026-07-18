// Use createLogger for logging ONLY
import type { Timer, TimerRun } from "@shared/models/timers";
import { generateToolCallId } from "./file-storage/utils";
import { getModelForActivity, ACTIVITY_CHAT } from "./job-profiles";
import { createLogger } from "./log";
import { formatMessageTimestamp, nowMessageTimestamp } from "./timezone";
import type { TimerHandler, TimerHandlerResult } from "./timer-handlers";

const log = createLogger("AgentTimerHandler");

export class AgentTimerHandler implements TimerHandler {
  async execute(timer: Timer, run: TimerRun): Promise<TimerHandlerResult> {
    const { chatStorage } = await import("./integrations/chat/storage");
    const { agentExecutor } = await import("./agent-executor");
    const { assembleContext } = await import("./agent-context");
    const { getToolSchemas: getToolDefinitions } =
      await import("./tool-registry");
    const { executeTool } = await import("./bridge-tools");
    const { writeJournal } = await import("./chat-journal");
    const { recordToolCallStart, recordToolCallEnd } =
      await import("./file-storage/tool-stats");
    type ExecutorMessageType = import("./agent-executor").ExecutorMessage;
    type StreamEventType = import("./agent-executor").StreamEvent;

    const sessionKey = `timer:${timer.id}`;
    const title = `[Timer] ${timer.name}`;
    const session = await chatStorage.createSession(
      title,
      sessionKey,
      undefined,
      {
        provenance: {
          triggerType: "timer",
          triggerId: timer.id,
          triggerName: timer.name,
        },
      },
    );
    const sessionId = session.id;

    await chatStorage.createMessage(sessionId, "user", timer.prompt);

    const chatModel = getModelForActivity(ACTIVITY_CHAT);

    const journal = (type: string, extra: Record<string, unknown> = {}) => {
      writeJournal({
        ts: Date.now(),
        type,
        sessionKey,
        sessionId: String(sessionId),
        source: "agent",
        ...extra,
      } as Parameters<typeof writeJournal>[0]);
    };

    journal("model_info", { model: chatModel });

    const existingMessages = await chatStorage.getMessagesBySession(sessionId);
    const conversationHistory: Array<{
      role: "user" | "assistant" | "tool";
      content: string;
      toolCallId?: string;
      toolCalls?: unknown[];
      thinking?: string;
    }> = [];

    for (const msg of existingMessages) {
      if (msg.role === "user" || msg.role === "assistant") {
        const ts = msg.createdAt ? new Date(msg.createdAt) : new Date();
        const safeTs = isNaN(ts.getTime()) ? new Date() : ts;
        conversationHistory.push({
          role: msg.role as "user" | "assistant",
          content: `${formatMessageTimestamp(safeTs)} ${msg.content || ""}`,
          thinking: msg.thinking || undefined,
          toolCalls: Array.isArray(msg.toolCalls) ? msg.toolCalls : undefined,
        });
      }
    }
    const allToolDefs = getToolDefinitions();
    const toolDefs = allToolDefs.map(
      (t: { name: string; description: string; parameters: unknown }) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }),
    );

    const context = await assembleContext({
      profile: "chat",
      conversationHistory,
      toolDefinitions: allToolDefs.map(
        (t: { name: string; description: string }) => ({
          name: t.name,
          description: t.description,
        }),
      ),
      model: chatModel,
    });

    const messages: ExecutorMessageType[] = [
      { role: "system", content: context.systemPrompt },
    ];
    for (const msg of context.messages) {
      messages.push({
        role: msg.role as ExecutorMessageType["role"],
        content: msg.content,
      });
    }
    messages.push({
      role: "user",
      content: `${nowMessageTimestamp()} ${timer.prompt}`,
    });

    const toolCallsData: Array<Record<string, unknown>> = [];

    const toolExecutor = async (
      name: string,
      args: Record<string, unknown>,
    ) => {
      const toolCallId = generateToolCallId();
      const toolResult = await executeTool(name, toolCallId, args, {
        sessionKey,
        sessionId,
      });
      return {
        result: toolResult.result,
        error: toolResult.error,
        sideEffectOnly: toolResult.sideEffectOnly,
        continuation: toolResult.continuation,
      };
    };

    const onEvent = (event: StreamEventType) => {
      switch (event.type) {
        case "tool_call": {
          const existing = toolCallsData.find(
            (t) => t.toolCallId === event.toolCallId,
          );
          if (existing) {
            if (event.arguments) existing.arguments = event.arguments;
          } else {
            if (event.toolCallId)
              recordToolCallStart(
                String(event.toolCallId),
                String(event.toolName || "unknown"),
              );
            toolCallsData.push({
              toolName: event.toolName,
              status: "running",
              toolCallId: event.toolCallId,
              arguments: event.arguments,
            });
          }
          break;
        }
        case "tool_result": {
          const tool = toolCallsData.find(
            (t) => t.toolCallId === event.toolCallId,
          );
          if (tool) {
            tool.status = event.isError ? "error" : "done";
            tool.result = event.result;
            if (event.isError) tool.error = String(event.result);
          }
          if (event.toolCallId)
            recordToolCallEnd(String(event.toolCallId), !!event.isError);
          break;
        }
      }
    };

    const result = await agentExecutor.run({
      sessionKey,
      sessionId,
      messages,
      tools: toolDefs as any,
      toolExecutor,
      activity: ACTIVITY_CHAT,
      model: chatModel,
      onEvent,
      querySubsystem: "autonomous",
      tier: "background",
    });

    if (result.terminationReason === "yield_to_interactive") {
      log.debug(
        `Timer chat run "${timer.name}" yielded to interactive session — yielding to scheduler finalizer`,
      );
      return { outcome: "skipped", reason: "yield_to_interactive" };
    }

    if (result.error && result.error === "admission_timeout") {
      throw new Error("admission_timeout");
    }

    if (result.error || result.abortReason) {
      const errorMsg = result.error || result.abortReason || "Unknown error";
      throw new Error(errorMsg);
    }

    const savedMsg = await chatStorage.createMessage(
      sessionId,
      "assistant",
      result.content || "(no response)",
      result.thinking || undefined,
      toolCallsData.length > 0 ? toolCallsData : undefined,
      result.model || chatModel,
    );

    const conv = await chatStorage.getSession(sessionId);
    if (conv && conv.status !== "saved") {
      await chatStorage.saveSession(sessionId, conv.title);
    }

    if (timer.type === "reminder") {
      await chatStorage.setHasUnreadResult(String(sessionId), true);
    }

    if (savedMsg) {
      journal("saved", {
        messageId: savedMsg.id,
        fullResponse: result.content,
        thinking: result.thinking || undefined,
        toolCalls: toolCallsData.length > 0 ? toolCallsData : undefined,
      });
    }

    await withQueryAttributionAsync("timer-scheduler", () =>
      timerStorage.updateRun(timer, run.id, {
        sessionId: String(sessionId),
      }),
    );
    return { outcome: "success", output: { sessionId: String(sessionId) } };
  }

}
