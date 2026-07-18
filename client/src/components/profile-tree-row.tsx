import { useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

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
  testId,
  defaultOpen = false,
  mobileLayout = "stacked",
}: {
  label: ReactNode;
  icon?: ReactNode;
  hasValue: boolean;
  showEmpty: boolean;
  children: ReactNode;
  expandedContent?: ReactNode;
  expandedContentClassName?: string;
  actionContent?: ReactNode;
  menuContent?: ReactNode;
  testId?: string;
  defaultOpen?: boolean;
  mobileLayout?: "stacked" | "inline";
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!hasValue && !showEmpty) return null;

  const canExpand = Boolean(expandedContent);
  const usesSessionMenuControls = mobileLayout === "inline";
  const sessionDisclosureControlClassName = "h-5 min-h-5 w-5 min-w-5 rounded [&_svg]:size-3";
  const sessionOverflowControlClassName = "h-6 min-h-6 w-6 min-w-6 rounded-md [&_svg]:size-3.5";

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <div className="group last:border-b-0">
        <div
          className={cn(
            "group relative grid w-full items-center gap-x-2 rounded-md px-2 py-1.5 text-left text-sm select-none transition-colors hover:bg-accent/70",
            mobileLayout === "inline"
              ? "grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto] gap-y-0"
              : "grid-cols-[minmax(0,1fr)_auto] gap-y-1",
            "sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto_auto] sm:gap-y-1",
          )}
        >
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <span className="flex shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
            <span className={cn("min-w-0", mobileLayout === "inline" ? "truncate" : "break-words")}>{label}</span>
          </div>
          <div
            className={cn(
              "flex min-w-0 max-w-full items-center text-xs leading-relaxed",
              mobileLayout === "inline"
                ? "col-span-1 justify-end overflow-hidden pl-0 text-right"
                : "col-span-2 justify-start pl-6 text-left",
              "sm:col-span-1 sm:w-48 sm:justify-end sm:overflow-visible sm:pl-0 sm:text-right",
              "[&_input]:h-5 [&_input]:w-48 [&_input]:bg-muted/50 [&_input]:px-1.5 [&_input]:py-0 [&_input]:text-right [&_input]:text-xs [&_input]:leading-none",
              "[&_input[type=date]]:[color-scheme:dark] [&_input[type=date]::-webkit-calendar-picker-indicator]:h-3 [&_input[type=date]::-webkit-calendar-picker-indicator]:w-3 [&_input[type=date]::-webkit-calendar-picker-indicator]:opacity-60 [&_input[type=date]::-webkit-calendar-picker-indicator]:invert",
              "[&_textarea]:bg-muted/50 [&_textarea]:text-xs",
              "[&_[role=combobox]]:h-5 [&_[role=combobox]]:w-48 [&_[role=combobox]]:justify-end [&_[role=combobox]]:bg-muted/50 [&_[role=combobox]]:px-1.5 [&_[role=combobox]]:py-0 [&_[role=combobox]]:text-right [&_[role=combobox]]:text-xs [&_[role=combobox]>span]:text-right",
              "[&_button]:min-h-11 [&_button]:px-2 [&_button]:text-xs sm:[&_button]:min-h-5 sm:[&_button]:px-1.5",
            )}
          >
            {children}
          </div>
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
          ) : actionContent ? (
            <div
              className={cn(
                "shrink-0",
                usesSessionMenuControls
                  ? "h-6 min-h-6 w-6 min-w-6"
                  : "min-h-11 min-w-11 sm:min-h-5 sm:min-w-5",
              )}
            >
              {actionContent}
            </div>
          ) : (
            <span className="hidden h-5 w-5 shrink-0 sm:block" />
          )}
          {menuContent ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "shrink-0 text-muted-foreground/60 transition-opacity hover:bg-accent hover:text-foreground",
                    usesSessionMenuControls
                      ? sessionOverflowControlClassName
                      : "min-h-11 min-w-11 rounded sm:min-h-5 sm:min-w-5 sm:opacity-0 sm:group-hover:opacity-100",
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
