import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreHorizontal,
  Search,
  Upload,
  X,
} from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useIsMobile } from "@/hooks/use-mobile";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LibraryPageEditor } from "@/pages/library/library-components";
import type { LibraryPage, LibraryPageFull } from "@/pages/library/types";
import type { Vault } from "@/hooks/use-vaults";

interface Library2IndexDestination {
  id: string;
  title: string;
  path: string;
  depth: number;
  sortOrder: number;
  category: "Entities" | "Concepts" | "Synthesis";
  pageId: string | null;
  pageTitle: string | null;
  pageSlug: string | null;
  pageEmoji: string | null;
  kind: "section" | "wiki";
}

interface Library2VaultDestination {
  vault: Vault;
  destinations: Library2IndexDestination[];
}

interface Library2Placement {
  placementId: string;
  vaultId: string;
  destinationPageId: string | null;
  indexPath: string | null;
  indexSection: "Entities" | "Concepts" | "Synthesis";
  createdAt: string;
  page: LibraryPage;
}

type ImportSource =
  | { type: "page" | "section"; pageId: string }
  | { type: "vault"; vaultId: string };

function importKey(
  source: ImportSource,
  vaultId: string,
  destinationId: string,
) {
  const sourceId = "pageId" in source ? source.pageId : source.vaultId;
  return `library2:${source.type}:${sourceId}:${vaultId}:${destinationId}`;
}

function ImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const { data: pages = [] } = useQuery<LibraryPage[]>({
    queryKey: ["/api/info/library"],
  });
  const { data: destinations = [] } = useQuery<Library2VaultDestination[]>({
    queryKey: ["/api/library2/destinations"],
  });
  const [sourceType, setSourceType] = useState<"page" | "section" | "vault">(
    "page",
  );
  const [sourceId, setSourceId] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [destinationId, setDestinationId] = useState("");

  const source = useMemo<ImportSource | null>(() => {
    if (!sourceId) return null;
    return sourceType === "vault"
      ? { type: "vault", vaultId: sourceId }
      : { type: sourceType, pageId: sourceId };
  }, [sourceId, sourceType]);

  const selectedDestination = destinations.find(
    (destination) => destination.vault.id === vaultId,
  );
  const parentIds = useMemo(
    () =>
      new Set(
        pages
          .map((page) => page.parentId)
          .filter((id): id is string => Boolean(id)),
      ),
    [pages],
  );
  const sourceOptions =
    sourceType === "vault"
      ? destinations.map((destination) => ({
          id: destination.vault.id,
          label: destination.vault.name,
        }))
      : pages
          .filter(
            (page) => sourceType === "page" || parentIds.has(page.id),
          )
          .map((page) => ({ id: page.id, label: page.title || "Untitled" }))
          .sort((a, b) => a.label.localeCompare(b.label));

  useEffect(() => {
    setSourceId("");
    setVaultId("");
    setDestinationId("");
  }, [sourceType, open]);

  const suggestMutation = useMutation({
    mutationFn: async (nextSource: ImportSource) => {
      const response = await apiRequest("POST", "/api/library2/suggest", {
        source: nextSource,
      });
      return response.json() as Promise<{
        vaultId: string;
        destinationId: string | null;
      }>;
    },
    onSuccess: (suggestion) => {
      if (!suggestion.destinationId) return;
      const destination = destinations.find(
        (candidate) => candidate.vault.id === suggestion.vaultId,
      );
      if (
        !destination?.destinations.some(
          (candidate) => candidate.id === suggestion.destinationId,
        )
      ) {
        return;
      }
      setVaultId(suggestion.vaultId);
      setDestinationId(suggestion.destinationId);
    },
    onError: (error) =>
      toast({
        title: "Suggestion unavailable",
        description:
          error instanceof Error ? error.message : "Choose a destination.",
        variant: "destructive",
      }),
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
        destinationId,
        importKey: importKey(source, vaultId, destinationId),
      });
      return response.json() as Promise<{
        sourceCount: number;
        createdCount: number;
        replayedCount: number;
      }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/library2/placements"],
      });
      const replayed = result.createdCount === 0 && result.replayedCount > 0;
      toast({
        title: replayed ? "Already imported" : "Imported",
        description: replayed
          ? `${result.sourceCount} page${result.sourceCount === 1 ? " is" : "s are"} already in Library2.`
          : `${result.createdCount} page${result.createdCount === 1 ? "" : "s"} added to Library2.`,
      });
      onOpenChange(false);
    },
    onError: (error) =>
      toast({
        title: "Import failed",
        description: error instanceof Error ? error.message : "Import failed",
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {(["page", "section", "vault"] as const).map((type) => (
              <Button
                key={type}
                type="button"
                variant={sourceType === type ? "secondary" : "outline"}
                onClick={() => setSourceType(type)}
                className="capitalize"
              >
                {type}
              </Button>
            ))}
          </div>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger data-testid="select-library2-import-source">
              <SelectValue placeholder={`Choose ${sourceType}`} />
            </SelectTrigger>
            <SelectContent>
              {sourceOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={vaultId}
            onValueChange={(value) => {
              setVaultId(value);
              setDestinationId("");
            }}
          >
            <SelectTrigger data-testid="select-library2-vault">
              <SelectValue placeholder="Vault" />
            </SelectTrigger>
            <SelectContent>
              {destinations.map((destination) => (
                <SelectItem
                  key={destination.vault.id}
                  value={destination.vault.id}
                >
                  {destination.vault.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={destinationId}
            onValueChange={setDestinationId}
            disabled={!vaultId}
          >
            <SelectTrigger data-testid="select-library2-section">
              <SelectValue placeholder="Index section" />
            </SelectTrigger>
            <SelectContent>
              {selectedDestination?.destinations.map((destination) => (
                <SelectItem key={destination.id} value={destination.id}>
                  {destination.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-cta text-cta-foreground"
            disabled={
              !source ||
              !vaultId ||
              !destinationId ||
              importMutation.isPending
            }
            onClick={() => importMutation.mutate()}
            data-testid="button-confirm-library2-import"
          >
            {importMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Import
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
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            aria-label="Library2 actions"
            data-testid="button-library2-actions"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={onImport}
            data-testid="menu-library2-import"
          >
            <Upload className="mr-2 h-3.5 w-3.5" /> Import
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function Library2Page() {
  const { toast } = useToast();
  const [importOpen, setImportOpen] = useState(false);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [expandedVaultIds, setExpandedVaultIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedDestinationIds, setExpandedDestinationIds] = useState<
    Set<string>
  >(() => new Set());
  const { data: placements = [], isLoading } = useQuery<Library2Placement[]>({
    queryKey: ["/api/library2/placements"],
  });
  const { data: destinations = [] } = useQuery<Library2VaultDestination[]>({
    queryKey: ["/api/library2/destinations"],
  });
  const { data: pages = [] } = useQuery<LibraryPage[]>({
    queryKey: ["/api/info/library"],
  });
  const selected =
    placements.find(
      (placement) => placement.placementId === selectedPlacementId,
    ) ?? null;
  const { data: selectedPageFull, isLoading: isPageLoading } =
    useQuery<LibraryPageFull>({
      queryKey: ["/api/info/library", selected?.page.id],
      enabled: Boolean(selected),
    });
  const isMobile = useIsMobile();

  useEffect(() => {
    if (destinations.length === 0) return;
    setExpandedVaultIds((current) =>
      current.size > 0
        ? current
        : new Set(destinations.map((destination) => destination.vault.id)),
    );
    setExpandedDestinationIds((current) =>
      current.size > 0
        ? current
        : new Set(
            destinations.flatMap((destination) =>
              destination.destinations.map((indexDestination) =>
                indexDestination.id,
              ),
            ),
          ),
    );
  }, [destinations]);

  const openImport = useCallback(() => setImportOpen(true), []);
  const headerContent = useMemo(
    () => <Library2Header onImport={openImport} />,
    [openImport],
  );
  usePageHeader({ title: "Library2", customContent: headerContent });

  const removeMutation = useMutation({
    mutationFn: async (placementId: string) =>
      apiRequest("DELETE", `/api/library2/placements/${placementId}`),
    onSuccess: () => {
      setSelectedPlacementId(null);
      queryClient.invalidateQueries({
        queryKey: ["/api/library2/placements"],
      });
      toast({ title: "Removed from Library2" });
    },
    onError: (error) =>
      toast({
        title: "Removal failed",
        description: error instanceof Error ? error.message : "Removal failed",
        variant: "destructive",
      }),
  });

  const searchTerm = search.trim().toLowerCase();
  const grouped = destinations
    .map((destination) => {
      return {
        ...destination,
        destinations: destination.destinations
          .map((indexDestination) => ({
            ...indexDestination,
            placements: placements.filter((placement) => {
              if (
                placement.vaultId !== destination.vault.id ||
                (searchTerm &&
                  !placement.page.title.toLowerCase().includes(searchTerm))
              ) {
                return false;
              }
              if (placement.indexPath) {
                return placement.indexPath === indexDestination.path;
              }
              if (placement.destinationPageId) {
                return (
                  indexDestination.pageId === placement.destinationPageId
                );
              }
              return (
                indexDestination.kind === "section" &&
                indexDestination.title.toLowerCase() ===
                  placement.indexSection.toLowerCase()
              );
            }),
          }))
          .filter(
            (indexDestination) =>
              !searchTerm || indexDestination.placements.length > 0,
          ),
      };
    })
    .filter((destination) => destination.destinations.length > 0);

  const toggleInSet = (
    setter: Dispatch<SetStateAction<Set<string>>>,
    id: string,
  ) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const showList = !isMobile || !selected;
  const showEditor = !isMobile || Boolean(selected);

  return (
    <div className="flex h-full min-w-0 overflow-hidden bg-background">
      {showList && (
        <div
          className={cn(
            "flex min-w-0 max-w-full flex-col overflow-hidden bg-background",
            isMobile ? "flex-1" : "w-1/3 min-w-[280px] border-r border-border",
          )}
        >
          <ScrollArea className="min-w-0 max-w-full flex-1 overflow-hidden bg-background p-2 [&_[data-radix-scroll-area-viewport]>div]:!block [&_[data-radix-scroll-area-viewport]>div]:!min-w-0 [&_[data-radix-scroll-area-viewport]>div]:!max-w-full">
            <div className="relative mb-1 min-w-0">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-7 w-full rounded-md border border-input bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="Search Library2"
                data-testid="input-library2-search"
              />
              {search && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setSearch("")}
                  aria-label="Clear Library2 search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : grouped.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                {searchTerm ? "No matching pages." : "No pages in Library2."}
              </div>
            ) : (
              grouped.map((destination) => {
                const vaultExpanded = expandedVaultIds.has(
                  destination.vault.id,
                );
                return (
                  <div key={destination.vault.id} className="mb-1 min-w-0">
                    <button
                      type="button"
                      onClick={() =>
                        toggleInSet(setExpandedVaultIds, destination.vault.id)
                      }
                      className="flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground hover:bg-accent/70"
                    >
                      {vaultExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                      )}
                      <span className="truncate">{destination.vault.name}</span>
                    </button>
                    {vaultExpanded &&
                      destination.destinations.map((indexDestination) => {
                        const destinationExpanded =
                          expandedDestinationIds.has(indexDestination.id);
                        const indent = 16 + indexDestination.depth * 16;
                        return (
                          <div key={indexDestination.id} className="min-w-0">
                            <button
                              type="button"
                              onClick={() =>
                                toggleInSet(
                                  setExpandedDestinationIds,
                                  indexDestination.id,
                                )
                              }
                              className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                              style={{
                                marginLeft: indent,
                                width: `calc(100% - ${indent}px)`,
                              }}
                            >
                              {destinationExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                              )}
                              <span className="truncate">
                                {indexDestination.title}
                              </span>
                            </button>
                            {destinationExpanded &&
                              indexDestination.placements.map((placement) => {
                                const pageIndent = indent + 24;
                                return (
                                  <button
                                    key={placement.placementId}
                                    type="button"
                                    onClick={() =>
                                      setSelectedPlacementId(
                                        placement.placementId,
                                      )
                                    }
                                    className={cn(
                                      "flex min-w-0 items-center rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-accent/70",
                                      selectedPlacementId ===
                                        placement.placementId && "bg-accent",
                                    )}
                                    style={{
                                      marginLeft: pageIndent,
                                      width: `calc(100% - ${pageIndent}px)`,
                                    }}
                                  >
                                    <span className="truncate">
                                      {placement.page.title || "Untitled"}
                                    </span>
                                  </button>
                                );
                              })}
                          </div>
                        );
                      })}
                  </div>
                );
              })
            )}
          </ScrollArea>
        </div>
      )}
      {showEditor && (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {selected && (isPageLoading || !selectedPageFull) ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : selected && selectedPageFull ? (
            <LibraryPageEditor
              selectedId={selected.page.id}
              selectedPage={selectedPageFull}
              pages={pages}
              library2PlacementId={selected.placementId}
              onRemoveFromLibrary2={(id) => removeMutation.mutate(id)}
            />
          ) : (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              Select a page.
            </div>
          )}
        </div>
      )}
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
