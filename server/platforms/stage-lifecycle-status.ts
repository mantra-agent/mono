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
      ? (isStage ? ["restart_stage", "full_rebuild"] : ["full_rebuild"])
      : (isStage ? ["enable_warm_stage", "full_rebuild"] : ["full_rebuild"]),
  };
}

const IN_FLIGHT_STATUSES = new Set(["INITIALIZING", "WAITING", "QUEUED", "BUILDING", "DEPLOYING"]);
const ACTIVE_STATUSES = new Set(["SUCCESS", "ACTIVE", "COMPLETED"]);
const FAILED_STATUSES = new Set(["FAILED", "CRASHED"]);

interface ComposeStageLifecycleStatusInput {
  deployments: RailwayDeployment[];
  targetCommitSha: string | null;
  providerError?: string | null;
  observedAt?: Date;
  capabilities: StageLifecycleStatus["capabilities"];
}

/** Build-owned projection of provider and source truth. The client must never derive commit identity. */
export function composeStageLifecycleStatus(input: ComposeStageLifecycleStatusInput): StageLifecycleStatus {
  const observedAt = (input.observedAt ?? new Date()).toISOString();
  const latest = input.deployments[0] ?? null;
  const latestStatus = latest?.status?.toUpperCase() ?? null;
  const active = input.deployments.find((deployment) => ACTIVE_STATUSES.has(deployment.status?.toUpperCase() ?? "")) ?? null;
  const activeCommitSha = extractDeploymentMeta(active?.meta).commitHash ?? null;
  const targetCommitSha = input.targetCommitSha?.trim() || null;
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

  if (ACTIVE_STATUSES.has(latestStatus)) {
    const latestCommitSha = extractDeploymentMeta(latest.meta).commitHash ?? null;
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
      state: latestCommitSha === targetCommitSha ? "ready" : "syncing",
      activeCommitSha: latestCommitSha,
      targetCommitSha,
      providerDeploymentId,
      providerStatus: latestStatus,
      observedAt,
      reason: latestCommitSha === targetCommitSha ? null : "The bound source branch is ahead of the active deployment.",
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
