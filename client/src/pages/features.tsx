import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, ChevronRight, Loader2, Package, Plus, User } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const stages = ["idea", "spec", "develop", "test", "calibrate", "maintain", "deprecate"] as const;
type Feature = { id: string; summary: string; stage: typeof stages[number]; status: string; product_name?: string; owner_person_id?: string; spec_page_id?: string | null };
type Product = { id: number; name: string };
type Person = { id: string; name: string; cabinetLevel?: string };

function formatStage(stage: typeof stages[number]) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function CreateFeatureDialog({ products, currentPerson, onCreated }: { products: Product[]; currentPerson: Person | null; onCreated: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [productId, setProductId] = useState("");
  const [owner, setOwner] = useState<ReferencePickerValue[]>([]);

  useEffect(() => {
    if (currentPerson && owner.length === 0) {
      setOwner([{ type: "person", id: currentPerson.id, label: currentPerson.name }]);
    }
  }, [currentPerson, owner.length]);

  const create = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/features", {
        summary: summary.trim(),
        productId: Number(productId),
        ownerPersonId: owner[0]?.id,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/features"] });
      toast({ title: "Feature created", description: summary.trim() });
      setSummary("");
      setProductId("");
      setOwner(currentPerson ? [{ type: "person", id: currentPerson.id, label: currentPerson.name }] : []);
      setOpen(false);
      onCreated();
    },
    onError: (error: unknown) => toast({
      title: "Failed to create Feature",
      description: error instanceof Error ? error.message : "Unknown error",
      variant: "destructive",
    }),
  });
  const valid = summary.trim().length > 0 && Boolean(productId) && Boolean(owner[0]?.id);

  return (
    <>
      <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => setOpen(true)} data-testid="button-new-feature">
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span>New Feature</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Feature</DialogTitle>
            <DialogDescription>Give the roadmap item a clear summary, Product, and Owner.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input autoFocus placeholder="Feature summary" value={summary} onChange={(event) => setSummary(event.target.value)} data-testid="input-feature-summary" />
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger data-testid="select-feature-product"><SelectValue placeholder="Product" /></SelectTrigger>
              <SelectContent>{products.map((product) => <SelectItem key={product.id} value={String(product.id)}>{product.name}</SelectItem>)}</SelectContent>
            </Select>
            <ReferencePicker types={["person"]} mode="single" variant="compact" placeholder="Owner" value={owner} onChange={setOwner} testId="picker-feature-owner" />
          </div>
          <DialogFooter>
            <Button onClick={() => create.mutate()} disabled={!valid || create.isPending} data-testid="button-create-feature">
              {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function FeaturesPage() {
  const [search, setSearch] = useState("");
  const features = useQuery<Feature[]>({
    queryKey: ["/api/features", search],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/features${search ? `?search=${encodeURIComponent(search)}` : ""}`);
      return response.json();
    },
  });
  const products = useQuery<Product[]>({ queryKey: ["/api/products"] });
  const people = useQuery<{ people: Person[] }>({ queryKey: ["/api/people"] });
  const currentPerson = people.data?.people.find((person) => person.cabinetLevel === "user") ?? null;
  const grouped = useMemo(() => stages.map((stage) => ({ stage, rows: (features.data ?? []).filter((row) => row.stage === stage) })), [features.data]);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="features-page">
          <HierarchySearchInput value={search} onChange={setSearch} inputTestId="input-search-features" clearTestId="button-clear-feature-search" ariaLabel="Search features" />
          <CreateFeatureDialog products={products.data ?? []} currentPerson={currentPerson} onCreated={() => features.refetch()} />
          {grouped.map(({ stage, rows }) => (
            <Collapsible key={stage} defaultOpen>
              <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
                <ChevronRight className="h-3 w-3 shrink-0" />
                {formatStage(stage)}
              </CollapsibleTrigger>
              <CollapsibleContent>
                {rows.length ? rows.map((feature, index) => (
                  <HierarchyTreeRow key={feature.id} continues={index < rows.length - 1} connectorAnchor="first-row-center">
                    <ProfileTreeRow
                      label={feature.summary}
                      hasValue
                      showEmpty
                      mobileLayout="inline"
                      valueLayout="compact"
                      testId={`feature-row-${feature.id}`}
                      expandedContent={(
                        <div className="space-y-0.5">
                          <ProfileTreeRow label="Product" icon={<Package className="h-3.5 w-3.5" />} hasValue={Boolean(feature.product_name)} showEmpty mobileLayout="inline"><span>{feature.product_name ?? "Product"}</span></ProfileTreeRow>
                          <ProfileTreeRow label="Stage" icon={<Activity className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline"><span>{formatStage(feature.stage)}</span></ProfileTreeRow>
                          <ProfileTreeRow label="Status" icon={<Activity className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline"><span>{feature.status.replace("_", " ")}</span></ProfileTreeRow>
                          <ProfileTreeRow label="Owner" icon={<User className="h-3.5 w-3.5" />} hasValue={Boolean(feature.owner_person_id)} showEmpty mobileLayout="inline"><span>{feature.owner_person_id ?? "Unassigned"}</span></ProfileTreeRow>
                          <ProfileTreeRow label="Spec" icon={<Package className="h-3.5 w-3.5" />} hasValue={Boolean(feature.spec_page_id)} showEmpty mobileLayout="inline"><span>{feature.spec_page_id ?? "Not linked"}</span></ProfileTreeRow>
                        </div>
                      )}
                      menuContent={(
                        <>
                          <DropdownMenuItem onSelect={() => apiRequest("POST", `/api/features/${feature.id}/archive`, { confirm: true }).then(() => { queryClient.invalidateQueries({ queryKey: ["/api/features"] }); })}>Archive</DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive" onSelect={() => apiRequest("DELETE", `/api/features/${feature.id}`, { confirm: true }).then(() => { queryClient.invalidateQueries({ queryKey: ["/api/features"] }); })}>Delete</DropdownMenuItem>
                        </>
                      )}
                    >
                      <span className="truncate text-muted-foreground">{feature.product_name ?? "Product"} · {feature.status.replace("_", " ")}</span>
                    </ProfileTreeRow>
                  </HierarchyTreeRow>
                )) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No Features</div>}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </div>
    </div>
  );
}
