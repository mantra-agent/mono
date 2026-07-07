import { createLogger } from "../log";
import { getSecret } from "../secrets-store";
import { getSetting, setSetting } from "../system-settings";
import { db } from "../db";
import { getEnvironmentBuildLifecycleConfig } from "../platforms/build-lifecycle-service";
import { spawn, execFileSync, execSync } from "child_process";
import * as pty from "@lydell/node-pty";
import path from "path";
import { getAuthenticatedGitUrl } from "../github-auth";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { and, eq } from "drizzle-orm";
import { environmentHostingBindings, platformProductEnvironments, platformProducts, platforms } from "@shared/models/platforms";

const log = createLogger("Expo");

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export async function getExpoToken(): Promise<string | undefined> {
  return getSecret("EXPO_ACCESS_TOKEN");
}


// ---------------------------------------------------------------------------
// Apple credentials setup config
// ---------------------------------------------------------------------------

const APPLE_CREDENTIALS_CONFIG_KEY = "system.expo.appleCredentialsConfig";
const EAS_RUN_STATE_KEY = "system.expo.latestEasRun";
const MAIN_BUILD_WORKSPACE_ROOT = path.resolve(process.cwd(), ".tmp", "mobile-build-main");

type MobileBuildSource = "local" | "main"; // "local" retained only for historical/interrupted run snapshots.

type MobileBackendTarget = "production" | "development";

const MOBILE_PLATFORM_ENVIRONMENT_ID = Number.parseInt(process.env.MOBILE_PLATFORM_ENVIRONMENT_ID || "", 10);
const DEFAULT_MOBILE_PLATFORM_NAME = process.env.MOBILE_PLATFORM_NAME || "Mantra";
const DEFAULT_MOBILE_PRODUCT_NAME = process.env.MOBILE_PLATFORM_PRODUCT_NAME || "Mobile";
const DEFAULT_MOBILE_ENVIRONMENT_NAME = process.env.MOBILE_PLATFORM_ENVIRONMENT_NAME || "dev";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

async function resolveDefaultMobileEnvironmentId(): Promise<number | null> {
  if (Number.isFinite(MOBILE_PLATFORM_ENVIRONMENT_ID) && MOBILE_PLATFORM_ENVIRONMENT_ID > 0) {
    return MOBILE_PLATFORM_ENVIRONMENT_ID;
  }

  const [row] = await db
    .select({ id: platformProductEnvironments.id })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .where(and(
      eq(platforms.name, DEFAULT_MOBILE_PLATFORM_NAME),
      eq(platformProducts.name, DEFAULT_MOBILE_PRODUCT_NAME),
      eq(platformProductEnvironments.name, DEFAULT_MOBILE_ENVIRONMENT_NAME),
    ))
    .limit(1);
  return row?.id ?? null;
}

async function getEnvironmentPublicUrl(environmentId: number): Promise<string | null> {
  const [hosting] = await db
    .select({ publicUrl: environmentHostingBindings.publicUrl, staticUrl: environmentHostingBindings.staticUrl })
    .from(environmentHostingBindings)
    .where(eq(environmentHostingBindings.environmentId, environmentId))
    .limit(1);
  const url = hosting?.publicUrl || hosting?.staticUrl || "";
  return url.trim() ? normalizeUrl(url) : null;
}

async function resolveMobileBuildEnvironment(profile: string): Promise<{ serverUrl: string; backendTarget: MobileBackendTarget; environmentId: number } | null> {
  const mobileEnvironmentId = await resolveDefaultMobileEnvironmentId();
  if (!mobileEnvironmentId) {
    log.warn("Mobile platform environment not found; leaving EAS profile env unchanged", {
      platform: DEFAULT_MOBILE_PLATFORM_NAME,
      product: DEFAULT_MOBILE_PRODUCT_NAME,
      environment: DEFAULT_MOBILE_ENVIRONMENT_NAME,
    });
    return null;
  }

  const lifecycle = await getEnvironmentBuildLifecycleConfig(mobileEnvironmentId);
  const deployPolicy = isRecord(lifecycle?.config?.deployPolicy) ? lifecycle.config.deployPolicy : {};
  const mobile = isRecord(deployPolicy.mobile) ? deployPolicy.mobile : {};
  const backendEnvironmentByProfile = isRecord(mobile.backendEnvironmentByProfile) ? mobile.backendEnvironmentByProfile : {};
  const backendTargetByProfile = isRecord(mobile.backendTargetByProfile) ? mobile.backendTargetByProfile : {};

  const backendEnvironmentId = numberFromRecord(backendEnvironmentByProfile, profile)
    ?? numberFromRecord(backendEnvironmentByProfile, "default")
    ?? mobileEnvironmentId;
  const target = stringFromRecord(backendTargetByProfile, profile)
    ?? stringFromRecord(backendTargetByProfile, "default")
    ?? (profile === "development" ? "development" : "production");
  const backendTarget: MobileBackendTarget = target === "development" ? "development" : "production";
  const serverUrl = await getEnvironmentPublicUrl(backendEnvironmentId);
  if (!serverUrl) {
    log.warn("Mobile backend environment has no public URL; leaving EAS profile env unchanged", {
      mobileEnvironmentId,
      backendEnvironmentId,
      profile,
    });
    return null;
  }

  return { serverUrl, backendTarget, environmentId: backendEnvironmentId };
}

async function applyMobilePlatformEnvironmentToEasProfile(mobileDir: string, profile: string): Promise<void> {
  const resolved = await resolveMobileBuildEnvironment(profile);
  if (!resolved) return;

  const easJsonPath = path.join(mobileDir, "eas.json");
  if (!existsSync(easJsonPath)) {
    log.warn("mobile/eas.json not found; cannot inject platform mobile environment config", { mobileDir, profile });
    return;
  }

  const raw = readFileSync(easJsonPath, "utf-8");
  const parsed = JSON.parse(raw) as { build?: Record<string, { env?: Record<string, string> }> };
  parsed.build ||= {};
  parsed.build[profile] ||= {};
  parsed.build[profile].env ||= {};
  parsed.build[profile].env.EXPO_PUBLIC_BACKEND_TARGET = resolved.backendTarget;
  parsed.build[profile].env.EXPO_PUBLIC_SERVER_URL = resolved.serverUrl;
  writeFileSync(easJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");

  log.log("Injected Platforms Mobile environment into EAS profile", {
    mobileEnvironment: `${DEFAULT_MOBILE_PLATFORM_NAME}/${DEFAULT_MOBILE_PRODUCT_NAME}/${DEFAULT_MOBILE_ENVIRONMENT_NAME}`,
    backendEnvironmentId: resolved.environmentId,
    profile,
    backendTarget: resolved.backendTarget,
    serverUrl: resolved.serverUrl,
  });
}

export interface ExpoAppleCredentialsConfig {
  appleIdEmail: string;
  teamId: string;
  bundleIdentifier: string;
  updatedAt?: string;
}

function sanitizeAppleCredentialsConfig(input: Partial<ExpoAppleCredentialsConfig>): ExpoAppleCredentialsConfig {
  const appleIdEmail = String(input.appleIdEmail || "").trim();
  const teamId = String(input.teamId || "").trim();
  const bundleIdentifier = String(input.bundleIdentifier || "").trim();

  if (!appleIdEmail || !appleIdEmail.includes("@")) {
    throw new Error("Apple ID email is required");
  }
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("Apple Team ID must be the 10-character Apple Developer Team ID");
  }
  if (!bundleIdentifier || !/^[A-Za-z0-9][A-Za-z0-9.-]+[A-Za-z0-9]$/.test(bundleIdentifier)) {
    throw new Error("Bundle identifier is required, for example com.raykallmeyer.firstglasses");
  }

  return { appleIdEmail, teamId, bundleIdentifier, updatedAt: new Date().toISOString() };
}

export async function getAppleCredentialsConfig(): Promise<ExpoAppleCredentialsConfig | null> {
  return getSetting<ExpoAppleCredentialsConfig>(APPLE_CREDENTIALS_CONFIG_KEY);
}

export async function saveAppleCredentialsConfig(input: Partial<ExpoAppleCredentialsConfig>): Promise<ExpoAppleCredentialsConfig> {
  const config = sanitizeAppleCredentialsConfig(input);
  await setSetting(APPLE_CREDENTIALS_CONFIG_KEY, config);
  return config;
}

export function redactAppleCredentialsConfig(config: ExpoAppleCredentialsConfig | null): (ExpoAppleCredentialsConfig & { configured: true }) | { configured: false } {
  if (!config) return { configured: false };
  return { ...config, configured: true };
}

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

async function expoGraphQL<T = any>(
  query: string,
  variables?: Record<string, any>,
): Promise<T> {
  const token = await getExpoToken();
  if (!token) throw new Error("No Expo access token configured");
  const resp = await fetch("https://api.expo.dev/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Expo API ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  if (json.errors?.length) {
    throw new Error(`Expo GraphQL: ${json.errors[0].message}`);
  }
  return json.data as T;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface ExpoAccount {
  id: string;
  name: string;
}

export interface ExpoViewer {
  id: string;
  username: string;
  primaryAccount: ExpoAccount;
  accounts: ExpoAccount[];
}

export async function getViewer(): Promise<ExpoViewer> {
  const data = await expoGraphQL<{ viewer: ExpoViewer }>(
    `query { viewer { id username primaryAccount { id name } accounts { id name } } }`,
  );
  return data.viewer;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ExpoProject {
  id: string;
  name: string;
  slug: string;
  fullName: string;
  accountName: string;
}

export async function listProjects(): Promise<ExpoProject[]> {
  const config = getProjectConfig();
  if (!config.projectId) return [];
  const data = await expoGraphQL<{ app: { byId: (ExpoProject & { ownerAccount?: ExpoAccount | null }) | null } }>(
    `query($appId: String!) {
      app {
        byId(appId: $appId) {
          id
          name
          slug
          ownerAccount { id name }
        }
      }
    }`,
    { appId: config.projectId },
  );
  const app = data.app?.byId;
  if (!app) return [];
  const accountName = app.ownerAccount?.name || config.owner || "";
  return [{
    id: app.id,
    name: app.name,
    slug: app.slug,
    fullName: accountName ? `@${accountName}/${app.slug}` : app.slug,
    accountName,
  }];
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

export interface ExpoBuild {
  id: string;
  status: string;
  platform: string;
  distribution: string;
  buildProfile: string;
  appVersion: string;
  appBuildVersion?: string | null;
  sdkVersion?: string | null;
  gitCommitHash?: string | null;
  gitCommitMessage?: string | null;
  message?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expirationDate: string | null;
  logFiles?: string[];
  artifacts: {
    buildUrl: string | null;
    installUrl?: string | null;
    logsUrl?: string | null;
    xcodeBuildLogsUrl?: string | null;
    applicationArchiveUrl?: string | null;
    buildArtifactsUrl?: string | null;
  } | null;
  error: { errorCode?: string | null; message: string; buildPhase?: string | null; docsUrl?: string | null } | null;
  project?: {
    id: string;
    name: string;
    slug: string;
    ownerAccount?: { id: string; name: string } | null;
  };
}

const EXPO_BUILD_FIELDS = `
  id status platform distribution buildProfile appVersion appBuildVersion sdkVersion
  gitCommitHash gitCommitMessage message createdAt updatedAt completedAt expirationDate
  logFiles
  artifacts { buildUrl xcodeBuildLogsUrl applicationArchiveUrl buildArtifactsUrl }
  error { errorCode message buildPhase docsUrl }
  project {
    __typename
    id
    name
    slug
    ... on App { ownerAccount { id name } }
  }
`;

function getExpoBuildPageUrl(build: ExpoBuild): string {
  const owner = build.project?.ownerAccount?.name;
  const slug = build.project?.slug;
  return owner && slug
    ? `https://expo.dev/accounts/${encodeURIComponent(owner)}/projects/${encodeURIComponent(slug)}/builds/${encodeURIComponent(build.id)}`
    : `https://expo.dev/builds/${encodeURIComponent(build.id)}`;
}

function withExpoInstallUrls(build: ExpoBuild): ExpoBuild {
  const buildPageUrl = getExpoBuildPageUrl(build);
  return {
    ...build,
    artifacts: {
      ...(build.artifacts || { buildUrl: null }),
      installUrl: buildPageUrl,
      logsUrl: buildPageUrl,
    },
  };
}

export async function listBuilds(
  projectId: string,
  limit = 10,
): Promise<ExpoBuild[]> {
  const data = await expoGraphQL<{ app: { byId: { builds: ExpoBuild[] } | null } }>(
    `query($appId: String!, $offset: Int!, $limit: Int!) {
      app {
        byId(appId: $appId) {
          id
          builds(offset: $offset, limit: $limit) {
            ${EXPO_BUILD_FIELDS}
          }
        }
      }
    }`,
    { appId: projectId, offset: 0, limit },
  );
  return (data.app?.byId?.builds || []).map(withExpoInstallUrls);
}


const CANCELLABLE_EAS_STATUSES = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS"]);

export interface ExpoCancelledBuild {
  id: string;
  previousStatus: string;
  status: string;
  platform: string;
  buildProfile: string;
}

export interface CancelExpoBuildsOptions {
  projectId?: string;
  platform?: string;
  profile?: string;
  limit?: number;
}

function normalizeExpoStatus(status: string | null | undefined): string {
  return String(status || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function normalizeExpoField(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function isCancellableBuild(build: ExpoBuild, platform?: string, profile?: string): boolean {
  if (!CANCELLABLE_EAS_STATUSES.has(normalizeExpoStatus(build.status))) return false;
  if (platform && normalizeExpoField(build.platform) !== normalizeExpoField(platform)) return false;
  if (profile && normalizeExpoField(build.buildProfile) !== normalizeExpoField(profile)) return false;
  return true;
}

export async function cancelBuild(buildId: string): Promise<Pick<ExpoBuild, "id" | "status">> {
  const id = String(buildId || "").trim();
  if (!id) throw new Error("Expo buildId is required");
  const data = await expoGraphQL<{ build: { cancel: Pick<ExpoBuild, "id" | "status"> | null } | null }>(
    `mutation CancelBuildMutation($buildId: ID!) {
      build(buildId: $buildId) {
        cancel {
          id
          status
        }
      }
    }`,
    { buildId: id },
  );
  const cancelled = data.build?.cancel;
  if (!cancelled) throw new Error(`Expo build could not be cancelled: ${id}`);
  return cancelled;
}

export async function cancelInProgressBuilds(options: CancelExpoBuildsOptions = {}): Promise<ExpoCancelledBuild[]> {
  const projectId = options.projectId || getProjectConfig().projectId;
  if (!projectId) throw new Error("Expo projectId is required to cancel in-progress builds");

  const builds = await listBuilds(projectId, Math.min(50, Math.max(1, options.limit || 25)));
  const cancellable = builds.filter((build) => isCancellableBuild(build, options.platform, options.profile));
  const cancelled: ExpoCancelledBuild[] = [];

  for (const build of cancellable) {
    try {
      const result = await cancelBuild(build.id);
      cancelled.push({
        id: build.id,
        previousStatus: build.status,
        status: result.status,
        platform: build.platform,
        buildProfile: build.buildProfile,
      });
    } catch (err: any) {
      log.warn("Unable to cancel Expo build before replacement build", {
        buildId: build.id,
        status: build.status,
        platform: build.platform,
        buildProfile: build.buildProfile,
        error: err?.message || String(err),
      });
    }
  }

  if (cancelled.length > 0) {
    log.log("Cancelled existing Expo builds before starting replacement", {
      projectId,
      platform: options.platform || null,
      profile: options.profile || null,
      cancelled,
    });
  }

  return cancelled;
}

export async function getBuild(buildId: string): Promise<ExpoBuild> {
  const data = await expoGraphQL<{ builds: { byId: ExpoBuild | null } }>(
    `query($buildId: ID!) {
      builds {
        byId(buildId: $buildId) {
          ${EXPO_BUILD_FIELDS}
        }
      }
    }`,
    { buildId },
  );
  const build = data.builds?.byId;
  if (!build) throw new Error(`Expo build not found: ${buildId}`);
  return withExpoInstallUrls(build);
}

export interface ExpoBuildLogReport {
  build: ExpoBuild;
  fetchedUrls: string[];
  failedUrls: Array<{ url: string; error: string }>;
  excerpts: string[];
  textBytes: number;
}

function collectErrorExcerpts(text: string, maxExcerpts = 80): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const patterns = [
    /\berror:/i,
    /fatal error/i,
    /build failed/i,
    /the following build commands failed/i,
    /\bfailed because/i,
    /\bSwiftCompile\b/i,
    /not marked with 'await'/i,
    /deprecated-declarations/i,
    /Run fastlane/i,
    /xcodebuild/i,
  ];
  const picked: string[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!patterns.some((re) => re.test(lines[i]))) continue;
    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length, i + 4);
    const key = start * 100000 + end;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(lines.slice(start, end).join("\n").trim());
    if (picked.length >= maxExcerpts) break;
  }
  return picked.filter(Boolean);
}

async function fetchExpoLogText(url: string, token: string): Promise<string> {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text().then((t) => t.slice(0, 500)).catch(() => "")}`);
  return resp.text();
}

export async function getBuildLogReport(buildId: string): Promise<ExpoBuildLogReport> {
  const token = await getExpoToken();
  if (!token) throw new Error("No Expo access token configured");
  const build = await getBuild(buildId);
  const urls = Array.from(new Set([
    build.artifacts?.xcodeBuildLogsUrl,
    build.artifacts?.buildArtifactsUrl,
    ...(build.logFiles || []),
  ].filter((value): value is string => typeof value === "string" && value.length > 0)));

  const fetchedUrls: string[] = [];
  const failedUrls: Array<{ url: string; error: string }> = [];
  const excerpts: string[] = [];
  let textBytes = 0;

  for (const url of urls) {
    try {
      const text = await fetchExpoLogText(url, token);
      fetchedUrls.push(url);
      textBytes += Buffer.byteLength(text);
      const urlExcerpts = collectErrorExcerpts(text);
      if (urlExcerpts.length > 0) {
        excerpts.push(`URL: ${url}\n${urlExcerpts.join("\n\n---\n\n")}`);
      }
    } catch (err: any) {
      failedUrls.push({ url, error: err?.message || String(err) });
    }
  }

  return { build, fetchedUrls, failedUrls, excerpts, textBytes };
}

// ---------------------------------------------------------------------------
// EAS CLI wrapper
// ---------------------------------------------------------------------------

const MOBILE_DIR = path.resolve(process.cwd(), "mobile");

interface EasArchiveRisk {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  ignoredByRoot: boolean;
  ignoredByMobile: boolean;
}

const EAS_ARCHIVE_MAX_BYTES = 1.75 * 1024 * 1024 * 1024;
const EAS_ARCHIVE_WARN_BYTES = 50 * 1024 * 1024;
const EAS_ARCHIVE_RISK_PATHS = [
  "mobile/node_modules",
  "node_modules",
  ".git",
  "dist",
  "uploads",
  "project-files",
  ".canvas",
  ".claude",
  ".agents",
  "data",
  "logs",
  "server",
  "client",
  "docs",
  "migrations",
  "scripts",
  "script",
  "config",
  "workspace",
  "agents",
];

const ROOT_REQUIRED_EAS_IGNORE_PATTERNS = [
  "uploads/",
  ".git/",
  "node_modules/",
  "mobile/node_modules/",
  "server/",
  "client/",
  "dist/",
];

const MOBILE_REQUIRED_EAS_IGNORE_PATTERNS = [
  "node_modules/",
  "../node_modules/",
  "../uploads/",
  "../.git/",
  "../server/",
  "../client/",
  "../dist/",
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function sizePathBytes(targetPath: string, depth = 0): number {
  const stat = statSync(targetPath);
  if (!stat.isDirectory()) return stat.size;

  let total = 0;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const childPath = path.join(targetPath, entry.name);
    try {
      // EAS can traverse real dependency directories. Symlink metadata alone is not
      // enough signal, so follow symlinks once and cap recursion through cycles.
      if (entry.isSymbolicLink()) {
        if (depth > 6) continue;
        total += sizePathBytes(childPath, depth + 1);
      } else if (entry.isDirectory()) {
        total += sizePathBytes(childPath, depth + 1);
      } else {
        total += statSync(childPath).size;
      }
    } catch (err: any) {
      log.warn("Unable to size EAS archive candidate", { path: childPath, error: err.message });
    }
  }
  return total;
}

function readIgnoreFile(ignorePath: string): string {
  if (!existsSync(ignorePath)) return "";
  return readFileSync(ignorePath, "utf-8");
}

function ignoreContains(ignoreContent: string, requiredPattern: string): boolean {
  return ignoreContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === requiredPattern);
}

function hasCoverageForRisk(risk: string, rootIgnore: string, mobileIgnore: string): { ignoredByRoot: boolean; ignoredByMobile: boolean } {
  const ignoredByRoot = ignoreContains(rootIgnore, `${risk}/`) || ignoreContains(rootIgnore, `${risk}`);
  const mobilePattern = risk.startsWith("mobile/")
    ? `${risk.replace(/^mobile\//, "")}/`
    : `../${risk}/`;
  const ignoredByMobile = ignoreContains(mobileIgnore, mobilePattern) || ignoreContains(mobileIgnore, mobilePattern.replace(/\/$/, ""));
  return { ignoredByRoot, ignoredByMobile };
}

function getMobileDirForSource(source: MobileBuildSource): string {
  return source === "main" ? path.join(MAIN_BUILD_WORKSPACE_ROOT, "latest", "mobile") : MOBILE_DIR;
}

function createMainBuildWorkspacePath(): string {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return path.join(MAIN_BUILD_WORKSPACE_ROOT, runId);
}


function runMobileDependencyInstall(mobileDir: string): void {
  const packageLockPath = path.join(mobileDir, "package-lock.json");
  const packageJsonPath = path.join(mobileDir, "package.json");
  if (!existsSync(packageJsonPath) || !existsSync(packageLockPath)) {
    throw new Error(`Mobile dependency install requires package.json and package-lock.json in ${mobileDir}`);
  }

  log.log("Installing Mobile build workspace dependencies from mobile/package-lock.json", { mobileDir });
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: mobileDir,
    stdio: "pipe",
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
  log.log("Installed Mobile build workspace dependencies", { mobileDir });
}

function assertMobilePluginDependencies(mobileDir: string): void {
  const requiredPlugins = ["expo-router"];
  const missingPlugins = requiredPlugins.filter((pluginName) => !existsSync(path.join(mobileDir, "node_modules", pluginName)));
  if (missingPlugins.length > 0) {
    throw new Error([
      "Mobile build workspace dependencies are incomplete.",
      `Missing config plugin modules: ${missingPlugins.join(", ")}.`,
      `Workspace: ${mobileDir}.`,
    ].join(" "));
  }
}

function ensureMobileDependencyLink(mobileDir: string): void {
  const rootNodeModules = path.join(process.cwd(), "node_modules");
  const mobileNodeModules = path.join(mobileDir, "node_modules");
  const requiredModules = [
    path.join(rootNodeModules, "@expo", "config-plugins", "build", "utils", "Updates.js"),
    path.join(rootNodeModules, "@expo", "config-plugins", "build", "index.js"),
    path.join(rootNodeModules, ".bin", "eas"),
  ];
  const missingRequired = requiredModules.filter((modulePath) => !existsSync(modulePath));
  if (missingRequired.length > 0) {
    throw new Error([
      "Local Mobile build dependencies are incomplete in the deployed runtime.",
      `Missing: ${missingRequired.join(", ")}.`,
      "Publish a fresh live deployment so Railway hydrates /app/node_modules from package-lock.json, then retry Local. Main builds can still run from a fresh GitHub checkout.",
    ].join(" "));
  }

  if (mobileNodeModules === rootNodeModules) return;
  let existingStat: ReturnType<typeof lstatSync> | null = null;
  try {
    existingStat = lstatSync(mobileNodeModules);
  } catch {
    existingStat = null;
  }
  if (existingStat) {
    if (existingStat.isSymbolicLink()) return;
    if (existingStat.isDirectory()) {
      log.warn("Mobile local dependencies are a real directory; leaving them in place", { mobileNodeModules });
      return;
    }
    throw new Error(`Local Mobile dependency path exists but is not a directory or symlink: ${mobileNodeModules}`);
  }

  symlinkSync(rootNodeModules, mobileNodeModules, "dir");
  log.log("Linked Local Mobile dependencies to runtime node_modules", {
    from: rootNodeModules,
    to: mobileNodeModules,
  });
}

async function prepareMainBuildWorkspace(): Promise<{ mobileDir: string; sourceRef: string }> {
  const repoUrl = process.env.GITHUB_REPO_URL;
  if (!repoUrl) {
    throw new Error("GITHUB_REPO_URL is required to prepare a Mobile build workspace from main.");
  }
  const authenticatedUrl = await getAuthenticatedGitUrl(repoUrl);
  const workspace = createMainBuildWorkspacePath();
  mkdirSync(MAIN_BUILD_WORKSPACE_ROOT, { recursive: true });
  log.log("Preparing Mobile build workspace from GitHub main", { repoUrl, workspace });
  execSync(`git clone --depth 1 --branch main ${JSON.stringify(authenticatedUrl)} ${JSON.stringify(workspace)}`, {
    cwd: process.cwd(),
    stdio: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  const mobileDir = path.join(workspace, "mobile");
  runMobileDependencyInstall(mobileDir);
  assertMobilePluginDependencies(mobileDir);

  const sourceRef = execSync("git rev-parse HEAD", { cwd: workspace, encoding: "utf-8" }).trim();
  return { mobileDir, sourceRef };
}

function assertEasArchivePreflight(mobileDir: string = MOBILE_DIR): void {
  const repoRoot = path.resolve(mobileDir, "..");
  const rootIgnore = readIgnoreFile(path.join(repoRoot, ".easignore"));
  const mobileIgnore = readIgnoreFile(path.join(mobileDir, ".easignore"));

  const missingIgnores = [
    ...ROOT_REQUIRED_EAS_IGNORE_PATTERNS
      .filter((pattern) => !ignoreContains(rootIgnore, pattern))
      .map((pattern) => `.easignore missing ${pattern}`),
    ...MOBILE_REQUIRED_EAS_IGNORE_PATTERNS
      .filter((pattern) => !ignoreContains(mobileIgnore, pattern))
      .map((pattern) => `mobile/.easignore missing ${pattern}`),
  ];

  const risks: EasArchiveRisk[] = [];
  for (const relativePath of EAS_ARCHIVE_RISK_PATHS) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    const sizeBytes = sizePathBytes(absolutePath);
    if (sizeBytes < EAS_ARCHIVE_WARN_BYTES) continue;
    const coverage = hasCoverageForRisk(relativePath, rootIgnore, mobileIgnore);
    risks.push({ relativePath, absolutePath, sizeBytes, ...coverage });
  }
  risks.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const uncoveredLargeRisks = risks.filter((risk) => {
    if (risk.sizeBytes < EAS_ARCHIVE_WARN_BYTES) return false;
    // EAS is invoked from mobile/, but previous failures show monorepo context can
    // leak in. Require both ignore files to cover known large paths.
    return !risk.ignoredByRoot || !risk.ignoredByMobile;
  });

  const riskSummary = risks
    .slice(0, 12)
    .map((risk) => `${risk.relativePath}=${formatBytes(risk.sizeBytes)} rootIgnored=${risk.ignoredByRoot} mobileIgnored=${risk.ignoredByMobile}`)
    .join(", ");

  if (risks.length) {
    log.log("EAS archive preflight size profile", {
      risks: risks.map((risk) => ({
        relativePath: risk.relativePath,
        size: formatBytes(risk.sizeBytes),
        ignoredByRoot: risk.ignoredByRoot,
        ignoredByMobile: risk.ignoredByMobile,
      })),
    });
  }

  if (missingIgnores.length || uncoveredLargeRisks.length) {
    const uncoveredSummary = uncoveredLargeRisks
      .slice(0, 12)
      .map((risk) => `${risk.relativePath}=${formatBytes(risk.sizeBytes)}`)
      .join(", ");
    throw new Error([
      "EAS archive preflight refused to start because this Railway app contains large directories that must be ignored before upload.",
      missingIgnores.length ? `Missing ignore coverage: ${missingIgnores.join("; ")}.` : undefined,
      uncoveredSummary ? `Large uncovered paths: ${uncoveredSummary}.` : undefined,
      riskSummary ? `Largest local paths: ${riskSummary}.` : undefined,
      "Expected mobile upload is small. Do not retry EAS until .easignore is deployed and mobile/node_modules plus root ballast are excluded.",
    ].filter(Boolean).join(" "));
  }

  const totalRiskBytes = risks.reduce((sum, risk) => sum + risk.sizeBytes, 0);
  if (totalRiskBytes >= EAS_ARCHIVE_MAX_BYTES) {
    log.warn("EAS archive preflight found large ignored paths; proceeding because ignore coverage is present", {
      totalRiskSize: formatBytes(totalRiskBytes),
      riskSummary,
    });
  }
}

export interface EasLogEntry {
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface EasResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  command?: string;
  cwd?: string;
  durationMs?: number;
  runId?: string;
  source?: MobileBuildSource;
  sourceRef?: string;
  startedAt?: string;
  completedAt?: string;
  guidance?: string;
  cancelledBuilds?: ExpoCancelledBuild[];
}

export interface EasRunSnapshot {
  runId: string;
  status: "running" | "success" | "failed" | "cancelled";
  command: string;
  cwd: string;
  profile?: string;
  platform?: string;
  source?: MobileBuildSource;
  sourceRef?: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number;
  result: EasResult | null;
  logs: EasLogEntry[];
  interactive?: boolean;
  inputCount?: number;
}

const MAX_EAS_LOG_LINES = 500;
let latestEasRun: EasRunSnapshot | null = null;
let latestEasRunLoaded = false;
let easRunPersistQueue: Promise<void> = Promise.resolve();
let activeEasProcess: pty.IPty | null = null;
let activeEasStartedAt = 0;
let activeEasTimeout: NodeJS.Timeout | null = null;

function normalizeEasTerminalOutput(chunk: string): string {
  return chunk
    // Strip ANSI/VT100 escape sequences emitted by the pseudo-terminal.
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    // Some logs have already decoded ESC as the replacement character.
    .replace(/\uFFFD\[[0-?]*[ -/]*[@-~]/g, "")
    // Normalize terminal redraws into readable line breaks.
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    // Drop remaining non-printing control characters except tabs/newlines.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function cloneEasRunSnapshot(run: EasRunSnapshot | null): EasRunSnapshot | null {
  if (!run) return null;
  return {
    ...run,
    logs: [...run.logs],
    result: run.result ? { ...run.result } : null,
  };
}

function scheduleEasRunPersist(): void {
  const snapshot = cloneEasRunSnapshot(latestEasRun);
  if (!snapshot) return;
  easRunPersistQueue = easRunPersistQueue
    .then(() => setSetting(EAS_RUN_STATE_KEY, snapshot))
    .catch((err: any) => {
      log.error("Failed to persist EAS run snapshot", {
        runId: snapshot.runId,
        error: err.message,
        stack: err.stack,
      });
    });
}

async function persistEasRunNow(): Promise<void> {
  scheduleEasRunPersist();
  await easRunPersistQueue;
}

function markLoadedRunningEasRunInterrupted(run: EasRunSnapshot): EasRunSnapshot {
  if (run.status !== "running" || activeEasProcess) return run;
  const completedAt = new Date().toISOString();
  const startedAtMs = Date.parse(run.startedAt);
  const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : run.durationMs;
  const message = "Interactive EAS setup was interrupted by a server restart or redeploy. Start setup again; saved requirements and prior logs were preserved.";

  const alreadyLogged = run.logs.some((entry) => entry.stream === "system" && entry.message === message);
  const logs = alreadyLogged
    ? run.logs
    : [...run.logs, { timestamp: completedAt, stream: "system" as const, message }];

  return {
    ...run,
    status: "failed",
    completedAt,
    durationMs,
    result: {
      ok: false,
      stdout: run.result?.stdout || "",
      stderr: run.result?.stderr || message,
      exitCode: run.result?.exitCode ?? null,
      error: message,
      command: run.command,
      cwd: run.cwd,
      durationMs,
      runId: run.runId,
      startedAt: run.startedAt,
      completedAt,
      guidance: message,
    },
    logs: logs.slice(-MAX_EAS_LOG_LINES),
  };
}

async function loadLatestEasRun(): Promise<void> {
  if (latestEasRunLoaded) return;
  latestEasRunLoaded = true;
  try {
    const stored = await getSetting<EasRunSnapshot>(EAS_RUN_STATE_KEY);
    latestEasRun = stored ? cloneEasRunSnapshot(stored) : null;
    if (latestEasRun?.status === "running" && !activeEasProcess) {
      latestEasRun = markLoadedRunningEasRunInterrupted(latestEasRun);
      scheduleEasRunPersist();
    }
  } catch (err: any) {
    latestEasRun = null;
    log.error("Failed to load persisted EAS run snapshot", { error: err?.message || String(err), stack: err?.stack });
  }
}

function appendEasLog(stream: EasLogEntry["stream"], chunk: string): void {
  if (!latestEasRun) return;
  const lines = normalizeEasTerminalOutput(chunk).split("\n");
  let changed = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const previous = latestEasRun.logs.at(-1);
    if (previous?.stream === stream && previous.message === line) continue;
    latestEasRun.logs.push({
      timestamp: new Date().toISOString(),
      stream,
      message: line,
    });
    changed = true;
  }
  if (latestEasRun.logs.length > MAX_EAS_LOG_LINES) {
    latestEasRun.logs = latestEasRun.logs.slice(-MAX_EAS_LOG_LINES);
    changed = true;
  }
  if (changed) scheduleEasRunPersist();
}

function createEasRun(
  command: string,
  profile?: string,
  platform?: string,
  cwd: string = MOBILE_DIR,
  source: MobileBuildSource = "local",
  sourceRef?: string,
): EasRunSnapshot {
  latestEasRunLoaded = true;
  latestEasRun = {
    runId: `eas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: "running",
    command,
    cwd,
    profile,
    platform,
    source,
    sourceRef,
    startedAt: new Date().toISOString(),
    completedAt: null,
    durationMs: 0,
    result: null,
    logs: [],
  };
  appendEasLog("system", `Starting ${command}`);
  scheduleEasRunPersist();
  return latestEasRun;
}

function getEasGuidance(stdout: string, stderr: string): string | undefined {
  const combined = `${stdout}
${stderr}`.toLowerCase();
  if (
    combined.includes(
      "couldn't find any credentials suitable for internal distribution",
    )
  ) {
    return "EAS reached Expo, but this iOS development build needs one-time Apple credential setup. Save Apple ID email, Team ID, and bundle ID in Integrations → Expo, then click Set up Apple credentials. If Apple requires browser auth or 2FA, Agent will stop and show that blocker.";
  }
  if (combined.includes("apple authentication") || combined.includes("two-factor") || combined.includes("2fa") || combined.includes("sign in to your apple")) {
    return "EAS needs Apple authentication that cannot be completed by the Railway runner. Use the Apple auth link/code shown in the EAS log, then rerun Set up Apple credentials.";
  }
  if (combined.includes("expo-asset cannot be found")) {
    return "The mobile bundle is missing expo-asset. Pull the latest main commit and redeploy the server image so mobile/package.json and package-lock.json are present in /app/mobile.";
  }
  if (combined.includes("cannot find module './utils/updates'") || combined.includes("@expo/config-plugins/build/index.js")) {
    return "The deployed Local EAS dependency tree is incomplete. Publish a fresh live deployment so /app/node_modules is hydrated from package-lock.json, or use Main while the deployment catches up.";
  }
  return undefined;
}

export async function getLatestEasRun(): Promise<EasRunSnapshot | null> {
  await loadLatestEasRun();
  return cloneEasRunSnapshot(latestEasRun);
}

function getLatestEasRunSync(): EasRunSnapshot | null {
  return cloneEasRunSnapshot(latestEasRun);
}

function finishInteractiveEasRun(result: EasResult, status: EasRunSnapshot["status"]): void {
  if (!latestEasRun) return;
  latestEasRun.status = status;
  latestEasRun.completedAt = result.completedAt || new Date().toISOString();
  latestEasRun.durationMs = result.durationMs || (Date.now() - activeEasStartedAt);
  latestEasRun.result = result;
  appendEasLog("system", status === "success" ? "Interactive EAS command completed" : result.error || "Interactive EAS command stopped");
  if (result.guidance) appendEasLog("system", result.guidance);
  activeEasProcess = null;
  if (activeEasTimeout) {
    clearTimeout(activeEasTimeout);
    activeEasTimeout = null;
  }
  scheduleEasRunPersist();
}

/** Resolve the eas binary — check node_modules/.bin first, then global PATH. */
function resolveEasBinary(): string {
  const localBin = path.resolve(process.cwd(), "node_modules", ".bin", "eas");
  if (existsSync(localBin)) return localBin;
  return "eas"; // fall back to global PATH
}

/** Ensure MOBILE_DIR has git context so EAS CLI doesn't complain about VCS. */
function ensureGitContext(mobileDir: string = MOBILE_DIR): void {
  // Check if mobile/ can reach a .git (either its own or a parent repo's)
  try {
    execSync("git rev-parse --git-dir", { cwd: mobileDir, stdio: "ignore" });
    return; // git context exists
  } catch {
    // No git context — initialize a minimal repo so EAS is happy
    log.log("No git context in mobile/, initializing minimal repo for EAS");
    try {
      execSync("git init && git add -A && git commit -m 'eas' --allow-empty", {
        cwd: mobileDir,
        stdio: "ignore",
      });
    } catch (e: any) {
      log.warn(`Failed to init git in mobile/: ${e.message}`);
    }
  }
}

async function runEas(
  args: string[],
  timeoutMs = 120_000,
  meta: { profile?: string; platform?: string; track?: boolean; cwd?: string; source?: MobileBuildSource; sourceRef?: string; cancelledBuilds?: ExpoCancelledBuild[] } = {},
): Promise<EasResult> {
  const token = await getExpoToken();
  if (!token) throw new Error("No Expo access token configured");

  const easBin = resolveEasBinary();
  const cwd = meta.cwd || MOBILE_DIR;
  ensureGitContext(cwd);

  return new Promise((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const startedAt = Date.now();
    const command = [easBin, ...args].join(" ");
    const run = meta.track === false ? null : createEasRun(command, meta.profile, meta.platform, cwd, meta.source || "local", meta.sourceRef);

    log.log(`EAS command starting: ${command} cwd=${cwd}`);

    const proc = spawn(easBin, args, {
      cwd,
      env: { ...process.env, EXPO_TOKEN: token },
      timeout: timeoutMs,
    });

    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout.push(chunk);
      if (run) appendEasLog("stdout", chunk);
    });
    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr.push(chunk);
      if (run) appendEasLog("stderr", chunk);
    });

    proc.on("close", (code, signal) => {
      const durationMs = Date.now() - startedAt;
      const completedAt = new Date().toISOString();
      const out = stdout.join("");
      const err = stderr.join("");
      const result: EasResult = {
        ok: code === 0,
        stdout: out,
        stderr: err,
        exitCode: code,
        command,
        cwd,
        durationMs,
        runId: run?.runId,
        source: meta.source || "local",
        sourceRef: meta.sourceRef,
        startedAt: run?.startedAt,
        completedAt,
        guidance: getEasGuidance(out, err),
        cancelledBuilds: meta.cancelledBuilds,
      };
      if (run) {
        run.status = result.ok ? "success" : "failed";
        run.completedAt = completedAt;
        run.durationMs = durationMs;
        run.result = result;
        appendEasLog(
          "system",
          result.ok
            ? "EAS command completed"
            : result.error || "EAS command failed",
        );
        if (result.guidance) appendEasLog("system", result.guidance);
        scheduleEasRunPersist();
      }
      if (signal) {
        result.error = `EAS command terminated by signal ${signal}`;
      } else if (code !== 0) {
        result.error = `EAS command exited with code ${code}`;
      }

      const logPayload = {
        command,
        cwd,
        exitCode: code,
        signal,
        durationMs,
        stdoutTail: result.stdout.slice(-2000),
        stderrTail: result.stderr.slice(-4000),
        guidance: result.guidance,
      };
      if (code !== 0 || signal) {
        log.error("EAS command failed", logPayload);
      } else {
        log.log("EAS command completed", { command, durationMs });
      }
      resolve(result);
    });

    proc.on("error", (err) => {
      const durationMs = Date.now() - startedAt;
      const completedAt = new Date().toISOString();
      const out = stdout.join("");
      const errText = err.message;
      const result: EasResult = {
        ok: false,
        stdout: out,
        stderr: errText,
        exitCode: null,
        error: errText,
        command,
        cwd,
        durationMs,
        runId: run?.runId,
        source: meta.source || "local",
        sourceRef: meta.sourceRef,
        startedAt: run?.startedAt,
        completedAt,
        guidance: getEasGuidance(out, errText),
        cancelledBuilds: meta.cancelledBuilds,
      };
      if (run) {
        run.status = "failed";
        run.completedAt = completedAt;
        run.durationMs = durationMs;
        run.result = result;
        appendEasLog("stderr", errText);
        if (result.guidance) appendEasLog("system", result.guidance);
        scheduleEasRunPersist();
      }
      log.error("EAS command spawn failed", {
        command,
        cwd,
        durationMs,
        error: err.message,
        stdoutTail: result.stdout.slice(-2000),
        stderrTail: result.stderr.slice(-4000),
      });
      resolve(result);
    });
  });
}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

interface AppConfig {
  expo?: {
    owner?: string;
    slug?: string;
    ios?: { bundleIdentifier?: string };
    extra?: { eas?: { projectId?: string } };
  };
}

function appJsonPathForMobileDir(mobileDir: string = MOBILE_DIR): string {
  return path.join(mobileDir, "app.json");
}

function appConfigJsPathForMobileDir(mobileDir: string = MOBILE_DIR): string {
  return path.join(mobileDir, "app.config.js");
}

function readStaticAppJson(mobileDir: string = MOBILE_DIR): AppConfig {
  const appJsonPath = appJsonPathForMobileDir(mobileDir);
  if (!existsSync(appJsonPath)) throw new Error(`${mobileDir}/app.json not found`);
  return JSON.parse(readFileSync(appJsonPath, "utf-8"));
}

function readResolvedExpoConfig(mobileDir: string = MOBILE_DIR): AppConfig {
  const appJsonPath = appJsonPathForMobileDir(mobileDir);
  if (existsSync(appJsonPath)) return readStaticAppJson(mobileDir);

  const appConfigJsPath = appConfigJsPathForMobileDir(mobileDir);
  if (!existsSync(appConfigJsPath)) {
    throw new Error(`${mobileDir}/app.json or app.config.js not found`);
  }

  const expoBin = path.resolve(mobileDir, "node_modules", ".bin", "expo");
  const command = existsSync(expoBin) ? expoBin : "npx";
  const args = existsSync(expoBin) ? ["config", "--json"] : ["expo", "config", "--json"];
  const output = execFileSync(command, args, {
    cwd: mobileDir,
    encoding: "utf-8",
    env: { ...process.env, EXPO_NO_TELEMETRY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  return parsed.expo ? parsed : { expo: parsed };
}

function writeAppJson(config: AppConfig, mobileDir: string = MOBILE_DIR): void {
  writeFileSync(appJsonPathForMobileDir(mobileDir), `${JSON.stringify(config, null, 2)}
`, "utf-8");
}

function syncBundleIdentifierToExpoConfig(bundleIdentifier: string, mobileDir: string = MOBILE_DIR): void {
  const appJsonPath = appJsonPathForMobileDir(mobileDir);
  if (!existsSync(appJsonPath)) {
    const resolved = readResolvedExpoConfig(mobileDir);
    const currentBundleId = resolved.expo?.ios?.bundleIdentifier;
    if (currentBundleId && currentBundleId !== bundleIdentifier) {
      log.warn("Skipping dynamic Expo config bundle identifier rewrite; app.config.js controls the bundle identifier", {
        configuredBundleIdentifier: bundleIdentifier,
        resolvedBundleIdentifier: currentBundleId,
        mobileDir,
      });
    }
    return;
  }

  const appConfig = readStaticAppJson(mobileDir);
  appConfig.expo ||= {};
  appConfig.expo.ios ||= {};
  const currentBundleId = appConfig.expo.ios.bundleIdentifier;
  if (currentBundleId === bundleIdentifier) return;

  appConfig.expo.ios.bundleIdentifier = bundleIdentifier;
  writeAppJson(appConfig, mobileDir);
  log.log("Updated mobile/app.json iOS bundle identifier for EAS credential setup", {
    previousBundleId: currentBundleId || null,
    bundleIdentifier,
  });
}

export interface ExpoProjectConfig {
  configured: boolean;
  owner?: string;
  slug?: string;
  projectId?: string;
  message?: string;
}

export function getProjectConfig(mobileDir: string = MOBILE_DIR): ExpoProjectConfig {
  const config = readResolvedExpoConfig(mobileDir);
  const owner = config.expo?.owner;
  const slug = config.expo?.slug;
  const projectId = config.expo?.extra?.eas?.projectId;
  const configured = Boolean(projectId);

  return {
    configured,
    owner,
    slug,
    projectId,
    message: configured
      ? undefined
      : "Expo project is not linked in mobile Expo config. Run eas init once and commit expo.extra.eas.projectId before triggering server-side builds.",
  };
}

function requireProjectConfig(mobileDir: string = MOBILE_DIR): ExpoProjectConfig {
  const project = getProjectConfig(mobileDir);
  if (!project.configured || !project.projectId) {
    throw new Error(
      project.message || "Expo projectId is missing from mobile Expo config",
    );
  }
  return project;
}

export async function easBuild(
  profile: string = "preview",
  platform: string = "ios",
  source: MobileBuildSource = "main",
  options: { cancelExisting?: boolean } = {},
): Promise<EasResult> {
  await loadLatestEasRun();
  if (latestEasRun?.status === "running") {
    throw new Error("A Mobile EAS build is already running.");
  }

  const buildSource: MobileBuildSource = source === "local" ? "main" : source;
  const sourceInfo = await prepareMainBuildWorkspace();
  const mobileDir = sourceInfo.mobileDir;
  await applyMobilePlatformEnvironmentToEasProfile(mobileDir, profile);
  const project = requireProjectConfig(mobileDir);
  const cancelledBuilds = options.cancelExisting === false
    ? []
    : await cancelInProgressBuilds({ projectId: project.projectId, platform, profile });
  assertEasArchivePreflight(mobileDir);
  if (platform === "ios") {
    const appleConfig = await getAppleCredentialsConfig();
    if (appleConfig?.bundleIdentifier) {
      syncBundleIdentifierToExpoConfig(appleConfig.bundleIdentifier, mobileDir);
      log.log("Prepared iOS bundle identifier for EAS build", {
        bundleIdentifier: appleConfig.bundleIdentifier,
        profile,
        source: buildSource,
        sourceRef: sourceInfo.sourceRef,
      });
    }
  }
  return runEas(
    [
      "build",
      "--profile",
      profile,
      "--platform",
      platform,
      "--non-interactive",
      "--no-wait",
    ],
    180_000,
    { profile, platform, cwd: mobileDir, source: buildSource, sourceRef: sourceInfo.sourceRef, cancelledBuilds },
  );
}

export async function easBuildStatus(): Promise<EasResult> {
  requireProjectConfig();
  return runEas(
    ["build:list", "--json", "--limit", "10", "--non-interactive"],
    120_000,
    { track: false },
  );
}

export async function triggerMainMobileBuild(input: {
  profile?: string;
  platform?: string;
  sourceRef?: string | null;
  reason?: string;
} = {}): Promise<{ triggered: boolean; reason: string; run?: EasResult; existingRunId?: string; cancelledBuilds?: ExpoCancelledBuild[] }> {
  await loadLatestEasRun();

  if (latestEasRun?.status === "running") {
    return {
      triggered: false,
      reason: "mobile_build_already_running",
      existingRunId: latestEasRun.runId,
    };
  }

  const requestedRef = input.sourceRef?.trim();
  if (requestedRef && latestEasRun?.source === "main" && latestEasRun.sourceRef === requestedRef && latestEasRun.status === "success") {
    return {
      triggered: false,
      reason: "mobile_build_already_succeeded_for_ref",
      existingRunId: latestEasRun.runId,
    };
  }

  log.log("Triggering Mobile EAS build from main", {
    reason: input.reason || "manual",
    requestedRef: requestedRef || null,
    profile: input.profile || "preview",
    platform: input.platform || "ios",
  });

  const run = await easBuild(input.profile || "preview", input.platform || "ios", "main", { cancelExisting: true });
  return { triggered: true, reason: "mobile_build_started", run, cancelledBuilds: run.cancelledBuilds || [] };
}

export async function startInteractiveAppleCredentialsSetup(): Promise<EasRunSnapshot> {
  requireProjectConfig();
  if (activeEasProcess && latestEasRun?.status === "running") {
    throw new Error("An interactive EAS credential setup is already running.");
  }

  const token = await getExpoToken();
  if (!token) throw new Error("No Expo access token configured");

  const config = await getAppleCredentialsConfig();
  if (!config) {
    throw new Error("Apple credential setup fields are missing. Save Apple ID email, Team ID, and bundle identifier first.");
  }

  syncBundleIdentifierToExpoConfig(config.bundleIdentifier);

  const easBin = resolveEasBinary();
  const args = ["credentials:configure-build", "--platform", "ios", "--profile", "development"];
  ensureGitContext();
  const command = [easBin, ...args].join(" ");
  const run = createEasRun(command, "development", "ios");
  run.interactive = true;
  run.inputCount = 0;
  activeEasStartedAt = Date.now();

  log.log(`Interactive EAS credential setup starting: ${command} cwd=${MOBILE_DIR}`);
  appendEasLog("system", "Interactive session started. Reply to EAS prompts below; inputs are not printed into the log.");

  const output: string[] = [];
  let proc: pty.IPty;
  try {
    proc = pty.spawn(easBin, args, {
      cwd: MOBILE_DIR,
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      env: {
        ...process.env,
        EXPO_TOKEN: token,
        EXPO_APPLE_ID: config.appleIdEmail,
        EXPO_APPLE_TEAM_ID: config.teamId,
        // Make it explicit that this is not CI. EAS should ask prompts instead of refusing interactive setup.
        CI: "0",
        TERM: "xterm-256color",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      encoding: "utf8",
    });
  } catch (err: any) {
    const completedAt = new Date().toISOString();
    const result: EasResult = {
      ok: false,
      stdout: "",
      stderr: err.message,
      exitCode: null,
      error: err.message,
      command,
      cwd: MOBILE_DIR,
      durationMs: Date.now() - activeEasStartedAt,
      runId: run.runId,
      startedAt: run.startedAt,
      completedAt,
      guidance: "Interactive EAS setup needs a pseudo-terminal, but the PTY backend failed to start on this deployment. Check Railway optional dependencies for @lydell/node-pty.",
    };
    finishInteractiveEasRun(result, "failed");
    await persistEasRunNow();
    return getLatestEasRunSync()!;
  }

  activeEasProcess = proc;

  proc.onData((chunk) => {
    output.push(chunk);
    appendEasLog("stdout", chunk);
  });

  proc.onExit(({ exitCode, signal }) => {
    const durationMs = Date.now() - activeEasStartedAt;
    const completedAt = new Date().toISOString();
    const out = output.join("");
    const result: EasResult = {
      ok: exitCode === 0,
      stdout: out,
      stderr: "",
      exitCode,
      command,
      cwd: MOBILE_DIR,
      durationMs,
      runId: run.runId,
      startedAt: run.startedAt,
      completedAt,
      guidance: getEasGuidance(out, ""),
    };
    if (signal) result.error = `EAS command terminated by signal ${signal}`;
    else if (exitCode !== 0) result.error = `EAS command exited with code ${exitCode}`;
    finishInteractiveEasRun(result, exitCode === 0 ? "success" : "failed");
  });

  activeEasTimeout = setTimeout(() => {
    if (!activeEasProcess || latestEasRun?.status !== "running") return;
    appendEasLog("system", "Interactive EAS session timed out after 15 minutes; cancelling process.");
    activeEasProcess.kill("SIGTERM");
  }, 900_000);

  await persistEasRunNow();
  return getLatestEasRunSync()!;
}

export function sendInteractiveEasInput(input: string): EasRunSnapshot {
  if (!activeEasProcess || !latestEasRun || latestEasRun.status !== "running") {
    throw new Error("No interactive EAS credential setup is running.");
  }
  const value = String(input ?? "");
  activeEasProcess.write(value + "\r");
  latestEasRun.inputCount = (latestEasRun.inputCount || 0) + 1;
  appendEasLog("system", `Sent response #${latestEasRun.inputCount} to EAS prompt.`);
  scheduleEasRunPersist();
  return getLatestEasRunSync()!;
}

export function cancelInteractiveEasRun(): EasRunSnapshot {
  if (!activeEasProcess || !latestEasRun || latestEasRun.status !== "running") {
    throw new Error("No interactive EAS credential setup is running.");
  }
  const completedAt = new Date().toISOString();
  const result: EasResult = {
    ok: false,
    stdout: "",
    stderr: "Cancelled by user",
    exitCode: null,
    error: "Cancelled by user",
    command: latestEasRun.command,
    cwd: latestEasRun.cwd,
    durationMs: Date.now() - activeEasStartedAt,
    runId: latestEasRun.runId,
    startedAt: latestEasRun.startedAt,
    completedAt,
  };
  activeEasProcess.kill("SIGTERM");
  finishInteractiveEasRun(result, "cancelled");
  return getLatestEasRunSync()!;
}

export async function easConfigureAppleCredentials(): Promise<EasResult> {
  const run = await startInteractiveAppleCredentialsSetup();
  return {
    ok: true,
    stdout: "Interactive EAS credential setup started",
    stderr: "",
    exitCode: 0,
    command: run.command,
    cwd: run.cwd,
    runId: run.runId,
    startedAt: run.startedAt,
    guidance: "Interactive EAS credential setup is running. Watch the log and submit replies to prompts from the Expo integration page.",
  };
}
