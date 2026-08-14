import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { createReferenceRef } from "@shared/references";
import { BookOpen, Building2, ChevronDown, ExternalLink, Loader2, Plus, Shield, X } from "lucide-react";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HierarchySectionHeader,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { InlineLibraryPageEditor } from "@/components/library/inline-library-page";
import { ReferencePicker } from "@/components/references/reference-picker";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { useToast } from "@/hooks/use-toast";
import { useVaults } from "@/hooks/use-vaults";
import {
  BUSINESS_QUERY_KEY,
  useSelectedBusiness,
  type BusinessDefinition,
  type NarrativePageRef,
} from "@/hooks/use-selected-business";
import { apiRequest, queryClient } from "@/lib/queryClient";

const NARRATIVE_SLOTS = [
  { slot: "values", label: "Values", page: (b: BusinessDefinition) => b.valuesPage },
  { slot: "vision", label: "Vision", page: (b: BusinessDefinition) => b.visionPage },
  { slot: "mission", label: "Mission", page: (b: BusinessDefinition) => b.missionPage },
  { slot: "phases", label: "Phases", page: (b: BusinessDefinition) => b.phasesPage },
  { slot: "pitch", label: "Pitch", page: (b: BusinessDefinition) => b.pitchPage },
  { slot: "gtm", label: "GTM", page: (b: BusinessDefinition) => b.gtmPage },
] as const;

function ScalarField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onSave: (next: string) => void;
}) {
  return (
    <ProfileTreeRow
      label={label}
      icon={<Building2 className="h-3.5 w-3.5" />}
      hasValue={Boolean(value)}
      showEmpty
      mobileLayout="inline"
      testId={`business-row-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <Input
        key={value}
        defaultValue={value}
        placeholder={placeholder}
        onBlur={(event) => {
          const next = event.target.value.trim();
          if (next !== value.trim()) onSave(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            event.currentTarget.value = value;
            event.currentTarget.blur();
          }
        }}
        data-testid={`business-field-${label.toLowerCase().replace(/\s+/g, "-")}`}
      />
    </ProfileTreeRow>
  );
}

function NarrativePagePicker({
  label,
  current,
  onAssign,
  onCancel,
}: {
  label: string;
  current?: NarrativePageRef | null;
  onAssign: (pageId: string) => void;
  onCancel?: () => void;
}) {
  return (
    <div className="flex w-full items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <ReferencePicker
        value={current ? [{ type: "page", id: current.id, label: current.title }] : []}
        onChange={(next) => {
          const selected = next[0];
          if (selected) onAssign(selected.id);
        }}
        types={["page"]}
        mode="single"
        variant="compact"
        placeholder={label}
        showToken={false}
        className={HIERARCHY_PRIMARY_ACTION_CLASS}
        testId="picker-business-narrative-assign"
      />
      {onCancel ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground/70"
          onClick={onCancel}
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

function NarrativeSlot({
  business,
  slot,
  label,
  page,
}: {
  business: BusinessDefinition;
  slot: string;
  label: string;
  page: NarrativePageRef | null;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const pageField = `${slot}PageId`;
  const assign = useMutation({
    mutationFn: async (pageId: string | null) => {
      const res = await apiRequest("PATCH", `/api/business/definition/${business.id}`, { [pageField]: pageId });
      return res.json();
    },
    onSuccess: (_result, pageId) => {
      queryClient.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY });
      toast({ title: pageId ? `${label} page assigned` : `${label} page cleared` });
    },
    onError: (error: unknown) => {
      toast({
        title: `Failed to update ${label} page`,
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/business/definition/${business.id}/pages`, { slot });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY });
      toast({ title: `${label} page created` });
    },
    onError: (error: unknown) => {
      toast({
        title: `Failed to create ${label} page`,
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });
  const busy = assign.isPending || create.isPending;
  const pageRef = page
    ? createReferenceRef({
        type: "page",
        id: page.id,
        metadata: { label: page.title, href: `/info#library?page=${encodeURIComponent(page.slug)}` },
      })
    : null;

  return (
    <ProfileTreeRow
      label={label}
      icon={<BookOpen className="h-3.5 w-3.5" />}
      hasValue={Boolean(page)}
      showEmpty
      mobileLayout="inline"
      menuVisibility="hover"
      testId={`business-narrative-${slot}`}
      expandedContent={page ? <InlineLibraryPageEditor page={page} /> : undefined}
      menuContent={
        page ? (
          <>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => setEditing(true)}
              data-testid={`menu-business-narrative-change-${slot}`}
            >
              Change page
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={busy}
              onSelect={() => assign.mutate(null)}
              data-testid={`menu-business-narrative-clear-${slot}`}
            >
              Clear
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => create.mutate()}
            data-testid={`menu-business-narrative-create-${slot}`}
          >
            {create.isPending ? "Creating…" : `Create ${label} page`}
          </DropdownMenuItem>
        )
      }
    >
      {page && pageRef && !editing ? (
        <ReferenceRenderer refValue={pageRef} surface="simple-chip" />
      ) : (
        <NarrativePagePicker
          label={`Choose ${label} page`}
          current={page}
          onAssign={(pageId) => {
            assign.mutate(pageId);
            setEditing(false);
          }}
          onCancel={page ? () => setEditing(false) : undefined}
        />
      )}
    </ProfileTreeRow>
  );
}

function DefinitionEditor({ business }: { business: BusinessDefinition }) {
  const { toast } = useToast();
  const { vaults } = useVaults();
  const [dataRoomOpen, setDataRoomOpen] = useState(false);
  const [dataRoomUrl, setDataRoomUrl] = useState("");
  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/business/definition/${business.id}`, body);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY }),
    onError: (error: unknown) => {
      toast({
        title: "Failed to save",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-2 py-2">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySectionHeader>Identity</HierarchySectionHeader>
        <div>
          <ScalarField
            label="Public Name"
            value={business.publicName}
            placeholder="Brand name"
            onSave={(publicName) => publicName && patch.mutate({ publicName })}
          />
          <ScalarField
            label="Entity Name"
            value={business.entityName ?? ""}
            placeholder="Legal entity"
            onSave={(entityName) => patch.mutate({ entityName: entityName || null })}
          />
          <ProfileTreeRow
            label="Vaults"
            icon={<Shield className="h-3.5 w-3.5" />}
            hasValue={business.vaultIds.length > 0}
            showEmpty
            mobileLayout="inline"
            testId="business-row-vaults"
          >
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" className="h-5 max-w-48 justify-end px-1.5 text-right text-xs font-normal" data-testid="button-edit-business-vaults">
                  <span className="truncate">
                    {vaults.filter((vault) => business.vaultIds.includes(vault.id)).map((vault) => vault.name).join(", ") || "Choose Vaults"}
                  </span>
                  <ChevronDown className="ml-1 h-3 w-3 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-1" data-testid="popover-business-vaults">
                {vaults.map((vault) => {
                  const checked = business.vaultIds.includes(vault.id);
                  const onlyMembership = checked && business.vaultIds.length === 1;
                  return (
                    <label key={vault.id} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent sm:min-h-9">
                      <Checkbox
                        checked={checked}
                        disabled={onlyMembership || patch.isPending}
                        onCheckedChange={(nextChecked) => {
                          const next = nextChecked
                            ? [...new Set([...business.vaultIds, vault.id])]
                            : business.vaultIds.filter((id) => id !== vault.id);
                          patch.mutate({ vaultIds: next });
                        }}
                        aria-label={`${checked ? "Remove from" : "Add to"} ${vault.name}`}
                        data-testid={`checkbox-business-vault-${vault.id}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{vault.name}</span>
                    </label>
                  );
                })}
              </PopoverContent>
            </Popover>
          </ProfileTreeRow>
          <ProfileTreeRow
            label="Data Room"
            icon={<ExternalLink className="h-3.5 w-3.5" />}
            hasValue={Boolean(business.dataRoomUrl)}
            showEmpty
            mobileLayout="inline"
            testId="business-row-data-room"
          >
            {business.dataRoomUrl ? (
              <a
                href={business.dataRoomUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-cta underline-offset-4 hover:text-active hover:underline"
                data-testid="link-business-data-room"
              >
                Open Data Room
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <button
                type="button"
                className="text-xs text-cta underline-offset-4 hover:text-active hover:underline"
                onClick={() => {
                  setDataRoomUrl("");
                  setDataRoomOpen(true);
                }}
                data-testid="button-configure-business-data-room"
              >
                Add URL
              </button>
            )}
          </ProfileTreeRow>
        </div>
      </div>

      <Dialog open={dataRoomOpen} onOpenChange={setDataRoomOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Data Room</DialogTitle>
            <DialogDescription>Paste the secure link for this Business.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            type="url"
            inputMode="url"
            value={dataRoomUrl}
            onChange={(event) => setDataRoomUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && dataRoomUrl.trim() && !patch.isPending) {
                patch.mutate({ dataRoomUrl: dataRoomUrl.trim() }, { onSuccess: () => setDataRoomOpen(false) });
              }
            }}
            placeholder="https://app.box.com/s/..."
            aria-label="Data Room URL"
            data-testid="input-business-data-room-url"
          />
          <DialogFooter>
            <Button
              onClick={() => patch.mutate(
                { dataRoomUrl: dataRoomUrl.trim() },
                { onSuccess: () => setDataRoomOpen(false) },
              )}
              disabled={!dataRoomUrl.trim() || patch.isPending}
              data-testid="button-save-business-data-room"
            >
              {patch.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySectionHeader>Narrative</HierarchySectionHeader>
        <div>
          {NARRATIVE_SLOTS.map(({ slot, label, page }) => (
            <NarrativeSlot key={slot} business={business} slot={slot} label={label} page={page(business)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function NewBusinessAction({ onCreated }: { onCreated: (business: BusinessDefinition) => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [publicName, setPublicName] = useState("");
  const create = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/business/definition", { publicName: publicName.trim() });
      return response.json() as Promise<BusinessDefinition>;
    },
    onSuccess: async (business) => {
      await queryClient.invalidateQueries({ queryKey: BUSINESS_QUERY_KEY });
      onCreated(business);
      setPublicName("");
      setOpen(false);
      toast({ title: `${business.publicName} created` });
    },
    onError: (error: unknown) => {
      toast({
        title: "Failed to create Business",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <>
      <button
        type="button"
        className={HIERARCHY_PRIMARY_ACTION_CLASS}
        onClick={() => setOpen(true)}
        data-testid="button-new-business"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" />
        <span>New Business</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Business</DialogTitle>
            <DialogDescription>Create the Business first, then define its identity and narrative.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={publicName}
            onChange={(event) => setPublicName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && publicName.trim() && !create.isPending) create.mutate();
            }}
            placeholder="Business name"
            aria-label="Business name"
            data-testid="input-new-business-name"
          />
          <DialogFooter>
            <Button onClick={() => create.mutate()} disabled={!publicName.trim() || create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Business
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function BusinessIdentityPage() {
  const { businesses, selectedId, setSelectedId, selected, isLoading } = useSelectedBusiness();

  return (
    <div className="p-4">
      <BusinessPageHeader
        page="Identity"
        businesses={businesses}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading businesses…
        </div>
      ) : selected ? (
        <>
          <NewBusinessAction onCreated={(business) => setSelectedId(business.id)} />
          <DefinitionEditor business={selected} />
        </>
      ) : (
        <div className="space-y-2 py-2">
          <NewBusinessAction onCreated={(business) => setSelectedId(business.id)} />
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No Businesses yet.</div>
        </div>
      )}
    </div>
  );
}
