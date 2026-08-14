import { createLogger } from "./log";
import { resolveSentryDsnSync } from "./integrations/sentry/config";

const log = createLogger("SentrySdk");

let initialized = false;

/**
 * Initialize the Node Sentry SDK once secrets are loaded.
 * Fail-open: missing DSN is a coverage gap, never a boot failure.
 */
export function initServerSentry(): boolean {
  if (initialized) return true;
  const dsn = resolveSentryDsnSync();
  if (!dsn) {
    log.info("Sentry server SDK not configured (missing SENTRY_DSN)");
    return false;
  }

  try {
    // Lazy require so optional absence of the package cannot break boot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/node") as typeof import("@sentry/node");
    const gitCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || undefined;
    const environmentName =
      process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
      process.env.NODE_ENV ||
      "development";

    Sentry.init({
      dsn,
      environment: environmentName,
      release: gitCommit,
      tracesSampleRate: 0.1,
      // Keep local/dev silent unless explicitly enabled.
      enabled: process.env.NODE_ENV === "production" || process.env.SENTRY_ENABLE_DEV === "true",
      initialScope: {
        tags: {
          surface: "server",
        },
      },
    });

    initialized = true;
    log.info("Sentry server SDK initialized");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Sentry server SDK init failed: ${message}`);
    return false;
  }
}

export function isServerSentryActive(): boolean {
  return initialized;
}

/** Express request handler from Sentry, or a no-op passthrough. */
export function sentryRequestHandler() {
  if (!initialized) {
    return (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next();
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/node") as typeof import("@sentry/node");
    return Sentry.Handlers.requestHandler();
  } catch {
    return (_req: unknown, _res: unknown, next: (err?: unknown) => void) => next();
  }
}

/** Express error handler from Sentry, or a no-op that forwards. */
export function sentryErrorHandler() {
  if (!initialized) {
    return (err: unknown, _req: unknown, _res: unknown, next: (err?: unknown) => void) => next(err);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/node") as typeof import("@sentry/node");
    return Sentry.Handlers.errorHandler();
  } catch {
    return (err: unknown, _req: unknown, _res: unknown, next: (err?: unknown) => void) => next(err);
  }
}

export function captureServerException(error: unknown, context?: Record<string, string>): void {
  if (!initialized) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Sentry = require("@sentry/node") as typeof import("@sentry/node");
    Sentry.withScope((scope) => {
      if (context) {
        for (const [key, value] of Object.entries(context)) {
          scope.setTag(key, value);
        }
      }
      scope.setTag("surface", "server");
      Sentry.captureException(error);
    });
  } catch {
    // fail-open
  }
}
