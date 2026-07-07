import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface SimpleCheckCircleProps {
  checked?: boolean;
  pending?: boolean;
  disabled?: boolean;
  interactive?: boolean;
  /** "check" (default) or "caution" for warning indicators like missing due dates */
  variant?: "check" | "caution";
  /** Tooltip text shown on hover (used with caution variant) */
  tooltip?: string;
  label?: string;
  onClick?: () => void;
  className?: string;
}

const CHECK_CIRCLE_BASE = "h-4 w-4 rounded-full border bg-transparent inline-flex items-center justify-center transition-colors";

export function SimpleCheckCircle({
  checked = false,
  pending = false,
  disabled = false,
  interactive = true,
  variant = "check",
  tooltip,
  label,
  onClick,
  className,
}: SimpleCheckCircleProps) {
  // Caution variant: warning icon with tooltip, non-interactive checkbox
  if (variant === "caution") {
    const cautionIcon = (
      <span
        className={cn(CHECK_CIRCLE_BASE, "border-warning text-warning", className)}
        aria-label={tooltip || "Warning"}
      >
        <AlertTriangle className="h-3 w-3" />
      </span>
    );

    if (tooltip) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{cautionIcon}</TooltipTrigger>
            <TooltipContent side="right" className="text-xs">{tooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return cautionIcon;
  }

  const classes = cn(
    CHECK_CIRCLE_BASE,
    checked
      ? "border-success text-success hover:bg-success/10"
      : "border-muted-foreground text-muted-foreground",
    interactive && !checked && !disabled && "hover:border-success hover:bg-success/10",
    disabled && interactive && !checked && "cursor-not-allowed opacity-60",
    !interactive && "pointer-events-none",
    className,
  );

  if (!interactive) {
    return (
      <span className={classes} aria-hidden="true">
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled && !pending) onClick?.();
      }}
      className={classes}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : checked ? <Check className="h-3 w-3" /> : null}
    </button>
  );
}
