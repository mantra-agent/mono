// ─── Boot/build-time registry validation (spec §6.1) ───────────────────────
// First-party collisions and dangling references are deployment defects and
// must fail loudly. This validator runs at server startup AND in the production
// build (script/build.ts) so drift can never reach a running release. The
// resolver never chooses a winner at runtime — the registry is proven coherent
// before it is used.
//
// Checks (spec §6.1):
//   • unique Mod keys + valid SemVer (and the full first-party set present)
//   • unique contribution IDs
//   • no duplicate route paths or semantic action IDs
//   • every referenced key exists (surface/icon/route/widget/collector/
//     connector/workflow/slot/command) and every nav/action routeId resolves
//   • no Mod contribution overrides Core (owner-prefixed IDs; no `core.*` in a Mod)
//   • every declared permission belongs to the central vocabulary
//   • no memory contribution kind
//   • no required Mod-to-Mod dependency (recommendsMods is discovery-only)

import type {
  AnyContribution,
  CoreDefinition,
  ModContributions,
  ModDefinition,
  ModRegistry,
} from "@shared/models/mod-registry";
import { CORE_CAPABILITY_KEYS, listContributions } from "@shared/models/mod-registry";
import { MOD_KEYS, type ModKey } from "@shared/models/mods";
import { PERMISSIONS } from "@shared/permissions-vocabulary";
import { isUiInteractionTarget, UI_INTERACTION_TARGET_ROUTES } from "@shared/ui-interaction";
import { REGISTERED_KEY_CATALOGS } from "./registered-keys";

export class ModRegistryValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Mod registry validation failed with ${problems.length} problem(s):\n- ${problems.join("\n- ")}`);
    this.name = "ModRegistryValidationError";
    this.problems = problems;
  }
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PERMISSION_SET = new Set<string>(PERMISSIONS);
const CORE_CAPABILITY_SET = new Set<string>(CORE_CAPABILITY_KEYS);
const MOD_KEY_SET = new Set<string>(MOD_KEYS);

function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

interface OwnedContribution {
  owner: string;
  contribution: AnyContribution;
}

function collectOwned(def: CoreDefinition | ModDefinition): OwnedContribution[] {
  return listContributions(def.contributions).map((contribution) => ({ owner: def.key, contribution }));
}

/**
 * Validate the assembled registry. Returns the (throwing-on-empty-none) list of
 * problems for callers that prefer to inspect; `assertModRegistryValid` throws.
 */
export function validateModRegistry(registry: ModRegistry): string[] {
  const problems: string[] = [];
  const push = (msg: string) => problems.push(msg);

  const core = registry.core;
  const mods = registry.mods;

  // ── Core shape ────────────────────────────────────────────────────────────
  if (core.key !== "core") push(`Core definition key must be "core", got "${core.key}".`);
  if (!parseSemver(core.version)) push(`Core version "${core.version}" is not valid SemVer.`);

  // ── Mod keys: unique, valid, and the full first-party set present ─────────
  const seenModKeys = new Set<string>();
  for (const mod of mods) {
    if (!MOD_KEY_SET.has(mod.key)) push(`Unknown Mod key "${mod.key}" (not in MOD_KEYS).`);
    if (seenModKeys.has(mod.key)) push(`Duplicate Mod key "${mod.key}".`);
    seenModKeys.add(mod.key);
    if (!parseSemver(mod.version)) push(`Mod "${mod.key}" version "${mod.version}" is not valid SemVer.`);
    if (!parseSemver(mod.compatibility.minimumCoreVersion)) {
      push(`Mod "${mod.key}" minimumCoreVersion "${mod.compatibility.minimumCoreVersion}" is not valid SemVer.`);
    } else if (compareSemver(mod.compatibility.minimumCoreVersion, core.version) > 0) {
      push(`Mod "${mod.key}" requires Core >= ${mod.compatibility.minimumCoreVersion} but Core is ${core.version}.`);
    }
  }
  for (const key of MOD_KEYS) {
    if (!seenModKeys.has(key)) push(`Missing first-party Mod definition for "${key}".`);
  }

  const definitions: (CoreDefinition | ModDefinition)[] = [core, ...mods];
  const owned: OwnedContribution[] = definitions.flatMap(collectOwned);

  // ── First pass: identity indexes ─────────────────────────────────────────
  const contributionIdCounts = new Map<string, number>();
  const heatmapSeriesKeyCounts = new Map<string, number>();
  const executableKeyCounts = new Map<string, number>();
  const clientRouteIds = new Set<string>();
  const clientRoutePaths = new Map<string, string>();
  const routePaths = new Map<string, number>();
  const actionIds = new Set<string>();

  for (const { contribution } of owned) {
    contributionIdCounts.set(contribution.id, (contributionIdCounts.get(contribution.id) ?? 0) + 1);
    if (contribution.kind === "client-route") {
      clientRouteIds.add(contribution.id);
      clientRoutePaths.set(contribution.id, contribution.path);
      routePaths.set(contribution.path, (routePaths.get(contribution.path) ?? 0) + 1);
    }
    if (contribution.kind === "action") {
      if (actionIds.has(contribution.id)) push(`Duplicate semantic action ID "${contribution.id}".`);
      actionIds.add(contribution.id);
    }
    if (["tool", "skill", "workflow", "hook-template", "timer-template", "server-route-group", "search-provider", "notification"].includes(contribution.kind)) {
      const key = contribution.kind === "tool" ? contribution.toolName
        : contribution.kind === "skill" ? contribution.skillKey
        : contribution.kind === "workflow" ? contribution.workflowKey
        : contribution.kind === "hook-template" ? contribution.templateKey
        : contribution.kind === "timer-template" ? contribution.templateKey
        : contribution.kind === "server-route-group" ? contribution.routeGroupKey
        : contribution.kind === "search-provider" ? contribution.providerKey
        : contribution.notificationKind;
      const identity = `${contribution.kind}:${key}`;
      executableKeyCounts.set(identity, (executableKeyCounts.get(identity) ?? 0) + 1);
    }
    if (contribution.kind === "dashboard-heatmap") {
      heatmapSeriesKeyCounts.set(
        contribution.seriesKey,
        (heatmapSeriesKeyCounts.get(contribution.seriesKey) ?? 0) + 1,
      );
    }
  }

  for (const [id, count] of contributionIdCounts) {
    if (count > 1) push(`Duplicate contribution ID "${id}" (appears ${count} times).`);
  }
  for (const [path, count] of routePaths) {
    if (count > 1) push(`Duplicate client route path "${path}" (appears ${count} times).`);
  }
  for (const [identity, count] of executableKeyCounts) {
    if (count > 1) push(`Duplicate executable contribution "${identity}" (appears ${count} times).`);
  }
  for (const [seriesKey, count] of heatmapSeriesKeyCounts) {
    if (count > 1) {
      push(`Duplicate dashboard heatmap seriesKey "${seriesKey}" (appears ${count} times).`);
    }
  }

  // ── Second pass: per-contribution reference + policy checks ───────────────
  for (const { owner, contribution } of owned) {
    validateContribution(owner, contribution, { clientRouteIds, clientRoutePaths, push });
  }

  // ── Per-definition policy: prefixes, permissions, capabilities, deps ──────
  for (const def of definitions) {
    validateDefinitionPolicy(def, push);
  }

  return problems;
}

interface ContributionCtx {
  clientRouteIds: Set<string>;
  clientRoutePaths: Map<string, string>;
  push: (msg: string) => void;
}

function requireKey(kind: keyof typeof REGISTERED_KEY_CATALOGS, key: string, id: string, ctx: ContributionCtx): void {
  if (!REGISTERED_KEY_CATALOGS[kind].has(key)) {
    ctx.push(`Contribution "${id}" references unknown ${kind} key "${key}".`);
  }
}

function validateContribution(owner: string, c: AnyContribution, ctx: ContributionCtx): void {
  const { push } = ctx;

  // No memory contribution may exist (spec §2 invariant 2).
  if ((c as { kind: string }).kind === "memory") {
    push(`Contribution "${c.id}" declares a forbidden memory contribution kind.`);
  }

  // Permissions must be in the central vocabulary.
  for (const perm of c.requiredPermissions ?? []) {
    if (!PERMISSION_SET.has(perm)) push(`Contribution "${c.id}" declares unknown permission "${perm}".`);
  }
  // Integration capability refs point at real connectors.
  for (const ref of c.requiredIntegrations ?? []) {
    requireKey("connector", ref.connectorKey, c.id, ctx);
  }

  switch (c.kind) {
    case "client-route":
      requireKey("surface", c.surfaceKey, c.id, ctx);
      break;
    case "navigation": {
      requireKey("icon", c.iconKey, c.id, ctx);
      if (!isUiInteractionTarget(c.target)) {
        push(`Navigation "${c.id}" references unknown interaction target "${String(c.target)}".`);
      } else if (!ctx.clientRouteIds.has(c.routeId)) {
        push(`Navigation "${c.id}" references unknown route ID "${c.routeId}".`);
      } else {
        const targetPath = UI_INTERACTION_TARGET_ROUTES[c.target].href.split("?")[0];
        const routePath = ctx.clientRoutePaths.get(c.routeId);
        if (routePath !== targetPath) {
          push(
            `Navigation "${c.id}" target "${c.target}" resolves to "${targetPath}" but route "${c.routeId}" resolves to "${routePath}".`,
          );
        }
      }
      if (!Number.isFinite(c.order)) push(`Navigation "${c.id}" has a non-numeric order.`);
      break;
    }
    case "widget":
      requireKey("widget", c.surfaceKey, c.id, ctx);
      requireKey("collector", c.collectorKey, c.id, ctx);
      if (!Number.isFinite(c.order)) push(`Widget "${c.id}" has a non-numeric order.`);
      break;
    case "dashboard-heatmap":
      requireKey("dashboardHeatmapSeries", c.seriesKey, c.id, ctx);
      requireKey("icon", c.icon, c.id, ctx);
      if (!c.title || !c.title.trim()) push(`Dashboard heatmap "${c.id}" is missing title.`);
      if (!Number.isFinite(c.order)) push(`Dashboard heatmap "${c.id}" has a non-numeric order.`);
      if (c.group !== "operating" && c.group !== "code" && c.group !== "wellness") {
        push(`Dashboard heatmap "${c.id}" has invalid group "${String(c.group)}".`);
      }
      break;
    case "slot":
      requireKey("slot", c.slotKey, c.id, ctx);
      requireKey("surface", c.surfaceKey, c.id, ctx);
      if (!Number.isFinite(c.order)) push(`Slot "${c.id}" has a non-numeric order.`);
      break;
    case "action":
      if (c.target.kind === "navigate") {
        if (!ctx.clientRouteIds.has(c.target.routeId)) {
          push(`Action "${c.id}" navigates to unknown route ID "${c.target.routeId}".`);
        }
      } else if (c.target.kind === "command") {
        requireKey("command", c.target.commandKey, c.id, ctx);
      } else if (c.target.kind === "tool") {
        push(`Action "${c.id}" targets a tool; tool actions are not supported in the Phase 1 registry.`);
      }
      break;
    case "integration":
      requireKey("connector", c.connectorKey, c.id, ctx);
      requireKey("icon", c.iconKey, c.id, ctx);
      if (!c.label || !c.label.trim()) push(`Integration "${c.id}" is missing label.`);
      if (c.route && !c.detailSurface) {
        push(`Integration "${c.id}" has a route but no detailSurface.`);
      }
      break;
    case "workflow":
      requireKey("workflow", c.workflowKey, c.id, ctx);
      break;
    case "timer-template":
      requireKey("timerTemplate", c.templateKey, c.id, ctx);
      break;
    case "skill":
      requireKey("skill", c.skillKey, c.id, ctx);
      break;
    case "server-route-group":
      requireKey("routeGroup", c.routeGroupKey, c.id, ctx);
      break;
    case "tool":
      requireKey("tool", c.toolName, c.id, ctx);
      break;
    case "hook-template":
      push(`Contribution "${c.id}" declares hook template "${c.templateKey}" without a registered hook-template catalog.`);
      break;
    default:
      break;
  }
}

function validateDefinitionPolicy(def: CoreDefinition | ModDefinition, push: (msg: string) => void): void {
  const owner = def.key;
  const prefix = `${owner}.`;

  for (const contribution of listContributions(def.contributions)) {
    if (!contribution.id.startsWith(prefix)) {
      push(`Contribution "${contribution.id}" in "${owner}" must be prefixed with "${prefix}".`);
    }
    // A Mod may never claim the Core namespace (no override of Core).
    if (owner !== "core" && contribution.id.startsWith("core.")) {
      push(`Mod "${owner}" contribution "${contribution.id}" overrides the Core namespace.`);
    }
  }

  if (def.key === "core") return; // Core has no requiresCore/recommendsMods/experience contract.

  const mod = def as ModDefinition;

  // requiresCore holds only Core capability keys — never a Mod-to-Mod requirement.
  for (const cap of mod.requiresCore) {
    if (!CORE_CAPABILITY_SET.has(cap)) push(`Mod "${owner}" requiresCore has unknown capability "${cap}".`);
    if (MOD_KEY_SET.has(cap as string)) push(`Mod "${owner}" requiresCore references a Mod key "${cap}" (no required Mod-to-Mod dependency allowed).`);
  }

  // recommendsMods is discovery-only; entries must be real Mods and not self.
  for (const rec of mod.recommendsMods ?? []) {
    if (!MOD_KEY_SET.has(rec)) push(`Mod "${owner}" recommends unknown Mod "${rec}".`);
    if (rec === owner) push(`Mod "${owner}" recommends itself.`);
  }

  // Guard against a stray required Mod-to-Mod field sneaking in via casts.
  const stray = (mod as unknown as { requiresMods?: ModKey[] }).requiresMods;
  if (stray && stray.length > 0) push(`Mod "${owner}" declares a forbidden required Mod-to-Mod dependency.`);

  // rootSurfaceKey, when present, must resolve to a real surface.
  const rootSurface = mod.experience.rootSurfaceKey;
  if (rootSurface && !REGISTERED_KEY_CATALOGS.surface.has(rootSurface)) {
    push(`Mod "${owner}" experience.rootSurfaceKey "${rootSurface}" is not a registered surface.`);
  }

  // Guard against a memory field sneaking into contributions via casts.
  if ((mod.contributions as ModContributions & { memory?: unknown }).memory !== undefined) {
    push(`Mod "${owner}" declares a forbidden memory contribution bundle.`);
  }
}
