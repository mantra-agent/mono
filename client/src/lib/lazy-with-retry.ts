import { lazy } from "react";
import { createLogger } from "@/lib/logger";
import { markNavigationLazyReady } from "@/lib/navigation-trace";

const log = createLogger("lazyWithRetry");
const IMPORT_ATTEMPT_TIMEOUT_MS = 6_000;
const RETRY_DELAY_MS = 500;

export class RouteLoadError extends Error {
  readonly code = "ROUTE_MODULE_LOAD_FAILED";
  readonly attempts: number;
  readonly causeName: string;

  constructor(message: string, attempts: number, cause: unknown) {
    super(message, { cause });
    this.name = "RouteLoadError";
    this.attempts = attempts;
    this.causeName = cause instanceof Error ? cause.name : typeof cause;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadWithTimeout<T>(
  factory: () => Promise<{ default: T }>,
  attempt: number,
): Promise<{ default: T }> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new RouteLoadError("Page module request timed out.", attempt, new Error("timeout")));
    }, IMPORT_ATTEMPT_TIMEOUT_MS);

    factory().then(
      (module) => {
        window.clearTimeout(timer);
        resolve(module);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function lazyWithRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      const module = await loadWithTimeout(factory, 1);
      markNavigationLazyReady();
      return module;
    } catch (firstError) {
      log.warn("page module load failed; retrying", {
        attempt: 1,
        errorName: firstError instanceof Error ? firstError.name : typeof firstError,
      });
    }

    await wait(RETRY_DELAY_MS);

    try {
      const module = await loadWithTimeout(factory, 2);
      markNavigationLazyReady();
      return module;
    } catch (retryError) {
      markNavigationLazyReady(true);
      const error = new RouteLoadError(
        "Failed to load the page module after two bounded attempts.",
        2,
        retryError,
      );
      window.dispatchEvent(
        new CustomEvent("mantra:route-module-load-failed", { detail: error }),
      );
      log.error("page module load exhausted", error, {
        attempts: error.attempts,
        errorName: error.causeName,
      });
      throw error;
    }
  });
}
