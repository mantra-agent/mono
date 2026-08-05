import type { ModInstallationResourceRow, ModInstallationRow } from "@shared/schema";
import type { DrizzleTx } from "../db";
import type { Principal } from "../principal";

/**
 * Managed-resources contract for the Planning Mod.
 *
 * Planning's full-vertical Scenarios surface owns no cadence timers,
 * deployment observers, or other ledger-materialized resources: it is pages,
 * routes, and the `scenarios` tool, none of which require installation-owned
 * rows. (The daily/weekly/monthly reflection timer templates are not declared
 * as Planning-owned managed resources in the ModDefinition.) These functions
 * exist so the mod-lifecycle-service can dispatch Planning symmetrically with
 * Build, Wellness, Business, and Network, and so a future Planning managed
 * resource has a canonical home. They are intentional, documented no-ops —
 * install/disable/reinstall touch nothing under Planning ownership.
 */
export async function materializePlanningManagedResources(
  _tx: DrizzleTx,
  _principal: Principal,
  _installation: ModInstallationRow,
): Promise<ModInstallationResourceRow[]> {
  return [];
}

export async function disablePlanningManagedResources(
  _tx: DrizzleTx,
  _principal: Principal,
  _installation: ModInstallationRow,
): Promise<void> {
  // No Planning-owned managed resources to disable.
}
