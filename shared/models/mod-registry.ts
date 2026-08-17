// ─── Mod registry typed contracts (spec §4) ────────────────────────────────
// Pure, dependency-free contribution and definition contracts for the
// first-party Mod composition plane. Both client and server import these; the
// file intentionally carries no drizzle/db imports so it stays client-safe.
//
// Registered-key fields (surface/icon/connector/collector/route-group/command/
// slot/tool/skill/workflow keys) are typed as `string` here because the trusted
// key catalogs live server-side (server/mods/registry/registered-keys.ts) and
// reference server-owned registration functions. Membership is enforced by
// boot/build-time validation (spec §6.1), not by the shared compile-time union.
// Server definitions gain compile-time key safety through the typed builders in
// server/mods/registry/contribution-builders.ts.

import type { ModKey } from "./mods";
import type { UiInteractionTarget } from "../ui-interaction";

export type { ModKey };

/** Core capability keys a Mod may declare a dependency on (spec §4). */
export type CoreCapabilityKey =
  | "agent"
  | "memory"
  | "library"
  | "automation"
  | "identity"
  | "integration-custody"
  | "references"
  | "search"
  | "notifications"
  | "audit"
  | "ui-composition";

export const CORE_CAPABILITY_KEYS: readonly CoreCapabilityKey[] = [
  "agent",
  "memory",
  "library",
  "automation",
  "identity",
  "integration-custody",
  "references",
  "search",
  "notifications",
  "audit",
  "ui-composition",
] as const;

/** Named-permission strings; validated against the central vocabulary. */
export type PermissionKey = string;

/** Reference to a connector capability an executable contribution requires. */
export interface IntegrationCapabilityRef {
  connectorKey: string;
  capability: string;
}

export type ContributionModality = "web" | "mobile" | "voice";
export type ContributionAudience = "primary" | "settings" | "diagnostic";

export interface ContributionSurfacePolicy {
  minViewport?: "mobile" | "desktop";
  maxPrimaryActions?: 0 | 1;
  priority?: number;
}

/**
 * Every contribution carries a globally stable ID, its required named
 * permissions, optional integration capability requirements, and presentation
 * hints. The `id` namespace prefix identifies the owning definition
 * (`core.*` or `<modKey>.*`) and is validated at boot/build.
 */
export interface ContributionBase {
  id: string;
  requiredPermissions?: PermissionKey[];
  requiredIntegrations?: IntegrationCapabilityRef[];
  modalities?: ContributionModality[];
  audience?: ContributionAudience;
  surfacePolicy?: ContributionSurfacePolicy;
}

// ── UI contracts (spec §4.1) ────────────────────────────────────────────────

export interface ClientRouteContribution extends ContributionBase {
  kind: "client-route";
  path: string;
  surfaceKey: string;
  exact?: boolean;
}

export interface NavigationContribution extends ContributionBase {
  kind: "navigation";
  section: string;
  label: string;
  iconKey: string;
  target: UiInteractionTarget;
  routeId: string;
  order: number;
}

export type WidgetSlot = "home.primary" | "home.secondary" | "home.inbox";

export interface WidgetContribution extends ContributionBase {
  kind: "widget";
  slot: WidgetSlot;
  surfaceKey: string;
  collectorKey: string;
  order: number;
}

/** Dashboard activity heatmap series owned by Core or a Mod. */
export interface DashboardHeatmapContribution extends ContributionBase {
  kind: "dashboard-heatmap";
  seriesKey: string;
  title: string;
  icon: string;
  order: number;
  group: "operating" | "code" | "wellness";
}

export interface MetricAdapterContribution extends ContributionBase {
  kind: "metric-adapter";
  adapterKey: string;
  definitionKeys: string[];
  viewKey: string;
}

export interface SlotContribution extends ContributionBase {
  kind: "slot";
  slotKey: string;
  surfaceKey: string;
  order: number;
  config?: unknown;
}

// ── Semantic actions (spec §4.2) ────────────────────────────────────────────

export type ActionTarget =
  | { kind: "navigate"; routeId: string }
  | { kind: "tool"; toolName: string; action?: string }
  | { kind: "command"; commandKey: string };

export interface ActionContribution extends ContributionBase {
  kind: "action";
  label: string;
  target: ActionTarget;
}

// ── Automation contracts (spec §4.3) — references to canonical tables ────────

export interface SkillContribution extends ContributionBase {
  kind: "skill";
  skillKey: string;
}

export interface WorkflowContribution extends ContributionBase {
  kind: "workflow";
  workflowKey: string;
}

export interface HookTemplateContribution extends ContributionBase {
  kind: "hook-template";
  templateKey: string;
  eventPattern: string;
}

export interface TimerTemplateContribution extends ContributionBase {
  kind: "timer-template";
  templateKey: string;
}

export interface ToolContribution extends ContributionBase {
  kind: "tool";
  toolName: string;
}

// ── Integration contracts (spec §4.4) ───────────────────────────────────────

export type ConnectorReadinessKind = "secret" | "oauth-account" | "provider-connection";

export interface IntegrationContribution extends ContributionBase {
  kind: "integration";
  connectorKey: string;
  relationship: "required" | "recommended" | "available";
  capabilities: string[];
  onboardingStepId?: string;
  /** Display name on the Integrations index. */
  label: string;
  /** Registered icon key. Generic UI looks this up; do not ship a connector-name icon map. */
  iconKey: string;
  /**
   * Integrations URL slug. Absent = no product page row (readiness-only leftover).
   * Generic list/detail consult this field, never a leftover name map.
   */
  route?: string;
  /**
   * Code-owned detail surface. Generic detail dispatches through a handler
   * table keyed by this contract. Absent = no detail page.
   */
  detailSurface?: string;
  /** Optional secrets-status health boolean; false renders Error when configured. */
  healthField?: string;
  /** secrets-status keys that mean this connector is configured. */
  statusFields?: string[];
  /** True when the detail surface already paints the connector title. */
  ownsTitle?: boolean;
  /** How cheap synchronous readiness is derived. Absent = no cheap signal. */
  readinessKind?: ConnectorReadinessKind;
  /** All of these secrets must be present when readinessKind is `secret`. */
  requiredSecrets?: string[];
  /** At least one of these secrets must be present when readinessKind is `secret`. */
  requiredAnySecrets?: string[];
  /** connected_accounts.provider when readinessKind is `oauth-account`. */
  oauthProvider?: string;
  /** provider_connections.provider when readinessKind is `provider-connection`. */
  connectionProvider?: string;
}

// ── Remaining contribution kinds (declared for completeness; spec §4) ────────

export interface OnboardingContribution extends ContributionBase {
  kind: "onboarding";
  stepKey: string;
  order: number;
}

export interface ServerRouteGroupContribution extends ContributionBase {
  kind: "server-route-group";
  routeGroupKey: string;
}

export interface SearchProviderContribution extends ContributionBase {
  kind: "search-provider";
  providerKey: string;
}

export interface NotificationContribution extends ContributionBase {
  kind: "notification";
  notificationKind: string;
}

/**
 * The full contribution surface a Core or Mod definition may declare.
 * There is deliberately NO `memory` field: Memory is ambient learned state and
 * can never be packaged by a definition (spec §2, invariant 2). Validation also
 * rejects any contribution carrying `kind: "memory"`.
 */
export interface ModContributions {
  metricAdapters?: MetricAdapterContribution[];
  skills?: SkillContribution[];
  workflows?: WorkflowContribution[];
  hooks?: HookTemplateContribution[];
  timers?: TimerTemplateContribution[];
  tools?: ToolContribution[];
  integrations?: IntegrationContribution[];
  onboarding?: OnboardingContribution[];
  clientRoutes?: ClientRouteContribution[];
  serverRouteGroups?: ServerRouteGroupContribution[];
  navigation?: NavigationContribution[];
  widgets?: WidgetContribution[];
  dashboardHeatmaps?: DashboardHeatmapContribution[];
  actions?: ActionContribution[];
  slots?: SlotContribution[];
  searchProviders?: SearchProviderContribution[];
  notificationKinds?: NotificationContribution[];
}

/** Any single contribution across all kinds. */
export type AnyContribution =
  | MetricAdapterContribution
  | SkillContribution
  | WorkflowContribution
  | HookTemplateContribution
  | TimerTemplateContribution
  | ToolContribution
  | IntegrationContribution
  | OnboardingContribution
  | ClientRouteContribution
  | ServerRouteGroupContribution
  | NavigationContribution
  | WidgetContribution
  | DashboardHeatmapContribution
  | ActionContribution
  | SlotContribution
  | SearchProviderContribution
  | NotificationContribution;

// ── Definitions (spec §3.3, §4) ─────────────────────────────────────────────

export interface ModOutcome {
  label: string;
  promise: string;
  activationSignals: string[];
}

export interface ModExperience {
  primaryObjectKind: string;
  primaryActionId: string;
  rootSurfaceKey?: string;
}

export interface ModDefinition {
  key: ModKey;
  version: string; // SemVer for the manifest contract
  name: string;
  description: string;
  outcome: ModOutcome;
  experience: ModExperience;
  compatibility: { minimumCoreVersion: string };
  requiresCore: CoreCapabilityKey[];
  recommendsMods?: ModKey[]; // discovery only; never a hard dependency in v1
  contributions: ModContributions;
}

/** The single non-installable Core definition (spec §1.1, §3.3). */
export interface CoreDefinition {
  key: "core";
  version: string;
  name: string;
  description: string;
  capabilities: CoreCapabilityKey[];
  contributions: ModContributions;
}

/** Assembled first-party registry: one Core plus the seven Mods. */
export interface ModRegistry {
  core: CoreDefinition;
  mods: ModDefinition[];
}

/** Serializable projection helpers ------------------------------------------ */

export function definitionOwnerKey(def: CoreDefinition | ModDefinition): string {
  return def.key;
}

/** Flatten a contributions bundle into a single ordered list. */
export function listContributions(contributions: ModContributions): AnyContribution[] {
  const groups: (AnyContribution[] | undefined)[] = [
    contributions.metricAdapters,
    contributions.skills,
    contributions.workflows,
    contributions.hooks,
    contributions.timers,
    contributions.tools,
    contributions.integrations,
    contributions.onboarding,
    contributions.clientRoutes,
    contributions.serverRouteGroups,
    contributions.navigation,
    contributions.widgets,
    contributions.dashboardHeatmaps,
    contributions.actions,
    contributions.slots,
    contributions.searchProviders,
    contributions.notificationKinds,
  ];
  const out: AnyContribution[] = [];
  for (const group of groups) {
    if (group) out.push(...group);
  }
  return out;
}
