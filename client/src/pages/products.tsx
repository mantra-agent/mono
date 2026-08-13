import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Boxes, ChevronRight, Loader2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ReferencePicker } from "@/components/references/reference-picker";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePageHeader } from "@/hooks/use-page-header";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { createReferenceRef } from "@shared/references";

const CONTEXT_KINDS = [
  { value: "coding_process", label: "Coding Process" },
  { value: "design_system", label: "Design System" },
  { value: "planning_process", label: "Planning Process" },
  { value: "product_definition", label: "Product Definition" },
  { value: "library_process", label: "Library Process" },
] as const;

interface ProductContext {
  id: number;
  kind: string;
  libraryPageId: string;
  pageTitle: string;
}

interface Product {
  id: number;
  name: string;
  description: string;
  status: "active" | "paused" | "archived";
  backlogId: number;
  platforms: { platformId: number; platformName: string }[];
  context?: ProductContext[];
}

function kindLabel(kind: string) {
  return CONTEXT_KINDS.find((item) => item.value === kind)?.label ?? kind;
}

function ProductRow({
  product,
  defaultOpen,
  onArchive,
  onDelete,
}: {
  product: Product;
  defaultOpen: boolean;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [adding, setAdding] = useState(false);
  const [newKind, setNewKind] = useState("");
  const [pageId, setPageId] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ProductContext | null>(null);

  const addContext = useMutation({
    mutationFn: async () => (await apiRequest("PUT", `/api/products/${product.id}/context-artifacts`, { kind: newKind, libraryPageId: pageId })).json(),
    onSuccess: () => {
      setAdding(false);
      setNewKind("");
      setPageId("");
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
    },
  });
  const removeContext = useMutation({
    mutationFn: async (contextId: number) => apiRequest("DELETE", `/api/products/${product.id}/context-artifacts/${contextId}`),
    onSuccess: () => {
      setPendingDelete(null);
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
    },
  });

  const children = product.context ?? [];

  return (
    <div className="min-w-0" data-testid={`product-row-${product.id}`}>
      <div className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm">
        <button type="button" onClick={() => setOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={open}>
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-foreground">{product.name}</span>
          <span className="shrink-0 text-xs capitalize text-muted-foreground">{product.status}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Actions for ${product.name}`}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={onArchive}><Archive className="mr-2 h-3.5 w-3.5" />Archive</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive" onSelect={onDelete}><Trash2 className="mr-2 h-3.5 w-3.5" />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open ? (
        <>
          {(product.description || product.platforms.length > 0) ? (
            <HierarchyTreeRow continues indent="icon" connectorAnchor="first-row-center">
              <div className="px-2 py-1 text-xs text-muted-foreground">
                {product.description || "No description"}
                <div>{product.platforms.map((platform) => platform.platformName).join(", ") || "No Platforms"}</div>
              </div>
            </HierarchyTreeRow>
          ) : null}
          {children.length === 0 && !adding ? (
            <HierarchyTreeRow continues={false} indent="icon" connectorAnchor="first-row-center">
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No Context yet.</div>
            </HierarchyTreeRow>
          ) : children.map((artifact, index) => {
            const ref = createReferenceRef({
              type: "page",
              id: artifact.libraryPageId,
              metadata: { label: artifact.pageTitle },
            });
            return (
              <HierarchyTreeRow
                key={artifact.id}
                continues={index < children.length - 1 || adding}
                indent="icon"
                connectorAnchor="first-row-center"
              >
                <div className="flex min-h-8 items-center gap-2 px-1 py-0.5">
                  <span className="shrink-0 text-xs text-muted-foreground">{kindLabel(artifact.kind)}</span>
                  <ReferenceRenderer refValue={ref} surface="simple-row" className="max-w-full" />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${artifact.pageTitle}`}
                    onClick={() => setPendingDelete(artifact)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </HierarchyTreeRow>
            );
          })}
          <HierarchyTreeRow continues={false} indent="icon" connectorAnchor="first-row-center">
            {adding ? (
              <div className="space-y-2 px-2 py-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Kind</Label>
                  <Select value={newKind} onValueChange={setNewKind}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue placeholder="Select context kind" />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTEXT_KINDS.map((kind) => (
                        <SelectItem key={kind.value} value={kind.value} className="text-xs">{kind.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Library Page</Label>
                  <ReferencePicker
                    types={["page"]}
                    mode="single"
                    variant="compact"
                    placeholder="Search library pages"
                    value={pageId ? [{ type: "page", id: pageId, label: "Selected page" }] : []}
                    onChange={(next) => setPageId(next[0]?.id ?? "")}
                  />
                </div>
                <div className="flex justify-end gap-1.5">
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { setAdding(false); setNewKind(""); setPageId(""); }}>Cancel</Button>
                  <Button size="sm" className="h-6 px-2 text-xs" disabled={!newKind || !pageId || addContext.isPending} onClick={() => addContext.mutate()}>
                    {addContext.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                  </Button>
                </div>
              </div>
            ) : (
              <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => setAdding(true)}>
                <Plus className="h-3.5 w-3.5 shrink-0" />
                Add Context
              </button>
            )}
          </HierarchyTreeRow>
        </>
      ) : null}
      <AlertDialog open={!!pendingDelete} onOpenChange={(openDialog) => !openDialog && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove context?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes “{pendingDelete?.pageTitle}” from {product.name}. The Library page itself is not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingDelete && removeContext.mutate(pendingDelete.id)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function ProductsPage() {
  usePageHeader({ title: "Products" });
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<{ product: Product; action: "archive" | "delete" } | null>(null);
  const { data = [], isLoading } = useQuery<Product[]>({ queryKey: ["/api/products"] });
  usePageLoadActivity("page:products", isLoading);
  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/products", { name })).json(),
    onSuccess: () => {
      setName("");
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
    },
  });
  const confirm = useMutation({
    mutationFn: async () => pending?.action === "archive"
      ? apiRequest("POST", `/api/products/${pending.product.id}/archive`, { confirm: true })
      : apiRequest("DELETE", `/api/products/${pending!.product.id}`, { confirm: true }),
    onSuccess: () => {
      setPending(null);
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
    },
  });

  const products = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return data;
    return data.filter((product) => {
      const haystack = [
        product.name,
        product.description,
        product.status,
        ...product.platforms.map((platform) => platform.platformName),
        ...(product.context ?? []).flatMap((artifact) => [artifact.kind, artifact.pageTitle]),
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [data, search]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="products-page">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS}>
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-products"
            clearTestId="button-clear-product-search"
            ariaLabel="Search products"
          />
          <div className="flex gap-2 pb-1">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Product name"
              onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) create.mutate(); }}
            />
            <Button className="bg-cta text-cta-foreground" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              <Plus className="mr-2 h-3.5 w-3.5" />New Product
            </Button>
          </div>
          <Collapsible defaultOpen>
            <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
              <ChevronRight className="h-3 w-3 shrink-0 rotate-90" />
              Products <span className="font-normal">({products.length})</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {products.length === 0 ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">No Products yet.</div>
              ) : products.map((product) => (
                <ProductRow
                  key={product.id}
                  product={product}
                  defaultOpen={Boolean(search.trim()) || (product.context?.length ?? 0) > 0}
                  onArchive={() => setPending({ product, action: "archive" })}
                  onDelete={() => setPending({ product, action: "delete" })}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
      <AlertDialog open={!!pending} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.action === "delete" ? "Delete Product" : "Archive Product"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.action === "delete"
                ? "Deletion fails while Platforms, Feature Requests, Issues, or Design dependencies remain."
                : "Archive this Product? Its history remains available."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirm.mutate()}>{pending?.action === "delete" ? "Delete" : "Archive"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
