// Use createLogger for logging ONLY
import { createLogger, initializeDiagnosticLogging } from "@/lib/logger";
import { useState, useEffect, useCallback, Suspense, Component, type ErrorInfo, type ReactNode } from "react";
import { lazyWithRetry } from "@/lib/lazy-with-retry";
import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";
import { NavPage } from "@/components/app-sidebar";
import { useSidebar } from "@/components/ui/sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { useInterfaceMode } from "@/hooks/use-interface-mode";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { openIssueCaptureDialog } from "@/components/issue-capture";
import { BootGate } from "@/components/boot-gate";
import { PageHeaderProvider } from "@/hooks/use-page-header";
import { PageActivityProvider } from "@/hooks/use-page-activity";
import { VoiceSessionProvider } from "@/hooks/use-voice-session";
import { TopBar } from "@/components/top-bar";
import { VaultProvider } from "@/hooks/use-vaults";
import { useDataSync } from "@/hooks/use-data-sync";
import { useEventStreamTransport } from "@/hooks/use-event-stream";
import { ClientPresenceProvider } from "@/hooks/use-client-presence";
import { ExecutorStatusProvider } from "@/hooks/use-executor-status";
import { FocusSessionProvider, useFocusSession } from "@/hooks/use-focus-session";
import { SessionActivityProvider } from "@/hooks/use-session-activity";
import { NativeMeetingTranscriptionProvider } from "@/hooks/use-native-meeting-transcription";
import { FocusContextProvider } from "@/hooks/use-focus-context";
import { TaskModalProvider } from "@/contexts/task-modal-context";
import { FocusWidget } from "@/components/focus-widget";
import { BottomBar } from "@/components/bottom-bar";
import { AppToastDisplay } from "@/components/toast-display";
import { ExportProgressBanner } from "@/components/ExportProgressBanner";
import { TabParamSync } from "@/hooks/use-tab-param";
import { useIsMobile, ContainerWidthProvider } from "@/hooks/use-mobile";
import { useMobileViewportRestoration } from "@/hooks/use-mobile-viewport-restoration";
import NotFound from "@/pages/not-found";
import { AppShellImmersive } from "@/components/app-shell-immersive";
import { getProvisionalOnboardingToken } from "@/lib/immersive-entrance";
import { markNavigationDestinationCommit } from "@/lib/navigation-trace";
import { UiInteractionProvider } from "@/hooks/use-ui-interaction";
import { ClaimVisualHandoff } from "@/components/claim-visual-handoff";
import { PageFallback, RouteFailure, RouteLoadBoundary } from "@/components/route-load-boundary";
import { useProductComposition } from "@/hooks/use-product-composition";

const log = createLogger("App");

const SystemPage = lazyWithRetry(() => import("@/pages/system"));
const BrainPage = lazyWithRetry(() => import("@/pages/brain"));
const IntegrationsPage = lazyWithRetry(() => import("@/pages/integrations"));
const ModsPage = lazyWithRetry(() => import("@/pages/mods"));
const Goals = lazyWithRetry(() => import("@/pages/goals"));
const VisionPage = lazyWithRetry(() => import("@/pages/vision"));
const HomePage = lazyWithRetry(() => import("@/pages/home"));
const DashboardPage = lazyWithRetry(() => import("@/pages/dashboard"));
const SessionPage = lazyWithRetry(() => import("@/pages/session"));
const GoalDetailRedirect = lazyWithRetry(() => import("@/pages/goal-detail"));
const ProjectsPage = lazyWithRetry(() => import("@/pages/projects"));
const IssueDetailPage = lazyWithRetry(() => import("@/pages/issue-detail"));
const IssueCaptureDialog = lazyWithRetry(() => import("@/components/issue-capture").then(m => ({ default: m.IssueCaptureDialog })));
const LogsPage = lazyWithRetry(() => import("@/pages/logs"));
const AccountPage = lazyWithRetry(() => import("@/pages/account"));
const VaultsPage = lazyWithRetry(() => import("@/pages/vaults-admin"));
const TeamsPage = lazyWithRetry(() => import("@/pages/teams"));
const LoginPage = lazyWithRetry(() => import("@/pages/login"));
const RegisterPage = lazyWithRetry(() => import("@/pages/register"));
const RecipientRecapPage = lazyWithRetry(() => import("@/pages/recipient-recap"));
const WaitlistPage = lazyWithRetry(() => import("@/pages/waitlist"));
const BuildPage = lazyWithRetry(() => import("@/pages/build"));
const DatabasePage = lazyWithRetry(() => import("@/pages/build").then(m => ({ default: m.DatabasePage })));
const DesignPage = lazyWithRetry(() => import("@/pages/design"));
const PeoplePage = lazyWithRetry(() => import("@/pages/people"));
const MeetingsPage = lazyWithRetry(() => import("@/pages/meetings"));
const CompaniesPage = lazyWithRetry(() => import("@/pages/companies"));
const BusinessIdentityPage = lazyWithRetry(() => import("@/pages/business-identity"));
const BusinessModelPage = lazyWithRetry(() => import("@/pages/business-model"));
const BusinessBudgetsPage = lazyWithRetry(() => import("@/pages/business-budgets"));
const BusinessPlanPage = lazyWithRetry(() => import("@/pages/business-plan"));
const BusinessKpisPage = lazyWithRetry(() => import("@/pages/business-kpis"));
const BusinessMetricsPage = lazyWithRetry(() => import("@/pages/business-metrics"));
const PerformancePage = lazyWithRetry(() => import("@/pages/resources"));
const JobRolesPage = lazyWithRetry(() => import("@/pages/job-roles"));
const BusinessHiringPage = lazyWithRetry(() => import("@/pages/business-hiring"));
const EmailPage = lazyWithRetry(() => import("@/pages/email"));
const CalendarPage = lazyWithRetry(() => import("@/pages/calendar"));
const TimersPage = lazyWithRetry(() => import("@/pages/timers"));
const MemoryPageFull = lazyWithRetry(() => import("@/pages/memory-page"));
const ScenariosPage = lazyWithRetry(() => import("@/pages/scenarios"));
const TagsPage = lazyWithRetry(() => import("@/pages/tags"));
const DecisionsPage = lazyWithRetry(() => import("@/pages/decisions"));
const ScenarioDetailPage = lazyWithRetry(() => import("@/pages/scenario-detail"));

const OrientationPage = lazyWithRetry(() => import("@/pages/orientation"));
const NewsPage = lazyWithRetry(() => import("@/pages/news"));
const PlatformsPage = lazyWithRetry(() => import("@/pages/platforms"));
const ProductsPage = lazyWithRetry(() => import("@/pages/products"));
const FeaturesPage = lazyWithRetry(() => import("@/pages/features"));
const PlatformEnvironmentDetailPage = lazyWithRetry(() => import("@/pages/platform-environment-detail"));
const HabitsPage = lazyWithRetry(() => import("@/pages/habits"));
const ReflectionsPage = lazyWithRetry(() => import("@/pages/reflections"));
const GratitudePage = lazyWithRetry(() => import("@/pages/gratitude"));
const HealthPage = lazyWithRetry(() => import("@/pages/health"));
const LibraryPage = lazyWithRetry(() => import("@/pages/library/index"));
const FilesPage = lazyWithRetry(() => import("@/pages/files"));
const DocumentViewerPage = lazyWithRetry(() => import("@/pages/document-viewer"));
const FinancePage = lazyWithRetry(() => import("@/pages/finance"));
const CreatePage = lazyWithRetry(() => import("@/pages/create-page"));
const ProfilePage = lazyWithRetry(() => import("@/pages/profile"));
const PipelinesPage = lazyWithRetry(() => import("@/pages/pipelines"));
const SkillsPage = lazyWithRetry(() => import("@/pages/skills"));
const AgendasPage = lazyWithRetry(() => import("@/pages/agendas"));
const ZeroPage = lazyWithRetry(() => import("@/pages/zero"));
const GlassesStandalone = lazyWithRetry(() => import("@/pages/glasses-standalone"));
const InterfacePreviewPage = lazyWithRetry(() => import("@/pages/interface-preview"));
const AudiencesPage = lazyWithRetry(() => import("@/pages/audiences"));
const CampaignsPage = lazyWithRetry(() => import("@/pages/campaigns"));
const DevOrbPage = lazyWithRetry(() => import("@/pages/dev-orb"));

function serializeCaughtValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause ? serializeCaughtValue(value.cause) : undefined,
      ...Object.fromEntries(Object.entries(value)),
    };
  }

  if (value instanceof Event) {
    return {
      type: value.type,
      target: value.target instanceof Element ? value.target.tagName : null,
      currentTarget: value.currentTarget instanceof Element ? value.currentTarget.tagName : null,
      defaultPrevented: value.defaultPrevented,
    };
  }

  if (typeof value === "object" && value !== null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return { type: Object.prototype.toString.call(value), value: String(value) };
    }
  }

  return { type: typeof value, value: String(value) };
}

function normalizeAppError(value: unknown, fallbackMessage: string, fallbackCode: string): Error {
  if (value instanceof Error) {
    const errorWithCode = value as Error & { code?: string };
    if (!errorWithCode.code) errorWithCode.code = fallbackCode;
    return errorWithCode;
  }

  const error = new Error(
    typeof value === "string" && value.trim().length > 0 ? value : fallbackMessage,
    { cause: value },
  ) as Error & { code?: string };
  error.name = "AppRuntimeError";
  error.code = fallbackCode;
  return error;
}

function getRuntimeCrashContext() {
  return {
    route: window.location.pathname,
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    document: {
      title: document.title,
      visibilityState: document.visibilityState,
      readyState: document.readyState,
    },
    build: {
      mode: import.meta.env.MODE,
      dev: import.meta.env.DEV,
      prod: import.meta.env.PROD,
    },
  };
}

function createCrashId() {
  return `crash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // Pass the real Error instance so createLogger can classify/name/code/callsite.
    // serializeCaughtValue remains available for the structured diagnostic payload.
    log.error("App crash", error, {
      crashId: createCrashId(),
      error: serializeCaughtValue(error),
      componentStack: info.componentStack,
      context: getRuntimeCrashContext(),
    });
  }
  render() {
    if (this.state.hasError) {
      return (
        <RouteFailure
          label="Mantra couldn’t continue"
          detail="Reload to start a fresh application session."
        />
      );
    }
    return this.props.children;
  }
}

interface OnboardingStatus {
  completed: boolean;
  onboardingStatus: string;
}

function ForbiddenPage() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <h1 className="text-xl font-semibold text-foreground">Permission required</h1>
        <p className="mt-2 text-sm text-muted-foreground">This surface is restricted for your account.</p>
      </div>
    </div>
  );
}

function RequirePermission({ permission, children }: { permission: string; children: ReactNode }) {
  const { hasPermission } = useAuth();
  return hasPermission(permission) ? <>{children}</> : <ForbiddenPage />;
}

function RequireComposedRoute({ routeId, children }: { routeId: string; children: ReactNode }) {
  const { data: composition, isLoading, isError } = useProductComposition();
  if (isLoading) return <PageFallback label="Checking product access…" />;
  if (isError || !composition?.routes.some((route) => route.id === routeId)) return <ForbiddenPage />;
  return <>{children}</>;
}

function RequireBuild({ routeId, children }: { routeId: string; children: ReactNode }) {
  return (
    <RequireComposedRoute routeId={routeId}>
      <RequirePermission permission="build:read">{children}</RequirePermission>
    </RequireComposedRoute>
  );
}

function preserveCurrentQuery(targetPath: string): string {
  const params = new URLSearchParams(window.location.search);
  const query = params.toString();
  return `${targetPath}${query ? `?${query}` : ""}`;
}

/** Keep search + hash across path-only redirects (Library deep links live in the hash). */
function preserveCurrentLocation(targetPath: string): string {
  return `${preserveCurrentQuery(targetPath)}${window.location.hash || ""}`;
}

function sessionRedirectFromQuery(fallbackPath = "/home"): string {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("c") || params.get("key");
  if (!sessionId) return fallbackPath;

  const next = new URLSearchParams();
  next.set("c", sessionId);
  const autoVoice = params.get("autoVoice");
  if (autoVoice) next.set("autoVoice", autoVoice);
  return `/session?${next.toString()}`;
}

function RouteCommitObserver() {
  const [location] = useLocation();
  useEffect(() => {
    markNavigationDestinationCommit(location);
  }, [location]);
  return null;
}

function Router() {
  const [location] = useLocation();

  return (
    <RouteLoadBoundary routeKey={location}>
      <RouteCommitObserver />
      <Switch>
        <Route path="/"><Redirect to="/home" /></Route>
        <Route path="/brain" component={BrainPage} />
        <Route path="/agendas" component={AgendasPage} />
        <Route path="/skills" component={SkillsPage} />
        <Route path="/system">{() => <RequirePermission permission="system:read"><SystemPage /></RequirePermission>}</Route>
        <Route path="/performance">{() => <Redirect to="/system?tab=resources" />}</Route>
        <Route path="/logs">{() => <LogsPage />}</Route>
        <Route path="/goals/:id" component={GoalDetailRedirect} />
        <Route path="/dashboard">{() => <RequirePermission permission="system:read"><DashboardPage /></RequirePermission>}</Route>
        <Route path="/home" component={HomePage} />
        <Route path="/simple">{() => <Redirect to={sessionRedirectFromQuery()} />}</Route>
        <Route path="/session" component={SessionPage} />
        <Route path="/sessions">{() => <Redirect to={sessionRedirectFromQuery()} />}</Route>
        <Route path="/goals" component={Goals} />
        <Route path="/vision" component={VisionPage} />
        <Route path="/scenarios/:id" component={ScenarioDetailPage} />
        <Route path="/scenarios" component={ScenariosPage} />
        <Route path="/tags/:slug" component={TagsPage} />
        <Route path="/tags" component={TagsPage} />
        <Route path="/decisions" component={DecisionsPage} />
        <Route path="/schedule/:eventId" component={CalendarPage} />
        <Route path="/schedule" component={CalendarPage} />
        <Route path="/calendar/:eventId">{(params: { eventId?: string }) => <Redirect to={`/schedule/${params.eventId || ""}`} />}</Route>
        <Route path="/calendar">{() => <Redirect to="/schedule" />}</Route>
        <Route path="/social">{() => <Redirect to="/create" />}</Route>
        <Route path="/create" component={CreatePage} />
        <Route path="/projects" component={ProjectsPage} />
        <Route path="/work">{() => <Redirect to="/projects" />}</Route>
        <Route path="/platforms/environments/:id">{() => <RequireBuild routeId="build.route.platform-environment-detail"><PlatformEnvironmentDetailPage /></RequireBuild>}</Route>
        <Route path="/platforms">{() => <RequireBuild routeId="build.route.platforms"><PlatformsPage /></RequireBuild>}</Route>
        <Route path="/products">{() => <RequireBuild routeId="build.route.products"><ProductsPage /></RequireBuild>}</Route>
        <Route path="/build/features">{() => <RequireBuild routeId="build.route.features"><FeaturesPage /></RequireBuild>}</Route>
        <Route path="/memory" component={MemoryPageFull} />
        <Route path="/journal">{() => <Redirect to="/memory?tab=maintenance" />}</Route>
        <Route path="/build">{() => <RequireBuild routeId="build.route.build"><BuildPage /></RequireBuild>}</Route>
        <Route path="/database">{() => <RequireBuild routeId="build.route.database"><DatabasePage /></RequireBuild>}</Route>
        <Route path="/design">{() => <RequireBuild routeId="build.route.design"><DesignPage /></RequireBuild>}</Route>
        <Route path="/dev">{() => <Redirect to="/build" />}</Route>
        <Route path="/people/:id" component={PeoplePage} />
        <Route path="/people" component={PeoplePage} />
        <Route path="/meetings" component={MeetingsPage} />
        <Route path="/meeting-recap/:token">
          {(params: { token?: string }) => (
            <RecipientRecapPage token={params.token ?? ""} />
          )}
        </Route>
        <Route path="/companies/:id" component={CompaniesPage} />
        <Route path="/companies" component={CompaniesPage} />
        <Route path="/business/identity">{() => <RequirePermission permission="system:read"><BusinessIdentityPage /></RequirePermission>}</Route>
        <Route path="/business/definition">{() => <Redirect to="/business/identity" />}</Route>
        <Route path="/business/model">{() => <RequirePermission permission="system:read"><BusinessModelPage /></RequirePermission>}</Route>
        <Route path="/business/budgets">{() => <RequirePermission permission="system:read"><BusinessBudgetsPage /></RequirePermission>}</Route>
        <Route path="/business/plan" component={BusinessPlanPage} />
        <Route path="/business/advantage">{() => <Redirect to="/business/plan" />}</Route>
        <Route path="/business/roles">{() => <RequirePermission permission="system:read"><JobRolesPage /></RequirePermission>}</Route>
        <Route path="/business/hiring">{() => <RequirePermission permission="system:read"><BusinessHiringPage /></RequirePermission>}</Route>
        <Route path="/tools/kpis">{() => <RequirePermission permission="system:read"><BusinessKpisPage /></RequirePermission>}</Route>
        <Route path="/tools/metrics">{() => <RequirePermission permission="system:read"><BusinessMetricsPage /></RequirePermission>}</Route>
        <Route path="/tools/performance">{() => <RequirePermission permission="system:read"><PerformancePage /></RequirePermission>}</Route>
        <Route path="/business/kpis">{() => <RequirePermission permission="system:read"><BusinessKpisPage /></RequirePermission>}</Route>
        <Route path="/business/metrics">{() => <RequirePermission permission="system:read"><BusinessMetricsPage /></RequirePermission>}</Route>
        <Route path="/email" component={EmailPage} />
        <Route path="/comms">{() => <Redirect to="/email" />}</Route>
        <Route path="/orientation" component={OrientationPage} />
        <Route path="/world">{() => <Redirect to={`/orientation${window.location.search}`} />}</Route>
        <Route path="/news" component={NewsPage} />
        <Route path="/finance" component={FinancePage} />


        <Route path="/brain/timers" component={TimersPage} />
        <Route path="/timers" component={TimersPage} />
        <Route path="/responsibilities">{() => <Redirect to="/brain/timers" />}</Route>
        <Route path="/integrations/:provider" component={IntegrationsPage} />
        <Route path="/integrations" component={IntegrationsPage} />
        <Route path="/mods">{() => <RequirePermission permission="mods:read"><ModsPage /></RequirePermission>}</Route>
        <Route path="/settings">{() => <Redirect to="/integrations" />}</Route>
        <Route path="/issues/:id">{() => <RequireBuild routeId="build.route.issue-detail"><IssueDetailPage /></RequireBuild>}</Route>
        <Route path="/chat">{() => <Redirect to={preserveCurrentQuery("/session")} />}</Route>
        <Route path="/wellness">{() => <Redirect to={preserveCurrentLocation("/habits")} />}</Route>
        <Route path="/habits">{() => <RequireComposedRoute routeId="wellness.route.habits"><HabitsPage /></RequireComposedRoute>}</Route>
        <Route path="/reflections">{() => <RequireComposedRoute routeId="wellness.route.reflections"><ReflectionsPage /></RequireComposedRoute>}</Route>
        <Route path="/gratitude">{() => <RequireComposedRoute routeId="wellness.route.gratitude"><GratitudePage /></RequireComposedRoute>}</Route>
        <Route path="/health">{() => <RequireComposedRoute routeId="wellness.route.health"><HealthPage /></RequireComposedRoute>}</Route>
        <Route path="/profile" component={ProfilePage} />
        <Route path="/workflows/:id">{() => <Redirect to="/home" />}</Route>
        <Route path="/workflows">{() => <Redirect to="/home" />}</Route>
        <Route path="/pipelines">{() => <RequireComposedRoute routeId="network.route.pipelines"><PipelinesPage /></RequireComposedRoute>}</Route>
        <Route path="/zero" component={ZeroPage} />
        <Route path="/interface-preview" component={InterfacePreviewPage} />
        <Route path="/dev/orb">{() => <RequirePermission permission="system:read"><DevOrbPage /></RequirePermission>}</Route>
        <Route path="/library2">{() => <Redirect to={preserveCurrentLocation("/library")} />}</Route>
        <Route path="/library" component={LibraryPage} />
        <Route path="/info">{() => <Redirect to={preserveCurrentLocation("/library")} />}</Route>
        <Route path="/files" component={FilesPage} />
        <Route path="/documents/:id" component={DocumentViewerPage} />
        <Route path="/audiences">{() => <RequirePermission permission="system:read"><AudiencesPage /></RequirePermission>}</Route>
        <Route path="/campaigns">{() => <RequirePermission permission="system:read"><CampaignsPage /></RequirePermission>}</Route>
        <Route path="/account" component={AccountPage} />
        <Route path="/vaults" component={VaultsPage} />
        <Route path="/teams" component={TeamsPage} />
        <Route component={NotFound} />
      </Switch>
    </RouteLoadBoundary>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    return <PageFallback label="Checking your session…" />;
  }

  if (location === "/waitlist") {
    const query = window.location.search;
    window.history.replaceState(null, "", `/start${query}`);
    return (
      <RouteLoadBoundary routeKey="/start">
        <WaitlistPage />
      </RouteLoadBoundary>
    );
  }

  if (location === "/start") {
    return (
      <RouteLoadBoundary routeKey="/start">
        <WaitlistPage />
      </RouteLoadBoundary>
    );
  }

  if (location === "/login") {
    return (
      <RouteLoadBoundary routeKey="/login">
        <LoginPage />
      </RouteLoadBoundary>
    );
  }

  if (location === "/register" || location.startsWith("/register/")) {
    return (
      <RouteLoadBoundary routeKey={location}>
        <Switch>
          <Route path="/register" component={RegisterPage} />
          <Route path="/register/:token" component={RegisterPage} />
        </Switch>
      </RouteLoadBoundary>
    );
  }

  if (location.startsWith("/recap/")) {
    const token = location.slice("/recap/".length);
    window.location.replace(`/r/${encodeURIComponent(token)}`);
    return <PageFallback />;
  }

  if (location === "/glasses") {
    return (
      <RouteLoadBoundary routeKey="/glasses">
        <GlassesStandalone />
      </RouteLoadBoundary>
    );
  }

  if (!isAuthenticated) {
    return (
      <RouteLoadBoundary routeKey="/login">
        <LoginPage />
      </RouteLoadBoundary>
    );
  }

  return <>{children}</>;
}

function AppLayout({ mobileSurfaceActive, previewRouteOwnsCanvas }: { mobileSurfaceActive: boolean; previewRouteOwnsCanvas: boolean }) {
  const isMobile = useIsMobile();
  const { open, openMobile, isMobile: sidebarIsMobile } = useSidebar();
  const { widgetOpen } = useFocusSession();
  const navOpen = sidebarIsMobile ? openMobile : open;
  const mobileSessionSurfaceOpen = isMobile && widgetOpen;
  const mobileViewport = useMobileViewportRestoration(isMobile && !previewRouteOwnsCanvas);

  return (
    <>
      <div
        ref={mobileViewport.shellRef}
        className={cn("flex h-[100dvh] w-full overflow-hidden", mobileSurfaceActive && !previewRouteOwnsCanvas && "bg-background sm:items-start sm:justify-center sm:p-6")}
        style={mobileViewport.restoredHeight ? { height: `${mobileViewport.restoredHeight}px` } : undefined}
      >
        <div
          className={cn(
            "relative flex flex-col min-w-0 overflow-hidden flex-1",
            mobileSurfaceActive && !previewRouteOwnsCanvas && "sm:h-[740px] sm:min-h-[680px] sm:max-w-[390px] sm:rounded-[2rem] sm:border sm:border-black sm:bg-background sm:shadow-none",
          )}
        >
          {!previewRouteOwnsCanvas && !mobileSessionSurfaceOpen && <TopBar />}
          {!previewRouteOwnsCanvas && !mobileSessionSurfaceOpen && <ExportProgressBanner />}
          <div className="flex flex-1 min-h-0 w-full">
            {mobileSessionSurfaceOpen ? (
              <FocusWidget contained />
            ) : (
              <main className="@container relative flex-1 min-w-0 overflow-hidden">
                <ContainerWidthProvider>
                  <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden scrollbar-thin">
                    <Router />
                  </div>
                  {navOpen && (
                    <div className="absolute inset-0 z-40 flex min-h-0 bg-background" data-testid="nav-overlay">
                      <NavPage />
                    </div>
                  )}
                </ContainerWidthProvider>
              </main>
            )}
          </div>
          {/* Physical mobile uses one flex column for page/session content and the
              composer. Keeping the editable composer out of fixed positioning
              prevents WebKit keyboard dismissal from splitting visual and
              hit-test coordinates. Desktop mobile-preview behavior is unchanged. */}
          {!previewRouteOwnsCanvas && isMobile && (
            <BottomBar
              contained
              publishGlobalHeight
              onComposerFocusChange={mobileViewport.onComposerFocusChange}
            />
          )}
          {!previewRouteOwnsCanvas && !isMobile && mobileSurfaceActive && <div className="shrink-0" style={{ height: "var(--bottom-bar-height, 0px)" }} />}
          {!previewRouteOwnsCanvas && !isMobile && mobileSurfaceActive && <BottomBar />}
          {!isMobile && mobileSurfaceActive && !previewRouteOwnsCanvas && <FocusWidget contained />}
        </div>
        {!isMobile && !mobileSurfaceActive && !previewRouteOwnsCanvas && <FocusWidget />}
      </div>
      {previewRouteOwnsCanvas ? null : (
        <AppToastDisplay className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--bottom-bar-height,0px)+3rem)] z-[80]" />
      )}
      <TabParamSync />
      <Suspense fallback={null}><IssueCaptureDialog /></Suspense>
    </>
  );
}

function AppShell() {
  useEventStreamTransport();
  useDataSync();
  useEffect(() => {
    void initializeDiagnosticLogging();
  }, []);
  const [location] = useLocation();
  const [interfaceMode] = useInterfaceMode();

  const style = {
    "--sidebar-width": "11rem",
    "--sidebar-width-icon": "3rem",
  };
  const previewRouteOwnsCanvas = location.startsWith("/interface-preview");
  const mobileSurfaceActive = interfaceMode === "mobile_detail" || interfaceMode === "mobile_simple";

  return (
    <ClientPresenceProvider>
      <PageHeaderProvider>
        <VoiceSessionProvider>
          <ExecutorStatusProvider>
            <FocusSessionProvider>
              <SessionActivityProvider>
                <NativeMeetingTranscriptionProvider>
                  <FocusContextProvider>
                    <TaskModalProvider>
                      <SidebarProvider style={style as React.CSSProperties} forceMobile={mobileSurfaceActive} defaultOpen={false}>
                        <UiInteractionProvider>
                          <AppLayout mobileSurfaceActive={mobileSurfaceActive} previewRouteOwnsCanvas={previewRouteOwnsCanvas} />
                        </UiInteractionProvider>
                      </SidebarProvider>
                    </TaskModalProvider>
                  </FocusContextProvider>
                </NativeMeetingTranscriptionProvider>
              </SessionActivityProvider>
            </FocusSessionProvider>
          </ExecutorStatusProvider>
        </VoiceSessionProvider>
      </PageHeaderProvider>
    </ClientPresenceProvider>
  );
}

function prefetchRoutes() {
  const quiet = (p: Promise<unknown>) => p.catch(() => {});
  quiet(import("@/pages/integrations"));
  // Removed: chat page prefetch (focus widget is sole chat surface now)
  quiet(import("@/pages/goals"));
  quiet(import("@/pages/projects"));
  quiet(import("@/pages/issue-detail"));
  quiet(import("@/components/issue-capture").then(m => m.IssueCaptureDialog));
}

function App() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      const error = normalizeAppError(
        event.error,
        event.message || "Window emitted an error without an exception",
        "APP_WINDOW_ERROR",
      );
      log.error("Window error", error, {
        crashId: createCrashId(),
        operation: "window.error",
        route: window.location.pathname,
        source: {
          filename: event.filename || undefined,
          line: event.lineno || undefined,
          column: event.colno || undefined,
        },
        error: serializeCaughtValue(error),
        context: getRuntimeCrashContext(),
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const error = normalizeAppError(
        event.reason,
        "Promise rejected without an Error reason",
        "APP_UNHANDLED_REJECTION",
      );
      log.error("Unhandled promise rejection", error, {
        crashId: createCrashId(),
        operation: "window.unhandledrejection",
        route: window.location.pathname,
        error: serializeCaughtValue(error),
        context: getRuntimeCrashContext(),
      });
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    const hasRIC = typeof window !== "undefined" && "requestIdleCallback" in window;
    const id = hasRIC
      ? window.requestIdleCallback(() => prefetchRoutes())
      : window.setTimeout(prefetchRoutes, 3000);
    return () => {
      if (hasRIC) window.cancelIdleCallback(id as number);
      else window.clearTimeout(id as number);
    };
  }, []);

  // Captured once at mount: the provisional immersive-orb voice entrance
  // (`/visualizer?i=<token>`) renders the app shell in immersive-orb mode and
  // deliberately bypasses AuthGate/BootGate/VaultProvider — a provisional
  // visitor has no authenticated principal. The URL is stable for this step;
  // account claim hard-replaces this capability URL with the canonical Home
  // FTUE deep link, causing a clean mount of the authenticated shell.
  const [provisionalOnboardingToken] = useState(() => getProvisionalOnboardingToken());

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <ClaimVisualHandoff />
        <QueryClientProvider client={queryClient}>
          <PageActivityProvider>
            <TooltipProvider delayDuration={200} skipDelayDuration={0}>
              {provisionalOnboardingToken !== null ? (
                <AppShellImmersive onboardingToken={provisionalOnboardingToken} />
              ) : (
                <AuthGate>
                  <BootGate>
                    <VaultProvider>
                      <AppShell />
                    </VaultProvider>
                  </BootGate>
                </AuthGate>
              )}
            </TooltipProvider>
          </PageActivityProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
