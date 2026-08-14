import { Client, Pool, type ClientConfig, type PoolConfig } from "pg";

import {
  DATABASE_WORKLOADS,
  type DatabasePoolWorkload,
  type DatabaseWorkload,
  type DedicatedDatabaseWorkload,
} from "./database-authority";
import { createLogger } from "./log";

const log = createLogger("DatabaseAdapters");

export interface ManagedDatabasePool {
  readonly workload: DatabaseWorkload;
  readonly pool: Pool;
  close(): Promise<void>;
}

const managedPools = new Map<DatabaseWorkload, ManagedDatabasePool>();

// Set the moment any managed pool begins closing (graceful shutdown). Best-effort
// telemetry writes read this and no-op before touching a pool, so a queued serial
// drain cannot fault against an ended pool and self-amplify into a log-rate flood
// that starves boot/shutdown evidence. Fail loudly, degrade gracefully.
let databasePoolsClosing = false;

/** True once graceful shutdown has begun ending managed database pools. */
export function areDatabasePoolsClosing(): boolean {
  return databasePoolsClosing;
}

export function createManagedDatabasePool(
  workload: DatabasePoolWorkload,
  config: PoolConfig,
): ManagedDatabasePool {
  if (DATABASE_WORKLOADS[workload].kind !== "pool") {
    throw new Error(`Database workload is not a pool: ${workload}`);
  }
  if (managedPools.has(workload)) {
    throw new Error(`Database pool workload already registered: ${workload}`);
  }
  const pool = new Pool(config);
  const adapter: ManagedDatabasePool = {
    workload,
    pool,
    async close() {
      databasePoolsClosing = true;
      await pool.end();
    },
  };
  managedPools.set(workload, adapter);
  pool.on("error", (error) => {
    log.error("managed database pool error", {
      workload,
      errorType: error.name,
      code: (error as Error & { code?: string }).code ?? null,
    });
  });
  return adapter;
}

export function createDedicatedDatabaseClient(
  workload: DedicatedDatabaseWorkload,
  config: ClientConfig,
): Client {
  if (DATABASE_WORKLOADS[workload].kind !== "dedicated-client") {
    throw new Error(`Database workload is not a dedicated client: ${workload}`);
  }
  return new Client({ ...config, application_name: config.application_name || `mantra-${workload}` });
}

export async function closeManagedDatabasePools(): Promise<void> {
  databasePoolsClosing = true;
  const entries = [...managedPools.values()];
  managedPools.clear();
  const results = await Promise.allSettled(entries.map((adapter) => adapter.close()));
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "rejected") {
      log.warn("managed database pool close degraded", {
        workload: entries[index]?.workload,
        errorType: result.reason instanceof Error ? result.reason.name : typeof result.reason,
      });
    }
  }
}
