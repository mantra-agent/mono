import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, ChevronRight, FileText, Loader2, Package, PenLine, Plus, User } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { ReferenceText } from "@/components/references/reference-text";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useSessionLaunch } from "@/hooks/use-session-launch";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  FEATURE_PIPELINE,
  FEATURE_STAGES,
  FEATURE_STATUSES,
  composeFeatureLaunchMessage,
  formatFeatureStage,
  type FeatureStage,
  type FeatureStatus,
} from "@shared/feature-pipeline";

const stages = FEATURE_STAGES;
const statuses = FEATURE_STATUSES;
type Feature = {
  id: string;
  summary: string;
  description?: string;
  stage: FeatureStage;
  status: FeatureStatus;
  product_id: number;
  product_name?: string;
  owner_person_id?: string;
  spec_page_id?: string | null;
};
type Product = { id: number; name: string };
type Person = { id: string; name: string; cabinetLevel?: string };

const STATUS_LABELS: Record<FeatureStatus, string> = {
  ready: "Ready",
  in_progress: "In Progress",
  needs_review: "Needs Review",
};

function formatStage(stage: FeatureStage) {
  return formatFeatureStage(stage);
}

function CreateFeatureDialog({
  products,
  currentPerson,
  onCreated,
}: {
  products: Product[];
  currentPerson: Person | null;
  onCreated: () => void;
}) {
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
    onError: (error: unknown) =>
      toast({
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
            <Input
              autoFocus
              placeholder="Feature summary"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              data-testid="input-feature-summary"
            />
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger data-testid="select-feature-product">
                <SelectValue placeholder="Product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((product) => (
                  <SelectItem key={product.id} value={String(product.id)}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ReferencePicker
              types={["person"]}
              mode="single"
              variant="compact"
              placeholder="Owner"
              value={owner}
              onChange={setOwner}
              testId="picker-feature-owner"
            />
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

function FeatureRow({ feature, products }: { feature: Feature; products: Product[] }) {
  const { toast } = useToast();
  const launch = useSessionLaunch();
  const [editingOwner, setEditingOwner] = useState(false);
  const [editingSpec, setEditingSpec] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);

  const update = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const response = await apiRequest("PATCH", `/api/features/${feature.id}`, patch);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/features"] });
    },
    onError: (error: unknown) =>
      toast({
        title: "Failed to update Feature",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const ownerValue: ReferencePickerValue[] = feature.owner_person_id
    ? [{ type: "person", id: feature.owner_person_id, label: feature.owner_person_id }]
    : [];
  const specValue: ReferencePickerValue[] = feature.spec_page_id
    ? [{ type: "page", id: feature.spec_page_id, label: feature.spec_page_id }]
    : [];

  return (
    <ProfileTreeRow
      label={feature.summary}
      hasValue
      showEmpty
      mobileLayout="inline"
      valueLayout="compact"
      testId={`feature-row-${feature.id}`}
      expandedContentClassName="px-2 pb-2 pl-2"
      expandedContent={(
        <div className="space-y-0.5">
          <div className="px-1 pb-1.5 pt-0.5" data-testid={`feature-description-${feature.id}`}>
            {editingDescription ? (
              <Textarea
                autoFocus
                defaultValue={feature.description ?? ""}
                placeholder="Add a description…"
                className="min-h-20 text-xs"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next === (feature.description ?? "").trim()) {
                    setEditingDescription(false);
                    return;
                  }
                  update.mutate({ description: next }, { onSettled: () => setEditingDescription(false) });
                }}
                data-testid={`textarea-feature-description-${feature.id}`}
              />
            ) : feature.description?.trim() ? (
              <button
                type="button"
                className="block w-full text-left prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0"
                onClick={() => setEditingDescription(true)}
                data-testid={`button-edit-feature-description-${feature.id}`}
              >
                <ReferenceText content={feature.description} />
              </button>
            ) : (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setEditingDescription(true)}
                data-testid={`button-add-feature-description-${feature.id}`}
              >
                Add a description…
              </button>
            )}
          </div>

          <ProfileTreeRow
            label="Product"
            icon={<Package className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`feature-product-${feature.id}`}
          >
            <Select
              value={String(feature.product_id)}
              onValueChange={(productId) => update.mutate({ productId: Number(productId) })}
              disabled={update.isPending}
            >
              <SelectTrigger className="h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0" data-testid={`select-feature-product-${feature.id}`}>
                <SelectValue placeholder="Product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((product) => (
                  <SelectItem key={product.id} value={String(product.id)}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ProfileTreeRow>

          <ProfileTreeRow
            label="Stage"
            icon={<Activity className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`feature-stage-${feature.id}`}
          >
            <Select
              value={feature.stage}
              onValueChange={(stage) => update.mutate({ stage })}
              disabled={update.isPending}
            >
              <SelectTrigger className="h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0" data-testid={`select-feature-stage-${feature.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stages.map((stage) => (
                  <SelectItem key={stage} value={stage}>
                    {formatStage(stage)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ProfileTreeRow>

          <ProfileTreeRow
            label="Status"
            icon={<Activity className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`feature-status-${feature.id}`}
          >
            <Select
              value={feature.status}
              onValueChange={(status) => update.mutate({ status })}
              disabled={update.isPending}
            >
              <SelectTrigger className="h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0" data-testid={`select-feature-status-${feature.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((status) => (
                  <SelectItem key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ProfileTreeRow>

          <ProfileTreeRow
            label="Owner"
            icon={<User className="h-3.5 w-3.5" />}
            hasValue={Boolean(feature.owner_person_id) || editingOwner}
            showEmpty
            mobileLayout="inline"
            testId={`feature-owner-${feature.id}`}
          >
            {editingOwner || !feature.owner_person_id ? (
              <ReferencePicker
                types={["person"]}
                mode="single"
                variant="compact"
                dense
                placeholder="Owner"
                value={ownerValue}
                onChange={(next) => {
                  const personId = next[0]?.id;
                  if (!personId || personId === feature.owner_person_id) {
                    setEditingOwner(false);
                    return;
                  }
                  update.mutate(
                    { ownerPersonId: personId },
                    { onSettled: () => setEditingOwner(false) },
                  );
                }}
                testId={`picker-feature-owner-${feature.id}`}
              />
            ) : (
              <button
                type="button"
                className="max-w-full truncate text-right"
                onClick={() => setEditingOwner(true)}
                data-testid={`button-edit-feature-owner-${feature.id}`}
              >
                <span className="pointer-events-none">
                  <InlineReferenceText text={`@person:${feature.owner_person_id}`} />
                </span>
              </button>
            )}
          </ProfileTreeRow>

          <ProfileTreeRow
            label="Spec"
            icon={<FileText className="h-3.5 w-3.5" />}
            hasValue={Boolean(feature.spec_page_id) || editingSpec}
            showEmpty
            mobileLayout="inline"
            testId={`feature-spec-${feature.id}`}
          >
            {editingSpec || !feature.spec_page_id ? (
              <ReferencePicker
                types={["page"]}
                mode="single"
                variant="compact"
                dense
                placeholder="Spec page"
                value={specValue}
                onChange={(next) => {
                  const pageId = next[0]?.id ?? null;
                  if (pageId === (feature.spec_page_id ?? null)) {
                    setEditingSpec(false);
                    return;
                  }
                  update.mutate(
                    { specPageId: pageId },
                    { onSettled: () => setEditingSpec(false) },
                  );
                }}
                testId={`picker-feature-spec-${feature.id}`}
              />
            ) : (
              <button
                type="button"
                className="max-w-full truncate text-right"
                onClick={() => setEditingSpec(true)}
                data-testid={`button-edit-feature-spec-${feature.id}`}
              >
                <span className="pointer-events-none">
                  <InlineReferenceText text={`@page:${feature.spec_page_id}`} />
                </span>
              </button>
            )}
          </ProfileTreeRow>
        </div>
      )}
      menuContent={(
        <>
          {FEATURE_STAGES.map((stage) => {
            const contract = FEATURE_PIPELINE[stage];
            const pending = launch.isPending && launch.variables?.pendingKey === `feature-${feature.id}-${stage}`;
            return (
              <DropdownMenuItem
                key={stage}
                disabled={launch.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  launch.mutate({
                    pendingKey: `feature-${feature.id}-${stage}`,
                    title: `${contract.actionLabel}: ${feature.summary}`.slice(0, 80),
                    personaName: contract.persona,
                    message: composeFeatureLaunchMessage({
                      id: feature.id,
                      summary: feature.summary,
                      stage: feature.stage,
                      productName: feature.product_name,
                      productId: feature.product_id,
                      ownerPersonId: feature.owner_person_id,
                      specPageId: feature.spec_page_id,
                      description: feature.description,
                    }, stage),
                    clientTurnSuffix: `feature-${feature.id}-${stage}`,
                    errorTitle: `Could not start ${contract.actionLabel.toLowerCase()} session`,
                  });
                }}
                data-testid={`button-feature-launch-${stage}-${feature.id}`}
              >
                {pending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <PenLine className="mr-2 h-3.5 w-3.5" />}
                {contract.actionLabel}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuItem
            onSelect={() =>
              apiRequest("POST", `/api/features/${feature.id}/archive`, { confirm: true }).then(() => {
                queryClient.invalidateQueries({ queryKey: ["/api/features"] });
              })
            }
          >
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() =>
              apiRequest("DELETE", `/api/features/${feature.id}`, { confirm: true }).then(() => {
                queryClient.invalidateQueries({ queryKey: ["/api/features"] });
              })
            }
          >
            Delete
          </DropdownMenuItem>
        </>
      )}
    />
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
  const productList = products.data ?? [];
  const grouped = useMemo(
    () => stages.map((stage) => ({ stage, rows: (features.data ?? []).filter((row) => row.stage === stage) })),
    [features.data],
  );

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="features-page">
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-features"
            clearTestId="button-clear-feature-search"
            ariaLabel="Search features"
          />
          <CreateFeatureDialog products={productList} currentPerson={currentPerson} onCreated={() => features.refetch()} />
          {grouped.map(({ stage, rows }) => (
            <Collapsible key={stage} defaultOpen>
              <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
                <ChevronRight className="h-3 w-3 shrink-0" />
                {formatStage(stage)}
              </CollapsibleTrigger>
              <CollapsibleContent>
                {rows.length ? (
                  rows.map((feature, index) => (
                    <HierarchyTreeRow key={feature.id} continues={index < rows.length - 1} connectorAnchor="first-row-center">
                      <FeatureRow feature={feature} products={productList} />
                    </HierarchyTreeRow>
                  ))
                ) : (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No Features</div>
                )}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </div>
    </div>
  );
}
