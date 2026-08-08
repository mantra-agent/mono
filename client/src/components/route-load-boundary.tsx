import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { createLogger } from "@/lib/logger";
import { usePageActivity } from "@/hooks/use-page-activity";
import { attemptVersionSkewRecovery } from "@/lib/spa-version-skew";
import { markNavigationFallback } from "@/lib/navigation-trace";
import { cn } from "@/lib/utils";

const log = createLogger("RouteLoadBoundary");
const DELAYED_ROUTE_LOAD_MS = 8_000;
const FAILED_ROUTE_LOAD_MS = 15_000;

type RouteLoadPhase = "loading" | "delayed" | "ready" | "failed";

interface PageFallbackProps {
  label?: string;
  delayed?: boolean;
  fullScreen?: boolean;
}

export function PageFallback({
  label = "Opening page…",
  delayed: delayedOverride,
  fullScreen = true,
}: PageFallbackProps) {
  const [localPhase, setLocalPhase] = useState<RouteLoadPhase>("loading");

  useEffect(() => {
    markNavigationFallback();
    if (delayedOverride !== undefined) return;
    const delayedTimer = window.setTimeout(() => setLocalPhase("delayed"), DELAYED_ROUTE_LOAD_MS);
    const failedTimer = window.setTimeout(() => {
      const fallbackKind = label.startsWith("Checking") ? "auth" : "page";
      log.error(
        "page fallback budget exhausted",
        createRouteBudgetError(fallbackKind),
        {
          elapsedMs: FAILED_ROUTE_LOAD_MS,
          fallbackKind,
        },
      );
      setLocalPhase("failed");
    }, FAILED_ROUTE_LOAD_MS);
    return () => {
      window.clearTimeout(delayedTimer);
      window.clearTimeout(failedTimer);
    };
  }, [delayedOverride, label]);

  if (delayedOverride === undefined && localPhase === "failed") {
    return (
      <RouteFailure
        label="This is taking too long"
        detail="The application did not become ready within 15 seconds. Reload to start a fresh request."
      />
    );
  }

  const delayed = delayedOverride ?? localPhase === "delayed";

  return (
    <div
      className={cn(
        "flex items-center justify-center bg-background",
        fullScreen ? "h-screen" : "h-full min-h-0",
      )}
      role="status"
      aria-live="polite"
      data-testid="page-fallback"
    >
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {delayed ? `Still ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label}
        </p>
        {delayed && (
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-cta transition-colors hover:text-active"
          >
            <RefreshCw className="h-4 w-4" />
            Reload page
          </button>
        )}
      </div>
    </div>
  );
}

interface RouteReadyObserverProps {
  onReady: () => void;
}

function RouteReadyObserver({ onReady }: RouteReadyObserverProps) {
  useEffect(() => onReady(), [onReady]);
  return null;
}

interface RouteFailureProps {
  label: string;
  detail: string;
  onRetry?: () => void;
}

function RouteFailure({ label, detail, onRetry }: RouteFailureProps) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center bg-background p-6"
      role="alert"
      data-testid="route-load-failure"
    >
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-lg font-semibold text-foreground">{label}</h1>
        <p className="text-sm text-muted-foreground">{detail}</p>
        <div className="flex min-h-11 items-center gap-4">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-sm text-cta transition-colors hover:text-active"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="flex items-center gap-2 text-sm text-cta transition-colors hover:text-active"
          >
            <RefreshCw className="h-4 w-4" />
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}

interface RouteErrorBoundaryProps {
  routeKey: string;
  routeLabel: string;
  children: ReactNode;
}

interface RouteErrorBoundaryState {
  error: Error | null;
}

function stampErrorCode(error: Error, code: string): Error {
  if (!("code" in error) || (error as Error & { code?: unknown }).code == null) {
    Object.defineProperty(error, "code", {
      value: code,
      enumerable: true,
      configurable: true,
    });
  }
  return error;
}

function normalizeRouteRenderError(caught: unknown): Error {
  if (caught instanceof Error) {
    if ((caught as Error & { code?: unknown }).code != null) return caught;
    if (caught.name === "RouteLoadError") {
      return stampErrorCode(caught, "ROUTE_MODULE_LOAD_FAILED");
    }
    // TypeError "Cannot read properties of null/undefined" collapses through
    // SECRET_LIKE message tokenization to CANNOT_READ_PROPERTIES_OF. Stamp a
    // stable product code so aggregates stay attributable after redaction.
    if (
      caught.name === "TypeError" ||
      /cannot read propert/i.test(caught.message) ||
      /is not a function/i.test(caught.message) ||
      /is not iterable/i.test(caught.message)
    ) {
      return stampErrorCode(caught, "ROUTE_RENDER_TYPEERROR");
    }
    return stampErrorCode(caught, "ROUTE_RENDER_FAILED");
  }

  const error = new Error("Route render threw a non-Error value.");
  error.name = "RouteRenderError";
  return stampErrorCode(error, "ROUTE_RENDER_NON_ERROR_THROW");
}

function createRouteBudgetError(kind: "route" | "page" | "auth"): Error {
  const error = new Error(
    kind === "route"
      ? "Route load budget exhausted."
      : kind === "auth"
        ? "Auth readiness budget exhausted."
        : "Page fallback budget exhausted.",
  );
  error.name = "RouteLoadBudgetError";
  return stampErrorCode(error, "ROUTE_LOAD_BUDGET_EXHAUSTED");
}

class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(caught: unknown): RouteErrorBoundaryState {
    return { error: normalizeRouteRenderError(caught) };
  }

  componentDidCatch(caught: unknown, info: ErrorInfo) {
    const error = normalizeRouteRenderError(caught);
    const diagnostics = {
      routeKey: this.props.routeKey,
      failurePhase: error.name === "RouteLoadError" ? "module-load" : "render",
      componentFrames: info.componentStack
        ?.split("\n")
        .filter(Boolean)
        .slice(0, 12)
        .map((frame) => frame.trim()),
    };

    void attemptVersionSkewRecovery(error).then((recoveryOutcome) => {
      if (recoveryOutcome === "reload_started" || recoveryOutcome === "update_prompted") {
        log.warn("route module failure recovered through deployment skew", {
          ...diagnostics,
          recoveryOutcome,
        });
        return;
      }
      log.error("route render failed", error, {
        ...diagnostics,
        recoveryOutcome,
      });
    });
  }

  render() {
    if (this.state.error) {
      return (
        <RouteFailure
          label={`${this.props.routeLabel} couldn’t open`}
          detail="The page module failed to load. Reload to request a fresh copy."
        />
      );
    }
    return this.props.children;
  }
}

interface RouteLoadBoundaryProps {
  routeKey: string;
  children: ReactNode;
}

function getRouteLabel(routeKey: string | null | undefined): string {
  const safeKey = typeof routeKey === "string" ? routeKey : "";
  const segment = safeKey.split("?")[0].split("/").filter(Boolean)[0] ?? "home";
  return segment
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function RouteLoadCycle({ routeKey, children }: RouteLoadBoundaryProps) {
  const { startActivity, endActivity, completeNavigation } = usePageActivity();
  const [phase, setPhase] = useState<RouteLoadPhase>("loading");
  const [manualAttempt, setManualAttempt] = useState(0);
  const [recoveryKey, setRecoveryKey] = useState(0);
  const readyRef = useRef(false);
  const delayedTimerRef = useRef<number | null>(null);
  const failedTimerRef = useRef<number | null>(null);
  const routeLabel = getRouteLabel(routeKey);

  const clearLoadTimers = useCallback(() => {
    if (delayedTimerRef.current !== null) {
      window.clearTimeout(delayedTimerRef.current);
      delayedTimerRef.current = null;
    }
    if (failedTimerRef.current !== null) {
      window.clearTimeout(failedTimerRef.current);
      failedTimerRef.current = null;
    }
  }, []);

  // Arm before paint / child useEffect. On warm lazy chunks Suspense does not
  // suspend, so RouteReadyObserver's effect would otherwise mark ready and then
  // this cycle's useEffect would reset readyRef and leave a false 15s failure
  // armed over an already-visible page (Integrations/Memory/etc.).
  useLayoutEffect(() => {
    readyRef.current = false;
    setPhase("loading");
    startActivity("route");
    clearLoadTimers();

    delayedTimerRef.current = window.setTimeout(() => {
      if (readyRef.current) return;
      // Delayed is status only. Remounting via recoveryKey wiped local page
      // state (open modals, drafts, in-flight UI) while the route was still live.
      log.warn("route load exceeded delayed budget", {
        routeKey,
        elapsedMs: DELAYED_ROUTE_LOAD_MS,
        manualAttempt,
      });
      setPhase("delayed");
    }, DELAYED_ROUTE_LOAD_MS);

    failedTimerRef.current = window.setTimeout(() => {
      if (readyRef.current) return;
      log.error(
        "route load budget exhausted",
        createRouteBudgetError("route"),
        {
          routeKey,
          elapsedMs: FAILED_ROUTE_LOAD_MS,
          manualAttempt,
        },
      );
      setPhase("failed");
    }, FAILED_ROUTE_LOAD_MS);

    return () => {
      clearLoadTimers();
      endActivity("route");
    };
  }, [clearLoadTimers, endActivity, manualAttempt, routeKey, startActivity]);

  const handleReady = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    clearLoadTimers();
    setPhase("ready");
    endActivity("route");
    completeNavigation(routeKey);
  }, [clearLoadTimers, completeNavigation, endActivity, routeKey]);

  const handleRetry = useCallback(() => {
    setRecoveryKey((value) => value + 1);
    setManualAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    if (phase !== "failed") return;
    endActivity("route");
    completeNavigation(routeKey);
  }, [completeNavigation, endActivity, phase, routeKey]);

  if (phase === "failed") {
    return (
      <RouteFailure
        label={`${routeLabel} is taking too long`}
        detail="The route did not commit within 15 seconds. Try the boundary again or reload the page."
        onRetry={handleRetry}
      />
    );
  }

  return (
    <RouteErrorBoundary
      key={`${routeKey}:${recoveryKey}`}
      routeKey={routeKey}
      routeLabel={routeLabel}
    >
      <Suspense fallback={null}>
        {children}
        <RouteReadyObserver onReady={handleReady} />
      </Suspense>
    </RouteErrorBoundary>
  );
}

export function RouteLoadBoundary({ routeKey, children }: RouteLoadBoundaryProps) {
  return (
    <RouteLoadCycle key={routeKey} routeKey={routeKey}>
      {children}
    </RouteLoadCycle>
  );
}
