import { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { useLocation, useSearch } from "wouter";
import { ClipboardList, FileText, Activity, Heart, User, SlidersHorizontal, Loader2 } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { lazyWithRetry } from "@/lib/lazy-with-retry";
import { useAuth } from "@/hooks/use-auth";

const ContextContent = lazyWithRetry(() => import("@/pages/context-page"));
const ObservationsContent = lazyWithRetry(() => import("@/pages/observations"));
const TimersContent = lazyWithRetry(() => import("@/pages/timers").then(m => ({ default: m.TimersContent })));

const EmotionContent = lazyWithRetry(() => import("@/pages/emotion-tab"));
const PersonasContent = lazyWithRetry(() => import("@/pages/personas"));
const ModelsContent = lazyWithRetry(() => import("@/pages/models"));
const PlansContent = lazyWithRetry(() => import("@/pages/plans"));

function TabFallback() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

const brainTabs = [
  { value: "observations", label: "Observations", icon: <Activity className="h-3.5 w-3.5" />, testId: "tab-brain-observations" },
  { value: "context", label: "Context", icon: <FileText className="h-3.5 w-3.5" />, testId: "tab-brain-context", permission: "system:read" },
  { value: "emotion", label: "Emotion", icon: <Heart className="h-3.5 w-3.5" />, testId: "tab-brain-emotion" },
  { value: "persona", label: "Personas", icon: <User className="h-3.5 w-3.5" />, testId: "tab-brain-persona" },
  { value: "model", label: "Models", icon: <SlidersHorizontal className="h-3.5 w-3.5" />, testId: "tab-brain-model", permission: "system:read" },
  { value: "plans", label: "Plans", icon: <ClipboardList className="h-3.5 w-3.5" />, testId: "tab-brain-plans" },
];

export default function BrainPage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const { hasPermission } = useAuth();

  const readUrlParams = useCallback(() => {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    return {
      tab: params.get("tab") || "observations",
    };
  }, [search]);

  const visibleTabs = useMemo(
    () => brainTabs.filter((tab) => !tab.permission || hasPermission(tab.permission)),
    [hasPermission],
  );

  const [activeTab, setActiveTab] = useState(() => readUrlParams().tab);

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab);
    setLocation(`/brain?tab=${encodeURIComponent(tab)}`);
  }, [setLocation]);

  useEffect(() => {
    const p = readUrlParams();
    const nextTab = visibleTabs.some((tab) => tab.value === p.tab) ? p.tab : (visibleTabs[0]?.value ?? "observations");
    if (nextTab !== p.tab) {
      setLocation(`/brain?tab=${encodeURIComponent(nextTab)}`, { replace: true });
      return;
    }
    setActiveTab(nextTab);
  }, [search, readUrlParams, setLocation, visibleTabs]);

  useEffect(() => {
    const syncFromHistory = () => {
      const p = readUrlParams();
      setActiveTab(visibleTabs.some((tab) => tab.value === p.tab) ? p.tab : (visibleTabs[0]?.value ?? "observations"));
    };
    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, [readUrlParams, visibleTabs]);

  usePageHeader({
    title: activeTab === "persona" ? "Personas" : "Brain",
    tabs: visibleTabs,
    activeTab,
    onTabChange: handleTabChange,
  });

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <Suspense fallback={<TabFallback />}>
        {activeTab === "observations" && <ObservationsContent embedded={true} />}
        {activeTab === "context" && hasPermission("system:read") && <ContextContent embedded={true} />}
        {activeTab === "emotion" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <EmotionContent />
          </div>
        )}
        {activeTab === "persona" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <PersonasContent />
          </div>
        )}
        {activeTab === "model" && hasPermission("system:read") && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <ModelsContent />
          </div>
        )}
        {activeTab === "plans" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <PlansContent />
          </div>
        )}
      </Suspense>
    </div>
  );
}
