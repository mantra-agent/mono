import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HIERARCHY_SESSION_ROW_CLASS } from "@/components/hierarchy-section-header";
import { cn } from "@/lib/utils";

/**
 * Collapsible tree section used across the Integrations surface and any screen
 * that reuses integration-styled connector trees (e.g. Routers). Owns its own
 * open state with optional localStorage persistence.
 */
export function IntegrationTreeSection({
  label,
  children,
  initialOpen = false,
  testIdPrefix = "recall",
  actions,
  expanderRight = false,
  icon,
  variant = "section",
  persistKey,
  labelColor,
}: {
  label: string;
  children: React.ReactNode;
  initialOpen?: boolean;
  testIdPrefix?: string;
  actions?: React.ReactNode;
  expanderRight?: boolean;
  icon?: React.ReactNode;
  variant?: "section" | "item";
  persistKey?: string;
  /** Optional vault color for item-variant titles. */
  labelColor?: string | null;
}) {
  const storageKey = persistKey ? `integrations:section-open:${persistKey}` : null;
  const [open, setOpen] = useState(() => {
    if (storageKey && typeof window !== "undefined") {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === "1") return true;
      if (stored === "0") return false;
    }
    return initialOpen;
  });
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (storageKey && typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, next ? "1" : "0");
    }
  };
  const isItem = variant === "item";

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <div className="flex items-center">
        <CollapsibleTrigger
          className={cn(
            "flex min-w-0 flex-1 items-center rounded-md hover-elevate",
            // Item rows match session-menu title density (py-1.5, no min-h-11).
            isItem
              ? cn(HIERARCHY_SESSION_ROW_CLASS, "font-medium text-foreground")
              : "min-h-11 gap-1.5 px-2 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground",
          )}
          data-testid={`button-${testIdPrefix}-section-${label.toLowerCase().replaceAll(" ", "-")}`}
        >
          {!expanderRight ? <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} /> : null}
          {icon ? <span className="shrink-0 text-muted-foreground">{icon}</span> : null}
          <span
            className="min-w-0 flex-1 truncate text-left"
            style={isItem && labelColor ? { color: labelColor } : undefined}
          >
            {label}
          </span>
          {expanderRight ? <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} /> : null}
        </CollapsibleTrigger>
        {actions}
      </div>
      <CollapsibleContent>
        <div className="mt-0 space-y-0">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
