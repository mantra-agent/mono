import { resolve as resolvePath, join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { existsSync, readdirSync } from "fs";
import { createLogger } from "./log";
import { withAbortTimeout, TimeoutError } from "./timeout";
import { WORKSPACE_DIR } from "./paths";
import { getGitHubAccessToken } from "./github-auth";

function getDir(): string {
  try {
    if (typeof import.meta?.url === "string") {
      return dirname(fileURLToPath(import.meta.url));
    }
  } catch {}
  return resolvePath(process.cwd(), "server");
}
const __dirname = getDir();

const logger = createLogger("gitnexus");

const ANALYZE_TIMEOUT_MS = 15 * 60 * 1000;
const BACKEND_INIT_TIMEOUT_MS = 2 * 60 * 1000;
const BRIDGE_CALL_TIMEOUT_MS = 30_000;
const RETRY_BACKOFF_MS = 5_000;

export interface GitNexusRepo {
  storagePath: string;
  indexedAt?: string;
  [key: string]: unknown;
}

export interface GitNexusCluster {
  id?: string;
  label?: string;
  heuristicLabel?: string;
  name?: string;
  symbolCount?: number;
  cohesion?: number;
  [key: string]: unknown;
}

export interface GitNexusProcess {
  id?: string;
  label?: string;
  heuristicLabel?: string;
  name?: string;
  processType?: string;
  stepCount?: number;
  crossCommunity?: boolean;
  communities?: string;
  entryPointId?: string;
  terminalId?: string;
  [key: string]: unknown;
}

export interface GitNexusArchitecture {
  context: unknown;
  clusters: GitNexusCluster[];
  processes: GitNexusProcess[];
  summary: {
    totalClusters: number;
    totalProcesses: number;
    stats: unknown;
  };
}

export interface GitNexusGraphNode {
  id: string;
  label: string;
  properties: {
    name?: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    heuristicLabel?: string;
    cohesion?: number;
    symbolCount?: number;
    processType?: string;
    stepCount?: number;
    communities?: string;
    entryPointId?: string;
    terminalId?: string;
  };
}

export interface GitNexusGraphRelationship {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  confidence?: number;
  reason?: string;
  step?: number;
}

export interface GitNexusGraphResult {
  nodes: GitNexusGraphNode[];
  relationships: GitNexusGraphRelationship[];
}

export interface GitNexusStatus {
  ready: boolean;
  phase: string;
  subPhase?: string;
  progressMessage?: string;
  analyzePercent?: number;
  analyzePhaseLabel?: string;
  elapsedSeconds?: number;
  stageElapsedSeconds?: number;
  repos?: GitNexusRepo[];
  message?: string;
  errorDetail?: string;
  lastIndexedAt?: string | null;
  lastErrorPhase?: string | null;
}

interface LocalBackendInstance {
  init(): Promise<void>;
  callTool(toolName: string, params: Record<string, unknown>): Promise<unknown>;
  listRepos(): Promise<GitNexusRepo[]>;
  queryClusters(filter: unknown, limit: number): Promise<{ clusters: GitNexusCluster[] }>;
  queryProcesses(filter: unknown, limit: number): Promise<{ processes: GitNexusProcess[] }>;
  queryClusterDetail(name: string): Promise<unknown>;
  queryProcessDetail(name: string): Promise<unknown>;
  getContext(): unknown;
}

interface PersistedNexusState {
  lastIndexedAt: string | null;
  lastError: string | null;
  lastErrorPhase: string | null;
  lastErrorDetail: string | null;
}

let backend: LocalBackendInstance | null = null;
let initPromise: Promise<void> | null = null;
let lastInitFailedAt: number | null = null;
let initAttemptCount = 0;
let ready = false;
let indexingPhase: "idle" | "indexing" | "ready" | "error" = "idle";
let indexingSubPhase: "syncing" | "analyzing" | "initializing" | "" = "";
let indexingProgressMessage = "";
let analyzePercent: number | undefined = undefined;
let analyzePhaseLabel: string | undefined = undefined;
let indexingStartedAt: number | null = null;
let stageStartedAt: number | null = null;
// Bar-progress throttle + heartbeat state (reset per spawnAnalyze run)
let lastLoggedPercent = -1;
let lastLoggedAt = 0;
let lastStdoutAt = 0;
let analyzeHeartbeat: ReturnType<typeof setInterval> | null = null;
const ANALYZE_PROGRESS_LOG_INTERVAL_MS = 10_000;
const ANALYZE_PROGRESS_LOG_PERCENT_DELTA = 5;
const ANALYZE_HEARTBEAT_INTERVAL_MS = 30_000;
const ANALYZE_STDOUT_SILENCE_THRESHOLD_MS = 60_000;
let lastErrorDetail: string | null = null;
let lastErrorRaw: string | null = null;
let lastErrorPhase: string | null = null;
let lastIndexedAt: string | null = null;

const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_BACKOFF_MS = 60_000;
let autoRetryCount = 0;
let pendingRetryTimer: ReturnType<typeof setTimeout> | null = null;

export function getGitNexusPhase() {
  return indexingPhase;
}

export function isGitNexusReady() {
  return ready;
}

// ---------------------------------------------------------------------------
// Indexing toggle (system_settings key "gitnexus_indexing_enabled")
// ---------------------------------------------------------------------------
// User-visible kill switch surfaced on the Build → Code Graph tab. When set
// to false we skip indexing on boot entirely and refuse all `code` tool
// calls with a clear message so xyz doesn't silently degrade.
//
// We cache the value in-memory so the hot path (gitnexusBridgeCall on every
// tool call) doesn't re-hit Postgres. The setter invalidates the cache.
// Default is `true` so existing installs keep their current behavior.
const INDEXING_ENABLED_KEY = "gitnexus_indexing_enabled";
let indexingEnabledCache: boolean | null = null;

export async function isIndexingEnabled(): Promise<boolean> {
  if (indexingEnabledCache !== null) return indexingEnabledCache;
  try {
    const { getSetting } = await import("./system-settings");
    const v = await getSetting<boolean>(INDEXING_ENABLED_KEY);
    indexingEnabledCache = v === false ? false : true;
  } catch {
    indexingEnabledCache = true;
  }
  return indexingEnabledCache;
}

export async function setIndexingEnabled(enabled: boolean): Promise<void> {
  const { setSetting } = await import("./system-settings");
  await setSetting(INDEXING_ENABLED_KEY, enabled);
  indexingEnabledCache = enabled;
}

export function isGitNexusAnalyzing(): boolean {
  return indexingSubPhase === "analyzing";
}

// Lightweight progress accessor for the boot gate. Returns null when not
// in the analyze sub-phase (or before the first percent has been reported)
// so callers can treat "no progress yet" and "not analyzing" the same way.
// Module-internal state stays read-only to outside consumers.

export function getAnalyzeProgress(): { percent: number; label?: string } | null {
  if (analyzePercent === undefined) return null;
  return analyzePhaseLabel !== undefined
    ? { percent: analyzePercent, label: analyzePhaseLabel }
    : { percent: analyzePercent };
}

export function __setAnalyzeProgressForTest(value: { percent: number; label?: string } | null | undefined): void {
  __testOverride = value;
}

async function persistState(state: Partial<PersistedNexusState>): Promise<void> {
  try {
    const { getSetting, setSetting } = await import("./system-settings");
    const existing = (await getSetting<PersistedNexusState>("gitnexus_state")) ?? {
      lastIndexedAt: null,
      lastError: null,
      lastErrorPhase: null,
      lastErrorDetail: null,
    };
    await setSetting("gitnexus_state", { ...existing, ...state });
  } catch (err) {
    logger.warn(`[state] failed to persist state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function loadPersistedState(): Promise<void> {
  try {
    const { getSetting } = await import("./system-settings");
    const state = await getSetting<PersistedNexusState>("gitnexus_state");
    if (state) {
      lastIndexedAt = state.lastIndexedAt ?? null;
      lastErrorDetail = state.lastErrorDetail ?? null;
      lastErrorRaw = state.lastError ?? null;
      lastErrorPhase = state.lastErrorPhase ?? null;
      logger.log(`[state] loaded persisted state: lastIndexedAt=${lastIndexedAt ?? "none"} lastErrorPhase=${lastErrorPhase ?? "none"}`);
    }
  } catch (err) {
    logger.warn(`[state] failed to load persisted state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function publishNexusFailed(phase: string, detail: string, retryCount: number): Promise<void> {
  try {
    const { eventBus } = await import("./event-bus");
    eventBus.publish({
      category: "system",
      event: "system:nexus_failed",
      payload: { phase, errorDetail: detail, autoRetryCount: retryCount },
    });
  } catch {}
}

function resolveLocalBackendPath(): string {
  const devPath = resolvePath("node_modules/gitnexus");
  if (existsSync(devPath)) {
    const importPath = "gitnexus/dist/mcp/local/local-backend.js";
    logger.log(`[gitnexus] resolveLocalBackendPath: using node_modules import (${importPath})`);
    return importPath;
  }
  const prodPath = resolvePath(process.cwd(), "dist/gitnexus-runtime/gitnexus/dist/mcp/local/local-backend.js");
  if (!existsSync(prodPath)) {
    const msg = `resolveLocalBackendPath: production runtime not found at ${prodPath} — was 'npm run build' executed?`;
    logger.error(`[gitnexus] ${msg}`);
    throw new Error(msg);
  }
  logger.log(`[gitnexus] resolveLocalBackendPath: node_modules/gitnexus not found — using production runtime at ${prodPath}`);
  return prodPath;
}

async function initBackend(): Promise<void> {
  const attempt = ++initAttemptCount;
  const startMs = Date.now();
  logger.log(`LocalBackend init attempt #${attempt} starting`);
  try {
    const localBackendPath = resolveLocalBackendPath();
    logger.log(`[gitnexus] initBackend: backend path resolved at ${localBackendPath}`);
    const importStart = Date.now();
    const { LocalBackend } = await import(
      /* webpackIgnore: true */
      localBackendPath
    );
    logger.log(`[gitnexus] initBackend: LocalBackend module imported elapsed=${Date.now() - importStart}ms`);
    const b: LocalBackendInstance = new LocalBackend();

    logger.log(`[gitnexus] initBackend: calling LocalBackend.init() (timeout=${BACKEND_INIT_TIMEOUT_MS}ms)`);
    await withAbortTimeout(
      (_signal) => b.init(),
      BACKEND_INIT_TIMEOUT_MS,
      "LocalBackend.init()",
    );

    backend = b;
    ready = true;
    lastInitFailedAt = null;
    lastIndexedAt = new Date().toISOString();
    indexingPhase = "ready";
    logger.log(`LocalBackend initialized in ${Date.now() - startMs}ms (attempt #${attempt}) — code tools & graph ready`);

    await persistState({ lastIndexedAt, lastError: null, lastErrorPhase: null, lastErrorDetail: null });

    try {
      const elapsedNow = Date.now() - startMs;
      logger.log(`[gitnexus] publishing system:nexus_ready event (elapsed=${elapsedNow}ms)`);
      const { eventBus } = await import("./event-bus");
      eventBus.publish({ category: "system", event: "system:nexus_ready", payload: { elapsed: elapsedNow } });
    } catch (publishErr) {
      logger.warn(`[gitnexus] failed to publish system:nexus_ready: ${publishErr instanceof Error ? publishErr.message : String(publishErr)}`);
    }
  } catch (err: unknown) {
    const elapsed = Date.now() - startMs;
    indexingPhase = "error";
    initPromise = null;
    lastInitFailedAt = Date.now();
    const msg = err instanceof Error ? err.message : String(err);
    const kind = err instanceof TimeoutError ? "timeout" : "error";
    const detail = `LocalBackend init ${kind} after ${Math.round(elapsed / 1000)}s: ${msg}`;
    lastErrorDetail = detail;
    lastErrorRaw = msg;
    lastErrorPhase = "initializing";
    logger.error(`LocalBackend init attempt #${attempt} failed after ${elapsed}ms [${kind}]: ${msg}`);

    await persistState({ lastError: msg, lastErrorPhase: "initializing", lastErrorDetail: detail });
    await publishNexusFailed("initializing", detail, autoRetryCount);
  }
}

export async function ensureBackend(): Promise<LocalBackendInstance> {
  if (ready && backend) return backend;
  if (!initPromise) {
    if (lastInitFailedAt !== null) {
      const sinceLastFail = Date.now() - lastInitFailedAt;
      if (sinceLastFail < RETRY_BACKOFF_MS) {
        const remaining = RETRY_BACKOFF_MS - sinceLastFail;
        logger.log(`ensureBackend: retry backoff — waiting ${remaining}ms before next attempt`);
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    }
    logger.log(`ensureBackend: scheduling init attempt #${initAttemptCount + 1}`);
    initPromise = initBackend();
  }
  await initPromise;
  if (!backend) throw new Error("GitNexus backend not initialized");
  return backend;
}

const GIT_OP_TIMEOUT_MS = 90_000;

function runGit(
  args: string[],
  cwd: string,
  opts: { captureOutput?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<string> {
  const { captureOutput = false, timeoutMs = GIT_OP_TIMEOUT_MS, env: extraEnv = {} } = opts;
  return new Promise((resolve, reject) => {
    const gitEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      ...extraEnv,
    };

    const git = spawn("git", args, {
      cwd,
      env: gitEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        const elapsed = Math.round(timeoutMs / 1000);
        logger.error(`[git-sync] git ${args[0]} timed out after ${elapsed}s — killing`);
        git.kill("SIGKILL");
        reject(new Error(`git ${args[0]} timed out after ${elapsed}s`));
      }
    }, timeoutMs);

    git.stdout?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      if (captureOutput) {
        stdoutBuf += chunk;
      } else {
        const line = chunk.trim();
        if (line) logger.log(`[git-sync] ${line}`);
      }
    });

    git.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderrBuf += chunk;
      const line = chunk.trim();
      if (line) logger.log(`[git-sync] ${line}`);
    });

    git.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(captureOutput ? stdoutBuf : "");
      } else {
        const detail = stderrBuf.slice(0, 300).trim();
        const msg = `git ${args[0]} exited with code ${code}${detail ? `: ${detail}` : ""}`;
        reject(Object.assign(new Error(msg), { stderr: stderrBuf, exitCode: code }));
      }
    });

    git.on("error", (err: Error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(new Error(`git ${args[0]} spawn error: ${err.message}`));
    });
  });
}

async function detectDefaultBranch(repoUrl: string, token: string): Promise<string> {
  try {
    const askpassScript = resolvePath(__dirname, "../scripts/git-askpass.sh");
    const output = await runGit(
      ["ls-remote", "--symref", repoUrl, "HEAD"],
      process.cwd(),
      {
        captureOutput: true,
        timeoutMs: 30_000,
        env: {
          GIT_ASKPASS: askpassScript,
          GIT_USERNAME: "x-access-token",
          GIT_PASSWORD: token,
        },
      }
    );
    const match = output.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
    if (match) {
      const branch = match[1];
      logger.log(`[git-sync] detected default branch: ${branch}`);
      return branch;
    }
    logger.log("[git-sync] could not parse default branch from ls-remote output, falling back to master");
    return "master";
  } catch (err) {
    logger.log(`[git-sync] ls-remote failed (${(err as Error).message}), falling back to master`);
    return "master";
  }
}

function classifyGitError(err: Error): string {
  const msg = err.message.toLowerCase();
  if (msg.includes("cannot exec") && msg.includes("askpass")) {
    return "Git credential helper missing or not executable — scripts/git-askpass.sh may be absent from the image or lack execute permissions";
  }
  if (msg.includes("ssl") || msg.includes("ca cert")) {
    return "Git SSL/TLS error — ca-certificates may not be installed in the container image";
  }
  if (msg.includes("authentication failed") || msg.includes("401")) {
    return "Git authentication failed — check the GitHub PAT in Build → GitHub";
  }
  if (msg.includes("could not read username") && !msg.includes("askpass")) {
    return "Git authentication failed — check the GitHub PAT in Build → GitHub";
  }
  if (msg.includes("repository not found") || msg.includes("404")) {
    return "Git repository not found — check GITHUB_REPO_URL";
  }
  if (msg.includes("could not resolve host") || msg.includes("network") || msg.includes("connection refused")) {
    return "Git network error — check connectivity";
  }
  return `Git sync failed: ${err.message}`;
}

async function syncGitRepo(repoUrl: string, targetDir: string): Promise<void> {
  indexingSubPhase = "syncing";
  stageStartedAt = Date.now();
  indexingProgressMessage = "Authenticating with GitHub...";

  const token = await getGitHubAccessToken();
  const askpassScript = resolvePath(__dirname, "../scripts/git-askpass.sh");
  const credEnv = {
    GIT_ASKPASS: askpassScript,
    GIT_USERNAME: "x-access-token",
    GIT_PASSWORD: token,
  };

  indexingProgressMessage = "Detecting default branch...";
  const detectedBranch = await detectDefaultBranch(repoUrl, token);

  const fallbackOrder: string[] = [detectedBranch];
  if (!fallbackOrder.includes("master")) fallbackOrder.push("master");
  if (!fallbackOrder.includes("main")) fallbackOrder.push("main");

  const gitDirExists = existsSync(join(targetDir, ".git"));

  if (gitDirExists) {
    let lastError: Error | undefined;
    for (const branch of fallbackOrder) {
      try {
        logger.log(`[git-sync] git pull in ${targetDir} [url=${repoUrl}] [branch=${branch}]`);
        indexingProgressMessage = "Pulling latest changes...";
        await runGit(["remote", "set-url", "origin", repoUrl], targetDir, { env: credEnv });
        await runGit(["pull", "origin", branch], targetDir, { env: credEnv });
        indexingProgressMessage = "Git sync complete";
        return;
      } catch (err) {
        lastError = err as Error;
        logger.log(`[git-sync] pull failed with branch "${branch}": ${lastError.message}`);
      }
    }
    throw lastError ?? new Error("git pull failed for all candidate branches");
  } else {
    const dirHasContent = existsSync(targetDir) &&
      (() => {
        try {
          return readdirSync(targetDir).length > 0;
        } catch {
          return false;
        }
      })();

    if (dirHasContent) {
      logger.warn(
        `[gitnexus] [git-sync] ${targetDir} has existing content without .git — will init and reset; pre-existing files may be overwritten`
      );
    }

    logger.log(`[git-sync] .git not found — initializing repo in-place in ${targetDir} from ${repoUrl}`);
    indexingProgressMessage = "Initializing local repository...";
    await runGit(["init"], targetDir);

    let lastError: Error | undefined;
    for (const branch of fallbackOrder) {
      try {
        logger.log(`[git-sync] attempting fetch with branch: ${branch}`);
        await runGit(["remote", "set-url", "origin", repoUrl], targetDir, { env: credEnv }).catch(async () => {
          await runGit(["remote", "add", "origin", repoUrl], targetDir, { env: credEnv });
        });
        indexingProgressMessage = "Downloading repository (this may take a minute for large repos)...";
        await runGit(["fetch", "origin", `${branch}`, "--depth=1"], targetDir, { env: credEnv });
        indexingProgressMessage = "Resetting workspace to latest commit...";
        await runGit(["reset", "--hard", `origin/${branch}`], targetDir, { env: credEnv });
        logger.log(`[git-sync] in-place git init and reset complete in ${targetDir} [branch=${branch}]`);
        indexingProgressMessage = "Git sync complete";
        return;
      } catch (err) {
        lastError = err as Error;
        logger.log(`[git-sync] fetch/reset failed with branch "${branch}": ${lastError.message}`);
      }
    }
    throw lastError ?? new Error("git fetch failed for all candidate branches");
  }
}

export function resetGitNexus() {
  if (pendingRetryTimer !== null) {
    clearTimeout(pendingRetryTimer);
    pendingRetryTimer = null;
  }
  indexingPhase = "indexing";
  indexingSubPhase = "";
  indexingProgressMessage = "Starting...";
  indexingStartedAt = Date.now();
  stageStartedAt = null;
  autoRetryCount = 0;
  ready = false;
  backend = null;
  initPromise = null;
  lastInitFailedAt = null;
}

function scheduleAutoRetry(reason: string) {
  if (autoRetryCount >= MAX_AUTO_RETRIES) {
    logger.error(`[gitnexus] auto-retry: max retries (${MAX_AUTO_RETRIES}) reached — not scheduling another attempt [reason=${reason}]`);
    return;
  }
  autoRetryCount++;
  const attempt = autoRetryCount;
  logger.log(`[gitnexus] auto-retry: scheduling attempt ${attempt}/${MAX_AUTO_RETRIES} in ${AUTO_RETRY_BACKOFF_MS / 1000}s [reason=${reason}]`);
  if (pendingRetryTimer !== null) clearTimeout(pendingRetryTimer);
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null;
    if (indexingPhase !== "error") {
      logger.log(`[gitnexus] auto-retry: attempt ${attempt} skipped — phase is now "${indexingPhase}"`);
      return;
    }
    logger.log(`[gitnexus] auto-retry: starting attempt ${attempt}/${MAX_AUTO_RETRIES}`);
    startGitNexus().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[gitnexus] auto-retry attempt ${attempt} threw unexpectedly: ${msg}`);
    });
  }, AUTO_RETRY_BACKOFF_MS);
}

function resolveAnalyzeBinary(): { cmd: string; args: (repoRoot: string) => string[] } {
  const localBin = resolvePath("node_modules/.bin/gitnexus");
  if (existsSync(localBin)) {
    logger.log(`[gitnexus] resolveAnalyzeBinary: using local binary at ${localBin}`);
    return {
      cmd: localBin,
      args: (repoRoot) => ["analyze", repoRoot],
    };
  }
  // In the bundled CJS production server, __dirname (from getDir()) is unreliable:
  // import.meta.url is unavailable in esbuild CJS output, so getDir() falls back to
  // resolve(process.cwd(), "server"), NOT the actual dist/ directory. To find the
  // bundled gitnexus runtime we anchor to process.cwd() — always the workspace root.
  const runtimeScript = resolvePath(process.cwd(), "dist/gitnexus-runtime/gitnexus/dist/cli/index.js");
  if (!existsSync(runtimeScript)) {
    const msg = `resolveAnalyzeBinary: production runtime not found at ${runtimeScript} — was 'npm run build' executed?`;
    logger.error(`[gitnexus] ${msg}`);
    throw new Error(msg);
  }
  logger.log(`[gitnexus] resolveAnalyzeBinary: local binary not found — using production runtime at ${runtimeScript}`);
  return {
    cmd: process.execPath,
    args: (repoRoot) => ["--max-old-space-size=2048", runtimeScript, "analyze", repoRoot],
  };
}

async function spawnAnalyze(repoRoot: string): Promise<void> {
  const { cmd, args: buildArgs } = resolveAnalyzeBinary();
  const gnEnv = { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" };
  const startMs = Date.now();

  logger.log(`[gitnexus] spawnAnalyze: cmd=${cmd} repoRoot=${repoRoot} NODE_OPTIONS=${gnEnv.NODE_OPTIONS}`);

  return new Promise((resolve, reject) => {
    const analyze = spawn(cmd, buildArgs(repoRoot), {
      cwd: repoRoot,
      env: gnEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    let stderrBuffer = "";
    let settled = false;

    // Reset per-run progress state
    analyzePercent = undefined;
    analyzePhaseLabel = undefined;
    lastLoggedPercent = -1;
    lastLoggedAt = 0;
    lastStdoutAt = Date.now();

    const clearHeartbeat = () => {
      if (analyzeHeartbeat) {
        clearInterval(analyzeHeartbeat);
        analyzeHeartbeat = null;
      }
    };
    analyzeHeartbeat = setInterval(() => {
      const now = Date.now();
      const elapsedSec = Math.round((now - startMs) / 1000);
      const stdoutAgoSec = Math.round((now - lastStdoutAt) / 1000);
      const pct = analyzePercent ?? 0;
      const phase = analyzePhaseLabel ?? "(unknown)";
      const base = `[gitnexus] analyze heartbeat elapsed=${elapsedSec}s lastStdoutAgo=${stdoutAgoSec}s percent=${pct}% phase="${phase}"`;
      if (now - lastStdoutAt > ANALYZE_STDOUT_SILENCE_THRESHOLD_MS) {
        logger.warn(`${base} — stdout silent for ${stdoutAgoSec}s`);
      } else {
        logger.log(base);
      }
    }, ANALYZE_HEARTBEAT_INTERVAL_MS);

    const watchdog = setupWatchdog(analyze, ANALYZE_TIMEOUT_MS, () => {
      if (!settled) {
        settled = true;
        clearHeartbeat();
        const elapsed = Math.round((Date.now() - startMs) / 1000);
        const detail = `analyze watchdog: process did not exit after ${elapsed}s`;
        logger.error(`[gitnexus] ${detail} — killing [pid=${analyze.pid}]`);
        reject(Object.assign(new Error(detail), { code: null, signal: "SIGKILL", stderr: "" }));
      }
    });

    analyze.stdout?.on("data", (d: Buffer) => {
      lastStdoutAt = Date.now();
      const raw = d.toString();
      // Split on \r and \n — gitnexus cli-progress uses \r overwrites for bar updates
      const fragments = raw.split(/[\r\n]+/);
      for (const fragment of fragments) {
        const line = fragment.trim();
        if (!line) continue;
        // updateAnalyzeProgress: bar lines update analyzePercent/analyzePhaseLabel
        // silently; non-bar lines are logged once and update indexingProgressMessage.
        updateAnalyzeProgress(line);
      }
    });

    analyze.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderrBuffer += chunk;
      const line = chunk.trim();
      if (line) logger.warn(`[analyze] ${line}`);
    });

    analyze.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      watchdog();
      clearHeartbeat();
      if (settled) return;
      settled = true;
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      if (code === 0) {
        logger.log(`[gitnexus] analyze complete after ${elapsed}s`);
        resolve();
      } else {
        const stderrSnippet = stderrBuffer.slice(0, 500).trim();
        const detail =
          `analyze exited with code ${code ?? "null"} signal ${signal ?? "none"} after ${elapsed}s` +
          (stderrSnippet ? `: ${stderrSnippet}` : "");
        logger.error(`[gitnexus] ${detail}`);
        reject(Object.assign(new Error(detail), { code, signal, stderr: stderrBuffer }));
      }
    });

    analyze.on("error", (err: Error) => {
      watchdog();
      clearHeartbeat();
      if (settled) return;
      settled = true;
      const detail = `analyze spawn error: ${err.message}`;
      logger.error(`[gitnexus] ${detail}`);
      reject(Object.assign(new Error(detail), { code: null, signal: null, stderr: "" }));
    });
  });
}

function setupWatchdog(proc: ReturnType<typeof spawn>, timeoutMs: number, onTimeout: () => void): () => void {
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
    onTimeout();
  }, timeoutMs);
  return () => clearTimeout(timer);
}

export async function startGitNexus() {
  if (indexingPhase === "indexing") {
    logger.log("[gitnexus] startGitNexus: already indexing — ignoring concurrent call");
    return;
  }

  const githubRepoUrl = process.env.GITHUB_REPO_URL;
  const repoRoot = resolvePath(process.cwd());
  const isDev = process.env.NODE_ENV !== "production";

  indexingPhase = "indexing";
  indexingStartedAt = indexingStartedAt ?? Date.now();
  indexingSubPhase = "";
  indexingProgressMessage = "Starting...";
  lastErrorDetail = null;
  lastErrorRaw = null;
  lastErrorPhase = null;

  logger.log(`[gitnexus] startGitNexus: phase=indexing repoRoot=${repoRoot} isDev=${isDev}`);

  if (githubRepoUrl && !isDev) {
    logger.log(`[gitnexus] GITHUB_REPO_URL set (production) — syncing repo before indexing [url=${githubRepoUrl} targetDir=${repoRoot}]`);
    try {
      await syncGitRepo(githubRepoUrl, repoRoot);
      logger.log("[gitnexus] git sync complete — starting background indexing...");
    } catch (err: unknown) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const classified = classifyGitError(err instanceof Error ? err : new Error(rawMsg));
      indexingPhase = "error";
      indexingSubPhase = "";
      indexingProgressMessage = "";
      lastErrorDetail = classified;
      lastErrorRaw = rawMsg;
      lastErrorPhase = "syncing";
      logger.error(`[gitnexus] git sync failed — skipping indexing [detail=${classified}] [raw=${rawMsg}]`);
      await persistState({ lastError: rawMsg, lastErrorPhase: "syncing", lastErrorDetail: classified });
      await publishNexusFailed("syncing", classified, autoRetryCount);
      scheduleAutoRetry(`git-sync-error: ${rawMsg}`);
      return;
    }
  } else if (githubRepoUrl && isDev) {
    logger.log(`[gitnexus] GITHUB_REPO_URL set but DEV mode — skipping git sync, indexing existing codebase at ${repoRoot}`);
  } else {
    logger.log("[gitnexus] GITHUB_REPO_URL not set — starting background indexing from cwd...");
  }

  indexingSubPhase = "analyzing";
  stageStartedAt = Date.now();
  indexingProgressMessage = "Scanning codebase...";
  logger.log("[gitnexus] phase transition: analyzing");

  try {
    await spawnAnalyze(repoRoot);
    autoRetryCount = 0;
    indexingSubPhase = "initializing";
    stageStartedAt = Date.now();
    indexingProgressMessage = "Starting query engine...";
    logger.log("[gitnexus] phase transition: initializing");
    initPromise = initBackend();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    indexingPhase = "error";
    indexingSubPhase = "";
    indexingProgressMessage = "";
    lastErrorDetail = detail;
    lastErrorRaw = detail;
    lastErrorPhase = "analyzing";
    await persistState({ lastError: detail, lastErrorPhase: "analyzing", lastErrorDetail: detail });
    await publishNexusFailed("analyzing", detail, autoRetryCount);
    scheduleAutoRetry(`analyze-error: ${detail}`);
  }
}

// ANSI escape sequence pattern (covers both CSI sequences like \x1b[2K and SGR colours)
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// cli-progress bar format: "  ████░░░░░░░ 35% | Parsing code (45s)"
// barCompleteChar: \u2588 (█)  barIncompleteChar: \u2591 (░)
const BAR_RE = /^[\u2588\u2591 ]+ (\d{1,3})% \| (.+)$/;

function updateAnalyzeProgress(rawLine: string): void {
  // Strip ANSI escape sequences (erase-line codes, colours, etc.)
  const line = rawLine.replace(ANSI_RE, "").trim();
  if (!line) return;

  const barMatch = line.match(BAR_RE);
  if (barMatch) {
    const pct = Math.min(100, Math.max(0, parseInt(barMatch[1], 10)));
    const label = barMatch[2].trim();
    analyzePercent = pct;
    analyzePhaseLabel = label;
    indexingProgressMessage = label;
    // Throttled progress log: at most once per 5% delta or 10s, whichever fires first.
    const now = Date.now();
    const percentRolledOver = pct < lastLoggedPercent;
    const enoughDelta = pct - lastLoggedPercent >= ANALYZE_PROGRESS_LOG_PERCENT_DELTA;
    const enoughTime = now - lastLoggedAt >= ANALYZE_PROGRESS_LOG_INTERVAL_MS;
    if (percentRolledOver || enoughDelta || enoughTime) {
      const elapsedSec = indexingStartedAt ? Math.round((now - indexingStartedAt) / 1000) : 0;
      logger.log(`[analyze] progress ${pct}% phase="${label}" elapsed=${elapsedSec}s`);
      lastLoggedPercent = pct;
      lastLoggedAt = now;
    }
    return;
  }

  // Non-bar lines (e.g. "Skipped 8 large files…", "Repository indexed…") —
  // log once for observability and use as a fallback progress message.
  logger.log(`[analyze] ${line}`);
  if (analyzePercent === undefined) {
    const truncated = line.length > 100 ? line.substring(0, 97) + "..." : line;
    indexingProgressMessage = truncated;
  }
}

export async function bridgeCall<T>(fn: (signal: AbortSignal) => Promise<T>, label: string): Promise<T> {
  try {
    return await withAbortTimeout(fn, BRIDGE_CALL_TIMEOUT_MS, label);
  } catch (err: unknown) {
    if (err instanceof TimeoutError) {
      logger.error(`[bridge-timeout] ${label} timed out after ${BRIDGE_CALL_TIMEOUT_MS}ms — gitnexus backend may be hung`);
    }
    throw err;
  }
}

export async function callTool(toolName: string, params: Record<string, unknown>): Promise<string> {
  const b = await ensureBackend();
  return bridgeCall(
    (_signal) => b.callTool(toolName, params).then((r) => (typeof r === "string" ? r : JSON.stringify(r, null, 2))),
    `callTool(${toolName})`,
  );
}

/**
 * Search the codebase by running direct Cypher MATCH queries against each node
 * type using the `cypher` tool (a raw passthrough). This bypasses the `query`
 * MCP tool entirely, which has a broken FTS pipeline (labels(n)[0] is Neo4j
 * syntax unsupported by KuzuDB, and node.filePath extraction is unreliable).
 *
 * Type is hardcoded per query so we never need labels(n) or label(n).
 */
/**
 * Parse a markdown table returned by the `cypher` tool into an array of objects.
 * The cypher tool returns { markdown: "| col1 | col2 |\n| --- | --- |\n| v1 | v2 |" }
 */
function parseCypherMarkdownTable(raw: string, logPrefix: string): Record<string, string>[] {
  logger.log(`[search] ${logPrefix} raw type=${typeof raw} len=${raw.length} preview=${raw.slice(0, 200)}`);

  let markdown: string;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.markdown === "string") {
      markdown = parsed.markdown;
      logger.log(`[search] ${logPrefix} parsed as {markdown} len=${markdown.length}`);
    } else if (Array.isArray(parsed)) {
      logger.log(`[search] ${logPrefix} parsed as array len=${parsed.length}`);
      return parsed;
    } else {
      logger.warn(`[search] ${logPrefix} unexpected parsed shape keys=${Object.keys(parsed || {}).join(",")}`);
      return [];
    }
  } catch (e) {
    logger.warn(`[search] ${logPrefix} JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const lines = markdown.split("\n").map((l) => l.trim()).filter((l) => l);
  logger.log(`[search] ${logPrefix} markdown lines=${lines.length} header=${lines[0]?.slice(0, 120)}`);
  if (lines.length < 3) {
    logger.warn(`[search] ${logPrefix} too few lines (${lines.length}), returning []`);
    return [];
  }

  const headers = lines[0].split("|").map((h) => h.trim()).filter((h) => h);
  logger.log(`[search] ${logPrefix} headers=${JSON.stringify(headers)}`);
  const rows: Record<string, string>[] = [];

  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split("|").map((c) => c.trim());
    const valueCells = cells.filter((_, idx) => idx > 0 && idx <= headers.length);
    if (valueCells.length === 0) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = valueCells[idx] ?? "";
    });
    rows.push(row);
  }

  logger.log(`[search] ${logPrefix} parsed rows=${rows.length} first=${JSON.stringify(rows[0])}`);
  return rows;
}

export async function searchCodebase(query: string): Promise<{
  processes: any[];
  process_symbols: any[];
  definitions: any[];
}> {
  if (!query.trim()) return { processes: [], process_symbols: [], definitions: [] };

  // Tokenize query for better lexical matching — each word matched independently
  const tokens = query.trim().split(/\s+/).filter(t => t.length >= 2).map(t => t.replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
  const perType = 5;

  const nodeTypes: Array<{ label: string; hasLines: boolean }> = [
    { label: "Function",  hasLines: true  },
    { label: "Class",     hasLines: true  },
    { label: "Method",    hasLines: true  },
    { label: "Interface", hasLines: true  },
    { label: "File",      hasLines: false },
  ];

  const allResults: any[] = [];
  logger.log(`[search] query="${query}" tokens=${JSON.stringify(tokens)} perType=${perType} types=${nodeTypes.map(t => t.label).join(",")}`);

  for (const { label, hasLines } of nodeTypes) {
    if (tokens.length === 0) break; // No valid tokens — skip CONTAINS, rely on semantic only
    try {
      const returnClause = hasLines
        ? `RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`
        : `RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;

      const whereClauses = tokens.map(t => `n.name CONTAINS '${t}' OR n.filePath CONTAINS '${t}'`).join(" OR ");
      const cypher = `MATCH (n:${label}) WHERE ${whereClauses} ${returnClause} LIMIT ${perType}`;
      logger.log(`[search] ${label} cypher="${cypher}"`);

      const raw = await callTool("cypher", { query: cypher });
      const rawStr = typeof raw === "string" ? raw : JSON.stringify(raw);
      const rows = parseCypherMarkdownTable(rawStr, label);

      logger.log(`[search] ${label} rows=${rows.length}`);
      for (const row of rows) {
        const name = row.name ?? "";
        const filePath = row.filePath ?? "";
        logger.log(`[search] ${label} row: name="${name}" filePath="${filePath}" id="${row.id}"`);
        if (!name && !filePath) {
          logger.warn(`[search] ${label} skipping row with empty name AND filePath`);
          continue;
        }
        allResults.push({
          id: row.id ?? "",
          name,
          type: label,
          filePath,
          ...(hasLines && row.startLine ? { startLine: Number(row.startLine) || undefined } : {}),
          ...(hasLines && row.endLine   ? { endLine:   Number(row.endLine)   || undefined } : {}),
        });
      }
    } catch (e) {
      logger.warn(`[search] ${label} error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let semanticResults: any[] = [];
  try {
    const { searchCodeSemantic } = await import("./gitnexus-embeddings");
    const semantic = await searchCodeSemantic(query, 10);
    semanticResults = semantic.map(r => ({
      id: `code_embed_${r.id}`,
      name: r.symbolName,
      type: r.symbolType,
      filePath: r.filePath,
      ...(r.startLine ? { startLine: r.startLine } : {}),
      ...(r.endLine ? { endLine: r.endLine } : {}),
      similarity: r.similarity,
      source: "semantic",
    }));
    logger.log(`[search] semantic results=${semanticResults.length} top_sim=${semanticResults[0]?.similarity?.toFixed(4) ?? "N/A"}`);
  } catch (err) {
    logger.warn(`[search] semantic search failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const seen = new Set<string>();
  const merged: any[] = [];

  for (const r of semanticResults) {
    const key = `${r.type}:${r.name}:${r.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
  }

  for (const r of allResults) {
    const key = r.id || `${r.type}:${r.name}:${r.filePath}`;
    const dedupeKey = `${r.type}:${r.name}:${r.filePath}`;
    if (seen.has(key) || seen.has(dedupeKey)) continue;
    seen.add(key);
    seen.add(dedupeKey);
    merged.push({ ...r, source: "contains" });
  }

  logger.log(`[search] done query="${query}" contains=${allResults.length} semantic=${semanticResults.length} merged=${merged.length} sample=${JSON.stringify(merged[0])}`);
  return { processes: [], process_symbols: merged, definitions: [] };
}

export async function getStatus(): Promise<GitNexusStatus> {
  const elapsed = indexingStartedAt ? Math.round((Date.now() - indexingStartedAt) / 1000) : undefined;
  const stageElapsed = stageStartedAt ? Math.round((Date.now() - stageStartedAt) / 1000) : undefined;

  if (indexingPhase === "indexing") {
    const isAnalyzing = (indexingSubPhase || "analyzing") === "analyzing";
    return {
      ready: false,
      phase: "indexing",
      subPhase: indexingSubPhase || "analyzing",
      progressMessage: indexingProgressMessage || "Processing...",
      ...(isAnalyzing && analyzePercent !== undefined && { analyzePercent }),
      ...(isAnalyzing && analyzePhaseLabel !== undefined && { analyzePhaseLabel }),
      elapsedSeconds: elapsed,
      stageElapsedSeconds: stageElapsed,
      message: "GitNexus is indexing the codebase",
      lastIndexedAt,
    };
  }

  if (indexingPhase === "error") {
    return {
      ready: false,
      phase: "error",
      errorDetail: lastErrorDetail ?? "GitNexus indexing failed",
      ...(lastErrorRaw && lastErrorRaw !== lastErrorDetail && { errorRaw: lastErrorRaw }),
      lastErrorPhase,
      lastIndexedAt,
    };
  }

  if (!ready || !backend) {
    return {
      ready: false,
      phase: "indexing",
      subPhase: indexingSubPhase || "initializing",
      progressMessage: indexingProgressMessage || "Initializing...",
      elapsedSeconds: elapsed,
      stageElapsedSeconds: stageElapsed,
      message: "GitNexus backend not yet initialized",
      lastIndexedAt,
    };
  }

  try {
    const repos = await bridgeCall((_signal) => backend!.listRepos(), "listRepos()");
    let embeddingStats: Record<string, unknown> = {};
    try {
      const { getEmbeddingStatus } = await import("./gitnexus-embeddings");
      embeddingStats = { codeEmbeddings: getEmbeddingStatus() };
    } catch {}
    return { ready: true, phase: "ready", repos, lastIndexedAt, ...embeddingStats };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ready: false, phase: "error", errorDetail: msg, lastIndexedAt };
  }
}

export async function getOverview(): Promise<unknown> {
  const b = await ensureBackend();
  return bridgeCall((_signal) => b.callTool("overview", {}), "getOverview()");
}

export { loadPersistedState };
