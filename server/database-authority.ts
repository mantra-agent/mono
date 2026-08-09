export type DatabasePoolWorkload = "general" | "voice" | "auth-session" | "metrics";
export type DedicatedDatabaseWorkload =
  | "watchdog"
  | "brain-export"
  | "brain-preflight"
  | "role-provisioning";
export type DatabaseWorkload = DatabasePoolWorkload | DedicatedDatabaseWorkload;

export interface DatabaseWorkloadDefinition {
  kind: "pool" | "dedicated-client";
  credentialSource: "runtime-primary" | "runtime-metrics" | "authorized-platform-environment";
  attribution: "ordinary-lane" | "workload-local";
  timeoutOwner: "adapter-config" | "caller-cursor-budget";
}

/** Checked-in identity and policy catalog for every PostgreSQL connection path. */
export const DATABASE_WORKLOADS: Record<DatabaseWorkload, DatabaseWorkloadDefinition> = {
  general: {
    kind: "pool",
    credentialSource: "runtime-primary",
    attribution: "ordinary-lane",
    timeoutOwner: "adapter-config",
  },
  voice: {
    kind: "pool",
    credentialSource: "runtime-primary",
    attribution: "ordinary-lane",
    timeoutOwner: "adapter-config",
  },
  "auth-session": {
    kind: "pool",
    credentialSource: "runtime-primary",
    attribution: "workload-local",
    timeoutOwner: "adapter-config",
  },
  metrics: {
    kind: "pool",
    credentialSource: "runtime-metrics",
    attribution: "workload-local",
    timeoutOwner: "adapter-config",
  },
  watchdog: {
    kind: "dedicated-client",
    credentialSource: "runtime-primary",
    attribution: "workload-local",
    timeoutOwner: "adapter-config",
  },
  "brain-export": {
    kind: "dedicated-client",
    credentialSource: "runtime-primary",
    attribution: "workload-local",
    timeoutOwner: "caller-cursor-budget",
  },
  "brain-preflight": {
    kind: "dedicated-client",
    credentialSource: "runtime-primary",
    attribution: "workload-local",
    timeoutOwner: "adapter-config",
  },
  "role-provisioning": {
    kind: "dedicated-client",
    credentialSource: "authorized-platform-environment",
    attribution: "workload-local",
    timeoutOwner: "adapter-config",
  },
};
