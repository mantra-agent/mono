import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { ArrowLeft, Briefcase, Building2, Globe, Loader2, MapPin, Plus, Search, Trash2, User, X } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePageHeader } from "@/hooks/use-page-header";
import { useFocusContext } from "@/hooks/use-focus-context";
import { useToast } from "@/hooks/use-toast";
import { ReferenceRenderer } from "@/components/references/reference-renderer";
import { useVisibleVaults } from "@/pages/library/use-vault-sections";

interface CompanyIndex { id: string; name: string; industry?: string; location?: string; peopleCount?: number; opportunityCount?: number; }
interface Company extends CompanyIndex { description?: string; website?: string; notes?: string; tags: string[]; opportunities: Array<{ id: number; vaultId: string | null; title: string; status: string; type: string }>; people: Array<{ id: string; name: string; role?: string }>; }
interface PersonIndex { id: string; name: string; role?: string; companyId?: string; }

function CompanyDetail({ id, onClose, onDelete }: { id: string; onClose: () => void; onDelete: () => void }) {
  const { toast } = useToast();
  const { isVaultEnabled, isLoading: vaultsLoading } = useVisibleVaults();
  const [personSearch, setPersonSearch] = useState("");
  const { data: company, isLoading } = useQuery<Company>({ queryKey: ["/api/companies", id] });
  const { data: peopleData } = useQuery<{ people: PersonIndex[] }>({ queryKey: ["/api/people"] });
  useFocusContext({ entity: { type: "company", id, label: company?.name }, subView: "detail" });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
    queryClient.invalidateQueries({ queryKey: ["/api/companies", id] });
    queryClient.invalidateQueries({ queryKey: ["/api/people"] });
    queryClient.invalidateQueries({ queryKey: ["/api/exec/opportunities"] });
  }, [id]);

  const update = useMutation({
    mutationFn: async (patch: Partial<Company>) => (await apiRequest("PATCH", `/api/companies/${id}`, patch)).json(),
    onSuccess: invalidate,
    onError: (error: Error) => toast({ title: "Failed to update company", description: error.message, variant: "destructive" }),
  });
  const unlink = useMutation({ mutationFn: async (personId: string) => apiRequest("DELETE", `/api/companies/${id}/people/${personId}`), onSuccess: invalidate });
  const link = useMutation({ mutationFn: async (personId: string) => apiRequest("POST", `/api/companies/${id}/people/${personId}`), onSuccess: () => { invalidate(); setPersonSearch(""); } });
  const remove = useMutation({ mutationFn: async () => apiRequest("DELETE", `/api/companies/${id}`), onSuccess: () => { invalidate(); onDelete(); } });

  const candidates = useMemo(() => (peopleData?.people || [])
    .filter(person => person.companyId !== id && person.name.toLowerCase().includes(personSearch.toLowerCase()))
    .slice(0, 8), [peopleData?.people, id, personSearch]);
  const visibleOpportunities = useMemo(
    () => vaultsLoading
      ? []
      : (company?.opportunities || []).filter(opportunity => opportunity.vaultId === null || isVaultEnabled(opportunity.vaultId)),
    [company?.opportunities, vaultsLoading, isVaultEnabled],
  );

  if (isLoading || vaultsLoading) return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!company) return <div className="p-4"><Button variant="ghost" onClick={onClose}><ArrowLeft className="mr-2 h-4 w-4" />Back to Companies</Button></div>;

  const editable = (field: keyof Company, value: string | undefined, placeholder: string) => (
    <Input key={`${field}-${value}`} defaultValue={value || ""} placeholder={placeholder} onBlur={event => {
      const next = event.target.value.trim();
      if (next !== (value || "")) update.mutate({ [field]: next || undefined });
    }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
  );

  return <div className="space-y-6 p-4" data-testid="company-detail-view">
    <section className="overflow-hidden rounded-md border border-border/20">
      <div className="flex items-center gap-3 border-b border-border/20 px-4 py-3">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-lg font-semibold">{editable("name", company.name, "Company name")}</div>
        <Button variant="ghost" size="icon" onClick={() => remove.mutate()} aria-label="Delete company"><Trash2 className="h-4 w-4" /></Button>
      </div>
      <div className="grid grid-cols-[8rem_1fr] items-center border-b border-border/20 px-4 py-2 text-sm"><span className="text-muted-foreground">Industry</span>{editable("industry", company.industry, "Industry")}</div>
      <div className="grid grid-cols-[8rem_1fr] items-center border-b border-border/20 px-4 py-2 text-sm"><span className="text-muted-foreground"><Globe className="mr-2 inline h-3.5 w-3.5" />Website</span>{editable("website", company.website, "https://")}</div>
      <div className="grid grid-cols-[8rem_1fr] items-center border-b border-border/20 px-4 py-2 text-sm"><span className="text-muted-foreground"><MapPin className="mr-2 inline h-3.5 w-3.5" />Location</span>{editable("location", company.location, "Location")}</div>
      <div className="grid grid-cols-[8rem_1fr] items-start border-b border-border/20 px-4 py-2 text-sm"><span className="pt-2 text-muted-foreground">Description</span><Textarea key={company.description} defaultValue={company.description || ""} placeholder="What this company does" className="min-h-20 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" onBlur={event => { const next = event.target.value.trim(); if (next !== (company.description || "")) update.mutate({ description: next || undefined }); }} /></div>
      <div className="grid grid-cols-[8rem_1fr] items-start px-4 py-2 text-sm"><span className="pt-2 text-muted-foreground">Notes</span><Textarea key={company.notes} defaultValue={company.notes || ""} placeholder="Notes" className="min-h-24 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" onBlur={event => { const next = event.target.value.trim(); if (next !== (company.notes || "")) update.mutate({ notes: next || undefined }); }} /></div>
    </section>

    <section className="overflow-hidden rounded-md border border-border/20">
      <div className="border-b border-border/20 px-4 py-3"><h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">People ({company.people.length})</h2></div>
      <div className="relative border-b border-border/20 p-3">
        <Search className="absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={personSearch} onChange={event => setPersonSearch(event.target.value)} placeholder="Add a person…" className="pl-8" />
        {personSearch && candidates.length > 0 && <div className="absolute left-3 right-3 z-50 mt-1 overflow-hidden rounded-md border bg-popover shadow-lg">{candidates.map(person => <button key={person.id} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent" onMouseDown={event => event.preventDefault()} onClick={() => link.mutate(person.id)}><Plus className="h-3.5 w-3.5" />{person.name}</button>)}</div>}
      </div>
      {company.people.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">No people linked yet.</p> : company.people.map(person => <div key={person.id} className="flex min-h-11 items-center gap-3 border-b border-border/10 px-4 py-2 last:border-b-0"><User className="h-3.5 w-3.5 text-muted-foreground" /><ReferenceRenderer refValue={{ type: "person", id: person.id, canonical: `@person:${person.id}` }} surface="chat-inline" className="min-w-0 flex-1" />{person.role && <span className="text-xs text-muted-foreground">{person.role}</span>}<Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => unlink.mutate(person.id)}><X className="h-3.5 w-3.5" /></Button></div>)}
    </section>

    <section className="overflow-hidden rounded-md border border-border/20">
      <div className="border-b border-border/20 px-4 py-3"><h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Opportunities ({visibleOpportunities.length})</h2></div>
      {visibleOpportunities.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">No visible opportunities linked.</p> : visibleOpportunities.map(opportunity => <div key={opportunity.id} className="flex min-h-11 items-center gap-3 border-b border-border/10 px-4 py-2 last:border-b-0"><Briefcase className="h-3.5 w-3.5 text-muted-foreground" /><div className="min-w-0 flex-1"><div className="truncate text-sm text-foreground">{opportunity.title}</div><div className="text-xs capitalize text-muted-foreground">{opportunity.status}</div></div><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => apiRequest("DELETE", `/api/companies/${id}/opportunities/${opportunity.id}`).then(invalidate)}><X className="h-3.5 w-3.5" /></Button></div>)}
    </section>
  </div>;
}

export default function CompaniesPage() {
  const [, params] = useRoute("/companies/:id");
  const [, navigate] = useLocation();
  const [selectedId, setSelectedId] = useState<string | null>(params?.id || null);
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const { toast } = useToast();
  const { data, isLoading } = useQuery<{ companies: CompanyIndex[] }>({ queryKey: ["/api/companies"] });
  const selectedName = data?.companies.find(company => company.id === selectedId)?.name;
  usePageHeader({ title: selectedName || "Companies" });
  useFocusContext(selectedId ? null : { subView: "companies" });

  const create = useMutation({ mutationFn: async () => (await apiRequest("POST", "/api/companies", { name: newName.trim() })).json(), onSuccess: (company: Company) => { queryClient.invalidateQueries({ queryKey: ["/api/companies"] }); setNewName(""); setShowQuickAdd(false); setSelectedId(company.id); navigate(`/companies/${company.id}`); }, onError: (error: Error) => toast({ title: "Failed to add company", description: error.message, variant: "destructive" }) });
  const companies = useMemo(() => (data?.companies || []).filter(company => `${company.name} ${company.industry || ""}`.toLowerCase().includes(search.toLowerCase())), [data?.companies, search]);
  const select = (id: string | null) => { setSelectedId(id); navigate(id ? `/companies/${id}` : "/companies"); };

  return <div className="flex h-full bg-black" data-testid="companies-page">
    <div className={`w-full @md:w-64 shrink-0 flex flex-col bg-black ${selectedId ? "hidden @md:flex" : "flex"}`}>
      <div className="p-2">
        <div className="relative"><Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search companies…" className="h-7 pl-7 text-xs" /></div>
      </div>
      <ScrollArea className="flex-1"><div className="space-y-0.5 p-2">
        {showQuickAdd && <div className="mb-1 border-b p-2">
          <div className="flex gap-1">
            <Input autoFocus value={newName} onChange={event => setNewName(event.target.value)} placeholder="Company name" className="h-8" onKeyDown={event => { if (event.key === "Enter" && newName.trim()) create.mutate(); if (event.key === "Escape") { setNewName(""); setShowQuickAdd(false); } }} data-testid="input-new-company-name" />
            <Button size="sm" className="h-8" disabled={!newName.trim() || create.isPending} onClick={() => create.mutate()} data-testid="button-confirm-add-company">{create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Add"}</Button>
          </div>
        </div>}
        <button type="button" onClick={() => setShowQuickAdd(true)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta transition-colors hover:bg-accent/70 hover:text-cta/80" data-testid="button-new-company-row">
          <Plus className="h-3.5 w-3.5 shrink-0" />
          <span>New Company</span>
        </button>{isLoading ? <Loader2 className="mx-auto mt-8 h-4 w-4 animate-spin text-muted-foreground" /> : companies.map(company => <button key={company.id} onClick={() => select(company.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${selectedId === company.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70"}`}><Building2 className="h-3.5 w-3.5" /><span className="min-w-0 flex-1 truncate">{company.name}</span><span className="text-[10px]">{(company.peopleCount || 0) + (company.opportunityCount || 0)}</span></button>)}</div></ScrollArea>
    </div>
    <div className={`min-w-0 flex-1 overflow-y-auto ${selectedId ? "block" : "hidden @md:block"}`}>{selectedId ? <CompanyDetail id={selectedId} onClose={() => select(null)} onDelete={() => select(null)} /> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Select a company</div>}</div>
  </div>;
}
