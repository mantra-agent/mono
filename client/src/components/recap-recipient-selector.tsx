import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Plus, UserRound } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface PersonSearchResult {
  id: string;
  name: string;
  company?: string;
  role?: string;
}

interface PersonDetail extends PersonSearchResult {
  contactInfo: Array<{ type: string; label: string; value: string }>;
}

export interface RecapRecipientSelection {
  personId: string;
  name: string;
  email: string;
}

interface RecapRecipientSelectorProps {
  draftId: string;
  selected: RecapRecipientSelection | null;
  disabled: boolean;
  onMutationStateChange: (state: { pending: boolean; failed: boolean }) => void;
}

function personEmails(person: PersonDetail): string[] {
  return [...new Set(
    person.contactInfo
      .filter(contact => contact.type === "email" && contact.value.trim())
      .map(contact => contact.value.trim().toLowerCase()),
  )];
}

export function RecapRecipientSelector({
  draftId,
  selected,
  disabled,
  onMutationStateChange,
}: RecapRecipientSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [personId, setPersonId] = useState<string | null>(selected?.personId ?? null);
  const [emailToAdd, setEmailToAdd] = useState("");

  useEffect(() => setPersonId(selected?.personId ?? null), [selected?.personId]);

  const { data: peopleSearchData } = useQuery<{ people: PersonSearchResult[] }>({
    queryKey: ["/api/people/search", query],
    queryFn: async () => {
      const response = await fetch(`/api/people/search?q=${encodeURIComponent(query.trim())}`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not search People");
      const payload = await response.json();
      return { people: Array.isArray(payload.people) ? payload.people : [] };
    },
    enabled: open && query.trim().length >= 2,
  });
  const people = peopleSearchData?.people.slice(0, 12) ?? [];

  const { data: person } = useQuery<PersonDetail>({
    queryKey: ["/api/people", personId],
    queryFn: async () => {
      const response = await fetch(`/api/people/${personId}`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load Person");
      return response.json();
    },
    enabled: open && !!personId,
  });
  const emails = useMemo(() => person ? personEmails(person) : [], [person]);

  const selectMutation = useMutation({
    mutationFn: async ({ targetPersonId, email }: { targetPersonId: string; email: string }) => {
      const response = await apiRequest("POST", `/api/email-drafts/${draftId}/recap-recipient`, {
        personId: targetPersonId,
        email,
      });
      return response.json();
    },
    onSuccess: result => {
      queryClient.setQueryData(["/api/email-drafts", draftId], (old: any) => old
        ? { ...old, draft: result.draft, recipientMode: result.recipientMode }
        : old,
      );
      setOpen(false);
      setQuery("");
    },
  });

  const addEmailMutation = useMutation({
    mutationFn: async () => {
      if (!personId) throw new Error("Choose a Person first");
      const response = await apiRequest("POST", `/api/people/${personId}/emails`, { email: emailToAdd });
      return response.json() as Promise<PersonDetail>;
    },
    onSuccess: async updatedPerson => {
      const normalizedEmail = emailToAdd.trim().toLowerCase();
      queryClient.setQueryData(["/api/people", personId], updatedPerson);
      queryClient.invalidateQueries({ queryKey: ["/api/people"] });
      setEmailToAdd("");
      await selectMutation.mutateAsync({ targetPersonId: updatedPerson.id, email: normalizedEmail });
    },
  });

  const isPending = selectMutation.isPending || addEmailMutation.isPending;
  const error = selectMutation.error || addEmailMutation.error;
  useEffect(() => {
    onMutationStateChange({ pending: isPending, failed: !!error });
  }, [error, isPending, onMutationStateChange]);
  useEffect(() => () => {
    onMutationStateChange({ pending: false, failed: false });
  }, [onMutationStateChange]);

  return (
    <div className="flex items-start gap-2 min-h-[28px]">
      <span className="w-8 shrink-0 pt-1 text-xs text-muted-foreground">To</span>
      <div className="min-w-0 flex-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={disabled || isPending}
              className="flex min-h-7 w-full items-center gap-2 rounded-sm border border-border/40 px-2 py-1 text-left text-xs hover:bg-accent disabled:opacity-50"
            >
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserRound className="h-3.5 w-3.5" />}
              <span className="min-w-0 flex-1 truncate">
                {selected ? `${selected.name} · ${selected.email}` : "Choose a Person and email…"}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] space-y-2 p-2">
            {!personId ? (
              <>
                <Input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="Search People…"
                  className="h-9 text-sm"
                  autoFocus
                />
                <div className="max-h-48 overflow-y-auto">
                  {query.trim().length < 2 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">Type at least two characters.</div>
                  )}
                  {query.trim().length >= 2 && people.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No matching People.</div>
                  )}
                  {people.map(candidate => (
                    <button
                      key={candidate.id}
                      type="button"
                      className="w-full rounded-sm px-2 py-2 text-left hover:bg-accent"
                      onClick={() => setPersonId(candidate.id)}
                    >
                      <div className="text-sm font-medium">{candidate.name}</div>
                      {(candidate.role || candidate.company) && (
                        <div className="text-xs text-muted-foreground">
                          {[candidate.role, candidate.company].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 px-1">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{person?.name || selected?.name || "Person"}</div>
                    <div className="text-xs text-muted-foreground">Choose one linked email</div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setPersonId(null); setQuery(""); }} disabled={isPending}>
                    Change
                  </Button>
                </div>
                <div className="max-h-40 overflow-y-auto">
                  {emails.map(email => (
                    <button
                      key={email}
                      type="button"
                      className="w-full rounded-sm px-2 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => selectMutation.mutate({ targetPersonId: personId, email })}
                      disabled={isPending}
                    >
                      {email}
                    </button>
                  ))}
                  {person && emails.length === 0 && (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No email yet.</div>
                  )}
                </div>
                <div className="flex gap-2 border-t border-border/40 pt-2">
                  <Input
                    type="email"
                    value={emailToAdd}
                    onChange={event => setEmailToAdd(event.target.value)}
                    placeholder="Add email"
                    className="h-9 text-sm"
                    disabled={isPending}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => addEmailMutation.mutate()}
                    disabled={isPending || !emailToAdd.trim()}
                    aria-label="Add email and select it"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </>
            )}
            {error && (
              <div className="px-1 text-xs text-destructive">
                {error instanceof Error ? error.message : "Recipient update failed"}
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
