import {
  useSidebar,
} from "@/components/ui/sidebar";
import { useCallback, useMemo, useState } from "react";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  BookOpen,
  Boxes,
  Briefcase,
  BrainCircuit,
  Calendar,
  ChevronDown,
  ChevronRight,
  Compass,
  DatabaseZap,
  Globe,
  Hammer,
  Newspaper,
  Heart,
  Home,
  Lightbulb,
  Mail,
  Monitor,
  Palette,
  Plug,
  Swords,
  Target,
  Workflow,
  Users,
} from "lucide-react";
import { useLocation } from "wouter";
import { useExecutorStatus } from "@/hooks/use-executor-status";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { useWorkActivity } from "./thought-indicator";
import { useGoalsActivity } from "./goals-activity-indicator";
import { useSystemActivity } from "./system-alert-indicator";
import { useWellnessAlerts } from "@/hooks/use-wellness-alerts";
import { useCommsActivity } from "@/hooks/use-comms-activity";
import { usePeopleActivity } from "@/hooks/use-people-activity";
import { useOrientationActivity } from "@/hooks/use-orientation-activity";
import { useEnvActivity } from "@/hooks/use-env-activity";
import { ActiveStatusSpinner, getStatusClasses, type NavDotLevel } from "./nav-dot";
import { MantraLogo } from "@/components/mantra-logo";

interface NavChild {
  title: string;
  tab: string;
}

interface NavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  children?: NavChild[];
}

export const navTree: NavItem[] = [
  { title: "Home", url: "/home", icon: Home },
  { title: "Goals", url: "/goals", icon: Target },
  { title: "Vision", url: "/vision", icon: Palette },
  { title: "Wellness", url: "/wellness", icon: Heart },
  { title: "Email", url: "/email", icon: Mail },
  { title: "News", url: "/news", icon: Newspaper },
  { title: "Library", url: "/library", icon: BookOpen },
  { title: "People", url: "/people", icon: Users },
  { title: "Orientation", url: "/orientation", icon: Globe },
  { title: "Schedule", url: "/schedule", icon: Calendar },
  { title: "Profile", url: "/profile", icon: Compass },
  { title: "Pipelines", url: "/pipelines", icon: Target },
  { title: "Workflows", url: "/workflows", icon: Workflow },
  { title: "Projects", url: "/projects", icon: Briefcase },
  { title: "Strategy", url: "/strategy", icon: Swords, children: [
    { title: "Decisions", tab: "decisions" },
    { title: "Strategies", tab: "strategies" },
  ]},
  { title: "Platforms", url: "/platforms", icon: Boxes },
  { title: "Skills", url: "/skills", icon: Lightbulb },
  { title: "Brain", url: "/brain", icon: BrainCircuit, children: [
    { title: "Observations", tab: "thoughts" },
    { title: "Context", tab: "context" },
    { title: "Emotion", tab: "emotion" },
    { title: "Persona", tab: "persona" },
    { title: "Model", tab: "model" },
    { title: "Plans", tab: "plans" },
  ]},
  { title: "System", url: "/system", icon: Monitor, children: [
    { title: "Performance", tab: "resources" },
    { title: "Logs", tab: "logs" },
    { title: "Timers", tab: "timers" },
    { title: "Tools", tab: "tools" },
    { title: "Inference", tab: "inference" },
    { title: "Cost", tab: "cost" },
    { title: "Events", tab: "events" },
    { title: "Hooks", tab: "hooks" },
    { title: "Process", tab: "process" },
    { title: "Users", tab: "users" },
  ]},
  { title: "Memory", url: "/memory", icon: DatabaseZap, children: [
    { title: "Layers", tab: "layers" },
    { title: "Graph", tab: "graph" },
    { title: "Log", tab: "log" },
    { title: "Query", tab: "query" },
    { title: "Tags", tab: "tags" },
  ]},
  { title: "Build", url: "/build", icon: Hammer, children: [
    { title: "Database", tab: "database" },
    { title: "Migration", tab: "migration" },
    { title: "History", tab: "history" },
    { title: "Code", tab: "code" },
    { title: "Issues", tab: "issues" },
    { title: "Prompts", tab: "prompts" },
  ]},
  { title: "Design", url: "/design", icon: Palette },
  { title: "Integrations", url: "/integrations", icon: Plug },
];

// Legacy flat navItems export for any downstream consumers
export const navItems = navTree.map(({ title, url, icon }) => ({ title, url, icon }));

const statusRingColors: Record<string, string> = {
  running: "ring-cta/40",
  stopped: "ring-neutral/30",
  starting: "ring-warning/40",
  restarting: "ring-warning/40",
  error: "ring-error/40",
  not_installed: "ring-neutral/20",
};

function XyzIcon({ status, onClick }: { status: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-md border border-cta bg-transparent p-0 text-cta transition-colors hover:border-active hover:text-active cursor-pointer select-none overflow-visible",
        statusRingColors[status] && `ring-1 ${statusRingColors[status]}`
      )}
      style={{ width: 28, height: 28, marginLeft: 4 }}
      data-testid="button-sidebar-toggle"
    >
      <MantraLogo className="h-[23px] w-[23px] relative" data-testid="icon-xyz-logo" />
    </button>
  );
}

export function XyzIconButton() {
  const { data: gatewayStatus } = useExecutorStatus();
  const { toggleSidebar, openMobile } = useSidebar();
  const { setWidgetOpen } = useFocusSession();
  const isMobile = useIsMobile();
  const status = gatewayStatus?.status || "not_installed";

  const handleClick = useCallback(() => {
    // On mobile, opening the nav must dismiss the sessions overlay
    if (isMobile && !openMobile) {
      setWidgetOpen(false);
    }
    toggleSidebar();
  }, [isMobile, openMobile, setWidgetOpen, toggleSidebar]);

  return <XyzIcon status={status} onClick={handleClick} />;
}


/**
 * Full-page navigation view. Replaces the main content area when the sidebar
 * is open. Renders the hierarchical nav tree with expandable parent items.
 */
export function NavPage() {
  const [location, navigate] = useLocation();
  const { setOpen, setOpenMobile, isMobile } = useSidebar();
  const { hasPermission } = useAuth();

  // Activity indicators
  const workActive = useWorkActivity();
  const goalsActive = useGoalsActivity();
  const systemActive = useSystemActivity();
  const { needsAttention: wellnessNeedsAttention } = useWellnessAlerts();
  const commsActive = useCommsActivity();
  const peopleActive = usePeopleActivity();
  const worldActive = useOrientationActivity();
  const envActive = useEnvActivity();

  const statusMap: Record<string, NavDotLevel | null> = {
    Brain: workActive ? "active" : null,
    Goals: goalsActive ? "attention" : null,
    System: systemActive ? "error" : null,
    Wellness: wellnessNeedsAttention ? "attention" : null,
    Email: commsActive,
    People: peopleActive,
    News: worldActive,
    Build: envActive,
  };

  const permittedItems = useMemo(() => navTree.filter((item) => {
    if (item.title === "System") return hasPermission("system:read");
    if (item.title === "Build") return hasPermission("build:read");
    return true;
  }), [hasPermission]);

  // Auto-expand the current page's item
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const current = navTree.find(item => location.startsWith(item.url));
    return current?.children ? new Set([current.url]) : new Set();
  });

  const closeSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    else setOpen(false);
  }, [isMobile, setOpen, setOpenMobile]);

  const toggleExpand = useCallback((url: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const handleNav = useCallback((url: string, tab?: string) => {
    const path = tab ? `${url}?tab=${tab}` : url;
    navigate(path);
    closeSidebar();
  }, [navigate, closeSidebar]);

  return (
    <div className="flex-1 overflow-y-auto bg-background scrollbar-thin" data-testid="nav-page">
      <nav className="p-3 space-y-0.5">
        {permittedItems.map((item) => {
          const isActive = location.startsWith(item.url);
          const level = statusMap[item.title] ?? null;
          const sc = getStatusClasses(level);
          const isExpanded = expanded.has(item.url);
          const hasChildren = !!item.children?.length;

          return (
            <div key={item.url}>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => {
                    if (hasChildren) {
                      toggleExpand(item.url);
                    } else {
                      handleNav(item.url);
                    }
                  }}
                  className={cn(
                    "flex items-center gap-2 flex-1 rounded-md px-2 py-1.5 text-sm transition-colors",
                    isActive
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                  data-testid={`link-nav-${item.title.toLowerCase()}`}
                >
                  {level === "active" ? (
                    <ActiveStatusSpinner className="h-4 w-4" />
                  ) : (
                    <item.icon className={cn("h-4 w-4 shrink-0", level ? sc.icon : "")} />
                  )}
                  <span className={cn("flex-1 text-left", level ? sc.text : "", level === "active" && "animate-pulse")}>
                    {item.title}
                  </span>
                  {hasChildren && (
                    isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                </button>
              </div>
              {hasChildren && isExpanded && (
                <div className="ml-6 mt-0.5 space-y-0.5 border-l border-border/50 pl-2">
                  {item.children!.map((child) => {
                    const childActive = isActive && new URLSearchParams(window.location.search).get("tab") === child.tab;
                    return (
                      <button
                        key={child.tab}
                        type="button"
                        onClick={() => handleNav(item.url, child.tab)}
                        className={cn(
                          "block w-full text-left rounded-md px-2 py-1 text-xs transition-colors",
                          childActive
                            ? "bg-muted/80 text-foreground font-medium"
                            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                        )}
                        data-testid={`link-nav-${item.title.toLowerCase()}-${child.tab}`}
                      >
                        {child.title}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-3 mt-4 border-t border-border/30">
        <UserFooter />
      </div>
    </div>
  );
}

function UserFooter() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { setOpen, setOpenMobile, isMobile } = useSidebar();

  if (!user) return null;

  return (
    <button
      type="button"
      onClick={() => {
        setLocation("/account");
        if (isMobile) setOpenMobile(false);
        else setOpen(false);
      }}
      className="flex items-center justify-between gap-2 w-full rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors"
      data-testid="button-user-menu"
    >
      <span className="text-xs text-muted-foreground truncate" data-testid="text-current-user">
        {user.email}
      </span>
      <ChevronRight className="h-3 w-3 text-muted-foreground/40 shrink-0" />
    </button>
  );
}
