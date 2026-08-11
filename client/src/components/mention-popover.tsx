import type { CSSProperties } from "react";
import { Search } from "lucide-react";
import type {
  ReferenceTrigger,
  ReferenceSuggestion,
} from "@/hooks/use-mention-autocomplete";
import { ReferenceSuggestionRow } from "@/components/references/reference-suggestion-row";
import { cn } from "@/lib/utils";

export interface ReferenceMentionMenuProps {
  triggerChar?: "@" | "#";
  suggestions: ReferenceSuggestion[];
  isLoading: boolean;
  activeIndex: number;
  onSelect: (suggestion: ReferenceSuggestion) => void;
  onHover: (index: number) => void;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export interface MentionPopoverProps {
  trigger: ReferenceTrigger | null;
  suggestions: ReferenceSuggestion[];
  isLoading: boolean;
  activeIndex: number;
  onSelect: (suggestion: ReferenceSuggestion) => void;
  onHover: (index: number) => void;
  testIdSuffix?: string;
}

export function ReferenceMentionMenu({
  triggerChar = "@",
  suggestions,
  isLoading,
  activeIndex,
  onSelect,
  onHover,
  className,
  style,
  testId = "mention-popover",
}: ReferenceMentionMenuProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "z-50 w-full max-w-md overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md",
        className,
      )}
      style={style}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-2 py-1 text-xs text-muted-foreground">
        <Search className="h-3 w-3" />
        <span>
          {triggerChar === "#"
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
        {suggestions.map((suggestion, index) => (
          <ReferenceSuggestionRow
            key={`${suggestion.type}:${suggestion.id}`}
            suggestion={suggestion}
            active={index === activeIndex}
            dense
            showToken={false}
            onSelect={onSelect}
            onHover={() => onHover(index)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Mention autocomplete popover using the shared reference menu presentation.
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
    <ReferenceMentionMenu
      triggerChar={trigger.char}
      suggestions={suggestions}
      isLoading={isLoading}
      activeIndex={activeIndex}
      onSelect={onSelect}
      onHover={onHover}
      className="absolute bottom-full left-0 mb-2"
      testId={`mention-popover${testIdSuffix}`}
    />
  );
}
