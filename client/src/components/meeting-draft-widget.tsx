import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { isValidReferenceIdentifier } from "@shared/references";

interface MeetingDraft {
  id: string;
  googleAccountId: string | null;
  calendarId: string;
  summary: string;
  startAt: string;
  endAt: string | null;
  timeZone: string;
  attendees: string[];
  location: string | null;
  description: string | null;
  status: "draft" | "scheduling" | "scheduled" | "discarded";
  googleEventId: string | null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-xs text-muted-foreground"><span>{label}</span>{children}</label>;
}

export function MeetingDraftWidget({ draftId }: { draftId: string }) {
  const valid = isValidReferenceIdentifier("meeting_draft", draftId);
  const [edits, setEdits] = useState<Partial<MeetingDraft>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const query = useQuery<{ draft: MeetingDraft }>({
    queryKey: ["/api/meeting-drafts", draftId], enabled: valid,
    queryFn: async () => (await fetch(`/api/meeting-drafts/${draftId}`, { credentials: "include" })).json(),
    refetchInterval: state => state.state.data?.draft?.status === "scheduling" ? 1500 : false,
  });
  const draft = query.data?.draft;
  const merged = useMemo(() => draft ? { ...draft, ...edits } : null, [draft, edits]);
  const patch = useMutation({
    mutationFn: async (value: Record<string, unknown>) => (await apiRequest("PATCH", `/api/meeting-drafts/${draftId}`, value)).json(),
    onSuccess: result => { queryClient.setQueryData(["/api/meeting-drafts", draftId], result); setEdits({}); },
  });
  const mutate = (field: string, value: unknown) => {
    setEdits(current => ({ ...current, [field]: value }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => patch.mutate({ [field]: value }), 400);
  };
  const flush = async () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (Object.keys(edits).length) await apiRequest("PATCH", `/api/meeting-drafts/${draftId}`, edits);
  };
  const schedule = useMutation({
    mutationFn: async () => { await flush(); return (await apiRequest("POST", `/api/meeting-drafts/${draftId}/schedule`)).json(); },
    onSuccess: result => { queryClient.setQueryData(["/api/meeting-drafts", draftId], result); setEdits({}); },
  });
  const discard = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/meeting-drafts/${draftId}/discard`)).json(),
    onSuccess: result => queryClient.setQueryData(["/api/meeting-drafts", draftId], result),
  });
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  if (!valid) return null;
  if (query.isLoading) return <div className="my-1 flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading meeting draft…</div>;
  if (!merged) return <div className="my-1 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">Meeting draft unavailable</div>;
  if (merged.status === "discarded") return <div className="my-1 flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 text-sm text-muted-foreground"><X className="h-3.5 w-3.5" />Meeting draft discarded</div>;
  if (merged.status === "scheduled") return <div className="my-1 flex items-center gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm"><Check className="h-3.5 w-3.5 text-success" /><span className="font-medium text-success">Scheduled</span><span className="truncate text-muted-foreground">{merged.summary}</span></div>;
  if (merged.status === "scheduling") return <div className="my-1 flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-active" />Scheduling meeting…</div>;

  const missing = !merged.summary.trim() || !merged.startAt || !merged.endAt || !merged.googleAccountId;
  const inputClass = "min-h-11 rounded-sm border border-border/30 bg-transparent px-2 text-sm text-foreground outline-none focus:border-border/60";
  return <div className="my-1 min-w-0 overflow-hidden rounded-md border border-border/60 bg-muted/20">
    <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2"><CalendarDays className="h-3.5 w-3.5 text-cta" /><span className="flex-1 text-sm font-medium">Meeting Draft</span>{patch.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}</div>
    <div className="grid gap-3 px-3 py-3 sm:grid-cols-2">
      <Field label="Title"><input className={`${inputClass} sm:col-span-2`} value={merged.summary} onChange={event => mutate("summary", event.target.value)} /></Field>
      <Field label="Calendar account"><input className={inputClass} value={merged.googleAccountId ?? ""} placeholder="Choose connected account" onChange={event => mutate("googleAccountId", event.target.value)} /></Field>
      <Field label="Time zone"><input className={inputClass} value={merged.timeZone} onChange={event => mutate("timeZone", event.target.value)} /></Field>
      <Field label="Start"><input className={inputClass} type="datetime-local" value={merged.startAt.slice(0, 16)} onChange={event => mutate("start", event.target.value)} /></Field>
      <Field label="End"><input className={inputClass} type="datetime-local" value={(merged.endAt ?? "").slice(0, 16)} onChange={event => mutate("end", event.target.value)} /></Field>
      <Field label="Attendees"><input className={inputClass} value={merged.attendees.join(", ")} placeholder="name@example.com" onChange={event => mutate("attendees", event.target.value.split(",").map(value => value.trim()).filter(Boolean))} /></Field>
      <Field label="Location or video"><input className={inputClass} value={merged.location ?? ""} onChange={event => mutate("location", event.target.value)} /></Field>
      <label className="grid gap-1 text-xs text-muted-foreground sm:col-span-2"><span>Description</span><textarea className={`${inputClass} min-h-20 resize-y py-2`} value={merged.description ?? ""} onChange={event => mutate("description", event.target.value)} /></label>
    </div>
    <div className="flex min-h-11 items-center gap-2 border-t border-border/40 bg-card px-3 py-2">
      <Button size="sm" className="gap-1.5 bg-cta text-cta-foreground" disabled={missing || schedule.isPending} onClick={() => schedule.mutate()}>{schedule.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarDays className="h-3.5 w-3.5" />}Approve & schedule</Button>
      <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={schedule.isPending || discard.isPending} onClick={() => discard.mutate()}><X className="h-3.5 w-3.5" />Discard</Button>
      {missing && <span className="ml-auto text-xs text-warning">Complete the missing fields</span>}
      {schedule.isError && <span className="ml-auto text-xs text-destructive">{(schedule.error as Error).message}</span>}
    </div>
  </div>;
}
