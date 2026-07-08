import { useCallback, useSyncExternalStore, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { usePageHeader } from "@/hooks/use-page-header";
import { useFocusContext } from "@/hooks/use-focus-context";
import { LibraryTab } from "./library-tab";
import { VISIBLE_INFO_TABS, VALID_TABS, type InfoTab, type LibraryPage } from "./types";
import { useLibraryUnread } from "@/components/library-activity-indicator";
import { cn } from "@/lib/utils";


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
function buildPageTrail(pages: LibraryPage[], pageSlug?: string): LibraryPage[] {
  if (!pageSlug) return [];
  const selected = pages.find((page) => page.slug === pageSlug || page.id === pageSlug);
  if (!selected) return [];
  const trail: LibraryPage[] = [];
  let current = selected.parentId ? pages.find((page) => page.id === selected.parentId) : undefined;
  while (current) {
    trail.unshift(current);
    current = current.parentId ? pages.find((page) => page.id === current!.parentId) : undefined;
  }
  return trail;
}

function LibraryTopbarBreadcrumbs({ trail, onSelectLibrary, onSelectPage }: {
  trail: LibraryPage[];
  onSelectLibrary: () => void;
  onSelectPage: (page: LibraryPage) => void;
}) {
  const visibleTrail = trail.length > 3 ? trail.slice(-3) : trail;
  const collapsed = trail.length > visibleTrail.length;
  return (
    <div className="flex min-w-0 items-center gap-1 truncate text-sm font-medium text-foreground">
      <button type="button" className="shrink-0 hover:text-cta" onClick={onSelectLibrary} data-testid="topbar-library-root">Library</button>
      {collapsed && (
        <>
          <span className="text-muted-foreground">/</span>
          <span className="shrink-0 text-muted-foreground">...</span>
        </>
      )}
      {visibleTrail.map((page) => (
        <span key={page.id} className="flex min-w-0 items-center gap-1">
          <span className="shrink-0 text-muted-foreground">/</span>
          <button
            type="button"
            className={cn("min-w-0 truncate hover:text-cta", page === visibleTrail[visibleTrail.length - 1] && "text-foreground")}
            onClick={() => onSelectPage(page)}
            data-testid={`topbar-library-crumb-${page.id}`}
            title={page.title || "Untitled"}
          >
            {page.title || "Untitled"}
          </button>
        </span>
      ))}
    </div>
  );
}

export default function InfoPage() {
  const [tab, setTab, specSlug, pageSlug] = useHashTab();
  const { data: unreadIds } = useLibraryUnread();
  const { data: pages = [] } = useQuery<LibraryPage[]>({ queryKey: ["/api/info/library"] });
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

  const libraryTrail = useMemo(() => buildPageTrail(pages, pageSlug), [pages, pageSlug]);
  const libraryHeaderContent = tab === "library" && pageSlug ? (
    <LibraryTopbarBreadcrumbs
      trail={libraryTrail}
      onSelectLibrary={() => setTab("library")}
      onSelectPage={(page) => { window.location.hash = `library?page=${page.slug}`; }}
    />
  ) : undefined;

  usePageHeader({
    title: "Library",
    tabs,
    activeTab: tab,
    onTabChange: setTab,
    customContent: libraryHeaderContent,
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
