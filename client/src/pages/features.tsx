import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  Check,
  ChevronRight,
  FileText,
  FlaskConical,
  Hammer,
  History,
  Lightbulb,
  Loader2,
  MessageSquare,
  Package,
  PenLine,
  Play,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Square,
  User,
  Wrench,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HierarchyTreeRow } from "@/components/hierarchy-tree";
import { HierarchySearchInput } from "@/components/hierarchy-search-input";
import { ProfileTreeRow } from "@/components/profile-tree-row";
import { InlineReferenceText } from "@/components/references/inline-reference-text";
import { ReferenceText } from "@/components/references/reference-text";
import { ReferencePicker, type ReferencePickerValue } from "@/components/references/reference-picker";
import { InlineLibraryPageEditor } from "@/components/library/inline-library-page";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { recordBrowserTelemetry } from "@/lib/browser-telemetry";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { emitSessionChanged } from "@/hooks/use-data-sync";
import {
  FEATURE_PIPELINE,
  FEATURE_STAGES,
  FEATURE_STATUSES,
  composeFeatureDiscussMessage,
  composeFeatureLaunchMessage,
  formatFeatureStage,
  getFeatureDiscussPersona,
  getFeatureJobContract,
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

function bucketDuration(ms: number): string {
  if (ms < 250) return "under_250ms";
  if (ms < 1_000) return "250ms_1s";
  if (ms < 3_000) return "1s_3s";
  if (ms < 10_000) return "3s_10s";
  return "over_10s";
}

function recordFeaturesTelemetry(
  name: string,
  value: number,
  unit: "ms" | "count" = "ms",
  metadata?: Record<string, unknown>,
): void {
  if (!Number.isFinite(value) || value < 0) return;
  recordBrowserTelemetry({
    kind: "features",
    name,
    value,
    unit,
    routeKey: "/features",
    bucket: unit === "ms" ? bucketDuration(value) : undefined,
    metadata,
  });
}

/**
 * Resolve the live pipeline session for one Feature without scanning the full
 * session catalog. Callers pass the page-level active-session shortlist.
 */
function resolveActiveFeatureSession(args: {
  featureId: string;
  summary: string;
  linkedSessions: FeatureSessionLink[];
  launchedSessionId: string | null;
  sessionsById: Map<string, ChatSession>;
  activePipelineSessions: ChatSession[];
}): ChatSession | null {
  const startedAt = performance.now();
  const candidates = new Map<string, ChatSession>();
  for (const link of args.linkedSessions) {
    const session = args.sessionsById.get(link.sessionId);
    if (session && isActivePipelineSession(session)) candidates.set(session.id, session);
  }
  if (args.launchedSessionId) {
    const launched = args.sessionsById.get(args.launchedSessionId);
    if (launched && isActivePipelineSession(launched)) candidates.set(launched.id, launched);
  }
  // Title match covers the gap before @feature discovery indexes the launch message.
  // Only active sessions are candidates — never O(features × all sessions).
  const summary = args.summary.trim();
  if (summary) {
    for (const session of args.activePipelineSessions) {
      if (!session.title?.includes(summary)) continue;
      candidates.set(session.id, session);
    }
  }
  const active = [...candidates.values()].sort(
    (a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt),
  );
  const elapsed = performance.now() - startedAt;
  // Sample expensive matches only; keep ambient noise low.
  if (elapsed >= 8 || Math.random() < 0.05) {
    recordFeaturesTelemetry("session_match", elapsed, "ms", {
      featureId: args.featureId,
      candidateCount: candidates.size,
      activeSessionPool: args.activePipelineSessions.length,
    });
  }
  return active[0] ?? null;
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

const FeatureRow = memo(function FeatureRow({
  feature,
  products,
  sessionsById,
  activePipelineSessions,
}: {
  feature: Feature;
  products: Product[];
  sessionsById: Map<string, ChatSession>;
  activePipelineSessions: ChatSession[];
}) {
  const { toast } = useToast();
  const launch = useSessionLaunch();
  const [editingOwner, setEditingOwner] = useState(false);
  const [editingSpec, setEditingSpec] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(feature.summary);
  /** Expand open — history fetches only when true (lazy). */
  const [rowExpanded, setRowExpanded] = useState(false);
  /** Optimistic link after a row launch, before discovery/artifact indexing catches up. */
  const [launchedSessionId, setLaunchedSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(feature.summary);
  }, [feature.summary, editingTitle]);

  const update = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const response = await apiRequest("PATCH", `/api/features/${feature.id}`, patch);
      return response.json() as Promise<Feature>;
    },
    onSuccess: (row) => {
      // Apply the returned row immediately so status chrome (needs_review unread)
      // flips before the network refetch settles. Keep product_name from cache when
      // the PATCH body does not join products.
      if (row?.id) {
        queryClient.setQueriesData<Feature[]>({ queryKey: ["/api/features"] }, (old) => {
          if (!Array.isArray(old)) return old;
          return old.map((entry) =>
            entry.id === row.id
              ? {
                  ...entry,
                  summary: row.summary ?? entry.summary,
                  description: row.description ?? entry.description,
                  stage: row.stage ?? entry.stage,
                  status: row.status ?? entry.status,
                  product_id: row.product_id ?? entry.product_id,
                  owner_person_id: row.owner_person_id ?? entry.owner_person_id,
                  spec_page_id:
                    row.spec_page_id !== undefined ? row.spec_page_id : entry.spec_page_id,
                  product_name: row.product_name ?? entry.product_name,
                }
              : entry,
          );
        });
      }
      void queryClient.invalidateQueries({ queryKey: ["/api/features"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/features", feature.id, "history"] });
    },
    onError: (error: unknown) =>
      toast({
        title: "Failed to update Feature",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      }),
  });

  // Linked-session fetch is gated: title-match against the active shortlist,
  // an optimistic launch on this row, or expand (for explicit discovery links).
  // Never fan out /sessions to every Feature just because one elsewhere is humming.
  const titleMightMatchActive = useMemo(() => {
    const summary = feature.summary.trim();
    if (!summary || activePipelineSessions.length === 0) return false;
    return activePipelineSessions.some((session) => session.title?.includes(summary));
  }, [activePipelineSessions, feature.summary]);
  const sessionsQueryEnabled =
    Boolean(launchedSessionId) || titleMightMatchActive || rowExpanded;
  const { data: linkedSessions = [] } = useQuery<FeatureSessionLink[]>({
    queryKey: ["/api/features", feature.id, "sessions"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/features/${feature.id}/sessions`);
      return response.json();
    },
    enabled: sessionsQueryEnabled,
    staleTime: 15_000,
  });

  // History is expand-only — collapsed rows must not each hit /history.
  const { data: historyRows = [] } = useQuery<FeatureHistoryRow[]>({
    queryKey: ["/api/features", feature.id, "history"],
    queryFn: async () => {
      const startedAt = performance.now();
      const response = await apiRequest("GET", `/api/features/${feature.id}/history?limit=30`);
      const rows = (await response.json()) as FeatureHistoryRow[];
      recordFeaturesTelemetry("expand", performance.now() - startedAt, "ms", {
        featureId: feature.id,
        historyCount: rows.length,
      });
      return rows;
    },
    enabled: rowExpanded,
    staleTime: 30_000,
  });

  const activeSession = useMemo(
    () =>
      resolveActiveFeatureSession({
        featureId: feature.id,
        summary: feature.summary,
        linkedSessions,
        launchedSessionId,
        sessionsById,
        activePipelineSessions,
      }),
    [
      activePipelineSessions,
      feature.id,
      feature.summary,
      launchedSessionId,
      linkedSessions,
      sessionsById,
    ],
  );

  const isSessionInProgress = Boolean(activeSession);

  useEffect(() => {
    if (!launchedSessionId) return;
    const session = sessionsById.get(launchedSessionId);
    if (session && !isActivePipelineSession(session)) {
      setLaunchedSessionId(null);
    }
  }, [launchedSessionId, sessionsById]);

  const handleRowOpenChange = useCallback((open: boolean) => {
    setRowExpanded(open);
  }, []);

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

  const needsReview = feature.status === "needs_review";
  // Ready/in_progress → Produce (Play). needs_review splits into AI Review launch
  // and human Check-to-advance; Produce is no longer the primary review-row control.
  const produceContract = getFeatureJobContract(feature.stage, "produce");
  const reviewContract = getFeatureJobContract(feature.stage, "review");
  const nextStageOnPass = FEATURE_PIPELINE[feature.stage].nextStageOnPass;
  const canApprove = needsReview && nextStageOnPass !== null;
  const produceLaunchKey = `feature-${feature.id}-${feature.stage}-produce`;
  const reviewLaunchKey = `feature-${feature.id}-${feature.stage}-review`;
  const produceLaunchPending =
    launch.isPending && launch.variables?.pendingKey === produceLaunchKey;
  const reviewLaunchPending =
    launch.isPending && launch.variables?.pendingKey === reviewLaunchKey;

  const featureLaunchContext = {
    id: feature.id,
    summary: feature.summary,
    stage: feature.stage,
    status: feature.status,
    productName: feature.product_name,
    productId: feature.product_id,
    ownerPersonId: feature.owner_person_id,
    specPageId: feature.spec_page_id,
    description: feature.description,
  };

  const onLaunchSuccess = (session: { id: string }) => {
    setLaunchedSessionId(session.id);
    void queryClient.invalidateQueries({
      queryKey: ["/api/features", feature.id, "sessions"],
    });
  };

  const runPipelineLaunch = (job: "produce" | "review") => {
    if (launch.isPending) return;
    const contract = getFeatureJobContract(feature.stage, job);
    const pendingKey = `feature-${feature.id}-${feature.stage}-${job}`;
    launch.mutate(
      {
        pendingKey,
        title: `${contract.actionLabel}: ${feature.summary}`.slice(0, 80),
        personaName: contract.persona,
        message: composeFeatureLaunchMessage(featureLaunchContext, job),
        clientTurnSuffix: pendingKey,
        errorTitle: `Could not start ${contract.actionLabel.toLowerCase()} session`,
        // Stay on Features; session mounts under the row (mobile Focus would leave).
        openFocus: false,
      },
      { onSuccess: onLaunchSuccess },
    );
  };

  const discussPendingKey = `feature-${feature.id}-discuss`;
  const discussPending =
    launch.isPending && launch.variables?.pendingKey === discussPendingKey;
  const discussPersona = getFeatureDiscussPersona(feature.stage);

  const runDiscussLaunch = () => {
    if (launch.isPending) return;
    launch.mutate(
      {
        pendingKey: discussPendingKey,
        title: `Discuss: ${feature.summary}`.slice(0, 80),
        personaName: discussPersona,
        message: composeFeatureDiscussMessage(featureLaunchContext),
        clientTurnSuffix: discussPendingKey,
        errorTitle: "Could not start discussion",
        // Stay on Features; session mounts under the row (mobile Focus would leave).
        openFocus: false,
      },
      { onSuccess: onLaunchSuccess },
    );
  };

  /** Human approve: advance stage (status resets to ready). Terminal rooms stay put. */
  const approveToNextStage = () => {
    if (!canApprove || !nextStageOnPass || update.isPending) return;
    update.mutate({
      stage: nextStageOnPass,
      historyNote: `Human approved ${formatStage(feature.stage)} → ${formatStage(nextStageOnPass)}`,
      historySource: "manual",
    });
  };

  /** Stop the in-progress Feature session (abort active run). */
  const stopSession = useMutation({
    mutationFn: async (sessionId: string) => {
      await apiRequest("POST", `/api/sessions/${sessionId}/abort`);
      return sessionId;
    },
    onSuccess: (sessionId) => {
      setLaunchedSessionId(null);
      void emitSessionChanged(sessionId, "feature-row-stop");
      void queryClient.invalidateQueries({
        queryKey: ["/api/features", feature.id, "sessions"],
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not stop session",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const runStopSession = () => {
    if (!activeSession || stopSession.isPending) return;
    stopSession.mutate(activeSession.id);
  };

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (!next || next === feature.summary.trim()) {
      setTitleDraft(feature.summary);
      setEditingTitle(false);
      return;
    }
    update.mutate({ summary: next }, { onSettled: () => setEditingTitle(false) });
  };

  // Session block lives outside ProfileTreeRow expand so it stays visible
  // under contracted Feature rows while a pipeline session is in progress.
  return (
    <div className="min-w-0">
      <ProfileTreeRow
        label={(
          editingTitle ? (
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
                  setTitleDraft(feature.summary);
                  setEditingTitle(false);
                }
              }}
              onBlur={commitTitle}
              className="h-6 max-w-[min(100%,28rem)] border-0 bg-muted/40 px-1.5 text-sm shadow-none focus-visible:ring-1"
              data-testid={`input-feature-title-${feature.id}`}
            />
          ) : (
            <button
              type="button"
              className={cn(
                "max-w-full truncate text-left text-sm",
                isSessionInProgress && "text-active font-medium motion-safe:animate-pulse",
                !isSessionInProgress && needsReview && "font-medium text-foreground",
                !isSessionInProgress && !needsReview && "text-muted-foreground",
              )}
              onClick={(event) => {
                event.stopPropagation();
                setTitleDraft(feature.summary);
                setEditingTitle(true);
              }}
              data-testid={`text-feature-title-${feature.id}`}
            >
              {feature.summary}
            </button>
          )
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
        // In-progress: Stop replaces Play/AI/Check. Idle: Play or AI Review + green Check.
        actionContent={(
          <div className="flex shrink-0 items-center justify-end">
            {isSessionInProgress ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 min-h-5 w-5 min-w-5 shrink-0 rounded text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3"
                disabled={stopSession.isPending}
                aria-label={`Stop session for ${feature.summary}`}
                title="Stop"
                onClick={(event) => {
                  event.stopPropagation();
                  runStopSession();
                }}
                data-testid={`button-feature-stop-${feature.id}`}
              >
                {stopSession.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Square className="h-3 w-3 fill-current" />
                )}
              </Button>
            ) : needsReview ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="relative h-5 min-h-5 w-5 min-w-5 shrink-0 rounded text-cta hover:bg-accent hover:text-active [&_svg]:size-3"
                  disabled={launch.isPending}
                  aria-label={`AI review ${feature.summary}`}
                  title={`AI ${reviewContract.actionLabel}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    runPipelineLaunch("review");
                  }}
                  data-testid={`button-feature-ai-review-${feature.stage}-${feature.id}`}
                >
                  {reviewLaunchPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      <Search className="h-3 w-3" />
                      <Sparkles className="absolute right-0.5 top-0.5 h-1.5 w-1.5 text-cta" />
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-5 min-h-5 w-5 min-w-5 shrink-0 rounded text-success hover:bg-accent hover:text-success disabled:opacity-40 [&_svg]:size-3"
                  disabled={!canApprove || update.isPending}
                  aria-label={
                    canApprove
                      ? `Approve ${feature.summary} to ${formatStage(nextStageOnPass!)}`
                      : `No next stage for ${formatStage(feature.stage)}`
                  }
                  title={
                    canApprove
                      ? `Approve → ${formatStage(nextStageOnPass!)}`
                      : "No next stage"
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    approveToNextStage();
                  }}
                  data-testid={`button-feature-approve-${feature.stage}-${feature.id}`}
                >
                  {update.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 min-h-5 w-5 min-w-5 shrink-0 rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground [&_svg]:size-3"
                disabled={launch.isPending}
                aria-label={`Play ${produceContract.actionLabel} for ${feature.summary}`}
                title={produceContract.actionLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  runPipelineLaunch("produce");
                }}
                data-testid={`button-feature-play-${feature.stage}-produce-${feature.id}`}
              >
                {produceLaunchPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
              </Button>
            )}
          </div>
        )}
        onOpenChange={handleRowOpenChange}
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

          {/* Spec is one field row like Product/Status/Owner; page body expands under the row. */}
          <ProfileTreeRow
            label="Spec"
            icon={<FileText className="h-3.5 w-3.5" />}
            hasValue={Boolean(feature.spec_page_id) || editingSpec}
            showEmpty
            mobileLayout="inline"
            testId={`feature-spec-${feature.id}`}
            expandedContent={
              feature.spec_page_id && !editingSpec ? (
                <InlineLibraryPageEditor
                  page={{
                    id: feature.spec_page_id,
                    title: "Spec",
                    slug: feature.spec_page_id,
                  }}
                />
              ) : undefined
            }
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
          {isSessionInProgress ? (
            <DropdownMenuItem
              disabled={stopSession.isPending}
              onSelect={(event) => {
                event.preventDefault();
                runStopSession();
              }}
              data-testid={`button-feature-menu-stop-${feature.id}`}
            >
              {stopSession.isPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="mr-2 h-3.5 w-3.5 fill-current" />
              )}
              Stop
            </DropdownMenuItem>
          ) : needsReview ? (
            <>
              <DropdownMenuItem
                disabled={launch.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  runPipelineLaunch("review");
                }}
                data-testid={`button-feature-launch-${feature.stage}-review-${feature.id}`}
              >
                {reviewLaunchPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span className="relative mr-2 inline-flex h-3.5 w-3.5 items-center justify-center text-cta">
                    <Search className="h-3.5 w-3.5" />
                    <Sparkles className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 text-cta" />
                  </span>
                )}
                AI {reviewContract.actionLabel}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canApprove || update.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  approveToNextStage();
                }}
                data-testid={`button-feature-menu-approve-${feature.stage}-${feature.id}`}
              >
                {update.isPending ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-2 h-3.5 w-3.5 text-success" />
                )}
                {canApprove
                  ? `Approve → ${formatStage(nextStageOnPass!)}`
                  : "Approve (no next stage)"}
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem
              disabled={launch.isPending}
              onSelect={(event) => {
                event.preventDefault();
                runPipelineLaunch("produce");
              }}
              data-testid={`button-feature-launch-${feature.stage}-produce-${feature.id}`}
            >
              {produceLaunchPending ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-2 h-3.5 w-3.5" />
              )}
              {produceContract.actionLabel}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            disabled={launch.isPending || isSessionInProgress}
            onSelect={(event) => {
              event.preventDefault();
              runDiscussLaunch();
            }}
            data-testid={`button-feature-discuss-${feature.id}`}
          >
            {discussPending ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageSquare className="mr-2 h-3.5 w-3.5" />
            )}
            Discuss
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid={`menu-feature-stage-${feature.id}`}>
              Stage
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuRadioGroup
                value={feature.stage}
                onValueChange={(stage) => {
                  if (stage === feature.stage) return;
                  update.mutate({
                    stage,
                    historyNote: `Manual stage change ${formatStage(feature.stage)} → ${formatStage(stage as FeatureStage)}`,
                    historySource: "manual",
                  });
                }}
              >
                {stages.map((stage) => (
                  <DropdownMenuRadioItem
                    key={stage}
                    value={stage}
                    data-testid={`menu-feature-stage-${stage}-${feature.id}`}
                  >
                    <span className="mr-2 inline-flex h-3.5 w-3.5 items-center justify-center text-muted-foreground">
                      {STAGE_ICONS[stage]}
                    </span>
                    {formatStage(stage)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
      {activeSessionMeta ? (
        <div className="px-2 pb-1.5 pl-8" data-testid={`feature-active-session-${feature.id}`}>
          <ChildSessionBlock
            meta={activeSessionMeta}
            defaultExpanded={false}
          />
        </div>
      ) : null}
    </div>
  );
});

export default function FeaturesPage() {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  /** Empty set = all products. Non-empty = only those product ids. */
  const [productFilter, setProductFilter] = useState<Set<number>>(() => new Set());
  const mountStartedAtRef = useRef(
    typeof performance !== "undefined" ? performance.now() : Date.now(),
  );
  const firstPaintRecordedRef = useRef(false);

  const features = useQuery<Feature[]>({
    queryKey: ["/api/features", search],
    queryFn: async () => {
      const startedAt = performance.now();
      const response = await apiRequest(
        "GET",
        `/api/features${search ? `?search=${encodeURIComponent(search)}` : ""}`,
      );
      const rows = (await response.json()) as Feature[];
      recordFeaturesTelemetry("list_fetch", performance.now() - startedAt, "ms", {
        rowCount: rows.length,
        searched: Boolean(search),
      });
      recordFeaturesTelemetry("row_count", rows.length, "count", {
        searched: Boolean(search),
      });
      return rows;
    },
    staleTime: 15_000,
  });
  const products = useQuery<Product[]>({ queryKey: ["/api/products"] });
  const people = useQuery<{ people: Person[] }>({ queryKey: ["/api/people"] });
  // One page-level sessions subscription — rows never each re-query /api/sessions.
  const sessions = useQuery<ChatSession[]>({
    queryKey: ["/api/sessions"],
    staleTime: 10_000,
  });
  const currentPerson = people.data?.people.find((person) => person.cabinetLevel === "user") ?? null;
  const productList = products.data ?? [];
  const filteredFeatures = useMemo(() => {
    const rows = features.data ?? [];
    if (productFilter.size === 0) return rows;
    return rows.filter((row) => productFilter.has(row.product_id));
  }, [features.data, productFilter]);
  const grouped = useMemo(
    () => stages.map((stage) => ({ stage, rows: filteredFeatures.filter((row) => row.stage === stage) })),
    [filteredFeatures],
  );

  const sessionsById = useMemo(() => {
    const map = new Map<string, ChatSession>();
    for (const session of sessions.data ?? []) map.set(session.id, session);
    return map;
  }, [sessions.data]);

  // Shortlist of live pipeline sessions for title-match without O(N×M) scans.
  const activePipelineSessions = useMemo(
    () => (sessions.data ?? []).filter((session) => isActivePipelineSession(session)),
    [sessions.data],
  );

  useEffect(() => {
    if (firstPaintRecordedRef.current) return;
    if (features.isLoading || sessions.isLoading) return;
    firstPaintRecordedRef.current = true;
    const elapsed = performance.now() - mountStartedAtRef.current;
    recordFeaturesTelemetry("first_paint", elapsed, "ms", {
      rowCount: filteredFeatures.length,
      activeSessionCount: activePipelineSessions.length,
    });
    recordFeaturesTelemetry("active_sessions", activePipelineSessions.length, "count", {
      rowCount: filteredFeatures.length,
    });
  }, [
    activePipelineSessions.length,
    features.isLoading,
    filteredFeatures.length,
    sessions.isLoading,
  ]);

  // Keep active-session count fresh while humming without spamming first_paint.
  useEffect(() => {
    if (!firstPaintRecordedRef.current) return;
    recordFeaturesTelemetry("active_sessions", activePipelineSessions.length, "count", {
      rowCount: filteredFeatures.length,
    });
  }, [activePipelineSessions.length, filteredFeatures.length]);

  const toggleProductFilter = (productId: number, checked: boolean) => {
    setProductFilter((prev) => {
      const next = new Set(prev);
      if (checked) next.add(productId);
      else next.delete(productId);
      return next;
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={HIERARCHY_TREE_STACK_CLASS} data-testid="features-page">
          <div className="mb-1 flex items-center gap-1.5">
            <div className="min-w-0 flex-1 [&>div]:mb-0">
              <HierarchySearchInput
                value={search}
                onChange={setSearch}
                inputTestId="input-search-features"
                clearTestId="button-clear-feature-search"
                ariaLabel="Search features"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 shrink-0 gap-1.5 px-2 text-xs",
                    productFilter.size > 0 && "border-foreground/40",
                  )}
                  data-testid="button-features-mixer"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Mixer
                  {productFilter.size > 0 ? (
                    <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
                      {productFilter.size}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="menu-features-product-filter">
                    Product
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52">
                    <DropdownMenuItem
                      onSelect={(event) => {
                        event.preventDefault();
                        setProductFilter(new Set());
                      }}
                      data-testid="menu-features-product-all"
                    >
                      <span className="mr-2 flex h-3.5 w-3.5 items-center justify-center">
                        {productFilter.size === 0 ? <Check className="h-3.5 w-3.5" /> : null}
                      </span>
                      All products
                    </DropdownMenuItem>
                    {productList.map((product) => (
                      <DropdownMenuCheckboxItem
                        key={product.id}
                        checked={productFilter.has(product.id)}
                        onCheckedChange={(checked) => toggleProductFilter(product.id, checked === true)}
                        onSelect={(event) => event.preventDefault()}
                        data-testid={`menu-features-product-${product.id}`}
                      >
                        {product.name}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
                      <FeatureRow
                        feature={feature}
                        products={productList}
                        sessionsById={sessionsById}
                        activePipelineSessions={activePipelineSessions}
                      />
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
