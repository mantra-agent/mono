// ─── Request-time contribution resolver (spec §4.4, §4.5, §6.2) ────────────
// Composes Core + active entitled installations + principal permissions +
// integration readiness + modality into a ResolvedProductComposition. It is
// the single request-time authority for the effective product (Layer 4).
//
// Guarantees:
//  • NEVER queries Memory to decide availability (spec §6.2). It touches only
//    entitlements, installations, connected accounts, provider connections,
//    app secrets, and the code-owned registry.
//  • Bounded queries only — exactly four principal-scoped reads regardless of
//    how many contributions exist. No per-contribution DB fan-out.
//  • Every read uses an EXPLICIT principal (not AsyncLocalStorage), so a route
//    that is not wrapped in runWithPrincipal can never leak another account's
//    connected accounts / provider connections.
//  • Resolved composition is DERIVED and cached by a state-derived version; it
//    is never persisted as a second source of truth. Cache invalidation is
//    automatic: any change to the inputs changes the version and yields a fresh
//    entry (spec §4.5 "invalidated by entitlement, installation, permission,
//    connector, or deployment-version changes").

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { createLogger } from "../../log";
import type { Principal } from "../../principal";
import { principalHasPermission } from "../../permissions";
import type { Permission } from "@shared/permissions-vocabulary";
import { combineWithVisibleScope, type ScopeColumns } from "../../scoped-storage";
import { combineWithSensitiveVisible } from "../../sensitive-scope";
import { TTLCache } from "../../utils/ttl-cache";
import { connectedAccounts } from "@shared/schema";
import { providerConnections } from "@shared/models/platforms";
import {
  MOD_KEYS,
  modEntitlements,
  modInstallations,
  type ModEntitlementRow,
  type ModInstallationRow,
  type ModKey,
} from "@shared/schema";
import type { AnyContribution, ModContributions } from "@shared/models/mod-registry";
import { getModRegistry, coreDefinition } from "../registry";
import { CORE_VERSION } from "../registry/core-definition";
import { listContributions } from "@shared/models/mod-registry";
import {
  type ContributionDiagnostic,
  type ContributionDiagnosticState,
  type ContributionModality,
  type ResolvedAction,
  type ResolvedClientRoute,
  type ResolvedDashboardHeatmap,
  type ResolvedIntegrationCard,
  type ResolvedNavigationItem,
  type ResolvedOnboardingStep,
  type ResolvedPresentation,
  type ResolvedProductComposition,
  type ResolvedSlotContribution,
  type ResolvedWidget,
} from "@shared/models/product-composition";
import { resolveConnectorReadiness, type ConnectorReadiness } from "./connector-readiness";
import { isModPlatformEnabled } from "../mod-platform-config";
import { isUiInteractionTarget, type UiInteractionTarget } from "@shared/ui-interaction";

const log = createLogger("mod-composition-resolver");

// Cache the DERIVED composition by a state-derived fingerprint. Two principals
// with identical (active mods, permissions, connector readiness, modality)
// resolve to a byte-identical composition, so sharing that entry is safe by
// construction (no per-account data in the output). 60s TTL bounds staleness
// even if an input's version derivation ever missed a signal.
const COMPOSITION_CACHE_TTL_MS = 60_000;
const _compositionCache = new TTLCache<ResolvedProductComposition>(
  "ProductComposition",
  COMPOSITION_CACHE_TTL_MS,
);

const entitlementScope: ScopeColumns = {
  scope: modEntitlements.scope,
  ownerUserId: modEntitlements.ownerUserId,
  accountId: modEntitlements.accountId,
};
const installationScope: ScopeColumns = {
  scope: modInstallations.scope,
  ownerUserId: modInstallations.ownerUserId,
  accountId: modInstallations.accountId,
};
const providerConnectionScope: ScopeColumns = {
  scope: providerConnections.scope,
  ownerUserId: providerConnections.ownerUserId,
  accountId: providerConnections.accountId,
};

/**
 * Deployment registry version (spec §4.5, §6.2 step 7). Derived once at module
 * load from the code-owned registry content; it changes whenever a deploy ships
 * a registry change, giving deployment-version cache invalidation for free.
 */
const REGISTRY_VERSION: string = (() => {
  const registry = getModRegistry();
  const projection = {
    core: {
      version: registry.core.version,
      contributionIds: listContributions(registry.core.contributions)
        .map((c) => c.id)
        .sort(),
    },
    mods: registry.mods
      .map((m) => ({
        key: m.key,
        version: m.version,
        minCore: m.compatibility.minimumCoreVersion,
        contributionIds: listContributions(m.contributions)
          .map((c) => c.id)
          .sort(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex").slice(0, 16);
})();

/** Minimal x.y.z semver "a <= b" comparison for Core compatibility checks. */
export function semverLte(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db_ = pb[i] ?? 0;
    if (da < db_) return true;
    if (da > db_) return false;
  }
  return true;
}

interface CompositionInputs {
  entitlements: Map<string, ModEntitlementRow>;
  installations: Map<string, ModInstallationRow>;
  connectorReadiness: Map<string, ConnectorReadiness>;
}

function requireAccount(principal: Principal): { userId: string; accountId: string } {
  if (!principal.userId || !principal.accountId) {
    throw new Error("Product composition requires a resolved user+account principal");
  }
  return { userId: principal.userId, accountId: principal.accountId };
}

/**
 * Four bounded, EXPLICIT-principal reads. Tiny per account (≤7 entitlement/
 * installation rows; a handful of connected accounts / provider connections).
 */
async function loadCompositionInputs(principal: Principal): Promise<CompositionInputs> {
  const [entitlementRows, installationRows, accountRows, connectionRows] = await Promise.all([
    db
      .select()
      .from(modEntitlements)
      .where(combineWithVisibleScope(principal, entitlementScope))
      .limit(200),
    db
      .select()
      .from(modInstallations)
      .where(combineWithVisibleScope(principal, installationScope))
      .limit(200),
    db
      .select({ provider: connectedAccounts.provider, healthy: connectedAccounts.healthy })
      .from(connectedAccounts)
      .where(
        combineWithSensitiveVisible(
          {
            ownerUserId: connectedAccounts.ownerUserId,
            principalAccountId: connectedAccounts.principalAccountId,
            vaultId: connectedAccounts.vaultId,
          },
          undefined,
          principal,
        ),
      )
      .limit(200),
    db
      .select({ provider: providerConnections.provider, status: providerConnections.status })
      .from(providerConnections)
      .where(combineWithVisibleScope(principal, providerConnectionScope))
      .limit(200),
  ]);

  const entitlements = new Map<string, ModEntitlementRow>();
  for (const row of entitlementRows) entitlements.set(row.modKey, row);
  const installations = new Map<string, ModInstallationRow>();
  for (const row of installationRows) installations.set(row.modKey, row);

  const connectorReadiness = resolveConnectorReadiness(
    accountRows.map((r) => ({ provider: r.provider, healthy: r.healthy ?? null })),
    connectionRows.map((r) => ({ provider: r.provider, status: r.status })),
  );

  return { entitlements, installations, connectorReadiness };
}

function entitlementIsActive(row: ModEntitlementRow | undefined, now: Date): boolean {
  if (!row) return false;
  if (row.status !== "granted") return false;
  if (row.validFrom && row.validFrom.getTime() > now.getTime()) return false;
  if (row.validUntil && row.validUntil.getTime() < now.getTime()) return false;
  return true;
}

/** A Mod is active iff registered ∩ Core-compatible ∩ entitled ∩ installation active. */
function computeActiveMods(inputs: CompositionInputs, now: Date): Set<ModKey> {
  const active = new Set<ModKey>();
  if (!isModPlatformEnabled()) return active;
  const registry = getModRegistry();
  for (const def of registry.mods) {
    const compatible = semverLte(def.compatibility.minimumCoreVersion, CORE_VERSION);
    if (!compatible) continue;
    if (!entitlementIsActive(inputs.entitlements.get(def.key), now)) continue;
    if (inputs.installations.get(def.key)?.status !== "active") continue;
    active.add(def.key);
  }
  return active;
}

interface ContributionResolution {
  visible: boolean;
  state: ContributionDiagnosticState;
  reasonCode?: string;
}

function hasAllPermissions(principal: Principal, permissions: readonly string[] | undefined): boolean {
  if (!permissions || permissions.length === 0) return true;
  return permissions.every((permission) =>
    principalHasPermission(principal, permission as Permission),
  );
}

function supportsModality(
  contribution: AnyContribution,
  modality: ContributionModality,
): boolean {
  const modalities = (contribution as { modalities?: ContributionModality[] }).modalities;
  if (!modalities || modalities.length === 0) return true;
  return modalities.includes(modality);
}

/** Resolve one contribution's visibility + diagnostic state (spec §3.2). */
function resolveContribution(
  contribution: AnyContribution,
  ownerActive: boolean,
  ownerReason: string | undefined,
  principal: Principal,
  modality: ContributionModality,
  connectorReadiness: Map<string, ConnectorReadiness>,
): ContributionResolution {
  if (!ownerActive) {
    return { visible: false, state: "unavailable", reasonCode: ownerReason ?? "mod-inactive" };
  }
  if (!hasAllPermissions(principal, contribution.requiredPermissions)) {
    return { visible: false, state: "unavailable", reasonCode: "permission-required" };
  }
  if (!supportsModality(contribution, modality)) {
    return { visible: false, state: "unavailable", reasonCode: "modality-unsupported" };
  }

  // Visible. Now decide executable/setup readiness from integration requirements
  // and, for integration cards, the card's own connector readiness.
  const requiredIntegrations = contribution.requiredIntegrations ?? [];
  for (const ref of requiredIntegrations) {
    if (connectorReadiness.get(ref.connectorKey) !== "ready") {
      return { visible: true, state: "setup-required", reasonCode: "integration-not-ready" };
    }
  }
  if (contribution.kind === "integration") {
    const readiness = connectorReadiness.get(contribution.connectorKey);
    if (readiness !== "ready") {
      return { visible: true, state: "setup-required", reasonCode: "integration-not-ready" };
    }
  }
  return { visible: true, state: "ready" };
}

/** Reason an owner Mod is inactive, for diagnostics. */
function inactiveModReason(inputs: CompositionInputs, modKey: ModKey, now: Date): string {
  const registry = getModRegistry();
  const def = registry.mods.find((m) => m.key === modKey);
  if (def && !semverLte(def.compatibility.minimumCoreVersion, CORE_VERSION)) return "incompatible";
  if (!entitlementIsActive(inputs.entitlements.get(modKey), now)) return "not-entitled";
  if (inputs.installations.get(modKey)?.status !== "active") return "not-installed";
  return "mod-inactive";
}

interface OwnerBundle {
  owner: "core" | ModKey;
  active: boolean;
  inactiveReason?: string;
  contributions: ModContributions;
}

/** Pure composition: registry + inputs + principal + modality → resolved product. */
function compose(
  inputs: CompositionInputs,
  principal: Principal,
  modality: ContributionModality,
  now: Date,
): ResolvedProductComposition {
  const registry = getModRegistry();
  const activeMods = computeActiveMods(inputs, now);

  const bundles: OwnerBundle[] = [
    { owner: "core", active: true, contributions: coreDefinition.contributions },
    ...registry.mods.map<OwnerBundle>((def) => ({
      owner: def.key,
      active: activeMods.has(def.key),
      inactiveReason: activeMods.has(def.key)
        ? undefined
        : inactiveModReason(inputs, def.key, now),
      contributions: def.contributions,
    })),
  ];

  const routes: ResolvedClientRoute[] = [];
  const navigation: ResolvedNavigationItem[] = [];
  const widgets: ResolvedWidget[] = [];
  const dashboardHeatmaps: ResolvedDashboardHeatmap[] = [];
  const actions: ResolvedAction[] = [];
  const integrations: ResolvedIntegrationCard[] = [];
  const onboarding: ResolvedOnboardingStep[] = [];
  const slots: ResolvedSlotContribution[] = [];
  const diagnostics: ContributionDiagnostic[] = [];
  const navOwnership: Partial<Record<UiInteractionTarget, ModKey>> = {};

  for (const bundle of bundles) {
    for (const contribution of listContributions(bundle.contributions)) {
      // Ownership is a property of the full registry, not of the active/visible
      // subset: record which mod owns each nav target regardless of whether the
      // mod is active or the principal is permitted. This lets static client nav
      // hide a mod's entry the moment that mod is inactive (no permission-denied
      // ghost). Core-owned nav is never gated, so it is intentionally excluded.
      if (contribution.kind === "navigation" && bundle.owner !== "core") {
        navOwnership[contribution.target] = bundle.owner;
      }

      const resolution = resolveContribution(
        contribution,
        bundle.active,
        bundle.inactiveReason,
        principal,
        modality,
        inputs.connectorReadiness,
      );

      // Diagnostics surface everything that is NOT plainly ready (spec §4.5).
      if (resolution.state !== "ready") {
        diagnostics.push({
          contributionId: contribution.id,
          state: resolution.state,
          reasonCode: resolution.reasonCode,
        });
      }

      if (!resolution.visible) continue;

      switch (contribution.kind) {
        case "client-route":
          routes.push({
            id: contribution.id,
            path: contribution.path,
            surfaceKey: contribution.surfaceKey,
            ...(contribution.exact !== undefined ? { exact: contribution.exact } : {}),
            sourceMod: bundle.owner,
          });
          break;
        case "navigation":
          // Never publish nav targets the client route table cannot resolve.
          if (!isUiInteractionTarget(contribution.target)) {
            diagnostics.push({
              contributionId: contribution.id,
              state: "unavailable",
              reasonCode: "unknown_interaction_target",
            });
            break;
          }
          navigation.push({
            id: contribution.id,
            section: contribution.section,
            label: contribution.label,
            iconKey: contribution.iconKey,
            target: contribution.target,
            routeId: contribution.routeId,
            order: contribution.order,
            sourceMod: bundle.owner,
          });
          break;
        case "widget":
          widgets.push({
            id: contribution.id,
            slot: contribution.slot,
            surfaceKey: contribution.surfaceKey,
            collectorKey: contribution.collectorKey,
            order: contribution.order,
            sourceMod: bundle.owner,
          });
          break;
        case "dashboard-heatmap":
          dashboardHeatmaps.push({
            id: contribution.id,
            seriesKey: contribution.seriesKey,
            title: contribution.title,
            icon: contribution.icon,
            order: contribution.order,
            group: contribution.group,
            sourceMod: bundle.owner,
          });
          break;
        case "action":
          actions.push({
            id: contribution.id,
            label: contribution.label,
            target: contribution.target,
            sourceMod: bundle.owner,
          });
          break;
        case "integration":
          integrations.push({
            id: contribution.id,
            connectorKey: contribution.connectorKey,
            relationship: contribution.relationship,
            capabilities: contribution.capabilities,
            readiness:
              inputs.connectorReadiness.get(contribution.connectorKey) === "ready"
                ? "ready"
                : "setup-required",
            sourceMod: bundle.owner,
            label: contribution.label,
            iconKey: contribution.iconKey,
            audience: contribution.audience,
            ...(contribution.route ? { route: contribution.route } : {}),
            ...(contribution.detailSurface ? { detailSurface: contribution.detailSurface } : {}),
            ...(contribution.healthField ? { healthField: contribution.healthField } : {}),
            ...(contribution.statusFields?.length ? { statusFields: contribution.statusFields } : {}),
            ...(contribution.ownsTitle ? { ownsTitle: true } : {}),
          });
          break;
        case "onboarding":
          onboarding.push({
            id: contribution.id,
            stepKey: contribution.stepKey,
            order: contribution.order,
            sourceMod: bundle.owner,
          });
          break;
        case "slot":
          slots.push({
            id: contribution.id,
            slotKey: contribution.slotKey,
            surfaceKey: contribution.surfaceKey,
            order: contribution.order,
            sourceMod: bundle.owner,
          });
          break;
        default:
          // skills/workflows/hooks/timers/tools/search/notification contributions
          // are executable references, not client-serializable surfaces; they
          // never cross the composition boundary.
          break;
      }
    }
  }

  // Deterministic ordering.
  navigation.sort((a, b) =>
    a.section === b.section ? a.order - b.order : a.section.localeCompare(b.section),
  );
  widgets.sort((a, b) => (a.slot === b.slot ? a.order - b.order : a.slot.localeCompare(b.slot)));
  dashboardHeatmaps.sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order));
  onboarding.sort((a, b) => a.order - b.order);
  slots.sort((a, b) => a.order - b.order);

  const presentation = derivePresentation(navigation, actions, widgets);

  const activeModList = registry.mods
    .filter((m) => activeMods.has(m.key))
    .map((m) => ({ key: m.key, version: m.version }));

  const compositionVersion = deriveCompositionVersion(activeModList, principal, inputs, modality);

  return {
    compositionVersion,
    modality,
    activeMods: activeModList,
    routes,
    navigation,
    navOwnership,
    widgets,
    dashboardHeatmaps,
    actions,
    integrations,
    onboarding,
    slots,
    presentation,
    diagnostics,
  };
}

/**
 * Presentation arbitration (spec §4.5, §7.5): "Tools" is today's primary
 * product area, so its visible nav is primary and everything else is overflow.
 * The primary action is the action that navigates to the first primary nav
 * destination, falling back to Home.
 */
function derivePresentation(
  navigation: ResolvedNavigationItem[],
  actions: ResolvedAction[],
  widgets: ResolvedWidget[],
): ResolvedPresentation {
  const primaryNav = navigation.filter((n) => n.section === "Tools");
  const overflowNav = navigation.filter((n) => n.section !== "Tools");

  const firstPrimaryRouteId = primaryNav[0]?.routeId;
  const actionForRoute = (routeId: string | undefined) =>
    routeId
      ? actions.find((a) => a.target.kind === "navigate" && a.target.routeId === routeId)?.id
      : undefined;
  const homeAction = actions.find(
    (a) => a.target.kind === "navigate" && a.target.routeId === "core.route.home",
  )?.id;
  const primaryActionId = actionForRoute(firstPrimaryRouteId) ?? homeAction;

  return {
    primaryActionId,
    primaryNavigationIds: primaryNav.map((n) => n.id),
    overflowNavigationIds: overflowNav.map((n) => n.id),
    homeContributionIds: widgets.map((w) => w.id),
  };
}

/**
 * Composition version = stable hash of every input that determines the output
 * (spec §4.5, §6.2 step 7): deployment registry version + active mods/versions
 * + principal permissions + connector readiness + modality. Any input mutation
 * changes this version and yields a fresh cache entry — derived, never synced.
 */
function deriveCompositionVersion(
  activeMods: Array<{ key: ModKey; version: string }>,
  principal: Principal,
  inputs: CompositionInputs,
  modality: ContributionModality,
): string {
  const fingerprint = {
    registry: REGISTRY_VERSION,
    core: CORE_VERSION,
    mods: activeMods.map((m) => `${m.key}@${m.version}`).sort(),
    permissions: [...(principal.permissions ?? [])].sort(),
    connectors: [...inputs.connectorReadiness.entries()]
      .map(([key, state]) => `${key}:${state}`)
      .sort(),
    modality,
  };
  return `v1.${createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex").slice(0, 24)}`;
}

/** Cache key: fingerprint identity only, no raw account data (safe to share). */
function cacheKey(principal: Principal, inputs: CompositionInputs, modality: ContributionModality): string {
  const activeInputs = {
    entitlements: [...inputs.entitlements.entries()]
      .map(([k, v]) => `${k}:${v.status}:${v.validFrom?.getTime() ?? ""}:${v.validUntil?.getTime() ?? ""}`)
      .sort(),
    installations: [...inputs.installations.entries()].map(([k, v]) => `${k}:${v.status}`).sort(),
    permissions: [...(principal.permissions ?? [])].sort(),
    connectors: [...inputs.connectorReadiness.entries()].map(([k, v]) => `${k}:${v}`).sort(),
    modality,
    registry: REGISTRY_VERSION,
    modPlatformEnabled: isModPlatformEnabled(),
  };
  return createHash("sha256").update(JSON.stringify(activeInputs)).digest("hex").slice(0, 32);
}

/**
 * Resolve the effective product composition for a principal + modality.
 * Meets the §9.5 latency budget: four tiny bounded reads plus in-memory
 * composition, with a fingerprint-keyed cache serving warm requests.
 */
export async function resolveProductComposition(
  principal: Principal,
  modality: ContributionModality,
): Promise<ResolvedProductComposition> {
  requireAccount(principal);
  const now = new Date();
  const inputs = await loadCompositionInputs(principal);
  const key = cacheKey(principal, inputs, modality);
  return _compositionCache.getOrFetch(key, async () => {
    const composed = compose(inputs, principal, modality, now);
    log.debug("resolved product composition", {
      modality,
      activeMods: composed.activeMods.length,
      routes: composed.routes.length,
      navigation: composed.navigation.length,
      diagnostics: composed.diagnostics.length,
      version: composed.compositionVersion,
    });
    return composed;
  });
}

/**
 * Compose a SYNTHETIC all-active / all-permission / all-ready composition for a
 * given modality. Used only by shadow-parity drift checking to compare the
 * resolver's output against today's hard-coded lists (spec Phase 1). Pure and
 * DB-free: it does not read or expose any real account state.
 */
export function composeParityShape(modality: ContributionModality): ResolvedProductComposition {
  const now = new Date();
  const entitlements = new Map<string, ModEntitlementRow>();
  const installations = new Map<string, ModInstallationRow>();
  for (const modKey of MOD_KEYS) {
    entitlements.set(modKey, {
      status: "granted",
      modKey,
      validFrom: null,
      validUntil: null,
    } as ModEntitlementRow);
    installations.set(modKey, { status: "active", modKey } as ModInstallationRow);
  }
  const connectorReadiness = new Map<string, ConnectorReadiness>();
  for (const [key] of resolveConnectorReadiness([], [])) connectorReadiness.set(key, "ready");

  const inputs: CompositionInputs = { entitlements, installations, connectorReadiness };
  const parityPrincipal = {
    actorType: "user",
    userId: "parity",
    accountId: "parity",
    permissions: ["build:read", "build:write", "system:read", "system:write", "users:read", "users:write", "mods:read", "mods:manage"],
    isAdmin: true,
    visibleVaultIds: [],
    activeVaultId: null,
  } as unknown as Principal;

  return compose(inputs, parityPrincipal, modality, now);
}
