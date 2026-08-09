import { useEffect, useRef, useState, type TouchEvent } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHomeFeed } from "@/hooks/use-home-feed";
import { usePageActivity } from "@/hooks/use-page-activity";
import { SimpleFeedView } from "./home-feed";
import { markHomeLoading, markHomeRenderable } from "@/lib/home-performance-attribution";

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
  const { startActivity, endActivity } = usePageActivity();
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

  useEffect(() => {
    if (query.isFetching) {
      startActivity("home-feed");
      if (!query.data) markHomeLoading();
    } else {
      endActivity("home-feed");
    }
    return () => endActivity("home-feed");
  }, [endActivity, query.data, query.isFetching, startActivity]);

  useEffect(() => {
    if (!query.data) return;
    const visibleSections = query.data.sections.filter((section) => section.items.length > 0 || section.planArtifact !== undefined);
    const itemCount = visibleSections.reduce((count, section) => count + section.items.length, 0);
    markHomeRenderable(visibleSections.length, itemCount);
  }, [query.data]);

  return (
    <div
      ref={rootRef}
      className="min-h-full touch-pan-y overscroll-y-contain"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      {query.isLoading ? null : query.isError && !query.data ? (
        <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 text-center">
          <div className="text-lg font-semibold">Simple couldn't load</div>
          <Button variant="outline" size="sm" onClick={refresh} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      ) : query.data ? (
        <SimpleFeedView feed={query.data} />
      ) : null}
    </div>
  );
}
