import { useEffect, useRef, useState, useCallback } from "react";
import { X, Download, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "exportJobId";
const POLL_INTERVAL_MS = 3000;

interface ExportJobStatus {
  jobId: string;
  status: "pending" | "running" | "complete" | "failed";
  progress: number;
  currentDomain: string | null;
  downloadUrl: string | null;
  error: string | null;
}

async function fetchJobStatus(jobId: string): Promise<ExportJobStatus | null> {
  try {
    const res = await fetch(`/api/export/archive/${jobId}`, { credentials: "include" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function formatDomain(domain: string | null): string {
  if (!domain) return "";
  return domain.charAt(0).toUpperCase() + domain.slice(1).replace(/_/g, " ");
}

export function ExportProgressBanner() {
  const [jobId, setJobId] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));
  const [status, setStatus] = useState<ExportJobStatus | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearJob = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setJobId(null);
    setStatus(null);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback((id: string) => {
    if (intervalRef.current) clearInterval(intervalRef.current);

    const poll = async () => {
      const s = await fetchJobStatus(id);
      if (!s) return;
      setStatus(s);
      if (s.status === "complete" || s.status === "failed") {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    };

    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
  }, []);

  // Resume polling if there's an active jobId in localStorage
  useEffect(() => {
    if (!jobId) return;
    startPolling(jobId);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [jobId, startPolling]);

  // Listen for new exports kicked off from anywhere in the app
  useEffect(() => {
    const handler = () => {
      const id = localStorage.getItem(STORAGE_KEY);
      if (id) {
        setJobId(id);
      }
    };
    window.addEventListener("export-started", handler);
    return () => window.removeEventListener("export-started", handler);
  }, []);

  if (!jobId || !status) return null;

  const isRunning = status.status === "pending" || status.status === "running";
  const isComplete = status.status === "complete";
  const isFailed = status.status === "failed";

  const handleDownload = () => {
    if (status.downloadUrl) {
      const a = document.createElement("a");
      a.href = status.downloadUrl;
      a.download = `xyz-export-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      clearJob();
    }
  };

  const handleRetry = async () => {
    clearJob();
    try {
      const res = await fetch("/api/export/archive", {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const { jobId: newId } = await res.json();
        localStorage.setItem(STORAGE_KEY, newId);
        setJobId(newId);
        window.dispatchEvent(new Event("export-started"));
      }
    } catch {
      // silent
    }
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-2 text-sm font-medium transition-all",
        "border-b border-border",
        isComplete && "bg-success/5 text-success-foreground",
        isFailed && "bg-error/5 text-error-foreground",
        isRunning && "bg-info/5 text-info-foreground",
      )}
    >
      {/* Icon */}
      <div className="flex-shrink-0">
        {isRunning && <Loader2 className="h-4 w-4 animate-spin" />}
        {isComplete && <Download className="h-4 w-4" />}
        {isFailed && <AlertCircle className="h-4 w-4" />}
      </div>

      {/* Message */}
      <div className="flex-1 min-w-0">
        {isRunning && (
          <span>
            Preparing your export…
            {status.currentDomain && ` ${formatDomain(status.currentDomain)}`}
          </span>
        )}
        {isComplete && (
          <span>Your export is ready</span>
        )}
        {isFailed && (
          <span>Export failed{status.error ? ` — ${status.error}` : ""}</span>
        )}
      </div>

      {/* Progress bar */}
      {isRunning && (
        <div className="hidden sm:block w-32 flex-shrink-0">
          <div className="h-1.5 rounded-full bg-info/20 dark:bg-info/20 overflow-hidden">
            <div
              className="h-full rounded-full bg-info dark:bg-info transition-all duration-500"
              style={{ width: `${status.progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {isComplete && status.downloadUrl && (
          <button
            onClick={handleDownload}
            className="underline underline-offset-2 hover:no-underline font-semibold"
          >
            Download
          </button>
        )}
        {isFailed && (
          <button
            onClick={handleRetry}
            className="underline underline-offset-2 hover:no-underline font-semibold"
          >
            Retry
          </button>
        )}
        <button
          onClick={clearJob}
          className="ml-1 opacity-60 hover:opacity-100 transition-opacity"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * Trigger a new export from anywhere in the app.
 * Sets localStorage key and dispatches the "export-started" event.
 */
export async function triggerExport(): Promise<void> {
  const res = await fetch("/api/export/archive", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  const { jobId } = await res.json();
  localStorage.setItem(STORAGE_KEY, jobId);
  window.dispatchEvent(new Event("export-started"));
}
