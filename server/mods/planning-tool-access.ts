import type { ToolSchema } from "../tool-registry";
import type { Principal } from "../principal";
import { hasActivePlanningAccess } from "./planning-access";

/**
 * Tools whose discovery and invocation belong to the Planning Mod's
 * full-vertical Scenarios surface.
 *
 * Per the locked owner-map (spec: "Scenarios (renamed from Strategy) →
 * Planning → pages + routes + the renamed scenarios tool"), disabling Planning
 * removes the Scenarios pages + routes + the `scenarios` agent tool (formerly
 * `strategy`). That is the single net-new gated tool: no ghost cognition — the
 * agent must never reason with the scenarios tool once its pages are gone.
 *
 * Deliberately excluded: `goals`, `tasks`, `plan`, and the schedule/projects
 * surfaces. Planning owns the Goals/Schedule/Projects pages, but the agent
 * needs goal, task, and execution cognition regardless of which Mods are
 * installed, so those tools stay core per the owner-map (its removal column is
 * the scenarios tool only). This mirrors Network keeping `people`/`meetings`
 * core while gating only `companies`.
 */
export const PLANNING_TOOL_NAMES = new Set(["scenarios"]);

export function isPlanningOwnedTool(toolName: string): boolean {
  return PLANNING_TOOL_NAMES.has(toolName);
}

/** Remove Planning tools from model discovery when Planning is inactive. */
export async function filterPlanningToolSchemas(
  principal: Principal,
  tools: ToolSchema[],
): Promise<ToolSchema[]> {
  return (await hasActivePlanningAccess(principal)) ? tools : tools.filter((tool) => !isPlanningOwnedTool(tool.name));
}

/** Fail closed at invocation even if a stale model schema still names the tool. */
export async function requirePlanningToolAccess(
  principal: Principal,
  toolName: string,
): Promise<void> {
  if (!isPlanningOwnedTool(toolName)) return;
  if (!(await hasActivePlanningAccess(principal))) {
    throw new Error("planning_mod_inactive");
  }
}
