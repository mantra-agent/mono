/**
 * Resumable recursive folder reconciler for Files semantic indexing.
 *
 * Owns durable run progress on file_index_reconciliation_runs:
 *   discovering → indexing → complete | partial | failed | canceled
 *
 * Traversal uses FilesApi.listChildren / getMetadata only. Provider fingerprints
 * decide whether to enqueue drive_file sources; semantic hash/extraction stays
 * in memory_vnext_source_queue. Coverage is multi-policy: disable retires only
 * sources no longer covered by another active self/recursive policy.
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  driveResources,
  fileIndexPolicies,
  fileIndexReconciliationRuns,
  indexedFileSources,
  users,
  type DriveResourceRow,
  type FileIndexPolicyRow,
  type FileIndexReconciliationRunRow,
  type IndexedFileSourceRow,
} from "@shared/schema";
import { db } from "./db";
import { createLogger } from "./log";
import {
  createUserPrincipalFromUser,
  resolveUserIdentityFoundation,
  type Principal,
} from "./principal";
import { runWithPrincipal } from "./principal-context";
import { filesApi, type FilesChild } from "./files-api";
import { isExtractableOfficeMime } from "./file-text-extraction";
import { markSourceChanged } from "./memory/vnext-source-queue";

const log = createLogger("FilesIndexReconciler");

const POLL_INTERVAL_MS = 15_000;
const BOOT_DELAY_MS = 45_000;
const MAX_RUNS_PER_TICK = 2;
const MAX_FOLDER_BATCHES_PER_CLAIM = 8;
const MAX_INDEX_BATCH = 25;
const MAX_FOLDERS_PER_RUN = 5_000;
const MAX_FILES_PER_RUN = 50_000;

const ACTIVE_PHASES = ["queued", "discovering", "indexing"] as const;

type DiscoveryStackEntry = {
  providerFileId: string;
  pageToken: string | null;
  path: string;
};

type DiscoveryCursor = {
  stack: DiscoveryStackEntry[];
  visitedFolderIds: string[];
  seenFileKeys: string[];
  /** Provider file ids observed as files during this sealed discovery. */
  discoveredFileIds: string[];
  /** Indexed source ids still needing an index attempt in this run. */
  pendingSourceIds: string[];
  /** Indexed source ids that failed during this run (retry without full restart). */
  failedSourceIds: string[];
  mode: "expand" | "retire";
};

function emptyCursor(mode: "expand" | "retire"): DiscoveryCursor {
  return {
    stack: [],
    visitedFolderIds: [],
    seenFileKeys: [],
    discoveredFileIds: [],
    pendingSourceIds: [],
    failedSourceIds: [],
    mode,
  };
}

function parseCursor(raw: unknown): DiscoveryCursor | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const mode = obj.mode === "retire" ? "retire" : obj.mode === "expand" ? "expand" : null;
  if (!mode) return null;
  const stackRaw = Array.isArray(obj.stack) ? obj.stack : [];
  const stack: DiscoveryStackEntry[] = [];
  for (const entry of stackRaw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.providerFileId !== "string" || !e.providerFileId) continue;
    stack.push({
      providerFileId: e.providerFileId,
      pageToken: typeof e.pageToken === "string" ? e.pageToken : null,
      path: typeof e.path === "string" ? e.path : "",
    });
  }
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  return {
    stack,
    visitedFolderIds: asStringArray(obj.visitedFolderIds),
    seenFileKeys: asStringArray(obj.seenFileKeys),
    discoveredFileIds: asStringArray(obj.discoveredFileIds),
    pendingSourceIds: asStringArray(obj.pendingSourceIds),
    failedSourceIds: asStringArray(obj.failedSourceIds),
    mode,
  };
}

function providerFingerprint(input: {
  md5Checksum?: string | null;
  modifiedTime?: string | null;
}): { checksum: string | null; modifiedAt: Date | null } {
  const checksum =
    typeof input.md5Checksum === "string" && input.md5Checksum.trim()
      ? input.md5Checksum.trim()
      : null;
  let modifiedAt: Date | null = null;
  if (typeof input.modifiedTime === "string" && input.modifiedTime.trim()) {
    const d = new Date(input.modifiedTime);
    if (!Number.isNaN(d.getTime())) modifiedAt = d;
  }
  return { checksum, modifiedAt };
}

function fingerprintsEqual(
  a: { checksum: string | null; modifiedAt: Date | null },
  b: { checksum: string | null; modifiedAt: Date | null },
): boolean {
  if (a.checksum || b.checksum) return a.checksum === b.checksum && !!a.checksum;
  if (!a.modifiedAt && !b.modifiedAt) return true;
  if (!a.modifiedAt || !b.modifiedAt) return false;
  return a.modifiedAt.getTime() === b.modifiedAt.getTime();
}

/**
 * Cheap eligibility for discovery. Binary-only / unknown media stay visible as
 * unsupported rather than entering the semantic queue.
 */
export function classifyDiscoveryEligibility(mimeType: string | null | undefined): {
  eligible: boolean;
  unsupported: boolean;
} {
  if (!mimeType) return { eligible: true, unsupported: false };
  const m = mimeType.toLowerCase();
  if (m === "application/vnd.google-apps.folder") {
    return { eligible: false, unsupported: true };
  }
  if (m.startsWith("image/") || m.startsWith("audio/") || m.startsWith("video/")) {
    return { eligible: false, unsupported: true };
  }
  if (m === "application/pdf") {
    // PDF.js extraction is owned by pdf-service and reused by the drive_file adapter.
    return { eligible: true, unsupported: false };
  }
  if (m === "application/zip" || m === "application/x-zip-compressed") {
    return { eligible: false, unsupported: true };
  }
  if (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript" ||
    m.endsWith("+json") ||
    m.endsWith("+xml") ||
    m === "application/csv" ||
    m === "text/csv" ||
    m === "application/vnd.google-apps.document" ||
    m === "application/vnd.google-apps.spreadsheet" ||
    m === "application/vnd.google-apps.presentation" ||
    isExtractableOfficeMime(m)
  ) {
    return { eligible: true, unsupported: false };
  }
  // Unknown office-ish binaries: attempt later via FilesApi; mark eligible so
  // the adapter can decide unsupported after read rather than hiding the file.
  if (m.startsWith("application/vnd.") || m.startsWith("application/msword")) {
    return { eligible: true, unsupported: false };
  }
  return { eligible: false, unsupported: true };
}

function fileKey(provider: string, providerFileId: string): string {
  return `${provider}:${providerFileId}`;
}

async function loadOwnerPrincipal(run: FileIndexReconciliationRunRow): Promise<Principal | null> {
  const [user] = await db.select().from(users).where(eq(users.id, run.ownerUserId)).limit(1);
  if (!user) return null;
  try {
    const foundation = await resolveUserIdentityFoundation(user.id);
    const principal = createUserPrincipalFromUser(user, foundation.accountId, foundation.instanceId);
    // Pin vault visibility to the run's vault so FilesApi vault gates succeed
    // even if the owner's active layout currently hides it.
    const visible = new Set(foundation.visibleVaultIds);
    visible.add(run.vaultId);
    return {
      ...principal,
      accountId: foundation.accountId,
      visibleVaultIds: [...visible],
      activeVaultId: run.vaultId,
      permissions: [],
    };
  } catch (err) {
    log.warn("files index reconciler: owner foundation missing", {
      ownerUserId: run.ownerUserId,
      runId: run.id,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return null;
  }
}

async function claimNextRun(): Promise<FileIndexReconciliationRunRow | null> {
  // Atomic claim across replicas: SKIP LOCKED head + conditional phase advance.
  const result = await db.execute(sql`
    UPDATE file_index_reconciliation_runs
    SET
      phase = CASE WHEN phase = 'queued' THEN 'discovering' ELSE phase END,
      started_at = COALESCE(started_at, NOW()),
      updated_at = NOW()
    WHERE id IN (
      SELECT id FROM file_index_reconciliation_runs
      WHERE phase IN ('queued', 'discovering', 'indexing')
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
  const rows = (result as { rows?: Record<string, unknown>[] }).rows ?? [];
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    ownerUserId: String(row.owner_user_id),
    vaultId: String(row.vault_id),
    policyId: String(row.policy_id),
    rootDriveResourceId: String(row.root_drive_resource_id),
    phase: row.phase as FileIndexReconciliationRunRow["phase"],
    foldersVisited: Number(row.folders_visited ?? 0),
    filesDiscovered: Number(row.files_discovered ?? 0),
    filesEligible: Number(row.files_eligible ?? 0),
    filesCompleted: Number(row.files_completed ?? 0),
    filesUnchanged: Number(row.files_unchanged ?? 0),
    filesUnsupported: Number(row.files_unsupported ?? 0),
    filesFailed: Number(row.files_failed ?? 0),
    discoveryCursor: (row.discovery_cursor as Record<string, unknown> | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    startedAt: row.started_at ? new Date(String(row.started_at)) : null,
    updatedAt: new Date(String(row.updated_at)),
    completedAt: row.completed_at ? new Date(String(row.completed_at)) : null,
    createdAt: new Date(String(row.created_at)),
  };
}

async function patchRun(
  runId: string,
  patch: Partial<{
    phase: FileIndexReconciliationRunRow["phase"];
    foldersVisited: number;
    filesDiscovered: number;
    filesEligible: number;
    filesCompleted: number;
    filesUnchanged: number;
    filesUnsupported: number;
    filesFailed: number;
    discoveryCursor: DiscoveryCursor | null;
    lastError: string | null;
    completedAt: Date | null;
  }>,
): Promise<FileIndexReconciliationRunRow | null> {
  const [row] = await db
    .update(fileIndexReconciliationRuns)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(fileIndexReconciliationRuns.id, runId))
    .returning();
  return row ?? null;
}

async function loadPolicy(policyId: string): Promise<FileIndexPolicyRow | null> {
  const [row] = await db
    .select()
    .from(fileIndexPolicies)
    .where(eq(fileIndexPolicies.id, policyId))
    .limit(1);
  return row ?? null;
}

async function loadRoot(rootId: string): Promise<DriveResourceRow | null> {
  const [row] = await db
    .select()
    .from(driveResources)
    .where(eq(driveResources.id, rootId))
    .limit(1);
  return row ?? null;
}

/**
 * Overlap-safe coverage: a source remains active while any active self policy
 * on its bind OR any recursive policy that last claimed it (same root) is on.
 * v1 has no full ancestor-path index; recursive coverage uses root provenance
 * plus active recursive policies in the same vault/provider.
 */
async function isSourceStillCovered(source: IndexedFileSourceRow): Promise<boolean> {
  if (source.driveResourceId) {
    const [selfPolicy] = await db
      .select({ id: fileIndexPolicies.id, mode: fileIndexPolicies.mode })
      .from(fileIndexPolicies)
      .where(
        and(
          eq(fileIndexPolicies.driveResourceId, source.driveResourceId),
          eq(fileIndexPolicies.mode, "self"),
        ),
      )
      .limit(1);
    if (selfPolicy) return true;
  }

  if (source.rootDriveResourceId) {
    const [rootPolicy] = await db
      .select({ id: fileIndexPolicies.id, mode: fileIndexPolicies.mode })
      .from(fileIndexPolicies)
      .where(
        and(
          eq(fileIndexPolicies.driveResourceId, source.rootDriveResourceId),
          eq(fileIndexPolicies.mode, "recursive"),
        ),
      )
      .limit(1);
    if (rootPolicy) return true;
  }

  // Another recursive policy in the same vault may still cover this provider file
  // if it last claimed it under a different root that remains recursive.
  if (source.policyId) {
    const [claiming] = await db
      .select({ id: fileIndexPolicies.id, mode: fileIndexPolicies.mode })
      .from(fileIndexPolicies)
      .where(
        and(
          eq(fileIndexPolicies.id, source.policyId),
          inArray(fileIndexPolicies.mode, ["self", "recursive"]),
        ),
      )
      .limit(1);
    if (claiming) return true;
  }

  return false;
}

async function retireUncoveredSourcesForRoot(input: {
  vaultId: string;
  rootDriveResourceId: string;
  policyId: string;
}): Promise<number> {
  const candidates = await db
    .select()
    .from(indexedFileSources)
    .where(
      and(
        eq(indexedFileSources.vaultId, input.vaultId),
        or(
          eq(indexedFileSources.rootDriveResourceId, input.rootDriveResourceId),
          eq(indexedFileSources.policyId, input.policyId),
        ),
        ne(indexedFileSources.discoveryState, "retired"),
      ),
    );

  let retired = 0;
  const now = new Date();
  for (const source of candidates) {
    if (await isSourceStillCovered(source)) continue;
    await db
      .update(indexedFileSources)
      .set({
        discoveryState: "retired",
        retiredAt: now,
        updatedAt: now,
      })
      .where(eq(indexedFileSources.id, source.id));
    retired += 1;
  }
  return retired;
}

async function markMissingDiscoveredDeleted(input: {
  vaultId: string;
  rootDriveResourceId: string;
  policyId: string;
  seenProviderFileIds: Set<string>;
}): Promise<number> {
  const prior = await db
    .select()
    .from(indexedFileSources)
    .where(
      and(
        eq(indexedFileSources.vaultId, input.vaultId),
        eq(indexedFileSources.rootDriveResourceId, input.rootDriveResourceId),
        inArray(indexedFileSources.discoveryState, ["active", "unsupported", "inaccessible"]),
      ),
    );

  let marked = 0;
  const now = new Date();
  for (const source of prior) {
    if (input.seenProviderFileIds.has(source.providerFileId)) continue;
    // Explicit self binds under another policy stay; only this root's discoveries.
    if (source.driveResourceId && source.driveResourceId === source.rootDriveResourceId) {
      continue;
    }
    // Self policy on an explicit bind keeps the source even if this root no longer sees it.
    if (source.driveResourceId) {
      const [selfPolicy] = await db
        .select({ id: fileIndexPolicies.id })
        .from(fileIndexPolicies)
        .where(
          and(
            eq(fileIndexPolicies.driveResourceId, source.driveResourceId),
            eq(fileIndexPolicies.mode, "self"),
          ),
        )
        .limit(1);
      if (selfPolicy) {
        await db
          .update(indexedFileSources)
          .set({
            rootDriveResourceId:
              source.rootDriveResourceId === input.rootDriveResourceId
                ? source.driveResourceId
                : source.rootDriveResourceId,
            policyId: selfPolicy.id,
            updatedAt: now,
          })
          .where(eq(indexedFileSources.id, source.id));
        continue;
      }
    }

    await db
      .update(indexedFileSources)
      .set({
        discoveryState: "deleted",
        updatedAt: now,
      })
      .where(eq(indexedFileSources.id, source.id));
    marked += 1;
  }
  return marked;
}

async function upsertDiscoveredFile(input: {
  principal: Principal;
  policy: FileIndexPolicyRow;
  root: DriveResourceRow;
  child: FilesChild;
  parentProviderFileId: string;
  path: string;
}): Promise<{
  source: IndexedFileSourceRow;
  enqueued: boolean;
  unchanged: boolean;
  unsupported: boolean;
  created: boolean;
}> {
  const { principal, policy, root, child } = input;
  const now = new Date();
  const fp = providerFingerprint(child);
  const eligibility = classifyDiscoveryEligibility(child.mimeType);
  const discoveryState = eligibility.unsupported ? "unsupported" : "active";

  const [existing] = await db
    .select()
    .from(indexedFileSources)
    .where(
      and(
        eq(indexedFileSources.vaultId, root.vaultId),
        eq(indexedFileSources.provider, child.provider),
        eq(indexedFileSources.providerFileId, child.providerFileId),
      ),
    )
    .limit(1);

  const sameFingerprint =
    existing != null &&
    fingerprintsEqual(
      {
        checksum: existing.providerChecksum,
        modifiedAt: existing.providerModifiedAt,
      },
      fp,
    );

  // Files owns selection and freshness. Materialize every selected descendant as a
  // stable internal drive_resource pointer so semantic systems never identify it
  // by provider path, display name, or URL. Reconciliation metadata remains here.
  const [durableResource] = await db
    .insert(driveResources)
    .values({
      accountId: root.accountId,
      vaultId: root.vaultId,
      connectedAccountId: root.connectedAccountId,
      provider: child.provider,
      providerFileId: child.providerFileId,
      name: child.name,
      mimeType: child.mimeType,
      resourceType: "file",
      iconUrl: child.iconUrl ?? null,
      webViewLink: child.webViewLink ?? null,
      addedByUserId: principal.userId,
    })
    .onConflictDoUpdate({
      target: [driveResources.vaultId, driveResources.provider, driveResources.providerFileId],
      set: {
        connectedAccountId: root.connectedAccountId,
        name: child.name,
        mimeType: child.mimeType,
        iconUrl: child.iconUrl ?? null,
        webViewLink: child.webViewLink ?? null,
      },
    })
    .returning({ id: driveResources.id });

  const [row] = await db
    .insert(indexedFileSources)
    .values({
      accountId: root.accountId,
      ownerUserId: principal.userId!,
      vaultId: root.vaultId,
      policyId: policy.id,
      rootDriveResourceId: root.id,
      driveResourceId: durableResource.id,
      provider: child.provider,
      providerFileId: child.providerFileId,
      name: child.name,
      mimeType: child.mimeType,
      providerPath: input.path,
      providerParentId: input.parentProviderFileId,
      providerChecksum: fp.checksum,
      providerModifiedAt: fp.modifiedAt,
      discoveryState,
      lastDiscoveredAt: now,
      retiredAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        indexedFileSources.vaultId,
        indexedFileSources.provider,
        indexedFileSources.providerFileId,
      ],
      set: {
        policyId: policy.id,
        rootDriveResourceId: root.id,
        driveResourceId: durableResource.id,
        name: child.name,
        mimeType: child.mimeType,
        providerPath: input.path,
        providerParentId: input.parentProviderFileId,
        providerChecksum: fp.checksum,
        providerModifiedAt: fp.modifiedAt,
        discoveryState,
        lastDiscoveredAt: now,
        retiredAt: null,
        updatedAt: now,
      },
    })
    .returning();

  const created = !existing;
  const unsupported = discoveryState === "unsupported";
  let enqueued = false;
  let unchanged = false;

  if (!unsupported && eligibility.eligible) {
    const queueSourceId = row.driveResourceId ?? row.id;
    if (!sameFingerprint || created || existing?.discoveryState !== "active") {
      await markSourceChanged("drive_file", queueSourceId, principal);
      enqueued = true;
    } else {
      unchanged = true;
    }
  }

  return { source: row, enqueued, unchanged, unsupported, created };
}

async function processDiscoveringBatch(input: {
  principal: Principal;
  run: FileIndexReconciliationRunRow;
  policy: FileIndexPolicyRow;
  root: DriveResourceRow;
}): Promise<FileIndexReconciliationRunRow> {
  const { principal, policy, root } = input;
  let run = input.run;
  let cursor = parseCursor(run.discoveryCursor);

  if (!cursor) {
    if (policy.mode !== "recursive") {
      // Disable path: recompute coverage without tree walk.
      const retired = await retireUncoveredSourcesForRoot({
        vaultId: root.vaultId,
        rootDriveResourceId: root.id,
        policyId: policy.id,
      });
      const completed =
        (await patchRun(run.id, {
          phase: "complete",
          discoveryCursor: emptyCursor("retire"),
          filesCompleted: retired,
          completedAt: new Date(),
          lastError: null,
        })) ?? run;
      log.info("files index reconciler: retire complete", {
        runId: run.id,
        policyId: policy.id,
        retired,
      });
      return completed;
    }

    cursor = emptyCursor("expand");
    cursor.stack.push({
      providerFileId: root.providerFileId,
      pageToken: null,
      path: root.name || "",
    });
    run =
      (await patchRun(run.id, {
        phase: "discovering",
        discoveryCursor: cursor,
        lastError: null,
      })) ?? run;
  }

  if (cursor.mode === "retire") {
    const retired = await retireUncoveredSourcesForRoot({
      vaultId: root.vaultId,
      rootDriveResourceId: root.id,
      policyId: policy.id,
    });
    return (
      (await patchRun(run.id, {
        phase: "complete",
        discoveryCursor: cursor,
        filesCompleted: retired,
        completedAt: new Date(),
        lastError: null,
      })) ?? run
    );
  }

  let foldersVisited = run.foldersVisited;
  let filesDiscovered = run.filesDiscovered;
  let filesEligible = run.filesEligible;
  let filesUnsupported = run.filesUnsupported;
  let filesUnchanged = run.filesUnchanged;
  const pending = new Set(cursor.pendingSourceIds);
  const seenFiles = new Set(cursor.seenFileKeys);
  const visited = new Set(cursor.visitedFolderIds);
  const discoveredFileIds = new Set(cursor.discoveredFileIds);

  let batches = 0;
  while (cursor.stack.length > 0 && batches < MAX_FOLDER_BATCHES_PER_CLAIM) {
    if (foldersVisited >= MAX_FOLDERS_PER_RUN || filesDiscovered >= MAX_FILES_PER_RUN) {
      return (
        (await patchRun(run.id, {
          phase: "failed",
          lastError: "reconciliation bounds exceeded",
          discoveryCursor: {
            ...cursor,
            visitedFolderIds: [...visited],
            seenFileKeys: [...seenFiles],
            discoveredFileIds: [...discoveredFileIds],
            pendingSourceIds: [...pending],
          },
          foldersVisited,
          filesDiscovered,
          filesEligible,
          filesUnsupported,
          filesUnchanged,
          completedAt: new Date(),
        })) ?? run
      );
    }

    const current = cursor.stack[cursor.stack.length - 1]!;
    const visitKey = fileKey(root.provider, current.providerFileId);
    // Cycle protection: skip folders already fully visited (no open page).
    if (!current.pageToken && visited.has(visitKey) && current !== cursor.stack[0]) {
      // Allow root first visit; for deeper nodes, visited means done.
    }

    let page: { children: FilesChild[]; nextPageToken: string | null };
    try {
      // Index discovery authorizes the bound root once, then walks any folder
      // id already discovered under it. Ordinary listChildren parent-chain
      // checks reject Google folder shortcuts because the target's parents do
      // not lead back to the bound root even though listing did.
      page = await filesApi.listChildrenForIndex({
        rootDriveResourceId: root.id,
        folderProviderFileId: current.providerFileId,
        pageToken: current.pageToken ?? undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : "listChildren failed";
      log.warn("files index reconciler: listChildren failed", {
        runId: run.id,
        folderId: current.providerFileId,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      return (
        (await patchRun(run.id, {
          phase: "failed",
          lastError: message,
          discoveryCursor: {
            ...cursor,
            visitedFolderIds: [...visited],
            seenFileKeys: [...seenFiles],
            discoveredFileIds: [...discoveredFileIds],
            pendingSourceIds: [...pending],
          },
          foldersVisited,
          filesDiscovered,
          filesEligible,
          filesUnsupported,
          filesUnchanged,
          completedAt: new Date(),
        })) ?? run
      );
    }

    const discoveredFolders: DiscoveryStackEntry[] = [];
    for (const child of page.children) {
      const childKey = fileKey(child.provider, child.providerFileId);
      if (child.resourceType === "folder") {
        if (visited.has(childKey) || cursor.stack.some((s) => s.providerFileId === child.providerFileId)) {
          continue;
        }
        // Cycle protection via visited set keyed by provider+id.
        if (seenFiles.has(`folder:${childKey}`)) continue;
        seenFiles.add(`folder:${childKey}`);
        discoveredFolders.push({
          providerFileId: child.providerFileId,
          pageToken: null,
          path: current.path ? `${current.path}/${child.name}` : child.name,
        });
        continue;
      }

      if (seenFiles.has(childKey)) continue;
      seenFiles.add(childKey);
      discoveredFileIds.add(child.providerFileId);
      filesDiscovered += 1;

      try {
        const result = await upsertDiscoveredFile({
          principal,
          policy,
          root,
          child,
          parentProviderFileId: current.providerFileId,
          path: current.path ? `${current.path}/${child.name}` : child.name,
        });
        if (result.unsupported) {
          filesUnsupported += 1;
        } else if (result.enqueued) {
          filesEligible += 1;
          pending.add(result.source.id);
        } else if (result.unchanged) {
          filesUnchanged += 1;
          filesEligible += 1;
        } else {
          filesEligible += 1;
        }
      } catch (err) {
        log.warn("files index reconciler: upsert file failed", {
          runId: run.id,
          providerFileId: child.providerFileId,
          errorName: err instanceof Error ? err.name : typeof err,
        });
        // Continue discovery; failed materialization is counted at seal/index time.
      }
    }

    // Keep paged children directly below the current folder. The current folder
    // remains the stack top until its final page, so a later pop can remove only
    // that folder while preserving every child found across all pages.
    if (discoveredFolders.length > 0) {
      cursor.stack.splice(
        cursor.stack.length - 1,
        0,
        ...discoveredFolders.reverse(),
      );
    }

    if (page.nextPageToken) {
      current.pageToken = page.nextPageToken;
    } else {
      visited.add(visitKey);
      foldersVisited += 1;
      const completed = cursor.stack.pop();
      if (completed !== current) {
        throw new Error("Discovery cursor changed while completing a folder");
      }
    }
    batches += 1;
  }

  cursor.visitedFolderIds = [...visited];
  cursor.seenFileKeys = [...seenFiles];
  cursor.discoveredFileIds = [...discoveredFileIds];
  cursor.pendingSourceIds = [...pending];

  if (cursor.stack.length > 0) {
    return (
      (await patchRun(run.id, {
        phase: "discovering",
        discoveryCursor: cursor,
        foldersVisited,
        filesDiscovered,
        filesEligible,
        filesUnsupported,
        filesUnchanged,
        lastError: null,
      })) ?? run
    );
  }

  // Discovery sealed — mark missing prior children, then enter indexing.
  await markMissingDiscoveredDeleted({
    vaultId: root.vaultId,
    rootDriveResourceId: root.id,
    policyId: policy.id,
    seenProviderFileIds: discoveredFileIds,
  });

  const pendingIds = [...pending];
  if (pendingIds.length === 0) {
    return (
      (await patchRun(run.id, {
        phase: "complete",
        discoveryCursor: cursor,
        foldersVisited,
        filesDiscovered,
        filesEligible,
        filesUnsupported,
        filesUnchanged,
        filesCompleted: filesUnchanged,
        completedAt: new Date(),
        lastError: null,
      })) ?? run
    );
  }

  return (
    (await patchRun(run.id, {
      phase: "indexing",
      discoveryCursor: {
        ...cursor,
        pendingSourceIds: pendingIds,
      },
      foldersVisited,
      filesDiscovered,
      filesEligible,
      filesUnsupported,
      filesUnchanged,
      lastError: null,
    })) ?? run
  );
}

async function processIndexingBatch(input: {
  principal: Principal;
  run: FileIndexReconciliationRunRow;
  policy: FileIndexPolicyRow;
  root: DriveResourceRow;
}): Promise<FileIndexReconciliationRunRow> {
  const { principal, root } = input;
  let run = input.run;
  const cursor = parseCursor(run.discoveryCursor) ?? emptyCursor("expand");
  const pending = [...cursor.pendingSourceIds];
  const failed = new Set(cursor.failedSourceIds);

  if (pending.length === 0) {
    const phase = failed.size > 0 ? "partial" : "complete";
    return (
      (await patchRun(run.id, {
        phase,
        discoveryCursor: { ...cursor, pendingSourceIds: [], failedSourceIds: [...failed] },
        completedAt: new Date(),
        filesFailed: failed.size,
        lastError: failed.size > 0 ? `${failed.size} file(s) failed indexing enqueue` : null,
      })) ?? run
    );
  }

  const batch = pending.slice(0, MAX_INDEX_BATCH);
  const remaining = pending.slice(MAX_INDEX_BATCH);
  let completed = run.filesCompleted;
  let unchanged = run.filesUnchanged;
  let unsupported = run.filesUnsupported;

  for (const sourceId of batch) {
    const [source] = await db
      .select()
      .from(indexedFileSources)
      .where(eq(indexedFileSources.id, sourceId))
      .limit(1);
    if (!source) {
      failed.add(sourceId);
      continue;
    }
    if (source.discoveryState === "unsupported") {
      unsupported += 1;
      completed += 1;
      continue;
    }
    if (source.discoveryState === "retired" || source.discoveryState === "deleted") {
      completed += 1;
      continue;
    }

    try {
      // Refresh cheap fingerprint via metadata when list lacked checksum.
      if (!source.providerChecksum) {
        try {
          const meta = await filesApi.getMetadata({
            vaultId: root.vaultId,
            ...(source.driveResourceId
              ? { driveResourceId: source.driveResourceId }
              : {
                  provider: source.provider as "google" | "box" | "mantra",
                  providerFileId: source.providerFileId,
                }),
          });
          const fp = providerFingerprint(meta);
          const same =
            fingerprintsEqual(
              {
                checksum: source.providerChecksum,
                modifiedAt: source.providerModifiedAt,
              },
              fp,
            ) && source.discoveryState === "active";
          await db
            .update(indexedFileSources)
            .set({
              providerChecksum: fp.checksum,
              providerModifiedAt: fp.modifiedAt,
              name: meta.name || source.name,
              mimeType: meta.mimeType ?? source.mimeType,
              updatedAt: new Date(),
            })
            .where(eq(indexedFileSources.id, source.id));
          if (same) {
            unchanged += 1;
            completed += 1;
            continue;
          }
        } catch {
          // Fall through to enqueue; adapter will classify inaccessible.
        }
      }

      const queueSourceId = source.driveResourceId ?? source.id;
      await markSourceChanged("drive_file", queueSourceId, principal);
      completed += 1;
      failed.delete(sourceId);
    } catch (err) {
      log.warn("files index reconciler: index enqueue failed", {
        runId: run.id,
        sourceId,
        errorName: err instanceof Error ? err.name : typeof err,
      });
      failed.add(sourceId);
    }
  }

  cursor.pendingSourceIds = remaining;
  cursor.failedSourceIds = [...failed];

  if (remaining.length > 0) {
    return (
      (await patchRun(run.id, {
        phase: "indexing",
        discoveryCursor: cursor,
        filesCompleted: completed,
        filesUnchanged: unchanged,
        filesUnsupported: unsupported,
        filesFailed: failed.size,
        lastError: null,
      })) ?? run
    );
  }

  const phase = failed.size > 0 ? "partial" : "complete";
  return (
    (await patchRun(run.id, {
      phase,
      discoveryCursor: cursor,
      filesCompleted: completed,
      filesUnchanged: unchanged,
      filesUnsupported: unsupported,
      filesFailed: failed.size,
      completedAt: new Date(),
      lastError: failed.size > 0 ? `${failed.size} file(s) failed` : null,
    })) ?? run
  );
}

async function processRun(run: FileIndexReconciliationRunRow): Promise<void> {
  const principal = await loadOwnerPrincipal(run);
  if (!principal || !principal.userId) {
    await patchRun(run.id, {
      phase: "failed",
      lastError: "owner principal unavailable",
      completedAt: new Date(),
    });
    return;
  }

  await runWithPrincipal(principal, async () => {
    const policy = await loadPolicy(run.policyId);
    const root = await loadRoot(run.rootDriveResourceId);
    if (!policy || !root) {
      await patchRun(run.id, {
        phase: "failed",
        lastError: "policy or root missing",
        completedAt: new Date(),
      });
      return;
    }

    // Policy turned off after enqueue → retire coverage path.
    if (policy.mode !== "recursive" && run.phase !== "indexing") {
      const cursor = parseCursor(run.discoveryCursor) ?? emptyCursor("retire");
      cursor.mode = "retire";
      await patchRun(run.id, { discoveryCursor: cursor, phase: "discovering" });
    }

    let current = run;
    if (current.phase === "queued" || current.phase === "discovering") {
      current = await processDiscoveringBatch({ principal, run: current, policy, root });
    }
    if (current.phase === "indexing") {
      current = await processIndexingBatch({ principal, run: current, policy, root });
    }

    log.info("files index reconciler: run tick", {
      runId: current.id,
      phase: current.phase,
      foldersVisited: current.foldersVisited,
      filesDiscovered: current.filesDiscovered,
      filesEligible: current.filesEligible,
      filesCompleted: current.filesCompleted,
      filesFailed: current.filesFailed,
    });
  });
}

let started = false;
let tickInFlight = false;

export async function runFilesIndexReconcilerTick(): Promise<{ claimed: number; errors: number }> {
  if (tickInFlight) return { claimed: 0, errors: 0 };
  tickInFlight = true;
  let claimed = 0;
  let errors = 0;
  try {
    for (let i = 0; i < MAX_RUNS_PER_TICK; i++) {
      const run = await claimNextRun();
      if (!run) break;
      claimed += 1;
      try {
        await processRun(run);
      } catch (err) {
        errors += 1;
        log.error("files index reconciler: run failed", {
          runId: run.id,
          errorName: err instanceof Error ? err.name : typeof err,
        });
        await patchRun(run.id, {
          phase: "failed",
          lastError: err instanceof Error ? err.message.slice(0, 500) : "reconciler error",
          completedAt: new Date(),
        }).catch(() => undefined);
      }
    }
  } finally {
    tickInFlight = false;
  }
  return { claimed, errors };
}

/**
 * Retry only failed sources from a terminal partial/failed run without restarting
 * full tree discovery. Creates a new run seeded with failedSourceIds in indexing.
 */
export async function retryFailedFilesIndexRun(input: {
  principal: Principal;
  runId: string;
}): Promise<FileIndexReconciliationRunRow> {
  const [prior] = await db
    .select()
    .from(fileIndexReconciliationRuns)
    .where(
      and(
        eq(fileIndexReconciliationRuns.id, input.runId),
        eq(fileIndexReconciliationRuns.accountId, input.principal.accountId!),
      ),
    )
    .limit(1);
  if (!prior) {
    throw Object.assign(new Error("Reconciliation run not found"), { status: 404 });
  }
  if (prior.phase !== "partial" && prior.phase !== "failed") {
    throw Object.assign(new Error("Only partial or failed runs can retry failed files"), {
      status: 400,
    });
  }

  const cursor = parseCursor(prior.discoveryCursor) ?? emptyCursor("expand");
  const failedIds = cursor.failedSourceIds;
  if (failedIds.length === 0) {
    throw Object.assign(new Error("No failed files to retry"), { status: 400 });
  }

  // Cancel any active run on the same policy first (idempotent single-flight).
  await db
    .update(fileIndexReconciliationRuns)
    .set({
      phase: "canceled",
      completedAt: new Date(),
      updatedAt: new Date(),
      lastError: "superseded by failed-file retry",
    })
    .where(
      and(
        eq(fileIndexReconciliationRuns.policyId, prior.policyId),
        inArray(fileIndexReconciliationRuns.phase, [...ACTIVE_PHASES]),
      ),
    );

  const now = new Date();
  const retryCursor: DiscoveryCursor = {
    ...emptyCursor("expand"),
    pendingSourceIds: failedIds,
    failedSourceIds: [],
    discoveredFileIds: cursor.discoveredFileIds,
    visitedFolderIds: cursor.visitedFolderIds,
    seenFileKeys: cursor.seenFileKeys,
  };

  const [row] = await db
    .insert(fileIndexReconciliationRuns)
    .values({
      accountId: prior.accountId,
      ownerUserId: prior.ownerUserId,
      vaultId: prior.vaultId,
      policyId: prior.policyId,
      rootDriveResourceId: prior.rootDriveResourceId,
      phase: "indexing",
      foldersVisited: prior.foldersVisited,
      filesDiscovered: prior.filesDiscovered,
      filesEligible: failedIds.length,
      filesCompleted: 0,
      filesUnchanged: 0,
      filesUnsupported: 0,
      filesFailed: 0,
      discoveryCursor: retryCursor,
      startedAt: now,
      updatedAt: now,
      createdAt: now,
    })
    .returning();

  log.info("files index reconciler: retry failed files enqueued", {
    priorRunId: prior.id,
    runId: row.id,
    failedCount: failedIds.length,
  });
  return row;
}

export function startFilesIndexReconciler(): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runFilesIndexReconcilerTick()
      .then((result) => {
        if (result.claimed > 0 || result.errors > 0) {
          log.info("files index reconciler tick", result);
        }
      })
      .catch((err) => {
        log.error("files index reconciler tick failed", {
          errorName: err instanceof Error ? err.name : typeof err,
        });
      });
  };
  setTimeout(tick, BOOT_DELAY_MS).unref();
  setInterval(tick, POLL_INTERVAL_MS).unref();
  log.info("files index reconciler started", {
    bootDelayMs: BOOT_DELAY_MS,
    intervalMs: POLL_INTERVAL_MS,
  });
}
