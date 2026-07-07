import type { ReactNode } from "react";
import { MantraLogo } from "@/components/mantra-logo";
import { cn } from "@/lib/utils";

interface ChatEmptyStateProps {
  message?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function ChatEmptyState({ message = "What's next?", compact = false, className }: ChatEmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-3" : "gap-4",
        className,
      )}
      data-testid="chat-empty-state"
    >
      <MantraLogo className={compact ? "h-10 w-10" : "h-14 w-14"} />
      <p className={cn("text-muted-foreground", compact ? "text-xs" : "text-sm")}>
        {message}
      </p>
    </div>
  );
}
