import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  composeFeatureLaunchMessage,
  featureAllowsFastForward,
  getFeatureJobContract,
  resolveFeaturePipelineJob,
  type FeatureStage,
  type FeatureStatus,
} from "@shared/feature-pipeline";
import type { ChatSession } from "@shared/models/chat";
import { isDurablyActiveSession } from "@shared/models/chat";
import {
  isFeatureControlCommand,
  type FeatureControlAct,
  type FeatureControlReason,
  type FeatureControlResult,
} from "@shared/feature-control";
import { apiRequest } from "@/lib/queryClient";
import { acquireSharedWS, releaseSharedWS } from "@/lib/ws-connection";
import { createLogger } from "@/lib/logger";
import {
  claimAutoReviewRoom,
  clearFeatureFastForwardRuntime,
  fastForwardLastLaunchByFeature,
  fastForwardLaunchInFlight,
  fastForwardLaunchedSessionByFeature,
  playIsGated,
  readFeatureFastForward,
  writeFeatureFastForward,
  type FeatureFastForwardRow,
} from "@/lib/feature-fast-forward-mode";
import { notifyFeatureFastForwardChanged } from "@/components/feature-fast-forward-host";

/**
 * Shell host: agent Feature controls (play / fast_forward / pause / stop).
 *
 * Same acts as the Features row. Fast Forward remains sessionStorage mode;
 * launch remains the ordinary session create + first message path; stop remains
 * POST /api/sessions/:id/abort. No stage/status writes.
 */

const log = createLogger("FeaturePipelineControl");
const WS_OWNER = "feature-pipeline-control";
const HANDLER_ID = "feature-pipeline-control-command";

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

function isActivePipelineSession(session: ChatSession | undefined | null): boolean {
  if (!session) return false;
  return isDurablyActiveSession(session) || session.status === "streaming";
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await apiRequest("GET", path);
  return response.json();
}

async function loadFeature(featureId: string): Promise<FeatureFastForwardRow | null> {
  try {
    const row = await fetchJson<FeatureFastForwardRow>(`/api/features/${featureId}`);
    return row?.id ? row : null;
  } catch {
    return null;
  }
}

async function loadProducts(): Promise<ProductContext[]> {
  try {
    return await fetchJson<ProductContext[]>("/api/products");
  } catch {
    return [];
  }
}

async function loadLinkedSessions(featureId: string): Promise<FeatureSessionLink[]> {
  try {
    return await fetchJson<FeatureSessionLink[]>(`/api/features/${featureId}/sessions`);
  } catch {
    return [];
  }
}

async function loadSessionsById(): Promise<Map<string, ChatSession>> {
  try {
    const sessions = await fetchJson<ChatSession[]>("/api/sessions");
    const map = new Map<string, ChatSession>();
    for (const session of sessions ?? []) map.set(session.id, session);
    return map;
  } catch {
    return new Map();
  }
}

function resolveOwnedActiveSession(args: {
  featureId: string;
  linkedSessions: FeatureSessionLink[];
  sessionsById: Map<string, ChatSession>;
}): ChatSession | null {
  const candidates = new Map<string, ChatSession>();
  const launchedId = fastForwardLaunchedSessionByFeature.get(args.featureId) ?? null;
  if (launchedId) {
    const launched = args.sessionsById.get(launchedId);
    if (launched && isActivePipelineSession(launched)) candidates.set(launched.id, launched);
  }
  for (const link of args.linkedSessions) {
    const session = args.sessionsById.get(link.sessionId);
    if (session && isActivePipelineSession(session)) candidates.set(session.id, session);
  }
  const active = [...candidates.values()].sort(
    (a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt),
  );
  return active[0] ?? null;
}

async function launchPipelineJob(
  feature: FeatureFastForwardRow,
  products: ProductContext[],
  job: "produce" | "review",
): Promise<{ sessionId: string } | { error: FeatureControlReason }> {
  // Room claim shared with auto AI Review — agent/remote launch must fence too.
  if (job === "review") {
    claimAutoReviewRoom(feature.id, feature.stage as FeatureStage);
  }
  const contract = getFeatureJobContract(feature.stage as FeatureStage, job);
  const product = products.find((row) => row.id === feature.product_id);
  const pendingKey = `feature-${feature.id}-${feature.stage}-${job}`;
  fastForwardLastLaunchByFeature.set(feature.id, {
    job,
    stage: feature.stage as FeatureStage,
    launchedAt: Date.now(),
  });
  try {
    const createResponse = await apiRequest("POST", "/api/sessions", {
      title: `${contract.actionLabel}: ${feature.summary}`.slice(0, 80),
      personaName: contract.persona,
    });
    const session: { id: string } = await createResponse.json();
    const message = composeFeatureLaunchMessage(
      {
        id: feature.id,
        summary: feature.summary,
        stage: feature.stage as FeatureStage,
        status: feature.status as FeatureStatus,
        productName: feature.product_name ?? product?.name,
        productId: feature.product_id,
        ownerPersonId: feature.owner_person_id ?? undefined,
        specPageId: feature.spec_page_id ?? undefined,
        description: feature.description ?? undefined,
        productContextPages: product?.context,
      },
      job,
    );
    await apiRequest("POST", `/api/sessions/${session.id}/messages`, {
      content: message,
      clientTurnId: `session-launch-${session.id}-${pendingKey}`.slice(0, 120),
    });
    fastForwardLaunchedSessionByFeature.set(feature.id, session.id);
    return { sessionId: session.id };
  } catch (error) {
    log.warn("pipeline launch failed", {
      featureId: feature.id,
      job,
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: "launch_failed" };
  }
}

async function abortSession(sessionId: string): Promise<boolean> {
  try {
    await apiRequest("POST", `/api/sessions/${sessionId}/abort`);
    return true;
  } catch (error) {
    log.warn("session abort failed", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function FeaturePipelineControlHost() {
  const queryClient = useQueryClient();
  const queryClientRef = useRef(queryClient);
  queryClientRef.current = queryClient;

  useEffect(() => {
    const ws = acquireSharedWS(WS_OWNER);
    const sendResult = (result: FeatureControlResult) => {
      const sent = ws.send(result as unknown as Record<string, unknown>);
      if (!sent) {
        log.warn("failed to send feature control result", { commandId: result.commandId });
      }
    };

    const handleAct = async (
      commandId: string,
      featureId: string,
      act: FeatureControlAct,
    ): Promise<FeatureControlResult> => {
      const base = {
        type: "feature.control.result" as const,
        commandId,
        featureId,
        act,
      };

      const feature = await loadFeature(featureId);
      if (!feature) {
        return { ...base, outcome: "unavailable", reason: "feature_not_found" };
      }

      const [products, linkedSessions, sessionsById] = await Promise.all([
        loadProducts(),
        loadLinkedSessions(featureId),
        loadSessionsById(),
      ]);
      const activeSession = resolveOwnedActiveSession({
        featureId,
        linkedSessions,
        sessionsById,
      });
      const modeOn = readFeatureFastForward(featureId);

      if (act === "play") {
        if (activeSession) {
          return {
            ...base,
            outcome: "unavailable",
            reason: "session_in_progress",
            sessionId: activeSession.id,
            fastForwardOn: modeOn,
          };
        }
        const job = resolveFeaturePipelineJob(feature.status as FeatureStatus);
        if (job === "produce" && playIsGated(feature.availability)) {
          return { ...base, outcome: "unavailable", reason: "gated_play", fastForwardOn: modeOn };
        }
        const launched = await launchPipelineJob(feature, products, job);
        if ("error" in launched) {
          return { ...base, outcome: "unavailable", reason: launched.error, fastForwardOn: modeOn };
        }
        void queryClientRef.current.invalidateQueries({ queryKey: ["/api/sessions"] });
        void queryClientRef.current.invalidateQueries({
          queryKey: ["/api/features", featureId, "sessions"],
        });
        return {
          ...base,
          outcome: "completed",
          sessionId: launched.sessionId,
          fastForwardOn: modeOn,
        };
      }

      if (act === "fast_forward") {
        if (!featureAllowsFastForward(feature.stage as FeatureStage) || feature.stage === "maintain") {
          return { ...base, outcome: "unavailable", reason: "ineligible_stage", fastForwardOn: false };
        }
        const job = resolveFeaturePipelineJob(feature.status as FeatureStatus);
        if (job === "produce" && playIsGated(feature.availability)) {
          return { ...base, outcome: "unavailable", reason: "gated_play", fastForwardOn: false };
        }
        if (modeOn) {
          return {
            ...base,
            outcome: "completed",
            reason: "mode_already_on",
            fastForwardOn: true,
            ...(activeSession ? { sessionId: activeSession.id } : {}),
          };
        }
        writeFeatureFastForward(featureId, true);
        notifyFeatureFastForwardChanged();
        let sessionId: string | undefined;
        if (!activeSession) {
          fastForwardLaunchInFlight.add(featureId);
          const launched = await launchPipelineJob(feature, products, job);
          if ("error" in launched) {
            clearFeatureFastForwardRuntime(featureId);
            notifyFeatureFastForwardChanged();
            return { ...base, outcome: "unavailable", reason: launched.error, fastForwardOn: false };
          }
          sessionId = launched.sessionId;
        } else {
          sessionId = activeSession.id;
        }
        void queryClientRef.current.invalidateQueries({ queryKey: ["/api/sessions"] });
        void queryClientRef.current.invalidateQueries({
          queryKey: ["/api/features", featureId, "sessions"],
        });
        return {
          ...base,
          outcome: "completed",
          sessionId,
          fastForwardOn: true,
        };
      }

      if (act === "pause") {
        if (!modeOn && !activeSession) {
          return { ...base, outcome: "completed", reason: "mode_already_off", fastForwardOn: false };
        }
        if (activeSession) {
          const aborted = await abortSession(activeSession.id);
          if (!aborted) {
            return {
              ...base,
              outcome: "unavailable",
              reason: "stop_failed",
              sessionId: activeSession.id,
              fastForwardOn: modeOn,
            };
          }
          fastForwardLaunchedSessionByFeature.delete(featureId);
        }
        clearFeatureFastForwardRuntime(featureId);
        notifyFeatureFastForwardChanged();
        void queryClientRef.current.invalidateQueries({ queryKey: ["/api/sessions"] });
        void queryClientRef.current.invalidateQueries({
          queryKey: ["/api/features", featureId, "sessions"],
        });
        return {
          ...base,
          outcome: "completed",
          ...(activeSession ? { sessionId: activeSession.id } : {}),
          fastForwardOn: false,
        };
      }

      // stop
      if (!activeSession) {
        if (modeOn) {
          clearFeatureFastForwardRuntime(featureId);
          notifyFeatureFastForwardChanged();
        }
        return { ...base, outcome: "unavailable", reason: "no_active_session", fastForwardOn: false };
      }
      const aborted = await abortSession(activeSession.id);
      if (!aborted) {
        return {
          ...base,
          outcome: "unavailable",
          reason: "stop_failed",
          sessionId: activeSession.id,
          fastForwardOn: modeOn,
        };
      }
      fastForwardLaunchedSessionByFeature.delete(featureId);
      if (modeOn) {
        clearFeatureFastForwardRuntime(featureId);
        notifyFeatureFastForwardChanged();
      }
      void queryClientRef.current.invalidateQueries({ queryKey: ["/api/sessions"] });
      void queryClientRef.current.invalidateQueries({
        queryKey: ["/api/features", featureId, "sessions"],
      });
      return {
        ...base,
        outcome: "completed",
        sessionId: activeSession.id,
        fastForwardOn: false,
      };
    };

    ws.addMessageHandler(HANDLER_ID, (message) => {
      if (!isFeatureControlCommand(message)) return;
      if (message.expiresAt <= Date.now()) {
        sendResult({
          type: "feature.control.result",
          commandId: message.commandId,
          featureId: message.featureId,
          act: message.act,
          outcome: "unavailable",
          reason: "timed_out",
        });
        return;
      }
      void handleAct(message.commandId, message.featureId, message.act)
        .then((result) => sendResult(result))
        .catch((error) => {
          log.warn("feature control handler error", {
            commandId: message.commandId,
            error: error instanceof Error ? error.message : String(error),
          });
          sendResult({
            type: "feature.control.result",
            commandId: message.commandId,
            featureId: message.featureId,
            act: message.act,
            outcome: "unavailable",
            reason: "target_unavailable",
          });
        });
    });

    return () => {
      ws.removeMessageHandler(HANDLER_ID);
      releaseSharedWS(WS_OWNER);
    };
  }, []);

  return null;
}
