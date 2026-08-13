import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { createLogger } from "./log";
import { getSetting, setSetting } from "./system-settings";
import { resolveGitSource } from "./git-source-resolver";
import { getBranchHead, type RepoRef } from "./integrations/github-pr";

const log = createLogger("StageSync");

const APP_ROOT = process.env.STAGE_SYNC_APP_ROOT || "/app";
const ACTIVE_MARKER = path.join(APP_ROOT, ".stage-sync-active-sha");
const STATUS_KEY_PREFIX = "stage_sync:env:";

const COPY_ENTRIES = [
  "server",
  "client",
  "shared",
  "script",
  "scripts",
  "migrations",
  "mobile",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "tailwind.config.ts",
  "postcss.config.js",
  "components.json",
  "AGENTS.md",
  "CODING.md",
  "SECURITY.md",
  "DESIGN.md",
  "GOALS.md",
  "PLANNING.md",
] as const;

export type StageSyncStatusRecord = {
  version: 1;
  environmentId: number;
  activeCommitSha: string | null;
  targetCommitSha: string | null;
  status: "idle" | "pending" | "applying" | "ready" | "failed";
  reason: string | null;
  updatedAt: string;
};

function statusKey(environmentId: number): string {
  return `${STATUS_KEY_PREFIX}${environmentId}`;
}

function boundedSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(sha)) throw new Error("Stage sync commit identity is invalid");
  return sha;
}

async function hashFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readStageSyncStatus(environmentId: number): Promise<StageSyncStatusRecord | null> {
  const value = await getSetting<StageSyncStatusRecord>(statusKey(environmentId));
  if (!value || typeof value !== "object" || value.version !== 1) return null;
  return value;
}

export async function writeStageSyncStatus(
  environmentId: number,
  patch: Partial<Omit<StageSyncStatusRecord, "version" | "environmentId" | "updatedAt">> & {
    activeCommitSha?: string | null;
    targetCommitSha?: string | null;
  },
): Promise<StageSyncStatusRecord> {
  const existing = await readStageSyncStatus(environmentId);
  const next: StageSyncStatusRecord = {
    version: 1,
    environmentId,
    activeCommitSha: patch.activeCommitSha !== undefined ? patch.activeCommitSha : existing?.activeCommitSha ?? null,
    targetCommitSha: patch.targetCommitSha !== undefined ? patch.targetCommitSha : existing?.targetCommitSha ?? null,
    status: patch.status ?? existing?.status ?? "idle",
    reason: patch.reason !== undefined ? patch.reason : existing?.reason ?? null,
    updatedAt: new Date().toISOString(),
  };
  await setSetting(statusKey(environmentId), next);
  return next;
}

export async function readLocalActiveSyncSha(): Promise<string | null> {
  try {
    const raw = (await fs.readFile(ACTIVE_MARKER, "utf8")).trim().toLowerCase();
    return /^[a-f0-9]{7,64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

async function writeLocalActiveSyncSha(sha: string): Promise<void> {
  await fs.writeFile(ACTIVE_MARKER, `${boundedSha(sha)}\n`, { mode: 0o644 });
}

async function run(command: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "null"}`));
    });
  });
}

async function downloadCommitTarball(ref: RepoRef, sha: string, destinationFile: string): Promise<void> {
  const source = await resolveGitSource({
    repoUrl: `https://github.com/${ref.owner}/${ref.repo}.git`,
    matchBranch: false,
  });
  if (!source?.token) throw new Error(`No GitHub credential for ${ref.owner}/${ref.repo}`);
  const response = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/tarball/${encodeURIComponent(sha)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${source.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mantra-stage-sync",
      },
      redirect: "follow",
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`GitHub tarball download failed HTTP ${response.status}`);
  }
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(destinationFile));
}

async function extractTarball(archivePath: string, destinationDir: string): Promise<string> {
  await fs.mkdir(destinationDir, { recursive: true });
  await run("tar", ["-xzf", archivePath, "-C", destinationDir]);
  const entries = await fs.readdir(destinationDir, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length !== 1) throw new Error("GitHub tarball did not contain exactly one root directory");
  return path.join(destinationDir, dirs[0].name);
}

async function applyTree(sourceRoot: string): Promise<void> {
  for (const relative of COPY_ENTRIES) {
    const from = path.join(sourceRoot, relative);
    const to = path.join(APP_ROOT, relative);
    try {
      await fs.access(from);
    } catch {
      continue;
    }
    await fs.rm(to, { recursive: true, force: true });
    await run("cp", ["-a", from, to]);
  }
}

function requestPlannedRestart(): void {
  if (typeof process.send === "function") {
    process.send({ type: "planned_restart", reason: "stage_sync_apply" });
  }
}

async function isWarmStageEnabled(environmentId: number): Promise<boolean> {
  // Prefer durable lifecycle policy. Railway restart of an old SUCCESS deploy often keeps a
  // stale process env snapshot, so STAGE_WARM_ENABLED alone is not authoritative.
  try {
    const { getEnvironmentBuildLifecycleConfig } = await import("./platforms/build-lifecycle-service");
    const lifecycle = await getEnvironmentBuildLifecycleConfig(environmentId, { includeDisabled: true });
    const policy = lifecycle?.config?.deployPolicy && typeof lifecycle.config.deployPolicy === "object" && !Array.isArray(lifecycle.config.deployPolicy)
      ? lifecycle.config.deployPolicy as Record<string, unknown>
      : {};
    if (policy.runtimeMode === "warm_workspace") return true;
  } catch (error) {
    log.warn(`stage_sync_warm_policy_read_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return process.env.STAGE_WARM_ENABLED === "true";
}

/**
 * Stage-only boot hook. Sync Latest writes target SHA to durable stage_sync status
 * (and best-effort STAGE_SYNC_TARGET_SHA), then restarts Stage. This downloads that
 * commit into /app (lockfile-safe) and requests a planned wrapper restart so tsx/Vite
 * load the new tree. Target identity is DB-first because Railway restart often keeps
 * a stale env snapshot from the prior SUCCESS image.
 */
export async function maybeApplyPendingStageSync(input: {
  environmentId: number | null;
  owner: string;
  repo: string;
}): Promise<{ applied: boolean; restartRequested: boolean; status: StageSyncStatusRecord | null }> {
  const isLiveRuntime = /(?:^|[._-])(?:live|prod)(?:$|[._-])/i.test(
    `${process.env.RAILWAY_ENVIRONMENT_NAME || ""} ${process.env.RAILWAY_ENVIRONMENT || ""}`,
  );
  if (isLiveRuntime) {
    log.info("stage_sync_skip reason=live_runtime");
    return { applied: false, restartRequested: false, status: null };
  }
  if (!input.environmentId || input.environmentId <= 0) {
    log.info("stage_sync_skip reason=no_environment_id");
    return { applied: false, restartRequested: false, status: null };
  }
  if (!(await isWarmStageEnabled(input.environmentId))) {
    log.info(`stage_sync_skip reason=warm_not_enabled environmentId=${input.environmentId}`);
    return { applied: false, restartRequested: false, status: await readStageSyncStatus(input.environmentId) };
  }

  const existing = await readStageSyncStatus(input.environmentId);
  // DB target is canonical (set before restart). Env is compatibility only.
  const targetRaw = (existing?.targetCommitSha || process.env.STAGE_SYNC_TARGET_SHA || "").trim();
  const localActive = await readLocalActiveSyncSha();
  const imageSha = (process.env.RAILWAY_GIT_COMMIT_SHA || "").trim().toLowerCase();
  const seedActive = localActive
    || (existing?.activeCommitSha && /^[a-f0-9]{7,64}$/i.test(existing.activeCommitSha) ? existing.activeCommitSha.toLowerCase() : null)
    || (/^[a-f0-9]{7,64}$/i.test(imageSha) ? imageSha : null);

  if (!targetRaw) {
    if (seedActive) {
      const status = await writeStageSyncStatus(input.environmentId, {
        activeCommitSha: seedActive,
        status: "ready",
        reason: null,
      });
      log.info(`stage_sync_seeded_active sha=${seedActive.slice(0, 7)} environmentId=${input.environmentId}`);
      return { applied: false, restartRequested: false, status };
    }
    log.info(`stage_sync_skip reason=no_target environmentId=${input.environmentId}`);
    return { applied: false, restartRequested: false, status: existing };
  }

  const targetSha = boundedSha(targetRaw);
  if (localActive && localActive === targetSha) {
    const status = await writeStageSyncStatus(input.environmentId, {
      activeCommitSha: localActive,
      targetCommitSha: targetSha,
      status: "ready",
      reason: null,
    });
    log.info(`stage_sync_already_active sha=${targetSha.slice(0, 7)} environmentId=${input.environmentId}`);
    return { applied: false, restartRequested: false, status };
  }

  // If durable status says ready at target but local marker is missing (volume/ephemeral),
  // re-apply once so Active/workspace converge.
  await writeStageSyncStatus(input.environmentId, {
    activeCommitSha: seedActive,
    targetCommitSha: targetSha,
    status: "applying",
    reason: `Applying ${targetSha.slice(0, 7)} into the warm workspace`,
  });
  log.info(`stage_sync_applying sha=${targetSha.slice(0, 7)} environmentId=${input.environmentId} priorActive=${(localActive || seedActive || "none").toString().slice(0, 7)}`);

  const workRoot = await fs.mkdtemp(path.join(tmpdir(), "stage-sync-"));
  const archivePath = path.join(workRoot, "source.tar.gz");
  const extractRoot = path.join(workRoot, "extract");
  try {
    await downloadCommitTarball({ owner: input.owner, repo: input.repo }, targetSha, archivePath);
    const treeRoot = await extractTarball(archivePath, extractRoot);
    const currentLock = path.join(APP_ROOT, "package-lock.json");
    const incomingLock = path.join(treeRoot, "package-lock.json");
    const currentHash = await hashFile(currentLock);
    const incomingHash = await hashFile(incomingLock);
    if (currentHash !== incomingHash) {
      const status = await writeStageSyncStatus(input.environmentId, {
        activeCommitSha: seedActive,
        targetCommitSha: targetSha,
        status: "failed",
        reason: "Full rebuild required — package-lock.json changed. Sync Latest will not install dependencies.",
      });
      log.warn(`stage_sync_lockfile_mismatch target=${targetSha.slice(0, 7)}`);
      return { applied: false, restartRequested: false, status };
    }

    await applyTree(treeRoot);
    await writeLocalActiveSyncSha(targetSha);
    const status = await writeStageSyncStatus(input.environmentId, {
      activeCommitSha: targetSha,
      targetCommitSha: targetSha,
      status: "ready",
      reason: null,
    });
    log.info(`stage_sync_applied sha=${targetSha.slice(0, 7)} environmentId=${input.environmentId}`);
    requestPlannedRestart();
    return { applied: true, restartRequested: true, status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = await writeStageSyncStatus(input.environmentId, {
      activeCommitSha: seedActive,
      targetCommitSha: targetSha,
      status: "failed",
      reason: message,
    });
    log.error(`stage_sync_failed sha=${targetSha.slice(0, 7)} error=${message}`);
    return { applied: false, restartRequested: false, status };
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function resolveBoundBranchHead(ref: RepoRef, branch: string): Promise<{ sha: string; message: string }> {
  const head = await getBranchHead(ref, branch);
  if (!head?.sha) throw new Error(`Could not resolve ${ref.owner}/${ref.repo}@${branch}`);
  return head;
}

export type QueueStageSyncLatestResult = {
  triggered: boolean;
  reason: string;
  environmentId?: number;
  targetCommitSha?: string;
  deploymentId?: string;
};

/**
 * Build-owned proactive Sync Latest. Call after a successful git merge/push onto
 * Stage-bound main. No GitHub webhook — the coding ship path is the signal.
 * Fail-soft: never throws into the git tool result.
 */
export async function queueStageSyncLatest(input: {
  commitSha: string;
  reason: string;
  owner?: string | null;
  repo?: string | null;
}): Promise<QueueStageSyncLatestResult> {
  const commitSha = boundedSha(input.commitSha);
  const { resolveGitSource } = await import("./git-source-resolver");
  const source = await resolveGitSource({
    platformName: "Mantra",
    productName: "Web",
    environmentName: "stage",
    matchBranch: false,
  });
  if (!source) {
    return { triggered: false, reason: "stage_source_unresolved" };
  }

  if (input.owner && input.repo) {
    if (source.owner.toLowerCase() !== input.owner.toLowerCase() || source.repo.toLowerCase() !== input.repo.toLowerCase()) {
      return { triggered: false, reason: "repo_not_stage_bound", environmentId: source.environmentId };
    }
  }

  const { getEnvironmentBuildLifecycleConfig } = await import("./platforms/build-lifecycle-service");
  const { deriveStageLifecycleCapabilities } = await import("./platforms/stage-lifecycle-status");
  const lifecycle = await getEnvironmentBuildLifecycleConfig(source.environmentId, { includeDisabled: true });
  const policy = lifecycle?.config?.deployPolicy && typeof lifecycle.config.deployPolicy === "object" && !Array.isArray(lifecycle.config.deployPolicy)
    ? lifecycle.config.deployPolicy as Record<string, unknown>
    : {};
  const capabilities = deriveStageLifecycleCapabilities(policy, lifecycle?.config?.providerKind || "railway", {
    platformName: source.platformName,
    productName: source.productName,
    environmentName: source.environmentName,
  });
  if (!capabilities.actions.includes("sync_latest")) {
    return {
      triggered: false,
      reason: "warm_stage_not_enabled",
      environmentId: source.environmentId,
      targetCommitSha: commitSha,
    };
  }

  const {
    resolveRailwayEnvironmentControl,
    setStageSyncTargetVariable,
    restartEnvironment,
  } = await import("./integrations/railway/environment-control");

  const control = await resolveRailwayEnvironmentControl(source.environmentId);
  await writeStageSyncStatus(source.environmentId, {
    targetCommitSha: commitSha,
    status: "pending",
    reason: `Queued ${commitSha.slice(0, 7)} from ${input.reason}`,
  });
  await setStageSyncTargetVariable(control, commitSha);
  const restart = await restartEnvironment(control);
  log.info(`stage_sync_queued sha=${commitSha.slice(0, 7)} environmentId=${source.environmentId} reason=${input.reason}`);
  return {
    triggered: true,
    reason: "queued",
    environmentId: source.environmentId,
    targetCommitSha: commitSha,
    deploymentId: restart.deploymentId,
  };
}
