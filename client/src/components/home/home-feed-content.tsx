import { useEffect, useLayoutEffect, useRef, useState, type TouchEvent } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useHomeFeed } from "@/hooks/use-home-feed";
import { usePageActivity } from "@/hooks/use-page-activity";
import {
  beginHomeEntry,
  getBrowserTelemetryResumeGeneration,
  recordHomeTelemetry,
  setHomeFeedReady,
} from "@/lib/browser-telemetry";
import { SimpleFeedView } from "./home-feed";

const PULL_THRESHOLD = 64;
const MAX_PULL_DISTANCE = 96;

function performanceNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function homeEntryKind(): "spa" | "load" {
  if (typeof performance === "undefined") return "load";
  const nav = performance.getEntriesByType?.("navigation")?.[0] as PerformanceNavigationTiming | undefined;
  // Soft SPA hops keep navigation.type "navigate" from the hard load; use history length as a weak signal.
  if (nav?.type === "reload") return "load";
  if (typeof window !== "undefined" && window.history.length > 1 && performance.now() > 2_000) return "spa";
  return nav?.type === "back_forward" ? "spa" : "load";
}

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
  const entryStartedRef = useRef(false);
  const mountAtRef = useRef(performanceNow());
  const feedReadyAtRef = useRef<number | null>(null);
  const feedReadyEmittedRef = useRef(false);
  const feedRenderEmittedRef = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);

  // Advance entry id before children layout so section_commit caps align with this mount.
  if (!entryStartedRef.current) {
    entryStartedRef.current = true;
    beginHomeEntry();
    mountAtRef.current = performanceNow();
  }

  const refresh = () => {
    if (!query.isFetching) void query.refetch();
  };

  useEffect(() => {
    return () => {
      setHomeFeedReady(false);
    };
  }, []);

  // Observe-only: split feed query wait from post-data first commit. Fetch options untouched.
  useEffect(() => {
    if (query.isLoading || !query.data || feedReadyEmittedRef.current) return;
    const readyAt = performanceNow();
    feedReadyAtRef.current = readyAt;
    feedReadyEmittedRef.current = true;
    setHomeFeedReady(true);
    recordHomeTelemetry("feed_ready", Math.max(0, readyAt - mountAtRef.current), {
      entry: homeEntryKind(),
      resumeGeneration: getBrowserTelemetryResumeGeneration(),
    });
  }, [query.data, query.isLoading]);

  useLayoutEffect(() => {
    if (!query.data || feedRenderEmittedRef.current || feedReadyAtRef.current == null) return;
    feedRenderEmittedRef.current = true;
    recordHomeTelemetry("feed_render", Math.max(0, performanceNow() - feedReadyAtRef.current), {
      entry: homeEntryKind(),
    });
  }, [query.data]);

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
    if (query.isFetching) startActivity("home-feed");
    else endActivity("home-feed");
    return () => endActivity("home-feed");
  }, [endActivity, query.isFetching, startActivity]);

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
