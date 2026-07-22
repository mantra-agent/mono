import { systemSettings } from "@shared/schema";
import { eq } from "drizzle-orm";
import { BOOT_ID, db } from "./db";
import { createLogger } from "./log";

const log = createLogger("RuntimeProcessLifecycle");
const RECORD_VERSION = 1;

export type ProcessTerminationKind = "clean" | "unclean";

interface ObservedChildExit {
  bootId: string;
  observedAt: string;
  exitCode: number | null;
  signal: string | null;
  reason: string;
  terminationKind: ProcessTerminationKind;
}

interface ProcessBootState {
  bootId: string;
  wrapperId: string | null;
  pid: number;
  startedAt: string;
  status: "active" | "terminated";
  terminationKind: ProcessTerminationKind | null;
  terminationCause: string | null;
  terminatedAt: string | null;
  exitCode: number | null;
  signal: string | null;
}

interface RuntimeProcessLifecycleRecord {
  version: 1;
  runtimeKey: string;
  deploymentId: string | null;
  replicaId: string | null;
  serviceId: string | null;
  gitCommit: string | null;
  current: ProcessBootState;
  previous: ProcessBootState | null;
  updatedAt: string;
}

export interface RuntimeTerminationInput {
  terminationKind: ProcessTerminationKind;
  cause: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function runtimeCoordinates(): {
  runtimeKey: string;
  deploymentId: string | null;
  replicaId: string | null;
  serviceId: string | null;
  gitCommit: string | null;
} {
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim() || null;
  const replicaId = process.env.RAILWAY_REPLICA_ID?.trim() || process.env.HOSTNAME?.trim() || null;
  const serviceId = process.env.RAILWAY_SERVICE_ID?.trim() || null;
  const gitCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim() || null;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID?.trim() || "local";
  const replicaPart = replicaId || `pid-${process.pid}`;
  return {
    runtimeKey: `${environmentId}:${serviceId || "service"}:${replicaPart}`,
    deploymentId,
    replicaId,
    serviceId,
    gitCommit,
  };
}

function settingKey(runtimeKey: string): string {
  return `system.runtime_process_lifecycle.${runtimeKey}`;
}

function parseObservedExit(): ObservedChildExit | null {
  const raw = process.env.WATCHDOG_PREVIOUS_EXIT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ObservedChildExit>;
    if (!parsed.bootId || typeof parsed.bootId !== "string") return null;
    return {
      bootId: parsed.bootId,
      observedAt: typeof parsed.observedAt === "string" ? parsed.observedAt : new Date().toISOString(),
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
      signal: typeof parsed.signal === "string" ? parsed.signal : null,
      reason: typeof parsed.reason === "string" ? parsed.reason : "observed_child_exit",
      terminationKind: parsed.terminationKind === "clean" ? "clean" : "unclean",
    };
  } catch {
    return null;
  }
}

function settlePriorBoot(prior: ProcessBootState, observed: ObservedChildExit | null, now: string): ProcessBootState {
  if (prior.status === "terminated") return prior;
  if (observed?.bootId === prior.bootId) {
    return {
      ...prior,
      status: "terminated",
      terminationKind: observed.terminationKind,
      terminationCause: observed.reason,
      terminatedAt: observed.observedAt,
      exitCode: observed.exitCode,
      signal: observed.signal,
    };
  }
  return {
    ...prior,
    status: "terminated",
    terminationKind: "unclean",
    terminationCause: "prior_boot_missing_terminal_record",
    terminatedAt: now,
    exitCode: null,
    signal: null,
  };
}

async function readRecord(key: string): Promise<RuntimeProcessLifecycleRecord | null> {
  const [row] = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  return (row?.value as RuntimeProcessLifecycleRecord | undefined) ?? null;
}

async function writeRecord(key: string, value: RuntimeProcessLifecycleRecord): Promise<void> {
  const updated = await db
    .update(systemSettings)
    .set({ value, updatedAt: new Date() })
    .where(eq(systemSettings.key, key));
  if ((updated.rowCount ?? 0) > 0) return;
  try {
    await db.insert(systemSettings).values({ key, value, updatedAt: new Date() });
  } catch (error) {
    const retry = await db
      .update(systemSettings)
      .set({ value, updatedAt: new Date() })
      .where(eq(systemSettings.key, key));
    if ((retry.rowCount ?? 0) === 0) throw error;
  }
}

export async function beginRuntimeProcessLifecycle(): Promise<void> {
  const coordinates = runtimeCoordinates();
  const key = settingKey(coordinates.runtimeKey);
  const now = new Date().toISOString();
  const existing = await readRecord(key);
  const observed = parseObservedExit();
  const prior = existing?.current && existing.current.bootId !== BOOT_ID
    ? settlePriorBoot(existing.current, observed, now)
    : existing?.previous ?? null;
  const current: ProcessBootState = {
    bootId: BOOT_ID,
    wrapperId: process.env.WATCHDOG_WRAPPER_ID?.trim() || null,
    pid: process.pid,
    startedAt: now,
    status: "active",
    terminationKind: null,
    terminationCause: null,
    terminatedAt: null,
    exitCode: null,
    signal: null,
  };
  const record: RuntimeProcessLifecycleRecord = {
    version: RECORD_VERSION,
    ...coordinates,
    current,
    previous: prior,
    updatedAt: now,
  };
  await writeRecord(key, record);
  log.info(`process_lifecycle ${JSON.stringify({
    event: "child_boot_registered",
    runtimeKey: coordinates.runtimeKey,
    bootId: BOOT_ID,
    wrapperId: current.wrapperId,
    pid: current.pid,
    priorBootId: prior?.bootId ?? null,
    priorTerminationKind: prior?.terminationKind ?? null,
    priorTerminationCause: prior?.terminationCause ?? null,
  })}`);
}

export async function markRuntimeProcessTermination(input: RuntimeTerminationInput): Promise<boolean> {
  const coordinates = runtimeCoordinates();
  const key = settingKey(coordinates.runtimeKey);
  const existing = await readRecord(key);
  if (!existing || existing.current.bootId !== BOOT_ID) {
    log.warn(`process_lifecycle ${JSON.stringify({
      event: "child_termination_not_recorded",
      runtimeKey: coordinates.runtimeKey,
      bootId: BOOT_ID,
      reason: "boot_id_mismatch_or_missing_record",
    })}`);
    return false;
  }
  const now = new Date().toISOString();
  const record: RuntimeProcessLifecycleRecord = {
    ...existing,
    current: {
      ...existing.current,
      status: "terminated",
      terminationKind: input.terminationKind,
      terminationCause: input.cause,
      terminatedAt: now,
      exitCode: input.exitCode,
      signal: input.signal,
    },
    updatedAt: now,
  };
  await writeRecord(key, record);
  log.info(`process_lifecycle ${JSON.stringify({
    event: "child_termination_recorded",
    runtimeKey: coordinates.runtimeKey,
    bootId: BOOT_ID,
    terminationKind: input.terminationKind,
    cause: input.cause,
    exitCode: input.exitCode,
    signal: input.signal,
  })}`);
  return true;
}
