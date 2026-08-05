import type { ModInstallationResourceRow, ModInstallationRow } from "@shared/schema";
import type { DrizzleTx } from "../db";
import type { Principal } from "../principal";

/**
 * Managed-resources contract for the Network Mod.
 *
 * Network owns no cadence timers, deployment observers, or other
 * ledger-materialized resources: its full-vertical surface is pages, routes,
 * and the `companies` tool, none of which require installation-owned rows.
 * These functions exist so the mod-lifecycle-service can dispatch Network
 * symmetrically with Build, Wellness, and Business, and so a future Network
 * managed resource has a canonical home. They are intentional, documented
 * no-ops — install/disable/reinstall touch nothing under Network ownership.
 */
export async function materializeNetworkManagedResources(
  _tx: DrizzleTx,
  _principal: Principal,
  _installation: ModInstallationRow,
): Promise<ModInstallationResourceRow[]> {
  return [];
}

export async function disableNetworkManagedResources(
  _tx: DrizzleTx,
  _principal: Principal,
  _installation: ModInstallationRow,
): Promise<void> {
  // No Network-owned managed resources to disable.
}
