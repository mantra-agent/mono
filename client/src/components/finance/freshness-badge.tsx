import { cn } from "@/lib/utils";
import { Clock } from "lucide-react";

interface FreshnessBadgeProps {
  lastUpdated: string | Date | null | undefined;
  className?: string;
}

function getAge(date: Date): { label: string; stale: boolean } {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 5) return { label: "Just now", stale: false };
  if (minutes < 60) return { label: `${minutes}m ago`, stale: false };
  if (hours < 24) return { label: `${hours}h ago`, stale: hours > 12 };
  return { label: `${days}d ago`, stale: true };
}

export function FreshnessBadge({ lastUpdated, className }: FreshnessBadgeProps) {
  if (!lastUpdated) return null;

  const date = typeof lastUpdated === "string" ? new Date(lastUpdated) : lastUpdated;
  if (isNaN(date.getTime())) return null;

  const { label, stale } = getAge(date);

  return (
    <span className={cn(
      "inline-flex items-center gap-1 text-xs leading-none",
      stale ? "text-warning-foreground" : "text-muted-foreground/60",
      className,
    )}>
      <Clock className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}
