export const UI_INTERACTION_TARGET_ROUTES = {
  "navigation.home.open": { href: "/home" },
  "navigation.dashboard.open": { href: "/dashboard", permission: "system:read" },
  "navigation.news.open": { href: "/news" },
  "navigation.email.open": { href: "/email" },
  "navigation.library.open": { href: "/library" },
  "navigation.schedule.open": { href: "/schedule" },
  "navigation.projects.open": { href: "/projects" },
  "navigation.wellness.open": { href: "/wellness" },
  "navigation.people.open": { href: "/people" },
  "navigation.meetings.open": { href: "/meetings" },
  "navigation.companies.open": { href: "/companies" },
  "navigation.pipelines.open": { href: "/pipelines" },
  "navigation.goals.open": { href: "/goals" },
  "navigation.decisions.open": { href: "/decisions" },
  "navigation.strategy.open": { href: "/strategy" },
  "navigation.businessModel.open": { href: "/business/model", permission: "system:read" },
  "navigation.roles.open": { href: "/business/roles", permission: "system:read" },
  "navigation.skills.open": { href: "/skills", permission: "system:read" },
  "navigation.plans.open": { href: "/brain?tab=plans" },
  "navigation.workflows.open": { href: "/workflows" },
  "navigation.hooks.open": { href: "/system?tab=hooks", permission: "system:read" },
  "navigation.timers.open": { href: "/system?tab=timers", permission: "system:read" },
  "navigation.orientation.open": { href: "/orientation" },
  "navigation.persona.open": { href: "/brain?tab=persona" },
  "navigation.emotion.open": { href: "/brain?tab=emotion" },
  "navigation.memoryLayers.open": { href: "/memory?tab=memories" },
  "navigation.memoryGraph.open": { href: "/memory?tab=graph" },
  "navigation.memoryJournal.open": { href: "/memory?tab=maintenance" },
  "navigation.platforms.open": { href: "/platforms", permission: "build:read" },
  "navigation.design.open": { href: "/design", permission: "build:read" },
  "navigation.database.open": { href: "/database", permission: "build:read" },
  "navigation.issues.open": { href: "/build?tab=issues", permission: "build:read" },
  "navigation.performance.open": { href: "/system?tab=resources", permission: "system:read" },
  "navigation.logs.open": { href: "/system?tab=logs", permission: "system:read" },
  "navigation.events.open": { href: "/system?tab=events", permission: "system:read" },
  "navigation.tools.open": { href: "/system?tab=tools", permission: "system:read" },
  "navigation.prompts.open": { href: "/build?tab=prompts", permission: "build:read" },
  "navigation.context.open": { href: "/brain?tab=context" },
  "navigation.router.open": { href: "/system?tab=inference", permission: "system:read" },
  "navigation.models.open": { href: "/brain?tab=model" },
  "navigation.cost.open": { href: "/system?tab=cost", permission: "system:read" },
  "navigation.audiences.open": { href: "/audiences", permission: "system:read" },
  "navigation.campaigns.open": { href: "/campaigns", permission: "system:read" },
  "navigation.users.open": { href: "/system?tab=users", permission: "system:read" },
  "navigation.vaults.open": { href: "/system?tab=vaults" },
  "navigation.integrations.open": { href: "/integrations" },
  "navigation.account.open": { href: "/account" },
} as const;

export type UiInteractionTarget = keyof typeof UI_INTERACTION_TARGET_ROUTES;
export type UiInteractionPermission = "system:read" | "build:read";

export const UI_INTERACTION_TARGETS = Object.freeze(
  Object.keys(UI_INTERACTION_TARGET_ROUTES) as UiInteractionTarget[],
);

export function getUiInteractionTargetHref(target: UiInteractionTarget): string {
  return UI_INTERACTION_TARGET_ROUTES[target].href;
}

export function getUiInteractionTargetPermission(target: UiInteractionTarget): UiInteractionPermission | undefined {
  const route = UI_INTERACTION_TARGET_ROUTES[target] as { permission?: UiInteractionPermission };
  return route.permission;
}

export function isUiInteractionTargetOpen(
  target: UiInteractionTarget,
  path: string,
  search: string,
): boolean {
  const href = getUiInteractionTargetHref(target);
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

export const UI_INTERACTION_OUTCOMES = ["completed", "cancelled", "unavailable"] as const;
export type UiInteractionOutcome = typeof UI_INTERACTION_OUTCOMES[number];

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

export interface UiInteractionCommand {
  type: "ui.interaction.command";
  commandId: string;
  target: UiInteractionTarget;
  mode: UiInteractionMode;
  expiresAt: number;
}

export interface UiInteractionResult {
  type: "ui.interaction.result";
  commandId: string;
  outcome: UiInteractionOutcome;
  reason?: UiInteractionReason;
}

export interface UiInteractionTerminalResult {
  target: UiInteractionTarget;
  mode: UiInteractionMode;
  outcome: UiInteractionOutcome;
  reason?: UiInteractionReason;
}

export function isUiInteractionTarget(value: unknown): value is UiInteractionTarget {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(UI_INTERACTION_TARGET_ROUTES, value);
}

export function isUiInteractionMode(value: unknown): value is UiInteractionMode {
  return typeof value === "string" && (UI_INTERACTION_MODES as readonly string[]).includes(value);
}

export function isUiInteractionOutcome(value: unknown): value is UiInteractionOutcome {
  return typeof value === "string" && (UI_INTERACTION_OUTCOMES as readonly string[]).includes(value);
}

export function isUiInteractionReason(value: unknown): value is UiInteractionReason {
  return typeof value === "string" && (UI_INTERACTION_REASONS as readonly string[]).includes(value);
}

export function isUiInteractionCommand(value: unknown): value is UiInteractionCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<UiInteractionCommand>;
  return command.type === "ui.interaction.command"
    && typeof command.commandId === "string"
    && command.commandId.length > 0
    && command.commandId.length <= 120
    && isUiInteractionTarget(command.target)
    && isUiInteractionMode(command.mode)
    && typeof command.expiresAt === "number"
    && Number.isFinite(command.expiresAt);
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
