import { Bot, Check, Glasses, Monitor, Smartphone, Sparkles, Bug } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useInterfaceMode } from "@/hooks/use-interface-mode";
import { interfaceModeLabels, type InterfaceMode } from "@shared/models/interface-mode";


type ReactNativeWebViewBridge = {
  postMessage: (message: string) => void;
};

declare global {
  interface Window {
    ReactNativeWebView?: ReactNativeWebViewBridge;
  }
}

function toggleNativeDebugOverlay() {
  window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "agent.debug.toggle" }));
}

const options: Array<{ mode: InterfaceMode; icon: typeof Monitor }> = [
  { mode: "web_detail", icon: Monitor },
  { mode: "mobile_detail", icon: Smartphone },
  { mode: "mobile_simple", icon: Sparkles },
  { mode: "glasses_simple", icon: Glasses },
];

export function InterfaceSurfaceSwitcher({
  children,
  align = "start",
  open,
  onOpenChange,
  activeMode,
  stayInPreview = false,
}: {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  activeMode?: InterfaceMode;
  stayInPreview?: boolean;
}) {
  const [mode, setMode] = useInterfaceMode();
  const selectedMode = activeMode ?? mode;
  const [location, setLocation] = useLocation();

  const selectMode = (next: InterfaceMode) => {
    setMode(next);
    onOpenChange?.(false);
    const params = new URLSearchParams(window.location.search);
    const currentPreviewPath = params.get("path");
    const sourcePath = currentPreviewPath && currentPreviewPath.startsWith("/")
      ? currentPreviewPath
      : location.startsWith("/interface-preview")
        ? "/home"
        : `${location}${window.location.search}`;

    if (!stayInPreview && next === "web_detail") {
      setLocation(sourcePath);
      return;
    }

    if (!stayInPreview && next === "mobile_detail") {
      setLocation(sourcePath);
      return;
    }

    if (!stayInPreview && next === "mobile_simple") {
      setLocation("/home");
      return;
    }

    const nextParams = new URLSearchParams({ mode: next, path: sourcePath });
    setLocation(`/interface-preview?${nextParams.toString()}`);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align} className="w-56 p-2" sideOffset={8}>
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">View Agent as</div>
        <div className="space-y-1">
          {options.map(({ mode: optionMode, icon: Icon }) => {
            const active = selectedMode === optionMode;
            return (
              <Button
                key={optionMode}
                type="button"
                variant="ghost"
                className={cn(
                  "h-9 w-full justify-start gap-2 px-2 text-sm",
                  active && "bg-accent text-accent-foreground",
                )}
                onClick={() => selectMode(optionMode)}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{interfaceModeLabels[optionMode]}</span>
                {active ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </Button>
            );
          })}
        </div>
        {window.ReactNativeWebView ? (
          <div className="mt-2 border-t border-border pt-2">
            <Button
              type="button"
              variant="ghost"
              className="h-9 w-full justify-start gap-2 px-2 text-sm"
              onClick={() => {
                toggleNativeDebugOverlay();
                onOpenChange?.(false);
              }}
            >
              <Bug className="h-4 w-4" />
              <span className="flex-1 text-left">Debug</span>
            </Button>
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-2 border-t border-border px-2 pt-2 text-xs text-muted-foreground">
          <Bot className="h-3.5 w-3.5" />
          <span>Changes the surface, not the runtime.</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
