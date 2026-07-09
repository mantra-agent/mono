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

const execAsync = promisify(exec);
const log = createLogger("BrowserManager");

const MAX_CONCURRENT_PAGES = 3;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const PAGE_TIMEOUT_MS = 30_000;

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let launchPromise: Promise<Browser> | null = null;
let activePages = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let _isLaunching = false;

const pageQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

// Discovers Chromium binary from PATH — relies on chromium installed via apt in the Docker runtime stage
async function getChromiumPath(): Promise<string> {
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
  throw new Error("Chromium binary not found. Install chromium system dependency.");
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
        "--single-process",
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

async function acquirePageSlot(): Promise<void> {
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages++;
    return;
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = pageQueue.indexOf(entry);
      if (idx >= 0) pageQueue.splice(idx, 1);
      reject(new Error(`Timed out waiting for browser page slot (max ${MAX_CONCURRENT_PAGES} concurrent).`));
    }, PAGE_TIMEOUT_MS);

    const entry = {
      resolve: () => { clearTimeout(timer); activePages++; resolve(); },
      reject,
    };
    pageQueue.push(entry);
  });
}

function releasePageSlot() {
  activePages--;
  if (pageQueue.length > 0 && activePages < MAX_CONCURRENT_PAGES) {
    const next = pageQueue.shift();
    if (next) next.resolve();
  }
}

export async function fetchWithBrowser(url: string, timeoutMs: number = PAGE_TIMEOUT_MS): Promise<string> {
  await acquirePageSlot();

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
    releasePageSlot();
    resetIdleTimer();
  }
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

async function createScreenshotSession(): Promise<ScreenshotSession> {
  // Dynamic imports for CJS deps (transitive from express-session)
  const uidSafe = await import("uid-safe") as unknown as { default?: { sync: (len: number) => string }; sync?: (len: number) => string };
  const uidSync = (uidSafe.default?.sync ?? uidSafe.sync) as (len: number) => string;

  const cookieSig = await import("cookie-signature") as unknown as { default?: { sign: (val: string, secret: string) => string }; sign?: (val: string, secret: string) => string };
  const cookieSign = (cookieSig.default?.sign ?? cookieSig.sign) as (val: string, secret: string) => string;

  const sid = uidSync(24);
  const secret = process.env.SESSION_SECRET || "dev-secret";

  // Look up the first admin user via raw pg pool
  const { pool } = await import("./db");
  const usersResult = await pool.query(
    "SELECT id FROM \"users\" WHERE role = 'admin' LIMIT 1"
  );
  const adminId: number | undefined = usersResult.rows[0]?.id;
  if (!adminId) throw new Error("No admin user found for screenshot session");

  // Insert a short-lived session row (60s TTL).
  // connect-pg-simple reads sessions with `expire >= to_timestamp(epoch_seconds)`
  // so we must store expire via to_timestamp() too — a JS Date lands as
  // `timestamp without time zone` which silently drops timezone context and
  // causes comparison mismatches when the server TZ differs from UTC.
  const expireEpochSeconds = Math.ceil((Date.now() + 60_000) / 1000);
  const sess = JSON.stringify({ cookie: { maxAge: 60000 }, userId: adminId });
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

export async function screenshotPage(
  url: string,
  options?: {
    viewport?: string | { width: number; height: number };
    fullPage?: boolean;
    delay?: number;
    outputPath?: string;
  }
): Promise<{ path: string; width: number; height: number; truncated: boolean }> {
  await acquirePageSlot();
  let page: Page | null = null;
  let screenshotContext: BrowserContext | null = null;

  // Determine if URL targets an external host (not localhost)
  const isExternal = !url.includes("localhost") && !url.includes("127.0.0.1");
  const session = isExternal ? null : await createScreenshotSession();

  try {
    await ensureBrowser();
    if (!browser) throw new Error("Browser not available");

    // Resolve viewport
    let viewportSize: { width: number; height: number };
    const vpOpt = options?.viewport;
    if (!vpOpt) {
      viewportSize = VIEWPORT_PRESETS.desktop;
    } else if (typeof vpOpt === "string") {
      if (VIEWPORT_PRESETS[vpOpt]) {
        viewportSize = VIEWPORT_PRESETS[vpOpt];
      } else {
        const match = vpOpt.match(/^(\d+)[xX](\d+)$/);
        if (match) {
          viewportSize = { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
        } else {
          viewportSize = VIEWPORT_PRESETS.desktop;
        }
      }
    } else {
      viewportSize = vpOpt;
    }

    // Create a SEPARATE context — no route blocking, so CSS/images/fonts load
    if (isExternal) {
      // External target: authenticate via bearer token, no cookie injection
      let extraHTTPHeaders: Record<string, string> = {};
      try {
        const { getSetting } = await import("./system-settings");
        const token = await getSetting<string>("system.automation_auth_token");
        if (token) {
          extraHTTPHeaders["Authorization"] = `Bearer ${token}`;
        }
      } catch {
        // Proceed without auth header
      }
      screenshotContext = await browser.newContext({ viewport: viewportSize, extraHTTPHeaders });
    } else {
      // Localhost: use session cookie auth
      screenshotContext = await browser.newContext({ viewport: viewportSize });
      await screenshotContext.addCookies([
        {
          name: "connect.sid",
          value: session!.signedCookie,
          domain: "localhost",
          path: "/",
        },
      ]);
    }

    page = await screenshotContext.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    const delay = options?.delay ?? 2000;
    if (delay > 0) {
      await page.waitForTimeout(delay);
    }

    // Build output path
    const scratchDir = process.env.SCRATCH_DIR || "/app/scratch";
    const screenshotsDir = path.join(scratchDir, "screenshots");
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }

    let outputPath = options?.outputPath;
    if (!outputPath) {
      const urlObj = new URL(url);
      const routeSlug = urlObj.pathname.replace(/\//g, "-").replace(/^-/, "") || "home";
      const vpLabel = typeof vpOpt === "string" ? vpOpt : `${viewportSize.width}x${viewportSize.height}`;
      const timestamp = Date.now();
      outputPath = path.join(screenshotsDir, `${routeSlug}-${vpLabel}-${timestamp}.png`);
    }

    const fullPage = options?.fullPage ?? false;
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

    const finalHeight = truncated
      ? 4000
      : fullPage
      ? await page.evaluate(() => document.body.scrollHeight)
      : viewportSize.height;

    log.log(`Screenshot saved: ${outputPath} (${viewportSize.width}×${finalHeight}${truncated ? " truncated" : ""})`);

    return { path: outputPath, width: viewportSize.width, height: finalHeight, truncated };
  } finally {
    if (page) { try { await page.close(); } catch {} }
    if (screenshotContext) { try { await screenshotContext.close(); } catch {} }
    releasePageSlot();
    resetIdleTimer();
    if (session) await session.cleanup();
  }
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
  },
): Promise<BrowserSessionEvidence> {
  await acquirePageSlot();
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
  let loginScreenDetected = false;
  let screenshot: BrowserSessionEvidence["screenshot"] = null;
  let error: string | null = null;

  // Determine if we should inject DB session auth (localhost targets only)
  const shouldAuthenticate = (options.authenticate ?? true) &&
    (entryUrl.includes("localhost") || entryUrl.includes("127.0.0.1"));
  let session: ScreenshotSession | null = null;

  try {
    await ensureBrowser();
    if (!browser) throw new Error("Browser not available");

    // Create DB session for cookie injection when authenticating localhost
    if (shouldAuthenticate) {
      session = await createScreenshotSession();
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
          domain: "localhost",
          path: "/",
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
    mark("auth", "Verify authenticated user session with /api/auth/me", authVerified ? "passed" : "failed", { url: finalUrl, error: authVerified ? null : `Auth status ${authResult.status}` });

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
    releasePageSlot();
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
    loginScreenDetected,
    screenshot,
    steps,
    error,
  };
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
// mid-init left hoisted module-level vars (e.g. `pageQueue`) as `undefined`
// while `getBrowserStats` itself remained callable via the exported
// namespace. The /api/gateway/processes probe hits this every ~2s and
// previously flooded prod logs with "Cannot read properties of undefined
// (reading 'length')".
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

    const queueRef: unknown = pageQueue;
    const queued = Array.isArray(queueRef) ? queueRef.length : 0;

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

process.on("SIGTERM", () => { closeBrowser().catch(() => {}); });
process.on("SIGINT", () => { closeBrowser().catch(() => {}); });
process.on("exit", () => {
  if (browser) {
    try { browser.close(); } catch {}
  }
});
