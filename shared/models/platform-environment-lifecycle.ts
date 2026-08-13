export const STAGE_LIFECYCLE_STATES = [
  "ready",
  "syncing",
  "restarting",
  "rebuilding",
  "degraded",
  "failed",
] as const;

export type StageLifecycleState = typeof STAGE_LIFECYCLE_STATES[number];

export type EnvironmentRuntimeMode = "immutable_artifact" | "warm_workspace";
export type StageLifecycleAction = "enable_warm_stage" | "sync_latest" | "restart_stage" | "full_rebuild";

export interface StageLifecycleCapabilities {
  runtimeMode: EnvironmentRuntimeMode;
  syncOnPush: boolean;
  dependencyPolicy: "rebuild_on_lockfile_change";
  fullRebuildProvider: "railway" | "eas" | "cloudflare_pages" | "manual";
  actions: StageLifecycleAction[];
}

export interface StageLifecycleStatus {
  state: StageLifecycleState;
  activeCommitSha: string | null;
  targetCommitSha: string | null;
  providerDeploymentId: string | null;
  providerStatus: string | null;
  observedAt: string;
  reason: string | null;
  capabilities: StageLifecycleCapabilities;
}
