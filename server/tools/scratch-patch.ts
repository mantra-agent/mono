import { spawn } from "child_process";
import { realpath } from "fs/promises";
import { resolve } from "path";
import { WORKSPACE_DIR } from "../paths";

const MAX_PATCH_BYTES = 512 * 1024;
const MAX_PATCH_FILES = 100;
const PATCH_TIMEOUT_MS = 30_000;

export interface ScratchPatchInput {
  repositoryDirectory: string;
  patch: string;
  sessionId: string;
}

export interface ScratchPatchResult {
  repositoryDirectory: string;
  changedFiles: string[];
  output: string;
}

export async function applyScratchRepositoryPatch(input: ScratchPatchInput): Promise<ScratchPatchResult> {
  const repositoryRoot = await resolveOwnedRepository(input.repositoryDirectory, input.sessionId);
  const patch = validatePatch(input.patch);
  const changedFiles = extractChangedFiles(patch);

  const output = await runGitApply(repositoryRoot, patch);
  return {
    repositoryDirectory: input.repositoryDirectory,
    changedFiles,
    output,
  };
}

async function resolveOwnedRepository(repositoryDirectory: string, sessionId: string): Promise<string> {
  if (!sessionId || sessionId.length < 8) throw new Error("A valid session is required");
  const normalized = repositoryDirectory.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  const directory = normalized.match(/^repos\/([^/]+)$/)?.[1];
  if (!directory || !directory.endsWith(`-${sessionId.slice(0, 8)}`)) {
    throw new Error("repositoryDirectory must identify the current session-owned clone");
  }

  const reposRoot = await realpath(resolve(WORKSPACE_DIR, "repos"));
  const repositoryRoot = await realpath(resolve(reposRoot, directory));
  if (!repositoryRoot.startsWith(`${reposRoot}/`)) throw new Error("Repository path escapes the workspace");
  return repositoryRoot;
}

function validatePatch(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("patch is required");
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_PATCH_BYTES) throw new Error(`patch exceeds the ${MAX_PATCH_BYTES}-byte limit`);
  if (/^GIT binary patch$/m.test(value) || /^Binary files /m.test(value)) {
    throw new Error("binary patches are not supported");
  }
  if (!/^diff --git a\//m.test(value)) throw new Error("patch must be a Git unified diff");
  return value.endsWith("\n") ? value : `${value}\n`;
}

function extractChangedFiles(patch: string): string[] {
  const files = [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
  if (files.length === 0) throw new Error("patch does not contain any file changes");
  if (files.length > MAX_PATCH_FILES) throw new Error(`patch exceeds the ${MAX_PATCH_FILES}-file limit`);
  for (const file of files) {
    if (!file || file.startsWith("/") || file.split("/").includes("..") || file.includes("\\")) {
      throw new Error(`unsafe patch path: ${file}`);
    }
  }
  return [...new Set(files)];
}

async function runGitApply(repositoryRoot: string, patch: string): Promise<string> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn("git", ["apply", "--recount", "--whitespace=nowarn", "--", "-"], {
      cwd: repositoryRoot,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: "/dev/null",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= 64 * 1024) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    const timer = setTimeout(() => child.kill("SIGKILL"), PATCH_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`git apply could not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8").trim();
      if (signal) return reject(new Error(`git apply terminated by ${signal}`));
      if (code !== 0) return reject(new Error(`patch rejected${output ? `: ${output}` : ""}`));
      resolveResult(output || "Patch applied");
    });
    child.stdin.end(patch);
  });
}
