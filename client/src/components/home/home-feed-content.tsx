import { useRef, useState, type TouchEvent } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHomeFeed } from "@/hooks/use-home-feed";
import { SimpleFeedView } from "./home-feed";

const PULL_THRESHOLD = 64;
const MAX_PULL_DISTANCE = 96;

function nearestScrollContainer(element: HTMLElement | null): HTMLElement | null {
  let current = element;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}

export function SimpleFeedContent() {
  const query = useHomeFeed();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const [pullDistance, setPullDistance] = useState(0);

  const refresh = () => {
    if (!query.isFetching) void query.refetch();
  };

  const atScrollTop = () => {
    const scrollContainer = nearestScrollContainer(rootRef.current);
    return (scrollContainer?.scrollTop ?? 0) <= 0;
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = atScrollTop() ? event.touches[0]?.clientY ?? null : null;
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const startY = touchStartYRef.current;
    if (startY == null || !atScrollTop()) return;

    const currentY = event.touches[0]?.clientY ?? startY;
    const delta = currentY - startY;
    if (delta <= 0) {
      setPullDistance(0);
      return;
    }

    setPullDistance(Math.min(MAX_PULL_DISTANCE, delta * 0.45));
  };

  const handleTouchEnd = () => {
    if (pullDistance >= PULL_THRESHOLD) refresh();
    touchStartYRef.current = null;
    setPullDistance(0);
  };

  const refreshLabel = query.isFetching ? "Refreshing…" : pullDistance >= PULL_THRESHOLD ? "Release to refresh" : "Pull to refresh";

  return (
    <div
      ref={rootRef}
      className="min-h-full touch-pan-y overscroll-y-contain"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div
        className="flex items-center justify-center gap-2 overflow-hidden text-xs text-muted-foreground transition-[height,opacity] duration-200"
        style={{ height: Math.max(pullDistance, query.isRefetching ? 32 : 0), opacity: pullDistance > 8 || query.isRefetching ? 1 : 0 }}
        aria-live="polite"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
        {refreshLabel}
      </div>

      {query.isLoading ? (
        <div className="flex min-h-[360px] items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : query.isError || !query.data ? (
        <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 text-center">
          <div className="text-lg font-semibold">Simple is catching up</div>
          <Button variant="outline" size="sm" onClick={refresh} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      ) : (
        <SimpleFeedView feed={query.data} />
      )}
    </div>
  );
}
