import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { useLocation } from "wouter";
import { ScrollText, DollarSign, Loader2, Wrench, ClipboardCheck, Brain, Zap, GitBranch, Cpu, Gauge, Users, Vault } from "lucide-react";
import { ProcessesCard } from "@/components/processes-card";
import { usePageHeader } from "@/hooks/use-page-header";
import { useAuth } from "@/hooks/use-auth";
import { useLogErrors } from "@/hooks/use-log-errors";
import { lazyWithRetry } from "@/lib/lazy-with-retry";

const PerformanceContent = lazyWithRetry(() => import("@/pages/performance"));
const ToolsContent = lazyWithRetry(() => import("@/pages/tools"));
const LogsContent = lazyWithRetry(() => import("@/pages/logs"));
const ResourcesContent = lazyWithRetry(() => import("@/pages/resources"));
const UsersContent = lazyWithRetry(() => import("@/pages/users-admin"));
const VaultsContent = lazyWithRetry(() => import("@/pages/vaults-admin"));

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
  { value: "resources", label: "Performance", icon: <Gauge className="h-3.5 w-3.5" />, testId: "tab-system-resources" },
  { value: "logs", label: "Logs", icon: <ScrollText className="h-3.5 w-3.5" />, testId: "tab-system-logs" },
  { value: "timers", label: "Timers", icon: <ClipboardCheck className="h-3.5 w-3.5" />, testId: "tab-system-timers" },
  { value: "tools", label: "Tools", icon: <Wrench className="h-3.5 w-3.5" />, testId: "tab-system-tools" },
  { value: "inference", label: "Inference", icon: <Brain className="h-3.5 w-3.5" />, testId: "tab-system-inference" },
  { value: "cost", label: "Cost", icon: <DollarSign className="h-3.5 w-3.5" />, testId: "tab-system-cost" },
  { value: "events", label: "Events", icon: <Zap className="h-3.5 w-3.5" />, testId: "tab-system-events" },
  { value: "hooks", label: "Hooks", icon: <GitBranch className="h-3.5 w-3.5" />, testId: "tab-system-hooks" },
  { value: "process", label: "Process", icon: <Cpu className="h-3.5 w-3.5" />, testId: "tab-system-process" },
  { value: "users", label: "Users", icon: <Users className="h-3.5 w-3.5" />, testId: "tab-system-users" },
  { value: "vaults", label: "Vaults", icon: <Vault className="h-3.5 w-3.5" />, testId: "tab-system-vaults" },
];

export default function SystemPage() {
  const [location] = useLocation();

  const { hasUnseenErrors: hasUnseenLogErrors, markSeen: markLogErrorsSeen } = useLogErrors();
  const { hasPermission } = useAuth();
  const canReadUsers = hasPermission("users:read");

  const readUrlParams = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      tab: params.get("tab") || "resources",
    };
  }, [canReadUsers]);

  const [activeTab, setActiveTab] = useState(() => readUrlParams().tab);

  useEffect(() => {
    const p = readUrlParams();
    setActiveTab(p.tab);
  }, [location, readUrlParams]);

  const tabs = useMemo(() =>
    systemTabs
      .filter((t) => t.value !== "users" || canReadUsers)
      .map(t => {
      if (t.value === "logs" && hasUnseenLogErrors) {
        return { ...t, indicatorLevel: "error" as const, tooltip: "Unseen log errors" };
      }
      return t;
    }),
    [canReadUsers, hasUnseenLogErrors]
  );

  useEffect(() => {
    if (activeTab === "users" && !canReadUsers) {
      setActiveTab("resources");
    }
  }, [activeTab, canReadUsers]);

  usePageHeader({
    title: activeTab === "vaults" ? "Vaults" : "System",
    tabs,
    activeTab,
    onTabChange: setActiveTab,
  });

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <Suspense fallback={<TabFallback />}>
        {activeTab === "users" && <UsersContent />}
        {activeTab === "logs" && <LogsContent embedded={true} />}
        {activeTab === "timers" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <TimersContent embedded={true} />
          </div>
        )}
        {activeTab === "tools" && <ToolsContent embedded={true} />}
        {activeTab === "inference" && <InferenceContent embedded={true} />}
        {activeTab === "cost" && <PerformanceContent embedded={true} />}
        {activeTab === "events" && <EventsContent embedded={true} />}
        {activeTab === "hooks" && <HooksContent embedded={true} />}
        {activeTab === "vaults" && <VaultsContent />}
        {activeTab === "resources" && <ResourcesContent />}
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
