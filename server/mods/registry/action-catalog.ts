// ─── Semantic action catalog (spec §4.2) ───────────────────────────────────
// Reproduces today's UI_INTERACTION_TARGET_ROUTES (shared/ui-interaction.ts) as
// owner-namespaced navigate ActionContributions. One route owns the path; nav
// and actions reference the stable route ID (spec §2.8). The live
// UI_INTERACTION_TARGET_ROUTES map is unchanged in this phase — these actions
// are the shadow representation and render nothing yet.
//
// navigation.sidebar.toggle is intentionally excluded: it is a pure UI control
// with an empty href, not a semantic navigation destination.

import type { ActionContribution, PermissionKey } from "@shared/models/mod-registry";

type Owner = "core" | "planning" | "build" | "business" | "wellness" | "network" | "finance";

interface ActionRow {
  slug: string;
  owner: Owner;
  routeId: string;
  permission?: PermissionKey;
}

// Route destinations mirror shared/ui-interaction.ts href paths (query strings
// collapse to the owning route ID; the tab is a route-internal concern).
const ACTION_ROWS: ActionRow[] = [
  { slug: "home", owner: "core", routeId: "core.route.home" },
  { slug: "dashboard", owner: "core", routeId: "core.route.dashboard", permission: "system:read" },
  { slug: "news", owner: "core", routeId: "core.route.news" },
  { slug: "email", owner: "core", routeId: "core.route.email" },
  { slug: "library", owner: "core", routeId: "core.route.library" },
  { slug: "agendas", owner: "core", routeId: "core.route.agendas" },
  { slug: "skills", owner: "core", routeId: "core.route.skills" },
  { slug: "plans", owner: "core", routeId: "core.route.brain" },
  { slug: "hooks", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "timers", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "orientation", owner: "core", routeId: "core.route.orientation" },
  { slug: "persona", owner: "core", routeId: "core.route.brain" },
  { slug: "emotion", owner: "core", routeId: "core.route.brain" },
  { slug: "memory-layers", owner: "core", routeId: "core.route.memory" },
  { slug: "memory-graph", owner: "core", routeId: "core.route.memory" },
  { slug: "memory-journal", owner: "core", routeId: "core.route.memory" },
  { slug: "tags", owner: "core", routeId: "core.route.tags" },
  { slug: "performance", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "logs", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "events", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "tools", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "context", owner: "core", routeId: "core.route.brain", permission: "system:read" },
  { slug: "router", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "cost", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "audiences", owner: "core", routeId: "core.route.audiences", permission: "system:read" },
  { slug: "campaigns", owner: "core", routeId: "core.route.campaigns", permission: "system:read" },
  { slug: "accounts", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "agents", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "users", owner: "core", routeId: "core.route.system", permission: "system:read" },
  { slug: "vaults", owner: "core", routeId: "core.route.vaults" },
  { slug: "teams", owner: "core", routeId: "core.route.teams" },
  { slug: "integrations", owner: "core", routeId: "core.route.integrations" },
  { slug: "account", owner: "core", routeId: "core.route.account" },
  { slug: "schedule", owner: "planning", routeId: "planning.route.schedule" },
  { slug: "projects", owner: "planning", routeId: "planning.route.projects" },
  { slug: "goals", owner: "planning", routeId: "planning.route.goals" },
  { slug: "habits", owner: "wellness", routeId: "wellness.route.habits" },
  { slug: "reflections", owner: "wellness", routeId: "wellness.route.reflections" },
  { slug: "gratitude", owner: "wellness", routeId: "wellness.route.gratitude" },
  { slug: "health", owner: "wellness", routeId: "wellness.route.health" },
  { slug: "wellness", owner: "wellness", routeId: "wellness.route.habits" },
  { slug: "people", owner: "network", routeId: "network.route.people" },
  { slug: "meetings", owner: "network", routeId: "network.route.meetings" },
  { slug: "companies", owner: "network", routeId: "network.route.companies" },
  { slug: "pipelines", owner: "network", routeId: "network.route.pipelines" },
  { slug: "decisions", owner: "core", routeId: "core.route.decisions" },
  { slug: "definition", owner: "business", routeId: "business.route.definition", permission: "system:read" },
  { slug: "pricing", owner: "business", routeId: "business.route.pricing", permission: "system:read" },
  { slug: "business-model", owner: "business", routeId: "business.route.business-model", permission: "system:read" },
  { slug: "budgets", owner: "business", routeId: "business.route.budgets", permission: "system:read" },
  { slug: "advantage", owner: "business", routeId: "business.route.advantage" },
  { slug: "roles", owner: "business", routeId: "business.route.job-roles", permission: "system:read" },
  { slug: "platforms", owner: "build", routeId: "build.route.platforms", permission: "build:read" },
  { slug: "design", owner: "build", routeId: "build.route.design", permission: "build:read" },
  { slug: "database", owner: "build", routeId: "build.route.database", permission: "build:read" },
  { slug: "issues", owner: "build", routeId: "build.route.build", permission: "build:read" },
  { slug: "prompts", owner: "core", routeId: "core.route.system", permission: "build:read" },
];

function slugToLabel(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Return the navigate ActionContributions owned by one definition. */
export function actionsForOwner(owner: Owner): ActionContribution[] {
  return ACTION_ROWS.filter((row) => row.owner === owner).map((row) => ({
    kind: "action" as const,
    id: `${row.owner}.action.${row.slug}`,
    label: `Open ${slugToLabel(row.slug)}`,
    target: { kind: "navigate" as const, routeId: row.routeId },
    audience: "primary" as const,
    ...(row.permission ? { requiredPermissions: [row.permission] } : {}),
  }));
}
