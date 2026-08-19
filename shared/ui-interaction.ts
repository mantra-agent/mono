import { parseReferenceText } from "./reference-parser";
import type { ReferenceRef } from "./references";
import { isScreenId, screenPath, type ScreenId } from "./screen-registry";

/**
 * Navigation / control interaction targets.
 * Screen-backed `*.open` targets declare `screen` and derive href from SCREEN_REGISTRY.
 * Non-screen controls (toggle) keep an empty href. Permission and description stay here.
 */
type UiInteractionRoute =
  | { href: ""; description?: string; permission?: UiInteractionPermission }
  | {
      screen: ScreenId;
      description?: string;
      permission?: UiInteractionPermission;
    };

export const UI_INTERACTION_TARGET_ROUTES = {
  "navigation.sidebar.toggle": { href: "" },
  "navigation.home.open": { screen: "home", description: "See what needs your attention today." },
  "navigation.dashboard.open": { screen: "dashboard", permission: "system:read", description: "Track your activity at a glance." },
  "navigation.news.open": { screen: "news", description: "Scan signals matched to your interests." },
  "navigation.email.open": { screen: "email", description: "Triage your inbox and draft replies." },
  "navigation.library.open": { screen: "library", description: "Browse and write your knowledge pages." },
  "navigation.files.open": { screen: "files", description: "Browse files from your connected drives." },
  "navigation.schedule.open": { screen: "schedule", description: "See your calendar and prep for what's ahead." },
  "navigation.projects.open": { screen: "projects", description: "Manage your projects, tasks, and milestones." },
  "navigation.habits.open": { screen: "habits", description: "Track your habits and wellness rhythms." },
  "navigation.reflections.open": { screen: "reflections", description: "Write and review your reflections." },
  "navigation.gratitude.open": { screen: "gratitude", description: "Capture what you are grateful for." },
  "navigation.wellness.open": { screen: "habits", description: "Track your habits and wellness rhythms." },
  "navigation.people.open": { screen: "people", description: "Keep your relationships warm and tracked." },
  "navigation.meetings.open": { screen: "meetings", description: "Review your meeting notes and recaps." },
  "navigation.companies.open": { screen: "companies", description: "Track the companies in your network." },
  "navigation.pipelines.open": { screen: "pipelines", description: "Move opportunities through your pipelines." },
  "navigation.goals.open": { screen: "goals", description: "Set and track your goals across every horizon." },
  "navigation.decisions.open": { screen: "decisions", description: "Work through your decisions with structure." },
  "navigation.scenarios.open": { screen: "scenarios", description: "Model scenarios and play out the moves." },
  "navigation.tags.open": { screen: "tags", description: "Organize everything with your tags." },
  "navigation.definition.open": { screen: "identity", permission: "system:read", description: "Define who your business is." },
  "navigation.pricing.open": { screen: "pricing", permission: "system:read", description: "Lock the package catalog." },
  "navigation.businessModel.open": { screen: "business-model", permission: "system:read", description: "Map how your business makes money." },
  "navigation.budgets.open": { screen: "budgets", permission: "system:read", description: "Plan and track your budgets." },
  "navigation.advantage.open": { screen: "plan", description: "Shape your business plan and strategy." },
  "navigation.roles.open": { screen: "roles", permission: "system:read", description: "Define the roles on your team." },
  "navigation.hiring.open": { screen: "hiring", permission: "system:read", description: "Plan who you'll hire next." },
  "navigation.kpis.open": { screen: "kpis", description: "Track the KPIs that matter." },
  "navigation.metrics.open": { screen: "metrics", description: "Watch your business metrics." },
  "navigation.health.open": { screen: "health", description: "See your health metrics." },
  "navigation.agendas.open": { screen: "agendas", description: "Build reusable agendas for your sessions." },
  "navigation.skills.open": { screen: "skills", description: "Run and manage your reusable skills." },
  "navigation.templates.open": { screen: "templates", description: "Map artifact shapes to Library pages." },
  "navigation.plans.open": { screen: "plans", description: "Track your multi-step plans." },
  "navigation.hooks.open": { screen: "hooks", permission: "system:read", description: "Automate actions when events fire." },
  "navigation.timers.open": { screen: "timers", permission: "system:read", description: "Schedule reminders and recurring runs." },
  "navigation.orientation.open": { screen: "orientation", description: "Shape how your agent understands your world." },
  "navigation.persona.open": { screen: "personas", description: "Choose how your agent shows up." },
  "navigation.emotion.open": { screen: "emotion", description: "See your agent's emotional state." },
  "navigation.memoryLayers.open": { screen: "memory-layers", description: "Browse what your agent remembers." },
  "navigation.memoryGraph.open": { screen: "memory-graph", description: "Explore your memory as a graph." },
  "navigation.memoryJournal.open": { screen: "memory-journal", description: "Follow how your memory is maintained." },
  "navigation.platforms.open": { screen: "platforms", permission: "build:read", description: "Manage your platforms and environments." },
  "navigation.products.open": { screen: "products", permission: "build:read", description: "Manage your products." },
  "navigation.features.open": { screen: "features", permission: "build:read", description: "Shape and ship your product features." },
  "navigation.design.open": { screen: "design", permission: "build:read", description: "Explore the design system." },
  "navigation.database.open": { screen: "database", permission: "build:read", description: "Inspect your database." },
  "navigation.issues.open": { screen: "issues", permission: "build:read", description: "Track and resolve reported issues." },
  "navigation.performance.open": { screen: "performance", permission: "system:read", description: "Watch performance measurements and resources." },
  "navigation.logs.open": { screen: "logs", permission: "system:read", description: "Read the system logs." },
  "navigation.events.open": { screen: "events", permission: "system:read", description: "Trace system events." },
  "navigation.tools.open": { screen: "tools", permission: "system:read", description: "Inspect the tool registry." },
  "navigation.prompts.open": { screen: "prompts", permission: "build:read", description: "Edit internal prompt templates." },
  "navigation.context.open": { screen: "context", permission: "system:read", description: "Inspect how context is assembled." },
  "navigation.router.open": { screen: "inference", permission: "system:read", description: "Review model routing and inference." },
  "navigation.routers.open": { screen: "routers", permission: "system:read", description: "Manage named LLM router pools." },
  "navigation.models.open": { screen: "models", permission: "system:read", description: "Configure your models." },
  "navigation.cost.open": { screen: "cost", permission: "system:read", description: "Track your usage and cost." },
  "navigation.audiences.open": { screen: "audiences", permission: "system:read", description: "Manage your audiences." },
  "navigation.campaigns.open": { screen: "campaigns", permission: "system:read", description: "Run your campaigns." },
  "navigation.accounts.open": { screen: "accounts", permission: "system:read", description: "Manage accounts." },
  "navigation.agents.open": { screen: "agents", permission: "system:read", description: "Manage agents." },
  "navigation.users.open": { screen: "users", permission: "system:read", description: "Manage users." },
  "navigation.secrets.open": { screen: "secrets", permission: "system:read", description: "Manage your secrets." },
  "navigation.vaults.open": { screen: "vaults", description: "Organize your vaults." },
  "navigation.teams.open": { screen: "teams", description: "Manage your teams." },
  "navigation.integrations.open": { screen: "integrations", description: "Connect your tools and accounts." },
  "navigation.mods.open": { screen: "mods", permission: "mods:read", description: "Install and manage mods." },
  "navigation.account.open": { screen: "account", description: "Manage your account settings." },
} as const satisfies Record<string, UiInteractionRoute>;

export type UiInteractionTarget = keyof typeof UI_INTERACTION_TARGET_ROUTES;
export type UiInteractionPermission = "system:read" | "build:read" | "mods:read";

export const UI_INTERACTION_TARGETS = Object.freeze(
  Object.keys(UI_INTERACTION_TARGET_ROUTES) as UiInteractionTarget[],
);

export function getUiInteractionTargetHref(target: UiInteractionTarget): string {
  // Fail closed: composition/registry can surface a typed target that is not yet
  // in the client route table. Reading an undefined entry hard-crashes Home.
  const route = UI_INTERACTION_TARGET_ROUTES[target] as UiInteractionRoute | undefined;
  if (!route) return "";
  if ("screen" in route && route.screen) {
    return isScreenId(route.screen) ? screenPath(route.screen) : "";
  }
  return "href" in route ? route.href : "";
}

export function getUiInteractionTargetPermission(target: UiInteractionTarget): UiInteractionPermission | undefined {
  const route = UI_INTERACTION_TARGET_ROUTES[target] as
    | { permission?: UiInteractionPermission }
    | undefined;
  return route?.permission;
}

export function getUiInteractionTargetDescription(target: UiInteractionTarget): string | undefined {
  const route = UI_INTERACTION_TARGET_ROUTES[target] as
    | { description?: string }
    | undefined;
  return route?.description;
}

export function isUiInteractionTargetOpen(
  target: UiInteractionTarget,
  path: string,
  search: string,
): boolean {
  const href = getUiInteractionTargetHref(target);
  if (!href) return false;
  const queryIndex = href.indexOf("?");
  const targetPath = queryIndex === -1 ? href : href.slice(0, queryIndex);
  if (path !== targetPath) return false;
  if (queryIndex === -1) return true;

  const targetParams = new URLSearchParams(href.slice(queryIndex + 1));
  const currentParams = new URLSearchParams(search);
  for (const [key, value] of targetParams.entries()) {
    if (currentParams.get(key) !== value) return false;
  }
  return true;
}

export const UI_INTERACTION_MODES = ["execute", "guide"] as const;
export type UiInteractionMode = typeof UI_INTERACTION_MODES[number];

export const UI_INTERACTION_RESOURCE_SURFACES = ["home"] as const;
export type UiInteractionResourceSurface = typeof UI_INTERACTION_RESOURCE_SURFACES[number];

export const UI_INTERACTION_OUTCOMES = ["completed", "cancelled", "unavailable"] as const;
export type UiInteractionOutcome = typeof UI_INTERACTION_OUTCOMES[number];

export const UI_INTERACTION_NARRATION_STATES = ["not_applicable", "already_spoken", "streamed"] as const;
export type UiInteractionNarrationState = typeof UI_INTERACTION_NARRATION_STATES[number];

export const UI_INTERACTION_REASONS = [
  "user_cancelled",
  "target_unavailable",
  "no_active_client",
  "ambiguous_active_client",
  "client_disconnected",
  "send_failed",
  "timed_out",
  "superseded",
  "capacity_exceeded",
] as const;

export type UiInteractionReason = typeof UI_INTERACTION_REASONS[number];

/** Upper bound on the guide introduction so the dispatched command stays small. */
export const UI_INTERACTION_INTRODUCTION_MAX_LENGTH = 400;

interface UiInteractionCommandBase {
  type: "ui.interaction.command";
  commandId: string;
  expiresAt: number;
}

interface UiInteractionNarratedCommand {
  /** Speech-capable narration. May retain expression tags for TTS. */
  introduction: string;
  /** Producer-derived sighted-UI projection with speech-only tags removed. */
  displayIntroduction: string;
  /** Whether this voice turn delivered the narration, or no voice narration applied. */
  narrationState: UiInteractionNarrationState;
}

export interface UiInteractionExecuteCommand extends UiInteractionCommandBase {
  /** Optional on control commands for rolling compatibility with the original protocol. */
  subject?: "control";
  target: UiInteractionTarget;
  mode: "execute";
}

export interface UiInteractionGuideCommand extends UiInteractionCommandBase, UiInteractionNarratedCommand {
  /** Optional on control commands for rolling compatibility with the original protocol. */
  subject?: "control";
  target: UiInteractionTarget;
  mode: "guide";
}

export interface UiInteractionResourceGuideCommand extends UiInteractionCommandBase, UiInteractionNarratedCommand {
  subject: "resource";
  mode: "guide";
  /** Canonical durable-object reference, e.g. `@meeting:abc`. */
  resource: string;
  /** Surface that owns resource discovery, reveal, expansion, and spotlight. */
  surface: UiInteractionResourceSurface;
}

/**
 * Subject and mode are jointly discriminated. Resource interactions are
 * guide-only, and every guide structurally requires narration.
 */
export type UiInteractionCommand =
  | UiInteractionExecuteCommand
  | UiInteractionGuideCommand
  | UiInteractionResourceGuideCommand;

export interface UiInteractionResult {
  type: "ui.interaction.result";
  commandId: string;
  outcome: UiInteractionOutcome;
  reason?: UiInteractionReason;
}

interface UiInteractionTerminalResultBase {
  mode: UiInteractionMode;
  outcome: UiInteractionOutcome;
  reason?: UiInteractionReason;
}

export type UiInteractionTerminalResult =
  | (UiInteractionTerminalResultBase & { subject: "control"; target: UiInteractionTarget })
  | (UiInteractionTerminalResultBase & { subject: "resource"; resource: string; surface: UiInteractionResourceSurface });

export function isUiInteractionTarget(value: unknown): value is UiInteractionTarget {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UI_INTERACTION_TARGET_ROUTES, value);
}

export function isUiInteractionMode(value: unknown): value is UiInteractionMode {
  return typeof value === "string" && (UI_INTERACTION_MODES as readonly string[]).includes(value);
}

export function isUiInteractionResourceSurface(value: unknown): value is UiInteractionResourceSurface {
  return typeof value === "string" && (UI_INTERACTION_RESOURCE_SURFACES as readonly string[]).includes(value);
}

export function parseUiInteractionResource(value: unknown): ReferenceRef | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const parts = parseReferenceText(trimmed);
  if (parts.length !== 1 || parts[0]?.kind !== "reference") return null;
  const ref = parts[0].ref;
  return ref.raw === trimmed && !ref.legacy ? ref : null;
}

export function isUiInteractionOutcome(value: unknown): value is UiInteractionOutcome {
  return typeof value === "string" && (UI_INTERACTION_OUTCOMES as readonly string[]).includes(value);
}

export function isUiInteractionNarrationState(value: unknown): value is UiInteractionNarrationState {
  return typeof value === "string" && (UI_INTERACTION_NARRATION_STATES as readonly string[]).includes(value);
}

export function isUiInteractionReason(value: unknown): value is UiInteractionReason {
  return typeof value === "string" && (UI_INTERACTION_REASONS as readonly string[]).includes(value);
}

export function isUiInteractionCommand(value: unknown): value is UiInteractionCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<UiInteractionCommand>;
  const baseValid = command.type === "ui.interaction.command"
    && typeof command.commandId === "string"
    && command.commandId.length > 0
    && command.commandId.length <= 120
    && typeof command.expiresAt === "number"
    && Number.isFinite(command.expiresAt);
  if (!baseValid) return false;

  if (command.subject === "resource") {
    return command.mode === "guide"
      && parseUiInteractionResource(command.resource) !== null
      && isUiInteractionResourceSurface(command.surface)
      && typeof command.introduction === "string"
      && command.introduction.trim().length > 0
      && command.introduction.length <= UI_INTERACTION_INTRODUCTION_MAX_LENGTH
      && typeof command.displayIntroduction === "string"
      && command.displayIntroduction.trim().length > 0
      && command.displayIntroduction.length <= UI_INTERACTION_INTRODUCTION_MAX_LENGTH
      && isUiInteractionNarrationState(command.narrationState);
  }

  if (command.subject === undefined || command.subject === "control") {
    if (!isUiInteractionTarget(command.target) || !isUiInteractionMode(command.mode)) return false;
    if (command.mode === "execute") return true;
    return typeof command.introduction === "string"
      && command.introduction.trim().length > 0
      && command.introduction.length <= UI_INTERACTION_INTRODUCTION_MAX_LENGTH
      && typeof command.displayIntroduction === "string"
      && command.displayIntroduction.trim().length > 0
      && command.displayIntroduction.length <= UI_INTERACTION_INTRODUCTION_MAX_LENGTH
      && isUiInteractionNarrationState(command.narrationState);
  }

  return false;
}

export function isUiInteractionResult(value: unknown): value is UiInteractionResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<UiInteractionResult>;
  return result.type === "ui.interaction.result"
    && typeof result.commandId === "string"
    && result.commandId.length > 0
    && result.commandId.length <= 120
    && isUiInteractionOutcome(result.outcome)
    && (result.reason === undefined || isUiInteractionReason(result.reason));
}
