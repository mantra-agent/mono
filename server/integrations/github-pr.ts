import { and, eq } from "drizzle-orm";
import { getGitHubAccessToken } from "../github-auth";
import { createLogger } from "../log";
import { db } from "../db";
import { getProviderCredential } from "../provider-credential-store";
import { environmentSourceBindings, providerConnections } from "@shared/models/platforms";



const log = createLogger("GitHubPR");

const GH_API = "https://api.github.com";
const GH_HEADERS_BASE = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PRSummary {
  number: number;
  htmlUrl: string;
  title: string;
  body: string | null;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
  mergeableState: string | null;
  draft: boolean;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string | null;
  authorLogin: string | null;
  htmlUrl: string;
}

/**
 * Wire-format DTO for a commit, used by `/api/railway/publish/*` responses
 * and embedded inside `PublishRun.summary.commits`. Fields are flattened to
 * what the Publish tab actually renders: a single display-name `author` and
 * a single `url` link to the GitHub commit page. Mirrored on the client in
 * `client/src/components/dev-publish-tab.tsx` (CommitSummary).
 */
export interface PublishCommit {
  sha: string;
  shortSha: string;
  message: string;
  /** Display name — prefers GitHub login (so "@octocat" works), falls back to git author name. */
  author: string | null;
  /** GitHub commit page URL. */
  url: string;
}

/** Convert internal CommitSummary → external PublishCommit DTO. */
export function toPublishCommit(c: CommitSummary): PublishCommit {
  return {
    sha: c.sha,
    shortSha: c.shortSha,
    message: c.message,
    author: c.authorLogin ?? c.authorName,
    url: c.htmlUrl,
  };
}

export interface CompareResult {
  base: string;
  head: string;
  status: "ahead" | "behind" | "identical" | "diverged";
  aheadBy: number;
  behindBy: number;
  commits: CommitSummary[];
  htmlUrl: string;
}

export class GitHubError extends Error {
  status: number;
  details?: unknown;
  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.details = details;
  }
}

/**
 * Thrown by `fastForwardRef` when GitHub refuses the ref update because the
 * target SHA is not a fast-forward of the branch's current HEAD (i.e. live
 * has commits dev doesn't). Caught by the publish flow to show the
 * "live has diverged — click Reconcile" failure card instead of force-
 * pushing over those commits.
 */
export class NotFastForwardError extends Error {
  constructor(message = "Update is not a fast forward.") {
    super(message);
    this.name = "NotFastForwardError";
  }
}

/**
 * GitHub API errors are returned as JSON like `{ "message": "...", ... }`.
 * Narrow safely so we can surface the human-readable string without `any`.
 */
function extractGitHubErrorMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = (parsed as { message?: unknown }).message;
  return typeof candidate === "string" ? candidate : null;
}

function repoFromApiPath(path: string): RepoRef | null {
  const match = path.match(/^\/repos\/([^/]+)\/([^/?#]+)/);
  if (!match) return null;
  return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]) };
}

async function getGitHubAccessTokenForPath(path: string): Promise<string> {
  const repo = repoFromApiPath(path);
  if (repo) {
    try {
      const rows = await db
        .select({
          connectionId: providerConnections.id,
          credentialRef: providerConnections.credentialRef,
        })
        .from(environmentSourceBindings)
        .innerJoin(providerConnections, eq(providerConnections.id, environmentSourceBindings.connectionId))
        .where(and(
          eq(environmentSourceBindings.provider, "github"),
          eq(environmentSourceBindings.owner, repo.owner),
          eq(environmentSourceBindings.repo, repo.repo),
          eq(providerConnections.provider, "github"),
          eq(providerConnections.status, "active"),
        ));

      for (const row of rows) {
        const token = row.credentialRef ? await getProviderCredential(row.credentialRef) : null;
        if (token) {
          log.info(`Using platform GitHub credential for ${repo.owner}/${repo.repo} via connection ${row.connectionId}`);
          return token;
        }
      }
    } catch (err) {
      log.warn(`Platform GitHub credential lookup failed for ${repo.owner}/${repo.repo}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return getGitHubAccessToken();
}

export async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getGitHubAccessTokenForPath(path);
  const res = await fetch(`${GH_API}${path}`, {
    method,
    headers: {
      ...GH_HEADERS_BASE,
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg = extractGitHubErrorMessage(parsed) ?? `GitHub ${method} ${path} failed (HTTP ${res.status})`;
    throw new GitHubError(msg, res.status, parsed);
  }
  return parsed as T;
}

function shortSha(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha;
}

export function parseRepoSlug(repo: string | null | undefined): RepoRef | null {
  if (!repo) return null;
  const m = repo.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * Compare two refs (branches/SHAs) on a repo. Returns which is ahead, by how
 * many commits, and the commit list (head ∋ base).
 */
export async function compareRefs(
  ref: RepoRef,
  base: string,
  head: string
): Promise<CompareResult> {
  const data = await gh<{
    status: "ahead" | "behind" | "identical" | "diverged";
    ahead_by: number;
    behind_by: number;
    html_url: string;
    commits: Array<{
      sha: string;
      html_url: string;
      commit: { message: string; author: { name: string | null } | null };
      author: { login: string | null } | null;
    }>;
  }>("GET", `/repos/${ref.owner}/${ref.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  return {
    base,
    head,
    status: data.status,
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
    htmlUrl: data.html_url,
    commits: data.commits.map((c) => ({
      sha: c.sha,
      shortSha: shortSha(c.sha),
      message: c.commit.message.split("\n")[0],
      authorName: c.commit.author?.name ?? null,
      authorLogin: c.author?.login ?? null,
      htmlUrl: c.html_url,
    })),
  };
}

/**
 * Look up the head ref for a branch (resolves to a commit SHA + commit message).
 * Returns null if the branch doesn't exist.
 */
export async function getBranchHead(
  ref: RepoRef,
  branch: string
): Promise<{ sha: string; message: string } | null> {
  try {
    const data = await gh<{
      commit: { sha: string; commit: { message: string } };
    }>("GET", `/repos/${ref.owner}/${ref.repo}/branches/${encodeURIComponent(branch)}`);
    return {
      sha: data.commit.sha,
      message: data.commit.commit.message.split("\n")[0],
    };
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

export async function getRepositoryFile(
  ref: RepoRef,
  path: string,
  branch: string,
): Promise<{ content: string; sha: string } | null> {
  try {
    const data = await gh<{ content: string; encoding: string; sha: string }>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
    );
    if (data.encoding !== "base64") throw new Error(`Unsupported GitHub content encoding: ${data.encoding}`);
    return { content: Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8"), sha: data.sha };
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) return null;
    throw err;
  }
}

export async function updateRepositoryFile(
  ref: RepoRef,
  input: {
    path: string;
    branch: string;
    content: string;
    message: string;
    expectedBranchSha: string;
  },
): Promise<{ commitSha: string; contentSha: string }> {
  const branchHead = await getBranchHead(ref, input.branch);
  if (!branchHead || branchHead.sha !== input.expectedBranchSha) {
    throw new Error(`Branch '${input.branch}' moved while preparing release notes. Refresh and publish again.`);
  }
  const existing = await getRepositoryFile(ref, input.path, input.branch);
  const data = await gh<{ content: { sha: string }; commit: { sha: string } }>(
    "PUT",
    `/repos/${ref.owner}/${ref.repo}/contents/${encodeURIComponent(input.path)}`,
    {
      message: input.message,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      branch: input.branch,
      ...(existing ? { sha: existing.sha } : {}),
    },
  );
  log.info(`Updated ${input.path} on ${input.branch} at ${data.commit.sha.slice(0, 7)}`);
  return { commitSha: data.commit.sha, contentSha: data.content.sha };
}

/**
 * Find an existing open PR with the given head and base. Returns null if none
 * is open (so callers can create a new one).
 */
export async function findOpenPR(
  ref: RepoRef,
  head: string,
  base: string
): Promise<PRSummary | null> {
  // GitHub's PR list expects head as `owner:branch` for cross-repo, but
  // `branch` works for same-repo PRs which is the only case here.
  const data = await gh<
    Array<{
      number: number;
      html_url: string;
      title: string;
      body: string | null;
      head: { ref: string };
      base: { ref: string };
      state: "open" | "closed";
      merged_at: string | null;
      mergeable_state: string | null;
      draft: boolean;
    }>
  >(
    "GET",
    `/repos/${ref.owner}/${ref.repo}/pulls?state=open&head=${encodeURIComponent(
      `${ref.owner}:${head}`
    )}&base=${encodeURIComponent(base)}&per_page=5`
  );
  const match = data[0];
  if (!match) return null;
  return {
    number: match.number,
    htmlUrl: match.html_url,
    title: match.title,
    body: match.body,
    head: match.head.ref,
    base: match.base.ref,
    state: match.state,
    merged: !!match.merged_at,
    mergeableState: match.mergeable_state,
    draft: match.draft,
  };
}

/** Fetch a single PR by number. */
export async function getPR(ref: RepoRef, prNumber: number): Promise<PRSummary> {
  const data = await gh<{
    number: number;
    html_url: string;
    title: string;
    body: string | null;
    head: { ref: string };
    base: { ref: string };
    state: "open" | "closed";
    merged: boolean;
    mergeable_state: string | null;
    draft: boolean;
  }>("GET", `/repos/${ref.owner}/${ref.repo}/pulls/${prNumber}`);
  return {
    number: data.number,
    htmlUrl: data.html_url,
    title: data.title,
    body: data.body,
    head: data.head.ref,
    base: data.base.ref,
    state: data.state,
    merged: data.merged,
    mergeableState: data.mergeable_state,
    draft: data.draft,
  };
}

/** Create a PR; the caller is expected to pass an already-formatted title/body. */
export async function createPR(
  ref: RepoRef,
  input: { title: string; head: string; base: string; body?: string; draft?: boolean }
): Promise<PRSummary> {
  const data = await gh<{
    number: number;
    html_url: string;
    title: string;
    body: string | null;
    head: { ref: string };
    base: { ref: string };
    state: "open" | "closed";
    mergeable_state: string | null;
    draft: boolean;
  }>("POST", `/repos/${ref.owner}/${ref.repo}/pulls`, {
    title: input.title,
    head: input.head,
    base: input.base,
    body: input.body,
    draft: !!input.draft,
  });
  log.log(`Created PR #${data.number} ${input.head} → ${input.base}`);
  return {
    number: data.number,
    htmlUrl: data.html_url,
    title: data.title,
    body: data.body,
    head: data.head.ref,
    base: data.base.ref,
    state: data.state,
    merged: false,
    mergeableState: data.mergeable_state,
    draft: data.draft,
  };
}

export interface PRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blobUrl: string | null;
}

/**
 * List the files touched by a PR. Used by the publish-tab dirty-merge
 * diagnosis to show *which* paths the user will need to look at when
 * reconciling drift between live and dev. GitHub doesn't expose per-file
 * "is conflicting" flags via REST, but the changed-files list is the same
 * surface the Files Changed UI shows for a dirty PR, so it's what
 * operators actually need to scan. Capped at 100 (GitHub's max page) — if
 * a PR has more than that we surface the truncation explicitly.
 */
export async function listPRFiles(
  ref: RepoRef,
  prNumber: number,
  limit = 100
): Promise<PRFile[]> {
  const data = await gh<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      blob_url: string | null;
    }>
  >(
    "GET",
    `/repos/${ref.owner}/${ref.repo}/pulls/${prNumber}/files?per_page=${Math.max(1, Math.min(100, limit))}`
  );
  return data.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    blobUrl: f.blob_url,
  }));
}

export interface MergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

/** Squash-merge a PR by default. */
export async function mergePR(
  ref: RepoRef,
  prNumber: number,
  opts?: { merge_method?: "merge" | "squash" | "rebase"; commit_title?: string; commit_message?: string }
): Promise<MergeResult> {
  const data = await gh<{ sha: string; merged: boolean; message: string }>(
    "PUT",
    `/repos/${ref.owner}/${ref.repo}/pulls/${prNumber}/merge`,
    {
      merge_method: opts?.merge_method || "squash",
      commit_title: opts?.commit_title,
      commit_message: opts?.commit_message,
    }
  );
  log.log(`Merged PR #${prNumber}: ${data.sha}`);
  return data;
}

/**
 * Update a branch ref to point at `sha` via GitHub's git data API.
 * Calls `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}`. By default
 * `force: true` — the publish flow uses this to make `live` always match
 * `dev`'s HEAD, even when `live` has drift commits that aren't on `dev`
 * (force-push behavior). A 422 "not a fast forward" is still translated
 * into a typed `NotFastForwardError` for callers that opt into
 * `{ force: false }` and want to detect divergence explicitly.
 */
export async function fastForwardRef(
  ref: RepoRef,
  branch: string,
  sha: string,
  opts?: { force?: boolean }
): Promise<{ sha: string }> {
  const force = opts?.force ?? true;
  try {
    const data = await gh<{ object: { sha: string } }>(
      "PATCH",
      `/repos/${ref.owner}/${ref.repo}/git/refs/heads/${encodeURIComponent(branch)}`,
      { sha, force }
    );
    log.log(`${force ? "Force-updated" : "Fast-forwarded"} ${branch} → ${sha.slice(0, 7)}`);
    return { sha: data.object.sha };
  } catch (err) {
    if (
      err instanceof GitHubError &&
      err.status === 422 &&
      /not a fast forward/i.test(err.message)
    ) {
      throw new NotFastForwardError(err.message);
    }
    throw err;
  }
}

/**
 * Close a PR (without merging) and optionally leave a comment explaining
 * why. Used by the publish flow to clean up stale dev → live PRs left
 * over from the old squash-merge flow once we switch to direct
 * fast-forward.
 */
export async function closePR(
  ref: RepoRef,
  prNumber: number,
  opts?: { comment?: string }
): Promise<void> {
  if (opts?.comment) {
    try {
      await gh<unknown>(
        "POST",
        `/repos/${ref.owner}/${ref.repo}/issues/${prNumber}/comments`,
        { body: opts.comment }
      );
    } catch (err) {
      log.warn(
        `Failed to comment on PR #${prNumber} before close: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  await gh<unknown>(
    "PATCH",
    `/repos/${ref.owner}/${ref.repo}/pulls/${prNumber}`,
    { state: "closed" }
  );
  log.log(`Closed PR #${prNumber}`);
}

/** Helper: format a list of commits into a markdown PR body. */
export function formatPRBody(commits: CommitSummary[], opts?: { header?: string; footer?: string }): string {
  const lines: string[] = [];
  if (opts?.header) {
    lines.push(opts.header.trim(), "");
  }
  if (commits.length > 0) {
    lines.push(`### ${commits.length} commit${commits.length === 1 ? "" : "s"}`);
    for (const c of commits) {
      const author = c.authorLogin ? `@${c.authorLogin}` : c.authorName || "unknown";
      lines.push(`- \`${c.shortSha}\` ${c.message} — ${author}`);
    }
  }
  if (opts?.footer) {
    lines.push("", opts.footer.trim());
  }
  return lines.join("\n");
}

/** Build a sensible PR title from the commits being promoted. */
export function buildPRTitle(commits: CommitSummary[], head: string, base: string): string {
  if (commits.length === 1) {
    return `Promote: ${commits[0].message}`;
  }
  return `Promote ${commits.length} commit${commits.length === 1 ? "" : "s"} from ${head} → ${base}`;
}
