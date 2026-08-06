import { execFile } from "child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "fs/promises";
import { constants } from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { promisify } from "util";
import { createLogger } from "./log";
import { WORKSPACE_DIR } from "./paths";

const log = createLogger("NpmDependencyMutation");
const execFileAsync = promisify(execFile);

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SAFE_PROJECT_NPM_CONFIG_LINES = new Set(["legacy-peer-deps=true"]);

export const NPM_DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "overrides",
] as const;

export type NpmDependencySection = typeof NPM_DEPENDENCY_SECTIONS[number];

export interface SetNpmPackageSpecInput {
  repositoryDirectory: string;
  manifestPath: string;
  section: NpmDependencySection;
  packageName: string;
  version: string;
  sessionId: string;
}

export interface SetNpmPackageSpecResult {
  outcome: "updated" | "unchanged";
  repositoryDirectory: string;
  manifestPath: string;
  lockfilePath: string;
  section: NpmDependencySection;
  packageName: string;
  version: string;
  lockedOccurrences: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function assertSafeInputs(input: SetNpmPackageSpecInput): void {
  if (!input.sessionId || !input.repositoryDirectory.endsWith(`-${input.sessionId.slice(0, 8)}`)) {
    throw new Error("session_owned_repository_required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(input.repositoryDirectory)) {
    throw new Error("invalid_repository_directory");
  }
  if (!SAFE_RELATIVE_PATH.test(input.manifestPath) || basename(input.manifestPath) !== "package.json") {
    throw new Error("package_manifest_required");
  }
  if (!NPM_DEPENDENCY_SECTIONS.includes(input.section)) {
    throw new Error("unsupported_dependency_section");
  }
  if (!PACKAGE_NAME.test(input.packageName) || FORBIDDEN_OBJECT_KEYS.has(input.packageName)) {
    throw new Error("invalid_package_name");
  }
  if (!EXACT_SEMVER.test(input.version)) {
    throw new Error("exact_semver_required");
  }
}

async function assertRegularFileInsideRepository(filePath: string, repositoryRoot: string, label: string): Promise<void> {
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label}_must_be_regular_file`);
  const canonical = await realpath(filePath);
  const repositoryBoundary = `${repositoryRoot}${sep}`;
  if (!canonical.startsWith(repositoryBoundary) || canonical !== filePath) {
    throw new Error(`${label}_must_not_cross_symlink`);
  }
}

async function assertSafeProjectNpmConfig(packageRoot: string, repositoryRoot: string): Promise<void> {
  let current = packageRoot;
  while (true) {
    const npmConfigPath = join(current, ".npmrc");
    if (await pathExists(npmConfigPath)) {
      await assertRegularFileInsideRepository(npmConfigPath, repositoryRoot, "project_npmrc");
      const lines = (await readFile(npmConfigPath, "utf-8"))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith(";"));
      if (lines.some((line) => !SAFE_PROJECT_NPM_CONFIG_LINES.has(line))) {
        throw new Error("project_npmrc_not_allowed");
      }
    }
    if (current === repositoryRoot) return;
    const parent = dirname(current);
    if (parent === current || !current.startsWith(`${repositoryRoot}${sep}`)) {
      throw new Error("package_root_outside_repository");
    }
    current = parent;
  }
}

function lockedPackageVersions(lockfile: Record<string, unknown>, packageName: string): string[] {
  if (!isRecord(lockfile.packages)) throw new Error("invalid_package_lock_packages");
  const suffix = `node_modules/${packageName}`;
  return Object.entries(lockfile.packages)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .map(([, value]) => isRecord(value) && typeof value.version === "string" ? value.version : "")
    .filter(Boolean);
}

function assertLockfileReflectsMutation(
  lockfile: Record<string, unknown>,
  section: NpmDependencySection,
  packageName: string,
  version: string,
): number {
  if (!isRecord(lockfile.packages) || !isRecord(lockfile.packages[""])) {
    throw new Error("invalid_package_lock_root");
  }
  const rootPackage = lockfile.packages[""] as Record<string, unknown>;
  if (section !== "overrides") {
    const lockedSection = rootPackage[section];
    if (!isRecord(lockedSection) || lockedSection[packageName] !== version) {
      throw new Error("package_lock_manifest_projection_mismatch");
    }
  }

  const versions = lockedPackageVersions(lockfile, packageName);
  if (versions.length === 0) throw new Error("package_not_resolved_in_lockfile");
  if (section === "overrides" && !versions.includes(version)) {
    throw new Error("package_lock_version_mismatch");
  }
  return versions.length;
}

async function restoreFile(path: string, original: string | null): Promise<void> {
  if (original === null) {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, original, "utf-8");
}

export async function setNpmPackageSpec(input: SetNpmPackageSpecInput): Promise<SetNpmPackageSpecResult> {
  assertSafeInputs(input);

  const repositoriesRoot = resolve(WORKSPACE_DIR, "repos");
  const repositoryRoot = resolve(repositoriesRoot, input.repositoryDirectory);
  if (relative(repositoriesRoot, repositoryRoot).startsWith("..")) throw new Error("repository_outside_workspace");
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  if (canonicalRepositoryRoot !== repositoryRoot) throw new Error("repository_root_must_not_cross_symlink");

  const manifestPath = resolve(repositoryRoot, input.manifestPath);
  const packageRoot = dirname(manifestPath);
  if (manifestPath !== join(repositoryRoot, "package.json") && !manifestPath.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error("manifest_outside_repository");
  }

  const lockfilePath = join(packageRoot, "package-lock.json");
  const packageNodeModules = join(packageRoot, "node_modules");
  const isRepositoryRootPackage = packageRoot === repositoryRoot;
  await assertRegularFileInsideRepository(manifestPath, repositoryRoot, "manifest");
  await assertRegularFileInsideRepository(lockfilePath, repositoryRoot, "lockfile");
  await assertSafeProjectNpmConfig(packageRoot, repositoryRoot);
  if (await pathExists(packageNodeModules)) {
    if (!isRepositoryRootPackage) throw new Error("package_node_modules_must_be_absent");
    const stats = await lstat(packageNodeModules);
    const canonicalNodeModules = await realpath(packageNodeModules);
    if (!stats.isSymbolicLink() || canonicalNodeModules !== resolve(WORKSPACE_DIR, "node_modules")) {
      throw new Error("repository_root_node_modules_must_use_immutable_toolchain");
    }
  }

  const originalManifest = await readFile(manifestPath, "utf-8");
  const originalLockfile = await readFile(lockfilePath, "utf-8");
  let mutationCommitted = false;
  let tempRoot: string | null = null;

  try {
    const manifest = JSON.parse(originalManifest) as unknown;
    if (!isRecord(manifest)) throw new Error("invalid_package_manifest");
    const existingSection = manifest[input.section];
    if (existingSection !== undefined && !isRecord(existingSection)) {
      throw new Error("dependency_section_must_be_object");
    }
    const section = existingSection as Record<string, unknown> | undefined ?? {};
    Object.defineProperty(section, input.packageName, {
      value: input.version,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    manifest[input.section] = section;
    const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, nextManifest, "utf-8");

    const tempParent = resolve(WORKSPACE_DIR, ".tmp", "npm-dependencies");
    await mkdir(tempParent, { recursive: true });
    tempRoot = await mkdtemp(join(tempParent, "run-"));
    const npmCache = join(tempRoot, "cache");
    const npmHome = join(tempRoot, "home");
    const npmUserConfig = join(tempRoot, "user.npmrc");
    const npmGlobalConfig = join(tempRoot, "global.npmrc");
    await mkdir(npmCache, { recursive: true });
    await mkdir(npmHome, { recursive: true });
    await writeFile(npmUserConfig, "", "utf-8");
    await writeFile(npmGlobalConfig, "", "utf-8");

    await execFileAsync("npm", [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
    ], {
      cwd: packageRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: npmHome,
        TMPDIR: tempRoot,
        LANG: process.env.LANG || "C.UTF-8",
        LC_ALL: process.env.LC_ALL || process.env.LANG || "C.UTF-8",
        CI: "1",
        NO_COLOR: "1",
        NPM_CONFIG_USERCONFIG: npmUserConfig,
        NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
        NPM_CONFIG_CACHE: npmCache,
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_PACKAGE_LOCK_ONLY: "true",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        NPM_CONFIG_LEGACY_PEER_DEPS: "true",
      },
    });

    if (await pathExists(packageNodeModules)) {
      await rm(packageNodeModules, { recursive: true, force: true });
      throw new Error("npm_created_forbidden_node_modules");
    }

    const finalManifest = await readFile(manifestPath, "utf-8");
    const finalLockfile = await readFile(lockfilePath, "utf-8");
    const parsedManifest = JSON.parse(finalManifest) as unknown;
    const parsedLockfile = JSON.parse(finalLockfile) as unknown;
    if (!isRecord(parsedManifest) || !isRecord(parsedManifest[input.section]) || (parsedManifest[input.section] as Record<string, unknown>)[input.packageName] !== input.version) {
      throw new Error("manifest_mutation_mismatch");
    }
    if (!isRecord(parsedLockfile)) throw new Error("invalid_package_lock");
    const lockedOccurrences = assertLockfileReflectsMutation(parsedLockfile, input.section, input.packageName, input.version);

    mutationCommitted = true;
    const outcome = finalManifest === originalManifest && finalLockfile === originalLockfile ? "unchanged" : "updated";
    log.info("npm dependency mutation completed", {
      outcome,
      repositoryDirectory: input.repositoryDirectory,
      manifestPath: input.manifestPath,
      section: input.section,
      packageName: input.packageName,
      version: input.version,
      lockedOccurrences,
    });
    return {
      outcome,
      repositoryDirectory: input.repositoryDirectory,
      manifestPath: input.manifestPath,
      lockfilePath: relative(repositoryRoot, lockfilePath),
      section: input.section,
      packageName: input.packageName,
      version: input.version,
      lockedOccurrences,
    };
  } catch (error) {
    log.error("npm dependency mutation failed", {
      repositoryDirectory: input.repositoryDirectory,
      manifestPath: input.manifestPath,
      section: input.section,
      packageName: input.packageName,
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorCode: error instanceof Error ? error.message : "unknown_error",
    });
    throw error;
  } finally {
    if (!mutationCommitted) {
      await restoreFile(manifestPath, originalManifest);
      await restoreFile(lockfilePath, originalLockfile);
      if (!isRepositoryRootPackage && await pathExists(packageNodeModules)) {
        await rm(packageNodeModules, { recursive: true, force: true });
      }
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}
