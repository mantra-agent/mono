import { useEffect, useLayoutEffect, useRef, useState, type TouchEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { apiRequest } from "@/lib/queryClient";
import type { SimpleFeed } from "@shared/models/simple";
import { SimpleFeedView } from "./home-feed";

const PULL_THRESHOLD = 64;
const MAX_PULL_DISTANCE = 96;
const HOME_FEED_QUERY_KEY = ["/api/home/feed"] as const;

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
  // Entry paint uses the non-refresh path; pull-to-refresh forces rebuild.
  const query = useHomeFeed();
  const queryClient = useQueryClient();
  const { startActivity, endActivity } = usePageActivity();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const entryStartedRef = useRef(false);
  const mountAtRef = useRef(performanceNow());
  /** First moment query.data is truthy during render (start of data→view work). */
  const feedDataPresentAtRef = useRef<number | null>(null);
  const feedReadyEmittedRef = useRef(false);
  const feedRenderEmittedRef = useRef(false);
  const [pullDistance, setPullDistance] = useState(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  // Advance entry id before children layout so section_commit caps align with this mount.
  if (!entryStartedRef.current) {
    entryStartedRef.current = true;
    beginHomeEntry();
    mountAtRef.current = performanceNow();
  }

  // Stamp data-present during render so feed_render includes SimpleFeedView commit cost.
  if (query.data && feedDataPresentAtRef.current == null) {
    feedDataPresentAtRef.current = performanceNow();
  }

  const refresh = () => {
    if (query.isFetching || manualRefreshing) return;
    setManualRefreshing(true);
    void (async () => {
      try {
        // Explicit rebuild: server refresh=true, then write into the stable query key.
        const res = await apiRequest("GET", "/api/home/feed?refresh=true");
        const feed = (await res.json()) as SimpleFeed;
        queryClient.setQueryData(HOME_FEED_QUERY_KEY, feed);
      } catch {
        void query.refetch();
      } finally {
        setManualRefreshing(false);
      }
    })();
  };

  useEffect(() => {
    return () => {
      setHomeFeedReady(false);
    };
  }, []);

  // feed_ready: mount → first data present. feed_render: data present → first SimpleFeedView layout.
  // Both in layout so feed_render is not deferred until a later refetch (prior useEffect/useLayoutEffect split).
  useLayoutEffect(() => {
    if (!query.data || query.isLoading) return;

    if (!feedReadyEmittedRef.current) {
      feedReadyEmittedRef.current = true;
      setHomeFeedReady(true);
      const readyAt = feedDataPresentAtRef.current ?? performanceNow();
      const staleFlag = query.data.stale === true ? 1 : 0;
      recordHomeTelemetry("feed_ready", Math.max(0, readyAt - mountAtRef.current), {
        entry: homeEntryKind(),
        resumeGeneration: getBrowserTelemetryResumeGeneration(),
        refresh: 0,
        cacheHit: staleFlag,
      });
    }

    if (!feedRenderEmittedRef.current && feedDataPresentAtRef.current != null) {
      feedRenderEmittedRef.current = true;
      recordHomeTelemetry("feed_render", Math.max(0, performanceNow() - feedDataPresentAtRef.current), {
        entry: homeEntryKind(),
      });
    }
  }, [query.data, query.isLoading]);

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

  const isBusy = query.isFetching || manualRefreshing;

  useEffect(() => {
    if (isBusy) startActivity("home-feed");
    else endActivity("home-feed");
    return () => endActivity("home-feed");
  }, [endActivity, isBusy, startActivity]);

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
