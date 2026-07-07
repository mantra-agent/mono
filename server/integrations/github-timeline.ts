import { gh, parseRepoSlug, GitHubError, type RepoRef } from "./github-pr";
import {
  fetchDeploymentsForEnvironment,
  extractDeploymentMeta,
  getProdConfig,
  isProdConfigComplete,
  type RailwayDeployment,
} from "./railway/client";
import { createLogger } from "../log";

const log = createLogger("VersionTimeline");

// ── Types ──────────────────────────────────────────────────────────────

export interface TimelineCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string | null;
  htmlUrl: string;
  timestamp: string;
}

export interface TimelinePR {
  number: number;
  title: string;
  author: string | null;
  htmlUrl: string;
  mergedAt: string;
  mergeCommitSha: string | null;
  commits: TimelineCommit[];
}

export interface TimelineDeploy {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  durationMs: number | null;
  commitHash: string | null;
  commitMessage: string | null;
  commitAuthor: string | null;
  branch: string | null;
  prs: TimelinePR[];
  orphanCommits: TimelineCommit[];
}

export interface TimelineResponse {
  pending: TimelinePR[];
  deployments: TimelineDeploy[];
  githubConnected: boolean;
}

// ── GitHub API types (raw) ─────────────────────────────────────────────

interface GHCommitRaw {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string | null; date: string } | null;
    committer: { date: string } | null;
  };
  author: { login: string } | null;
}

interface GHPullRaw {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string };
  user: { login: string } | null;
}

// ── Cache ──────────────────────────────────────────────────────────────

interface TimelineCache {
  data: TimelineResponse;
  fetchedAt: number;
}

let cache: TimelineCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Helpers ────────────────────────────────────────────────────────────

function repoRefFromUrl(): RepoRef | null {
  const url = process.env.GITHUB_REPO_URL;
  if (!url) return null;
  // Handle full URLs: https://github.com/owner/repo(.git)
  try {
    const parsed = new URL(url);
    const slug = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return parseRepoSlug(slug);
  } catch {
    // Try as bare slug: owner/repo
    return parseRepoSlug(url);
  }
}

// ── Fetch functions ────────────────────────────────────────────────────

async function fetchGitHubCommits(ref: RepoRef, limit = 100): Promise<TimelineCommit[]> {
  const raw = await gh<GHCommitRaw[]>(
    "GET",
    `/repos/${ref.owner}/${ref.repo}/commits?sha=main&per_page=${limit}`
  );
  return raw.map((c) => ({
    sha: c.sha,
    shortSha: c.sha.slice(0, 7),
    message: c.commit.message.split("\n")[0],
    author: c.author?.login ?? c.commit.author?.name ?? null,
    htmlUrl: c.html_url,
    timestamp: c.commit.committer?.date ?? c.commit.author?.date ?? "",
  }));
}

async function fetchMergedPRs(ref: RepoRef, limit = 100): Promise<TimelinePR[]> {
  const raw = await gh<GHPullRaw[]>(
    "GET",
    `/repos/${ref.owner}/${ref.repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=${limit}`
  );
  return raw
    .filter((pr) => pr.merged_at !== null)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? null,
      htmlUrl: pr.html_url,
      mergedAt: pr.merged_at!,
      mergeCommitSha: pr.merge_commit_sha,
      commits: [],
    }));
}

async function fetchRailwayDeploys(): Promise<RailwayDeployment[]> {
  try {
    const cfg = await getProdConfig();
    if (!isProdConfigComplete(cfg)) {
      log.debug("Railway prod config incomplete, skipping deploy fetch");
      return [];
    }
    return await fetchDeploymentsForEnvironment(
      cfg.projectId!,
      cfg.serviceId!,
      cfg.environmentId!,
      50
    );
  } catch (err: any) {
    log.warn(`Railway deploy fetch failed: ${err?.message || err}`);
    return [];
  }
}

// ── Merge logic ────────────────────────────────────────────────────────

function mergeTimeline(
  rawDeploys: RailwayDeployment[],
  prs: TimelinePR[],
  commits: TimelineCommit[],
  githubConnected: boolean
): TimelineResponse {
  // Sort deploys by createdAt desc
  const sortedDeploys = [...rawDeploys]
    .filter((d) => d.createdAt)
    .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());

  // Build deploy timeline entries
  const deployments: TimelineDeploy[] = sortedDeploys.map((d) => {
    const meta = extractDeploymentMeta(d.meta);
    const createdMs = new Date(d.createdAt!).getTime();
    const updatedMs = d.updatedAt ? new Date(d.updatedAt).getTime() : null;
    return {
      id: d.id,
      status: d.status,
      createdAt: d.createdAt!,
      updatedAt: d.updatedAt ?? null,
      durationMs: updatedMs && updatedMs > createdMs ? updatedMs - createdMs : null,
      commitHash: meta.commitHash ?? null,
      commitMessage: meta.commitMessage ?? null,
      commitAuthor: meta.commitAuthor ?? null,
      branch: meta.branch ?? null,
      prs: [],
      orphanCommits: [],
    };
  });

  if (!githubConnected || deployments.length === 0) {
    return { pending: [], deployments, githubConnected };
  }

  // Assign PRs to deploy windows by timestamp
  // Deploy window: from previous deploy's createdAt to this deploy's createdAt
  const assignedPRs = new Set<number>();
  const pending: TimelinePR[] = [];

  // Sort PRs by mergedAt desc
  const sortedPRs = [...prs].sort(
    (a, b) => new Date(b.mergedAt).getTime() - new Date(a.mergedAt).getTime()
  );

  // Build a commit index by sha for assigning commits to PRs
  const commitBySha = new Map<string, TimelineCommit>();
  for (const c of commits) {
    commitBySha.set(c.sha, c);
  }

  // For each PR, assign commits that match the merge commit sha
  // (squash merge: merge_commit_sha is the single squashed commit)
  for (const pr of sortedPRs) {
    if (pr.mergeCommitSha) {
      const mergeCommit = commitBySha.get(pr.mergeCommitSha);
      if (mergeCommit) {
        pr.commits = [mergeCommit];
      }
    }
  }

  // Assign PRs to deploy windows
  for (const pr of sortedPRs) {
    const prMergedAt = new Date(pr.mergedAt).getTime();

    // Check if this PR merged after the latest deploy
    if (deployments.length > 0) {
      const latestDeployAt = new Date(deployments[0].createdAt).getTime();
      if (prMergedAt > latestDeployAt) {
        pending.push(pr);
        assignedPRs.add(pr.number);
        continue;
      }
    }

    // Find which deploy window this PR belongs to
    for (let i = 0; i < deployments.length; i++) {
      const deployAt = new Date(deployments[i].createdAt).getTime();
      const prevDeployAt =
        i + 1 < deployments.length
          ? new Date(deployments[i + 1].createdAt).getTime()
          : 0;

      if (prMergedAt <= deployAt && prMergedAt > prevDeployAt) {
        deployments[i].prs.push(pr);
        assignedPRs.add(pr.number);
        break;
      }
    }
  }

  // Find orphan commits (not associated with any PR's merge_commit_sha)
  const prMergeCommitShas = new Set(
    prs.filter((p) => p.mergeCommitSha).map((p) => p.mergeCommitSha!)
  );

  const orphanCommits = commits.filter((c) => !prMergeCommitShas.has(c.sha));

  // Assign orphan commits to deploy windows by timestamp
  for (const commit of orphanCommits) {
    const commitAt = new Date(commit.timestamp).getTime();
    for (let i = 0; i < deployments.length; i++) {
      const deployAt = new Date(deployments[i].createdAt).getTime();
      const prevDeployAt =
        i + 1 < deployments.length
          ? new Date(deployments[i + 1].createdAt).getTime()
          : 0;

      if (commitAt <= deployAt && commitAt > prevDeployAt) {
        deployments[i].orphanCommits.push(commit);
        break;
      }
    }
  }

  return { pending, deployments, githubConnected };
}

// ── Public API ─────────────────────────────────────────────────────────

export async function fetchVersionTimeline(): Promise<TimelineResponse> {
  // Check cache
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  const repoRef = repoRefFromUrl();
  let githubConnected = !!repoRef;
  let prs: TimelinePR[] = [];
  let commits: TimelineCommit[] = [];

  // Fetch all sources in parallel
  const [railwayDeploys, ghResult] = await Promise.all([
    fetchRailwayDeploys(),
    repoRef
      ? Promise.all([
          fetchGitHubCommits(repoRef).catch((err) => {
            log.warn(`GitHub commits fetch failed: ${err?.message || err}`);
            githubConnected = false;
            return [] as TimelineCommit[];
          }),
          fetchMergedPRs(repoRef).catch((err) => {
            log.warn(`GitHub PRs fetch failed: ${err?.message || err}`);
            githubConnected = false;
            return [] as TimelinePR[];
          }),
        ])
      : Promise.resolve([[] as TimelineCommit[], [] as TimelinePR[]] as const),
  ]);

  if (repoRef && ghResult) {
    [commits, prs] = ghResult;
  }

  const result = mergeTimeline(railwayDeploys, prs, commits, githubConnected);

  // Update cache
  cache = { data: result, fetchedAt: Date.now() };

  return result;
}
