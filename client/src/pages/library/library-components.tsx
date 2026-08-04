// Use createLogger for logging ONLY
import { createLogger } from "@/lib/logger";
import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useEditableContent } from "@/hooks/use-editable-content";
import { useApiMutation } from "@/hooks/use-api-mutation";
import { downloadPageAsMarkdown } from "@/lib/editor-utils";
import { markdownToTiptap, normalizeTiptapDoc } from "@shared/markdown-tiptap";
import { parseReferenceText } from "@shared/reference-parser";
import { createReferenceRef, type ReferenceRef } from "@shared/references";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RichTextEditor, type RichTextEditorHandle } from "@/components/rich-text-editor";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Trash2, FileText, BookOpen, Download, MoreHorizontal, Loader2, FilePlus, Search, Info, FolderInput, Globe, ChevronRight, RotateCcw, Pin, MessageSquare, Share2,
} from "lucide-react";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import type { JSONContent } from "@tiptap/core";
import type { LibraryPage, LibraryPageFull, TreeNode } from "./types";
import { useVisibleVaults } from "./use-vault-sections";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HIERARCHY_SECTION_HEADER_CLASS } from "@/components/hierarchy-section-header";
import { useVaults, type Vault } from "@/hooks/use-vaults";
import type { LibraryPageTitleColorResolver } from "./library-title-color";
import { MUTED_TITLE_ALPHA } from "@/lib/vault-title-color";
import { UniversalTagPicker } from "@/components/universal-tag-picker";
import { ShareSheet } from "@/components/sharing/share-sheet";
import { semanticLibraryTags, structuralLibraryTags } from "@shared/library-tags";


const log = createLogger("LibraryComponents");

export function PageEmoji({ emoji, size = "sm" }: { emoji: string | null; size?: "xs" | "sm" | "md" }) {
  const sizeClass = size === "md" ? "text-base h-4 w-4" : size === "xs" ? "text-xs h-3.5 w-3.5" : "text-sm h-4 w-4";
  if (emoji) return <span className={cn("shrink-0 leading-none flex items-center justify-center", sizeClass)}>{emoji}</span>;
  return <FileText className={cn("shrink-0 text-muted-foreground", sizeClass)} />;
}

function extractWikiLinkTitles(plainText: string): string[] {
  const matches = [...plainText.matchAll(/\[\[([^\]]+)\]\]/g)];
  return matches.map(m => m[1]);
}

interface LinkedSessionInfo {
  sessionId: string;
  title: string;
  sessionType: string;
  createdAt: string;
}

function extractPageReferences(plainText: string, pages: LibraryPage[]): ReferenceRef[] {
  const references = parseReferenceText(plainText)
    .filter((part): part is { kind: "reference"; ref: ReferenceRef } => part.kind === "reference")
    .map((part) => part.ref);

  for (const title of extractWikiLinkTitles(plainText)) {
    const page = pages.find((candidate) => candidate.title.toLowerCase() === title.toLowerCase());
    if (page) references.push(createReferenceRef({ type: "page", id: page.id, metadata: { label: page.title } }));
  }

  const seen = new Set<string>();
  return references.filter((reference) => {
    if (seen.has(reference.canonical)) return false;
    seen.add(reference.canonical);
    return true;
  });
}

function PageLinks({ slug, plainText, pages }: { slug: string; plainText: string; pages: LibraryPage[] }) {
  const { data: sessions = [] } = useQuery<LinkedSessionInfo[]>({
    queryKey: ["/api/library", slug, "sessions"],
    queryFn: () => fetch(`/api/library/${slug}/sessions`).then(r => r.json()),
    enabled: !!slug,
  });

  const links = useMemo(() => {
    const references = extractPageReferences(plainText, pages);
    const seen = new Set(references.map((reference) => reference.canonical));

    for (const session of sessions) {
      const reference = createReferenceRef({
        type: "session",
        id: session.sessionId,
        metadata: {
          label: session.title || "Untitled",
          href: `/session?c=${encodeURIComponent(session.sessionId)}`,
        },
      });
      if (seen.has(reference.canonical)) continue;
      seen.add(reference.canonical);
      references.push(reference);
    }

    return references;
  }, [pages, plainText, sessions]);

  if (links.length === 0) return null;

  return (
    <div className="border-t border-border/60 px-10 py-3 space-y-1.5" data-testid="library-page-links">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Links</div>
      <div className="flex flex-col items-start gap-1.5">
        {links.map((reference) => (
          <ReferenceRenderer
            key={reference.canonical}
            refValue={reference}
            surface="chat-inline"
            className="max-w-full text-sm"
          />
        ))}
      </div>
    </div>
  );
}

function ChildPages({ pageId, pages }: { pageId: string; pages: LibraryPage[] }) {
  const children = useMemo(() => {
    const siblings = pages.filter((page) => page.parentId === pageId);
    return [
      ...siblings.filter((page) => page.isPinned),
      ...siblings.filter((page) => !page.isPinned),
    ];
  }, [pageId, pages]);

  if (children.length === 0) return null;

  return (
    <div className="border-t border-border/60 px-10 py-3 space-y-1.5" data-testid="library-child-pages">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Children</div>
      <div className="flex flex-col items-start gap-1.5">
        {children.map((page) => (
          <ReferenceRenderer
            key={page.id}
            refValue={createReferenceRef({
              type: "page",
              id: page.id,
              metadata: { label: page.title || "Untitled", href: `/info#library?page=${encodeURIComponent(page.id)}` },
            })}
            surface="chat-inline"
            className="max-w-full text-sm"
          />
        ))}
      </div>
    </div>
  );
}

interface LibraryPageEditorProps {
  selectedId: string;
  selectedPage: LibraryPageFull;
  pages: LibraryPage[];
  onTogglePin: (id: string, isPinned: boolean) => void;
  onDiscuss: (page: LibraryPage) => void;
  discussPending: boolean;
  resolveTitleColor: LibraryPageTitleColorResolver;
  onDeleteRequest?: (id: string) => void;
}

export function LibraryPageEditor({
  selectedId,
  selectedPage,
  pages,
  onTogglePin,
  onDiscuss,
  discussPending,
  resolveTitleColor,
  onDeleteRequest,
}: LibraryPageEditorProps) {
  const editorRef = useRef<RichTextEditorHandle>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [specPickerOpen, setSpecPickerOpen] = useState(false);
  const [specPickerQuery, setSpecPickerQuery] = useState("");
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [bodyFocused, setBodyFocused] = useState(false);
  const [isTitleEditing, setIsTitleEditing] = useState(() => !selectedPage.title && !selectedPage.plainTextContent?.trim());
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const titleColor = resolveTitleColor(selectedPage, 1);
  const titleStyle = titleColor ? { color: titleColor } : undefined;

  useEffect(() => {
    const nextTarget = document.getElementById("library-page-header-slot");
    if (nextTarget !== headerTarget) setHeaderTarget(nextTarget);
  });

  const selectedPageContent = useMemo((): JSONContent | null => {
    const rawContent = selectedPage.content;
    // Always normalize — stored docs may predate schema-safe table/cell emission.
    const normalized = normalizeTiptapDoc(rawContent);
    if (normalized) {
      log.debug("[LibraryContent] using rich content", {
        pageId: selectedPage.id,
        contentSize: JSON.stringify(normalized).length,
      });
      return normalized;
    }
    if (selectedPage.plainTextContent) {
      log.warn("[LibraryContent] page has no valid rich content, falling back to plainText conversion", {
        pageId: selectedPage.id,
        plainTextLength: selectedPage.plainTextContent.length,
      });
      return markdownToTiptap(selectedPage.plainTextContent);
    }
    log.error("[LibraryContent] page has no content at all", { pageId: selectedPage.id });
    return null;
  }, [selectedPage.id, selectedPage.content, selectedPage.plainTextContent]);

  const saveMutation = useApiMutation<{ id: string; title: string; content: JSONContent | null; plainTextContent: string }>({
    method: "PATCH",
    path: ({ id }) => `/api/info/library/${id}`,
    body: ({ title, content, plainTextContent, id }) => {
      const wikiTitles = extractWikiLinkTitles(plainTextContent);
      const linkPageIds = wikiTitles
        .map(t => pages.find(p => p.title.toLowerCase() === t.toLowerCase())?.id)
        .filter((pid): pid is string => !!pid && pid !== id);
      return { title, content, plainTextContent, ...(linkPageIds.length > 0 ? { linkPages: linkPageIds } : {}) };
    },
    invalidateKeys: [["/api/info/library"], ["/api/info/library", selectedId]],
    errorTitle: "Save failed",
    onSuccess: (_result, input) => {
      setIsDirty(false);
      apiRequest("PATCH", `/api/info/library/${input.id}/read`).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/info/library/unread"] });
      }).catch(() => {});
    },
  });

  const {
    editTitle, editContent, editPlainText, isDirty, setIsDirty,
    handleContentChange, handleTitleChange: rawHandleTitleChange,
  } = useEditableContent({
    selectedId,
    initialTitle: selectedPage.title || "",
    initialContent: selectedPageContent,
    initialPlainText: selectedPage.plainTextContent || "",
    saveMutation,
  });

  const handleTitleChange = useCallback((value: string) => {
    queryClient.setQueryData<LibraryPage[]>(["/api/info/library"], (old) =>
      old?.map(p => p.id === selectedId ? { ...p, title: value } : p)
    );
    rawHandleTitleChange(value);
  }, [selectedId, rawHandleTitleChange]);

  const emojiMutation = useApiMutation<{ id: string; emoji: string | null }>({
    method: "PATCH",
    path: ({ id }) => `/api/info/library/${id}`,
    body: ({ emoji }) => ({ emoji }),
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"], ["/api/info/library", selectedId]],
  });

  const shareMutation = useApiMutation<{ id: string; shared: boolean }>({
    method: "PATCH",
    path: ({ id }) => `/api/info/library/${id}/share`,
    body: ({ shared }) => ({ shared }),
    invalidateKeys: [["/api/info/library"], ["/api/info/library/tree"], ["/api/info/library", selectedId]],
  });

  const isNewUntitledPage = !selectedPage.title && !selectedPage.plainTextContent?.trim();

  useEffect(() => {
    setBodyFocused(false);
  }, [selectedId]);

  useEffect(() => {
    setIsTitleEditing(isNewUntitledPage);
  }, [isNewUntitledPage, selectedId]);

  return (
    <>
      {headerTarget && createPortal(
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Popover open={emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
            <PopoverTrigger asChild>
            <button className="shrink-0 h-7 w-7 flex items-center justify-center rounded hover:bg-accent transition-colors" style={titleStyle} data-testid="button-emoji-picker" title="Set page icon">
              <PageEmoji emoji={selectedPage.emoji} size="md" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0 border-0" sideOffset={4}>
            <Picker data={data} onEmojiSelect={(emoji: { native: string }) => { emojiMutation.mutate({ id: selectedPage.id, emoji: emoji.native }); setEmojiPickerOpen(false); }} theme="light" previewPosition="none" skinTonePosition="search" />
            {selectedPage.emoji && (
              <button className="w-full text-xs text-muted-foreground hover:text-foreground py-2 hover:bg-accent transition-colors border-t" data-testid="button-remove-emoji" onClick={() => { emojiMutation.mutate({ id: selectedPage.id, emoji: null }); setEmojiPickerOpen(false); }}>
                Remove icon
              </button>
            )}
          </PopoverContent>
        </Popover>
        {isTitleEditing ? (
          <Input
            value={editTitle}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => handleTitleChange(e.target.value)}
            onBlur={() => setIsTitleEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                setIsTitleEditing(false);
                editorRef.current?.focus();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setIsTitleEditing(false);
              }
            }}
            placeholder="New page"
            className="min-w-0 flex-1 h-7 border-none bg-transparent p-0 text-sm font-medium shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
            style={titleStyle}
            data-testid="input-library-title"
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground transition-opacity hover:opacity-80"
            style={titleStyle}
            onClick={() => setIsTitleEditing(true)}
            title={editTitle || "Untitled"}
            data-testid="button-edit-library-title"
          >
            {editTitle || "Untitled"}
          </button>
        )}
        <div className={cn("ml-auto flex shrink-0 items-center gap-1", bodyFocused && "invisible pointer-events-none")}>
          {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" data-testid="button-page-actions-menu" className="h-7 w-7 p-0 text-muted-foreground">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem
                disabled={discussPending}
                onClick={() => onDiscuss(selectedPage)}
                data-testid="menu-page-discuss"
              >
                {discussPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5 mr-2" />
                )}
                Discuss
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onTogglePin(selectedPage.id, !selectedPage.isPinned)} data-testid="menu-page-pin">
                <Pin
                  className={cn("h-3.5 w-3.5 mr-2", selectedPage.isPinned ? "text-foreground" : "text-muted-foreground")}
                  {...(selectedPage.isPinned ? { fill: "currentColor" } : {})}
                />
                {selectedPage.isPinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShareOpen(true)} data-testid="menu-page-share">
                <Share2 className="h-3.5 w-3.5 mr-2" /> Share
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDetailsDialogOpen(true)} data-testid="menu-page-details">
                <Info className="h-3.5 w-3.5 mr-2" /> Details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setMoveDialogOpen(true)} data-testid="menu-move-page">
                <FolderInput className="h-3.5 w-3.5 mr-2" /> Move
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => shareMutation.mutate({ id: selectedPage.id, shared: selectedPage.scope !== "shared" })} data-testid="menu-share-page">
                <Globe className="h-3.5 w-3.5 mr-2" /> {selectedPage.scope === "shared" ? "Unshare" : "Share with all users"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => downloadPageAsMarkdown(selectedPage.title, selectedPage.content, selectedPage.plainTextContent)} data-testid="menu-download-page">
                <Download className="h-3.5 w-3.5 mr-2" /> Download
              </DropdownMenuItem>
              {onDeleteRequest ? (
                <DropdownMenuItem onClick={() => onDeleteRequest(selectedPage.id)} className="text-destructive" data-testid="menu-delete-page">
                  <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </div>,
        headerTarget,
      )}
      <div className="flex-1 flex flex-col overflow-hidden">
        <RichTextEditor ref={editorRef} key={selectedId} value={editContent} onChange={handleContentChange} placeholder="Write your page content here..." className="flex-1 overflow-hidden" data-testid="editor-library-content" onInsertLink={() => { setSpecPickerQuery(""); setSpecPickerOpen(true); }} plainTextFallback={selectedPage.plainTextContent || ""} onFocusChange={setBodyFocused} contentFooter={<>
          <ChildPages pageId={selectedPage.id} pages={pages} />
          <PageLinks slug={selectedPage.slug} plainText={editPlainText} pages={pages} />
        </>} />
      </div>
      <PageLinkPickerDialog open={specPickerOpen} onOpenChange={setSpecPickerOpen} query={specPickerQuery} onQueryChange={setSpecPickerQuery} pages={pages} editorRef={editorRef} resolveTitleColor={resolveTitleColor} />
      <PageDetailsDialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen} page={selectedPage} pages={pages} />
      <MovePageDialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen} page={selectedPage} pages={pages} resolveTitleColor={resolveTitleColor} />
      <ShareSheet objectType="library_page" objectId={selectedPage.id} title={selectedPage.title} open={shareOpen} onOpenChange={setShareOpen} />
    </>
  );
}

export function EmptyLibraryState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
      <BookOpen className="h-10 w-10 opacity-20" />
      <p className="text-sm">Select a page or create a new one</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onCreate} data-testid="button-create-library-empty">
          <FilePlus className="h-3.5 w-3.5" /> New Page
        </Button>
      </div>
    </div>
  );
}

function PageLinkPickerDialog({ open, onOpenChange, query, onQueryChange, pages, editorRef, resolveTitleColor }: {
  open: boolean; onOpenChange: (open: boolean) => void; query: string; onQueryChange: (query: string) => void; pages: LibraryPage[]; editorRef: React.RefObject<RichTextEditorHandle | null>; resolveTitleColor: LibraryPageTitleColorResolver;
}) {
  const { toast } = useToast();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Insert Page Link</DialogTitle>
          <DialogDescription>Search for a page to insert a reference link.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Search pages..." className="pl-7 h-8 text-sm" data-testid="input-page-picker-search" autoFocus />
        </div>
        <ScrollArea className="max-h-48">
          {pages
            .filter(p => !query || p.title.toLowerCase().includes(query.toLowerCase()) || p.slug.includes(query.toLowerCase()))
            .map(page => {
              const titleColor = resolveTitleColor(page, MUTED_TITLE_ALPHA);
              const titleStyle = titleColor ? { color: titleColor } : undefined;
              return (
              <button key={page.id} className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-accent/50 flex items-center gap-2" data-testid={`button-page-pick-${page.id}`}
                onClick={() => {
                  const linkText = `[[${page.title}]]`;
                  if (editorRef.current) { editorRef.current.insertContent(linkText); }
                  else { navigator.clipboard.writeText(linkText).catch((err) => log.warn("clipboard write failed", err)); toast({ title: "Copied to clipboard", description: `${linkText} — paste it in your content` }); }
                  onOpenChange(false);
                }}>
                <FileText className="h-3 w-3 shrink-0" style={titleStyle} />
                <span className="truncate flex-1" style={titleStyle}>{page.title}</span>
              </button>
              );
            })}
          {pages.length === 0 && <p className="text-xs text-muted-foreground text-center py-3">No pages yet</p>}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

// ─── Trash ─────────────────────────────────────────────────────────────────

const TRASH_INDENT_STEP_PX = 16;
const TRASH_MAX_INDENT_PX = 96;
const TRASH_QUIET_ROW_CLASS = "px-2 py-1.5 text-sm text-muted-foreground";

/**
 * One row in the trashed forest. Forest roots (depth 0) are the top-level
 * trashed entries — the thing that was deleted — and carry the Restore action
 * in the standard item ellipsis menu. Descendants render intact underneath
 * without their own menu, matching the v1 "restore the whole unit" behavior.
 */
function TrashNode({
  page,
  depth,
  childrenByParent,
  onRestore,
  restorePendingId,
  resolveTitleColor,
}: {
  page: LibraryPage;
  depth: number;
  childrenByParent: Map<string, LibraryPage[]>;
  onRestore: (id: string) => void;
  restorePendingId: string | null;
  resolveTitleColor: LibraryPageTitleColorResolver;
}) {
  const children = childrenByParent.get(page.id) ?? [];
  const indentPx = Math.min(depth * TRASH_INDENT_STEP_PX, TRASH_MAX_INDENT_PX);
  const isRoot = depth === 0;
  const isRestoring = restorePendingId === page.id;
  const titleColor = resolveTitleColor(page, MUTED_TITLE_ALPHA);
  const titleStyle = titleColor ? { color: titleColor } : undefined;

  return (
    <div className="min-w-0">
      <div
        className="group flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-sm text-muted-foreground"
        data-testid={`trash-node-${page.id}`}
      >
        {indentPx > 0 && <div className="shrink-0" style={{ width: indentPx }} aria-hidden="true" />}
        <span style={titleStyle}><PageEmoji emoji={page.emoji} size="xs" /></span>
        <span className="min-w-0 flex-1 truncate" style={titleStyle}>{page.title || "Untitled"}</span>
        {isRoot && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(event) => event.stopPropagation()}
                disabled={isRestoring}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/40 bg-background text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 disabled:opacity-50"
                data-testid={`button-trash-menu-${page.id}`}
                aria-label="Trashed page actions"
              >
                {isRestoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]" onCloseAutoFocus={(event) => event.preventDefault()}>
              <DropdownMenuItem onClick={() => onRestore(page.id)} data-testid={`menu-trash-restore-${page.id}`}>
                <RotateCcw className="mr-2 h-3.5 w-3.5" /> Restore
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {children.map((child) => (
        <TrashNode
          key={child.id}
          page={child}
          depth={depth + 1}
          childrenByParent={childrenByParent}
          onRestore={onRestore}
          restorePendingId={restorePendingId}
          resolveTitleColor={resolveTitleColor}
        />
      ))}
    </div>
  );
}

/**
 * TRASH section, pinned to the bottom of the Library sidebar. Lists trashed
 * pages with hierarchy preserved (trashed subtrees render intact), respects
 * top-bar vault visibility (pages whose source vault is toggled off are hidden),
 * supports filtering Trash by vault, and places destructive/restorative actions
 * in the same ellipsis menus as the rest of Library. Restore returns a trashed
 * unit to its origin.
 */
export function TrashSection({
  trashedPages,
  resolveTitleColor,
  open,
  onOpenChange,
  onRestore,
  restorePendingId,
  onEmptyTrash,
  emptyTrashPending,
}: {
  trashedPages: LibraryPage[];
  resolveTitleColor: LibraryPageTitleColorResolver;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (id: string) => void;
  restorePendingId: string | null;
  onEmptyTrash: (ids: string[]) => void;
  emptyTrashPending: boolean;
}) {
  const { resolveVaultId, isVaultEnabled } = useVisibleVaults();
  const { vaults } = useVaults();
  const [vaultFilter, setVaultFilter] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const vaultById = useMemo(() => new Map(vaults.map((v) => [v.id, v])), [vaults]);

  // Respect top-bar vault visibility first (drop trashed pages whose resolved
  // vault is toggled off), then apply the optional in-Trash vault chip filter.
  const visibleTrashed = useMemo(
    () =>
      trashedPages.filter((p) => {
        const vid = resolveVaultId(p.vaultId);
        if (!vid || !isVaultEnabled(vid)) return false;
        if (vaultFilter && vid !== vaultFilter) return false;
        return true;
      }),
    [trashedPages, resolveVaultId, isVaultEnabled, vaultFilter],
  );

  // Chip set: visible vaults that currently hold trashed pages (ignores the
  // active chip filter so you can always switch/clear it).
  const chipVaultIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of trashedPages) {
      const vid = resolveVaultId(p.vaultId);
      if (vid && isVaultEnabled(vid)) ids.add(vid);
    }
    return [...ids];
  }, [trashedPages, resolveVaultId, isVaultEnabled]);

  // Build the trashed forest: a page is a forest root when its parent is not in
  // the visible trashed set (parent was live, separately trashed, or filtered
  // out). Roots are the top-level entries Restore acts on.
  const { roots, childrenByParent } = useMemo(() => {
    const idSet = new Set(visibleTrashed.map((p) => p.id));
    const byParent = new Map<string, LibraryPage[]>();
    const rootList: LibraryPage[] = [];
    for (const p of visibleTrashed) {
      if (p.parentId && idSet.has(p.parentId)) {
        const arr = byParent.get(p.parentId) ?? [];
        arr.push(p);
        byParent.set(p.parentId, arr);
      } else {
        rootList.push(p);
      }
    }
    return { roots: rootList, childrenByParent: byParent };
  }, [visibleTrashed]);

  const totalCount = visibleTrashed.length;

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="mb-1 mt-2 min-w-0"
      data-testid="library-trash-section"
    >
      <div className="group relative min-w-0">
        <CollapsibleTrigger
          className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
          data-testid="button-trash-section"
        >
          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
          <Trash2 className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate pr-6 text-left">Trash</span>
        </CollapsibleTrigger>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              disabled={emptyTrashPending}
              className="absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-border/40 bg-background text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 disabled:opacity-50"
              data-testid="button-trash-actions"
              aria-label="Trash actions"
            >
              {emptyTrashPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]" onCloseAutoFocus={(event) => event.preventDefault()}>
            <DropdownMenuItem
              onClick={() => setConfirmOpen(true)}
              disabled={totalCount === 0}
              className="text-destructive"
              data-testid="menu-empty-trash"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Empty Trash
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CollapsibleContent>
        {totalCount === 0 ? (
          <div className={TRASH_QUIET_ROW_CLASS}>Trash is empty.</div>
        ) : (
          <>
            {chipVaultIds.length > 1 && (
              <div className="flex flex-wrap gap-1 px-2 py-1.5">
                {chipVaultIds.map((vid) => {
                  const v = vaultById.get(vid);
                  if (!v) return null;
                  const active = vaultFilter === vid;
                  return (
                    <button
                      key={vid}
                      type="button"
                      onClick={() => setVaultFilter(active ? null : vid)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-xs font-medium transition-colors",
                        active ? "border-transparent bg-accent" : "border-border/50 hover:bg-accent/50",
                      )}
                      style={{ color: v.color ?? undefined }}
                      data-testid={`trash-vault-chip-${vid}`}
                    >
                      {v.name}
                    </button>
                  );
                })}
              </div>
            )}
            {roots.map((root) => (
              <TrashNode
                key={root.id}
                page={root}
                depth={0}
                childrenByParent={childrenByParent}
                onRestore={onRestore}
                restorePendingId={restorePendingId}
                resolveTitleColor={resolveTitleColor}
              />
            ))}
          </>
        )}
      </CollapsibleContent>
      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          if (!emptyTrashPending) setConfirmOpen(o);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Empty Trash</DialogTitle>
            <DialogDescription>
              Permanently delete {totalCount} {totalCount === 1 ? "page" : "pages"}? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={emptyTrashPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onEmptyTrash(visibleTrashed.map((p) => p.id));
                setConfirmOpen(false);
              }}
              disabled={emptyTrashPending || totalCount === 0}
              data-testid="button-confirm-empty-trash"
            >
              {emptyTrashPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Delete {totalCount}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Collapsible>
  );
}

function PageDetailsDialog({ open, onOpenChange, page, pages }: {
  open: boolean; onOpenChange: (open: boolean) => void; page: LibraryPageFull; pages: LibraryPage[];
}) {
  const parent = page.parentId ? pages.find(p => p.id === page.parentId) : null;
  const tagsMutation = useApiMutation<{ tags: string[] }>({
    method: "PATCH",
    path: `/api/info/library/${page.id}`,
    body: ({ tags }) => ({ tags }),
    invalidateKeys: [
      ["/api/info/library"],
      ["/api/info/library/tree"],
      ["/api/tags"],
    ],
    errorTitle: "Failed to update tags",
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Page Details</DialogTitle>
          <DialogDescription>Metadata for "{page.title || "Untitled"}"</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <DetailRow label="ID" value={`#${page.pageId}`} mono />
          <DetailRow label="Slug" value={page.slug} mono />
          {parent && <DetailRow label="Parent" value={parent.title || "Untitled"} />}
          {page.oneLiner && <DetailRow label="One-liner" value={page.oneLiner} />}
          {page.summary && <DetailRow label="Summary" value={page.summary} />}
          <div className="flex gap-2">
            <span className="text-muted-foreground shrink-0 w-20 pt-1">Tags</span>
            <div className="min-w-0 flex-1">
              <UniversalTagPicker
                variant="compact"
                selected={semanticLibraryTags(page.tags)}
                onChange={(next) => tagsMutation.mutate({ tags: [...structuralLibraryTags(page.tags), ...next] })}
                placeholder="Add tag"
                testId="input-library-page-tags"
                className="min-h-8 rounded-md border border-input px-2 py-1"
              />
            </div>
          </div>
          <DetailRow label="Created" value={new Date(page.createdAt).toLocaleString()} />
          <DetailRow label="Updated" value={new Date(page.updatedAt).toLocaleString()} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0 w-20">{label}</span>
      <span className={cn("break-all", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

function getDescendantIds(pages: LibraryPage[], rootId: string): Set<string> {
  const descendants = new Set<string>();
  const walk = (parentId: string) => {
    for (const p of pages) {
      if (p.parentId === parentId && !descendants.has(p.id)) {
        descendants.add(p.id);
        walk(p.id);
      }
    }
  };
  walk(rootId);
  return descendants;
}

export function MovePageDialog({ open, onOpenChange, page, pages, resolveTitleColor }: {
  open: boolean; onOpenChange: (open: boolean) => void; page: LibraryPage | LibraryPageFull; pages: LibraryPage[]; resolveTitleColor: LibraryPageTitleColorResolver;
}) {
  const [query, setQuery] = useState("");
  const { visibleVaults, resolveVaultId, isLoading: areVaultsLoading } = useVisibleVaults();

  interface MovePageInput {
    id: string;
    parentId: string | null;
    destinationVaultId: string;
  }

  const moveMutation = useApiMutation<MovePageInput>({
    method: "PATCH",
    path: ({ id }) => `/api/info/library/${id}`,
    body: ({ parentId, destinationVaultId }) => ({ parentId, destinationVaultId }),
    invalidateKeys: [
      ["/api/info/library"],
      ["/api/info/library/tree"],
    ],
    successMessage: () => `${page.title || "Page"} moved`,
    errorTitle: "Move failed",
    onSuccess: () => onOpenChange(false),
  });

  const excludeIds = useMemo(() => {
    const ids = getDescendantIds(pages, page.id);
    ids.add(page.id);
    return ids;
  }, [pages, page.id]);

  const destinationSections = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return visibleVaults.flatMap((vault) => {
      const matchingPages = pages.filter((candidate) =>
        !excludeIds.has(candidate.id) &&
        resolveVaultId(candidate.vaultId) === vault.id &&
        (!normalizedQuery || candidate.title.toLowerCase().includes(normalizedQuery))
      );
      if (normalizedQuery && matchingPages.length === 0 && !vault.name.toLowerCase().includes(normalizedQuery)) {
        return [];
      }
      return [{ vault, pages: matchingPages }];
    });
  }, [excludeIds, pages, query, resolveVaultId, visibleVaults]);

  const currentVaultId = resolveVaultId(page.vaultId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Move Page</DialogTitle>
          <DialogDescription>Choose a vault or page for "{page.title || "Untitled"}"</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search destinations..." className="pl-7 h-8 text-sm" data-testid="input-move-search" autoFocus />
        </div>
        <ScrollArea className="h-64">
          {areVaultsLoading && (
            <p className="px-2 py-3 text-sm text-muted-foreground">Loading destinations…</p>
          )}
          {!areVaultsLoading && destinationSections.map(({ vault, pages: destinationPages }) => (
            <div key={vault.id} className="mb-2 last:mb-0">
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm font-medium hover:bg-accent/50",
                  page.parentId === null && currentVaultId === vault.id && "text-muted-foreground",
                )}
                data-testid={`button-move-vault-${vault.id}`}
                disabled={moveMutation.isPending || (page.parentId === null && currentVaultId === vault.id)}
                onClick={() => moveMutation.mutate({ id: page.id, parentId: null, destinationVaultId: vault.id })}
              >
                <FolderInput className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{vault.name}</span>
                {page.parentId === null && currentVaultId === vault.id && <span className="text-xs">Current</span>}
              </button>
              {destinationPages.map((destinationPage) => {
                const titleColor = resolveTitleColor(destinationPage, MUTED_TITLE_ALPHA);
                const titleStyle = titleColor ? { color: titleColor } : undefined;
                return (
                <button
                  type="button"
                  key={destinationPage.id}
                  className={cn(
                    "flex w-full items-center gap-2 rounded py-1.5 pl-7 pr-2 text-left text-sm hover:bg-accent/50",
                    destinationPage.id === page.parentId && "text-muted-foreground",
                  )}
                  data-testid={`button-move-${destinationPage.id}`}
                  disabled={moveMutation.isPending || destinationPage.id === page.parentId}
                  onClick={() => moveMutation.mutate({ id: page.id, parentId: destinationPage.id, destinationVaultId: vault.id })}
                >
                  <span style={titleStyle}><PageEmoji emoji={destinationPage.emoji} /></span>
                  <span className="min-w-0 flex-1 truncate" style={titleStyle}>{destinationPage.title || "Untitled"}</span>
                  {destinationPage.id === page.parentId && <span className="text-xs">Current</span>}
                </button>
                );
              })}
            </div>
          ))}
          {!areVaultsLoading && destinationSections.length === 0 && (
            <p className="px-2 py-3 text-sm text-muted-foreground">No matching destinations.</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
