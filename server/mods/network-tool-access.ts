import type { ToolSchema } from "../tool-registry";
import type { Principal } from "../principal";
import { hasActiveNetworkAccess } from "./network-access";

/**
 * Tools whose discovery and invocation belong to the Network Mod's
 * newly-absorbed Companies/Pipelines vertical.
 *
 * Per the locked owner-map, disabling Network removes the Companies and
 * Pipelines pages + routes + company/pipeline tools. Of those, only Companies
 * is served by a dedicated agent tool (`companies`). Pipelines is a
 * page/route-only surface today (the Pipeline cockpit is presentational and has
 * no dedicated agent tool), so its full-vertical enforcement is page + route
 * removal; a future pipeline agent tool joins this set.
 *
 * Deliberately excluded: `people` and `meetings`. Network owns the People and
 * Meetings pages, but the agent needs contacts and calendar cognition
 * regardless of which Mods are installed, so those tools stay core per the
 * owner-map (their removal column is company/pipeline tools only).
 */
export const NETWORK_TOOL_NAMES = new Set(["companies"]);

export function isNetworkOwnedTool(toolName: string): boolean {
  return NETWORK_TOOL_NAMES.has(toolName);
}

/** Remove Network tools from model discovery when Network is inactive. */
export async function filterNetworkToolSchemas(
  principal: Principal,
  tools: ToolSchema[],
): Promise<ToolSchema[]> {
  return (await hasActiveNetworkAccess(principal)) ? tools : tools.filter((tool) => !isNetworkOwnedTool(tool.name));
}

/** Fail closed at invocation even if a stale model schema still names the tool. */
export async function requireNetworkToolAccess(
  principal: Principal,
  toolName: string,
): Promise<void> {
  if (!isNetworkOwnedTool(toolName)) return;
  if (!(await hasActiveNetworkAccess(principal))) {
    throw new Error("network_mod_inactive");
  }
}
