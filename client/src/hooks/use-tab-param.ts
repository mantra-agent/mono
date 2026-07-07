import { useEffect, useRef } from "react";
import { useSearch } from "wouter";
import { usePageHeaderContext } from "./use-page-header";

/**
 * Global tab-param synchronizer. Watches ?tab= URL param changes and calls
 * the active page header's onTabChange when the URL tab differs from the
 * current activeTab. This allows the NavBar to navigate to /page?tab=xxx
 * without modifying every page individually.
 *
 * Render this component once inside AppShell (after PageHeaderProvider).
 */
export function TabParamSync() {
  const search = useSearch();
  const { config } = usePageHeaderContext();
  const lastApplied = useRef<string>("");

  useEffect(() => {
    const urlTab = new URLSearchParams(search).get("tab");
    if (!urlTab) return;
    if (!config?.onTabChange) return;
    if (config.activeTab === urlTab) return;
    // Avoid double-firing for the same URL tab
    if (lastApplied.current === urlTab) return;
    lastApplied.current = urlTab;
    config.onTabChange(urlTab);
  }, [search, config]);

  // Reset when config changes (page navigation)
  useEffect(() => {
    lastApplied.current = "";
  }, [config?.title]);

  return null;
}
