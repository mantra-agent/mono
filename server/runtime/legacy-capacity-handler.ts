import type { RuntimeResourcePool } from "@shared/models/runtime";
import type { Principal } from "../principal";
import { runtimeHandlerRegistry, type RuntimeHandler } from "./runtime-handler";

/**
 * Compatibility marker for the admission façade.
 *
 * Legacy capacity leases are created and released by `runtime-storage` /
 * `run-admission` without dispatcher execution. Terminalization still requires
 * the registered handler identity so `require(legacy.capacity@1)` can parse the
 * stored input and complete the receipt. This handler must never be claimed or
 * executed by the dispatcher path.
 */
export const LEGACY_CAPACITY_HANDLER_KEY = "legacy.capacity";
const HANDLER_VERSION = 1;
const INPUT_SCHEMA_VERSION = 1;

const RESOURCE_POOLS = new Set<RuntimeResourcePool>([
  "realtime_agent",
  "interactive_agent",
  "background_agent",
  "short_worker",
  "isolated_execution",
]);

export interface LegacyCapacityInput {
  compatibility: true;
  externalRunId: string;
  admissionRequestId: string;
  sourceType: string;
  activity: string | null;
  resourcePool: RuntimeResourcePool;
  idempotencyKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Legacy capacity input.${field} must be a non-empty string`);
  }
  return value;
}

export function parseLegacyCapacityInput(value: unknown): LegacyCapacityInput {
  if (!isRecord(value)) {
    throw new Error("Legacy capacity input must be an object");
  }
  if (value.compatibility !== true) {
    throw new Error("Legacy capacity input.compatibility must be true");
  }
  const resourcePool = value.resourcePool;
  if (typeof resourcePool !== "string" || !RESOURCE_POOLS.has(resourcePool as RuntimeResourcePool)) {
    throw new Error("Legacy capacity input.resourcePool is invalid");
  }
  const activity = value.activity;
  if (activity !== null && typeof activity !== "string") {
    throw new Error("Legacy capacity input.activity must be a string or null");
  }
  return {
    compatibility: true,
    externalRunId: requireString(value.externalRunId, "externalRunId"),
    admissionRequestId: requireString(value.admissionRequestId, "admissionRequestId"),
    sourceType: requireString(value.sourceType, "sourceType"),
    activity: activity === null ? null : activity.slice(0, 120),
    resourcePool: resourcePool as RuntimeResourcePool,
    idempotencyKey: requireString(value.idempotencyKey, "idempotencyKey"),
  };
}

async function authorizeLegacyCapacity(
  principal: Principal,
  _input: LegacyCapacityInput,
): Promise<{ allowed: boolean; reasonCode: string }> {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    return { allowed: false, reasonCode: "legacy_capacity_user_principal_required" };
  }
  return { allowed: true, reasonCode: "legacy_capacity_authorized" };
}

/**
 * Defense in depth: the dispatcher never claims legacy.capacity runs, and the
 * façade never calls execute. If something does, fail closed instead of
 * pretending this is a real worker.
 */
async function executeLegacyCapacity(): Promise<never> {
  throw Object.assign(new Error("legacy.capacity is a capacity-ledger handler and is not executable"), {
    code: "legacy_capacity_not_executable",
    status: 409,
  });
}

const legacyCapacityHandler: RuntimeHandler<LegacyCapacityInput> = {
  key: LEGACY_CAPACITY_HANDLER_KEY,
  version: HANDLER_VERSION,
  inputSchemaVersion: INPUT_SCHEMA_VERSION,
  inputSchema: { parse: parseLegacyCapacityInput },
  // Identity fields are not consulted by the façade release path. The registry
  // requires one resourcePool/executorProfile pair per key@version; acquire
  // still stamps the real pool/profile onto each runtime_runs row.
  resourcePool: "interactive_agent",
  executorProfile: "in_process_trusted",
  requiredCapabilities: ["runtime:legacy-capacity"],
  authorize: authorizeLegacyCapacity,
  execute: executeLegacyCapacity,
};

let registered = false;

export function registerLegacyCapacityHandler(): void {
  if (registered) return;
  if (runtimeHandlerRegistry.get(LEGACY_CAPACITY_HANDLER_KEY, HANDLER_VERSION)) {
    registered = true;
    return;
  }
  runtimeHandlerRegistry.register(legacyCapacityHandler);
  registered = true;
}
