/**
 * Instance-level identity configuration.
 *
 * Separates three concerns that were previously conflated:
 * 1. Category labels (enum values like "agent") — what TYPE of thing this is
 * 2. Per-user names — resolved from agent_profiles by user-scoped code
 * 3. App-level fallback display strings for surfaces without a user principal
 */

export const DEFAULT_AGENT_NAME = "Mantra";

/** App-level fallback name. User-scoped surfaces must read agent_profiles. */
export function getInstanceName(): string {
  return (typeof process !== "undefined" && process.env?.INSTANCE_NAME) || DEFAULT_AGENT_NAME;
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
