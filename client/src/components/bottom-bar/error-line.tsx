import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { AlertTriangle, RefreshCw, X } from "lucide-react";

interface ErrorLineProps {
  message: string | null;
  visible: boolean;
  onDismiss: () => void;
  onRetry?: () => void;
  autoDismissMs?: number;
}

export function ErrorLine({
  message,
  visible,
  onDismiss,
  onRetry,
  autoDismissMs = 5000,
}: ErrorLineProps) {
  useEffect(() => {
    if (!visible || !message) return;
    const timer = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(timer);
  }, [visible, message, onDismiss, autoDismissMs]);

  if (!visible || !message) return null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-xs",
        "text-destructive",
        "transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 min-w-0 truncate">{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
          aria-label="Retry"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-0.5 rounded hover:bg-muted transition-colors"
        aria-label="Dismiss error"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
