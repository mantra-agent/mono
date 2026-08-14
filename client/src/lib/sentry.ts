import { createLogger } from "./logger";

const log = createLogger("client:Sentry");

type SentryBrowser = {
  init: (options: Record<string, unknown>) => void;
  captureException: (error: unknown) => void;
  withScope?: (cb: (scope: { setTag: (k: string, v: string) => void }) => void) => void;
};

let initialized = false;
let browserSdk: SentryBrowser | null = null;

declare global {
  interface Window {
    Sentry?: SentryBrowser;
  }
}

function loadBrowserSdk(version = "7.77.0"): Promise<SentryBrowser | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Sentry) return Promise.resolve(window.Sentry);

  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-mantra-sentry]");
    if (existing) {
      existing.addEventListener("load", () => resolve(window.Sentry || null), { once: true });
      existing.addEventListener("error", () => resolve(null), { once: true });
      return;
    }

    const script = document.createElement("script");
    // Loader matches the Node SDK major already in the monorepo toolchain.
    script.src = `https://browser.sentry-cdn.com/${version}/bundle.tracing.min.js`;
    script.crossOrigin = "anonymous";
    script.async = true;
    script.dataset.mantraSentry = "1";
    script.onload = () => resolve(window.Sentry || null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

/**
 * Initialize browser Sentry from the public runtime bootstrap.
 * Fail-open: missing DSN or loader failure is a coverage gap, never a boot failure.
 *
 * Uses the official browser CDN loader so web crash capture does not require a
 * second package install path beyond the shared secrets setup.
 */
export async function initWebSentry(): Promise<boolean> {
  if (initialized) return true;
  if (typeof window === "undefined") return false;

  try {
    const res = await fetch("/api/public/sentry-bootstrap", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      log.debug(`Sentry bootstrap unavailable: HTTP ${res.status}`);
      return false;
    }

    const body = (await res.json()) as {
      dsn?: string | null;
      environment?: string | null;
      release?: string | null;
    };
    const dsn = typeof body.dsn === "string" ? body.dsn.trim() : "";
    if (!dsn) {
      log.debug("Sentry web SDK not configured (no DSN)");
      return false;
    }

    const sdk = await loadBrowserSdk();
    if (!sdk?.init) {
      log.warn("Sentry browser loader failed");
      return false;
    }

    sdk.init({
      dsn,
      environment: body.environment || undefined,
      release: body.release || undefined,
      tracesSampleRate: 0.1,
      initialScope: {
        tags: { surface: "web" },
      },
    });

    browserSdk = sdk;
    initialized = true;
    log.info("Sentry web SDK initialized");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Sentry web init failed: ${message}`);
    return false;
  }
}

export function captureWebException(error: unknown): void {
  if (!initialized || !browserSdk) return;
  try {
    if (browserSdk.withScope) {
      browserSdk.withScope((scope) => {
        scope.setTag("surface", "web");
        browserSdk!.captureException(error);
      });
      return;
    }
    browserSdk.captureException(error);
  } catch {
    // fail-open
  }
}

export function isWebSentryActive(): boolean {
  return initialized;
}
