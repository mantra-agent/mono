import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronRight, ClipboardList, Loader2, MessageSquare, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import type {
  AgendaDefinition,
  AgendaDefinitionCreate,
  AgendaDefinitionItemInput,
  AgendaDefinitionUpdate,
} from "@shared/models/agendas";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
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
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAgendaDiscussion } from "@/hooks/use-agenda-discussion";
import { buildAgendaDefinitionDiscussionMessage } from "@/lib/agenda-discussion";
import { usePageHeader } from "@/hooks/use-page-header";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

interface AgendasResponse {
  agendas: AgendaDefinition[];
}

interface AgendaDraft {
  name: string;
  description: string;
  items: AgendaDefinitionItemInput[];
}

const EMPTY_ITEM: AgendaDefinitionItemInput = { title: "", description: "" };

function draftFromAgenda(agenda?: AgendaDefinition): AgendaDraft {
  return agenda
    ? {
        name: agenda.name,
        description: agenda.description ?? "",
        items: agenda.items.map((item) => ({ ...item })),
      }
    : { name: "", description: "", items: [{ ...EMPTY_ITEM }] };
}

function mutationErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "The agenda was not saved.";
  const jsonStart = error.message.indexOf("{");
  if (jsonStart === -1) return error.message;
  try {
    const parsed = JSON.parse(error.message.slice(jsonStart)) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : error.message;
  } catch {
    return error.message;
  }
}

function AgendaEditor({ agenda, onClose }: { agenda?: AgendaDefinition; onClose: () => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<AgendaDraft>(() => draftFromAgenda(agenda));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({
    predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/agendas"),
  });

  const save = useMutation({
    mutationFn: async () => {
      const items = draft.items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        title: item.title.trim(),
        description: item.description.trim(),
      }));
      if (agenda) {
        const patch: AgendaDefinitionUpdate = {
          name: draft.name.trim(),
          items,
          ...(draft.description.trim()
            ? { description: draft.description.trim() }
            : agenda.description
              ? { clearFields: ["description"] }
              : {}),
        };
        return (await apiRequest("PATCH", `/api/agendas/${agenda.id}`, patch)).json() as Promise<AgendaDefinition>;
      }
      const input: AgendaDefinitionCreate = {
        name: draft.name.trim(),
        items,
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      };
      return (await apiRequest("POST", "/api/agendas", input)).json() as Promise<AgendaDefinition>;
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: (error) => toast({ title: "Could not save agenda", description: mutationErrorMessage(error), variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!agenda) return;
      await apiRequest("DELETE", `/api/agendas/${agenda.id}`);
    },
    onSuccess: () => {
      invalidate();
      setDeleteOpen(false);
      onClose();
    },
    onError: (error) => toast({ title: "Could not delete agenda", description: mutationErrorMessage(error), variant: "destructive" }),
  });

  const canSave = Boolean(
    draft.name.trim()
      && draft.items.length > 0
      && draft.items.every((item) => item.title.trim() && item.description.trim()),
  );

  const updateItem = (index: number, patch: Partial<AgendaDefinitionItemInput>) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }));
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= current.items.length) return current;
      const items = [...current.items];
      [items[index], items[targetIndex]] = [items[targetIndex], items[index]];
      return { ...current, items };
    });
  };

  return (
    <div className="ml-6 space-y-3 border-l border-border/40 pb-3 pl-3 pr-2 pt-2" data-testid={agenda ? `agenda-editor-${agenda.id}` : "agenda-editor-new"}>
      <Input
        autoFocus={!agenda}
        value={draft.name}
        onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        placeholder="Agenda name"
        data-testid="input-agenda-name"
      />
      <Textarea
        value={draft.description}
        onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
        placeholder="Description (optional)"
        className="min-h-20"
        data-testid="textarea-agenda-description"
      />

      <div className="space-y-2">
        {draft.items.map((item, index) => (
          <div key={item.id ?? `new-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md bg-muted/40 p-2">
            <div className="min-w-0 space-y-2">
              <Input
                value={item.title}
                onChange={(event) => updateItem(index, { title: event.target.value })}
                placeholder="Simple 3–5 word title"
                data-testid={`input-agenda-item-title-${index}`}
              />
              <Textarea
                value={item.description}
                onChange={(event) => updateItem(index, { description: event.target.value })}
                placeholder="What should happen in this step?"
                className="min-h-20"
                data-testid={`textarea-agenda-item-description-${index}`}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" disabled={index === 0} onClick={() => moveItem(index, -1)} aria-label={`Move item ${index + 1} up`}>
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" disabled={index === draft.items.length - 1} onClick={() => moveItem(index, 1)} aria-label={`Move item ${index + 1} down`}>
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-muted-foreground hover:text-destructive"
                disabled={draft.items.length === 1}
                onClick={() => setDraft((current) => ({ ...current, items: current.items.filter((_, itemIndex) => itemIndex !== index) }))}
                aria-label={`Remove item ${index + 1}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="flex items-center gap-2 px-2 py-1.5 text-sm text-cta hover:text-cta/80"
        onClick={() => setDraft((current) => ({ ...current, items: [...current.items, { ...EMPTY_ITEM }] }))}
        data-testid="button-add-agenda-item"
      >
        <Plus className="h-3.5 w-3.5" />Add Item
      </button>

      <div className="flex items-center justify-between gap-2">
        <div>
          {agenda && !agenda.reservedKey && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button type="button" size="sm" disabled={!canSave || save.isPending} onClick={() => save.mutate()} data-testid="button-save-agenda">
            {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save
          </Button>
        </div>
      </div>

      {agenda && (
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {agenda.name}?</AlertDialogTitle>
              <AlertDialogDescription>Existing Sessions keep their snapshots. This reusable agenda definition will be removed.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={remove.isPending}
                onClick={(event) => { event.preventDefault(); remove.mutate(); }}
              >
                {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

function AgendaRow({ agenda, open, onToggle }: { agenda: AgendaDefinition; open: boolean; onToggle: () => void }) {
  const discuss = useAgendaDiscussion();
  return (
    <div data-testid={`agenda-row-${agenda.id}`}>
      <div className="group relative min-w-0">
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            HIERARCHY_SESSION_ROW_CLASS,
            "min-w-0 pr-9 hover:bg-accent/70",
            open && "bg-accent text-foreground",
          )}
          aria-expanded={open}
        >
          <ClipboardList className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{agenda.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{agenda.items.length} {agenda.items.length === 1 ? "item" : "items"}</span>
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-border/40 bg-background text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                open && "bg-accent text-foreground",
              )}
              data-testid={`button-agenda-menu-${agenda.id}`}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Actions for ${agenda.name}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]" onCloseAutoFocus={(event) => event.preventDefault()}>
            <DropdownMenuItem
              disabled={discuss.isPending}
              onClick={(event) => {
                event.stopPropagation();
                if (discuss.isPending) return;
                discuss.mutate({
                  pendingKey: agenda.id,
                  title: agenda.name,
                  message: buildAgendaDefinitionDiscussionMessage(agenda),
                  clientTurnSuffix: agenda.id,
                });
              }}
              data-testid={`menu-agenda-discuss-${agenda.id}`}
            >
              {discuss.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <MessageSquare className="mr-2 h-3.5 w-3.5" />
              )}
              Discuss
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && <AgendaEditor agenda={agenda} onClose={onToggle} />}
    </div>
  );
}

function AgendaSection({ label, agendas, openId, setOpenId }: {
  label: string;
  agendas: AgendaDefinition[];
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover:bg-accent/70")}>
        <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")} />
        {label} · {agendas.length}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {agendas.length === 0
          ? <div className="px-2 py-1.5 text-sm text-muted-foreground">No agendas.</div>
          : agendas.map((agenda) => (
              <AgendaRow
                key={agenda.id}
                agenda={agenda}
                open={openId === agenda.id}
                onToggle={() => setOpenId(openId === agenda.id ? null : agenda.id)}
              />
            ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function AgendasPage() {
  usePageHeader({ title: "Agendas" });
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const endpoint = search.trim() ? `/api/agendas?query=${encodeURIComponent(search.trim())}` : "/api/agendas";
  const { data, isLoading, error, refetch } = useQuery<AgendasResponse>({ queryKey: [endpoint] });
  const sections = useMemo(() => {
    const agendas = data?.agendas ?? [];
    return {
      onboarding: agendas.filter((agenda) => agenda.reservedKey === "ftue"),
      agendas: agendas.filter((agenda) => agenda.reservedKey !== "ftue"),
    };
  }, [data?.agendas]);

  return (
    <div className="h-full w-full overflow-y-auto bg-background" data-testid="agendas-page">
      <div className={HIERARCHY_TREE_STACK_CLASS}>
        <HierarchySearchInput
          value={search}
          onChange={setSearch}
          inputTestId="input-search-agendas"
          clearTestId="button-clear-agenda-search"
          ariaLabel="Search agendas"
        />
        {creating
          ? <AgendaEditor onClose={() => setCreating(false)} />
          : (
            <button type="button" onClick={() => { setOpenId(null); setCreating(true); }} className={HIERARCHY_PRIMARY_ACTION_CLASS} data-testid="button-new-agenda">
              <Plus className="h-3.5 w-3.5 shrink-0" />New Agenda
            </button>
          )}

        {isLoading ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">Loading agendas…</div>
        ) : error ? (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">
            Agendas unavailable. <button type="button" className="text-cta" onClick={() => void refetch()}>Try again</button>
          </div>
        ) : (
          <div className="space-y-1">
            <AgendaSection label="Onboarding" agendas={sections.onboarding} openId={openId} setOpenId={(id) => { setCreating(false); setOpenId(id); }} />
            <AgendaSection label="Agendas" agendas={sections.agendas} openId={openId} setOpenId={(id) => { setCreating(false); setOpenId(id); }} />
          </div>
        )}
      </div>
    </div>
  );
}
