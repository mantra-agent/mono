import { useState, useEffect, useCallback, Suspense } from "react";
import { useLocation } from "wouter";
import { ClipboardList, FileText, Activity, Heart, User, SlidersHorizontal, Loader2 } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { lazyWithRetry } from "@/lib/lazy-with-retry";

const ContextContent = lazyWithRetry(() => import("@/pages/context-page"));
const ObservationsContent = lazyWithRetry(() => import("@/pages/thoughts-page"));
const TimersContent = lazyWithRetry(() => import("@/pages/timers").then(m => ({ default: m.TimersContent })));

const EmotionContent = lazyWithRetry(() => import("@/pages/emotion-tab"));
const PersonaContent = lazyWithRetry(() => import("@/pages/persona-tab"));
const ModelContent = lazyWithRetry(() => import("@/pages/model-tab"));
const PlansContent = lazyWithRetry(() => import("@/pages/plans-view").then(m => ({ default: m.PlansView })));

function TabFallback() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

const brainTabs = [
  { value: "observations", label: "Observations", icon: <Activity className="h-3.5 w-3.5" />, testId: "tab-brain-observations" },
  { value: "context", label: "Context", icon: <FileText className="h-3.5 w-3.5" />, testId: "tab-brain-context" },
  { value: "emotion", label: "Emotion", icon: <Heart className="h-3.5 w-3.5" />, testId: "tab-brain-emotion" },
  { value: "persona", label: "Persona", icon: <User className="h-3.5 w-3.5" />, testId: "tab-brain-persona" },
  { value: "model", label: "Model", icon: <SlidersHorizontal className="h-3.5 w-3.5" />, testId: "tab-brain-model" },
  { value: "plans", label: "Plans", icon: <ClipboardList className="h-3.5 w-3.5" />, testId: "tab-brain-plans" },
];

export default function BrainPage() {
  const [location] = useLocation();

  const readUrlParams = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      tab: params.get("tab") || "observations",
    };
  }, []);

  const [activeTab, setActiveTab] = useState(() => readUrlParams().tab);

  useEffect(() => {
    const p = readUrlParams();
    setActiveTab(p.tab);
  }, [location, readUrlParams]);

  usePageHeader({
    title: "Brain",
    tabs: brainTabs,
    activeTab,
    onTabChange: setActiveTab,
  });

  return (
    <div className="flex flex-col h-full min-w-0 overflow-hidden">
      <Suspense fallback={<TabFallback />}>
        {activeTab === "observations" && <ObservationsContent embedded={true} />}
        {activeTab === "context" && <ContextContent embedded={true} />}
        {activeTab === "emotion" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <EmotionContent />
          </div>
        )}
        {activeTab === "persona" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <PersonaContent />
          </div>
        )}
        {activeTab === "model" && (
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin">
            <ModelContent />
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
