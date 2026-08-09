import type { ToolHandler } from "./contracts";
import { TOOLS } from "../tool-registry";

/**
 * Fail boot/build loudly unless the executable dispatch surface exactly
 * matches the public Tool Registry. Private implementation helpers belong
 * behind a domain adapter and are never dispatch-map keys.
 */
export function assertRegisteredToolHandlers(
  handlers: Readonly<Record<string, ToolHandler>>,
): void {
  const registered = Object.keys(TOOLS);
  const missing = registered.filter((name) => typeof handlers[name] !== "function");
  const hidden = Object.keys(handlers).filter((name) => !Object.hasOwn(TOOLS, name));
  if (missing.length > 0 || hidden.length > 0) {
    throw new Error(
      `Tool handler registry mismatch: missing=[${missing.sort().join(", ")}] hidden=[${hidden.sort().join(", ")}]`,
    );
  }
}
