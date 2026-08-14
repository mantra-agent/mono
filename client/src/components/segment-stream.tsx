import { Fragment, useEffect, useMemo, type ComponentType, type ReactNode } from "react";
import type { ExecutionStep, MessageSegment } from "@shared/streaming-types";
import type { VisibilityLayer } from "@/hooks/use-visibility-layer";
import { createLogger } from "@/lib/logger";

const log = createLogger("SegmentStream");

function segmentDebugSummary(seg: MessageSegment, index: number) {
  if (seg.type === "content") {
    return {
      index,
      type: "content",
      length: seg.content.length,
      preview: seg.content.replace(/\n/g, "\\n").slice(0, 80),
    };
  }

  return {
    index,
    type: "timeline",
    steps: seg.steps.map(step => ({
      type: step.type,
      status: step.status,
      systemStepName: step.systemStepName,
      title: step.title,
      hasThinking: !!step.thinking,
      hasResult: !!step.result,
      error: !!step.error,
    })),
  };
}

type RenderSegment =
  | { type: "content"; content: string; sourceIndexes: number[] }
  | { type: "timeline"; segment: Extract<MessageSegment, { type: "timeline" }>; sourceIndexes: number[] };

/** Canonical visibility policy for streamed execution steps. Kept with the renderer so
 * transport/replay consumers cannot omit or stale-inject a required callback. */
export function filterStepsByLayer(
  steps: ExecutionStep[],
  layer: VisibilityLayer,
  isActiveSession?: boolean,
): ExecutionStep[] {
  return steps.filter((step) => {
    if (step.type === "system" && step.systemStepName === "session_compaction") {
      return step.status === "active" || step.status === "error";
    }

    if (layer === 4) return true;
    if (step.type === "compacting") return false;

    if (step.type === "system") {
      if (step.systemStepName === "working_context_compression")
        return layer >= 1;
      if (step.systemStepName === "compaction") return layer >= 1;
      if (
        step.systemStepName?.startsWith("voice_error") ||
        step.systemStepName === "voice_disconnect" ||
        step.systemStepName === "voice_reconnect_attempt" ||
        step.systemStepName === "voice_reconnect_result" ||
        step.systemStepName === "voice_reconnect_exhausted"
      )
        return layer >= 2;
      return layer >= 4;
    }

    if (step.type === "thinking") {
      if (layer <= 2) {
        return (
          !!isActiveSession && step.status === "active" && !step.thinking?.trim()
        );
      }
      return layer >= 3;
    }

    if (step.type === "tool_call") {
      // QuestionWidget is the single source of truth for rendering an inline
      // question. The timeline must not also paint a non-error question step as
      // a generic tool card, or the answered card renders twice (widget + tool
      // card) at layers >= 1. Mirror the error-skip in questionToolCallIdsFromSegments:
      // errored questions have no widget owner, so they remain visible here.
      if (step.toolName === "question" && step.status !== "error") return false;
      if (layer === 1) {
        return step.toolName !== "think" && step.toolName !== "observe";
      }
      return layer >= 2;
    }

    return true;
  });
}

function stepOwnsActiveStatus(step: Extract<MessageSegment, { type: "timeline" }>["steps"][number]): boolean {
  if (step.status !== "active") return false;
  if (step.type === "thinking" || step.type === "tool_call") return true;
  return step.type === "system" && step.systemStepName === "session_compaction";
}

function normalizeRenderSegments(
  segments: MessageSegment[],
  layer: VisibilityLayer,
  isStreaming: boolean,
  filterVisibleSteps: (steps: ExecutionStep[], layer: VisibilityLayer, isMainSession?: boolean) => ExecutionStep[],
): RenderSegment[] {
  if (layer === 0) {
    if (isStreaming) return [];
    const finalContentIndex = segments.findLastIndex(
      (segment) => segment.type === "content" && segment.content.trim().length > 0,
    );
    if (finalContentIndex < 0) return [];
    const finalContent = segments[finalContentIndex];
    return finalContent.type === "content"
      ? [{ type: "content", content: finalContent.content, sourceIndexes: [finalContentIndex] }]
      : [];
  }

  const rendered: RenderSegment[] = [];
  let pendingContent = "";
  let pendingContentIndexes: number[] = [];

  const flushContent = () => {
    if (!pendingContent) return;
    rendered.push({ type: "content", content: pendingContent, sourceIndexes: pendingContentIndexes });
    pendingContent = "";
    pendingContentIndexes = [];
  };

  segments.forEach((seg, index) => {
    if (seg.type === "content") {
      if (seg.content) {
        pendingContent += seg.content;
        pendingContentIndexes.push(index);
      }
      return;
    }

    const visibleSteps = filterVisibleSteps(seg.steps, layer, true);
    if (visibleSteps.length === 0) return;

    flushContent();
    rendered.push({
      type: "timeline",
      segment: { ...seg, steps: visibleSteps },
      sourceIndexes: [index],
    });
  });

  flushContent();
  return rendered;
}

export interface SegmentStreamProps {
  segments: MessageSegment[];
  isStreaming: boolean;
  layer: VisibilityLayer;
  stripTags?: boolean;
  suppressTrailingThinking?: boolean;
  contentClassName?: string;
  contentCompact?: boolean;
  planSessionId?: string;
  renderAfterTimelineSegment?: (sourceIndex: number) => ReactNode;
  ActiveThinkingStatusComponent: ComponentType<{ startTime: Date | null; showTimer?: boolean; label?: string }>;
  ExecutionTimelineComponent: ComponentType<{ steps: ExecutionStep[]; compact?: boolean; layer: VisibilityLayer; planSessionId?: string }>;
  MarkdownContentComponent: ComponentType<{ content: string; className?: string; compact?: boolean }>;
  getThinkingStartTime: (segments: MessageSegment[]) => Date | null;
}

/**
 * Renders a sequence of MessageSegments: timeline blocks and markdown content blocks.
 * Handles the "Thinking..." indicator and empty-streaming fallback.
 * Extracted from ChatTurn's assistant branch for reuse.
 */
export function SegmentStream({
  segments,
  isStreaming,
  layer,
  stripTags = false,
  suppressTrailingThinking = false,
  contentClassName,
  contentCompact = false,
  planSessionId,
  renderAfterTimelineSegment,
  ActiveThinkingStatusComponent,
  ExecutionTimelineComponent,
  MarkdownContentComponent,
  getThinkingStartTime,
}: SegmentStreamProps) {
  const renderSegments = useMemo(
    () => normalizeRenderSegments(segments, layer, isStreaming, filterStepsByLayer),
    [segments, isStreaming, layer],
  );
  const graphSteps = useMemo(() => {
    const byId = new Map<string, Extract<MessageSegment, { type: "timeline" }>["steps"][number]>();
    for (const segment of segments) {
      if (segment.type !== "timeline") continue;
      for (const step of segment.steps) byId.set(step.id, step);
    }
    return [...byId.values()];
  }, [segments]);
  const hasContent = renderSegments.some(seg => seg.type === "content" && seg.content.length > 0);

  useEffect(() => {
    if (!isStreaming || segments.length === 0) return;
    log.debug("SEGMENT_STREAM:RENDER", {
      isStreaming,
      layer,
      stripTags,
      suppressTrailingThinking,
      contentCompact,
      hasContentClassName: !!contentClassName,
      segmentCount: segments.length,
      renderSegmentCount: renderSegments.length,
      segments: segments.map(segmentDebugSummary),
      renderSegments: renderSegments.map((seg, index) => seg.type === "content" ? {
        index,
        type: "content",
        sourceIndexes: seg.sourceIndexes,
        length: seg.content.length,
        preview: seg.content.replace(/\n/g, "\\n").slice(0, 80),
      } : {
        index,
        type: "timeline",
        sourceIndexes: seg.sourceIndexes,
        steps: seg.segment.steps.map(step => ({
          type: step.type,
          status: step.status,
          systemStepName: step.systemStepName,
          title: step.title,
        })),
      }),
    });
  }, [segments, renderSegments, isStreaming, layer, stripTags, suppressTrailingThinking, contentCompact, contentClassName, hasContent]);

  if (segments.length > 0) {
    return (
      <>
        {renderSegments.map((seg, i) => {
          if (seg.type === "timeline") {
            return (
              <Fragment key={`timeline-${seg.sourceIndexes.join("-")}`}>
                <ExecutionTimelineComponent
                  steps={seg.segment.steps}
                  graphSteps={graphSteps}
                  isStreaming={isStreaming}
                  autoCollapse
                  layer={layer}
                />
                {seg.sourceIndexes.flatMap((sourceIndex) => {
                  const rendered = renderAfterTimelineSegment?.(sourceIndex);
                  return rendered == null
                    ? []
                    : [<Fragment key={`timeline-artifact-${sourceIndex}`}>{rendered}</Fragment>];
                })}
              </Fragment>
            );
          }
          if (seg.type === "content") {
            const content = <MarkdownContentComponent content={seg.content} stripTags={stripTags} compact={contentCompact || !!contentClassName} planSessionId={planSessionId} />;
            return contentClassName ? (
              <div key={`content-${seg.sourceIndexes.join("-") || i}`} className={contentClassName}>
                {content}
              </div>
            ) : (
              <div key={`content-${seg.sourceIndexes.join("-") || i}`}>{content}</div>
            );
          }
          return null;
        })}
        {!suppressTrailingThinking && isStreaming && !hasContent && !renderSegments.some(seg =>
          seg.type === "timeline" && seg.segment.steps.some(stepOwnsActiveStatus)
        ) && (
          <div className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1" data-testid="thinking-status-trailing">
            <ActiveThinkingStatusComponent startTime={getThinkingStartTime(segments)} showTimer={layer >= 3} />
          </div>
        )}
      </>
    );
  }

  // Empty segments while streaming — show thinking indicator
  if (isStreaming) {
    return (
      <div className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1">
        <ActiveThinkingStatusComponent startTime={getThinkingStartTime(segments)} showTimer={layer >= 3} />
      </div>
    );
  }

  return null;
}
