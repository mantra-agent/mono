import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  HierarchySectionHeader,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ExpandableLibraryPage } from "@/components/library/inline-library-page";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  BUSINESS_QUERY_KEY,
  useSelectedBusiness,
  type BusinessDefinition,
  type NarrativePageRef,
} from "@/hooks/use-selected-business";
import { BusinessSelector } from "@/components/business/business-selector";

const NARRATIVE_SLOTS = [
  { slot: "values", label: "Values", page: (b: BusinessDefinition) => b.valuesPage },
  { slot: "vision", label: "Vision", page: (b: BusinessDefinition) => b.visionPage },
  { slot: "mission", label: "Mission", page: (b: BusinessDefinition) => b.missionPage },
] as const;

/** Inline scalar field that persists on blur when the value actually changed. */
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
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next !== value.trim()) onSave(next);
        }}
        data-testid={`business-field-${label.toLowerCase().replace(/\s+/g, "-")}`}
      />
    </label>
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

  if (page) {
    return (
      <ExpandableLibraryPage page={page} defaultOpen={false} />
    );
  }

  return (
    <button
      type="button"
      className="flex min-h-8 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      onClick={() => create.mutate()}
      disabled={create.isPending}
      data-testid={`business-narrative-add-${slot}`}
    >
      {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
      <span>Add {label}</span>
    </button>
  );
}

function DefinitionEditor({ business }: { business: BusinessDefinition }) {
  const { toast } = useToast();
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
    <div className="space-y-6 py-4">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySectionHeader>Identity</HierarchySectionHeader>
        <div className="grid max-w-xl gap-3 sm:grid-cols-2">
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
        </div>
      </div>

      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySectionHeader>Narrative</HierarchySectionHeader>
        <div className="space-y-2">
          {NARRATIVE_SLOTS.map(({ slot, label, page }) => (
            <NarrativeSlot
              key={slot}
              business={business}
              slot={slot}
              label={label}
              page={page(business)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function BusinessDefinitionPage() {
  const { businesses, selectedId, setSelectedId, selected, isLoading } = useSelectedBusiness();

  return (
    <div className="p-4">
      <BusinessSelector businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} />

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading businesses…
        </div>
      ) : selected ? (
        <DefinitionEditor business={selected} />
      ) : (
        <div className="px-2 py-16 text-center text-sm text-muted-foreground">
          Create a Business to define its identity, values, vision, and mission.
        </div>
      )}
    </div>
  );
}
