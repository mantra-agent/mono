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

const EDGE_PAD = 8;
const GAP = 8;

type Placement = "above" | "below";

type PopoverPos = {
  /** Fixed Y of the pinned edge (bottom edge when above, top edge when below). */
  y: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: Placement;
};

function readViewport() {
  const vv = window.visualViewport;
  // visualViewport is the only trustworthy bound on iOS with the keyboard up:
  // layout viewport stays tall while the visible area shrinks and can offset.
  return {
    top: vv?.offsetTop ?? 0,
    left: vv?.offsetLeft ?? 0,
    width: vv?.width ?? window.innerWidth,
    height: vv?.height ?? window.innerHeight,
    bottom: (vv?.offsetTop ?? 0) + (vv?.height ?? window.innerHeight),
    right: (vv?.offsetLeft ?? 0) + (vv?.width ?? window.innerWidth),
  };
}

function samePos(a: PopoverPos | null, b: PopoverPos): boolean {
  return (
    !!a &&
    a.y === b.y &&
    a.left === b.left &&
    a.width === b.width &&
    a.maxHeight === b.maxHeight &&
    a.placement === b.placement
  );
}

/**
 * Mention autocomplete popover. Compact single-line rows via shared
 * ReferenceSuggestionRow. When `anchorRef` is provided, renders via
 * portal at document.body to escape overflow-hidden containers, and
 * pins its near edge to the composer inside the visual viewport
 * (no height-estimated gap above the input).
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
  const [pos, setPos] = useState<PopoverPos | null>(null);

  const reposition = useCallback(() => {
    if (!anchorRef?.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const vp = readViewport();
    const width = Math.min(rect.width, Math.max(0, vp.width - EDGE_PAD * 2));

    const spaceAbove = rect.top - vp.top - GAP - EDGE_PAD;
    const spaceBelow = vp.bottom - rect.bottom - GAP - EDGE_PAD;

    // Prefer above (composer is usually at the bottom). Flip below only when
    // above has almost no room and below is clearly better.
    const placement: Placement =
      spaceAbove >= 80 || spaceAbove >= spaceBelow ? "above" : "below";

    let y: number;
    let maxHeight: number;
    if (placement === "above") {
      // Pin the BOTTOM edge to just above the composer. translateY(-100%) does
      // the height math in the compositor — no estimate, no residual gap.
      y = rect.top - GAP;
      maxHeight = Math.max(80, Math.min(320, spaceAbove));
      // Keep the full max-height box inside the visual viewport.
      const maxFromTop = y - (vp.top + EDGE_PAD);
      maxHeight = Math.max(80, Math.min(maxHeight, maxFromTop));
      // If the pin itself drifted above the visible area, clamp the edge down.
      y = Math.min(Math.max(y, vp.top + EDGE_PAD + Math.min(80, maxHeight)), vp.bottom - EDGE_PAD);
    } else {
      // Pin the TOP edge to just below the composer.
      y = rect.bottom + GAP;
      maxHeight = Math.max(80, Math.min(320, spaceBelow));
      const maxFromBottom = vp.bottom - EDGE_PAD - y;
      maxHeight = Math.max(80, Math.min(maxHeight, maxFromBottom));
      y = Math.min(Math.max(y, vp.top + EDGE_PAD), vp.bottom - EDGE_PAD - Math.min(80, maxHeight));
    }

    let left = rect.left;
    left = Math.min(
      Math.max(left, vp.left + EDGE_PAD),
      vp.right - EDGE_PAD - width,
    );

    const next: PopoverPos = { y, left, width, maxHeight, placement };
    setPos((prev) => (samePos(prev, next) ? prev : next));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!trigger || !anchorRef?.current) {
      setPos(null);
      return;
    }

    reposition();
    // Content height can settle one frame later; edge-pin is height-invariant,
    // but maxHeight still benefits from a second pass after layout.
    const raf = window.requestAnimationFrame(() => reposition());

    const onChange = () => reposition();
    window.addEventListener("resize", onChange);
    // scroll must be capture: true so nested chat scroll containers still fire.
    window.addEventListener("scroll", onChange, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onChange);
    vv?.addEventListener("scroll", onChange);

    const node = popoverRef.current;
    const ro =
      typeof ResizeObserver !== "undefined" && node
        ? new ResizeObserver(() => reposition())
        : null;
    if (node && ro) ro.observe(node);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
      vv?.removeEventListener("resize", onChange);
      vv?.removeEventListener("scroll", onChange);
      ro?.disconnect();
    };
  }, [trigger, suggestions, isLoading, anchorRef, reposition]);

  if (!trigger) return null;

  const body = (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2 py-1 text-xs text-muted-foreground">
        <Search className="h-3 w-3" />
        <span>
          {trigger.char === "#"
            ? "Link a task, project, goal…"
            : "Mention a person, page, project…"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-0.5">
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
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(s);
            }}
          />
        ))}
      </div>
    </>
  );

  // Portal mode: escape overflow:hidden ancestors (chat composer).
  if (anchorRef) {
    const style: React.CSSProperties = pos
      ? {
          position: "fixed",
          left: `${pos.left}px`,
          width: `${pos.width}px`,
          maxHeight: `${pos.maxHeight}px`,
          // Above: y is the bottom edge → translate up by full height.
          // Below: y is the top edge → no translate.
          top: `${pos.y}px`,
          transform: pos.placement === "above" ? "translateY(-100%)" : undefined,
        }
      : // Hide until first measure so we never flash at 0,0 under the status bar.
        { position: "fixed", top: 0, left: 0, visibility: "hidden" };

    return createPortal(
      <div
        ref={popoverRef}
        data-testid={`mention-popover${testIdSuffix}`}
        style={style}
        className="z-[9999] flex flex-col overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md"
      >
        {body}
      </div>,
      document.body,
    );
  }

  // Inline mode: CSS-anchored above the trigger (goals fields, etc.).
  return (
    <div
      data-testid={`mention-popover${testIdSuffix}`}
      className="absolute bottom-full left-0 z-50 mb-2 w-full max-w-md overflow-hidden rounded-md border border-border bg-background text-foreground shadow-md"
    >
      {body}
    </div>
  );
}
