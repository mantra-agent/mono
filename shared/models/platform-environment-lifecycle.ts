export const STAGE_LIFECYCLE_STATES = [
  "ready",
  "syncing",
  "restarting",
  "rebuilding",
  "degraded",
  "failed",
] as const;

export type StageLifecycleState = typeof STAGE_LIFECYCLE_STATES[number];

export interface StageLifecycleStatus {
  state: StageLifecycleState;
  activeCommitSha: string | null;
  targetCommitSha: string | null;
  providerDeploymentId: string | null;
  providerStatus: string | null;
  observedAt: string;
  reason: string | null;
}
