import type { ToolHandler } from "./contracts";
import { TOOLS } from "../tool-registry";

/**
 * Fail boot/build loudly when public registry metadata lacks an executable
 * handler. Extra private handlers are allowed only as implementation details
 * behind a registered umbrella adapter.
 */
export function assertRegisteredToolHandlers(
  handlers: Readonly<Record<string, ToolHandler>>,
): void {
  const missing = Object.keys(TOOLS).filter((name) => typeof handlers[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`Registered tools missing handlers: ${missing.sort().join(", ")}`);
  }
}
