import { fileIssueStorage } from "../file-storage/issues";
import { getEnvironmentBuildStatus, type EnvironmentBuildStatus } from "./build-lifecycle-service";

export type EnvironmentHealthState = "healthy" | "unhealthy" | "unknown";
export type EnvironmentHealthSignalKey = "deploy" | "reachability" | "bindings" | "issues" | "jobs";

export type EnvironmentHealthSignal = {
  key: EnvironmentHealthSignalKey;
  state: EnvironmentHealthState;
  residual: string | null;
  href: string | null;
};

export type EnvironmentHealth = {
  state: EnvironmentHealthState;
  residual: string | null;
  signals: EnvironmentHealthSignal[];
};

const SUCCESS_DEPLOY_STATES = new Set(["SUCCESS", "READY", "COMPLETED", "COMPLETE", "SUCCEEDED"]);
const FAILED_DEPLOY_STATES = new Set(["FAILED", "CRASHED", "ERROR", "CANCELED", "CANCELLED"]);

export async function getEnvironmentHealth(environmentId: number): Promise<EnvironmentHealth | null> {
  const status = await getEnvironmentBuildStatus(environmentId);
  if (!status) return null;
  const signals = await Promise.all([
    Promise.resolve(deploySignal(status)),
    Promise.resolve(reachabilitySignal(status)),
    Promise.resolve(bindingsSignal(status)),
    issuesSignal(environmentId),
    Promise.resolve(jobsSignal(status)),
  ]);
  const firstResidual = signals.find((item) => item.state === "unhealthy")
    ?? signals.find((item) => item.state === "unknown");
  return {
    state: signals.some((item) => item.state === "unhealthy")
      ? "unhealthy"
      : signals.some((item) => item.state === "unknown") ? "unknown" : "healthy",
    residual: firstResidual?.residual ?? null,
    signals,
  };
}

function providerStatus(status: EnvironmentBuildStatus): Record<string, unknown> | null {
  return status.providers.railway ?? status.providers.cloudflare_pages ?? status.providers.eas ?? null;
}

function deploySignal(status: EnvironmentBuildStatus): EnvironmentHealthSignal {
  const provider = providerStatus(status);
  const deployment = provider?.deployment && typeof provider.deployment === "object"
    ? provider.deployment as Record<string, unknown>
    : provider?.latestBuild && typeof provider.latestBuild === "object"
      ? provider.latestBuild as Record<string, unknown>
      : null;
  const value = String(deployment?.status ?? "").toUpperCase();
  if (FAILED_DEPLOY_STATES.has(value)) return signal("deploy", "unhealthy", `Latest deploy ${value.toLowerCase()}.`, "#build");
  if (SUCCESS_DEPLOY_STATES.has(value)) return signal("deploy", "healthy");
  if (provider?.degraded === true) return signal("deploy", "unknown", String(provider.reason || "Deploy provider unavailable."), "#build");
  return signal("deploy", "unknown", status.hosting ? "No completed deploy is available." : "No hosting binding.", "#build");
}

function reachabilitySignal(status: EnvironmentBuildStatus): EnvironmentHealthSignal {
  const provider = providerStatus(status);
  if (provider?.urlReachable === true) return signal("reachability", "healthy");
  if (provider?.urlReachable === false) return signal("reachability", "unhealthy", "Configured health URL is not reachable.", "#hosting");
  return signal("reachability", "unknown", "No public health URL is configured.", "#hosting");
}

function bindingsSignal(status: EnvironmentBuildStatus): EnvironmentHealthSignal {
  if (!status.hosting) return signal("bindings", "unknown", "No hosting binding.", "#hosting");
  const hosting = status.hosting;
  const complete = Boolean(hosting.connectionId)
    && (hosting.provider === "cloudflare"
      ? Boolean(hosting.projectId && hosting.projectName)
      : Boolean(hosting.projectId && hosting.serviceId && hosting.providerEnvironmentId));
  if (!complete) return signal("bindings", "unhealthy", "Hosting binding is incomplete.", "#hosting");
  if (!status.source) return signal("bindings", "unknown", "No source binding.", "#source");
  return signal("bindings", "healthy");
}

async function issuesSignal(environmentId: number): Promise<EnvironmentHealthSignal> {
  try {
    const issues = await fileIssueStorage.getIssues({ status: "open", platformEnvironmentId: environmentId });
    const open = issues.filter((issue) => issue.kind !== "reported");
    if (!open.length) return signal("issues", "healthy");
    const first = open[0];
    return signal("issues", "unhealthy", `${open.length} open Issue${open.length === 1 ? "" : "s"}: ${first.title}`, `/issues/${first.id}`);
  } catch {
    return signal("issues", "unknown", "Issues are unavailable.");
  }
}

function jobsSignal(status: EnvironmentBuildStatus): EnvironmentHealthSignal {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const failed = status.workflows.recent.find((item) => {
    if (!item || typeof item !== "object") return false;
    const run = item as Record<string, unknown>;
    const updatedAt = Date.parse(String(run.updatedAt ?? run.createdAt ?? ""));
    return ["failed", "blocked"].includes(String(run.status ?? "")) && Number.isFinite(updatedAt) && updatedAt >= since;
  }) as Record<string, unknown> | undefined;
  if (failed) return signal("jobs", "unhealthy", `Linked job ${String(failed.status)}: ${String(failed.title || failed.id || "workflow")}.`, "#build");
  return signal("jobs", "healthy");
}

function signal(key: EnvironmentHealthSignalKey, state: EnvironmentHealthState, residual: string | null = null, href: string | null = null): EnvironmentHealthSignal {
  return { key, state, residual, href };
}
