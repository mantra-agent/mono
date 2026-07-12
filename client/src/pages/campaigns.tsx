import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { usePageHeader } from "@/hooks/use-page-header";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Audience { id: string; name: string; definition: { kind: "manual"; personIds: string[] } }
interface Campaign { id: string; name: string; status: "draft"; audienceId: string | null; senderName: string; senderEmail: string; replyToEmail: string; subject: string; body: string; updatedAt: string }

export default function CampaignsPage() {
  usePageHeader({ title: "Campaigns" });
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("system:write");
  const campaignsQuery = useQuery<{ campaigns: Campaign[] }>({ queryKey: ["/api/communications/campaigns"] });
  const audiencesQuery = useQuery<{ audiences: Audience[] }>({ queryKey: ["/api/communications/audiences"] });
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const campaigns = campaignsQuery.data?.campaigns ?? [];
  const audiences = audiencesQuery.data?.audiences ?? [];
  const selected = campaigns.find((campaign) => campaign.id === selectedId) ?? null;
  const filtered = campaigns.filter((campaign) => campaign.name.toLowerCase().includes(search.toLowerCase()));

  const createMutation = useMutation({
    mutationFn: async (name: string) => (await apiRequest("POST", "/api/communications/campaigns", { name })).json(),
    onSuccess: (campaign: Campaign) => { queryClient.invalidateQueries({ queryKey: ["/api/communications/campaigns"] }); setSelectedId(campaign.id); setCreating(false); },
  });
  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Campaign> }) => (await apiRequest("PATCH", `/api/communications/campaigns/${id}`, patch)).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/communications/campaigns"] }),
  });
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/communications/campaigns/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/communications/campaigns"] }); setSelectedId(null); },
  });

  if (!hasPermission("system:read")) return <div className="p-6 text-sm text-muted-foreground">Campaigns requires system:read.</div>;
  if (campaignsQuery.isLoading || audiencesQuery.isLoading) return <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden md:grid-cols-[minmax(240px,32%)_1fr]">
    <div className="min-w-0 overflow-y-auto border-b border-border p-2 md:border-b-0 md:border-r">
      <div className="relative mb-1"><Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search campaigns" className="h-7 pl-7 pr-7 text-xs" />{search && <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"><X className="h-3 w-3" /></button>}</div>
      <button disabled={!canWrite} onClick={() => setCreating(true)} className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-cta hover:bg-accent/70 disabled:opacity-50"><Plus className="h-3.5 w-3.5" /> New Campaign</button>
      {creating && <NewCampaign onSubmit={(name) => createMutation.mutate(name)} onCancel={() => setCreating(false)} />}
      <CampaignSection title="Draft" items={filtered} selectedId={selectedId} onSelect={setSelectedId} />
      <CampaignSection title="Scheduled" items={[]} selectedId={selectedId} onSelect={setSelectedId} />
      <CampaignSection title="Sent" items={[]} selectedId={selectedId} onSelect={setSelectedId} />
      <CampaignSection title="Archived" items={[]} selectedId={selectedId} onSelect={setSelectedId} />
    </div>
    <div className="min-w-0 overflow-y-auto p-4 md:p-6">
      {selected ? <CampaignEditor key={selected.id} campaign={selected} audiences={audiences} canWrite={canWrite} saving={updateMutation.isPending} onSave={(patch) => updateMutation.mutate({ id: selected.id, patch })} onDelete={() => deleteMutation.mutate(selected.id)} /> : <div className="px-2 py-1.5 text-sm text-muted-foreground">Select a campaign to write and preview it.</div>}
    </div>
  </div>;
}

function NewCampaign({ onSubmit, onCancel }: { onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  return <div className="px-2 py-1.5"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) onSubmit(name.trim()); if (event.key === "Escape") onCancel(); }} placeholder="Campaign name" className="h-7 text-sm" /></div>;
}

function CampaignSection({ title, items, selectedId, onSelect }: { title: string; items: Campaign[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  return <section><button onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:bg-accent/70 hover:text-foreground"><ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} /><span>{title}</span><span className="ml-auto text-[10px] font-normal">{items.length || ""}</span></button>{open && <div className="pb-2">{items.length === 0 ? <div className="ml-5 px-2 py-1.5 text-sm text-muted-foreground">No {title.toLowerCase()} campaigns.</div> : items.map((item) => <button key={item.id} onClick={() => onSelect(item.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${selectedId === item.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/70 hover:text-foreground"}`}><FileText className="h-3.5 w-3.5" /><span className="min-w-0 flex-1 truncate">{item.name}</span></button>)}</div>}</section>;
}

function CampaignEditor({ campaign, audiences, canWrite, saving, onSave, onDelete }: { campaign: Campaign; audiences: Audience[]; canWrite: boolean; saving: boolean; onSave: (patch: Partial<Campaign>) => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(campaign);
  const [preview, setPreview] = useState(false);
  useEffect(() => setDraft(campaign), [campaign]);
  const audience = useMemo(() => audiences.find((item) => item.id === draft.audienceId), [audiences, draft.audienceId]);
  return <div className="max-w-5xl space-y-6">
    <div><h1 className="text-xl font-semibold text-foreground">{campaign.name}</h1><p className="text-sm text-muted-foreground">Draft and preview only. Sending remains a separate human action.</p></div>
    <Card className="min-w-0 overflow-hidden p-4 space-y-4">
      <div className="grid gap-4 md:grid-cols-2"><label className="space-y-1"><span className="text-sm font-medium">Campaign name</span><Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} disabled={!canWrite} /></label><label className="space-y-1"><span className="text-sm font-medium">Audience</span><Select value={draft.audienceId ?? "none"} onValueChange={(value) => setDraft({ ...draft, audienceId: value === "none" ? null : value })} disabled={!canWrite}><SelectTrigger><SelectValue placeholder="Choose an audience" /></SelectTrigger><SelectContent><SelectItem value="none">No audience selected</SelectItem>{audiences.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {item.definition.personIds.length}</SelectItem>)}</SelectContent></Select></label></div>
      <div className="grid gap-4 md:grid-cols-3"><label className="space-y-1"><span className="text-sm font-medium">Sender name</span><Input value={draft.senderName} onChange={(event) => setDraft({ ...draft, senderName: event.target.value })} disabled={!canWrite} /></label><label className="space-y-1"><span className="text-sm font-medium">From</span><Input type="email" value={draft.senderEmail} onChange={(event) => setDraft({ ...draft, senderEmail: event.target.value })} disabled={!canWrite} /></label><label className="space-y-1"><span className="text-sm font-medium">Reply to</span><Input type="email" value={draft.replyToEmail} onChange={(event) => setDraft({ ...draft, replyToEmail: event.target.value })} disabled={!canWrite} /></label></div>
      <label className="block space-y-1"><span className="text-sm font-medium">Subject</span><Input value={draft.subject} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} disabled={!canWrite} /></label>
      <label className="block space-y-1"><span className="text-sm font-medium">Body</span><Textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} disabled={!canWrite} rows={12} placeholder="Write the update…" /></label>
      <p className="text-xs text-muted-foreground">{audience ? `${audience.definition.personIds.length} People currently match ${audience.name}. Recipient snapshots and delivery records activate with the future human send action.` : "Choose an audience before this campaign can eventually be sent."}</p>
    </Card>
    {preview && <Card className="min-w-0 overflow-hidden p-6"><div className="mx-auto max-w-3xl space-y-4"><div className="border-b border-border pb-4"><div className="text-xs text-muted-foreground">From {draft.senderName} &lt;{draft.senderEmail}&gt;</div><div className="mt-2 text-lg font-semibold text-foreground">{draft.subject || "Untitled email"}</div></div><div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{draft.body || "Nothing written yet."}</div></div></Card>}
    <div className="flex flex-wrap items-center gap-2"><Button disabled={!canWrite || saving || !draft.name.trim()} onClick={() => onSave({ name: draft.name.trim(), audienceId: draft.audienceId, senderName: draft.senderName, senderEmail: draft.senderEmail, replyToEmail: draft.replyToEmail, subject: draft.subject, body: draft.body })}>{saving ? "Saving…" : "Save Draft"}</Button><Button variant="outline" onClick={() => setPreview(!preview)}>{preview ? "Hide Preview" : "Preview"}</Button><span className="text-xs text-muted-foreground">No send control is enabled.</span><Button variant="ghost" className="ml-auto text-destructive" disabled={!canWrite} onClick={onDelete}><Trash2 className="mr-2 h-4 w-4" />Delete</Button></div>
  </div>;
}
