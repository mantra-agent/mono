import type { ToolSchema } from "../tool-registry";
import type { Principal } from "../principal";
import { hasActiveBuildAccess } from "./build-access";

export const BUILD_TOOL_NAMES = new Set([
  "code",
  "git",
  "platforms",
  "railway",
  "sentry",
  "expo",
  "npm_dependencies",
  "regression",
  "issues",
]);

export function isBuildOwnedTool(toolName: string): boolean {
  return BUILD_TOOL_NAMES.has(toolName);
}

/** Remove Build tools from model discovery when Build is inactive. */
export async function filterBuildToolSchemas(
  principal: Principal,
  tools: ToolSchema[],
): Promise<ToolSchema[]> {
  return (await hasActiveBuildAccess(principal))
    ? tools
    : tools.filter((tool) => !isBuildOwnedTool(tool.name));
}

/** Fail closed at invocation even if a stale model schema still names the tool. */
export async function requireBuildToolAccess(principal: Principal, toolName: string): Promise<void> {
  if (!isBuildOwnedTool(toolName)) return;
  if (!(await hasActiveBuildAccess(principal))) {
    throw new Error("build_mod_inactive");
  }
}
