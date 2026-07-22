import type {
  SystemStepRecord,
  ToolCallInfo,
} from "@shared/models/chat";
import type { StreamingContent } from "@shared/streaming-types";
import type { SegmentChronologyEntry } from "./chat-file-storage";

export interface AssistantDraftProjection {
  content: string;
  thinking?: string;
  toolCalls: ToolCallInfo[];
  systemSteps: SystemStepRecord[];
  segmentChronology: SegmentChronologyEntry[];
}

/**
 * Projects the canonical live transcript into the existing durable assistant
 * message contract. Segment boundaries remain explicit so an interrupted turn
 * reloads with the same prose, tools, and diagnostic order the user already saw.
 */
export function projectAssistantDraft(
  streamingContent: StreamingContent,
): AssistantDraftProjection {
  const contentParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: ToolCallInfo[] = [];
  const systemSteps: SystemStepRecord[] = [];
  const segmentChronology: SegmentChronologyEntry[] = [];

  for (const segment of streamingContent.segments) {
    if (segment.type === "content") {
      if (!segment.content) continue;
      contentParts.push(segment.content);
      segmentChronology.push({ s: "content", c: segment.content });
      continue;
    }

    for (const step of segment.steps) {
      if (step.type === "thinking") {
        if (!step.thinking) continue;
        thinkingParts.push(step.thinking);
        segmentChronology.push({ s: "thinking", c: step.thinking });
        continue;
      }

      if (step.type === "tool_call") {
        const toolIndex = toolCalls.length;
        toolCalls.push({
          toolName: step.toolName || "unknown",
          status:
            step.status === "error"
              ? "error"
              : step.status === "done"
                ? "done"
                : "running",
          arguments: step.arguments,
          toolCallId: step.toolCallId,
          result: step.result,
          error: step.error,
          parentId: step.parentId,
        });
        segmentChronology.push({ s: "tool", i: toolIndex });
        continue;
      }

      const systemIndex = systemSteps.length;
      systemSteps.push({
        id: step.id,
        name:
          step.type === "compacting"
            ? "working_context_compression"
            : step.systemStepName || "unknown",
        status: step.status === "error" ? "error" : "done",
        elapsedMs: step.elapsedMs,
        parentId: step.parentId,
        selfTimeMs: step.selfTimeMs,
        startedAt: step.startedAt ?? step.timestamp,
        endedAt: step.endedAt,
        detail:
          step.type === "compacting"
            ? step.thinking
            : step.systemStepDetail,
        metadata: step.systemStepMetadata,
        timingKind: step.timingKind,
        diagnosticVisibility: step.diagnosticVisibility,
        childMode: step.childMode,
        occurredAt: step.occurredAt,
      });
      segmentChronology.push({ s: "system", i: systemIndex });
    }
  }

  return {
    content: contentParts.join(""),
    thinking:
      thinkingParts.length > 0 ? thinkingParts.join("\n\n") : undefined,
    toolCalls,
    systemSteps,
    segmentChronology,
  };
}
