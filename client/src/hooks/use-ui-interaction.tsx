import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { useLocation, useSearch } from "wouter";
import {
  getUiInteractionTargetHref,
  getUiInteractionTargetPermission,
  isUiInteractionCommand,
  isUiInteractionTargetOpen,
  type UiInteractionCommand,
  type UiInteractionReason,
  type UiInteractionTarget,
} from "@shared/ui-interaction";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { createLogger } from "@/lib/logger";
import { useSidebar } from "@/components/ui/sidebar";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/hooks/use-auth";
import { useVoiceSessionOptional } from "@/hooks/use-voice-session";
import { usePageActivity } from "@/hooks/use-page-activity";

const log = createLogger("UiInteraction");
const WS_OWNER = "ui-interaction";
const HANDLER_ID = "ui-interaction-command";
const TARGET_WAIT_MS = 2_000;
const NARRATION_SETTLE_TIMEOUT_MS = 8_000;

type TargetRegistry = Map<UiInteractionTarget, HTMLElement>;
type ResourceRegistry = Map<string, HTMLElement>;
type UiInteractionOutcome = "completed" | "cancelled" | "unavailable";

interface TargetRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

interface UiInteractionContextValue {
  guidedTarget: UiInteractionTarget | null;
  guidedResource: string | null;
  invoke: (target: UiInteractionTarget) => void;
  registerTarget: (target: UiInteractionTarget, element: HTMLElement | null) => void;
  registerResource: (resource: string, element: HTMLElement | null) => void;
}

const UiInteractionContext = createContext<UiInteractionContextValue | null>(null);

function GuideSpotlight({ target, introduction, onCancel }: { target: HTMLElement; introduction: string; onCancel: () => void }) {
  const [rect, setRect] = useState<TargetRect | null>(null);

  useEffect(() => {
    const update = () => {
      const next = target.getBoundingClientRect();
      setRect({ top: next.top, left: next.left, right: next.right, bottom: next.bottom });
    };
    target.scrollIntoView({ block: "center", inline: "nearest" });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [target]);

  if (!rect) return null;
  const width = Math.max(0, rect.right - rect.left);
  const height = Math.max(0, rect.bottom - rect.top);

  // Anchor the narration beside the highlighted control, flipping above it when
  // the control sits low in the viewport so the caption is never clipped.
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
  const placeAbove = viewportHeight > 0 && rect.bottom > viewportHeight * 0.6;
  const captionStyle = placeAbove
    ? { bottom: Math.max(16, viewportHeight - rect.top + 12), left: Math.max(16, rect.left) }
    : { top: rect.bottom + 12, left: Math.max(16, rect.left) };

  return (
    <div className="pointer-events-none fixed inset-0 z-[90]" role="presentation">
      <div className="pointer-events-auto absolute inset-x-0 top-0 bg-background/80" style={{ height: Math.max(0, rect.top) }} />
      <div className="pointer-events-auto absolute inset-x-0 bottom-0 bg-background/80" style={{ top: Math.max(0, rect.bottom) }} />
      <div className="pointer-events-auto absolute left-0 bg-background/80" style={{ top: rect.top, width: Math.max(0, rect.left), height }} />
      <div className="pointer-events-auto absolute right-0 bg-background/80" style={{ top: rect.top, left: rect.right, height }} />
      <div
        className="absolute rounded-md ring-2 ring-cta ring-offset-2 ring-offset-background"
        style={{ top: rect.top, left: rect.left, width, height }}
      />
      <div
        className="pointer-events-auto absolute z-[91] w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-card-border bg-card p-4 shadow-xl"
        style={captionStyle}
        role="status"
        aria-live="polite"
      >
        <p className="text-sm leading-relaxed text-foreground">{introduction}</p>
      </div>
      <button
        type="button"
        data-ui-interaction-cancel
        onClick={onCancel}
        className="pointer-events-auto fixed right-4 top-4 rounded-md bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      >
        Cancel
      </button>
    </div>
  );
}

export function UiInteractionProvider({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const isMobile = useIsMobile();
  const { hasPermission } = useAuth();
  const { setOpen, setOpenMobile, closeSidebar } = useSidebar();
  const { setWidgetOpen } = useFocusSession();
  const { startNavigation } = usePageActivity();
  // Optional: when a voice transport is mounted, gate the guide reveal on the
  // agent finishing its spoken introduction. Absent voice, this stays false and
  // the guide reveals immediately (text-mode behavior).
  const voiceSession = useVoiceSessionOptional();
  const agentSpeaking = voiceSession?.agentMode === "speaking";
  const targetsRef = useRef<TargetRegistry>(new Map());
  const resourcesRef = useRef<ResourceRegistry>(new Map());
  const sharedWSRef = useRef<ReturnType<typeof acquireSharedWS> | null>(null);
  const [targetVersion, setTargetVersion] = useState(0);
  const [activeCommand, setActiveCommand] = useState<UiInteractionCommand | null>(null);
  const activeCommandRef = useRef<UiInteractionCommand | null>(null);
  // Latches true once a guide's spotlight has been revealed, so a later spoken
  // turn cannot retract an already-visible highlight.
  const [guideRevealed, setGuideRevealed] = useState(false);
  const narrationSpeakingObservedRef = useRef(false);
  const narrationReceivedAtRef = useRef(0);

  const sendResult = useCallback((
    command: UiInteractionCommand,
    outcome: UiInteractionOutcome,
    reason?: UiInteractionReason,
  ) => {
    const sent = sharedWSRef.current?.send({
      type: "ui.interaction.result",
      commandId: command.commandId,
      outcome,
      ...(reason ? { reason } : {}),
    }) ?? false;
    log.info("interaction settled", {
      commandId: command.commandId,
      subject: command.subject ?? "control",
      ...(command.subject === "resource"
        ? { resource: command.resource, surface: command.surface }
        : { target: command.target }),
      mode: command.mode,
      outcome,
      reason: reason ?? null,
      sent,
    });
  }, []);

  const settle = useCallback((outcome: UiInteractionOutcome, reason?: UiInteractionReason) => {
    const command = activeCommandRef.current;
    if (!command) return;
    activeCommandRef.current = null;
    setActiveCommand(null);
    setGuideRevealed(false);
    sendResult(command, outcome, reason);
  }, [sendResult]);

  const canInvoke = useCallback((target: UiInteractionTarget) => {
    const permission = getUiInteractionTargetPermission(target);
    return !permission || hasPermission(permission);
  }, [hasPermission]);

  const invoke = useCallback((target: UiInteractionTarget) => {
    if (!canInvoke(target)) return;
    if (target === "navigation.sidebar.toggle") {
      if (isMobile) setOpenMobile((open) => !open);
      else setOpen((open) => !open);
      return;
    }
    const href = getUiInteractionTargetHref(target);
    if (!href) return;
    if (isMobile) setWidgetOpen(false);
    if (href !== location) startNavigation({ href });
    navigate(href);
    closeSidebar();
  }, [canInvoke, closeSidebar, isMobile, location, navigate, setOpen, setOpenMobile, setWidgetOpen, startNavigation]);

  const revealControl = useCallback((target: UiInteractionTarget) => {
    if (target === "navigation.sidebar.toggle") return;
    if (isMobile) {
      setWidgetOpen(false);
      setOpenMobile(true);
    } else {
      setOpen(true);
    }
  }, [isMobile, setOpen, setOpenMobile, setWidgetOpen]);

  const revealResource = useCallback(() => {
    if (isMobile) setWidgetOpen(false);
    navigate("/home");
    closeSidebar();
  }, [closeSidebar, isMobile, navigate, setWidgetOpen]);

  const canInvokeRef = useRef(canInvoke);
  const invokeRef = useRef(invoke);
  const revealControlRef = useRef(revealControl);
  const revealResourceRef = useRef(revealResource);
  canInvokeRef.current = canInvoke;
  invokeRef.current = invoke;
  revealControlRef.current = revealControl;
  revealResourceRef.current = revealResource;

  const registerTarget = useCallback((target: UiInteractionTarget, element: HTMLElement | null) => {
    const previous = targetsRef.current.get(target) ?? null;
    if (previous === element) return;
    if (element) targetsRef.current.set(target, element);
    else targetsRef.current.delete(target);
    setTargetVersion((value) => value + 1);
  }, []);

  const registerResource = useCallback((resource: string, element: HTMLElement | null) => {
    const previous = resourcesRef.current.get(resource) ?? null;
    if (previous === element) return;
    if (element) resourcesRef.current.set(resource, element);
    else resourcesRef.current.delete(resource);
    setTargetVersion((value) => value + 1);
  }, []);

  useEffect(() => {
    const ws = acquireSharedWS(WS_OWNER);
    sharedWSRef.current = ws;
    ws.addMessageHandler(HANDLER_ID, (message) => {
      if (!isUiInteractionCommand(message)) return;
      if (message.expiresAt <= Date.now()) {
        sendResult(message, "unavailable", "timed_out");
        return;
      }

      if (message.subject !== "resource" && !canInvokeRef.current(message.target)) {
        sendResult(message, "unavailable", "target_unavailable");
        return;
      }
      const previous = activeCommandRef.current;
      if (previous) {
        activeCommandRef.current = null;
        setActiveCommand(null);
        sendResult(previous, "cancelled", "superseded");
      }
      activeCommandRef.current = message;
      narrationSpeakingObservedRef.current = false;
      narrationReceivedAtRef.current = Date.now();
      setActiveCommand(message);
      setGuideRevealed(false);

      // Execute acts immediately. Guide reveal is deferred to the speech-gated
      // effect below so the spotlight never appears mid-introduction.
      if (message.subject !== "resource" && message.mode === "execute") invokeRef.current(message.target);
    });
    ws.addCloseHandler(HANDLER_ID, () => settle("unavailable", "client_disconnected"));
    return () => {
      const command = activeCommandRef.current;
      if (command) sendResult(command, "unavailable", "client_disconnected");
      activeCommandRef.current = null;
      ws.removeMessageHandler(HANDLER_ID);
      ws.removeCloseHandler(HANDLER_ID);
      sharedWSRef.current = null;
      releaseSharedWS(WS_OWNER);
    };
  }, [sendResult, settle]);

  useEffect(() => {
    if (!activeCommand || activeCommand.subject === "resource") return;
    if (isUiInteractionTargetOpen(activeCommand.target, location, search)) {
      settle("completed");
    }
  }, [activeCommand, location, search, settle]);

  useEffect(() => {
    if (!activeCommand) return;
    const remainingMs = activeCommand.expiresAt - Date.now();
    if (remainingMs <= 0) {
      settle("unavailable", "timed_out");
      return;
    }
    const timer = window.setTimeout(() => settle("unavailable", "timed_out"), remainingMs);
    return () => window.clearTimeout(timer);
  }, [activeCommand, settle]);

  // A voice guide with newly streamed narration reveals only after provider
  // speaking starts and settles. Already-spoken and text-mode guides reveal
  // immediately. If provider mode evidence is lost, fail open after a bounded
  // wait rather than trapping FTUE behind an invisible guide.
  useEffect(() => {
    if (!activeCommand || activeCommand.mode !== "guide" || guideRevealed) return;
    if (activeCommand.narrationState !== "streamed") {
      if (activeCommand.subject === "resource") revealResourceRef.current();
      else revealControlRef.current(activeCommand.target);
      setGuideRevealed(true);
      return;
    }

    if (agentSpeaking) {
      narrationSpeakingObservedRef.current = true;
      return;
    }
    if (narrationSpeakingObservedRef.current) {
      if (activeCommand.subject === "resource") revealResourceRef.current();
      else revealControlRef.current(activeCommand.target);
      setGuideRevealed(true);
      return;
    }

    const remainingMs = Math.max(
      0,
      NARRATION_SETTLE_TIMEOUT_MS - (Date.now() - narrationReceivedAtRef.current),
    );
    const timer = window.setTimeout(() => {
      log.warn("guide narration speaking state timed out; revealing", {
        commandId: activeCommand.commandId,
      });
      if (activeCommand.subject === "resource") revealResourceRef.current();
      else revealControlRef.current(activeCommand.target);
      setGuideRevealed(true);
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [activeCommand, agentSpeaking, guideRevealed]);

  const activeTargetElement = activeCommand?.mode === "guide" && guideRevealed
    ? activeCommand.subject === "resource"
      ? resourcesRef.current.get(activeCommand.resource) ?? null
      : targetsRef.current.get(activeCommand.target) ?? null
    : null;

  // Start the target-availability clock only after the guide has been revealed,
  // so waiting for the agent to finish speaking never counts against it.
  useEffect(() => {
    if (!activeCommand || activeCommand.mode !== "guide" || !guideRevealed || activeTargetElement) return;
    const timer = window.setTimeout(() => settle("unavailable", "target_unavailable"), TARGET_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [activeCommand, activeTargetElement, guideRevealed, settle, targetVersion]);

  useEffect(() => {
    if (!activeCommand || activeCommand.mode !== "guide" || !activeTargetElement) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    activeTargetElement.focus({ preventScroll: true });

    const blockOutside = (event: Event) => {
      if (!(event.target instanceof Node)) return;
      if (activeTargetElement.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest("[data-ui-interaction-cancel]")) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const completeOnTargetActivation = () => {
      settle("completed");
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settle("cancelled", "user_cancelled");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        activeTargetElement.focus({ preventScroll: true });
      }
    };

    activeTargetElement.addEventListener("click", completeOnTargetActivation, true);
    document.addEventListener("pointerdown", blockOutside, true);
    document.addEventListener("click", blockOutside, true);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      activeTargetElement.removeEventListener("click", completeOnTargetActivation, true);
      document.removeEventListener("pointerdown", blockOutside, true);
      document.removeEventListener("click", blockOutside, true);
      document.removeEventListener("keydown", handleKey, true);
      previousFocus?.focus({ preventScroll: true });
    };
  }, [activeCommand, activeTargetElement, settle]);

  const value = useMemo<UiInteractionContextValue>(() => ({
    guidedTarget: activeCommand?.mode === "guide" && guideRevealed && activeCommand.subject !== "resource"
      ? activeCommand.target
      : null,
    guidedResource: activeCommand?.mode === "guide" && guideRevealed && activeCommand.subject === "resource"
      ? activeCommand.resource
      : null,
    invoke,
    registerTarget,
    registerResource,
  }), [activeCommand, guideRevealed, invoke, registerResource, registerTarget]);

  return (
    <UiInteractionContext.Provider value={value}>
      {children}
      {activeTargetElement && activeCommand?.mode === "guide" ? (
        <GuideSpotlight
          target={activeTargetElement}
          introduction={activeCommand.displayIntroduction}
          onCancel={() => settle("cancelled", "user_cancelled")}
        />
      ) : null}
    </UiInteractionContext.Provider>
  );
}

export function useUiInteraction(): UiInteractionContextValue {
  const value = useContext(UiInteractionContext);
  if (!value) throw new Error("useUiInteraction must be used within UiInteractionProvider");
  return value;
}

export function useUiInteractionTarget(target: UiInteractionTarget): RefCallback<HTMLElement> {
  const { registerTarget } = useUiInteraction();
  return useCallback((element: HTMLElement | null) => registerTarget(target, element), [registerTarget, target]);
}

export function useUiInteractionResource(resource: string | null): RefCallback<HTMLElement> {
  const { registerResource } = useUiInteraction();
  return useCallback((element: HTMLElement | null) => {
    if (resource) registerResource(resource, element);
  }, [registerResource, resource]);
}
