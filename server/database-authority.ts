import type { PoolConfig } from "pg";

export type DatabasePoolClass = "app" | "system" | "migrator";

export interface DatabasePoolDefinition {
  poolClass: DatabasePoolClass;
  connectionStringEnv: "DATABASE_URL" | "SYSTEM_DATABASE_URL" | "MIGRATOR_DATABASE_URL";
  bypassRls: boolean;
  allowedCallers: readonly string[];
}

/**
 * Checked-in authority map. It is deliberately inert: callers still construct pools,
 * and MIGRATOR_DATABASE_URL is never consumed by the application runtime.
 */
export const DATABASE_POOL_DEFINITIONS: Record<DatabasePoolClass, DatabasePoolDefinition> = {
  app: {
    poolClass: "app",
    connectionStringEnv: "DATABASE_URL",
    bypassRls: false,
    allowedCallers: ["server/db.ts"],
  },
  system: {
    poolClass: "system",
    connectionStringEnv: "SYSTEM_DATABASE_URL",
    bypassRls: false,
    allowedCallers: [
      "server/auth.ts (session store)",
      "server/metrics-db.ts (metrics isolation)",
      "server/meeting/locks.ts (advisory locks)",
      "server/email-sync-timer.ts (LISTEN/NOTIFY)",
    ],
  },
  migrator: {
    poolClass: "migrator",
    connectionStringEnv: "MIGRATOR_DATABASE_URL",
    bypassRls: true,
    allowedCallers: ["offline migration runner only"],
  },
};

export function appPoolConfig(connectionString: string): Pick<PoolConfig, "connectionString"> {
  if (!connectionString) throw new Error("DATABASE_URL is required for the app pool");
  return { connectionString };
}

export function assertRawDatabaseCallerAllowed(
  poolClass: Exclude<DatabasePoolClass, "migrator">,
  caller: string,
): void {
  if (!DATABASE_POOL_DEFINITIONS[poolClass].allowedCallers.includes(caller)) {
    throw new Error(`Raw database caller is not allowlisted for ${poolClass} pool: ${caller}`);
  }
}
