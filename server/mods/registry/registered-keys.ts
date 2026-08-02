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
  "platform-environment-detail",
  "memory",
  "build",
  "database",
  "design",
  "people",
  "meetings",
  "recipient-recap",
  "companies",
  "business-model",
  "business-advantage",
  "job-roles",
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
  "audiences",
  "campaigns",
  "user-details",
] as const;
export type RegisteredSurfaceKey = (typeof REGISTERED_SURFACE_KEYS)[number];

export const REGISTERED_ICON_KEYS = [
  "Home",
  "Gauge",
  "Newspaper",
  "Mail",
  "BookOpen",
  "Calendar",
  "Briefcase",
  "Activity",
  "Users",
  "MessagesSquare",
  "Target",
  "Scale",
  "Swords",
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
  "Heart",
  "DatabaseZap",
  "Share2",
  "ScrollText",
  "Boxes",
  "Palette",
  "Hammer",
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
  "railway",
  "cloudflare",
  "automation-auth",
  "expo",
  "sentry",
  "sendgrid",
  "meta",
  "oura",
  "recall",
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
  "state",
] as const;
export type RegisteredCollectorKey = (typeof REGISTERED_COLLECTOR_KEYS)[number];

// Canonical workflow_templates keys (workflow-service.ts BUILD_WORKFLOW_TEMPLATE_ID).
export const REGISTERED_WORKFLOW_KEYS = ["build-v1"] as const;
export type RegisteredWorkflowKey = (typeof REGISTERED_WORKFLOW_KEYS)[number];

// Trusted server route-group keys. Server route-group contributions are a
// Phase 4 concern; no first-party definition declares one yet, so this catalog
// is intentionally empty but present so validation can enforce membership when
// the first group is added.
export const REGISTERED_ROUTE_GROUP_KEYS = [] as const;
export type RegisteredRouteGroupKey = (typeof REGISTERED_ROUTE_GROUP_KEYS)[number];

// Semantic command keys (spec §4.2 command targets). None registered yet.
export const REGISTERED_COMMAND_KEYS = [] as const;
export type RegisteredCommandKey = (typeof REGISTERED_COMMAND_KEYS)[number];

// Extension slot keys (spec §4.1). None registered yet in Phase 1.
export const REGISTERED_EXTENSION_SLOT_KEYS = [] as const;
export type RegisteredExtensionSlotKey = (typeof REGISTERED_EXTENSION_SLOT_KEYS)[number];

/** Read-only Set catalogs used by the validator for existence checks. */
export const REGISTERED_KEY_CATALOGS = {
  surface: new Set<string>(REGISTERED_SURFACE_KEYS),
  icon: new Set<string>(REGISTERED_ICON_KEYS),
  connector: new Set<string>(REGISTERED_CONNECTOR_KEYS),
  widget: new Set<string>(REGISTERED_WIDGET_KEYS),
  collector: new Set<string>(REGISTERED_COLLECTOR_KEYS),
  workflow: new Set<string>(REGISTERED_WORKFLOW_KEYS),
  routeGroup: new Set<string>(REGISTERED_ROUTE_GROUP_KEYS),
  command: new Set<string>(REGISTERED_COMMAND_KEYS),
  slot: new Set<string>(REGISTERED_EXTENSION_SLOT_KEYS),
} as const;
