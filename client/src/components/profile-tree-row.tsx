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
}) {
  const [open, setOpen] = useState(false);

  if (!hasValue && !showEmpty) return null;

  const canExpand = Boolean(expandedContent);

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={testId}>
      <div className="group last:border-b-0">
        <div className="group relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm w-full text-left select-none transition-colors hover:bg-accent/70">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
            <span className="flex items-center justify-center shrink-0 text-muted-foreground">{icon}</span>
            <span className="truncate">{label}</span>
          </div>
          <div
            className={cn(
              "flex min-w-0 w-48 shrink-0 items-center justify-end text-right text-xs leading-none",
              "[&_input]:h-5 [&_input]:w-48 [&_input]:bg-muted/50 [&_input]:px-1.5 [&_input]:py-0 [&_input]:text-right [&_input]:text-xs [&_input]:leading-none",
              "[&_input[type=date]]:[color-scheme:dark] [&_input[type=date]::-webkit-calendar-picker-indicator]:h-3 [&_input[type=date]::-webkit-calendar-picker-indicator]:w-3 [&_input[type=date]::-webkit-calendar-picker-indicator]:opacity-60 [&_input[type=date]::-webkit-calendar-picker-indicator]:invert",
              "[&_textarea]:bg-muted/50 [&_textarea]:text-xs",
              "[&_[role=combobox]]:h-5 [&_[role=combobox]]:w-48 [&_[role=combobox]]:justify-end [&_[role=combobox]]:bg-muted/50 [&_[role=combobox]]:px-1.5 [&_[role=combobox]]:py-0 [&_[role=combobox]]:text-right [&_[role=combobox]]:text-xs [&_[role=combobox]>span]:text-right",
              "[&_button]:h-5 [&_button]:px-1.5 [&_button]:text-xs",
            )}
          >
            {children}
          </div>
          {canExpand ? (
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 hover:bg-accent hover:text-foreground"
                aria-label={`${open ? "Collapse" : "Expand"} ${typeof label === "string" ? label : "profile field"}`}
              >
                <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
              </Button>
            </CollapsibleTrigger>
          ) : actionContent ? (
            <div className="h-5 w-5 shrink-0">{actionContent}</div>
          ) : (
            <span className="h-5 w-5 shrink-0" />
          )}
          {menuContent ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0 rounded text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100" aria-label="More actions">
                  <MoreHorizontal className="h-3 w-3" />
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
