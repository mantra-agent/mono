import { cn } from "@/lib/utils";

interface StatusIndicatorProps {
  status: "running" | "stopped" | "starting" | "restarting" | "error" | "not_installed";
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
}

const statusConfig = {
  running: { color: "bg-success", pulse: true, label: "Running" },
  stopped: { color: "bg-neutral", pulse: false, label: "Stopped" },
  starting: { color: "bg-warning", pulse: true, label: "Starting" },
  restarting: { color: "bg-warning", pulse: true, label: "Restarting" },
  error: { color: "bg-error", pulse: true, label: "Error" },
  not_installed: { color: "bg-neutral", pulse: false, label: "Not Installed" },
};

const sizeMap = { sm: "h-2 w-2", md: "h-2.5 w-2.5", lg: "h-3 w-3" };

export function StatusIndicator({ status, size = "md", showLabel = false }: StatusIndicatorProps) {
  const config = statusConfig[status];
  return (
    <div className="flex items-center gap-2">
      <span className="relative flex">
        {config.pulse && (
          <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", config.color)} />
        )}
        <span className={cn("relative inline-flex rounded-full", config.color, sizeMap[size])} />
      </span>
      {showLabel && (
        <span className="text-xs font-medium text-muted-foreground" data-testid="text-agent-status">
          {config.label}
        </span>
      )}
    </div>
  );
}
