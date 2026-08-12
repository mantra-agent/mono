import type { ToolSchema } from "../tool-registry";
import type { Principal } from "../principal";
import { hasActiveBusinessAccess } from "./business-access";

/**
 * Tools whose discovery and invocation belong to the Business Mod.
 *
 * Post-cutover Business scope is Business Model, Advantage, Roles, KPIs, and
 * Metrics. Of these, only Roles is served by a dedicated agent tool (`jobs` —
 * job-role definitions for hiring plans and headcount cost). Business Model,
 * Advantage, KPIs, and Metrics are page/route-only surfaces today with no
 * dedicated agent tool, so full-vertical enforcement for them is page+route
 * removal; when a KPI/metrics/model agent tool is later added it joins this set.
 *
 * Deliberately excluded (they are NOT Business): `decisions` (core),
 * `strategy`/scenarios (Planning), `companies` and pipelines (Network).
 */
export const BUSINESS_TOOL_NAMES = new Set(["jobs", "business"]);

export function isBusinessOwnedTool(toolName: string): boolean {
  return BUSINESS_TOOL_NAMES.has(toolName);
}

/** Remove Business tools from model discovery when Business is inactive. */
export async function filterBusinessToolSchemas(
  principal: Principal,
  tools: ToolSchema[],
): Promise<ToolSchema[]> {
  return (await hasActiveBusinessAccess(principal)) ? tools : tools.filter((tool) => !isBusinessOwnedTool(tool.name));
}

/** Fail closed at invocation even if a stale model schema still names the tool. */
export async function requireBusinessToolAccess(
  principal: Principal,
  toolName: string,
): Promise<void> {
  if (!isBusinessOwnedTool(toolName)) return;
  if (!(await hasActiveBusinessAccess(principal))) {
    throw new Error("business_mod_inactive");
  }
}
