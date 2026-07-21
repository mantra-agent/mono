import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Upload, X, Search, Loader2, ChevronRight } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useIsMobile } from "@/hooks/use-mobile";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LibraryPageEditor } from "@/pages/library/library-components";
import type { LibraryPage, LibraryPageFull } from "@/pages/library/types";
import type { Vault } from "@/hooks/use-vaults";

interface Library2Section {
  id: string;
  title: string;
  slug: string;
  emoji: string | null;
  sortOrder: number;
  category: string;
}

interface Library2Destination {
  vault: Vault;
  sections: Library2Section[];
}

interface Library2Placement {
  placementId: string;
  vaultId: string;
  sectionPageId: string;
  importKey: string;
  createdAt: string;
  page: LibraryPage;
}

type ImportSource =
  | { type: "page" | "section"; pageId: string }
  | { type: "vault"; vaultId: string };

function importKey(source: ImportSource, vaultId: string, sectionPageId: string) {
  const sourceId = "pageId" in source ? source.pageId : source.vaultId;
  return `library2:${source.type}:${sourceId}:${vaultId}:${sectionPageId}`;
}

function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const { data: pages = [] } = useQuery<LibraryPage[]>({ queryKey: ["/api/info/library"] });
  const { data: destinations = [] } = useQuery<Library2Destination[]>({ queryKey: ["/api/library2/destinations"] });
  const [sourceType, setSourceType] = useState<"page" | "section" | "vault">("page");
  const [sourceId, setSourceId] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [sectionPageId, setSectionPageId] = useState("");

  const source = useMemo<ImportSource | null>(() => {
    if (!sourceId) return null;
    return sourceType === "vault" ? { type: "vault", vaultId: sourceId } : { type: sourceType, pageId: sourceId };
  }, [sourceId, sourceType]);

  const selectedDestination = destinations.find((destination) => destination.vault.id === vaultId);
  const parentIds = useMemo(() => new Set(pages.map((page) => page.parentId).filter((id): id is string => !!id)), [pages]);
  const sourceOptions = sourceType === "vault"
    ? destinations.map((destination) => ({ id: destination.vault.id, label: destination.vault.name }))
    : pages
        .filter((page) => sourceType === "page" || parentIds.has(page.id))
        .map((page) => ({ id: page.id, label: page.title || "Untitled" }));

  useEffect(() => {
    if (!open) return;
    setSourceId("");
    setVaultId("");
    setSectionPageId("");
  }, [sourceType]);

  const suggestMutation = useMutation({
    mutationFn: async (nextSource: ImportSource) => {
      const response = await apiRequest("POST", "/api/library2/suggest", { source: nextSource });
      return response.json() as Promise<{ vaultId: string; sectionPageId: string }>;
    },
    onSuccess: (suggestion) => {
      const destination = destinations.find((candidate) => candidate.vault.id === suggestion.vaultId);
      if (!destination?.sections.some((section) => section.id === suggestion.sectionPageId)) return;
      setVaultId(suggestion.vaultId);
      setSectionPageId(suggestion.sectionPageId);
    },
    onError: (error) => toast({ title: "Suggestion unavailable", description: error instanceof Error ? error.message : "Choose a destination.", variant: "destructive" }),
  });

  useEffect(() => {
    if (source) suggestMutation.mutate(source);
  }, [source]);

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!source) throw new Error("Choose something to import");
      const response = await apiRequest("POST", "/api/library2/placements", {
        source,
        vaultId,
        sectionPageId,
        importKey: importKey(source, vaultId, sectionPageId),
      });
      return response.json() as Promise<{ sourceCount: number; createdCount: number }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/library2/placements"] });
      toast({ title: "Imported", description: `${result.createdCount || result.sourceCount} page${result.sourceCount === 1 ? "" : "s"} added to Library2.` });
      onOpenChange(false);
    },
    onError: (error) => toast({ title: "Import failed", description: error instanceof Error ? error.message : "Import failed", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Import</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {(["page", "section", "vault"] as const).map((type) => (
              <Button key={type} type="button" variant={sourceType === type ? "secondary" : "outline"} onClick={() => setSourceType(type)} className="capitalize">{type}</Button>
            ))}
          </div>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger data-testid="select-library2-import-source"><SelectValue placeholder={`Choose ${sourceType}`} /></SelectTrigger>
            <SelectContent>{sourceOptions.map((option) => <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={vaultId} onValueChange={(value) => { setVaultId(value); setSectionPageId(""); }}>
            <SelectTrigger data-testid="select-library2-vault"><SelectValue placeholder="Vault" /></SelectTrigger>
            <SelectContent>{destinations.map((destination) => <SelectItem key={destination.vault.id} value={destination.vault.id}>{destination.vault.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={sectionPageId} onValueChange={setSectionPageId} disabled={!vaultId}>
            <SelectTrigger data-testid="select-library2-section"><SelectValue placeholder="Index section" /></SelectTrigger>
            <SelectContent>{selectedDestination?.sections.map((section) => <SelectItem key={section.id} value={section.id}>{section.category} / {section.title}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" className="bg-cta text-cta-foreground" disabled={!source || !vaultId || !sectionPageId || importMutation.isPending} onClick={() => importMutation.mutate()} data-testid="button-confirm-library2-import">
            {importMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Library2Header({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0">Library2</span>
      <div id="library-page-header-slot" className="flex min-w-0 flex-1 items-center" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label="Library2 actions" data-testid="button-library2-actions"><MoreHorizontal className="h-3.5 w-3.5" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuItem onClick={onImport} data-testid="menu-library2-import"><Upload className="mr-2 h-3.5 w-3.5" /> Import</DropdownMenuItem></DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function Library2Page() {
  const [importOpen, setImportOpen] = useState(false);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const { data: placements = [], isLoading } = useQuery<Library2Placement[]>({ queryKey: ["/api/library2/placements"] });
  const { data: destinations = [] } = useQuery<Library2Destination[]>({ queryKey: ["/api/library2/destinations"] });
  const { data: pages = [] } = useQuery<LibraryPage[]>({ queryKey: ["/api/info/library"] });
  const selected = placements.find((placement) => placement.placementId === selectedPlacementId) ?? null;
  const { data: selectedPageFull } = useQuery<LibraryPageFull>({ queryKey: ["/api/info/library", selected?.page.id], enabled: !!selected });
  const isMobile = useIsMobile();

  const openImport = useCallback(() => setImportOpen(true), []);
  const headerContent = useMemo(() => <Library2Header onImport={openImport} />, [openImport]);
  usePageHeader({ title: "Library2", customContent: headerContent });

  const removeMutation = useMutation({
    mutationFn: async (placementId: string) => apiRequest("DELETE", `/api/library2/placements/${placementId}`),
    onSuccess: () => {
      setSelectedPlacementId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/library2/placements"] });
    },
  });

  const grouped = destinations.map((destination) => ({
    ...destination,
    sections: destination.sections.map((section) => ({
      ...section,
      placements: placements.filter((placement) => placement.vaultId === destination.vault.id && placement.sectionPageId === section.id && placement.page.title.toLowerCase().includes(search.toLowerCase())),
    })).filter((section) => section.placements.length > 0),
  })).filter((destination) => destination.sections.length > 0);

  const showList = !isMobile || !selected;
  const showEditor = !isMobile || !!selected;

  return (
    <div className="flex h-full min-w-0 overflow-hidden bg-background">
      {showList && <div className={cn("flex min-w-0 flex-col border-r border-border", isMobile ? "flex-1" : "w-[320px]")}>
        <div className="relative m-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-7 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label="Search Library2" />
          {search && <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setSearch("")}><X className="h-3.5 w-3.5" /></button>}
        </div>
        <ScrollArea className="flex-1 p-2">
          {isLoading ? <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div> : grouped.length === 0 ? <div className="px-2 py-1.5 text-sm text-muted-foreground">No pages in Library2.</div> : grouped.map((destination) => (
            <div key={destination.vault.id} className="mb-3">
              <div className="px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">{destination.vault.name}</div>
              {destination.sections.map((section) => <div key={section.id}>
                <div className="flex items-center gap-1 px-2 py-1 text-sm text-muted-foreground"><ChevronRight className="h-3.5 w-3.5 rotate-90" />{section.title}</div>
                {section.placements.map((placement) => <button key={placement.placementId} onClick={() => setSelectedPlacementId(placement.placementId)} className={cn("ml-6 flex w-[calc(100%-1.5rem)] items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent/50", selectedPlacementId === placement.placementId && "bg-accent")}><span className="truncate">{placement.page.title || "Untitled"}</span></button>)}
              </div>)}
            </div>
          ))}
        </ScrollArea>
      </div>}
      {showEditor && <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {selected && selectedPageFull ? <LibraryPageEditor selectedId={selected.page.id} selectedPage={selectedPageFull} pages={pages} onDeleteRequest={() => {}} library2PlacementId={selected.placementId} onRemoveFromLibrary2={(id) => removeMutation.mutate(id)} /> : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Select a page</div>}
      </div>}
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
