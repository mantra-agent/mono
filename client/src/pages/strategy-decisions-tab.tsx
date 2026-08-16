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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  Plus, Loader2, Trash2, Lock, Link2, X,
  ChevronRight, ChevronsUpDown, Check, Scale,
} from "lucide-react";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { RichTextEditor } from "@/components/rich-text-editor";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { cn } from "@/lib/utils";

type DecisionStatus = "open" | "closed";
type DecisionTrafficLight = "green" | "yellow" | "red";

interface Decision {
  id: string;
  title: string;
  description: string;
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
  | "title" | "description"
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
    (decision.description ?? "").toLowerCase().includes(q)
  );
}

function DecisionRow({
  decision,
  onDelete,
}: {
  decision: Decision;
  onDelete: () => void;
}) {
  const statusMeta =
    decision.status === "closed" && decision.trafficLight
      ? TRAFFIC_LABEL[decision.trafficLight]
      : decision.status === "closed"
        ? "Closed"
        : "Open";

  return (
    <ProfileTreeRow
      label={<span data-testid={`text-decision-title-${decision.id}`}>{decision.title}</span>}
      icon={<Scale className="h-3.5 w-3.5" />}
      hasValue
      showEmpty
      mobileLayout="inline"
      valueLayout="compact"
      testId={`decision-row-${decision.id}`}
      expandedContentClassName="px-2 pb-2 pl-2"
      expandedContent={(
        <DecisionInlineEditor
          decisionId={decision.id}
          onDelete={() => onDelete()}
        />
      )}
      menuContent={(
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={onDelete}
          data-testid={`button-delete-decision-${decision.id}`}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete
        </DropdownMenuItem>
      )}
    >
      <span className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
        {decision.status === "closed" && decision.trafficLight ? (
          <span className={cn("h-2 w-2 shrink-0 rounded-full", TRAFFIC_DOT[decision.trafficLight])} />
        ) : null}
        <span className="truncate">{statusMeta}</span>
      </span>
    </ProfileTreeRow>
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
  decisionId, onDelete,
}: {
  decisionId: string;
  onDelete: (d: Decision) => void;
}) {
  const { toast } = useToast();
  const { data: full, isLoading } = useQuery<DecisionFull>({
    queryKey: ["/api/decisions", decisionId],
  });

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [data, setData] = useState<JSONContent | null>(null);
  const [dataText, setDataText] = useState("");
  const [scenarios, setScenarios] = useState<JSONContent | null>(null);
  const [scenariosText, setScenariosText] = useState("");
  const [plan, setPlan] = useState<JSONContent | null>(null);
  const [planText, setPlanText] = useState("");
  const [lockConfirmOpen, setLockConfirmOpen] = useState(false);

  const prevIdRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleRef = useRef("");
  const descriptionRef = useRef("");
  const dataRef = useRef<{ json: JSONContent | null; text: string }>({ json: null, text: "" });
  const scenariosRef = useRef<{ json: JSONContent | null; text: string }>({ json: null, text: "" });
  const planRef = useRef<{ json: JSONContent | null; text: string }>({ json: null, text: "" });

  useEffect(() => {
    if (!full) return;
    if (full.id === prevIdRef.current) return;
    prevIdRef.current = full.id;
    setTitle(full.title);
    setDescription(full.description);
    setData(full.dataContent);
    setDataText(full.dataPlainText);
    setScenarios(full.scenariosContent);
    setScenariosText(full.scenariosPlainText);
    setPlan(full.planContent);
    setPlanText(full.planPlainText);
    titleRef.current = full.title;
    descriptionRef.current = full.description;
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
        title: titleRef.current,
        description: descriptionRef.current,
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
      const res = await apiRequest("POST", `/api/decisions/${decisionId}/lock`, {});
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

  return (
    <div className="space-y-3 pt-2" data-testid={`decision-editor-${decisionId}`}>
      {/* Title + controls bar */}
      <div className="flex items-center gap-2">
        <Input
          value={title}
          onChange={(e) => { setTitle(e.target.value); titleRef.current = e.target.value; scheduleSave(); }}
          placeholder="Decision title"
          className="h-8 text-sm font-medium border-0 bg-transparent focus-visible:ring-1 px-1 flex-1"
          data-testid="input-decision-title"
        />
        {isClosed && (
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
        )}
        {!isClosed && (
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

      {isClosed && full.closedAt && (
        <div className="text-xs text-muted-foreground flex items-center gap-1.5" data-testid="text-decision-closed-at">
          <Lock className="h-3 w-3" />
          Closed {new Date(full.closedAt).toLocaleString()}
        </div>
      )}

      {/* Description */}
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
  const hasAnswer = Boolean(decision.answerPayload && Object.keys(decision.answerPayload).length > 0);
  const hasSource = Boolean(decision.sourceSessionId || decision.sourceToolCallId);
  if (!provenanceLinks.length && !hasReasoning && !hasAnswer && !hasSource) return null;

  const answerSummary = (() => {
    const payload = decision.answerPayload;
    if (!payload) return null;
    if (typeof payload.selectedLabels === "string") return payload.selectedLabels;
    if (Array.isArray(payload.selectedLabels)) return payload.selectedLabels.join(", ");
    if (Array.isArray(payload.selectedOptionIds)) return payload.selectedOptionIds.join(", ");
    if (typeof payload.otherText === "string" && payload.otherText.trim()) return payload.otherText.trim();
    return null;
  })();

  return (
    <div className="space-y-2" data-testid="decision-provenance">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
        <Scale className="h-3 w-3" /> Provenance
      </div>
      {answerSummary && (
        <div className="text-sm" data-testid="decision-provenance-answer">
          <span className="text-muted-foreground">Answer: </span>
          <span>{answerSummary}</span>
        </div>
      )}
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

interface StrategyOption { id: string; title: string }
interface ProjectOption { id: number; title: string }

function DecisionLinksSection({ decisionId, links }: { decisionId: string; links: DecisionLink[] }) {
  const { toast } = useToast();
  const manualLinks = useMemo(
    () => links.filter((link) => !link.predicate || !PROVENANCE_PREDICATES.has(link.predicate)),
    [links],
  );

  const { data: strategies = [] } = useQuery<StrategyOption[]>({
    queryKey: ["/api/strategy/goals"],
  });
  const { data: projects = [] } = useQuery<ProjectOption[]>({
    queryKey: ["/api/projects/projects"],
  });

  const strategyById = useMemo(() => new Map(strategies.map(s => [s.id, s])), [strategies]);
  const projectById = useMemo(() => new Map(projects.map(p => [String(p.id), p])), [projects]);

  const linkedStrategyIds = useMemo(
    () => new Set(manualLinks.filter(l => l.targetType === "strategy").map(l => l.targetId)),
    [manualLinks],
  );
  const linkedProjectIds = useMemo(
    () => new Set(manualLinks.filter(l => l.targetType === "project").map(l => l.targetId)),
    [manualLinks],
  );

  const addMutation = useMutation({
    mutationFn: async (input: { targetType: "strategy" | "project"; targetId: string }) => {
      const res = await apiRequest("POST", `/api/decisions/${decisionId}/links`, input);
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

  const labelFor = (l: DecisionLink) => {
    if (l.targetType === "strategy") return strategyById.get(l.targetId)?.title || `strategy:${l.targetId}`;
    if (l.targetType === "project") return projectById.get(l.targetId)?.title || `project:${l.targetId}`;
    return l.targetAddress || `${l.targetType}:${l.targetId}`;
  };

  const toggleLink = (
    targetType: "strategy" | "project",
    targetId: string,
    currentlyLinked: boolean,
  ) => {
    if (currentlyLinked) {
      const existing = manualLinks.find(l => l.targetType === targetType && l.targetId === targetId);
      if (existing) removeMutation.mutate(existing.id);
    } else {
      addMutation.mutate({ targetType, targetId });
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <Link2 className="h-3 w-3" /> Links
        </div>
        <div className="flex items-center gap-1.5">
          <LinkMultiSelect
            label="Strategies"
            placeholder="Search strategies..."
            options={strategies.map(s => ({ value: s.id, label: s.title }))}
            selected={linkedStrategyIds}
            onToggle={(id, linked) => toggleLink("strategy", id, linked)}
            testId="select-link-strategies"
          />
          <LinkMultiSelect
            label="Projects"
            placeholder="Search projects..."
            options={projects.map(p => ({ value: String(p.id), label: p.title }))}
            selected={linkedProjectIds}
            onToggle={(id, linked) => toggleLink("project", id, linked)}
            testId="select-link-projects"
          />
        </div>
      </div>
      {manualLinks.length === 0 ? (
        <div className="text-xs text-muted-foreground" data-testid="text-no-links">No links</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {manualLinks.map(l => (
            <span key={l.id} className="inline-flex items-center gap-1 text-xs bg-muted rounded px-2 py-0.5" data-testid={`link-${l.id}`}>
              {l.targetAddress ? (
                <InlineReferenceText text={l.targetAddress} />
              ) : (
                <>
                  <span className="capitalize">{l.targetType}:</span>
                  <span>{labelFor(l)}</span>
                </>
              )}
              <button
                onClick={() => removeMutation.mutate(l.id)}
                className="hover:text-destructive"
                data-testid={`button-remove-link-${l.id}`}
                aria-label="Remove link"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Link Multi Select ───

function LinkMultiSelect({
  label, placeholder, options, selected, onToggle, testId,
}: {
  label: string;
  placeholder: string;
  options: { value: string; label: string }[];
  selected: Set<string>;
  onToggle: (value: string, currentlyLinked: boolean) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs justify-between gap-2"
          data-testid={testId}
        >
          <span>{label}{selected.size > 0 ? ` (${selected.size})` : ""}</span>
          <ChevronsUpDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        <Command>
          <CommandInput placeholder={placeholder} data-testid={`${testId}-input`} />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              {options.map(opt => {
                const isLinked = selected.has(opt.value);
                return (
                  <CommandItem
                    key={opt.value}
                    value={`${opt.label} ${opt.value}`}
                    onSelect={() => onToggle(opt.value, isLinked)}
                    data-testid={`${testId}-option-${opt.value}`}
                  >
                    <Check className={cn("mr-2 h-3.5 w-3.5", isLinked ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{opt.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
