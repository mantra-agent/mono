import {
  useSidebar,
} from "@/components/ui/sidebar";
import { useCallback, useMemo, useState } from "react";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Activity,
  BookOpen,
  Boxes,
  Brain,
  Briefcase,
  BrainCircuit,
  Calendar,
  ChevronRight,
  Clock,
  DatabaseZap,
  DollarSign,
  FileText,
  Gauge,
  GitBranch,
  Globe,
  Hammer,
  Heart,
  Home,
  Lightbulb,
  Mail,
  Megaphone,
  Newspaper,
  Palette,
  Plug,
  Scale,
  ScrollText,
  Search,
  Settings,
  Share2,
  SlidersHorizontal,
  Swords,
  Target,
  Terminal,
  User,
  Users,
  Vault,
  Workflow,
  Wrench,
  X,
  Zap,
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
import { useOrientationActivity } from "@/hooks/use-orientation-activity";
import { useEnvActivity } from "@/hooks/use-env-activity";
import { ActiveStatusSpinner, getStatusClasses, type NavDotLevel } from "./nav-dot";
import { MantraLogo } from "@/components/mantra-logo";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface NavItem {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string;
}

interface NavSection {
  label: string;
  defaultOpen: boolean;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    label: "Tools",
    defaultOpen: true,
    items: [
      { title: "Home", url: "/home", icon: Home },
      { title: "News", url: "/news", icon: Newspaper },
      { title: "Email", url: "/email", icon: Mail },
      { title: "Library", url: "/library", icon: BookOpen },
      { title: "People", url: "/people", icon: Users },
      { title: "Schedule", url: "/schedule", icon: Calendar },
      { title: "Projects", url: "/projects", icon: Briefcase },
      { title: "Pipelines", url: "/pipelines", icon: Target },
      { title: "Wellness", url: "/wellness", icon: Activity },
    ],
  },
  {
    label: "Planning",
    defaultOpen: false,
    items: [
      { title: "Goals", url: "/goals", icon: Target },
      { title: "Decisions", url: "/decisions", icon: Scale },
      { title: "Strategy", url: "/strategy", icon: Swords },
    ],
  },
  {
    label: "Automation",
    defaultOpen: false,
    items: [
      { title: "Skills", url: "/skills", icon: Lightbulb, permission: "system:read" },
      { title: "Plans", url: "/brain?tab=plans", icon: FileText },
      { title: "Workflows", url: "/workflows", icon: Workflow },
      { title: "Hooks", url: "/system?tab=hooks", icon: GitBranch, permission: "system:read" },
      { title: "Timers", url: "/system?tab=timers", icon: Clock, permission: "system:read" },
    ],
  },
  {
    label: "Agent",
    defaultOpen: false,
    items: [
      { title: "Orientation", url: "/orientation", icon: Globe },
      { title: "Persona", url: "/brain?tab=persona", icon: User },
      { title: "Emotion", url: "/brain?tab=emotion", icon: Heart },
    ],
  },
  {
    label: "Memory",
    defaultOpen: false,
    items: [
      { title: "Layers", url: "/memory?tab=memories", icon: DatabaseZap },
      { title: "Graph", url: "/memory?tab=graph", icon: Share2 },
      { title: "Journal", url: "/memory?tab=maintenance", icon: ScrollText },
    ],
  },
  {
    label: "Build",
    defaultOpen: false,
    items: [
      { title: "Platforms", url: "/platforms", icon: Boxes, permission: "build:read" },
      { title: "Design", url: "/design", icon: Palette, permission: "build:read" },
      { title: "Database", url: "/database", icon: DatabaseZap, permission: "build:read" },
      { title: "Code", url: "/build?tab=code", icon: Terminal, permission: "build:read" },
      { title: "Issues", url: "/build?tab=issues", icon: Hammer, permission: "build:read" },
    ],
  },
  {
    label: "System",
    defaultOpen: false,
    items: [
      { title: "Performance", url: "/system?tab=resources", icon: Gauge, permission: "system:read" },
      { title: "Logs", url: "/system?tab=logs", icon: ScrollText, permission: "system:read" },
      { title: "Events", url: "/system?tab=events", icon: Zap, permission: "system:read" },
      { title: "Tools", url: "/system?tab=tools", icon: Wrench, permission: "system:read" },
      { title: "Prompts", url: "/build?tab=prompts", icon: FileText, permission: "build:read" },
      { title: "Context", url: "/brain?tab=context", icon: BrainCircuit },
      { title: "Router", url: "/system?tab=inference", icon: Brain, permission: "system:read" },
      { title: "Models", url: "/brain?tab=model", icon: SlidersHorizontal },
      { title: "Cost", url: "/system?tab=cost", icon: DollarSign, permission: "system:read" },
    ],
  },
  {
    label: "Admin",
    defaultOpen: false,
    items: [
      { title: "Audiences", url: "/audiences", icon: Users, permission: "system:read" },
      { title: "Campaigns", url: "/campaigns", icon: Megaphone, permission: "system:read" },
      { title: "Users", url: "/system?tab=users", icon: Users, permission: "system:read" },
      { title: "Vaults", url: "/system?tab=vaults", icon: Vault },
      { title: "Integrations", url: "/integrations", icon: Plug },
      { title: "Account", url: "/account", icon: Settings },
    ],
  },
];

// Build a flat navTree for legacy consumers
export const navTree = navSections.flatMap((section) =>
  section.items.map(({ title, url, icon }) => ({ title, url, icon }))
);

// Legacy flat navItems export
export const navItems = navTree;

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
    if (isMobile && !openMobile) {
      setWidgetOpen(false);
    }
    toggleSidebar();
  }, [isMobile, openMobile, setWidgetOpen, toggleSidebar]);

  return <XyzIcon status={status} onClick={handleClick} />;
}

const STORAGE_KEY = "nav-sections-collapsed";

function loadCollapsedState(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function saveCollapsedState(collapsed: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch { /* ignore */ }
}

/** Parse a nav item URL into a path and optional tab param */
function parseNavUrl(url: string): { path: string; tab?: string } {
  const idx = url.indexOf("?tab=");
  if (idx === -1) return { path: url };
  return { path: url.slice(0, idx), tab: url.slice(idx + 5) };
}

/** Check if a nav item is active given the current location */
function isItemActive(itemUrl: string, location: string): boolean {
  const { path, tab } = parseNavUrl(itemUrl);
  if (!location.startsWith(path)) return false;
  if (!tab) return true;
  const params = new URLSearchParams(window.location.search);
  return params.get("tab") === tab;
}

/**
 * Full-page navigation view. Replaces the main content area when the sidebar
 * is open. Renders nav items under collapsible section headers.
 */
export function NavPage() {
  const [location, navigate] = useLocation();
  const { closeSidebar } = useSidebar();
  const { hasPermission } = useAuth();
  const [searchQuery, setSearchQuery] = useState("");

  // Activity indicators
  const workActive = useWorkActivity();
  const goalsActive = useGoalsActivity();
  const systemActive = useSystemActivity();
  const { needsAttention: wellnessNeedsAttention } = useWellnessAlerts();
  const commsActive = useCommsActivity();
  const worldActive = useOrientationActivity();
  const envActive = useEnvActivity();

  const statusMap: Record<string, NavDotLevel | null> = {
    Brain: workActive ? "active" : null,
    Goals: goalsActive ? "attention" : null,
    System: systemActive ? "error" : null,
    Wellness: wellnessNeedsAttention ? "attention" : null,
    Email: commsActive,
    News: worldActive,
    Build: envActive,
  };

  // Collapsed state: sections that are explicitly collapsed by the user.
  // Default: everything collapsed except sections with defaultOpen: true.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const stored = loadCollapsedState();
    if (stored.size > 0) return stored;
    // Initial state: collapse everything except defaultOpen sections
    return new Set(
      navSections.filter((s) => !s.defaultOpen).map((s) => s.label)
    );
  });

  const toggleSection = useCallback((label: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      saveCollapsedState(next);
      return next;
    });
  }, []);

  const handleNav = useCallback(
    (url: string) => {
      navigate(url);
      closeSidebar();
    },
    [navigate, closeSidebar]
  );

  // Filter sections and items by permission and search query
  const filteredSections = useMemo(() => {
    const queryTokens = searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    return navSections
      .map((section) => {
        const items = section.items.filter((item) => {
          // Permission check
          if (item.permission && !hasPermission(item.permission)) return false;
          // Search filter
          if (queryTokens.length === 0) return true;
          const haystack = `${item.title} ${section.label}`.toLowerCase();
          return queryTokens.every((t) => haystack.includes(t));
        });
        return { ...section, items };
      })
      .filter((section) => section.items.length > 0);
  }, [hasPermission, searchQuery]);

  // When searching, expand all sections
  const isSearching = searchQuery.trim().length > 0;

  return (
    <div
      className="flex-1 overflow-y-auto bg-background scrollbar-thin"
      data-testid="nav-page"
    >
      <div className="p-2 space-y-1">
        {/* Search bar */}
        <div className="relative min-w-0 mb-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder=""
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-7 pl-7 pr-7 rounded-md border border-input bg-background text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid="input-search-nav"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
              data-testid="button-clear-nav-search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Nav sections */}
        {filteredSections.length === 0 && searchQuery.trim() ? (
          <div className="py-8 text-center">
            <Search className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">
              No pages match &quot;{searchQuery.trim()}&quot;
            </p>
          </div>
        ) : (
          filteredSections.map((section) => {
            const isOpen = isSearching || !collapsed.has(section.label);

            return (
              <Collapsible
                key={section.label}
                open={isOpen}
                onOpenChange={() => {
                  if (!isSearching) toggleSection(section.label);
                }}
              >
                <CollapsibleTrigger
                  className="flex items-center gap-1.5 w-full px-2 py-1.5 text-xs font-bold text-muted-foreground uppercase tracking-wider hover-elevate rounded-md"
                  data-testid={`button-nav-section-${section.label.toLowerCase()}`}
                >
                  <ChevronRight
                    className={`h-3 w-3 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
                  />
                  {section.label}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-0.5 ml-[11px]">
                    {section.items.map((item, idx) => {
                      const active = isItemActive(item.url, location);
                      const level = statusMap[item.title] ?? null;
                      const sc = getStatusClasses(level);
                      const isLast = idx === section.items.length - 1;

                      return (
                        <div key={item.url} className="flex items-stretch min-w-0">
                          {/* L connector gutter */}
                          <div className="shrink-0 w-5 self-stretch relative mr-1" aria-hidden="true">
                            <div className={cn("absolute left-1/2 top-0 -translate-x-px border-l border-border", isLast ? "bottom-1/2" : "bottom-0")} />
                            <div className="absolute left-1/2 top-1/2 right-0 border-t border-border" />
                          </div>
                          {/* Nav item */}
                          <button
                            type="button"
                            onClick={() => handleNav(item.url)}
                            className={cn(
                              "flex items-center gap-2 flex-1 min-w-0 rounded-md px-2 py-1.5 text-sm transition-colors",
                              active
                                ? "bg-muted font-medium text-foreground"
                                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                            )}
                            data-testid={`link-nav-${item.title.toLowerCase().replace(/\s+/g, "-")}`}
                          >
                            {level === "active" ? (
                              <ActiveStatusSpinner className="h-4 w-4" />
                            ) : (
                              <item.icon
                                className={cn(
                                  "h-4 w-4 shrink-0",
                                  level ? sc.icon : ""
                                )}
                              />
                            )}
                            <span
                              className={cn(
                                "flex-1 text-left truncate",
                                level ? sc.text : "",
                                level === "active" && "animate-pulse"
                              )}
                            >
                              {item.title}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })
        )}
      </div>


    </div>
  );
}

