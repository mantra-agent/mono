import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearch, useLocation } from "wouter";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useFocusContextValue } from "@/hooks/use-focus-context";
import { usePageHeaderContext } from "@/hooks/use-page-header";
import { useVoiceStreaming } from "@/hooks/use-voice-streaming";
import { useVoiceSessionOptional } from "@/hooks/use-voice-session";
import { useExecutorStatus } from "@/hooks/use-executor-status";
import { SessionTranscriptPanel } from "@/components/session-transcript-panel";
import { XyzIconButton } from "@/components/app-sidebar";
import { ConnectionsIndicator } from "@/components/connections-indicator";
import { VaultToggles } from "@/components/vault-toggles";
// Tooltip import removed — FAB tooltip no longer needed
import { apiRequest } from "@/lib/queryClient";
import { deleteSessionTree } from "@/lib/session-deletion";
import { getSessionStreamState, useSessionSubscriptions } from "@/hooks/use-session-subscription";
import type { ChatSession as Session, PageContext } from "@shared/models/chat";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import { BottomBar } from "@/components/bottom-bar";
import { useSessionActivityState } from "@/components/thought-indicator";
import { emitSessionListChanged, emitSessionChanged } from "@/hooks/use-data-sync";
import { useToast } from "@/hooks/use-toast";
import { useSidebar } from "@/components/ui/sidebar";

const log = createLogger("FocusWidget");

const HIDDEN_ROUTES = new Set<string>([]);
const MOBILE_BREAKPOINT_PX = 768;
const CONTEXT_PATCH_DEBOUNCE_MS = 600;

const FOCUS_COLUMN_DEFAULT_WIDTH = 820;
const FOCUS_COLUMN_MIN_WIDTH = 680;
const FOCUS_COLUMN_MAX_FRACTION = 0.85;
/** Default width for the session menu sidebar — matches the main area default for symmetry. */
const FOCUS_SIDEBAR_DEFAULT_WIDTH = 320;
const FOCUS_SIDEBAR_MIN_WIDTH = 220;
const FOCUS_SIDEBAR_MAX_WIDTH = 520;
const FOCUS_SIDEBAR_WIDTH_STORAGE_KEY = "xyz.focus-widget.sidebar-width-v2";
const FOCUS_COLUMN_WIDTH_STORAGE_KEY = "xyz.focus-widget.column-width-v2";

/** Portrait aspect ratio for modern mobile devices (width/height ~ 9:19.5). */
const MOBILE_PORTRAIT_RATIO = 9 / 19.5;

/** Compute side-panel width from viewport height to match a mobile canvas aspect ratio. */
function getDefaultSidePanelWidth(): number {
  if (typeof window === "undefined") return 390;
  return Math.min(480, Math.max(280, Math.round(window.innerHeight * MOBILE_PORTRAIT_RATIO)));
}

function clampFocusColumnWidth(w: number): number {
  if (typeof window === "undefined") return Math.max(FOCUS_COLUMN_MIN_WIDTH, w);
  const max = Math.max(
    FOCUS_COLUMN_MIN_WIDTH + 1,
    Math.floor(window.innerWidth * FOCUS_COLUMN_MAX_FRACTION)
  );
  return Math.min(max, Math.max(FOCUS_COLUMN_MIN_WIDTH, Math.round(w)));
}

function useFocusColumnWidth() {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return FOCUS_COLUMN_DEFAULT_WIDTH;
    try {
      const saved = window.localStorage.getItem(FOCUS_COLUMN_WIDTH_STORAGE_KEY);
      const n = saved ? parseInt(saved, 10) : NaN;
      if (Number.isFinite(n)) return clampFocusColumnWidth(n);
    } catch { /* ignore */ }
    return clampFocusColumnWidth(window.innerWidth - getDefaultSidePanelWidth());
  });
  // Re-clamp on viewport resize so the column never exceeds its max fraction.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth((prev) => clampFocusColumnWidth(prev));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const persist = useCallback((w: number) => {
    try { window.localStorage.setItem(FOCUS_COLUMN_WIDTH_STORAGE_KEY, String(w)); } catch { /* ignore */ }
  }, []);
  return { width, setWidth, persist };
}

function clampFocusSidebarWidth(w: number): number {
  return Math.min(FOCUS_SIDEBAR_MAX_WIDTH, Math.max(FOCUS_SIDEBAR_MIN_WIDTH, Math.round(w)));
}

function useFocusSidebarWidth() {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return FOCUS_SIDEBAR_DEFAULT_WIDTH;
    try {
      const saved = window.localStorage.getItem(FOCUS_SIDEBAR_WIDTH_STORAGE_KEY);
      const n = saved ? parseInt(saved, 10) : NaN;
      if (Number.isFinite(n)) return clampFocusSidebarWidth(n);
    } catch { /* ignore */ }
    return clampFocusSidebarWidth(getDefaultSidePanelWidth());
  });
  const persist = useCallback((w: number) => {
    try { window.localStorage.setItem(FOCUS_SIDEBAR_WIDTH_STORAGE_KEY, String(w)); } catch { /* ignore */ }
  }, []);
  return { width, setWidth, persist };
}

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= MOBILE_BREAKPOINT_PX;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(min-width: ${MOBILE_BREAKPOINT_PX}px)`);
    const handler = () => setIsDesktop(mq.matches);
    handler();
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);
  return isDesktop;
}

/**
 * Outer FocusWidget — mounted globally on every route. Renders the cheap
 * sparkles trigger when closed; only mounts the heavy `FocusWidgetPanel`
 * (which owns its own WS subscription) when open.
 */
export function FocusWidget({ contained = false }: { contained?: boolean } = {}) {
  const { route, widgetOpen, setWidgetOpen, setSessionForRoute } = useFocusSession();
  const { openMobile, isMobile: sidebarIsMobile } = useSidebar();
  const voiceSession = useVoiceSessionOptional();
  const { data: agentStatus } = useExecutorStatus();
  const isDesktop = useIsDesktop();
  const isAgentRunning = agentStatus?.status === "running";
  const deepLinkHandled = useRef(false);
  const pendingAutoVoiceSession = useRef<string | null>(null);

  // Deep links can arrive while the widget is closed, especially during FTUE.
  // Desktop keeps the existing background behavior because the SessionWindow is
  // already mounted. Mobile must open the full-screen SessionWindow before
  // starting the voice hello sequence.
  useEffect(() => {
    if (deepLinkHandled.current) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const targetSessionId = params.get("c");
      if (!targetSessionId) return;
      deepLinkHandled.current = true;
      const hasAutoVoice = params.get("autoVoice") === "1";
      const url = new URL(window.location.href);
      url.searchParams.delete("c");
      url.searchParams.delete("autoVoice");
      window.history.replaceState({}, "", url.toString());
      log.info("Deep link: handling session", { sessionId: targetSessionId, autoVoice: hasAutoVoice, isDesktop });
      setSessionForRoute(route, targetSessionId);
      if (hasAutoVoice) {
        pendingAutoVoiceSession.current = targetSessionId;
      }
      if (!isDesktop || route === "/session") {
        setWidgetOpen(true);
      }
    } catch (err) {
      log.warn("Deep link handling failed:", err);
    }
  }, [route, isDesktop, setSessionForRoute, setWidgetOpen]);

  useEffect(() => {
    if (route === "/session" && !widgetOpen && !(sidebarIsMobile && openMobile)) {
      setWidgetOpen(true);
    }
  }, [route, widgetOpen, setWidgetOpen, sidebarIsMobile, openMobile]);

  useEffect(() => {
    const sessionId = pendingAutoVoiceSession.current;
    if (!sessionId || !voiceSession) return;
    if (!isDesktop && !widgetOpen) return;
    if (voiceSession.status !== "idle") return;
    pendingAutoVoiceSession.current = null;
    log.info("Deep link auto-voice: starting voice session", { sessionId, isDesktop });
    voiceSession.setActiveConversationId(sessionId);
    voiceSession.startSession();
  }, [voiceSession, voiceSession?.status, widgetOpen, isDesktop]);

  if (HIDDEN_ROUTES.has(route)) return null;

  // On mobile, the widget is a full-screen overlay gated on widgetOpen.
  // On desktop, the session window is always visible; widgetOpen only controls
  // the session menu sidebar. So we always mount FocusWidgetPanel on desktop.
  if (!isDesktop && !widgetOpen) return null;

  return <FocusWidgetPanel isAgentRunning={isAgentRunning} />;
}

interface FocusWidgetPanelProps {
  isAgentRunning: boolean;
}

/**
 * Mounted only when the widget is OPEN. Owns the focus session's WS
 * subscription and transcript panel. Closing the widget tears this whole subtree
 * down so its hooks stop running.
 */
function FocusWidgetPanel({ isAgentRunning }: FocusWidgetPanelProps) {
  const { route, widgetOpen, setWidgetOpen, getSessionForRoute, setSessionForRoute, clearSessionForRoute, sessionMenuResetKey, requestBottomBarFocus, setMobileSessionTitle } = useFocusSession();
  const { hasStreaming } = useSessionActivityState();
  const [, setLocationNav] = useLocation();
  const { toast } = useToast();
  const { config: pageHeaderConfig } = usePageHeaderContext();
  const isDesktop = useIsDesktop();
  const queryClient = useQueryClient();
  const voiceSession = useVoiceSessionOptional();
  // On the /session route, closing the widget should redirect to /simple
  // since /session has no content of its own (it exists for FTUE deep links).
  const closeWidget = useCallback(() => {
    setWidgetOpen(false);
    if (route === "/session") setLocationNav("/home");
  }, [setWidgetOpen, route, setLocationNav]);
  const { width: columnWidth, setWidth: setColumnWidth, persist: persistColumnWidth } = useFocusColumnWidth();
  const { width: sidebarWidth, setWidth: setSidebarWidth, persist: persistSidebarWidth } = useFocusSidebarWidth();

  // Drag-to-resize: track the starting pointer/width on mousedown, then update
  // width on mousemove (clamped to MIN..viewport*MAX_FRACTION). On mouseup,
  // persist the final width to localStorage so it survives reloads.
  const resizeStartRef = useRef<{ startX: number; startW: number } | null>(null);
  const startResize = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    if (typeof window === "undefined") return;
    e.preventDefault();
    const startX = "clientX" in e ? e.clientX : 0;
    resizeStartRef.current = { startX, startW: columnWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      if (!resizeStartRef.current) return;
      // Dragging LEFT (smaller clientX) grows the right-docked column.
      const delta = resizeStartRef.current.startX - ev.clientX;
      setColumnWidth(clampFocusColumnWidth(resizeStartRef.current.startW + delta));
    };
    const onUp = (ev: MouseEvent) => {
      if (!resizeStartRef.current) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        return;
      }
      const delta = resizeStartRef.current.startX - ev.clientX;
      const finalW = clampFocusColumnWidth(resizeStartRef.current.startW + delta);
      setColumnWidth(finalW);
      persistColumnWidth(finalW);
      resizeStartRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [columnWidth, setColumnWidth, persistColumnWidth]);


  const sidebarResizeStartRef = useRef<{ startX: number; startW: number } | null>(null);
  const startSidebarResize = useCallback((e: React.MouseEvent | React.PointerEvent) => {
    if (typeof window === "undefined" || !isDesktop) return;
    e.preventDefault();
    const startX = "clientX" in e ? e.clientX : 0;
    sidebarResizeStartRef.current = { startX, startW: sidebarWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      if (!sidebarResizeStartRef.current) return;
      // Dragging LEFT (smaller clientX) grows the right-side sidebar
      const delta = sidebarResizeStartRef.current.startX - ev.clientX;
      setSidebarWidth(clampFocusSidebarWidth(sidebarResizeStartRef.current.startW + delta));
    };
    const onUp = (ev: MouseEvent) => {
      if (!sidebarResizeStartRef.current) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        return;
      }
      const delta = sidebarResizeStartRef.current.startX - ev.clientX;
      const finalW = clampFocusSidebarWidth(sidebarResizeStartRef.current.startW + delta);
      setSidebarWidth(finalW);
      persistSidebarWidth(finalW);
      sidebarResizeStartRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [isDesktop, sidebarWidth, setSidebarWidth, persistSidebarWidth]);

  // --- Panel view: single discriminant for what the user sees ---
  // Replaces the old (activeSession, composing) pair which allowed
  // impossible states and required transition-detection refs.
  type PanelView =
    | { mode: "list" }
    | { mode: "composing" }
    | { mode: "session"; sessionId: string };

  const [panelView, setPanelView] = useState<PanelView>({ mode: "list" });
  const activeSession = panelView.mode === "session" ? panelView.sessionId : null;
  const composing = panelView.mode === "composing";

  const voice = useVoiceStreaming(voiceSession, activeSession);
  const { setShowVoiceToolsSafe, voiceStepsInsertIndexRef } = voice;
  const [searchQuery, setSearchQuery] = useState("");


  // Deep link refs — declared early so widget-open effect can check them.
  const deepLinkHandled = useRef(false);
  const deepLinkAutoVoice = useRef(false);

  // Mobile preserves the old overlay behavior: opening the session menu returns
  // to the list unless a deep link selected a session. Desktop keeps the
  // SessionWindow mounted beside the menu, so opening the menu must not steal
  // the currently focused conversation.
  const prevWidgetOpenRef = useRef(false);
  useEffect(() => {
    if (widgetOpen && !prevWidgetOpenRef.current && !isDesktop) {
      if (!deepLinkHandled.current) {
        setPanelView({ mode: "list" });
        clearSessionForRoute(route);
      }
    }
    prevWidgetOpenRef.current = widgetOpen;
  }, [widgetOpen, isDesktop, route, clearSessionForRoute]);

  // Mobile SessionMenu requests are explicit navigation commands. They must
  // work even when the full-screen SessionWindow is already open, where
  // setWidgetOpen(true) alone is a no-op and the open-transition effect above
  // does not fire.
  useEffect(() => {
    if (isDesktop) return;
    if (!widgetOpen) return;
    if (sessionMenuResetKey === 0) return;
    setPanelView({ mode: "list" });
    clearSessionForRoute(route);
  }, [sessionMenuResetKey, isDesktop, widgetOpen, route, clearSessionForRoute]);

  // Page navigation must not change the focused conversation. The selected
  // session is user-owned state; route changes only update the pageContext
  // patched onto that session below. Older focus-session behavior re-resolved
  // a per-route session here, which made navbar navigation steal focus.

  // Persist activeSession into the per-route map whenever a session becomes
  // active. We intentionally bind only to the route that was active at the
  // moment the session was attached — navigating with the widget open keeps
  // the conversation but should NOT re-associate it with the new route's slot
  // in the map (otherwise opening the widget on a different page would
  // resurface this conversation).
  const sessionAttachedRouteRef = useRef<string | null>(null);
  const lastBoundSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSession) {
      sessionAttachedRouteRef.current = null;
      lastBoundSessionRef.current = null;
      return;
    }
    if (lastBoundSessionRef.current === activeSession) return;
    sessionAttachedRouteRef.current = route;
    lastBoundSessionRef.current = activeSession;
    setSessionForRoute(route, activeSession);
    // route intentionally omitted from deps so navigation doesn't rebind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession, setSessionForRoute]);

  // Sync local activeSession when an external source (e.g. BottomBar) updates
  // the route session map, but never let a route change replace an already
  // focused conversation. Explicit selection should win; navigation is only
  // context.
  const externalSessionId = getSessionForRoute(route);
  useEffect(() => {
    if (!externalSessionId) return;
    if (externalSessionId === lastBoundSessionRef.current) return;
    setPanelView((prev) => prev.mode === "session" && prev.sessionId === externalSessionId
      ? prev
      : { mode: "session", sessionId: externalSessionId });
  }, [externalSessionId]);

  // Auto-close widget on routes where it should be hidden
  useEffect(() => {
    if (HIDDEN_ROUTES.has(route) && widgetOpen) {
      setWidgetOpen(false);
    }
  }, [route, widgetOpen, setWidgetOpen]);

  // Fallback deep link handler for legacy entry points where the outer widget
  // did not consume the params first. The panel is already mounted here, so
  // selecting the session puts the user directly into the SessionWindow before
  // any auto-voice start.
  useEffect(() => {
    if (deepLinkHandled.current) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const targetSessionId = params.get("c");
      if (!targetSessionId) return;
      deepLinkHandled.current = true;
      const hasAutoVoice = params.get("autoVoice") === "1";
      if (hasAutoVoice) deepLinkAutoVoice.current = true;
      const url = new URL(window.location.href);
      url.searchParams.delete("c");
      url.searchParams.delete("autoVoice");
      window.history.replaceState({}, "", url.toString());
      log.info("Deep link: selecting session", { sessionId: targetSessionId, autoVoice: hasAutoVoice });
      setPanelView({ mode: "session", sessionId: targetSessionId });
    } catch (err) {
      log.warn("Deep link handling failed:", err);
    }
  }, []);

  // Deep link auto-voice: start voice once session + voiceSession are ready
  useEffect(() => {
    if (!deepLinkAutoVoice.current || !activeSession || !voiceSession) return;
    if (voiceSession.status !== "idle") return;
    deepLinkAutoVoice.current = false;
    log.info("Deep link auto-voice: starting voice session", { sessionId: activeSession });
    voiceSession.setActiveConversationId(activeSession);
    voiceSession.startSession();
  }, [activeSession, voiceSession]);

  const focusCtx = useFocusContextValue();
  // Reactive URL search string — many pages encode the active tab as ?tab=...
  // Used as a fallback when the page header config hasn't mounted yet (lazy
  // page load race) or doesn't report an active tab.
  const search = useSearch();
  const pageContext = useMemo<PageContext>(() => ({
    route,
    pageTitle: pageHeaderConfig?.title || undefined,
    tab: pageHeaderConfig?.activeTab || new URLSearchParams(search).get("tab") || undefined,
    subView: focusCtx?.subView,
    entity: focusCtx?.entity,
    state: focusCtx?.state,
  }), [route, pageHeaderConfig?.title, pageHeaderConfig?.activeTab, focusCtx, search]);

  const pageContextRef = useRef(pageContext);
  pageContextRef.current = pageContext;

  // Fresh pageContext at send time — included in every message POST so the
  // server can update the focus session's stored context even if the session
  // was created before the page header mounted (or from another surface).
  const getMessagePageContext = useCallback(() => pageContextRef.current, []);

  const createSessionPayload = useCallback(() => ({
    sessionType: "user",
    sessionKey: `focus:${pageContextRef.current.route}`,
    pageContext: pageContextRef.current,
    title: pageContextRef.current.pageTitle
      ? `Focus: ${pageContextRef.current.pageTitle}`
      : `Focus: ${pageContextRef.current.route}`,
  }), []);

  // Watch the active session for messages to know if we can clean up an empty
  // session on close. We also use the query's error state as the authoritative
  // "session no longer exists" signal — the /api/sessions list query lags
  // behind optimistic cache writes, so checking it for stale-session detection
  // races with new-session creation.
  const { data: sessionData, error: sessionError } = useQuery<{ messages: { role: string }[] } & Session>({
    queryKey: ["/api/sessions", activeSession],
    enabled: !!activeSession,
  });

  const messageCount = sessionData?.messages?.length ?? 0;

  // Debounced PATCH /api/sessions/:id/context whenever pageContext changes for
  // an active focus session that has at least one message.
  const lastPatchedContextRef = useRef<string>("");
  useEffect(() => {
    if (!activeSession) return;
    if (messageCount === 0) return;
    const key = JSON.stringify({
      r: pageContext.route,
      t: pageContext.tab ?? "",
      p: pageContext.pageTitle ?? "",
      s: pageContext.subView ?? "",
      e: pageContext.entity ?? null,
      st: pageContext.state ?? null,
    });
    if (lastPatchedContextRef.current === key) return;
    const handle = window.setTimeout(() => {
      lastPatchedContextRef.current = key;
      apiRequest("PATCH", `/api/sessions/${activeSession}/context`, {
        pageContext: {
          route: pageContext.route,
          tab: pageContext.tab,
          pageTitle: pageContext.pageTitle,
          subView: pageContext.subView,
          entity: pageContext.entity,
          state: pageContext.state,
        },
      })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/sessions", activeSession] });
          queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
        })
        .catch((err) => log.warn("failed to patch session context", err));
    }, CONTEXT_PATCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [activeSession, messageCount, pageContext, queryClient]);

  // Reset patch tracker when switching sessions.
  useEffect(() => {
    lastPatchedContextRef.current = "";
  }, [activeSession]);

  // Sessions list (used by SessionTranscriptPanel header for title/topics/pin badges).
  const { data: sessions = [], isLoading: sessionsLoading } = useQuery<Session[]>({
    queryKey: ["/api/sessions"],
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });

  const liveSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeSession) ids.add(activeSession);
    for (const session of sessions) {
      if (session.status !== "streaming") continue;
      ids.add(session.id);
      if (ids.size >= 8) break;
    }
    return Array.from(ids);
  }, [activeSession, sessions]);
  const sessionStreams = useSessionSubscriptions(liveSessionIds, { owner: "focus-widget", activeSession });
  const sessionSub = getSessionStreamState(sessionStreams.streams, activeSession, sessionStreams.wsConnected);



  const selectSession = useCallback((id: string) => {
    const targetSession = sessions.find((session) => session.id === id);
    const needsMarkRead = targetSession?.hasUnreadResult || targetSession?.errorSeverity;
    if (needsMarkRead) {
      queryClient.setQueryData<Session[]>(["/api/sessions"], (old) =>
        old?.map((session) => session.id === id
          ? { ...session, hasUnreadResult: false, errorSeverity: undefined }
          : session)
      );
      apiRequest("PATCH", `/api/sessions/${id}/read`).catch(() => {});
    }

    voiceSession?.clearTranscript();
    setShowVoiceToolsSafe(false);
    voiceStepsInsertIndexRef.current = -1;
    setPanelView({ mode: "session", sessionId: id });
  }, [queryClient, sessions, voiceSession, setShowVoiceToolsSafe, voiceStepsInsertIndexRef]);

  const startNewChat = useCallback(async () => {
    voiceSession?.clearTranscript();
    setShowVoiceToolsSafe(false);
    voiceStepsInsertIndexRef.current = -1;

    try {
      const res = await apiRequest("POST", "/api/sessions", { title: "New Session" });
      const newSession: Session = await res.json();

      queryClient.setQueryData<Session[]>(["/api/sessions"], (old) => {
        if (!old) return [newSession as any];
        if (old.some(s => s.id === newSession.id)) return old;
        return [newSession as any, ...old];
      });

      setPanelView({ mode: "session", sessionId: newSession.id });
      requestBottomBarFocus();
      emitSessionListChanged("new-session");
    } catch (err) {
      log.error("Failed to create new session:", err);
      toast({ title: "Failed to create session", description: String(err), variant: "destructive" });
      clearSessionForRoute(route);
      setPanelView({ mode: "list" });
    }
  }, [voiceSession, setShowVoiceToolsSafe, voiceStepsInsertIndexRef, clearSessionForRoute, route, queryClient, toast, requestBottomBarFocus]);

  const sidebarDeleteConversation = useMutation({
    mutationFn: (id: string) => deleteSessionTree(id),
    onSuccess: (result) => {
      emitSessionListChanged("focus-sidebar-delete");
      if (panelView.mode === "session" && result.deletedSessionIds.includes(panelView.sessionId)) {
        setPanelView({ mode: "list" });
        clearSessionForRoute(route);
      }
    },
    onError: (err) => {
      toast({ title: "Failed to delete session", description: String(err), variant: "destructive" });
    },
  });

  const sidebarArchiveConversation = useMutation({
    mutationFn: async (id: string) => {
      const session = sessions.find((item) => item.id === id);
      await apiRequest("PATCH", `/api/sessions/${id}/archive`, { archived: !session?.archivedAt });
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["/api/sessions"] });
      const previousSessions = queryClient.getQueryData<Session[]>(["/api/sessions"]);
      const session = previousSessions?.find((item) => item.id === id);
      const archivedAt = session?.archivedAt ? null : new Date().toISOString();
      queryClient.setQueryData<Session[]>(["/api/sessions"], (old) =>
        old?.map((item) => item.id === id ? { ...item, archivedAt, isPinned: archivedAt ? false : item.isPinned } : item) ?? old,
      );
      return { previousSessions, archivedAt };
    },
    onSuccess: (_data, id) => {
      emitSessionListChanged("focus-sidebar-archive-toggle");
      if (panelView.mode === "session" && panelView.sessionId === id) {
        setPanelView({ mode: "list" });
        clearSessionForRoute(route);
      }
    },
    onError: (err, _id, context) => {
      if (context?.previousSessions) {
        queryClient.setQueryData(["/api/sessions"], context.previousSessions);
      }
      toast({ title: "Failed to update archive state", description: String(err), variant: "destructive" });
    },
  });

  const sidebarRenameConversation = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      await apiRequest("PATCH", `/api/sessions/${id}`, { title });
    },
    onSuccess: (_data, { id }) => {
      emitSessionListChanged("focus-sidebar-rename");
      emitSessionChanged(id, "focus-sidebar-rename");
    },
    onError: (err) => {
      toast({ title: "Failed to rename session", description: String(err), variant: "destructive" });
    },
  });

  // If active session disappears server-side (e.g. deleted from main chat page),
  // drop it from local state so the widget won't try to open a stale id.
  useEffect(() => {
    if (!activeSession) return;
    if (!sessionError) return;
    const msg = sessionError instanceof Error ? sessionError.message : String(sessionError);
    if (!msg.startsWith("404:")) return;
    log.warn(`active focus session ${activeSession} 404 — clearing local state`);
    setPanelView({ mode: "list" });
    clearSessionForRoute(route);
  }, [activeSession, sessionError, route, clearSessionForRoute]);

  const setActiveSessionWrapped = useCallback((id: string | null) => {
    if (id) {
      selectSession(id);
    } else {
      setPanelView({ mode: "list" });
      clearSessionForRoute(route);
    }
  }, [selectSession, clearSessionForRoute, route]);

  // Compat wrapper for SessionTranscriptPanel's setComposing prop. Only transitions to
  // list when leaving composing mode; a no-op in session mode (where
  // setActiveSession already moved the discriminant).
  const setComposingCompat = useCallback((v: boolean) => {
    if (v) { setPanelView({ mode: "composing" }); return; }
    setPanelView(prev => prev.mode === "composing" ? { mode: "list" } : prev);
  }, []);

  // One discriminant: panelView.mode determines which view the user sees.
  const showMobileSessionTranscriptPanel = !isDesktop && panelView.mode !== "list";
  const activeSessionTitle = activeSession
    ? sessions.find((session) => session.id === activeSession)?.title || "Session"
    : composing
      ? "New Session"
      : "Sessions";
  const returnToMobileSessionList = useCallback(() => {
    setPanelView({ mode: "list" });
    clearSessionForRoute(route);
  }, [clearSessionForRoute, route]);

  const handleFocusedSessionReminderSet = useCallback((id: string) => {
    if (!isDesktop && panelView.mode === "session" && panelView.sessionId === id) {
      returnToMobileSessionList();
    }
  }, [isDesktop, panelView, returnToMobileSessionList]);

  const toggleAttention = useMutation({
    mutationFn: async ({ id, isPinned }: { id: string; isPinned: boolean }) => {
      await apiRequest("PATCH", `/api/gateway/conversations/${id}/attention`, { isPinned });
    },
    onMutate: async ({ id, isPinned }) => {
      await queryClient.cancelQueries({ queryKey: ["/api/sessions"] });
      const previousSessions = queryClient.getQueryData<Session[]>(["/api/sessions"]);
      queryClient.setQueryData<Session[]>(["/api/sessions"], (old) =>
        old?.map((session) => session.id === id ? { ...session, isPinned } : session) ?? old,
      );
      return { previousSessions };
    },
    onError: (err, _variables, context) => {
      if (context?.previousSessions) queryClient.setQueryData(["/api/sessions"], context.previousSessions);
      toast({ title: "Failed to toggle pin", description: String(err), variant: "destructive" });
    },
    onSettled: () => {
      emitSessionListChanged("focus-sidebar-pin-toggle");
    },
  });

  const handleTogglePin = useCallback((id: string, pinned: boolean) => {
    toggleAttention.mutate({ id, isPinned: pinned });
  }, [toggleAttention]);

  useEffect(() => {
    setMobileSessionTitle(showMobileSessionTranscriptPanel ? activeSessionTitle : null);
    return () => setMobileSessionTitle(null);
  }, [activeSessionTitle, setMobileSessionTitle, showMobileSessionTranscriptPanel]);

  // Transcript panel width must be computed before headerAndPanel JSX that references it.
  const transcriptPanelWidth = columnWidth - sidebarWidth - 1; // -1px for divider

  const headerAndPanel = (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
      <div className="flex items-center gap-2 h-[42px] px-1.5 border-b border-black md:hidden shrink-0 bg-background">
        <XyzIconButton />
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={activeSessionTitle}>
          {activeSessionTitle}
        </div>
        {showMobileSessionTranscriptPanel && (
          <button
            type="button"
            onClick={returnToMobileSessionList}
            className={cn(
              "shrink-0 flex items-center justify-center h-7 w-7 rounded-md transition-colors",
              "text-foreground bg-muted",
            )}
            aria-label="Session menu"
            data-testid="button-focus-widget-session-menu"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="flex-1 flex flex-col md:flex-row min-h-0 overflow-hidden">
        <div
          className={cn(
            "flex-col min-w-0 overflow-hidden md:flex shrink-0",
            showMobileSessionTranscriptPanel ? "flex flex-1" : "hidden",
          )}
          style={isDesktop ? { width: `${transcriptPanelWidth}px` } : undefined}
        >
          <SessionTranscriptPanel
            activeSession={activeSession}
            setActiveSession={setActiveSessionWrapped}
            composing={composing}
            setComposing={setComposingCompat}
            sessions={sessions}
            voice={voice}
            sessionSub={sessionSub}
            sessionStreams={sessionStreams.streams}
            mode="widget"
            enableAutoScroll={true}
            showBackButton={!isDesktop}
            onArchiveSession={(id) => sidebarArchiveConversation.mutate(id)}
            onTogglePinSession={handleTogglePin}
            onSessionReminderSet={handleFocusedSessionReminderSet}
            titlebarActions={undefined}
            emptyStateMessage="What's next?"
          />
          {isDesktop && (
            <BottomBar
              contained
              sessionId={activeSession}
              sessionSub={sessionSub}
              setSessionId={setActiveSessionWrapped}
              createSessionPayload={createSessionPayload}
              getMessagePageContext={getMessagePageContext}
            />
          )}
        </div>
        {/* Desktop: session menu sidebar + divider, toggled by widgetOpen */}
        {widgetOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sessions menu"
            onMouseDown={startSidebarResize}
            className="hidden md:flex w-px shrink-0 cursor-col-resize bg-transparent hover:bg-foreground active:bg-foreground transition-colors z-10 items-center justify-center relative"
            data-testid="handle-focus-widget-sidebar-resize"
          >
            {/* Wide invisible hit target */}
            <div className="absolute inset-y-0 -left-1.5 w-3" />
          </div>
        )}
        <div
          className={cn(
            "border-b border-black md:border-b-0 bg-background flex-col w-full min-w-0 md:flex-none md:h-auto",
            showMobileSessionTranscriptPanel ? "hidden" : "flex flex-1 min-h-0",
            // Desktop: session menu hidden when widgetOpen is false
            !showMobileSessionTranscriptPanel && isDesktop && !widgetOpen && "md:hidden",
            widgetOpen && "md:flex",
          )}
          style={isDesktop ? { flexBasis: `${sidebarWidth}px` } : undefined}
        >
          <ConversationSidebar
            sessions={sessions}
            convsLoading={sessionsLoading}
            activeSession={activeSession}
            isAgentRunning={isAgentRunning}
            hideForSessionTranscript={false}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}

            onSelect={selectSession}
            onDelete={(id) => sidebarDeleteConversation.mutate(id)}
            onRename={(id, title) => sidebarRenameConversation.mutate({ id, title })}
            onArchive={(id) => sidebarArchiveConversation.mutate(id)}
            onTogglePin={handleTogglePin}
            onStartNewChat={startNewChat}
            scrollResetKey={sessionMenuResetKey}
          />
        </div>
      </div>
    </div>
  );

  // Mobile: full-screen overlay (unchanged from popup behavior).
  if (!isDesktop) {
    return (
      <div
        className="fixed inset-x-0 top-0 z-40 bg-background flex flex-col overflow-hidden"
        style={{ bottom: "var(--bottom-bar-height, 0px)" }}
        data-testid="panel-focus-widget"
      >
        {headerAndPanel}
      </div>
    );
  }

  // Desktop: docked right column with fixed width. The aside is always the
  // full columnWidth. When the session menu is hidden, the transcript panel keeps
  // its width and the sidebar space becomes empty — the divider doesn't move.
  return (
    <aside
      className="relative flex shrink-0 min-w-0 bg-background h-full"
      style={{ width: `${columnWidth}px` }}
      data-testid="panel-focus-widget"
      aria-label="Focus chat"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize focus chat"
        onMouseDown={startResize}
        className="absolute left-0 top-0 bottom-0 w-px -translate-x-1/2 cursor-col-resize bg-transparent hover:bg-foreground active:bg-foreground transition-colors z-10"
        data-testid="handle-focus-widget-resize"
      >
        {/* Wide invisible hit target */}
        <div className="absolute inset-y-0 -left-1.5 w-3" />
      </div>
      <div className="flex flex-col min-w-0 flex-1 overflow-hidden">
        {/* Desktop header: vault context is centered over the transcript column. */}
        <div className="hidden md:flex h-[42px] shrink-0">
          <div
            className="flex shrink-0 items-center justify-center"
            style={{ width: `${transcriptPanelWidth}px` }}
          >
            <VaultToggles />
          </div>
          <div className="flex flex-1 items-center justify-end gap-2 px-2">
            <ConnectionsIndicator />
            <button
            type="button"
            onClick={() => setWidgetOpen(!widgetOpen)}
            className={cn(
              "shrink-0 flex items-center justify-center h-7 w-7 rounded-md border transition-colors",
              hasStreaming
                ? "text-active border-active/30 animate-pulse"
                : "border-border text-muted-foreground hover:bg-muted/50",
            )}
            aria-label={widgetOpen ? "Hide sessions menu" : "Show sessions menu"}
            data-testid="button-focus-widget-conversation-toggle"
          >
            <MessageSquare className="h-4 w-4" />
            </button>
          </div>
        </div>
        {headerAndPanel}
      </div>
    </aside>
  );
}
