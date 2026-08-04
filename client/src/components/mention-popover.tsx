import { useRef, useLayoutEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import type {
  ReferenceTrigger,
  ReferenceSuggestion,
} from "@/hooks/use-mention-autocomplete";
import { ReferenceSuggestionRow } from "@/components/references/reference-suggestion-row";

export interface MentionPopoverProps {
  trigger: ReferenceTrigger | null;
  suggestions: ReferenceSuggestion[];
  isLoading: boolean;
  activeIndex: number;
  onSelect: (suggestion: ReferenceSuggestion) => void;
  onHover: (index: number) => void;
  /** Ref to the anchor element (textarea/input) for portal positioning */
  anchorRef?: React.RefObject<HTMLElement | null>;
  testIdSuffix?: string;
}

/**
 * Mention autocomplete popover. Compact single-line rows via shared
 * ReferenceSuggestionRow. When `anchorRef` is provided, renders via
 * portal at document.body to escape overflow-hidden containers.
 */
export function MentionPopover({
  trigger,
  suggestions,
  isLoading,
  activeIndex,
  onSelect,
  onHover,
  anchorRef,
  testIdSuffix = "",
}: MentionPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({
    top: -9999,
    left: 0,
    width: 400,
  });

  const reposition = useCallback(() => {
    const anchor = anchorRef?.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverHeight = popover.offsetHeight;
    const gap = 8;
    setPos({
      top: Math.max(4, anchorRect.top - popoverHeight - gap),
      left: anchorRect.left,
      width: Math.min(anchorRect.width, 420),
    });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!trigger || !anchorRef?.current) return;
    reposition();
  }, [trigger, anchorRef, suggestions.length, isLoading, reposition]);

  const isVisible = trigger && (suggestions.length > 0 || isLoading);
  if (!isVisible) return null;

  const content = (
    <>
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground">
        <Search className="h-3.5 w-3.5" />
        <span>
          Reference {trigger.query ? `“${trigger.query}”` : "anything"}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto py-0.5">
        {isLoading && suggestions.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">Searching…</div>
        ) : (
          suggestions.map((suggestion, index) => (
            <ReferenceSuggestionRow
              key={`${suggestion.type}:${suggestion.id}`}
              suggestion={suggestion}
              active={index === activeIndex}
              dense
              onSelect={onSelect}
              onHover={() => onHover(index)}
            />
          ))
        )}
      </div>
    </>
  );

  if (anchorRef) {
    return createPortal(
      <div
        ref={popoverRef}
        className="fixed z-[9999] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        style={{
          top: `${pos.top}px`,
          left: `${pos.left}px`,
          width: `${pos.width}px`,
        }}
        data-testid={`reference-suggestions${testIdSuffix}`}
      >
        {content}
      </div>,
      document.body,
    );
  }

  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      data-testid={`reference-suggestions${testIdSuffix}`}
    >
      {content}
    </div>
  );
}
