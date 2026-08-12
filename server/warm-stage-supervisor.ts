import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = "/stage-workspace";
const STATE_FILE = "state.json";
const SNAPSHOTS_DIR = "snapshots";
const ACTIVE_LINK = "active";
const PREVIOUS_LINK = "previous";
const MAX_SNAPSHOTS = 3;
const HEALTH_PATH = "/api/health";
const REQUIRED_ACTIVE_ENTRIES = ["package.json", "package-lock.json", "node_modules", "server/index.ts"] as const;
const HEALTH_TIMEOUT_MS = 5_000;

export type WarmSupervisorState = {
  version: 1;
  runtimeMode: "warm_workspace";
  activeCommitSha: string;
  previousCommitSha: string | null;
  lockfileHash: string;
  status: "ready" | "degraded" | "failed";
  updatedAt: string;
  reason: string | null;
};

export type WarmWorkspaceContract = {
  root: string;
  port: number;
  lockfileHash: string;
  activePath: string;
  previousPath: string;
};

function boundedSha(value: string): string {
  const sha = value.trim();
  if (!/^[a-f0-9]{7,64}$/i.test(sha)) throw new Error("Warm workspace commit identity is invalid");
  return sha;
}

async function hashFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function readLink(root: string, name: string): Promise<string | null> {
  try {
    return await fs.readlink(path.join(root, name));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(root: string, state: WarmSupervisorState): Promise<void> {
  const target = path.join(root, STATE_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, target);
}

export async function loadWarmWorkspaceContract(root = process.env.STAGE_WORKSPACE_ROOT || DEFAULT_ROOT): Promise<WarmWorkspaceContract> {
  const normalizedRoot = path.resolve(root);
  const activePath = path.join(normalizedRoot, ACTIVE_LINK);
  const activeTarget = await readLink(normalizedRoot, ACTIVE_LINK);
  if (!activeTarget) throw new Error("Warm workspace is not initialized: active snapshot is missing");
  const lockfileHash = await hashFile(path.join(activePath, "package-lock.json"));
  const previousTarget = await readLink(normalizedRoot, PREVIOUS_LINK);
  return {
    root: normalizedRoot,
    port: Number.parseInt(process.env.PORT || "5000", 10),
    lockfileHash,
    activePath,
    previousPath: previousTarget ? path.join(normalizedRoot, PREVIOUS_LINK) : activePath,
  };
}

export async function validateWarmWorkspace(contract: WarmWorkspaceContract, expectedLockfileHash = process.env.STAGE_LOCKFILE_HASH): Promise<void> {
  if (expectedLockfileHash && contract.lockfileHash !== expectedLockfileHash.trim()) {
    throw new Error("Full rebuild required: warm workspace lockfile does not match the runtime dependency cache");
  }
  for (const relative of REQUIRED_ACTIVE_ENTRIES) await fs.access(path.join(contract.activePath, relative));
}

export async function activateWarmSnapshot(root: string, commitShaInput: string, snapshotDirectory: string, lockfileHash: string): Promise<WarmSupervisorState> {
  const commitSha = boundedSha(commitShaInput);
  const normalizedRoot = path.resolve(root);
  const snapshotsRoot = path.join(normalizedRoot, SNAPSHOTS_DIR);
  const snapshotPath = path.resolve(snapshotDirectory);
  if (!snapshotPath.startsWith(`${snapshotsRoot}${path.sep}`)) throw new Error("Warm snapshot must remain inside the snapshot directory");
  await fs.access(path.join(snapshotPath, "package-lock.json"));
  const currentTarget = await readLink(normalizedRoot, ACTIVE_LINK);
  const previousTarget = currentTarget;
  const temporaryLink = path.join(normalizedRoot, `.active.${process.pid}.tmp`);
  await fs.symlink(path.relative(normalizedRoot, snapshotPath), temporaryLink, "dir");
  await fs.rename(temporaryLink, path.join(normalizedRoot, ACTIVE_LINK));
  if (previousTarget) {
    const previousLinkPath = path.join(normalizedRoot, PREVIOUS_LINK);
    const previousTemporary = path.join(normalizedRoot, `.previous.${process.pid}.tmp`);
    await fs.rm(previousLinkPath, { force: true });
    await fs.symlink(previousTarget, previousTemporary, "dir");
    await fs.rename(previousTemporary, previousLinkPath);
  }
  const state: WarmSupervisorState = {
    version: 1,
    runtimeMode: "warm_workspace",
    activeCommitSha: commitSha,
    previousCommitSha: null,
    lockfileHash,
    status: "ready",
    updatedAt: new Date().toISOString(),
    reason: null,
  };
  await writeState(normalizedRoot, state);
  return state;
}

async function healthCheck(port: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Warm Stage health returned HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function runWarmStageSupervisor(): Promise<never> {
  if (process.env.STAGE_WARM_ENABLED !== "true") throw new Error("Warm Stage supervisor is disabled");
  const contract = await loadWarmWorkspaceContract();
  await validateWarmWorkspace(contract);
  let child: ChildProcess | null = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  child = spawn("node", ["--import", "tsx", "server/index.ts"], {
    cwd: contract.activePath,
    env: { ...process.env, NODE_ENV: "development", PORT: String(contract.port) },
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>((resolve) => child?.once("exit", (code) => resolve(code ?? 1)));
  if (!stopping && exitCode === 0) throw new Error("Warm Stage server exited unexpectedly");
  process.exitCode = exitCode;
  return new Promise(() => undefined);
}

if (process.argv[1]?.endsWith("warm-stage-supervisor.ts")) {
  runWarmStageSupervisor().catch((error) => {
    process.stderr.write(`warm_stage_supervisor_failed ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
