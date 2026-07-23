/**
 * Client-side instance identity configuration.
 *
 * Reads VITE_INSTANCE_NAME from build-time env, falling back to the product name.
 * For the server-side equivalent, see @shared/instance-config.ts.
 */

export function getInstanceName(): string {
  return import.meta.env.VITE_INSTANCE_NAME || "Mantra";
}

/** Check if a session/owner/timer type represents the agent. */
export function isAgentType(type: string | null | undefined): boolean {
  return type === "agent";
}

/** The canonical enum value for agent type. Use this for writes. */
export const AGENT_TYPE = "agent" as const;
