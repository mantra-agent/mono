/**
 * Instance-level identity configuration.
 *
 * Separates three concerns that were previously conflated:
 * 1. Category labels (enum values like "agent") — what TYPE of thing this is
 * 2. Instance name (e.g. "Agent") — the proper noun for THIS instance
 * 3. Display strings — user-facing text derived from the instance name
 *
 * The agent's name is resolved from the People table (cabinetLevel = "agent")
 * at boot time via setInstanceNameCache(). Falls back to INSTANCE_NAME env var,
 * then to "Agent" if neither is available.
 */

/** Module-level cache populated at boot by the server. */
let _instanceNameCache: string | null = null;

/**
 * Set the cached instance name. Called once at server boot after querying
 * the People table for the person with cabinetLevel = "agent".
 */
export function setInstanceNameCache(name: string): void {
  _instanceNameCache = name;
}

/** The proper name of this agent instance. */
export function getInstanceName(): string {
  if (_instanceNameCache) return _instanceNameCache;
  return (typeof process !== "undefined" && process.env?.INSTANCE_NAME) || "Agent";
}

/** Check if a session/owner/timer type represents the agent. */
export function isAgentType(type: string | null | undefined): boolean {
  return type === "agent";
}

/** The canonical enum value for agent type. Use this for writes. */
export const AGENT_TYPE = "agent" as const;

/** Lowercase instance name for case-insensitive comparisons. */
export function getInstanceNameLower(): string {
  return getInstanceName().toLowerCase();
}

/**
 * App name prefix for database connection tagging.
 * Derived from instance name to support multi-instance deployments.
 */
export function getAppNamePrefix(): string {
  return `${getInstanceNameLower()}-app`;
}

/**
 * Brain export format version.
 * Includes instance name for provenance tracking.
 */
export function getBrainFormatVersion(): string {
  return `${getInstanceNameLower()}-v3`;
}
