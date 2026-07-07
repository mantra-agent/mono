import { useCallback, useSyncExternalStore, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import { usePageHeader } from "@/hooks/use-page-header";
import { useFocusContext } from "@/hooks/use-focus-context";
import { LibraryTab } from "./library-tab";
import { VISIBLE_INFO_TABS, VALID_TABS, type InfoTab } from "./types";
import { useLibraryUnread } from "@/components/library-activity-indicator";


// Old hashes — `#data` and `#db` — used to land on the in-page Data sub-tab
// here. Task #1026 moved that view (and the prod ↔ dev sync controls) into
// the dedicated `/dev?tab=database` tab. We keep the redirect mapping so
// bookmarked links still resolve.
const REDIRECT_HASHES = new Set(["data", "db"]);

function parseHashInfo(hash: string): {
  tab: InfoTab;
  specSlug?: string;
  pageSlug?: string;
} {
  const raw = hash.replace(/^#/, "");
  if (raw.startsWith("library?spec=")) {
    const slug = raw.slice("library?spec=".length);
    return { tab: "library", specSlug: slug || undefined };
  }
  if (raw.startsWith("library?page=")) {
    const slug = raw.slice("library?page=".length);
    return { tab: "library", pageSlug: slug || undefined };
  }
  // Legacy #notes and #notes?id=X redirect to library
  if (raw === "notes" || raw.startsWith("notes?")) {
    return { tab: "library" };
  }
  const tab = (VALID_TABS as readonly string[]).includes(raw) ? raw as InfoTab : "library";
  return { tab };
}

function useHashTab(): [InfoTab, (t: string) => void, string | undefined, string | undefined] {
  const getHash = useCallback(() => window.location.hash.replace(/^#/, "") || "library", []);
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("hashchange", cb);
    return () => window.removeEventListener("hashchange", cb);
  }, []);
  const rawHash = useSyncExternalStore(subscribe, getHash, getHash);
  const { tab, specSlug, pageSlug } = parseHashInfo(rawHash);

  const setTab = useCallback((t: string) => {
    window.location.hash = t;
  }, []);

  return [tab, setTab, specSlug, pageSlug];
}

export default function InfoPage() {
  const [tab, setTab, specSlug, pageSlug] = useHashTab();
  const { data: unreadIds } = useLibraryUnread();
  const hasUnreadLibrary = (unreadIds?.length ?? 0) > 0;

  const [, setLocation] = useLocation();
  // Old `/info#data` and `/info#db` links now live at `/dev?tab=database`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => {
      const raw = window.location.hash.replace(/^#/, "");
      if (REDIRECT_HASHES.has(raw)) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
        setLocation("/dev?tab=database");
      }
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [setLocation]);

  const tabs = useMemo(() =>
    VISIBLE_INFO_TABS.map(t =>
      t.value === "library" && hasUnreadLibrary
        ? { ...t, indicatorLevel: "unread" as const }
        : t
    ),
    [hasUnreadLibrary]
  );

  usePageHeader({
    title: "Library",
    tabs,
    activeTab: tab,
    onTabChange: setTab,
  });

  useFocusContext(
    tab === "library" && pageSlug
      ? { entity: { type: "library_page", id: pageSlug }, subView: specSlug || undefined }
      : null
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {tab === "library" && <LibraryTab initialSpecSlug={specSlug} initialPageSlug={pageSlug} />}
    </div>
  );
}
