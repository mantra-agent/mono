// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useCallback, useRef, useMemo, createContext, useContext, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";

const log = createLogger("Myelination");

interface MyelinationState {
  isMyelinating: boolean;
  isPaused: boolean;
  phase: string;
  current: number;
  total: number;
  detail: string;
  result: { summarized: number; embedded: number; linked: number } | null;
}

interface MyelinationContextValue extends MyelinationState {
  start: () => void;
  pause: () => void;
  resume: () => void;
}

const MyelinationContext = createContext<MyelinationContextValue | null>(null);

export function useMyelination() {
  const ctx = useContext(MyelinationContext);
  if (!ctx) throw new Error("useMyelination must be used within MyelinationProvider");
  return ctx;
}

export function useMyelinationOptional() {
  return useContext(MyelinationContext);
}

export function MyelinationProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const [state, setState] = useState<MyelinationState>({
    isMyelinating: false,
    isPaused: false,
    phase: "",
    current: 0,
    total: 0,
    detail: "",
    result: null,
  });
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    stoppedRef.current = false;

    const poll = async () => {
      if (stoppedRef.current) return;
      try {
        const res = await fetch("/api/memory/myelination/progress");
        if (!res.ok) return;
        const data = await res.json();

        if (stoppedRef.current) return;

        if (!data.running && data.phase === "complete" && data.result) {
          setState(s => ({
            ...s,
            isMyelinating: false,
            isPaused: false,
            phase: "complete",
            current: data.current,
            total: data.total,
            detail: data.detail,
            result: data.result,
          }));
          toast({
            title: "Myelination complete",
            description: `${data.result.summarized} summarized, ${data.result.embedded} embedded, ${data.result.linked} linked`,
          });
          stopPolling();
          queryClient.invalidateQueries({ queryKey: ["/api/memory/vnext/graph"] });
          queryClient.invalidateQueries({ queryKey: ["/api/memory/myelination/stats"] });
          return;
        }

        if (!data.running && data.phase === "error") {
          setState(s => ({
            ...s,
            isMyelinating: false,
            isPaused: false,
            phase: "error",
            detail: data.error || data.detail || "Unknown error",
          }));
          toast({ title: "Myelination failed", description: data.error || data.detail, variant: "destructive" });
          stopPolling();
          return;
        }

        if (!data.running && data.phase === "idle") {
          stopPolling();
          setState(s => ({ ...s, isMyelinating: false }));
          return;
        }

        if (data.running) {
          setState(s => ({
            ...s,
            isMyelinating: true,
            isPaused: false,
            phase: data.phase || s.phase,
            current: data.current ?? s.current,
            total: data.total ?? s.total,
            detail: data.detail || s.detail,
          }));
        }
      } catch (err) {
        log.error("Poll error:", err);
      }
    };

    poll();
    pollingRef.current = setInterval(poll, 1000);
  }, [stopPolling, toast]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const start = useCallback(async () => {
    if (state.isMyelinating && !state.isPaused) return;

    setState(s => ({
      ...s,
      isMyelinating: true,
      isPaused: false,
      phase: "starting",
      current: 0,
      total: 0,
      detail: "Starting myelination...",
      result: null,
    }));

    try {
      const res = await apiRequest("POST", "/api/memory/myelinate", { phase: "all" });
      const data = await res.json();

      if (!data.started && data.message === "Myelination already running") {
        toast({ title: "Myelination already in progress" });
      }

      startPolling();
    } catch (err: any) {
      log.error("Failed to start:", err);
      toast({ title: "Myelination failed", description: err.message, variant: "destructive" });
      setState(s => ({ ...s, isMyelinating: false, phase: "error", detail: err.message }));
    }
  }, [state.isMyelinating, state.isPaused, toast, startPolling]);

  const pause = useCallback(() => {
    stoppedRef.current = true;
    stopPolling();
    setState(s => ({ ...s, isPaused: true, detail: "Paused — click Resume to continue" }));
  }, [stopPolling]);

  const resume = useCallback(() => {
    setState(s => ({ ...s, isPaused: false }));
    startPolling();
  }, [startPolling]);

  const value = useMemo(() => ({
    ...state,
    start,
    pause,
    resume,
  }), [state, start, pause, resume]);

  return (
    <MyelinationContext.Provider value={value}>
      {children}
    </MyelinationContext.Provider>
  );
}
