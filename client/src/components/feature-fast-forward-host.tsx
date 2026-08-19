import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  composeFeatureLaunchMessage,
  featureAllowsFastForward,
  getFeatureJobContract,
  resolveFeaturePipelineJob,
} from "@shared/feature-pipeline";
import type { ChatSession } from "@shared/models/chat";
import { isDurablyActiveSession } from "@shared/models/chat";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useSessionLaunch } from "@/hooks/use-session-launch";
import {
  clearFeatureFastForwardRuntime,
  fastForwardLastLaunchByFeature,
  fastForwardLaunchInFlight,
  fastForwardLaunchedSessionByFeature,
  listFeatureFastForwardIdsFromStorage,
  parseClock,
  playIsGated,
  readFeatureFastForward,
  sessionHasError,
  sessionHasQuestion,
  type FeatureFastForwardRow,
} from "@/lib/feature-fast-forward-mode";

/**
 * Shell-owned Fast Forward sequencer.
 *
 * Mode is sessionStorage per Feature. Launch + settle memory is process-local.
 * Host stays mounted under SessionActivityProvider so walking continues after
 * leaving /features. Only runPipelineLaunch paths — no stage/status writes.
 */

function isActivePipelineSession(session: ChatSession | undefined | null): boolean {
  if (!session) return false;
  return isDurablyActiveSession(session) || session.status === "streaming";
}

type ProductContext = {
  id: number;
  name: string;
  context?: Array<{ kind: string; libraryPageId: string; pageTitle?: string }>;
};

type FeatureSessionLink = {
  sessionId: string;
  title: string;
  evidenceType: "explicit" | "discovered";
  createdAt?: string | null;
};

function FeatureFastForwardWalker({
  feature,
  products,
  sessionsById,
}: {
  feature: FeatureFastForwardRow;
  products: ProductContext[];
  sessionsById: Map<string, ChatSession>;
}) {
  const launch = useSessionLaunch();
  const [settleTick, setSettleTick] = useState(0);
  const settleRefetchKeyRef = useRef<string | null>(null);
  const launchedSessionId = fastForwardLaunchedSessionByFeature.get(feature.id) ?? null;

  const turnOff = useCallback(() => {
    clearFeatureFastForwardRuntime(feature.id);
    // Force host rescan of sessionStorage keys.
    window.dispatchEvent(new Event("feature-fast-forward-changed"));
  }, [feature.id]);

  const { data: linkedSessions = [] } = useQuery<FeatureSessionLink[]>({
    queryKey: ["/api/features", feature.id, "sessions"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/features/${feature.id}/sessions`);
      return response.json();
    },
    staleTime: 15_000,
  });

  const ownedSession = useMemo(() => {
    const candidates = new Map<string, ChatSession>();
    if (launchedSessionId) {
      const launched = sessionsById.get(launchedSessionId);
      if (launched && isActivePipelineSession(launched)) candidates.set(launched.id, launched);
    }
    for (const link of linkedSessions) {
      const session = sessionsById.get(link.sessionId);
      if (session && isActivePipelineSession(session)) candidates.set(session.id, session);
    }
    // Title ownership is page-level on Features; shell host only binds launched
    // + linked sessions so it never steals another Feature's stream by title.
    const active = [...candidates.values()].sort(
      (a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt),
    );
    if (active[0]) return active[0];
    if (!launchedSessionId) return null;
    return sessionsById.get(launchedSessionId) ?? null;
  }, [launchedSessionId, linkedSessions, sessionsById]);

  const isSessionInProgress = Boolean(
    ownedSession && isActivePipelineSession(ownedSession),
  );

  const runPipelineLaunch = useCallback(
    (job: "produce" | "review") => {
      if (launch.isPending) return;
      const contract = getFeatureJobContract(feature.stage, job);
      const pendingKey = `feature-${feature.id}-${feature.stage}-${job}`;
      fastForwardLastLaunchByFeature.set(feature.id, {
        job,
        stage: feature.stage,
        launchedAt: Date.now(),
      });
      const product = products.find((row) => row.id === feature.product_id);
      launch.mutate(
        {
          pendingKey,
          title: `${contract.actionLabel}: ${feature.summary}`.slice(0, 80),
          personaName: contract.persona,
          message: composeFeatureLaunchMessage(
            {
              id: feature.id,
              summary: feature.summary,
              stage: feature.stage,
              status: feature.status,
              productName: feature.product_name ?? product?.name,
              productId: feature.product_id,
              ownerPersonId: feature.owner_person_id ?? undefined,
              specPageId: feature.spec_page_id ?? undefined,
              description: feature.description ?? undefined,
              productContextPages: product?.context,
            },
            job,
          ),
          clientTurnSuffix: pendingKey,
          errorTitle: `Could not start ${contract.actionLabel.toLowerCase()} session`,
          openFocus: false,
        },
        {
          onSuccess: (session) => {
            fastForwardLaunchedSessionByFeature.set(feature.id, session.id);
            void queryClient.invalidateQueries({
              queryKey: ["/api/features", feature.id, "sessions"],
            });
          },
          onError: () => turnOff(),
        },
      );
    },
    [feature, launch, products, turnOff],
  );

  const runPipelineLaunchRef = useRef(runPipelineLaunch);
  runPipelineLaunchRef.current = runPipelineLaunch;

  useEffect(() => {
    if (!readFeatureFastForward(feature.id)) return;
    if (!featureAllowsFastForward(feature.stage) || feature.stage === "maintain") {
      turnOff();
      return;
    }
    if (sessionHasQuestion(ownedSession) || sessionHasError(ownedSession)) {
      turnOff();
      return;
    }
    if (isSessionInProgress) {
      fastForwardLaunchInFlight.delete(feature.id);
      return;
    }
    if (launch.isPending) return;
    const last = fastForwardLastLaunchByFeature.get(feature.id) ?? null;
    if (last && !ownedSession && launchedSessionId) return;
    if (last) {
      const sessionSettledAt = ownedSession
        ? parseClock(ownedSession.updatedAt || ownedSession.createdAt)
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
        if (settleRefetchKeyRef.current !== refetchKey) {
          settleRefetchKeyRef.current = refetchKey;
          void queryClient.invalidateQueries({ queryKey: ["/api/features"] });
        }
        const timeoutId = window.setTimeout(() => {
          setSettleTick((tick) => tick + 1);
        }, 1_000);
        return () => window.clearTimeout(timeoutId);
      }
      if (last.job === "review" && feature.stage === last.stage) {
        turnOff();
        return;
      }
      if (last.job === "produce" && feature.status !== "needs_review") {
        turnOff();
        return;
      }
    }
    const job = resolveFeaturePipelineJob(feature.status);
    if (job === "produce" && playIsGated(feature.availability)) {
      turnOff();
      return;
    }
    if (fastForwardLaunchInFlight.has(feature.id)) return;
    fastForwardLaunchInFlight.add(feature.id);
    runPipelineLaunchRef.current(job);
  }, [
    feature.availability,
    feature.id,
    feature.stage,
    feature.status,
    feature.updated_at,
    isSessionInProgress,
    launch.isPending,
    launchedSessionId,
    ownedSession,
    settleTick,
    turnOff,
  ]);

  return null;
}

/**
 * Mount once in the authenticated shell. Renders nothing; drives active
 * Fast Forward Features while the SPA tab lives.
 */
export function FeatureFastForwardHost() {
  const [activeIds, setActiveIds] = useState<string[]>(() => listFeatureFastForwardIdsFromStorage());

  useEffect(() => {
    const refresh = () => setActiveIds(listFeatureFastForwardIdsFromStorage());
    window.addEventListener("storage", refresh);
    window.addEventListener("feature-fast-forward-changed", refresh);
    // Catch same-tab writes that only hit sessionStorage (no storage event).
    const intervalId = window.setInterval(refresh, 2_000);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("feature-fast-forward-changed", refresh);
      window.clearInterval(intervalId);
    };
  }, []);

  const features = useQuery<FeatureFastForwardRow[]>({
    queryKey: ["/api/features"],
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/features");
      return response.json();
    },
    enabled: activeIds.length > 0,
    staleTime: 10_000,
  });

  const products = useQuery<ProductContext[]>({
    queryKey: ["/api/products"],
    enabled: activeIds.length > 0,
    staleTime: 30_000,
  });

  const sessions = useQuery<ChatSession[]>({
    queryKey: ["/api/sessions"],
    enabled: activeIds.length > 0,
    staleTime: 10_000,
  });

  const sessionsById = useMemo(() => {
    const map = new Map<string, ChatSession>();
    for (const session of sessions.data ?? []) map.set(session.id, session);
    return map;
  }, [sessions.data]);

  const productList = products.data ?? [];
  const featureById = useMemo(() => {
    const map = new Map<string, FeatureFastForwardRow>();
    for (const row of features.data ?? []) map.set(row.id, row);
    return map;
  }, [features.data]);

  // Drop flags whose Features disappeared or are no longer eligible.
  useEffect(() => {
    if (!features.data) return;
    for (const id of activeIds) {
      const row = featureById.get(id);
      if (!row) continue;
      if (!featureAllowsFastForward(row.stage) || row.stage === "maintain") {
        clearFeatureFastForwardRuntime(id);
      }
    }
  }, [activeIds, featureById, features.data]);

  if (activeIds.length === 0) return null;

  return (
    <>
      {activeIds.map((id) => {
        const feature = featureById.get(id);
        if (!feature) return null;
        if (!readFeatureFastForward(id)) return null;
        if (!featureAllowsFastForward(feature.stage)) return null;
        return (
          <FeatureFastForwardWalker
            key={id}
            feature={feature}
            products={productList}
            sessionsById={sessionsById}
          />
        );
      })}
    </>
  );
}

/** Notify shell host after same-tab mode writes (sessionStorage has no event). */
export function notifyFeatureFastForwardChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("feature-fast-forward-changed"));
}
