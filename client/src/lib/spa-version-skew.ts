import { createLogger } from "./logger";

const log = createLogger("SpaVersionSkew");
const AUTO_RELOAD_KEY = "mantra:spa-version-skew:auto-reload";
// Sentinel reload key for a confirmed chunk failure when the server cannot
// report its build id. Keeps the one-shot reload bounded without a real SHA.
const UNKNOWN_BUILD_RELOAD_KEY = "unknown-build";
const PROMPT_ID = "mantra-version-skew-prompt";
const MIN_CHECK_INTERVAL_MS = 15_000;

interface VersionResponse {
  buildId?: unknown;
}

export type VersionSkewRecoveryOutcome =
  | "not_chunk_failure"
  | "same_build"
  | "reload_started"
  | "update_prompted"
  | "check_unavailable";

let installed = false;
let inFlight: Promise<VersionSkewRecoveryOutcome> | null = null;
let lastCheckAt = 0;

function isChunkLoadFailure(value: unknown): boolean {
  let candidate: unknown = value;

  for (let depth = 0; depth < 4; depth += 1) {
    const error = candidate instanceof Error ? candidate : null;
    const name = error?.name || "";
    const message = error?.message || String(candidate || "");

    if (
      name === "ChunkLoadError" ||
      /Loading chunk [\d-]+ failed/i.test(message) ||
      /Failed to fetch dynamically imported module/i.test(message) ||
      /Importing a module script failed/i.test(message) ||
      /error loading dynamically imported module/i.test(message) ||
      /is not a valid JavaScript MIME type/i.test(message)
    ) {
      return true;
    }

    if (!error || !("cause" in error) || error.cause == null || error.cause === candidate) {
      return false;
    }
    candidate = error.cause;
  }

  return false;
}

function showUpdatePrompt(): void {
  if (document.getElementById(PROMPT_ID)) return;

  const prompt = document.createElement("div");
  prompt.id = PROMPT_ID;
  prompt.setAttribute("role", "alert");
  prompt.className =
    "fixed inset-x-0 bottom-6 z-[10000] flex justify-center px-4 pointer-events-none";

  const card = document.createElement("div");
  card.className =
    "pointer-events-auto flex w-full max-w-md items-center gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-lg";

  const copy = document.createElement("div");
  copy.className = "min-w-0 flex-1";

  const title = document.createElement("p");
  title.className = "text-sm font-semibold";
  title.textContent = "Update ready";

  const message = document.createElement("p");
  message.className = "mt-1 text-sm text-muted-foreground";
  message.textContent = "Reload Mantra to use the latest version.";

  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  button.textContent = "Reload";
  button.addEventListener("click", () => window.location.reload());

  copy.append(title, message);
  card.append(copy, button);
  prompt.append(card);
  document.body.append(prompt);
}

function reloadOnceOrPrompt(reloadKey: string): VersionSkewRecoveryOutcome {
  try {
    if (sessionStorage.getItem(AUTO_RELOAD_KEY) === reloadKey) {
      showUpdatePrompt();
      return "update_prompted";
    }

    sessionStorage.setItem(AUTO_RELOAD_KEY, reloadKey);
    window.location.reload();
    return "reload_started";
  } catch {
    showUpdatePrompt();
    return "update_prompted";
  }
}

async function fetchServerBuildId(): Promise<string | null> {
  const response = await fetch("/api/version", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Version check failed with status ${response.status}`);
  }

  const payload = (await response.json()) as VersionResponse;
  return typeof payload.buildId === "string" && payload.buildId.trim()
    ? payload.buildId.trim()
    : null;
}

async function checkForVersionSkew(
  force: boolean,
  recoverChunkFailure = false,
): Promise<VersionSkewRecoveryOutcome> {
  if (__MANTRA_BUILD_ID__ === "development") return "same_build";

  const now = Date.now();
  if (!force && now - lastCheckAt < MIN_CHECK_INTERVAL_MS) return "same_build";
  if (inFlight) {
    const sharedOutcome = await inFlight;
    if (
      recoverChunkFailure &&
      sharedOutcome !== "reload_started" &&
      sharedOutcome !== "update_prompted"
    ) {
      return checkForVersionSkew(true, true);
    }
    return sharedOutcome;
  }

  lastCheckAt = now;
  inFlight = (async () => {
    try {
      const serverBuildId = await fetchServerBuildId();
      if (!serverBuildId) {
        // A confirmed chunk failure with no resolvable server build id must not
        // strand the route on same_build. Attempt one guarded reload keyed by a
        // fixed sentinel so a stale or dropped asset still gets one recovery
        // pass without looping; ordinary skew checks keep same_build.
        if (!recoverChunkFailure) return "same_build";
        log.warn("SPA chunk failure with unresolved server build id", {
          clientBuildId: __MANTRA_BUILD_ID__,
        });
        return reloadOnceOrPrompt(UNKNOWN_BUILD_RELOAD_KEY);
      }

      const buildChanged = serverBuildId !== __MANTRA_BUILD_ID__;
      if (!buildChanged && !recoverChunkFailure) return "same_build";

      log.warn(buildChanged ? "SPA version skew detected" : "SPA chunk response invalid", {
        clientBuildId: __MANTRA_BUILD_ID__,
        serverBuildId,
      });

      return reloadOnceOrPrompt(serverBuildId);
    } catch (error) {
      log.warn("SPA version check unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (recoverChunkFailure) showUpdatePrompt();
      return "check_unavailable";
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function attemptVersionSkewRecovery(
  error: unknown,
): Promise<VersionSkewRecoveryOutcome> {
  if (!isChunkLoadFailure(error)) return Promise.resolve("not_chunk_failure");
  return checkForVersionSkew(true, true);
}

export function installSpaVersionSkewGuard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("focus", () => {
    void checkForVersionSkew(false);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void checkForVersionSkew(false);
    }
  });

  window.addEventListener("error", (event) => {
    attemptVersionSkewRecovery(event.error || event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    attemptVersionSkewRecovery(event.reason);
  });

  window.addEventListener("vite:preloadError", (event) => {
    attemptVersionSkewRecovery((event as CustomEvent<unknown>).payload);
  });

  window.addEventListener("mantra:route-module-load-failed", (event) => {
    attemptVersionSkewRecovery((event as CustomEvent<unknown>).detail);
  });
}
