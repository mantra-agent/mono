import { and, gte, lt, sql } from "drizzle-orm";
import { mergedPullRequests } from "@shared/schema";
import { db } from "../db";
import { createLogger } from "../log";
import { getSetting, setSetting } from "../system-settings";
import { resolveGitSource } from "../git-source-resolver";
import { gh, type RepoRef } from "./github-pr";
import { eq } from "drizzle-orm";
import { environmentSourceBindings, providerConnections } from "@shared/models/platforms";

const log = createLogger("MergedPrLedger");

const BACKFILL_SETTING_KEY = "merged_pr_ledger_backfill_v1";
const CATCHUP_INTERVAL_MS = 5 * 60_000;
const SEARCH_PAGE_SIZE = 100;
/** Search API hard-caps at 1000 hits; keep windows under that at ~70 merges/day. */
const BACKFILL_WINDOW_DAYS = 7;
const DASHBOARD_HISTORY_DAYS = 370;
const GH_API = "https://api.github.com";
const GH_HEADERS_BASE = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

export type MergedPrSource = "live" | "backfill" | "catchup";

export interface MergedPrRecordInput {
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  htmlUrl: string;
  mergedAt: Date | string;
  mergeCommitSha: string | null;
  source: MergedPrSource;
}

interface BackfillState {
  status: "pending" | "running" | "complete" | "error";
  /** Exclusive lower bound already covered (ISO date YYYY-MM-DD). */
  cursorDate: string;
  updatedAt: string;
  lastError?: string;
  insertedTotal?: number;
}

interface GhPullDetail {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string } | null;
  base?: { ref?: string };
}

interface GhSearchItem {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  pull_request?: { merged_at?: string | null; url?: string };
  closed_at?: string | null;
}

interface GhSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GhSearchItem[];
}

let catchupTimer: ReturnType<typeof setInterval> | null = null;
let syncInFlight: Promise<void> | null = null;

function normalizeOwnerRepo(owner: string, repo: string): { owner: string; repo: string } {
  return {
    owner: owner.trim().toLowerCase(),
    repo: repo.trim().toLowerCase().replace(/\.git$/i, ""),
  };
}

function asMergedAt(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid mergedAt: ${String(value)}`);
  }
  return date;
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateString(date);
}

function daysAgoUtc(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return utcDateString(date);
}

async function listBoundGitHubRepos(): Promise<RepoRef[]> {
  try {
    const rows = await db
      .select({
        owner: environmentSourceBindings.owner,
        repo: environmentSourceBindings.repo,
      })
      .from(environmentSourceBindings)
      .innerJoin(
        providerConnections,
        eq(providerConnections.id, environmentSourceBindings.connectionId),
      )
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
    return refs;
  } catch (error) {
    log.warn("Failed to list GitHub source bindings for merge ledger", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function resolveRepoToken(ref: RepoRef): Promise<string> {
  const source = await resolveGitSource({
    repoUrl: `https://github.com/${ref.owner}/${ref.repo}.git`,
    matchBranch: false,
  });
  if (!source?.token) {
    throw new Error(`No GitHub credential for ${ref.owner}/${ref.repo}`);
  }
  return source.token;
}

/**
 * Idempotent ledger write. Unique on (owner, repo, number).
 * Live merges win title/author/sha updates; backfill never clobbers richer live rows.
 */
export async function recordMergedPullRequest(input: MergedPrRecordInput): Promise<void> {
  const { owner, repo } = normalizeOwnerRepo(input.owner, input.repo);
  if (!owner || !repo) throw new Error("owner and repo are required");
  if (!Number.isFinite(input.number) || input.number <= 0) {
    throw new Error(`Invalid PR number: ${input.number}`);
  }
  const mergedAt = asMergedAt(input.mergedAt);
  const title = (input.title || `PR #${input.number}`).slice(0, 500);
  const htmlUrl =
    input.htmlUrl?.trim() ||
    `https://github.com/${owner}/${repo}/pull/${input.number}`;

  await db
    .insert(mergedPullRequests)
    .values({
      owner,
      repo,
      number: input.number,
      title,
      author: input.author,
      htmlUrl,
      mergedAt,
      mergeCommitSha: input.mergeCommitSha,
      source: input.source,
    })
    .onConflictDoUpdate({
      target: [
        mergedPullRequests.owner,
        mergedPullRequests.repo,
        mergedPullRequests.number,
      ],
      set: {
        title,
        author: input.author,
        htmlUrl,
        mergedAt,
        mergeCommitSha: input.mergeCommitSha,
        // First writer owns `source`; later revisits only refresh display fields.
      },
    });
}

/** After a successful GitHub merge API call, fetch PR detail and ledger it. Fail-soft. */
export async function recordMergedPullRequestFromGithub(
  ref: RepoRef,
  prNumber: number,
  mergeCommitSha: string | null,
  source: MergedPrSource = "live",
): Promise<void> {
  try {
    const detail = await gh<GhPullDetail>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/pulls/${prNumber}`,
    );
    if (!detail.merged_at) {
      log.warn("Merged PR detail missing merged_at; skipping ledger write", {
        owner: ref.owner,
        repo: ref.repo,
        number: prNumber,
      });
      return;
    }
    await recordMergedPullRequest({
      owner: ref.owner,
      repo: ref.repo,
      number: detail.number,
      title: detail.title,
      author: detail.user?.login ?? null,
      htmlUrl: detail.html_url,
      mergedAt: detail.merged_at,
      mergeCommitSha: mergeCommitSha ?? detail.merge_commit_sha,
      source,
    });
  } catch (error) {
    log.warn("Failed to record merged PR in ledger", {
      owner: ref.owner,
      repo: ref.repo,
      number: prNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Chicago-local day counts for Dashboard CODE heatmap. Pure DB read. */
export async function queryMergedPrSeries(
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const localDate = sql<string>`to_char(${mergedPullRequests.mergedAt} AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      date: localDate,
      value: sql<number>`count(*)::int`,
    })
    .from(mergedPullRequests)
    .where(
      and(
        gte(mergedPullRequests.mergedAt, start),
        lt(mergedPullRequests.mergedAt, end),
      ),
    )
    .groupBy(localDate);
  return new Map(rows.map((row) => [row.date, Number(row.value)]));
}

/** Half-open [start, end) merge count for work metrics. Pure DB read. */
export async function countMergedPrsInRange(start: Date, end: Date): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(mergedPullRequests)
    .where(
      and(
        gte(mergedPullRequests.mergedAt, start),
        lt(mergedPullRequests.mergedAt, end),
      ),
    );
  return Number(row?.value ?? 0);
}

async function readBackfillState(): Promise<BackfillState> {
  const existing = await getSetting<BackfillState>(BACKFILL_SETTING_KEY);
  if (
    existing &&
    typeof existing === "object" &&
    typeof existing.cursorDate === "string" &&
    typeof existing.status === "string"
  ) {
    return existing;
  }
  return {
    status: "pending",
    cursorDate: daysAgoUtc(DASHBOARD_HISTORY_DAYS),
    updatedAt: new Date().toISOString(),
    insertedTotal: 0,
  };
}

async function writeBackfillState(state: BackfillState): Promise<void> {
  await setSetting(BACKFILL_SETTING_KEY, {
    ...state,
    updatedAt: new Date().toISOString(),
  } satisfies BackfillState);
}

async function githubSearch(
  token: string,
  query: string,
  page: number,
): Promise<GhSearchResponse> {
  const url = new URL(`${GH_API}/search/issues`);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(SEARCH_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "created");
  url.searchParams.set("order", "asc");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      ...GH_HEADERS_BASE,
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const message =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { message?: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : `GitHub search failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  return parsed as GhSearchResponse;
}

async function ingestSearchWindow(
  ref: RepoRef,
  token: string,
  fromDate: string,
  toDateInclusive: string,
  source: MergedPrSource,
): Promise<number> {
  const query = `repo:${ref.owner}/${ref.repo} is:pr is:merged merged:${fromDate}..${toDateInclusive}`;
  let page = 1;
  let inserted = 0;
  // Search hard-caps at 1000 results (10 pages).
  while (page <= 10) {
    const result = await githubSearch(token, query, page);
    if (result.items.length === 0) break;
    for (const item of result.items) {
      const mergedAt = item.pull_request?.merged_at ?? item.closed_at;
      if (!mergedAt) continue;
      await recordMergedPullRequest({
        owner: ref.owner,
        repo: ref.repo,
        number: item.number,
        title: item.title,
        author: item.user?.login ?? null,
        htmlUrl: item.html_url,
        mergedAt,
        mergeCommitSha: null,
        source,
      });
      inserted += 1;
    }
    if (result.items.length < SEARCH_PAGE_SIZE) break;
    if (page * SEARCH_PAGE_SIZE >= Math.min(result.total_count, 1000)) break;
    page += 1;
  }
  return inserted;
}

async function runCatchupOnce(): Promise<void> {
  const repos = await listBoundGitHubRepos();
  if (repos.length === 0) return;
  const fromDate = daysAgoUtc(3);
  const toDate = utcDateString(new Date());
  for (const ref of repos) {
    try {
      const token = await resolveRepoToken(ref);
      const inserted = await ingestSearchWindow(ref, token, fromDate, toDate, "catchup");
      if (inserted > 0) {
        log.debug("Merge ledger catch-up window ingested", {
          owner: ref.owner,
          repo: ref.repo,
          fromDate,
          toDate,
          inserted,
        });
      }
    } catch (error) {
      log.warn("Merge ledger catch-up failed for repo", {
        owner: ref.owner,
        repo: ref.repo,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runBackfillStep(): Promise<boolean> {
  const state = await readBackfillState();
  if (state.status === "complete") return true;

  const today = utcDateString(new Date());
  if (state.cursorDate >= today) {
    await writeBackfillState({
      ...state,
      status: "complete",
      cursorDate: today,
    });
    return true;
  }

  const windowEnd = addUtcDays(state.cursorDate, BACKFILL_WINDOW_DAYS - 1);
  const toDate = windowEnd < today ? windowEnd : addUtcDays(today, -1);
  if (toDate < state.cursorDate) {
    await writeBackfillState({
      ...state,
      status: "complete",
      cursorDate: today,
    });
    return true;
  }

  await writeBackfillState({
    ...state,
    status: "running",
  });

  const repos = await listBoundGitHubRepos();
  let inserted = 0;
  for (const ref of repos) {
    const token = await resolveRepoToken(ref);
    inserted += await ingestSearchWindow(
      ref,
      token,
      state.cursorDate,
      toDate,
      "backfill",
    );
  }

  const nextCursor = addUtcDays(toDate, 1);
  const complete = nextCursor >= today;
  await writeBackfillState({
    status: complete ? "complete" : "running",
    cursorDate: complete ? today : nextCursor,
    updatedAt: new Date().toISOString(),
    insertedTotal: (state.insertedTotal ?? 0) + inserted,
  });
  log.info("Merge ledger backfill window complete", {
    fromDate: state.cursorDate,
    toDate,
    inserted,
    nextCursor: complete ? today : nextCursor,
    complete,
  });
  return complete;
}

async function runSyncLoopBody(): Promise<void> {
  try {
    let complete = false;
    // Bounded steps per wake so boot/catch-up never monopolize the event loop.
    for (let step = 0; step < 8; step += 1) {
      complete = await runBackfillStep();
      if (complete) break;
    }
    await runCatchupOnce();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("Merge ledger sync cycle failed", { error: message });
    try {
      const state = await readBackfillState();
      await writeBackfillState({
        ...state,
        status: state.status === "complete" ? "complete" : "error",
        lastError: message,
      });
    } catch {
      // ignore secondary persistence failure
    }
  }
}

function enqueueSync(): void {
  if (syncInFlight) return;
  syncInFlight = runSyncLoopBody().finally(() => {
    syncInFlight = null;
  });
}

/** Start fail-soft background backfill + periodic catch-up. Safe to call once per process. */
export function startMergedPrLedgerSync(): void {
  enqueueSync();
  if (catchupTimer) return;
  catchupTimer = setInterval(() => {
    enqueueSync();
  }, CATCHUP_INTERVAL_MS);
  // Allow the process to exit in tests/shutdown without waiting on the timer.
  if (typeof catchupTimer.unref === "function") catchupTimer.unref();
  log.info("Merge ledger background sync started");
}
