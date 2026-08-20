import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface PendingNavigation {
  href: string;
}

interface PageActivityContextValue {
  isPageActive: boolean;
  pendingNavigation: PendingNavigation | null;
  startActivity: (key: string) => void;
  endActivity: (key: string) => void;
  startNavigation: (destination: PendingNavigation) => void;
  completeNavigation: (href: string) => void;
}

const PageActivityContext = createContext<PageActivityContextValue | null>(null);

export function PageActivityProvider({ children }: { children: ReactNode }) {
  const activityKeysRef = useRef(new Set<string>());
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const navigationWatchdogRef = useRef<number | null>(null);
  const [activityCount, setActivityCount] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);

  const startActivity = useCallback((key: string) => {
    if (activityKeysRef.current.has(key)) return;
    activityKeysRef.current.add(key);
    setActivityCount(activityKeysRef.current.size);
  }, []);

  const endActivity = useCallback((key: string) => {
    if (!activityKeysRef.current.delete(key)) return;
    setActivityCount(activityKeysRef.current.size);
  }, []);

  const startNavigation = useCallback((destination: PendingNavigation) => {
    // RouteLoadBoundary completes with wouter location (path only). Normalize so
    // query-bearing chip/nav hrefs still clear when the destination mounts.
    const normalized: PendingNavigation = {
      href: destination.href.split("?")[0] || destination.href,
    };
    pendingNavigationRef.current = normalized;
    setPendingNavigation(normalized);
    startActivity("navigation");
    if (navigationWatchdogRef.current !== null) window.clearTimeout(navigationWatchdogRef.current);
    navigationWatchdogRef.current = window.setTimeout(() => {
      if (pendingNavigationRef.current?.href !== normalized.href) return;
      pendingNavigationRef.current = null;
      setPendingNavigation(null);
      endActivity("navigation");
    }, 12_000);
  }, [endActivity, startActivity]);

  const completeNavigation = useCallback((href: string) => {
    const pathOnly = href.split("?")[0] || href;
    if (pendingNavigationRef.current?.href !== pathOnly) return;
    pendingNavigationRef.current = null;
    setPendingNavigation(null);
    if (navigationWatchdogRef.current !== null) {
      window.clearTimeout(navigationWatchdogRef.current);
      navigationWatchdogRef.current = null;
    }
    endActivity("navigation");
  }, [endActivity]);

  useEffect(() => () => {
    if (navigationWatchdogRef.current !== null) window.clearTimeout(navigationWatchdogRef.current);
  }, []);

  const value = useMemo<PageActivityContextValue>(() => ({
    isPageActive: activityCount > 0,
    pendingNavigation,
    startActivity,
    endActivity,
    startNavigation,
    completeNavigation,
  }), [activityCount, completeNavigation, endActivity, pendingNavigation, startActivity, startNavigation]);

  return (
    <PageActivityContext.Provider value={value}>
      {children}
    </PageActivityContext.Provider>
  );
}

export function usePageActivity() {
  const context = useContext(PageActivityContext);
  if (!context) {
    throw new Error("usePageActivity must be used within PageActivityProvider");
  }
  return context;
}

/** Chips/widgets in detached trees may lack the provider — fail open. */
export function useOptionalPageActivity() {
  return useContext(PageActivityContext);
}

export function usePageLoadActivity(key: string, active: boolean) {
  const { startActivity, endActivity } = usePageActivity();

  useEffect(() => {
    if (!active) {
      endActivity(key);
      return;
    }

    startActivity(key);
    return () => endActivity(key);
  }, [active, endActivity, key, startActivity]);
}
