import { cn } from "@/lib/utils";
import { type ReferenceSuggestion } from "@/lib/reference-search";
import { resolveReference } from "@/components/references/reference-registry";

export type ReferenceSuggestionRowProps = {
  suggestion: ReferenceSuggestion;
  active?: boolean;
  dense?: boolean;
  showToken?: boolean;
  onSelect?: (suggestion: ReferenceSuggestion) => void;
  onHover?: () => void;
  className?: string;
  testId?: string;
};

/**
 * Compact single-line reference suggestion row.
 * Shared by chat mention popover, field pickers, and Design playground.
 */
export function ReferenceSuggestionRow({
  suggestion,
  active = false,
  dense = false,
  showToken = false,
  onSelect,
  onHover,
  className,
  testId,
}: ReferenceSuggestionRowProps) {
  const resolved = resolveReference({
    type: suggestion.type,
    id: suggestion.id,
    canonical: `@${suggestion.type}:${suggestion.id}`,
    metadata: { label: suggestion.label },
  });
  const Icon = resolved.Icon;

  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 text-left transition-colors",
        dense ? "px-2 py-1 text-sm" : "px-3 py-1 text-sm",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        className,
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        onSelect?.(suggestion);
      }}
      onMouseEnter={onHover}
      data-testid={testId ?? `reference-suggestion-${suggestion.type}-${suggestion.id}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium">{suggestion.label}</span>
      {showToken ? (
        <code className="hidden shrink-0 text-[10px] text-muted-foreground md:inline">
          @{suggestion.type}:{suggestion.id}
        </code>
      ) : null}
    </button>
  );
}
