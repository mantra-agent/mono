import type { RailwayDeployment } from "../integrations/railway/client";
import { extractDeploymentMeta } from "../integrations/railway/client";
import type { StageLifecycleCapabilities, StageLifecycleStatus } from "@shared/models/platform-environment-lifecycle";

export function isMantraWebStageIdentity(identity?: { platformName?: string | null; productName?: string | null; environmentName?: string | null }): boolean {
  return identity?.platformName?.trim().toLowerCase() === "mantra"
    && identity?.productName?.trim().toLowerCase() === "web"
    && identity?.environmentName?.trim().toLowerCase() === "stage";
}

export function deriveStageLifecycleCapabilities(
  policy: Record<string, unknown> = {},
  providerKind = "railway",
  identity?: { platformName?: string | null; productName?: string | null; environmentName?: string | null },
): StageLifecycleCapabilities {
  const runtimeMode = policy.runtimeMode === "warm_workspace" ? "warm_workspace" : "immutable_artifact";
  const fullRebuildProvider = policy.fullRebuildProvider === "eas" || policy.fullRebuildProvider === "cloudflare_pages" || policy.fullRebuildProvider === "manual"
    ? policy.fullRebuildProvider
    : providerKind === "railway" ? "railway" : "manual";
  const isStage = isMantraWebStageIdentity(identity);
  return {
    runtimeMode,
    syncOnPush: runtimeMode === "warm_workspace" && policy.syncOnPush === true,
    dependencyPolicy: "rebuild_on_lockfile_change",
    fullRebuildProvider,
    actions: runtimeMode === "warm_workspace"
      ? (isStage ? ["sync_latest", "restart_stage", "full_rebuild"] : ["full_rebuild"])
      : (isStage ? ["enable_warm_stage", "full_rebuild"] : ["full_rebuild"]),
  };
}

const IN_FLIGHT_STATUSES = new Set(["INITIALIZING", "WAITING", "QUEUED", "BUILDING", "DEPLOYING"]);
const ACTIVE_STATUSES = new Set(["SUCCESS", "ACTIVE", "COMPLETED"]);
const FAILED_STATUSES = new Set(["FAILED", "CRASHED"]);

export type WarmSyncProjection = {
  activeCommitSha?: string | null;
  targetCommitSha?: string | null;
  status?: "idle" | "pending" | "applying" | "ready" | "failed" | null;
  reason?: string | null;
};

interface ComposeStageLifecycleStatusInput {
  deployments: RailwayDeployment[];
  /** Bound source branch HEAD — desired code on Warm Stage. */
  targetCommitSha: string | null;
  /** Warm workspace truth when runtimeMode is warm_workspace. Railway image SHA is not Active. */
  warmSync?: WarmSyncProjection | null;
  providerError?: string | null;
  observedAt?: Date;
  capabilities: StageLifecycleStatus["capabilities"];
}

function normalizeSha(value: string | null | undefined): string | null {
  const sha = value?.trim().toLowerCase() || "";
  return /^[a-f0-9]{7,64}$/.test(sha) ? sha : null;
}

function equalSha(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  const n = Math.min(left.length, right.length);
  return n >= 7 && left.slice(0, n) === right.slice(0, n);
}

/** Build-owned projection of provider and source truth. The client must never derive commit identity. */
export function composeStageLifecycleStatus(input: ComposeStageLifecycleStatusInput): StageLifecycleStatus {
  const observedAt = (input.observedAt ?? new Date()).toISOString();
  const latest = input.deployments[0] ?? null;
  const latestStatus = latest?.status?.toUpperCase() ?? null;
  const activeDeploy = input.deployments.find((deployment) => ACTIVE_STATUSES.has(deployment.status?.toUpperCase() ?? "")) ?? null;
  const providerImageSha = normalizeSha(extractDeploymentMeta(activeDeploy?.meta).commitHash)
    ?? normalizeSha(extractDeploymentMeta(latest?.meta).commitHash);
  const branchHead = normalizeSha(input.targetCommitSha);
  const warmActive = normalizeSha(input.warmSync?.activeCommitSha);
  const warmTarget = normalizeSha(input.warmSync?.targetCommitSha);
  const warmStatus = input.warmSync?.status ?? null;
  const warmReason = input.warmSync?.reason?.trim() || null;
  const isWarm = input.capabilities.runtimeMode === "warm_workspace";
  // Warm Active = workspace tree SHA. Cold Active = Railway image SHA.
  const activeCommitSha = isWarm ? (warmActive ?? providerImageSha) : providerImageSha;
  const targetCommitSha = branchHead ?? warmTarget;
  const providerDeploymentId = latest?.id ?? null;

  if (input.providerError) {
    return {
      state: "degraded",
      activeCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: input.providerError,
      capabilities: input.capabilities,
    };
  }

  if (!latest || !latestStatus) {
    return {
      state: "degraded",
      activeCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: "No provider deployment truth is available.",
      capabilities: input.capabilities,
    };
  }

  // Full Rebuild / cold image path still surfaces when Railway is mid-build.
  if (IN_FLIGHT_STATUSES.has(latestStatus) && !isWarm) {
    return {
      state: "rebuilding",
      activeCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: activeCommitSha ? null : "The provider has not reported an active deployment commit.",
      capabilities: input.capabilities,
    };
  }

  if (FAILED_STATUSES.has(latestStatus) && !isWarm) {
    return {
      state: "failed",
      activeCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: `Railway deployment ${latestStatus.toLowerCase()}.`,
      capabilities: input.capabilities,
    };
  }

  if (isWarm) {
    if (warmStatus === "failed") {
      return {
        state: "failed",
        activeCommitSha,
        targetCommitSha,
        providerDeploymentId,
        providerStatus: latestStatus,
        observedAt,
        reason: warmReason || "Warm Sync Latest failed.",
        capabilities: input.capabilities,
      };
    }
    if (warmStatus === "pending" || warmStatus === "applying") {
      return {
        state: "syncing",
        activeCommitSha,
        targetCommitSha,
        providerDeploymentId,
        providerStatus: latestStatus,
        observedAt,
        reason: warmReason
          || (warmStatus === "applying"
            ? "Applying target commit into the warm workspace."
            : "Sync Latest queued — waiting for Stage restart to apply the target."),
        capabilities: input.capabilities,
      };
    }
    // Cold autodeploy may still be BUILDING underneath Warm Stage; that is parachute noise,
    // not the Active/Target identity for the warm workspace.
    if (IN_FLIGHT_STATUSES.has(latestStatus) && !activeCommitSha) {
      return {
        state: "rebuilding",
        activeCommitSha,
        targetCommitSha,
        providerDeploymentId,
        providerStatus: latestStatus,
        observedAt,
        reason: "Railway is building a recovery image while Warm Stage has no workspace commit yet.",
        capabilities: input.capabilities,
      };
    }
    if (!targetCommitSha) {
      return {
        state: "degraded",
        activeCommitSha,
        targetCommitSha,
        providerDeploymentId,
        providerStatus: latestStatus,
        observedAt,
        reason: "The bound source branch head could not be resolved.",
        capabilities: input.capabilities,
      };
    }
    if (!activeCommitSha) {
      return {
        state: "syncing",
        activeCommitSha,
        targetCommitSha,
        providerDeploymentId,
        providerStatus: latestStatus,
        observedAt,
        reason: "Warm workspace has not recorded an active commit yet — run Sync Latest after Stage is healthy.",
        capabilities: input.capabilities,
      };
    }
    if (equalSha(activeCommitSha, targetCommitSha)) {
      return {
        state: "ready",
        activeCommitSha,
        targetCommitSha,
        providerDeploymentId,
        providerStatus: latestStatus,
        observedAt,
        reason: null,
        capabilities: input.capabilities,
      };
    }
    return {
      state: "syncing",
      activeCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: "Warm workspace is behind the bound source branch. Run Sync Latest.",
      capabilities: input.capabilities,
    };
  }

  if (ACTIVE_STATUSES.has(latestStatus)) {
    const latestCommitSha = normalizeSha(extractDeploymentMeta(latest.meta).commitHash);
    if (!latestCommitSha || !targetCommitSha) {
      return {
        state: "degraded",
        activeCommitSha: latestCommitSha,
        targetCommitSha,
        providerDeploymentId,
        providerStatus: latestStatus,
        observedAt,
        reason: !latestCommitSha
          ? "The active provider deployment has no commit identity."
          : "The bound source branch head could not be resolved.",
        capabilities: input.capabilities,
      };
    }
    return {
      state: equalSha(latestCommitSha, targetCommitSha) ? "ready" : "syncing",
      activeCommitSha: latestCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: equalSha(latestCommitSha, targetCommitSha) ? null : "The bound source branch is ahead of the active deployment.",
      capabilities: input.capabilities,
    };
  }

  if (IN_FLIGHT_STATUSES.has(latestStatus)) {
    return {
      state: "rebuilding",
      activeCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: activeCommitSha ? null : "The provider has not reported an active deployment commit.",
      capabilities: input.capabilities,
    };
  }

  if (FAILED_STATUSES.has(latestStatus)) {
    return {
      state: "failed",
      activeCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: `Railway deployment ${latestStatus.toLowerCase()}.`,
      capabilities: input.capabilities,
    };
  }

  return {
    state: "degraded",
    activeCommitSha,
    targetCommitSha,
    providerDeploymentId,
    providerStatus: latestStatus,
    observedAt,
    reason: `Unsupported Railway deployment status ${latestStatus}.`,
    capabilities: input.capabilities,
  };
}
