import { createLogger } from "../log";

const logger = createLogger("JsonParse");

export type SafeParseResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; raw: string };

export function normalizeToolArgs(input: Record<string, unknown>, toolName?: string): Record<string, unknown> {
  const coercedKeys: string[] = [];

  for (const key of Object.keys(input)) {
    const val = input[key];
    if (typeof val !== "string") continue;

    const trimmed = val.trim();
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          input[key] = parsed;
          coercedKeys.push(key);
        }
      } catch {
        // Not valid JSON, leave the string as-is
      }
    }
  }

  if (coercedKeys.length > 0) {
    logger.warn(
      `normalizeToolArgs: coerced stringified JSON values for keys [${coercedKeys.join(", ")}]${toolName ? ` in tool '${toolName}'` : ""}`
    );
  }

  return input;
}

export function safeParseJSON<T = unknown>(content: string, context?: string): SafeParseResult<T> {
  if (!content || content.trim().length === 0) {
    return { ok: false, error: "Empty content", raw: content };
  }

  try {
    const data = JSON.parse(content) as T;
    return { ok: true, data };
  } catch {
    // noop
  }

  const candidates: RegExp[] = [/\{[\s\S]*\}/, /\[[\s\S]*\]/];
  for (const re of candidates) {
    const jsonMatch = content.match(re);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[0]) as T;
        logger.log(`JSON extracted via regex fallback${context ? ` (${context})` : ""}`);
        return { ok: true, data };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`JSON regex extraction found candidate but parse failed${context ? ` (${context})` : ""}: ${errMsg}`);
      }
    }
  }

  logger.warn(`No JSON found in LLM response${context ? ` (${context})` : ""}: ${content.slice(0, 200)}`);
  return { ok: false, error: "No JSON found in response", raw: content };
}
