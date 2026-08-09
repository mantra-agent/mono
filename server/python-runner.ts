import { createHash } from "crypto";
import { realpath } from "fs/promises";
import { basename, join, resolve } from "path";
import { spawn } from "child_process";
import { createLogger } from "./log";
import { WORKSPACE_DIR } from "./paths";

const log = createLogger("PythonRunner");

const PYTHON_BINARY = "/usr/bin/python3";
const PRLIMIT_BINARY = "/usr/bin/prlimit";
const BWRAP_BINARY = "/usr/bin/bwrap";
const MAX_SOURCE_CHARS = 50_000;
const MAX_OUTPUT_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const FILE_SIZE_LIMIT_BYTES = 1 * 1024 * 1024;

const PYTHON_SANDBOX_BOOTSTRAP = String.raw`
import builtins
import os
import sys

_root = os.path.realpath(sys.argv[1])
_stdlib_roots = tuple(os.path.realpath(path) for path in {sys.base_prefix, sys.exec_prefix} if path)
_realpath = os.path.realpath
_fspath = os.fspath


def _inside(path, roots):
    try:
        candidate = _realpath(_fspath(path))
    except (TypeError, ValueError, OSError):
        return False
    return any(candidate == root or candidate.startswith(root + os.sep) for root in roots)


def _deny(message):
    raise PermissionError("Mantra Python sandbox: " + message)


def _audit(event, args):
    if event.startswith("socket.") or event.startswith("ssl."):
        _deny("network access is disabled")
    if event in {
        "subprocess.Popen", "os.system", "os.posix_spawn", "os.posix_spawnp", "os.fork",
        "os.forkpty", "pty.spawn", "ctypes.dlopen", "ctypes.dlsym", "ctypes.call_function",
    } or event.startswith("os.exec") or event.startswith("os.spawn"):
        _deny("process and native-code execution is disabled")
    if event == "import" and len(args) > 1 and isinstance(args[1], str):
        filename = args[1].lower()
        if filename.endswith((".so", ".pyd", ".dll", ".dylib")):
            _deny("native extensions are disabled")
    if event == "open" and args:
        path = args[0]
        mode = args[1] if len(args) > 1 else "r"
        flags = args[2] if len(args) > 2 else 0
        if isinstance(mode, str) and any(token in mode for token in ("w", "a", "x", "+")):
            _deny("filesystem writes are disabled")
        if isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
            _deny("filesystem writes are disabled")
        if not isinstance(path, int) and not _inside(path, (_root,) + _stdlib_roots):
            _deny("file reads must stay inside the repository or Python standard library")
    if event in {"os.listdir", "os.scandir", "os.chdir"} and args:
        if not _inside(args[0], (_root,) + _stdlib_roots):
            _deny("filesystem traversal must stay inside the repository or Python standard library")
    if event in {
        "os.remove", "os.rmdir", "os.rename", "os.replace", "os.mkdir", "os.link",
        "os.symlink", "os.chmod", "os.chown", "os.truncate", "shutil.copyfile", "shutil.copymode",
        "shutil.copystat", "shutil.rmtree", "tempfile.mkstemp", "tempfile.mkdtemp",
    }:
        _deny("filesystem mutation is disabled")


sys.addaudithook(_audit)
_source = sys.stdin.read()
exec(compile(_source, "<mantra-python>", "exec"), {"__name__": "__main__", "__builtins__": builtins.__dict__})
`;

export interface PythonRunInput {
  repositoryDirectory: string;
  source: string;
  timeoutMs?: number;
  sessionId: string;
}

export interface PythonRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function resolveRepositoryDirectory(repositoryDirectory: string, sessionId: string): string {
  const directory = repositoryDirectory.trim();
  if (!directory || directory.includes("/") || directory.includes("\\") || directory === "." || directory === "..") {
    throw new Error("repositoryDirectory must be one exact directory name inside repos/");
  }
  if (!sessionId || !directory.endsWith(`-${sessionId.slice(0, 8)}`)) {
    throw new Error("Python execution requires the current session-owned repository clone");
  }
  return resolve(WORKSPACE_DIR, "repos", directory);
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("timeoutMs must be a positive number");
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

export async function runConstrainedPython(input: PythonRunInput): Promise<PythonRunResult> {
  if (typeof input.source !== "string" || !input.source.trim()) throw new Error("source is required");
  if (input.source.length > MAX_SOURCE_CHARS) throw new Error(`source exceeds ${MAX_SOURCE_CHARS} characters`);

  const requestedRoot = resolveRepositoryDirectory(input.repositoryDirectory, input.sessionId);
  const repositoryRoot = await realpath(requestedRoot);
  const reposRoot = await realpath(join(WORKSPACE_DIR, "repos"));
  if (repositoryRoot !== join(reposRoot, basename(repositoryRoot)) || basename(repositoryRoot) !== input.repositoryDirectory) {
    throw new Error("repositoryDirectory must resolve to one direct session-owned repos/ clone");
  }

  const timeoutMs = boundedTimeout(input.timeoutMs);
  const sourceHash = createHash("sha256").update(input.source).digest("hex").slice(0, 16);
  const startedAt = Date.now();
  log.info("python.run.started", {
    repositoryDirectory: input.repositoryDirectory,
    sourceHash,
    sourceChars: input.source.length,
    timeoutMs,
  });

  return await new Promise<PythonRunResult>((resolveResult, reject) => {
    const child = spawn(BWRAP_BINARY, [
      "--die-with-parent",
      "--new-session",
      "--unshare-all",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", repositoryRoot, "/workspace",
      "--proc", "/proc",
      "--dev", "/dev",
      "--tmpfs", "/tmp",
      "--chdir", "/workspace",
      "--",
      PRLIMIT_BINARY,
      `--as=${MEMORY_LIMIT_BYTES}`,
      `--cpu=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
      `--fsize=${FILE_SIZE_LIMIT_BYTES}`,
      "--nofile=64",
      "--core=0",
      "--nproc=1",
      "--",
      PYTHON_BINARY,
      "-I",
      "-S",
      "-c",
      PYTHON_SANDBOX_BOOTSTRAP,
      "/workspace",
    ], {
      cwd: repositoryRoot,
      env: {
        HOME: repositoryRoot,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;

    const stopForOutput = () => {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      child.kill("SIGKILL");
    };
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      if (current.length + chunk.length > MAX_OUTPUT_BYTES) {
        const remaining = Math.max(0, MAX_OUTPUT_BYTES - current.length);
        stopForOutput();
        return remaining > 0 ? Buffer.concat([current, chunk.subarray(0, remaining)]) : current;
      }
      return Buffer.concat([current, chunk]);
    };

    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      log.info("python.run.finished", {
        repositoryDirectory: input.repositoryDirectory,
        sourceHash,
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        durationMs,
      });
      resolveResult({
        exitCode,
        signal,
        timedOut,
        outputLimitExceeded,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        durationMs,
      });
    });

    child.stdin.end(input.source);
  });
}
