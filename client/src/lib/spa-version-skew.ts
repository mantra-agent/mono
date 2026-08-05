import { createLogger } from "./logger";

const log = createLogger("SpaVersionSkew");
const AUTO_RELOAD_KEY = "mantra:spa-version-skew:auto-reload";
const PROMPT_ID = "mantra-version-skew-prompt";
const MIN_CHECK_INTERVAL_MS = 15_000;

interface VersionResponse {
  buildId?: unknown;
}

let installed = false;
let inFlight: Promise<void> | null = null;
let lastCheckAt = 0;

function isChunkLoadFailure(value: unknown): boolean {
  const error = value instanceof Error ? value : null;
  const name = error?.name || "";
  const message = error?.message || String(value || "");

  return (
    name === "ChunkLoadError" ||
    /Loading chunk [\d-]+ failed/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message)
  );
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
  showPromptOnFailure = false,
): Promise<void> {
  if (__MANTRA_BUILD_ID__ === "development") return;

  const now = Date.now();
  if (!force && now - lastCheckAt < MIN_CHECK_INTERVAL_MS) return;
  if (inFlight) return inFlight;

  lastCheckAt = now;
  inFlight = (async () => {
    try {
      const serverBuildId = await fetchServerBuildId();
      if (!serverBuildId || serverBuildId === __MANTRA_BUILD_ID__) return;

      log.warn("SPA version skew detected", {
        clientBuildId: __MANTRA_BUILD_ID__,
        serverBuildId,
      });

      try {
        if (sessionStorage.getItem(AUTO_RELOAD_KEY) === serverBuildId) {
          showUpdatePrompt();
          return;
        }

        sessionStorage.setItem(AUTO_RELOAD_KEY, serverBuildId);
        window.location.reload();
      } catch {
        showUpdatePrompt();
      }
    } catch (error) {
      log.warn("SPA version check unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (showPromptOnFailure) showUpdatePrompt();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function attemptVersionSkewRecovery(error: unknown): void {
  if (!isChunkLoadFailure(error)) return;
  void checkForVersionSkew(true, true);
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
}
