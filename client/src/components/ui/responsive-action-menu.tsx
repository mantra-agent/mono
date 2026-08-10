import * as React from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";

import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

interface ResponsiveActionMenuContextValue {
  close: () => void;
  enter: (id: string, label: string) => void;
  path: Array<{ id: string; label: string }>;
}

const ResponsiveActionMenuContext = React.createContext<ResponsiveActionMenuContextValue | null>(null);

function useResponsiveActionMenuContext() {
  const context = React.useContext(ResponsiveActionMenuContext);
  if (!context) throw new Error("Responsive action menu parts must be used inside ResponsiveActionMenu");
  return context;
}

export interface ResponsiveActionMenuProps {
  trigger: React.ReactNode;
  title: string;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
}

export function ResponsiveActionMenu({ trigger, title, children, open: controlledOpen, onOpenChange, align = "end" }: ResponsiveActionMenuProps) {
  const isMobile = useIsMobile();
  const [internalOpen, setInternalOpen] = React.useState(false);
  const [path, setPath] = React.useState<Array<{ id: string; label: string }>>([]);
  const open = controlledOpen ?? internalOpen;
  const setOpen = React.useCallback((next: boolean) => {
    if (!next) setPath([]);
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  }, [controlledOpen, onOpenChange]);

  React.useEffect(() => {
    if (open) setOpen(false);
    // Presentation changes close rather than transferring focus between modality trees.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  const context = React.useMemo<ResponsiveActionMenuContextValue>(() => ({
    close: () => setOpen(false),
    enter: (id, label) => setPath((current) => [...current, { id, label }]),
    path,
  }), [path, setOpen]);

  const currentChildren = resolveMenuLevel(children, path.map((entry) => entry.id));
  const currentTitle = path.at(-1)?.label ?? title;
  const body = (
    <ResponsiveActionMenuContext.Provider value={context}>
      <div className="max-h-[min(70vh,32rem)] overflow-y-auto overscroll-contain p-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]">
        {path.length > 0 && (
          <button
            type="button"
            className="mb-1 flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setPath((current) => current.slice(0, -1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </button>
        )}
        {currentChildren}
      </div>
    </ResponsiveActionMenuContext.Provider>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="max-h-[85dvh] bg-popover text-popover-foreground">
          <DrawerHeader className="pb-2 text-left">
            <DrawerTitle className="truncate text-base text-popover-foreground">{currentTitle}</DrawerTitle>
          </DrawerHeader>
          {body}
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="w-64 p-0">
        <div className="border-b border-border/40 px-3 py-2 text-sm font-medium">{currentTitle}</div>
        {body}
      </PopoverContent>
    </Popover>
  );
}

function resolveMenuLevel(children: React.ReactNode, path: string[]): React.ReactNode {
  if (path.length === 0) return children;
  const [next, ...rest] = path;
  for (const child of React.Children.toArray(children)) {
    if (React.isValidElement<ResponsiveActionMenuSubProps>(child) && child.type === ResponsiveActionMenuSub && child.props.id === next) {
      return resolveMenuLevel(child.props.children, rest);
    }
  }
  return children;
}

export interface ResponsiveActionMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: LucideIcon;
  destructive?: boolean;
  onSelect?: () => void;
}

export function ResponsiveActionMenuItem({ icon: Icon, destructive, onSelect, className, children, disabled, ...props }: ResponsiveActionMenuItemProps) {
  const { close } = useResponsiveActionMenuContext();
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        "flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        destructive && "text-destructive",
        className,
      )}
      onClick={() => {
        onSelect?.();
        close();
      }}
      {...props}
    >
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export interface ResponsiveActionMenuSubProps {
  id: string;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
  children: React.ReactNode;
}

export function ResponsiveActionMenuSub({ id, label, icon: Icon, disabled }: ResponsiveActionMenuSubProps) {
  const { enter } = useResponsiveActionMenuContext();
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className="flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      onClick={() => enter(id, label)}
    >
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function ResponsiveActionMenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border/40" />;
}
