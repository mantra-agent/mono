import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2, Plus, Search, Trash2, Users, X } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";

interface AudienceDefinition { kind: "manual"; personIds: string[] }
interface Audience { id: string; name: string; description: string; status: "active" | "archived"; definition: AudienceDefinition; updatedAt: string }
interface PersonChoice { id: string; name: string; emails: string[] }

function usePeopleChoices() {
  const peopleQuery = useQuery<{ people: Array<{ id: string; name: string }> }>({ queryKey: ["/api/people"] });
  const emailQuery = useQuery<{ emailMap: Record<string, { id: string; name: string }> }>({ queryKey: ["/api/people/email-map"] });
  return useMemo(() => {
    const byId = new Map<string, PersonChoice>();
    for (const person of peopleQuery.data?.people ?? []) byId.set(person.id, { ...person, emails: [] });
    for (const [email, person] of Object.entries(emailQuery.data?.emailMap ?? {})) {
      const current = byId.get(person.id) ?? { id: person.id, name: person.name, emails: [] };
      current.emails.push(email);
      byId.set(person.id, current);
    }
    return Array.from(byId.values()).filter((person) => person.emails.length > 0).sort((a, b) => a.name.localeCompare(b.name));
  }, [peopleQuery.data, emailQuery.data]);
}

export default function AudiencesPage() {
  usePageHeader({ title: "Audiences" });
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("system:write");
  const { data, isLoading } = useQuery<{ audiences: Audience[] }>({ queryKey: ["/api/communications/audiences"] });
  const people = usePeopleChoices();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const audiences = data?.audiences ?? [];
  const selected = audiences.find((audience) => audience.id === selectedId) ?? null;
  const filtered = audiences.filter((audience) => audience.name.toLowerCase().includes(search.toLowerCase()));

  const createMutation = useMutation({
    mutationFn: async (name: string) => (await apiRequest("POST", "/api/communications/audiences", { name, personIds: [] })).json(),
    onSuccess: (audience: Audience) => { queryClient.invalidateQueries({ queryKey: ["/api/communications/audiences"] }); setSelectedId(audience.id); setCreating(false); },
  });
  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<Audience, "name" | "description" | "status">> & { personIds?: string[] } }) =>
      (await apiRequest("PATCH", `/api/communications/audiences/${id}`, patch)).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/communications/audiences"] }),
  });
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/communications/audiences/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/communications/audiences"] }); setSelectedId(null); },
  });

  if (!hasPermission("system:read")) return <div className="p-6 text-sm text-muted-foreground">Audiences requires system:read.</div>;
  if (isLoading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden md:grid-cols-[minmax(240px,32%)_1fr]">
      <div className="min-w-0 overflow-y-auto border-b border-border p-2 md:border-b-0 md:border-r">
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search audiences" className="h-7 pl-7 pr-7 text-xs" />
          {search && <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"><X className="h-3 w-3" /></button>}
        </div>
        <button disabled={!canWrite} onClick={() => setCreating(true)} className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta hover:bg-accent/70 disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" /> New Audience
        </button>
        {creating && <NewAudience onSubmit={(name) => createMutation.mutate(name)} onCancel={() => setCreating(false)} />}
        <AudienceSection title="Active" items={filtered.filter((item) => item.status === "active")} selectedId={selectedId} onSelect={setSelectedId} />
        <AudienceSection title="Archived" items={filtered.filter((item) => item.status === "archived")} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
      <div className="min-w-0 overflow-y-auto p-4 md:p-6">
        {selected ? (
          <AudienceEditor audience={selected} people={people} canWrite={canWrite} saving={updateMutation.isPending} onSave={(patch) => updateMutation.mutate({ id: selected.id, patch })} onDelete={() => deleteMutation.mutate(selected.id)} />
        ) : <div className="px-2 py-1.5 text-sm text-muted-foreground">Select an audience to manage its People.</div>}
      </div>
    </div>
  );
}

function NewAudience({ onSubmit, onCancel }: { onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  return <div className="flex items-center gap-2 px-2 py-1.5"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) onSubmit(name.trim()); if (event.key === "Escape") onCancel(); }} placeholder="Audience name" className="h-7 text-sm" /></div>;
}

function AudienceSection({ title, items, selectedId, onSelect }: { title: string; items: Audience[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  return <section>
    <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/70 hover:text-foreground">
      <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} /><span>{title}</span><span className="ml-auto text-[10px] font-normal">{items.length || ""}</span>
    </button>
    {open && <div className="pb-2">{items.length === 0 ? <div className="ml-5 px-2 py-1.5 text-sm text-muted-foreground">No {title.toLowerCase()} audiences.</div> : items.map((item) => <button key={item.id} onClick={() => onSelect(item.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${selectedId === item.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"}`}><Users className="h-3.5 w-3.5" /><span className="min-w-0 flex-1 truncate">{item.name}</span><span className="text-xs">{item.definition.personIds.length}</span></button>)}</div>}
  </section>;
}

function AudienceEditor({ audience, people, canWrite, saving, onSave, onDelete }: { audience: Audience; people: PersonChoice[]; canWrite: boolean; saving: boolean; onSave: (patch: { name: string; description: string; personIds: string[]; status: "active" | "archived" }) => void; onDelete: () => void }) {
  const [name, setName] = useState(audience.name);
  const [description, setDescription] = useState(audience.description);
  const [personIds, setPersonIds] = useState<string[]>(audience.definition.personIds);
  const [personSearch, setPersonSearch] = useState("");
  const visiblePeople = people.filter((person) => `${person.name} ${person.emails.join(" ")}`.toLowerCase().includes(personSearch.toLowerCase()));
  return <div className="max-w-5xl space-y-6">
    <div><h1 className="text-xl font-semibold text-foreground">{audience.name}</h1><p className="text-sm text-muted-foreground">A reusable definition over People. Campaigns snapshot recipients later.</p></div>
    <Card className="min-w-0 overflow-hidden p-4 space-y-4">
      <label className="block space-y-1"><span className="text-sm font-medium">Name</span><Input value={name} onChange={(event) => setName(event.target.value)} disabled={!canWrite} /></label>
      <label className="block space-y-1"><span className="text-sm font-medium">Description</span><Textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={!canWrite} rows={3} /></label>
    </Card>
    <Card className="min-w-0 overflow-hidden p-4 space-y-3">
      <div><h2 className="text-lg font-semibold">People</h2><p className="text-sm text-muted-foreground">Only People with an email address can be selected.</p></div>
      <Input value={personSearch} onChange={(event) => setPersonSearch(event.target.value)} placeholder="Search People" />
      <div className="max-h-80 overflow-y-auto divide-y divide-border/60">
        {visiblePeople.length === 0 ? <div className="px-2 py-1.5 text-sm text-muted-foreground">No matching People with email addresses.</div> : visiblePeople.map((person) => <label key={person.id} className="flex min-h-11 items-center gap-3 px-2 py-2 text-sm"><Checkbox checked={personIds.includes(person.id)} disabled={!canWrite} onCheckedChange={(checked) => setPersonIds((current) => checked ? [...current, person.id] : current.filter((id) => id !== person.id))} /><span className="min-w-0 flex-1"><span className="block truncate text-foreground">{person.name}</span><span className="block truncate text-xs text-muted-foreground">{person.emails.join(", ")}</span></span></label>)}
      </div>
    </Card>
    <div className="flex flex-wrap items-center gap-2"><Button disabled={!canWrite || saving || !name.trim()} onClick={() => onSave({ name: name.trim(), description, personIds, status: audience.status })}>{saving ? "Saving…" : "Save Audience"}</Button><Button variant="outline" disabled={!canWrite} onClick={() => onSave({ name: name.trim(), description, personIds, status: audience.status === "active" ? "archived" : "active" })}>{audience.status === "active" ? "Archive" : "Restore"}</Button><Button variant="ghost" className="ml-auto text-destructive" disabled={!canWrite} onClick={onDelete}><Trash2 className="mr-2 h-4 w-4" />Delete</Button></div>
  </div>;
}
