import { eq } from "drizzle-orm";
import { gh, parseRepoSlug, GitHubError, type RepoRef } from "./github-pr";
import {
  extractDeploymentMeta,
  type RailwayDeployment,
} from "./railway/client";
import {
  fetchEnvironmentDeployments,
  resolveRailwayEnvironmentControl,
} from "./railway/environment-control";
import { environmentSourceBindings, providerConnections } from "@shared/models/platforms";
import { db } from "../db";
import { createLogger } from "../log";
import pLimit from "p-limit";
import { TTLCache } from "../utils/ttl-cache";

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
const mergedPrCache = new TTLCache<TimelinePR[]>("MergedPrHistory", CACHE_TTL_MS);
const MERGED_PR_MAX_PAGES = 10;
const MERGED_PR_PAGE_CONCURRENCY = 3;

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
    const control = await resolveRailwayEnvironmentControl(undefined, { allowCurrentRuntime: true });
    return await fetchEnvironmentDeployments(control, 50);
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


/** Resolve all distinct GitHub repos from platform source bindings, falling back to GITHUB_REPO_URL. */
async function allGitHubRepos(): Promise<RepoRef[]> {
  try {
    const rows = await db
      .select({ owner: environmentSourceBindings.owner, repo: environmentSourceBindings.repo })
      .from(environmentSourceBindings)
      .innerJoin(providerConnections, eq(providerConnections.id, environmentSourceBindings.connectionId))
      .where(eq(environmentSourceBindings.provider, "github"));
    const seen = new Set<string>();
    const refs: RepoRef[] = [];
    for (const row of rows) {
      if (!row.owner || !row.repo) continue;
      const key = `${row.owner.toLowerCase()}/${row.repo.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ owner: row.owner, repo: row.repo });
    }
    if (refs.length > 0) return refs;
  } catch (err) {
    log.warn("Failed to query platform source bindings for PR count", { error: err instanceof Error ? err.message : String(err) });
  }
  // Fallback to env var
  const fallback = repoRefFromUrl();
  return fallback ? [fallback] : [];
}

function mergedPrPagePath(ref: RepoRef, page: number): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`;
}

function qualifyingMergedPrs(raw: GHPullRaw[], since: Date): TimelinePR[] {
  return raw.flatMap((pr) => {
    if (!pr.merged_at || new Date(pr.merged_at) < since) return [];
    return [{
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? null,
      htmlUrl: pr.html_url,
      mergedAt: pr.merged_at,
      mergeCommitSha: pr.merge_commit_sha,
      commits: [],
    }];
  });
}

async function fetchMergedPrsForRepo(ref: RepoRef, since: Date): Promise<TimelinePR[]> {
  const firstPage = await gh<GHPullRaw[]>("GET", mergedPrPagePath(ref, 1));
  const results = qualifyingMergedPrs(firstPage, since);
  if (firstPage.length < 100) return results;

  const limit = pLimit(MERGED_PR_PAGE_CONCURRENCY);
  const remainingPages = Array.from(
    { length: MERGED_PR_MAX_PAGES - 1 },
    (_, index) => index + 2,
  );
  const pages = await Promise.all(
    remainingPages.map((page) => limit(() => gh<GHPullRaw[]>("GET", mergedPrPagePath(ref, page)))),
  );
  for (const page of pages) results.push(...qualifyingMergedPrs(page, since));
  return results;
}

async function fetchMergedPrHistory(since: Date): Promise<TimelinePR[]> {
  const repos = await allGitHubRepos();
  if (repos.length === 0) return [];
  const perRepo = await Promise.all(
    repos.map((ref) =>
      fetchMergedPrsForRepo(ref, since).catch((err) => {
        log.warn(`PR fetch failed for ${ref.owner}/${ref.repo}`, { error: err instanceof Error ? err.message : String(err) });
        return [] as TimelinePR[];
      }),
    ),
  );
  const seen = new Set<string>();
  const results: TimelinePR[] = [];
  for (const prs of perRepo) {
    for (const pr of prs) {
      if (seen.has(pr.htmlUrl)) continue;
      seen.add(pr.htmlUrl);
      results.push(pr);
    }
  }
  return results;
}

export async function fetchMergedPrsSince(since: Date): Promise<TimelinePR[]> {
  const cacheKey = since.toISOString();
  return mergedPrCache.getOrFetch(cacheKey, () => fetchMergedPrHistory(since));
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
