import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type ReactNode,
} from "react";
import { useLocation } from "wouter";
import type { PendingChatTurn } from "@/hooks/use-chat-send";

const STORAGE_KEY = "xyz_focus_sessions_by_route_v1";
const ACTIVE_SESSION_STORAGE_KEY = "xyz_focus_active_session_v1";

function loadFromStorage(): Record<string, string> {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {}
  return {};
}

function saveToStorage(map: Record<string, string>) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

function loadActiveSession(): string | null {
  try {
    return typeof window !== "undefined"
      ? window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)
      : null;
  } catch {
    return null;
  }
}

function saveActiveSession(id: string | null) {
  try {
    if (typeof window === "undefined") return;
    if (id) {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, id);
    } else {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  } catch {}
}

interface FocusSessionContextValue {
  /** Current pathname-keyed route (e.g. "/goals", "/projects"). */
  route: string;
  /** Whether the floating widget should be open (vs. collapsed bubble). */
  widgetOpen: boolean;
  setWidgetOpen: (open: boolean) => void;
  /** Monotonic signal for forcing the Session Menu back to its top entrypoint. */
  sessionMenuResetKey: number;
  requestSessionMenuReset: () => void;
  /** Monotonic signal for moving keyboard focus into the global BottomBar input. */
  bottomBarFocusRequestKey: number;
  requestBottomBarFocus: () => void;
  /** Returns the globally focused session. The route parameter is legacy. */
  getSessionForRoute: (route: string) => string | null;
  /** Sets the globally focused session. The route parameter is retained for legacy callers. */
  setSessionForRoute: (route: string, id: string) => void;
  /** Clears the globally focused session. The route parameter is retained for legacy callers. */
  clearSessionForRoute: (route: string) => void;
  /** Mobile top-bar override while the session window owns the screen. */
  mobileSessionTitle: string | null;
  setMobileSessionTitle: (title: string | null) => void;
  /** Shared pending turn state — written by BottomBar's useChatSend and read by
   *  SessionTranscriptPanel so the streaming anchor stays correct. */
  pendingTurn: PendingChatTurn | null;
  setPendingTurn: (turn: PendingChatTurn | null) => void;
}

const FocusSessionContext = createContext<FocusSessionContextValue | null>(null);

export function FocusSessionProvider({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const route = useMemo(() => normalizeRoute(location), [location]);
  // Default: session menu collapsed; user toggles it open
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [sessionMenuResetKey, setSessionMenuResetKey] = useState(0);
  const [bottomBarFocusRequestKey, setBottomBarFocusRequestKey] = useState(0);
  const [sessionByRoute, setSessionByRoute] = useState<Record<string, string>>(() => loadFromStorage());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => loadActiveSession());
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const [mobileSessionTitle, setMobileSessionTitle] = useState<string | null>(null);
  const [pendingTurn, setPendingTurn] = useState<PendingChatTurn | null>(null);

  useEffect(() => {
    saveToStorage(sessionByRoute);
  }, [sessionByRoute]);

  useEffect(() => {
    saveActiveSession(activeSessionId);
  }, [activeSessionId]);

  const getSessionForRoute = useCallback((_r: string): string | null => {
    return activeSessionIdRef.current;
  }, []);

  const setSessionForRoute = useCallback((r: string, id: string) => {
    setActiveSessionId(id);
    setSessionByRoute((prev) => {
      if (prev[r] === id) return prev;
      return { ...prev, [r]: id };
    });
  }, []);

  const clearSessionForRoute = useCallback((r: string) => {
    setActiveSessionId(null);
    setSessionByRoute((prev) => {
      if (!(r in prev)) return prev;
      const next = { ...prev };
      delete next[r];
      return next;
    });
  }, []);

  const requestSessionMenuReset = useCallback(() => {
    setSessionMenuResetKey((key) => key + 1);
  }, []);

  const requestBottomBarFocus = useCallback(() => {
    setBottomBarFocusRequestKey((key) => key + 1);
  }, []);

  const value = useMemo<FocusSessionContextValue>(() => ({
    route,
    widgetOpen,
    setWidgetOpen,
    sessionMenuResetKey,
    requestSessionMenuReset,
    bottomBarFocusRequestKey,
    requestBottomBarFocus,
    mobileSessionTitle,
    setMobileSessionTitle,
    getSessionForRoute,
    setSessionForRoute,
    clearSessionForRoute,
    pendingTurn,
    setPendingTurn,
  }), [route, widgetOpen, sessionMenuResetKey, requestSessionMenuReset, bottomBarFocusRequestKey, requestBottomBarFocus, mobileSessionTitle, getSessionForRoute, setSessionForRoute, clearSessionForRoute, pendingTurn]);

  return (
    <FocusSessionContext.Provider value={value}>
      {children}
    </FocusSessionContext.Provider>
  );
}

export function useFocusSession() {
  const ctx = useContext(FocusSessionContext);
  if (!ctx) throw new Error("useFocusSession must be used inside FocusSessionProvider");
  return ctx;
}

export function useFocusSessionOptional() {
  return useContext(FocusSessionContext);
}

function normalizeRoute(loc: string): string {
  if (!loc) return "/";
  const path = loc.split("?")[0].split("#")[0];
  return path.replace(/\/+$/, "") || "/";
}
