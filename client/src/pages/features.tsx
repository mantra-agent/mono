import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { apiRequest } from "@/lib/queryClient";

const stages = ["idea", "spec", "develop", "test", "calibrate", "maintain", "deprecate"] as const;
type Feature = { id: string; summary: string; stage: typeof stages[number]; status: string; product_name?: string };

export default function FeaturesPage() {
  const [search, setSearch] = useState("");
  const features = useQuery<Feature[]>({ queryKey: ["/api/features", search], queryFn: async () => apiRequest("GET", `/api/features${search ? `?search=${encodeURIComponent(search)}` : ""}`) });
  const grouped = useMemo(() => stages.map(stage => ({ stage, rows: (features.data ?? []).filter(row => row.stage === stage) })), [features.data]);
  return <div className="flex h-full min-w-0 flex-col gap-4 bg-background p-4">
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1"><Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search Features" className="pl-8" aria-label="Search Features" /></div>
      <Button className="bg-cta text-cta-foreground"><Plus className="mr-2 h-3.5 w-3.5" />New Feature</Button>
    </div>
    <div className="flex min-w-0 flex-col gap-2">
      {grouped.map(({ stage, rows }) => <section key={stage} className="border-b border-border/30 pb-2">
        <h2 className="px-2 py-1 text-sm font-medium capitalize text-foreground">{stage}</h2>
        {rows.length ? rows.map(feature => <HierarchyTreeRow key={feature.id} label={feature.summary} meta={`${feature.product_name ?? "Product"} · ${feature.status.replace("_", " ")}`} />) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No Features</div>}
      </section>)}
    </div>
  </div>;
}
