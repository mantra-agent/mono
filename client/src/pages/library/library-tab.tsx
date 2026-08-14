// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { useFocusSession } from "@/hooks/use-focus-session";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { downloadPageAsMarkdown } from "@/lib/editor-utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { X, Plus, Loader2, Search, ChevronRight, MoreHorizontal, FilePlus } from "lucide-react";
import type { JSONContent } from "@tiptap/core";
import type { LibraryPage, LibraryPageFull, TreeNode, DropPosition } from "./types";
import { LibraryPageEditor, EmptyLibraryState, TrashSection, MovePageDialog, PageEmoji } from "./library-components";
import { flattenTree, DndTree } from "./library-tree";
import { useVaultSections } from "./use-vault-sections";
import { useVaults, type Vault } from "@/hooks/use-vaults";
import { useAuth } from "@/hooks/use-auth";
import { MUTED_TITLE_ALPHA } from "@/lib/vault-title-color";
import { libraryPageTitleColor, type LibraryPageTitleColorResolver } from "./library-title-color";
import { useLibraryUnread, computeHasUnreadDescendantIds } from "@/components/library-activity-indicator";
import { HierarchySectionHeader, HIERARCHY_SECTION_HEADER_CLASS } from "@/components/hierarchy-section-header";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const log = createLogger("LibraryTab");

const SIDEBAR_WIDTH_KEY = "library-sidebar-width";
const EXPANDED_IDS_KEY = "library-expanded-ids";
const COLLAPSED_VAULTS_KEY = "library-collapsed-vault-ids";
const TRASH_OPEN_KEY = "library-trash-open";
const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 480;

const QUIET_ROW_CLASS = "px-2 py-1.5 text-sm text-muted-foreground";

type CreatedSession = { id: string };

function buildLibraryPageDiscussMessage(page: LibraryPage): string {
  return [
    `Let's discuss this Library page: **${page.title || "Untitled"}**`,
    `Reference: @page:${page.slug}`,
  ].join("\n");
}

function stablePartitionPinned(nodes: TreeNode[]): TreeNode[] {
  const withOrderedChildren = nodes.map((node) => ({
    ...node,
    children: stablePartitionPinned(node.children),
  }));
  return [
    ...withOrderedChildren.filter((node) => node.isPinned),
    ...withOrderedChildren.filter((node) => !node.isPinned),
  ];
}

function patchPinnedTree(nodes: TreeNode[], id: string, isPinned: boolean): TreeNode[] {
  return stablePartitionPinned(
    nodes.map((node) => ({
      ...node,
      isPinned: node.id === id ? isPinned : node.isPinned,
      children: patchPinnedTree(node.children, id, isPinned),
    })),
  );
}

/**
 * Vault section header: a collapsible disclosure trigger (mirroring the Session
 * menu's collapsible group headers) plus a "..." actions menu whose Add Page
 * item creates a page at this vault's root. The menu button is a sibling of the
 * trigger — not a child — so the two buttons never nest, exactly like the page
 * rows in the tree.
 */
function VaultSectionHeader({
  vault,
  open,
  onAddPage,
}: {
  vault: Vault;
  open: boolean;
  onAddPage: () => void;
}) {
  return (
    <div
      className="group relative mt-2 min-w-0"
      data-testid={`library-vault-section-${vault.id}`}
    >
      <CollapsibleTrigger
        className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
        data-testid={`button-vault-section-${vault.id}`}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate pr-6 text-left">{vault.name}</span>
      </CollapsibleTrigger>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-border/40 bg-background text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            data-testid={`button-vault-menu-${vault.id}`}
            aria-label={`${vault.name} actions`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[140px]" onCloseAutoFocus={(e) => e.preventDefault()}>
          <DropdownMenuItem onClick={onAddPage} data-testid={`menu-vault-add-page-${vault.id}`}>
            <FilePlus className="h-3.5 w-3.5 mr-2" /> Add Page
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function SharedTreeSection({
  rootNodes,
  selectedId,
  expandedIds,
  onSelect,
  onDownload,
  onDiscuss,
  discussingPageId,
  toggleExpand,
  unreadIds,
  hasUnreadDescendantIds,
  resolveTitleColor,
}: {
  rootNodes: TreeNode[];
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (id: string, slug?: string) => void;
  onDownload: (node: TreeNode) => void;
  onDiscuss: (page: LibraryPage) => void;
  discussingPageId: string | null;
  toggleExpand: (id: string) => void;
  unreadIds: Set<string>;
  hasUnreadDescendantIds: Set<string>;
  resolveTitleColor: LibraryPageTitleColorResolver;
}) {
  const flatNodes = useMemo(() => flattenTree(rootNodes, 0, null, expandedIds), [rootNodes, expandedIds]);
  const flatNodeIds = useMemo(() => flatNodes.map((node) => node.id), [flatNodes]);
  const flatNodeMap = useMemo(() => new Map(flatNodes.map((node) => [node.id, node])), [flatNodes]);

  return (
    <div className="mb-1 min-w-0" data-testid="library-shared-section">
      <HierarchySectionHeader className="mt-2">
        <span className="truncate">Shared</span>
      </HierarchySectionHeader>
      <DndTree
        treeData={rootNodes}
        flatNodes={flatNodes}
        flatNodeIds={flatNodeIds}
        flatNodeMap={flatNodeMap}
        selectedId={selectedId}
        expandedIds={expandedIds}
        dragActiveId={null}
        dropTarget={null}
        onDragActiveIdChange={() => undefined}
        onDropTargetChange={() => undefined}
        onSelect={onSelect}
        onCreateChild={() => undefined}
        onSetEmoji={() => undefined}
        onDelete={() => undefined}
        onDownload={onDownload}
        onEnrich={() => undefined}
        onMove={() => undefined}
        onTogglePin={() => undefined}
        onDiscuss={onDiscuss}
        discussingPageId={discussingPageId}
        onReorder={() => undefined}
        toggleExpand={toggleExpand}
        unreadIds={unreadIds}
        hasUnreadDescendantIds={hasUnreadDescendantIds}
        resolveTitleColor={resolveTitleColor}
        readOnly
      />
    </div>
  );
}

interface VaultTreeSectionProps {
  vault: Vault;
  rootNodes: TreeNode[];
  /** Active title search; federates the Drive branch (title-only) with the native page filter. */
  searchQuery: string;
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (id: string, slug?: string) => void;
  onCreateChild: (parentId: string) => void;
  onSetEmoji: (id: string, emoji: string | null) => void;
  onDelete: (id: string) => void;
  onDownload: (node: TreeNode) => void;
  onEnrich: (id: string) => void;
  onMove: (id: string) => void;
  onTogglePin: (id: string, isPinned: boolean) => void;
  onDiscuss: (page: LibraryPage) => void;
  discussingPageId: string | null;
  onReorder: (data: { id: string; parentId: string | null; sortOrder: number }) => void;
  toggleExpand: (id: string) => void;
  unreadIds: Set<string>;
  hasUnreadDescendantIds: Set<string>;
  resolveTitleColor: LibraryPageTitleColorResolver;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddPage: () => void;
}

/**
 * One vault section: a header plus a self-contained DndTree over that vault's
 * root nodes. Each section owns its own drag state, which keeps direct
 * drag-and-drop reordering inside the displayed vault. Cross-vault transfers
 * remain an explicit Move-dialog action with a named destination vault.
 */
function VaultTreeSection({
  vault, rootNodes, searchQuery, selectedId, expandedIds,
  onSelect, onCreateChild, onSetEmoji, onDelete, onDownload, onEnrich, onMove, onTogglePin, onDiscuss, discussingPageId, onReorder, toggleExpand,
  unreadIds, hasUnreadDescendantIds, resolveTitleColor,
  open, onOpenChange, onAddPage,
}: VaultTreeSectionProps) {
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; position: DropPosition } | null>(null);
  const flatNodes = useMemo(() => flattenTree(rootNodes, 0, null, expandedIds), [rootNodes, expandedIds]);
  const flatNodeIds = useMemo(() => flatNodes.map(n => n.id), [flatNodes]);
  const flatNodeMap = useMemo(() => new Map(flatNodes.map(n => [n.id, n])), [flatNodes]);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="mb-1 min-w-0">
      <VaultSectionHeader vault={vault} open={open} onAddPage={onAddPage} />
      <CollapsibleContent>
        {rootNodes.length === 0 ? (
          <div className={QUIET_ROW_CLASS}>No pages yet.</div>
        ) : (
          <DndTree
            treeData={rootNodes}
            flatNodes={flatNodes}
            flatNodeIds={flatNodeIds}
            flatNodeMap={flatNodeMap}
            selectedId={selectedId}
            expandedIds={expandedIds}
            dragActiveId={dragActiveId}
            dropTarget={dropTarget}
            onDragActiveIdChange={setDragActiveId}
            onDropTargetChange={setDropTarget}
            onSelect={onSelect}
            onCreateChild={onCreateChild}
            onSetEmoji={onSetEmoji}
            onDelete={onDelete}
            onDownload={onDownload}
            onEnrich={onEnrich}
            onMove={onMove}
            onTogglePin={onTogglePin}
            onDiscuss={onDiscuss}
            discussingPageId={discussingPageId}
            onReorder={onReorder}
            toggleExpand={toggleExpand}
            unreadIds={unreadIds}
            hasUnreadDescendantIds={hasUnreadDescendantIds}
            resolveTitleColor={resolveTitleColor}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

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
  const [treeMoveId, setTreeMoveId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(TRASH_OPEN_KEY) === "1"; } catch { return false; }
  });
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
  const { vaults, activeVaultId } = useVaults();
  const { user } = useAuth();
  const vaultById = useMemo(() => new Map(vaults.map((vault) => [vault.id, vault])), [vaults]);
  const defaultVaultId = useMemo(() => vaults.find((vault) => vault.isDefault)?.id ?? null, [vaults]);
  const resolveTitleColor = useCallback<LibraryPageTitleColorResolver>(
    (page, alpha) => libraryPageTitleColor(page, defaultVaultId, vaultById, activeVaultId, alpha),
    [activeVaultId, defaultVaultId, vaultById],
  );

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

  const { data: trashedPages = [] } = useQuery<LibraryPage[]>({
    queryKey: ["/api/info/library/trash"],
  });

  const { toast } = useToast();
  const { route, setSessionForRoute, setWidgetOpen } = useFocusSession();
  const discussMutation = useMutation({
    mutationFn: async (page: LibraryPage) => {
      const response = await apiRequest("POST", "/api/sessions", {
        title: page.title.trim().slice(0, 80) || "Library Page",
      });
      const session: CreatedSession = await response.json();
      await apiRequest("POST", `/api/sessions/${session.id}/messages`, {
        content: buildLibraryPageDiscussMessage(page),
      });
      return session;
    },
    onSuccess: (session) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
      setSessionForRoute(route, session.id);
      setWidgetOpen(true);
    },
    onError: (error: Error) => {
      toast({
        title: "Could not start discussion",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  const discussPage = useCallback((page: LibraryPage) => {
    if (!discussMutation.isPending) discussMutation.mutate(page);
  }, [discussMutation]);

  const pinMutation = useMutation({
    mutationFn: async ({ id, isPinned }: { id: string; isPinned: boolean }) => {
      const response = await apiRequest("PATCH", `/api/info/library/${id}`, { isPinned });
      return response.json() as Promise<LibraryPageFull>;
    },
    onMutate: async ({ id, isPinned }: { id: string; isPinned: boolean }) => {
      const listKey = ["/api/info/library"];
      const treeKey = ["/api/info/library/tree"];
      const detailKey = ["/api/info/library", id];
      await Promise.all([
        queryClient.cancelQueries({ queryKey: listKey }),
        queryClient.cancelQueries({ queryKey: treeKey }),
        queryClient.cancelQueries({ queryKey: detailKey }),
      ]);
      const snapshot = {
        list: queryClient.getQueryData<LibraryPage[]>(listKey),
        tree: queryClient.getQueryData<TreeNode[]>(treeKey),
        detail: queryClient.getQueryData<LibraryPageFull>(detailKey),
      };
      queryClient.setQueryData<LibraryPage[]>(listKey, (old) =>
        old?.map((page) => page.id === id ? { ...page, isPinned } : page),
      );
      queryClient.setQueryData<TreeNode[]>(treeKey, (old) =>
        old ? patchPinnedTree(old, id, isPinned) : old,
      );
      queryClient.setQueryData<LibraryPageFull>(detailKey, (old) =>
        old ? { ...old, isPinned } : old,
      );
      return snapshot;
    },
    onError: (error: Error, input, snapshot) => {
      if (snapshot) {
        queryClient.setQueryData(["/api/info/library"], snapshot.list);
        queryClient.setQueryData(["/api/info/library/tree"], snapshot.tree);
        queryClient.setQueryData(["/api/info/library", input.id], snapshot.detail);
      }
      toast({
        title: "Failed to toggle pin",
        description: error.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/info/library"] });
      queryClient.invalidateQueries({ queryKey: ["/api/info/library/tree"] });
      queryClient.invalidateQueries({ queryKey: ["/api/info/library", selectedId] });
    },
  });

  const handleTogglePin = useCallback((id: string, isPinned: boolean) => {
    pinMutation.mutate({ id, isPinned });
  }, [pinMutation]);

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

  // Per-vault section collapse state. We persist the COLLAPSED set (not the
  // expanded set) so a newly created or newly visible vault defaults to open.
  const [collapsedVaultIds, setCollapsedVaultIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(COLLAPSED_VAULTS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) return new Set<string>(parsed);
      }
    } catch { /* ignore parse errors */ }
    return new Set<string>();
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSED_VAULTS_KEY, JSON.stringify([...collapsedVaultIds]));
  }, [collapsedVaultIds]);

  useEffect(() => {
    try { localStorage.setItem(TRASH_OPEN_KEY, trashOpen ? "1" : "0"); } catch { /* ignore */ }
  }, [trashOpen]);

  const setVaultOpen = useCallback((vaultId: string, open: boolean) => {
    setCollapsedVaultIds(prev => {
      const next = new Set(prev);
      if (open) next.delete(vaultId);
      else next.add(vaultId);
      return next;
    });
  }, []);

  const selectPage = useCallback((id: string, slug?: string) => {
    setSelectedId(id);
    const resolvedSlug = slug || pages.find(p => p.id === id)?.slug;
    if (resolvedSlug) {
      window.location.hash = `library?page=${resolvedSlug}`;
    }
  }, [pages]);

  useEffect(() => {
    if (!initialSpecSlug && !initialPageSlug) setSelectedId(null);
  }, [initialSpecSlug, initialPageSlug]);

  useEffect(() => {
    const handler = () => {
      const raw = window.location.hash.replace(/^#/, "");
      if (raw.startsWith("library?page=")) {
        let pageRef = raw.slice("library?page=".length);
        if (!pageRef) return;
        try {
          pageRef = decodeURIComponent(pageRef);
        } catch {
          /* keep raw token when malformed */
        }
        // Canonical @page links emit UUID; in-app navigation prefers slug.
        const match = pages.find((p) => p.slug === pageRef || p.id === pageRef);
        if (match) setSelectedId(match.id);
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

  // Vault-aware sidebar: one section per visible vault (including empty ones)
  // plus a RECENT list. `treeData` is search-filtered so sections reflect the
  // query; RECENT derives from the full page list. Grouping/visibility come
  // from the shared hook, which reacts to top-bar vault toggles.
  const isSearching = searchQuery.trim().length > 0;
  const { sections, sharedRoots, recent, visibleVaults, isLoading: isVaultLoading } = useVaultSections({
    pages,
    treeData: filteredTreeData,
    currentUserId: user?.id ?? null,
  });
  const useSectioned = !isVaultLoading && visibleVaults.length > 0;
  const renderedSections = useMemo(
    () => (isSearching ? sections.filter((s) => s.rootNodes.length > 0) : sections),
    [isSearching, sections],
  );

  const reorderMutation = useApiMutation<{ id: string; parentId: string | null; destinationVaultId: string; sortOrder: number }>({
    method: "PATCH",
    path: "/api/info/library/reorder",
    invalidateKeys: [["/api/info/library/tree"], ["/api/info/library"]],
    errorTitle: "Reorder failed",
    // The reorder endpoint returns 409 when it loses a serialization race
    // with another reorder or a `library` tool write under the same parent.
    // Retry once with a small backoff before surfacing an error to the user.
    retryOn409: true,
  });

  const createMutation = useApiMutation<{ parentId?: string; vaultId?: string; title?: string; tags?: string[] } | undefined, LibraryPage>({
    method: "POST",
    path: "/api/info/library",
    body: (opts) => ({
      title: opts?.title ?? "",
      content: null,
      plainTextContent: "",
      parentId: opts?.parentId || null,
      vaultId: opts?.vaultId || undefined,
      tags: opts?.tags || [],
    }),
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"]],
    errorTitle: "Failed to create page",
    onSuccess: (page, opts) => {
      if (opts?.parentId) {
        setExpandedIds(prev => { const next = new Set(prev); next.add(opts.parentId!); return next; });
      }
      selectPage(page.id, page.slug);
    },
  });

  // Delete is now a one-click, reversible action: the page goes to Trash (no
  // confirmation gate). Only the irreversible Empty Trash step is gated. Refresh
  // the trash list so the deleted subtree appears there immediately.
  const deleteMutation = useApiMutation<string>({
    method: "DELETE",
    path: (id) => `/api/info/library/${id}`,
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"], ["/api/info/library/trash"]],
    successMessage: (pageId) => `${pages.find((page) => page.id === pageId)?.title || "Page"} moved to Trash`,
    errorTitle: "Delete failed",
    onSuccess: (_result, pageId) => {
      setSelectedId((current) => (current === pageId ? null : current));
    },
  });

  const restoreMutation = useApiMutation<string>({
    method: "POST",
    path: (id) => `/api/info/library/${id}/restore`,
    body: () => null,
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"], ["/api/info/library/trash"]],
    successMessage: (_result, pageId) => `${trashedPages.find((p) => p.id === pageId)?.title || "Page"} restored`,
    errorTitle: "Restore failed",
    onSettled: () => setRestoringId(null),
  });

  const handleRestore = useCallback((id: string) => {
    setRestoringId(id);
    restoreMutation.mutate(id);
  }, [restoreMutation]);

  // Empty Trash — the only irreversible action in the feature. The visible
  // trashed set (vault toggles + active chip) is computed inside TrashSection,
  // which passes those exact ids here after a counted confirmation. The server
  // re-validates them to trashed + owned rows before hard-deleting.
  const emptyTrashMutation = useApiMutation<string[]>({
    method: "POST",
    path: "/api/info/library/trash/empty",
    body: (ids) => ({ pageIds: ids }),
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"], ["/api/info/library/trash"]],
    successMessage: (_result, ids) => `Permanently deleted ${ids.length} ${ids.length === 1 ? "page" : "pages"}`,
    errorTitle: "Empty Trash failed",
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
          ) : (
            <>
              {!isSearching && (
                <div className="mb-1 min-w-0" data-testid="library-recent-section">
                  <HierarchySectionHeader className="mt-2">
                    <span className="truncate">Recent</span>
                  </HierarchySectionHeader>
                  {recent.length === 0 ? (
                    <div className={QUIET_ROW_CLASS}>Nothing recent yet.</div>
                  ) : (
                    recent.map((p) => {
                      const titleColor = resolveTitleColor(
                        p,
                        unreadIds.has(p.id) ? 1 : MUTED_TITLE_ALPHA,
                      );
                      const titleStyle = titleColor ? { color: titleColor } : undefined;
                      return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => selectPage(p.id, p.slug)}
                        className={cn(
                          "flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-accent/50",
                          selectedId === p.id && "bg-accent",
                        )}
                        data-testid={`library-recent-${p.id}`}
                      >
                        <span style={titleStyle}><PageEmoji emoji={p.emoji} size="xs" /></span>
                        <span className="min-w-0 flex-1 truncate text-left" style={titleStyle}>{p.title || "Untitled"}</span>
                      </button>
                      );
                    })
                  )}
                </div>
              )}
              {useSectioned ? (
                renderedSections.length === 0 && sharedRoots.length === 0 ? (
                  <div className={QUIET_ROW_CLASS}>{isSearching ? "No matching pages." : "No pages yet."}</div>
                ) : (
                  <>
                  {renderedSections.map((section) => (
                    <VaultTreeSection
                      key={section.vault.id}
                      vault={section.vault}
                      rootNodes={section.rootNodes}
                      searchQuery={searchQuery}
                      selectedId={selectedId}
                      expandedIds={expandedIds}
                      onSelect={selectPage}
                      onCreateChild={(parentId) => createMutation.mutate({ parentId })}
                      onSetEmoji={(id, emoji) => emojiMutation.mutate({ id, emoji })}
                      onDelete={(id) => deleteMutation.mutate(id)}
                      onDownload={handleTreeDownload}
                      onEnrich={(id) => enrichMutation.mutate(id)}
                      onMove={(id) => setTreeMoveId(id)}
                      onTogglePin={handleTogglePin}
                      onDiscuss={discussPage}
                      discussingPageId={discussMutation.isPending ? discussMutation.variables?.id ?? null : null}
                      onReorder={(data) => reorderMutation.mutate({ ...data, destinationVaultId: section.vault.id })}
                      toggleExpand={toggleExpand}
                      unreadIds={unreadIds}
                      hasUnreadDescendantIds={hasUnreadDescendantIds}
                      resolveTitleColor={resolveTitleColor}
                      open={isSearching ? true : !collapsedVaultIds.has(section.vault.id)}
                      onOpenChange={(next) => setVaultOpen(section.vault.id, next)}
                      onAddPage={() => {
                        setVaultOpen(section.vault.id, true);
                        createMutation.mutate({ vaultId: section.vault.id });
                      }}
                    />
                  ))}
                  {sharedRoots.length > 0 && (
                    <SharedTreeSection
                      rootNodes={sharedRoots}
                      selectedId={selectedId}
                      expandedIds={expandedIds}
                      onSelect={selectPage}
                      onDownload={handleTreeDownload}
                      onDiscuss={discussPage}
                      discussingPageId={discussMutation.isPending ? discussMutation.variables?.id ?? null : null}
                      toggleExpand={toggleExpand}
                      unreadIds={unreadIds}
                      hasUnreadDescendantIds={hasUnreadDescendantIds}
                      resolveTitleColor={resolveTitleColor}
                    />
                  )}
                  </>
                )
              ) : filteredTreeData.length === 0 ? (
                <div className={QUIET_ROW_CLASS}>{searchQuery ? "No matching pages." : "No pages yet."}</div>
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
                  onDelete={(id) => deleteMutation.mutate(id)}
                  onDownload={handleTreeDownload}
                  onEnrich={(id) => enrichMutation.mutate(id)}
                  onMove={(id) => setTreeMoveId(id)}
                  onTogglePin={handleTogglePin}
                  onDiscuss={discussPage}
                  discussingPageId={discussMutation.isPending ? discussMutation.variables?.id ?? null : null}
                  onReorder={(data) => {
                    const destinationVaultId = data.parentId
                      ? pages.find((candidate) => candidate.id === data.parentId)?.vaultId
                      : pages.find((candidate) => candidate.id === data.id)?.vaultId;
                    if (destinationVaultId) {
                      reorderMutation.mutate({ ...data, destinationVaultId });
                    }
                  }}
                  toggleExpand={toggleExpand}
                  unreadIds={unreadIds}
                  hasUnreadDescendantIds={hasUnreadDescendantIds}
                  resolveTitleColor={resolveTitleColor}
                />
              )}
            </>
          )}
          <TrashSection
            trashedPages={trashedPages}
            resolveTitleColor={resolveTitleColor}
            open={trashOpen}
            onOpenChange={setTrashOpen}
            onRestore={handleRestore}
            restorePendingId={restoringId}
            onEmptyTrash={(ids) => emptyTrashMutation.mutate(ids)}
            emptyTrashPending={emptyTrashMutation.isPending}
          />
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
              onTogglePin={handleTogglePin}
              onDiscuss={discussPage}
              discussPending={discussMutation.isPending && discussMutation.variables?.id === selectedPageFull.id}
              resolveTitleColor={resolveTitleColor}
              onDeleteRequest={(id) => deleteMutation.mutate(id)}
            />
          )
        ) : (
          <EmptyLibraryState onCreate={() => createMutation.mutate({})} />
        )}
      </div>
      )}

      {treeMoveId && (() => {
        const movePage = pages.find(p => p.id === treeMoveId);
        if (!movePage) return null;
        return (
          <MovePageDialog
            open={true}
            onOpenChange={(open) => { if (!open) setTreeMoveId(null); }}
            page={movePage}
            pages={pages}
            resolveTitleColor={resolveTitleColor}
          />
        );
      })()}
    </div>
  );
}
