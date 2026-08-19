/**
 * Shell-owned Feature Fast Forward sequencer.
 *
 * Survives leaving /features. Only calls the same launch path Features uses
 * (useSessionLaunch + composeFeatureLaunchMessage). Mode is sessionStorage.
 * Pause / stop stay on the Feature row (runStopSession).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FEATURE_PIPELINE,
  FEATURE_STAGES,
  composeFeatureLaunchMessage,
  featureAllowsFastForward,
  getFeatureJobContract,
  resolveFeaturePipelineJob,
  type FeatureStage,
  type FeatureStatus,
} from "@shared/feature-pipeline";
import type { ChatSession } from "@shared/models/chat";
import { isDurablyActiveSession } from "@shared/models/chat";
import { useSessionLaunch } from "@/hooks/use-session-launch";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  bindFastForwardLaunchSession,
  fastForwardLaunchInFlight,
  getFastForwardLastLaunch,
  getFastForwardSettleRefetchKey,
  listActiveFeatureFastForwardIds,
  readFeatureFastForward,
  setFastForwardLastLaunch,
  setFastForwardSettleRefetchKey,
  subscribeFeatureFastForwardMode,
  writeFeatureFastForward,
  FEATURE_FAST_FORWARD_MODE_EVENT,
} from "@/lib/feature-fast-forward";

type FeatureAvailabilityState = "on_stage" | "waiting" | "unknown";

type SequencerFeature = {
  id: string;
  summary: string;
  description?: string;
  stage: FeatureStage;
  status: FeatureStatus;
  product_id: number;
  product_name?: string;
  owner_person_id?: string;
  spec_page_id?: string | null;
  availability?: { state: FeatureAvailabilityState };
  updated_at?: string;
};

type ProductContextPage = {
  kind: string;
  libraryPageId: string;
  pageTitle?: string;
};

type ProductRow = {
  id: number;
  name: string;
  context?: ProductContextPage[];
};

type FeatureSessionLink = {
  sessionId: string;
};

/** Same exact launch-title set as Features page — never substring. */
const FEATURE_SESSION_TITLE_LABELS: readonly string[] = Array.from(
  new Set([
    "Discuss",
    ...FEATURE_STAGES.flatMap((stage) => [
      FEATURE_PIPELINE[stage].produce.actionLabel,
      FEATURE_PIPELINE[stage].review.actionLabel,
    ]),
  ]),
);

function featureSessionLaunchTitles(summary: string): string[] {
  const trimmed = summary.trim();
  if (!trimmed) return [];
  return FEATURE_SESSION_TITLE_LABELS.map((label) => `${label}: ${trimmed}`.slice(0, 80));
}

function sessionTitleMatchesFeature(
  sessionTitle: string | null | undefined,
  summary: string,
): boolean {
  const title = sessionTitle?.trim();
  if (!title) return false;
  return featureSessionLaunchTitles(summary).includes(title);
}

function isActivePipelineSession(session: ChatSession | undefined | null): boolean {
  if (!session) return false;
  return isDurablyActiveSession(session) || session.status === "streaming";
}

function playIsGated(availability?: SequencerFeature["availability"]): boolean {
  return availability?.state === "waiting" || availability?.state === "unknown";
}

function sessionHasQuestion(session: ChatSession | null | undefined): boolean {
  if (!session) return false;
  return Boolean(
    session.awaitingQuestionResponse ||
      session.awaitingReview ||
      session.reviewKinds?.includes("question"),
  );
}

function sessionHasError(session: ChatSession | null | undefined): boolean {
  if (!session) return false;
  return session.errorSeverity === "error" || Boolean(session.reviewKinds?.includes("error"));
}

function parseClock(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function buildExclusiveTitleSessionOwners(
  features: Array<{ id: string; summary: string }>,
  activePipelineSessions: ChatSession[],
): Map<string, string> {
  const sessionToFeature = new Map<string, string>();
  for (const session of activePipelineSessions) {
    const title = session.title?.trim();
    if (!title) continue;
    const matches = features
      .filter((feature) => sessionTitleMatchesFeature(title, feature.summary))
      .map((feature) => ({
        featureId: feature.id,
        summaryLen: feature.summary.trim().length,
      }))
      .sort((a, b) => b.summaryLen - a.summaryLen || a.featureId.localeCompare(b.featureId));
    if (matches.length === 0) continue;
    if (matches.length === 1 || matches[0].summaryLen > matches[1].summaryLen) {
      sessionToFeature.set(session.id, matches[0].featureId);
    }
  }
  return sessionToFeature;
}

function resolveOwnedSession(args: {
  featureId: string;
  linkedSessions: FeatureSessionLink[];
  lastSessionId: string | null | undefined;
  sessionsById: Map<string, ChatSession>;
  titleSessionOwners: Map<string, string>;
}): { active: ChatSession | null; owned: ChatSession | null } {
  const ownedByOther = (sessionId: string) => {
    const owner = args.titleSessionOwners.get(sessionId);
    return Boolean(owner && owner !== args.featureId);
  };
  const candidates = new Map<string, ChatSession>();

  if (args.lastSessionId && !ownedByOther(args.lastSessionId)) {
    const launched = args.sessionsById.get(args.lastSessionId);
    if (launched && isActivePipelineSession(launched)) candidates.set(launched.id, launched);
  }
  for (const link of args.linkedSessions) {
    if (ownedByOther(link.sessionId)) continue;
    const session = args.sessionsById.get(link.sessionId);
    if (session && isActivePipelineSession(session)) candidates.set(session.id, session);
  }
  for (const [sessionId, ownerFeatureId] of args.titleSessionOwners) {
    if (ownerFeatureId !== args.featureId) continue;
    const session = args.sessionsById.get(sessionId);
    if (session && isActivePipelineSession(session)) candidates.set(session.id, session);
  }

  const active =
    [...candidates.values()].sort(
      (a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt),
    )[0] ?? null;

  if (active) return { active, owned: active };
  if (!args.lastSessionId) return { active: null, owned: null };
  const session = args.sessionsById.get(args.lastSessionId);
  if (!session) return { active: null, owned: null };
  if (ownedByOther(session.id)) return { active: null, owned: null };
  return { active: null, owned: session };
}

/**
 * Mount once under the authenticated app shell. Renders nothing.
 * Drives Fast Forward for every feature with sessionStorage mode on.
 */
export function FeatureFastForwardSequencer() {
  const launch = useSessionLaunch();
  const [activeIds, setActiveIds] = useState<string[]>(() => listActiveFeatureFastForwardIds());
  const [settleTick, setSettleTick] = useState(0);
  const launchRef = useRef(launch);
  launchRef.current = launch;
  /** Timeouts scheduled this pass — cleared on effect cleanup. */
  const settleTimeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    const sync = () => setActiveIds(listActiveFeatureFastForwardIds());
    const unsub = subscribeFeatureFastForwardMode(() => sync());
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key.startsWith("feature-fast-forward:")) sync();
    };
    const onMode = () => sync();
    window.addEventListener("storage", onStorage);
    window.addEventListener(FEATURE_FAST_FORWARD_MODE_EVENT, onMode as EventListener);
    return () => {
      unsub();
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(FEATURE_FAST_FORWARD_MODE_EVENT, onMode as EventListener);
    };
  }, []);

  const featuresEnabled = activeIds.length > 0;
  const features = useQuery<SequencerFeature[]>({
    queryKey: ["/api/features"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/features");
      return response.json();
    },
    enabled: featuresEnabled,
    staleTime: 5_000,
    refetchInterval: featuresEnabled ? 4_000 : false,
  });

  const products = useQuery<ProductRow[]>({
    queryKey: ["/api/products"],
    enabled: featuresEnabled,
    staleTime: 60_000,
  });

  const sessions = useQuery<ChatSession[]>({
    queryKey: ["/api/sessions"],
    enabled: featuresEnabled,
    staleTime: 5_000,
    refetchInterval: featuresEnabled ? 3_000 : false,
  });

  const sessionsById = useMemo(() => {
    const map = new Map<string, ChatSession>();
    for (const session of sessions.data ?? []) map.set(session.id, session);
    return map;
  }, [sessions.data]);

  const activePipelineSessions = useMemo(
    () => (sessions.data ?? []).filter((session) => isActivePipelineSession(session)),
    [sessions.data],
  );

  const featureById = useMemo(() => {
    const map = new Map<string, SequencerFeature>();
    for (const row of features.data ?? []) map.set(row.id, row);
    return map;
  }, [features.data]);

  const titleSessionOwners = useMemo(
    () =>
      buildExclusiveTitleSessionOwners(
        (features.data ?? []).map((feature) => ({ id: feature.id, summary: feature.summary })),
        activePipelineSessions,
      ),
    [activePipelineSessions, features.data],
  );

  const productById = useMemo(() => {
    const map = new Map<number, ProductRow>();
    for (const product of products.data ?? []) map.set(product.id, product);
    return map;
  }, [products.data]);

  const linkedByFeature = useQuery<Record<string, FeatureSessionLink[]>>({
    queryKey: ["/api/features", "fast-forward-sessions", activeIds.slice().sort().join(",")],
    queryFn: async () => {
      const entries = await Promise.all(
        activeIds.map(async (featureId) => {
          try {
            const response = await apiRequest("GET", `/api/features/${featureId}/sessions`);
            const rows = (await response.json()) as FeatureSessionLink[];
            return [featureId, rows] as const;
          } catch {
            return [featureId, [] as FeatureSessionLink[]] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    },
    enabled: featuresEnabled && activeIds.length > 0,
    staleTime: 5_000,
    refetchInterval: featuresEnabled ? 4_000 : false,
  });

  useEffect(() => {
    for (const id of settleTimeoutsRef.current) window.clearTimeout(id);
    settleTimeoutsRef.current = [];

    if (activeIds.length === 0) return;

    const scheduleSettle = () => {
      const timeoutId = window.setTimeout(() => {
        setSettleTick((tick) => tick + 1);
      }, 1_000);
      settleTimeoutsRef.current.push(timeoutId);
    };

    for (const featureId of activeIds) {
      if (!readFeatureFastForward(featureId)) continue;

      const feature = featureById.get(featureId);
      if (!feature) {
        if (features.isLoading || features.isFetching || !features.data) continue;
        writeFeatureFastForward(featureId, false);
        continue;
      }

      if (!featureAllowsFastForward(feature.stage) || feature.stage === "maintain") {
        writeFeatureFastForward(featureId, false);
        continue;
      }

      const last = getFastForwardLastLaunch(featureId);
      const linked = linkedByFeature.data?.[featureId] ?? [];
      const { active, owned } = resolveOwnedSession({
        featureId,
        linkedSessions: linked,
        lastSessionId: last?.sessionId ?? null,
        sessionsById,
        titleSessionOwners,
      });

      if (sessionHasQuestion(owned) || sessionHasError(owned)) {
        writeFeatureFastForward(featureId, false);
        continue;
      }

      if (active) {
        fastForwardLaunchInFlight.delete(featureId);
        continue;
      }

      const launchPending =
        launchRef.current.isPending &&
        typeof launchRef.current.variables?.pendingKey === "string" &&
        launchRef.current.variables.pendingKey.startsWith(`feature-${featureId}-`);
      if (launchPending) continue;

      if (last) {
        // Bound session id not yet in the sessions map — wait.
        if (last.sessionId && !sessionsById.has(last.sessionId) && !owned) {
          scheduleSettle();
          continue;
        }

        const sessionSettledAt = owned
          ? parseClock(owned.updatedAt || owned.createdAt)
          : last.launchedAt;
        const featureUpdatedAt = parseClock(feature.updated_at);
        const writeLanded =
          Number.isFinite(featureUpdatedAt) &&
          Number.isFinite(sessionSettledAt) &&
          featureUpdatedAt + 2_000 >= sessionSettledAt;
        const waitedTooLong =
          Number.isFinite(sessionSettledAt) && Date.now() - sessionSettledAt > 15_000;

        if (!writeLanded && !waitedTooLong) {
          const refetchKey = `${last.job}:${last.stage}:${last.launchedAt}`;
          if (getFastForwardSettleRefetchKey(featureId) !== refetchKey) {
            setFastForwardSettleRefetchKey(featureId, refetchKey);
            void queryClient.invalidateQueries({ queryKey: ["/api/features"] });
          }
          scheduleSettle();
          continue;
        }

        if (last.job === "review" && feature.stage === last.stage) {
          writeFeatureFastForward(featureId, false);
          continue;
        }
        if (last.job === "produce" && feature.status !== "needs_review") {
          writeFeatureFastForward(featureId, false);
          continue;
        }
      }

      const job = resolveFeaturePipelineJob(feature.status);
      if (job === "produce" && playIsGated(feature.availability)) {
        writeFeatureFastForward(featureId, false);
        continue;
      }

      if (fastForwardLaunchInFlight.has(featureId)) continue;
      if (launchRef.current.isPending) continue;

      const product = productById.get(feature.product_id);
      const contract = getFeatureJobContract(feature.stage, job);
      const pendingKey = `feature-${featureId}-${feature.stage}-${job}`;
      const launchContext = {
        id: feature.id,
        summary: feature.summary,
        stage: feature.stage,
        status: feature.status,
        productName: feature.product_name ?? product?.name,
        productId: feature.product_id,
        ownerPersonId: feature.owner_person_id,
        specPageId: feature.spec_page_id,
        description: feature.description,
        productContextPages: product?.context,
      };

      fastForwardLaunchInFlight.add(featureId);
      setFastForwardLastLaunch(featureId, {
        job,
        stage: feature.stage,
        statusAtLaunch: feature.status,
        launchedAt: Date.now(),
      });

      launchRef.current.mutate(
        {
          pendingKey,
          title: `${contract.actionLabel}: ${feature.summary}`.slice(0, 80),
          personaName: contract.persona,
          message: composeFeatureLaunchMessage(launchContext, job),
          clientTurnSuffix: pendingKey,
          errorTitle: `Could not start ${contract.actionLabel.toLowerCase()} session`,
          openFocus: false,
        },
        {
          onSuccess: (session) => {
            bindFastForwardLaunchSession(featureId, session.id);
            void queryClient.invalidateQueries({
              queryKey: ["/api/features", featureId, "sessions"],
            });
            void queryClient.invalidateQueries({ queryKey: ["/api/sessions"] });
          },
          onError: () => {
            fastForwardLaunchInFlight.delete(featureId);
            writeFeatureFastForward(featureId, false);
          },
          onSettled: () => {
            const timeoutId = window.setTimeout(() => {
              fastForwardLaunchInFlight.delete(featureId);
              setSettleTick((tick) => tick + 1);
            }, 250);
            settleTimeoutsRef.current.push(timeoutId);
          },
        },
      );
    }

    return () => {
      for (const id of settleTimeoutsRef.current) window.clearTimeout(id);
      settleTimeoutsRef.current = [];
    };
  }, [
    activeIds,
    featureById,
    features.data,
    features.isFetching,
    features.isLoading,
    linkedByFeature.data,
    productById,
    sessionsById,
    settleTick,
    titleSessionOwners,
    launch.isPending,
  ]);

  return null;
}
