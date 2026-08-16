import { parseReferenceText } from "./reference-parser";
import type { ReferenceRef } from "./references";

export const UI_INTERACTION_TARGET_ROUTES = {
  "navigation.sidebar.toggle": { href: "" },
  "navigation.home.open": { href: "/home", description: "See what needs your attention today." },
  "navigation.dashboard.open": { href: "/dashboard", permission: "system:read", description: "Track your activity at a glance." },
  "navigation.news.open": { href: "/news", description: "Scan signals matched to your interests." },
  "navigation.email.open": { href: "/email", description: "Triage your inbox and draft replies." },
  "navigation.library.open": { href: "/library", description: "Browse and write your knowledge pages." },
  "navigation.files.open": { href: "/files", description: "Browse files from your connected drives." },
  "navigation.schedule.open": { href: "/schedule", description: "See your calendar and prep for what's ahead." },
  "navigation.projects.open": { href: "/projects", description: "Manage your projects, tasks, and milestones." },
  "navigation.wellness.open": { href: "/wellness", description: "Track your habits and wellness rhythms." },
  "navigation.people.open": { href: "/people", description: "Keep your relationships warm and tracked." },
  "navigation.meetings.open": { href: "/meetings", description: "Review your meeting notes and recaps." },
  "navigation.companies.open": { href: "/companies", description: "Track the companies in your network." },
  "navigation.pipelines.open": { href: "/pipelines", description: "Move opportunities through your pipelines." },
  "navigation.goals.open": { href: "/goals", description: "Set and track your goals across every horizon." },
  "navigation.decisions.open": { href: "/decisions", description: "Work through your decisions with structure." },
  "navigation.scenarios.open": { href: "/scenarios", description: "Model scenarios and play out the moves." },
  "navigation.tags.open": { href: "/tags", description: "Organize everything with your tags." },
  "navigation.definition.open": { href: "/business/identity", permission: "system:read", description: "Define who your business is." },
  "navigation.businessModel.open": { href: "/business/model", permission: "system:read", description: "Map how your business makes money." },
  "navigation.budgets.open": { href: "/business/budgets", permission: "system:read", description: "Plan and track your budgets." },
  "navigation.advantage.open": { href: "/business/plan", description: "Shape your business plan and strategy." },
  "navigation.roles.open": { href: "/business/roles", permission: "system:read", description: "Define the roles on your team." },
  "navigation.hiring.open": { href: "/business/hiring", permission: "system:read", description: "Plan who you'll hire next." },
  "navigation.kpis.open": { href: "/tools/kpis", permission: "system:read", description: "Track the KPIs that matter." },
  "navigation.metrics.open": { href: "/tools/metrics", permission: "system:read", description: "Watch your business metrics." },
  "navigation.agendas.open": { href: "/agendas", description: "Build reusable agendas for your sessions." },
  "navigation.skills.open": { href: "/skills", description: "Run and manage your reusable skills." },
  "navigation.plans.open": { href: "/brain?tab=plans", description: "Track your multi-step plans." },
  "navigation.workflows.open": { href: "/workflows", description: "Run and manage your workflows." },
  "navigation.hooks.open": { href: "/system?tab=hooks", permission: "system:read", description: "Automate actions when events fire." },
  "navigation.timers.open": { href: "/system?tab=timers", permission: "system:read", description: "Schedule reminders and recurring runs." },
  "navigation.orientation.open": { href: "/orientation", description: "Shape how your agent understands your world." },
  "navigation.persona.open": { href: "/brain?tab=persona", description: "Choose how your agent shows up." },
  "navigation.emotion.open": { href: "/brain?tab=emotion", description: "See your agent's emotional state." },
  "navigation.memoryLayers.open": { href: "/memory?tab=memories", description: "Browse what your agent remembers." },
  "navigation.memoryGraph.open": { href: "/memory?tab=graph", description: "Explore your memory as a graph." },
  "navigation.memoryJournal.open": { href: "/memory?tab=maintenance", description: "Follow how your memory is maintained." },
  "navigation.platforms.open": { href: "/platforms", permission: "build:read", description: "Manage your platforms and environments." },
  "navigation.products.open": { href: "/products", permission: "build:read", description: "Manage your products." },
  "navigation.features.open": { href: "/build/features", permission: "build:read", description: "Shape and ship your product features." },
  "navigation.design.open": { href: "/design", permission: "build:read", description: "Explore the design system." },
  "navigation.database.open": { href: "/database", permission: "build:read", description: "Inspect your database." },
  "navigation.issues.open": { href: "/build?tab=issues", permission: "build:read", description: "Track and resolve reported issues." },
  "navigation.performance.open": { href: "/performance", permission: "system:read", description: "Watch performance measurements and resources." },
  "navigation.logs.open": { href: "/system?tab=logs", permission: "system:read", description: "Read the system logs." },
  "navigation.events.open": { href: "/system?tab=events", permission: "system:read", description: "Trace system events." },
  "navigation.tools.open": { href: "/system?tab=tools", permission: "system:read", description: "Inspect the tool registry." },
  "navigation.prompts.open": { href: "/system?tab=prompts", permission: "build:read", description: "Edit internal prompt templates." },
  "navigation.context.open": { href: "/brain?tab=context", permission: "system:read", description: "Inspect how context is assembled." },
  "navigation.router.open": { href: "/system?tab=inference", permission: "system:read", description: "Review model routing and inference." },
  "navigation.routers.open": { href: "/system?tab=routers", permission: "system:read", description: "Manage named LLM router pools." },
  "navigation.models.open": { href: "/brain?tab=model", permission: "system:read", description: "Configure your models." },
  "navigation.cost.open": { href: "/system?tab=cost", permission: "system:read", description: "Track your usage and cost." },
  "navigation.audiences.open": { href: "/audiences", permission: "system:read", description: "Manage your audiences." },
  "navigation.campaigns.open": { href: "/campaigns", permission: "system:read", description: "Run your campaigns." },
  "navigation.accounts.open": { href: "/system?tab=accounts", permission: "system:read", description: "Manage accounts." },
  "navigation.agents.open": { href: "/system?tab=agents", permission: "system:read", description: "Manage agents." },
  "navigation.users.open": { href: "/system?tab=users", permission: "system:read", description: "Manage users." },
  "navigation.secrets.open": { href: "/system?tab=secrets", permission: "system:read", description: "Manage your secrets." },
  "navigation.vaults.open": { href: "/vaults", description: "Organize your vaults." },
  "navigation.teams.open": { href: "/teams", description: "Manage your teams." },
  "navigation.integrations.open": { href: "/integrations", description: "Connect your tools and accounts." },
  "navigation.mods.open": { href: "/mods", permission: "mods:read", description: "Install and manage mods." },
  "navigation.account.open": { href: "/account", description: "Manage your account settings." },
} as const;

export type UiInteractionTarget = keyof typeof UI_INTERACTION_TARGET_ROUTES;
export type UiInteractionPermission = "system:read" | "build:read" | "mods:read";

export const UI_INTERACTION_TARGETS = Object.freeze(
  Object.keys(UI_INTERACTION_TARGET_ROUTES) as UiInteractionTarget[],
);

export function getUiInteractionTargetHref(target: UiInteractionTarget): string {
  // Fail closed: composition/registry can surface a typed target that is not yet
  // in the client route table. Reading `.href` on undefined hard-crashes Home.
  const route = UI_INTERACTION_TARGET_ROUTES[target];
  return route?.href ?? "";
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
