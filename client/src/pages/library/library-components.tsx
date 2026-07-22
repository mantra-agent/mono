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
import { markdownToTiptap, isValidTiptapDoc } from "@shared/markdown-tiptap";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RichTextEditor, type RichTextEditorHandle } from "@/components/rich-text-editor";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Trash2, FileText, BookOpen, Download, MoreHorizontal, Loader2, FilePlus, Search, Info, FolderInput, Globe,
} from "lucide-react";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import type { JSONContent } from "@tiptap/core";
import type { LibraryPage, LibraryPageFull, TreeNode } from "./types";
import { useVisibleVaults } from "./use-vault-sections";


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

function LinkedSessions({ slug }: { slug: string }) {
  const { data: sessions } = useQuery<LinkedSessionInfo[]>({
    queryKey: ["/api/library", slug, "sessions"],
    queryFn: () => fetch(`/api/library/${slug}/sessions`).then(r => r.json()),
    enabled: !!slug,
  });

  if (!sessions?.length) return null;

  return (
    <div className="border-t border-border/60 px-10 py-3 space-y-1.5" data-testid="linked-page-sessions">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Linked sessions</div>
      <div className="space-y-1">
        {sessions.map((s) => (
          <div key={`${s.sessionId}-${s.createdAt}`} className="flex min-w-0 items-center" data-testid={`linked-session-${s.sessionId}`}>
            <ReferenceRenderer
              refValue={{
                type: "session",
                id: s.sessionId,
                canonical: `@session:${s.sessionId}`,
                metadata: { label: s.title || "Untitled", href: `/session?c=${encodeURIComponent(s.sessionId)}` },
              }}
              surface="chat-inline"
              className="max-w-full"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ChildPages({ pageId, pages }: { pageId: string; pages: LibraryPage[] }) {
  const children = useMemo(() => pages.filter((page) => page.parentId === pageId), [pageId, pages]);

  if (children.length === 0) return null;

  return (
    <div className="border-t border-border/60 px-10 py-3 space-y-1.5" data-testid="library-child-pages">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Children</div>
      <div className="flex flex-col items-start gap-1.5">
        {children.map((page) => (
          <ReferenceRenderer
            key={page.id}
            refValue={{
              type: "page",
              id: page.slug,
              canonical: `@page:${page.slug}`,
              metadata: { label: page.title || "Untitled", href: `/info#library?page=${encodeURIComponent(page.slug)}` },
            }}
            surface="chat-inline"
            className="max-w-full"
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
  onDeleteRequest?: (id: string) => void;
  library2PlacementId?: string;
  onRemoveFromLibrary2?: (placementId: string) => void;
}

export function LibraryPageEditor({
  selectedId,
  selectedPage,
  pages,
  onDeleteRequest,
  library2PlacementId,
  onRemoveFromLibrary2,
}: LibraryPageEditorProps) {
  const editorRef = useRef<RichTextEditorHandle>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [specPickerOpen, setSpecPickerOpen] = useState(false);
  const [specPickerQuery, setSpecPickerQuery] = useState("");
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [bodyFocused, setBodyFocused] = useState(false);
  const [isTitleEditing, setIsTitleEditing] = useState(() => !selectedPage.title && !selectedPage.plainTextContent?.trim());
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const nextTarget = document.getElementById("library-page-header-slot");
    if (nextTarget !== headerTarget) setHeaderTarget(nextTarget);
  });

  const selectedPageContent = useMemo((): JSONContent | null => {
    const rawContent = selectedPage.content;
    if (isValidTiptapDoc(rawContent)) {
      log.debug("[LibraryContent] using rich content", { pageId: selectedPage.id, contentSize: JSON.stringify(rawContent).length });
      return rawContent;
    }
    if (selectedPage.plainTextContent) {
      log.warn("[LibraryContent] page has no valid rich content, falling back to plainText conversion", { pageId: selectedPage.id, plainTextLength: selectedPage.plainTextContent.length });
      return markdownToTiptap(selectedPage.plainTextContent);
    }
    log.warn("[LibraryContent] page has no content at all", { pageId: selectedPage.id });
    return rawContent;
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
    editTitle, editContent, isDirty, setIsDirty,
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
            <button className="shrink-0 h-7 w-7 flex items-center justify-center rounded hover:bg-accent transition-colors" data-testid="button-emoji-picker" title="Set page icon">
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
            data-testid="input-library-title"
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground hover:text-cta"
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
              {library2PlacementId && onRemoveFromLibrary2 ? (
                <DropdownMenuItem onClick={() => onRemoveFromLibrary2(library2PlacementId)} data-testid="menu-remove-library2-placement">
                  <Trash2 className="h-3.5 w-3.5 mr-2" /> Remove from Library2
                </DropdownMenuItem>
              ) : onDeleteRequest ? (
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
          <LinkedSessions slug={selectedPage.slug} />
        </>} />
      </div>
      <PageLinkPickerDialog open={specPickerOpen} onOpenChange={setSpecPickerOpen} query={specPickerQuery} onQueryChange={setSpecPickerQuery} pages={pages} editorRef={editorRef} />
      <PageDetailsDialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen} page={selectedPage} pages={pages} />
      <MovePageDialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen} page={selectedPage} pages={pages} />
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

function PageLinkPickerDialog({ open, onOpenChange, query, onQueryChange, pages, editorRef }: {
  open: boolean; onOpenChange: (open: boolean) => void; query: string; onQueryChange: (query: string) => void; pages: LibraryPage[]; editorRef: React.RefObject<RichTextEditorHandle | null>;
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
            .map(page => (
              <button key={page.id} className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-accent/50 flex items-center gap-2" data-testid={`button-page-pick-${page.id}`}
                onClick={() => {
                  const linkText = `[[${page.title}]]`;
                  if (editorRef.current) { editorRef.current.insertContent(linkText); }
                  else { navigator.clipboard.writeText(linkText).catch((err) => log.warn("clipboard write failed", err)); toast({ title: "Copied to clipboard", description: `${linkText} — paste it in your content` }); }
                  onOpenChange(false);
                }}>
                <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="truncate flex-1">{page.title}</span>
              </button>
            ))}
          {pages.length === 0 && <p className="text-xs text-muted-foreground text-center py-3">No pages yet</p>}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

export function DeletePageDialog({ open, onOpenChange, pageTitle, isPending, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; pageTitle: string; isPending: boolean; onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete Page</DialogTitle>
          <DialogDescription>Are you sure you want to delete "{pageTitle}"? This action cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} data-testid="button-cancel-delete">Cancel</Button>
          <Button variant="destructive" size="sm" disabled={isPending} data-testid="button-confirm-delete" onClick={onConfirm}>
            {isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PageDetailsDialog({ open, onOpenChange, page, pages }: {
  open: boolean; onOpenChange: (open: boolean) => void; page: LibraryPageFull; pages: LibraryPage[];
}) {
  const parent = page.parentId ? pages.find(p => p.id === page.parentId) : null;
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
          {page.tags.length > 0 && (
            <div className="flex gap-2">
              <span className="text-muted-foreground shrink-0 w-20">Tags</span>
              <div className="flex flex-wrap gap-1">
                {page.tags.map(t => (
                  <span key={t} className="text-xs bg-accent px-1.5 py-0.5 rounded">{t}</span>
                ))}
              </div>
            </div>
          )}
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

export function MovePageDialog({ open, onOpenChange, page, pages }: {
  open: boolean; onOpenChange: (open: boolean) => void; page: LibraryPage | LibraryPageFull; pages: LibraryPage[];
}) {
  const [query, setQuery] = useState("");
  const { visibleVaults, resolveVaultId } = useVisibleVaults();

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
      ["/api/library2/placements"],
      ["/api/library2/destinations"],
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
        <ScrollArea className="max-h-64">
          {destinationSections.map(({ vault, pages: destinationPages }) => (
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
              {destinationPages.map((destinationPage) => (
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
                  <PageEmoji emoji={destinationPage.emoji} />
                  <span className="min-w-0 flex-1 truncate">{destinationPage.title || "Untitled"}</span>
                  {destinationPage.id === page.parentId && <span className="text-xs">Current</span>}
                </button>
              ))}
            </div>
          ))}
          {destinationSections.length === 0 && (
            <p className="px-2 py-3 text-sm text-muted-foreground">No matching destinations.</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
