// ─── First-party Mod registry (spec §3.3, Layer 2) ─────────────────────────
// Code-owned assembly of the one non-installable Core plus the seven Mods.
// This is the single source of truth for what a release CAN provide. Account
// entitlements/installations (Layer 3) and the request-time resolver (Layer 4,
// next step) consume it; nothing renders from it yet (Phase 1 shadow).

import type { ModRegistry } from "@shared/models/mod-registry";
import { coreDefinition } from "./core-definition";
import { modDefinitions } from "./mod-definitions";
import { validateModRegistry, ModRegistryValidationError } from "./validate-registry";

export const modRegistry: ModRegistry = {
  core: coreDefinition,
  mods: modDefinitions,
};

export function getModRegistry(): ModRegistry {
  return modRegistry;
}

/** Assert the canonical first-party registry is coherent, or throw loudly. */
export function assertModRegistryValid(): void {
  const problems = validateModRegistry(modRegistry);
  if (problems.length > 0) throw new ModRegistryValidationError(problems);
}

export { coreDefinition } from "./core-definition";
export { modDefinitions } from "./mod-definitions";
export { validateModRegistry, ModRegistryValidationError } from "./validate-registry";
