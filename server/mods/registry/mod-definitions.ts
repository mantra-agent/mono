// ─── First-party Mod definitions (spec §1.2, §3.3, §4) ─────────────────────
// Six code-owned ModDefinitions whose contributions reproduce today's product
// exactly. Ownership follows the spec §1.2 product boundaries; the navigation
// `section` field preserves each item's CURRENT sidebar placement so an
// all-Mods-active account resolves to the same sidebar/router as today. Nothing
// renders from these yet (Phase 1 shadow).

import type { ModDefinition } from "@shared/models/mod-registry";
import {
  clientRoute,
  dashboardHeatmap,
  integration,
  nav,
  timerTemplateRef,
  widget,
  workflowRef,
} from "./contribution-builders";
import { actionsForOwner } from "./action-catalog";

const MIN_CORE = "1.0.0";

const planning: ModDefinition = {
  key: "planning",
  version: "1.0.0",
  name: "Planning",
  description: "The full goal and execution workspace: Schedule, Projects, Tasks, Goals, Plans, and planning/review rhythms.",
  outcome: {
    label: "Plan and run my work",
    promise: "Turn intentions into scheduled, tracked execution across goals, projects, and tasks.",
    activationSignals: ["planning.route.goals", "planning.route.projects", "planning.route.schedule"],
  },
  experience: { primaryObjectKind: "goal", primaryActionId: "planning.action.goals", rootSurfaceKey: "goals" },
  compatibility: { minimumCoreVersion: MIN_CORE },
  requiresCore: ["agent", "automation", "references", "ui-composition"],
  contributions: {
    clientRoutes: [
      clientRoute("planning.route.goals", "/goals", "goals"),
      clientRoute("planning.route.goal-detail", "/goals/:id", "goal-detail"),
      clientRoute("planning.route.vision", "/vision", "vision"),
      clientRoute("planning.route.schedule", "/schedule", "calendar"),
      clientRoute("planning.route.schedule-event", "/schedule/:eventId", "calendar"),
      clientRoute("planning.route.projects", "/projects", "work"),
    ],
    navigation: [
      nav("planning.nav.schedule", "Tools", "Schedule", "Calendar", "navigation.schedule.open", "planning.route.schedule", 6),
      nav("planning.nav.projects", "Tools", "Projects", "Briefcase", "navigation.projects.open", "planning.route.projects", 7),
      nav("planning.nav.goals", "Planning", "Goals", "Target", "navigation.goals.open", "planning.route.goals", 1),
    ],
    widgets: [
      widget("planning.widget.priority-task", "home.primary", "priority_task", "tasks", 2),
      widget("planning.widget.project", "home.primary", "project", "projects", 3),
    ],
    actions: actionsForOwner("planning"),
  },
};

const build: ModDefinition = {
  key: "build",
  version: "1.0.0",
  name: "Build",
  description: "The Build product area: Platforms, Design, Database, Issues, and build workflows.",
  outcome: {
    label: "Build and operate software",
    promise: "Design, ship, and operate software with platform environments, issues, and build workflows.",
    activationSignals: ["build.route.build", "build.route.platforms"],
  },
  experience: { primaryObjectKind: "platform", primaryActionId: "build.action.platforms", rootSurfaceKey: "build" },
  compatibility: { minimumCoreVersion: MIN_CORE },
  requiresCore: ["automation", "integration-custody", "ui-composition"],
  recommendsMods: ["planning"],
  contributions: {
    clientRoutes: [
      clientRoute("build.route.build", "/build", "build", { requiredPermissions: ["build:read"] }),
      clientRoute("build.route.database", "/database", "database", { requiredPermissions: ["build:read"] }),
      clientRoute("build.route.design", "/design", "design", { requiredPermissions: ["build:read"] }),
      clientRoute("build.route.platforms", "/platforms", "platforms", { requiredPermissions: ["build:read"] }),
      clientRoute("build.route.platform-environment-detail", "/platforms/environments/:id", "platform-environment-detail", { requiredPermissions: ["build:read"] }),
      clientRoute("build.route.issue-detail", "/issues/:id", "issue-detail", { requiredPermissions: ["build:read"] }),
    ],
    navigation: [
      nav("build.nav.platforms", "Build", "Platforms", "Boxes", "navigation.platforms.open", "build.route.platforms", 1, { requiredPermissions: ["build:read"] }),
      nav("build.nav.design", "Build", "Design", "Palette", "navigation.design.open", "build.route.design", 2, { requiredPermissions: ["build:read"] }),
      nav("build.nav.database", "Build", "Database", "DatabaseZap", "navigation.database.open", "build.route.database", 3, { requiredPermissions: ["build:read"] }),
      nav("build.nav.issues", "Build", "Issues", "Hammer", "navigation.issues.open", "build.route.build", 4, { requiredPermissions: ["build:read"] }),
    ],
    integrations: [
      integration("build.integration.github", "github", "available", ["source"]),
      integration("build.integration.railway", "railway", "available", ["hosting"]),
      integration("build.integration.cloudflare", "cloudflare", "available", ["hosting", "dns"]),
      integration("build.integration.expo", "expo", "available", ["mobile-build"]),
      integration("build.integration.sentry", "sentry", "available", ["error-tracking"]),
    ],
    workflows: [workflowRef("build.workflow.build-v1", "build-v1")],
    timers: [
      timerTemplateRef("build.timer.reliability-sentinel-30m", "build-reliability-sentinel-30m"),
      timerTemplateRef("build.timer.security-sentinel-weekly", "build-security-sentinel-weekly"),
      timerTemplateRef("build.timer.post-acceptance-regression", "post-build-regression"),
    ],
    widgets: [
      widget("build.widget.deployment-inbox", "home.inbox", "inbox_item", "build-deployments", 1),
    ],
    actions: actionsForOwner("build"),
  },
};

const business: ModDefinition = {
  key: "business",
  version: "1.1.0",
  name: "Business",
  description: "Business operating surfaces: companies, strategy, decisions, business model, roles, and pipelines.",
  outcome: {
    label: "Run my company",
    promise: "Operate the business: strategy, decisions, pipelines, companies, and the operating model.",
    activationSignals: ["business.route.companies", "business.route.strategy", "business.route.pipelines"],
  },
  experience: { primaryObjectKind: "company", primaryActionId: "business.action.companies", rootSurfaceKey: "companies" },
  compatibility: { minimumCoreVersion: MIN_CORE },
  requiresCore: ["agent", "automation", "references", "ui-composition"],
  recommendsMods: ["planning"],
  contributions: {
    clientRoutes: [
      clientRoute("business.route.strategy", "/strategy", "strategy"),
      clientRoute("business.route.strategy-detail", "/strategy/:id", "strategy-detail"),
      clientRoute("business.route.decisions", "/decisions", "decisions"),
      clientRoute("business.route.companies", "/companies", "companies"),
      clientRoute("business.route.company-detail", "/companies/:id", "companies"),
      clientRoute("business.route.business-model", "/business/model", "business-model", { requiredPermissions: ["system:read"] }),
      clientRoute("business.route.advantage", "/business/advantage", "business-advantage"),
      clientRoute("business.route.job-roles", "/business/roles", "job-roles", { requiredPermissions: ["system:read"] }),
      clientRoute("business.route.pipelines", "/pipelines", "pipelines"),
    ],
    navigation: [
      nav("business.nav.companies", "Network", "Companies", "Briefcase", "navigation.companies.open", "business.route.companies", 3),
      nav("business.nav.decisions", "Planning", "Decisions", "Scale", "navigation.decisions.open", "business.route.decisions", 2),
      nav("business.nav.strategy", "Planning", "Strategy", "Swords", "navigation.strategy.open", "business.route.strategy", 3),
      nav("business.nav.advantage", "Business", "Advantage", "Target", "navigation.advantage.open", "business.route.advantage", 1),
      nav("business.nav.pipelines", "Business", "Pipelines", "Waypoints", "navigation.pipelines.open", "business.route.pipelines", 2),
      nav("business.nav.business-model", "Business", "Model", "LineChart", "navigation.businessModel.open", "business.route.business-model", 3, { requiredPermissions: ["system:read"] }),
      nav("business.nav.job-roles", "Business", "Roles", "Briefcase", "navigation.roles.open", "business.route.job-roles", 4, { requiredPermissions: ["system:read"] }),
    ],
    actions: actionsForOwner("business"),
  },
};

const wellness: ModDefinition = {
  key: "wellness",
  version: "1.1.0",
  name: "Wellness",
  description: "Wellness activities, routines, health signals, reflection, coaching, and health integrations.",
  outcome: {
    label: "Improve health and grow",
    promise: "Build sustainable routines, reflect, and grow with coaching grounded in the health signals that matter.",
    activationSignals: ["wellness.route.wellness"],
  },
  experience: { primaryObjectKind: "wellness_activity", primaryActionId: "wellness.action.wellness", rootSurfaceKey: "wellness" },
  compatibility: { minimumCoreVersion: MIN_CORE },
  requiresCore: ["agent", "automation", "integration-custody", "ui-composition"],
  recommendsMods: ["planning"],
  contributions: {
    clientRoutes: [clientRoute("wellness.route.wellness", "/wellness", "wellness")],
    navigation: [nav("wellness.nav.wellness", "Tools", "Wellness", "Activity", "navigation.wellness.open", "wellness.route.wellness", 8)],
    widgets: [widget("wellness.widget.wellness", "home.primary", "wellness", "wellness", 4)],
    dashboardHeatmaps: [
      dashboardHeatmap(
        "wellness.heatmap.completions",
        "wellness_completions",
        "Wellness",
        "Heart",
        50,
        "wellness",
      ),
    ],
    integrations: [integration("wellness.integration.oura", "oura", "available", ["health-metrics"])],
    // Cadence Timers materialize through wellness-managed-resources under installation ownership.
    timerTemplates: [
      timerTemplateRef("wellness.timer.weekly-reflection", "weekly-reflection"),
      timerTemplateRef("wellness.timer.monthly-reflection", "monthly-reflection"),
      timerTemplateRef("wellness.timer.reflect-daily", "reflect-daily"),
    ],
    actions: actionsForOwner("wellness"),
  },
};

const network: ModDefinition = {
  key: "network",
  version: "1.0.0",
  name: "Network",
  description: "People, meetings, relationships, and outreach. Owns the People experience.",
  outcome: {
    label: "Strengthen relationships",
    promise: "Keep relationships warm with people, meetings, and timely outreach.",
    activationSignals: ["network.route.people", "network.route.meetings"],
  },
  experience: { primaryObjectKind: "person", primaryActionId: "network.action.people", rootSurfaceKey: "people" },
  compatibility: { minimumCoreVersion: MIN_CORE },
  requiresCore: ["agent", "references", "notifications", "ui-composition"],
  contributions: {
    clientRoutes: [
      clientRoute("network.route.people", "/people", "people"),
      clientRoute("network.route.person-detail", "/people/:id", "people"),
      clientRoute("network.route.meetings", "/meetings", "meetings"),
    ],
    navigation: [
      nav("network.nav.people", "Network", "People", "Users", "navigation.people.open", "network.route.people", 1),
      nav("network.nav.meetings", "Network", "Meetings", "MessagesSquare", "navigation.meetings.open", "network.route.meetings", 2),
    ],
    widgets: [
      widget("network.widget.meeting", "home.primary", "meeting", "meetings", 5),
      widget("network.widget.person", "home.primary", "person", "people", 6),
    ],
    actions: actionsForOwner("network"),
  },
};

const finance: ModDefinition = {
  key: "finance",
  version: "1.0.0",
  name: "Finance",
  description: "Accounts, transactions, budgets, liabilities, investments, financial intelligence, and finance integrations. Owns Plaid discovery.",
  outcome: {
    label: "Manage finances",
    promise: "See and steer your money: accounts, transactions, budgets, and forecasts.",
    activationSignals: ["finance.route.finance"],
  },
  // Finance has no sidebar nav item or ui-interaction target today; it is
  // reachable only via /finance. Reproduce that exactly (route + connectors).
  experience: { primaryObjectKind: "account", primaryActionId: "finance.action.finance", rootSurfaceKey: "finance" },
  compatibility: { minimumCoreVersion: MIN_CORE },
  requiresCore: ["automation", "integration-custody", "ui-composition"],
  contributions: {
    clientRoutes: [clientRoute("finance.route.finance", "/finance", "finance")],
    integrations: [
      integration("finance.integration.plaid", "plaid", "available", ["transactions", "balances", "liabilities", "investments"]),
      integration("finance.integration.quickbooks", "quickbooks", "available", ["accounting"]),
    ],
  },
};

export const modDefinitions: ModDefinition[] = [
  planning,
  build,
  business,
  wellness,
  network,
  finance,
];
