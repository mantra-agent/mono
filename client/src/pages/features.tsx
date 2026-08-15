import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

const stages = ["idea", "spec", "develop", "test", "calibrate", "maintain", "deprecate"] as const;
type Feature = { id: string; summary: string; stage: typeof stages[number]; status: string; product_name?: string };

function formatStage(stage: typeof stages[number]) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

export default function FeaturesPage() {
  const [search, setSearch] = useState("");
  const features = useQuery<Feature[]>({
    queryKey: ["/api/features", search],
    queryFn: async () => apiRequest("GET", `/api/features${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  });
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
          <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} data-testid="button-new-feature">
            <Plus className="h-3.5 w-3.5 shrink-0" />
            <span>New Feature</span>
          </button>
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
                    >
                      <span className="truncate text-muted-foreground">
                        {feature.product_name ?? "Product"} · {feature.status.replace("_", " ")}
                      </span>
                    </ProfileTreeRow>
                  </HierarchyTreeRow>
                )) : (
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
