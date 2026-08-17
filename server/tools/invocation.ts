import type { ToolSchema } from "../tool-registry";

const DEFAULT_TOOL_REASONING = "No model reasoning provided.";

type ToolInvocationPreparation =
  | { outcome: "ready"; args: Record<string, any>; droppedEmptyKeys: string[] }
  | { outcome: "invalid"; error: string };

function isEmptyOptionalValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const values = Object.values(value as Record<string, unknown>);
    return values.length === 0 || values.every(isEmptyOptionalValue);
  }
  return false;
}

function preservesExplicitEmptyString(
  toolName: string,
  args: Record<string, any>,
  key: string,
  value: unknown,
): boolean {
  if (value !== "" || key !== "new_string") return false;
  const action = String(args.action || "");
  return (toolName === "scratch" && action === "edit")
    || (toolName === "skills" && action === "edit")
    || (toolName === "library" && ["edit", "edit_library_page"].includes(action));
}

/**
 * Canonical model-argument boundary for every registered tool invocation.
 * Optional empty values mean omission; destructive clears require a domain-owned
 * explicit clear contract. Validation and normalization share the exact schema.
 */
export function prepareToolInvocation(
  toolName: string,
  rawArgs: Record<string, any>,
  schema: ToolSchema,
): ToolInvocationPreparation {
  const required = new Set(schema.parameters?.required ?? []);
  const args: Record<string, any> = {};
  const droppedEmptyKeys: string[] = [];

  for (const [key, value] of Object.entries(rawArgs ?? {})) {
    // Retired question flag: Other is structural. Ignore on write so callers that
    // still pass allowOther cannot reintroduce a closed option set or trip unknown-key.
    if (toolName === "question" && key === "allowOther") {
      droppedEmptyKeys.push(key);
      continue;
    }
    if (required.has(key) || preservesExplicitEmptyString(toolName, rawArgs, key, value)) {
      args[key] = value;
    } else if (isEmptyOptionalValue(value)) {
      droppedEmptyKeys.push(key);
    } else {
      args[key] = value;
    }
  }

  if (required.has("reasoning")) {
    const reasoning = args.reasoning;
    if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
      args.reasoning = DEFAULT_TOOL_REASONING;
    }
  }

  const missing = [...required].filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length > 0) {
    return { outcome: "invalid", error: `Missing required parameter(s): ${missing.join(", ")}` };
  }

  const properties = schema.parameters?.properties;
  if (properties) {
    const knownKeys = new Set(Object.keys(properties));
    const unknownKeys = Object.keys(args).filter((key) => !knownKeys.has(key));
    if (unknownKeys.length > 0) {
      return {
        outcome: "invalid",
        error: `Unknown parameter(s) for ${toolName}: ${unknownKeys.join(", ")}. Allowed: ${[...knownKeys].join(", ")}`,
      };
    }
  }

  return { outcome: "ready", args, droppedEmptyKeys };
}
