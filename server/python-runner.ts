import { createHash } from "crypto";
import { realpath } from "fs/promises";
import { basename, join, resolve } from "path";
import { spawn } from "child_process";
import { createLogger } from "./log";
import { WORKSPACE_DIR } from "./paths";

const log = createLogger("PythonRunner");

const PYTHON_BINARY = "/usr/bin/python3";
const PRLIMIT_BINARY = "/usr/bin/prlimit";
const MAX_SOURCE_CHARS = 50_000;
const MAX_OUTPUT_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const FILE_SIZE_LIMIT_BYTES = 1 * 1024 * 1024;

const PYTHON_SANDBOX_BOOTSTRAP = String.raw`
import builtins
import ctypes
import errno
import os
import platform
import sys

_root = os.path.realpath(sys.argv[1])
_stdlib_roots = tuple(
    os.path.realpath(path)
    for path in sys.path
    if path and os.path.exists(path)
)
_realpath = os.path.realpath
_fspath = os.fspath
_libc = ctypes.CDLL(None, use_errno=True)

_PR_SET_NO_NEW_PRIVS = 38
_LANDLOCK_CREATE_RULESET_VERSION = 1
_LANDLOCK_RULE_PATH_BENEATH = 1
_LANDLOCK_ACCESS_FS_EXECUTE = 1 << 0
_LANDLOCK_ACCESS_FS_WRITE_FILE = 1 << 1
_LANDLOCK_ACCESS_FS_READ_FILE = 1 << 2
_LANDLOCK_ACCESS_FS_READ_DIR = 1 << 3
_LANDLOCK_ACCESS_FS_REMOVE_DIR = 1 << 4
_LANDLOCK_ACCESS_FS_REMOVE_FILE = 1 << 5
_LANDLOCK_ACCESS_FS_MAKE_CHAR = 1 << 6
_LANDLOCK_ACCESS_FS_MAKE_DIR = 1 << 7
_LANDLOCK_ACCESS_FS_MAKE_REG = 1 << 8
_LANDLOCK_ACCESS_FS_MAKE_SOCK = 1 << 9
_LANDLOCK_ACCESS_FS_MAKE_FIFO = 1 << 10
_LANDLOCK_ACCESS_FS_MAKE_BLOCK = 1 << 11
_LANDLOCK_ACCESS_FS_MAKE_SYM = 1 << 12
_LANDLOCK_ACCESS_FS_REFER = 1 << 13
_LANDLOCK_ACCESS_FS_TRUNCATE = 1 << 14
_LANDLOCK_ACCESS_FS_IOCTL_DEV = 1 << 15
_LANDLOCK_READ = _LANDLOCK_ACCESS_FS_READ_FILE | _LANDLOCK_ACCESS_FS_READ_DIR
_LANDLOCK_ALL = (1 << 16) - 1


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class _PathBeneathAttr(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def _syscall_number(name):
    machine = platform.machine().lower()
    numbers = {
        "x86_64": {"create": 444, "add": 445, "restrict": 446},
        "amd64": {"create": 444, "add": 445, "restrict": 446},
        "aarch64": {"create": 444, "add": 445, "restrict": 446},
        "arm64": {"create": 444, "add": 445, "restrict": 446},
    }.get(machine)
    if not numbers:
        raise RuntimeError("unsupported kernel architecture: " + machine)
    return numbers[name]


def _checked_syscall(number, *args):
    result = _libc.syscall(number, *args)
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return result


def _restrict_filesystem():
    version = _checked_syscall(_syscall_number("create"), 0, 0, _LANDLOCK_CREATE_RULESET_VERSION)
    handled = (1 << 13) - 1
    if version >= 2:
        handled |= _LANDLOCK_ACCESS_FS_REFER
    if version >= 3:
        handled |= _LANDLOCK_ACCESS_FS_TRUNCATE
    if version >= 5:
        handled |= _LANDLOCK_ACCESS_FS_IOCTL_DEV
    ruleset_attr = _RulesetAttr(handled)
    ruleset_fd = _checked_syscall(
        _syscall_number("create"), ctypes.byref(ruleset_attr), ctypes.sizeof(ruleset_attr), 0
    )
    try:
        for path in (_root,) + _stdlib_roots:
            parent_fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
            try:
                rule = _PathBeneathAttr(_LANDLOCK_READ & handled, parent_fd)
                _checked_syscall(
                    _syscall_number("add"), ruleset_fd, _LANDLOCK_RULE_PATH_BENEATH,
                    ctypes.byref(rule), 0
                )
            finally:
                os.close(parent_fd)
        if _libc.prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        _checked_syscall(_syscall_number("restrict"), ruleset_fd, 0)
    finally:
        os.close(ruleset_fd)


def _install_seccomp_network_deny():
    # Classic BPF over seccomp_data: load syscall number, deny socket/socketpair,
    # otherwise allow. exec/fork remain denied independently by the Python audit hook
    # and RLIMIT_NPROC; the kernel filter carries the network boundary.
    machine = platform.machine().lower()
    syscall_numbers = {
        "x86_64": (41, 53), "amd64": (41, 53),
        "aarch64": (198, 199), "arm64": (198, 199),
    }.get(machine)
    if not syscall_numbers:
        raise RuntimeError("unsupported seccomp architecture: " + machine)

    class _SockFilter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]

    class _SockFprog(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(_SockFilter))]

    deny = 0x00050000 | errno.EPERM
    allow = 0x7FFF0000
    filters = (_SockFilter * 6)(
        _SockFilter(0x20, 0, 0, 0),
        _SockFilter(0x15, 0, 1, syscall_numbers[0]),
        _SockFilter(0x06, 0, 0, deny),
        _SockFilter(0x15, 0, 1, syscall_numbers[1]),
        _SockFilter(0x06, 0, 0, deny),
        _SockFilter(0x06, 0, 0, allow),
    )
    program = _SockFprog(len(filters), filters)
    if _libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def _inside(path, roots):
    try:
        candidate = _realpath(_fspath(path))
    except (TypeError, ValueError, OSError):
        return False
    return any(candidate == root or candidate.startswith(root + os.sep) for root in roots)


def _deny(message):
    raise PermissionError("Mantra Python sandbox: " + message)


def _audit(event, args):
    if event == "import" and args and args[0] in {"ctypes", "_ctypes"}:
        _deny("native foreign-function access is disabled")
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


_source = sys.stdin.read()
sys.addaudithook(_audit)
_restrict_filesystem()
_install_seccomp_network_deny()
for _module_name in ("ctypes", "_ctypes"):
    sys.modules.pop(_module_name, None)
del ctypes
del _libc
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
    const child = spawn(PRLIMIT_BINARY, [
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
      repositoryRoot,
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
