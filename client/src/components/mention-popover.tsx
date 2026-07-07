import { useRef, useLayoutEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import type {
  ReferenceTrigger,
  ReferenceSuggestion,
} from "@/hooks/use-mention-autocomplete";
import { REFERENCE_TYPE_LABELS } from "@/hooks/use-mention-autocomplete";

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
 * Mention autocomplete popover. When `anchorRef` is provided, renders via
 * portal at document.body to escape overflow-hidden containers. Falls back
 * to absolute positioning within the parent when no anchor is given.
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
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: -9999, left: 0, width: 400 });

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
      width: Math.min(anchorRect.width, 448),
    });
  }, [anchorRef]);

  // Reposition on every render when visible (covers suggestion list changes, scroll, resize)
  useLayoutEffect(() => {
    if (!trigger || !anchorRef?.current) return;
    reposition();
  }, [trigger, anchorRef, suggestions.length, isLoading, reposition]);

  const isVisible = trigger && (suggestions.length > 0 || isLoading);
  if (!isVisible) return null;

  const content = (
    <>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
        <Search className="h-3.5 w-3.5" />
        <span>
          Reference {trigger.query ? `"${trigger.query}"` : "something"}
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {isLoading && suggestions.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            Searching…
          </div>
        ) : (
          suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.type}:${suggestion.id}`}
              type="button"
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                index === activeIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/60"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(suggestion);
              }}
              onMouseEnter={() => onHover(index)}
              data-testid={`reference-suggestion-${suggestion.type}-${suggestion.id}`}
            >
              <span className="shrink-0 rounded border border-cta/20 bg-cta/10 px-1.5 py-0.5 text-[10px] font-medium text-cta">
                {REFERENCE_TYPE_LABELS[suggestion.type] || suggestion.type}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {suggestion.label}
                </span>
                {suggestion.description ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {suggestion.description}
                  </span>
                ) : null}
              </span>
              <code className="shrink-0 text-[10px] text-muted-foreground">
                @{suggestion.type}:{suggestion.id}
              </code>
            </button>
          ))
        )}
      </div>
    </>
  );

  // Portal mode: escape overflow-hidden ancestors
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

  // Fallback: absolute positioning within parent container
  return (
    <div
      className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      data-testid={`reference-suggestions${testIdSuffix}`}
    >
      {content}
    </div>
  );
}
