// playwright-core is intentionally NOT imported at module top level. It is a
// large native-binding dep that is `external` in the production esbuild bundle,
// so a transitive `require()` failure inside it (chromium-bidi sub-modules,
// etc.) would surface as a `MODULE_NOT_FOUND` the moment anything called
// `await import("./browser-manager")` — including the /api/gateway/processes
// stats probe that has no intent to actually launch a browser. Loading
// playwright-core lazily inside `ensureBrowser()` keeps stats/metadata callers
// completely decoupled from the headless-browser dep chain.
import type { Browser, BrowserContext, Page } from "playwright-core";
import { createLogger } from "./log";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

const execAsync = promisify(exec);
const log = createLogger("BrowserManager");

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const PAGE_TIMEOUT_MS = 30_000;

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let launchPromise: Promise<Browser> | null = null;
let activePages = 0;
let waitingForCapacity = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let _isLaunching = false;

async function withIsolatedBrowserCapacity<T>(activity: string, fn: () => Promise<T>): Promise<T> {
  const { admissionController } = await import("./run-admission");
  const runId = `browser:${activity}:${randomUUID()}`;
  let waiting = true;
  waitingForCapacity++;
  try {
    return await admissionController.withResourcePool("isolated_execution", runId, async () => {
      if (waiting) {
        waiting = false;
        waitingForCapacity--;
      }
      activePages++;
      try {
        return await fn();
      } finally {
        activePages--;
        resetIdleTimer();
      }
    }, { activity, timeout: PAGE_TIMEOUT_MS });
  } finally {
    if (waiting) waitingForCapacity--;
  }
}

// Discovers a working Chromium binary. Prefers Playwright's bundled Chrome for
// Testing (version-matched to playwright-core) over the system chromium package,
// because system Chromium upgrades (e.g. v150 on Debian trixie) can introduce
// SIGTRAP crashes in container environments with restrictive seccomp profiles.
async function getChromiumPath(): Promise<string> {
  // 1. Playwright's bundled Chrome for Testing (installed via `npx playwright install chromium`)
  try {
    const { stdout } = await execAsync(
      "find /root/.cache/ms-playwright -name 'chrome' -path '*/chrome-linux64/*' 2>/dev/null | head -1"
    );
    const path = stdout.trim();
    if (path) {
      log.log(`Using Playwright bundled Chrome: ${path}`);
      return path;
    }
  } catch {}

  // 2. System chromium (may not work in all container runtimes)
  try {
    const { stdout } = await execAsync("which chromium");
    const path = stdout.trim();
    if (path) return path;
  } catch {}
  try {
    const { stdout } = await execAsync("which chromium-browser");
    const path = stdout.trim();
    if (path) return path;
  } catch {}
  throw new Error("Chromium binary not found. Install via `npx playwright install chromium` or apt.");
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (activePages === 0) {
      await closeBrowser();
    }
  }, IDLE_TIMEOUT_MS);
}

async function ensureBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) {
    return browser;
  }

  if (launchPromise) {
    return launchPromise;
  }

  _isLaunching = true;
  launchPromise = (async () => {
    const executablePath = await getChromiumPath();
    log.log(`Launching headless Chromium from ${executablePath}`);

    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--no-first-run",
        "--disable-default-apps",
      ],
    });

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    await context.route("**/*", (route) => {
      const resourceType = route.request().resourceType();
      if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
        return route.abort();
      }
      return route.continue();
    });

    log.log("Headless Chromium browser launched successfully");
    _isLaunching = false;
    launchPromise = null;
    resetIdleTimer();
    return browser;
  })();

  try {
    return await launchPromise;
  } catch (err) {
    _isLaunching = false;
    launchPromise = null;
    throw err;
  }
}

export async function fetchWithBrowser(url: string, timeoutMs: number = PAGE_TIMEOUT_MS): Promise<string> {
  return withIsolatedBrowserCapacity("browser.fetch", async () => {
    try {
    await ensureBrowser();
    if (!context) throw new Error("Browser context not available");

    let page: Page | null = null;
    try {
      page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      await page.waitForTimeout(1500);

      const html = await page.content();
      return html;
    } finally {
      if (page) {
        try { await page.close(); } catch {}
      }
    }
    } finally {
      resetIdleTimer();
    }
  });
}

// ---------------------------------------------------------------------------
// Screenshot support — uses a SEPARATE browser context (no resource blocking)
// with an injected authenticated session cookie for capturing app UI.
// ---------------------------------------------------------------------------

const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet:  { width: 768,  height: 1024 },
  mobile:  { width: 375,  height: 812 },
};

interface ScreenshotSession {
  sid: string;
  signedCookie: string;
  cleanup: () => Promise<void>;
}

async function createScreenshotSession(userId: string, sessionSecret?: string): Promise<ScreenshotSession> {
  // Dynamic imports for CJS deps (transitive from express-session)
  const uidSafe = await import("uid-safe") as unknown as { default?: { sync: (len: number) => string }; sync?: (len: number) => string };
  const uidSync = (uidSafe.default?.sync ?? uidSafe.sync) as (len: number) => string;

  const cookieSig = await import("cookie-signature") as unknown as { default?: { sign: (val: string, secret: string) => string }; sign?: (val: string, secret: string) => string };
  const cookieSign = (cookieSig.default?.sign ?? cookieSig.sign) as (val: string, secret: string) => string;

  const sid = uidSync(24);
  const secret = sessionSecret || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("Platform-binding auth invariant failed: SESSION_SECRET is unavailable to sign the acceptance session cookie");
  }
  if (!userId.trim()) {
    throw new Error("Platform-binding auth invariant failed: workflow owner user ID is missing");
  }

  const { pool } = await import("./db");
  const usersResult = await pool.query(
    'SELECT id FROM "users" WHERE id = $1 LIMIT 1',
    [userId],
  );
  const sessionUserId: string | undefined = usersResult.rows[0]?.id;
  if (!sessionUserId) {
    throw new Error(`Platform-binding auth invariant failed: workflow owner ${userId} does not exist in the shared user store`);
  }

  // Insert a short-lived session row (120s TTL).
  // connect-pg-simple reads sessions with `expire >= to_timestamp(epoch_seconds)`
  // so we must store expire via to_timestamp() too — a JS Date lands as
  // `timestamp without time zone` which silently drops timezone context and
  // causes comparison mismatches when the server TZ differs from UTC.
  const expireEpochSeconds = Math.ceil((Date.now() + 120_000) / 1000);
  const sess = JSON.stringify({
    cookie: { maxAge: 120000 },
    userId: sessionUserId,
    createdAt: new Date().toISOString(),
    userAgent: "mantra-screenshot-session",
  });
  await pool.query(
    'INSERT INTO "session" (sid, sess, expire) VALUES ($1, $2, to_timestamp($3))',
    [sid, sess, expireEpochSeconds]
  );

  const signedCookie = "s:" + cookieSign(sid, secret);

  const cleanup = async () => {
    try {
      await pool.query('DELETE FROM "session" WHERE sid = $1', [sid]);
    } catch {
      // best-effort cleanup
    }
  };

  return { sid, signedCookie, cleanup };
}

/** Closed keyboard keys for web.test press steps. */
export const WEB_TEST_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
] as const;

export type WebTestKey = (typeof WEB_TEST_KEYS)[number];

export type WebTestStep =
  | { kind: "navigate"; route: string }
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "tap"; selector: string }
  | { kind: "scroll"; selector: string }
  | { kind: "scroll"; deltaX?: number; deltaY?: number }
  | { kind: "press"; key: WebTestKey }
  | { kind: "type"; text: string }
  | { kind: "screenshot" };

export type WebTestOutcome =
  | "ok"
  | "input_invalid"
  | "auth_failed"
  | "step_failed"
  | "origin_escaped"
  | "capture_failed";

export type WebTestAuthUsed = "none" | "principal-cookie" | "automation-auth";

export interface WebTestFrame {
  path: string;
  width: number;
  height: number;
  truncated: boolean;
  label: string;
}

export interface WebTestStepResult {
  index: number;
  kind: string;
  status: "ok" | "failed";
  detail: string;
}

export interface WebTestResult {
  outcome: WebTestOutcome;
  authUsed: WebTestAuthUsed;
  entryUrl: string;
  finalUrl: string | null;
  steps: WebTestStepResult[];
  frames: WebTestFrame[];
  errorMessage?: string;
  /** First/closing frame path for callers that still expect a single screenshot. */
  path: string;
  width: number;
  height: number;
  truncated: boolean;
}

const WEB_TEST_MAX_STEPS = 8;
const WEB_TEST_SELECTOR_MAX = 200;
const WEB_TEST_STEP_TIMEOUT_MS = 7_000;
const WEB_TEST_SCROLL_CLAMP = 4000;
const WEB_TEST_KEY_SET = new Set<string>(WEB_TEST_KEYS);

export class WebTestError extends Error {
  readonly outcome: WebTestOutcome;
  constructor(outcome: WebTestOutcome, message: string) {
    super(message);
    this.name = "WebTestError";
    this.outcome = outcome;
  }
}

function isLocalAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return false;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const appPort = String(process.env.PORT || "5000");
    return port === appPort || (port === "80" && appPort === "80");
  } catch {
    return false;
  }
}

function resolveViewportSize(
  vpOpt: string | { width: number; height: number } | undefined,
): { width: number; height: number } {
  if (!vpOpt) return VIEWPORT_PRESETS.desktop;
  if (typeof vpOpt === "string") {
    if (VIEWPORT_PRESETS[vpOpt]) return VIEWPORT_PRESETS[vpOpt];
    const match = vpOpt.match(/^(\d+)[xX](\d+)$/);
    if (match) {
      return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
    }
    return VIEWPORT_PRESETS.desktop;
  }
  return vpOpt;
}

async function integrationHasBrowserSession(connectorKey: string): Promise<boolean> {
  // Capability catalog lives on IntegrationContribution; code only checks the field.
  const { getModRegistry } = await import("./mods/registry");
  const registry = getModRegistry();
  const contributions = [
    ...(registry.core.contributions.integrations ?? []),
    ...registry.mods.flatMap((mod) => mod.contributions.integrations ?? []),
  ];
  const hit = contributions.find((c) => c.connectorKey === connectorKey);
  return Boolean(hit?.capabilities?.includes("browser-session"));
}

function localAppOrigin(): string {
  const port = process.env.PORT || "5000";
  return `http://localhost:${port}`;
}

function resolveLocalRoute(route: string): string {
  const trimmed = route.trim();
  if (!trimmed) throw new WebTestError("input_invalid", "navigate route must be non-empty");
  const pathPart = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${localAppOrigin()}${pathPart}`;
}

export function parseWebTestSteps(raw: unknown): WebTestStep[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new WebTestError("input_invalid", "steps must be an array");
  }
  if (raw.length > WEB_TEST_MAX_STEPS) {
    throw new WebTestError("input_invalid", `steps max is ${WEB_TEST_MAX_STEPS}`);
  }

  const steps: WebTestStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new WebTestError("input_invalid", `steps[${i}] must be an object`);
    }
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    if (typeof kind !== "string") {
      throw new WebTestError("input_invalid", `steps[${i}].kind is required`);
    }

    const keys = Object.keys(rec).filter((k) => k !== "kind");
    const requireOnly = (allowed: string[]) => {
      for (const k of keys) {
        if (!allowed.includes(k)) {
          throw new WebTestError("input_invalid", `steps[${i}] has extra key '${k}'`);
        }
      }
    };
    const nonEmptyString = (field: string): string => {
      const v = rec[field];
      if (typeof v !== "string" || !v.trim()) {
        throw new WebTestError("input_invalid", `steps[${i}].${field} must be a non-empty string`);
      }
      return v.trim();
    };

    switch (kind) {
      case "navigate": {
        const hasRoute = Object.prototype.hasOwnProperty.call(rec, "route");
        const hasUrl = Object.prototype.hasOwnProperty.call(rec, "url");
        if (hasRoute === hasUrl) {
          throw new WebTestError("input_invalid", `steps[${i}] navigate needs exactly one of route or url`);
        }
        requireOnly(hasRoute ? ["route"] : ["url"]);
        if (hasRoute) steps.push({ kind: "navigate", route: nonEmptyString("route") });
        else steps.push({ kind: "navigate", url: nonEmptyString("url") });
        break;
      }
      case "click":
      case "tap": {
        requireOnly(["selector"]);
        const selector = nonEmptyString("selector");
        if (selector.length > WEB_TEST_SELECTOR_MAX) {
          throw new WebTestError("input_invalid", `steps[${i}].selector max ${WEB_TEST_SELECTOR_MAX} characters`);
        }
        steps.push(kind === "click" ? { kind: "click", selector } : { kind: "tap", selector });
        break;
      }
      case "scroll": {
        const hasSelector = Object.prototype.hasOwnProperty.call(rec, "selector");
        const hasDeltaX = Object.prototype.hasOwnProperty.call(rec, "deltaX");
        const hasDeltaY = Object.prototype.hasOwnProperty.call(rec, "deltaY");
        if (hasSelector && (hasDeltaX || hasDeltaY)) {
          throw new WebTestError("input_invalid", `steps[${i}] scroll supplies selector or deltas, not both`);
        }
        if (!hasSelector && !hasDeltaX && !hasDeltaY) {
          throw new WebTestError("input_invalid", `steps[${i}] scroll needs selector or deltaX/deltaY`);
        }
        if (hasSelector) {
          requireOnly(["selector"]);
          const selector = nonEmptyString("selector");
          if (selector.length > WEB_TEST_SELECTOR_MAX) {
            throw new WebTestError("input_invalid", `steps[${i}].selector max ${WEB_TEST_SELECTOR_MAX} characters`);
          }
          steps.push({ kind: "scroll", selector });
        } else {
          requireOnly(["deltaX", "deltaY"]);
          const clamp = (n: unknown, field: string): number | undefined => {
            if (n === undefined) return undefined;
            if (typeof n !== "number" || !Number.isFinite(n)) {
              throw new WebTestError("input_invalid", `steps[${i}].${field} must be a finite number`);
            }
            return Math.max(-WEB_TEST_SCROLL_CLAMP, Math.min(WEB_TEST_SCROLL_CLAMP, n));
          };
          steps.push({
            kind: "scroll",
            deltaX: clamp(rec.deltaX, "deltaX"),
            deltaY: clamp(rec.deltaY, "deltaY"),
          });
        }
        break;
      }
      case "press": {
        requireOnly(["key"]);
        const key = nonEmptyString("key");
        if (!WEB_TEST_KEY_SET.has(key)) {
          throw new WebTestError("input_invalid", `steps[${i}].key '${key}' is outside the allowlist`);
        }
        steps.push({ kind: "press", key: key as WebTestKey });
        break;
      }
      case "type": {
        requireOnly(["text"]);
        const text = nonEmptyString("text");
        steps.push({ kind: "type", text });
        break;
      }
      case "screenshot": {
        requireOnly([]);
        steps.push({ kind: "screenshot" });
        break;
      }
      default:
        throw new WebTestError("input_invalid", `steps[${i}].kind '${kind}' is unknown`);
    }
  }
  return steps;
}

export function parseWebTestAuth(
  raw: unknown,
): { mode: "omit" } | { mode: "integration"; integration: string } {
  if (raw == null) return { mode: "omit" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new WebTestError("input_invalid", "auth must be an object");
  }
  const rec = raw as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    if (k !== "integration") {
      throw new WebTestError("input_invalid", `auth has extra key '${k}'`);
    }
  }
  const integration = rec.integration;
  if (typeof integration !== "string" || !integration.trim()) {
    throw new WebTestError("input_invalid", "auth.integration must be a non-empty string");
  }
  return { mode: "integration", integration: integration.trim() };
}

function ensureScreenshotsDir(): string {
  const scratchDir = process.env.SCRATCH_DIR || "/app/scratch";
  const screenshotsDir = path.join(scratchDir, "screenshots");
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }
  return screenshotsDir;
}

function buildFramePath(
  entryUrl: string,
  viewportSize: { width: number; height: number },
  vpOpt: string | { width: number; height: number } | undefined,
  label: string,
): string {
  const screenshotsDir = ensureScreenshotsDir();
  const urlObj = new URL(entryUrl);
  const routeSlug = urlObj.pathname.replace(/\//g, "-").replace(/^-/, "") || "home";
  const vpLabel = typeof vpOpt === "string" ? vpOpt : `${viewportSize.width}x${viewportSize.height}`;
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "frame";
  return path.join(screenshotsDir, `${routeSlug}-${vpLabel}-${safeLabel}-${Date.now()}.png`);
}

async function captureFrame(
  page: Page,
  viewportSize: { width: number; height: number },
  fullPage: boolean,
  outputPath: string,
  label: string,
): Promise<WebTestFrame> {
  let truncated = false;
  if (fullPage) {
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    if (scrollHeight > 4000) {
      truncated = true;
      await page.screenshot({
        path: outputPath,
        clip: { x: 0, y: 0, width: viewportSize.width, height: 4000 },
      });
    } else {
      await page.screenshot({ path: outputPath, fullPage: true });
    }
  } else {
    await page.screenshot({ path: outputPath });
  }

  const finalHeight = truncated
    ? 4000
    : fullPage
      ? await page.evaluate(() => document.body.scrollHeight)
      : viewportSize.height;

  log.log(`Screenshot saved: ${outputPath} (${viewportSize.width}×${finalHeight}${truncated ? " truncated" : ""})`);
  return {
    path: outputPath,
    width: viewportSize.width,
    height: finalHeight,
    truncated,
    label,
  };
}

async function firstVisibleLocator(page: Page, selector: string) {
  const locator = page.locator(selector);
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * One authenticated Chromium session for web.test.
 * Empty steps = today's photograph. Closed steps act then evidence; origin re-checked after each act.
 * Does not use withTargetBoundBrowserPage (isolator would change the photograph).
 */
export async function screenshotPage(
  url: string,
  options?: {
    viewport?: string | { width: number; height: number };
    fullPage?: boolean;
    delay?: number;
    outputPath?: string;
    userId?: string;
    steps?: unknown;
    auth?: unknown;
  },
): Promise<WebTestResult> {
  return withIsolatedBrowserCapacity("browser.screenshot", async () => {
    let page: Page | null = null;
    let screenshotContext: BrowserContext | null = null;
    let session: ScreenshotSession | null = null;

    const frames: WebTestFrame[] = [];
    const stepResults: WebTestStepResult[] = [];
    let authUsed: WebTestAuthUsed = "none";
    let finalUrl: string | null = null;
    let outcome: WebTestOutcome = "ok";
    let errorMessage: string | undefined;

    const emptyResult = (o: WebTestOutcome, message: string): WebTestResult => ({
      outcome: o,
      authUsed,
      entryUrl: url,
      finalUrl,
      steps: stepResults,
      frames,
      errorMessage: message,
      path: frames[0]?.path ?? "",
      width: frames[0]?.width ?? 0,
      height: frames[0]?.height ?? 0,
      truncated: frames[0]?.truncated ?? false,
    });

    try {
      let steps: WebTestStep[];
      let authArg: ReturnType<typeof parseWebTestAuth>;
      try {
        steps = parseWebTestSteps(options?.steps);
        authArg = parseWebTestAuth(options?.auth);
      } catch (err) {
        if (err instanceof WebTestError) return emptyResult(err.outcome, err.message);
        throw err;
      }

      let entryOrigin: string;
      try {
        entryOrigin = originOf(url);
      } catch {
        return emptyResult("input_invalid", `Invalid entry URL: ${url}`);
      }

      const localApp = isLocalAppUrl(url);
      const hasSteps = steps.length > 0;

      // Auth + origin legality before any act.
      if (authArg.mode === "integration") {
        if (!(await integrationHasBrowserSession(authArg.integration))) {
          return emptyResult(
            "input_invalid",
            `Integration '${authArg.integration}' is unknown or lacks browser-session capability`,
          );
        }
        // Day-one injector is automation-auth bearer only.
        if (authArg.integration !== "automation-auth") {
          return emptyResult(
            "input_invalid",
            `Integration '${authArg.integration}' has no browser-session injector in this build`,
          );
        }
      } else if (hasSteps && !localApp) {
        return emptyResult(
          "input_invalid",
          "External URL with steps requires auth.integration with browser-session capability",
        );
      }

      const viewportSize = resolveViewportSize(options?.viewport);
      const vpOpt = options?.viewport;
      const fullPage = options?.fullPage ?? false;

      await ensureBrowser();
      if (!browser) throw new Error("Browser not available");

      const extraHTTPHeaders: Record<string, string> = {};

      if (authArg.mode === "integration") {
        try {
          const { getAutomationAuthToken } = await import("./automation-auth-token");
          const token = await getAutomationAuthToken();
          if (!token) {
            return emptyResult("auth_failed", "automation-auth token is unset");
          }
          extraHTTPHeaders["Authorization"] = `Bearer ${token}`;
          authUsed = "automation-auth";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return emptyResult("auth_failed", `automation-auth injector failed: ${msg}`);
        }
      } else if (localApp) {
        const { getCurrentPrincipal } = await import("./principal-context");
        const userId = options?.userId || getCurrentPrincipal()?.userId;
        if (!userId) {
          return emptyResult("auth_failed", "Local screenshot authentication requires a user principal");
        }
        try {
          session = await createScreenshotSession(userId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return emptyResult("auth_failed", `Principal cookie could not be minted: ${msg}`);
        }
        authUsed = "principal-cookie";
      } else {
        // External photograph-only stranger — no credentials (spec).
        authUsed = "none";
      }

      // hasTouch so tap is first-class (Playwright requires it); does not change the photograph path.
      const contextOptions = {
        viewport: viewportSize,
        hasTouch: true,
        ...(Object.keys(extraHTTPHeaders).length > 0 ? { extraHTTPHeaders } : {}),
      };
      screenshotContext = await browser.newContext(contextOptions);
      if (session) {
        await screenshotContext.addCookies([
          {
            name: "connect.sid",
            value: session.signedCookie,
            url: entryOrigin,
            httpOnly: true,
            secure: url.startsWith("https://"),
            sameSite: "Lax",
          },
        ]);
      }

      page = await screenshotContext.newPage();
      page.setDefaultTimeout(WEB_TEST_STEP_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(30_000);

      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome = "capture_failed";
        errorMessage = `Entry navigation failed: ${msg}`;
        try {
          finalUrl = page.url();
        } catch {
          finalUrl = null;
        }
        return emptyResult(outcome, errorMessage);
      }

      finalUrl = page.url();
      if (originOf(finalUrl) !== entryOrigin) {
        outcome = "origin_escaped";
        errorMessage = `Entry navigation left origin ${entryOrigin} → ${originOf(finalUrl)}`;
      } else {
        // Run closed steps
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          try {
            let detail = "";
            switch (step.kind) {
              case "navigate": {
                const target =
                  "route" in step && step.route !== undefined
                    ? resolveLocalRoute(step.route)
                    : (step as { url: string }).url;
                if ("url" in step && step.url) {
                  let parsed: URL;
                  try {
                    parsed = new URL(step.url);
                  } catch {
                    throw new WebTestError("input_invalid", `steps[${i}] navigate url is invalid`);
                  }
                  if (parsed.origin !== entryOrigin) {
                    throw new WebTestError(
                      "origin_escaped",
                      `steps[${i}] navigate url leaves entry origin`,
                    );
                  }
                } else if ("route" in step) {
                  if (!isLocalAppUrl(target) || originOf(target) !== entryOrigin) {
                    throw new WebTestError(
                      "input_invalid",
                      `steps[${i}] navigate route is local-app only on the entry origin`,
                    );
                  }
                }
                await page.goto(target, { waitUntil: "networkidle", timeout: 30_000 });
                detail = `navigated ${target}`;
                break;
              }
              case "click": {
                const loc = await firstVisibleLocator(page, step.selector);
                if (!loc) {
                  throw new WebTestError("step_failed", `No visible match for selector '${step.selector}'`);
                }
                await loc.click({ timeout: WEB_TEST_STEP_TIMEOUT_MS });
                detail = `clicked ${step.selector}`;
                break;
              }
              case "tap": {
                const loc = await firstVisibleLocator(page, step.selector);
                if (!loc) {
                  throw new WebTestError("step_failed", `No visible match for selector '${step.selector}'`);
                }
                await loc.tap({ timeout: WEB_TEST_STEP_TIMEOUT_MS });
                detail = `tapped ${step.selector}`;
                break;
              }
              case "scroll": {
                if ("selector" in step && step.selector) {
                  const loc = await firstVisibleLocator(page, step.selector);
                  if (!loc) {
                    throw new WebTestError("step_failed", `No visible match for selector '${step.selector}'`);
                  }
                  await loc.scrollIntoViewIfNeeded({ timeout: WEB_TEST_STEP_TIMEOUT_MS });
                  detail = `scrolled into view ${step.selector}`;
                } else {
                  const dx = step.deltaX ?? 0;
                  const dy = step.deltaY ?? 0;
                  await page.mouse.wheel(dx, dy);
                  detail = `wheeled deltaX=${dx} deltaY=${dy}`;
                }
                break;
              }
              case "press": {
                const key = step.key === "Space" ? " " : step.key;
                await page.keyboard.press(key);
                detail = `pressed ${step.key}`;
                break;
              }
              case "type": {
                await page.keyboard.type(step.text, { delay: 0 });
                detail = `typed ${step.text.length} chars`;
                break;
              }
              case "screenshot": {
                const midPath = buildFramePath(url, viewportSize, vpOpt, `step${i}`);
                const frame = await captureFrame(page, viewportSize, fullPage, midPath, `step-${i}`);
                frames.push(frame);
                detail = `frame ${frame.path}`;
                break;
              }
              default:
                throw new WebTestError("input_invalid", `Unknown step kind`);
            }

            finalUrl = page.url();
            if (originOf(finalUrl) !== entryOrigin) {
              throw new WebTestError(
                "origin_escaped",
                `Step ${i} left entry origin → ${originOf(finalUrl)}`,
              );
            }
            stepResults.push({ index: i, kind: step.kind, status: "ok", detail });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof WebTestError) {
              outcome = err.outcome;
            } else {
              outcome = "step_failed";
            }
            errorMessage = msg;
            stepResults.push({ index: i, kind: step.kind, status: "failed", detail: msg });
            try {
              finalUrl = page.url();
            } catch {
              /* keep prior */
            }
            break;
          }
        }
      }

      const delay = options?.delay ?? 2000;
      if (delay > 0 && page) {
        await page.waitForTimeout(delay);
      }

      // Closing frame whenever a page exists.
      if (page) {
        try {
          const closePath =
            options?.outputPath || buildFramePath(url, viewportSize, vpOpt, "close");
          const closeFrame = await captureFrame(page, viewportSize, fullPage, closePath, "close");
          frames.push(closeFrame);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (outcome === "ok") {
            outcome = "capture_failed";
            errorMessage = `Closing screenshot failed: ${msg}`;
          }
        }
      }

      try {
        finalUrl = page?.url() ?? finalUrl;
      } catch {
        /* keep */
      }

      const primary = frames[frames.length - 1] ?? frames[0];
      return {
        outcome,
        authUsed,
        entryUrl: url,
        finalUrl,
        steps: stepResults,
        frames,
        errorMessage,
        path: primary?.path ?? "",
        width: primary?.width ?? 0,
        height: primary?.height ?? 0,
        truncated: primary?.truncated ?? false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`screenshotPage failed: ${msg}`);
      return emptyResult("capture_failed", msg);
    } finally {
      if (page) {
        try {
          await page.close();
        } catch {}
      }
      if (screenshotContext) {
        try {
          await screenshotContext.close();
        } catch {}
      }
      resetIdleTimer();
      if (session) await session.cleanup();
    }
  });
}

export interface TargetBoundBrowserEvidence {
  targetOrigin: string;
  finalUrl: string;
  authVerified: boolean;
  authStatus: number | null;
  authUserId: string | null;
  blockedRequests: Array<{ kind: "http" | "websocket"; origin: string }>;
}

export async function withTargetBoundBrowserPage<T>(
  entryUrl: string,
  options: {
    viewport?: string | { width: number; height: number };
    timeoutMs?: number;
    authentication?: { mode: "none" } | { mode: "platform_binding"; userId: string; sessionSecret: string };
  },
  execute: (page: Page, evidence: TargetBoundBrowserEvidence) => Promise<T>,
): Promise<{ value: T; evidence: TargetBoundBrowserEvidence }> {
  const parsedEntry = new URL(entryUrl);
  if (!["http:", "https:"].includes(parsedEntry.protocol) || parsedEntry.username || parsedEntry.password) {
    throw new Error("Regression browser target must be one credential-free HTTP(S) origin");
  }
  const targetOrigin = parsedEntry.origin;
  const auth = options.authentication || { mode: "none" as const };
  return withIsolatedBrowserCapacity("browser.regression", async () => {

  let page: Page | null = null;
  let targetContext: BrowserContext | null = null;
  let session: ScreenshotSession | null = null;
  const evidence: TargetBoundBrowserEvidence = {
    targetOrigin,
    finalUrl: entryUrl,
    authVerified: auth.mode === "none",
    authStatus: null,
    authUserId: null,
    blockedRequests: [],
  };
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), Math.max(1_000, Math.min(options.timeoutMs || 60_000, 120_000)));

  try {
    await ensureBrowser();
    if (!browser) throw new Error("Browser not available");
    if (auth.mode === "platform_binding") {
      session = await createScreenshotSession(auth.userId, auth.sessionSecret);
    }

    const viewport = typeof options.viewport === "string"
      ? VIEWPORT_PRESETS[options.viewport] || VIEWPORT_PRESETS.desktop
      : options.viewport || VIEWPORT_PRESETS.desktop;
    targetContext = await browser.newContext({ viewport, serviceWorkers: "block" });

    await targetContext.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      try {
        const parsed = new URL(requestUrl);
        if (["data:", "blob:", "about:"].includes(parsed.protocol) || parsed.origin === targetOrigin) {
          await route.continue();
          return;
        }
        if (evidence.blockedRequests.length < 25) evidence.blockedRequests.push({ kind: "http", origin: parsed.origin });
      } catch {
        if (evidence.blockedRequests.length < 25) evidence.blockedRequests.push({ kind: "http", origin: "invalid" });
      }
      await route.abort("blockedbyclient");
    });
    await targetContext.routeWebSocket("**/*", async (socket) => {
      try {
        const parsed = new URL(socket.url());
        const httpProtocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
        const socketOrigin = `${httpProtocol}//${parsed.host}`;
        if (socketOrigin === targetOrigin) {
          socket.connectToServer();
          return;
        }
        if (evidence.blockedRequests.length < 25) evidence.blockedRequests.push({ kind: "websocket", origin: socketOrigin });
      } catch {
        if (evidence.blockedRequests.length < 25) evidence.blockedRequests.push({ kind: "websocket", origin: "invalid" });
      }
      await socket.close({ code: 1008, reason: "Regression target origin only" });
    });

    if (session) {
      await targetContext.addCookies([{
        name: "connect.sid",
        value: session.signedCookie,
        url: targetOrigin,
        httpOnly: true,
        secure: parsedEntry.protocol === "https:",
        sameSite: "Lax",
      }]);
    }

    page = await targetContext.newPage();
    page.setDefaultTimeout(7_000);
    page.setDefaultNavigationTimeout(15_000);
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => undefined));
    page.on("download", (download) => void download.cancel().catch(() => undefined));
    page.on("popup", (popup) => void popup.close().catch(() => undefined));
    await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    evidence.finalUrl = page.url();
    if (new URL(evidence.finalUrl).origin !== targetOrigin) {
      throw new Error(`Regression browser escaped acceptance target to ${new URL(evidence.finalUrl).origin}`);
    }

    if (auth.mode === "platform_binding") {
      const authResult = await page.evaluate(async () => {
        try {
          const response = await fetch("/api/auth/me", { credentials: "include" });
          const body = await response.json().catch(() => null);
          return { ok: response.ok, status: response.status, userId: body?.user?.id || body?.principal?.userId || null };
        } catch {
          return { ok: false, status: 0, userId: null };
        }
      });
      evidence.authStatus = authResult.status || null;
      evidence.authUserId = authResult.userId || null;
      evidence.authVerified = Boolean(authResult.ok && authResult.userId === auth.userId);
      if (!evidence.authVerified) {
        throw new Error(`Platform-binding regression session was rejected by the snapshotted target with status ${authResult.status}`);
      }
    }

    const abortExecution = new Promise<never>((_, reject) => {
      timeoutController.signal.addEventListener("abort", () => reject(new Error("Regression browser scenario exceeded its total runtime budget")), { once: true });
    });
    const value = await Promise.race([execute(page, evidence), abortExecution]);
    evidence.finalUrl = page.url();
    if (new URL(evidence.finalUrl).origin !== targetOrigin) {
      throw new Error(`Regression browser escaped acceptance target to ${new URL(evidence.finalUrl).origin}`);
    }
    return { value, evidence };
  } finally {
    clearTimeout(timeout);
    if (page) { try { await page.close(); } catch {} }
    if (targetContext) { try { await targetContext.close(); } catch {} }
    if (session) await session.cleanup();
    resetIdleTimer();
  }
  });
}

export interface BrowserSessionEvidenceStep {
  key: string;
  label: string;
  status: "pending" | "passed" | "failed";
  at: string;
  url?: string | null;
  error?: string | null;
}

export interface BrowserSessionEvidence {
  startedAt: string;
  completedAt: string;
  entryUrl: string;
  expectedRoutePath: string;
  finalUrl: string | null;
  currentUrl: string | null;
  authVerified: boolean;
  authStatus: number | null;
  authUserId: string | null;
  authError: string | null;
  loginScreenDetected: boolean;
  screenshot: { path: string; width: number; height: number; truncated: boolean } | null;
  steps: BrowserSessionEvidenceStep[];
  error: string | null;
}

function detectLoginScreenText(text: string, url: string): boolean {
  const normalized = text.toLowerCase();
  return url.includes("/login") || (normalized.includes("sign in") && normalized.includes("password")) || normalized.includes("invalid email or password");
}

export async function captureBrowserSessionEvidence(
  entryUrl: string,
  options: {
    expectedRoutePath: string;
    viewport?: string | { width: number; height: number };
    fullPage?: boolean;
    delay?: number;
    outputPath?: string;
    authenticate?: boolean;
    authentication?: {
      mode: "platform_binding";
      userId: string;
      sessionSecret: string;
    };
  },
): Promise<BrowserSessionEvidence> {
  return withIsolatedBrowserCapacity("browser.acceptance", async () => {
  let page: Page | null = null;
  let screenshotContext: BrowserContext | null = null;
  const startedAt = new Date().toISOString();
  const steps: BrowserSessionEvidenceStep[] = [];
  const mark = (key: string, label: string, status: BrowserSessionEvidenceStep["status"], extra: Partial<BrowserSessionEvidenceStep> = {}) => {
    steps.push({ key, label, status, at: new Date().toISOString(), ...extra });
  };

  let finalUrl: string | null = null;
  let currentUrl: string | null = null;
  let authVerified = false;
  let authStatus: number | null = null;
  let authUserId: string | null = null;
  let authError: string | null = null;
  let loginScreenDetected = false;
  let screenshot: BrowserSessionEvidence["screenshot"] = null;
  let error: string | null = null;

  const entryOrigin = new URL(entryUrl).origin;
  const isLocalTarget = entryUrl.includes("localhost") || entryUrl.includes("127.0.0.1");
  const shouldAuthenticate = options.authenticate ?? true;
  const platformBindingAuth = options.authentication?.mode === "platform_binding" ? options.authentication : null;
  let session: ScreenshotSession | null = null;

  try {
    await ensureBrowser();
    if (!browser) throw new Error("Browser not available");

    if (shouldAuthenticate) {
      if (!isLocalTarget && !platformBindingAuth) {
        throw new Error("Platform-binding auth invariant failed: external acceptance target has no bound user-session identity");
      }
      const userId = platformBindingAuth?.userId;
      if (!userId) {
        throw new Error("Platform-binding auth invariant failed: authenticated acceptance requires the workflow owner user ID");
      }
      session = await createScreenshotSession(userId, platformBindingAuth.sessionSecret);
    }

    let viewportSize: { width: number; height: number };
    const vpOpt = options.viewport;
    if (!vpOpt) {
      viewportSize = VIEWPORT_PRESETS.desktop;
    } else if (typeof vpOpt === "string") {
      if (VIEWPORT_PRESETS[vpOpt]) {
        viewportSize = VIEWPORT_PRESETS[vpOpt];
      } else {
        const match = vpOpt.match(/^(\d+)[xX](\d+)$/);
        viewportSize = match ? { width: parseInt(match[1], 10), height: parseInt(match[2], 10) } : VIEWPORT_PRESETS.desktop;
      }
    } else {
      viewportSize = vpOpt;
    }

    screenshotContext = await browser.newContext({ viewport: viewportSize });

    // Inject session cookie before creating page (same pattern as screenshotPage)
    if (session) {
      await screenshotContext.addCookies([
        {
          name: "connect.sid",
          value: session.signedCookie,
          url: entryOrigin,
          httpOnly: true,
          secure: entryOrigin.startsWith("https://"),
          sameSite: "Lax",
        },
      ]);
    }

    page = await screenshotContext.newPage();
    mark("open", "Open browser session", "passed", { url: entryUrl });
    await page.goto(entryUrl, { waitUntil: "networkidle", timeout: 30000 });
    finalUrl = page.url();
    currentUrl = finalUrl;
    mark("navigate", "Navigate through automation login", "passed", { url: finalUrl });

    const expectedPath = options.expectedRoutePath.startsWith("/") ? options.expectedRoutePath : `/${options.expectedRoutePath}`;
    const finalPath = new URL(finalUrl).pathname;
    const routeMatched = finalPath === expectedPath || finalPath.startsWith(`${expectedPath}/`);
    mark("route", `Verify browser reached ${expectedPath}`, routeMatched ? "passed" : "failed", { url: finalUrl, error: routeMatched ? null : `Final path was ${finalPath}` });

    const sessionCookiePresent = shouldAuthenticate
      ? (await screenshotContext.cookies(entryOrigin)).some((cookie) => cookie.name === "connect.sid")
      : true;
    if (!sessionCookiePresent) {
      throw new Error(`Platform-binding auth invariant failed: Chromium did not retain the signed session cookie for ${entryOrigin}`);
    }

    const authResult = await page.evaluate(async () => {
      try {
        const response = await fetch("/api/auth/me", { credentials: "include" });
        let body: any = null;
        try { body = await response.json(); } catch {}
        return { ok: response.ok, status: response.status, userId: body?.user?.id || body?.principal?.userId || null };
      } catch (err) {
        return { ok: false, status: 0, userId: null, error: err instanceof Error ? err.message : String(err) };
      }
    });
    authStatus = authResult.status || null;
    authVerified = Boolean(authResult.ok && authResult.userId);
    authUserId = authResult.userId || null;
    authError = authVerified
      ? null
      : shouldAuthenticate
        ? `Platform-binding auth invariant failed: injected workflow-owner session was rejected by ${entryOrigin}/api/auth/me with status ${authResult.status}. Verify the bound environment shares the canonical PostgreSQL session store and SESSION_SECRET.`
        : `Auth status ${authResult.status}`;
    mark("auth", "Verify authenticated user session with /api/auth/me", authVerified ? "passed" : "failed", { url: finalUrl, error: authError });

    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    loginScreenDetected = detectLoginScreenText(bodyText, finalUrl);
    mark("login-screen", "Verify browser is not on login screen", !loginScreenDetected ? "passed" : "failed", { url: finalUrl, error: loginScreenDetected ? "Login screen detected" : null });

    const delay = options.delay ?? 1500;
    if (delay > 0) await page.waitForTimeout(delay);

    const scratchDir = process.env.SCRATCH_DIR || "/app/scratch";
    const screenshotsDir = path.join(scratchDir, "screenshots");
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    let outputPath = options.outputPath;
    if (!outputPath) {
      const urlObj = new URL(finalUrl);
      const routeSlug = urlObj.pathname.replace(/\//g, "-").replace(/^-/, "") || "home";
      const vpLabel = typeof vpOpt === "string" ? vpOpt : `${viewportSize.width}x${viewportSize.height}`;
      outputPath = path.join(screenshotsDir, `validation-${routeSlug}-${vpLabel}-${Date.now()}.png`);
    }

    const fullPage = options.fullPage ?? true;
    let truncated = false;
    if (fullPage) {
      const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
      if (scrollHeight > 4000) {
        truncated = true;
        await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: viewportSize.width, height: 4000 } });
      } else {
        await page.screenshot({ path: outputPath, fullPage: true });
      }
    } else {
      await page.screenshot({ path: outputPath });
    }
    const finalHeight = truncated ? 4000 : fullPage ? await page.evaluate(() => document.body.scrollHeight) : viewportSize.height;
    screenshot = { path: outputPath, width: viewportSize.width, height: finalHeight, truncated };
    mark("screenshot", "Capture validation viewport screenshot", "passed", { url: finalUrl });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    mark("error", "Browser session failed", "failed", { url: currentUrl, error });
  } finally {
    if (page) { try { currentUrl = page.url(); } catch {} try { await page.close(); } catch {} }
    if (screenshotContext) { try { await screenshotContext.close(); } catch {} }
    resetIdleTimer();
    if (session) await session.cleanup();
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    entryUrl,
    expectedRoutePath: options.expectedRoutePath,
    finalUrl,
    currentUrl: currentUrl || finalUrl,
    authVerified,
    authStatus,
    authUserId,
    authError,
    loginScreenDetected,
    screenshot,
    steps,
    error,
  };
  });
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (context) {
    try { await context.close(); } catch {}
    context = null;
  }
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
    log.log("Browser closed");
  }
  _isLaunching = false;
  launchPromise = null;
}

export function isBrowserLaunching(): boolean {
  return _isLaunching;
}

export function isBrowserReady(): boolean {
  try {
    const b = browser;
    if (!b) return false;
    const fn = (b as Browser | null)?.isConnected;
    if (typeof fn !== "function") return false;
    return fn.call(b) === true;
  } catch {
    return false;
  }
}

// Defensive on purpose. In the production esbuild bundle this module is only
// reached via dynamic import; historically esbuild's lazy `__esm` wrapper
// memoised itself as "initialised" before the init body finished, so a throw
// mid-init left hoisted module-level diagnostics as `undefined`
// while `getBrowserStats` itself remained callable via the exported
// namespace. The /api/gateway/processes probe hits this every ~2s and
// previously flooded prod logs when a hoisted diagnostic counter was absent.
//
// The `__esm` helper is now patched at build time by
// `script/safe-esm-helper-plugin.ts` (task #928) so a failed init re-throws
// on every subsequent call instead of silently returning a zombie namespace.
// We keep this belt-and-braces guard anyway: it costs nothing and protects
// against unrelated transient failures (e.g. a thrown isBrowserReady probe).
// (See task #924/#928 PR notes for the full bundler forensics.)
export function getBrowserStats(): { activeBrowsers: number; activePages: number; queued: number; launching: boolean } {
  try {
    let active = 0;
    try { active = isBrowserReady() ? 1 : 0; } catch { active = 0; }

    const queued = Number.isFinite(waitingForCapacity) ? Math.max(0, waitingForCapacity) : 0;

    const pagesRef: unknown = activePages;
    const pages = typeof pagesRef === "number" && Number.isFinite(pagesRef) ? pagesRef : 0;

    const launchingRef: unknown = _isLaunching;
    const launching = launchingRef === true;

    return {
      activeBrowsers: active,
      activePages: pages,
      queued,
      launching,
    };
  } catch {
    return { activeBrowsers: 0, activePages: 0, queued: 0, launching: false };
  }
}

// Signal-driven cleanup is owned by the server graceful-shutdown coordinator.
// Keep only the synchronous exit fallback for abrupt local exits.
process.on("exit", () => {
  if (browser) {
    try { browser.close(); } catch {}
  }
});
