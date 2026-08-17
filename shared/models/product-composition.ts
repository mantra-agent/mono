// ─── Resolved product composition contract (spec §4.5) ─────────────────────
// The safe, serializable, principal-resolved shape returned by
// GET /api/product-composition. It contains NO secrets, raw permission policy,
// executable handlers, or hidden contribution metadata — only stable IDs, keys,
// paths, labels, orders, states, and reason codes the client may render.
//
// Client and server both import this file; it intentionally carries no drizzle
// / db imports so it stays client-safe (mirrors shared/models/mod-registry.ts).

import type { ContributionAudience } from "./mod-registry";
import type { ModKey } from "./mods";
import type { UiInteractionTarget } from "../ui-interaction";

export type ContributionModality = "web" | "mobile" | "voice";

export const CONTRIBUTION_MODALITIES: readonly ContributionModality[] = [
  "web",
  "mobile",
  "voice",
] as const;

export function isContributionModality(value: string): value is ContributionModality {
  return (CONTRIBUTION_MODALITIES as readonly string[]).includes(value);
}

/** One resolved, visible client route. Path + surface key only — no component. */
export interface ResolvedClientRoute {
  id: string;
  path: string;
  surfaceKey: string;
  exact?: boolean;
  sourceMod: "core" | ModKey;
}

/** One resolved, visible navigation destination referencing a route ID. */
export interface ResolvedNavigationItem {
  id: string;
  section: string;
  label: string;
  iconKey: string;
  target: UiInteractionTarget;
  routeId: string;
  order: number;
  sourceMod: "core" | ModKey;
}

/** One resolved, visible Home widget slot. */
export interface ResolvedWidget {
  id: string;
  slot: "home.primary" | "home.secondary" | "home.inbox";
  surfaceKey: string;
  collectorKey: string;
  order: number;
  sourceMod: "core" | ModKey;
}

/** One resolved Dashboard activity heatmap series. */
export interface ResolvedDashboardHeatmap {
  id: string;
  seriesKey: string;
  title: string;
  icon: string;
  order: number;
  group: "operating" | "code" | "wellness";
  sourceMod: "core" | ModKey;
}

export type ResolvedActionTarget =
  | { kind: "navigate"; routeId: string }
  | { kind: "tool"; toolName: string; action?: string }
  | { kind: "command"; commandKey: string };

/** One resolved, visible semantic action. */
export interface ResolvedAction {
  id: string;
  label: string;
  target: ResolvedActionTarget;
  sourceMod: "core" | ModKey;
}

/** One resolved connector card. Discovery metadata only — never credentials. */
export interface ResolvedIntegrationCard {
  id: string;
  connectorKey: string;
  relationship: "required" | "recommended" | "available";
  capabilities: string[];
  /** Whether the underlying connector capability is currently usable. */
  readiness: "ready" | "setup-required";
  sourceMod: "core" | ModKey;
  label: string;
  iconKey: string;
  audience?: ContributionAudience;
  /** Absent = readiness-only; the Integrations page must not invent a row. */
  route?: string;
  /** Code-owned detail surface; generic detail looks this up. */
  detailSurface?: string;
  healthField?: string;
  statusFields?: string[];
  ownsTitle?: boolean;
}

/** One resolved onboarding step. */
export interface ResolvedOnboardingStep {
  id: string;
  stepKey: string;
  order: number;
  sourceMod: "core" | ModKey;
}

/** One resolved extension-slot contribution. */
export interface ResolvedSlotContribution {
  id: string;
  slotKey: string;
  surfaceKey: string;
  order: number;
  sourceMod: "core" | ModKey;
}

/** Composition-level presentation arbitration (spec §4.5, §7.5). */
export interface ResolvedPresentation {
  primaryActionId?: string;
  primaryNavigationIds: string[];
  overflowNavigationIds: string[];
  homeContributionIds: string[];
}

export type ContributionDiagnosticState = "ready" | "setup-required" | "unavailable";

export interface ContributionDiagnostic {
  contributionId: string;
  state: ContributionDiagnosticState;
  reasonCode?: string;
}

/**
 * The effective, principal-resolved product. Derived (never persisted as a
 * second source of truth) and cached by a state-derived composition version.
 */
export interface ResolvedProductComposition {
  compositionVersion: string;
  modality: ContributionModality;
  activeMods: Array<{ key: ModKey; version: string }>;
  routes: ResolvedClientRoute[];
  navigation: ResolvedNavigationItem[];
  /**
   * Ownership map for mod-owned nav targets across the FULL registry (active or
   * not), so static client nav can hide a mod's entry whenever that mod is
   * inactive. Core-owned nav targets are intentionally absent (never gated).
   */
  navOwnership: Partial<Record<UiInteractionTarget, ModKey>>;
  widgets: ResolvedWidget[];
  dashboardHeatmaps: ResolvedDashboardHeatmap[];
  actions: ResolvedAction[];
  integrations: ResolvedIntegrationCard[];
  onboarding: ResolvedOnboardingStep[];
  slots: ResolvedSlotContribution[];
  presentation: ResolvedPresentation;
  diagnostics: ContributionDiagnostic[];
}
