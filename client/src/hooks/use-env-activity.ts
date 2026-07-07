import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { NavDotLevel } from "@/components/nav-dot";
import { statusFamily } from "@/components/build-status-panel";
import { usePublishSummary } from "@/components/dev-publish-tab";

interface RailwayStatus {
  configured?: boolean;
  deployment?: { id?: string; status?: string };
}

interface MobileBuildLogStatus {
  run?: { runId: string; status: "running" | "success" | "failed"; startedAt?: string; profile?: string; platform?: string } | null;
}

interface ExpoBuildSnapshot {
  id?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  buildProfile?: string;
  profile?: string;
  platform?: string;
}

const TAB_SEEN_KEY = "xyz-build-tab-seen";


function isExpoBuildActive(status: string | undefined): boolean {
  return ["NEW", "IN_QUEUE", "IN_PROGRESS", "PENDING_CANCEL"].includes((status || "").toUpperCase());
}

function isExpoBuildFailed(status: string | undefined): boolean {
  return ["ERRORED", "CANCELED"].includes((status || "").toUpperCase());
}

function sortRemoteBuilds(builds: ExpoBuildSnapshot[] | undefined): ExpoBuildSnapshot[] {
  return [...(builds || [])].sort((a, b) => {
    const aTime = Date.parse(a.createdAt || a.updatedAt || "");
    const bTime = Date.parse(b.createdAt || b.updatedAt || "");
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
}

function getLatestRemoteBuild(builds: ExpoBuildSnapshot[] | undefined): ExpoBuildSnapshot | null {
  return sortRemoteBuilds(builds)[0] || null;
}

function getRelevantRemoteBuild(builds: ExpoBuildSnapshot[] | undefined, run: MobileBuildLogStatus["run"]): ExpoBuildSnapshot | null {
  const sortedBuilds = sortRemoteBuilds(builds);
  const latestBuild = sortedBuilds[0] || null;
  if (!run) return latestBuild;

  const startedAtMs = Date.parse(run.startedAt || "");
  if (!Number.isFinite(startedAtMs)) return latestBuild;
  const profile = run.profile?.toLowerCase();
  const platform = run.platform?.toLowerCase();
  return sortedBuilds.find((build) => {
    const createdAtMs = Date.parse(build.createdAt || build.updatedAt || "");
    if (!Number.isFinite(createdAtMs) || createdAtMs < startedAtMs - 30_000) return false;
    const buildProfile = (build.buildProfile || build.profile || "").toLowerCase();
    const buildPlatform = (build.platform || "").toLowerCase();
    if (profile && buildProfile && buildProfile !== profile) return false;
    if (platform && buildPlatform && buildPlatform !== platform) return false;
    return true;
  }) || latestBuild;
}

function deploymentLevel(status: string | undefined): NavDotLevel | null {
  const family = statusFamily(status);
  if (family === "deploying") return "active";
  if (family === "failed") return "error";
  if (family === "running") return "unread";
  return null;
}

function readTabSeen(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(TAB_SEEN_KEY) || "{}"); }
  catch { return {}; }
}

/** Returns the highest-priority NavDotLevel across Build tabs. */
export function useEnvActivity(): NavDotLevel | null {
  const { data: devStatus } = useQuery<RailwayStatus>({
    queryKey: ["/api/railway/dev/status"],
    refetchInterval: 15_000,
    retry: false,
  });
  const { data: prodStatus } = useQuery<RailwayStatus>({
    queryKey: ["/api/railway/prod/status"],
    refetchInterval: 15_000,
    retry: false,
  });
  const { data: mobileBuildLog } = useQuery<MobileBuildLogStatus>({
    queryKey: ["/api/integrations/expo/build-log"],
    refetchInterval: (query) => query.state.data?.run?.status === "running" ? 1000 : 30_000,
    retry: false,
  });
  const { data: mobileBuilds } = useQuery<{ builds: ExpoBuildSnapshot[] }>({
    queryKey: ["/api/integrations/expo/builds"],
    refetchInterval: (query) => isExpoBuildActive(getLatestRemoteBuild(query.state.data?.builds)?.status) ? 5000 : 30_000,
    retry: false,
  });
  const { data: publishSummary } = usePublishSummary();

  const devLevel = devStatus?.configured ? deploymentLevel(devStatus.deployment?.status) : null;
  const prodBaseLevel = prodStatus?.configured ? deploymentLevel(prodStatus.deployment?.status) : null;
  const prodLevel = publishSummary?.run?.status === "running" ? "active" as const : prodBaseLevel;

  const devId = devStatus?.configured ? devStatus.deployment?.id : undefined;
  const prodId = prodStatus?.configured ? prodStatus.deployment?.id : undefined;
  const devFamily = statusFamily(devStatus?.deployment?.status);
  const prodFamily = statusFamily(prodStatus?.deployment?.status);
  const isPublishing = publishSummary?.run?.status === "running";
  const devKey = `dev-${devFamily}-${devId ?? "none"}`;
  const prodKey = `prod-${prodFamily}-${isPublishing ? "publishing" : prodId ?? "none"}`;

  // Use the same per-tab seen state as the Build header tabs. This keeps the
  // sidebar Build indicator aligned with Stage/Publish/Mobile instead of
  // clearing Publish just because some other Build tab was opened.
  const [tabSeen, setTabSeen] = useState(readTabSeen);

  useEffect(() => {
    const syncTabSeen = () => setTabSeen(readTabSeen());
    window.addEventListener("storage", syncTabSeen);
    window.addEventListener("xyz-build-tab-seen", syncTabSeen);
    return () => {
      window.removeEventListener("storage", syncTabSeen);
      window.removeEventListener("xyz-build-tab-seen", syncTabSeen);
    };
  }, []);

  const mobileRun = mobileBuildLog?.run;
  const mobileRemoteBuild = getRelevantRemoteBuild(mobileBuilds?.builds, mobileRun);
  const mobileRemoteStatus = mobileRemoteBuild?.status;
  const mobileActive = mobileRun?.status === "running" || isExpoBuildActive(mobileRemoteStatus);
  const mobileFailed = mobileRun?.status === "failed" || isExpoBuildFailed(mobileRemoteStatus);
  const mobileLevel = mobileActive
    ? "active" as const
    : mobileFailed
      ? "error" as const
      : null;

  // Priority cascade: error > active > unread. Active/error states always show;
  // green success only shows while the corresponding Build tab is green.
  const alwaysVisibleLevels: (NavDotLevel | null)[] = [devLevel, prodLevel, mobileLevel].filter((level) => level !== "unread");
  if (alwaysVisibleLevels.includes("error")) return "error";
  if (alwaysVisibleLevels.includes("active")) return "active";

  const devUnread = devLevel === "unread" && "stage" in tabSeen && tabSeen.stage !== devKey;
  const prodUnread = prodLevel === "unread" && "publish" in tabSeen && tabSeen.publish !== prodKey;

  if (devUnread || prodUnread) return "unread";

  return null;
}
