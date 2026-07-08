import { useEffect, useMemo } from "react";
import type { MessageSegment } from "@shared/streaming-types";
import { ActiveThinkingStatus, ExecutionTimeline, MarkdownContent, filterStepsByLayer, findThinkingStartTime } from "@/components/chat-shared";
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

function normalizeRenderSegments(segments: MessageSegment[], layer: 1 | 2 | 3 | 4): RenderSegment[] {
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

    const visibleSteps = filterStepsByLayer(seg.steps, layer, true);
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
  layer: 1 | 2 | 3 | 4;
  stripTags?: boolean;
  suppressTrailingThinking?: boolean;
  contentClassName?: string;
  contentCompact?: boolean;
}

/**
 * Renders a sequence of MessageSegments: timeline blocks and markdown content blocks.
 * Handles the "Thinking..." indicator and empty-streaming fallback.
 * Extracted from ChatTurn's assistant branch for reuse.
 */
export function SegmentStream({ segments, isStreaming, layer, stripTags = false, suppressTrailingThinking = false, contentClassName, contentCompact = false }: SegmentStreamProps) {
  const renderSegments = useMemo(() => normalizeRenderSegments(segments, layer), [segments, layer]);

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
              <ExecutionTimeline
                key={`timeline-${seg.sourceIndexes.join("-")}`}
                steps={seg.segment.steps}
                isStreaming={isStreaming}
                autoCollapse
                layer={layer}
              />
            );
          }
          if (seg.type === "content") {
            const content = <MarkdownContent content={seg.content} stripTags={stripTags} compact={contentCompact || !!contentClassName} />;
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
        {!suppressTrailingThinking && isStreaming && !hasContent && !segments.some(seg =>
          seg.type === "timeline" && seg.steps.some(s =>
            (s.type === "thinking" && s.status === "active" && (layer === 1 || !s.thinking)) ||
            (s.type === "tool_call" && s.status === "active")
          )
        ) && (
          <div className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1" data-testid="thinking-status-trailing">
            <ActiveThinkingStatus startTime={findThinkingStartTime(segments)} showTimer={layer >= 3} />
          </div>
        )}
      </>
    );
  }

  // Empty segments while streaming — show thinking indicator
  if (isStreaming) {
    return (
      <div className="animate-in fade-in slide-in-from-bottom-1 duration-200 px-1.5 py-1">
        <ActiveThinkingStatus startTime={findThinkingStartTime(segments)} showTimer={layer >= 3} />
      </div>
    );
  }

  return null;
}
