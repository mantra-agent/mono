import { useEffect, useState } from "react";
import { statusFamily } from "@/components/build-status-panel";

const STORAGE_KEY = "mantra-platform-environment-build-seen";
const CHANGE_EVENT = "mantra-environment-build-seen";

export interface EnvironmentDeploymentSnapshot {
  id?: string;
  status?: string | null;
}

export interface EnvironmentBuildSnapshot {
  providers?: {
    railway?: { deployment?: EnvironmentDeploymentSnapshot | null };
    cloudflare_pages?: { deployment?: EnvironmentDeploymentSnapshot | null };
  };
  activity?: { state?: "building" | "idle" };
}

function readSeenBuilds(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function latestLiveDeploymentId(snapshot: EnvironmentBuildSnapshot | undefined): string | null {
  const deployment = snapshot?.providers?.railway?.deployment ?? snapshot?.providers?.cloudflare_pages?.deployment;
  return deployment?.id && statusFamily(deployment.status) === "running" ? deployment.id : null;
}

export function markEnvironmentBuildSeen(environmentId: number, snapshot: EnvironmentBuildSnapshot | undefined): void {
  const deploymentId = latestLiveDeploymentId(snapshot);
  if (!deploymentId) return;
  const seen = readSeenBuilds();
  if (seen[String(environmentId)] === deploymentId) return;
  seen[String(environmentId)] = deploymentId;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seen));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function useEnvironmentBuildSeenState(): Record<string, string> {
  const [seen, setSeen] = useState(readSeenBuilds);

  useEffect(() => {
    const sync = () => setSeen(readSeenBuilds());
    window.addEventListener("storage", sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  return seen;
}
