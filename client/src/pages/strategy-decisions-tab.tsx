import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { JSONContent } from "@tiptap/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Plus, Loader2, Trash2, Lock, Link2, X,
  ChevronRight, Check, Scale, MoreHorizontal, FolderInput,
} from "lucide-react";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_SESSION_ROW_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { RichTextEditor } from "@/components/rich-text-editor";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { SIMPLE_TEXT_FRAME_CLASS } from "@/components/home/simple-text-frame";
import { vaultTitleColor } from "@/lib/vault-title-color";
import { useVaults } from "@/hooks/use-vaults";
import { cn } from "@/lib/utils";

type DecisionStatus = "open" | "closed";
type DecisionTrafficLight = "green" | "yellow" | "red";

interface Decision {
  id: string;
  title: string;
  description: string;
  answer?: string | null;
  vaultId?: string | null;
  status: DecisionStatus;
  trafficLight: DecisionTrafficLight | null;
  dataContent: JSONContent | null;
  dataPlainText: string;
  scenariosContent: JSONContent | null;
  scenariosPlainText: string;
  planContent: JSONContent | null;
  planPlainText: string;
  closedAt: string | null;
  ownerPersonId?: string | null;
  sourceSessionId?: string | null;
  sourceToolCallId?: string | null;
  answerPayload?: Record<string, unknown> | null;
  reasoning?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DecisionUpdate {
  id: string;
  decisionId: string;
  content: string;
  createdAt: string;
}

interface DecisionLink {
  id: string;
  decisionId: string;
  targetType: string;
  targetId: string;
  targetAddress?: string;
  predicate?: string;
  createdAt: string;
  source?: string;
}

interface DecisionFull extends Decision {
  updates: DecisionUpdate[];
  links: DecisionLink[];
}

type DecisionPatch = Partial<Pick<Decision,
  | "title" | "description" | "answer" | "vaultId"
  | "trafficLight"
  | "dataContent" | "dataPlainText"
  | "scenariosContent" | "scenariosPlainText"
  | "planContent" | "planPlainText"
>>;

const TRAFFIC_DOT: Record<DecisionTrafficLight, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-error",
};

const TRAFFIC_LABEL: Record<DecisionTrafficLight, string> = {
  green: "On track",
  yellow: "At risk",
  red: "Blocked",
};

const SAVE_DEBOUNCE_MS = 800;

function matchesDecisionSearch(decision: Decision, search: string) {
  if (!search.trim()) return true;
  const q = search.trim().toLowerCase();
  return (
    decision.title.toLowerCase().includes(q) ||
    (decision.description ?? "").toLowerCase().includes(q) ||
    (decision.answer ?? "").toLowerCase().includes(q)
  );
}

function DecisionRow({
  decision,
  onDelete,
}: {
  decision: Decision;
  onDelete: () => void;
}) {
  const { vaults, activeVaultId, visibleVaultIds } = useVaults();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(decision.title);
  const vaultById = useMemo(() => new Map(vaults.map((vault) => [vault.id, vault])), [vaults]);
  const titleColor = vaultTitleColor(
    decision.vaultId ? [decision.vaultId] : undefined,
    vaultById,
    activeVaultId,
    1,
  );
  const writableVaults = useMemo(
    () => vaults.filter((vault) => !vault.isArchived && visibleVaultIds.includes(vault.id)),
    [vaults, visibleVaultIds],
  );

  const rename = useMutation({
    mutationFn: async (title: string) => {
      const res = await apiRequest("PATCH", `/api/decisions/${decision.id}`, { title });
      return res.json() as Promise<Decision>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", decision.id] });
    },
    onError: (err: Error) => toast({ title: "Could not rename Decision", description: err.message, variant: "destructive" }),
  });

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (!next || next === decision.title.trim()) {
      setTitleDraft(decision.title);
      setEditingTitle(false);
      return;
    }
    rename.mutate(next, { onSettled: () => setEditingTitle(false) });
  };

  const setVault = useMutation({
    mutationFn: async (vaultId: string) => {
      const res = await apiRequest("PATCH", `/api/decisions/${decision.id}`, { vaultId });
      return res.json() as Promise<Decision>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", decision.id] });
    },
    onError: (err: Error) => toast({ title: "Could not move Decision", description: err.message, variant: "destructive" }),
  });

  const statusMeta =
    decision.status === "closed" && decision.trafficLight
      ? TRAFFIC_LABEL[decision.trafficLight]
      : decision.status === "closed"
        ? "Closed"
        : null;

  return (
    <div className="min-w-0">
      <div
        className={cn(HIERARCHY_SESSION_ROW_CLASS, "hover:bg-accent/70")}
        data-testid={`decision-row-${decision.id}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Scale className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {editingTitle ? (
          <Input
            autoFocus
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                commitTitle();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTitleDraft(decision.title);
                setEditingTitle(false);
              }
            }}
            onBlur={commitTitle}
            className="h-6 max-w-[min(100%,28rem)] border-0 bg-muted/40 px-1.5 text-sm shadow-none focus-visible:ring-1"
            data-testid={`input-decision-title-${decision.id}`}
          />
        ) : (
          <button
            type="button"
            className={cn("min-w-0 flex-1 truncate text-left text-sm", !titleColor && "text-foreground")}
            style={titleColor ? { color: titleColor } : undefined}
            onClick={(event) => {
              event.stopPropagation();
              setTitleDraft(decision.title);
              setEditingTitle(true);
            }}
            data-testid={`text-decision-title-${decision.id}`}
          >
            {decision.title}
          </button>
        )}
        {statusMeta ? (
          <span className="flex shrink-0 items-center gap-1.5 pr-14 text-xs text-muted-foreground">
            {decision.trafficLight ? (
              <span className={cn("h-2 w-2 shrink-0 rounded-full", TRAFFIC_DOT[decision.trafficLight])} />
            ) : null}
            <span className="truncate">{statusMeta}</span>
          </span>
        ) : (
          <span className="pr-14" />
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((value) => !value);
          }}
          className="absolute right-8 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          aria-label={open ? `Collapse ${decision.title}` : `Expand ${decision.title}`}
          data-testid={`button-decision-expand-${decision.id}`}
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        </button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md bg-accent/50 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
              aria-label={`Actions for ${decision.title}`}
              data-testid={`button-decision-menu-${decision.id}`}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger data-testid={`menu-decision-vault-${decision.id}`}>
                <FolderInput className="mr-2 h-3.5 w-3.5" />
                Vault
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">
                {writableVaults.map((vault) => (
                  <DropdownMenuItem
                    key={vault.id}
                    disabled={vault.id === decision.vaultId || setVault.isPending}
                    onSelect={() => setVault.mutate(vault.id)}
                    data-testid={`menu-decision-vault-${decision.id}-${vault.id}`}
                  >
                    <span
                      className="mr-2 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: vault.color || undefined }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{vault.name}</span>
                    {vault.id === decision.vaultId && <Check className="ml-2 h-3.5 w-3.5 shrink-0" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={onDelete}
              data-testid={`button-delete-decision-${decision.id}`}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open ? (
        <div className="px-2 pb-2 pl-2">
          <DecisionInlineEditor decisionId={decision.id} />
        </div>
      ) : null}
    </div>
  );
}

// ─── Main Tab ───

export default function StrategyDecisionsTab() {
  const { toast } = useToast();
  const { data: decisions = [], isLoading } = useQuery<Decision[]>({
    queryKey: ["/api/decisions"],
  });

  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Decision | null>(null);

  const filtered = useMemo(
    () => decisions.filter((decision) => matchesDecisionSearch(decision, search)),
    [decisions, search],
  );
  const openList = filtered.filter((d) => d.status === "open");
  const closedList = filtered.filter((d) => d.status === "closed");
  const hasAny = decisions.length > 0;
  const searchActive = search.trim().length > 0;

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/decisions", {
        title: "New Decision",
        description: "",
      });
      return res.json() as Promise<Decision>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
    },
    onError: (err: Error) => toast({ title: "Failed to create", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/decisions/${id}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast({ title: "Failed to delete", description: err.message, variant: "destructive" }),
  });

  const renderRows = (rows: Decision[], emptyCopy: string) => {
    if (rows.length === 0) {
      return <div className="px-2 py-1.5 text-sm text-muted-foreground">{emptyCopy}</div>;
    }

    return rows.map((decision, index) => (
      <HierarchyTreeRow
        key={decision.id}
        continues={index < rows.length - 1}
        connectorAnchor="first-row-center"
      >
        <DecisionRow
          decision={decision}
          onDelete={() => setDeleteTarget(decision)}
        />
      </HierarchyTreeRow>
    ));
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground" data-testid="decisions-tab">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS}>
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-decisions"
            clearTestId="button-clear-decision-search"
            ariaLabel="Search decisions"
          />

          <button
            type="button"
            className={HIERARCHY_PRIMARY_ACTION_CLASS}
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending}
            data-testid="button-create-decision"
          >
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>New Decision</span>
          </button>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !hasAny ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground" data-testid="text-no-decisions">
              No decisions yet.
            </div>
          ) : (
            <>
              <Collapsible defaultOpen data-testid="group-open-decisions">
                <CollapsibleTrigger
                  className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
                  data-testid="toggle-group-open"
                >
                  <ChevronRight className="h-3 w-3 shrink-0" />
                  Open
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {renderRows(
                    openList,
                    searchActive ? "No matching open decisions." : "No open decisions.",
                  )}
                </CollapsibleContent>
              </Collapsible>

              <Collapsible defaultOpen={searchActive && closedList.length > 0} data-testid="group-closed-decisions">
                <CollapsibleTrigger
                  className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}
                  data-testid="toggle-group-closed"
                >
                  <ChevronRight className="h-3 w-3 shrink-0" />
                  Closed
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {renderRows(
                    closedList,
                    searchActive ? "No matching closed decisions." : "No closed decisions.",
                  )}
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </div>
      </div>

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-delete-decision-title">Delete Decision</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-decision-desc">
              Permanently delete &ldquo;{deleteTarget?.title}&rdquo;? This will also remove its updates and links.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-decision">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete-decision"
            >
              {deleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Inline Editor (expanded view for a single decision) ───

function DecisionInlineEditor({
  decisionId,
}: {
  decisionId: string;
}) {
  const { toast } = useToast();
  const { data: full, isLoading } = useQuery<DecisionFull>({
    queryKey: ["/api/decisions", decisionId],
  });

  const [description, setDescription] = useState("");
  const [answer, setAnswer] = useState("");
  const [data, setData] = useState<JSONContent | null>(null);
  const [dataText, setDataText] = useState("");
  const [scenarios, setScenarios] = useState<JSONContent | null>(null);
  const [scenariosText, setScenariosText] = useState("");
  const [plan, setPlan] = useState<JSONContent | null>(null);
  const [planText, setPlanText] = useState("");
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false);

  const prevIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descriptionRef = useRef("");
  const answerRef = useRef("");
  const dataRef = useRef<{ json: JSONContent | null; text: string }>({ json: null, text: "" });
  const scenariosRef = useRef<{ json: JSONContent | null; text: string }>({ json: null, text: "" });
  const planRef = useRef<{ json: JSONContent | null; text: string }>({ json: null, text: "" });

  useEffect(() => {
    if (!full) return;
    if (full.id === prevIdRef.current) return;
    prevIdRef.current = full.id;
    setDescription(full.description);
    setAnswer(full.answer ?? "");
    setData(full.dataContent);
    setDataText(full.dataPlainText);
    setScenarios(full.scenariosContent);
    setScenariosText(full.scenariosPlainText);
    setPlan(full.planContent);
    setPlanText(full.planPlainText);
    descriptionRef.current = full.description;
    answerRef.current = full.answer ?? "";
    dataRef.current = { json: full.dataContent, text: full.dataPlainText };
    scenariosRef.current = { json: full.scenariosContent, text: full.scenariosPlainText };
    planRef.current = { json: full.planContent, text: full.planPlainText };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, [full]);

  const saveMutation = useMutation({
    mutationFn: async (patch: DecisionPatch) => {
      const res = await apiRequest("PATCH", `/api/decisions/${decisionId}`, patch);
      return res.json() as Promise<Decision>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", decisionId] });
    },
    onError: (err: Error) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveMutation.mutate({
        description: descriptionRef.current,
        answer: answerRef.current,
        dataContent: dataRef.current.json,
        dataPlainText: dataRef.current.text,
        scenariosContent: scenariosRef.current.json,
        scenariosPlainText: scenariosRef.current.text,
        planContent: planRef.current.json,
        planPlainText: planRef.current.text,
      });
    }, SAVE_DEBOUNCE_MS);
  }, [saveMutation]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const setTrafficLightMutation = useMutation({
    mutationFn: async (trafficLight: DecisionTrafficLight) => {
      const res = await apiRequest("PATCH", `/api/decisions/${decisionId}`, { trafficLight });
      return res.json() as Promise<Decision>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", decisionId] });
    },
    onError: (err: Error) => toast({ title: "Could not set status", description: err.message, variant: "destructive" }),
  });

  const lockMutation = useMutation({
    mutationFn: async () => {
      const chosen = answerRef.current.trim();
      if (!chosen) throw new Error("Answer is required to lock");
      const res = await apiRequest("POST", `/api/decisions/${decisionId}/lock`, { answer: chosen });
      return res.json() as Promise<Decision>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", decisionId] });
      setLockConfirmOpen(false);
      toast({ title: "Decision locked" });
    },
    onError: (err: Error) => toast({ title: "Failed to lock", description: err.message, variant: "destructive" }),
  });

  if (isLoading || !full) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isClosed = full.status === "closed";
  const canLock = answer.trim().length > 0;

  return (
    <div className="space-y-3 pt-2" data-testid={`decision-editor-${decisionId}`}>
      {isClosed && (
        <div className="flex items-center gap-2">
          <Select
            value={full.trafficLight ?? "green"}
            onValueChange={(v) => setTrafficLightMutation.mutate(v as DecisionTrafficLight)}
          >
            <SelectTrigger className="h-7 w-28 text-xs" data-testid="select-decision-traffic-light">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["green", "yellow", "red"] as DecisionTrafficLight[]).map(t => (
                <SelectItem key={t} value={t}>
                  <span className="flex items-center gap-2">
                    <span className={cn("inline-block h-2 w-2 rounded-full", TRAFFIC_DOT[t])} />
                    {TRAFFIC_LABEL[t]}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {full.closedAt && (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="text-decision-closed-at">
              <Lock className="h-3 w-3" />
              Closed {new Date(full.closedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      <div>
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Description</div>
        <Textarea
          value={description}
          onChange={(e) => { setDescription(e.target.value); descriptionRef.current = e.target.value; scheduleSave(); }}
          placeholder="A short summary of what this decision is about..."
          rows={2}
          className="text-sm resize-none"
          data-testid="input-decision-description"
        />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Answer</div>
          {!isClosed && canLock && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => setLockConfirmOpen(true)}
              data-testid="button-lock-decision"
            >
              <Lock className="h-3 w-3 mr-1" /> Lock
            </Button>
          )}
        </div>
        <Textarea
          value={answer}
          onChange={(e) => { setAnswer(e.target.value); answerRef.current = e.target.value; scheduleSave(); }}
          placeholder="The chosen answer..."
          rows={2}
          className="text-sm resize-none"
          data-testid="input-decision-answer"
        />
      </div>

      {/* Data / Scenarios / Plan sections — no Card frames */}
      <DecisionSection
        label="Data"
        value={data}
        plain={dataText}
        onChange={(json, text) => {
          setData(json); setDataText(text);
          dataRef.current = { json, text };
          scheduleSave();
        }}
        testId="editor-decision-data"
      />
      <DecisionSection
        label="Scenarios"
        value={scenarios}
        plain={scenariosText}
        onChange={(json, text) => {
          setScenarios(json); setScenariosText(text);
          scenariosRef.current = { json, text };
          scheduleSave();
        }}
        testId="editor-decision-scenarios"
      />
      <DecisionSection
        label="Plan"
        value={plan}
        plain={planText}
        onChange={(json, text) => {
          setPlan(json); setPlanText(text);
          planRef.current = { json, text };
          scheduleSave();
        }}
        testId="editor-decision-plan"
      />

      <DecisionProvenanceSection decision={full} links={full.links} />
      <DecisionLinksSection decisionId={decisionId} links={full.links} />

      {isClosed && (
        <DecisionUpdatesSection decisionId={decisionId} updates={full.updates} />
      )}

      {/* Lock confirmation */}
      <AlertDialog open={lockConfirmOpen} onOpenChange={setLockConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-lock-confirm-title">Lock this decision?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-lock-confirm-desc">
              Locking moves &ldquo;{full.title}&rdquo; to closed and starts a traffic-light status (defaults to On track).
              You can keep editing the Data, Scenarios, and Plan sections to record corrections, and you can
              add append-only updates that are timestamped and cannot be edited or deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-lock-decision">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => lockMutation.mutate()}
              data-testid="button-confirm-lock-decision"
            >
              {lockMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lock"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Section (frameless) ───

function DecisionSection({
  label, value, plain, onChange, testId,
}: {
  label: string;
  value: JSONContent | null;
  plain: string;
  onChange: (json: JSONContent, text: string) => void;
  testId: string;
}) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
      <RichTextEditor
        value={value}
        onChange={onChange}
        placeholder={`Notes for ${label.toLowerCase()}...`}
        plainTextFallback={plain}
        className="h-auto"
        contentClassName={cn(
          SIMPLE_TEXT_FRAME_CLASS,
          "!p-0 [&_.ProseMirror]:!min-h-20 [&_.ProseMirror]:px-3 [&_.ProseMirror]:py-2",
        )}
        data-testid={testId}
      />
    </div>
  );
}

// ─── Provenance ───

const PROVENANCE_PREDICATES = new Set(["decided_by", "governed_by", "triggered_by", "guided_by"]);

const PREDICATE_LABELS: Record<string, string> = {
  decided_by: "Decided by",
  governed_by: "Guided by",
  triggered_by: "Source",
  guided_by: "Guided by",
  relates_to: "Related",
  governs: "Governs",
  evidence_for: "Evidence",
  produced: "Produced",
};

function DecisionProvenanceSection({
  decision,
  links,
}: {
  decision: Decision;
  links: DecisionLink[];
}) {
  const provenanceLinks = useMemo(
    () => links.filter((link) => link.predicate && PROVENANCE_PREDICATES.has(link.predicate)),
    [links],
  );
  const hasReasoning = Boolean(decision.reasoning?.trim());
  const hasSource = Boolean(decision.sourceSessionId || decision.sourceToolCallId);
  if (!provenanceLinks.length && !hasReasoning && !hasSource) return null;

  return (
    <div className="space-y-2" data-testid="decision-provenance">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Scale className="h-3 w-3" /> Provenance
      </div>
      {hasReasoning && (
        <div className="text-sm whitespace-pre-wrap" data-testid="decision-provenance-reasoning">
          <span className="text-muted-foreground">Reasoning: </span>
          {decision.reasoning}
        </div>
      )}
      {provenanceLinks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {provenanceLinks.map((link) => (
            <div key={link.id} className="flex items-center gap-2 text-xs" data-testid={`provenance-link-${link.id}`}>
              <span className="text-muted-foreground min-w-[72px]">
                {PREDICATE_LABELS[link.predicate ?? ""] ?? link.predicate}
              </span>
              {link.targetAddress ? (
                <InlineReferenceText text={link.targetAddress} />
              ) : (
                <span className="capitalize">{link.targetType}:{link.targetId}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {hasSource && !provenanceLinks.some((l) => l.predicate === "triggered_by") && decision.sourceSessionId && (
        <div className="flex items-center gap-2 text-xs" data-testid="decision-provenance-session">
          <span className="text-muted-foreground min-w-[72px]">Session</span>
          <InlineReferenceText text={`@session:${decision.sourceSessionId}`} />
        </div>
      )}
    </div>
  );
}

// ─── Links ───

function linkAddress(link: DecisionLink): string {
  return link.targetAddress || `@${link.targetType}:${link.targetId}`;
}

function DecisionLinksSection({ decisionId, links }: { decisionId: string; links: DecisionLink[] }) {
  const { toast } = useToast();
  const manualLinks = useMemo(
    () => links.filter((link) => !link.predicate || !PROVENANCE_PREDICATES.has(link.predicate)),
    [links],
  );
  const pickerValue = useMemo<ReferencePickerValue[]>(
    () => manualLinks.map((link) => ({
      type: link.targetType,
      id: link.targetId,
      label: linkAddress(link),
    })),
    [manualLinks],
  );

  const addMutation = useMutation({
    mutationFn: async (value: ReferencePickerValue) => {
      const res = await apiRequest("POST", `/api/decisions/${decisionId}/links`, {
        targetAddress: `@${value.type}:${value.id}`,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", decisionId] });
    },
    onError: (err: Error) => toast({ title: "Failed to link", description: err.message, variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (linkId: string) => { await apiRequest("DELETE", `/api/decisions/links/${linkId}`); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", decisionId] });
    },
  });

  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-1">
        <Link2 className="h-3 w-3" /> Links
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {manualLinks.map((link) => (
          <span key={link.id} className="inline-flex items-center gap-0.5" data-testid={`link-${link.id}`}>
            <InlineReferenceText text={linkAddress(link)} />
            <button
              type="button"
              onClick={() => removeMutation.mutate(link.id)}
              className="text-muted-foreground hover:text-destructive"
              data-testid={`button-remove-link-${link.id}`}
              aria-label="Remove link"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <ReferencePicker
          value={pickerValue}
          onChange={(next) => {
            const existing = new Set(manualLinks.map((link) => `${link.targetType}:${link.targetId}`));
            const added = next.find((item) => !existing.has(`${item.type}:${item.id}`));
            if (added) addMutation.mutate(added);
          }}
          mode="multi"
          variant="compact"
          dense
          placeholder="Add link"
          testId="picker-decision-links"
        />
      </div>
      {manualLinks.length === 0 ? (
        <div className="mt-1 text-xs text-muted-foreground" data-testid="text-no-links">No links</div>
      ) : null}
    </div>
  );
}

// ─── Updates (append-only, closed decisions only) ───

function DecisionUpdatesSection({ decisionId, updates }: { decisionId: string; updates: DecisionUpdate[] }) {
  const { toast } = useToast();
  const [draftText, setDraftText] = useState("");

  const addMutation = useMutation({
    mutationFn: async () => {
      const content = draftText.trim();
      if (!content) throw new Error("Update is empty");
      const res = await apiRequest("POST", `/api/decisions/${decisionId}/updates`, { content });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/decisions", decisionId] });
      setDraftText("");
      toast({ title: "Update added" });
    },
    onError: (err: Error) => toast({ title: "Failed to add update", description: err.message, variant: "destructive" }),
  });

  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">
        Updates ({updates.length}) <span className="text-xs normal-case text-muted-foreground/70">— append-only</span>
      </div>
      <div className="space-y-2 mb-3">
        {updates.length === 0 ? (
          <div className="text-xs text-muted-foreground" data-testid="text-no-updates">No updates yet</div>
        ) : (
          updates.map(u => (
            <div key={u.id} className="border-l-2 border-border pl-2 py-1" data-testid={`update-${u.id}`}>
              <div className="text-xs text-muted-foreground mb-1">
                {new Date(u.createdAt).toLocaleString()}
              </div>
              <div className="text-xs whitespace-pre-wrap" data-testid={`text-update-${u.id}`}>{u.content}</div>
            </div>
          ))
        )}
      </div>
      <div className="space-y-2 border-t border-border/20 pt-2">
        <Textarea
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          placeholder="Add an update (timestamped on save, cannot be edited or deleted)..."
          rows={3}
          className="text-sm"
          data-testid="input-new-update"
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={() => addMutation.mutate()} disabled={!draftText.trim() || addMutation.isPending} data-testid="button-add-update">
            {addMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Plus className="h-3 w-3 mr-1" />}
            Add Update
          </Button>
        </div>
      </div>
    </div>
  );
}
