import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, MoreHorizontal, Plus, Trash2, Users } from "lucide-react";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { ProfileDetailSection } from "@/components/profile-detail-section";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { usePageHeader } from "@/hooks/use-page-header";
import { usePageLoadActivity } from "@/hooks/use-page-activity";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

function invalidateAudiences() {
  queryClient.invalidateQueries({ queryKey: ["/api/communications/audiences"] });
}

export default function AudiencesPage() {
  usePageHeader({ title: "Audiences" });
  const { hasPermission } = useAuth();
  const canWrite = hasPermission("system:write");
  const { data, isLoading, error, refetch } = useQuery<{ audiences: Audience[] }>({ queryKey: ["/api/communications/audiences"] });
  usePageLoadActivity("page:audiences", isLoading);
  const people = usePeopleChoices();
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const audiences = data?.audiences ?? [];
  const filtered = audiences.filter((audience) => audience.name.toLowerCase().includes(search.toLowerCase()));

  const createMutation = useMutation({
    mutationFn: async (name: string) => (await apiRequest("POST", "/api/communications/audiences", { name, personIds: [] })).json() as Promise<Audience>,
    onSuccess: (audience) => {
      invalidateAudiences();
      setCreating(false);
      setOpenId(audience.id);
    },
  });

  if (!hasPermission("system:read")) {
    return <div className="px-2 py-1.5 text-sm text-muted-foreground">Audiences requires system:read.</div>;
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background" data-testid="audiences-page">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={search}
          onChange={setSearch}
          inputTestId="input-search-audiences"
          clearTestId="button-clear-audience-search"
          ariaLabel="Search audiences"
        />
        {creating ? (
          <NewAudience
            pending={createMutation.isPending}
            onSubmit={(name) => createMutation.mutate(name)}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <button
            type="button"
            disabled={!canWrite}
            onClick={() => { setOpenId(null); setCreating(true); }}
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            data-testid="button-new-audience"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />New Audience
          </button>
        )}

        {isLoading ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading audiences…</div>
        ) : error ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            Audiences unavailable. <button type="button" className="text-cta" onClick={() => void refetch()}>Try again</button>
          </div>
        ) : (
          <div className="space-y-1">
            <AudienceSection
              label="Active"
              items={filtered.filter((item) => item.status === "active")}
              people={people}
              canWrite={canWrite}
              openId={openId}
              setOpenId={(id) => { setCreating(false); setOpenId(id); }}
            />
            <AudienceSection
              label="Archived"
              items={filtered.filter((item) => item.status === "archived")}
              people={people}
              canWrite={canWrite}
              openId={openId}
              setOpenId={(id) => { setCreating(false); setOpenId(id); }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function NewAudience({ pending, onSubmit, onCancel }: { pending: boolean; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Input
        autoFocus
        value={name}
        disabled={pending}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && name.trim()) onSubmit(name.trim());
          if (event.key === "Escape") onCancel();
        }}
        placeholder="Audience name"
        className="h-7 text-sm"
        data-testid="input-new-audience-name"
      />
    </div>
  );
}

function AudienceSection({
  label,
  items,
  people,
  canWrite,
  openId,
  setOpenId,
}: {
  label: string;
  items: Audience[];
  people: PersonChoice[];
  canWrite: boolean;
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label} · {items.length}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {items.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No {label.toLowerCase()} audiences.</div>
        ) : items.map((item) => (
          <AudienceRow
            key={item.id}
            audience={item}
            people={people}
            canWrite={canWrite}
            open={openId === item.id}
            onToggle={() => setOpenId(openId === item.id ? null : item.id)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function AudienceRow({
  audience,
  people,
  canWrite,
  open,
  onToggle,
}: {
  audience: Audience;
  people: PersonChoice[];
  canWrite: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const count = audience.definition.personIds.length;
  const updateMutation = useMutation({
    mutationFn: async (patch: Partial<Pick<Audience, "name" | "description" | "status">> & { personIds?: string[] }) =>
      (await apiRequest("PATCH", `/api/communications/audiences/${audience.id}`, patch)).json(),
    onSuccess: invalidateAudiences,
  });
  const deleteMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/communications/audiences/${audience.id}`),
    onSuccess: () => {
      invalidateAudiences();
      if (open) onToggle();
    },
  });

  return (
    <div data-testid={`audience-row-${audience.id}`}>
      <div
        className={cn(
          HIERARCHY_SESSION_ROW_CLASS,
          "min-w-0 hover:bg-accent/70",
          open && "bg-accent text-foreground",
        )}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{audience.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{count} {count === 1 ? "person" : "people"}</span>
        <span className="ml-1 flex w-5 shrink-0 items-center justify-center">
          <button
            type="button"
            className="rounded p-0.5 hover:bg-accent/60"
            onClick={(event) => { event.stopPropagation(); onToggle(); }}
            aria-label={open ? "Collapse audience" : "Expand audience"}
          >
            <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
          </button>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-5 shrink-0 items-center justify-center rounded p-0.5 opacity-0 transition-opacity hover:bg-accent/60 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              data-testid={`button-audience-menu-${audience.id}`}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Actions for ${audience.name}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={(event) => event.preventDefault()}>
            <DropdownMenuItem
              disabled={!canWrite || updateMutation.isPending}
              onClick={(event) => {
                event.stopPropagation();
                updateMutation.mutate({ status: audience.status === "active" ? "archived" : "active" });
              }}
            >
              {audience.status === "active" ? "Archive" : "Restore"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canWrite}
              className="text-destructive focus:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <AudienceEditor
          audience={audience}
          people={people}
          canWrite={canWrite}
          saving={updateMutation.isPending}
          onSave={(patch) => updateMutation.mutate(patch)}
        />
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {audience.name}?</AlertDialogTitle>
            <AlertDialogDescription>Campaigns keep any snapshot they already took. This reusable audience definition will be removed.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(event) => { event.preventDefault(); deleteMutation.mutate(); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AudienceEditor({
  audience,
  people,
  canWrite,
  saving,
  onSave,
}: {
  audience: Audience;
  people: PersonChoice[];
  canWrite: boolean;
  saving: boolean;
  onSave: (patch: { name: string; description: string; personIds: string[]; status: "active" | "archived" }) => void;
}) {
  const [name, setName] = useState(audience.name);
  const [description, setDescription] = useState(audience.description);
  const [personIds, setPersonIds] = useState<string[]>(audience.definition.personIds);
  const [personSearch, setPersonSearch] = useState("");
  const visiblePeople = people.filter((person) => `${person.name} ${person.emails.join(" ")}`.toLowerCase().includes(personSearch.toLowerCase()));

  return (
    <div className="space-y-1 pb-2" data-testid={`audience-editor-${audience.id}`}>
      <ProfileDetailSection title="Audience" defaultOpen>
        <ProfileTreeRow label="Name" hasValue showEmpty mobileLayout="inline">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={!canWrite}
            className="h-7 w-56 text-right"
            data-testid="input-audience-name"
          />
        </ProfileTreeRow>
        <ProfileTreeRow label="Description" hasValue={Boolean(description.trim())} showEmpty mobileLayout="stacked">
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            disabled={!canWrite}
            rows={3}
            className="min-h-20"
            data-testid="textarea-audience-description"
          />
        </ProfileTreeRow>
      </ProfileDetailSection>
      <ProfileDetailSection title="People" count={personIds.length} defaultOpen>
        <HierarchySearchInput
          value={personSearch}
          onChange={setPersonSearch}
          inputTestId="input-search-audience-people"
          clearTestId="button-clear-audience-people-search"
          ariaLabel="Search People"
        />
        {visiblePeople.length === 0 ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No matching People with email addresses.</div>
        ) : visiblePeople.map((person) => {
          const checked = personIds.includes(person.id);
          return (
            <ProfileTreeRow
              key={person.id}
              label={person.name}
              icon={<Users className="h-3.5 w-3.5" />}
              hasValue
              showEmpty
              mobileLayout="inline"
              actionContent={
                <Checkbox
                  checked={checked}
                  disabled={!canWrite}
                  onCheckedChange={(next) => setPersonIds((current) => next ? [...current, person.id] : current.filter((id) => id !== person.id))}
                  aria-label={`Include ${person.name}`}
                />
              }
            >
              <span className="truncate text-xs text-muted-foreground">{person.emails.join(", ")}</span>
            </ProfileTreeRow>
          );
        })}
      </ProfileDetailSection>
      <div className="flex justify-end px-2 py-1">
        <Button
          size="sm"
          disabled={!canWrite || saving || !name.trim()}
          onClick={() => onSave({ name: name.trim(), description, personIds, status: audience.status })}
          data-testid="button-save-audience"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
