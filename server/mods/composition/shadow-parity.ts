// ─── Shadow-mode drift detection (Phase 1) ─────────────────────────────────
// Compares the resolver's output for the DEFAULT (all-first-party-Mods-active)
// account shape against today's hard-coded client composition lists — the
// app-sidebar navSections and the App.tsx canonical route table — and emits a
// structured warn-level drift log when they diverge. Nothing renders from the
// resolver yet; this only proves shadow parity.
//
// FIXTURE_* below is a deliberate, temporary snapshot of the current
// hard-coded client lists. It exists ONLY so the shadow resolver can be
// compared against reality, and it is expected to be deleted at the Phase 2
// cutover when the client begins consuming /api/product-composition. Keep it in
// sync with client/src/components/app-sidebar.tsx and client/src/App.tsx while
// it lives.

import { createLogger } from "../../log";
import { composeParityShape } from "./contribution-resolver";

const log = createLogger("mod-composition-parity");

// Snapshot of app-sidebar.tsx navSections as `${section}|${label}` keys.
const FIXTURE_NAV_KEYS: string[] = [
  "Tools|Home",
  "Tools|Dashboard",
  "Tools|News",
  "Tools|Email",
  "Tools|Library",
  "Tools|Schedule",
  "Tools|Projects",
  "Wellness|Habits",
  "Wellness|Reflections",
  "Wellness|Gratitude",
  "Network|People",
  "Network|Meetings",
  "Network|Companies",
  "Planning|Goals",
  "Planning|Decisions",
  "Planning|Strategy",
  "Business|Advantage",
  "Business|Pipelines",
  "Business|Model",
  "Business|Roles",
  "Automation|Agendas",
  "Automation|Skills",
  "Automation|Plans",
  "Automation|Hooks",
  "Automation|Timers",
  "Agent|Orientation",
  "Agent|Persona",
  "Agent|Emotion",
  "Memory|Layers",
  "Memory|Graph",
  "Memory|Journal",
  "Build|Platforms",
  "Build|Design",
  "Build|Toast",
  "Build|Database",
  "Build|Issues",
  "System|Performance",
  "System|Logs",
  "System|Events",
  "System|Tools",
  "System|Prompts",
  "System|Context",
  "System|Router",
  "System|Models",
  "System|Cost",
  "Admin|Audiences",
  "Admin|Campaigns",
  "Admin|Users",
  "Admin|Vaults",
  "Admin|Integrations",
  "Admin|Account",
];

// Snapshot of App.tsx canonical (non-redirect, non-alias) route paths, with
// dynamic params normalized. Redirect aliases (/calendar, /work, /comms, etc.)
// are intentionally excluded because they are compatibility redirects, not
// canonical routes the resolver reproduces.
const FIXTURE_ROUTE_PATHS: string[] = [
  "/home",
  "/session",
  "/brain",
  "/agendas",
  "/skills",
  "/system",
  "/logs",
  "/dashboard",
  "/memory",
  "/create",
  "/email",
  "/orientation",
  "/news",
  "/meeting-recap/:param",
  "/timers",
  "/brain/timers",
  "/integrations",
  "/integrations/:param",
  "/profile",
  "/zero",
  "/interface-preview",
  "/dev/orb",
  "/dev/toast",
  "/library",
  "/info",
  "/audiences",
  "/campaigns",
  "/account",
  "/goals",
  "/goals/:param",
  "/vision",
  "/schedule",
  "/schedule/:param",
  "/projects",
  "/build",
  "/database",
  "/design",
  "/platforms",
  "/platforms/environments/:param",
  "/issues/:param",
  "/strategy",
  "/strategy/:param",
  "/decisions",
  "/companies",
  "/companies/:param",
  "/business/model",
  "/business/plan",
  "/business/roles",
  "/pipelines",
  "/habits",
  "/reflections",
  "/gratitude",
  "/health",
  "/people",
  "/people/:param",
  "/meetings",
  "/finance",
];

function normalizePath(path: string): string {
  return path.replace(/\/:[^/]+/g, "/:param");
}

function diff(fixture: string[], resolved: string[]): { missing: string[]; extra: string[] } {
  const fixtureSet = new Set(fixture);
  const resolvedSet = new Set(resolved);
  return {
    missing: fixture.filter((v) => !resolvedSet.has(v)).sort(),
    extra: resolved.filter((v) => !fixtureSet.has(v)).sort(),
  };
}

let _lastRunAt = 0;
const PARITY_MIN_INTERVAL_MS = 60_000;

/**
 * Run the shadow-parity drift check for the default account shape. Bounded and
 * throttled to at most once per minute; the comparison itself is pure, DB-free,
 * and reads no real account state (composeParityShape is synthetic).
 */
export function runShadowParityCheck(force = false): void {
  const now = Date.now();
  if (!force && now - _lastRunAt < PARITY_MIN_INTERVAL_MS) return;
  _lastRunAt = now;

  try {
    const parity = composeParityShape("web");

    const resolvedNavKeys = parity.navigation.map((n) => `${n.section}|${n.label}`);
    const resolvedRoutePaths = parity.routes.map((r) => normalizePath(r.path));

    const navDiff = diff(FIXTURE_NAV_KEYS, resolvedNavKeys);
    const routeDiff = diff(FIXTURE_ROUTE_PATHS, resolvedRoutePaths);

    const navDrift = navDiff.missing.length > 0 || navDiff.extra.length > 0;
    const routeDrift = routeDiff.missing.length > 0 || routeDiff.extra.length > 0;

    if (navDrift || routeDrift) {
      log.warn("shadow composition drift detected", {
        compositionVersion: parity.compositionVersion,
        nav: navDrift
          ? {
              missingFromResolved: navDiff.missing.slice(0, 25),
              extraInResolved: navDiff.extra.slice(0, 25),
            }
          : undefined,
        routes: routeDrift
          ? {
              missingFromResolved: routeDiff.missing.slice(0, 25),
              extraInResolved: routeDiff.extra.slice(0, 25),
            }
          : undefined,
      });
    } else {
      log.debug("shadow composition parity holds", {
        compositionVersion: parity.compositionVersion,
        navigation: resolvedNavKeys.length,
        routes: resolvedRoutePaths.length,
      });
    }
  } catch (error) {
    log.warn("shadow parity check failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
