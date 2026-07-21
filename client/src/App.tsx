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
import { Loader2 } from "lucide-react";
import { openIssueCaptureDialog } from "@/components/issue-capture";
import { BootGate } from "@/components/boot-gate";
import { PageHeaderProvider } from "@/hooks/use-page-header";
import { VoiceSessionProvider } from "@/hooks/use-voice-session";
import { MyelinationProvider } from "@/hooks/use-myelination";
import { TopBar } from "@/components/top-bar";
import { VaultProvider } from "@/hooks/use-vaults";
import { useDataSync } from "@/hooks/use-data-sync";
import { ClientPresenceProvider } from "@/hooks/use-client-presence";
import { ExecutorStatusProvider } from "@/hooks/use-executor-status";
import { FocusSessionProvider, useFocusSession } from "@/hooks/use-focus-session";
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

const log = createLogger("App");

const SystemPage = lazyWithRetry(() => import("@/pages/system"));
const BrainPage = lazyWithRetry(() => import("@/pages/brain"));
const IntegrationsPage = lazyWithRetry(() => import("@/pages/integrations"));
const Goals = lazyWithRetry(() => import("@/pages/goals"));
const VisionPage = lazyWithRetry(() => import("@/pages/goals-future"));
const HomePage = lazyWithRetry(() => import("@/pages/simple"));
const DashboardPage = lazyWithRetry(() => import("@/pages/dashboard"));
const SessionPage = lazyWithRetry(() => import("@/pages/session"));
const GoalDetail = lazyWithRetry(() => import("@/pages/goal-detail"));
const ProjectsPage = lazyWithRetry(() => import("@/pages/work"));
const IssueDetailPage = lazyWithRetry(() => import("@/pages/issue-detail"));
const IssueCaptureDialog = lazyWithRetry(() => import("@/components/issue-capture").then(m => ({ default: m.IssueCaptureDialog })));
const LogsPage = lazyWithRetry(() => import("@/pages/logs"));
const UserDetailsPage = lazyWithRetry(() => import("@/pages/user-details"));
const LoginPage = lazyWithRetry(() => import("@/pages/login"));
const RegisterPage = lazyWithRetry(() => import("@/pages/register"));
const WaitlistPage = lazyWithRetry(() => import("@/pages/waitlist"));
const BuildPage = lazyWithRetry(() => import("@/pages/build"));
const DatabasePage = lazyWithRetry(() => import("@/pages/build").then(m => ({ default: m.DatabasePage })));
const DesignPage = lazyWithRetry(() => import("@/pages/design"));
const PeoplePage = lazyWithRetry(() => import("@/pages/people"));
const CompaniesPage = lazyWithRetry(() => import("@/pages/companies"));
const CommsPage = lazyWithRetry(() => import("@/pages/comms"));
const CalendarPage = lazyWithRetry(() => import("@/pages/calendar"));
const TimersPage = lazyWithRetry(() => import("@/pages/timers"));
const MemoryPageFull = lazyWithRetry(() => import("@/pages/memory-page"));
const StrategyPage = lazyWithRetry(() => import("@/pages/strategy"));
const DecisionsPage = lazyWithRetry(() => import("@/pages/decisions"));
const StrategyDetailPage = lazyWithRetry(() => import("@/pages/strategy-detail"));

const OrientationPage = lazyWithRetry(() => import("@/pages/orientation"));
const NewsPage = lazyWithRetry(() => import("@/pages/news"));
const PlatformsPage = lazyWithRetry(() => import("@/pages/platforms"));
const PlatformEnvironmentDetailPage = lazyWithRetry(() => import("@/pages/platform-environment-detail"));
const WellnessPage = lazyWithRetry(() => import("@/pages/wellness"));
const InfoPage = lazyWithRetry(() => import("@/pages/library/index"));
const Library2Page = lazyWithRetry(() => import("@/pages/library2"));
const FinancePage = lazyWithRetry(() => import("@/pages/finance"));
const CreatePage = lazyWithRetry(() => import("@/pages/create-page"));
const ProfilePage = lazyWithRetry(() => import("@/pages/profile"));
const PipelinesPage = lazyWithRetry(() => import("@/pages/pipelines"));
const WorkflowsPage = lazyWithRetry(() => import("@/pages/workflows"));
const SkillsPage = lazyWithRetry(() => import("@/pages/skills"));
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

function getRuntimeCrashContext() {
  return {
    path: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    href: window.location.href,
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
    log.error("App crash", {
      crashId: createCrashId(),
      error: serializeCaughtValue(error),
      componentStack: info.componentStack,
      context: getRuntimeCrashContext(),
    });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 40, fontFamily: "system-ui" }}>
          <h2 style={{ marginBottom: 8 }}>Something went wrong</h2>
          <pre style={{ color: "#b91c1c", whiteSpace: "pre-wrap", fontSize: 13 }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: "8px 16px", cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface OnboardingStatus {
  completed: boolean;
  onboardingStatus: string;
}

function PageFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
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

function preserveCurrentQuery(targetPath: string): string {
  const params = new URLSearchParams(window.location.search);
  const query = params.toString();
  return `${targetPath}${query ? `?${query}` : ""}`;
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

function Router() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Switch>
        <Route path="/"><Redirect to="/home" /></Route>
        <Route path="/brain" component={BrainPage} />
        <Route path="/skills">{() => <RequirePermission permission="system:read"><SkillsPage /></RequirePermission>}</Route>
        <Route path="/system">{() => <RequirePermission permission="system:read"><SystemPage /></RequirePermission>}</Route>
        <Route path="/logs">{() => <LogsPage />}</Route>
        <Route path="/goals/:id" component={GoalDetail} />
        <Route path="/dashboard">{() => <RequirePermission permission="system:read"><DashboardPage /></RequirePermission>}</Route>
        <Route path="/home">{() => {
          const target = sessionRedirectFromQuery();
          return target === "/home" ? <HomePage /> : <Redirect to={target} />;
        }}</Route>
        <Route path="/simple">{() => <Redirect to={sessionRedirectFromQuery()} />}</Route>
        <Route path="/session" component={SessionPage} />
        <Route path="/sessions">{() => <Redirect to={sessionRedirectFromQuery()} />}</Route>
        <Route path="/goals" component={Goals} />
        <Route path="/vision" component={VisionPage} />
        <Route path="/strategy/:id" component={StrategyDetailPage} />
        <Route path="/strategy" component={StrategyPage} />
        <Route path="/decisions" component={DecisionsPage} />
        <Route path="/schedule/:eventId" component={CalendarPage} />
        <Route path="/schedule" component={CalendarPage} />
        <Route path="/calendar/:eventId">{(params: { eventId?: string }) => <Redirect to={`/schedule/${params.eventId || ""}`} />}</Route>
        <Route path="/calendar">{() => <Redirect to="/schedule" />}</Route>
        <Route path="/social">{() => <Redirect to="/create" />}</Route>
        <Route path="/create" component={CreatePage} />
        <Route path="/projects" component={ProjectsPage} />
        <Route path="/work">{() => <Redirect to="/projects" />}</Route>
        <Route path="/platforms/environments/:id" component={PlatformEnvironmentDetailPage} />
        <Route path="/platforms" component={PlatformsPage} />
        <Route path="/memory" component={MemoryPageFull} />
        <Route path="/journal">{() => <Redirect to="/memory?tab=maintenance" />}</Route>
        <Route path="/build">{() => <RequirePermission permission="build:read"><BuildPage /></RequirePermission>}</Route>
        <Route path="/database">{() => <RequirePermission permission="build:read"><DatabasePage /></RequirePermission>}</Route>
        <Route path="/design">{() => <RequirePermission permission="build:read"><DesignPage /></RequirePermission>}</Route>
        <Route path="/dev">{() => <Redirect to="/build" />}</Route>
        <Route path="/people/:id" component={PeoplePage} />
        <Route path="/people" component={PeoplePage} />
        <Route path="/companies/:id" component={CompaniesPage} />
        <Route path="/companies" component={CompaniesPage} />
        <Route path="/email" component={CommsPage} />
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
        <Route path="/settings">{() => <Redirect to="/integrations" />}</Route>
        <Route path="/issues/:id" component={IssueDetailPage} />
        <Route path="/chat">{() => <Redirect to={preserveCurrentQuery("/session")} />}</Route>
        <Route path="/wellness" component={WellnessPage} />
        <Route path="/profile" component={ProfilePage} />
        <Route path="/workflows/:id" component={WorkflowsPage} />
        <Route path="/workflows" component={WorkflowsPage} />
        <Route path="/pipelines" component={PipelinesPage} />
        <Route path="/zero" component={ZeroPage} />
        <Route path="/interface-preview" component={InterfacePreviewPage} />
        <Route path="/dev/orb">{() => <RequirePermission permission="system:read"><DevOrbPage /></RequirePermission>}</Route>
        <Route path="/library2" component={Library2Page} />
        <Route path="/library" component={InfoPage} />
        <Route path="/info" component={InfoPage} />
        <Route path="/audiences">{() => <RequirePermission permission="system:read"><AudiencesPage /></RequirePermission>}</Route>
        <Route path="/campaigns">{() => <RequirePermission permission="system:read"><CampaignsPage /></RequirePermission>}</Route>
        <Route path="/account" component={UserDetailsPage} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useAuth();
  const [location] = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (location === "/waitlist") {
    const query = window.location.search;
    window.history.replaceState(null, "", `/start${query}`);
    return (
      <Suspense fallback={<PageFallback />}>
        <WaitlistPage />
      </Suspense>
    );
  }

  if (location === "/start") {
    return (
      <Suspense fallback={<PageFallback />}>
        <WaitlistPage />
      </Suspense>
    );
  }

  if (location === "/register" || location.startsWith("/register/")) {
    return (
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/register" component={RegisterPage} />
          <Route path="/register/:token" component={RegisterPage} />
        </Switch>
      </Suspense>
    );
  }

  if (location === "/glasses") {
    return (
      <Suspense fallback={<PageFallback />}>
        <GlassesStandalone />
      </Suspense>
    );
  }

  if (!isAuthenticated) {
    return (
      <Suspense fallback={<PageFallback />}>
        <LoginPage />
      </Suspense>
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
              <main className="@container flex-1 min-w-0 overflow-y-auto overflow-x-hidden scrollbar-thin">
                <ContainerWidthProvider>
                  {navOpen ? <NavPage /> : <Router />}
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
        <MyelinationProvider>
          <ExecutorStatusProvider>
            <FocusSessionProvider>
              <FocusContextProvider>
              <TaskModalProvider>
              <SidebarProvider style={style as React.CSSProperties} forceMobile={mobileSurfaceActive} defaultOpen={false}>
                <AppLayout mobileSurfaceActive={mobileSurfaceActive} previewRouteOwnsCanvas={previewRouteOwnsCanvas} />
              </SidebarProvider>
              </TaskModalProvider>
              </FocusContextProvider>
            </FocusSessionProvider>
          </ExecutorStatusProvider>
        </MyelinationProvider>
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
  quiet(import("@/pages/work"));
  quiet(import("@/pages/issue-detail"));
  quiet(import("@/components/issue-capture").then(m => m.IssueCaptureDialog));
}

function App() {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      log.error("Window error", {
        crashId: createCrashId(),
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: serializeCaughtValue(event.error),
        context: getRuntimeCrashContext(),
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      log.error("Unhandled promise rejection", {
        crashId: createCrashId(),
        reason: serializeCaughtValue(event.reason),
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

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AuthGate>
              <BootGate>
                <VaultProvider>
                  <AppShell />
                </VaultProvider>
              </BootGate>
            </AuthGate>
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
