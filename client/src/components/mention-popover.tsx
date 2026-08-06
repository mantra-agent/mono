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
  testIdSuffix?: string;
}

/**
 * Mention autocomplete popover. Compact single-line rows via shared
 * ReferenceSuggestionRow.
 *
 * Positioning is pure CSS: the popover is `absolute bottom-full` inside the
 * caller's `relative` composer/field wrapper, so it lives in that element's
 * own coordinate space and opens directly above the input.
 *
 * This is deliberately NOT `position: fixed` + visualViewport math. On mobile
 * the soft keyboard slides the visual viewport out from under the layout
 * viewport; `fixed` lays out against the layout viewport while
 * getBoundingClientRect/visualViewport describe the visual one, so any JS that
 * measures in one frame and paints in the other drifts by exactly the keyboard
 * offset. The composer already rides above the keyboard in the shell's own
 * coordinate space — anchoring to it inherits that correctness for free.
 */
export function MentionPopover({
  trigger,
  suggestions,
  isLoading,
  activeIndex,
  onSelect,
  onHover,
  testIdSuffix = "",
}: MentionPopoverProps) {
  if (!trigger) return null;

  return (
    <div
      data-testid={`mention-popover${testIdSuffix}`}
      className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1 text-xs text-muted-foreground">
        <Search className="h-3 w-3" />
        <span>
          {trigger.char === "#"
            ? "Link a task, project, goal…"
            : "Mention a person, page, project…"}
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto overscroll-contain py-0.5">
        {isLoading && suggestions.length === 0 && (
          <div className="px-3 py-1 text-xs text-muted-foreground">Searching…</div>
        )}
        {!isLoading && suggestions.length === 0 && (
          <div className="px-3 py-1 text-xs text-muted-foreground">No matches</div>
        )}
        {suggestions.map((s, i) => (
          <ReferenceSuggestionRow
            key={`${s.type}:${s.id}`}
            suggestion={s}
            active={i === activeIndex}
            dense
            showToken={false}
            onSelect={onSelect}
            onHover={() => onHover(i)}
          />
        ))}
      </div>
    </div>
  );
}
