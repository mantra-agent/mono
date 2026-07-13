import { createLogger } from "../../log";
import { getSetting, setSetting } from "../../system-settings";
import {
  fetchDeploymentsForEnvironment,
  redeployServiceInstance,
  extractDeploymentMeta,
  getDevConfig,
  getProdConfig,
  isDevConfigComplete,
  isProdConfigComplete,
  type RailwayDevConfig,
  type RailwayProdConfig,
} from "./client";
import {
  parseRepoSlug,
  compareRefs,
  findOpenPR,
  getPR,
  createPR,
  mergePR,
  closePR,
  fastForwardRef,
  formatPRBody,
  toPublishCommit,
  listPRFiles,
  getBranchHead,
  type RepoRef,
  type PRSummary,
  type PublishCommit,
  type PRFile,
} from "../github-pr";
import {
  buildReleaseDraft,
  publishVersionFile,
  recordSuccessfulRelease,
  type ReleaseDraft,
  type VersionIncrement,
} from "./release-versioning";

const log = createLogger("RailwayPublish");
const PUBLISH_RUN_STATE_KEY = "system.railway.publish.latestRun";

// Stages, in order. Adding/removing stages is safe — frontend renders dynamically.
export type PublishStageName =
  | "fast_forward_live"
  | "railway_build"
  | "trigger_redeploy_fallback"
  | "wait_for_success"
  | "health_check"
  | "ready";

/**
 * Legacy stage names from the previous PR-based publish flow. Kept only so
 * `retryRun` against an old failed run (whose `resumeFromStage` is one of
 * these) can be migrated to the new equivalent stage instead of crashing
 * with "stage not found in STAGE_ORDER". They are NOT part of the current
 * pipeline and are never written to a fresh run.
 */
const LEGACY_STAGE_MIGRATION: Record<string, PublishStageName> = {
  open_pr: "fast_forward_live",
  merge_pr: "fast_forward_live",
};

export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

/**
 * Structured diagnosis attached to the `fast_forward_live` stage when live has diverged from dev or GitHub reports
 * the PR as unmergeable (`dirty`/`conflicting`/`blocked`). The Publish tab
 * renders this so the user can see *why* the PR is dirty and offer a one-
 * click reconcile, instead of getting only the bare GitHub error string.
 *
 * Fields:
 *   - mergeableState: the raw GitHub state (`dirty`, `blocked`, …).
 *   - prNumber / prHtmlUrl: the publish PR (dev → live), with a deep link
 *     to its Files Changed view on GitHub.
 *   - driftCommits: commits on `live` that are not yet on `dev` — i.e. the
 *     reason the branches have diverged. Empty list is meaningful (it
 *     implies the conflict is structural, not drift-driven).
 *   - conflictingFiles: the changed-files list for the dirty PR. GitHub's
 *     REST API doesn't flag per-file conflicts, but this is the surface
 *     the user needs to scan to understand the conflict.
 *   - filesTruncated: true when GitHub returned the max page size and we
 *     can't be sure we have the full file list.
 *   - explanation: short plain-language summary of the most likely cause,
 *     derived from the diagnosis (drift vs. structural).
 */
export interface DirtyMergeDiagnosis {
  mergeableState: string;
  /** PR-related fields are null when the diagnosis comes from the
   *  PR-less fast-forward path (no dev → live PR exists). */
  prNumber: number | null;
  prHtmlUrl: string | null;
  filesUrl: string | null;
  driftCommits: PublishCommit[];
  /**
   * True when the drift compare *succeeded* (so an empty `driftCommits`
   * legitimately means "no drift, conflict is structural"). False when
   * the compare API call failed and `driftCommits` is empty by default
   * — UI should render "drift unknown" and keep the reconcile action
   * available rather than treating this as a structural conflict.
   */
  driftKnown: boolean;
  conflictingFiles: Array<{ filename: string; status: string; blobUrl: string | null }>;
  filesTruncated: boolean;
  explanation: string;
}

export interface PublishStage {
  name: PublishStageName;
  label: string;
  status: StageStatus;
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  // Free-form per-stage details surfaced as expandable text in the UI.
  log: string[];
  error: string | null;
  /**
   * Set by the `fast_forward_live` stage when GitHub refuses the
   * ref-update because `live` has commits `dev` doesn't (drift). The UI
   * uses this to render drift commits + a Reconcile button. Null on
   * every other stage and on happy-path runs.
   */
  dirtyMerge?: DirtyMergeDiagnosis | null;
}

export interface PublishRunSummary {
  /** Snapshot of the dev branch head at run start */
  devCommit: { sha: string; shortSha: string; message: string } | null;
  devBranch: string | null;
  /** Snapshot of the live branch head at run start */
  prodCommit: { sha: string; shortSha: string; message: string } | null;
  prodBranch: string;
  repo: string | null;
  /** Wire-format commits — use the flattened DTO so the frontend gets `author`/`url` directly. */
  commits: PublishCommit[];
}

export interface PublishRun {
  id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  startedByName: string | null;
  summary: PublishRunSummary;
  stages: PublishStage[];
  prUrl: string | null;
  prNumber: number | null;
  deploymentId: string | null;
  /** Deep link to the deployment in Railway's web console (when known). */
  deploymentUrl: string | null;
  /**
   * Railway deployment id captured at run-start (before merge), used to detect
   * a fresh deployment without racing Railway's auto-deploy. Internal only.
   */
  baselineDeploymentId: string | null;
  newProdCommitSha: string | null;
  release: {
    increment: VersionIncrement;
    previousVersion: string;
    version: string;
    versionFileUrl: string;
    versionFileCommitSha: string | null;
    notes: ReleaseDraft["notes"];
    markdown: string;
  } | null;
  prodUrl: string | null;
  // Stage to resume from on retry; null when starting fresh.
  resumeFromStage: PublishStageName | null;
}

const STAGE_LABELS: Record<PublishStageName, string> = {
  fast_forward_live: "Fast-forward live",
  railway_build: "Railway build",
  trigger_redeploy_fallback: "Trigger redeploy (fallback)",
  wait_for_success: "Wait for SUCCESS",
  health_check: "Post-deploy health check",
  ready: "Production ready",
};

const STAGE_ORDER: PublishStageName[] = [
  "fast_forward_live",
  "railway_build",
  "trigger_redeploy_fallback",
  "wait_for_success",
  "health_check",
  "ready",
];

function blankStage(name: PublishStageName): PublishStage {
  return {
    name,
    label: STAGE_LABELS[name],
    status: "pending",
    message: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    log: [],
    error: null,
    dirtyMerge: null,
  };
}

/**
 * Build the plain-language explanation rendered above the diagnosis on a
 * dirty-merge failure. Branches on the most informative signal first
 * (drift commits) and falls back to a structural explanation when the
 * branches haven't actually diverged commit-wise.
 */
function buildDirtyExplanation(opts: {
  mergeableState: string;
  driftCount: number;
  driftKnown: boolean;
  liveBranch: string;
  devBranch: string;
}): string {
  const { mergeableState, driftCount, driftKnown, liveBranch, devBranch } = opts;
  if (!driftKnown) {
    return (
      `GitHub marked the PR as ${mergeableState}, but the drift compare against '${devBranch}' failed ` +
      `so we couldn't determine whether '${liveBranch}' has commits ahead. Try Reconcile anyway — if there's no ` +
      `drift it will refuse to open an empty PR and you'll know the conflict is structural.`
    );
  }
  if (driftCount > 0) {
    return (
      `GitHub marked the PR as ${mergeableState}: '${liveBranch}' has ${driftCount} commit${
        driftCount === 1 ? "" : "s"
      } that '${devBranch}' doesn't yet have. ` +
      `Merge those drift commits back into '${devBranch}' (use the Reconcile button below), then retry the publish.`
    );
  }
  return (
    `GitHub marked the PR as ${mergeableState}, but '${liveBranch}' has no commits ahead of '${devBranch}'. ` +
    `The conflict is structural — likely a squash-merge history mismatch or a branch/repo misconfiguration ` +
    `rather than real drift. Reconciling won't help; inspect the PR's Files Changed view directly.`
  );
}

/**
 * Diagnose a dirty/conflicting/blocked PR by fetching drift commits
 * (live ∋ dev) and the PR's changed-files list. Best-effort: any
 * sub-call that fails returns a partial diagnosis with the empty list
 * for that field, since the user is better served by a partial render
 * than by no render at all.
 */
async function diagnoseDirtyPR(
  repo: RepoRef,
  pr: PRSummary,
  devBranch: string,
  liveBranch: string
): Promise<DirtyMergeDiagnosis> {
  let driftCommits: PublishCommit[] = [];
  let driftCount = 0;
  let driftKnown = false;
  try {
    const driftCmp = await compareRefs(repo, devBranch, liveBranch);
    driftCommits = driftCmp.commits.map(toPublishCommit);
    driftCount = driftCmp.aheadBy;
    driftKnown = true;
  } catch (err) {
    log.warn(`Drift compare failed for PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let conflictingFiles: DirtyMergeDiagnosis["conflictingFiles"] = [];
  let filesTruncated = false;
  try {
    const files: PRFile[] = await listPRFiles(repo, pr.number, 100);
    conflictingFiles = files.map((f) => ({
      filename: f.filename,
      status: f.status,
      blobUrl: f.blobUrl,
    }));
    filesTruncated = files.length >= 100;
  } catch (err) {
    log.warn(`PR files fetch failed for PR #${pr.number}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const mergeableState = pr.mergeableState ?? "unknown";
  return {
    mergeableState,
    prNumber: pr.number,
    prHtmlUrl: pr.htmlUrl,
    filesUrl: `${pr.htmlUrl}/files`,
    driftCommits,
    driftKnown,
    conflictingFiles,
    filesTruncated,
    explanation: buildDirtyExplanation({
      mergeableState,
      driftCount,
      driftKnown,
      liveBranch,
      devBranch,
    }),
  };
}

function newRunId(): string {
  return `pub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the Railway web-console deep link for a given deployment, e.g.
 * https://railway.com/project/<projectId>/service/<serviceId>?environmentId=<envId>&id=<deploymentId>
 */
function buildRailwayDeploymentUrl(
  cfg: RailwayProdConfig,
  deploymentId: string
): string | null {
  if (!cfg.projectId || !cfg.serviceId || !cfg.environmentId) return null;
  const params = new URLSearchParams({
    environmentId: cfg.environmentId,
    id: deploymentId,
  });
  return `https://railway.com/project/${cfg.projectId}/service/${cfg.serviceId}?${params.toString()}`;
}

// ─── Module state ──────────────────────────────────────────────────────────────
// Single in-flight publish at a time. We retain the *last* run after it finishes
// so the UI can still render its timeline until a new one starts.

let currentRun: PublishRun | null = null;
let lastRun: PublishRun | null = null;
let publishRunLoaded = false;
let publishRunPersistQueue: Promise<void> = Promise.resolve();
let runAbort: AbortController | null = null;
/**
 * Synchronous reservation token. Must be acquired *atomically* (without any
 * intervening await) right after observing that `currentRun` is null in
 * `startRun()` / `retryRun()`. JS's single-threaded event loop guarantees that
 * a synchronous "check + set" is uninterruptible, so two simultaneous HTTP
 * callers cannot both pass the check. Released on every error path *and* when
 * the run takes ownership of `currentRun`.
 */
let runStartLock = false;
const runListeners = new Set<(run: PublishRun) => void>();

function clonePublishRun(run: PublishRun | null): PublishRun | null {
  if (!run) return null;
  return {
    ...run,
    summary: {
      ...run.summary,
      devCommit: run.summary.devCommit ? { ...run.summary.devCommit } : null,
      prodCommit: run.summary.prodCommit ? { ...run.summary.prodCommit } : null,
      commits: run.summary.commits.map((commit) => ({ ...commit })),
    },
    stages: run.stages.map((stage) => ({
      ...stage,
      log: [...stage.log],
      dirtyMerge: stage.dirtyMerge
        ? {
            ...stage.dirtyMerge,
            driftCommits: stage.dirtyMerge.driftCommits.map((commit) => ({ ...commit })),
            conflictingFiles: stage.dirtyMerge.conflictingFiles.map((file) => ({ ...file })),
          }
        : null,
    })),
  };
}

function markLoadedRunningPublishRunInterrupted(run: PublishRun): PublishRun {
  const now = new Date().toISOString();
  const stages = run.stages.map((stage) => {
    if (stage.status !== "running") return stage;
    const startedAtMs = stage.startedAt ? Date.parse(stage.startedAt) : NaN;
    return {
      ...stage,
      status: "failed" as const,
      finishedAt: now,
      durationMs: Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : stage.durationMs,
      error: "Publish was interrupted by a server restart or redeploy.",
      message: "Publish was interrupted by a server restart or redeploy. Start publish again after checking production state.",
      log: [...stage.log, "Publish run interrupted by server restart or redeploy."],
    };
  });
  return { ...run, status: "failed", finishedAt: now, stages };
}

function schedulePublishRunPersist(): void {
  const snapshot = clonePublishRun(currentRun ?? lastRun);
  if (!snapshot) return;
  publishRunPersistQueue = publishRunPersistQueue
    .then(() => setSetting(PUBLISH_RUN_STATE_KEY, snapshot))
    .catch((err: any) => {
      log.error("Failed to persist publish run snapshot", {
        runId: snapshot.id,
        error: err?.message || String(err),
        stack: err?.stack,
      });
    });
}

async function ensurePublishRunLoaded(): Promise<void> {
  if (publishRunLoaded) return;
  publishRunLoaded = true;
  try {
    const stored = await getSetting<PublishRun>(PUBLISH_RUN_STATE_KEY);
    if (!stored) return;
    const run = clonePublishRun(stored);
    if (!run) return;
    lastRun = run.status === "running" ? markLoadedRunningPublishRunInterrupted(run) : run;
    if (run.status === "running") schedulePublishRunPersist();
  } catch (err: any) {
    log.error("Failed to load persisted publish run snapshot", {
      error: err?.message || String(err),
      stack: err?.stack,
    });
  }
}

function emit() {
  const snap = currentRun ?? lastRun;
  if (!snap) return;
  schedulePublishRunPersist();
  for (const fn of runListeners) {
    try { fn(snap); } catch { /* ignore */ }
  }
}

export function subscribe(fn: (run: PublishRun) => void): () => void {
  runListeners.add(fn);
  return () => runListeners.delete(fn);
}

export function getCurrentRun(): PublishRun | null {
  return currentRun;
}

export function getLastRun(): PublishRun | null {
  return lastRun;
}

export async function getDisplayRun(): Promise<PublishRun | null> {
  await ensurePublishRunLoaded();
  return currentRun ?? lastRun;
}

// ─── Setup-required check ──────────────────────────────────────────────────────

export interface PublishPrereqs {
  ready: boolean;
  reason: string | null;
  devCfg: RailwayDevConfig;
  prodCfg: RailwayProdConfig;
  hasGitHub: boolean;
  repo: RepoRef | null;
  devBranch: string | null;
}

/**
 * Check everything the publish flow needs: dev config, prod config, GitHub
 * connector, and a recent dev deployment so we know the dev branch + repo.
 */
export async function checkPrereqs(): Promise<PublishPrereqs> {
  const [devCfg, prodCfg] = await Promise.all([getDevConfig(), getProdConfig()]);
  const result: PublishPrereqs = {
    ready: false,
    reason: null,
    devCfg,
    prodCfg,
    hasGitHub: false,
    repo: null,
    devBranch: null,
  };

  if (!devCfg.hasToken) {
    result.reason = "Railway API token is not configured.";
    return result;
  }
  if (!isDevConfigComplete(devCfg)) {
    result.reason = "Dev environment is not configured. Open the Setup tab first.";
    return result;
  }
  if (!isProdConfigComplete(prodCfg)) {
    result.reason = "Prod environment is not configured. Set RAILWAY_PROD_ENVIRONMENT_ID, RAILWAY_PROD_SERVICE_ID, and RAILWAY_PROD_URL.";
    return result;
  }

  // Probe GitHub auth — getGitHubAccessToken throws if no PAT is configured.
  try {
    const { getGitHubAccessToken } = await import("../../github-auth");
    await getGitHubAccessToken();
    result.hasGitHub = true;
  } catch (err) {
    result.reason = `GitHub auth unavailable: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  // Resolve repo + dev branch from the latest dev deployment so we know what
  // to compare against `live`.
  try {
    const deps = await fetchDeploymentsForEnvironment(
      devCfg.projectId!,
      devCfg.serviceId!,
      devCfg.environmentId!,
      1
    );
    const meta = extractDeploymentMeta(deps[0]?.meta);
    result.repo = parseRepoSlug(meta.repo ?? null);
    result.devBranch = meta.branch ?? null;
    if (!result.repo) {
      result.reason = "Couldn't determine GitHub repo from the latest dev deployment.";
      return result;
    }
    if (!result.devBranch) {
      result.reason = "Couldn't determine dev branch from the latest dev deployment.";
      return result;
    }
  } catch (err) {
    result.reason = `Couldn't read dev deployment metadata: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  result.ready = true;
  return result;
}

// ─── Public commands ───────────────────────────────────────────────────────────

/**
 * Thrown when a publish/retry is requested while another is already in flight
 * (or already being launched). Translated to HTTP 409 by the route layer.
 */
export class PublishInFlightError extends Error {
  constructor(message = "A publish is already in flight.") {
    super(message);
    this.name = "PublishInFlightError";
  }
}

/**
 * Thrown when a publish/retry can't start because prerequisites are missing
 * (no Railway token, no GitHub connection, prod env vars not set, etc.).
 * Translated to HTTP 422 by the route layer so the client can distinguish
 * "fix your setup" from a real server error.
 */
export class PublishNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishNotReadyError";
  }
}

/**
 * Thrown when there are no commits to publish (dev is not ahead of live).
 * Translated to HTTP 409 by the route layer with the machine-readable code
 * `nothing_to_publish` so clients can render a friendly state without
 * regex-matching the error message.
 */
export class NothingToPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NothingToPublishError";
  }
}

/**
 * Public, wire-format projection of `PublishRun`. Strips fields that are
 * implementation details and shouldn't be exposed to clients (e.g. the
 * pre-merge baseline deployment id used internally to detect Railway races).
 */
export type PublicPublishRun = Omit<PublishRun, "baselineDeploymentId" | "release"> & {
  release: Omit<NonNullable<PublishRun["release"]>, "markdown"> | null;
};

/** Drop internal-only fields before sending a run to the client. */
export function toPublicRun(run: PublishRun): PublicPublishRun;
export function toPublicRun(run: PublishRun | null): PublicPublishRun | null;
export function toPublicRun(run: PublishRun | null): PublicPublishRun | null {
  if (!run) return null;
  // Destructure to strip internal-only fields cleanly without mutating the
  // original (which is still the live module-state object).
  const { baselineDeploymentId: _baselineDeploymentId, release, ...publicRun } = run;
  void _baselineDeploymentId;
  const publicRelease = release
    ? (({ markdown: _markdown, ...value }) => {
        void _markdown;
        return value;
      })(release)
    : null;
  return { ...publicRun, release: publicRelease };
}

/**
 * Atomically reserves the right to start a new run. Combines the
 * `currentRun == null` check with `runStartLock` acquisition in a single
 * synchronous step — JS's event loop guarantees no other handler can run
 * between these two operations, so two simultaneous HTTP requests cannot both
 * succeed here. Throws PublishInFlightError if the slot is taken.
 */
function acquireStartSlot(): void {
  if (currentRun || runStartLock) {
    throw new PublishInFlightError();
  }
  runStartLock = true;
}

export async function startRun(
  actor: { id: string; name: string | null },
  increment: VersionIncrement,
): Promise<PublishRun> {
  await ensurePublishRunLoaded();
  acquireStartSlot();
  try {
    const prereqs = await checkPrereqs();
    if (!prereqs.ready) {
      throw new PublishNotReadyError(prereqs.reason ?? "Publish prerequisites not met.");
    }

    // Look up dev/live HEADs and compare to know which stages will run.
    const repo = prereqs.repo!;
    const devBranch = prereqs.devBranch!;
    const liveBranch = prereqs.prodCfg.liveBranch;

    const compare = await compareRefs(repo, liveBranch, devBranch);
    if (compare.aheadBy === 0) {
      throw new NothingToPublishError(`Nothing to publish — '${devBranch}' is not ahead of '${liveBranch}'.`);
    }

    const summary: PublishRunSummary = {
      devCommit: null,
      devBranch,
      prodCommit: null,
      prodBranch: liveBranch,
      repo: `${repo.owner}/${repo.repo}`,
      commits: compare.commits.map(toPublishCommit),
    };

    // Snapshot dev/prod commit headers for the header summary.
    try {
      const { getBranchHead } = await import("../github-pr");
      const [devHead, prodHead] = await Promise.all([
        getBranchHead(repo, devBranch),
        getBranchHead(repo, liveBranch),
      ]);
      if (devHead) {
        summary.devCommit = { sha: devHead.sha, shortSha: devHead.sha.slice(0, 7), message: devHead.message };
      }
      if (prodHead) {
        summary.prodCommit = { sha: prodHead.sha, shortSha: prodHead.sha.slice(0, 7), message: prodHead.message };
      }
    } catch (err) {
      log.warn(`Failed to snapshot branch heads: ${err instanceof Error ? err.message : String(err)}`);
    }

    const runId = newRunId();
    const targetCommitSha = summary.devCommit?.sha;
    if (!targetCommitSha) throw new Error(`Couldn't resolve HEAD of '${devBranch}' for release notes.`);
    const releaseDraft = await buildReleaseDraft(
      repo,
      summary.commits,
      increment,
      runId,
      targetCommitSha,
    );

    const run: PublishRun = {
      id: runId,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedBy: actor.id,
      startedByName: actor.name,
      summary,
      stages: STAGE_ORDER.map(blankStage),
      prUrl: null,
      prNumber: null,
      deploymentId: null,
      deploymentUrl: null,
      baselineDeploymentId: null,
      newProdCommitSha: null,
      release: {
        increment: releaseDraft.increment,
        previousVersion: releaseDraft.currentVersion,
        version: releaseDraft.nextVersion,
        versionFileUrl: releaseDraft.fileUrl,
        versionFileCommitSha: null,
        notes: releaseDraft.notes,
        markdown: releaseDraft.markdown,
      },
      prodUrl: prereqs.prodCfg.prodUrl ?? null,
      resumeFromStage: null,
    };

    // Capture the prod baseline deployment *before* we open the PR. Railway can
    // sometimes pick up a merge in well under a second, and a baseline taken
    // mid-pipeline could end up equal to the freshly-created deployment, which
    // would force us into the unnecessary fallback-redeploy path.
    if (prereqs.prodCfg.projectId && prereqs.prodCfg.serviceId && prereqs.prodCfg.environmentId) {
      try {
        const baseline = await fetchDeploymentsForEnvironment(
          prereqs.prodCfg.projectId,
          prereqs.prodCfg.serviceId,
          prereqs.prodCfg.environmentId,
          1
        );
        run.baselineDeploymentId = baseline[0]?.id ?? null;
      } catch (err) {
        log.warn(`Failed to snapshot baseline deployment: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Hand the slot off from the lock to the live `currentRun`. The
    // assignment to currentRun and lock release happen synchronously
    // together, so there is no window where neither guards new starts.
    currentRun = run;
    runAbort = new AbortController();
    runStartLock = false;
    emit();

    // Fire-and-forget pipeline. Errors are caught inside runPipeline.
    runPipeline(run, runAbort.signal).catch((err) => {
      log.error(`Publish pipeline crashed: ${err instanceof Error ? err.message : String(err)}`);
    });

    return run;
  } catch (err) {
    // Release the reservation on every failure path so a later retry can run.
    runStartLock = false;
    throw err;
  }
}

/**
 * Decide *where* a retry should resume from. The naive approach — always resume
 * from the failed stage — works for stages whose failure is transient (network
 * blip, race, etc.). It does NOT work for `wait_for_success` failures, where
 * the deployment ended in a terminal FAILED/CRASHED/REMOVED state: re-running
 * `wait_for_success` against the same `deploymentId` will re-observe the same
 * terminal failure and immediately fail again.
 *
 * Policy:
 *   - `wait_for_success` failed → bump back to `trigger_redeploy_fallback` and
 *     clear `deploymentId` so the fallback issues a fresh redeploy.
 *   - `health_check` failed → resume in place; the deployment is healthy from
 *     Railway's perspective, the app just isn't answering, so we re-poll.
 *   - everything else → resume from the failed stage as-is.
 */
function planRetry(failedStage: PublishStage): {
  resumeFrom: PublishStageName;
  clearDeploymentId: boolean;
} {
  if (failedStage.name === "wait_for_success") {
    return { resumeFrom: "trigger_redeploy_fallback", clearDeploymentId: true };
  }
  // Migrate legacy stage names from old PR-based runs so retry doesn't
  // crash on a stage that no longer exists in STAGE_ORDER.
  const stageName =
    LEGACY_STAGE_MIGRATION[failedStage.name as string] ?? failedStage.name;
  return { resumeFrom: stageName, clearDeploymentId: false };
}

export async function retryRun(actor: { id: string; name: string | null }): Promise<PublishRun> {
  await ensurePublishRunLoaded();
  acquireStartSlot();
  try {
    if (!lastRun || lastRun.status !== "failed") {
      throw new Error("No failed run to retry.");
    }
    const failedStage = lastRun.stages.find((s) => s.status === "failed");
    if (!failedStage) throw new Error("Last run has no failed stage to resume from.");

    const plan = planRetry(failedStage);
    const resumeIdx = STAGE_ORDER.indexOf(plan.resumeFrom);

    // Recreate run preserving prior progress.
    const fresh: PublishRun = {
      ...lastRun,
      id: newRunId(),
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      startedBy: actor.id,
      startedByName: actor.name,
      // If we're rewinding past the deployment-detection stage, the old
      // deployment id (and its derived URL) are stale; clear them so the
      // fallback redeploy creates a fresh one.
      deploymentId: plan.clearDeploymentId ? null : lastRun.deploymentId,
      deploymentUrl: plan.clearDeploymentId ? null : lastRun.deploymentUrl,
      resumeFromStage: plan.resumeFrom,
      // If the prior run used legacy stage names (old PR-based flow), the
      // stage list won't match the current STAGE_ORDER at all — rebuild
      // from scratch so we don't carry stale stages with no labels.
      stages: lastRun.stages.some((s) => STAGE_ORDER.indexOf(s.name) === -1)
        ? STAGE_ORDER.map(blankStage)
        : lastRun.stages.map((s) => {
            // Reset the resume-from stage and everything after it; preserve
            // succeeded/skipped stages before that point.
            const stageIdx = STAGE_ORDER.indexOf(s.name);
            if (stageIdx < resumeIdx && (s.status === "succeeded" || s.status === "skipped")) {
              return s;
            }
            return blankStage(s.name);
          }),
    };
    currentRun = fresh;
    runAbort = new AbortController();
    runStartLock = false;
    emit();
    runPipeline(fresh, runAbort.signal).catch((err) => {
      log.error(`Publish retry crashed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return fresh;
  } catch (err) {
    runStartLock = false;
    throw err;
  }
}

/**
 * Find-or-create a PR going *backwards* — from `live` into `dev` — so the
 * user can review and merge the drift commits that are blocking a dirty
 * publish. Idempotent: if such a PR is already open, returns its URL
 * without creating a duplicate. Does NOT merge it; the user reviews and
 * merges in GitHub. Throws PublishNotReadyError when prereqs are missing
 * or NothingToPublishError when there is no actual drift to reconcile
 * (so the UI can render a sensible message instead of opening an empty
 * PR).
 */
export interface ReconcileResult {
  url: string;
  number: number;
  /** True iff this call created the PR; false if it reused an existing open PR. */
  created: boolean;
  /** True iff this call merged the PR. False when the PR was already merged
   *  before we got there (rare but possible across racing calls). */
  merged: boolean;
  /** SHA of the merge commit on `dev` (when known). */
  mergeSha: string | null;
}

export async function reconcileLiveIntoDev(): Promise<ReconcileResult> {
  const prereqs = await checkPrereqs();
  if (!prereqs.ready || !prereqs.repo || !prereqs.devBranch) {
    throw new PublishNotReadyError(prereqs.reason ?? "Publish prerequisites not met.");
  }
  const repo = prereqs.repo;
  const devBranch = prereqs.devBranch;
  const liveBranch = prereqs.prodCfg.liveBranch;

  // Confirm there's actually drift to merge (live ahead of dev). If not,
  // refuse rather than open an empty PR — the user's real problem is
  // structural and a reconcile PR won't help.
  const drift = await compareRefs(repo, devBranch, liveBranch);
  if (drift.aheadBy === 0) {
    throw new NothingToPublishError(
      `Nothing to reconcile — '${liveBranch}' has no commits ahead of '${devBranch}'.`
    );
  }

  let pr = await findOpenPR(repo, liveBranch, devBranch);
  let created = false;
  if (!pr) {
    const title = `Reconcile ${liveBranch} → ${devBranch} (${drift.aheadBy} drift commit${drift.aheadBy === 1 ? "" : "s"})`;
    const body = formatPRBody(drift.commits, {
      header: `Bring '${devBranch}' back in sync with '${liveBranch}' so the next dev → live publish can fast-forward cleanly.`,
      footer: "Opened automatically by the Publish tab's reconcile action.",
    });
    pr = await createPR(repo, { title, head: liveBranch, base: devBranch, body });
    created = true;
  } else {
    log.debug(`Reconcile PR already open: #${pr.number}`);
  }

  // Wait briefly for GitHub to compute mergeability if it's not ready yet
  // (mergeable_state is often "unknown" right after PR creation).
  let attempts = 0;
  while (attempts < 10) {
    const refreshed = await getPR(repo, pr.number);
    pr = refreshed;
    if (refreshed.merged) break;
    if (refreshed.mergeableState && refreshed.mergeableState !== "unknown") break;
    attempts += 1;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (pr.merged) {
    return { url: pr.htmlUrl, number: pr.number, created, merged: false, mergeSha: null };
  }

  if (pr.mergeableState && /(dirty|conflicting|blocked)/i.test(pr.mergeableState)) {
    throw new Error(
      `Reconcile PR #${pr.number} is not mergeable (state: ${pr.mergeableState}). ` +
        `Resolve the conflict on GitHub directly: ${pr.htmlUrl}`
    );
  }

  // Use a real merge commit (NOT squash) so live's orphan commits land on
  // dev verbatim — preserving the byte-identical relationship between the
  // two branches that the fast-forward publish flow depends on.
  const mergeResult = await mergePR(repo, pr.number, { merge_method: "merge" });
  if (!mergeResult.merged) {
    throw new Error(`Reconcile merge rejected by GitHub: ${mergeResult.message}`);
  }

  return {
    url: pr.htmlUrl,
    number: pr.number,
    created,
    merged: true,
    mergeSha: mergeResult.sha,
  };
}

export function cancelRun(): boolean {
  if (!currentRun || !runAbort) return false;
  runAbort.abort();
  // Pipeline marks itself as cancelled when it observes the abort signal; do
  // not mutate state here to avoid double-finishing.
  return true;
}

// ─── Pipeline runner ───────────────────────────────────────────────────────────

function setStage(run: PublishRun, name: PublishStageName, patch: Partial<PublishStage>) {
  const s = run.stages.find((x) => x.name === name);
  if (!s) return;
  Object.assign(s, patch);
  emit();
}

function startStage(run: PublishRun, name: PublishStageName) {
  setStage(run, name, {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    error: null,
  });
}

function finishStage(run: PublishRun, name: PublishStageName, patch: Partial<PublishStage> & { status: StageStatus }) {
  const s = run.stages.find((x) => x.name === name)!;
  const finishedAt = new Date().toISOString();
  const durationMs = s.startedAt ? Date.parse(finishedAt) - Date.parse(s.startedAt) : null;
  setStage(run, name, { ...patch, finishedAt, durationMs });
}

function appendLog(run: PublishRun, name: PublishStageName, line: string) {
  const s = run.stages.find((x) => x.name === name);
  if (!s) return;
  s.log.push(line);
  emit();
}

/**
 * Distinct error class used solely to mark "this throw was triggered by an
 * AbortSignal, not by an actual failure". The pipeline catches it specifically
 * to finalize the run as "cancelled" instead of "failed".
 */
class PublishCancelledError extends Error {
  constructor(message = "Publish cancelled by user.") {
    super(message);
    this.name = "PublishCancelledError";
  }
}

function isCancelled(err: unknown): err is PublishCancelledError {
  return err instanceof PublishCancelledError;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new PublishCancelledError();
  }
}

/**
 * Parse a candidate ms value (often from `parseInt(env)`), substituting the
 * default if NaN/non-positive, and clamping to [min, max].
 */
function clampMs(value: number, defaultValue: number, min: number, max: number): number {
  const v = Number.isFinite(value) && value > 0 ? value : defaultValue;
  return Math.max(min, Math.min(max, v));
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new PublishCancelledError());
      },
      { once: true }
    );
  });
}

const RAILWAY_TERMINAL_OK = new Set(["SUCCESS"]);
const RAILWAY_TERMINAL_FAIL = new Set(["FAILED", "CRASHED", "REMOVED"]);

async function runPipeline(run: PublishRun, signal: AbortSignal): Promise<void> {
  const finalize = (status: PublishRun["status"]) => {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    lastRun = run;
    currentRun = null;
    runAbort = null;
    emit();
  };

  try {
    const prereqs = await checkPrereqs();
    if (!prereqs.ready || !prereqs.repo) {
      throw new Error(prereqs.reason ?? "Prerequisites not met.");
    }
    const repo = prereqs.repo;
    const devBranch = prereqs.devBranch!;
    const prodCfg = prereqs.prodCfg;
    const liveBranch = prodCfg.liveBranch;

    const shouldRunStage = (name: PublishStageName) => {
      if (!run.resumeFromStage) return true;
      return STAGE_ORDER.indexOf(name) >= STAGE_ORDER.indexOf(run.resumeFromStage);
    };

    // ─── Stage 1: fast_forward_live ──────────────────────────────────────────
    // Directly fast-forward the `live` ref to dev's HEAD SHA. No PR is
    // opened; no squash commit is created on `live`. This keeps `live` and
    // `dev` byte-identical after every publish so subsequent publishes
    // never have to deal with drift or a "dirty" merge state.
    let mergeSha: string | null = null;
    if (shouldRunStage("fast_forward_live")) {
      startStage(run, "fast_forward_live");
      try {
        // Re-check ahead-by in case dev moved while waiting in the queue.
        const cmp = await compareRefs(repo, liveBranch, devBranch);
        run.summary.commits = cmp.commits.map(toPublishCommit);
        if (cmp.aheadBy === 0) {
          finishStage(run, "fast_forward_live", {
            status: "skipped",
            message: `'${devBranch}' is not ahead of '${liveBranch}' — nothing to promote.`,
          });
          finishStage(run, "railway_build", { status: "skipped", message: "No new deployment expected." });
          finishStage(run, "trigger_redeploy_fallback", { status: "skipped", message: "Skipped." });
          finishStage(run, "wait_for_success", { status: "skipped", message: "Skipped." });
          finishStage(run, "health_check", { status: "skipped", message: "Skipped." });
          finishStage(run, "ready", {
            status: "succeeded",
            message: `Already in sync (${run.summary.prodCommit?.shortSha ?? "—"}).`,
          });
          finalize("succeeded");
          return;
        }

        // Look up dev's HEAD SHA *now* — we'll fast-forward `live` to this
        // exact commit. Done after the compare so we know dev is ahead.
        const devHead = await getBranchHead(repo, devBranch);
        if (!devHead) {
          throw new Error(`Couldn't resolve HEAD of '${devBranch}'.`);
        }

        // Auto-close any stale dev → live PR left over from the old
        // PR-based publish flow. Best-effort — failure here doesn't block
        // the fast-forward.
        try {
          const stalePR = await findOpenPR(repo, devBranch, liveBranch);
          if (stalePR) {
            await closePR(repo, stalePR.number, {
              comment:
                "Superseded by direct fast-forward via Mantra Publish — `live` is now updated by ref-update, not by squash-merging this PR.",
            });
            appendLog(
              run,
              "fast_forward_live",
              `Closed stale dev → live PR #${stalePR.number}.`
            );
          }
        } catch (err) {
          appendLog(
            run,
            "fast_forward_live",
            `Couldn't close stale PR: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // Force-update live → dev. We deliberately do NOT use fast-forward
        // semantics here: if `live` has drift commits that aren't on `dev`,
        // they get overwritten. This is by design — the user's mental model
        // is "publish takes whatever is on dev and puts it on live", and we
        // never want the publish flow to be blockable by drift on live.
        // Drift commits will be recovered by `reconcileLiveIntoDev` if/when
        // the user explicitly asks for them.
        const result = await fastForwardRef(repo, liveBranch, devHead.sha, { force: true });
        mergeSha = result.sha;
        const driftSuffix =
          cmp.behindBy > 0
            ? ` (overwriting ${cmp.behindBy} drift commit${cmp.behindBy === 1 ? "" : "s"} on '${liveBranch}')`
            : "";
        appendLog(
          run,
          "fast_forward_live",
          `Force-updated '${liveBranch}' to ${devHead.sha.slice(0, 7)} (${cmp.aheadBy} commit${cmp.aheadBy === 1 ? "" : "s"})${driftSuffix}.`
        );

        finishStage(run, "fast_forward_live", {
          status: "succeeded",
          message: `'${liveBranch}' → ${devHead.sha.slice(0, 7)} (${cmp.aheadBy} commit${cmp.aheadBy === 1 ? "" : "s"})${driftSuffix}.`,
        });
      } catch (err) {
        if (isCancelled(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        finishStage(run, "fast_forward_live", { status: "failed", error: msg, message: msg });
        finalize("failed");
        return;
      }
    }

    checkAbort(signal);

    // ─── Stage 3: railway_build ─────────────────────────────────────────────
    // We compare against the *run-start* baseline (captured before the PR was
    // opened in startRun) so a fast Railway auto-deploy can't race us into the
    // fallback path.
    const baselineDeploymentId = run.baselineDeploymentId;

    // Grace windows are configurable so operators can tune them per
    // environment without a code change. Defaults match the original
    // hard-coded values (60s grace, 5s poll). Values are clamped to safe
    // bounds to avoid degenerate configs.
    const GRACE_WINDOW_MS = clampMs(parseInt(process.env.RAILWAY_PUBLISH_GRACE_MS ?? "", 10), 60_000, 5_000, 600_000);
    const POLL_INTERVAL_MS = clampMs(parseInt(process.env.RAILWAY_PUBLISH_POLL_MS ?? "", 10), 5_000, 1_000, 30_000);

    let newDeploymentId: string | null = run.deploymentId;
    let lastSeenStatus: string | null = null;
    if (shouldRunStage("railway_build")) {
      startStage(run, "railway_build");
      try {
        const start = Date.now();
        while (!newDeploymentId && Date.now() - start < GRACE_WINDOW_MS) {
          checkAbort(signal);
          await sleep(POLL_INTERVAL_MS, signal);
          const latest = await fetchDeploymentsForEnvironment(
            prodCfg.projectId!,
            prodCfg.serviceId!,
            prodCfg.environmentId!,
            3
          );
          for (const d of latest) {
            // Skip the pre-merge baseline AND any deployment id this run was
            // previously bound to (e.g. a prior failed deployment that the
            // wait_for_success-aware retry just rewound past).
            if (d.id === baselineDeploymentId) continue;
            if (run.deploymentId && d.id === run.deploymentId) continue;
            const meta = extractDeploymentMeta(d.meta);
            const created = d.createdAt ? Date.parse(d.createdAt) : NaN;
            const createdAfterRun = Number.isFinite(created) && created > Date.parse(run.startedAt);
            const matchesMergeSha = !!mergeSha && !!meta.commitHash && meta.commitHash.startsWith(mergeSha.slice(0, 7));
            // Require *either* a commit-sha match (strong signal) or a
            // created-after-run-start timestamp. We removed the "no mergeSha
            // ⇒ accept anything" branch because that allowed stale historical
            // deployments to be selected when the merge SHA was unknown.
            if (matchesMergeSha || createdAfterRun) {
              newDeploymentId = d.id;
              lastSeenStatus = d.status;
              appendLog(run, "railway_build", `Detected new deployment ${d.id} (${d.status}).`);
              break;
            }
          }
        }
        if (newDeploymentId) {
          run.deploymentId = newDeploymentId;
          run.deploymentUrl = buildRailwayDeploymentUrl(prodCfg, newDeploymentId);
          // Surface the live build-state transitions (QUEUED → BUILDING →
          // DEPLOYING …) on this stage so users see the deploy moving even
          // before we hand off to wait_for_success. Bounded by ~30s so we
          // don't sit here if the deploy is fast.
          const transitionDeadline = Date.now() + 30_000;
          while (
            lastSeenStatus &&
            !RAILWAY_TERMINAL_OK.has(lastSeenStatus.toUpperCase()) &&
            !RAILWAY_TERMINAL_FAIL.has(lastSeenStatus.toUpperCase()) &&
            Date.now() < transitionDeadline
          ) {
            checkAbort(signal);
            setStage(run, "railway_build", { message: `Status: ${lastSeenStatus}` });
            await sleep(POLL_INTERVAL_MS, signal);
            const latest = await fetchDeploymentsForEnvironment(
              prodCfg.projectId!,
              prodCfg.serviceId!,
              prodCfg.environmentId!,
              5
            );
            const dep = latest.find((d) => d.id === newDeploymentId);
            if (!dep) break;
            if (dep.status !== lastSeenStatus) {
              appendLog(run, "railway_build", `Status: ${dep.status}`);
              lastSeenStatus = dep.status;
            }
            // Hand off to wait_for_success once we hit a terminal state.
            const upper = (dep.status || "").toUpperCase();
            if (RAILWAY_TERMINAL_OK.has(upper) || RAILWAY_TERMINAL_FAIL.has(upper)) break;
          }
          finishStage(run, "railway_build", {
            status: "succeeded",
            message: `Found deployment ${newDeploymentId.slice(0, 8)}${lastSeenStatus ? ` (${lastSeenStatus})` : ""}.`,
          });
        } else {
          finishStage(run, "railway_build", {
            status: "skipped",
            message: `No new deployment within ${Math.round(GRACE_WINDOW_MS / 1000)}s — using fallback redeploy.`,
          });
        }
      } catch (err) {
        if (isCancelled(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        finishStage(run, "railway_build", { status: "failed", error: msg, message: msg });
        finalize("failed");
        return;
      }
    }

    checkAbort(signal);

    // ─── Stage 4: trigger_redeploy_fallback ─────────────────────────────────
    if (shouldRunStage("trigger_redeploy_fallback")) {
      if (newDeploymentId) {
        finishStage(run, "trigger_redeploy_fallback", {
          status: "skipped",
          message: "Railway picked up the merge automatically.",
        });
      } else {
        startStage(run, "trigger_redeploy_fallback");
        try {
          // Snapshot every deployment id Railway already knows about before
          // we trigger the redeploy. The simple `id !== baselineDeploymentId`
          // check we used previously was unsafe: it would happily match any
          // *historical* deployment (or, if baseline was null, the existing
          // latest), causing wait_for_success to poll a stale deployment and
          // potentially report success while prod was still on old code.
          // We also need this set so retries after a failed deployment don't
          // re-bind to the dead deployment id.
          const knownIds = new Set<string>();
          if (baselineDeploymentId) knownIds.add(baselineDeploymentId);
          if (run.deploymentId) knownIds.add(run.deploymentId);
          try {
            const pre = await fetchDeploymentsForEnvironment(
              prodCfg.projectId!,
              prodCfg.serviceId!,
              prodCfg.environmentId!,
              10
            );
            for (const d of pre) knownIds.add(d.id);
          } catch (err) {
            log.warn(`Pre-redeploy snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          // Capture *before* the API call so the timestamp is conservative —
          // any deployment whose `createdAt` is older than this cannot be
          // the one we're about to trigger.
          const triggerAt = Date.now();
          await redeployServiceInstance(prodCfg.serviceId!, prodCfg.environmentId!);
          appendLog(
            run,
            "trigger_redeploy_fallback",
            `Triggered service-instance redeploy. Excluding ${knownIds.size} pre-existing deployment(s).`
          );

          // Wait for the fresh deployment to appear (up to 60s). A candidate
          // must be (a) not in the pre-trigger set AND (b) created at-or-after
          // the trigger timestamp. Both checks are required: (a) catches the
          // old-deployments-still-in-list case, (b) catches the rare case
          // where (a) wouldn't match because the list is paginated past the
          // ones we knew.
          const start = Date.now();
          while (!newDeploymentId && Date.now() - start < GRACE_WINDOW_MS) {
            checkAbort(signal);
            await sleep(POLL_INTERVAL_MS, signal);
            const latest = await fetchDeploymentsForEnvironment(
              prodCfg.projectId!,
              prodCfg.serviceId!,
              prodCfg.environmentId!,
              5
            );
            const found = latest.find((d) => {
              if (knownIds.has(d.id)) return false;
              if (!d.createdAt) return false;
              const created = Date.parse(d.createdAt);
              if (!Number.isFinite(created)) return false;
              // Allow a 2s clock-skew slop between our wall clock and Railway's.
              return created >= triggerAt - 2_000;
            });
            if (found) {
              newDeploymentId = found.id;
              run.deploymentId = newDeploymentId;
              run.deploymentUrl = buildRailwayDeploymentUrl(prodCfg, newDeploymentId);
              appendLog(
                run,
                "trigger_redeploy_fallback",
                `New deployment id: ${newDeploymentId} (created ${found.createdAt}).`
              );
            }
          }
          if (!newDeploymentId) {
            const msg = "Redeploy was triggered but no new deployment appeared within 60s.";
            finishStage(run, "trigger_redeploy_fallback", { status: "failed", error: msg, message: msg });
            finalize("failed");
            return;
          }
          finishStage(run, "trigger_redeploy_fallback", {
            status: "succeeded",
            message: `Manual redeploy registered as ${newDeploymentId.slice(0, 8)}.`,
          });
        } catch (err) {
          if (isCancelled(err)) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          finishStage(run, "trigger_redeploy_fallback", { status: "failed", error: msg, message: msg });
          finalize("failed");
          return;
        }
      }
    }

    checkAbort(signal);

    // ─── Stage 5: wait_for_success ──────────────────────────────────────────
    if (shouldRunStage("wait_for_success")) {
      startStage(run, "wait_for_success");
      try {
        if (!newDeploymentId) {
          throw new Error("No deployment to wait on.");
        }
        // Long poll up to 15 minutes.
        const start = Date.now();
        const TIMEOUT_MS = 15 * 60 * 1000;
        let lastStatus = "";
        while (Date.now() - start < TIMEOUT_MS) {
          checkAbort(signal);
          const latest = await fetchDeploymentsForEnvironment(
            prodCfg.projectId!,
            prodCfg.serviceId!,
            prodCfg.environmentId!,
            5
          );
          const dep = latest.find((d) => d.id === newDeploymentId);
          if (dep) {
            if (dep.status !== lastStatus) {
              appendLog(run, "wait_for_success", `Status: ${dep.status}`);
              lastStatus = dep.status;
              setStage(run, "wait_for_success", { message: `Status: ${dep.status}` });
            }
            const upper = (dep.status || "").toUpperCase();
            if (RAILWAY_TERMINAL_OK.has(upper)) {
              const meta = extractDeploymentMeta(dep.meta);
              run.newProdCommitSha = meta.commitHash ?? null;
              finishStage(run, "wait_for_success", {
                status: "succeeded",
                message: `Deployment SUCCESS (${meta.commitHash?.slice(0, 7) ?? "—"}).`,
              });
              break;
            }
            if (RAILWAY_TERMINAL_FAIL.has(upper)) {
              const msg = `Deployment ${dep.status}.`;
              finishStage(run, "wait_for_success", { status: "failed", error: msg, message: msg });
              finalize("failed");
              return;
            }
          }
          await sleep(POLL_INTERVAL_MS, signal);
        }
        const stillRunning = run.stages.find((s) => s.name === "wait_for_success");
        if (stillRunning && stillRunning.status === "running") {
          const msg = "Timed out waiting for the deployment to reach SUCCESS.";
          finishStage(run, "wait_for_success", { status: "failed", error: msg, message: msg });
          finalize("failed");
          return;
        }
      } catch (err) {
        if (isCancelled(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        finishStage(run, "wait_for_success", { status: "failed", error: msg, message: msg });
        finalize("failed");
        return;
      }
    }

    checkAbort(signal);

    // ─── Stage 6: health_check ──────────────────────────────────────────────
    if (shouldRunStage("health_check")) {
      startStage(run, "health_check");
      try {
        const ok = await healthCheck(prodCfg.prodUrl!, signal, (line) => appendLog(run, "health_check", line));
        if (!ok) {
          const msg = `Health check never returned 2xx for ${prodCfg.prodUrl}.`;
          finishStage(run, "health_check", { status: "failed", error: msg, message: msg });
          finalize("failed");
          return;
        }
        finishStage(run, "health_check", {
          status: "succeeded",
          message: `2xx from ${prodCfg.prodUrl}`,
        });
      } catch (err) {
        if (isCancelled(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        finishStage(run, "health_check", { status: "failed", error: msg, message: msg });
        finalize("failed");
        return;
      }
    }

    checkAbort(signal);

    // ─── Stage 7: ready ─────────────────────────────────────────────────────
    startStage(run, "ready");
    if (run.release?.versionFileCommitSha) {
      finishStage(run, "ready", {
        status: "succeeded",
        message: `${run.release.version} release metadata already recorded.`,
      });
      finalize("succeeded");
      return;
    }
    if (!run.release || !run.summary.repo || !run.newProdCommitSha) {
      throw new Error("Release metadata is incomplete after a successful deployment.");
    }
    const releaseDraft: ReleaseDraft = {
      increment: run.release.increment,
      currentVersion: run.release.previousVersion,
      nextVersion: run.release.version,
      notes: run.release.notes,
      markdown: run.release.markdown,
      fileUrl: run.release.versionFileUrl,
    };
    const versionFile = await publishVersionFile(repo, releaseDraft, run.newProdCommitSha);
    run.release.versionFileCommitSha = versionFile.commitSha;
    await recordSuccessfulRelease({
      publishRunId: run.id,
      actorUserId: run.startedBy,
      draft: releaseDraft,
      promotedCommitSha: run.newProdCommitSha,
      versionFileCommitSha: versionFile.commitSha,
      deploymentId: run.deploymentId,
    });
    const totalMs = Date.now() - Date.parse(run.startedAt);
    const totalLabel = totalMs < 60_000 ? `${Math.round(totalMs / 1000)}s` : `${Math.floor(totalMs / 60_000)}m ${Math.round((totalMs % 60_000) / 1000)}s`;
    finishStage(run, "ready", {
      status: "succeeded",
      message: `${run.release.version} live at ${prodCfg.prodUrl} — ${run.newProdCommitSha?.slice(0, 7) ?? "—"} (took ${totalLabel}).`,
    });
    finalize("succeeded");
  } catch (err) {
    if (isCancelled(err)) {
      // The run was cancelled by an operator — that's distinct from a stage
      // *failing* on its own. Mark the in-flight stage as `skipped` so the
      // timeline reads "skipped: cancelled by user" rather than showing a
      // misleading red "failed" indicator next to a green run-status.
      const stage = run.stages.find((s) => s.status === "running");
      if (stage) {
        finishStage(run, stage.name, {
          status: "skipped",
          message: "Cancelled by user.",
        });
      }
      finalize("cancelled");
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Publish run ${run.id} crashed: ${msg}`);
    const stage = run.stages.find((s) => s.status === "running");
    if (stage) {
      finishStage(run, stage.name, { status: "failed", error: msg, message: msg });
    }
    finalize("failed");
  }
}

// ─── Health check ──────────────────────────────────────────────────────────────

async function healthCheck(
  prodUrl: string,
  signal: AbortSignal,
  log: (line: string) => void
): Promise<boolean> {
  // Try /health, then /healthz, then /. Whichever returns 2xx first wins.
  const candidates = ["/health", "/healthz", "/"];
  // Keep retrying up to ~90 seconds with a 5s gap so we ride out the brief
  // window where Railway flips the deployment to SUCCESS but the new container
  // hasn't accepted connections yet.
  const deadline = Date.now() + 90_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    // Throw rather than returning false so the caller treats this as a
    // cancellation (run.status="cancelled", stage="skipped") instead of a
    // health-check *failure*. Other stages already use checkAbort() — this
    // brings the final stage in line.
    checkAbort(signal);
    attempt += 1;
    for (const path of candidates) {
      const url = prodUrl.replace(/\/$/, "") + path;
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { "User-Agent": "Mantra-Publish-HealthCheck" },
          signal,
        });
        if (res.status >= 200 && res.status < 300) {
          log(`✓ ${url} → ${res.status}`);
          return true;
        }
        log(`${url} → ${res.status} (attempt ${attempt})`);
      } catch (err) {
        // fetch() with an aborted signal throws AbortError — re-raise as a
        // PublishCancelledError so the run-loop's isCancelled() guard fires.
        if (signal.aborted) throw new PublishCancelledError();
        log(`${url} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await sleep(5_000, signal);
  }
  return false;
}
