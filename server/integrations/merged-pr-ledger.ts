import { and, gte, lt, ne, or, sql, eq } from "drizzle-orm";
import { mergedPullRequests } from "@shared/schema";
import { db } from "../db";
import { createLogger } from "../log";
import { getSetting, setSetting } from "../system-settings";
import { resolveGitCloneSource, resolveGitSource } from "../git-source-resolver";
import { gh, type RepoRef } from "./github-pr";

const log = createLogger("MergedPrLedger");

/** Bump when CODE repo scope or cursor semantics change so ledgers reseed cleanly. */
const BACKFILL_SETTING_KEY = "merged_pr_ledger_backfill_v4";
const CATCHUP_INTERVAL_MS = 5 * 60_000;
const SEARCH_PAGE_SIZE = 100;
const REST_PAGE_SIZE = 100;
/** Recent REST seed pages — enough for the visible heatmap at ~70 merges/day. */
const RECENT_REST_MAX_PAGES = 15;
/**
 * Catch-up is incremental: page closed main PRs only until past the local
 * watermark. A few pages is enough for a 5-minute gap; never re-scrape 14 days.
 */
const CATCHUP_REST_MAX_PAGES = 3;
/** Overlap behind newest local merged_at so a missed live write can heal. */
const CATCHUP_OVERLAP_MS = 2 * 60 * 60_000;
/** Days of history the Dashboard heatmap asks for (+ a little slack). */
const DASHBOARD_HISTORY_DAYS = 370;
/** Search windows stay under the 1000-result hard cap. */
const SEARCH_WINDOW_DAYS = 3;
/** Cold-start / empty-ledger horizon only — not the steady-state catch-up window. */
const CATCHUP_DAYS = 14;
const GH_API = "https://api.github.com";
const GH_HEADERS_BASE = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

export type MergedPrSource = "live" | "backfill" | "catchup" | "seed";

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

/**
 * Walks history newest → oldest.
 * `cursorDate` is the oldest UTC day already fully covered (inclusive).
 * Next step covers (cursorDate - window) .. (cursorDate - 1).
 */
interface BackfillState {
  status: "pending" | "running" | "complete" | "error";
  cursorDate: string;
  recentSeeded: boolean;
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
  updated_at?: string;
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

/**
 * CODE heatmap counts Mantra product shipping only — the canonical Web stage
 * source binding (mantra-agent/mono). Landing-page / personal-site repos must
 * not inflate day totals.
 */
async function resolveCodeHeatmapRepo(): Promise<RepoRef | null> {
  try {
    const source = await resolveGitCloneSource();
    if (!source?.owner || !source?.repo) return null;
    const normalized = normalizeOwnerRepo(source.owner, source.repo);
    return { owner: normalized.owner, repo: normalized.repo };
  } catch (error) {
    log.warn("Failed to resolve CODE heatmap GitHub repo", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function listCodeHeatmapRepos(): Promise<RepoRef[]> {
  const ref = await resolveCodeHeatmapRepo();
  return ref ? [ref] : [];
}

function codeHeatmapRepoPredicate(ref: RepoRef) {
  const { owner, repo } = normalizeOwnerRepo(ref.owner, ref.repo);
  return and(
    eq(mergedPullRequests.owner, owner),
    eq(mergedPullRequests.repo, repo),
  );
}

/** Drop leftover rows from other bound repos (lightway/website/…). */
async function purgeNonCodeHeatmapRows(ref: RepoRef): Promise<number> {
  const { owner, repo } = normalizeOwnerRepo(ref.owner, ref.repo);
  const removed = await db
    .delete(mergedPullRequests)
    .where(
      or(
        ne(mergedPullRequests.owner, owner),
        ne(mergedPullRequests.repo, repo),
      ),
    )
    .returning({ id: mergedPullRequests.id });
  return removed.length;
}

/**
 * v3 upserted onto leftover scrape rows, so empty historical windows never
 * cleared wrong-dated days. A rebuild starts from an empty table.
 */
async function wipeLedgerForRebuild(): Promise<number> {
  const removed = await db
    .delete(mergedPullRequests)
    .returning({ id: mergedPullRequests.id });
  return removed.length;
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
      },
    });
}

/**
 * Batch upsert. Returns how many rows were **new** inserts (not conflict updates).
 * Callers previously treated every upsert as "inserted", which made catch-up look
 * like it rewrote ~1.3k rows every 5 minutes when almost nothing was new.
 */
async function recordMergedPullRequestsBatch(
  inputs: MergedPrRecordInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  let inserted = 0;
  // Keep batches small enough for one statement without blowing parameter limits.
  const chunkSize = 50;
  for (let offset = 0; offset < inputs.length; offset += chunkSize) {
    const chunk = inputs.slice(offset, offset + chunkSize);
    const values = chunk.map((input) => {
      const { owner, repo } = normalizeOwnerRepo(input.owner, input.repo);
      return {
        owner,
        repo,
        number: input.number,
        title: (input.title || `PR #${input.number}`).slice(0, 500),
        author: input.author,
        htmlUrl:
          input.htmlUrl?.trim() ||
          `https://github.com/${owner}/${repo}/pull/${input.number}`,
        mergedAt: asMergedAt(input.mergedAt),
        mergeCommitSha: input.mergeCommitSha,
        source: input.source,
      };
    });
    // xmax = 0 on a freshly inserted row in PostgreSQL; conflict updates are non-zero.
    const returned = await db
      .insert(mergedPullRequests)
      .values(values)
      .onConflictDoUpdate({
        target: [
          mergedPullRequests.owner,
          mergedPullRequests.repo,
          mergedPullRequests.number,
        ],
        set: {
          title: sql`excluded.title`,
          author: sql`excluded.author`,
          htmlUrl: sql`excluded.html_url`,
          mergedAt: sql`excluded.merged_at`,
          mergeCommitSha: sql`excluded.merge_commit_sha`,
        },
      })
      .returning({
        isInsert: sql<boolean>`(xmax = 0)`,
      });
    inserted += returned.filter((row) => row.isInsert).length;
  }
  return inserted;
}

function isGitHubRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /rate limit|secondary rate|abuse.?detection|too many requests/i.test(message);
}

/** Newest merged_at already in the local CODE ledger for this repo, or null if empty. */
async function newestLedgerMergedAt(ref: RepoRef): Promise<Date | null> {
  const [row] = await db
    .select({
      value: sql<Date | string | null>`max(${mergedPullRequests.mergedAt})`,
    })
    .from(mergedPullRequests)
    .where(codeHeatmapRepoPredicate(ref));
  if (row?.value == null) return null;
  const date = row.value instanceof Date ? row.value : new Date(row.value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** After a successful GitHub merge API call, fetch PR detail and ledger it. Fail-soft. */
export async function recordMergedPullRequestFromGithub(
  ref: RepoRef,
  prNumber: number,
  mergeCommitSha: string | null,
  source: MergedPrSource = "live",
): Promise<void> {
  try {
    // CODE ledger is Mantra mono only — ignore merges in other bound repos.
    const codeRef = await resolveCodeHeatmapRepo();
    if (!codeRef) return;
    const normalized = normalizeOwnerRepo(ref.owner, ref.repo);
    if (normalized.owner !== codeRef.owner || normalized.repo !== codeRef.repo) return;

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

/** Chicago-local day counts for Dashboard CODE heatmap. Pure DB read of Mantra mono only. */
export async function queryMergedPrSeries(
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const ref = await resolveCodeHeatmapRepo();
  if (!ref) return new Map();
  const localDate = sql<string>`to_char(${mergedPullRequests.mergedAt} AT TIME ZONE 'America/Chicago', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      date: localDate,
      value: sql<number>`count(*)::int`,
    })
    .from(mergedPullRequests)
    .where(
      and(
        codeHeatmapRepoPredicate(ref),
        gte(mergedPullRequests.mergedAt, start),
        lt(mergedPullRequests.mergedAt, end),
      ),
    )
    .groupBy(localDate);
  return new Map(rows.map((row) => [row.date, Number(row.value)]));
}

/** Half-open [start, end) merge count for work metrics. Pure DB read of Mantra mono only. */
export async function countMergedPrsInRange(start: Date, end: Date): Promise<number> {
  const ref = await resolveCodeHeatmapRepo();
  if (!ref) return 0;
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(mergedPullRequests)
    .where(
      and(
        codeHeatmapRepoPredicate(ref),
        gte(mergedPullRequests.mergedAt, start),
        lt(mergedPullRequests.mergedAt, end),
      ),
    );
  return Number(row?.value ?? 0);
}

async function ledgerRowCount(ref: RepoRef): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(mergedPullRequests)
    .where(codeHeatmapRepoPredicate(ref));
  return Number(row?.value ?? 0);
}

function defaultBackfillState(): BackfillState {
  return {
    status: "pending",
    // Newest day fully covered starts as "tomorrow" so the first step covers today.
    cursorDate: addUtcDays(utcDateString(new Date()), 1),
    recentSeeded: false,
    updatedAt: new Date().toISOString(),
    insertedTotal: 0,
  };
}

async function readBackfillState(): Promise<BackfillState> {
  const existing = await getSetting<BackfillState>(BACKFILL_SETTING_KEY);
  if (
    existing &&
    typeof existing === "object" &&
    typeof existing.cursorDate === "string" &&
    typeof existing.status === "string"
  ) {
    return {
      ...defaultBackfillState(),
      ...existing,
      recentSeeded: Boolean(existing.recentSeeded),
    };
  }
  return defaultBackfillState();
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
  // Newest first so recent heat fills even if a window is truncated at 1000.
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");

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

function searchItemToRecord(
  ref: RepoRef,
  item: GhSearchItem,
  source: MergedPrSource,
): MergedPrRecordInput | null {
  // closed_at is not merge time — using it painted winter/spring CODE cells
  // for PRs that GitHub never merged on those days.
  const mergedAt = item.pull_request?.merged_at;
  if (!mergedAt || !item.pull_request) return null;
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: item.number,
    title: item.title,
    author: item.user?.login ?? null,
    htmlUrl: item.html_url,
    mergedAt,
    mergeCommitSha: null,
    source,
  };
}

async function ingestSearchWindow(
  ref: RepoRef,
  token: string,
  fromDate: string,
  toDateInclusive: string,
  source: MergedPrSource,
): Promise<number> {
  const query = `repo:${ref.owner}/${ref.repo} is:pr is:merged base:main merged:${fromDate}..${toDateInclusive}`;
  let page = 1;
  let inserted = 0;
  while (page <= 10) {
    const result = await githubSearch(token, query, page);
    if (page === 1) {
      log.info("Merge ledger search window", {
        owner: ref.owner,
        repo: ref.repo,
        fromDate,
        toDateInclusive,
        totalCount: result.total_count,
        source,
      });
    }
    if (result.items.length === 0) break;
    const batch: MergedPrRecordInput[] = [];
    for (const item of result.items) {
      const record = searchItemToRecord(ref, item, source);
      if (record) batch.push(record);
    }
    inserted += await recordMergedPullRequestsBatch(batch);
    if (result.items.length < SEARCH_PAGE_SIZE) break;
    if (page * SEARCH_PAGE_SIZE >= Math.min(result.total_count, 1000)) break;
    page += 1;
  }
  return inserted;
}

export interface RecentRestSeedResult {
  /** Brand-new ledger rows (not conflict updates). */
  inserted: number;
  /** Merged PRs on or after `since` seen in this walk. */
  candidates: number;
  pages: number;
}

/**
 * Fast path: page closed main PRs by updated desc until past the recent horizon.
 * Fills the visible heatmap without waiting on historical Search backfill.
 * `maxPages` keeps catch-up from re-scraping the full recent window every tick.
 */
async function seedRecentViaRest(
  ref: RepoRef,
  since: Date,
  source: MergedPrSource,
  maxPages: number = RECENT_REST_MAX_PAGES,
): Promise<RecentRestSeedResult> {
  let inserted = 0;
  let candidates = 0;
  let pages = 0;
  let reachedPastSince = false;
  const pageCap = Math.max(1, Math.min(maxPages, RECENT_REST_MAX_PAGES));
  for (let page = 1; page <= pageCap; page += 1) {
    const raw = await gh<GhPullDetail[]>(
      "GET",
      `/repos/${ref.owner}/${ref.repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=${REST_PAGE_SIZE}&page=${page}`,
    );
    pages += 1;
    if (raw.length === 0) break;
    const batch: MergedPrRecordInput[] = [];
    for (const pr of raw) {
      if (!pr.merged_at) continue;
      const mergedAt = new Date(pr.merged_at);
      if (mergedAt < since) {
        reachedPastSince = true;
        continue;
      }
      candidates += 1;
      batch.push({
        owner: ref.owner,
        repo: ref.repo,
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? null,
        htmlUrl: pr.html_url,
        mergedAt: pr.merged_at,
        mergeCommitSha: pr.merge_commit_sha,
        source,
      });
    }
    inserted += await recordMergedPullRequestsBatch(batch);
    if (raw.length < REST_PAGE_SIZE) break;
    // No in-window merges on this page and we already saw older merges → done.
    if (batch.length === 0 && reachedPastSince) break;
    // If every merged PR on this page is older than since, stop.
    const newestMergedOnPage = raw
      .filter((pr) => pr.merged_at)
      .map((pr) => new Date(pr.merged_at!).getTime())
      .reduce((max, ts) => Math.max(max, ts), 0);
    if (reachedPastSince && newestMergedOnPage > 0 && newestMergedOnPage < since.getTime()) {
      break;
    }
  }
  return { inserted, candidates, pages };
}

async function runRecentSeed(): Promise<number> {
  const repos = await listCodeHeatmapRepos();
  if (repos.length === 0) {
    log.warn("Merge ledger recent seed found no CODE heatmap GitHub repo");
    return 0;
  }
  const since = new Date(`${daysAgoUtc(CATCHUP_DAYS)}T00:00:00.000Z`);
  let inserted = 0;
  for (const ref of repos) {
    try {
      const result = await seedRecentViaRest(ref, since, "seed", RECENT_REST_MAX_PAGES);
      inserted += result.inserted;
      log.info("Merge ledger recent REST seed complete", {
        owner: ref.owner,
        repo: ref.repo,
        inserted: result.inserted,
        candidates: result.candidates,
        pages: result.pages,
        sinceDays: CATCHUP_DAYS,
      });
    } catch (error) {
      log.warn("Merge ledger recent REST seed failed", {
        owner: ref.owner,
        repo: ref.repo,
        error: error instanceof Error ? error.message : String(error),
      });
      // Cold seed only: Search once if REST failed for a non-rate-limit reason.
      // Primary exhaustion must not thrash the Search secondary budget.
      if (isGitHubRateLimitError(error)) {
        log.warn("Merge ledger recent seed skipped search fallback (primary rate limit)", {
          owner: ref.owner,
          repo: ref.repo,
        });
        continue;
      }
      try {
        const token = await resolveRepoToken(ref);
        const fromDate = daysAgoUtc(CATCHUP_DAYS);
        const toDate = utcDateString(new Date());
        const count = await ingestSearchWindow(ref, token, fromDate, toDate, "seed");
        inserted += count;
        log.info("Merge ledger recent search seed complete", {
          owner: ref.owner,
          repo: ref.repo,
          inserted: count,
          fromDate,
          toDate,
        });
      } catch (searchError) {
        log.warn("Merge ledger recent search seed failed", {
          owner: ref.owner,
          repo: ref.repo,
          error: searchError instanceof Error ? searchError.message : String(searchError),
        });
      }
    }
  }
  return inserted;
}

/**
 * Steady-state catch-up: heal gaps since the newest local ledger row.
 * Live merges already write through `recordMergedPullRequestFromGithub`.
 * This path must not re-list 14 days of closed PRs every 5 minutes.
 */
async function runCatchupOnce(): Promise<number> {
  const repos = await listCodeHeatmapRepos();
  if (repos.length === 0) return 0;
  const coldSince = new Date(`${daysAgoUtc(CATCHUP_DAYS)}T00:00:00.000Z`);
  let inserted = 0;
  for (const ref of repos) {
    try {
      const newest = await newestLedgerMergedAt(ref);
      const since = newest
        ? new Date(Math.max(coldSince.getTime(), newest.getTime() - CATCHUP_OVERLAP_MS))
        : coldSince;
      const maxPages = newest ? CATCHUP_REST_MAX_PAGES : RECENT_REST_MAX_PAGES;
      const result = await seedRecentViaRest(ref, since, "catchup", maxPages);
      inserted += result.inserted;
      log.info("Merge ledger catch-up complete", {
        owner: ref.owner,
        repo: ref.repo,
        since: since.toISOString(),
        newestLocal: newest?.toISOString() ?? null,
        inserted: result.inserted,
        candidates: result.candidates,
        pages: result.pages,
        path: "rest",
      });
    } catch (error) {
      // Never Search-fallback on catch-up: under primary 403 it spent more quota
      // and still returned ~1000 "inserted" conflict updates. Live + next tick heal.
      log.warn("Merge ledger catch-up failed for repo", {
        owner: ref.owner,
        repo: ref.repo,
        rateLimited: isGitHubRateLimitError(error),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return inserted;
}

/** One historical step: walk SEARCH_WINDOW_DAYS backward from cursor. */
async function runBackfillStep(): Promise<boolean> {
  const state = await readBackfillState();
  if (state.status === "complete") return true;

  const historyFloor = daysAgoUtc(DASHBOARD_HISTORY_DAYS);
  // cursorDate = oldest day already covered. Next window ends the day before.
  const toDate = addUtcDays(state.cursorDate, -1);
  if (toDate < historyFloor) {
    await writeBackfillState({
      ...state,
      status: "complete",
      cursorDate: historyFloor,
    });
    return true;
  }

  const fromDate = addUtcDays(toDate, -(SEARCH_WINDOW_DAYS - 1));
  const windowStart = fromDate < historyFloor ? historyFloor : fromDate;

  await writeBackfillState({
    ...state,
    status: "running",
  });

  const repos = await listCodeHeatmapRepos();
  let inserted = 0;
  for (const ref of repos) {
    try {
      const token = await resolveRepoToken(ref);
      inserted += await ingestSearchWindow(
        ref,
        token,
        windowStart,
        toDate,
        "backfill",
      );
    } catch (error) {
      log.warn("Merge ledger backfill window failed for repo", {
        owner: ref.owner,
        repo: ref.repo,
        fromDate: windowStart,
        toDate,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const nextCursor = windowStart;
  const complete = nextCursor <= historyFloor;
  await writeBackfillState({
    status: complete ? "complete" : "running",
    cursorDate: nextCursor,
    recentSeeded: state.recentSeeded,
    updatedAt: new Date().toISOString(),
    insertedTotal: (state.insertedTotal ?? 0) + inserted,
  });
  log.info("Merge ledger backfill window complete", {
    fromDate: windowStart,
    toDate,
    inserted,
    nextCursor,
    complete,
  });
  return complete;
}

async function runSyncLoopBody(): Promise<void> {
  try {
    const ref = await resolveCodeHeatmapRepo();
    if (!ref) {
      log.warn("Merge ledger sync skipped — no CODE heatmap GitHub repo resolved");
      return;
    }

    let state = await readBackfillState();

    // New cursor / never-seeded: wipe leftover scrape dates, then rebuild.
    if (!state.recentSeeded) {
      const wiped = await wipeLedgerForRebuild();
      log.info("Merge ledger wiped for rebuild", {
        owner: ref.owner,
        repo: ref.repo,
        wiped,
        cursor: BACKFILL_SETTING_KEY,
      });
    } else {
      const purged = await purgeNonCodeHeatmapRows(ref);
      if (purged > 0) {
        log.info("Merge ledger purged non-CODE repo rows", {
          owner: ref.owner,
          repo: ref.repo,
          purged,
        });
      }
    }

    const rows = await ledgerRowCount(ref);

    // Empty ledger or never-seeded: fill recent history first so CODE paints now.
    if (!state.recentSeeded || rows === 0) {
      const seeded = await runRecentSeed();
      state = await readBackfillState();
      await writeBackfillState({
        ...state,
        recentSeeded: true,
        // After seed, mark the catch-up horizon as covered so backfill continues older.
        cursorDate: daysAgoUtc(CATCHUP_DAYS),
        insertedTotal: (state.insertedTotal ?? 0) + seeded,
        status: state.status === "complete" ? "complete" : "running",
      });
      log.info("Merge ledger recent seed finished", {
        owner: ref.owner,
        repo: ref.repo,
        seeded,
        priorRows: rows,
      });
    }

    // Always refresh the recent window first (correctness under external merges).
    await runCatchupOnce();

    // Then walk older history newest → oldest, bounded steps per wake.
    for (let step = 0; step < 6; step += 1) {
      const complete = await runBackfillStep();
      if (complete) break;
    }
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

/** Start fail-soft background seed + catch-up + backfill. Safe to call once per process. */
export function startMergedPrLedgerSync(): void {
  enqueueSync();
  if (catchupTimer) return;
  catchupTimer = setInterval(() => {
    enqueueSync();
  }, CATCHUP_INTERVAL_MS);
  if (typeof catchupTimer.unref === "function") catchupTimer.unref();
  log.info("Merge ledger background sync started");
}
