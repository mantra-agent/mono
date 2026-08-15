// ─── Trusted registered-key catalogs (spec §3.3, §6.1) ─────────────────────
// These are the code-owned catalogs of keys a first-party definition may
// reference. They mirror the CURRENT product exactly:
//   surfaces   → one key per route-level page component in client/src/App.tsx
//   icons      → the lucide icon names used by app-sidebar navSections
//   connectors → the ids in client/src/pages/integrations.tsx INTEGRATIONS[]
//   widgets    → the SimpleWidgetType renderers in home-widget-renderer.tsx
//   collectors → the server/simple/collectors.ts fan-out sources
//   workflows  → canonical workflow_templates keys (currently build-v1)
//
// Phase 1 is additive/shadow: these catalogs are validation authority only —
// nothing renders from them yet. When Phase 2 introduces the trusted surface
// registry mapping keys to lazy imports, these catalogs become its key source.

export const REGISTERED_SURFACE_KEYS = [
  "home",
  "session",
  "brain",
  "agendas",
  "skills",
  "system",
  "logs",
  "dashboard",
  "goals",
  "goal-detail",
  "vision",
  "strategy",
  "strategy-detail",
  "decisions",
  "calendar",
  "create",
  "work",
  "platforms",
  "products",
  "backlog",
  "platform-environment-detail",
  "memory",
  "tags",
  "build",
  "database",
  "design",
  "people",
  "meetings",
  "recipient-recap",
  "companies",
  "business-model",
  "business-budgets",
  "business-identity",
  "business-plan",
  "job-roles",
  "business-hiring",
  "business-kpis",
  "business-metrics",
  "comms",
  "orientation",
  "news",
  "finance",
  "timers",
  "integrations",
  "issue-detail",
  "wellness",
  "profile",
  "workflows",
  "pipelines",
  "zero",
  "interface-preview",
  "dev-orb",
  "library",
  "files",
  "audiences",
  "campaigns",
  "user-details",
  "vaults",
  "teams",
] as const;
export type RegisteredSurfaceKey = (typeof REGISTERED_SURFACE_KEYS)[number];

export const REGISTERED_ICON_KEYS = [
  "Home",
  "Gauge",
  "Newspaper",
  "Mail",
  "BookOpen",
  "Bot",
  "Building2",
  "Calendar",
  "Briefcase",
  "Activity",
  "Users",
  "MessagesSquare",
  "Target",
  "Scale",
  "Swords",
  "Tags",
  "Waypoints",
  "LineChart",
  "ClipboardList",
  "Lightbulb",
  "FileText",
  "Workflow",
  "GitBranch",
  "Clock",
  "Globe",
  "User",
  "UserPlus",
  "Heart",
  "DatabaseZap",
  "Share2",
  "ScrollText",
  "Boxes",
  "Palette",
  "Hammer",
  "HardDrive",
  "Zap",
  "Wrench",
  "BrainCircuit",
  "Brain",
  "SlidersHorizontal",
  "DollarSign",
  "Megaphone",
  "Vault",
  "Plug",
  "Settings",
] as const;
export type RegisteredIconKey = (typeof REGISTERED_ICON_KEYS)[number];

export const REGISTERED_CONNECTOR_KEYS = [
  "google",
  "box",
  "elevenlabs",
  "cartesia",
  "twilio",
  "deepgram",
  "anthropic",
  "openai",
  "claude-cli",
  "twitter",
  "plaid",
  "quickbooks",
  "brave",
  "github",
  "automation-auth",
  "expo",
  "sentry",
  "sendgrid",
  "meta",
  "oura",
  "recall",
  "slack",
] as const;
export type RegisteredConnectorKey = (typeof REGISTERED_CONNECTOR_KEYS)[number];

// Home widget renderers with dedicated inline content (home-widget-renderer.tsx).
export const REGISTERED_WIDGET_KEYS = [
  "priority_task",
  "meeting",
  "project",
  "inbox_item",
  "wellness",
  "person",
  "state",
] as const;
export type RegisteredWidgetKey = (typeof REGISTERED_WIDGET_KEYS)[number];

// Server collector fan-out sources (server/simple/collectors.ts).
export const REGISTERED_COLLECTOR_KEYS = [
  "goals",
  "projects",
  "milestones",
  "tasks",
  "wellness",
  "people",
  "news",
  "email",
  "meetings",
  "build-deployments",
  "state",
] as const;
export type RegisteredCollectorKey = (typeof REGISTERED_COLLECTOR_KEYS)[number];

// Canonical workflow_templates keys (workflow-service.ts BUILD_WORKFLOW_TEMPLATE_ID).
export const REGISTERED_WORKFLOW_KEYS = ["build-v1"] as const;
export type RegisteredWorkflowKey = (typeof REGISTERED_WORKFLOW_KEYS)[number];

// Code-owned built-in Skill definitions referenced by Mod contributions.
export const REGISTERED_SKILL_KEYS = [
  "self-heal",
  "sentry",
  "guard",
  "regression",
  "reflect",
  "affirmations",
  "coach",
  "brief-daily",
] as const;
export type RegisteredSkillKey = (typeof REGISTERED_SKILL_KEYS)[number];

// Public Unified Tool Registry names owned by optional Mods.
export const REGISTERED_MOD_TOOL_KEYS = [
  "code",
  "git",
  "platforms",
  "railway",
  "sentry",
  "expo",
  "npm_dependencies",
  "regression",
  "issues",
  "health",
  "business",
  "jobs",
  "companies",
  "scenarios",
] as const;
export type RegisteredToolKey = (typeof REGISTERED_MOD_TOOL_KEYS)[number];

// Code-owned managed Timer templates. These keys are lifecycle identities,
// never permission or credential grants.
export const REGISTERED_TIMER_TEMPLATE_KEYS = [
  "build-reliability-sentinel-30m",
  "build-security-sentinel-weekly",
  "post-build-regression",
  "build-self-heal-nightly",
  "weekly-reflection",
  "monthly-reflection",
  "reflect-daily",
  "daily-brief",
] as const;
export type RegisteredTimerTemplateKey = (typeof REGISTERED_TIMER_TEMPLATE_KEYS)[number];

// Trusted server route-group keys. Server route-group contributions are a
// Phase 4 concern; no first-party definition declares one yet, so this catalog
// is intentionally empty but present so validation can enforce membership when
// the first group is added.
export const REGISTERED_ROUTE_GROUP_KEYS = [
  "build.platforms",
  "build.products",
  "build.features",
  "build.issues",
  "build.db-sync",
  "build.railway",
  "business.api",
  "wellness.api",
  "wellness.oura",
  "network.companies",
  "planning.scenarios",
  "slack.api",
] as const;
export type RegisteredRouteGroupKey = (typeof REGISTERED_ROUTE_GROUP_KEYS)[number];

// Semantic command keys (spec §4.2 command targets). None registered yet.
export const REGISTERED_COMMAND_KEYS = [] as const;
export type RegisteredCommandKey = (typeof REGISTERED_COMMAND_KEYS)[number];

// Extension slot keys (spec §4.1). None registered yet in Phase 1.
export const REGISTERED_EXTENSION_SLOT_KEYS = [] as const;
export type RegisteredExtensionSlotKey = (typeof REGISTERED_EXTENSION_SLOT_KEYS)[number];

// Dashboard activity heatmap series keys (must match live collectors in dashboard-activity.ts).
export const REGISTERED_DASHBOARD_HEATMAP_SERIES_KEYS = [
  "opportunity_interactions",
  "completed_tasks",
  "shipped_prs",
  "wellness_completions",
] as const;
export type RegisteredDashboardHeatmapSeriesKey =
  (typeof REGISTERED_DASHBOARD_HEATMAP_SERIES_KEYS)[number];

/** Read-only Set catalogs used by the validator for existence checks. */
export const REGISTERED_KEY_CATALOGS = {
  surface: new Set<string>(REGISTERED_SURFACE_KEYS),
  icon: new Set<string>(REGISTERED_ICON_KEYS),
  connector: new Set<string>(REGISTERED_CONNECTOR_KEYS),
  widget: new Set<string>(REGISTERED_WIDGET_KEYS),
  collector: new Set<string>(REGISTERED_COLLECTOR_KEYS),
  workflow: new Set<string>(REGISTERED_WORKFLOW_KEYS),
  skill: new Set<string>(REGISTERED_SKILL_KEYS),
  tool: new Set<string>(REGISTERED_MOD_TOOL_KEYS),
  timerTemplate: new Set<string>(REGISTERED_TIMER_TEMPLATE_KEYS),
  routeGroup: new Set<string>(REGISTERED_ROUTE_GROUP_KEYS),
  command: new Set<string>(REGISTERED_COMMAND_KEYS),
  slot: new Set<string>(REGISTERED_EXTENSION_SLOT_KEYS),
  dashboardHeatmapSeries: new Set<string>(REGISTERED_DASHBOARD_HEATMAP_SERIES_KEYS),
} as const;
