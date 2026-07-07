// DB sync routes — publish the local DB to a Railway destination.
//
// Phase 1 mental model: source is still THIS instance's local DB (the `pool` /
// process.env.DATABASE_URL). Destination can be a legacy dev/prod target or a
// Platform Environment hosting binding. The pipeline (export → maintenance →
// upload → restart) is identical; endpoint resolution is the only variable.
//
// Destructive destinations require a typed phrase and every destination must
// pass the fail-closed DB fingerprint guard before /start can proceed.

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { eq, type SQL } from "drizzle-orm";
import { randomUUID } from "crypto";
import { stat, unlink } from "fs/promises";
import { createReadStream } from "fs";
import { requireAuth, requireAdmin } from "../auth";
import { db } from "../db";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import { createLogger } from "../log";
import { createDbSyncImportAuthHeader } from "../lib/db-sync-import-auth";
import { getSetting, setSetting, deleteSetting } from "../system-settings";
import {
  fetchServiceVariables,
  getDevConfig,
  getProdConfig,
  getRailwayTokenForConnection,
} from "../integrations/railway/client";
import {
  PROD_DESTINATION_CONFIRMATION,
  fingerprintDbUrl,
  redactDbUrl,
  resolveDbUrl,
  sameDbFingerprint,
  type DbFingerprint,
} from "../lib/db-sync-safety";
import {
  exportBrain,
  INSERT_ORDER,
  type ExportMode,
} from "./brain";
import {
  environmentHostingBindings,
  platformProductEnvironments,
  platformProducts,
  platforms,
  providerConnections,
} from "@shared/models/platforms";

const log = createLogger("DbSyncRoutes");

const SYNC_STATE_KEY = "system.db_sync_state";
const SYNC_CANCEL_KEY = "system.db_sync_cancel";

function computeExportStaleTimeoutMs(): number {
  const raw = Number(process.env.DB_SYNC_STALE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 60_000;
  return Math.max(10_000, raw);
}
const EXPORT_STALE_TIMEOUT_MS = computeExportStaleTimeoutMs();
const PROGRESS_SAVE_THROTTLE_MS = 1_000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const REAPER_PHASE_GRACE_MS = 60_000;
const RESTART_WAIT_MS = 90 * 1000;
const MAINTENANCE_TTL_MS = 20 * 60 * 1000;

const platformScopeColumns = { scope: platforms.scope, ownerUserId: platforms.ownerUserId, accountId: platforms.accountId };

function visiblePlatform(predicate?: SQL): SQL {
  return combineWithVisibleScope(getCurrentPrincipalOrSystem(), platformScopeColumns, predicate);
}

export type DbSyncDestination = "dev" | "prod" | `env:${number}`;

type LegacyDbSyncDestination = "dev" | "prod";

interface DbSyncDestinationRef {
  legacy?: LegacyDbSyncDestination;
  platformEnvironmentId?: number;
}

interface ResolvedDbSyncDestination {
  key: DbSyncDestination;
  label: string;
  environmentKind: "development" | "staging" | "production" | "custom";
  url?: string;
  cfg: {
    projectId?: string;
    environmentId?: string;
    serviceId?: string;
    token?: string;
  };
  complete: boolean;
  blockers: string[];
}

type DbSyncStatus =
  | "idle"
  | "exporting"
  | "uploading"
  | "restarting"
  | "complete"
  | "failed"
  | "cancelled";

interface DbSyncState {
  status: DbSyncStatus;
  mode: ExportMode | null;
  destination: DbSyncDestination | null;
  syncId: string | null;
  startedAt: string | null;
  lastProgressAt: string | null;
  currentTable: string | null;
  currentTableIndex: number;
  totalTables: number;
  tablesCompleted: number;
  rowsExported: number;
  totalRowsExpected: number;
  elapsedMs: number;
  error: string | null;
  completedAt: string | null;
}

const IDLE_STATE: DbSyncState = {
  status: "idle",
  mode: null,
  destination: null,
  syncId: null,
  startedAt: null,
  lastProgressAt: null,
  currentTable: null,
  currentTableIndex: 0,
  totalTables: 0,
  tablesCompleted: 0,
  rowsExported: 0,
  totalRowsExpected: 0,
  elapsedMs: 0,
  error: null,
  completedAt: null,
};

async function loadState(): Promise<DbSyncState> {
  const raw = await getSetting<DbSyncState>(SYNC_STATE_KEY);
  if (!raw) return { ...IDLE_STATE };
  return { ...IDLE_STATE, ...raw };
}

type DbSyncStateInput =
  | DbSyncState
  | (Omit<DbSyncState, "lastProgressAt"> & { lastProgressAt?: string | null });

async function saveState(state: DbSyncStateInput): Promise<void> {
  const isActive =
    state.status === "exporting" ||
    state.status === "uploading" ||
    state.status === "restarting";
  const stamped: DbSyncState = {
    ...state,
    lastProgressAt: isActive
      ? new Date().toISOString()
      : (state.lastProgressAt ?? null),
  };
  await setSetting(SYNC_STATE_KEY, stamped);
}

function isActiveStatus(status: DbSyncStatus): boolean {
  return status === "exporting" || status === "uploading" || status === "restarting";
}

async function isCancelled(syncId: string): Promise<boolean> {
  const cancel = await getSetting<{ syncId: string }>(SYNC_CANCEL_KEY);
  return !!cancel && cancel.syncId === syncId;
}

function staleTimeoutForPhase(status: DbSyncStatus): number | null {
  switch (status) {
    case "exporting":
      return EXPORT_STALE_TIMEOUT_MS;
    case "uploading":
      return UPLOAD_TIMEOUT_MS + REAPER_PHASE_GRACE_MS;
    case "restarting":
      return RESTART_WAIT_MS + REAPER_PHASE_GRACE_MS;
    default:
      return null;
  }
}

function environmentKindFromName(name: string): ResolvedDbSyncDestination["environmentKind"] {
  const lower = name.trim().toLowerCase();
  if (["prod", "production", "live"].includes(lower)) return "production";
  if (["dev", "development"].includes(lower)) return "development";
  if (["stage", "staging", "preview"].includes(lower)) return "staging";
  return "custom";
}

function destinationKeyForEnvironment(environmentId: number): DbSyncDestination {
  return `env:${environmentId}`;
}

function parseDestinationRef(input: unknown): DbSyncDestinationRef | { error: string } {
  if (input === "dev" || input === "prod") return { legacy: input };
  if (typeof input === "string" && input.startsWith("env:")) {
    const id = Number.parseInt(input.slice(4), 10);
    if (Number.isFinite(id) && id > 0) return { platformEnvironmentId: id };
  }
  return { error: "destination must be 'dev', 'prod', or env:<environmentId>" };
}

function coerceDestinationKey(destination: string | undefined, destinationEnvironmentId: unknown): DbSyncDestinationRef | { error: string } {
  if (typeof destinationEnvironmentId !== "undefined" && destinationEnvironmentId !== null && destinationEnvironmentId !== "") {
    const id = typeof destinationEnvironmentId === "number"
      ? destinationEnvironmentId
      : Number.parseInt(String(destinationEnvironmentId), 10);
    if (!Number.isFinite(id) || id <= 0) return { error: "destinationEnvironmentId must be a positive integer" };
    return { platformEnvironmentId: id };
  }
  return parseDestinationRef(destination);
}

function isProductionDestination(dest: Pick<ResolvedDbSyncDestination, "environmentKind" | "key">): boolean {
  return dest.environmentKind === "production" || dest.key === "prod";
}

async function reapStaleSync(state: DbSyncState): Promise<DbSyncState> {
  const timeoutMs = staleTimeoutForPhase(state.status);
  if (timeoutMs === null) return state;
  const progressIso = state.lastProgressAt ?? state.startedAt;
  if (!progressIso) return state;
  const progressMs = Date.parse(progressIso);
  if (!Number.isFinite(progressMs)) return state;
  if (Date.now() - progressMs < timeoutMs) return state;
  const startedMs = state.startedAt ? Date.parse(state.startedAt) : progressMs;
  const reaped: DbSyncState = {
    ...state,
    status: "failed",
    error:
      state.error ??
      `Sync timed out in ${state.status} phase (no progress for ${Math.round(timeoutMs / 1000)}s)`,
    completedAt: new Date().toISOString(),
    elapsedMs: Number.isFinite(startedMs) ? Date.now() - startedMs : state.elapsedMs,
  };
  await saveState(reaped);
  log.warn(`Reaped stale sync ${state.syncId} (status was ${state.status}, last progress ${progressIso})`);
  return reaped;
}

// Quick GET against the target instance's /api/health to confirm it's
// reachable before starting an expensive export.
async function checkTargetReachable(targetUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const url = targetUrl.replace(/\/+$/, "") + "/api/health";
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return { ok: false, error: `Target health check returned ${res.status}` };
    return { ok: true };
  } catch (err: any) {
    if (err?.name === "AbortError") return { ok: false, error: "Target health check timed out (5s)" };
    return { ok: false, error: `Target unreachable: ${err?.message ?? String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTargetHttpDbIdentity(
  targetUrl: string,
  importAuthSecret: string,
  syncId: string,
): Promise<{ ok: true; fingerprint: DbFingerprint; redacted: string } | { ok: false; error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const url = targetUrl.replace(/\/+$/, "") + "/api/brain/db-identity";
    const res = await fetch(url, {
      headers: {
        "X-Db-Sync-Import-Auth": createDbSyncImportAuthHeader(importAuthSecret, syncId),
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Target DB identity failed (${res.status}): ${text.slice(0, 300)}` };
    }
    const data = (await res.json()) as { fingerprint?: DbFingerprint; redactedUrl?: string };
    if (!data.fingerprint?.host || !data.fingerprint?.port || !data.fingerprint?.database || !data.fingerprint?.user) {
      return { ok: false, error: "Target DB identity response was malformed" };
    }
    return { ok: true, fingerprint: data.fingerprint, redacted: data.redactedUrl ?? "unknown" };
  } catch (err: any) {
    if (err?.name === "AbortError") return { ok: false, error: "Target DB identity timed out (5s)" };
    return { ok: false, error: `Target DB identity unreachable: ${err?.message ?? String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

function assertTargetHttpMatchesDestination(
  dest: ResolvedDbSyncDestination,
  expected: DbFingerprint,
  actual: { fingerprint: DbFingerprint; redacted: string },
): { ok: true } | { ok: false; error: string } {
  if (sameDbFingerprint(expected, actual.fingerprint)) return { ok: true };
  return {
    ok: false,
    error:
      `Refusing to publish: ${dest.label} HTTP URL (${dest.url}) is connected to ${actual.redacted}, ` +
      `which does not match the Railway destination DB selected for that environment. ` +
      `Fix the Platform hosting binding public URL before retrying.`,
  };
}

async function enterTargetMaintenance(
  targetUrl: string,
  syncId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const url = targetUrl.replace(/\/+$/, "") + "/api/maintenance/enter";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: `db-sync ${syncId}`,
        ttlMs: MAINTENANCE_TTL_MS,
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Enter maintenance failed (${res.status}): ${text.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Enter maintenance error: ${err?.message ?? String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function exitTargetMaintenance(targetUrl: string): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const url = targetUrl.replace(/\/+$/, "") + "/api/maintenance/exit";
    const res = await fetch(url, { method: "POST", signal: ac.signal });
    if (!res.ok) {
      log.warn(`exitTargetMaintenance: target returned ${res.status}`);
    }
  } catch (err: any) {
    log.warn(`exitTargetMaintenance failed: ${err?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function triggerTargetRestart(
  targetUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const url = targetUrl.replace(/\/+$/, "") + "/api/maintenance/exit-and-restart";
    const res = await fetch(url, { method: "POST", signal: ac.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Trigger restart failed (${res.status}): ${text.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: `Trigger restart error: ${err?.message ?? String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForTargetReady(targetUrl: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = targetUrl.replace(/\/+$/, "") + "/api/health";
  const deadline = Date.now() + RESTART_WAIT_MS;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let sawDown = false;
  while (Date.now() < deadline) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (res.ok) {
        if (sawDown) return { ok: true };
      } else {
        sawDown = true;
      }
    } catch {
      sawDown = true;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { ok: false, error: `Target did not come back within ${RESTART_WAIT_MS / 1000}s` };
}

async function uploadArchiveToTarget(
  archivePath: string,
  targetUrl: string,
  syncId: string,
  importAuthSecret: string,
): Promise<{ ok: true } | { ok: false; error: string; cancelled?: boolean }> {
  const stats = await stat(archivePath);
  const filename = archivePath.split("/").pop() ?? "brain.tar.gz";

  const importUrl = targetUrl.replace(/\/+$/, "") + "/api/brain/import";
  log.log(`Uploading ${stats.size} bytes to ${importUrl} (streaming)`);

  const boundary = `----xyz-brain-${randomUUID()}`;
  const preamble = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="brain"; filename="${filename}"\r\n` +
      `Content-Type: application/gzip\r\n\r\n`,
  );
  const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);

  const fileStream = createReadStream(archivePath, { highWaterMark: 64 * 1024 });
  const bodyStream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(preamble);
        fileStream.on("data", (chunk: Buffer | string) => {
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          controller.enqueue(new Uint8Array(buf));
          if ((controller.desiredSize ?? 1) <= 0) {
            fileStream.pause();
          }
        });
        fileStream.on("end", () => {
          controller.enqueue(epilogue);
          controller.close();
        });
        fileStream.on("error", (err) => controller.error(err));
      },
      pull() {
        if (fileStream.isPaused()) fileStream.resume();
      },
      cancel() {
        fileStream.destroy();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
  );

  const ac = new AbortController();
  let abortReason: "timeout" | "cancelled" | null = null;
  const timeoutTimer = setTimeout(() => {
    abortReason = "timeout";
    ac.abort();
  }, UPLOAD_TIMEOUT_MS);

  const cancelTimer = setInterval(async () => {
    try {
      if (await isCancelled(syncId)) {
        abortReason = "cancelled";
        ac.abort();
      }
    } catch {
      /* swallow */
    }
  }, 1000);

  try {
    const res = await fetch(importUrl, {
      method: "POST",
      body: bodyStream,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(preamble.length + stats.size + epilogue.length),
        "X-Db-Sync-Import-Auth": createDbSyncImportAuthHeader(importAuthSecret, syncId),
      },
      signal: ac.signal,
      // @ts-expect-error — undici streaming bodies need duplex: "half"
      duplex: "half",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Target import failed (${res.status}): ${text.slice(0, 500)}` };
    }
    return { ok: true };
  } catch (err: any) {
    if (abortReason === "cancelled") {
      return { ok: false, error: "Upload cancelled by user", cancelled: true };
    }
    if (abortReason === "timeout" || err?.name === "AbortError") {
      return { ok: false, error: `Upload timed out after ${UPLOAD_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timeoutTimer);
    clearInterval(cancelTimer);
    fileStream.destroy();
  }
}

async function runSync(
  syncId: string,
  mode: ExportMode,
  targetUrl: string,
  destination: DbSyncDestination,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let rowsExported = 0;
  let tablesCompleted = 0;
  let lastTable: string | null = INSERT_ORDER[0]?.key ?? null;
  let lastIndex = 0;
  let archivePath: string | null = null;
  let lastProgressSaveAt = 0;
  let totalRowsExpected = 0;

  const baseState = (overrides: Partial<DbSyncState>): DbSyncState => ({
    ...IDLE_STATE,
    status: "exporting",
    mode,
    destination,
    syncId,
    startedAt,
    currentTable: lastTable,
    currentTableIndex: 0,
    totalTables: INSERT_ORDER.length,
    tablesCompleted: 0,
    rowsExported: 0,
    totalRowsExpected: 0,
    elapsedMs: Date.now() - startedMs,
    error: null,
    completedAt: null,
    ...overrides,
  });

  await saveState(baseState({ elapsedMs: 0 }));

  try {
    const exportResult = await exportBrain({
      mode,
      onPreflight: async (n) => {
        totalRowsExpected = n;
        await saveState(baseState({ totalRowsExpected }));
      },
      onTableStart: async (table, index, total) => {
        lastTable = table;
        lastIndex = index;
        await saveState(baseState({
          currentTable: table,
          currentTableIndex: index,
          totalTables: total,
          tablesCompleted,
          rowsExported,
          totalRowsExpected,
        }));
      },
      onTableDone: async (table, index, total, rows) => {
        rowsExported += rows;
        tablesCompleted = index + 1;
        lastProgressSaveAt = Date.now();
        await saveState(baseState({
          currentTable: table,
          currentTableIndex: index,
          totalTables: total,
          tablesCompleted,
          rowsExported,
          totalRowsExpected,
        }));
      },
      onProgress: async (_rowsInTable, totalRowsSoFar, currentTable) => {
        const now = Date.now();
        if (now - lastProgressSaveAt < PROGRESS_SAVE_THROTTLE_MS) return;
        lastProgressSaveAt = now;
        lastTable = currentTable;
        await saveState(baseState({
          currentTable,
          currentTableIndex: lastIndex,
          tablesCompleted,
          rowsExported: totalRowsSoFar,
          totalRowsExpected,
        }));
      },
      shouldCancel: () => isCancelled(syncId),
    });

    if (exportResult.cancelled) {
      await saveState(baseState({
        status: "cancelled",
        currentTableIndex: lastIndex,
        totalTables: exportResult.totalTables,
        tablesCompleted,
        rowsExported: exportResult.totalRows,
        totalRowsExpected,
        completedAt: new Date().toISOString(),
      }));
      await deleteSetting(SYNC_CANCEL_KEY).catch(() => {});
      log.log(`Sync ${syncId} cancelled after ${tablesCompleted}/${exportResult.totalTables} tables`);
      return;
    }

    if (exportResult.failedTables.length > 0) {
      const failedList = exportResult.failedTables.join(", ");
      await saveState(baseState({
        status: "failed",
        currentTableIndex: lastIndex,
        totalTables: exportResult.totalTables,
        tablesCompleted,
        rowsExported: exportResult.totalRows,
        totalRowsExpected,
        error: `Export failed for ${exportResult.failedTables.length} table(s): ${failedList}. Target DB was not modified.`,
        completedAt: new Date().toISOString(),
      }));
      log.error(`Sync ${syncId} aborted: failed tables ${failedList}`);
      return;
    }

    await saveState(baseState({
      status: "uploading",
      currentTable: null,
      currentTableIndex: exportResult.totalTables,
      totalTables: exportResult.totalTables,
      tablesCompleted: exportResult.totalTables,
      rowsExported: exportResult.totalRows,
      totalRowsExpected,
    }));

    archivePath = exportResult.archivePath;

    const destinationRef = parseDestinationRef(destination);
    if ("error" in destinationRef) {
      await saveState(baseState({
        status: "failed",
        currentTable: null,
        currentTableIndex: exportResult.totalTables,
        totalTables: exportResult.totalTables,
        tablesCompleted: exportResult.totalTables,
        rowsExported: exportResult.totalRows,
        totalRowsExpected,
        error: destinationRef.error,
        completedAt: new Date().toISOString(),
      }));
      return;
    }
    const resolvedDestination = await getDestinationConfig(destinationRef);
    const importAuth = await resolveTargetImportAuthSecret(resolvedDestination);
    if (!importAuth.ok) {
      await saveState(baseState({
        status: "failed",
        currentTable: null,
        currentTableIndex: exportResult.totalTables,
        totalTables: exportResult.totalTables,
        tablesCompleted: exportResult.totalTables,
        rowsExported: exportResult.totalRows,
        totalRowsExpected,
        error: `Target import auth unavailable: ${importAuth.error}`,
        completedAt: new Date().toISOString(),
      }));
      log.error(`Sync ${syncId} aborted before maintenance: ${importAuth.error}`);
      return;
    }

    const enterRes = await enterTargetMaintenance(targetUrl, syncId);
    if (!enterRes.ok) {
      await saveState(baseState({
        status: "failed",
        currentTable: null,
        currentTableIndex: exportResult.totalTables,
        totalTables: exportResult.totalTables,
        tablesCompleted: exportResult.totalTables,
        rowsExported: exportResult.totalRows,
        totalRowsExpected,
        error: `Failed to enter target maintenance: ${enterRes.error}`,
        completedAt: new Date().toISOString(),
      }));
      log.error(`Sync ${syncId} aborted before upload: ${enterRes.error}`);
      return;
    }
    log.log(`Sync ${syncId}: ${destination} target in maintenance, starting upload`);

    const uploaded = await uploadArchiveToTarget(exportResult.archivePath, targetUrl, syncId, importAuth.secret);
    if (!uploaded.ok) {
      await exitTargetMaintenance(targetUrl);
      const cancelled = "cancelled" in uploaded && uploaded.cancelled === true;
      await saveState(baseState({
        status: cancelled ? "cancelled" : "failed",
        currentTable: null,
        currentTableIndex: exportResult.totalTables,
        totalTables: exportResult.totalTables,
        tablesCompleted: exportResult.totalTables,
        rowsExported: exportResult.totalRows,
        totalRowsExpected,
        error: cancelled
          ? "Upload cancelled — target DB may be in a partial-import state. Re-run sync to recover."
          : uploaded.error,
        completedAt: new Date().toISOString(),
      }));
      if (cancelled) {
        await deleteSetting(SYNC_CANCEL_KEY).catch(() => {});
        log.log(`Sync ${syncId} cancelled during upload`);
      } else {
        log.error(`Sync ${syncId} failed during upload: ${uploaded.error}`);
      }
      return;
    }

    await saveState(baseState({
      status: "restarting",
      currentTable: null,
      currentTableIndex: exportResult.totalTables,
      totalTables: exportResult.totalTables,
      tablesCompleted: exportResult.totalTables,
      rowsExported: exportResult.totalRows,
      totalRowsExpected,
    }));

    const restartRes = await triggerTargetRestart(targetUrl);
    if (!restartRes.ok) {
      await exitTargetMaintenance(targetUrl);
      await saveState(baseState({
        status: "failed",
        currentTable: null,
        currentTableIndex: exportResult.totalTables,
        totalTables: exportResult.totalTables,
        tablesCompleted: exportResult.totalTables,
        rowsExported: exportResult.totalRows,
        totalRowsExpected,
        error: `Import succeeded but target restart failed: ${restartRes.error}. Restart target manually to clear caches.`,
        completedAt: new Date().toISOString(),
      }));
      log.error(`Sync ${syncId}: import OK but restart failed: ${restartRes.error}`);
      return;
    }

    const ready = await waitForTargetReady(targetUrl);
    await saveState(baseState({
      status: "complete",
      currentTable: null,
      currentTableIndex: exportResult.totalTables,
      totalTables: exportResult.totalTables,
      tablesCompleted: exportResult.totalTables,
      rowsExported: exportResult.totalRows,
      totalRowsExpected,
      error: ready.ok
        ? null
        : `Target did not respond after restart within ${RESTART_WAIT_MS / 1000}s — check it manually.`,
      completedAt: new Date().toISOString(),
    }));
    if (ready.ok) {
      log.log(`Sync ${syncId} complete: ${exportResult.totalRows} rows in ${Date.now() - startedMs}ms (target restarted cleanly)`);
    } else {
      log.warn(`Sync ${syncId} import OK but target did not come back within ${RESTART_WAIT_MS / 1000}s`);
    }
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await saveState(baseState({
      status: "failed",
      currentTable: lastTable,
      currentTableIndex: lastIndex,
      totalTables: INSERT_ORDER.length,
      tablesCompleted,
      rowsExported,
      totalRowsExpected,
      error: message,
      completedAt: new Date().toISOString(),
    }));
    log.error(`Sync ${syncId} failed: ${message}`);
  } finally {
    await deleteSetting(SYNC_CANCEL_KEY).catch(() => {});
    if (archivePath) {
      await unlink(archivePath).catch(() => {});
    }
  }
}

const startBodySchema = z.object({
  mode: z.enum(["schema", "data", "data_plus"]),
  destination: z.string().optional(),
  destinationEnvironmentId: z.number().int().positive().optional(),
  // Required when destination is production/live; ignored otherwise.
  confirmation: z.string().optional(),
});

// Railway secrets are sometimes set without a scheme (e.g. just
// "xyz-production-5cad.up.railway.app"), which makes fetch() throw
// "Failed to parse URL". Normalize: prepend https:// when the value
// lacks a scheme, strip trailing slashes.
function normalizeTargetBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  let s = raw.trim();
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

// Resolve the Railway destination instance URL + service variables. Legacy dev/prod
// support remains for compatibility; new UI calls pass destinationEnvironmentId
// and resolve through Platforms → Environment → hosting binding → Railway.
async function getLegacyDestinationConfig(destination: LegacyDbSyncDestination): Promise<ResolvedDbSyncDestination> {
  if (destination === "dev") {
    const cfg = await getDevConfig();
    const url = normalizeTargetBaseUrl(cfg.devUrl);
    const blockers: string[] = [];
    if (!cfg.hasToken) blockers.push("RAILWAY_API_TOKEN secret is not set");
    if (!cfg.projectId) blockers.push("RAILWAY_PROJECT_ID secret is not set");
    if (!cfg.environmentId) blockers.push("RAILWAY_DEV_ENVIRONMENT_ID secret is not set");
    if (!cfg.serviceId) blockers.push("RAILWAY_DEV_SERVICE_ID secret is not set");
    if (!url) blockers.push("RAILWAY_DEV_URL secret is not set");
    return {
      key: "dev",
      label: "Railway dev",
      environmentKind: "development",
      cfg: {
        projectId: cfg.projectId,
        environmentId: cfg.environmentId,
        serviceId: cfg.serviceId,
      },
      complete: blockers.length === 0,
      url,
      blockers,
    };
  }
  const cfg = await getProdConfig();
  const url = normalizeTargetBaseUrl(cfg.prodUrl);
  const blockers: string[] = [];
  if (!cfg.hasToken) blockers.push("RAILWAY_API_TOKEN secret is not set");
  if (!cfg.projectId) blockers.push("RAILWAY_PROJECT_ID secret is not set");
  if (!cfg.environmentId) blockers.push("RAILWAY_PROD_ENVIRONMENT_ID secret is not set");
  if (!cfg.serviceId) blockers.push("RAILWAY_PROD_SERVICE_ID secret is not set");
  if (!url) blockers.push("RAILWAY_PROD_URL secret is not set");
  return {
    key: "prod",
    label: "Railway prod",
    environmentKind: "production",
    cfg: {
      projectId: cfg.projectId,
      environmentId: cfg.environmentId,
      serviceId: cfg.serviceId,
    },
    complete: blockers.length === 0,
    url,
    blockers,
  };
}

async function getPlatformDestinationConfig(environmentId: number): Promise<ResolvedDbSyncDestination> {
  const [row] = await db
    .select({
      environmentId: platformProductEnvironments.id,
      environmentName: platformProductEnvironments.name,
      productName: platformProducts.name,
      platformName: platforms.name,
      projectId: environmentHostingBindings.projectId,
      providerEnvironmentId: environmentHostingBindings.providerEnvironmentId,
      serviceId: environmentHostingBindings.serviceId,
      publicUrl: environmentHostingBindings.publicUrl,
      staticUrl: environmentHostingBindings.staticUrl,
      provider: environmentHostingBindings.provider,
      connectionId: environmentHostingBindings.connectionId,
      connectionProvider: providerConnections.provider,
    })
    .from(platformProductEnvironments)
    .innerJoin(platformProducts, eq(platformProductEnvironments.productId, platformProducts.id))
    .innerJoin(platforms, eq(platformProducts.platformId, platforms.id))
    .leftJoin(environmentHostingBindings, eq(environmentHostingBindings.environmentId, platformProductEnvironments.id))
    .leftJoin(providerConnections, eq(providerConnections.id, environmentHostingBindings.connectionId))
    .where(visiblePlatform(eq(platformProductEnvironments.id, environmentId)))
    .limit(1);

  if (!row) {
    return {
      key: destinationKeyForEnvironment(environmentId),
      label: `Environment ${environmentId}`,
      environmentKind: "custom",
      cfg: {},
      complete: false,
      blockers: [`Platform environment ${environmentId} was not found`],
    };
  }

  const label = `${row.platformName} / ${row.productName} / ${row.environmentName}`;
  const blockers: string[] = [];
  if (!row.provider) blockers.push(`${label} has no hosting binding`);
  if (row.provider && row.provider !== "railway") blockers.push(`${label} hosting provider must be railway for database publish`);
  if (row.connectionId && row.connectionProvider && row.connectionProvider !== "railway") {
    blockers.push(`${label} hosting connection is ${row.connectionProvider}, not railway`);
  }
  if (!row.projectId) blockers.push(`${label} hosting binding is missing Railway projectId`);
  if (!row.providerEnvironmentId) blockers.push(`${label} hosting binding is missing Railway environmentId`);
  if (!row.serviceId) blockers.push(`${label} hosting binding is missing Railway serviceId`);
  const url = normalizeTargetBaseUrl(row.publicUrl || row.staticUrl || undefined);
  if (!url) blockers.push(`${label} hosting binding is missing publicUrl`);

  let token: string | undefined;
  if (row.connectionId) {
    try {
      token = await getRailwayTokenForConnection(row.connectionId);
    } catch (err) {
      blockers.push(`${label} Railway connection unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    key: destinationKeyForEnvironment(environmentId),
    label,
    environmentKind: environmentKindFromName(row.environmentName),
    url,
    cfg: {
      projectId: row.projectId || undefined,
      environmentId: row.providerEnvironmentId || undefined,
      serviceId: row.serviceId || undefined,
      token,
    },
    complete: blockers.length === 0,
    blockers,
  };
}

async function getDestinationConfig(ref: DbSyncDestinationRef): Promise<ResolvedDbSyncDestination> {
  if (ref.platformEnvironmentId) return getPlatformDestinationConfig(ref.platformEnvironmentId);
  if (ref.legacy) return getLegacyDestinationConfig(ref.legacy);
  return {
    key: "env:0" as DbSyncDestination,
    label: "Unknown destination",
    environmentKind: "custom",
    cfg: {},
    complete: false,
    blockers: ["Destination was not provided"],
  };
}

async function resolveTargetImportAuthSecret(
  dest: ResolvedDbSyncDestination,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  if (!dest.cfg.projectId || !dest.cfg.environmentId || !dest.cfg.serviceId) {
    return { ok: false, error: `${dest.label} Railway binding is incomplete` };
  }
  try {
    const vars = await fetchServiceVariables(
      dest.cfg.projectId,
      dest.cfg.environmentId,
      dest.cfg.serviceId,
      dest.cfg.token,
    );
    const secret = vars.DB_SYNC_IMPORT_TOKEN || vars.SESSION_SECRET;
    if (!secret) {
      return { ok: false, error: `${dest.label} is missing DB_SYNC_IMPORT_TOKEN or SESSION_SECRET` };
    }
    return { ok: true, secret };
  } catch (err) {
    return {
      ok: false,
      error: `Unable to resolve ${dest.label} import auth secret: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// 30s in-memory cache for Railway destination DB resolution. fetchServiceVariables
// hits the Railway GraphQL API and is the slowest part of the verify path; the
// UI polls verify on focus so we don't want each poll to round-trip Railway.
const DEST_FP_CACHE_TTL_MS = 30_000;
type DestFpCacheEntry = {
  expiresAt: number;
  fingerprint: DbFingerprint;
  key: string;
  redacted: string;
};
const destFpCache = new Map<string, DestFpCacheEntry>();

// Probe destination's Railway service variables to resolve its DB URL, so we
// can fingerprint and refuse a self-overwrite (local pool === destination DB).
async function fingerprintDestinationDb(
  projectId: string,
  environmentId: string,
  serviceId: string,
  token?: string,
): Promise<{ ok: true; fingerprint: DbFingerprint; key: string; redacted: string } | { ok: false; error: string }> {
  const cacheKey = `${projectId}|${environmentId}|${serviceId}|${token ? "bound" : "legacy"}`;
  const cached = destFpCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, fingerprint: cached.fingerprint, key: cached.key, redacted: cached.redacted };
  }
  try {
    const vars = await fetchServiceVariables(projectId, environmentId, serviceId, token);
    const resolved = resolveDbUrl(vars);
    if (!resolved) {
      return { ok: false, error: "Destination Railway service has no DATABASE_URL/POSTGRES_URL" };
    }
    const entry: DestFpCacheEntry = {
      expiresAt: Date.now() + DEST_FP_CACHE_TTL_MS,
      fingerprint: fingerprintDbUrl(resolved.url),
      key: resolved.key,
      redacted: redactDbUrl(resolved.url),
    };
    destFpCache.set(cacheKey, entry);
    return {
      ok: true,
      fingerprint: entry.fingerprint,
      key: entry.key,
      redacted: entry.redacted,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not fetch destination service variables: ${message}` };
  }
}

type LocalIdentityKind = "railway-dev" | "railway-prod" | "unknown";

interface LocalIdentityResult {
  kind: LocalIdentityKind;
  host: string;
  port: string;
  database: string;
  user: string;
  redactedUrl: string;
}

// Compute the local DB identity by comparing the local pool URL against known Railway dev/prod fingerprints.
async function computeLocalIdentity(): Promise<LocalIdentityResult | { error: string }> {
  const url = process.env.DATABASE_URL;
  if (!url) return { error: "DATABASE_URL not set" };
  let fp: DbFingerprint;
  try {
    fp = fingerprintDbUrl(url);
  } catch (err) {
    return { error: `DATABASE_URL invalid: ${err instanceof Error ? err.message : String(err)}` };
  }

  let kind: LocalIdentityKind = "unknown";
  try {
    const [devCfg, prodCfg] = await Promise.all([getDevConfig(), getProdConfig()]);
    const probes: Array<Promise<{ env: "dev" | "prod"; fp: DbFingerprint } | null>> = [];
    if (devCfg.hasToken && devCfg.projectId && devCfg.environmentId && devCfg.serviceId) {
      probes.push(
        fingerprintDestinationDb(devCfg.projectId, devCfg.environmentId, devCfg.serviceId)
          .then((r) => (r.ok ? { env: "dev" as const, fp: r.fingerprint } : null))
          .catch(() => null),
      );
    }
    if (prodCfg.hasToken && prodCfg.projectId && prodCfg.environmentId && prodCfg.serviceId) {
      probes.push(
        fingerprintDestinationDb(prodCfg.projectId, prodCfg.environmentId, prodCfg.serviceId)
          .then((r) => (r.ok ? { env: "prod" as const, fp: r.fingerprint } : null))
          .catch(() => null),
      );
    }
    const results = await Promise.all(probes);
    for (const result of results) {
      if (!result) continue;
      if (sameDbFingerprint(fp, result.fp)) {
        kind = result.env === "dev" ? "railway-dev" : "railway-prod";
        break;
      }
    }
  } catch (err) {
    log.warn(`local-identity probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    kind,
    host: fp.host,
    port: fp.port,
    database: fp.database,
    user: fp.user,
    redactedUrl: redactDbUrl(url),
  };
}

export function registerDbSyncRoutes(app: Express) {
  app.get("/api/db-sync/status", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const state = await loadState();
      const fresh = await reapStaleSync(state);
      let elapsedMs = fresh.elapsedMs;
      if (isActiveStatus(fresh.status) && fresh.startedAt) {
        const started = Date.parse(fresh.startedAt);
        if (Number.isFinite(started)) elapsedMs = Date.now() - started;
      }
      res.json({ ...fresh, elapsedMs });
    } catch (err: any) {
      log.error(`status failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // Identity badge for the source (always = local pool / DATABASE_URL).
  // `kind` classifies the local DB so the UI can warn loudly when local configuration points at a Railway environment.
  app.get(
    "/api/db-sync/local-identity",
    requireAuth,
    requireAdmin,
    async (_req: Request, res: Response) => {
      const ident = await computeLocalIdentity();
      if ("error" in ident) {
        return res.status(500).json({ error: ident.error });
      }
      res.json(ident);
    },
  );

  // Destination-aware preflight: returns the list of inline blockers the UI
  // should display before allowing /start. Blockers cover missing Railway
  // bindings/secrets, target unreachability, fingerprint resolution failure,
  // and self-overwrite refusal (local DB === destination DB).
  app.get(
    "/api/db-sync/verify",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
      const destinationRef = coerceDestinationKey(
        typeof req.query.destination === "string" ? req.query.destination : undefined,
        req.query.destinationEnvironmentId,
      );
      if ("error" in destinationRef) {
        return res.status(400).json({ error: destinationRef.error });
      }

      const blockers: string[] = [];
      const localIdent = await computeLocalIdentity();
      const localIdentity = "error" in localIdent ? null : localIdent;
      if ("error" in localIdent) {
        blockers.push(`Local DB identity unavailable: ${localIdent.error}`);
      }

      const dest = await getDestinationConfig(destinationRef);
      blockers.push(...dest.blockers);

      let destinationIdentity:
        | { redactedUrl: string; host: string; port: string; database: string }
        | null = null;
      let sameDb = false;

      if (dest.complete && dest.url) {
        const reachable = await checkTargetReachable(dest.url);
        if (!reachable.ok) {
          blockers.push(`Destination unreachable: ${reachable.error}`);
        }

        const destFp = await fingerprintDestinationDb(
          dest.cfg.projectId!,
          dest.cfg.environmentId!,
          dest.cfg.serviceId!,
          dest.cfg.token,
        );
        if (!destFp.ok) {
          // Fail-closed: surface as a blocker so the UI disables Publish.
          blockers.push(`Destination DB fingerprint unavailable: ${destFp.error}`);
        } else {
          destinationIdentity = {
            redactedUrl: destFp.redacted,
            host: destFp.fingerprint.host,
            port: destFp.fingerprint.port,
            database: destFp.fingerprint.database,
          };
          if (localIdentity) {
            const localFp = fingerprintDbUrl(process.env.DATABASE_URL!);
            if (sameDbFingerprint(localFp, destFp.fingerprint)) {
              sameDb = true;
              blockers.push(
                `Refusing to publish: local DB is the SAME database as ${dest.label} (${destFp.redacted}). This would overwrite the source itself.`,
              );
            }
          }
          const importAuth = await resolveTargetImportAuthSecret(dest);
          if (!importAuth.ok) {
            blockers.push(`Destination import auth unavailable: ${importAuth.error}`);
          } else {
            const httpIdentity = await fetchTargetHttpDbIdentity(dest.url, importAuth.secret, "verify");
            if (!httpIdentity.ok) {
              blockers.push(httpIdentity.error);
            } else {
              const match = assertTargetHttpMatchesDestination(dest, destFp.fingerprint, httpIdentity);
              if (!match.ok) blockers.push(match.error);
            }
          }
        }
      }

      res.json({
        ok: blockers.length === 0,
        destination: dest.key,
        destinationEnvironmentId: destinationRef.platformEnvironmentId ?? null,
        destinationLabel: dest.label,
        destinationUrl: dest.url ?? null,
        environmentKind: dest.environmentKind,
        blockers,
        localIdentity,
        destinationIdentity,
        sameDb,
        confirmationPhrase: isProductionDestination(dest) ? PROD_DESTINATION_CONFIRMATION : null,
      });
    },
  );

  app.post("/api/db-sync/start", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    const parsed = startBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid body" });
    }
    const { mode, confirmation } = parsed.data;
    const destinationRef = coerceDestinationKey(parsed.data.destination, parsed.data.destinationEnvironmentId);
    if ("error" in destinationRef) {
      return res.status(400).json({ error: destinationRef.error });
    }
    const dest = await getDestinationConfig(destinationRef);

    // Production/live destinations require the typed-phrase confirmation.
    if (isProductionDestination(dest) && confirmation !== PROD_DESTINATION_CONFIRMATION) {
      return res.status(400).json({
        error: `Confirmation phrase required for ${dest.label}`,
        confirmationPhrase: PROD_DESTINATION_CONFIRMATION,
      });
    }

    if (!dest.complete || !dest.url) {
      return res.status(503).json({
        error: `${dest.label} destination is not fully configured`,
        blockers: dest.blockers,
      });
    }

    const reachable = await checkTargetReachable(dest.url);
    if (!reachable.ok) {
      return res.status(503).json({ error: reachable.error });
    }

    // Fail-closed self-overwrite guard: if we can't fingerprint the
    // destination DB, we refuse rather than risk overwriting an unverified
    // target.
    const localUrl = process.env.DATABASE_URL;
    if (!localUrl) {
      return res.status(500).json({ error: "DATABASE_URL not set; refusing to publish" });
    }
    let localFp: DbFingerprint;
    try {
      localFp = fingerprintDbUrl(localUrl);
    } catch (err) {
      return res.status(500).json({
        error: `Local DATABASE_URL invalid: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    const destFp = await fingerprintDestinationDb(
      dest.cfg.projectId!,
      dest.cfg.environmentId!,
      dest.cfg.serviceId!,
      dest.cfg.token,
    );
    if (!destFp.ok) {
      return res.status(503).json({
        error: `Refusing to publish: cannot fingerprint ${dest.label} destination DB (${destFp.error}). Resolve the destination configuration before retrying.`,
      });
    }
    if (sameDbFingerprint(localFp, destFp.fingerprint)) {
      return res.status(409).json({
        error: `Refusing to publish: local DB is the SAME database as ${dest.label} (${destFp.redacted}). This would overwrite the source itself.`,
      });
    }

    const importAuth = await resolveTargetImportAuthSecret(dest);
    if (!importAuth.ok) {
      return res.status(503).json({ error: `Refusing to publish: ${importAuth.error}` });
    }
    const httpIdentity = await fetchTargetHttpDbIdentity(dest.url, importAuth.secret, "start");
    if (!httpIdentity.ok) {
      return res.status(503).json({ error: `Refusing to publish: ${httpIdentity.error}` });
    }
    const identityMatch = assertTargetHttpMatchesDestination(dest, destFp.fingerprint, httpIdentity);
    if (!identityMatch.ok) {
      return res.status(409).json({ error: identityMatch.error });
    }

    const current = await reapStaleSync(await loadState());
    if (isActiveStatus(current.status)) {
      return res.status(409).json({ error: "Sync already in progress", state: current });
    }

    await deleteSetting(SYNC_CANCEL_KEY).catch(() => {});

    const syncId = randomUUID();
    log.log(`Starting sync ${syncId} (mode=${mode}, dest=${dest.key}, label=${dest.label}) → ${dest.url}`);

    await saveState({
      ...IDLE_STATE,
      status: "exporting",
      mode,
      destination: dest.key,
      syncId,
      startedAt: new Date().toISOString(),
      totalTables: INSERT_ORDER.length,
    });

    runSync(syncId, mode, dest.url, dest.key).catch((err) => {
      log.error(`runSync ${syncId} threw: ${err?.message ?? err}`);
    });

    res.json({ syncId, status: "exporting", destination: dest.key, destinationLabel: dest.label });
  });

  app.post("/api/db-sync/cancel", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const state = await loadState();
    if (state.status !== "exporting" && state.status !== "uploading") {
      return res.status(409).json({ error: "No sync in progress" });
    }
    if (!state.syncId) {
      return res.status(409).json({ error: "Sync has no id" });
    }
    await setSetting(SYNC_CANCEL_KEY, { syncId: state.syncId, requestedAt: new Date().toISOString() });
    log.log(`Cancellation requested for sync ${state.syncId}`);
    res.json({ ok: true, syncId: state.syncId });
  });

  app.post("/api/db-sync/dismiss", requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    const state = await loadState();
    if (isActiveStatus(state.status)) {
      return res.status(409).json({ error: "Cannot dismiss an active sync — cancel first" });
    }
    await saveState({ ...IDLE_STATE });
    await deleteSetting(SYNC_CANCEL_KEY).catch(() => {});
    res.json({ ok: true });
  });
}
