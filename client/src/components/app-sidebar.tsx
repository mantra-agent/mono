import {
  useSidebar,
} from "@/components/ui/sidebar";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefCallback,
} from "react";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useSessionActivity } from "@/hooks/use-session-activity";
import { usePageActivity } from "@/hooks/use-page-activity";
import { useIsMobile } from "@/hooks/use-mobile";
import { useVoiceSessionOptional } from "@/hooks/use-voice-session";
import { useNativeMeetingTranscription } from "@/hooks/use-native-meeting-transcription";
import {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Briefcase,
  Building2,
  FolderOpen,
  HardDrive,
  BrainCircuit,
  Calendar,
  ClipboardList,
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
  LineChart,
  KeyRound,
  Mail,
  Megaphone,
  MessagesSquare,
  Newspaper,
  Palette,
  Plus,
  Plug,
  Route,
  Scale,
  ScrollText,
  Search,
  Settings,
  Share2,
  SlidersHorizontal,
  Swords,
  Tags,
  Target,
  User,
  UserPlus,
  Users,
  Vault,
  Waypoints,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useLocation } from "wouter";
import { useExecutorStatus } from "@/hooks/use-executor-status";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { useWorkActivity } from "./thought-indicator";
import { useSystemActivity } from "./system-alert-indicator";
import { useCommsActivity } from "@/hooks/use-comms-activity";
import { useEnvActivity } from "@/hooks/use-env-activity";
import { useProductComposition } from "@/hooks/use-product-composition";
import { openIssueCaptureDialog } from "@/components/issue-capture";
import { HIERARCHY_PRIMARY_ACTION_CLASS } from "@/components/hierarchy-section-header";
import { ActiveStatusSpinner, getStatusClasses, type NavDotLevel } from "./nav-dot";
import { AgentOrb } from "@/components/agent-orb";
import { VoiceEntranceOrb } from "@/components/voice-entrance-orb";
import type { AgentVisualState } from "@shared/agent-visualizer";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useUiInteraction, useUiInteractionTarget } from "@/hooks/use-ui-interaction";
import {
  getUiInteractionTargetHref,
  getUiInteractionTargetPermission,
  getUiInteractionTargetDescription,
  type UiInteractionTarget,
} from "@shared/ui-interaction";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ResolvedProductComposition } from "@shared/models/product-composition";

interface NavItem {
  title: string;
  target: UiInteractionTarget;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string;
  titleTone?: "default" | "muted";
  description?: string;
}

function navItem(
  title: string,
  target: UiInteractionTarget,
  icon: NavItem["icon"],
  titleTone?: NavItem["titleTone"],
): NavItem {
  return {
    title,
    target,
    url: getUiInteractionTargetHref(target),
    icon,
    permission: getUiInteractionTargetPermission(target),
    description: getUiInteractionTargetDescription(target),
    ...(titleTone ? { titleTone } : {}),
  };
}

interface NavSection {
  label: string;
  defaultOpen: boolean;
  items: NavItem[];
}

const MOD_NAV_ICONS = {
  Activity,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Briefcase,
  Building2,
  BrainCircuit,
  Calendar,
  ClipboardList,
  Clock,
  DatabaseZap,
  DollarSign,
  FileText,
  Gauge,
  GitBranch,
  Globe,
  HardDrive,
  Hammer,
  Heart,
  Home,
  Lightbulb,
  LineChart,
  Mail,
  Megaphone,
  MessagesSquare,
  Newspaper,
  Palette,
  Plug,
  Scale,
  ScrollText,
  Share2,
  SlidersHorizontal,
  Swords,
  Tags,
  Target,
  User,
  UserPlus,
  Users,
  Vault,
  Waypoints,
  Wrench,
  Zap,
} satisfies Record<string, LucideIcon>;

function mergeResolvedNavigation(
  staticSections: NavSection[],
  composition: ResolvedProductComposition | undefined,
): NavSection[] {
  if (!composition) return staticSections.filter((section) => section.label !== "Build");

  const activeMods = new Set(composition.activeMods.map((mod) => mod.key));
  const sections = staticSections
    .filter((section) => section.label !== "Build" || activeMods.has("build"))
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        // Ownership derives from the full mod registry (composition.navOwnership),
        // so any static nav entry owned by an inactive mod is hidden — no
        // hand-maintained per-item map to drift out of sync with the registry.
        const ownerMod = composition.navOwnership?.[item.target];
        return !ownerMod || activeMods.has(ownerMod);
      }),
    }));
  const routeById = new Map(composition.routes.map((route) => [route.id, route]));

  for (const contribution of composition.navigation) {
    const route = routeById.get(contribution.routeId);
    const icon = MOD_NAV_ICONS[contribution.iconKey as keyof typeof MOD_NAV_ICONS];
    const target = contribution.target;
    if (!route || !icon) continue;

    let section = sections.find((candidate) => candidate.label === contribution.section);
    if (!section) {
      section = { label: contribution.section, defaultOpen: false, items: [] };
      sections.push(section);
    }
    // One target, one placement. A stale Mod section must not reinsert an existing item.
    if (sections.some((candidate) => candidate.items.some((item) => item.target === target))) continue;

    // Fail closed on unknown targets — empty href used to throw inside this useMemo.
    const url = getUiInteractionTargetHref(target);
    if (!url) continue;

    const lowerTargets = new Set(
      composition.navigation
        .filter((item) => item.section === contribution.section && item.order < contribution.order)
        .map((item) => item.target),
    );
    const insertionIndex = section.items.filter((item) => lowerTargets.has(item.target)).length;
    section.items.splice(insertionIndex, 0, {
      title: contribution.label,
      target,
      url,
      icon,
      permission: getUiInteractionTargetPermission(target),
      description: getUiInteractionTargetDescription(target),
    });
  }

  return sections;
}

const navSections: NavSection[] = [
  {
    label: "Tools",
    defaultOpen: true,
    items: [
      navItem("Home", "navigation.home.open", Home),
      navItem("Dashboard", "navigation.dashboard.open", Gauge),
      navItem("News", "navigation.news.open", Newspaper),
      navItem("Email", "navigation.email.open", Mail, "muted"),
      navItem("Library", "navigation.library.open", FolderOpen),
      navItem("Files", "navigation.files.open", HardDrive),
      navItem("Wellness", "navigation.wellness.open", Activity, "muted"),
      navItem("KPIs", "navigation.kpis.open", Gauge),
      navItem("Metrics", "navigation.metrics.open", Activity),
    ],
  },
  {
    label: "Network",
    defaultOpen: true,
    items: [
      navItem("People", "navigation.people.open", Users),
      navItem("Meetings", "navigation.meetings.open", MessagesSquare),
      navItem("Companies", "navigation.companies.open", Briefcase),
      navItem("Pipelines", "navigation.pipelines.open", Waypoints),
    ],
  },
  {
    label: "Planning",
    defaultOpen: false,
    items: [
      navItem("Projects", "navigation.projects.open", Briefcase),
      navItem("Schedule", "navigation.schedule.open", Calendar),
      navItem("Goals", "navigation.goals.open", Target, "muted"),
      navItem("Decisions", "navigation.decisions.open", Scale),
      navItem("Scenarios", "navigation.scenarios.open", Swords),
    ],
  },
  {
    label: "Business",
    defaultOpen: false,
    items: [
      navItem("Identity", "navigation.definition.open", FileText),
      navItem("Plan", "navigation.advantage.open", Target),
      navItem("Model", "navigation.businessModel.open", LineChart),
      navItem("Budgets", "navigation.budgets.open", DollarSign),
      navItem("Roles", "navigation.roles.open", Briefcase),
      navItem("Hiring", "navigation.hiring.open", UserPlus),
    ],
  },
  {
    label: "Automation",
    defaultOpen: false,
    items: [
      navItem("Agendas", "navigation.agendas.open", ClipboardList),
      navItem("Skills", "navigation.skills.open", Lightbulb),
      navItem("Plans", "navigation.plans.open", FileText),
      navItem("Hooks", "navigation.hooks.open", GitBranch),
      navItem("Timers", "navigation.timers.open", Clock),
    ],
  },
  {
    label: "Agent",
    defaultOpen: false,
    items: [
      navItem("Orientation", "navigation.orientation.open", Globe),
      navItem("Personas", "navigation.persona.open", User),
      navItem("Emotion", "navigation.emotion.open", Heart),
    ],
  },
  {
    label: "Memory",
    defaultOpen: false,
    items: [
      navItem("Layers", "navigation.memoryLayers.open", DatabaseZap),
      navItem("Graph", "navigation.memoryGraph.open", Share2),
      navItem("Journal", "navigation.memoryJournal.open", ScrollText),
      navItem("Tags", "navigation.tags.open", Tags),
    ],
  },
  {
    label: "Build",
    defaultOpen: false,
    items: [
      navItem("Platforms", "navigation.platforms.open", Boxes),
      navItem("Products", "navigation.products.open", Boxes),
      navItem("Design", "navigation.design.open", Palette),
      navItem("Issues", "navigation.issues.open", Hammer),
      navItem("Database", "navigation.database.open", DatabaseZap),
    ],
  },
  {
    label: "System",
    defaultOpen: false,
    items: [
      navItem("Logs", "navigation.logs.open", ScrollText),
      navItem("Events", "navigation.events.open", Zap),
      navItem("Tools", "navigation.tools.open", Wrench),
      navItem("Prompts", "navigation.prompts.open", FileText),
      navItem("Context", "navigation.context.open", BrainCircuit),
      navItem("Inference", "navigation.router.open", Brain),
      navItem("Models", "navigation.models.open", SlidersHorizontal),
      navItem("Routers", "navigation.routers.open", Route),
      navItem("Cost", "navigation.cost.open", DollarSign),
      navItem("Performance", "navigation.performance.open", Gauge),
    ],
  },
  {
    label: "Admin",
    defaultOpen: false,
    items: [
      navItem("Mods", "navigation.mods.open", Boxes),
      navItem("Audiences", "navigation.audiences.open", Users),
      navItem("Campaigns", "navigation.campaigns.open", Megaphone),
      navItem("Accounts", "navigation.accounts.open", Building2),
      navItem("Agents", "navigation.agents.open", Bot),
      navItem("Users", "navigation.users.open", Users),
      navItem("Vaults", "navigation.vaults.open", Vault),
      navItem("Teams", "navigation.teams.open", Users),
      navItem("Secrets", "navigation.secrets.open", KeyRound),
      navItem("Integrations", "navigation.integrations.open", Plug),
      navItem("Account", "navigation.account.open", Settings),
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
  stopped: "ring-neutral/30",
  starting: "ring-warning/40",
  restarting: "ring-warning/40",
  error: "ring-error/40",
  not_installed: "ring-neutral/20",
};

const TEXT_ACTIVITY_VISUAL_STATE = {
  none: "idle",
  streaming: "speaking",
  thinking: "thinking",
  tool: "tool_call",
} as const satisfies Record<ReturnType<typeof useSessionActivity>["visibleAssistantActivity"], AgentVisualState>;

/** Hold duration before the top-left orb opens Report Issue instead of toggling nav. */
const ORB_REPORT_HOLD_MS = 500;

/** Shared pointer-hold handlers for the always-visible top-left agent orb. */
function useOrbReportHold(onLongPress?: () => void) {
  const holdTimerRef = useRef<number | null>(null);
  const holdFiredRef = useRef(false);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearHoldTimer(), [clearHoldTimer]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !onLongPress) return;
      holdFiredRef.current = false;
      clearHoldTimer();
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        holdFiredRef.current = true;
        onLongPress();
      }, ORB_REPORT_HOLD_MS);
    },
    [clearHoldTimer, onLongPress],
  );

  const onContextMenu = useCallback(
    (event: { preventDefault: () => void }) => {
      // Long-press is the report-issue gesture; suppress the native menu on hold.
      if (onLongPress) event.preventDefault();
    },
    [onLongPress],
  );

  const consumeHoldClick = useCallback(() => {
    if (!holdFiredRef.current) return false;
    holdFiredRef.current = false;
    return true;
  }, []);

  return {
    onPointerDown,
    onPointerUp: clearHoldTimer,
    onPointerCancel: clearHoldTimer,
    onPointerLeave: clearHoldTimer,
    onContextMenu,
    consumeHoldClick,
  };
}

interface NavigationOrbProps {
  status: string;
  visualState: AgentVisualState;
  audioLevel: number;
  voiceSession: ReturnType<typeof useVoiceSessionOptional>;
  targetRef?: RefCallback<HTMLButtonElement>;
  onClick?: () => void;
  onLongPress?: () => void;
}

function NavigationOrb({
  status,
  visualState,
  audioLevel,
  voiceSession,
  targetRef,
  onClick,
  onLongPress,
}: NavigationOrbProps) {
  const orbProps = {
    state: visualState,
    audioLevel,
    maxFrameRate: 20,
    className: "pointer-events-none absolute inset-0",
  } as const;
  const hold = useOrbReportHold(onLongPress);

  return (
    <button
      ref={targetRef}
      type="button"
      onPointerDown={hold.onPointerDown}
      onPointerUp={hold.onPointerUp}
      onPointerCancel={hold.onPointerCancel}
      onPointerLeave={hold.onPointerLeave}
      onContextMenu={hold.onContextMenu}
      onClick={(e) => {
        e.stopPropagation();
        if (hold.consumeHoldClick()) {
          e.preventDefault();
          return;
        }
        onClick?.();
      }}
      className={cn(
        "relative ml-1 flex h-7 w-7 shrink-0 cursor-pointer select-none items-center justify-center overflow-hidden rounded-md border border-transparent bg-background p-0 transition-colors hover:border-active",
        statusRingColors[status] && `ring-1 ${statusRingColors[status]}`,
      )}
      aria-label="Open main navigation. Hold to report an issue."
      title="Hold to report an issue"
      data-testid="button-sidebar-toggle"
      data-voice-state={visualState}
    >
      {voiceSession ? (
        <VoiceEntranceOrb voiceSession={voiceSession} {...orbProps} />
      ) : (
        <AgentOrb {...orbProps} />
      )}
    </button>
  );
}

export function NavigationOrbButton() {
  const targetRef = useUiInteractionTarget("navigation.sidebar.toggle");
  const { data: gatewayStatus } = useExecutorStatus();
  const { toggleSidebar, openMobile } = useSidebar();
  const { setWidgetOpen } = useFocusSession();
  const sessionActivity = useSessionActivity();
  const { isPageActive } = usePageActivity();
  const voiceSession = useVoiceSessionOptional();
  const nativeTranscription = useNativeMeetingTranscription();
  const isMobile = useIsMobile();
  const status = gatewayStatus?.status || "not_installed";
  const voiceVisualActive = voiceSession?.status !== undefined && voiceSession.status !== "idle";
  const nativeVisualActive = nativeTranscription.activeSessionId !== null;
  const visualState = voiceVisualActive
    ? voiceSession.visualState
    : nativeVisualActive
      ? "listening"
      : TEXT_ACTIVITY_VISUAL_STATE[sessionActivity.visibleAssistantActivity];
  const readAudioLevel = voiceVisualActive
    ? voiceSession.readAudioLevel
    : nativeVisualActive
      ? nativeTranscription.readAudioLevel
      : null;
  const [audioLevel, setAudioLevel] = useState(0);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!readAudioLevel) {
      setAudioLevel(0);
      return;
    }

    let lastSampleAt = 0;
    const sample = (now: number) => {
      frameRef.current = requestAnimationFrame(sample);
      if (now - lastSampleAt < 1000 / 20) return;
      lastSampleAt = now;
      setAudioLevel(readAudioLevel());
    };
    frameRef.current = requestAnimationFrame(sample);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [readAudioLevel]);

  const handleClick = useCallback(() => {
    if (isMobile && !openMobile) {
      setWidgetOpen(false);
    }
    toggleSidebar();
  }, [isMobile, openMobile, setWidgetOpen, toggleSidebar]);

  const handleReportIssue = useCallback(() => {
    openIssueCaptureDialog();
  }, []);
  const hold = useOrbReportHold(handleReportIssue);

  if (isPageActive) {
    return (
      <button
        type="button"
        ref={targetRef}
        onPointerDown={hold.onPointerDown}
        onPointerUp={hold.onPointerUp}
        onPointerCancel={hold.onPointerCancel}
        onPointerLeave={hold.onPointerLeave}
        onContextMenu={hold.onContextMenu}
        onClick={(event) => {
          if (hold.consumeHoldClick()) {
            event.preventDefault();
            return;
          }
          handleClick();
        }}
        aria-label={
          openMobile
            ? "Close navigation. Hold to report an issue."
            : "Open navigation. Hold to report an issue."
        }
        title="Hold to report an issue"
        className="relative ml-1 flex h-7 w-7 shrink-0 cursor-pointer select-none items-center justify-center rounded-md text-active hover:bg-white/5"
        data-testid="nav-orb"
        data-page-active="true"
      >
        <ActiveStatusSpinner className="h-4 w-4" />
      </button>
    );
  }

  return (
    <NavigationOrb
      targetRef={targetRef}
      status={status}
      visualState={visualState}
      audioLevel={audioLevel}
      voiceSession={voiceVisualActive ? voiceSession : null}
      onClick={handleClick}
      onLongPress={handleReportIssue}
    />
  );
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

interface SemanticNavButtonProps {
  item: NavItem;
  onNavigate: (target: UiInteractionTarget) => void;
  className: string;
  children: React.ReactNode;
}

function SemanticNavButton({ item, onNavigate, className, children }: SemanticNavButtonProps) {
  const targetRef = useUiInteractionTarget(item.target);
  const button = (
    <button
      ref={targetRef}
      type="button"
      onClick={() => onNavigate(item.target)}
      className={className}
      data-testid={`link-nav-${item.title.toLowerCase().replace(/\s+/g, "-")}`}
    >
      {children}
    </button>
  );

  if (!item.description) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{item.description}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Full-page navigation view. Replaces the main content area when the sidebar
 * is open. Renders nav items under collapsible section headers.
 */
export function NavPage() {
  const [location] = useLocation();
  const { hasPermission } = useAuth();
  const { data: productComposition } = useProductComposition();
  const resolvedNavSections = useMemo(
    () => mergeResolvedNavigation(navSections, productComposition),
    [productComposition],
  );
  const { guidedTarget, invoke } = useUiInteraction();
  const [searchQuery, setSearchQuery] = useState("");

  // Activity indicators. Attention/unread/pinned must not enter this map:
  // those levels paint text-foreground and impersonate the selected route.
  const workActive = useWorkActivity();
  const systemActive = useSystemActivity();
  const commsActive = useCommsActivity();
  const envActive = useEnvActivity();

  const statusMap: Record<string, NavDotLevel | null> = {
    Brain: workActive ? "active" : null,
    System: systemActive ? "error" : null,
    Email: commsActive === "error" ? "error" : null,
    Build: envActive === "error" || envActive === "active" ? envActive : null,
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
    (target: UiInteractionTarget) => invoke(target),
    [invoke],
  );

  // Filter sections and items by permission and search query
  const filteredSections = useMemo(() => {
    const queryTokens = searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    return resolvedNavSections
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
  }, [hasPermission, resolvedNavSections, searchQuery]);

  // Guided targets own their discoverability while the command is active.
  const guidedSectionLabel = useMemo(() => {
    if (!guidedTarget) return null;
    return resolvedNavSections.find((section) =>
      section.items.some((item) => item.target === guidedTarget),
    )?.label ?? null;
  }, [guidedTarget, resolvedNavSections]);
  const isSearching = searchQuery.trim().length > 0;
  const canReportIssue = !isSearching;
  const visibleSections = useMemo(() => {
    if (!guidedTarget || !guidedSectionLabel) return filteredSections;
    const section = resolvedNavSections.find((candidate) => candidate.label === guidedSectionLabel);
    if (!section) return filteredSections;
    const items = section.items.filter((item) =>
      item.target === guidedTarget && (!item.permission || hasPermission(item.permission)),
    );
    return items.length > 0 ? [{ ...section, items }] : filteredSections;
  }, [filteredSections, guidedSectionLabel, guidedTarget, hasPermission, resolvedNavSections]);

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
    <div
      className="flex-1 overflow-y-auto bg-background scrollbar-thin"
      data-testid="nav-page"
    >
      <div className="p-2 space-y-1">
        <HierarchySearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          inputTestId="input-search-nav"
          clearTestId="button-clear-nav-search"
          ariaLabel="Search navigation"
        />

        {/* Nav sections */}
        {visibleSections.length === 0 && searchQuery.trim() ? (
          <div className="py-8 text-center">
            <Search className="h-8 w-8 text-muted-foreground/50 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">
              No pages match &quot;{searchQuery.trim()}&quot;
            </p>
          </div>
        ) : (
          visibleSections.map((section) => {
            const isOpen = isSearching || section.label === guidedSectionLabel || !collapsed.has(section.label);

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
                      // Selected owns white. Status may keep error/active hue, never attention-as-selected.
                      const statusPaints = level === "error" || level === "active" || level === "cta";
                      const isLast = idx === section.items.length - 1;

                      return (
                        <div key={item.url} className="flex items-stretch min-w-0">
                          {/* L connector gutter */}
                          <div className="shrink-0 w-5 self-stretch relative mr-1" aria-hidden="true">
                            <div className={cn("absolute left-1/2 top-0 -translate-x-px border-l border-border", isLast ? "bottom-1/2" : "bottom-0")} />
                            <div className="absolute left-1/2 top-1/2 right-0 border-t border-border" />
                          </div>
                          {/* Nav item */}
                          <SemanticNavButton
                            item={item}
                            onNavigate={handleNav}
                            className={cn(
                              "group flex items-center gap-2 flex-1 min-w-0 rounded-md px-2 py-1.5 text-sm transition-colors",
                              active
                                ? "bg-muted font-medium text-foreground"
                                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                            )}
                          >
                            {level === "active" ? (
                              <ActiveStatusSpinner className="h-4 w-4" />
                            ) : (
                              <item.icon
                                className={cn(
                                  "h-4 w-4 shrink-0",
                                  // Rest-only mute: child text color must not pin over parent hover/active.
                                  item.titleTone === "muted" && !active && !statusPaints
                                    ? "text-muted-foreground group-hover:text-foreground"
                                    : statusPaints
                                      ? sc.icon
                                      : "",
                                )}
                              />
                            )}
                            <span
                              className={cn(
                                "flex-1 text-left truncate",
                                item.titleTone === "muted" && !active && !statusPaints
                                  ? "text-muted-foreground group-hover:text-foreground"
                                  : statusPaints
                                    ? sc.text
                                    : "",
                                level === "active" && "animate-pulse"
                              )}
                            >
                              {item.title}
                            </span>
                          </SemanticNavButton>
                        </div>
                      );
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            );
          })
        )}

        {canReportIssue ? (
          <button
            type="button"
            onClick={openIssueCaptureDialog}
            className={cn(HIERARCHY_PRIMARY_ACTION_CLASS, "mt-2")}
            data-testid="button-report-issue"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>Report Issue</span>
          </button>
        ) : null}
      </div>


    </div>
    </TooltipProvider>
  );
}

