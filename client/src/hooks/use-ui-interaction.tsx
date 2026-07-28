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
  isUiInteractionCommand,
  type UiInteractionCommand,
  type UiInteractionReason,
  type UiInteractionTarget,
} from "@shared/ui-interaction";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { createLogger } from "@/lib/logger";
import { useSidebar } from "@/components/ui/sidebar";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useIsMobile } from "@/hooks/use-mobile";

const log = createLogger("UiInteraction");
const WS_OWNER = "ui-interaction";
const HANDLER_ID = "ui-interaction-command";
const TARGET_WAIT_MS = 2_000;

type TargetRegistry = Map<UiInteractionTarget, HTMLElement>;
type UiInteractionOutcome = "completed" | "cancelled" | "unavailable";

interface TargetRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

interface UiInteractionContextValue {
  guidedTarget: UiInteractionTarget | null;
  invoke: (target: UiInteractionTarget) => void;
  registerTarget: (target: UiInteractionTarget, element: HTMLElement | null) => void;
}

const UiInteractionContext = createContext<UiInteractionContextValue | null>(null);

function memoryGraphIsOpen(path: string, search: string): boolean {
  return path === "/memory" && new URLSearchParams(search).get("tab") === "graph";
}

function GuideSpotlight({ target, onCancel }: { target: HTMLElement; onCancel: () => void }) {
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
  const { setOpen, setOpenMobile, closeSidebar } = useSidebar();
  const { setWidgetOpen } = useFocusSession();
  const targetsRef = useRef<TargetRegistry>(new Map());
  const sharedWSRef = useRef<ReturnType<typeof acquireSharedWS> | null>(null);
  const [targetVersion, setTargetVersion] = useState(0);
  const [activeCommand, setActiveCommand] = useState<UiInteractionCommand | null>(null);
  const activeCommandRef = useRef<UiInteractionCommand | null>(null);

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
      target: command.target,
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
    sendResult(command, outcome, reason);
  }, [sendResult]);

  const invoke = useCallback((target: UiInteractionTarget) => {
    if (target !== "navigation.memoryGraph.open") return;
    if (isMobile) setWidgetOpen(false);
    navigate("/memory?tab=graph");
    closeSidebar();
  }, [closeSidebar, isMobile, navigate, setWidgetOpen]);

  const reveal = useCallback((target: UiInteractionTarget) => {
    if (target !== "navigation.memoryGraph.open") return;
    if (isMobile) {
      setWidgetOpen(false);
      setOpenMobile(true);
    } else {
      setOpen(true);
    }
  }, [isMobile, setOpen, setOpenMobile, setWidgetOpen]);

  const invokeRef = useRef(invoke);
  const revealRef = useRef(reveal);
  invokeRef.current = invoke;
  revealRef.current = reveal;

  const registerTarget = useCallback((target: UiInteractionTarget, element: HTMLElement | null) => {
    const previous = targetsRef.current.get(target) ?? null;
    if (previous === element) return;
    if (element) targetsRef.current.set(target, element);
    else targetsRef.current.delete(target);
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

      const previous = activeCommandRef.current;
      if (previous) sendResult(previous, "cancelled", "superseded");
      activeCommandRef.current = message;
      setActiveCommand(message);

      if (message.mode === "execute") invokeRef.current(message.target);
      else revealRef.current(message.target);
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
    if (!activeCommand) return;
    if (activeCommand.target === "navigation.memoryGraph.open" && memoryGraphIsOpen(location, search)) {
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

  const activeTargetElement = activeCommand?.mode === "guide"
    ? targetsRef.current.get(activeCommand.target) ?? null
    : null;

  useEffect(() => {
    if (!activeCommand || activeCommand.mode !== "guide" || activeTargetElement) return;
    const timer = window.setTimeout(() => settle("unavailable", "target_unavailable"), TARGET_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [activeCommand, activeTargetElement, settle, targetVersion]);

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

    document.addEventListener("pointerdown", blockOutside, true);
    document.addEventListener("click", blockOutside, true);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("pointerdown", blockOutside, true);
      document.removeEventListener("click", blockOutside, true);
      document.removeEventListener("keydown", handleKey, true);
      previousFocus?.focus({ preventScroll: true });
    };
  }, [activeCommand, activeTargetElement, settle]);

  const value = useMemo<UiInteractionContextValue>(() => ({
    guidedTarget: activeCommand?.mode === "guide" ? activeCommand.target : null,
    invoke,
    registerTarget,
  }), [activeCommand, invoke, registerTarget]);

  return (
    <UiInteractionContext.Provider value={value}>
      {children}
      {activeTargetElement ? (
        <GuideSpotlight
          target={activeTargetElement}
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
