import { navTree, XyzIconButton } from "@/components/app-sidebar";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { MessageSquare } from "lucide-react";
import { ConnectionsIndicator } from "@/components/connections-indicator";
import { useFocusSession } from "@/hooks/use-focus-session";
import { usePageHeaderContext } from "@/hooks/use-page-header";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSessionActivityState } from "@/components/thought-indicator";
import { VaultToggles } from "@/components/vault-toggles";
import { useLocation } from "wouter";
import { useCallback, type ReactNode } from "react";

const DETAIL_ROUTE_TITLES: Array<[string, string]> = [
  ["/goals/", "Goals"],
  ["/strategy/", "Strategy"],
  ["/projects/", "Projects"],
  ["/people/", "People"],
  ["/integrations/", "Integrations"],
  ["/issues/", "Build"],
  ["/brain/timers", "Brain"],
  ["/timers", "Brain"],
  ["/chat", "Home"],
  ["/session", "Home"],
  ["/account", "Account"],
  ["/logs", "System"],
  ["/zero", "Zero"],
  ["/interface-preview", "Preview"],
];

function getPageTitle(pathname: string) {
  if (pathname === "/" || pathname === "/home" || pathname === "/home") return "Home";

  const detailMatch = DETAIL_ROUTE_TITLES.find(([prefix]) =>
    pathname === prefix || pathname.startsWith(prefix),
  );
  if (detailMatch) return detailMatch[1];

  // Try exact tab match first: if the browser URL has ?tab=X, find the
  // navTree item whose url matches both path and tab param.
  const currentTab = new URLSearchParams(window.location.search).get("tab");
  if (currentTab) {
    const tabMatch = navTree.find((item) => {
      const qIdx = item.url.indexOf("?tab=");
      if (qIdx === -1) return false;
      const itemPath = item.url.slice(0, qIdx);
      const itemTab = item.url.slice(qIdx + 5);
      return pathname === itemPath && currentTab === itemTab;
    });
    if (tabMatch) return tabMatch.title;
  }

  // Fall back to path-only matching (longest match wins)
  const navMatch = [...navTree]
    .sort((a, b) => b.url.length - a.url.length)
    .find((item) => {
      const itemPath = item.url.split("?")[0];
      return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
    });

  if (!navMatch) return "Home";
  return navMatch.title === "Info" ? "Library" : navMatch.title;
}

function PageTitle({ title, customContent }: { title: string; customContent?: ReactNode }) {
  if (customContent) {
    return (
      <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" data-testid="top-bar-page-title" title={title}>
        {customContent}
      </div>
    );
  }
  return (
    <div
      className="min-w-0 truncate text-sm font-medium text-foreground"
      data-testid="top-bar-page-title"
      title={title}
    >
      {title}
    </div>
  );
}


export function TopBar() {
  const [location] = useLocation();
  const isMobile = useIsMobile();
  const previewOwnsAgentIcon = location.startsWith("/interface-preview");
  const pageTitle = getPageTitle(location.split("?")[0] || "/");
  const { config: pageHeaderConfig } = usePageHeaderContext();
  const { route, widgetOpen, setWidgetOpen, clearSessionForRoute, requestSessionMenuReset, mobileSessionTitle } = useFocusSession();
  const configuredTitle = pageHeaderConfig?.title || pageTitle;
  const displayTitle = isMobile && mobileSessionTitle ? mobileSessionTitle : configuredTitle;
  const { setOpenMobile } = useSidebar();
  const { hasStreaming } = useSessionActivityState();

  // The mobile top-bar converse button is an entrypoint to the Session Menu,
  // not a shortcut back into the last focused conversation. Clear the global
  // focus before opening so route changes cannot resurrect a stale session.
  const openWidget = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
      clearSessionForRoute(route);
      requestSessionMenuReset();
    }
    setWidgetOpen(true);
  }, [isMobile, setOpenMobile, clearSessionForRoute, requestSessionMenuReset, route, setWidgetOpen]);

  const converseButton = (
    <button
      type="button"
      onClick={openWidget}
      className={cn(
        "shrink-0 flex items-center justify-center h-7 w-7 rounded-md border transition-colors",
        hasStreaming
          ? "text-active border-active/30 animate-pulse"
          : "border-border text-muted-foreground hover:bg-muted/50",
      )}
      aria-label="Open sessions"
      data-testid="button-top-bar-converse"
    >
      <MessageSquare className="h-4 w-4" />
    </button>
  );

  // Desktop: normal bar above the main section only (not above the chat
  // window or session menu — it's already inside the main content column).
  if (!isMobile) {
    return (
      <div
        className="shrink-0 flex items-center gap-3 px-1.5 bg-background"
        style={{ height: 42 }}
        data-testid="top-bar"
      >
        {!previewOwnsAgentIcon && <XyzIconButton />}
        <PageTitle title={displayTitle} customContent={pageHeaderConfig?.customContent} />
        <div className="flex-1" />
        <VaultToggles />
        <div className="flex-1" />
      </div>
    );
  }

  // Mobile: full bar with Agent icon + converse toggle.
  // Hidden when the focus widget is open (its own header takes over).
  return (
    <div
      className={cn(
        "shrink-0 flex items-center gap-3 px-1.5 sticky top-0 z-50 bg-background",
        widgetOpen && "hidden",
      )}
      style={{ height: 42 }}
      data-testid="top-bar"
    >
      {!previewOwnsAgentIcon && <XyzIconButton />}
      <PageTitle title={displayTitle} customContent={pageHeaderConfig?.customContent} />
      <div className="flex-1" />
      <ConnectionsIndicator />
      {converseButton}
    </div>
  );
}
