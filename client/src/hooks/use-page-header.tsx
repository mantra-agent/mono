import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { createLogger } from "@/lib/logger";

const log = createLogger("PageHeader");

interface TabDef {
  value: string;
  label: string;
  icon?: ReactNode;
  indicator?: ReactNode;
  indicatorLevel?: "error" | "active" | "attention" | "unread";
  indicatorKey?: string;
  tooltip?: string;
  testId?: string;
}

interface PageHeaderConfig {
  title: string;
  tabs?: TabDef[];
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  customContent?: ReactNode;
  skip?: boolean;
}

interface PageHeaderContextValue {
  config: PageHeaderConfig | null;
  setConfig: (config: PageHeaderConfig | null) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue>({
  config: null,
  setConfig: () => {},
});

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<PageHeaderConfig | null>(null);
  return (
    <PageHeaderContext.Provider value={{ config, setConfig }}>
      {children}
    </PageHeaderContext.Provider>
  );
}

export function usePageHeaderContext() {
  return useContext(PageHeaderContext);
}

function useStableTabs(tabs?: TabDef[]): TabDef[] | undefined {
  const ref = useRef(tabs);
  const prevKey = useRef("");
  const key = tabs ? tabs.map(t => `${t.value}:${t.label}:${t.indicatorKey ?? (t.indicator ? "1" : "0")}:${t.indicatorLevel ?? ""}:${t.tooltip ?? ""}`).join("|") : "";
  if (key !== prevKey.current) {
    ref.current = tabs;
    prevKey.current = key;
  }
  return ref.current;
}

export function usePageHeader(config: PageHeaderConfig) {
  const { setConfig } = useContext(PageHeaderContext);

  const stableOnTabChange = useCallback(
    (tab: string) => config.onTabChange?.(tab),
    [config.onTabChange]
  );

  const stableTabs = useStableTabs(config.tabs);

  useEffect(() => {
    if (config.skip) return;
    log.debug("Config set:", config.title);
    setConfig({
      title: config.title,
      tabs: stableTabs,
      activeTab: config.activeTab,
      onTabChange: stableOnTabChange,
      customContent: config.customContent,
    });
  }, [config.skip, config.title, config.activeTab, stableTabs, stableOnTabChange, config.customContent, setConfig]);
}
