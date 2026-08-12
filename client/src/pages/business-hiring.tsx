import { useMemo, useState } from "react";
import { Briefcase, Loader2, Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BusinessPageHeader } from "@/components/business/business-page-header";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSelectedBusiness } from "@/hooks/use-selected-business";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { BusinessHiringPlan, HiringQuarter } from "@shared/models/business-hiring";
import type { JobRole } from "@shared/models/job-roles";

function quarterOptions(): string[] {
  const year = new Date().getFullYear();
  return Array.from({ length: 12 }, (_, index) => `${year + Math.floor(index / 4)} Q${(index % 4) + 1}`);
}

function AddRole({ businessId, quarter, roles, onDone }: { businessId: string; quarter: string; roles: JobRole[]; onDone: () => void }) {
  const [roleId, setRoleId] = useState("");
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async () => {
      const [year, q] = quarter.split(" ");
      const month = String((Number(q.slice(1)) - 1) * 3 + 1).padStart(2, "0");
      return apiRequest("POST", "/api/business/hiring/slots", { businessId, roleId, approvalMonth: `${year}-${month}`, idempotencyKey: `ui-${businessId}-${quarter}-${roleId}` });
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["/api/business/hiring", businessId] }); onDone(); },
    onError: (error: Error) => toast({ title: "Could not approve role", description: error.message, variant: "destructive" }),
  });
  return <div className="flex flex-wrap items-center gap-2 py-2 pl-8"><Select value={roleId} onValueChange={setRoleId}><SelectTrigger className="w-64" aria-label="Job Role"><SelectValue placeholder="Choose a Job Role" /></SelectTrigger><SelectContent>{roles.map((role) => <SelectItem key={role.id} value={role.id}>{role.title}</SelectItem>)}</SelectContent></Select><Button className="bg-cta text-cta-foreground" size="sm" disabled={!roleId || mutation.isPending} onClick={() => mutation.mutate()}>Approve Role</Button><Button variant="ghost" size="sm" onClick={onDone}>Cancel</Button></div>;
}

function QuarterRow({ plan, quarter, businessId, query, onRefresh }: { plan: BusinessHiringPlan; quarter: HiringQuarter; businessId: string; query: string; onRefresh: () => void }) {
  const [adding, setAdding] = useState(false);
  const { toast } = useToast();
  const visibleRoles = quarter.roles.filter((role) => role.title.toLowerCase().includes(query.toLowerCase()));
  const remove = useMutation({ mutationFn: async (slotId: string) => apiRequest("DELETE", `/api/business/hiring/slots/${slotId}?businessId=${encodeURIComponent(businessId)}`), onSuccess: onRefresh, onError: (error: Error) => toast({ title: "Could not remove approval", description: error.message, variant: "destructive" }) });
  return <div><ProfileTreeRow label={quarter.quarter} icon={<Briefcase className="h-3.5 w-3.5" />} hasValue showEmpty defaultOpen expandedContent={<div>{visibleRoles.map((role) => <HierarchyTreeRow key={role.slotId} continues={false} connectorAnchor="first-row-center"><ProfileTreeRow label={role.title} icon={<Briefcase className="h-3.5 w-3.5" />} menuContent={<button type="button" className="flex items-center gap-2 text-destructive" onClick={() => remove.mutate(role.slotId)}><Trash2 className="h-3.5 w-3.5" />Remove approval</button>} menuVisibility="hover"><span className="text-sm text-muted-foreground">{role.team}</span></ProfileTreeRow></HierarchyTreeRow>)}{adding ? <AddRole businessId={businessId} quarter={quarter.quarter} roles={plan.roles.filter((role) => !quarter.roles.some((existing) => existing.id === role.id))} onDone={() => setAdding(false)} /> : <HierarchyTreeRow continues={false} connectorAnchor="first-row-center"><button type="button" className="flex items-center gap-2 px-2 py-1.5 text-sm text-cta" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />Add role</button></HierarchyTreeRow>}</div>} expandedContentClassName="px-0 pb-0 pl-0" /> </div>;
}

export default function BusinessHiringPage() {
  const { businesses, selectedId, setSelectedId, isLoading: businessesLoading } = useSelectedBusiness();
  const [query, setQuery] = useState("");
  const [newQuarter, setNewQuarter] = useState("");
  const { toast } = useToast();
  const key = ["/api/business/hiring", selectedId] as const;
  const { data, isLoading, refetch } = useQuery<BusinessHiringPlan>({ queryKey: key, enabled: Boolean(selectedId), queryFn: async () => (await apiRequest("GET", `/api/business/hiring?businessId=${encodeURIComponent(selectedId ?? "")}`)).json() });
  const addQuarter = useMutation({ mutationFn: async () => { const [year, q] = newQuarter.split(" "); const month = String((Number(q.slice(1)) - 1) * 3 + 1).padStart(2, "0"); const role = data?.roles[0]; if (!role) throw new Error("Create a Job Role first in Roles"); return apiRequest("POST", "/api/business/hiring/slots", { businessId: selectedId, roleId: role.id, approvalMonth: `${year}-${month}`, idempotencyKey: `ui-quarter-${selectedId}-${newQuarter}` }); }, onSuccess: () => { void queryClient.invalidateQueries({ queryKey: key }); setNewQuarter(""); }, onError: (error: Error) => toast({ title: "Could not add quarter", description: error.message, variant: "destructive" }) });
  const quarters = useMemo(() => data?.quarters.filter((quarter) => !query || quarter.quarter.toLowerCase().includes(query.toLowerCase()) || quarter.roles.some((role) => role.title.toLowerCase().includes(query.toLowerCase()))) ?? [], [data?.quarters, query]);
  if (businessesLoading || isLoading) return <div className="flex h-full items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  return <div className="w-full p-4"><BusinessPageHeader page="Hiring" businesses={businesses} selectedId={selectedId} onSelect={setSelectedId} /><div className="flex flex-wrap items-center gap-2 pb-2"><div className="min-w-0 flex-1"><HierarchySearchInput value={query} onChange={setQuery} placeholder="Search hiring plan" /></div><Select value={newQuarter} onValueChange={setNewQuarter}><SelectTrigger className="w-40" aria-label="Quarter"><SelectValue placeholder="Add quarter" /></SelectTrigger><SelectContent>{quarterOptions().map((quarter) => <SelectItem key={quarter} value={quarter}>{quarter}</SelectItem>)}</SelectContent></Select><Button className="bg-cta text-cta-foreground" disabled={!newQuarter || addQuarter.isPending} onClick={() => addQuarter.mutate()}><Plus className="mr-1.5 h-3.5 w-3.5" />Add quarter</Button></div>{selectedId && data ? quarters.map((quarter) => <QuarterRow key={quarter.quarter} plan={data} quarter={quarter} businessId={selectedId} query={query} onRefresh={() => { void refetch(); }} />) : <div className="px-2 py-1.5 text-sm text-muted-foreground">No Business selected.</div>}{data && quarters.length === 0 && <div className="px-2 py-1.5 text-sm text-muted-foreground">No hiring quarters yet.</div>}</div>;
}
