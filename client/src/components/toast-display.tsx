import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";

import { parseReferenceText } from "@shared/reference-parser";

import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const EXIT_MS = 260;
const DISMISS_COOLDOWN_MS = 10000;

type ToastPhase = "enter" | "visible" | "exit";

function ToastLabel({ label }: { label: string }) {
  const parts = parseReferenceText(label);

  return (
    <span className="relative z-10 flex min-w-0 flex-1 flex-wrap items-center justify-center gap-x-1 gap-y-0.5 text-center text-sm font-medium leading-tight text-white">
      {parts.map((part, index) => {
        if (part.kind === "reference") {
          return (
            <ReferenceRenderer
              key={`${part.ref.canonical}-${index}`}
              refValue={part.ref}
              surface="chat-inline"
              className="mx-0 text-sm font-semibold text-cyan-100 drop-shadow-[0_0_10px_rgba(34,211,238,0.35)] hover:text-white [&>span]:border-white/70"
            />
          );
        }

        return (
          <span key={index} className="min-w-0 whitespace-pre-wrap break-words">
            {part.text}
          </span>
        );
      })}
    </span>
  );
}

interface AppToastDisplayProps {
  className?: string;
  toastClassName?: string;
}

/**
 * Shared app toast renderer for bottom-bar and glasses surfaces.
 * The toast state remains owned by use-toast; this component owns only the
 * presentation lifecycle so every surface gets the same look and motion.
 */
export function AppToastDisplay({ className, toastClassName }: AppToastDisplayProps) {
  const { toasts, dismiss } = useToast();
  const [currentToast, setCurrentToast] = useState(() => null as (typeof toasts)[number] | null);
  const [phase, setPhase] = useState<ToastPhase>("enter");
  const cooldownUntilRef = useRef(0);
  const exitingToastIdRef = useRef<string | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enterFrameRef = useRef<number | null>(null);
  const secondEnterFrameRef = useRef<number | null>(null);

  const activeToast = useMemo(() => {
    if (Date.now() < cooldownUntilRef.current) return null;
    return toasts.find((toast) => toast.open !== false) ?? null;
  }, [toasts]);

  const clearTimers = useCallback(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (enterFrameRef.current) {
      cancelAnimationFrame(enterFrameRef.current);
      enterFrameRef.current = null;
    }
    if (secondEnterFrameRef.current) {
      cancelAnimationFrame(secondEnterFrameRef.current);
      secondEnterFrameRef.current = null;
    }
  }, []);

  const beginExit = useCallback((toastId: string, explicitDismiss = false) => {
    if (exitingToastIdRef.current === toastId) return;
    if (explicitDismiss) {
      cooldownUntilRef.current = Date.now() + DISMISS_COOLDOWN_MS;
    }
    exitingToastIdRef.current = toastId;
    setPhase("exit");
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    exitTimerRef.current = setTimeout(() => {
      dismiss(toastId);
      setCurrentToast((toast) => (toast?.id === toastId ? null : toast));
      exitingToastIdRef.current = null;
      exitTimerRef.current = null;
    }, EXIT_MS);
  }, [dismiss]);

  useEffect(() => {
    return clearTimers;
  }, [clearTimers]);

  useEffect(() => {
    if (!activeToast) {
      if (currentToast && exitingToastIdRef.current !== currentToast.id) {
        beginExit(currentToast.id);
      }
      return;
    }

    if (activeToast.id === exitingToastIdRef.current) return;
    if (currentToast?.id === activeToast.id) return;

    clearTimers();
    exitingToastIdRef.current = null;
    setCurrentToast(activeToast);
    setPhase("enter");
    enterFrameRef.current = requestAnimationFrame(() => {
      secondEnterFrameRef.current = requestAnimationFrame(() => {
        setPhase("visible");
        secondEnterFrameRef.current = null;
      });
      enterFrameRef.current = null;
    });
  }, [activeToast, beginExit, clearTimers, currentToast]);

  const handleDismiss = useCallback(() => {
    if (currentToast) beginExit(currentToast.id, true);
  }, [beginExit, currentToast]);

  if (!currentToast) return null;

  const isDestructive = currentToast.variant === "destructive";
  const Icon = isDestructive ? AlertTriangle : CheckCircle2;
  const iconClassName = isDestructive ? "text-error" : "text-success";
  const label = [currentToast.title, currentToast.description]
    .filter(Boolean)
    .join(" — ");

  return (
    <div className={cn("pointer-events-none flex justify-center px-3", className)}>
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-auto relative flex min-h-12 max-w-[min(38rem,calc(100vw-2rem))] items-center gap-3 overflow-hidden rounded-2xl border border-white/20 bg-gradient-to-br from-zinc-900/90 via-zinc-800/70 to-zinc-950/90 px-5 py-3 text-center text-sm text-white shadow-[0_18px_60px_rgba(0,0,0,0.58),0_0_0_1px_rgba(255,255,255,0.08),inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-xl before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:bg-gradient-to-b before:from-white/18 before:via-white/7 before:to-transparent after:pointer-events-none after:absolute after:inset-0 after:bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.16),transparent_58%)]",
          isDestructive && "border-error/30 from-zinc-950/92 via-zinc-900/78 to-red-950/55 after:bg-[radial-gradient(circle_at_50%_0%,rgba(239,68,68,0.22),transparent_60%)]",
          "transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform",
          phase === "enter" && "translate-y-8 opacity-0",
          phase === "visible" && "translate-y-0 opacity-100",
          phase === "exit" && "translate-y-0 opacity-0 duration-[260ms] ease-in",
          toastClassName,
        )}
      >
        <Icon className={cn("relative z-10 h-5 w-5 shrink-0 drop-shadow-[0_0_10px_currentColor]", iconClassName)} />
        <ToastLabel label={label} />
        <button
          type="button"
          onClick={handleDismiss}
          className="relative z-10 -mr-1 shrink-0 rounded-md p-1 text-white/70 transition-colors duration-150 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
          aria-label="Dismiss toast"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
