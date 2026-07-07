import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Loader2, CheckCircle2, Circle, AlertCircle, RefreshCw } from "lucide-react";

interface AnalyzeProgress {
  percent: number;
  label?: string;
}

interface BootPhaseInfo {
  name: string;
  label: string;
  status: "pending" | "active" | "done" | "error" | "degraded";
  durationMs: number | null;
  error?: string;
  analyzeProgress?: AnalyzeProgress;
}

interface BootStatus {
  phases: BootPhaseInfo[];
  ready: boolean;
  error: string | null;
  elapsedMs: number;
}

type ConnectionState = "connecting" | "connected" | "error";

export function BootGate({ children }: { children: ReactNode }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [bootStatus, setBootStatus] = useState<BootStatus | null>(null);
  const [bootReady, setBootReady] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [failCount, setFailCount] = useState(0);

  const MAX_CONNECT_FAILURES = 120;

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/boot/status", { credentials: "include" });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: BootStatus = await res.json();
      setConnectionState("connected");
      setBootStatus(data);
      setFailCount(0);

      if (data.ready) {
        setBootReady(true);
      }

      if (data.error) {
        setFatalError(data.error);
      }
    } catch {
      setFailCount((c) => {
        const next = c + 1;
        if (next >= MAX_CONNECT_FAILURES) {
          setFatalError("Unable to connect to server after extended waiting. The server may have failed to start.");
          setConnectionState("error");
        }
        return next;
      });
    }
  }, []);

  useEffect(() => {
    if (bootReady) return;

    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [poll, bootReady]);

  if (bootReady) {
    return <>{children}</>;
  }

  if (fatalError) {
    return (
      <BootScreen>
        <div className="flex flex-col items-center gap-4" data-testid="boot-error">
          <AlertCircle className="h-8 w-8 text-error" />
          <p className="text-sm text-error text-center max-w-xs">{fatalError}</p>
          <button
            onClick={() => window.location.reload()}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-white/10 hover:bg-white/20 text-sm text-white/80 transition-colors"
            data-testid="button-reload"
          >
            <RefreshCw className="h-4 w-4" />
            Reload
          </button>
        </div>
      </BootScreen>
    );
  }

  return (
    <BootScreen>
      <ConnectingState failCount={failCount} />
    </BootScreen>
  );
}

function BootScreen({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col items-center justify-center h-screen bg-gradient-to-b from-background via-background to-background text-foreground"
      data-testid="boot-screen"
    >
      <div className="flex flex-col items-center gap-8">
        {children}
      </div>
    </div>
  );
}

function ConnectingState({ failCount }: { failCount: number }) {
  return (
    <div className="flex flex-col items-center gap-3" data-testid="boot-connecting">
      <div className="relative">
        <div className="h-8 w-8 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
      </div>
      {failCount > 10 && (
        <p className="text-xs text-white/30">
          Server is starting up ({failCount}s)
        </p>
      )}
    </div>
  );
}

function PhaseChecklist({ phases, elapsedMs }: { phases: BootPhaseInfo[]; elapsedMs: number }) {
  return (
    <div className="flex flex-col gap-1 w-64" data-testid="boot-phases">
      {phases.map((phase) => (
        <PhaseRow key={phase.name} phase={phase} />
      ))}
      <div className="mt-4 text-center">
        <p className="text-xs text-white/30">
          {(elapsedMs / 1000).toFixed(0)}s elapsed
        </p>
      </div>
    </div>
  );
}

function PhaseRow({ phase }: { phase: BootPhaseInfo }) {
  const showAnalyzeProgress =
    phase.name === "code_intelligence" &&
    (phase.status === "active" || phase.status === "degraded") &&
    phase.analyzeProgress !== undefined;
  return (
    <div
      className="flex flex-col gap-1 py-1.5 px-2 rounded-md transition-colors"
      data-testid={`boot-phase-${phase.name}`}
    >
      <div className="flex items-center gap-3">
        <PhaseIcon status={phase.status} />
        <span
          className={`text-sm flex-1 ${
            phase.status === "done"
              ? "text-white/40"
              : phase.status === "active"
              ? "text-white/90"
              : phase.status === "error"
              ? "text-error"
              : phase.status === "degraded"
              ? "text-warning"
              : "text-white/25"
          }`}
        >
          {phase.label}
        </span>
        {phase.status === "done" && phase.durationMs != null && (
          <span className="text-xs text-white/20 tabular-nums">
            {(phase.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {phase.status === "error" && (
          <span className="text-xs text-error/60">failed</span>
        )}
        {phase.status === "degraded" && (
          <span
            className="text-xs text-warning/80"
            data-testid={`status-degraded-${phase.name}`}
          >
            still indexing
          </span>
        )}
        {showAnalyzeProgress && phase.analyzeProgress && (
          <span
            className="text-xs text-white/40 tabular-nums"
            data-testid={`text-analyze-percent-${phase.name}`}
          >
            {Math.round(phase.analyzeProgress.percent)}%
          </span>
        )}
      </div>
      {showAnalyzeProgress && phase.analyzeProgress && (
        <div className="flex flex-col gap-0.5 pl-7">
          <div
            className="h-1 w-full rounded-full bg-white/10 overflow-hidden"
            data-testid={`progress-analyze-${phase.name}`}
          >
            <div
              className="h-full bg-white/40 transition-all"
              style={{ width: `${Math.max(0, Math.min(100, phase.analyzeProgress.percent))}%` }}
            />
          </div>
          {phase.analyzeProgress.label && (
            <span
              className="text-xs text-white/30 truncate"
              data-testid={`text-analyze-label-${phase.name}`}
            >
              {phase.analyzeProgress.label}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function PhaseIcon({ status }: { status: BootPhaseInfo["status"] }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-success/70 shrink-0" />;
    case "active":
      return <Loader2 className="h-4 w-4 text-white/60 animate-spin shrink-0" />;
    case "error":
      return <AlertCircle className="h-4 w-4 text-error shrink-0" />;
    case "degraded":
      return <AlertCircle className="h-4 w-4 text-warning shrink-0" />;
    default:
      return <Circle className="h-4 w-4 text-white/15 shrink-0" />;
  }
}
