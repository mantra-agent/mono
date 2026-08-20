import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { useLocation, useSearch } from "wouter";
import { ScrollText, DollarSign, Loader2, Wrench, ClipboardCheck, Brain, Zap, GitBranch, Cpu, Users, FileText, KeyRound, Building2, Bot, Route } from "lucide-react";
import { ProcessesCard } from "@/components/processes-card";
import { usePageHeader } from "@/hooks/use-page-header";
import { useAuth } from "@/hooks/use-auth";
import { useLogErrors } from "@/hooks/use-log-errors";
import { lazyWithRetry } from "@/lib/lazy-with-retry";

const CostContent = lazyWithRetry(() => import("@/pages/cost"));
const ToolsContent = lazyWithRetry(() => import("@/pages/tools"));
const PromptsContent = lazyWithRetry(() => import("@/pages/prompts"));
const LogsContent = lazyWithRetry(() => import("@/pages/logs"));
const UsersContent = lazyWithRetry(() => import("@/pages/users-admin"));
const AccountsContent = lazyWithRetry(() => import("@/pages/accounts-admin"));
const AgentsContent = lazyWithRetry(() => import("@/pages/agents-admin"));
const RoutersContent = lazyWithRetry(() => import("@/pages/routers-admin"));
const SecretsContent = lazyWithRetry(() => import("@/pages/secrets-admin"));

const InferenceContent = lazyWithRetry(() => import("@/pages/inference"));
const EventsContent = lazyWithRetry(() => import("@/pages/events"));
const HooksContent = lazyWithRetry(() => import("@/pages/hooks"));
const TimersContent = lazyWithRetry(() => import("@/pages/timers").then(m => ({ default: m.TimersContent })));

function TabFallback() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

const systemTabs = [
  { value: "logs", label: "Logs", icon: <ScrollText className="h-3.5 w-3.5" />, testId: "tab-system-logs" },
  { value: "timers", label: "Timers", icon: <ClipboardCheck className="h-3.5 w-3.5" />, testId: "tab-system-timers" },
  { value: "tools", label: "Tools", icon: <Wrench className="h-3.5 w-3.5" />, testId: "tab-system-tools" },
  { value: "prompts", label: "Prompts", icon: <FileText className="h-3.5 w-3.5" />, testId: "tab-system-prompts" },
  { value: "inference", label: "Inference", icon: <Brain className="h-3.5 w-3.5" />, testId: "tab-system-inference" },
  { value: "routers", label: "Routers", icon: <Route className="h-3.5 w-3.5" />, testId: "tab-system-routers" },
  { value: "cost", label: "Cost", icon: <DollarSign className="h-3.5 w-3.5" />, testId: "tab-system-cost" },
  { value: "events", label: "Events", icon: <Zap className="h-3.5 w-3.5" />, testId: "tab-system-events" },
  { value: "hooks", label: "Hooks", icon: <GitBranch className="h-3.5 w-3.5" />, testId: "tab-system-hooks" },
  { value: "process", label: "Process", icon: <Cpu className="h-3.5 w-3.5" />, testId: "tab-system-process" },
  { value: "accounts", label: "Accounts", icon: <Building2 className="h-3.5 w-3.5" />, testId: "tab-system-accounts" },
  { value: "agents", label: "Agents", icon: <Bot className="h-3.5 w-3.5" />, testId: "tab-system-agents" },
  { value: "users", label: "Users", icon: <Users className="h-3.5 w-3.5" />, testId: "tab-system-users" },
  { value: "secrets", label: "Secrets", icon: <KeyRound className="h-3.5 w-3.5" />, testId: "tab-system-secrets" },
];

export default function SystemPage() {
  const [, setLocation] = useLocation();
  // Wouter location is pathname-only; query changes must subscribe via useSearch.
  const search = useSearch();

  const { hasUnseenErrors: hasUnseenLogErrors, markSeen: markLogErrorsSeen } = useLogErrors();
  const { hasPermission } = useAuth();
  const canReadUsers = hasPermission("users:read");
  const canReadPrompts = hasPermission("build:read");

  const readUrlParams = useCallback(() => {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    return {
      tab: params.get("tab") || "logs",
    };
  }, [search]);

  const [activeTab, setActiveTab] = useState(() => readUrlParams().tab);

  const identityTabs = new Set(["users", "accounts", "agents"]);

  const tabs = useMemo(() =>
    systemTabs
      .filter((t) => (!identityTabs.has(t.value) || canReadUsers) && (t.value !== "prompts" || canReadPrompts))
      .map(t => {
      if (t.value === "logs" && hasUnseenLogErrors) {
        return { ...t, indicatorLevel: "error" as const, tooltip: "Unseen log errors" };
      }
      return t;
    }),
    [canReadUsers, canReadPrompts, hasUnseenLogErrors]
  );

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    // Keep query string authoritative so deep links and same-path navigations remount the right tab.
    setLocation(`/system?tab=${encodeURIComponent(tab)}`);
  }, [setLocation]);

  useEffect(() => {
    const p = readUrlParams();
    // Vaults moved to a first-class /vaults route so all authenticated users
    // can manage their vaults without system:read.
    if (p.tab === "vaults") {
      setLocation("/vaults");
      return;
    }
    // Performance is a first-class /performance route; keep old System deep links working.
    if (p.tab === "resources" || p.tab === "performance") {
      setLocation("/performance");
      return;
    }
    const allowed = tabs.some((t) => t.value === p.tab) ? p.tab : null;
    if (!allowed) return;
    setActiveTab(allowed);
  }, [search, readUrlParams, setLocation, tabs]);

  useEffect(() => {
    const syncFromHistory = () => {
      const p = readUrlParams();
      if (tabs.some((t) => t.value === p.tab)) setActiveTab(p.tab);
    };
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, [readUrlParams, tabs]);

  useEffect(() => {
    if (identityTabs.has(activeTab) && !canReadUsers) {
      handleTabChange("logs");
    }
    if (activeTab === "prompts" && !canReadPrompts) {
      handleTabChange("logs");
    }
    // Legacy System→Billing deep link: price map lives on Integrations → Stripe.
    if (activeTab === "billing") {
      setLocation("/integrations/stripe");
    }
  }, [activeTab, canReadUsers, canReadPrompts, handleTabChange, setLocation]);

  usePageHeader({
    title:
      activeTab === "hooks" ? "Hooks"
        : activeTab === "prompts" ? "Prompts"
          : activeTab === "accounts" ? "Accounts"
            : activeTab === "agents" ? "Agents"
              : activeTab === "users" ? "Users"
                : activeTab === "routers" ? "Routers"
                  : "System",
    tabs,
    activeTab,
    onTabChange: handleTabChange,
  });

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <Suspense fallback={<TabFallback />}>
        {activeTab === "accounts" && <AccountsContent />}
        {activeTab === "agents" && <AgentsContent />}
        {activeTab === "users" && <UsersContent />}
        {activeTab === "routers" && <RoutersContent />}
        {activeTab === "secrets" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <SecretsContent />
          </div>
        )}
        {activeTab === "logs" && <LogsContent embedded={true} />}
        {activeTab === "timers" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <TimersContent embedded={true} />
          </div>
        )}
        {activeTab === "tools" && <ToolsContent embedded={true} />}
        {activeTab === "prompts" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <PromptsContent />
          </div>
        )}
        {activeTab === "inference" && <InferenceContent embedded={true} />}
        {activeTab === "cost" && <CostContent embedded={true} />}
        {activeTab === "events" && <EventsContent embedded={true} />}
        {activeTab === "hooks" && <HooksContent embedded={true} />}
        {activeTab === "process" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin p-6">
            <div className="">
              <ProcessesCard />
            </div>
          </div>
        )}
      </Suspense>
    </div>
  );
}
