import { Children, useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

function hasRenderableChildren(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (child == null || child === false || child === true) return false;
    if (typeof child === "string" || typeof child === "number") {
      return String(child).trim().length > 0;
    }
    return true;
  });
}

export function ProfileTreeRow({
  label,
  icon,
  hasValue,
  showEmpty,
  children,
  expandedContent,
  expandedContentClassName,
  actionContent,
  menuContent,
  menuVisibility = "hover",
  testId,
  defaultOpen = false,
  mobileLayout = "stacked",
  valueLayout = "default",
  onOpenChange,
}: {
  label: ReactNode;
  icon?: ReactNode;
  hasValue: boolean;
  showEmpty: boolean;
  children?: ReactNode;
  expandedContent?: ReactNode;
  expandedContentClassName?: string;
  actionContent?: ReactNode;
  menuContent?: ReactNode;
  menuVisibility?: "always" | "hover";
  testId?: string;
  defaultOpen?: boolean;
  mobileLayout?: "stacked" | "inline";
  /** Controls inline label/value allocation; `compact` lets labels use remaining width. */
  valueLayout?: "default" | "compact";
  /** Fires when expand open state changes (collapsed ↔ expanded). */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  if (!hasValue && !showEmpty) return null;

  const canExpand = Boolean(expandedContent);
  const showValue = hasRenderableChildren(children);
  const showAction = Boolean(actionContent);
  const showMenu = Boolean(menuContent);
  // Trailing control count: expand + action + menu. Class names must stay
  // fully static so Tailwind emits the grid templates.
  const trailingCount = (canExpand ? 1 : 0) + (showAction ? 1 : 0) + (showMenu ? 1 : 0);
  const usesSessionMenuControls = mobileLayout === "inline";
  const sessionDisclosureControlClassName = "h-5 min-h-5 w-5 min-w-5 rounded [&_svg]:size-3";
  const sessionOverflowControlClassName = "h-6 min-h-6 w-6 min-w-6 rounded-md [&_svg]:size-3.5";

  // Rendered cells are label, value, then trailing controls. Keep exactly one
  // grid track per cell; valueLayout sizes content inside the flexible value
  // track rather than introducing a phantom fixed-width track.
  const inlineValueGrid =
    trailingCount === 3
      ? "grid-cols-[max-content_minmax(0,1fr)_auto_auto_auto] gap-y-0"
      : trailingCount === 2
        ? "grid-cols-[max-content_minmax(0,1fr)_auto_auto] gap-y-0"
        : trailingCount === 1
          ? "grid-cols-[max-content_minmax(0,1fr)_auto] gap-y-0"
          : "grid-cols-[max-content_minmax(0,1fr)] gap-y-0";
  const inlineNoValueGrid =
    trailingCount === 3
      ? "grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-y-0"
      : trailingCount === 2
        ? "grid-cols-[minmax(0,1fr)_auto_auto] gap-y-0"
        : trailingCount === 1
          ? "grid-cols-[minmax(0,1fr)_auto] gap-y-0"
          : "grid-cols-[minmax(0,1fr)] gap-y-0";
  const stackedValueGrid = inlineValueGrid;
  const stackedNoValueGrid = inlineNoValueGrid;

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange} data-testid={testId}>
      <div className="group last:border-b-0">
        <div
          className={cn(
            "group relative grid w-full items-center rounded-md px-2 py-1.5 text-left text-sm select-none transition-colors hover:bg-accent/70",
            mobileLayout === "inline" ? "gap-x-0" : "gap-x-2",
            showValue
              ? mobileLayout === "inline"
                ? inlineValueGrid
                : stackedValueGrid
              : mobileLayout === "inline"
                ? inlineNoValueGrid
                : stackedNoValueGrid,
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2 text-muted-foreground",
              // Keep short field labels fully visible; values take remaining width.
              // Grid gap-x is uniform, so label→value spacing lives here as
              // label-cell right padding; the grid stays gap-x-0 to keep the
              // trailing disclosure/overflow controls compact.
              mobileLayout === "inline" ? "min-w-max shrink-0 pr-2" : "min-w-0",
            )}
          >
            {icon ? (
              <span className="flex shrink-0 items-center justify-center text-muted-foreground">
                {icon}
              </span>
            ) : null}
            <span
              className={cn(
                !icon && "w-full",
                // Field labels are structural identifiers, not editable content:
                // keep them on one line and let the value/editor absorb the
                // remaining width.
                "shrink-0 whitespace-nowrap",
              )}
            >
              {label}
            </span>
          </div>
          {showValue ? (
            <div
              className={cn(
                "flex min-w-0 max-w-full items-center text-xs leading-relaxed",
                "col-span-1 min-w-0 justify-self-end justify-end overflow-hidden pl-0 text-right",
                valueLayout === "compact"
                  ? "sm:col-span-1 sm:w-auto sm:justify-end sm:overflow-visible sm:pl-0 sm:text-right"
                  : "sm:col-span-1 sm:w-auto sm:justify-end sm:overflow-visible sm:pl-0 sm:text-right",
                "[&_input]:h-5 [&_input]:w-auto [&_input]:min-w-0 [&_input]:max-w-full [&_input]:bg-muted/50 [&_input]:px-1.5 [&_input]:py-0 [&_input]:text-right [&_input]:text-xs [&_input]:leading-none",
                "[&_input[type=date]]:[color-scheme:dark] [&_input[type=date]::-webkit-calendar-picker-indicator]:h-3 [&_input[type=date]::-webkit-calendar-picker-indicator]:w-3 [&_input[type=date]::-webkit-calendar-picker-indicator]:opacity-60 [&_input[type=date]::-webkit-calendar-picker-indicator]:invert",
                "[&_textarea]:max-w-full [&_textarea]:bg-muted/50 [&_textarea]:text-xs",
                "[&_[role=combobox]]:h-5 [&_[role=combobox]]:w-auto [&_[role=combobox]]:min-w-0 [&_[role=combobox]]:max-w-full [&_[role=combobox]]:justify-end [&_[role=combobox]]:bg-muted/50 [&_[role=combobox]]:px-1.5 [&_[role=combobox]]:py-0 [&_[role=combobox]]:text-right [&_[role=combobox]]:text-xs [&_[role=combobox]>span]:text-right",
                mobileLayout === "inline"
                  ? "[&_button]:min-h-5 [&_button]:px-1.5 [&_button]:text-xs"
                  : "[&_button]:min-h-5 [&_button]:px-1.5 [&_button]:text-xs",
              )}
            >
              {children}
            </div>
          ) : null}
          {showAction ? (
            <div
              className={cn(
                // Width follows content so rows can host one control (Play) or a
                // dual pair (AI review + Check) without clipping.
                "flex shrink-0 items-center justify-end gap-0",
                usesSessionMenuControls
                  ? "h-6 min-h-6 min-w-6 w-auto"
                  : "min-h-11 min-w-11 sm:min-h-5 sm:min-w-5",
              )}
            >
              {actionContent}
            </div>
          ) : null}
          {canExpand ? (
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "shrink-0 text-muted-foreground/60 hover:bg-accent hover:text-foreground",
                  usesSessionMenuControls
                    ? sessionDisclosureControlClassName
                    : "min-h-11 min-w-11 rounded sm:min-h-5 sm:min-w-5",
                )}
                aria-label={`${open ? "Collapse" : "Expand"} ${typeof label === "string" ? label : "profile field"}`}
              >
                <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
              </Button>
            </CollapsibleTrigger>
          ) : null}
          {showMenu ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "shrink-0 text-muted-foreground/60 transition-opacity hover:bg-accent hover:text-foreground",
                    usesSessionMenuControls
                      ? sessionOverflowControlClassName
                      : "min-h-11 min-w-11 rounded sm:min-h-5 sm:min-w-5",
                    menuVisibility === "hover" &&
                      "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
                  )}
                  aria-label="More actions"
                >
                  <MoreHorizontal className={usesSessionMenuControls ? "h-3.5 w-3.5" : "h-3 w-3"} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>{menuContent}</DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {canExpand && (
          <CollapsibleContent>
            <div className={cn("px-2 pb-2 pl-8 text-xs leading-relaxed text-foreground", expandedContentClassName)}>
              {expandedContent}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}
