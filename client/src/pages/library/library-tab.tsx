// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useIsMobile } from "@/hooks/use-mobile";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { downloadPageAsMarkdown } from "@/lib/editor-utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { X, Plus, Loader2, Search } from "lucide-react";
import type { JSONContent } from "@tiptap/core";
import type { LibraryPage, LibraryPageFull, TreeNode, DropPosition } from "./types";
import { LibraryPageEditor, EmptyLibraryState, DeletePageDialog, MovePageDialog } from "./library-components";
import { flattenTree, DndTree } from "./library-tree";
import { useLibraryUnread, computeHasUnreadDescendantIds } from "@/components/library-activity-indicator";

const log = createLogger("LibraryTab");

const SIDEBAR_WIDTH_KEY = "library-sidebar-width";
const EXPANDED_IDS_KEY = "library-expanded-ids";
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 480;

export function LibraryTab({ initialSpecSlug, initialPageSlug }: { initialSpecSlug?: string; initialPageSlug?: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(EXPANDED_IDS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return new Set<string>(parsed);
      }
    } catch { /* ignore parse errors */ }
    return new Set<string>();
  });
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const expandedInitialized = useRef(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [treeMoveId, setTreeMoveId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (Number.isFinite(parsed)) return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, parsed));
    }
    return DEFAULT_SIDEBAR_WIDTH;
  });
  const isResizing = useRef(false);

  const { data: pages = [] } = useQuery<LibraryPage[]>({
    queryKey: ["/api/info/library"],
  });

  const lastResolvedPageRef = useRef<string | undefined>();
  useEffect(() => {
    const pageRef = initialSpecSlug || initialPageSlug;
    if (pageRef && pages.length > 0 && pageRef !== lastResolvedPageRef.current) {
      const match = pages.find(p => p.slug === pageRef || p.id === pageRef);
      if (match) {
        lastResolvedPageRef.current = pageRef;
        setSelectedId(match.id);
      }
    }
  }, [initialSpecSlug, initialPageSlug, pages]);

  const { data: treeData = [], isLoading: isTreeLoading } = useQuery<TreeNode[]>({
    queryKey: ["/api/info/library/tree"],
  });

  const { data: unreadIdsList = [] } = useLibraryUnread();
  const unreadIds = useMemo(() => new Set(unreadIdsList), [unreadIdsList]);
  const hasUnreadDescendantIds = useMemo(
    () => computeHasUnreadDescendantIds(treeData, unreadIds),
    [treeData, unreadIds],
  );

  useEffect(() => {
    if (!expandedInitialized.current && treeData.length > 0) {
      expandedInitialized.current = true;
      if (!localStorage.getItem(EXPANDED_IDS_KEY)) {
        const parentIds = new Set<string>();
        const walkTree = (nodes: TreeNode[]) => {
          for (const n of nodes) {
            if (n.children.length > 0) parentIds.add(n.id);
            walkTree(n.children);
          }
        };
        walkTree(treeData);
        setExpandedIds(parentIds);
      }
    }
  }, [treeData]);

  useEffect(() => {
    if (expandedInitialized.current) {
      localStorage.setItem(EXPANDED_IDS_KEY, JSON.stringify([...expandedIds]));
    }
  }, [expandedIds]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectPage = useCallback((id: string) => {
    setSelectedId(id);
    const page = pages.find(p => p.id === id);
    if (page?.slug) {
      window.location.hash = `library?page=${page.slug}`;
    }
  }, [pages]);

  useEffect(() => {
    const handler = () => {
      const raw = window.location.hash.replace(/^#/, "");
      if (raw.startsWith("library?page=")) {
        const slug = raw.slice("library?page=".length);
        if (slug) {
          const match = pages.find(p => p.slug === slug);
          if (match) setSelectedId(match.id);
        }
      }
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, [pages]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, startWidth + (ev.clientX - startX)));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      setSidebarWidth(w => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
        return w;
      });
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  const filterTree = useCallback((nodes: TreeNode[], query: string): TreeNode[] => {
    if (!query.trim()) return nodes;
    const lowerQ = query.toLowerCase();
    const filter = (items: TreeNode[]): TreeNode[] => {
      return items.reduce<TreeNode[]>((acc, node) => {
        const filteredChildren = filter(node.children);
        if (node.title.toLowerCase().includes(lowerQ) || filteredChildren.length > 0) {
          acc.push({ ...node, children: filteredChildren });
        }
        return acc;
      }, []);
    };
    return filter(nodes);
  }, []);

  const filteredTreeData = useMemo(() => filterTree(treeData, searchQuery), [treeData, searchQuery, filterTree]);
  const flatNodes = useMemo(() => flattenTree(filteredTreeData, 0, null, expandedIds), [filteredTreeData, expandedIds]);
  const flatNodeIds = useMemo(() => flatNodes.map(n => n.id), [flatNodes]);
  const flatNodeMap = useMemo(() => new Map(flatNodes.map(n => [n.id, n])), [flatNodes]);

  const reorderMutation = useApiMutation<{ id: string; parentId: string | null; sortOrder: number }>({
    method: "PATCH",
    path: "/api/info/library/reorder",
    invalidateKeys: [["/api/info/library/tree"], ["/api/info/library"]],
    errorTitle: "Reorder failed",
    // The reorder endpoint returns 409 when it loses a serialization race
    // with another reorder or a `library` tool write under the same parent.
    // Retry once with a small backoff before surfacing an error to the user.
    retryOn409: true,
  });

  const createMutation = useApiMutation<{ parentId?: string; title?: string; tags?: string[] } | undefined, LibraryPage>({
    method: "POST",
    path: "/api/info/library",
    body: (opts) => ({
      title: opts?.title || "Untitled Page",
      content: null,
      plainTextContent: "",
      parentId: opts?.parentId || null,
      tags: opts?.tags || [],
    }),
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"]],
    successMessage: (page) => `${page.title || "Page"} created`,
    errorTitle: "Failed to create page",
    onSuccess: (page, opts) => {
      if (opts?.parentId) {
        setExpandedIds(prev => { const next = new Set(prev); next.add(opts.parentId!); return next; });
      }
      selectPage(page.id);
    },
  });

  const deleteMutation = useApiMutation<string>({
    method: "DELETE",
    path: (id) => `/api/info/library/${id}`,
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"]],
    successMessage: (pageId) => `${pages.find((page) => page.id === pageId)?.title || "Page"} deleted`,
    errorTitle: "Delete failed",
    onSuccess: () => setSelectedId(null),
  });

  const emojiMutation = useApiMutation<{ id: string; emoji: string | null }>({
    method: "PATCH",
    path: ({ id }) => `/api/info/library/${id}`,
    body: ({ emoji }) => ({ emoji }),
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"]],
  });

  const enrichMutation = useApiMutation<string>({
    method: "POST",
    path: (id) => `/api/library/pages/${id}/enrich`,
    body: () => ({}),
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"]],
    successMessage: (pageId) => `${pages.find((page) => page.id === pageId)?.title || "Page"} enriched`,
    errorTitle: "Enrich failed",
  });

  const handleTreeDownload = useCallback(async (node: TreeNode) => {
    try {
      const res = await fetch(`/api/info/library/${node.id}`);
      const page = await res.json();
      downloadPageAsMarkdown(
        node.title,
        page.content as JSONContent | null,
        page.plainTextContent,
      );
    } catch (err) {
      log.warn("download failed for page", { pageId: node.id, error: err });
    }
  }, []);

  const { data: selectedPageFull, isLoading: isPageContentLoading } = useQuery<LibraryPageFull>({
    queryKey: ["/api/info/library", selectedId],
    enabled: !!selectedId,
  });

  useEffect(() => {
    if (selectedId && selectedPageFull) {
      apiRequest("PATCH", `/api/info/library/${selectedId}/read`).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/info/library/unread"] });
      }).catch((err) => {
        log.warn("Failed to mark library page as read", { pageId: selectedId, error: err });
      });
    }
  }, [selectedId, selectedPageFull]);

  const deletePageToConfirm = deleteConfirmId ? pages.find(p => p.id === deleteConfirmId) : null;
  const selectedPage = pages.find(p => p.id === selectedId) || null;
  const isMobile = useIsMobile();
  const showLibEditor = isMobile && selectedId;
  const showLibList = !isMobile || !selectedId;

  return (
    <div className="flex h-full min-w-0 overflow-hidden bg-background">
      {showLibList && (
      <>
      <div className={cn("flex min-w-0 max-w-full flex-col overflow-hidden bg-background", isMobile ? "flex-1" : "shrink-0 border-r border-border")} style={isMobile ? undefined : { width: sidebarWidth, maxWidth: sidebarWidth }}>
        <ScrollArea className="min-w-0 max-w-full flex-1 overflow-hidden bg-background p-2 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0 [&_[data-radix-scroll-area-viewport]>div]:!max-w-full">
          <div className="relative mb-1 min-w-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="input-library-search"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                data-testid="button-clear-library-search"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => createMutation.mutate({})}
            disabled={createMutation.isPending}
            className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="button-create-library-page"
          >
            {createMutation.isPending ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Plus className="h-3.5 w-3.5 shrink-0" />}
            <span>New Page</span>
          </button>
          {isTreeLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : filteredTreeData.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">{searchQuery ? "No matching pages" : "No pages yet"}</div>
          ) : (
            <DndTree
              treeData={treeData}
              flatNodes={flatNodes}
              flatNodeIds={flatNodeIds}
              flatNodeMap={flatNodeMap}
              selectedId={selectedId}
              expandedIds={expandedIds}
              dragActiveId={dragActiveId}
              dropTarget={dropTarget}
              onDragActiveIdChange={setDragActiveId}
              onDropTargetChange={setDropTarget}
              onSelect={selectPage}
              onCreateChild={(parentId) => createMutation.mutate({ parentId })}
              onSetEmoji={(id, emoji) => emojiMutation.mutate({ id, emoji })}
              onDelete={(id) => setDeleteConfirmId(id)}
              onDownload={handleTreeDownload}
              onEnrich={(id) => enrichMutation.mutate(id)}
              onMove={(id) => setTreeMoveId(id)}
              onReorder={(data) => reorderMutation.mutate(data)}
              toggleExpand={toggleExpand}
              unreadIds={unreadIds}
              hasUnreadDescendantIds={hasUnreadDescendantIds}
            />
          )}
        </ScrollArea>
      </div>
      {!isMobile && (
        <div
          className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
          onMouseDown={handleResizeStart}
          data-testid="sidebar-resize-handle"
        />
      )}
      </>
      )}

      {(!isMobile || showLibEditor) && (
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedPage && selectedId ? (
          isPageContentLoading || !selectedPageFull ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <LibraryPageEditor
              selectedId={selectedId}
              selectedPage={selectedPageFull}
              pages={pages}
              isMobile={isMobile}
              onBack={() => setSelectedId(null)}
              onSelectPage={selectPage}
              onDeleteRequest={(id) => setDeleteConfirmId(id)}
            />
          )
        ) : (
          <EmptyLibraryState onCreate={() => createMutation.mutate({})} />
        )}
      </div>
      )}

      <DeletePageDialog
        open={!!deleteConfirmId}
        onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}
        pageTitle={deletePageToConfirm?.title || "Untitled"}
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteConfirmId) {
            deleteMutation.mutate(deleteConfirmId);
            setDeleteConfirmId(null);
          }
        }}
      />
      {treeMoveId && (() => {
        const movePage = pages.find(p => p.id === treeMoveId);
        if (!movePage) return null;
        return (
          <MovePageDialog
            open={true}
            onOpenChange={(open) => { if (!open) setTreeMoveId(null); }}
            page={movePage}
            pages={pages}
          />
        );
      })()}
    </div>
  );
}
