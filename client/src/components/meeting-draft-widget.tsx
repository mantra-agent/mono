import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CalendarDays, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

interface GoogleAccount {
  id: string;
  email: string;
  label?: string;
  healthy?: boolean;
  scopes?: {
    hasCalendar?: boolean;
    hasCalendarReadonly?: boolean;
  };
}

function toLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-12 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function MeetingDraftWidget({ draftId }: { draftId: string }) {
  const valid = isValidReferenceIdentifier("meeting_draft", draftId);
  const [edits, setEdits] = useState<Partial<MeetingDraft>>({});
  const [showDetails, setShowDetails] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useQuery<{ draft: MeetingDraft }>({
    queryKey: ["/api/meeting-drafts", draftId],
    enabled: valid,
    queryFn: async () => (await fetch(`/api/meeting-drafts/${draftId}`, { credentials: "include" })).json(),
    refetchInterval: (state) => (state.state.data?.draft?.status === "scheduling" ? 1500 : false),
  });

  const draft = query.data?.draft;
  const merged = useMemo(() => (draft ? { ...draft, ...edits } : null), [draft, edits]);

  const { data: accountsData } = useQuery<{ accounts: GoogleAccount[] }>({
    queryKey: ["/api/gmail/accounts"],
    enabled: !!draft && draft.status === "draft",
  });

  const accounts = useMemo(
    () =>
      (accountsData?.accounts ?? []).filter(
        (account) => account.healthy !== false && account.scopes?.hasCalendar === true,
      ),
    [accountsData?.accounts],
  );

  const selectedAccount = accounts.find((account) => account.id === merged?.googleAccountId);

  const patch = useMutation({
    mutationFn: async (value: Record<string, unknown>) =>
      (await apiRequest("PATCH", `/api/meeting-drafts/${draftId}`, value)).json(),
    onSuccess: (result, value) => {
      queryClient.setQueryData(["/api/meeting-drafts", draftId], result);
      setEdits((current) => {
        const remaining = { ...current };
        for (const [field, next] of Object.entries(value)) {
          if ((remaining as Record<string, unknown>)[field] === next) {
            delete (remaining as Record<string, unknown>)[field];
          }
        }
        return remaining;
      });
    },
  });

  const mutate = (field: string, value: unknown, immediate = false) => {
    setEdits((current) => ({ ...current, [field]: value }));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (immediate) {
      patch.mutate({ [field]: value });
      return;
    }
    debounceRef.current = setTimeout(() => patch.mutate({ [field]: value }), 400);
  };

  const flush = async () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (Object.keys(edits).length) await apiRequest("PATCH", `/api/meeting-drafts/${draftId}`, edits);
  };

  const schedule = useMutation({
    mutationFn: async () => {
      await flush();
      return (await apiRequest("POST", `/api/meeting-drafts/${draftId}/schedule`)).json();
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["/api/meeting-drafts", draftId], result);
      setEdits({});
    },
  });

  const discard = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/meeting-drafts/${draftId}/discard`)).json(),
    onSuccess: (result) => queryClient.setQueryData(["/api/meeting-drafts", draftId], result),
  });

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    if (!merged) return;
    if (merged.location || merged.description) setShowDetails(true);
  }, [merged?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!valid) return null;
  if (query.isLoading) {
    return (
      <div className="my-1 flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading meeting draft…
      </div>
    );
  }
  if (!merged) {
    return (
      <div className="my-1 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        Meeting draft unavailable
      </div>
    );
  }
  if (merged.status === "discarded") {
    return (
      <div className="my-1 flex items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-2 text-sm text-muted-foreground">
        <X className="h-3.5 w-3.5" />
        Meeting draft discarded
      </div>
    );
  }
  if (merged.status === "scheduled") {
    return (
      <div className="my-1 flex items-center gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2 text-sm">
        <Check className="h-3.5 w-3.5 text-success" />
        <span className="font-medium text-success">Scheduled</span>
        <span className="truncate text-muted-foreground">{merged.summary}</span>
      </div>
    );
  }
  if (merged.status === "scheduling") {
    return (
      <div className="my-1 flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-active" />
        Scheduling meeting…
      </div>
    );
  }

  const missing =
    !merged.summary.trim() ||
    !merged.startAt ||
    !merged.endAt ||
    !merged.googleAccountId ||
    (accounts.length > 0 && !selectedAccount);
  const busy = schedule.isPending || discard.isPending;
  const inputClass =
    "h-7 w-full rounded-sm border border-border/30 bg-transparent px-2 text-xs text-foreground outline-none focus:border-border/60";

  return (
    <div className="my-1 min-w-0 overflow-hidden rounded-md border border-border/60 bg-muted/20">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5">
        <CalendarDays className="h-3.5 w-3.5 shrink-0 text-cta" />
        <span className="flex-1 text-sm font-medium">Meeting Draft</span>
        {patch.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>

      <div className="space-y-1.5 px-3 py-2">
        <Row label="Title">
          <input
            className={inputClass}
            value={merged.summary}
            disabled={busy}
            onChange={(event) => mutate("summary", event.target.value)}
          />
        </Row>

        <Row label="From">
          {accounts.length > 0 ? (
            <Select
              value={merged.googleAccountId || ""}
              onValueChange={(value) => mutate("googleAccountId", value, true)}
              disabled={busy}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder="Select account">
                  {selectedAccount?.email || merged.googleAccountId || "Select account"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id} className="text-xs">
                    {account.email}
                    {account.label ? ` · ${account.label}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="text-xs text-destructive">No Google Calendar account available.</span>
          )}
        </Row>

        <div className="grid gap-1.5 sm:grid-cols-2">
          <Row label="Start">
            <input
              className={inputClass}
              type="datetime-local"
              value={toLocalInput(merged.startAt)}
              disabled={busy}
              onChange={(event) => mutate("start", event.target.value)}
            />
          </Row>
          <Row label="End">
            <input
              className={inputClass}
              type="datetime-local"
              value={toLocalInput(merged.endAt)}
              disabled={busy}
              onChange={(event) => mutate("end", event.target.value)}
            />
          </Row>
        </div>

        <Row label="Who">
          <input
            className={inputClass}
            value={merged.attendees.join(", ")}
            placeholder="name@example.com"
            disabled={busy}
            onChange={(event) =>
              mutate(
                "attendees",
                event.target.value
                  .split(",")
                  .map((value) => value.trim())
                  .filter(Boolean),
              )
            }
          />
        </Row>

        {(showDetails || merged.location || merged.description) && (
          <>
            <Row label="Where">
              <input
                className={inputClass}
                value={merged.location ?? ""}
                disabled={busy}
                onChange={(event) => mutate("location", event.target.value)}
              />
            </Row>
            <div className="flex min-w-0 items-start gap-2">
              <span className="w-12 shrink-0 pt-1.5 text-xs text-muted-foreground">Notes</span>
              <textarea
                className={`${inputClass} min-h-14 resize-y py-1.5`}
                value={merged.description ?? ""}
                disabled={busy}
                onChange={(event) => mutate("description", event.target.value)}
              />
            </div>
            <Row label="TZ">
              <input
                className={inputClass}
                value={merged.timeZone}
                disabled={busy}
                onChange={(event) => mutate("timeZone", event.target.value)}
              />
            </Row>
          </>
        )}

        {!showDetails && !merged.location && !merged.description && (
          <button
            type="button"
            className="pl-14 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowDetails(true)}
          >
            Add location or notes
          </button>
        )}
      </div>

      <div className="flex min-h-10 items-center gap-2 border-t border-border/40 bg-card px-3 py-1.5">
        <Button
          size="sm"
          className="h-8 gap-1.5 bg-cta text-cta-foreground"
          disabled={missing || busy}
          onClick={() => schedule.mutate()}
        >
          {schedule.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CalendarDays className="h-3.5 w-3.5" />
          )}
          Schedule
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-muted-foreground"
          disabled={busy}
          onClick={() => discard.mutate()}
        >
          <X className="h-3.5 w-3.5" />
          Discard
        </Button>
        {missing && <span className="ml-auto text-xs text-warning">Finish required fields</span>}
        {schedule.isError && (
          <span className="ml-auto text-xs text-destructive">{(schedule.error as Error).message}</span>
        )}
      </div>
    </div>
  );
}
