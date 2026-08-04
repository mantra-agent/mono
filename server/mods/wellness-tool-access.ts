import type { ToolSchema } from "../tool-registry";
import type { Principal } from "../principal";
import { hasActiveWellnessAccess } from "./wellness-access";

/** Wellness-owned agent tools. Discovery and invocation both fail closed when inactive. */
export const WELLNESS_TOOL_NAMES = new Set([
  "health",
]);

export function isWellnessOwnedTool(toolName: string): boolean {
  return WELLNESS_TOOL_NAMES.has(toolName);
}

/** Remove Wellness tools from model discovery when Wellness is inactive. */
export async function filterWellnessToolSchemas(
  principal: Principal,
  tools: ToolSchema[],
): Promise<ToolSchema[]> {
  return (await hasActiveWellnessAccess(principal))
    ? tools
    : tools.filter((tool) => !isWellnessOwnedTool(tool.name));
}

/** Fail closed at invocation even if a stale model schema still names the tool. */
export async function requireWellnessToolAccess(principal: Principal, toolName: string): Promise<void> {
  if (!isWellnessOwnedTool(toolName)) return;
  if (!(await hasActiveWellnessAccess(principal))) {
    throw new Error("wellness_mod_inactive");
  }
}
