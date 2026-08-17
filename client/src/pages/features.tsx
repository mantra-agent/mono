import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  ChevronRight,
  FileText,
  FlaskConical,
  Hammer,
  History,
  Lightbulb,
  Loader2,
  Package,
  PenLine,
  Plus,
  SlidersHorizontal,
  User,
  Wrench,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { ReferenceText } from "@/components/references/reference-text";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { ChildSessionBlock } from "@/components/inline-session-blocks";
import { ActiveStatusSpinner } from "@/components/nav-dot";
import { useSessionLaunch } from "@/hooks/use-session-launch";
import {
  HIERARCHY_PRIMARY_ACTION_CLASS,
  HIERARCHY_SECTION_HEADER_CLASS,
  HIERARCHY_TREE_STACK_CLASS,
} from "@/components/hierarchy-section-header";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  FEATURE_STAGES,
  FEATURE_STATUSES,
  composeFeatureLaunchMessage,
  formatFeatureStage,
  getFeatureJobContract,
  resolveFeaturePipelineJob,
  type FeatureStage,
  type FeatureStatus,
} from "@shared/feature-pipeline";
import type { ChatSession, ChildSessionBlockMeta } from "@shared/models/chat";
import { isDurablyActiveSession } from "@shared/models/chat";

const stages = FEATURE_STAGES;
const statuses = FEATURE_STATUSES;
type Feature = {
  id: string;
  summary: string;
  description?: string;
  stage: FeatureStage;
  status: FeatureStatus;
  product_id: number;
  product_name?: string;
  owner_person_id?: string;
  spec_page_id?: string | null;
};
type Product = { id: number; name: string };
type Person = { id: string; name: string; cabinetLevel?: string };
type FeatureSessionLink = {
  sessionId: string;
  title: string;
  evidenceType: "explicit" | "discovered";
  createdAt?: string | null;
};
type FeatureHistoryRow = {
  id: string;
  feature_id: string;
  from_stage: FeatureStage | null;
  to_stage: FeatureStage;
  from_status: FeatureStatus | null;
  to_status: FeatureStatus;
  note: string;
  source: string;
  actor_user_id?: string | null;
  session_id?: string | null;
  created_at: string;
};

/** Same chrome as expanded Project summary — bordered card frame, capped height. */
const FEATURE_DESCRIPTION_FRAME_CLASS =
  "max-h-40 overflow-y-auto rounded-md border border-border/30 bg-card/40 p-2";

const STATUS_LABELS: Record<FeatureStatus, string> = {
  ready: "Ready",
  in_progress: "In Progress",
  needs_review: "Needs Review",
};

const STAGE_ICONS: Record<FeatureStage, ReactNode> = {
  idea: <Lightbulb className="h-3.5 w-3.5" />,
  spec: <FileText className="h-3.5 w-3.5" />,
  develop: <Hammer className="h-3.5 w-3.5" />,
  test: <FlaskConical className="h-3.5 w-3.5" />,
  calibrate: <SlidersHorizontal className="h-3.5 w-3.5" />,
  maintain: <Wrench className="h-3.5 w-3.5" />,
  deprecate: <Archive className="h-3.5 w-3.5" />,
};

function formatStage(stage: FeatureStage) {
  return formatFeatureStage(stage);
}

function formatHistoryTransition(row: FeatureHistoryRow): string {
  const fromStage = row.from_stage ? formatFeatureStage(row.from_stage) : "—";
  const toStage = formatFeatureStage(row.to_stage);
  const fromStatus = row.from_status ? STATUS_LABELS[row.from_status] : "—";
  const toStatus = STATUS_LABELS[row.to_status];
  if (row.from_stage !== row.to_stage && row.from_status !== row.to_status) {
    return `${fromStage}/${fromStatus} → ${toStage}/${toStatus}`;
  }
  if (row.from_stage !== row.to_stage) {
    return `${fromStage} → ${toStage}`;
  }
  if (row.from_status !== row.to_status) {
    return `${fromStatus} → ${toStatus}`;
  }
  return `${toStage}/${toStatus}`;
}

function formatHistoryWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isActivePipelineSession(session: ChatSession | undefined | null): boolean {
  if (!session) return false;
  return isDurablyActiveSession(session) || session.status === "streaming";
}

function NewFeature({
  products,
  currentPerson,
  onCreated,
  onCancel,
}: {
  products: Product[];
  currentPerson: Person | null;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [summary, setSummary] = useState("");
  const [productId, setProductId] = useState("");
  const [owner, setOwner] = useState<ReferencePickerValue[]>([]);

  useEffect(() => {
    if (currentPerson && owner.length === 0) {
      setOwner([{ type: "person", id: currentPerson.id, label: currentPerson.name }]);
    }
  }, [currentPerson, owner.length]);

  const create = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/features", {
        summary: summary.trim(),
        productId: Number(productId),
        ownerPersonId: owner[0]?.id,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/features"] });
      toast({ title: "Feature created", description: summary.trim() });
      onCreated();
    },
    onError: (error: unknown) =>
      toast({
        title: "Failed to create Feature",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      }),
  });
  const valid = summary.trim().length > 0 && Boolean(productId) && Boolean(owner[0]?.id);
  const submit = () => {
    if (valid && !create.isPending) create.mutate();
  };

  return (
    <div className="space-y-0.5 px-2 pb-2">
      <ProfileTreeRow label="Summary" icon={<PenLine className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-new-feature-summary">
        <Input
          autoFocus
          placeholder="Feature summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
            if (event.key === "Escape") onCancel();
          }}
          className="h-7 text-right text-xs"
          data-testid="input-feature-summary"
        />
      </ProfileTreeRow>
      <ProfileTreeRow label="Product" icon={<Package className="h-3.5 w-3.5" />} hasValue showEmpty mobileLayout="inline" testId="row-new-feature-product">
        <Select value={productId} onValueChange={setProductId}>
          <SelectTrigger className="h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0" data-testid="select-feature-product">
            <SelectValue placeholder="Product" />
          </SelectTrigger>
          <SelectContent>
            {products.map((product) => (
              <SelectItem key={product.id} value={String(product.id)}>
                {product.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ProfileTreeRow>
      <ProfileTreeRow
        label="Owner"
        icon={<User className="h-3.5 w-3.5" />}
        hasValue
        showEmpty
        mobileLayout="inline"
        testId="row-new-feature-owner"
        actionContent={(
          <button
            type="button"
            onClick={submit}
            disabled={!valid || create.isPending}
            className="text-xs text-cta disabled:text-muted-foreground"
            data-testid="button-create-feature"
          >
            {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Create"}
          </button>
        )}
      >
        <ReferencePicker
          types={["person"]}
          mode="single"
          variant="compact"
          dense
          placeholder="Owner"
          value={owner}
          onChange={setOwner}
          testId="picker-feature-owner"
        />
      </ProfileTreeRow>
    </div>
  );
}

function FeatureRow({ feature, products }: { feature: Feature; products: Product[] }) {
  const { toast } = useToast();
  const launch = useSessionLaunch();
  const [editingOwner, setEditingOwner] = useState(false);
  const [editingSpec, setEditingSpec] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  /** Optimistic link after a row launch, before discovery/artifact indexing catches up. */
  const [launchedSessionId, setLaunchedSessionId] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const response = await apiRequest("PATCH", `/api/features/${feature.id}`, patch);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/features"] });
      queryClient.invalidateQueries({ queryKey: ["/api/features", feature.id, "history"] });
    },
    onError: (error: unknown) =>
      toast({
        title: "Failed to update Feature",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      }),
  });

  const { data: linkedSessions = [] } = useQuery<FeatureSessionLink[]>({
    queryKey: ["/api/features", feature.id, "sessions"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/features/${feature.id}/sessions`);
      return response.json();
    },
    staleTime: 5_000,
  });

  const { data: historyRows = [] } = useQuery<FeatureHistoryRow[]>({
    queryKey: ["/api/features", feature.id, "history"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/features/${feature.id}/history?limit=30`);
      return response.json();
    },
    staleTime: 5_000,
  });

  const { data: allSessions = [] } = useQuery<ChatSession[]>({
    queryKey: ["/api/sessions"],
  });

  const sessionsById = useMemo(() => {
    const map = new Map<string, ChatSession>();
    for (const session of allSessions) map.set(session.id, session);
    return map;
  }, [allSessions]);

  const activeSession = useMemo(() => {
    const candidates = new Map<string, ChatSession>();
    for (const link of linkedSessions) {
      const session = sessionsById.get(link.sessionId);
      if (session) candidates.set(session.id, session);
    }
    if (launchedSessionId) {
      const launched = sessionsById.get(launchedSessionId);
      if (launched) candidates.set(launched.id, launched);
    }
    // Title match covers the gap before @feature discovery indexes the launch message.
    const summary = feature.summary.trim();
    if (summary) {
      for (const session of allSessions) {
        if (!session.title?.includes(summary)) continue;
        candidates.set(session.id, session);
      }
    }
    const active = [...candidates.values()]
      .filter((session) => isActivePipelineSession(session))
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
    return active[0] ?? null;
  }, [allSessions, feature.summary, launchedSessionId, linkedSessions, sessionsById]);

  const isSessionInProgress = Boolean(activeSession);

  useEffect(() => {
    if (!launchedSessionId) return;
    const session = sessionsById.get(launchedSessionId);
    if (session && !isActivePipelineSession(session)) {
      setLaunchedSessionId(null);
    }
  }, [launchedSessionId, sessionsById]);

  const activeSessionMeta: ChildSessionBlockMeta | null = activeSession
    ? {
        childSessionId: activeSession.id,
        parentSessionId: activeSession.parentSessionId || activeSession.id,
        role: activeSession.title || "Feature session",
        startedAt: activeSession.createdAt,
        updatedAt: activeSession.updatedAt,
        summary: activeSession.summary ?? null,
      }
    : null;

  const ownerValue: ReferencePickerValue[] = feature.owner_person_id
    ? [{ type: "person", id: feature.owner_person_id, label: feature.owner_person_id }]
    : [];
  const specValue: ReferencePickerValue[] = feature.spec_page_id
    ? [{ type: "page", id: feature.spec_page_id, label: feature.spec_page_id }]
    : [];

  return (
    <ProfileTreeRow
      label={(
        <span
          className={cn(
            "truncate",
            isSessionInProgress && "text-active font-medium motion-safe:animate-pulse",
          )}
          data-testid={`text-feature-title-${feature.id}`}
        >
          {feature.summary}
        </span>
      )}
      icon={
        isSessionInProgress
          ? <ActiveStatusSpinner className="h-3.5 w-3.5" />
          : STAGE_ICONS[feature.stage]
      }
      hasValue
      showEmpty
      mobileLayout="inline"
      valueLayout="compact"
      testId={`feature-row-${feature.id}`}
      expandedContentClassName="px-2 pb-2 pl-2"
      expandedContent={(
        <div className="space-y-0.5">
          <div
            className={cn(FEATURE_DESCRIPTION_FRAME_CLASS, "mb-1.5")}
            data-testid={`feature-description-${feature.id}`}
          >
            {editingDescription ? (
              <Textarea
                autoFocus
                defaultValue={feature.description ?? ""}
                placeholder="Add a description…"
                className="min-h-16 resize-none border-0 bg-transparent p-0 text-xs leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next === (feature.description ?? "").trim()) {
                    setEditingDescription(false);
                    return;
                  }
                  update.mutate({ description: next }, { onSettled: () => setEditingDescription(false) });
                }}
                data-testid={`textarea-feature-description-${feature.id}`}
              />
            ) : feature.description?.trim() ? (
              <button
                type="button"
                className="block w-full text-left text-xs leading-relaxed text-muted-foreground hover:text-foreground"
                onClick={() => setEditingDescription(true)}
                data-testid={`button-edit-feature-description-${feature.id}`}
              >
                <ReferenceText content={feature.description} />
              </button>
            ) : (
              <button
                type="button"
                className="text-xs text-muted-foreground/50 hover:text-muted-foreground"
                onClick={() => setEditingDescription(true)}
                data-testid={`button-add-feature-description-${feature.id}`}
              >
                Add a description…
              </button>
            )}
          </div>

          <ProfileTreeRow
            label="Product"
            icon={<Package className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`feature-product-${feature.id}`}
          >
            <Select
              value={String(feature.product_id)}
              onValueChange={(productId) => update.mutate({ productId: Number(productId) })}
              disabled={update.isPending}
            >
              <SelectTrigger className="h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0" data-testid={`select-feature-product-${feature.id}`}>
                <SelectValue placeholder="Product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((product) => (
                  <SelectItem key={product.id} value={String(product.id)}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ProfileTreeRow>

          <ProfileTreeRow
            label="Stage"
            icon={<Activity className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`feature-stage-${feature.id}`}
          >
            <Select
              value={feature.stage}
              onValueChange={(stage) =>
                update.mutate({
                  stage,
                  historyNote: `Manual stage change ${formatStage(feature.stage)} → ${formatStage(stage as FeatureStage)}`,
                  historySource: "manual",
                })
              }
              disabled={update.isPending}
            >
              <SelectTrigger className="h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0" data-testid={`select-feature-stage-${feature.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stages.map((stage) => (
                  <SelectItem key={stage} value={stage}>
                    {formatStage(stage)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ProfileTreeRow>

          <ProfileTreeRow
            label="Status"
            icon={<Activity className="h-3.5 w-3.5" />}
            hasValue
            showEmpty
            mobileLayout="inline"
            testId={`feature-status-${feature.id}`}
          >
            <Select
              value={feature.status}
              onValueChange={(status) =>
                update.mutate({
                  status,
                  historyNote: `Manual status change ${STATUS_LABELS[feature.status]} → ${STATUS_LABELS[status as FeatureStatus]}`,
                  historySource: "manual",
                })
              }
              disabled={update.isPending}
            >
              <SelectTrigger className="h-7 w-auto max-w-full border-0 bg-transparent px-0 text-xs shadow-none focus:ring-0" data-testid={`select-feature-status-${feature.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((status) => (
                  <SelectItem key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </ProfileTreeRow>

          <ProfileTreeRow
            label="Owner"
            icon={<User className="h-3.5 w-3.5" />}
            hasValue={Boolean(feature.owner_person_id) || editingOwner}
            showEmpty
            mobileLayout="inline"
            testId={`feature-owner-${feature.id}`}
          >
            {editingOwner || !feature.owner_person_id ? (
              <ReferencePicker
                types={["person"]}
                mode="single"
                variant="compact"
                dense
                placeholder="Owner"
                value={ownerValue}
                onChange={(next) => {
                  const personId = next[0]?.id;
                  if (!personId || personId === feature.owner_person_id) {
                    setEditingOwner(false);
                    return;
                  }
                  update.mutate(
                    { ownerPersonId: personId },
                    { onSettled: () => setEditingOwner(false) },
                  );
                }}
                testId={`picker-feature-owner-${feature.id}`}
              />
            ) : (
              <button
                type="button"
                className="max-w-full truncate text-right"
                onClick={() => setEditingOwner(true)}
                data-testid={`button-edit-feature-owner-${feature.id}`}
              >
                <span className="pointer-events-none">
                  <InlineReferenceText text={`@person:${feature.owner_person_id}`} />
                </span>
              </button>
            )}
          </ProfileTreeRow>

          <ProfileTreeRow
            label="Spec"
            icon={<FileText className="h-3.5 w-3.5" />}
            hasValue={Boolean(feature.spec_page_id) || editingSpec}
            showEmpty
            mobileLayout="inline"
            testId={`feature-spec-${feature.id}`}
          >
            {editingSpec || !feature.spec_page_id ? (
              <ReferencePicker
                types={["page"]}
                mode="single"
                variant="compact"
                dense
                placeholder="Spec page"
                value={specValue}
                onChange={(next) => {
                  const pageId = next[0]?.id ?? null;
                  if (pageId === (feature.spec_page_id ?? null)) {
                    setEditingSpec(false);
                    return;
                  }
                  update.mutate(
                    { specPageId: pageId },
                    { onSettled: () => setEditingSpec(false) },
                  );
                }}
                testId={`picker-feature-spec-${feature.id}`}
              />
            ) : (
              <button
                type="button"
                className="max-w-full truncate text-right"
                onClick={() => setEditingSpec(true)}
                data-testid={`button-edit-feature-spec-${feature.id}`}
              >
                <span className="pointer-events-none">
                  <InlineReferenceText text={`@page:${feature.spec_page_id}`} />
                </span>
              </button>
            )}
          </ProfileTreeRow>

          {activeSessionMeta ? (
            <div className="pt-1.5" data-testid={`feature-active-session-${feature.id}`}>
              <ChildSessionBlock
                meta={activeSessionMeta}
                defaultExpanded={false}
              />
            </div>
          ) : null}

          <div className="pt-2" data-testid={`feature-history-${feature.id}`}>
            <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
              <History className="h-3 w-3" />
              History
            </div>
            {historyRows.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground/50">No stage or status changes yet.</p>
            ) : (
              <ul className="max-h-48 space-y-1.5 overflow-y-auto px-1">
                {historyRows.map((row) => (
                  <li
                    key={row.id}
                    className="rounded-md border border-border/20 bg-muted/20 px-2 py-1.5"
                    data-testid={`feature-history-row-${row.id}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-foreground">
                        {formatHistoryTransition(row)}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/70">
                        {formatHistoryWhen(row.created_at)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {row.note}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      menuContent={(
        <>
          {(() => {
            // Status chooses the job: needs_review → Review; otherwise Produce for this stage.
            const job = resolveFeaturePipelineJob(feature.status);
            const contract = getFeatureJobContract(feature.stage, job);
            const pendingKey = `feature-${feature.id}-${feature.stage}-${job}`;
            const pending = launch.isPending && launch.variables?.pendingKey === pendingKey;
            return (
              <DropdownMenuItem
                disabled={launch.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  launch.mutate(
                    {
                      pendingKey,
                      title: `${contract.actionLabel}: ${feature.summary}`.slice(0, 80),
                      personaName: contract.persona,
                      message: composeFeatureLaunchMessage({
                        id: feature.id,
                        summary: feature.summary,
                        stage: feature.stage,
                        status: feature.status,
                        productName: feature.product_name,
                        productId: feature.product_id,
                        ownerPersonId: feature.owner_person_id,
                        specPageId: feature.spec_page_id,
                        description: feature.description,
                      }, job),
                      clientTurnSuffix: pendingKey,
                      errorTitle: `Could not start ${contract.actionLabel.toLowerCase()} session`,
                    },
                    {
                      onSuccess: (session) => {
                        setLaunchedSessionId(session.id);
                        queryClient.invalidateQueries({ queryKey: ["/api/features", feature.id, "sessions"] });
                      },
                    },
                  );
                }}
                data-testid={`button-feature-launch-${feature.stage}-${job}-${feature.id}`}
              >
                {pending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <PenLine className="mr-2 h-3.5 w-3.5" />}
                {contract.actionLabel}
              </DropdownMenuItem>
            );
          })()}
          <DropdownMenuItem
            onSelect={() =>
              apiRequest("POST", `/api/features/${feature.id}/archive`, { confirm: true }).then(() => {
                queryClient.invalidateQueries({ queryKey: ["/api/features"] });
              })
            }
          >
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() =>
              apiRequest("DELETE", `/api/features/${feature.id}`, { confirm: true }).then(() => {
                queryClient.invalidateQueries({ queryKey: ["/api/features"] });
              })
            }
          >
            Delete
          </DropdownMenuItem>
        </>
      )}
    />
  );
}

export default function FeaturesPage() {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const features = useQuery<Feature[]>({
    queryKey: ["/api/features", search],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/features${search ? `?search=${encodeURIComponent(search)}` : ""}`);
      return response.json();
    },
  });
  const products = useQuery<Product[]>({ queryKey: ["/api/products"] });
  const people = useQuery<{ people: Person[] }>({ queryKey: ["/api/people"] });
  const currentPerson = people.data?.people.find((person) => person.cabinetLevel === "user") ?? null;
  const productList = products.data ?? [];
  const grouped = useMemo(
    () => stages.map((stage) => ({ stage, rows: (features.data ?? []).filter((row) => row.stage === stage) })),
    [features.data],
  );

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="features-page">
          <HierarchySearchInput
            value={search}
            onChange={setSearch}
            inputTestId="input-search-features"
            clearTestId="button-clear-feature-search"
            ariaLabel="Search features"
          />
          {creating ? (
            <NewFeature
              products={productList}
              currentPerson={currentPerson}
              onCreated={() => {
                setCreating(false);
                void features.refetch();
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <button type="button" className={HIERARCHY_PRIMARY_ACTION_CLASS} onClick={() => setCreating(true)} data-testid="button-new-feature">
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>New Feature</span>
            </button>
          )}
          {grouped.map(({ stage, rows }) => (
            <Collapsible key={stage} defaultOpen>
              <CollapsibleTrigger className={cn(HIERARCHY_SECTION_HEADER_CLASS, "hover-elevate")}>
                <ChevronRight className="h-3 w-3 shrink-0" />
                {formatStage(stage)}
              </CollapsibleTrigger>
              <CollapsibleContent>
                {rows.length ? (
                  rows.map((feature, index) => (
                    <HierarchyTreeRow key={feature.id} continues={index < rows.length - 1} connectorAnchor="first-row-center">
                      <FeatureRow feature={feature} products={productList} />
                    </HierarchyTreeRow>
                  ))
                ) : (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No Features</div>
                )}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      </div>
    </div>
  );
}
