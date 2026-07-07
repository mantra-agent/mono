import { useCallback, useMemo, useSyncExternalStore } from "react";
import { usePageHeader } from "@/hooks/use-page-header";
import { Scale, Swords } from "lucide-react";
import StrategyDecisionsTab from "./strategy-decisions-tab";
import StrategyListTab from "./strategy-list-tab";

const TABS = [
  { value: "decisions", label: "Decisions", icon: <Scale className="h-3.5 w-3.5" />, testId: "tab-strategy-decisions" },
  { value: "strategies", label: "Strategies", icon: <Swords className="h-3.5 w-3.5" />, testId: "tab-strategy-strategies" },
] as const;

const VALID_TABS = TABS.map(t => t.value) as readonly string[];
type StrategyTab = typeof TABS[number]["value"];

function useHashTab(): [StrategyTab, (t: string) => void] {
  const getHash = useCallback(() => window.location.hash.replace(/^#/, "") || "decisions", []);
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  }, []);
  const raw = useSyncExternalStore(subscribe, getHash, getHash);
  const tab = (VALID_TABS.includes(raw) ? raw : "decisions") as StrategyTab;
  const setTab = useCallback((t: string) => { window.location.hash = t; }, []);
  return [tab, setTab];
}

export default function StrategyPage() {
  const [tab, setTab] = useHashTab();
  const tabs = useMemo(() => TABS.map(t => ({ ...t })), []);
  usePageHeader({ title: "Strategy", tabs, activeTab: tab, onTabChange: setTab });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {tab === "decisions" && <StrategyDecisionsTab />}
      {tab === "strategies" && <StrategyListTab />}
    </div>
  );
}
